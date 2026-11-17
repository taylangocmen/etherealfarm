/* Ethereal Farm — GPL-3.0-or-later; see ../LICENSE. */
(() => {
  'use strict';
  class RunRecorder {
    constructor(saved) {
      this.runs = saved?.version === 1 && Array.isArray(saved.runs) ? saved.runs.filter(r => r && typeof r.id === 'string' && typeof r.key === 'string' &&
        Number.isFinite(r.label) && Array.isArray(r.events) && r.events.length <= 1000 &&
        r.events.every(e => Number.isFinite(e.t) && ['Sun', 'Mist', 'Rainbow'].includes(e.name)) &&
        Array.isArray(r.samples) && r.samples.length > 0 && r.samples.length <= 1200 &&
        r.samples.every(p => Number.isFinite(p.t) && p.t >= 0 && Array.isArray(p.values) && p.values.length === 5 &&
          p.values.every(n => n && Number.isFinite(n.b) && Number.isFinite(n.e) && typeof n.text === 'string')))
        .slice(-10) : [];
      this.resuming = true;
      this.revision = 0;
    }
    get current() { return this.runs.at(-1); }
    observe(snapshot, options = {}) {
      if (!Number.isFinite(snapshot.t) || snapshot.t < 0 || snapshot.values.length !== 5) return;
      let run = this.current;
      const last = run?.samples.at(-1);
      if (!run || run.key !== snapshot.key || (last && snapshot.t < last.t - 0.01)) {
        const reason = !run ? 'Recording started' : run.key !== snapshot.key ? 'New run / loaded save' : 'Timeline restarted (undo or import)';
        run = { id: crypto.randomUUID(), key: snapshot.key, challenge: snapshot.challenge,
          label: this.runs.length ? (this.current.label || 1) + 1 : 1,
          reason, samples: [], events: [], thinned: false };
        this.runs.push(run);
        this.runs = this.runs.slice(-10);
      }
      const previous = run.samples.at(-1);
      const gap = !!previous && (this.resuming || options.gap);
      this.resuming = false;
      const valuesChanged = previous && snapshot.values.some((n, i) => n.b !== previous.values[i].b || n.e !== previous.values[i].e);
      const point = { t: snapshot.t, values: snapshot.values, gap };
      if (previous && snapshot.t === previous.t) {
        point.gap ||= previous.gap;
        run.samples[run.samples.length - 1] = point;
      } else if (!previous || options.force || gap || valuesChanged || snapshot.t - previous.t >= 1) {
        run.samples.push(point);
      } else return;
      if (run.samples.length > 1200) {
        // Thin old history, preserving endpoints and discontinuities. Never synthesize values.
        const kept = [];
        let crossedGap = false;
        run.samples.forEach((p, i, all) => {
          crossedGap ||= p.gap;
          if (i % 2 === 0 || i === all.length - 1) {
            kept.push({ ...p, gap: crossedGap }); crossedGap = false;
          }
        });
        run.samples = kept;
        run.thinned = true;
      }
      this.revision++;
    }
    event(snapshot, name) {
      this.observe(snapshot, { force: true });
      const run = this.current;
      if (!run) return;
      // update() advances runtime before actions, but their timestamp is state.time.
      const t = Math.max(0, snapshot.t - Math.max(0, snapshot.prev - snapshot.time));
      const last = run.events.at(-1);
      if (!last || last.t !== t || last.name !== name) {
        run.events.push({ t, name });
        if (run.events.length > 1000) { run.events.shift(); run.eventsTruncated = true; }
        this.revision++;
      }
    }
    serialize() { return { version: 1, runs: this.runs }; }
  }
  globalThis.EtherealRunRecorder = RunRecorder;
})();
