/* Ethereal Farm — GPL-3.0-or-later; see LICENSE. */
import { readFileSync, writeFileSync, renameSync } from 'node:fs';
import { createHash } from 'node:crypto';

export const clone = value => JSON.parse(JSON.stringify(value));
export function atomic(file, value) {
  writeFileSync(file + '.tmp', value);
  renameSync(file + '.tmp', file);
}
export const writeJSON = (file, value) => atomic(file, JSON.stringify(value, null, 2) + '\n');
export const readJSON = file => JSON.parse(readFileSync(file, 'utf8'));
export const policyDigest = policy => createHash('sha256').update(JSON.stringify(policy)).digest('hex');
export function validateStartingPolicy(policy, engine, reference) {
  if (policy?.identity?.engine !== engine) throw new Error('Starting policy engine fingerprint does not match');
  const p = policy.parameters;
  if (!Array.isArray(p?.priorities) || p.priorities.length !== 4 ||
      !p.priorities.every(v => Number.isFinite(v) && v >= -8 && v <= 8) ||
      !Number.isFinite(p.unlockFraction) || p.unlockFraction < .05 || p.unlockFraction > 1 ||
      !Number.isFinite(p.upgradeFraction) || p.upgradeFraction < .005 || p.upgradeFraction > 1 ||
      !Array.isArray(p.layout) || p.layout.length !== 5 ||
      !p.layout.every(row => Array.isArray(row) && row.length === 5)) throw new Error('Invalid starting policy parameters');
  for (let y = 0; y < 5; y++) for (let x = 0; x < 5; x++) {
    if ((reference.layout[y][x] === null) !== (p.layout[y][x] === null)) throw new Error('Starting policy changes tree cells');
  }
  if (JSON.stringify(p.layout.flat().sort()) !== JSON.stringify(reference.layout.flat().sort())) {
    throw new Error('Starting policy changes crop-role counts');
  }
}
export function trainerFingerprint() {
  const hash = createHash('sha256');
  for (const name of ['train-parallel.mjs', 'training-worker.mjs', 'parallel-training-common.mjs', 'learned-policy.mjs']) {
    hash.update(name + '\0').update(readFileSync(new URL(name, import.meta.url)));
  }
  return hash.digest('hex');
}

// Keep the original trainer's RNG and mutation order. Scheduling never draws RNG.
export function mutate(parent, state) {
  function random() {
    state.rng = (state.rng + 0x6d2b79f5) >>> 0;
    let t = Math.imul(state.rng ^ (state.rng >>> 15), state.rng | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  const p = clone(parent);
  p.priorities = p.priorities.map(v => Math.max(-8, Math.min(8, v + (random() - .5) * 4)));
  p.unlockFraction = Math.max(.05, Math.min(1, p.unlockFraction * Math.exp((random() - .5) * 2)));
  p.upgradeFraction = Math.max(.005, Math.min(1, p.upgradeFraction * Math.exp((random() - .5) * 3)));
  const cells = p.layout.flatMap((row, y) => row.flatMap((type, x) => type ? [[x, y]] : []));
  if (random() < .75) {
    const [ax, ay] = cells[Math.floor(random() * cells.length)];
    const [bx, by] = cells[Math.floor(random() * cells.length)];
    [p.layout[ay][ax], p.layout[by][bx]] = [p.layout[by][bx], p.layout[ay][ax]];
  }
  return p;
}
