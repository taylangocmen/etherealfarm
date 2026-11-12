"""Bounded local pilot and fail-closed acceptance checks; no LLM monitoring."""
import argparse
import json
import os
from pathlib import Path
import shutil
import signal
import subprocess
import sys
from .gate import accepted
from .train import write_json, now


def run(args):
    root=Path(args.out).resolve()
    root.mkdir(parents=True,exist_ok=False)
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
                result=child.wait(timeout=timeout)
                if result:raise subprocess.CalledProcessError(result,child.args)
            finally:
                if child.poll() is None:
                    child.terminate()
                    try:child.wait(timeout=45)
                    except subprocess.TimeoutExpired:pass
                # Also clean up simulator descendants after a crashed evaluator.
                try:os.killpg(child.pid,signal.SIGKILL)
                except ProcessLookupError:pass
    def stop(*_):
        raise KeyboardInterrupt('Pipeline stopped by signal')
    signal.signal(signal.SIGTERM,stop)
    signal.signal(signal.SIGINT,stop)
    try:
        pilot=root/'pilot'
        report('pilot_training')
        execute('headless.rl_v4.train',['--out',str(pilot),'--node',shutil.which('node'),
                '--workers','9','--hours',str(args.pilot_minutes/60),'--steps','1000000',
                '--eval-every','1000000000','--seed','20261115'],'pilot.log',args.pilot_minutes*60+180)
        checkpoint=pilot/json.loads((pilot/'latest.json').read_text())['checkpoint']
        model=checkpoint/'model.zip'
        report('preflight_comparison')
        execute('headless.rl_v4.gate',['--model',str(model),'--out',str(root/'preflight.json'),
                '--seeds','3','--seed-base','1000004001','--wall-seconds','240'],
                'preflight.log',900)
        pre=json.loads((root/'preflight.json').read_text());r={x['mode']:x for x in pre['reports']}
        if (not all(x['complete'] for x in r.values()) or r['sampled']['successes']<2 or
                r['greedy']['successes']<2):
            report('rejected',reason='Three-seed preflight did not establish reliable spore production',preflight=str(root/'preflight.json'))
            return
        report('heldout_acceptance_test')
        execute('headless.rl_v4.gate',['--model',str(model),'--out',str(root/'gate.json'),
                '--seeds','9','--seed-base','1000005001','--wall-seconds','600'],'gate.log',1980)
        gate=json.loads((root/'gate.json').read_text())
        if not accepted(gate):
            report('rejected',reason='Nine-seed reliability/random-baseline gate failed',gate=str(root/'gate.json'))
            return
        report('accepted',gate=str(root/'gate.json'))
        report('long_training',long_run_started=True)
        execute('headless.rl_v4.train',['--out',str(root/'long-run'),'--node',shutil.which('node'),
                '--workers','9','--hours','1','--steps','1000000','--eval-every','1000000000',
                '--passed-gate',str(root/'gate.json'),'--seed','20261116'],'long-run.log',3780)
        report('complete')
    except BaseException as error:
        report('stopped' if isinstance(error,KeyboardInterrupt) else 'failed',error=repr(error))
        raise


if __name__=='__main__':
    p=argparse.ArgumentParser();p.add_argument('--out',required=True);p.add_argument('--pilot-minutes',type=float,default=10)
    run(p.parse_args())
