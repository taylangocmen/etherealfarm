# Local first-spore learning with an acceptance gate

V4 keeps earlier experiments intact. It adds read-only observations to a separate
copy of the simulator host; original game rules/ticks/actions are unchanged.
All computation runs locally under the existing network-denial sandbox. No
external models, human strategies, scripted actions, demonstrations or old policy
weights enter training. The existing installed PyTorch/SB3 stack is sufficient.

## What changed

The objective is to earn one new spore from a fresh game, with a four-hour game
allowance. The farm does not reset after easy seed milestones. The learner gets
incremental feedback for cumulative seed earnings, current seed production, new
crop unlocks, and newly mature crop types, as well as actual spore progress.
Unlock/maturity credit is one-time; refunds to current stock earn no milestone
reward. Production losses produce negative feedback, so removing productive
plants is no longer indistinguishable from preserving them. Rewards are a proxy;
acceptance uses actual spores and time, not training reward.

The observation now includes public production rates, base crop production,
maturation history, crop functions, upgrade-to-crop links, costs, refund amounts,
and neighboring crop-type counts. These are game facts, not preferred actions or
layouts. The new observation wrapper is tested against the original simulator on
identical action sequences to ensure it does not change dynamics or legal actions.

The neural actor scores legal action candidates using their semantic features and
the farm state. It has a shared 80→32→1 scorer and a 32→64→1 critic. Up to 512 legal
candidates are supported; overflow fails loudly rather than dropping actions.
Initial probability mass is balanced across action types so the number of board
coordinates does not drown out research/wait choices. Greedy selection chooses
the highest-probability type and then its highest-probability candidate. Sampled
selection uses the full masked joint distribution. No action-type priorities are
handwritten. All simulator ticks are preserved at the existing 9.99-second
ordinary cadence, with optional longer waits.

PPO uses random weights, 128-step per-worker rollouts, three epochs, learning rate
3e-4, gamma 1, GAE lambda .995, entropy coefficient .005 and one Torch thread.
The old long run was gracefully stopped before this implementation.

## Unattended fail-closed pipeline

From the repository root, with the existing virtual environment and Node on PATH:

```sh
/usr/bin/sandbox-exec -f headless/rl/offline.sb \
  .venv-rl/bin/python -m headless.rl_v4.pipeline \
  --out headless/training/UNIQUE_EXPERIMENT --pilot-minutes 10
```

1. Train a fresh random-initialized neural policy for at most ten wall minutes
   with nine workers. Save the model, optimizer, all environments and RNG state.
2. Compare that fixed model with a type-balanced random baseline on three fresh
   seeds. Both use identical rules, action space and four-hour game horizons.
   Evaluate sampled and greedy neural action selection. Each mode has a four-minute
   emergency wall limit. Fewer than two successes in either neural mode, or any
   incomplete mode, ends the pipeline without a long run.
3. If the preflight succeeds, evaluate on nine further unused seeds, with a
   ten-minute emergency wall limit per mode. The model is not changed between
   preflight and final acceptance. Acceptance requires:
   - all 27 episodes (sampled, random, greedy) complete;
   - at least 8/9 sampled-policy successes and 6/9 greedy-policy successes;
   - at least three more sampled successes than random, OR at least 20% lower
     mean completion time with failures charged the full horizon, with no fewer
     successes than random.
4. Only a passing gate starts a one-hour nine-worker continuation of that same
   locally trained model, still on the first-spore task. It does not silently
   change the objective to transcension or discard the validated weights.

The full gate recomputes metrics from per-seed outcomes, checks actual earned
spores and the named goal, and requires distinct held-out seeds. The trainer
verifies source/runtime identity and the model checksum before continuation.
The random baseline uses equal probability per legal action type, then uniform
choice among that type's legal candidates. It is not disadvantaged by a different
interface or a shorter game horizon. Seeds used for acceptance are never trained on.

The staged test may take additional minutes beyond the ten-minute pilot. A failed
or timed-out test does **not** trigger a larger or longer experiment. The optional
long run is itself capped at one hour or one million decisions. The pipeline is
code-controlled and needs no LLM supervision. SIGTERM to the pipeline stops its
active child; timeouts/errors clean up the simulator process group. Normal trainer
SIGTERM saves a checkpoint, while forced termination may lose the partial rollout.

## Files and interpretation

- `pipeline.json`: current phase, PID, child PID, and whether long training started.
- `pilot/status.json`, `pilot.log`: bounded training and its milestones/results.
- `preflight.json`, `preflight.log`: three-seed learned/random comparison.
- `gate.json`, `gate.log`: final nine-seed acceptance results and model checksum.
- `long-run/`, `long-run.log`: created only after the gate passes.

A successful code test or nine-worker smoke run is not evidence of learning.
A high training reward is not evidence of spore production. A rejected pipeline
must be reported as rejected, with no automatic retry or inflated success claim.
Longer training remains on first-spore competence; later tree/transcension goals
need separate validated extensions.

## Tests

```sh
/usr/bin/sandbox-exec -f headless/rl/offline.sb \
  .venv-rl/bin/python -m unittest headless.rl_v4.test_training -v
```

Tests cover unchanged simulator dynamics/legality, new observation bounds,
actual weight updates, legal predictions, model roundtrip, exact game replay,
refund-resistant milestone rewards, frozen evaluation slots, and rejection of
incomplete, weak, wrong-goal, or non-improving acceptance results. The local
nine-worker smoke experiment is separate from the first-spore learning test.
