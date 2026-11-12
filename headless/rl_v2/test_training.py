import json
from pathlib import Path
import shutil
import subprocess
import sys
import time
import tempfile
import unittest
from unittest.mock import patch
import numpy as np
import torch
from sb3_contrib import MaskablePPO
from .environment import CurriculumEnv, ROOT
from .policy import StructuredPolicy, action_features


class Tests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        torch.set_num_threads(1)
        cls.node = shutil.which('node')
        cls.catalog = json.loads(subprocess.check_output([cls.node, str(ROOT / 'headless/rl/catalog.mjs')]))

    def env(self, seconds=28800):
        return CurriculumEnv(self.catalog, self.node, seconds)

    def test_real_timing_masks_and_exact_resume(self):
        a, b = self.env(), self.env()
        try:
            obs, _ = a.reset(seed=9)
            self.assertTrue(a.observation_space.contains(obs))
            legal = a.action_masks()
            i = next(i for i, (act, _) in enumerate(a.env.actions) if legal[i] and act['type'] == 'plant')
            a.step(i)
            self.assertAlmostEqual(a.env.observation['elapsedSeconds'], 9.99)
            saved = a.export_state()
            np.testing.assert_array_equal(b.import_state(saved), a.encode())
            x, y = a.step(2), b.step(2)
            np.testing.assert_array_equal(x[0], y[0])
            self.assertEqual(x[1:], y[1:])
            a.reset(); b.reset()
            self.assertEqual(a.env.game_seed, b.env.game_seed)
        finally:
            a.close(); b.close()

    def test_milestones_not_repeatable_curriculum_and_final_objective(self):
        env = self.env()
        try:
            for episode in range(10):
                env.reset(seed=episode)
                env.env.observation['highestTreeLevel'] = 1
                with patch.object(env.env, 'step', return_value=(None, 0, False, False, {})):
                    _, reward, done, truncated, info = env.step(0)
                self.assertEqual(reward, 3)
                self.assertTrue(done)
                self.assertFalse(truncated)
                self.assertTrue(info['episode']['goal_success'])
                self.assertFalse(info['episode']['completed'])
            self.assertEqual(env.pending_target, 2)
            env.reset()
            self.assertEqual(env.target, 2)
            env.env.observation['highestTreeLevel'] = 1
            with patch.object(env.env, 'step', return_value=(None, 0, False, False, {})):
                self.assertEqual(env.step(0)[1], .5)
                self.assertEqual(env.step(0)[1], 0)
            saved = env.export_state()
            self.assertEqual(saved['peak'], 1)
            env.reset(options={'target': 11})
            env.env.observation['highestTreeLevel'] = 6
            with patch.object(env.env, 'step', return_value=(None, 0, False, False, {})):
                self.assertEqual(env.step(0)[1], 0)
        finally:
            env.close()

    def test_structured_weights_learn_and_roundtrip(self):
        env = self.env(33.3)
        try:
            model = MaskablePPO(StructuredPolicy, env, n_steps=16, batch_size=16, n_epochs=1,
                                seed=17, device='cpu', policy_kwargs={
                                    'action_features': action_features(self.catalog, self.node),
                                    'net_arch': {'pi': [32], 'vf': [32]}})
            before = model.policy.action_net.embed[0].weight.detach().clone()
            model.learn(32)
            self.assertFalse(torch.equal(before, model.policy.action_net.embed[0].weight))
            self.assertTrue(model.policy.optimizer.state)
            obs, _ = env.reset(seed=1)
            masks = env.action_masks()
            with tempfile.TemporaryDirectory() as d:
                model.save(Path(d) / 'model.zip')
                loaded = MaskablePPO.load(Path(d) / 'model.zip', device='cpu')
                self.assertEqual(int(model.predict(obs, deterministic=True, action_masks=masks)[0]),
                                 int(loaded.predict(obs, deterministic=True, action_masks=masks)[0]))
                for a, b in zip(model.policy.parameters(), loaded.policy.parameters()):
                    self.assertTrue(torch.equal(a, b))
        finally:
            env.close()

    def test_detached_runner_stop_resume_and_validation(self):
        with tempfile.TemporaryDirectory(prefix='farm-v2-test-') as temporary:
            out = Path(temporary)
            command = [sys.executable, '-m', 'headless.rl_v2.train', '--out', str(out),
                       '--workers', '2', '--steps', '128', '--hours', '.1', '--max-seconds', '333',
                       '--rollout-steps', '16', '--batch-size', '32', '--epochs', '1',
                       '--eval-steps', '4', '--eval-every', '64', '--eval-seconds', '10']
            with open(out / 'log', 'w') as log:
                process = subprocess.Popen(command, stdout=log, stderr=log, start_new_session=True)
                try:
                    deadline = time.monotonic() + 90
                    while not (out / 'metrics.jsonl').exists():
                        self.assertIsNone(process.poll(), (out / 'log').read_text())
                        self.assertLess(time.monotonic(), deadline)
                        time.sleep(.1)
                    process.terminate()
                    self.assertEqual(process.wait(timeout=60), 0, (out / 'log').read_text())
                    state = json.loads((out / 'status.json').read_text())
                    self.assertEqual(state['status'], 'stopped')
                    self.assertGreater(state['steps'], 0)
                    self.assertLess(state['steps'], 128)
                    checkpoint = out / json.loads((out / 'latest.json').read_text())['checkpoint']
                    self.assertTrue((checkpoint / 'environments.json.gz').exists())
                    resumed = subprocess.run(command, stdout=log, stderr=log, timeout=90)
                    self.assertEqual(resumed.returncode, 0, (out / 'log').read_text())
                    state = json.loads((out / 'status.json').read_text())
                    self.assertEqual(state['status'], 'complete')
                    self.assertEqual(state['steps'], 128)
                    self.assertEqual(len(state['training_summary']), 2)
                    self.assertEqual({r['deterministic'] for r in state['validation']}, {True, False})
                    self.assertTrue((out / 'best-target-1.zip').exists())
                    self.assertTrue(all(r['target'] == 11 for r in state['test_evaluation']))
                    self.assertIn('train/entropy_loss', state['optimizer_metrics'])
                finally:
                    if process.poll() is None:
                        process.terminate()
                        process.wait(timeout=60)


if __name__ == '__main__':
    unittest.main()
