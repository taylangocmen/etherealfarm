import json
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest
import copy
import numpy as np
import torch
from sb3_contrib import MaskablePPO
from headless.rl.environment import NodeClient
from .environment import FarmEnv, ROOT, amount
from .policy import SemanticPolicy
from .gate import accepted


class Tests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        torch.set_num_threads(1)
        cls.node=shutil.which('node')
        cls.catalog=json.loads(subprocess.check_output([cls.node,str(ROOT/'headless/rl_v4/catalog.mjs')]))

    def test_observation_extension_preserves_game_dynamics_and_legality(self):
        old=NodeClient(self.node);env=FarmEnv(self.catalog,self.node,333)
        rng=np.random.default_rng(61)
        try:
            base=old.call('reset',seed=17,maxEpisodeSeconds=333)['observation'];obs,_=env.reset(options={'game_seed':17})
            for _ in range(15):
                self.assertTrue(env.observation_space.contains(obs))
                self.assertEqual(env.o['resources'],base['resources'])
                self.assertEqual(env.o['legalActions'],base['legalActions'])
                self.assertEqual(env.o['treeLevel'],base['treeLevel'])
                for c in env.o['crops']:
                    self.assertIn('baseProduction',c)
                    self.assertIn('everMature',c)
                i=int(rng.choice(np.flatnonzero(env.action_masks())));a,ticks=env.actions[i]
                base=old.call('step',action=a,ticks=ticks)['observation']
                obs,_,done,_,_=env.step(i)
                if done:break
        finally:old.close();env.close()

    def test_reward_and_replay(self):
        a=FarmEnv(self.catalog,self.node,333);b=FarmEnv(self.catalog,self.node,333)
        try:
            a.reset(seed=72);initial=a.potential()
            i=next(i for i,(x,_) in enumerate(a.actions) if x['type']=='plant');a.step(i)
            self.assertGreater(a.potential(),initial)
            saved=a.export_state();obs=b.import_state(saved)
            for key in obs:np.testing.assert_array_equal(obs[key],a.encode()[key])
            x,y=a.step(0),b.step(0)
            for k in x[0]:np.testing.assert_array_equal(x[0][k],y[0][k])
            self.assertEqual(x[1:],y[1:])
            # Current-stock changes cannot farm lifetime-resource milestones.
            before=a.potential();a.o['resources']['seeds']={'b':1,'e':80}
            self.assertEqual(a.potential(),before)
        finally:a.close();b.close()

    def test_policy_learns_roundtrips_and_masks(self):
        e=FarmEnv(self.catalog,self.node,33.3)
        try:
            m=MaskablePPO(SemanticPolicy,e,n_steps=16,batch_size=16,n_epochs=1,
                seed=13,device='cpu',policy_kwargs={'net_arch':[]})
            before=m.policy.action_net[0].weight.detach().clone();m.learn(32)
            self.assertFalse(torch.equal(before,m.policy.action_net[0].weight))
            obs,_=e.reset(seed=19);mask=e.action_masks()
            for deterministic in (True,False):
                act,_=m.predict(obs,deterministic=deterministic,action_masks=mask);self.assertTrue(mask[int(act)])
            with tempfile.TemporaryDirectory() as d:
                m.save(Path(d)/'model.zip');loaded=MaskablePPO.load(Path(d)/'model.zip',device='cpu')
                self.assertEqual(int(m.predict(obs,deterministic=True,action_masks=mask)[0]),
                                 int(loaded.predict(obs,deterministic=True,action_masks=mask)[0]))
        finally:e.close()

    def test_evaluation_freezes(self):
        e=FarmEnv(self.catalog,self.node,3.33,training=False)
        try:
            e.reset(options={'game_seed':1});self.assertTrue(e.step(0)[2]);saved=e.export_state()
            e.reset();e.step(0);self.assertEqual(e.export_state(),saved)
            e.reset(options={'game_seed':2});self.assertFalse(e.frozen)
        finally:e.close()

    def test_long_run_gate_rejects_failures_incomplete_and_easy_goal_counts(self):
        seeds=list(range(1_000_005_001,1_000_005_010))
        result={'seeds':seeds,'game_horizon_seconds':14400,'reports':[]}
        for mode,successes in [('sampled',8),('random',2),('greedy',6)]:
            result['reports'].append({'mode':mode,'complete':True,'episodes':[
                {'seed':s,'goal_success':i<successes,'game_seconds':7000,'goal':'earn 1 new spore',
                 'earned_spores':1.1 if i<successes else 0} for i,s in enumerate(seeds)]})
        self.assertTrue(accepted(result))
        bad=copy.deepcopy(result);bad['reports'][0]['complete']=False;bad['passed']=True
        self.assertFalse(accepted(bad))
        bad=copy.deepcopy(result)
        for r in bad['reports']:
            for e in r['episodes']:e['goal']='earn 100 new seeds'
        self.assertFalse(accepted(bad))
        bad=copy.deepcopy(result);bad['reports'][0]['episodes'][0]=None
        self.assertFalse(accepted(bad))
        bad=copy.deepcopy(result);bad['seeds']=seeds[:3]
        self.assertFalse(accepted(bad))
        bad=copy.deepcopy(result)
        for r in bad['reports']:
            for e in r['episodes']:e['goal_success']=False
        self.assertFalse(accepted(bad))
        bad=copy.deepcopy(result);bad['reports'][1]=copy.deepcopy(bad['reports'][0]);bad['reports'][1]['mode']='random'
        self.assertFalse(accepted(bad))


if __name__=='__main__':unittest.main()
