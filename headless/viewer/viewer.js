/* Ethereal Farm — GPL-3.0-or-later; see LICENSE. */
const $ = id => document.getElementById(id);
const token = document.querySelector('meta[name="viewer-token"]').content;
const icons = {berry:'🫐', mushroom:'🍄', flower:'🌼', brassica:'🌱', stinging:'🌿'};
let observation, running = false, busy = false, timer, lastFrame = 0, budget = 0;
function number(n) {
  if (!n?.b) return '0';
  const log = Math.log10(Math.abs(n.b)) + n.e * Math.LOG10E * Math.LN2;
  if (log >= 9) return `${(10 ** (log - Math.floor(log))).toFixed(2)}e${Math.floor(log)}`;
  return (n.b * 2 ** n.e).toLocaleString(undefined, {maximumFractionDigits: 2});
}
function clock(seconds) {
  const s = Math.floor(seconds);
  return `${Math.floor(s/3600)}h ${Math.floor(s/60)%60}m ${s%60}s`;
}
function text(tag, content, className) {
  const node = document.createElement(tag); node.textContent = content;
  if (className) node.className = className;
  return node;
}
function controls() {
  $('reset').disabled = busy || running;
  $('seed').disabled = busy || running;
  $('step').disabled = busy || running || !observation || observation.completed || observation.truncated;
  $('play').disabled = !observation || observation.completed || observation.truncated || (busy && !running);
  $('play').textContent = running ? 'Pause' : 'Play';
}
function pause() { running = false; clearTimeout(timer); budget = 0; controls(); }
function describe(a, crops) {
  if (a.type === 'plant' || a.type === 'replace') return `${a.type} ${crops.get(a.crop)?.name || a.crop} at (${a.x+1}, ${a.y+1})`;
  if (a.type === 'upgrade') return `buy ${observation.upgrades.find(u => u.id === a.upgrade)?.name || a.upgrade}${a.choice ? ` · choice ${a.choice}` : ''}`;
  if (a.type === 'weather') return `activate ${['sun','mist','rainbow'][a.ability]}`;
  if (a.type === 'inspect') return `read ${a.page}`;
  return a.type;
}
function render(result) {
  observation = result.observation;
  const o = observation, crops = new Map(o.crops.map(c => [c.id,c]));
  $('time').textContent = clock(o.elapsedSeconds);
  $('level').textContent = `${o.completed ? o.completionLevel : o.treeLevel} / 10`;
  $('seeds').textContent = number(o.resources.seeds);
  $('spores').textContent = `${number(o.resources.spores)} / ${number(o.treeRequirement.spores)}`;
  $('resin').textContent = number(o.completed ? o.awardedResin : o.pendingResin);
  $('season').textContent = ['Spring','Summer','Autumn','Winter'][o.season] || String(o.season);
  $('field').replaceChildren(...o.field.flat().map(cell => {
    const crop = crops.get(cell.crop), tree = cell.tile === 1 || cell.tile === 2;
    const tile = text('div', '', `cell ${crop?.type || (tree ? 'tree' : 'empty')}`);
    const fern = o.fern?.x === cell.x && o.fern?.y === cell.y;
    tile.append(text('span', fern ? '🍃' : crop ? icons[crop.type] || '🌿' : tree ? '🌳' : '·', 'icon'));
    tile.append(text('span', crop?.name || (tree ? 'Tree' : 'Empty'), 'crop-name'));
    if (crop) {
      const meter = document.createElement('progress'); meter.max = 1; meter.value = Math.max(0,Math.min(1,cell.growth));
      meter.setAttribute('aria-label', crop.type === 'brassica' ? 'Remaining life' : 'Growth'); tile.append(meter);
    }
    tile.title = `(${cell.x+1}, ${cell.y+1}) ${crop?.name || 'Terrain'}${crop ? ` · ${(cell.growth*100).toFixed(1)}%` : ''}`;
    return tile;
  }));
  $('weather').textContent = 'Weather: ' + (o.weather.filter(w => w.unlocked).map(w => `${w.name} ${w.active ? 'active' : w.selectable ? 'ready' : `${Math.ceil(w.cooldownSeconds)}s cooldown`}`).join(' · ') || 'not unlocked');
  $('fruit').textContent = `Fruit: ${o.fruits.stored.length} stored · active slot ${o.fruits.active < 0 ? 'none' : o.fruits.active+1}`;
  for (const entry of result.activity) {
    const description = describe(entry.action, crops);
    $('last').textContent = description;
    $('activity').prepend(text('li', `${clock(entry.time)} — ${description}`));
  }
  while ($('activity').children.length > 100) $('activity').lastChild.remove();
  if (o.completed || o.truncated) pause();
  $('status').textContent = o.completed ? `First transcension completed in ${clock(o.elapsedSeconds)}. Resin awarded: ${number(o.awardedResin)}.` :
    o.truncated ? 'Episode time limit reached without transcending.' : running ? `Playing · tick ${o.simulationTicks}` : `Paused · tick ${o.simulationTicks}`;
}
async function request(command, extra = {}) {
  busy = true; controls();
  try {
    const response = await fetch('/api', {method:'POST', headers:{'Content-Type':'application/json','X-Viewer-Token':token}, body:JSON.stringify({command,...extra})});
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || 'Request failed');
    render(result);
  } catch (error) { pause(); $('status').textContent = `Stopped: ${error.message}`; }
  finally { busy = false; controls(); }
}
async function frame() {
  if (!running) return;
  const now = performance.now();
  budget += Math.min(1,(now-lastFrame)/1000) * Number($('speed').value) / 0.333;
  lastFrame = now;
  const ticks = Math.min(100, Math.floor(budget));
  if (ticks && !busy) { budget -= ticks; await request('advance', {ticks}); }
  // Drop excessive backlog instead of a burst when the machine cannot keep up.
  budget = Math.min(budget, 100);
  if (running) timer = setTimeout(frame, 50);
}
$('play').addEventListener('click', () => {
  if (running) { pause(); $('status').textContent = busy ? 'Pausing after the current batch…' : 'Paused'; return; }
  running = true; budget = 0; lastFrame = performance.now(); controls(); frame();
});
$('step').addEventListener('click', () => request('advance', {ticks:1}));
$('reset').addEventListener('click', async () => {
  const seed = Number($('seed').value);
  if (!Number.isInteger(seed) || seed < 0 || seed > 4294967295) { $('status').textContent = 'Enter an unsigned 32-bit integer seed.'; return; }
  pause(); $('activity').replaceChildren(); $('last').textContent = 'Waiting for the first action.';
  await request('reset', {seed});
});
