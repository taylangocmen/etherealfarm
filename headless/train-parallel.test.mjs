/* Ethereal Farm — GPL-3.0-or-later; see LICENSE. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, existsSync, rmSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { gunzipSync } from 'node:zlib';
import { setTimeout as delay } from 'node:timers/promises';
import { HeadlessEnvironment } from './environment.mjs';
import { initialParameters } from './learned-policy.mjs';
import { clone, mutate, policyDigest, validateStartingPolicy } from './parallel-training-common.mjs';

const root = new URL('..', import.meta.url);
const read = file => JSON.parse(readFileSync(file, 'utf8'));
function launch(out, { workers = 3, seconds = 33.3, legacy = false, children = 2, extra = [] } = {}) {
  const args = [legacy ? 'headless/train.mjs' : 'headless/train-parallel.mjs', '--out', out,
    '--generations', '1', '--children', String(children), '--max-seconds', String(seconds)];
  if (!legacy) args.push('--workers', String(workers));
  args.push(...extra);
  const child = spawn(process.execPath, args, { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  child.stdout.on('data', data => { output += data; });
  child.stderr.on('data', data => { output += data; });
  const done = new Promise((resolve, reject) => {
    child.on('error', reject);
    child.on('close', (code, signal) => resolve({ code, signal, output }));
  });
  return { child, done };
}
async function until(predicate, timeout = 20000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const result = predicate();
    if (result) return result;
    await delay(25);
  }
  throw new Error('Timed out waiting for trainer state');
}
const stateAt = dir => existsSync(join(dir, 'status.json')) ? read(join(dir, 'status.json')) : null;
function deterministic(state) {
  return {
    rng: state.rng, generation: state.generation, result: state.result,
    completed: state.completed.map(candidate => ({ id: candidate.id, parameters: candidate.parameters,
      loss: candidate.loss, successes: candidate.successes,
      episodes: candidate.episodes.map(({ seed, completed, truncated, gameSeconds, ticks, awardedResin, loss }) =>
        ({ seed, completed, truncated, gameSeconds, ticks, awardedResin, loss })) })),
  };
}

test('parallel scheduling matches serial and legacy search, results, and replay histories', { timeout: 120000 }, async () => {
  const temp = mkdtempSync(join(tmpdir(), 'etherealfarm-parallel-'));
  try {
    for (const [name, options] of [['legacy', { legacy: true }], ['serial', { workers: 1 }], ['parallel', { workers: 3 }]]) {
      const result = await launch(join(temp, name), options).done;
      assert.equal(result.code, 0, result.output);
      assert.equal(stateAt(join(temp, name)).status, 'complete');
    }
    assert.deepEqual(deterministic(stateAt(join(temp, 'parallel'))), deterministic(stateAt(join(temp, 'serial'))));
    assert.deepEqual(deterministic(stateAt(join(temp, 'parallel'))), deterministic(stateAt(join(temp, 'legacy'))));
    for (const name of readdirSync(join(temp, 'legacy')).filter(name => name.endsWith('.checkpoint.json.gz'))) {
      const snapshot = dir => JSON.parse(gunzipSync(readFileSync(join(temp, dir, name))));
      assert.deepEqual(snapshot('parallel'), snapshot('legacy'));
      assert.deepEqual(snapshot('parallel'), snapshot('serial'));
    }
    const before = readFileSync(join(temp, 'parallel/status.json'), 'utf8');
    const mismatch = await launch(join(temp, 'parallel'), { seconds: 66.6 }).done;
    assert.notEqual(mismatch.code, 0);
    assert.match(mismatch.output, /Configuration or source changed/);
    assert.equal(readFileSync(join(temp, 'parallel/status.json'), 'utf8'), before);
    const rerun = await launch(join(temp, 'parallel')).done;
    assert.equal(rerun.code, 0, rerun.output);
  } finally { rmSync(temp, { recursive: true, force: true }); }
});

test('warm start retains the imported winner, resumes without source file and compares on fresh seeds', { timeout: 120000 }, async () => {
  const temp = mkdtempSync(join(tmpdir(), 'etherealfarm-warm-'));
  const out = join(temp, 'run'), source = join(temp, 'winner.json');
  const engine = new HeadlessEnvironment().metadata.engineFingerprint;
  const parameters = clone(initialParameters);
  parameters.priorities = [-2, 5, 4, 1];
  parameters.unlockFraction = .8;
  parameters.upgradeFraction = .6;
  [parameters.layout[0][0], parameters.layout[0][1]] = [parameters.layout[0][1], parameters.layout[0][0]];
  const artifact = { id: 'previous-winner', identity: { engine, trainer: 'older-trainer' }, parameters };
  writeFileSync(source, JSON.stringify(artifact));
  const options = { seconds: 333, children: 1, extra: ['--search-seed', '17', '--validation-seeds', '201,202'] };
  let current;
  try {
    current = launch(out, { ...options, extra: [...options.extra, '--initial-policy', source] });
    await until(() => Object.values(stateAt(out)?.active || {}).some(a => a.phase === 'training'));
    current.child.kill('SIGTERM');
    let result = await current.done;
    assert.equal(result.code, 0, result.output);
    assert.equal(stateAt(out).status, 'stopped');
    assert.deepEqual(stateAt(out).initial.parameters, parameters);
    assert.equal(stateAt(out).config.initialPolicySha256, policyDigest(artifact));
    assert.equal(readFileSync(source, 'utf8'), JSON.stringify(artifact));

    const before = readFileSync(join(out, 'status.json'), 'utf8');
    const changed = clone(artifact);
    changed.parameters.priorities[0]++;
    writeFileSync(source, JSON.stringify(changed));
    result = await launch(out, { ...options, extra: [...options.extra, '--initial-policy', source] }).done;
    assert.notEqual(result.code, 0);
    assert.match(result.output, /Configuration or source changed/);
    assert.equal(readFileSync(join(out, 'status.json'), 'utf8'), before);
    rmSync(source);

    current = launch(out, options);
    result = await current.done;
    assert.equal(result.code, 0, result.output);
    const state = stateAt(out);
    assert.equal(state.status, 'complete');
    assert.deepEqual(state.initial.parameters, parameters);
    assert.deepEqual(state.best.parameters, parameters); // All short episodes tie: incumbent survives.
    assert.deepEqual(state.completed[1].parameters, mutate(parameters, { rng: 17 }));
    assert.deepEqual(state.validation[0].parameters, parameters);
    assert.deepEqual(state.validation[0].episodes.map(e => e.seed), [201, 202]);
    assert.deepEqual(state.startingPolicy.artifact, artifact);
    assert.equal(state.result.startingPolicyId, 'previous-winner');
    assert.equal(state.result.validationImprovementPercent, null);
    assert.equal(state.result.trainingImprovementPercent, null);

    for (const extra of [['--validation-seeds', '1,201'], ['--validation-seeds', '201,201'], ['--search-seed', '-1']]) {
      result = await launch(join(temp, 'invalid'), { extra }).done;
      assert.notEqual(result.code, 0);
      assert.match(result.output, /Invalid training bounds or seeds/);
    }
    assert.throws(() => validateStartingPolicy({ ...artifact, identity: { engine: 'wrong' } }, engine, initialParameters), /engine fingerprint/);
    const invalid = clone(artifact);
    invalid.parameters.layout[1][2] = 'berry';
    assert.throws(() => validateStartingPolicy(invalid, engine, initialParameters), /tree cells/);
    invalid.parameters = clone(parameters);
    invalid.parameters.layout[0][0] = 'berry';
    assert.throws(() => validateStartingPolicy(invalid, engine, initialParameters), /crop-role counts/);
    invalid.parameters = clone(parameters);
    invalid.parameters.priorities[0] = Infinity;
    assert.throws(() => validateStartingPolicy(invalid, engine, initialParameters), /Invalid starting policy/);
  } finally {
    if (current?.child.exitCode === null) { current.child.kill('SIGTERM'); await current.done; }
    rmSync(temp, { recursive: true, force: true });
  }
});

test('stop/resume checkpoints, duplicate lock, worker failure and recovery', { timeout: 120000 }, async () => {
  const temp = mkdtempSync(join(tmpdir(), 'etherealfarm-recovery-'));
  let current;
  const options = { seconds: 333, children: 1, workers: 2 };
  try {
    current = launch(temp, options);
    await until(() => Object.values(stateAt(temp)?.active || {}).some(active => active.phase === 'training'));
    // A competing invocation fails without touching the live owner's state.
    const duplicate = await launch(temp, options).done;
    assert.notEqual(duplicate.code, 0);
    assert.match(duplicate.output, /already in use/);
    current.child.kill('SIGTERM');
    let result = await current.done;
    assert.equal(result.code, 0, result.output);
    assert.equal(stateAt(temp).status, 'stopped');
    assert.equal(existsSync(join(temp, 'running.lock')), false);
    const checkpoints = readdirSync(temp).filter(name => name.endsWith('.progress.json'));
    assert.ok(checkpoints.length > 0);
    for (const name of checkpoints) assert.ok(existsSync(join(temp, read(join(temp, name)).checkpoint)));

    current = launch(temp, options);
    const active = await until(() => Object.values(stateAt(temp)?.active || {}).find(active => active.phase === 'restoring'));
    process.kill(active.pid, 'SIGKILL');
    result = await current.done;
    assert.notEqual(result.code, 0);
    assert.equal(stateAt(temp).status, 'failed');
    assert.equal(existsSync(join(temp, 'running.lock')), false);

    current = launch(temp, options);
    result = await current.done;
    assert.equal(result.code, 0, result.output);
    assert.equal(stateAt(temp).status, 'complete');
    const reference = join(temp, 'reference');
    current = launch(reference, { ...options, workers: 1 });
    result = await current.done;
    assert.equal(result.code, 0, result.output);
    assert.deepEqual(deterministic(stateAt(temp)), deterministic(stateAt(reference)));
    for (const name of readdirSync(reference).filter(name => name.endsWith('.checkpoint.json.gz'))) {
      assert.deepEqual(JSON.parse(gunzipSync(readFileSync(join(temp, name)))),
        JSON.parse(gunzipSync(readFileSync(join(reference, name)))));
    }
  } finally {
    if (current?.child.exitCode === null) { current.child.kill('SIGTERM'); await current.done; }
    rmSync(temp, { recursive: true, force: true });
  }
});
