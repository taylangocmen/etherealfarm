"""Train a randomly initialized neural policy on verified self-discovered paths."""
import argparse
from concurrent.futures import ProcessPoolExecutor
import hashlib
import json
import multiprocessing as mp
from pathlib import Path
import shutil
import subprocess
import time
import numpy as np
import torch
from sb3_contrib import MaskablePPO
from headless.rl_v4.environment import FarmEnv, ROOT
from headless.rl_v4.policy import SemanticPolicy
from headless.rl_v4.train import now, write_json
from .archive import identity, load_snapshot


def action_key(action,ticks):return json.dumps([action,ticks],sort_keys=True,separators=(',',':'))


def replay_discovery(task):
    entry,source,catalog,node,output=task
    saved=load_snapshot(entry,source)
    if not 0<entry['seed']<1_000_000_000 or entry['earned_spores']<1:
        raise RuntimeError('Only successful self-generated training seeds are permitted')
    snapshot=saved['state']['snapshot']
    env=FarmEnv(catalog,node,snapshot['maxTicks']*.333)
    records=[];labels=[];masks=[];rewards=[];done=False;info={}
    try:
        observation,_=env.reset(options={'game_seed':entry['seed']})
        for item in snapshot['history']:
            if done:raise RuntimeError('Trajectory continues after first-spore success')
            options={action_key(a,t):i for i,(a,t) in enumerate(env.actions)}
            key=action_key(item['action'],item['ticks'])
            if key not in options:raise RuntimeError('Archived action is not legal during fresh replay')
            label=options[key];records.append(observation);labels.append(label);masks.append(env.action_masks())
            observation,reward,done,_,info=env.step(label);rewards.append(reward)
        if not done or not info['episode']['goal_success'] or env.progress()<1:
            raise RuntimeError('Discovery failed fresh replay; cannot train on it')
        returns=np.cumsum(np.asarray(rewards,dtype=np.float32)[::-1])[::-1].copy()
        arrays={k:np.stack([r[k] for r in records]) for k in records[0]}
        arrays.update(labels=np.asarray(labels,dtype=np.int64),masks=np.stack(masks),returns=returns)
        path=Path(output)/f"seed-{entry['seed']}.npz"
        np.savez_compressed(path,**arrays)
        return {'seed':entry['seed'],'path':str(path),'transitions':len(labels),
                'sha256':hashlib.sha256(path.read_bytes()).hexdigest(),'source_sha256':entry['sha256'],
                'verified_episode':info['episode']}
    finally:env.close()


def train_batch(model,obs,mask,labels,returns):
    distribution=model.policy.get_distribution(obs,action_masks=mask)
    actor_loss=-distribution.log_prob(labels).mean()
    value_loss=(model.policy.predict_values(obs).flatten()-returns).square().mean()
    loss=actor_loss+.05*value_loss
    model.policy.optimizer.zero_grad();loss.backward()
    # Large untrained value errors must not shrink the actor's imitation gradient.
    torch.nn.utils.clip_grad_norm_(model.policy.action_net.parameters(),1.)
    torch.nn.utils.clip_grad_norm_(model.policy.value_net.parameters(),1.)
    model.policy.optimizer.step()
    return float(actor_loss.detach()),float(value_loss.detach())


def run(args):
    output=Path(args.out).resolve();output.mkdir(parents=True,exist_ok=False)
    torch.set_num_threads(1);torch.manual_seed(20261118)
    catalog=json.loads(subprocess.check_output([shutil.which('node'),str(ROOT/'headless/rl_v4/catalog.mjs')]))
    source=identity(catalog)
    manifest=json.loads(Path(args.discoveries).read_text())
    if manifest['identity']!=source:raise RuntimeError('Discovery source identity mismatch')
    # One fastest path per seed, so duplicate descendants do not inflate diversity.
    selected={}
    for entry in manifest['entries']:
        if entry['seed'] not in selected or entry['seconds']<selected[entry['seed']]['seconds']:
            selected[entry['seed']]=entry
    if len(selected)<3:raise RuntimeError('Need successful discoveries on at least three independent training seeds')
    tasks=[(entry,source,catalog,shutil.which('node'),str(output)) for entry in selected.values()]
    status={'status':'replaying_discoveries','created_at':now(),'identity':source,'training_seeds':sorted(selected)}
    write_json(output/'status.json',status)
    with ProcessPoolExecutor(max_workers=min(9,len(tasks)),mp_context=mp.get_context('spawn')) as executor:
        datasets=list(executor.map(replay_discovery,tasks))
    write_json(output/'dataset.json',{'identity':source,'origin':'verified self-generated search paths','datasets':datasets})
    arrays=[]
    for data in datasets:
        with np.load(data['path']) as file:arrays.append({k:file[k] for k in file.files})
    # Hold out complete training-seed trajectories for model selection, never gate seeds.
    train={k:np.concatenate([a[k] for a in arrays[:-1]]) for k in arrays[0]}
    dev=arrays[-1];del arrays
    env=FarmEnv(catalog,shutil.which('node'))
    model=MaskablePPO(SemanticPolicy,env,device='cpu',seed=20261118,n_steps=128,
                     learning_rate=3e-4,gamma=1.,gae_lambda=.995,ent_coef=.005,
                     policy_kwargs={'net_arch':[]})
    for group in model.policy.optimizer.param_groups:group['lr']=.001
    before=model.policy.action_net[0].weight.detach().clone()
    rng=np.random.default_rng(20261118);best=float('inf');started=time.monotonic();history=[]
    def batch(data,ids):
        obs={k:torch.as_tensor(data[k][ids]) for k in ('global','actions','prior')}
        return obs,torch.as_tensor(data['masks'][ids]),torch.as_tensor(data['labels'][ids]),torch.as_tensor(data['returns'][ids])
    try:
        for epoch in range(args.epochs):
            model.policy.set_training_mode(True);losses=[]
            order=rng.permutation(len(train['labels']))
            for start in range(0,len(order),64):
                losses.append(train_batch(model,*batch(train,order[start:start+64])))
            model.policy.set_training_mode(False);dev_losses=[]
            with torch.no_grad():
                for start in range(0,len(dev['labels']),64):
                    ids=np.arange(start,min(start+64,len(dev['labels'])))
                    obs,mask,labels,_=batch(dev,ids)
                    dev_losses.extend((-model.policy.get_distribution(obs,mask).log_prob(labels)).tolist())
            loss=float(np.mean(dev_losses));model._n_updates=epoch+1
            if loss<best:
                best=loss;model.save(output/'model.tmp.zip');(output/'model.tmp.zip').replace(output/'model.zip')
            history.append({'epoch':epoch+1,'train_actor_loss':float(np.mean([x[0] for x in losses])),
                            'dev_actor_loss':loss,'best_dev_loss':best})
            status.update(status='training',updated_at=now(),epochs=epoch+1,history=history,
                          transitions=len(train['labels']),dev_transitions=len(dev['labels']))
            write_json(output/'status.json',status)
            if time.monotonic()-started>=args.minutes*60:break
        if torch.equal(before,model.policy.action_net[0].weight):raise RuntimeError('Neural actor weights did not change')
        status.update(status='complete',updated_at=now(),model_sha256=hashlib.sha256((output/'model.zip').read_bytes()).hexdigest())
        write_json(output/'status.json',status)
    finally:env.close()


if __name__=='__main__':
    parser=argparse.ArgumentParser();parser.add_argument('--discoveries',required=True);parser.add_argument('--out',required=True)
    parser.add_argument('--epochs',type=int,default=30);parser.add_argument('--minutes',type=float,default=5)
    run(parser.parse_args())
