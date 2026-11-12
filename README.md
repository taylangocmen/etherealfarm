# etherealfarm
Ethereal Farm incremental game

**Training on another Mac? Start with the [Mac handoff and execution guide](headless/HANDOFF.md).**

For multiple CPU workers, see the [parallel training guide](headless/PARALLEL_TRAINING.md).

For neural learning from random weights with no demonstrations, see the
[fully local neural training guide](headless/rl/README.md).
For the shorter revised experiment, see [local curriculum training](headless/rl_v2/README.md).
The latest [resource-to-tree curriculum](headless/rl_v3/README.md) includes a tested
reachable first goal and fixed-horizon paired evaluation.

https://lodev.org/etherealfarm/

This fork also contains an initial local, code-controlled
[headless first-transcension environment](headless/README.md). It reuses the
game rules and runs through Node.js without a browser or external services.
The seven focused tests pass, and the seed-1 scripted player completed its first
transcension in a displayed 6h 25m 45s of game time. See the headless README for the API,
benchmark contract, limitations, and validation command.

The [acceptance-gated local learner](headless/rl_v4/README.md) tests spore production
against a random baseline before permitting a longer run.

For state archives and learning from self-generated successful paths, see
[local archive search](headless/rl_v5/README.md).
