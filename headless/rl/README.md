# Fully local neural learning from scratch

This experiment trains a randomly initialized neural policy with Maskable PPO.
There are no demonstrations, imported evolved policies, LLM calls, remote models,
or scripted gameplay choices. Nine local game processes generate experience for
one shared neural actor/critic. Nine mostly idle Python adapter processes handle
their local pipes. The learner uses one CPU thread; the simulator runs on the
unchanged Node engine. Existing evolutionary runs and engine fingerprints remain
intact.

## Installation and offline launch

The local `.venv-rl` uses Python 3.12. Installed versions are pinned in
`requirements.lock.txt`. Initial package installation requires downloads unless
the wheels are already available locally; training requires no internet access.

```sh
python3.12 -m venv .venv-rl
.venv-rl/bin/python -m pip install -r headless/rl/requirements.lock.txt
headless/rl/run.sh --out headless/training/neural-scratch-w9-20261112
```

`run.sh` applies the macOS sandbox profile that denies all network operations to
the learner and its descendants. Local process pipes still work. It does not
restrict filesystem access or claim to be a general untrusted-code sandbox.
No API keys, downloaded pretrained model weights, or cloud loggers are used.
There is no sleep-prevention process. For unattended use, start the launcher in
a detached session with stdin closed and stdout/stderr redirected to a local log.
The actual run log is `headless/training/neural-scratch-w9-20261112.log`.

Defaults are nine workers, up to 10 million neural decisions or 24 hours of
training wall time, whichever comes first. Final evaluation can take up to
another 15 minutes. A decision may advance multiple ticks only for explicit
wait actions. These limits are budgets, not promises of successful learning.

## Policy and observation/action contract

- Separate actor and critic MLPs with two 128-unit layers each, about 2 million
  parameters in total. Random initialization with seed 20261112.
- 5,769 float features: field/crop identity and growth, logarithmic resources and
  costs, upgrade counts, earned achievements, weather, fruit information, and
  public time/progression information. No hidden seed or checkpoint history is
  supplied to the neural policy. Scaling is fixed, so no running normalization
  statistics are omitted from recovery.
- 3,807 fixed action IDs from the game's static content definitions. Invalid
  actions are masked using the engine's legal-action list. Legality is not a
  strategy filter: all supported legal placements/replacements/deletions and
  purchases remain available. Unrecognized legal actions fail loudly rather
  than being silently hidden.
- Wait choices advance 1, 10, 100, or 1,000 ticks (0.333, 3.33, 33.3, 333 seconds).
  Non-wait choices advance one tick. A long wait selects no intermediate actions;
  every original 333 ms engine update is still executed. This is an explicit
  action-space addition, not offline catch-up or a scripted waiting heuristic.
- No fixed crop counts, layouts, weather choices, collection priorities, or
  automatic transcend trigger. The network chooses them through legal actions.
- The action/feature encoder supports 16 storage and 32 sacrifice fruit slots
  with at most eight abilities per fruit. These exceed the initial inventory;
  exceeding the declared limits aborts rather than dropping data.

The static content catalog is generated in a separate VM from original source
definitions. The game environment itself is not modified. It includes locked
content in the fixed vocabulary, but observations do not expose hidden future
random outcomes. This is structured observation learning, not screen reading.

## Objective, rewards and evaluation

Each episode starts from a fresh save and must actually transcend. The finite
task deadline is eight simulated hours (rounded to whole 333 ms ticks).

The base reward is `-elapsed / episode_limit`, with `+2` for a successful
transcension or `-1` at the failed deadline. A successful episode therefore has
base return at least 1, while a timeout has base return -2. Deadline failures are
terminal in the Gym adapter, so PPO does not bootstrap value beyond the task's
deadline. They remain labeled as failures in results.

For exploration, add `Phi(next) - Phi(previous)` with:

```
Phi = treeLevel / 10
    + 0.02 * (log2(1 + earnedSeeds) + log2(1 + earnedSpores))
```

Terminal Phi is zero. With `gamma=1`, these additions telescope to a fixed
initial-state offset across a complete episode: they provide intermediate
feedback without changing the complete-episode ranking. They do not reward
copying human layouts or prescribe particular actions. Reward shaping is still
a documented design choice, not a claim that learning has no human assumptions.

Other settings: GAE lambda .995, Adam learning rate .0003, entropy coefficient
.005, target KL .03, 256 steps per environment per rollout, minibatches of 256,
and three optimization epochs. These are initial experimental settings, not
validated optimal hyperparameters. Neural inference can cost more than the
previous evolutionary policy; measure actual throughput.

Training game seeds are sampled from 1 through 999,999,999. At the end, the fixed
policy is evaluated deterministically on seeds 1,000,001,001 through 1,000,001,009.
Evaluation never updates the model or selects checkpoints. If evaluation exceeds
its wall budget, unfinished entries are null and `interrupted` is true; they are
not claimed as completed games. Mean completion time is reported only if every
evaluation episode succeeds. Evaluation workers that finish early are ignored
after their first result, even though the vector environment auto-resets them.

## Progress and checkpoints

- `status.json`: status, step/update counts, worker PIDs, game progress, training
  episode successes/timeouts, configuration, source/runtime identity and checkpoint.
- `episodes.jsonl`: completed training episode outcomes. On crash/replay, records
  after the last checkpoint may be repeated; use model step numbers to interpret
  this diagnostic append-only log, not as the authoritative resume state.
- `latest.json`: atomically published pointer to a complete checkpoint directory.
- Checkpoint directories: model and Adam optimizer, Python/NumPy/Torch RNGs, game
  replay checkpoints, environment seed-generator states, observations/episode
  boundaries and progress counters. The latest two are retained. Temporary
  incomplete directories are never selected for resume.
- `evaluation.json`: final untouched-seed evaluation, including failures.

Progress is written approximately every 30 seconds. Checkpoints are written at
startup, approximately every ten minutes at rollout boundaries, and on graceful
stop/completion. A machine crash can lose work since the last checkpoint. Recovery
replays active game histories and can take minutes.

Send SIGTERM to the verified coordinator PID in `running.lock` to stop. Resume
with the same command and flags. Source, runtime and configuration mismatches
are rejected; duplicate writers are rejected. No automatic retries conceal engine
or worker errors: a failed run records its error and stops the remaining workers.

An interrupted, unfinished PPO rollout is discarded without an optimizer update;
the current model, RNGs and advanced game states are saved consistently. Resume
therefore continues learning but is not guaranteed bit-for-bit identical to an
uninterrupted run's optimizer schedule. Full rollout checkpoints preserve the
optimizer state. Checkpoint loading is for files produced locally by this runner,
not arbitrary external pickle/model files.

Do not edit simulator or training sources during a run. Final `complete` means
the configured experiment finished, not that the agent learned successful play.
Original-browser equivalence remains an outstanding simulator validation task.

## Verification

```sh
/usr/bin/sandbox-exec -f headless/rl/offline.sb \
  .venv-rl/bin/python -m unittest headless.rl.test_training -v
```

Tests check legal-action masking, stable observation shapes, unchanged state after
invalid actions, exact game replay/seed-generator recovery, reward telescoping,
deadline semantics, actual neural parameter updates, optimizer persistence,
graceful signal recovery, worker failure recovery, duplicate locks and rejection
of changed configuration without overwriting state. Short smoke episodes are
infrastructure checks, not evidence that the neural learner has mastered the game.
