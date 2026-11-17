/* Ethereal Farm — GPL-3.0-or-later; see ../LICENSE. */
(() => {
  'use strict';
  if (window.__etherealSpeed) return;
  const realNow = Date.now.bind(Date);
  const key = 'ethereal-speed:offset:v1:' + location.pathname;
  let offset = 0;
  let storageOK = true;
  try {
    const saved = localStorage.getItem(key);
    if (saved !== null) {
      offset = Number(saved);
      if (!Number.isFinite(offset) || offset < 0) throw new Error('Invalid clock offset');
    }
    localStorage.setItem(key, String(offset));
  } catch (_) {
    storageOK = false;
    if (!Number.isFinite(offset) || offset < 0) offset = 0;
  }
  let rate = 1;
  let last = realNow();
  let enabled = true;
  let interactionUntil = 0;

  function now() {
    const real = realNow();
    // Cap suspended/throttled intervals: waking a laptop must not add days at high speed.
    const elapsed = Math.min(1000, Math.max(0, real - Math.max(last, interactionUntil)));
    last = real;
    if (enabled && rate > 1 && elapsed > 0 && !document.hidden && storageOK) {
      const next = offset + elapsed * (rate - 1);
      try {
        // Persist before exposing future time to the game/autosave.
        localStorage.setItem(key, String(next));
        offset = next;
      } catch (_) {
        storageOK = false;
        rate = 1;
      }
    }
    return real + (enabled ? offset : 0);
  }

  window.__etherealSpeed = Object.freeze({
    enable() { enabled = true; last = realNow(); },
    setRate(value) {
      if (!(value === 1 || (Number.isInteger(value) && value >= 10 && value <= 100 && value % 10 === 0))) throw new RangeError('Unsupported speed');
      now();
      rate = storageOK ? value : 1;
      return rate;
    },
    holdForInteraction() {
      // Do not manufacture another accelerated interval before draining pending work.
      last = realNow();
      interactionUntil = last + 1000;
    },
    get rate() { return rate; },
    get storageOK() { return storageOK; }
  });
  Date.now = now;
  document.addEventListener('visibilitychange', () => {
    // Require a deliberate click to resume acceleration after switching tabs.
    now();
    rate = 1;
  });
})();
