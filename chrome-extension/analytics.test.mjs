import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { webcrypto } from 'node:crypto';
const context = vm.createContext({ crypto: webcrypto });
vm.runInContext(readFileSync(new URL('./run-recorder.js', import.meta.url), 'utf8'), context);
const Recorder = context.EtherealRunRecorder;
const snapshot = (t, key = 'run1', value = t) => ({ key, t, time: 1000 + t, prev: 1000 + t, challenge: 0,
  values: Array.from({ length: 5 }, () => ({ b: value, e: 0, text: String(value) })) });

test('current and previous runs retain exact samples independently', () => {
  const r = new Recorder(); r.observe(snapshot(10)); r.observe(snapshot(20)); r.observe(snapshot(0, 'run2'));
  assert.equal(r.runs.length, 2); assert.equal(r.runs[0].samples[1].values[0].b, 20);
  assert.equal(r.current.samples[0].t, 0);
});
test('reload continues the run with a gap; undo branches the timeline', () => {
  const r = new Recorder(); r.observe(snapshot(10)); r.observe(snapshot(20));
  const restored = new Recorder(JSON.parse(JSON.stringify(r.serialize())));
  restored.observe(snapshot(100));
  assert.equal(restored.runs.length, 1); assert.equal(restored.current.samples.at(-1).gap, true);
  restored.observe(snapshot(15)); assert.equal(restored.runs.length, 2);
  assert.match(restored.current.reason, /undo/);
});
test('successful power event timestamps use the action time, not tick end', () => {
  const r = new Recorder(); const s = snapshot(130); s.time = 1100; s.prev = 1130;
  r.event(s, 'Sun'); r.event(s, 'Sun');
  assert.equal(r.current.events.length, 1); assert.equal(r.current.events[0].t, 100);
});
test('history is bounded and large numbers survive serialization without overflow', () => {
  const r = new Recorder();
  for (let t = 0; t < 3000; t++) { const s = snapshot(t); s.values[0] = { b: 1.2345, e: 100000, text: 'huge' }; r.observe(s); }
  assert.ok(r.current.samples.length <= 1200); assert.equal(r.current.samples[0].t, 0);
  assert.equal(r.current.samples.at(-1).t, 2999);
  assert.equal(JSON.parse(JSON.stringify(r.serialize())).runs[0].samples[0].values[0].e, 100000);
  for (let i = 0; i < 20; i++) r.observe(snapshot(0, 'new' + i));
  assert.equal(r.runs.length, 10);
});
test('unknown live builds do not expose a guessed adapter', () => {
  const c = vm.createContext({ document: { title: 'Ethereal Farm v99' } }); c.window = c;
  vm.runInContext(readFileSync(new URL('./game-data.js', import.meta.url), 'utf8'), c);
  assert.equal(c.__etherealData.adapter(), null);
});
test('production changes within one second are captured before pausing', () => {
  const r = new Recorder(); r.observe(snapshot(10, 'run1', 0)); r.observe(snapshot(10.3, 'run1', 1));
  assert.equal(r.current.samples.at(-1).values[3].b, 1);
});
