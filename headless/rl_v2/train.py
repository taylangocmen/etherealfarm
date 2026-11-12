"""Random-initialized, offline Maskable PPO with nine local game workers."""
from __future__ import annotations

import argparse
from collections import deque
from datetime import datetime, timezone
import fcntl
from functools import partial
import gzip
import hashlib
import importlib.metadata
import json
import os
from pathlib import Path
import platform
import random
import shutil
import signal
import subprocess
import time
import traceback

# Prevent BLAS/PyTorch thread pools competing with the simulator workers.
for name in ('OMP_NUM_THREADS', 'OPENBLAS_NUM_THREADS', 'MKL_NUM_THREADS', 'VECLIB_MAXIMUM_THREADS'):
    os.environ[name] = '1'
os.environ['MPLCONFIGDIR'] = '/tmp/etherealfarm-matplotlib'

import numpy as np
import torch
from sb3_contrib import MaskablePPO
from stable_baselines3.common.callbacks import BaseCallback
from stable_baselines3.common.vec_env import SubprocVecEnv

from .environment import CurriculumEnv as FarmEnv, ROOT
from .policy import StructuredPolicy, action_features


def now():
    return datetime.now(timezone.utc).isoformat()


def json_default(value):
    if isinstance(value, np.generic):
        return value.item()
    if isinstance(value, np.ndarray):
        return value.tolist()
    raise TypeError(f'Not JSON serializable: {type(value)}')


def write_json(path, value):
    temporary = path.with_name(path.name + '.tmp')
    temporary.write_text(json.dumps(value, indent=2, allow_nan=False, default=json_default) + '\n')
    temporary.replace(path)


def fingerprint(catalog):
    digest = hashlib.sha256()
    for name in ('headless/rl/environment.py', 'headless/rl_v2/environment.py', 'headless/rl_v2/train.py',
                 'headless/rl_v2/policy.py', 'headless/rl/catalog.mjs',
                 'headless/rl/requirements.lock.txt', 'headless/rl/offline.sb', 'headless/cli.mjs'):
        digest.update(name.encode() + b'\0' + (ROOT / name).read_bytes())
    return {'source': digest.hexdigest(), 'engine': catalog['engine'],
            'python': platform.python_version(),
            'packages': {name: importlib.metadata.version(name) for name in
                         ('torch', 'numpy', 'gymnasium', 'stable-baselines3', 'sb3-contrib')}}


class ManagedVecEnv(SubprocVecEnv):
    def close(self):
        if self.closed:
            return
        # Bounded cleanup also works after a worker exception/broken pipe.
        for remote in self.remotes:
            try:
                remote.send(('close', None))
            except (BrokenPipeError, EOFError, OSError):
                pass
        for process in self.processes:
            process.join(timeout=2)
        for process in self.processes:
            if process.is_alive():
                process.terminate()
                process.join(timeout=2)
            if process.is_alive():
                process.kill()
                process.join()
        for remote in self.remotes:
            remote.close()
        self.closed = True


class Progress(BaseCallback):
    def __init__(self, runner):
        super().__init__()
        self.runner = runner
        self.last_report = time.monotonic()

    def _on_step(self):
        for info in self.locals['infos']:
            if 'episode' in info:
                episode = {'event': 'episode', 'at': now(), 'steps': self.num_timesteps, **info['episode']}
                self.runner.recent.append(episode)
                self.runner.events.write(json.dumps(episode, allow_nan=False, default=json_default) + '\n')
                self.runner.events.flush()
        if time.monotonic() - self.last_report >= 30:
            self.runner.report('training')
            self.last_report = time.monotonic()
        stop = self.runner.stopping or self.runner.elapsed() >= self.runner.config['hours'] * 3600 - min(240, self.runner.config['hours'] * 360) or self.num_timesteps >= self.runner.config['steps']
        last_step = self.locals['n_steps'] + 1 == self.locals['n_rollout_steps']
        if stop and not last_step:
            # SB3 calls callbacks before assigning these fields. Keep the saved
            # observation consistent with the already advanced environments.
            # The unfinished rollout is deliberately discarded (not optimized).
            self.model._last_obs = self.locals['new_obs']
            self.model._last_episode_starts = self.locals['dones']
            self.runner.discarded_partial_rollout = True
            return False
        return True


class Runner:
    def __init__(self, args):
        self.args = args
        self.directory = Path(args.out).resolve()
        self.directory.mkdir(parents=True, exist_ok=True)
        self.config = {key: getattr(args, key) for key in
                       ('workers', 'steps', 'hours', 'max_seconds', 'rollout_steps', 'batch_size', 'epochs', 'seed', 'eval_seconds', 'eval_steps', 'eval_every')}
        self.stopping = False
        self.started = time.monotonic()
        self.previous_seconds = 0
        self.vec = None
        self.model = None
        self.state = {}
        self.recent = deque(maxlen=100)
        self.discarded_partial_rollout = False
        self.events = None
        self.lock = None

    def elapsed(self):
        return self.previous_seconds + time.monotonic() - self.started

    def report(self, status):
        if self.vec is not None:
            self.state['worker_progress'] = self.vec.env_method('summary')
        self.state.update(status=status, updated_at=now(), pid=os.getpid(), elapsed_wall_seconds=self.elapsed(),
                          steps=self.model.num_timesteps if self.model else self.state.get('steps', 0),
                          updates=self.model._n_updates if self.model else self.state.get('updates', 0),
                          recent_episodes=list(self.recent))
        write_json(self.directory / 'status.json', self.state)
        print(json.dumps({key: self.state.get(key) for key in ('status', 'updated_at', 'steps', 'updates', 'elapsed_wall_seconds')}), flush=True)

    def make_vec(self, training=True):
        return ManagedVecEnv([partial(FarmEnv, self.catalog, self.args.node,
                                      self.config['max_seconds'], rank, training)
                              for rank in range(self.config['workers'])], start_method='spawn')

    def checkpoint(self):
        # All workers are idle at this point. Publish a directory only after
        # model+optimizer, RNGs and every game checkpoint have been written.
        name = f'checkpoint-{self.model.num_timesteps:012d}-{time.time_ns()}'
        temporary = self.directory / (name + '.tmp')
        temporary.mkdir()
        self.model.save(temporary / 'model.zip')
        environments = self.vec.env_method('export_state')
        with gzip.open(temporary / 'environments.json.gz', 'wt') as handle:
            json.dump(environments, handle, separators=(',', ':'), allow_nan=False)
        torch.save({'python': random.getstate(), 'numpy': np.random.get_state(), 'torch': torch.get_rng_state()}, temporary / 'rng.pt')
        write_json(temporary / 'metadata.json', {
            'identity': self.identity, 'config': self.config, 'steps': self.model.num_timesteps,
            'updates': self.model._n_updates, 'elapsed_wall_seconds': self.elapsed(),
            'episode_starts': self.model._last_episode_starts.tolist(),
            'discarded_partial_rollout': self.discarded_partial_rollout,
        })
        temporary.rename(self.directory / name)
        write_json(self.directory / 'latest.json', {'checkpoint': name})
        self.state['checkpoint'] = name
        # Keep the latest and previous committed checkpoint, never delete a
        # checkpoint before its successor is fully published.
        committed = sorted(p for p in self.directory.glob('checkpoint-*') if p.is_dir() and not p.name.endswith('.tmp'))
        for old in committed[:-2]:
            shutil.rmtree(old)
        self.discarded_partial_rollout = False

    def restore(self, checkpoint):
        metadata = json.loads((checkpoint / 'metadata.json').read_text())
        if metadata['identity'] != self.identity or metadata['config'] != self.config:
            raise RuntimeError('Checkpoint source/configuration mismatch')
        self.model = MaskablePPO.load(checkpoint / 'model.zip', env=self.vec, device='cpu', force_reset=False)
        with gzip.open(checkpoint / 'environments.json.gz', 'rt') as handle:
            environments = json.load(handle)
        # Dispatch restores concurrently; they can involve minutes of replay.
        for remote, saved in zip(self.vec.remotes, environments, strict=True):
            remote.send(('env_method', ('import_state', (saved,), {})))
        restored = np.stack([remote.recv() for remote in self.vec.remotes])
        if self.model._last_obs is not None and not np.array_equal(restored, self.model._last_obs):
            raise RuntimeError('Restored observations differ from model checkpoint')
        self.model._last_obs = restored
        self.model._last_episode_starts = np.asarray(metadata['episode_starts'], dtype=bool)
        # These files are generated locally by this runner. Never load external
        # pickle/model files as part of a from-scratch experiment.
        rng = torch.load(checkpoint / 'rng.pt', map_location='cpu', weights_only=False)
        random.setstate(rng['python'])
        np.random.set_state(rng['numpy'])
        torch.set_rng_state(rng['torch'])

    def evaluate(self, final=False):
        # Training workers remain idle. Only nine evaluation workers compute.
        # Preserve RNGs so evaluation does not alter subsequent training draws.
        saved_rng = (random.getstate(), np.random.get_state(), torch.get_rng_state())
        training_vec = self.vec
        validation = self.make_vec(training=False)
        summaries = training_vec.env_method('summary')
        target = 11 if final else max(w['next_target'] for w in summaries)
        seed_base = 1_000_001_001 if final else 1_000_002_001
        seeds = [seed_base + i for i in range(self.config['workers'])]
        reports = []
        try:
            for deterministic in (True, False):
                torch.manual_seed(1701)
                validation.set_options([{'game_seed': seed, 'target': target} for seed in seeds])
                observations = validation.reset()
                results = [None] * len(seeds)
                last = [None] * len(seeds)
                deadline = min(time.monotonic() + self.config['eval_seconds'],
                               time.monotonic() + max(0, self.config['hours'] * 3600 - self.elapsed()))
                ticks = 0
                while ticks < self.config['eval_steps'] and not self.stopping and time.monotonic() < deadline:
                    masks = np.stack(validation.env_method('action_masks'))
                    actions, _ = self.model.predict(observations, deterministic=deterministic, action_masks=masks)
                    for i, result in enumerate(results):
                        if result is not None:
                            actions[i] = 3
                    observations, _, dones, infos = validation.step(actions)
                    ticks += 1
                    # Freeze metrics at the first episode; ignore auto-reset episodes.
                    for i, summary in enumerate(validation.env_method('summary')):
                        if results[i] is None:
                            last[i] = summary
                        if dones[i] and results[i] is None:
                            results[i] = infos[i]['episode']
                    if all(r is not None for r in results):
                        break
                scores = [r['tree_level'] if r else (w['active_tree_level'] if w else 0)
                          for r, w in zip(results, last)]
                report = {'at': now(), 'steps': self.model.num_timesteps, 'target': target,
                          'deterministic': deterministic, 'seeds': seeds, 'episodes': results,
                          'worker_progress': last, 'decision_rounds': ticks,
                          'budget_complete': ticks == self.config['eval_steps'] or all(r is not None for r in results),
                          'mean_tree_level': float(np.mean(scores)),
                          'goal_successes': sum(bool(r and r['goal_success']) for r in results),
                          'transcensions': sum(bool(r and r['completed']) for r in results)}
                reports.append(report)
            self.state['test_evaluation' if final else 'validation'] = reports
            with open(self.directory / 'evaluations.jsonl', 'a') as handle:
                handle.write(json.dumps({'kind': 'test' if final else 'validation', 'reports': reports}) + '\n')
            if not final and all(r['budget_complete'] for r in reports):
                # Compare within the same target and fixed decision budget only.
                score = [sum(r['goal_successes'] for r in reports),
                         sum(r['mean_tree_level'] for r in reports),
                         -sum(e['game_seconds'] for r in reports for e in r['episodes'] if e and e['goal_success'])]
                best = self.state.setdefault('best_by_target', {})
                key = str(target)
                if key not in best or score > best[key]['score']:
                    temp = self.directory / f'best-target-{target}.tmp.zip'
                    self.model.save(temp)
                    temp.replace(self.directory / f'best-target-{target}.zip')
                    best[key] = {'score': score, 'steps': self.model.num_timesteps, 'reports': reports}
                    write_json(self.directory / 'best.json', best)
        finally:
            validation.close()
            random.setstate(saved_rng[0])
            np.random.set_state(saved_rng[1])
            torch.set_rng_state(saved_rng[2])
        self.report('training' if not final else 'evaluated')

    def run(self):
        self.lock = open(self.directory / 'running.lock', 'a+')
        try:
            fcntl.flock(self.lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            self.lock.close()
            self.lock = None
            raise RuntimeError('Neural training directory already has a live writer')
        self.lock.seek(0)
        self.lock.truncate()
        self.lock.write(str(os.getpid()))
        self.lock.flush()
        writable = False
        try:
            torch.set_num_threads(1)
            torch.set_num_interop_threads(1)
            torch.use_deterministic_algorithms(True)
            self.catalog = json.loads(subprocess.check_output([self.args.node, str(ROOT / 'headless/rl/catalog.mjs')], cwd=ROOT, text=True))
            self.identity = fingerprint(self.catalog)
            self.identity['node'] = subprocess.check_output([self.args.node, '--version'], text=True).strip()
            path = self.directory / 'status.json'
            if path.exists():
                previous = json.loads(path.read_text())
                if previous['identity'] != self.identity or previous['config'] != self.config:
                    raise RuntimeError('Source/configuration changed; use a new output directory')
                self.state = previous
                self.state.pop('error', None)
                self.previous_seconds = previous['elapsed_wall_seconds']
                self.recent.extend(previous.get('recent_episodes', []))
                if previous['status'] == 'complete':
                    print('Training already complete.', flush=True)
                    return
            else:
                self.state = {'format': 'etherealfarm-neural-curriculum-v2', 'created_at': now(),
                              'identity': self.identity, 'config': self.config,
                              'initialization': 'random; no demonstrations or imported policies',
                              'network': 'CPU MaskablePPO, shared structured action scoring, actor/critic [128,128]',
                              'commit': subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=ROOT, text=True).strip()}
                write_json(self.directory / 'catalog.json', self.catalog)
            writable = True
            self.events = open(self.directory / 'episodes.jsonl', 'a', buffering=1)
            self.started = time.monotonic()
            self.report('starting')
            self.vec = self.make_vec()
            manifest = self.directory / 'latest.json'
            if manifest.exists():
                checkpoint = self.directory / json.loads(manifest.read_text())['checkpoint']
                self.report('restoring')
                self.restore(checkpoint)
            else:
                self.model = MaskablePPO(StructuredPolicy, self.vec, device='cpu', seed=self.config['seed'],
                                        learning_rate=1e-4, n_steps=self.config['rollout_steps'],
                                        batch_size=self.config['batch_size'], n_epochs=self.config['epochs'],
                                        gamma=1.0, gae_lambda=.995, ent_coef=.02, target_kl=.03,
                                        policy_kwargs={'net_arch': {'pi': [128, 128], 'vf': [128, 128]},
                                                       'action_features': action_features(self.catalog, self.args.node)}, verbose=0)
                self.model._last_obs = self.vec.reset()
                self.model._last_episode_starts = np.ones(self.config['workers'], dtype=bool)
                self.state['parameters'] = sum(p.numel() for p in self.model.policy.parameters())
                self.state['observation_features'] = self.vec.observation_space.shape[0]
                self.state['actions'] = self.vec.action_space.n
                self.checkpoint()
            callback = Progress(self)
            self.report('training')
            last_checkpoint = last_validation = time.monotonic()
            last_validation_step = self.model.num_timesteps
            self.evaluate()
            rollout = self.config['workers'] * self.config['rollout_steps']
            while not self.stopping and self.model.num_timesteps < self.config['steps'] and self.elapsed() < self.config['hours'] * 3600 - min(240, self.config['hours'] * 360):
                self.model.learn(total_timesteps=rollout, reset_num_timesteps=False, callback=callback)
                metrics = {k: float(v) for k, v in self.model.logger.name_to_value.items()
                           if isinstance(v, (int, float, np.number)) and np.isfinite(v)}
                with open(self.directory / 'metrics.jsonl', 'a') as handle:
                    handle.write(json.dumps({'steps': self.model.num_timesteps, **metrics}) + '\n')
                if metrics:
                    self.state['optimizer_metrics'] = metrics
                if (self.model.num_timesteps - last_validation_step >= self.config['eval_every'] or
                        time.monotonic() - last_validation >= 600) and not self.stopping:
                    self.evaluate()
                    last_validation = time.monotonic()
                    last_validation_step = self.model.num_timesteps
                if time.monotonic() - last_checkpoint >= 300:
                    self.checkpoint()
                    self.report('training')
                    last_checkpoint = time.monotonic()
            self.checkpoint()
            self.report('stopped' if self.stopping else 'trained')
            self.state['training_summary'] = self.state.get('worker_progress', [])
            if not self.stopping:
                self.evaluate()
                self.evaluate(final=True)
            self.state['finished_at'] = now() if not self.stopping else None
            self.report('stopped' if self.stopping else 'complete')
        except Exception:
            if writable:
                self.state.update(status='failed', error=traceback.format_exc(), updated_at=now(), elapsed_wall_seconds=self.elapsed())
                write_json(self.directory / 'status.json', self.state)
            raise
        finally:
            if self.vec is not None:
                self.vec.close()
            if self.events:
                self.events.close()
            if self.lock:
                (self.directory / 'running.lock').unlink(missing_ok=True)
                self.lock.close()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--out', required=True)
    parser.add_argument('--node', default=shutil.which('node'))
    parser.add_argument('--workers', type=int, default=9)
    parser.add_argument('--steps', type=int, default=1_000_000)
    parser.add_argument('--hours', type=float, default=1)
    parser.add_argument('--max-seconds', type=float, default=28800)
    parser.add_argument('--rollout-steps', type=int, default=512)
    parser.add_argument('--batch-size', type=int, default=256)
    parser.add_argument('--epochs', type=int, default=3)
    parser.add_argument('--seed', type=int, default=20261112)
    parser.add_argument('--eval-seconds', type=float, default=60)
    parser.add_argument('--eval-steps', type=int, default=192)
    parser.add_argument('--eval-every', type=int, default=100000)
    args = parser.parse_args()
    if args.eval_steps < 1 or args.eval_every < 1 or not args.node or not 1 <= args.workers <= 32 or args.steps < 1 or not math_is_positive(args.hours) or not .333 <= args.max_seconds <= 604800 or args.rollout_steps < 2 or args.batch_size < 2 or not 1 <= args.epochs <= 20 or not 0 <= args.seed <= 0xffffffff or not math_is_positive(args.eval_seconds):
        parser.error('Invalid training bounds')
    runner = Runner(args)
    def stop(signum, frame):
        runner.stopping = True
    for sig in (signal.SIGTERM, signal.SIGINT):
        signal.signal(sig, stop)
    runner.run()


def math_is_positive(value):
    return np.isfinite(value) and value > 0


if __name__ == '__main__':
    main()
