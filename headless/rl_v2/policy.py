"""Shared action-descriptor scoring, retaining exact joint legality masks."""
import numpy as np
import torch
from torch import nn
from sb3_contrib.common.maskable.policies import MaskableActorCriticPolicy
from headless.rl.environment import FarmEnv


def action_features(catalog, node):
    env = FarmEnv(catalog, node)
    actions = env.actions
    # Factor identities share parameters across locations and action types.
    fields = ('type', 'crop', 'x', 'y', 'upgrade', 'choice', 'ability', 'page', 'slot', 'destination')
    vocab = {f: sorted({str(a[f]) for a, _ in actions if f in a}) for f in fields}
    width = sum(len(v) for v in vocab.values()) + 4
    rows = np.zeros((len(actions), width), dtype=np.float32)
    for i, (a, _) in enumerate(actions):
        offset = 0
        for field in fields:
            if field in a:
                rows[i, offset + vocab[field].index(str(a[field]))] = 1
            offset += len(vocab[field])
        if i < 4:
            rows[i, offset + i] = 1
    return rows.tolist()


class ActionHead(nn.Module):
    def __init__(self, latent_dim, features):
        super().__init__()
        self.register_buffer('descriptors', torch.tensor(features, dtype=torch.float32))
        self.embed = nn.Sequential(nn.Linear(self.descriptors.shape[1], 64), nn.Tanh(), nn.Linear(64, 64))
        self.query = nn.Linear(latent_dim, 64)

    def forward(self, latent):
        return self.query(latent) @ self.embed(self.descriptors).T / 8


class StructuredPolicy(MaskableActorCriticPolicy):
    def __init__(self, *args, action_features, **kwargs):
        self.action_features = action_features
        super().__init__(*args, **kwargs)

    def _build(self, lr_schedule):
        super()._build(lr_schedule)
        self.action_net = ActionHead(self.mlp_extractor.latent_dim_pi, self.action_features)
        self.optimizer = self.optimizer_class(self.parameters(), lr=lr_schedule(1), **self.optimizer_kwargs)
