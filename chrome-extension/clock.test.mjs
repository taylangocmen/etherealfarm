import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
const clockSource = readFileSync(new URL('./clock.js', import.meta.url), 'utf8');
function fixture(store = new Map()) {
  let time = 1794355200000;
  const listeners = {};
  const context = vm.createContext({
    Date: { now: () => time }, location: { hostname: 'lodev.org', pathname: '/etherealfarm/' },
    document: { hidden: false, addEventListener: (name, fn) => { listeners[name] = fn; } },
    localStorage: { getItem: key => store.get(key) ?? null, setItem: (key, value) => store.set(key, value) }
  });
  context.window = context;
  context.addEventListener = (name, fn) => { listeners[name] = fn; };
  vm.runInContext(clockSource, context);
  return { context, clock: context.__etherealSpeed, advance: ms => { time += ms; },
    now: () => context.Date.now(), listeners, store };
}
for (const rate of [1, 10, 20, 30, 40, 50, 60, 70, 80, 90, 100]) {
  test(`${rate}× advances the actual game simulation`, () => {
    const f = fixture();
    f.context.gameRuntime = { headless: true, holiday: 0, now: () => f.now() / 1000,
      random: () => 0.5, schedule: () => {}, emit: () => {} };
    for (const file of ['game_runtime.js', 'utils.js', 'headless/presentation.js', 'image.js',
      'images.js', 'images_plants.js', 'images_fish.js', 'images_tree.js', 'images_medals.js',
      'images_td.js', 'number.js', 'resource.js', 'strings.js', 'towerdefense.js', 'data.js',
      'state.js', 'gameplay_helpers.js', 'game.js', 'headless/bridge.js']) {
      vm.runInContext(readFileSync(new URL('../' + file, import.meta.url), 'utf8'), f.context);
    }
    f.context.headlessBridge.initialize();
    const start = f.context.state.c_runtime;
    f.clock.setRate(rate);
    f.advance(333);
    f.context.update();
    assert.ok(Math.abs(f.context.state.c_runtime - start - 0.333 * rate) < 0.001);
    // Reproduce an already-exposed future clock, then click to plant at speed.
    vm.runInContext(readFileSync(new URL('./interaction.js', import.meta.url), 'utf8'), f.context);
    f.advance(333); f.now();
    f.listeners.pointerdown({ composedPath: () => [] });
    const plant = f.context.headlessBridge.legalActions().find(a => a.type === 'plant');
    f.context.headlessBridge.submit(plant);
    f.advance(333); f.context.update();
    assert.notEqual(f.context.state.field[plant.y][plant.x].index, 0, 'manual planting must not be dropped');
    assert.equal(f.clock.rate, rate, 'interaction preserves selected speed');
  });
}
test('switching speeds is continuous; reload preserves offset at 1×', () => {
  const f = fixture();
  const start = f.now();
  f.clock.setRate(100); f.advance(100); assert.equal(f.now(), start + 10000);
  f.clock.setRate(1); assert.equal(f.now(), start + 10000);
  f.advance(100); assert.equal(f.now(), start + 10100);
  const reloaded = fixture(f.store); reloaded.advance(200);
  assert.equal(reloaded.now(), f.now());
  assert.equal(reloaded.clock.rate, 1);
});
test('hidden tabs stop acceleration and long stalls are capped', () => {
  const f = fixture(); const start = f.now();
  f.clock.setRate(100); f.advance(60000);
  assert.equal(f.now() - start, 60000 + 99000);
  f.context.document.hidden = true; f.listeners.visibilitychange();
  assert.equal(f.clock.rate, 1);
  const hiddenStart = f.now(); f.advance(60000);
  assert.equal(f.now() - hiddenStart, 60000);
});
test('storage failure prevents unpersisted future time', () => {
  const f = fixture(); const start = f.now(); f.clock.setRate(100);
  f.context.localStorage.setItem = () => { throw new Error('Quota'); };
  f.advance(100); assert.equal(f.now(), start + 100);
  assert.equal(f.clock.rate, 1); assert.equal(f.clock.storageOK, false);
});

test('1000× and unsupported slider values are rejected', () => {
  const f = fixture();
  for (const rate of [0, 2, 15, 101, 1000, NaN]) assert.throws(() => f.clock.setRate(rate));
});
test('interaction hold expires without accumulating accelerated time debt', () => {
  const f = fixture(); f.clock.setRate(100); f.clock.holdForInteraction();
  const start = f.now(); f.advance(900); assert.equal(f.now() - start, 900);
  f.advance(200); assert.equal(f.now() - start, 11000);
});
