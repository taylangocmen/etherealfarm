/* Ethereal Farm — GPL-3.0-or-later; see ../LICENSE. */
(() => {
  'use strict';
  // The published build renames globals. Fail closed on an unverified version,
  // rather than invoking an unrelated function after a future minifier change.
  function updater() {
    if (window.gameRuntime && window.state && typeof window.update === 'function') {
      return window.update;
    }
    if (document.title === 'Ethereal Farm v0.18.5' && window.E && typeof window.An === 'function') {
      return window.An;
    }
    return null;
  }
  window.__etherealInteraction = Object.freeze({ available: () => !!updater() });
  function beforeInteraction(event) {
    if (event.type === 'keydown' && [',', '.', '<', '>'].includes(event.key)) return;
    if (event.composedPath().some(node => node.id === 'ethereal-speed-controls' || node.id === 'ethereal-run-charts')) return;
    const clock = window.__etherealSpeed;
    if (clock.rate === 1) return;
    const update = updater();
    if (!update) { clock.setRate(1); return; }
    clock.holdForInteraction();
    // Run before the game's listener queues an action: its catch-up path drops
    // human actions whenever the elapsed interval exceeds two game seconds.
    // Two passes also handle the engine's bounded catch-up loop in typical farms.
    update();
    update();
  }
  for (const type of ['pointerdown', 'mousedown', 'click', 'keydown']) {
    window.addEventListener(type, beforeInteraction, { capture: true });
  }
})();
