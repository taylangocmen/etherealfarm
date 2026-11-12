"""Nine-process archive exploration, restoring useful self-discovered states."""
import argparse
from collections import defaultdict
import fcntl
import json
import multiprocessing as mp
import os
from pathlib import Path
import shutil
import signal
import subprocess
import time
import traceback
import numpy as np
from headless.rl_v4.environment import FarmEnv, ROOT
from headless.rl_v4.train import now, write_json
from .archive import Archive, describe, identity, load_snapshot, save_snapshot


def worker(pipe,catalog,node,limit,directory,source,rank):
    env=FarmEnv(catalog,node,limit,rank,True)
    try:
        env.reset(seed=rank,options={'game_seed':202611200+rank})
        pipe.send({'ready':True,'node_pid':env.client.process.pid})
        while True:
            job=pipe.recv()
            if job is None:break
            try:
                if job['parent'] is None:
                    env.reset(seed=job['id'],options={'game_seed':job['seed']})
                else:
                    saved=load_snapshot(job['parent'],source)
                    env.import_state(saved['state'])
                rng=np.random.default_rng(98173+job['id'])
                candidates=[];outcome=None;kind=None;remaining=0
                if job['parent'] is None:
                    candidates.append(save_snapshot(Path(directory)/f"job-{job['id']:08d}-root.json.gz",env,source))
                for step in range(job['steps']):
                    groups=defaultdict(list)
                    for i,(action,_) in enumerate(env.actions):groups[action['type']].append(i)
                    # Random action-type bursts provide temporally coherent
                    # exploration without any crop or layout-specific rule.
                    if remaining==0 or kind not in groups or rng.random()<.2:
                        kind=rng.choice(sorted(groups));remaining=int(rng.integers(1,5))
                    index=int(rng.choice(groups[kind]));remaining-=1
                    _,_,done,_,info=env.step(index)
                    if done:
                        outcome=info['episode']
                        if outcome['goal_success']:
                            candidates.append(save_snapshot(Path(directory)/f"job-{job['id']:08d}-success.json.gz",env,source))
                        break
                    if (step+1)%4==0 or step+1==job['steps']:
                        candidates.append(save_snapshot(Path(directory)/f"job-{job['id']:08d}-{step:03d}.json.gz",env,source))
                pipe.send({'job':job['id'],'candidates':candidates,'outcome':outcome,
                           'expanded_from_archive':job['parent'] is not None})
            except Exception:
                pipe.send({'error':traceback.format_exc(),'job':job['id']});break
    finally:
        env.close();pipe.close()


def run(args):
    directory=Path(args.out).resolve();directory.mkdir(parents=True,exist_ok=True)
    lock=open(directory/'running.lock','a+');fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
    snapshots=directory/'states';snapshots.mkdir(exist_ok=True)
    node=shutil.which('node');catalog=json.loads(subprocess.check_output([node,str(ROOT/'headless/rl_v4/catalog.mjs')]))
    source=identity(catalog);config={k:getattr(args,k) for k in ('workers','minutes','max_seconds','chunk_steps','capacity','discoveries')}
    archive=Archive(args.capacity);rng=np.random.default_rng(20261117)
    state={'identity':source,'config':config,'created_at':now(),'jobs':0,'restored_branches':0,'discoveries':[], 'elapsed_seconds':0}
    manifest=directory/'archive.json'
    if manifest.exists():
        saved=json.loads(manifest.read_text())
        if saved['identity']!=source or saved['config']!=config:raise RuntimeError('Search resume source/config mismatch')
        if saved['status'] in ('complete','budget_exhausted'):return
        archive.cells={e['key']:e for e in saved.pop('cells')};rng.bit_generator.state=saved.pop('rng');state=saved
        journal=directory/'discoveries.json'
        if journal.exists():
            discovered=json.loads(journal.read_text())
            if discovered['identity']!=source:raise RuntimeError('Discovery journal source mismatch')
            state['discoveries']=list({e['sha256']:e for e in state['discoveries']+discovered['entries']}.values())
    start=time.monotonic();previous=state['elapsed_seconds'];stop=False
    def stopping(*_):
        nonlocal stop
        stop=True
    signal.signal(signal.SIGTERM,stopping);signal.signal(signal.SIGINT,stopping)
    processes=[];connections=[];nodes={};busy={};protected={};ready=set();rooted={e['seed'] for e in archive.cells.values()}
    counter_path=directory/'counter.json'
    counter=json.loads(counter_path.read_text())['next'] if counter_path.exists() else 0
    def report(status):
        state.update(status=status,pid=os.getpid(),updated_at=now(),elapsed_seconds=previous+time.monotonic()-start,
                     archive_cells=len(archive.cells),best_score=max((e['score'] for e in archive.cells.values()),default=0),
                     worker_pids=[p.pid for p in processes],node_pids=list(nodes.values()),active_jobs=list(busy.values()))
        write_json(directory/'status.json',state)
        write_json(manifest,{**state,'cells':archive.serializable(),'rng':rng.bit_generator.state})
    try:
        ctx=mp.get_context('spawn')
        for rank in range(args.workers):
            parent,child=ctx.Pipe();process=ctx.Process(target=worker,args=(child,catalog,node,args.max_seconds,str(snapshots),source,rank))
            process.start();child.close();processes.append(process);connections.append(parent)
        report('starting');last_report=time.monotonic()
        while True:
            solved={e['seed'] for e in state['discoveries']}
            finished=stop or previous+time.monotonic()-start>=args.minutes*60 or len(solved)>=args.discoveries
            for rank,pipe in enumerate(connections):
                if pipe.poll():
                    message=pipe.recv()
                    if message.get('error'):raise RuntimeError(message['error'])
                    if message.get('ready'):
                        ready.add(rank);nodes[rank]=message['node_pid']
                    else:
                        busy.pop(rank,None);protected.pop(rank,None);state['jobs']+=1
                        state['restored_branches']+=int(message['expanded_from_archive'])
                        for entry in message['candidates']:
                            if entry['earned_spores']>=1:
                                state['discoveries'].append(entry);solved.add(entry['seed'])
                                write_json(directory/'discoveries.json',{'identity':source,'entries':state['discoveries']})
                            elif archive.offer(entry):rooted.add(entry['seed'])
                            else:Path(entry['path']).unlink(missing_ok=True)
                        # Retain only referenced snapshots, including complete successes.
                        keep={e['path'] for e in archive.cells.values()}|{e['path'] for e in state['discoveries']}|set(protected.values())
                        for path in snapshots.glob('*.json.gz'):
                            # Files from in-flight jobs must not be touched.
                            jid=int(path.name.split('-')[1])
                            if jid not in busy.values() and str(path.resolve()) not in keep:path.unlink(missing_ok=True)
                if not processes[rank].is_alive() and not finished:raise RuntimeError(f'Search worker {rank} exited unexpectedly')
            finished=stop or previous+time.monotonic()-start>=args.minutes*60 or len(solved)>=args.discoveries
            if finished:
                break
            for rank in sorted(ready):
                if rank in busy:continue
                seed=202611200+rank
                parent=None if seed not in rooted else archive.choose(rng,solved)
                counter+=1;write_json(counter_path,{'next':counter})
                if parent:protected[rank]=parent['path']
                connections[rank].send({'id':counter,'seed':seed,'parent':parent,'steps':args.chunk_steps})
                busy[rank]=counter
            if time.monotonic()-last_report>=20:
                report('searching');last_report=time.monotonic()
            time.sleep(.05)
        report('stopped' if stop else ('complete' if len(solved)>=args.discoveries else 'budget_exhausted'))
    except BaseException:
        state['error']=traceback.format_exc();report('failed');raise
    finally:
        for pipe in connections:
            try:pipe.send(None)
            except (OSError,EOFError):pass
        deadline=time.monotonic()+10
        for process in processes:process.join(timeout=max(0,deadline-time.monotonic()))
        for process in processes:
            if process.is_alive():process.terminate();process.join(timeout=2)
            if process.is_alive():process.kill();process.join()
        for pid in nodes.values():
            try:os.kill(pid,signal.SIGTERM)
            except ProcessLookupError:pass
        for pipe in connections:pipe.close()
        lock.close()


if __name__=='__main__':
    parser=argparse.ArgumentParser();parser.add_argument('--out',required=True)
    parser.add_argument('--workers',type=int,default=9);parser.add_argument('--minutes',type=float,default=20)
    parser.add_argument('--max-seconds',type=float,default=14400);parser.add_argument('--chunk-steps',type=int,default=16)
    parser.add_argument('--capacity',type=int,default=1024);parser.add_argument('--discoveries',type=int,default=9)
    args=parser.parse_args()
    if not 1<=args.workers<=9 or args.minutes<=0 or not 1<=args.discoveries<=args.workers or args.capacity<args.workers or not 4<=args.chunk_steps<=128:
        parser.error('Invalid search bounds')
    run(args)
