"""Curriculum adapter; game rules only, no demonstrations or scripted layouts."""
from collections import Counter, deque
import gymnasium as gym
import numpy as np
from headless.rl.environment import FarmEnv, ROOT, number_log

FINAL_TARGET = 13


def earned(o, resource):
    return 2 ** min(128, number_log(o['earnedResources'][resource])) - 1


def goal_name(target):
    return ['earn 1 new seed', 'earn 100 new seeds', 'earn 1 new spore'][target] if target < 3 else (
        'transcend' if target == FINAL_TARGET else f'reach tree level {target - 2}')


class CurriculumEnv(gym.Wrapper):
    def __init__(self, catalog, node, max_seconds=28800, rank=0, training=True):
        super().__init__(FarmEnv(catalog, node, max_seconds, rank, training))
        self.full_limit = max_seconds
        self.target = 0 if training else FINAL_TARGET
        self.pending_target = self.target
        self.history = deque(maxlen=10)
        self.episodes = self.successes = self.timeouts = 0
        self.counts = Counter()
        self.last_action = None
        self.streak = self.max_streak = 0
        self.return_ = 0.
        self.peak = 0
        self.baseline = {}
        self.eval_finished = False
        self.observation_space = gym.spaces.Box(-16, 16, shape=(self.env.observation_space.shape[0] + 1,), dtype=np.float32)
        # Ten seconds per ordinary decision. Every simulator tick still runs.
        # Waiting is a duration choice, never a crop/layout heuristic.
        self.env.actions = [(a, (30, 90, 300, 900)[i] if i < 4 else 30)
                            for i, (a, _) in enumerate(self.env.actions)]

    def encode(self):
        return np.concatenate((self.env.encode(), np.array([self.target / FINAL_TARGET], dtype=np.float32)))

    def episode_limit(self):
        if not self.env.training:
            return min(self.full_limit, 600)
        return min(self.full_limit, (600, 1800, 7200)[self.target] if self.target < 3 else self.full_limit)

    def reset(self, *, seed=None, options=None):
        # VecEnv auto-reset must not run another game in a finished evaluation slot.
        if not self.env.training and self.eval_finished and not options:
            return self.encode(), {}
        self.eval_finished = False
        self.target = int((options or {}).get('target', self.pending_target))
        self.env.max_seconds = self.episode_limit()
        self.env.reset(seed=seed, options=options)
        self.baseline = {key: earned(self.env.observation, key) for key in ('seeds', 'spores')}
        self.return_ = 0.
        self.peak = 0
        self.last_action = None
        self.streak = 0
        return self.encode(), {}

    def action_masks(self):
        if self.eval_finished:
            mask = np.zeros(self.env.action_space.n, dtype=bool)
            mask[0] = True
            return mask
        return self.env.action_masks()

    def progress(self):
        o = self.env.observation
        if self.target < 3:
            resource = 'spores' if self.target == 2 else 'seeds'
            threshold = 100 if self.target == 1 else 1
            gained = max(0, earned(o, resource) - self.baseline[resource])
            return min(1., np.log1p(gained) / np.log1p(threshold)), gained >= threshold
        if self.target == FINAL_TARGET:
            return 0., bool(o['completed'])
        target_level = self.target - 2
        # Continuous progress toward the next tree level, rewarded once only.
        req = number_log(o['treeRequirement']['spores'])
        fraction = min(1., number_log(o['resources']['spores']) / req) if req > 0 else 0.
        return min(1., (o['highestTreeLevel'] + fraction) / target_level), o['highestTreeLevel'] >= target_level

    def step(self, action):
        if self.eval_finished:
            return self.encode(), 0., False, False, {}
        action = int(action)
        before = self.env.observation['elapsedSeconds']
        _, _, engine_done, _, _ = self.env.step(action)
        o = self.env.observation
        level = o['highestTreeLevel']
        progress, goal_success = self.progress()
        success = bool(o['completed'] or goal_success)
        done = success or engine_done
        elapsed = o['elapsedSeconds'] - before
        # One-time level milestones cannot be farmed by refreshing/deleting.
        # At the final task remove milestone rewards: optimize actual completion.
        reward = -elapsed / self.env.effective_limit
        if self.target < FINAL_TARGET:
            reward += max(0, progress - self.peak)
        self.peak = max(self.peak, progress)
        reward += 2 if success else (-1 if done else 0)
        self.return_ += reward
        self.counts[self.env.actions[action][0]['type']] += 1
        self.streak = self.streak + 1 if action == self.last_action else 1
        self.max_streak = max(self.max_streak, self.streak)
        self.last_action = action
        info = {}
        if done:
            self.episodes += 1
            self.successes += int(success)
            self.timeouts += int(not success)
            self.history.append(success)
            info['episode'] = {'r': self.return_, 'l': self.env.decisions, 'completed': bool(o['completed']),
                               'goal_success': success, 'target': self.target, 'goal': goal_name(self.target),
                               'goal_progress': self.peak, 'tree_level': level,
                               'game_seconds': o['elapsedSeconds'], 'seed': self.env.game_seed}
            if not self.env.training:
                self.eval_finished = True
            if self.env.training and len(self.history) == 10 and sum(self.history) >= 8 and self.target < FINAL_TARGET:
                self.pending_target = self.target + 1
                self.history.clear()
        return self.encode(), float(reward), done, False, info

    def summary(self):
        return {**self.env.summary(), 'episodes': self.episodes, 'successes': self.successes,
                'timeouts': self.timeouts, 'target': self.target, 'goal': goal_name(self.target),
                'goal_progress': self.peak, 'next_target': self.pending_target,
                'action_counts': dict(self.counts), 'max_action_streak': self.max_streak,
                'goal_recent_successes': sum(self.history), 'goal_recent_episodes': len(self.history)}

    def export_state(self):
        return {'inner': self.env.export_state(), 'target': self.target, 'pending_target': self.pending_target,
                'baseline': self.baseline, 'eval_finished': self.eval_finished,
                'history': list(self.history), 'episodes': self.episodes, 'successes': self.successes,
                'timeouts': self.timeouts, 'counts': dict(self.counts), 'last_action': self.last_action,
                'streak': self.streak, 'max_streak': self.max_streak, 'return_': self.return_, 'peak': self.peak}

    def import_state(self, saved):
        self.target = saved['target']
        self.env.max_seconds = self.episode_limit()
        self.env.import_state(saved['inner'])
        for key in ('target', 'pending_target', 'episodes', 'successes', 'timeouts', 'last_action',
                    'streak', 'max_streak', 'return_', 'peak', 'baseline', 'eval_finished'):
            setattr(self, key, saved[key])
        self.counts = Counter(saved['counts'])
        self.history = deque(saved['history'], maxlen=10)
        return self.encode()
