"""Curriculum adapter; game rules only, no demonstrations or scripted layouts."""
from collections import Counter, deque
import gymnasium as gym
import numpy as np
from headless.rl.environment import FarmEnv, ROOT


class CurriculumEnv(gym.Wrapper):
    def __init__(self, catalog, node, max_seconds=28800, rank=0, training=True):
        super().__init__(FarmEnv(catalog, node, max_seconds, rank, training))
        self.full_limit = max_seconds
        self.target = 1 if training else 11
        self.pending_target = self.target
        self.history = deque(maxlen=10)
        self.episodes = self.successes = self.timeouts = 0
        self.counts = Counter()
        self.last_action = None
        self.streak = self.max_streak = 0
        self.return_ = 0.
        self.peak = 0
        self.observation_space = gym.spaces.Box(-16, 16, shape=(self.env.observation_space.shape[0] + 1,), dtype=np.float32)
        # Ten seconds per ordinary decision. Every simulator tick still runs.
        # Waiting is a duration choice, never a crop/layout heuristic.
        self.env.actions = [(a, (30, 90, 300, 900)[i] if i < 4 else 30)
                            for i, (a, _) in enumerate(self.env.actions)]

    def encode(self):
        return np.concatenate((self.env.encode(), np.array([self.target / 11], dtype=np.float32)))

    def reset(self, *, seed=None, options=None):
        self.target = int((options or {}).get('target', self.pending_target))
        self.env.max_seconds = min(self.full_limit, 1800 * self.target) if self.target < 11 else self.full_limit
        self.env.reset(seed=seed, options=options)
        self.return_ = 0.
        self.peak = 0
        self.last_action = None
        self.streak = 0
        return self.encode(), {}

    def action_masks(self):
        return self.env.action_masks()

    def step(self, action):
        action = int(action)
        before = self.env.observation['elapsedSeconds']
        _, _, engine_done, _, _ = self.env.step(action)
        o = self.env.observation
        level = o['highestTreeLevel']
        success = bool(o['completed'] or (self.target < 11 and level >= self.target))
        done = success or engine_done
        elapsed = o['elapsedSeconds'] - before
        # One-time level milestones cannot be farmed by refreshing/deleting.
        # At the final task remove milestone rewards: optimize actual completion.
        reward = -elapsed / self.env.effective_limit
        if self.target < 11:
            reward += max(0, min(level, self.target) - self.peak) / self.target
        self.peak = max(self.peak, min(level, self.target))
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
                               'goal_success': success, 'target': self.target, 'tree_level': level,
                               'game_seconds': o['elapsedSeconds'], 'seed': self.env.game_seed}
            if self.env.training and len(self.history) == 10 and sum(self.history) >= 8 and self.target < 11:
                self.pending_target = self.target + 1
                self.history.clear()
        return self.encode(), float(reward), done, False, info

    def summary(self):
        return {**self.env.summary(), 'episodes': self.episodes, 'successes': self.successes,
                'timeouts': self.timeouts, 'target': self.target, 'next_target': self.pending_target,
                'action_counts': dict(self.counts), 'max_action_streak': self.max_streak,
                'goal_recent_successes': sum(self.history), 'goal_recent_episodes': len(self.history)}

    def export_state(self):
        return {'inner': self.env.export_state(), 'target': self.target, 'pending_target': self.pending_target,
                'history': list(self.history), 'episodes': self.episodes, 'successes': self.successes,
                'timeouts': self.timeouts, 'counts': dict(self.counts), 'last_action': self.last_action,
                'streak': self.streak, 'max_streak': self.max_streak, 'return_': self.return_, 'peak': self.peak}

    def import_state(self, saved):
        self.target = saved['target']
        self.env.max_seconds = min(self.full_limit, 1800 * self.target) if self.target < 11 else self.full_limit
        self.env.import_state(saved['inner'])
        for key in ('target', 'pending_target', 'episodes', 'successes', 'timeouts', 'last_action',
                    'streak', 'max_streak', 'return_', 'peak'):
            setattr(self, key, saved[key])
        self.counts = Counter(saved['counts'])
        self.history = deque(saved['history'], maxlen=10)
        return self.encode()
