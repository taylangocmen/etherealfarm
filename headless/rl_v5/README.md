# Local archive search and learning from self-discovered paths

V5 replaces repeated fresh-start random rollouts with a persistent state archive.
It reuses the v4 simulator interface and neural policy, but **does not load any old
policy weights or human/scripted demonstrations**. All processes run locally inside
`headless/rl/offline.sb`, which denies outbound networking. No new packages or
external services are needed.

## Unattended pipeline

```sh
/usr/bin/sandbox-exec -f headless/rl/offline.sb \
  .venv-rl/bin/python -m headless.rl_v5.pipeline \
  --out headless/training/UNIQUE_EXPERIMENT --search-minutes 20
```

1. **Search with nine workers.** Begin nine fresh training seeds. Archive useful
   states and restore them to explore alternate continuations. The initial search
   is capped at 20 wall minutes, or stops after discoveries on all nine seeds.
2. **Require actual discoveries.** If fewer than three distinct training seeds
   produced at least one new spore, stop. Do not train on fabricated successes or
   automatically spend another hour searching.
3. **Verify and learn.** Replay the fastest discovered success for each seed from
   its fresh initial state. Check every action against the actual legal menu and
   require real spore production at the end. Create datasets only from verified
   paths, then train a randomly initialized neural actor and critic on those paths.
4. **Check reproduction.** On three different fresh seeds, run the learned policy
   in sampled and greedy modes, plus a matched random baseline. If either learned
   mode gets fewer than two successes, or any evaluation is incomplete, stop.
5. **Run the final gate.** Use nine further unused seeds. Require all 27 trials to
   complete, at least 8/9 sampled successes and 6/9 greedy successes, and either
   three additional successes over random or at least 20% lower failure-capped
   mean completion time with no fewer successes.
6. **Only after passing:** start a one-hour, nine-worker PPO continuation of the
   tested model, still optimizing first-spore production. No automatic promotion
   to an untested transcension objective. No long run starts on failure/timeout.

All comparison arms use the same four-hour game allowance and action interface.
The random baseline samples an action type uniformly, then one of its legal
candidates uniformly. Evaluation starts from fresh farms, never archive states.
Search training seeds, three-seed preflight seeds, and final nine-seed gate seeds
are disjoint. The model is fixed between preflight and final acceptance.

## Archive behavior

Workers explore random action-type bursts of one to four decisions, with additional
random switches. There is no crop ordering, hand-selected layout, or preferred
upgrade list. All candidates are legal engine actions. Archive novelty combines
unlocked/mature crops, resource/production bands, crop-type counts and spore
progress. Representative quality uses unlocks, maturation, seed stock, production
and actual spores; it does not choose actions directly.

The coordinator favors promising and less-visited archived states, while retaining
broader exploration. It keeps up to 1,024 cells, reserves initial roots, and stores
full replay histories. Snapshots are compressed, content-hashed, and tied to the
search code, simulator and runtime identity. Paths being read by active workers
are protected from eviction. A separate discovery journal protects completed
successes during recovery. Job IDs are reserved atomically before dispatch.

Snapshots currently restore by replaying original game ticks, not by copying a VM
image. Late-game restores can be expensive. Workers are persistent, but search
speed is not assumed to match emulator systems with instant snapshots. The fixed
search budget is deliberately retained until the approach demonstrates success.

The search can be gracefully stopped and resumed with the same `search` command,
configuration and source files. Its RNG state, archive and unique job counter are
saved. In-flight branches may be discarded on stop/crash. Already completed or
budget-exhausted searches do not silently start another search budget.

## Neural training

The model is the v4 semantic candidate scorer: 80→32→1 actor and 32→64→1 critic.
Behavior cloning uses legal-action log likelihood; the critic learns actual
return-to-go along the self-discovered trajectories. There are no imported weights.
One complete search-seed trajectory is reserved for choosing the best model by
validation log likelihood. Those internal validation seeds are not the acceptance
seeds. Up to nine workers replay training paths in parallel; the small neural
optimizer uses one CPU thread. Fit is capped at 30 epochs or five optimization
minutes, plus bounded replay time.

Search success does not imply neural-policy success. Training loss does not imply
spore production. Only independent simulator evaluation can unlock the long run.
The existing gate also verifies the accepted model checksum and runtime identity
before PPO continuation.

## Outputs

- `pipeline.json`: phase, PIDs, rejection reason, whether a long run started.
- `search/status.json`: jobs, restored branches, archive size, discoveries.
- `search/archive.json`: resumable coordinator state and archive references.
- `search/states/`: compressed, checksummed game snapshots.
- `search/discoveries.json`: successful self-generated trajectories only.
- `fit/dataset.json`: provenance and fresh-replay verification for each dataset.
- `fit/status.json`, `fit/model.zip`: supervised learning metrics and selected model.
- `preflight.json`, `gate.json`: actual learned/random outcomes on fresh seeds.
- `long-run/`: created only after the final acceptance gate passes.

The detached pipeline requires no Codex/LLM monitoring. Timeouts clean up process
groups, including simulator descendants. SIGTERM stops the active phase; no
automatic retry or larger experiment occurs after rejection.

## Verification

```sh
/usr/bin/sandbox-exec -f headless/rl/offline.sb \
  .venv-rl/bin/python -m unittest headless.rl_v5.test_archive \
  headless.rl_v4.test_training.Tests.test_long_run_gate_rejects_failures_incomplete_and_easy_goal_counts -v
```

Tests cover exact state replay and alternate branches, immutable archive content,
checksum/source rejection, root preservation, solved-seed exclusion, rejection of
unsuccessful/falsified demonstration summaries, neural gradient/save/load, and
search stop/resume with persistent job IDs. A separate nine-worker smoke run checks
concurrent archive expansion. These are infrastructure checks, not claims that
search or the neural policy has already produced spores.
