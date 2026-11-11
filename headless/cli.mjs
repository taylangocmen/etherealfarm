/* Ethereal Farm — GPL-3.0-or-later; see LICENSE. */
import { createInterface } from 'node:readline';
import { HeadlessEnvironment } from './environment.mjs';

// One JSON request per line on stdin; one JSON response per line on stdout.
// This is an API transport, not a gameplay policy or training process.
const argv = process.argv.slice(2);
if (argv.length) {
  if (argv.length === 1 && argv[0] === '--help') {
    process.stdout.write('Usage: node headless/cli.mjs\nCommands: reset, observe, legalActions, step, snapshot, restore\n');
  } else {
    process.stderr.write('Usage: node headless/cli.mjs (JSON lines on stdin)\n');
    process.exitCode = 1;
  }
} else {
  let env;
  const input = createInterface({ input: process.stdin, crlfDelay: Infinity, terminal: false });
  for await (const line of input) {
    if (!line.trim()) continue;
    let request;
    try {
      request = JSON.parse(line);
      if (!request || typeof request !== 'object') throw new Error('Expected a JSON command object');
      let result;
      if (request.command === 'reset') {
        env = new HeadlessEnvironment({ seed: request.seed ?? 1,
          maxEpisodeSeconds: request.maxEpisodeSeconds ?? 7 * 24 * 3600 });
        result = { metadata: env.metadata, observation: env.observe() };
      } else {
        if (!env) throw new Error('Send reset before other commands');
        switch (request.command) {
          case 'observe': result = env.observe(); break;
          case 'legalActions': result = env.legalActions(); break;
          case 'step': result = env.step(request.action, { ticks: request.ticks ?? 1 }); break;
          case 'snapshot': result = env.snapshot(); break;
          case 'restore': result = env.restore(request.snapshot); break;
          default: throw new Error('Unknown command: ' + request.command);
        }
      }
      process.stdout.write(JSON.stringify({ id: request.id ?? null, ok: true, result }) + '\n');
    } catch (error) {
      process.stdout.write(JSON.stringify({ id: request?.id ?? null, ok: false, error: String(error.message || error) }) + '\n');
    }
  }
}
