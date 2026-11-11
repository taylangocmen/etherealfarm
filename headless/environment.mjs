/* Ethereal Farm — GPL-3.0-or-later; see LICENSE. */
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { createContext, Script } from 'node:vm';

export const TICK_SECONDS = 0.333;
const TICK_MS = 333;
const START_MS = Date.UTC(2026, 10, 11); // nonzero, fixed; fresh farms start in spring
const MAX_STEP_TICKS = 10811; // approximately one simulated hour per request
const SNAPSHOT_FORMAT = 'etherealfarm-first-transcension-replay-v1';
const ROOT = new URL('../', import.meta.url);
const SOURCE_FILES = [
  'game_runtime.js', 'utils.js', 'headless/presentation.js',
  'image.js', 'images.js', 'images_plants.js', 'images_fish.js',
  'images_tree.js', 'images_medals.js', 'images_td.js',
  'number.js', 'resource.js', 'strings.js', 'towerdefense.js',
  'data.js', 'state.js', 'gameplay_helpers.js', 'game.js', 'headless/bridge.js',
];
let bundle;

function sources() {
  if (!bundle) {
    const hash = createHash('sha256');
    const scripts = SOURCE_FILES.map(file => {
      const code = readFileSync(new URL(file, ROOT), 'utf8');
      hash.update(file + '\0' + code + '\0');
      return new Script(code, { filename: file });
    });
    hash.update(readFileSync(new URL('./environment.mjs', import.meta.url)));
    bundle = { scripts, fingerprint: hash.digest('hex') };
  }
  return bundle;
}

function uint32(value) {
  if (!Number.isInteger(value) || value < 0 || value > 0xffffffff) {
    throw new TypeError('seed must be an unsigned 32-bit integer');
  }
  return value;
}

function copy(value) { return JSON.parse(JSON.stringify(value)); }

/** Local, synchronous, single-worker first-transcension environment.
 * VM contexts isolate the game's globals; they are not a security boundary.
 * No browser, network, package dependency, real-time timer, or autosave is used.
 */
export class HeadlessEnvironment {
  #context;
  #seed;
  #ticks = 0;
  #maxTicks;
  #completed = false;
  #fault = null;
  #history = [];
  #events = [];
  #droppedEvents = 0;

  constructor({ seed = 1, maxEpisodeSeconds = 7 * 24 * 3600 } = {}) {
    if (!Number.isFinite(maxEpisodeSeconds) || maxEpisodeSeconds < TICK_SECONDS ||
        maxEpisodeSeconds > 7 * 24 * 3600) {
      throw new RangeError('maxEpisodeSeconds must be between 0.333 and 604800');
    }
    this.#maxTicks = Math.floor(maxEpisodeSeconds * 1000 / TICK_MS + 1e-9);
    this.reset({ seed });
  }

  get metadata() {
    return {
      task: 'fastest-first-transcension', engineFingerprint: sources().fingerprint,
      tickSeconds: TICK_SECONDS, maxEpisodeSeconds: this.#maxTicks * TICK_MS / 1000,
      holiday: false, initialSeason: 'spring',
      decisionCadence: 'at most one action per tick',
    };
  }

  reset({ seed = this.#seed } = {}) {
    uint32(seed);
    let rng = seed;
    this.#seed = seed;
    this.#ticks = 0;
    this.#completed = false;
    this.#fault = null;
    this.#history = [];
    this.#events = [];
    this.#droppedEvents = 0;
    const runtime = {
      headless: true,
      holiday: 0,
      now: () => (START_MS + this.#ticks * TICK_MS) / 1000,
      // Mulberry32 seeds the existing game RNGs and controls fern positions.
      // Fruit/fern reward generation itself still uses the original game code.
      random: () => {
        rng = (rng + 0x6d2b79f5) >>> 0;
        let t = Math.imul(rng ^ (rng >>> 15), rng | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
      },
      schedule: () => { throw new Error('Unexpected asynchronous work in headless simulation'); },
      emit: event => {
        // The adapter must never conceal an engine rejection or error.
        if (event.category === 1 || event.category === 2) {
          throw new Error(`Engine rejected action or reported an error: ${event.text}`);
        }
        if (this.#events.length < 1000) {
          this.#events.push({ ...copy(event), elapsedSeconds: this.#ticks * TICK_MS / 1000 });
        } else {
          this.#droppedEvents++;
        }
      },
    };
    this.#context = createContext({ gameRuntime: runtime }, {
      name: 'etherealfarm-headless', codeGeneration: { strings: false, wasm: false },
    });
    try {
      for (const script of sources().scripts) script.runInContext(this.#context);
      this.#context.headlessBridge.initialize();
      return this.observe();
    } catch (error) {
      this.#fault = String(error);
      throw error;
    }
  }

  #requireHealthy() {
    if (this.#fault) throw new Error(`Environment faulted; reset before continuing: ${this.#fault}`);
  }

  observe() {
    this.#requireHealthy();
    const observation = copy(this.#context.headlessBridge.observe());
    const truncated = !this.#completed && this.#ticks >= this.#maxTicks;
    return {
      ...observation, elapsedSeconds: this.#ticks * TICK_MS / 1000,
      simulationTicks: this.#ticks, truncated,
      legalActions: truncated ? [] : observation.legalActions,
    };
  }

  legalActions() {
    this.#requireHealthy();
    if (this.#completed || this.#ticks >= this.#maxTicks) return [];
    return copy(this.#context.headlessBridge.legalActions());
  }

  /** Apply one action at the start of the first tick, then advance without
   * further decisions. `ticks` must be an integer, so batching waits never
   * changes the integration grid. Stops immediately after a successful reset.
   */
  step(action = { type: 'wait' }, { ticks = 1 } = {}) {
    this.#requireHealthy();
    if (this.#completed || this.#ticks >= this.#maxTicks) throw new Error('Episode has ended; reset first');
    if (!Number.isInteger(ticks) || ticks < 1 || ticks > MAX_STEP_TICKS) {
      throw new RangeError(`ticks must be an integer from 1 to ${MAX_STEP_TICKS}`);
    }
    if (!action || typeof action !== 'object' || Array.isArray(action)) {
      throw new TypeError('action must be a plain JSON object');
    }
    // Validate before advancing time. A rejected public action leaves the
    // episode untouched; an unexpected error inside update() faults it.
    const canonical = this.legalActions().find(candidate => {
      const keys = Object.keys(candidate);
      return keys.length === Object.keys(action).length && keys.every(k => candidate[k] === action[k]);
    });
    if (!canonical) throw new Error('Action is not currently legal: ' + JSON.stringify(action));
    const before = this.#ticks;
    this.#events = [];
    this.#droppedEvents = 0;
    try {
      this.#context.headlessBridge.submit(canonical);
      const until = Math.min(this.#ticks + ticks, this.#maxTicks);
      while (this.#ticks < until && !this.#completed) {
        this.#ticks++;
        this.#completed = this.#context.headlessBridge.tick();
      }
      const executedTicks = this.#ticks - before;
      this.#history.push({ action: canonical, ticks: executedTicks });
      return {
        observation: this.observe(), reward: -executedTicks * TICK_MS / 1000,
        terminated: this.#completed, truncated: !this.#completed && this.#ticks >= this.#maxTicks,
        elapsedSeconds: executedTicks * TICK_MS / 1000,
        events: copy(this.#events), droppedEvents: this.#droppedEvents,
      };
    } catch (error) {
      this.#fault = String(error);
      throw error;
    }
  }

  /** Deterministic replay checkpoint, not a browser save. Replaying restores
   * ALL globals and random draws, including state outside the State object.
   * Deliberately slower than an eventual optimized in-memory checkpoint.
   * Seeds/history are evaluation infrastructure, not policy observations.
   */
  snapshot() {
    this.#requireHealthy();
    return copy({
      format: SNAPSHOT_FORMAT, engineFingerprint: sources().fingerprint,
      seed: this.#seed, maxTicks: this.#maxTicks, history: this.#history,
    });
  }

  restore(snapshot) {
    const s = copy(snapshot);
    if (s?.format !== SNAPSHOT_FORMAT || s.engineFingerprint !== sources().fingerprint) {
      throw new Error('Checkpoint format or engine fingerprint does not match');
    }
    uint32(s.seed);
    if (s.maxTicks !== this.#maxTicks || !Array.isArray(s.history)) {
      throw new Error('Checkpoint episode limit does not match, or history is invalid');
    }
    let total = 0;
    for (const entry of s.history) {
      if (!entry || !Number.isInteger(entry.ticks) || entry.ticks < 1 || entry.ticks > MAX_STEP_TICKS) {
        throw new Error('Invalid checkpoint step');
      }
      total += entry.ticks;
      if (total > this.#maxTicks) throw new Error('Checkpoint exceeds episode limit');
    }
    // Replay in this environment so clock/event closures continue to reference
    // this instance. If replay fails, the environment must be explicitly reset.
    this.reset({ seed: s.seed });
    try {
      for (const entry of s.history) {
        const result = this.step(entry.action, { ticks: entry.ticks });
        if (Math.round(result.elapsedSeconds * 1000 / TICK_MS) !== entry.ticks) {
          throw new Error('Checkpoint continued after episode completion');
        }
      }
      return this.observe();
    } catch (error) {
      this.#fault = String(error);
      throw error;
    }
  }
}
