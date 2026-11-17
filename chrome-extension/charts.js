/* Ethereal Farm — GPL-3.0-or-later; see ../LICENSE. */
(() => {
  'use strict';
  const channel = 'ethereal-run-charts-v1';
  const names = ['Resin / hour', 'Tree level', 'Twigs / hour'];
  const colors = { Sun: '#f4ce58', Mist: '#64b5ed', Rainbow: '#c795ed' };
  const duration = t => t < 60 ? Math.floor(t) + 's' : t < 3600 ? Math.floor(t / 60) + 'm' :
    Math.floor(t / 3600) + 'h ' + Math.floor(t % 3600 / 60) + 'm';
  let adapter, recorder, root, host, canvases, loaded = false, dirty = false, status = 'Loading history…';
  let scale = 'linear', selected = 'previous', hover = null, lastCapture = performance.now(), saveRevision = -1;
  let expanded = true, drawer = false, error = '', recordingOwner = true;
  const post = (type, data) => window.postMessage({ channel, type, data }, '*');

  function capture(force = false) {
    if (!recorder || !recordingOwner) return;
    try {
      const now = performance.now();
      recorder.observe(adapter.snapshot(), { force, gap: now - lastCapture > 5000 });
      lastCapture = now; dirty = true;
    } catch (e) { error = 'Recording stopped: incompatible game data'; }
  }
  function persist() {
    if (!loaded || !recorder || !recordingOwner || recorder.revision === saveRevision) return;
    saveRevision = recorder.revision;
    post('save', recorder.serialize());
  }
  function attach(saved) {
    if (recorder) return;
    recorder = new EtherealRunRecorder(saved);
    capture(true);
    const original = window[adapter.update];
    window[adapter.update] = function(...args) {
      // Preserve the last observed point before a possible transcendence.
      capture();
      const result = original.apply(this, args);
      capture();
      return result;
    };
    const message = window[adapter.message];
    window[adapter.message] = function(...args) {
      const result = message.apply(this, args);
      const match = typeof args[0] === 'string' && /^(sun|mist|rainbow) activated\b/.exec(args[0]);
      if (match && recordingOwner) {
        try { recorder.event(adapter.snapshot(), match[1][0].toUpperCase() + match[1].slice(1)); dirty = true; }
        catch (_) { error = 'Could not record a power activation'; }
      }
      return result;
    };
    dirty = true;
  }
  window.addEventListener('message', event => {
    if (event.source !== window || event.data?.channel !== channel) return;
    if (event.data.type === 'loaded' && adapter && !loaded) {
      loaded = true; status = 'Recording'; attach(event.data.data);
    } else if (event.data.type === 'error') {
      status = 'History storage unavailable — recording in memory';
      if (adapter) attach(null);
      loaded = false;
    } else if (event.data.type === 'saved') status = 'Recording · saved locally';
  });

  function layout() {
    if (!host) return;
    let edge = innerWidth;
    try { if (adapter) edge = Math.max(adapter.edge(), document.getElementById('ethereal-speed-controls')?.getBoundingClientRect().right || 0) + 12; } catch (_) {}
    const space = innerWidth - edge - 12;
    drawer = space < 340;
    host.style.left = drawer ? 'auto' : edge + 'px';
    host.style.right = '12px';
    host.style.width = drawer ? 'min(560px, calc(100vw - 24px))' : 'auto';
    root.querySelector('#panel').style.height = Math.max(0, innerHeight - 20) + 'px';
    root.querySelector('#panel').hidden = !expanded || drawer && !host.dataset.drawerOpen;
    root.querySelector('#open').hidden = expanded && !drawer || !!host.dataset.drawerOpen;
    root.querySelector('#open').textContent = drawer ? 'Run charts ↗' : 'Show run charts';
  }
  function comparison() {
    if (!recorder) return null;
    return selected === 'none' ? null : selected === 'previous' ? recorder.runs.at(-2) : recorder.runs.find(r => r.id === selected);
  }
  function render() {
    if (!root) return;
    layout();
    root.querySelector('#status').textContent = error || (!recordingOwner ? 'Another tab is recording' : status);
    if (!recorder || !dirty || root.querySelector('#panel').hidden) return;
    dirty = false;
    const current = recorder.current, previous = comparison();
    const select = root.querySelector('#compare');
    const options = [['previous', 'Previous run'], ['none', 'Current only'], ...recorder.runs.slice(0, -1).reverse().map(r => [r.id, `Run ${r.label} · ${duration(r.samples.at(-1)?.t || 0)}${r.challenge ? ' · challenge ' + r.challenge : ''}`])];
    const signature = options.map(o => o[0]).join('|');
    if (select.dataset.signature !== signature) {
      select.replaceChildren(...options.map(([value, text]) => { const o = document.createElement('option'); o.value = value; o.textContent = text; return o; }));
      select.dataset.signature = signature; select.value = selected;
    }
    root.querySelector('#current').textContent = `Current run ${current.label}${current.challenge ? ' · challenge ' + current.challenge : ''}`;
    root.querySelector('#note').textContent = `Elapsed game time · ${duration(current.samples.at(-1)?.t || 0)}. ` +
      (previous ? `Comparing run ${previous.label}. ` : 'No earlier recorded run selected. ') +
      `Recording begins at ${duration(current.samples[0]?.t || 0)}. Gaps are unobserved time.` +
      (current.thinned ? ' Older samples thinned.' : '') + (current.eventsTruncated ? ' Oldest power markers trimmed.' : '');
    canvases.forEach((canvas, i) => draw(canvas, i, current, previous));

  }

  function draw(canvas, metric, current, previous) {
    const width = Math.max(300, canvas.getBoundingClientRect().width);
    const height = Math.max(72, canvas.getBoundingClientRect().height);
    const dpr = devicePixelRatio || 1;
    canvas.width = width * dpr; canvas.height = height * dpr;
    const c = canvas.getContext('2d'); c.scale(dpr, dpr);
    const left = 53, top = 9, right = width - 12, bottom = height - 23;
    const all = [...current.samples, ...(previous?.samples || [])];
    const maxT = Math.max(60, ...all.map(p => p.t));
    const nonzero = all.filter(p => p.values[metric].b !== 0);
    const exponent = nonzero.length ? Math.max(...nonzero.map(p => p.values[metric].e)) : 0;
    const transform = n => {
      if (!n.b) return 0;
      if (scale === 'log' && metric !== 1) {
        const l = Math.log10(Math.abs(n.b)) + n.e * Math.LOG10E * Math.LN2;
        return Math.sign(n.b) * (l > 15 ? l : Math.log10(1 + 10 ** l));
      }
      return n.b * 2 ** (n.e - exponent);
    };
    const values = all.map(p => transform(p.values[metric]));
    const min = Math.min(0, ...values), max = (Math.max(...values) === min ? min + 1 : Math.max(...values));
    const x = t => left + t / maxT * (right - left), y = v => bottom - (v - min) / (max - min) * (bottom - top);
    const axis = v => {
      if (!v) return '0';
      if (scale === 'log' && metric !== 1) return (v < 0 ? '−' : '') + (Math.abs(v) > 4 ? `10^${Math.abs(v).toFixed(1)}` : (10 ** Math.abs(v) - 1).toPrecision(2));
      const log = Math.log10(Math.abs(v)) + exponent * Math.LOG10E * Math.LN2;
      return log > 5 || log < -2 ? `${v < 0 ? '−' : ''}${(10 ** (log - Math.floor(log))).toFixed(1)}e${Math.floor(log)}` : (v * 2 ** exponent).toLocaleString(undefined, { maximumFractionDigits: 2 });
    };
    c.font = '10px system-ui'; c.lineWidth = 1;
    for (let i = 0; i <= 3; i++) {
      const v = metric === 1 ? i * Math.max(1, Math.ceil((max - min) / 3)) : min + (max - min) * i / 3;
      if (v > max) continue;
      const yy = y(v);
      c.strokeStyle = '#354653'; c.beginPath(); c.moveTo(left, yy); c.lineTo(right, yy); c.stroke();
      c.fillStyle = '#b3c3ce'; c.textAlign = 'right'; c.fillText(axis(v), left - 5, yy + 3);
    }
    for (let i = 0; i <= 4; i++) {
      c.textAlign = i === 0 ? 'left' : i === 4 ? 'right' : 'center';
      c.fillText(duration(maxT * i / 4), x(maxT * i / 4), height - 6);
    }
    for (const [run, faint] of [[previous, true], [current, false]]) {
      if (!run) continue;
      for (const e of run.events) {
        c.lineWidth = 1; c.globalAlpha = faint ? 0.35 : 0.75; c.strokeStyle = colors[e.name] || '#777'; c.setLineDash([]);
        c.beginPath(); c.moveTo(x(e.t), top); c.lineTo(x(e.t), bottom); c.stroke();
      }
      c.globalAlpha = 1; c.setLineDash(faint ? [5, 4] : []); c.strokeStyle = faint ? '#8fb9db' : '#8cdb9c'; c.lineWidth = 1.8;
      c.beginPath(); let last;
      for (const point of run.samples) {
        const xx = x(point.t), yy = y(transform(point.values[metric]));
        if (!last || point.gap) c.moveTo(xx, yy);
        else { if (metric === 1) c.lineTo(xx, y(transform(last.values[metric]))); c.lineTo(xx, yy); }
        last = point;
      }
      c.stroke();
      if (run.samples.length === 1) { c.beginPath(); c.arc(x(last.t), y(transform(last.values[metric])), 2.5, 0, Math.PI * 2); c.fillStyle = c.strokeStyle; c.fill(); }
    }
    c.setLineDash([]);
    if (hover !== null) {
      const target = hover * maxT;
      c.strokeStyle = '#93a8b8'; c.lineWidth = 1; c.beginPath(); c.moveTo(x(target), top); c.lineTo(x(target), bottom); c.stroke();
      const closest = run => run?.samples.reduce((best, p) => !best || Math.abs(p.t - target) < Math.abs(best.t - target) ? p : best, null);
      const a = closest(current), b = closest(previous);
      root.querySelectorAll('.readout')[metric].textContent =
        (a ? `${duration(a.t)} · ${a.values[metric].text}` : '') + (b ? ` | Previous ${duration(b.t)} · ${b.values[metric].text}` : '');
    } else root.querySelectorAll('.readout')[metric].textContent = current.samples.at(-1)?.values[metric].text || '—';
  }

  let attempts = 0;
  function mount() {
    if (!/ethereal farm/i.test(document.title)) return;
    adapter = window.__etherealData.adapter();
    if (!adapter && attempts++ < 40) { setTimeout(mount, 250); return; }
    host = document.createElement('div'); host.id = 'ethereal-run-charts';
    host.style.cssText = 'position:fixed;top:10px;right:12px;z-index:9;font:12px system-ui';
    root = host.attachShadow({ mode: 'open' });
    root.innerHTML = `<style>
      :host{color-scheme:dark}*{box-sizing:border-box}button,select{font:inherit;color:#e2eaf0;background:#304351;border:1px solid #526b7b;border-radius:5px;padding:5px 8px;cursor:pointer}button:focus-visible,select:focus-visible,canvas:focus-visible{outline:2px solid #8cdb9c}
      #panel{background:#243440;border:1px solid #4a6272;border-radius:9px;padding:12px;color:#e2eaf0;height:calc(100vh - 20px);overflow:auto;display:flex;flex-direction:column}
      header,.toolbar,.legend{flex-shrink:0;display:flex;align-items:center;gap:8px;justify-content:space-between}h2{font-size:18px;margin:0}#status{font-size:10px;color:#a3c5ad;margin:5px 0 9px}.toolbar{flex-wrap:wrap}.legend{justify-content:flex-start;font-size:11px;margin:8px 0}.now{color:#8cdb9c}.prior{color:#8fb9db}#events{font-size:10px;margin:8px 0;line-height:1.5;color:#b3c3ce}
      article{flex:1 1 0;min-height:130px;display:flex;flex-direction:column;border:1px solid #405666;border-radius:6px;margin:6px 0;padding:7px 6px 0;background:#1c2a35}h3{font-size:12px;margin:0 0 2px 5px}.readout{font-size:10px;color:#b3c3ce;min-height:14px;margin-left:5px}canvas{display:block;width:100%;height:0;min-height:72px;flex:1 1 0}#note{flex-shrink:0;font-size:10px;line-height:1.5;color:#a8bac8;margin:9px 0 0}[hidden]{display:none!important}
    </style><button id="open" hidden>Run charts ↗</button><section id="panel" aria-label="Run analytics">
    <header><h2>Run analytics</h2><button id="close" aria-label="Collapse run charts">−</button></header><div id="status" role="status"></div>
    <div class="toolbar"><span id="current">Current run</span><label>Compare <select id="compare"><option value="previous">Previous run</option></select></label><label>Scale <select id="scale"><option value="linear">Linear</option><option value="log">Log (signed)</option></select></label></div>
    <div class="legend"><span class="now">━ Current</span><span class="prior">┄ Previous / selected</span></div>
    ${names.map(n => `<article><h3>${n}</h3><div class="readout"></div><canvas role="img" aria-label="${n} versus elapsed game time"></canvas></article>`).join('')}
    <p id="note"></p></section>`;
    document.body.appendChild(host);
    canvases = [...root.querySelectorAll('canvas')];
    canvases.forEach(canvas => {
      canvas.addEventListener('pointermove', e => { hover = Math.max(0, Math.min(1, (e.offsetX - 53) / (canvas.clientWidth - 65))); dirty = true; render(); });
      canvas.addEventListener('pointerleave', () => { hover = null; dirty = true; render(); });
    });
    root.querySelector('#compare').addEventListener('change', e => { selected = e.target.value; dirty = true; render(); });
    root.querySelector('#scale').addEventListener('change', e => { scale = e.target.value; dirty = true; render(); });
    root.querySelector('#close').addEventListener('click', () => { expanded = false; delete host.dataset.drawerOpen; layout(); });
    root.querySelector('#open').addEventListener('click', () => { expanded = true; host.dataset.drawerOpen = 'yes'; dirty = true; render(); });
    window.addEventListener('resize', () => { dirty = true; render(); });
    document.addEventListener('visibilitychange', persist); window.addEventListener('pagehide', persist);
    if (!adapter) { error = 'Unsupported game version — no data recorded'; render(); return; }
    const start = () => { post('load'); setTimeout(() => { if (!recorder) { status = 'History unavailable — recording in memory'; attach(null); } }, 3000); };
    if (navigator.locks) navigator.locks.request('ethereal-run-charts:' + location.pathname, { ifAvailable: true }, lock => {
      if (!lock) { recordingOwner = false; status = 'Another tab is recording'; render(); return; }
      start(); return new Promise(() => {});
    }); else start();
    setInterval(() => { capture(); render(); }, 1000);
    setInterval(persist, 5000);
    render();
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount, { once: true }); else mount();
})();
