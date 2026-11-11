/* Ethereal Farm — GPL-3.0-or-later; see LICENSE. */
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { gzipSync, gunzipSync } from 'node:zlib';
import { setImmediate as yieldTurn } from 'node:timers/promises';
import { HeadlessEnvironment } from './environment.mjs';
import { chooseAction } from './learned-policy.mjs';
import { atomic, readJSON, writeJSON, trainerFingerprint } from './parallel-training-common.mjs';

let stopping = false, startedJob = false;
for (const signal of ['SIGINT', 'SIGTERM', 'disconnect']) process.on(signal, () => { stopping = true; });
function report(message) {
  if (process.connected) process.send(message, error => { if (error) stopping = true; });
}
process.on('message', message => {
  if (message.type === 'stop') { stopping = true; return; }
  if (message.type !== 'start' || startedJob) return;
  startedJob = true;
  run(message.job).catch(error => {
    console.error(error.stack || error);
    process.exitCode = 1;
  }).finally(() => { if (process.connected) process.disconnect(); });
});

async function run(job) {
  const { id, seed, parameters, directory, maxSeconds, identity } = job;
  const file = suffix => resolve(directory, id + suffix);
  const env = new HeadlessEnvironment({ seed, maxEpisodeSeconds: maxSeconds });
  if (env.metadata.engineFingerprint !== identity.engine || trainerFingerprint() !== identity.trainer) {
    throw new Error('Worker source fingerprint changed');
  }
  let previous = existsSync(file('.progress.json')) ? readJSON(file('.progress.json')) : null;
  if (previous) {
    if (JSON.stringify(previous.identity) !== JSON.stringify(identity) || previous.seed !== seed ||
        JSON.stringify(previous.parameters) !== JSON.stringify(parameters)) throw new Error('Worker checkpoint identity mismatch');
    report({ type: 'progress', active: { id, seed, pid: process.pid, phase: 'restoring', gameSeconds: previous.gameSeconds } });
    env.restore(JSON.parse(gunzipSync(readFileSync(resolve(directory, previous.checkpoint)))));
  }
  let o = env.observe(), start = performance.now(), saved = start;
  const elapsedWall = previous?.wallSeconds || 0;
  function checkpoint() {
    // Alternate files: a crash before publishing progress leaves the previous
    // checkpoint intact, unlike overwriting one shared active checkpoint.
    const slot = previous?.slot === 0 ? 1 : 0;
    const checkpointName = `${id}.active-${slot}.checkpoint.json.gz`;
    atomic(resolve(directory, checkpointName), gzipSync(JSON.stringify(env.snapshot())));
    previous = { identity, parameters, id, seed, pid: process.pid, phase: 'training', slot,
      checkpoint: checkpointName, gameSeconds: o.elapsedSeconds, treeLevel: o.treeLevel,
      wallSeconds: elapsedWall + (performance.now() - start) / 1000 };
    writeJSON(file('.progress.json'), previous);
    report({ type: 'progress', active: previous });
  }
  report({ type: 'progress', active: { id, seed, pid: process.pid, phase: 'training', gameSeconds: o.elapsedSeconds } });
  while (!o.completed && !o.truncated && !stopping) {
    for (let j = 0; j < 100 && !o.completed && !o.truncated; j++) {
      o = env.step(chooseAction(o, parameters)).observation;
    }
    await yieldTurn();
    if (performance.now() - saved >= 30000) { checkpoint(); saved = performance.now(); }
  }
  if (stopping) { checkpoint(); return; }
  const result = { identity, parameters, seed, completed: o.completed, truncated: o.truncated,
    gameSeconds: o.elapsedSeconds, ticks: o.simulationTicks, completionLevel: o.completionLevel,
    awardedResin: o.awardedResin, wallSeconds: elapsedWall + (performance.now() - start) / 1000,
    loss: o.completed ? o.elapsedSeconds : maxSeconds * 2 };
  atomic(file('.checkpoint.json.gz'), gzipSync(JSON.stringify(env.snapshot())));
  writeJSON(file('.json'), result);
  report({ type: 'result', id, result });
}
