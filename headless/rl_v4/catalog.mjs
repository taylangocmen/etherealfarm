/* Ethereal Farm — GPL-3.0-or-later; see LICENSE. */
// Static public content definitions only. No RNG or future game state is sent
// to the policy. Keep the simulator and its historical fingerprints unchanged.
import { readFileSync } from 'node:fs';
import { createContext, Script } from 'node:vm';
import { HeadlessEnvironment } from './simulator.mjs';

const root = new URL('../../', import.meta.url);
const files = [
  'game_runtime.js', 'utils.js', 'headless/presentation.js',
  'image.js', 'images.js', 'images_plants.js', 'images_fish.js',
  'images_tree.js', 'images_medals.js', 'images_td.js',
  'number.js', 'resource.js', 'strings.js', 'towerdefense.js',
  'data.js', 'state.js', 'gameplay_helpers.js', 'game.js', 'headless/bridge.js',
];
const env = new HeadlessEnvironment();
const context = createContext({ gameRuntime: {
  headless: true, holiday: 0, now: () => Date.UTC(2026, 10, 11) / 1000,
  random: () => .5, schedule: () => { throw new Error('Unexpected timer'); }, emit: () => {},
} });
for (const file of files) new Script(readFileSync(new URL(file, root), 'utf8'), { filename: file }).runInContext(context);
const catalog = new Script(`JSON.stringify({
  crops: registered_crops.filter(id => crops[id].isReal() && !crops[id].quad).map(id => ({
    id, name: crops[id].name, type: getCropTypeName(crops[id].type), tier: crops[id].tier
  })),
  upgrades: registered_upgrades.map(id => ({id, name: upgrades[id].name, choice: !!upgrades[id].is_choice})),
  achievements: registered_medals.slice()
})`).runInContext(context);
console.log(JSON.stringify({ format: 'etherealfarm-rl-catalog-v1', engine: env.metadata.engineFingerprint, ...JSON.parse(catalog) }));
