/* Ethereal Farm — GPL-3.0-or-later; see ../LICENSE. */
(() => {
  'use strict';
  const pack = n => {
    if (typeof n === 'number') return { b: n, e: 0, text: String(n) };
    if (!n || !Number.isFinite(n.b) || !Number.isFinite(n.e)) throw Error('Invalid game number');
    return { b: n.b, e: n.e, text: n.toString() };
  };
  function adapter() {
    if (window.gameRuntime && window.state && typeof window.getResinHour === 'function') {
      return { state: () => window.state, update: 'update', message: 'showMessage',
        snapshot() {
          const s = window.state;
          return { key: `${s.c_starttime}:${s.challenge}`, t: s.c_runtime, time: s.time, prev: s.prevtime,
            paused: s.paused, challenge: s.challenge, start: s.c_starttime,
            values: [pack(getResinHour()), pack(s.treelevel), pack(getTwigsHour()), pack(gain.seeds), pack(gain.spores)] };
        }, speedBounds() { return rightFlex.div.getBoundingClientRect(); }, edge() { return Math.max(gameFlex.div.getBoundingClientRect().right,
          showingSidePanel ? rightFlex.div.getBoundingClientRect().right : 0); } };
    }
    if (document.title === 'Ethereal Farm v0.18.5' && window.E &&
        typeof window.JL === 'function' && typeof window.KL === 'function' && window.xC) {
      return { state: () => window.E, update: 'An', message: 'V',
        snapshot() {
          const s = window.E;
          return { key: `${s.Ld}:${s.challenge}`, t: s.ja, time: s.time, prev: s.Aa,
            paused: s.paused, challenge: s.challenge, start: s.Ld,
            values: [pack(JL()), pack(s.D), pack(KL()), pack(xC.j), pack(xC.F)] };
        }, speedBounds() { return jY.div.getBoundingClientRect(); }, edge() { return Math.max(Xb.div.getBoundingClientRect().right,
          getComputedStyle(jY.div).visibility !== 'hidden' ? jY.div.getBoundingClientRect().right : 0); } };
    }
    return null;
  }
  window.__etherealData = { adapter, pack };
})();
