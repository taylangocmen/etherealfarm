/* Ethereal Farm — GPL-3.0-or-later; see LICENSE. */
import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync, renameSync, openSync, closeSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

// Unattended sequential comparison queue. Does not modify code, train a policy,
// start a browser, or run Git. All child simulation work uses one worker.
const options = {};
const args = process.argv.slice(2);
for (let i = 0; i < args.length; i += 2) {
  if (!['--out','--reference','--repeats','--wait-seconds'].includes(args[i]) || !args[i+1] || options[args[i]]) {
    throw new Error('Usage: node headless/experiments.mjs --out NEW_DIRECTORY --reference BASELINE_DIRECTORY [--repeats 2] [--wait-seconds 1800]');
  }
  options[args[i]] = args[i+1];
}
if (!options['--out'] || !options['--reference']) throw new Error('--out and --reference are required');
const out = resolve(options['--out']), reference = resolve(options['--reference']);
const repeats = Number(options['--repeats'] || 2);
const waitSeconds = Number(options['--wait-seconds'] || 1800);
if (!Number.isInteger(repeats) || repeats < 1 || repeats > 20) throw new Error('repeats must be 1–20');
if (!Number.isFinite(waitSeconds) || waitSeconds < 0 || waitSeconds > 86400) throw new Error('Invalid wait deadline');
mkdirSync(out);
const state = {format:'etherealfarm-experiments-v1', pid:process.pid, reference, repeats,
  startedAt:new Date().toISOString(), status:'waiting-for-reference', runs:[]};
function save() {
  writeFileSync(resolve(out,'status.json.tmp'), JSON.stringify(state,null,2)+'\n');
  renameSync(resolve(out,'status.json.tmp'), resolve(out,'status.json'));
}
let child;
let stopped = false;
for (const signal of ['SIGINT','SIGTERM']) process.on(signal, () => {
  stopped = true;
  child?.kill(signal);
});
async function run(directory, seeds, maxSeconds) {
  const log = openSync(resolve(out,`run-${state.runs.length+1}.log`),'wx');
  try {
    await new Promise((accept, reject) => {
      child = spawn(process.execPath, [fileURLToPath(new URL('./benchmark.mjs',import.meta.url)),
        '--out', directory, '--seeds', seeds.join(','), '--max-seconds',String(maxSeconds),'--compare',reference],
        {stdio:['ignore',log,log]});
      child.on('error',reject);
      child.on('exit',(code,signal) => {
        child = undefined;
        if (code === 0) accept();
        else reject(new Error(`Benchmark exited with code ${code}, signal ${signal}; see run log`));
      });
    });
  } finally { closeSync(log); }
}
save();
console.log(`Experiment queue started (PID ${process.pid}). Status: ${resolve(out,'status.json')}`);
try {
  const deadline = Date.now()+waitSeconds*1000;
  let baseline;
  for (;;) {
    if (stopped) throw new Error('Stopped by signal');
    try { baseline = JSON.parse(readFileSync(resolve(reference,'summary.json'),'utf8')); break; }
    catch (error) {
      if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error;
      if (Date.now() >= deadline) throw new Error('Reference did not finish before the wait deadline');
      await delay(1000);
    }
  }
  if (baseline.format !== 'etherealfarm-benchmark-summary-v1' || !baseline.seeds?.length) throw new Error('Invalid reference summary');
  const references = baseline.seeds.map(seed => JSON.parse(readFileSync(resolve(reference,`seed-${seed}.json`),'utf8')));
  const maxSeconds = references[0].metadata.maxEpisodeSeconds;
  if (references.some(r=>r.metadata.maxEpisodeSeconds !== maxSeconds)) throw new Error('Mixed reference episode limits');
  state.seeds = baseline.seeds;
  state.maxEpisodeSeconds = maxSeconds;
  let engine;
  for (let index=1; index<=repeats; index++) {
    if (stopped) throw new Error('Stopped by signal');
    const directory = resolve(out,`run-${index}`);
    state.status = 'running'; state.currentRun = index; state.currentDirectory = directory; save();
    await run(directory,baseline.seeds,maxSeconds);
    if (stopped) throw new Error('Stopped by signal');
    const results = baseline.seeds.map(seed => JSON.parse(readFileSync(resolve(directory,`seed-${seed}.json`),'utf8')));
    engine ??= results[0].metadata.engineFingerprint;
    if (results.some(r=>!r.comparison?.matches || r.metadata.engineFingerprint !== engine)) throw new Error('Trajectory mismatch or engine changed between runs');
    state.runs.push({directory, results:results.map(r=>({seed:r.seed, completed:r.completed,
      gameSeconds:r.gameSeconds, simulationMs:r.timing.simulationMs, ticksPerSecond:r.timing.ticksPerSecond,
      speedup:r.comparison.simulationSpeedup, traceSha256:r.traceSha256, matches:r.comparison.matches}))});
    save();
    console.log(`Finished comparison ${index}/${repeats}; all trajectory digests match.`);
  }
  const speedups = state.runs.flatMap(r=>r.results.map(result=>result.speedup)).sort((a,b)=>a-b);
  const middle = Math.floor(speedups.length/2);
  state.medianSpeedup = speedups.length%2 ? speedups[middle] : (speedups[middle-1]+speedups[middle])/2;
  state.status = 'complete'; state.finishedAt = new Date().toISOString(); save();
  console.log(`Complete. Median recorded speedup: ${state.medianSpeedup.toFixed(2)}x. Results: ${out}`);
} catch (error) {
  state.status = stopped ? 'stopped' : 'failed'; state.error = String(error.message || error);
  state.finishedAt = new Date().toISOString(); save();
  console.error(state.error); process.exitCode = 1;
}
