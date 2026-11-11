"""Meaningful adapter, objective, learning and recovery integration checks."""
import fcntl
import gzip
import json
import os
from pathlib import Path
import shutil
import signal
import subprocess
import sys
import tempfile
import time
import unittest

import numpy as np
from sb3_contrib import MaskablePPO

from .environment import FarmEnv, ROOT, potential, reward_for


def read(path):
    return json.loads(path.read_text())


class AdapterTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.node = shutil.which('node')
        cls.catalog = json.loads(subprocess.check_output([cls.node, str(ROOT / 'headless/rl/catalog.mjs')], text=True))

    def test_mask_encoding_and_replay_restore(self):
        original = FarmEnv(self.catalog, self.node, max_seconds=333)
        restored = FarmEnv(self.catalog, self.node, max_seconds=333)
        try:
            first, _ = original.reset(seed=73)
            self.assertTrue(original.observation_space.contains(first))
            self.assertEqual(int(original.action_masks().sum()), len(original.observation['legalActions']) + 3)
            bad = int(np.flatnonzero(~original.action_masks())[0])
            before = original.export_state()
            with self.assertRaises(ValueError):
                original.step(bad)
            self.assertEqual(original.export_state(), before)
            plant = next(i for i, (a, _) in enumerate(original.actions) if a['type'] == 'plant' and original.action_masks()[i])
            original.step(plant)
            for _ in range(3):
                original.step(1)
            saved = original.export_state()
            np.testing.assert_array_equal(restored.import_state(saved), original.encode())
            np.testing.assert_array_equal(restored.action_masks(), original.action_masks())
            a, b = original.step(2), restored.step(2)
            np.testing.assert_array_equal(a[0], b[0])
            self.assertEqual(a[1:], b[1:])
            original.reset()
            restored.reset()
            self.assertEqual(original.game_seed, restored.game_seed)
        finally:
            original.close()
            restored.close()

    def test_deadline_is_failure_not_bootstrapped_truncation(self):
        env = FarmEnv(self.catalog, self.node, max_seconds=3.33)
        try:
            env.reset(seed=1)
            initial_potential = potential(env.observation)
            _, reward, terminated, truncated, info = env.step(3)
            self.assertTrue(terminated)
            self.assertFalse(truncated)
            self.assertTrue(info['deadline_failure'])
            self.assertFalse(info['episode']['completed'])
            self.assertAlmostEqual(reward, -2 - initial_potential)
            self.assertFalse(env.action_masks().any())
        finally:
            env.close()

    def test_shaping_telescopes_and_cannot_reward_resource_cycles(self):
        def observation(level, earned, completed=False, truncated=False):
            return {'treeLevel': level, 'earnedResources': {'seeds': {'b': earned, 'e': 0}, 'spores': {'b': 0, 'e': 0}},
                    'completed': completed, 'truncated': truncated}
        start = observation(0, 10)
        middle = observation(5, 10000)
        success = observation(0, 10000, completed=True)
        reward1, _ = reward_for(start, middle, 40, 100)
        reward2, _ = reward_for(middle, success, 10, 100)
        self.assertAlmostEqual(reward1 + reward2, 2 - .5 - potential(start))
        forward, _ = reward_for(start, middle, 1, 100)
        backward, _ = reward_for(middle, start, 1, 100)
        self.assertAlmostEqual(forward + backward, -.02)
        failure = observation(5, 10000, truncated=True)
        failed, _ = reward_for(start, failure, 100, 100)
        self.assertLess(failed, reward1 + reward2)


class TrainingTests(unittest.TestCase):
    def test_optimizer_checkpoint_signal_resume_worker_failure_and_lock(self):
        with tempfile.TemporaryDirectory(prefix='farm-rl-') as temporary:
            directory = Path(temporary)
            args = [sys.executable, '-m', 'headless.rl.train', '--out', str(directory),
                    '--workers', '2', '--steps', '256', '--hours', '.1', '--max-seconds', '333',
                    '--rollout-steps', '16', '--batch-size', '32', '--epochs', '1', '--eval-seconds', '15']
            output = open(directory / 'run.log', 'a+')
            child = None

            def launch(arguments=args):
                return subprocess.Popen(arguments, cwd=ROOT, stdout=output, stderr=subprocess.STDOUT)

            def wait_for(predicate, timeout=60):
                end = time.monotonic() + timeout
                while time.monotonic() < end:
                    status = read(directory / 'status.json') if (directory / 'status.json').exists() else {}
                    if predicate(status):
                        return status
                    if child and child.poll() is not None:
                        self.fail((directory / 'run.log').read_text())
                    time.sleep(.05)
                self.fail('Timed out waiting for training state: ' + (directory / 'run.log').read_text())

            try:
                # Lock rejection cannot overwrite a live writer's lock/state.
                with open(directory / 'running.lock', 'a+') as lock:
                    fcntl.flock(lock, fcntl.LOCK_EX)
                    duplicate = launch()
                    self.assertNotEqual(duplicate.wait(timeout=20), 0)
                child = launch()
                wait_for(lambda s: s.get('status') == 'training' and s.get('pid') == child.pid)
                child.send_signal(signal.SIGTERM)
                self.assertEqual(child.wait(timeout=40), 0, (directory / 'run.log').read_text())
                stopped = read(directory / 'status.json')
                self.assertEqual(stopped['status'], 'stopped')
                checkpoint = directory / read(directory / 'latest.json')['checkpoint']
                with gzip.open(checkpoint / 'environments.json.gz', 'rt') as handle:
                    saved = json.load(handle)
                self.assertEqual(len(saved), 2)
                model = MaskablePPO.load(checkpoint / 'model.zip', device='cpu')
                self.assertEqual(model.num_timesteps, stopped['steps'])
                initial_weights = {name: tensor.clone() for name, tensor in model.policy.state_dict().items()}

                child = launch()
                active = wait_for(lambda s: s.get('status') == 'training' and s.get('pid') == child.pid)
                os.kill(active['worker_progress'][0]['node_pid'], signal.SIGKILL)
                self.assertNotEqual(child.wait(timeout=40), 0)
                self.assertEqual(read(directory / 'status.json')['status'], 'failed')
                self.assertTrue(checkpoint.exists())

                child = launch()
                self.assertEqual(child.wait(timeout=90), 0, (directory / 'run.log').read_text())
                finished = read(directory / 'status.json')
                self.assertEqual(finished['status'], 'complete')
                self.assertEqual(finished['steps'], 256)
                self.assertGreater(finished['updates'], 0)
                self.assertEqual(finished['evaluation']['seeds'], [1_000_001_001, 1_000_001_002])
                self.assertNotIn('error', finished)
                final = directory / read(directory / 'latest.json')['checkpoint']
                learned = MaskablePPO.load(final / 'model.zip', device='cpu')
                self.assertTrue(learned.policy.optimizer.state)
                self.assertTrue(any(not np.array_equal(initial_weights[name].numpy(), tensor.numpy())
                                    for name, tensor in learned.policy.state_dict().items()))
                before = (directory / 'status.json').read_bytes()
                mismatch = launch(args + ['--seed', '99'])
                self.assertNotEqual(mismatch.wait(timeout=20), 0)
                self.assertEqual((directory / 'status.json').read_bytes(), before)
                complete_again = launch()
                self.assertEqual(complete_again.wait(timeout=20), 0)
                self.assertEqual((directory / 'status.json').read_bytes(), before)
            finally:
                if child and child.poll() is None:
                    child.terminate()
                    try:
                        child.wait(timeout=40)
                    except subprocess.TimeoutExpired:
                        child.kill()
                        child.wait()
                output.close()


if __name__ == '__main__':
    unittest.main()
