"""Fresh-seed, full-horizon spore evaluation. This module never launches training."""
import argparse
from functools import partial
import hashlib
import json
from pathlib import Path
import shutil
import subprocess
import time
import numpy as np
import torch
from sb3_contrib import MaskablePPO
from .environment import FarmEnv, ROOT
from .train import ManagedVecEnv, write_json, now, fingerprint


def accepted(result):
    """Recompute acceptance from completed per-seed outcomes, not a passed flag."""
    seeds=result.get('seeds',[])
    if len(seeds)!=9 or len(set(seeds))!=9 or min(seeds)<1_000_000_000:return False
    reports={r['mode']:r for r in result.get('reports',[])}
    if set(reports)!={'sampled','random','greedy'}:return False
    success={};times={}
    for mode,r in reports.items():
        episodes=r.get('episodes',[])
        if not r.get('complete') or len(episodes)!=9 or any(e is None for e in episodes):return False
        if [e['seed'] for e in episodes]!=seeds:return False
        if any(e.get('goal')!='earn 1 new spore' or bool(e['goal_success'])!=(e.get('earned_spores',0)>=1) for e in episodes):return False
        success[mode]=sum(bool(e['goal_success']) for e in episodes)
        times[mode]=float(np.mean([e['game_seconds'] if e['goal_success'] else result['game_horizon_seconds'] for e in episodes]))
    return (success['sampled']>=8 and success['greedy']>=6 and
            (success['sampled']>=success['random']+3 or
             (success['sampled']>=success['random'] and times['sampled']<=.8*times['random'])))


def run(args):
    torch.set_num_threads(1)
    node=shutil.which('node')
    catalog=json.loads(subprocess.check_output([node,str(ROOT/'headless/rl_v4/catalog.mjs')]))
    model=MaskablePPO.load(args.model,device='cpu')
    seeds=[args.seed_base+i for i in range(args.seeds)]
    reports=[]
    for mode in ('sampled','random','greedy'):
        vec=ManagedVecEnv([partial(FarmEnv,catalog,node,args.max_seconds,i,False)
                           for i in range(args.seeds)],start_method='spawn')
        rng=np.random.default_rng(8172);torch.manual_seed(8172)
        try:
            vec.set_options([{'game_seed':s} for s in seeds]);obs=vec.reset()
            results=[None]*args.seeds;start=time.monotonic();step=0
            while not all(r is not None for r in results) and time.monotonic()-start<args.wall_seconds:
                masks=np.stack(vec.env_method('action_masks'))
                if mode=='random':
                    actions=[]
                    for prior,mask in zip(obs['prior'],masks):
                        p=np.exp(prior)*mask;p/=p.sum();actions.append(rng.choice(len(p),p=p))
                    actions=np.array(actions)
                else:actions,_=model.predict(obs,deterministic=mode=='greedy',action_masks=masks)
                obs,_,done,infos=vec.step(actions);step+=1
                for i in range(args.seeds):
                    if results[i] is None and done[i]:results[i]=infos[i]['episode']
            complete=all(r is not None for r in results)
            score_times=[r['game_seconds'] if r and r['goal_success'] else args.max_seconds for r in results]
            r={'mode':mode,'complete':complete,'episodes':results,'successes':sum(bool(r and r['goal_success']) for r in results),
               'mean_capped_seconds':float(np.mean(score_times)),'wall_seconds':time.monotonic()-start,
               'rounds':step,'workers':vec.env_method('summary')}
            reports.append(r);print(json.dumps({k:v for k,v in r.items() if k not in ('episodes','workers')}),flush=True)
        finally:vec.close()
    sampled,random,greedy=reports
    reliable=sampled['successes']>=8 and greedy['successes']>=6
    better=(sampled['successes']>=random['successes']+3 or
            (sampled['successes']>=random['successes'] and
             sampled['mean_capped_seconds']<=.8*random['mean_capped_seconds']))
    passed=args.seeds>=9 and all(r['complete'] for r in reports) and reliable and better
    identity=fingerprint(catalog)
    identity['node']=subprocess.check_output([node,'--version'],text=True).strip()
    result={'at':now(),'passed':passed,'identity':identity,'model':str(Path(args.model).resolve()),
            'model_sha256':hashlib.sha256(Path(args.model).read_bytes()).hexdigest(),
            'seed_base':args.seed_base,'seeds':seeds,'game_horizon_seconds':args.max_seconds,
            'criteria':'9+ fresh seeds; sampled >=8 successes; greedy >=6; +3 successes or >=20% lower capped mean time vs type-balanced random; all trials complete',
            'reports':reports}
    result['passed']=accepted(result)
    write_json(Path(args.out),result);print(json.dumps({'passed':result['passed'],'out':args.out}),flush=True)


if __name__=='__main__':
    p=argparse.ArgumentParser();p.add_argument('--model',required=True);p.add_argument('--out',required=True)
    p.add_argument('--seeds',type=int,default=9);p.add_argument('--seed-base',type=int,default=1_000_003_001)
    p.add_argument('--max-seconds',type=float,default=14400);p.add_argument('--wall-seconds',type=float,default=600)
    run(p.parse_args())
