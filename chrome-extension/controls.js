/* Ethereal Farm — GPL-3.0-or-later; see ../LICENSE. */
(() => {
  'use strict';
  function mount() {
    if (!/ethereal farm/i.test(document.title) || document.getElementById('ethereal-speed-controls')) return;
    const clock = window.__etherealSpeed;
    clock.enable();
    const assist = window.__etherealInteraction;
    const host = document.createElement('div');
    host.id = 'ethereal-speed-controls';
    host.style.cssText = 'position:fixed;top:8px;right:12px;z-index:2147483647';
    const root = host.attachShadow({ mode: 'open' });
    root.innerHTML = `
      <style>
        :host { color-scheme:dark; }
        section { width:100%;box-sizing:border-box;padding:6px 8px;border:1px solid #52654b;
          border-radius:7px;background:#17261ef5;color:#f0f4e9;box-shadow:0 5px 24px #0006;
          font:13px/1.5 system-ui,sans-serif; }
        header { display:flex;align-items:center;justify-content:space-between;gap:6px;min-height:24px; }
        strong { font-size:12px;white-space:nowrap; }
        output { min-width:32px;text-align:right;font-variant-numeric:tabular-nums; }
        label { display:flex;justify-content:space-between; }
        input[type=range] { min-width:50px;width:100%;flex:1;margin:0;accent-color:#d3e9a5;cursor:pointer; }
        .ends { display:flex;justify-content:space-between;color:#bac8b4;font-size:11px; }
        button { cursor:pointer;border:1px solid #62745a;border-radius:7px;background:#28392d;
          color:inherit;padding:7px 9px;font:inherit; }
        button[aria-pressed=true] { background:#d3e9a5;color:#17261e;border-color:#d3e9a5; }
        button:focus-visible { outline:2px solid #fff;outline-offset:2px; }
        #collapse { padding:0 7px; }
        p { margin:9px 0 0;color:#bac8b4;font-size:11px; }
        [hidden] { display:none; }
      </style>
      <section aria-label="Ethereal Farm speed controls">
        <header><strong>🌱 Speed</strong>
          <input id="speed" aria-label="Game speed" type="range" min="0" max="10" step="1" value="0" aria-valuetext="1×">
          <output id="value" for="speed">1×</output>
          <button id="collapse" aria-label="Expand speed details" aria-expanded="false">+</button></header>
        <div id="body" hidden>
          <p>, / &lt; slower · . / &gt; faster</p>
          <p id="status" role="status" aria-live="polite"></p>
          <p>Export a backup first. Speed changes affect your saved farm. Keep this extension enabled for accelerated saves.</p>
        </div>
      </section>`;
    const slider = root.querySelector('#speed');
    slider.addEventListener('input', () => {
      const position = Number(slider.value);
      clock.setRate(position === 0 ? 1 : position * 10);
      render();
    });
    function position() {
      let bounds;
      try { bounds = window.__etherealData?.adapter()?.speedBounds(); } catch (_) {}
      const width = bounds ? Math.min(bounds.width - 8, innerWidth - 24) : 250;
      const left = bounds && width >= 200 ? Math.min(bounds.left + 4, innerWidth - width - 12) : innerWidth - 262;
      host.style.left = Math.max(12, left) + 'px';
      host.style.right = 'auto';
      host.style.width = Math.max(200, Math.min(width, innerWidth - 24)) + 'px';
    }
    window.addEventListener('resize', position);
    function render() {
      position();
      slider.value = String(clock.rate === 1 ? 0 : clock.rate / 10);
      slider.disabled = !clock.storageOK || !assist.available();
      slider.setAttribute('aria-valuetext', clock.rate + '×');
      root.querySelector('#value').textContent = clock.rate + '×';
      root.querySelector('#status').textContent = !clock.storageOK
        ? 'Storage unavailable. Acceleration disabled.'
        : !assist.available() ? 'Unsupported game version · acceleration disabled'
        : clock.rate === 1 ? 'Normal speed · choose a boost'
        : clock.rate + '× active · switching tabs returns to 1×';
    }
    root.querySelector('#collapse').addEventListener('click', event => {
      const body = root.querySelector('#body');
      body.hidden = !body.hidden;
      event.currentTarget.textContent = body.hidden ? '+' : '−';
      event.currentTarget.setAttribute('aria-expanded', String(!body.hidden));
      event.currentTarget.setAttribute('aria-label', body.hidden ? 'Expand speed details' : 'Collapse speed details');
    });
    window.addEventListener('keydown', event => {
      if (event.ctrlKey || event.altKey || event.metaKey || !assist.available()) return;
      if (event.composedPath().some(node => node.isContentEditable ||
          ['INPUT', 'TEXTAREA', 'SELECT'].includes(node.tagName) ||
          node.getAttribute?.('role') === 'textbox')) return;
      const direction = [',', '<'].includes(event.key) ? -1 : ['.', '>'].includes(event.key) ? 1 : 0;
      if (!direction) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      const position = Math.max(0, Math.min(10, (clock.rate === 1 ? 0 : clock.rate / 10) + direction));
      clock.setRate(position === 0 ? 1 : position * 10);
      render();
    }, { capture: true });
    document.addEventListener('visibilitychange', render);
    setInterval(render, 1000);
    document.body.appendChild(host);
    render();
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount, { once: true });
  else mount();
})();
