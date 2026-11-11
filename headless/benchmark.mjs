/* Ethereal Farm — GPL-3.0-or-later; see LICENSE. */
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { cpus, platform, arch } from 'node:os';
import { gzipSync } from 'node:zlib';
import { performance } from 'node:perf_hooks';
import { HeadlessEnvironment } from './environment.mjs';
import { chooseAction } from './scripted-player.mjs';

// One worker, one action per original tick. Recording adds overhead deliberately:
// the digest covers EVERY public observation/action/result, not just the score.
const args = process.argv.slice(2);
const options = {};
for (let i = 0; i < args.length; i += 2) {
  if (!['--out', '--seeds', '--max-seconds', '--compare'].includes(args[i]) || !args[i+1]) {
    throw new Error('Usage: node headless/benchmark.mjs --out NEW_DIRECTORY [--seeds 1,2,3] [--max-seconds 86400] [--compare REFERENCE_DIRECTORY]');
  }
  if (options[args[i]]) throw new Error('Duplicate option: ' + args[i]);
  options[args[i]] = args[i+1];
}
if (!options['--out']) throw new Error('--out is required; existing directories are never overwritten');
const seeds = (options['--seeds'] || '1').split(',').map(Number);
if (seeds.some(s => !Number.isInteger(s) || s < 0 || s > 0xffffffff) || new Set(seeds).size !== seeds.length) throw new Error('Seeds must be distinct uint32 integers');
const maxEpisodeSeconds = Number(options['--max-seconds'] || 86400);
if (!Number.isFinite(maxEpisodeSeconds) || maxEpisodeSeconds < 0.333 || maxEpisodeSeconds > 604800) throw new Error('Invalid episode limit');
const out = resolve(options['--out']);
const root = new URL('../', import.meta.url);
const sha = value => createHash('sha256').update(value).digest('hex');
const git = (...argv) => execFileSync('git', argv, {cwd: root, encoding:'utf8'}).trim();
const provenance = {
  commit: git('rev-parse','HEAD'), dirty: !!git('status','--porcelain'),
  policySha256: sha(readFileSync(new URL('./scripted-player.mjs', import.meta.url))),
  runnerSha256: sha(readFileSync(new URL('./benchmark.mjs', import.meta.url))),
  node: process.version, platform: platform(), arch: arch(), cpu: cpus()[0]?.model,
  workers: 1, startedAt: new Date().toISOString(),
};
mkdirSync(out); // Intentionally exclusive: every experiment has its own directory.
const summaries = [];
for (const seed of seeds) {
  const started = performance.now();
  const env = new HeadlessEnvironment({seed, maxEpisodeSeconds});
  const initializationMs = performance.now() - started;
  let observation = env.observe();
  const trace = createHash('sha256');
  trace.update(JSON.stringify(observation) + '\n');
  const milestones = [], actionCounts = {};
  let policyMs = 0, stepMs = 0, recordingMs = 0, lastReport = performance.now();
  const simulationStarted = performance.now();
  while (!observation.completed && !observation.truncated) {
    let time = performance.now();
    const action = chooseAction(observation);
    policyMs += performance.now() - time;
    time = performance.now();
    const result = env.step(action);
    stepMs += performance.now() - time;
    time = performance.now();
    trace.update(JSON.stringify({action, result}) + '\n');
    actionCounts[action.type] = (actionCounts[action.type] || 0) + 1;
    if (result.observation.treeLevel !== observation.treeLevel || result.terminated) {
      milestones.push({tick:result.observation.simulationTicks, gameSeconds:result.observation.elapsedSeconds,
        treeLevel:result.observation.treeLevel, completed:result.terminated});
    }
    observation = result.observation;
    recordingMs += performance.now() - time;
    if (performance.now() - lastReport > 30000 || result.terminated || result.truncated) {
      process.stdout.write(JSON.stringify({seed, tick:observation.simulationTicks, gameSeconds:observation.elapsedSeconds,
        level:observation.treeLevel, completed:result.terminated, wallSeconds:(performance.now()-started)/1000}) + '\n');
      lastReport = performance.now();
    }
  }
  const simulationMs = performance.now() - simulationStarted;
  const checkpoint = JSON.stringify(env.snapshot());
  const summary = {
    format:'etherealfarm-benchmark-v1', ...provenance, seed, metadata:env.metadata,
    completed:observation.completed, truncated:observation.truncated,
    gameSeconds:observation.elapsedSeconds, ticks:observation.simulationTicks,
    completionLevel:observation.completionLevel, awardedResin:observation.awardedResin,
    traceSha256:trace.digest('hex'), finalObservationSha256:sha(JSON.stringify(observation)),
    historySha256:sha(JSON.stringify(JSON.parse(checkpoint).history)),
    timing:{initializationMs, simulationMs, policyMs, stepMs, recordingMs,
      ticksPerSecond:observation.simulationTicks/(simulationMs/1000),
      gameSecondsPerWallSecond:observation.elapsedSeconds/(simulationMs/1000)},
    milestones, actionCounts,
  };
  if (options['--compare']) {
    const reference = JSON.parse(readFileSync(resolve(options['--compare'], `seed-${seed}.json`), 'utf8'));
    const keys = ['seed','policySha256','runnerSha256','completed','truncated','gameSeconds','ticks','traceSha256','finalObservationSha256','historySha256'];
    const mismatches = keys.filter(key => JSON.stringify(reference[key]) !== JSON.stringify(summary[key]));
    if (reference.metadata.maxEpisodeSeconds !== summary.metadata.maxEpisodeSeconds) mismatches.push('maxEpisodeSeconds');
    summary.comparison = {reference:resolve(options['--compare']), matches:mismatches.length === 0, mismatches,
      simulationSpeedup:reference.timing.simulationMs / simulationMs};
    if (mismatches.length) process.exitCode = 1;
  }
  writeFileSync(resolve(out, `seed-${seed}.checkpoint.json.gz`), gzipSync(checkpoint));
  writeFileSync(resolve(out, `seed-${seed}.json`), JSON.stringify(summary,null,2)+'\n');
  summaries.push(summary);
  process.stdout.write(JSON.stringify({seed, completed:summary.completed, gameSeconds:summary.gameSeconds,
    ticksPerSecond:summary.timing.ticksPerSecond, comparison:summary.comparison})+'\n');
}
const completedTimes = summaries.filter(s => s.completed).map(s => s.gameSeconds).sort((a,b)=>a-b);
const middle = Math.floor(completedTimes.length/2);
writeFileSync(resolve(out,'summary.json'), JSON.stringify({format:'etherealfarm-benchmark-summary-v1', ...provenance,
  seeds, completed:summaries.filter(s=>s.completed).length, truncated:summaries.filter(s=>s.truncated).length,
  medianSuccessfulGameSeconds:completedTimes.length ? (completedTimes.length%2 ? completedTimes[middle] : (completedTimes[middle-1]+completedTimes[middle])/2) : null,
  comparisonsPassed:options['--compare'] ? summaries.every(s=>s.comparison.matches) : null},null,2)+'\n');
