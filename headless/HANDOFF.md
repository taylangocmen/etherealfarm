# Ethereal Farm: local simulation and training handoff

This is the entry point for moving work to another Mac or handing it to another
engineer/agent. Commands below run from the repository root unless stated otherwise.
They are instructions for the operator, not evidence that each command has been
executed on the destination machine.

## 1. Objective and current state

**Objective:** minimize simulated time from a fresh save to the actual first
normal transcension at tree level 10 or above. Learning resin/hour across many
transcensions is a later objective and is not implemented.

The fork contains a working Node.js simulator, a fixed scripted player, optional
local viewer, deterministic benchmark recorder, unattended comparison queue, and
an unattended evolutionary trainer. No LLM, API key, network service, browser,
Python, npm package, or GPU is needed to run training. Git/network are needed only
for obtaining/updating the repository or transferring files.

The original game mechanics are reused, not reimplemented as an approximation.
The integration contract is one action per fixed 333 ms game tick. Training never
sleeps to match game time; all ticks execute as fast as the CPU can process them.

**Known result:** the fixed seed-1 player completed in **23,145.831 game seconds**
(6h 25m 45.831s), **69,507 ticks**, earning approximately **11.49 resin**.
This is a baseline, not an optimum or a claim about unrestricted human speedruns.

### Evidence available in Git

| Evidence | Result / location |
| --- | --- |
| Focused environment tests | Seven passed before the latest optimization/trainer additions; not rerun afterward |
| Full pre-optimization seed-1 run | [baseline/seed-1.json](benchmarks/baseline/seed-1.json) |
| Two optimized full-run comparisons | [comparison-batch/status.json](benchmarks/comparison-batch/status.json) |
| Exact trajectory equivalence | Same digest of every public observation/action/result, same final state and action history in both repetitions |
| Recorded wall time | 687.03 seconds before; 307.47 and 313.21 seconds after |
| Median recorded speedup | 2.21× on Apple M2 Pro, Node v24.14.1, one worker |
| Trainer scheduling trial | Short 3.33-game-second episodes exercised generation, selection, timeouts and held-out reporting; these were intentionally unsuccessful games |
| Partial training snapshot | [pilot-1-handoff.json](reports/pilot-1-handoff.json); dated, immutable, **not resumable** |

At the handoff snapshot, the initial policy succeeded on both training seeds:
seed 1 in 23,145.831 seconds and seed 2 in 23,891.751 seconds; mean 23,518.791.
The first mutation succeeded but was slower (mean 26,424.549 seconds). The second
mutation timed out on both seeds. The initial policy remained best at that point.
The pilot was still running; this does not establish a final learned improvement.
Check the snapshot for its exact timestamp and completed candidates.

## 2. Set up the Mac mini

Prerequisites: Git, a terminal, enough free disk space for experiment artifacts,
and Node.js. The tested version is **Node v24.14.1**. Use that version for the
closest reproduction (the code targets Node 20+, but other versions have not
been measured here). Use your existing Node version manager or install Node
before proceeding. There is no `npm install`, build step, or training dependency
installation in this repository.

```sh
git clone git@github.com:taylangocmen/etherealfarm.git
cd etherealfarm
node --version
git status --short
git log -1 --oneline
```

If SSH authentication is not configured, clone via
`https://github.com/taylangocmen/etherealfarm.git` using your normal GitHub access.
An existing checkout can use `git pull --ff-only` while no experiment is running.
Do not change simulator/trainer/policy source while a run is active.

Recommended destination-machine checks, run **sequentially**, not in parallel:

```sh
node --test --test-concurrency=1 headless/environment.test.mjs
node headless/train.mjs --out headless/training/mac-mini-smoke --generations 1 --children 1 --max-seconds 3.33
```

The smoke run should end with `status: "complete"` and null improvement metrics:
all its episodes are deliberately too short to transcend. A completed trainer
job is different from a successfully completed game.

## 3. Start real training and leave it running

Start with the default pilot. On macOS, `caffeinate -i` keeps the machine from
idle-sleeping while its child runs. `nohup` lets the job survive closing the
terminal. Neither makes it survive reboot; checkpoints support restarting.

```sh
mkdir -p headless/training
nohup caffeinate -i node headless/train.mjs --out headless/training/mac-mini-pilot > headless/training/mac-mini-pilot.log 2>&1 < /dev/null &
```

The `$!` shell PID may belong to the wrapper. The Node process PID is recorded in
`headless/training/mac-mini-pilot/running.lock` and `status.json` after startup.

Defaults:

- 3 generations, 4 mutations per generation: 12 candidate policies.
- Training seeds: 1 and 2. Held-out evaluation seeds: 101 and 102.
- The initial policy is evaluated first; each candidate then plays both training
  seeds. Final evaluation compares the initial and selected policies on held-out seeds.
- At most **30 episodes**: `2 × (1 + generations × children) + 4`.
- Each episode is capped at 28,800 game seconds (8 hours), rounded down to whole
  ticks; an unsuccessful full-length episode ends at 28,799.838 seconds.
- One worker. Estimated wall time is several hours on the measured M2 Pro;
  measure the Mac mini rather than assuming an exact speedup.

For a larger **new** run after the pilot:

```sh
nohup caffeinate -i node headless/train.mjs --out headless/training/mac-mini-g8-c8 --generations 8 --children 8 --max-seconds 28800 > headless/training/mac-mini-g8-c8.log 2>&1 < /dev/null &
```

That is 64 mutated policies and up to 134 episodes. At five minutes per episode,
134 episodes would take roughly 11 hours; failures and slower policies may take
longer. Run only one experiment at a time until concurrency is implemented and
measured. More physical cores do not automatically accelerate this single-worker
implementation. A new directory starts from the initial policy, not from the
winner of another directory: cross-run warm starts are not implemented.

Supported training flags are exactly `--out`, `--generations`, `--children`, and
`--max-seconds`. There is no `--workers`, `--resume`, `--seed`, GPU option, or
wall-clock-budget option yet. Generations/children must be integers 1–100.
Changing configuration requires a new directory; a finished run cannot simply
be extended by increasing `--generations` on its existing directory.

## 4. Monitor, stop, and resume

```sh
tail -n 10 headless/training/mac-mini-pilot.log
node -e 'const fs=require("node:fs"); const s=JSON.parse(fs.readFileSync(process.argv[1],"utf8")); console.log(JSON.stringify({status:s.status,pid:s.pid,updatedAt:s.updatedAt,generation:s.generation,active:s.active,evaluated:s.completed.length,best:s.best&&{id:s.best.id,successes:s.best.successes,loss:s.best.loss},result:s.result,error:s.error},null,2));' headless/training/mac-mini-pilot/status.json
```

`generation` counts finished generations, so zero during generation 1 is normal.
`completed` includes the initial policy. `active.gameSeconds` is simulated time;
`active.wallSeconds` is measured episode execution time. Progress is saved about
every 30 wall-clock seconds, and at episode/selection boundaries. Long replay
restoration can have no fresh progress output while it reconstructs the episode.
No external notification or agent monitoring is required.

Statuses are `starting`, `training`, `validating`, `stopped`, `failed`, and
`complete`. `result.validationImprovementPercent` is positive for a faster winner,
negative for worse held-out performance, and null if either policy failed a
held-out seed. Training success alone is not evidence of generalization.

Graceful stop (substitute the correct output path):

```sh
TRAIN_PID=$(cat headless/training/mac-mini-pilot/running.lock)
ps -p "$TRAIN_PID" -o pid=,command=
kill -TERM "$TRAIN_PID"
```

Verify the PID is the expected trainer before signaling it. Wait for it to exit:
`status.json` should say `stopped` and `running.lock` should disappear. It saves
an active replay checkpoint before exiting. Avoid `kill -9` for normal shutdown.
If the process has already finished, the lock will already be absent.

Resume by running the **same command with the same directory and flag values**.
It preserves the search RNG, completed evaluations, pending candidates, incumbent,
and active episode. A duplicate live writer is rejected. Resume reconstructs an
active episode by replaying its action history, so it may take minutes.

Back up the stopped directory before troubleshooting. Fingerprint/configuration
mismatches must be resolved by using matching source/configuration or a new run;
do not edit identity fields to bypass them. A failed engine action should be
investigated, not silently converted to a success or ordinary timeout.

## 5. Move an existing run between machines

**A Git clone does not contain active training state.** The entire `training/`
output tree is ignored except its `.gitignore`. Benchmark replay files are also
ignored. Only code, docs, intentionally selected JSON reports, and the partial
handoff snapshot are pushed. The snapshot in `reports/` cannot resume training.

For an exact continuation:

1. Gracefully stop the source trainer, as above. Confirm it exited and the lock
   disappeared. Do not copy a live directory: checkpoint and status updates are
   separate writes and could be copied inconsistently.
2. Archive the complete stopped experiment directory, including `status.json`,
   all `.checkpoint.json.gz` files, and candidate results. Keep the external log
   too if desired, but the log is not required to resume.
3. Copy it privately to the Mac mini and unpack at the repository root.
4. Use the same Node version, exact configuration, and compatible source. Source
   fingerprint checks are enforced. A docs-only Git commit does not change those
   fingerprints. The current pilot was started at commit `f7424a7`.
5. Resume with the original flags and directory. Do not run the same experiment
   concurrently on both machines.

Example for the current source pilot, **after stopping it**:

```sh
tar -czf "$HOME/etherealfarm-pilot-1.tar.gz" headless/training/pilot-1
```

Transfer that archive using your preferred local file transfer. On the destination,
ensure `headless/training/pilot-1` does not already contain another experiment:

```sh
tar -xzf "$HOME/etherealfarm-pilot-1.tar.gz"
nohup caffeinate -i node headless/train.mjs --out headless/training/pilot-1 > headless/training/pilot-1.log 2>&1 < /dev/null &
```

A transferred PID is not portable. A clean graceful stop removes the lock. If
recovering an unclean archive with `running.lock`, confirm there is no trainer
using that directory on either machine before removing **only that stale lock**.
A reused PID on the destination can otherwise cause a false "already in use".
Do not delete `status.json` or checkpoint files to work around a lock.

## 6. How this learner works

`learned-policy.mjs` starts with the scripted strategy. The trainable genome is:

- Four numeric priorities for brassica, berry, mushroom, and flower decisions.
- Seed-spending fractions for unlocks and crop upgrades.
- A 5×5 map of intended crop roles; mutations swap roles between non-tree cells.

Priorities receive bounded additive noise; spending fractions receive bounded
multiplicative noise. A mutation has a 75% chance of attempting a cell-role swap;
a swap can be a no-op. Crop-role counts and tree cells are preserved. Each new
generation samples around the current best policy. All candidates in a generation
are generated before that generation is evaluated. The incumbent survives unless
a candidate ranks better.

Candidate ranking is lexicographic: more successful training episodes first,
then lower mean loss. Successful loss is elapsed game seconds. Timeout loss is
`2 × maxSeconds`, so failing cannot beat success just by ending an episode.
Held-out seeds are evaluated after search and do not choose weights or parents.
The search RNG is seeded with 20261111 and saved; game RNGs are independently
controlled by each game seed. Repeating the same config/source from scratch
repeats the same deterministic search; more duplicate runs are not more diversity.

This is **evolutionary parameter optimization**, not PPO, a neural network, or an
LLM agent. Many heuristics remain fixed: collecting ferns, information achievements,
weather choices, fruit selection, tier ordering, and transcending as soon as legal.
It does not learn arbitrary crop counts or unrestricted timing. Unlimited compute
cannot overcome these representation limits.

`best-policy.json` contains the winner's `parameters` plus provenance/results.
To use it in another local runner, load `.parameters` and call
`chooseAction(observation, parameters)` from `learned-policy.mjs`, then pass that
legal action to `env.step`. The existing viewer and `play.mjs` still use the fixed
script; training does not silently replace their policy. There is no dedicated
winner-playback CLI yet.

## 7. Game rules and extraction details worth preserving

- Fresh 5×5 farm, actual starter seeds (10.00001), spring start, no inherited
  ethereal bonuses/resin. Calendar holiday rewards are disabled for reproducibility.
- Resources use the original `Num`/`Res` implementations. Public numbers are
  `{b,e}`, meaning `b * 2**e`, not a decimal exponent. Avoid lossy conversion for
  future long-horizon tasks; the pilot's simple policy uses ordinary JS numbers.
- Berries supply seeds; neighboring mushrooms consume seeds to produce spores.
  Flowers boost adjacent crops. Watercress has finite life and copies neighboring
  production. The field topology and replacement timing matter.
- The initial blackberry unlock requires ten cumulative plantings on a first run;
  two repeatedly replanted watercress cells eventually satisfy it. The baseline's
  slow opening is a policy choice, not the absence of an unlock.
- Information-screen achievements confer production bonuses. Explicit `inspect`
  actions model help/changelog/stats and unlocked fruit information; these are not
  silently pre-granted.
- The first fruit arrives at level 5. The first-run action surface supports fruit
  selection/storage moves but excludes fusion/essence spending, later fields,
  challenges and post-transcension play. Expanding the task requires a new audit.
- Resin is awarded by the actual transcend action, not merely by reaching level 10.
  `terminated` is success; `truncated` is the episode time limit without success.
- Time advances through original `update()` calls on a 333 ms grid, never through
  the game's approximate offline catch-up. Large waits still execute every tick.
  Bulk UI shortcuts are separate actions, so the benchmark has an explicit cadence.
- VM contexts isolate global state per environment. The runtime injects clock and
  randomness; existing fruit/fern RNG algorithms remain in place. Async surprises
  and engine rejection/error messages throw instead of being silently swallowed.
- UI dependencies are explicit presentation no-ops, not a fake DOM. Shared gameplay
  helpers were extracted from UI files. Unsupported later modes may still need UI
  dependencies; the scope is first transcension, not every mode of the full game.
- Legal-action caching is valid only until the next tick/reset. Costs are reused
  within one legality calculation; cell-specific growth-dependent refunds remain
  distinct. Callers receive detached copies. Do not leak mutable cached objects.
- Artwork is still initialized even though no pixels are rendered. Startup overhead
  removal and faster true snapshots are potential future work.

## 8. Benchmarks and correctness on the destination

Run a new output directory and compare with the committed original reference:

```sh
node headless/benchmark.mjs --out headless/benchmarks/mac-mini-check --seeds 1 --max-seconds 86400 --compare headless/benchmarks/baseline
```

Or run two unattended repetitions:

```sh
node headless/experiments.mjs --reference headless/benchmarks/baseline --out headless/benchmarks/mac-mini-comparisons --repeats 2
```

These output directories must not exist. The committed `baseline/` and
`comparison-batch/` directories already exist after cloning; do not use them as
new output targets. A comparison requires the same policy/recorder source hashes,
episode limit, exact action history, final observation, and digest of every tick's
returned result. Nonmatching trajectories exit nonzero. Engine fingerprints may
differ across implementation optimizations; checkpoint restore is stricter and
requires its exact original fingerprint.

Comparing Mac mini wall time against the original baseline mixes hardware and
implementation effects. For clean hardware comparisons, use the committed
optimized run timings as context, and compare like-for-like workloads. Timing
includes trace hashing, excludes checkpoint compression/file output, and reports
initialization separately. Training timings are not directly interchangeable
with benchmark timings because their recording work differs.

## 9. Known limitations and next work

Implemented: reproducible complete runs, exact-output comparison for exercised
trajectories, bounded unattended evolutionary search, per-episode results, periodic
replay checkpoints, signal stop/resume code, source/config identity enforcement.

Not yet established: original-browser equivalence across all mechanics; broad
random-action coverage; a demonstrated final learned improvement; cross-machine
checkpoint migration tested end-to-end; signal recovery under all crash timings.
The completed short trainer trial tested scheduling/reporting, not every recovery
path. Source hashes exclude Node/hardware: matching them is necessary but not a
proof of numerical equivalence on every runtime. Use the tested Node version and
run destination comparisons.

Next performance/search work, in suggested order:

1. Retain and analyze the pilot's final held-out result; distinguish bad mutations
   from engine failures. Keep a separate untouched test set if repeatedly tuning
   against the current held-out seeds.
2. Measure remaining simulation/recording costs on the Mac mini.
3. Add mathematically safe early rejection and staged seed evaluation. Neither is
   implemented now; every candidate currently gets full training episodes.
4. Add a measured multi-worker scheduler, starting at two workers, then four.
   Use isolated environments and deterministic parent selection. More cores alone
   do not speed up the current one-worker loop.
5. Add configurable search/train/test seeds, compute budgets, and cross-run warm
   starts. Changing the hard-coded seed arrays now changes the trainer fingerprint.
6. Expand the policy representation (placement, crop counts, timing), then consider
   neural reinforcement learning or imitation initialization if justified.

Do not simply increase tick duration or use offline catch-up for speed: that can
change the game and reward strategies that exploit the simulator. Changing how
often the policy decides is also a benchmark change and must be labeled.

## 10. Source map and working agreements

| File | Role |
| --- | --- |
| `game.js`, `data.js`, `state.js`, `number.js`, `resource.js` | Original game rules and state |
| `game_runtime.js`, `gameplay_helpers.js`, `ui_game.js` | Runtime injection, shared helpers, extracted browser handlers |
| `headless/environment.mjs` | Isolated VM, clock/RNG, API, replay checkpoints |
| `headless/bridge.js`, `headless/presentation.js` | Legal actions/observations and explicit non-rendering hooks |
| `headless/scripted-player.mjs`, `play.mjs` | Fixed baseline policy and runner |
| `headless/learned-policy.mjs`, `train.mjs` | Parameterized policy and unattended trainer |
| `headless/benchmark.mjs`, `experiments.mjs` | Exact trajectory recorder and comparison queue |
| `headless/watch.mjs`, `viewer/` | Optional viewer; not needed for training |
| `headless/cli.mjs` | JSON-lines API for other local programs |
| `headless/README.md` | API contract and component details |

Commit meaningful changes locally. Push only when requested (this handoff was
explicitly authorized to push). Do not commit all generated experiments blindly;
choose compact reports and preserve model/checkpoint provenance. The viewer is
currently out of scope for improvements. Keep all work local; no paid inference.
Obsidian is read-only unless explicitly authorized to write, and Discord must
always remain read-only. Neither was used as evidence for this implementation.
Follow the user's resource-safety rules: execute tests/benchmarks/servers only when
explicitly requested, and use one worker until multi-worker execution is authorized.
