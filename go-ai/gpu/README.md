# Batched value replay

This directory contains the accelerator-facing half of training. It preserves
the v7 contract used in Bitburner: the model rates a board after Black's
candidate and White's immediate reply. It does not predict moves and it never
receives a pre-response board.

## Current pipeline

`go_cpp_gpu_env` owns a fixed number of independent complete-game slots. For
each slot and turn it:

1. enumerates every legal Black move, including pass;
2. applies that move with positional-superko history;
3. samples a valid WHRNG phase and runs the exact native Bitburner opponent;
4. applies one valid White reply to every candidate;
5. sends all resulting boards to `train.py` in one batch.

PyTorch keeps all model weights resident on MPS, CUDA, or CPU. It rates the
flattened batch, splits it back into games, and chooses each game's action by
win probability first and expected loss-penalized Power per total round
second. Only the selected position advances. The native sidecar asserts that
the position it advances is byte-identical to the board PyTorch evaluated.

At terminal state, the selected trajectory yields Monte Carlo labels:

- `won` trains the win logit with binary cross entropy;
- `log1p(loss-penalized terminal Power)` trains the Power output;
- `log1p(terminal round - position round)` trains remaining rounds.

Unselected candidates are deliberately not assigned the model's own values.
They affect action selection, but receiving bootstrapped labels without a
completed rollout would merely preserve current errors. Epsilon exploration
creates complete alternative trajectories. The later native `duel`/`trio`
handoff adds teacher, frozen-champion, and KataGo coverage.

`--learning-rates` creates several independently optimized checkpoints from
identical replay minibatches. By default, complete environments are assigned
round-robin to every learner plus an immutable copy of the incoming champion
(`--actor-mode population-retention`). This gives divergent rate paths and the
retention policy honest terminal trajectories while keeping one shared replay
corpus. `population` omits retention and `first` retains the original single-
actor experiment. This separates expensive corpus generation from cheap rate
search without pretending the unplayed alternatives have labels.
For multi-stage research lineages, `--retention-model` separates that immutable
actor from `--init`, matching the native population trainer. This prevents an
unpromoted initialization candidate from silently replacing official champion
coverage in the replay population.

Replay sampling defaults to `uniform`. `opponent` balances the six 5x5 enemy
heads, while `outcome` alternates examples from winning and losing terminal
trajectories when both exist. Controlled experiments found both alternatives
worse than uniform replay; they remain diagnostic options. Outcome balancing
changes only sampling frequency: all three labels remain the exact native
terminal result, and promotion still uses the ordinary unweighted fixed-corpus
gate.

## Exactness boundary

The current GPU code contains only the neural value function. The branch-heavy
Go rules and opponent remain in C++, and therefore inherit
`go_cpp_opponent_parity`, which differentially tests the pinned upstream game.
The PyTorch implementation is checked against `go_cpp_oracle value` before
training and after every checkpoint write.

Moving the opponent itself to the accelerator is possible, but it is a second
kernel rather than part of the neural network. Its natural shape is one GPU
lane per post-Black candidate, each running the same fixed opponent program.
The input must include board cells, the White legal mask derived from complete
superko history, opponent identity, pass count, and WHRNG phase. The output is
the chosen White move or post-response board.

For Metal portability, WHRNG must not rely on unavailable float64 arithmetic.
The 200 ms seed grid makes it exactly integer-representable: store each
Wichmann-Hill state multiplied by five, update it modulo `5 * 30269`,
`5 * 30307`, and `5 * 30323`, and compare the resulting rational numerator
against branch thresholds in int64. The common denominator and all products
fit in signed 64 bits. Board analysis can likewise use fixed-size integer
arrays and bounded flood-fill iterations. No approximate neural substitute is
acceptable for this kernel.

A GPU opponent is eligible to replace the sidecar implementation only after
it matches the native reply set, branch, pass behavior, and resulting board on
the full reachable parity corpus for every faction and both board profiles.
Until then, the hybrid sidecar is the fidelity oracle.

## Handoff and promotion

An accelerator checkpoint is never installed directly because its training
metrics are on-policy and therefore not a promotion gate. Cheap unseen native
screens select a wall-clock checkpoint. That checkpoint becomes
`INIT_MODEL` for a fresh CPU `duel` or `trio` population, while the official
champion is passed separately as `RETENTION_MODEL`. The original GPU
checkpoint remains a finalist if fine-tuning does not improve it.

Promotion still requires at least 4,800 unseen balanced small5 games and an
independent confirmation corpus. World Daemon uses its separately documented
fixed-corpus ladder. Only `go:promote --apply` may replace a champion; it also
refreshes the runtime export and golden vectors.
