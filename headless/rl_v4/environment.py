"""First-spore learning with semantic actions and continuous prerequisite feedback."""
from collections import Counter
import json
import math
import subprocess
import gymnasium as gym
import numpy as np
from headless.rl.environment import ROOT, NodeClient, number_log

MAX_ACTIONS = 512
KINDS = ('wait','plant','replace','delete','upgrade','fern','inspect','weather','fruit-select','fruit-move','transcend')
TYPES = ('brassica','berry','mushroom','flower','nettle','bee','nut')
ACTION_DIM = 48
GLOBAL_DIM = 32
FINAL_TARGET = 0


def goal_name(_):
    return 'earn 1 new spore'


def amount(n):
    return math.copysign(2 ** min(128, abs(number_log(n))) - 1, number_log(n))


class Client(NodeClient):
    def __init__(self, node):
        self.process = subprocess.Popen([node, str(ROOT / 'headless/rl_v4/cli.mjs')], cwd=ROOT,
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True, bufsize=1)
        self.sequence = 0


class FarmEnv(gym.Env):
    def __init__(self, catalog, node, max_seconds=14400, rank=0, training=True):
        self.catalog, self.node, self.limit, self.rank, self.training = catalog,node,max_seconds,rank,training
        self.client = None
        self.o = None
        self.actions = []
        self.frozen = False
        self.episodes = self.successes = self.timeouts = self.total_decisions = self.total_ticks = 0
        self.counts = Counter()
        self.max_level = 0
        self.observation_space = gym.spaces.Dict({
            'global': gym.spaces.Box(-16,16,(GLOBAL_DIM,),np.float32),
            'actions': gym.spaces.Box(-16,16,(MAX_ACTIONS,ACTION_DIM),np.float32),
            'prior': gym.spaces.Box(-16,0,(MAX_ACTIONS,),np.float32)})
        self.action_space = gym.spaces.Discrete(MAX_ACTIONS)

    def reset(self, *, seed=None, options=None):
        super().reset(seed=seed)
        if self.frozen and not options and not self.training:
            return self.encode(), {}
        if self.client is None:
            self.client = Client(self.node)
        self.game_seed = int((options or {}).get('game_seed', self.np_random.integers(1,1_000_000_000)))
        result = self.client.call('reset',seed=self.game_seed,maxEpisodeSeconds=self.limit)
        if result['metadata']['engineFingerprint'] != self.catalog['engine']:
            raise RuntimeError('Engine fingerprint mismatch')
        self.o = result['observation']
        self.frozen = False
        self.earned_start = amount(self.o['earnedResources']['spores'])
        self.decisions = 0
        self.return_ = 0.
        self.last_phi = self.potential()
        self.refresh()
        return self.encode(), {}

    def progress(self):
        return max(0.,amount(self.o['earnedResources']['spores'])-self.earned_start)

    def potential(self):
        # Credits prerequisites without prescribing actions, crops or placements.
        # Current production losses are negative; restoring it cancels that loss.
        # Unlock/maturity flags and lifetime earnings cannot be farmed by refunds.
        o = self.o
        unlocks = sum(c['type'] != 'brassica' for c in o['crops'] if c['tier'] >= 0)
        mature = sum(c['everMature'] for c in o['crops'] if c['tier'] >= 0 and c['type'] != 'brassica')
        return (.1*number_log(o['earnedResources']['seeds']) +
                .2*number_log(o['production']['seeds']) + .75*unlocks + .75*mature +
                10*min(1.,math.log1p(self.progress())/math.log(2)))

    def refresh(self):
        self.actions = []
        for a in self.o['legalActions']:
            if a['type']=='wait':
                self.actions.extend((a,t) for t in (30,90,300,900))
            else:
                self.actions.append((a,30))
        if len(self.actions)>MAX_ACTIONS:
            raise RuntimeError(f'Action capacity exceeded: {len(self.actions)}')

    def action_masks(self):
        mask=np.zeros(MAX_ACTIONS,dtype=bool)
        mask[:1 if self.frozen else len(self.actions)]=True
        return mask

    def encode(self):
        o=self.o; crops={c['id']:c for c in o['crops']}; upgrades={u['id']:u for u in o['upgrades']}
        g=np.zeros(GLOBAL_DIM,np.float32)
        g[:10]=[o['elapsedSeconds']/self.limit,number_log(o['resources']['seeds'])/24,
                number_log(o['resources']['spores'])/24,number_log(o['earnedResources']['seeds'])/24,
                number_log(o['earnedResources']['spores'])/24,number_log(o['production']['seeds'])/16,
                number_log(o['production']['spores'])/16,o['treeLevel']/10,len(crops)/20,self.last_phi/20]
        for cell in sum(o['field'],[]):
            c=crops.get(cell['crop'])
            if c and c['type'] in TYPES:
                k=TYPES.index(c['type']);g[10+k]+=1/25;g[17+k]+=float(cell['growth']>=1)/25
        g[24:27]=[sum(c['everMature'] for c in crops.values())/20,
                  max((c['tier'] for c in crops.values()),default=0)/10,self.progress()]
        features=np.zeros((MAX_ACTIONS,ACTION_DIM),np.float32)
        prior=np.zeros(MAX_ACTIONS,np.float32)
        counts=Counter(a['type'] for a,_ in self.actions)
        for i,(a,ticks) in enumerate(self.actions):
            row=features[i];row[KINDS.index(a['type'])]=1
            u=upgrades.get(a.get('upgrade'));c=crops.get(a.get('crop'))
            if c is None and u:
                # The crop may be locked: static catalog gives its function.
                c=crops.get(u['crop']) or next((x for x in self.catalog['crops'] if x['id']==u['crop']),None)
            if c and c['type'] in TYPES:row[11+TYPES.index(c['type'])]=1
            cost=(u or c or {}).get('cost',{})
            row[18]=number_log(cost.get('seeds',{'b':0,'e':0}))/24
            row[19]=number_log(cost.get('spores',{'b':0,'e':0}))/24
            row[20]=ticks/900
            if c:
                row[21]=c['tier']/10
                row[22]=c.get('growthSeconds',0)/600
                row[23]=float(c.get('everMature',False))
                row[24]=number_log(c.get('baseProduction',{}).get('seeds',{'b':0,'e':0}))/16
                row[25]=number_log(c.get('baseProduction',{}).get('spores',{'b':0,'e':0}))/16
            if u:
                row[26:29]=[u['cropUnlock'],u['cropUpgrade'],math.log1p(u['count'])/8]
            if 'x' in a:
                cell=o['field'][a['y']][a['x']];old=crops.get(cell['crop'])
                row[29:34]=[a['x']/4,a['y']/4,cell['growth'],
                    number_log(cell['production']['seeds'])/16,number_log(cell['production']['spores'])/16]
                row[34]=number_log(cell['recoup']['seeds'])/24
                row[35]=float(old is not None and c is not None and old['id']==c['id'])
                for dx,dy in ((1,0),(-1,0),(0,1),(0,-1)):
                    x,y=a['x']+dx,a['y']+dy
                    if 0<=x<5 and 0<=y<5:
                        neighbor=crops.get(o['field'][y][x]['crop'])
                        if neighbor and neighbor['type'] in TYPES:row[36+TYPES.index(neighbor['type'])]+=.25
                if old:
                    row[43]=old['tier']/10
                    row[44]=float(old['type']=='berry')
                    row[45]=float(old['type']=='mushroom')
            row[46]=len(self.actions)/MAX_ACTIONS
            row[47]=float(c is not None and c['id'] in crops)
            # Equal initial mass per action type, rather than per coordinate.
            prior[i]=-math.log(counts[a['type']])
        return {'global':np.clip(g,-16,16),'actions':np.clip(features,-16,16),'prior':prior}

    def step(self,index):
        if self.frozen:return self.encode(),0.,False,False,{}
        index=int(index)
        if not 0<=index<len(self.actions):raise ValueError('Invalid action')
        a,ticks=self.actions[index];before=self.o['elapsedSeconds']
        result=self.client.call('step',action=a,ticks=ticks);self.o=result['observation']
        success=self.progress()>=1
        done=success or result['terminated'] or result['truncated']
        phi=self.potential()
        reward=phi-self.last_phi-(self.o['elapsedSeconds']-before)/self.limit
        reward+=10 if success else (-2 if done else 0)
        self.last_phi=phi;self.return_+=reward;self.decisions+=1;self.total_decisions+=1
        self.total_ticks+=round((self.o['elapsedSeconds']-before)/.333)
        self.max_level=max(self.max_level,self.o['highestTreeLevel']);self.counts[a['type']]+=1
        info={}
        if done:
            self.episodes+=1;self.successes+=int(success);self.timeouts+=int(not success)
            info['episode']={'r':self.return_,'l':self.decisions,'completed':bool(self.o['completed']),
                'goal_success':success,'goal_progress':min(1.,self.progress()),'earned_spores':self.progress(),
                'target':0,'goal':goal_name(0),
                'tree_level':self.o['highestTreeLevel'],'game_seconds':self.o['elapsedSeconds'],'seed':self.game_seed}
            if not self.training:self.frozen=True
        self.refresh()
        return self.encode(),float(reward),bool(done),False,info

    def summary(self):
        return {'worker':self.rank,'node_pid':self.client.process.pid if self.client else None,
            'episodes':self.episodes,'successes':self.successes,'timeouts':self.timeouts,
            'target':0,'next_target':0,'goal':goal_name(0),'goal_progress':self.progress() if self.o else 0,
            'max_tree_level':self.max_level,'active_tree_level':self.o['treeLevel'] if self.o else 0,
            'active_seconds':self.o['elapsedSeconds'] if self.o else 0,'action_counts':dict(self.counts),
            'total_decisions':self.total_decisions,'total_ticks':self.total_ticks,
            'unlocked_crops':[c['name'] for c in self.o['crops']] if self.o else []}

    def export_state(self):
        keys=('game_seed','earned_start','last_phi','decisions','return_','episodes','successes','timeouts',
              'total_decisions','total_ticks','max_level','frozen')
        return {'snapshot':self.client.call('snapshot'),'rng':self.np_random.bit_generator.state,
                'counts':dict(self.counts),**{k:getattr(self,k) for k in keys}}

    def import_state(self,saved):
        self.reset(options={'game_seed':saved['game_seed']})
        self.o=self.client.call('restore',snapshot=saved['snapshot'])
        for k,v in saved.items():
            if k not in ('snapshot','rng','counts'):setattr(self,k,v)
        self.np_random.bit_generator.state=saved['rng'];self.counts=Counter(saved['counts']);self.refresh()
        return self.encode()

    def close(self):
        if self.client:self.client.close();self.client=None
