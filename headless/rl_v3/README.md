# Local resource-to-tree curriculum (v3)

This experiment fixes the unreachable first-stage feedback and incomplete paired
validation in v2. Old trainers and run directories are retained unchanged.
All learning is local, with random initial weights, no demonstrations, no imported
policies, no scripted layouts or action priorities, and outbound network denied
by `headless/rl/offline.sb`.

```sh
headless/rl_v3/run.sh --out headless/training/UNIQUE_NAME \
  --workers 9 --hours 1 --steps 1000000
```

The earlier of the time/decision budgets stops training. About four minutes of the
wall budget are reserved for final validation and testing; unused time is not
filled with extra training. In-flight simulator calls, saving and shutdown can add
a small overrun. Resume an interrupted run using the same command; source/config
changes require a fresh directory. Completed runs do not restart. SIGTERM/SIGINT
save model, optimizer, all nine games, curriculum state and RNG state. Partial
rollouts are discarded; resumption is consistent, not bit-exact optimization.

## Curriculum and rewards

| Target ID | Goal | Training game deadline |
|---|---|---|
| 0 | Earn 1 new seed | 10 minutes |
| 1 | Earn 100 new seeds | 30 minutes |
| 2 | Earn 1 new spore | 2 hours |
| 3–12 | Reach tree levels 1–10 | 8 hours |
| 13 | Actually transcend | 8 hours |

Every episode begins a fresh game. Eight successes out of the last ten advance
that worker's next target. The target is observed by the policy. Resource goals
use cumulative earned resources minus the reset baseline; starting resources and
current-stock refunds cannot satisfy them. They do not prescribe how resources
are acquired. Reaching a resource goal is NOT reaching a tree level or transcending.

Feedback is a one-time high-water-mark increase in goal progress, plus elapsed-time
cost, success bonus, or deadline-failure penalty. Resource progress uses
`log(1 + new earnings) / log(1 + threshold)`. Tree progress includes the fraction
of the next spore requirement available, as well as levels reached. Progress
repeatedly lost and regained cannot earn duplicate rewards. Target 13 removes
these progress rewards, retaining actual completion and time only.

The shared structured-action policy, exact joint legal masks and ten-second
ordinary decisions from v2 are retained. Waits are 9.99/29.97/99.9/299.7 seconds;
all original game ticks execute. This deliberately limits action timing and is
not an unrestricted-browser optimality claim. All packages were already installed.

## Evaluation that finishes

Both deterministic and sampled modes use the same nine validation seeds, the same
goal, and a fixed **600-game-second trial**. At least 9.99 seconds elapse per decision,
so 64 decision rounds suffice to terminate all nine first trials. Finishing early
freezes that worker, including across VecEnv auto-reset: no extra games are simulated
while waiting for the other workers. A 180-second per-mode wall cap remains as an
emergency bound, also constrained by the overall run time budget.

Only evaluations with **all nine trials terminated in both modes** may select a
best model. A decision or wall cutoff is explicitly incomplete, never a successful
paired evaluation. Selection is within the same goal: number of successes, total
goal progress, then completion time. Best models are separate from recovery
checkpoints. Evaluation RNG use does not perturb training RNGs.

Validation runs at random initialization, every 100,000 decisions or ten minutes,
and at the end. Its short horizon is an early-progress benchmark, not the full
training deadline. A separate final test uses untouched seeds and target 13 for
600 game seconds as well; this is explicitly a short full-task probe, not an
eight-hour test or proof that the entire curriculum was learned. Advanced goals
may score zero in this short benchmark even when longer training episodes succeed.

Nine training workers pause during evaluation; nine temporary evaluation workers
compute while the paused processes remain resident. Status and logs contain:

- `episodes.jsonl`: named goal, goal progress/success, actual transcend, level/time.
- `status.json`: per-worker stages, action counts, repetition, PPO metrics.
- `evaluations.jsonl`: complete/incomplete paired trials, initial baseline and tests.
- `best.json`, `best-target-N.zip`: validation-selected policies per stage.
- `metrics.jsonl`: entropy loss, KL, value loss, explained variance and update count.
- `latest.json`, `checkpoint-*`: two most recent full recovery checkpoints.

## Verification

```sh
/usr/bin/sandbox-exec -f headless/rl/offline.sb \
  .venv-rl/bin/python -m unittest headless.rl_v3.test_training -v
```

The first-goal test uses uniformly sampled legal actions on 20 independent seeded
games, without a neural model, trained weights or demonstrations. It requires at
least 16 successes. A wait-only control verifies that starting stock and inactivity
do not count as success. Additional tests check one-time rewards, mastery,
checkpoint replay, frozen evaluation slots, neural weight updates/save/load,
stop/resume, and completed paired evaluations. A nine-worker integration smoke
run separately verifies the actual evaluation and training process configuration.
