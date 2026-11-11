/* Ethereal Farm — GPL-3.0-or-later; see LICENSE. */
import { HeadlessEnvironment } from './environment.mjs';
import { advancePlayer } from './scripted-player.mjs';

// Optional standalone runner; no server or viewer dependency.
const [seedArg = '1', secondsArg = '86400', ...extra] = process.argv.slice(2);
if (extra.length) throw new Error('Usage: node headless/play.mjs [seed] [max-game-seconds]');
const env = new HeadlessEnvironment({seed: Number(seedArg), maxEpisodeSeconds: Number(secondsArg)});
let previousLevel = -1;
let o = env.observe();
while (!o.completed && !o.truncated) {
  const result = advancePlayer(env, 100);
  o = result.observation;
  if (o.treeLevel !== previousLevel || o.completed || o.truncated) {
    process.stdout.write(JSON.stringify({elapsedSeconds:o.elapsedSeconds, treeLevel:o.treeLevel,
      completionLevel:o.completionLevel, completed:o.completed, truncated:o.truncated}) + '\n');
    previousLevel = o.treeLevel;
  }
}
process.exitCode = o.completed ? 0 : 2;
