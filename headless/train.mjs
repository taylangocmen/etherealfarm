/* Ethereal Farm — GPL-3.0-or-later; see LICENSE. */
import { mkdirSync, readFileSync, writeFileSync, renameSync, existsSync, openSync, closeSync, unlinkSync } from 'node:fs';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { gzipSync, gunzipSync } from 'node:zlib';
import { execFileSync } from 'node:child_process';
import { setImmediate as yieldTurn } from 'node:timers/promises';
import { HeadlessEnvironment } from './environment.mjs';
import { initialParameters, chooseAction } from './learned-policy.mjs';

const args = process.argv.slice(2), opts = {};
for (let i=0;i<args.length;i+=2) {
  if (!['--out','--generations','--children','--max-seconds'].includes(args[i]) || !args[i+1] || opts[args[i]]) throw new Error('Usage: node headless/train.mjs --out DIRECTORY [--generations 3] [--children 4] [--max-seconds 28800]');
  opts[args[i]]=args[i+1];
}
if (!opts['--out']) throw new Error('--out is required (same directory resumes a stopped run)');
const directory=resolve(opts['--out']);
const config={generations:Number(opts['--generations']||3),children:Number(opts['--children']||4),maxSeconds:Number(opts['--max-seconds']||28800),trainingSeeds:[1,2],validationSeeds:[101,102],searchSeed:20261111};
if (!Number.isInteger(config.generations)||config.generations<1||config.generations>100||!Number.isInteger(config.children)||config.children<1||config.children>100||!Number.isFinite(config.maxSeconds)||config.maxSeconds<0.333||config.maxSeconds>604800) throw new Error('Invalid training bounds');
mkdirSync(directory,{recursive:true});
const lockPath=resolve(directory,'running.lock');
if(existsSync(lockPath)) {
  const pid=Number(readFileSync(lockPath,'utf8'));
  try { process.kill(pid,0); throw new Error(`Training directory already in use by PID ${pid}`); }
  catch(error) { if(error.code!=='ESRCH') throw error; unlinkSync(lockPath); }
}
const lock=openSync(lockPath,'wx'); writeFileSync(lock,String(process.pid)); closeSync(lock);
const path=name=>resolve(directory,name);
function atomic(name,value) { writeFileSync(path(name+'.tmp'),value); renameSync(path(name+'.tmp'),path(name)); }
const json=value=>JSON.stringify(value,null,2)+'\n';
const clone=value=>JSON.parse(JSON.stringify(value));
let stopping=false;
for(const signal of ['SIGINT','SIGTERM']) process.on(signal,()=>{stopping=true;});
let state, env;
try {
  env=new HeadlessEnvironment({seed:1,maxEpisodeSeconds:config.maxSeconds});
  const sourceHash=createHash('sha256');
  for(const name of ['train.mjs','learned-policy.mjs']) sourceHash.update(readFileSync(new URL(name,import.meta.url)));
  const identity={engine:env.metadata.engineFingerprint,trainer:sourceHash.digest('hex')};
  if(existsSync(path('status.json'))) {
    state=JSON.parse(readFileSync(path('status.json'),'utf8'));
    if(JSON.stringify(state.config)!==JSON.stringify(config)||JSON.stringify(state.identity)!==JSON.stringify(identity)) throw new Error('Configuration or source changed; use a new output directory');
    if(state.status==='complete') { console.log('Training already complete.'); process.exitCode=0; }
  } else {
    state={format:'etherealfarm-training-v1',config,identity,node:process.version,workers:1,commit:execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),
      startedAt:new Date().toISOString(),status:'starting',rng:config.searchSeed,generation:0,completed:[],best:null,pending:[],validation:[]};
  }
  function save() { state.pid=process.pid; state.updatedAt=new Date().toISOString(); atomic('status.json',json(state)); }
  function random() {
    state.rng=(state.rng+0x6d2b79f5)>>>0; let t=Math.imul(state.rng^(state.rng>>>15),state.rng|1);
    t^=t+Math.imul(t^(t>>>7),t|61); return ((t^(t>>>14))>>>0)/4294967296;
  }
  function mutate(parent) {
    const p=clone(parent);
    // Mutate numeric decision priorities and savings thresholds; optionally
    // swap field roles while preserving tree positions and crop counts.
    p.priorities=p.priorities.map(v=>Math.max(-8,Math.min(8,v+(random()-.5)*4)));
    p.unlockFraction=Math.max(.05,Math.min(1,p.unlockFraction*Math.exp((random()-.5)*2)));
    p.upgradeFraction=Math.max(.005,Math.min(1,p.upgradeFraction*Math.exp((random()-.5)*3)));
    const cells=p.layout.flatMap((row,y)=>row.flatMap((type,x)=>type?[[x,y]]:[]));
    if(random()<.75) {
      const [ax,ay]=cells[Math.floor(random()*cells.length)], [bx,by]=cells[Math.floor(random()*cells.length)];
      [p.layout[ay][ax],p.layout[by][bx]]=[p.layout[by][bx],p.layout[ay][ax]];
    }
    return p;
  }
  async function evaluate(candidate,seeds) {
    candidate.episodes ??=[];
    for(let i=candidate.episodes.length;i<seeds.length;i++) {
      if(stopping) return false;
      const seed=seeds[i], id=`${candidate.id}-seed-${seed}`;
      env.reset({seed});
      let elapsedWall=0;
      if(state.active?.id===id && state.active.checkpoint) {
        env.restore(JSON.parse(gunzipSync(readFileSync(path(state.active.checkpoint)))));
        elapsedWall=state.active.wallSeconds;
      }
      let o=env.observe(), started=performance.now(), saved=started;
      state.active={id,seed,checkpoint:null,wallSeconds:elapsedWall,gameSeconds:o.elapsedSeconds,treeLevel:o.treeLevel};
      save();
      function checkpoint() {
        const filename='active.checkpoint.json.gz';
        atomic(filename,gzipSync(JSON.stringify(env.snapshot())));
        state.active={id,seed,checkpoint:filename,wallSeconds:elapsedWall+(performance.now()-started)/1000,gameSeconds:o.elapsedSeconds,treeLevel:o.treeLevel};
        save();
      }
      while(!o.completed&&!o.truncated) {
        for(let j=0;j<100&&!o.completed&&!o.truncated;j++) o=env.step(chooseAction(o,candidate.parameters)).observation;
        await yieldTurn();
        if(stopping) { checkpoint(); return false; }
        if(performance.now()-saved>30000) { checkpoint(); saved=performance.now(); console.log(JSON.stringify({candidate:candidate.id,seed,gameSeconds:o.elapsedSeconds,level:o.treeLevel})); }
      }
      const result={seed,completed:o.completed,truncated:o.truncated,gameSeconds:o.elapsedSeconds,ticks:o.simulationTicks,completionLevel:o.completionLevel,
        awardedResin:o.awardedResin,wallSeconds:elapsedWall+(performance.now()-started)/1000};
      // Failures always lose to ANY completed run, never reward a short timeout.
      result.loss=o.completed?o.elapsedSeconds:config.maxSeconds*2;
      atomic(id+'.checkpoint.json.gz',gzipSync(JSON.stringify(env.snapshot())));
      atomic(id+'.json',json({identity,parameters:candidate.parameters,...result}));
      candidate.episodes.push(result); state.active=null; save();
      console.log(JSON.stringify({candidate:candidate.id,...result}));
    }
    candidate.loss=candidate.episodes.reduce((sum,e)=>sum+e.loss,0)/seeds.length;
    candidate.successes=candidate.episodes.filter(e=>e.completed).length;
    return true;
  }
  if(state.status!=='complete') {
    state.status='training'; save();
    if(!state.best) {
      state.initial ??={id:'initial',parameters:clone(initialParameters),episodes:[]};
      if(await evaluate(state.initial,config.trainingSeeds)) {
        state.best=clone(state.initial); state.completed.push(clone(state.initial));
        atomic('best-policy.json',json({identity,trainingSeeds:config.trainingSeeds,...state.best})); save();
      }
    }
    while(!stopping && state.generation<config.generations) {
      if(!state.pending.length) {
        state.pending=Array.from({length:config.children},(_,i)=>({id:`g${state.generation+1}-c${i+1}`,parameters:mutate(state.best.parameters),episodes:[]})); save();
      }
      while(state.pending.length&&!stopping) {
        const candidate=state.pending[0];
        if(!await evaluate(candidate,config.trainingSeeds)) break;
        // Lexicographic objective: success count first, then mean time/penalty.
        if(candidate.successes>state.best.successes || (candidate.successes===state.best.successes && candidate.loss<state.best.loss)) state.best=clone(candidate);
        state.completed.push(clone(candidate)); state.pending.shift();
        if(!state.pending.length) state.generation++;
        atomic('best-policy.json',json({identity,trainingSeeds:config.trainingSeeds,...state.best})); save();
      }
    }
    if(!stopping) {
      state.status='validating';
      if(!state.validation.length) state.validation=[{id:'validation-initial',parameters:clone(initialParameters),episodes:[]},{id:'validation-best',parameters:clone(state.best.parameters),episodes:[]}];
      save();
      for(const candidate of state.validation) if(!await evaluate(candidate,config.validationSeeds)) break;
    }
    state.status=stopping?'stopped':'complete';
    if(!stopping) {
      state.finishedAt=new Date().toISOString();
      const [baseline, winner]=state.validation;
      state.result={selectedCandidate:state.best.id,
        trainingMeanSeconds:state.best.successes===config.trainingSeeds.length?state.best.loss:null,
        validationBaselineMeanSeconds:baseline.successes===config.validationSeeds.length?baseline.loss:null,
        validationWinnerMeanSeconds:winner.successes===config.validationSeeds.length?winner.loss:null,
        validationImprovementPercent:baseline.successes===config.validationSeeds.length&&winner.successes===config.validationSeeds.length?
          100*(baseline.loss-winner.loss)/baseline.loss:null};
    }
    save();
    console.log(`${state.status}: ${path('status.json')}`);
  }
} catch(error) {
  if(state) { state.status='failed'; state.error=String(error.stack||error); atomic('status.json',json(state)); }
  console.error(error); process.exitCode=1;
} finally { unlinkSync(lockPath); }
