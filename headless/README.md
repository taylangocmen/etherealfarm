# Local first-transcension environment

For setup on another machine, unattended execution, migration, and current
limitations, start with the [handoff guide](HANDOFF.md).

This is the initial headless extraction for **fastest first transcension from a
fresh save**. It uses the fork's original crop formulas, adjacency allocation,
growth, unlocks, achievements, fruit generation, weather, and transcend action.
The core environment needs no LLM, browser, server, network connection, or
package installation. The optional local trainer is described below.
Use a local Node.js runtime with ES modules and
the built-in `node:vm`/`node:test` modules (Node.js 20 or newer).

**Validation status:** all seven focused tests passed locally on 2026-11-11
(one worker, approximately 13 seconds). The seed-1 scripted player subsequently
completed a legal first transcension through the local viewer: displayed game
time **6h 25m 45s**, level **10**, awarded resin **11.49** (rounded display values).
Equivalence with original browser gameplay still needs validation before treating
this as a trustworthy training benchmark. No optimal-play claim has been established.

## JavaScript API

From the repository root, create a script such as:

```js
import { HeadlessEnvironment } from './headless/environment.mjs';

const env = new HeadlessEnvironment({ seed: 42 });
const initial = env.observe();
const plant = env.legalActions().find(action => action.type === 'plant');
const result = env.step(plant);

console.log(result.observation.elapsedSeconds); // 0.333
console.log(result.terminated);                 // false

const checkpoint = env.snapshot();
env.step({ type: 'wait' }, { ticks: 100 });       // 33.3 game seconds, no real-time sleep
env.restore(checkpoint);
```

Available methods:

| Method | Meaning |
| --- | --- |
| `reset({seed})` | Recreates the isolated engine and a fresh save; returns an observation |
| `observe()` | Returns a detached JSON observation without advancing time |
| `legalActions()` | Enumerates currently legal actions in the supported first-run action space |
| `step(action, {ticks: 1})` | Applies one action, then simulates that many fixed ticks |
| `snapshot()` | Returns a portable replay checkpoint; does not write a file |
| `restore(checkpoint)` | Reconstructs the run by deterministic replay |
| `metadata` | Reports benchmark settings and a SHA-256 engine fingerprint |

Seeds are unsigned 32-bit integers. An episode defaults to at most seven game
days; `maxEpisodeSeconds` may reduce that limit, rounded down to whole ticks.
One `step` accepts 1–10,811 ticks (at most about one game hour). Calls are
synchronous and run on one CPU worker. No process or timer is started in the
background. CPU use is bounded by the requested ticks, not by a wall-time SLA.

## Benchmark contract

- Fresh 5×5 field and the game's actual starter resources, with no inherited
  resin, upgrades, fruit, or achievements.
- Normal spring start. Seasons advance normally; calendar holiday bonuses are
  disabled so the benchmark does not change with the host date.
- Fixed **333 ms** simulation steps, matching the browser's nominal update
  interval. Large waits execute every step; they do not use offline catch-up.
- At most one structured action per tick, at the beginning of the interval.
  Bulk UI shortcuts are represented by successive decisions. This is a declared
  action-cadence constraint, not a claim of unrestricted human speedrun parity.
- Success requires actually completing the first normal transcension at tree
  level 10 or above. Reaching 10 alone does not terminate the episode.
- The score is total simulated seconds through the successful update, with
  333 ms resolution. Reward is negative elapsed seconds. `simulationTicks` is
  an integration counter, not the game's variable-duration update counter.
- `terminated` means successful transcension; `truncated` means the time limit
  was reached without success. A learning algorithm must distinguish these;
  an unfinished short rollout is not a faster successful run.
- Advancement stops after the successful transcend update; no second run can
  be played through this API. `completionLevel` and `awardedResin` remain in the
  terminal observation even though the basic tree has reset to zero.

Supported actions are `wait`, `plant`, `replace`, `delete`, `upgrade` (including
both choice branches), `fern`, `weather`, `fruit-select`, `fruit-move`, `inspect`,
and `transcend`. Copy complete action objects from `legalActions()`; IDs come
from the current engine rather than a separate hard-coded crop catalog.

`inspect` models reading help, changelog, player stats, and (once available)
fruit-storage information. The original game awards small production bonuses
for those interactions. The adapter exposes them as explicit actions and lets
the original medal conditions award them; it does not pre-grant achievements.

The scope excludes challenges, later fields, automation, amber purchases,
save manipulation, and post-transcension progression. Fruit fusion and essence
spending are not exposed in this first action surface: with holidays disabled,
the fresh run has only the level-5 fruit before reaching the target level, and
no essence from prior sacrifices. Extending beyond the immediate first-reset
objective requires expanding the action surface and its legality checks.

Observations include the field, resources, crop costs and growth times, unlocked
upgrades, weather/cooldowns, fern position, fruit inventory, earned achievements,
and legal actions. Large quantities use `{b, e}` for **b × 2^e**, preserving the
game's `Num` representation. They must not be blindly converted to ordinary
floating-point numbers in a future long-horizon learner. Observations omit
hidden RNG seeds and future random outcomes.

Invalid public actions throw before advancing time or changing the game. An
unexpected engine error faults the instance; use `reset()` before continuing.
Engine messages are returned as events (up to 1,000 per step, with an explicit
drop count). UI dialogs and sound are not rendered.

## JSON-lines transport

The CLI allows another local program, including Python, to control the same
environment over stdin/stdout without an HTTP server:

```sh
node headless/cli.mjs
```

Send one JSON object per line:

```json
{"id":1,"command":"reset","seed":42}
{"id":2,"command":"legalActions"}
{"id":3,"command":"step","action":{"type":"wait"},"ticks":100}
{"id":4,"command":"observe"}
{"id":5,"command":"snapshot"}
```

For restore, send `{"command":"restore","snapshot":...}` with the returned
checkpoint object. Responses have `id`, `ok`, and either `result` or `error`.
The CLI does not choose actions, start training, or save checkpoints for you.

## Extraction boundaries

- `game_runtime.js`: default browser clock/randomness/scheduling, with injected
  host implementations in headless mode. The normal browser remains the default.
- `gameplay_helpers.js`: shared helpers previously mixed into UI files,
  including the fruit-storage heuristic and production accumulator.
- `ui_game.js`: browser keyboard/mouse handlers and chips moved out of `game.js`.
- `presentation.js`: explicit non-rendering hooks. There is no fake `window`,
  `document`, canvas, or catch-all proxy that hides unsupported dependencies.
- `bridge.js`: bounded first-run action API, detached observations, and the
  original `update()` entry point. Legal-action masks preflight supported
  first-run actions; the engine remains authoritative when applying them.
- `environment.mjs`: one private VM context per environment, controlled time,
  seeded randomness, completion limits, and replay checkpoints. Node VM is used
  for global-state isolation, not to execute untrusted code securely.

No `ui_*.js`, `main.js`, browser renderer, or browser save codec is loaded by the
runner. Pixel-array definitions are still evaluated because content registrations
reference them; removing that startup overhead is deferred. No pixels are rendered.
Original game code still contains some presentation hooks and later-game UI
dependencies; this is a scoped extraction, not a full rewrite of every game mode.

Snapshots contain the seed, settings, and action/tick history. Restore starts a
new context and replays that history, thereby rebuilding mutable definitions,
caches, and RNG state as well as `state`. This prioritizes correctness over cheap
branching: restore cost grows with episode length. Checkpoints reject a different
engine fingerprint or episode limit. Do not supply checkpoint seeds/history to a
policy as privileged observations. Restart the Node process after editing sources.

## Runtime validation

The focused tests cover fresh initialization, action rejection, isolation,
observation immutability, fixed-tick batching, seeded replay, information-screen
achievements, and time-limit truncation:

```sh
node --test --test-concurrency=1 headless/environment.test.mjs
```

The seven tests above passed locally, and full legal seed-1 runs completed in
the viewer and benchmark runner. Benchmark replay artifacts were saved locally;
compact reports are committed. Remaining validation includes comparison against the original browser's active-play
calculations at crop-growth, replacement/refund, weather, fruit, and reset
boundaries. Do not create a fake successful episode by granting resources or
editing tree level. Original-browser equivalence checks and throughput
measurements remain separate opt-in work.

## Local viewer and scripted player

Start the optional loopback-only viewer manually:

```sh
node headless/watch.mjs
```

Open **http://127.0.0.1:8787**, then choose **New farm** and **Play**.
Use one viewer tab per server. `PORT=8788 node headless/watch.mjs` selects another
port. No installation or internet connection is needed. Stop with Ctrl+C.
The server is an optional UI transport; the environment itself still has no
server, browser, or network dependency.

- **Pause** stops requesting work after any in-flight batch finishes (at most
  100 ticks / 33.3 simulated seconds).
- **Single-step** makes one policy decision and advances exactly one 333 ms tick,
  including when the decision is to wait.
- **Speed** targets 1×, 10×, 100×, or 1000× simulated time per wall-clock time.
  Actual throughput depends on the machine. Rendering skips intermediate frames
  at high speed, but the policy still makes a decision on every simulation tick.
- The field shows crop names, growth or cress lifetime bars, and ferns; the
  dashboard shows resources, tree level, weather, fruit, and the last 100 actions.
- Success stops playback after the actual transcend action; the seven-game-day
  limit stops an unsuccessful run. Closing the page stops new simulation requests.
- New farm discards the current in-memory run. This viewer does not persist runs
  or implement replay controls yet; the environment checkpoint API remains available.

`scripted-player.mjs` exports the pure `chooseAction(observation)` policy and
`advancePlayer(env, ticks)` runner. They import neither the viewer nor the server.
The policy collects ferns, reads achievement-awarding information, buys unlocks,
maintains two watercress cells, grows berries/mushrooms/flowers in a fixed layout,
upgrades crops, uses weather, equips a stored fruit, and transcends when legal.
It only selects actions supplied by the environment; it never grants resources.
This is a transparent baseline heuristic, not an optimized or learned strategy.
A seed-1 run has completed successfully; see the validation result above.

The same player can run without any viewer (defaults: seed 1, one game day):

```sh
node headless/play.mjs 1 86400
```

It reports tree-level milestones as JSON lines and exits with status 0 for success
or 2 for the episode limit. This can perform substantial simulation work; the
command is documented here, not automatically run during implementation.

**Viewer validation:** the local server and visible viewer were run through a
complete seed-1 first transcension, increasing playback from 10× to a target of
1000×. The policy and engine needed no fixes during the run. Playback stopped
at completion. This is an observed baseline, not a saved replay artifact or a
measurement of wall-clock throughput. The seven previously passing environment
tests predate the additional upgrade metadata fields; they were not rerun here.

## Reproducible benchmarks

`benchmark.mjs` runs the unchanged scripted policy with one worker and one decision
per 333 ms tick. It writes exact results, level milestone ticks, action counts,
initialization/policy/step/recording timings, runtime and Git provenance, policy
and engine fingerprints, and a compressed replay checkpoint for each seed.
Checkpoints stay local (ignored by Git); compact JSON reports can be committed.
Existing output directories are rejected to avoid overwriting an experiment.

```sh
node headless/benchmark.mjs --out headless/benchmarks/baseline --seeds 1 --max-seconds 86400
node headless/benchmark.mjs --out headless/benchmarks/candidate --seeds 1 --max-seconds 86400 --compare headless/benchmarks/baseline
```

The comparison requires identical policy and recorder source hashes, episode
limits, action histories, final observations, and a digest covering **every**
action and returned observation/reward/event. A mismatch produces exit status 1.
Engine fingerprints may differ because optimization changes implementation;
replay checkpoint restore still requires its original engine fingerprint.
Comparisons cover exercised trajectories, not all possible actions or equivalence
to the original browser. Keep the same seed set and episode limits for fair timing.
A truncated episode is recorded as a failure to complete, never as a faster run.
Timing includes full trace hashing, but excludes final checkpoint compression and
file output; initialization is reported separately. This is recorded throughput,
not a claim about uninstrumented peak speed. No extra processes or workers run.

### Unattended comparison queue

After starting a baseline benchmark, launch the queue once and leave it running:

```sh
node headless/experiments.mjs --reference headless/benchmarks/baseline --out headless/benchmarks/comparison-batch --repeats 2
```

It waits up to 30 minutes for the baseline's completion record, reads its seeds
and episode limit, then executes the comparisons sequentially with one worker.
Each run gets a separate log, report, and checkpoint. Atomic `status.json` records
progress and the final speedup, or the reason for failure. Any mismatch or changed
engine between repetitions stops the queue. Ctrl+C or SIGTERM stops its child too.
Output directories are exclusive; partial experiments are retained for diagnosis,
not silently resumed or overwritten. Do not edit engine, policy, or recorder code
while this queue runs. No agent needs to supervise normal execution.

This queue measures and checks implementations. Policy optimization is handled
separately by the evolutionary trainer below.

## Local evolutionary training

```sh
node headless/train.mjs --out headless/training/pilot-1
```

This unattended pilot uses one worker, no network, and no LLM. It evaluates the
initial policy and 12 mutated candidates (3 generations × 4 children) on seeds
1 and 2, then evaluates the initial and selected policy on held-out seeds 101
and 102. This is 30 episodes at most, each capped at eight simulated hours.
Expected wall time is several hours, depending on policy behavior and the machine.
The simulator still executes every 333 ms tick and every selected action must be
legal. The scripted player and viewer are unchanged.

The learned parameters control crop-type priority, fractions of available seeds
allowed for unlocks/upgrades, and swaps in the field layout. Mutation preserves
crop-role counts and tree cells. Some decisions (fern collection, information
achievements, weather choice, and the transcend trigger) remain fixed heuristics.
This is parameter learning by evolutionary search, not neural reinforcement
learning or an unrestricted search over every strategy.

Candidates with more successful training runs rank first; equal success counts
are ranked by mean completion time with a timeout penalty of twice the episode
limit. A timeout cannot beat a completed run. The best training candidate is
retained, even if no mutation improves it. Held-out results are reported only;
they never influence mutation or selection.

The output directory contains:

- `status.json`: atomic progress, candidate history, RNG state, and final held-out
  comparison (improvement is null when either policy fails a held-out seed).
- `best-policy.json`: selected weights/layout and training results.
- Per-episode JSON results and compressed replay checkpoints.
- An active checkpoint refreshed about every 30 wall-clock seconds.

SIGINT/SIGTERM saves the active episode and stops. Running the exact same command
resumes from the checkpoint, including search RNG state. A lock prevents duplicate
writers. Source/configuration fingerprints must match; changed code requires a
new output directory. Restore replays the saved trajectory, so resume takes time.
Outputs are ignored by Git; source and intentionally selected reports are committed.
Do not edit trainer, policy, or simulator sources while training is running.

A short pilot with `--generations 1 --children 1 --max-seconds 3.33` exercises the
whole scheduling/selection/held-out/reporting path; its deliberate timeouts are
not evidence of strategy quality. A full training run is required for that.

## Recorded simulator speedup

The seed-1 baseline took 687.03 seconds of recorded simulation wall time. Two
optimized repetitions took 307.47 and 313.21 seconds: median speedup **2.21×**.
Both matched every recorded observation/action/result and all 69,507 ticks,
finishing at exactly **23,145.831 simulated seconds**. The optimization reuses
legal actions within a tick and crop costs within one legality calculation;
engine rules and time integration were unchanged. These are single-seed local
measurements, including trace recording overhead, not broad performance claims.
