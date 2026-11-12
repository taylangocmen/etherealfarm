"""Content-verified local replay archive; no external trajectories are accepted."""
import gzip
import hashlib
import json
import math
from pathlib import Path
import shutil
import subprocess
import numpy as np
from headless.rl.environment import number_log
from headless.rl_v4.environment import TYPES, ROOT
from headless.rl_v4.train import fingerprint, write_json


def identity(catalog):
    files=('archive.py','search.py','fit.py','pipeline.py')
    digest=hashlib.sha256()
    for name in files:
        digest.update(name.encode()+b'\0'+(ROOT/'headless/rl_v5'/name).read_bytes())
    return {'search_source':digest.hexdigest(),'runtime':fingerprint(catalog),
            'node':subprocess.check_output([shutil.which('node'),'--version'],text=True).strip()}


def describe(env):
    o=env.o
    crops=[c for c in o['crops'] if c['tier']>=0]
    unlocked=sorted(c['id'] for c in crops)
    mature=sorted(c['id'] for c in crops if c['everMature'])
    by_id={c['id']:c for c in crops}
    counts=[sum(by_id.get(cell['crop'],{}).get('type')==kind for cell in sum(o['field'],[])) for kind in TYPES]
    stock=max(0.,number_log(o['resources']['seeds']))
    production=max(0.,number_log(o['production']['seeds']))
    spores=env.progress()
    # Goal-independent economic novelty plus the actual spore objective.
    # No named crop, placement, upgrade ordering, or scripted action priority.
    score=6*len(unlocked)+3*len(mature)+stock/4+production/2+20*min(1.,spores)
    key=json.dumps([env.game_seed,'root' if env.decisions==0 else 'state',unlocked,mature,int(stock//2),int(production),
                    [min(4,n) for n in counts],int(min(1.,spores)*10)],separators=(',',':'))
    return {'key':key,'seed':env.game_seed,'score':score,'seconds':o['elapsedSeconds'],
            'decisions':env.decisions,'earned_spores':spores,'unlocked':unlocked,'mature':mature,
            'production_log2':production,'stock_log2':stock,'tree_level':o['highestTreeLevel']}


def save_snapshot(path, env, source):
    saved={'origin':'local-archive-search-v1','identity':source,'state':env.export_state(),
           'description':describe(env)}
    encoded=gzip.compress(json.dumps(saved,separators=(',',':')).encode(),mtime=0)
    path=Path(path);temporary=path.with_suffix(path.suffix+'.tmp')
    temporary.write_bytes(encoded);temporary.replace(path)
    return {**saved['description'],'path':str(path.resolve()),'sha256':hashlib.sha256(encoded).hexdigest(),'visits':0}


def load_snapshot(entry, source):
    encoded=Path(entry['path']).read_bytes()
    if hashlib.sha256(encoded).hexdigest()!=entry['sha256']:
        raise RuntimeError('Archive snapshot checksum mismatch')
    value=json.loads(gzip.decompress(encoded))
    if value['origin']!='local-archive-search-v1' or value['identity']!=source:
        raise RuntimeError('Archive provenance/source mismatch')
    if value['description']['seed']!=entry['seed'] or value['state']['game_seed']!=entry['seed']:
        raise RuntimeError('Archive seed mismatch')
    return value


class Archive:
    def __init__(self,capacity=1024):
        self.capacity=capacity
        self.cells={}

    def offer(self,entry):
        old=self.cells.get(entry['key'])
        # Within a coarse cell retain more useful, faster representatives.
        quality=lambda e:(round(e['score'],6),-e['seconds'],-e['decisions'])
        if old and quality(entry)<=quality(old):return False
        if not old and len(self.cells)>=self.capacity:
            candidates=[x for x in self.cells.values() if x['decisions']>0]
            if not candidates:return False
            victim=min(candidates,key=quality)
            if quality(entry)<=quality(victim):return False
            del self.cells[victim['key']]
        if old:entry['visits']=old['visits']
        self.cells[entry['key']]=entry
        return True

    def choose(self,rng,solved):
        entries=[e for e in self.cells.values() if e['seed'] not in solved]
        if not entries:raise RuntimeError('No unsolved archive roots')
        if rng.random()<.65:
            entries=sorted(entries,key=lambda e:e['score'],reverse=True)[:max(9,min(40,len(entries)))]
        weights=np.array([1/math.sqrt(1+e['visits']) for e in entries]);weights/=weights.sum()
        entry=entries[int(rng.choice(len(entries),p=weights))]
        entry['visits']+=1
        return dict(entry)

    def serializable(self):return list(self.cells.values())
