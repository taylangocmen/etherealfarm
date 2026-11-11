/* Ethereal Farm — GPL-3.0-or-later; see LICENSE. */
import { mkdirSync, existsSync, openSync, closeSync, writeFileSync, unlinkSync } from 'node:fs';
import { resolve } from 'node:path';
import { fork, execFileSync } from 'node:child_process';
import { HeadlessEnvironment } from './environment.mjs';
import { initialParameters } from './learned-policy.mjs';
import { clone, readJSON, writeJSON, mutate, trainerFingerprint, policyDigest, validateStartingPolicy } from './parallel-training-common.mjs';

const opts = {}, args = process.argv.slice(2);
for (let i = 0; i < args.length; i += 2) {
  if (!['--out', '--workers', '--generations', '--children', '--max-seconds', '--initial-policy', '--search-seed', '--validation-seeds'].includes(args[i]) ||
      !args[i + 1] || opts[args[i]]) throw new Error('Usage: node headless/train-parallel.mjs --out DIRECTORY [--workers 9 --generations 8 --children 16 --max-seconds 28800 --initial-policy FILE --search-seed UINT32 --validation-seeds 201,202]');
  opts[args[i]] = args[i + 1];
}
if (!opts['--out']) throw new Error('--out is required');
const workers = Number(opts['--workers'] || 9);
const config = { generations: Number(opts['--generations'] || 8), children: Number(opts['--children'] || 16),
  maxSeconds: Number(opts['--max-seconds'] || 28800), trainingSeeds: [1, 2],
  validationSeeds: opts['--validation-seeds'] ? opts['--validation-seeds'].split(',').map(v => /^\d+$/.test(v) ? Number(v) : NaN) : [101, 102],
  searchSeed: Number(opts['--search-seed'] ?? 20261111) };
const uint32 = value => Number.isInteger(value) && value >= 0 && value <= 0xffffffff;
if (!Number.isInteger(workers) || workers < 1 || workers > 64 ||
    !Number.isInteger(config.generations) || config.generations < 1 || config.generations > 100 ||
    !Number.isInteger(config.children) || config.children < 1 || config.children > 100 ||
    !Number.isFinite(config.maxSeconds) || config.maxSeconds < .333 || config.maxSeconds > 604800 ||
    !uint32(config.searchSeed) || config.validationSeeds.length < 1 || config.validationSeeds.length > 100 ||
    !config.validationSeeds.every(seed => uint32(seed) && !config.trainingSeeds.includes(seed)) ||
    new Set(config.validationSeeds).size !== config.validationSeeds.length) throw new Error('Invalid training bounds or seeds');

const directory = resolve(opts['--out']);
mkdirSync(directory, { recursive: true });
const file = name => resolve(directory, name);
const lockPath = file('running.lock');
if (existsSync(lockPath)) {
  const pid = readJSON(lockPath);
  if (!Number.isInteger(pid) || pid <= 0) throw new Error('Invalid running.lock');
  try { process.kill(pid, 0); throw new Error(`Training directory already in use by PID ${pid}`); }
  catch (error) { if (error.code !== 'ESRCH') throw error; unlinkSync(lockPath); }
}
const lock = openSync(lockPath, 'wx');
writeFileSync(lock, String(process.pid)); closeSync(lock);
let state, stopping = false;
const children = new Set();
function stop() {
  stopping = true;
  for (const child of children) if (child.connected) child.send({ type: 'stop' }, () => {});
}
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, stop);
function save() {
  state.pid = process.pid; state.workers = workers; state.updatedAt = new Date().toISOString();
  writeJSON(file('status.json'), state);
}
try {
  const env = new HeadlessEnvironment({ seed: 1, maxEpisodeSeconds: config.maxSeconds });
  const identity = { engine: env.metadata.engineFingerprint, trainer: trainerFingerprint() };
  const saved = existsSync(file('status.json')) ? readJSON(file('status.json')) : null;
  let startingPolicy;
  if (opts['--initial-policy']) {
    const sourcePath = resolve(opts['--initial-policy']);
    const artifact = readJSON(sourcePath);
    startingPolicy = { sourcePath, sha256: policyDigest(artifact), artifact };
  } else if (saved?.startingPolicy) {
    // Resume from the embedded copy even if the original export was moved.
    startingPolicy = saved.startingPolicy;
  }
  if (startingPolicy) {
    validateStartingPolicy(startingPolicy.artifact, identity.engine, initialParameters);
    if (policyDigest(startingPolicy.artifact) !== startingPolicy.sha256) throw new Error('Starting policy digest mismatch');
    config.initialPolicySha256 = startingPolicy.sha256;
  }
  if (saved) {
    if (saved.format !== 'etherealfarm-parallel-training-v1' || JSON.stringify(saved.config) !== JSON.stringify(config) ||
        JSON.stringify(saved.identity) !== JSON.stringify(identity)) throw new Error('Configuration or source changed; use a new output directory');
    // After an unclean coordinator exit, disconnected workers may still be
    // finishing a checkpoint. Never allow two writers for those episode files.
    for (const active of Object.values(saved.active || {})) {
      if (!active.pid) continue;
      try { process.kill(active.pid, 0); throw new Error(`Previous worker PID ${active.pid} is still alive; retry after it exits`); }
      catch (error) { if (error.code !== 'ESRCH') throw error; }
    }
    state = saved;
  } else {
    state = { format: 'etherealfarm-parallel-training-v1', config, identity, node: process.version,
      commit: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: new URL('..', import.meta.url), encoding: 'utf8' }).trim(),
      startedAt: new Date().toISOString(), status: 'starting', rng: config.searchSeed,
      generation: 0, completed: [], pending: [], validation: [], best: null, startingPolicy };
  }
  state.active = {};
  delete state.error;

  function readResult(job) {
    if (!existsSync(file(job.id + '.json'))) return null;
    const result = readJSON(file(job.id + '.json'));
    if (JSON.stringify(result.identity) !== JSON.stringify(identity) || result.seed !== job.seed ||
        JSON.stringify(result.parameters) !== JSON.stringify(job.parameters)) throw new Error(`Result identity mismatch: ${job.id}`);
    return result;
  }
  function runJob(job) {
    return new Promise((resolveJob, rejectJob) => {
      const child = fork(new URL('./training-worker.mjs', import.meta.url), [], { stdio: ['ignore', 'inherit', 'inherit', 'ipc'] });
      children.add(child);
      let error;
      child.on('error', cause => { error = cause; });
      child.on('message', message => {
        try {
          if (message.type === 'progress') {
            state.active[job.id] = message.active;
            save();
            console.log(JSON.stringify({ event: 'progress', ...message.active, parameters: undefined, identity: undefined }));
          } else if (message.type === 'result') {
            console.log(JSON.stringify({ event: 'episode', id: job.id, ...message.result, parameters: undefined, identity: undefined }));
          }
        } catch (cause) {
          error = cause; child.kill('SIGTERM');
        }
      });
      // 'close' also fires when process creation fails (where 'exit' may not).
      child.on('close', (code, signal) => {
        children.delete(child); delete state.active[job.id];
        try {
          save();
          if (error || code !== 0) throw error || new Error(`Worker ${job.id} exited ${code ?? signal}`);
          if (!stopping && !readResult(job)) throw new Error(`Worker ${job.id} exited without a result`);
          resolveJob();
        } catch (cause) { rejectJob(cause); }
      });
      try {
        state.active[job.id] = { id: job.id, seed: job.seed, pid: child.pid, phase: 'starting' };
        save();
        child.send({ type: 'start', job: { ...job, directory, maxSeconds: config.maxSeconds, identity } }, cause => {
          if (cause) { error = cause; child.kill('SIGTERM'); }
        });
      } catch (cause) {
        error = cause;
        // No episode was assigned, so disconnect lets an idle worker exit.
        if (child.connected) child.disconnect();
      }
    });
  }
  async function evaluate(candidates, seeds) {
    const jobs = candidates.flatMap(candidate => seeds.map(seed => ({ id: `${candidate.id}-seed-${seed}`, seed, parameters: candidate.parameters })));
    const missing = jobs.filter(job => !readResult(job));
    let cursor = 0, failure;
    await Promise.all(Array.from({ length: Math.min(workers, missing.length) }, async () => {
      while (!stopping && cursor < missing.length) {
        const job = missing[cursor++];
        try { await runJob(job); }
        catch (error) { failure ??= error; stop(); }
      }
    }));
    if (failure) throw failure;
    if (stopping) return false;
    for (const candidate of candidates) {
      candidate.episodes = seeds.map(seed => readResult({ id: `${candidate.id}-seed-${seed}`, seed, parameters: candidate.parameters }));
      candidate.loss = candidate.episodes.reduce((sum, episode) => sum + episode.loss, 0) / seeds.length;
      candidate.successes = candidate.episodes.filter(episode => episode.completed).length;
    }
    return true;
  }

  if (state.status !== 'complete') {
    state.status = 'training'; save();
    if (!state.best) {
      state.initial ??= { id: 'initial', parameters: clone(state.startingPolicy?.artifact.parameters ?? initialParameters) };
      save();
      if (await evaluate([state.initial], config.trainingSeeds)) {
        state.best = clone(state.initial); state.completed.push(clone(state.initial)); save();
        writeJSON(file('best-policy.json'), { identity, trainingSeeds: config.trainingSeeds, ...state.best });
      }
    }
    while (!stopping && state.generation < config.generations) {
      if (!state.pending.length) {
        state.pending = Array.from({ length: config.children }, (_, i) => ({ id: `g${state.generation + 1}-c${i + 1}`, parameters: mutate(state.best.parameters, state) }));
        save();
      }
      if (!await evaluate(state.pending, config.trainingSeeds)) break;
      // Fixed candidate/seed order preserves ties and parent choice regardless
      // of which worker finishes first. Only one coordinator writes search state.
      for (const candidate of state.pending) {
        if (candidate.successes > state.best.successes ||
            (candidate.successes === state.best.successes && candidate.loss < state.best.loss)) state.best = clone(candidate);
        state.completed.push(clone(candidate));
      }
      state.pending = []; state.generation++;
      save();
      writeJSON(file('best-policy.json'), { identity, trainingSeeds: config.trainingSeeds, ...state.best });
      console.log(JSON.stringify({ event: 'generation', generation: state.generation, best: state.best.id, loss: state.best.loss }));
    }
    if (!stopping) {
      state.status = 'validating';
      if (!state.validation.length) state.validation = [
        { id: 'validation-initial', parameters: clone(state.initial.parameters) },
        { id: 'validation-best', parameters: clone(state.best.parameters) },
      ];
      save();
      await evaluate(state.validation, config.validationSeeds);
    }
    state.status = stopping ? 'stopped' : 'complete';
    if (!stopping) {
      const [baseline, winner] = state.validation;
      state.finishedAt = new Date().toISOString();
      state.result = { selectedCandidate: state.best.id,
        trainingMeanSeconds: state.best.successes === config.trainingSeeds.length ? state.best.loss : null,
        validationBaselineMeanSeconds: baseline.successes === config.validationSeeds.length ? baseline.loss : null,
        validationWinnerMeanSeconds: winner.successes === config.validationSeeds.length ? winner.loss : null,
        validationImprovementPercent: baseline.successes === config.validationSeeds.length && winner.successes === config.validationSeeds.length
          ? 100 * (baseline.loss - winner.loss) / baseline.loss : null };
      if (state.startingPolicy) {
        state.result.startingPolicyId = state.startingPolicy.artifact.id;
        state.result.trainingBaselineMeanSeconds = state.initial.successes === config.trainingSeeds.length ? state.initial.loss : null;
        state.result.trainingImprovementPercent = state.initial.successes === config.trainingSeeds.length && state.best.successes === config.trainingSeeds.length
          ? 100 * (state.initial.loss - state.best.loss) / state.initial.loss : null;
      }
    }
    save();
  }
  if (state.best) writeJSON(file('best-policy.json'), { identity, trainingSeeds: config.trainingSeeds, ...state.best });
  console.log(`${state.status}: ${file('status.json')}`);
} catch (error) {
  if (state) { state.status = 'failed'; state.error = String(error.stack || error); save(); }
  console.error(error.stack || error); process.exitCode = 1;
} finally {
  unlinkSync(lockPath);
}
