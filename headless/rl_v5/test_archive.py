import copy
import json
from pathlib import Path
import shutil
import subprocess
import sys
import time
import tempfile
import unittest
import numpy as np
import torch
from sb3_contrib import MaskablePPO
from headless.rl_v4.environment import FarmEnv, ROOT
from headless.rl_v4.policy import SemanticPolicy
from .archive import Archive, describe, identity, load_snapshot, save_snapshot
from .fit import replay_discovery, train_batch


class Tests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        torch.set_num_threads(1)
        cls.node=shutil.which('node')
        cls.catalog=json.loads(subprocess.check_output([cls.node,str(ROOT/'headless/rl_v4/catalog.mjs')]))
        cls.source=identity(cls.catalog)

    def test_archive_restores_identical_state_and_can_explore_new_continuation(self):
        a=FarmEnv(self.catalog,self.node,333);b=FarmEnv(self.catalog,self.node,333)
        try:
            a.reset(options={'game_seed':731})
            plant=next(i for i,(act,_) in enumerate(a.actions) if act['type']=='plant')
            a.step(plant)
            with tempfile.TemporaryDirectory() as directory:
                entry=save_snapshot(Path(directory)/'state.gz',a,self.source)
                saved=load_snapshot(entry,self.source)
                restored=b.import_state(saved['state'])
                for k in restored:np.testing.assert_array_equal(restored[k],a.encode()[k])
                left,right=a.step(0),b.step(0)
                for k in left[0]:np.testing.assert_array_equal(left[0][k],right[0][k])
                self.assertEqual(left[1:],right[1:])
                b.import_state(saved['state'])
                alternate=1  # A different legal wait duration after restoring the same state.
                b.step(alternate)
                self.assertNotEqual(a.export_state()['snapshot']['history'],b.export_state()['snapshot']['history'])
                self.assertEqual(load_snapshot(entry,self.source)['state'],saved['state'])
        finally:a.close();b.close()

    def test_archive_rejects_tampering_and_cross_version_states(self):
        env=FarmEnv(self.catalog,self.node,333)
        try:
            env.reset(options={'game_seed':733})
            with tempfile.TemporaryDirectory() as directory:
                path=Path(directory)/'state.gz';entry=save_snapshot(path,env,self.source)
                wrong=copy.deepcopy(self.source);wrong['search_source']='wrong'
                with self.assertRaisesRegex(RuntimeError,'provenance'):load_snapshot(entry,wrong)
                path.write_bytes(path.read_bytes()+b'changed')
                with self.assertRaisesRegex(RuntimeError,'checksum'):load_snapshot(entry,self.source)
        finally:env.close()

    def test_archive_selection_preserves_roots_and_skips_solved_seeds(self):
        archive=Archive(3)
        def entry(key,seed,score,steps):
            return {'key':key,'seed':seed,'score':score,'seconds':steps*10,'decisions':steps,'visits':0}
        self.assertTrue(archive.offer(entry('root1',1,1,0)))
        self.assertTrue(archive.offer(entry('root2',2,1,0)))
        self.assertTrue(archive.offer(entry('productive',1,5,10)))
        self.assertFalse(archive.offer(entry('productive',1,4,12)))
        self.assertTrue(archive.offer(entry('better',2,6,11)))
        self.assertIn('root1',archive.cells);self.assertIn('root2',archive.cells)
        for _ in range(20):self.assertEqual(archive.choose(np.random.default_rng(1),{1})['seed'],2)

    def test_unsuccessful_path_cannot_become_training_demonstration(self):
        env=FarmEnv(self.catalog,self.node,333)
        try:
            env.reset(options={'game_seed':735});env.step(0)
            with tempfile.TemporaryDirectory() as directory:
                entry=save_snapshot(Path(directory)/'state.gz',env,self.source)
                with self.assertRaisesRegex(RuntimeError,'successful'):
                    replay_discovery((entry,self.source,self.catalog,self.node,directory))
                entry['earned_spores']=1 # Falsifying summary cannot bypass actual replay.
                with self.assertRaisesRegex(RuntimeError,'failed fresh replay'):
                    replay_discovery((entry,self.source,self.catalog,self.node,directory))
                self.assertFalse(list(Path(directory).glob('*.npz')))
        finally:env.close()

    def test_self_imitation_gradient_and_saved_policy_roundtrip(self):
        env=FarmEnv(self.catalog,self.node,333)
        try:
            model=MaskablePPO(SemanticPolicy,env,seed=918,device='cpu',policy_kwargs={'net_arch':[]})
            obs,_=env.reset(seed=918);index=next(i for i,(a,_) in enumerate(env.actions) if a['type']=='plant')
            tensors={k:torch.tensor(v[None]) for k,v in obs.items()};mask=torch.tensor(env.action_masks()[None])
            labels=torch.tensor([index]);returns=torch.tensor([1.])
            before=model.policy.action_net[0].weight.detach().clone()
            for _ in range(3):train_batch(model,tensors,mask,labels,returns)
            self.assertFalse(torch.equal(before,model.policy.action_net[0].weight))
            with tempfile.TemporaryDirectory() as directory:
                path=Path(directory)/'model.zip';model.save(path);restored=MaskablePPO.load(path,device='cpu')
                self.assertEqual(int(model.predict(obs,deterministic=True,action_masks=env.action_masks())[0]),
                                 int(restored.predict(obs,deterministic=True,action_masks=env.action_masks())[0]))
        finally:env.close()

    def test_search_stop_resume_preserves_archive_and_unique_job_ids(self):
        with tempfile.TemporaryDirectory(prefix='farm-v5-resume-') as temporary:
            directory=Path(temporary);out=directory/'search'
            command=[sys.executable,'-m','headless.rl_v5.search','--out',str(out),
                     '--workers','2','--discoveries','2','--minutes','.25','--chunk-steps','4']
            with open(directory/'log','w') as log:
                process=subprocess.Popen(command,stdout=log,stderr=log)
                try:
                    deadline=time.monotonic()+30
                    while True:
                        self.assertIsNone(process.poll(),(directory/'log').read_text())
                        self.assertLess(time.monotonic(),deadline)
                        counter=out/'counter.json'
                        if counter.exists() and json.loads(counter.read_text())['next']>=5:break
                        time.sleep(.05)
                    process.terminate();self.assertEqual(process.wait(timeout=20),0,(directory/'log').read_text())
                    saved=json.loads((out/'archive.json').read_text());first_counter=json.loads(counter.read_text())['next']
                    self.assertEqual(saved['status'],'stopped');self.assertGreater(len(saved['cells']),1)
                    for entry in saved['cells']:load_snapshot(entry,self.source)
                    result=subprocess.run(command,stdout=log,stderr=log,timeout=35)
                    self.assertEqual(result.returncode,0,(directory/'log').read_text())
                    self.assertGreater(json.loads(counter.read_text())['next'],first_counter)
                    final=json.loads((out/'archive.json').read_text())
                    self.assertGreaterEqual(final['restored_branches'],saved['restored_branches'])
                    self.assertEqual(final['status'],'budget_exhausted')
                finally:
                    if process.poll() is None:process.terminate();process.wait(timeout=20)


if __name__=='__main__':unittest.main()
