"""A shared neural scorer for legal actions with observable semantic features."""
import torch
from torch import nn
from stable_baselines3.common.torch_layers import BaseFeaturesExtractor
from sb3_contrib.common.maskable.policies import MaskableActorCriticPolicy


class GlobalExtractor(BaseFeaturesExtractor):
    def __init__(self, observation_space):
        super().__init__(observation_space,observation_space['global'].shape[0])
    def forward(self, obs):return obs['global']


class SemanticPolicy(MaskableActorCriticPolicy):
    def __init__(self,*args,**kwargs):
        kwargs['features_extractor_class']=GlobalExtractor
        super().__init__(*args,**kwargs)

    def _build(self, lr_schedule):
        super()._build(lr_schedule)
        g=self.observation_space['global'].shape[0];a=self.observation_space['actions'].shape[1]
        self.action_net=nn.Sequential(nn.Linear(g+a,32),nn.Tanh(),nn.Linear(32,1))
        nn.init.normal_(self.action_net[-1].weight,std=.01);nn.init.zeros_(self.action_net[-1].bias)
        self.value_net=nn.Sequential(nn.Linear(g,64),nn.Tanh(),nn.Linear(64,1))
        self.optimizer=self.optimizer_class(self.parameters(),lr=lr_schedule(1),**self.optimizer_kwargs)

    def get_distribution(self, obs, action_masks=None):
        a=obs['actions'];g=obs['global'].unsqueeze(1).expand(-1,a.shape[1],-1)
        logits=self.action_net(torch.cat((g,a),dim=-1)).squeeze(-1)+obs['prior']
        distribution=self.action_dist.proba_distribution(action_logits=logits)
        if action_masks is not None:distribution.apply_masking(action_masks)
        return distribution

    def predict_values(self,obs):return self.value_net(obs['global'])

    def choose(self,obs,distribution,deterministic):
        if not deterministic:return distribution.get_actions(deterministic=False)
        # Greedy at each factor: choose the most probable action type first.
        # A type with many equivalent positions must not lose to a lone wait.
        types=obs['actions'][:,:,:11]
        probabilities=distribution.distribution.probs
        masses=(types*probabilities.unsqueeze(-1)).sum(dim=1)
        kind=masses.argmax(dim=1)
        selected=types.gather(2,kind[:,None,None].expand(-1,types.shape[1],1)).squeeze(-1)>0
        return probabilities.masked_fill(~selected,-1).argmax(dim=1)

    def _predict(self,obs,deterministic=False,action_masks=None):
        return self.choose(obs,self.get_distribution(obs,action_masks),deterministic)

    def forward(self,obs,deterministic=False,action_masks=None):
        d=self.get_distribution(obs,action_masks);a=self.choose(obs,d,deterministic)
        return a,self.predict_values(obs),d.log_prob(a)

    def evaluate_actions(self,obs,actions,action_masks=None):
        d=self.get_distribution(obs,action_masks)
        return self.predict_values(obs),d.log_prob(actions),d.entropy()
