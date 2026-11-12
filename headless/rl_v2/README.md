# Local curriculum experiment (v2)

This separate trainer preserves the original `headless/rl` experiment and its
checkpoint compatibility. No demonstrations, imported weights, Discord content,
scripted crop priorities, or placement templates are used. Python/PyTorch and the
original Node simulator run locally under the existing macOS network-denial sandbox.

Run from the repository root:

```sh
headless/rl_v2/run.sh --out headless/training/UNIQUE_NAME \
  --workers 9 --hours 1 --steps 1000000
```

The first budget reached stops training. The wall budget includes validation;
approximately four minutes are reserved for final evaluations. Checkpoint writes,
in-flight simulator calls, initialization and cleanup may add a small overrun.
SIGTERM/SIGINT saves a resumable checkpoint. Run the same command to resume a
stopped run; completed runs do not restart. Source/config changes require a new
output directory. Recovery includes all nine game states, curriculum stages,
recent mastery results, RNG states, optimizer and model weights. A partial rollout
is discarded on interruption; continuation is state-consistent, not bit-exact.

## Changes and deliberate tradeoffs

- Each ordinary action advances 30 original simulator ticks (9.99 seconds).
  Wait choices advance 30/90/300/900 ticks. No game ticks are skipped. This reduces
  the decision horizon but restricts action timing; it is an experimental task
  interface, not a claim of optimal play in the unrestricted browser game.
- Each worker starts with the goal of reaching tree level 1. Eight successes in
  the last ten episodes advance its next goal by one, through level 10 and then
  actual transcension (goal 11). Deadlines are 30 minutes times the target,
  capped by the eight-hour full-task limit. Every episode starts a fresh game.
- The target is part of the observation. Curriculum rewards are elapsed-time
  penalty plus non-repeatable tree-level milestones and a goal-success bonus.
  Refreshing, planting, deleting, and resource accumulation earn no direct reward.
  At goal 11, milestone rewards disappear: only completion and elapsed time matter.
  This deliberately changes early training objectives. Curriculum success must
  never be reported as a successful transcension.
- Shared action-descriptor embeddings encode action type, crop, x/y, upgrade,
  choice, ability, page, fruit slot/destination and wait duration. A state query
  scores every complete action using those shared features. Exact joint legal
  masks remain in place. This is structured scoring, not independent component
  sampling that could create illegal action combinations.
- PPO uses separate 128x128 actor/critic MLPs, 512-step rollouts, learning rate
  1e-4, entropy coefficient .02, gamma 1, GAE lambda .995, three epochs, one
  PyTorch thread. No new packages or remote services are required.

## Validation and comparison

At initialization, every 100,000 training decisions or ten minutes, and at the
end, test deterministic and sampled action selection on nine fixed validation
seeds. Evaluation uses the highest current curriculum target, with a fixed
192-decision cap per environment and 60-second wall cap per mode. Full budgets
are explicitly distinguished from interrupted evaluations. Best models are
selected only from complete evaluations and only compared within the same target:
goal successes, then mean level, then successful completion time.

Nine training game workers pause during validation while nine temporary evaluation
workers execute. There are at most nine active simulator workers; paused training
processes remain resident. Evaluation RNG state is isolated from training RNGs.

Final testing uses a separate seed range and goal 11, with the same bounded
assessment; it is not used to select models. If the curriculum has not reached
that goal, this is an early full-task probe, not a claim that training finished
all stages. Evaluation caps may end episodes before their game-time deadline;
missing results are not counted as completed failures or successes.

Outputs in the run directory:

- `status.json`: counters, stages, repetition, latest PPO metrics and evaluations.
- `episodes.jsonl`: target, goal success, actual transcension, time, level and seed.
- `metrics.jsonl`: entropy loss, KL, value loss, explained variance and other PPO metrics.
- `evaluations.jsonl`: fixed-seed sampled/deterministic comparisons and baseline.
- `best.json`, `best-target-N.zip`: best validation model for each stage.
- `latest.json`, `checkpoint-*`: latest two resumable training checkpoints.

A saved best policy is for evaluation; the latest checkpoint is for resuming the
same training process. Progress should be judged against the random initial
validation baseline at the same goal, not against the maximum level ever seen.

Tests:

```sh
/usr/bin/sandbox-exec -f headless/rl/offline.sb \
  .venv-rl/bin/python -m unittest headless.rl_v2.test_training -v
```
