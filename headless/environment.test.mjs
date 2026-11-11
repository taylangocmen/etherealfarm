/* Ethereal Farm — GPL-3.0-or-later; see LICENSE. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { HeadlessEnvironment, TICK_SECONDS } from './environment.mjs';

function firstPlant(env) {
  const action = env.legalActions().find(a => a.type === 'plant');
  assert.ok(action, 'starter resources must afford watercress');
  return action;
}

test('fresh farm uses the real starter budget, tree footprint, and action restrictions', () => {
  const env = new HeadlessEnvironment();
  const o = env.observe();
  assert.equal(o.elapsedSeconds, 0);
  assert.equal(o.treeLevel, 0);
  assert.equal(o.season, 0);
  assert.equal(o.field.length, 5);
  assert.equal(o.field[0].length, 5);
  assert.equal(o.field[1][2].tile, 1);
  assert.equal(o.field[2][2].tile, 2);
  const seeds = o.resources.seeds.b * 2 ** o.resources.seeds.e;
  assert.ok(Math.abs(seeds - 10.00001) < 1e-9);
  assert.equal(o.resources.resin.b, 0);
  assert.equal(o.legalActions.filter(a => a.type === 'plant').length, 23);
  assert.ok(!o.legalActions.some(a => a.type === 'transcend' || a.type === 'fruit-select'));
  assert.equal('fruit_seed' in o, false);
  assert.equal('state' in env, false);
});

test('illegal actions leave time and state unchanged', () => {
  const env = new HeadlessEnvironment();
  const before = env.observe();
  const plant = firstPlant(env);
  assert.throws(() => env.step({ ...plant, x: 2, y: 2 }), /not currently legal/);
  assert.throws(() => env.step({ ...plant, by_automaton: true }), /not currently legal/);
  assert.throws(() => env.step({ type: 'transcend' }), /not currently legal/);
  assert.throws(() => env.step(plant, { ticks: 0 }), /ticks/);
  assert.deepEqual(env.observe(), before);
});

test('observations are detached and separate environments do not share state', () => {
  const a = new HeadlessEnvironment({ seed: 7 });
  const b = new HeadlessEnvironment({ seed: 7 });
  const original = b.observe();
  const exported = a.observe();
  exported.resources.seeds.b = 1e99;
  exported.field[0][0].crop = 123;
  exported.legalActions.length = 0;
  assert.deepEqual(a.observe(), original);
  a.step(firstPlant(a));
  assert.deepEqual(b.observe(), original);
  assert.deepEqual(a.reset({ seed: 7 }), original);
});

test('batching waits does not change integration or seeded fern behavior', () => {
  const a = new HeadlessEnvironment({ seed: 42 });
  const b = new HeadlessEnvironment({ seed: 42 });
  a.step(firstPlant(a));
  b.step(firstPlant(b));
  // Long enough for the original 60-second watercress to wither, without
  // purchasing upgrades. No offline catch-up or fabricated growth is used.
  a.step({ type: 'wait' }, { ticks: 600 });
  for (let i = 0; i < 600; i++) b.step({ type: 'wait' });
  assert.deepEqual(a.observe(), b.observe());
  assert.equal(a.observe().field[0][0].crop, null);
});

test('replay checkpoint restores clocks, random streams, and subsequent outcomes', () => {
  const env = new HeadlessEnvironment({ seed: 19 });
  env.step(firstPlant(env));
  env.step({ type: 'wait' }, { ticks: 600 });
  const checkpoint = env.snapshot();
  const before = env.observe();
  const expected = env.step({ type: 'wait' }, { ticks: 100 });
  assert.deepEqual(env.restore(checkpoint), before);
  assert.deepEqual(env.step({ type: 'wait' }, { ticks: 100 }), expected);
  const current = env.observe();
  assert.throws(() => env.restore({ ...checkpoint, engineFingerprint: 'different' }), /fingerprint/);
  assert.deepEqual(env.observe(), current);
});

test('reading information has the same achievement consequence as the UI', () => {
  const env = new HeadlessEnvironment();
  assert.ok(!env.observe().achievements.includes(2002));
  const result = env.step({ type: 'inspect', page: 'stats' });
  assert.ok(result.observation.achievements.includes(2002));
  assert.equal(result.reward, -TICK_SECONDS);
  assert.ok(!env.legalActions().some(a => a.type === 'inspect' && a.page === 'stats'));
});

test('time limit truncates an unfinished episode without awarding success', () => {
  const env = new HeadlessEnvironment({ maxEpisodeSeconds: 3.33 });
  const result = env.step({ type: 'wait' }, { ticks: 100 });
  assert.equal(result.observation.simulationTicks, 10);
  assert.equal(result.observation.elapsedSeconds, 3.33);
  assert.equal(result.terminated, false);
  assert.equal(result.truncated, true);
  assert.equal(result.observation.awardedResin.b, 0);
  assert.deepEqual(env.legalActions(), []);
  assert.throws(() => env.step(), /Episode has ended/);
});
