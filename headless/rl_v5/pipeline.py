"""Local search → self-imitation → independent acceptance gate → optional PPO."""
import argparse
import json
import os
from pathlib import Path
import shutil
import signal
import subprocess
import sys
from headless.rl_v4.gate import accepted
from headless.rl_v4.train import write_json, now


def run(args):
    root=Path(args.out).resolve();root.mkdir(parents=True,exist_ok=False)
    status={'created_at':now(),'pid':os.getpid(),'phase':'starting','long_run_started':False}
    def report(phase,**extra):
        status.update(phase=phase,updated_at=now(),**extra);write_json(root/'pipeline.json',status)
        print(json.dumps(status),flush=True)
    def execute(module,arguments,log,timeout):
        with open(root/log,'w') as handle:
            child=subprocess.Popen([sys.executable,'-m',module,*arguments],stdout=handle,stderr=subprocess.STDOUT,
                                   stdin=subprocess.DEVNULL,start_new_session=True)
            report(status['phase'],child_pid=child.pid)
            try:
                code=child.wait(timeout=timeout)
                if code:raise subprocess.CalledProcessError(code,child.args)
            finally:
                if child.poll() is None:
                    child.terminate()
                    try:child.wait(timeout=45)
                    except subprocess.TimeoutExpired:pass
                try:os.killpg(child.pid,signal.SIGKILL)
                except ProcessLookupError:pass
    def stop(*_):raise KeyboardInterrupt('Pipeline stopped')
    signal.signal(signal.SIGTERM,stop);signal.signal(signal.SIGINT,stop)
    try:
        report('archive_search')
        execute('headless.rl_v5.search',['--out',str(root/'search'),'--workers','9','--minutes',str(args.search_minutes)],
                'search.log',args.search_minutes*60+180)
        discoveries=root/'search/discoveries.json'
        entries=json.loads(discoveries.read_text())['entries'] if discoveries.exists() else []
        count=len({e['seed'] for e in entries if e['earned_spores']>=1})
        if count<3:
            report('rejected',reason='Search did not discover spores on three distinct training seeds',discovered_seeds=count)
            return
        report('learning_from_discoveries',discovered_seeds=count)
        execute('headless.rl_v5.fit',['--discoveries',str(discoveries),'--out',str(root/'fit')],'fit.log',900)
        model=root/'fit/model.zip'
        report('preflight_comparison')
        execute('headless.rl_v4.gate',['--model',str(model),'--out',str(root/'preflight.json'),
                '--seeds','3','--seed-base','1000006001','--wall-seconds','240'],'preflight.log',900)
        reports=json.loads((root/'preflight.json').read_text())['reports'];r={x['mode']:x for x in reports}
        if not all(x['complete'] for x in reports) or r['sampled']['successes']<2 or r['greedy']['successes']<2:
            report('rejected',reason='Neural policy did not reliably reproduce its discoveries from fresh starts')
            return
        report('heldout_acceptance_test')
        execute('headless.rl_v4.gate',['--model',str(model),'--out',str(root/'gate.json'),
                '--seeds','9','--seed-base','1000007001','--wall-seconds','600'],'gate.log',1980)
        gate=json.loads((root/'gate.json').read_text())
        if not accepted(gate):
            report('rejected',reason='Nine-seed reliability/random-baseline gate failed')
            return
        report('long_training',long_run_started=True)
        execute('headless.rl_v4.train',['--out',str(root/'long-run'),'--node',shutil.which('node'),
                '--workers','9','--hours','1','--steps','1000000','--eval-every','1000000000',
                '--passed-gate',str(root/'gate.json'),'--seed','20261119'],'long-run.log',3780)
        report('complete')
    except BaseException as error:
        report('stopped' if isinstance(error,KeyboardInterrupt) else 'failed',error=repr(error));raise


if __name__=='__main__':
    parser=argparse.ArgumentParser();parser.add_argument('--out',required=True)
    parser.add_argument('--search-minutes',type=float,default=20);run(parser.parse_args())
