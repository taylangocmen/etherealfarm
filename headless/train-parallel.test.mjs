/* Ethereal Farm — GPL-3.0-or-later; see LICENSE. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, existsSync, rmSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { gunzipSync } from 'node:zlib';
import { setTimeout as delay } from 'node:timers/promises';

const root = new URL('..', import.meta.url);
const read = file => JSON.parse(readFileSync(file, 'utf8'));
function launch(out, { workers = 3, seconds = 33.3, legacy = false, children = 2 } = {}) {
  const args = [legacy ? 'headless/train.mjs' : 'headless/train-parallel.mjs', '--out', out,
    '--generations', '1', '--children', String(children), '--max-seconds', String(seconds)];
  if (!legacy) args.push('--workers', String(workers));
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
