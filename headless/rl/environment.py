"""Local Gymnasium adapter. No gameplay policy, demonstrations or network calls."""
from __future__ import annotations

import json
import math
import os
from pathlib import Path
import select
import subprocess
import time

import gymnasium as gym
import numpy as np
from gymnasium import spaces

ROOT = Path(__file__).resolve().parents[2]
WAIT_TICKS = (1, 10, 100, 1000)
RESOURCES = ('seeds', 'spores', 'resin', 'twigs', 'nuts', 'infseeds', 'amber', 'essence', 'infspores')
FRUIT_SLOTS = tuple(range(16)) + tuple(range(100, 132))


def action_key(action):
    return json.dumps(action, sort_keys=True, separators=(',', ':'))


def number_log(value):
    """Signed log2(1+abs(value)) without expanding b*2**e to infinity."""
    b, e = value.get('b', 0), value.get('e', 0)
    if not b:
        return 0.0
    exponent = math.log2(abs(b)) + e
    result = exponent if exponent > 40 else math.log2(1 + 2 ** exponent)
    return math.copysign(result, b)


def potential(observation):
    # Potential differences telescope to a constant over a complete episode.
    # No rewards for imitating a layout, planting, or choosing particular crops.
    if observation['completed'] or observation['truncated']:
        return 0.0
    earned = observation['earnedResources']
    return observation['treeLevel'] / 10 + .02 * (number_log(earned['seeds']) + number_log(earned['spores']))


def reward_for(previous, current, elapsed, limit):
    base = -elapsed / limit
    if current['completed']:
        base += 2
    elif current['truncated']:
        base -= 1
    return base + potential(current) - potential(previous), base


class NodeClient:
    def __init__(self, node):
        self.process = subprocess.Popen(
            [node, str(ROOT / 'headless/cli.mjs')], cwd=ROOT,
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=None,
            text=True, bufsize=1,
        )
        self.sequence = 0

    def call(self, command, **kwargs):
        self.sequence += 1
        request = {'id': self.sequence, 'command': command, **kwargs}
        self.process.stdin.write(json.dumps(request, separators=(',', ':')) + '\n')
        self.process.stdin.flush()
        timeout = 1800 if command == 'restore' else 120
        if not select.select([self.process.stdout], [], [], timeout)[0]:
            raise TimeoutError(f'Node {command} did not respond within {timeout}s')
        line = self.process.stdout.readline()
        if not line:
            raise RuntimeError(f'Node game worker exited ({self.process.poll()})')
        response = json.loads(line)
        if response.get('id') != self.sequence or not response.get('ok'):
            raise RuntimeError(f'Game protocol error: {response}')
        return response['result']

    def close(self):
        if self.process.poll() is None:
            try:
                self.process.stdin.close()
                self.process.wait(timeout=5)
            except (OSError, subprocess.TimeoutExpired):
                self.process.terminate()
                try:
                    self.process.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    self.process.kill()
                    self.process.wait()
        if self.process.stdout:
            self.process.stdout.close()


class FarmEnv(gym.Env):
    metadata = {'render_modes': []}

    def __init__(self, catalog, node, max_seconds=28800, rank=0, training=True):
        super().__init__()
        self.catalog = catalog
        self.node = node
        self.max_seconds = max_seconds
        self.rank = rank
        self.training = training
        self.client = None
        self.observation = None
        self.game_seed = None
        self.decisions = 0
        self.episode_return = 0.0
        self.base_return = 0.0
        self.episode_count = 0
        self.total_ticks = 0
        self.total_decisions = 0
        self.successes = 0
        self.timeouts = 0
        self.max_tree_level = 0
        self.effective_limit = math.floor(max_seconds * 1000 / 333 + 1e-9) * .333
        self.crop_index = {c['id']: i for i, c in enumerate(catalog['crops'])}
        self.upgrade_index = {u['id']: i for i, u in enumerate(catalog['upgrades'])}
        self.achievement_index = {value: i for i, value in enumerate(catalog['achievements'])}
        self.actions = []
        for ticks in WAIT_TICKS:
            self.actions.append(({'type': 'wait'}, ticks))
        for y in range(5):
            for x in range(5):
                for kind in ('delete', 'fern'):
                    self.actions.append(({'type': kind, 'x': x, 'y': y}, 1))
                for crop in catalog['crops']:
                    for kind in ('plant', 'replace'):
                        self.actions.append(({'type': kind, 'x': x, 'y': y, 'crop': crop['id']}, 1))
        for upgrade in catalog['upgrades']:
            for choice in ([1, 2] if upgrade['choice'] else [None]):
                action = {'type': 'upgrade', 'upgrade': upgrade['id']}
                if choice is not None:
                    action['choice'] = choice
                self.actions.append((action, 1))
        for ability in range(3):
            self.actions.append(({'type': 'weather', 'ability': ability}, 1))
        for page in ('help', 'changelog', 'stats', 'fruit'):
            self.actions.append(({'type': 'inspect', 'page': page}, 1))
        for slot in (-1, *range(16)):
            self.actions.append(({'type': 'fruit-select', 'slot': slot}, 1))
        for slot in FRUIT_SLOTS:
            self.actions.append(({'type': 'fruit-move', 'slot': slot, 'destination': 'sacrifice' if slot < 100 else 'storage'}, 1))
        self.actions.append(({'type': 'transcend'}, 1))
        self.action_indices = {action_key(a): i for i, (a, _) in enumerate(self.actions) if a['type'] != 'wait'}
        self.action_space = spaces.Discrete(len(self.actions))
        # Build the feature width independently of a running game.
        self.observation_space = spaces.Box(-16, 16, shape=(self.feature_count(),), dtype=np.float32)

    def feature_count(self):
        # Globals, cells, crop stats, upgrade stats, medals, weather, fern, fruit.
        return (6 + 3 * len(RESOURCES) + 4 + 2 +
                25 * (len(self.catalog['crops']) + 3) +
                len(self.catalog['crops']) * 5 + len(self.catalog['upgrades']) * 8 +
                len(self.catalog['achievements']) + 3 * 6 + 4 + 2 + len(FRUIT_SLOTS) * 20)

    def _client(self):
        if self.client is None:
            self.client = NodeClient(self.node)
        return self.client

    def reset(self, *, seed=None, options=None):
        super().reset(seed=seed)
        # Training and final evaluation occupy disjoint game-seed ranges.
        self.game_seed = int(options['game_seed']) if options and 'game_seed' in options else int(self.np_random.integers(1, 1_000_000_000))
        result = self._client().call('reset', seed=self.game_seed, maxEpisodeSeconds=self.max_seconds)
        if result['metadata']['engineFingerprint'] != self.catalog['engine']:
            raise RuntimeError('Simulator/catalog fingerprint mismatch')
        self.effective_limit = result['metadata']['maxEpisodeSeconds']
        self.observation = result['observation']
        self.decisions = 0
        self.episode_return = self.base_return = 0.0
        self._refresh_mask()
        return self.encode(), {}

    def _refresh_mask(self):
        self.mask = np.zeros(self.action_space.n, dtype=bool)
        for action in self.observation['legalActions']:
            if action['type'] == 'wait':
                self.mask[:len(WAIT_TICKS)] = True
            else:
                key = action_key(action)
                if key not in self.action_indices:
                    raise RuntimeError(f'Legal action absent from fixed catalog: {action}')
                self.mask[self.action_indices[key]] = True

    def action_masks(self):
        return self.mask.copy()

    def encode(self):
        o = self.observation
        features = [o['elapsedSeconds'] / self.effective_limit, o['treeLevel'] / 10,
                    o['highestTreeLevel'] / 10, o['timeAtTreeLevelSeconds'] / 3600,
                    o['seasonRemainingSeconds'] / 86400, math.log2(1 + o['collectedFerns']) / 32]
        for field in ('resources', 'treeRequirement', 'earnedResources'):
            features.extend(number_log(o[field][name]) / 128 for name in RESOURCES)
        features.extend(float(o['season'] == i) for i in range(4))
        features.extend([number_log(o['pendingResin']) / 128, number_log(o['awardedResin']) / 128])
        for row in o['field']:
            for cell in row:
                onehot = [0.] * len(self.crop_index)
                if cell['crop'] is not None:
                    onehot[self.crop_index[cell['crop']]] = 1.
                features.extend(onehot)
                features.extend([float(cell['crop'] is None and cell['tile'] == 0),
                                 float(cell['crop'] is None and cell['tile'] != 0), cell['growth']])
        crops = {c['id']: c for c in o['crops']}
        # Ghost/template crops can be unlocked but are not legal real crop actions.
        for definition in self.catalog['crops']:
            c = crops.get(definition['id'])
            features.extend([1., c['tier'] / 32, number_log(c['cost']['seeds']) / 128,
                             number_log(c['cost']['spores']) / 128, c['growthSeconds'] / 3600] if c else [0.] * 5)
        upgrades = {u['id']: u for u in o['upgrades']}
        if set(upgrades) - set(self.upgrade_index):
            raise RuntimeError('Unknown upgrade in observation')
        for definition in self.catalog['upgrades']:
            u = upgrades.get(definition['id'])
            features.extend([1., math.log2(1 + u['count']) / 32, float(u['exhausted']),
                             float(u['cropUnlock']), float(u['cropUpgrade']), float(u['choice']),
                             number_log(u['cost']['seeds']) / 128, number_log(u['cost']['spores']) / 128] if u else [0.] * 8)
        medals = set(o['achievements'])
        if medals - set(self.achievement_index):
            raise RuntimeError('Unknown achievement')
        features.extend(float(medal in medals) for medal in self.catalog['achievements'])
        for weather in o['weather']:
            features.extend([float(weather['unlocked']), float(weather['active']),
                             weather['remainingSeconds'] / 3600, weather['cooldownSeconds'] / 3600,
                             float(weather['selectable']), weather['ability'] / 3])
        fern = o['fern']
        features.extend([1., fern['x'] / 4, fern['y'] / 4, fern['kind'] / 8] if fern else [0.] * 4)
        features.extend([o['fruits']['active'] / 16, o['fruits']['capacity'] / 16])
        fruits = {f['slot']: f for f in o['fruits']['stored'] + o['fruits']['sacrifice']}
        if set(fruits) - set(FRUIT_SLOTS):
            raise RuntimeError('Fruit inventory exceeds declared encoder capacity')
        for slot in FRUIT_SLOTS:
            fruit = fruits.get(slot)
            values = [0.] * 20
            if fruit:
                if len(fruit['abilities']) > 8 or len(fruit['levels']) != len(fruit['abilities']):
                    raise RuntimeError('Unsupported fruit ability shape')
                values[:4] = [1., fruit['tier'] / 16, fruit['type'] / 32, number_log(fruit['essence']) / 128]
                for i, (ability, level) in enumerate(zip(fruit['abilities'], fruit['levels'])):
                    values[4 + 2 * i:6 + 2 * i] = [ability / 128, math.log2(1 + level) / 32]
            features.extend(values)
        array = np.asarray(features, dtype=np.float32)
        if array.shape != self.observation_space.shape or not np.isfinite(array).all():
            raise RuntimeError(f'Invalid observation encoding {array.shape}')
        return np.clip(array, -16, 16)

    def step(self, index):
        index = int(index)
        if not 0 <= index < self.action_space.n or not self.mask[index]:
            raise ValueError(f'Invalid or masked action {index}')
        action, ticks = self.actions[index]
        previous = self.observation
        result = self._client().call('step', action=action, ticks=ticks)
        self.observation = result['observation']
        reward, base = reward_for(previous, self.observation, result['elapsedSeconds'], self.effective_limit)
        self.decisions += 1
        self.total_decisions += 1
        self.total_ticks += self.observation['simulationTicks'] - previous['simulationTicks']
        self.episode_return += reward
        self.base_return += base
        self.max_tree_level = max(self.max_tree_level, self.observation['highestTreeLevel'])
        self._refresh_mask()
        done = bool(result['terminated'] or result['truncated'])
        info = {}
        if done:
            self.episode_count += 1
            self.successes += int(result['terminated'])
            self.timeouts += int(result['truncated'])
            info['episode'] = {'r': self.episode_return, 'l': self.decisions,
                               'completed': bool(result['terminated']), 'game_seconds': self.observation['elapsedSeconds'],
                               'tree_level': self.observation['highestTreeLevel'], 'seed': self.game_seed,
                               'base_return': self.base_return}
            info['deadline_failure'] = bool(result['truncated'])
        # The eight-hour deadline is part of the finite task, hence terminal
        # failure, not a time-limit wrapper that SB3 should bootstrap past.
        return self.encode(), float(reward), done, False, info

    def summary(self):
        return {'worker': self.rank, 'node_pid': self.client.process.pid if self.client else None,
                'episodes': self.episode_count, 'successes': self.successes, 'timeouts': self.timeouts,
                'total_ticks': self.total_ticks, 'total_decisions': self.total_decisions,
                'max_tree_level': self.max_tree_level,
                'active_seconds': self.observation['elapsedSeconds'] if self.observation else 0,
                'active_tree_level': self.observation['treeLevel'] if self.observation else 0}

    def export_state(self):
        return {'snapshot': self._client().call('snapshot'), 'rng': self.np_random.bit_generator.state,
                'game_seed': self.game_seed, 'decisions': self.decisions,
                'episode_return': self.episode_return, 'base_return': self.base_return,
                'episode_count': self.episode_count, 'total_ticks': self.total_ticks,
                'total_decisions': self.total_decisions, 'successes': self.successes,
                'timeouts': self.timeouts, 'max_tree_level': self.max_tree_level}

    def import_state(self, saved):
        self.reset(options={'game_seed': saved['game_seed']})
        self.observation = self._client().call('restore', snapshot=saved['snapshot'])
        self.np_random.bit_generator.state = saved['rng']
        for key in ('game_seed', 'decisions', 'episode_return', 'base_return', 'episode_count',
                    'total_ticks', 'total_decisions', 'successes', 'timeouts', 'max_tree_level'):
            setattr(self, key, saved[key])
        self._refresh_mask()
        return self.encode()

    def close(self):
        if self.client:
            self.client.close()
            self.client = None

    def __del__(self):
        if getattr(self, 'client', None):
            self.close()
