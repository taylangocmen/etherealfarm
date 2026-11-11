# Parallel evolutionary training

`train-parallel.mjs` evaluates independent candidate/seed episodes in separate
Node processes. A single coordinator generates mutations, selects the winner,
and writes search state. It uses the same game engine, policy representation,
RNG, training seeds, held-out seeds, and ranking as `train.mjs`. There are no
packages to install, GPU requirements, LLM calls, network services, or agent
monitoring loops. Node 20+ is supported; local validation used v20.13.1.

## Current unattended run

The Apple M4 machine has 10 cores (4 performance, 6 efficiency) and 24 GiB RAM.
The configured limit is **nine episode workers**, plus a mostly idle coordinator.
This is a process concurrency limit, not CPU affinity or a hard reservation of
one core. macOS schedules the processes. Full ninefold speedup is not assumed.
The initial baseline has only two independent episodes and final validation has
four; each generation offers 32 episodes to the nine-worker pool.

```sh
node headless/train-parallel.mjs \
  --out headless/training/local-parallel-w9-g8-c16-20261111 \
  --workers 9 --generations 8 --children 16 --max-seconds 28800
```

This is 128 mutated policies and up to **262 episodes**, each bounded by eight
simulated hours. Wall time depends on the machine and candidate behavior. The
coordinator stops automatically after held-out validation or a worker failure.
The machine is already configured not to sleep; no `caffeinate` is needed.
Launch with a detached process/session and redirect output to a log when running
unattended. The actual run uses
`headless/training/local-parallel-w9-g8-c16-20261111.log`.

## Progress, stop, and resume

`status.json` records the coordinator PID, configured workers, finished
generations, selected policy, pending candidates, and an `active` object keyed
by episode ID. Active entries show worker PIDs and training/restoration progress.
Workers checkpoint approximately every 30 seconds of execution. During a long
checkpoint replay the worker is marked `restoring` and may not emit progress.
Completed episode `.json` files appear immediately; `completed` candidates are
published in deterministic order at generation boundaries.

```sh
tail -n 12 headless/training/local-parallel-w9-g8-c16-20261111.log
cat headless/training/local-parallel-w9-g8-c16-20261111/status.json
```

To stop, verify the coordinator PID in `running.lock`, then send that PID SIGTERM.
The coordinator tells all workers to checkpoint, waits for them to exit, writes
`stopped`, and removes the lock. Send signals to the coordinator for normal stops,
not to individual workers. An unexpected worker exit fails the whole job and
gracefully stops its peers instead of treating the failed game as a timeout.

Run the same command to resume. `--workers` may change between restarts; it does
not alter search identity. All other configuration and source fingerprints must
match. A finished run is not extended by changing its generation count. Use a
new output directory for changed experiments. Checkpoint restore replays history.

Each episode owns separate result/progress files. Its two alternating active
checkpoints preserve the prior published checkpoint if a process crashes during
a write. Completed results are reusable after restart even if the coordinator
had not yet recorded the generation. Workers detect coordinator disconnection
and stop after their current synchronous batch/replay; a restarted coordinator
rejects recorded worker PIDs that are still alive. This is local process recovery,
not a guarantee against disk corruption or arbitrary power-loss timing.

The old `train.mjs` and its output format remain unchanged. The earlier
`local-pilot-20261111` run was gracefully stopped and is preserved. Its checkpoint
is not imported into this separate parallel run. Neither runner updates the
viewer or scripted policy automatically.

## Continue from a saved winner

Use a new output directory and `--initial-policy` to import a `best-policy.json`:

```sh
node headless/train-parallel.mjs \
  --out headless/training/continuation-2-w9-g8-c16-20261111 \
  --initial-policy headless/training/local-parallel-w9-g8-c16-20261111/best-policy.json \
  --workers 9 --generations 8 --children 16 --max-seconds 28800 \
  --search-seed 20261112 --validation-seeds 201,202
```

This continuation starts from the previous winner `g7-c16`, re-evaluates its
parameters on training seeds 1 and 2, then mutates from that incumbent. Previous
scores, action histories, and search RNG state are not imported. The old run is
untouched. The new search seed avoids repeating the previous mutation sequence.
The incumbent survives any mutation that does not rank strictly better on the
training seeds; validation performance can still decline.

Final validation compares the **imported starting policy** and the new winner
on the same seeds 201 and 202. They are fresh relative to the previous run's
evaluation seeds 101 and 102 and are never used for parent selection. In this
run `validationBaselineMeanSeconds` means the imported winner's mean, and
`validationImprovementPercent` measures additional improvement over that winner,
not improvement over the original scripted policy. `startingPolicyId`,
`trainingBaselineMeanSeconds`, and `trainingImprovementPercent` record the
corresponding training comparison. Improvement is null if either policy fails.

The full starting artifact, original path, and serialized JSON SHA-256 are embedded
in `status.json`. The engine fingerprint, numeric bounds, tree positions and crop
counts must match the current policy representation. An older trainer fingerprint
is allowed because only policy parameters are imported and scores are recomputed.
The embedded copy makes resume independent of the external source file: omit
`--initial-policy` when resuming if the file was moved. If supplied, it must match
the original digest. Keep all other flags the same (except worker count).

`--search-seed` is an unsigned 32-bit integer. `--validation-seeds` is a comma-
separated list of 1–100 unique unsigned 32-bit seeds, disjoint from training seeds
1 and 2. Defaults remain 20261111 and 101,102 for runs without these flags.
Changing source code still invalidates resumability of older runs; completed
run directories remain readable and their policy exports can seed a new run.

## Determinism and checks

Candidates for a generation are all sampled from its starting incumbent before
evaluation. Results are selected in candidate order, with seed order fixed;
worker finish order never draws RNG, breaks ties, or changes parents. More
successful episodes rank first, followed by lower completion-time/timeout loss.
Held-out seeds 101 and 102 are only used after search.

```sh
node --test --test-concurrency=1 headless/train-parallel.test.mjs
```

The integration tests compare serial, parallel, and legacy trainer search state,
episode results and exact replay histories on short trajectories. They also cover
duplicate writers, configuration rejection without state modification, graceful
stop/resume, a killed worker followed by recovery, imported policy retention,
mutations around the imported parent, fresh validation seeds, malformed policy
rejection, and warm-start resume without the source file. Deliberately short test
episodes time out; they do not demonstrate learned improvements or exhaustive
game equivalence. Original-browser equivalence remains a separate limitation.

Do not edit the parallel trainer, worker, common helpers, policy, or simulator
while an experiment is running. Worker processes verify source identity before
executing an episode. All generated training data remain ignored by Git.
