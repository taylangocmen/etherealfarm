/* Ethereal Farm — GPL-3.0-or-later; see LICENSE. */
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { HeadlessEnvironment } from './environment.mjs';
import { advancePlayer } from './scripted-player.mjs';

const port = Number(process.env.PORT || 8787);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid PORT');
const origin = `http://127.0.0.1:${port}`;
const token = randomBytes(24).toString('hex');
const files = new Map([
  ['/', ['text/html; charset=utf-8', readFileSync(new URL('./viewer/index.html', import.meta.url), 'utf8').replace('__TOKEN__', token)]],
  ['/viewer.js', ['text/javascript; charset=utf-8', readFileSync(new URL('./viewer/viewer.js', import.meta.url))]],
  ['/style.css', ['text/css; charset=utf-8', readFileSync(new URL('./viewer/style.css', import.meta.url))]],
]);
let env; // Lazy initialization; loading the viewer does not start a run.
const server = createServer(async (req, res) => {
  const reply = (status, value) => {
    res.writeHead(status, {'Content-Type': 'application/json', 'Cache-Control': 'no-store'});
    res.end(JSON.stringify(value));
  };
  if (req.headers.host !== `127.0.0.1:${port}`) return reply(403, {error: 'Use the loopback URL'});
  if (req.method === 'GET' && files.has(req.url)) {
    const [type, body] = files.get(req.url);
    res.writeHead(200, {'Content-Type': type, 'Cache-Control': 'no-store',
      'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; frame-ancestors 'none'"});
    return res.end(body);
  }
  if (req.method !== 'POST' || req.url !== '/api') return reply(404, {error: 'Not found'});
  if (req.headers.origin !== origin || req.headers['x-viewer-token'] !== token) return reply(403, {error: 'Invalid viewer request'});
  try {
    let body = '';
    for await (const chunk of req) {
      body += chunk;
      if (body.length > 4096) return reply(413, {error: 'Request too large'});
    }
    const request = JSON.parse(body);
    if (request.command === 'reset') {
      const next = new HeadlessEnvironment({seed: request.seed ?? 1});
      env = next;
      return reply(200, {observation: env.observe(), activity: []});
    }
    if (!env) throw new Error('Create a farm first');
    if (request.command === 'advance') return reply(200, advancePlayer(env, request.ticks));
    if (request.command === 'observe') return reply(200, {observation: env.observe(), activity: []});
    throw new Error('Unknown command');
  } catch (error) { reply(400, {error: error.message}); }
});
server.listen(port, '127.0.0.1', () => console.log(`Ethereal Farm viewer: ${origin}\nPress Ctrl+C to stop. Simulation advances only on viewer requests.`));
