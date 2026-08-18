# Go neural deployment

This document begins after `go:promote --apply` installs a full-f32 champion.
Training and promotion are documented in [`README.md`](README.md); derivative
work never changes champion identity.

## Production selectors

`GO_PROFILE_CANDIDATE_LIMITS` and `GO_PROFILE_DEEP_SEARCH` in
`shared/strategy/go/neural/engine.ts` are shared by live play and arenas.

| Profile | Contract |
|---|---|
| `daemon19` | Strict K=1 policy-only. One behavior-conditioned policy dispatch; no post-response value dispatch. |
| `small5` | K=4 roots, exact White replies, follow-up K=3 with one timing-uncertainty tick, then round-two post-reply value comparison. |

Small5 ranks wins first, then loss-penalized Black Power per total turn, then
fewer turns. It never values or selects from the greedy post-Black board.

## Stages

1. **Champion:** immutable `go-ai/<profile>-champion.model`, installed only by
   promotion and identified by full-f32 SHA-256.
2. **Static export:** `bun run go:export` creates
   `shared/strategy/go/neural/models/<profile>.ts`. Dense rows use q8 weights
   with f16 biases where their golden gate permits it. The auxiliary response
   branch is omitted because TypeScript resolves it exactly.
3. **Optional derivative:** a champion-SHA-bound transformed checkpoint. It is
   not a champion and must pass its own parity, golden, and paired arena gates.

Current champion hashes and payloads are in [`BASELINES.md`](BASELINES.md).

## Required gates

```sh
bun run go:export
bun run go:golden
bun run go:gpu
bun run go:selector:audit
```

The golden fixture comes from the exact full-f32 authority being exported. The
browser evaluates the generated WGSL artifact. A derivative install additionally
requires exact traced decision comparison and a fresh paired production arena.
All operations are transactional; a failed gate restores the prior module.

Every generated module records the champion SHA, encoded payload SHA, topology,
and any derivative binding. A new champion invalidates the old derivative and
requires a fresh export/gate sequence.

## Current optional derivatives

- daemon19 `strip-neutral-value-v1`: removes the provably zero value tensors
  from the strict-K=1 artifact. The exporter refuses the transform if the head
  is nonzero, and the resulting runtime fails loudly if value evaluation is
  requested.
- Small5 `structured-distill-v1`: freezes the trunk/proposal path and recovers a
  smaller value path against the installed champion. Its model is retained
  under `go-ai/derivatives/` and is valid only for the champion SHA recorded in
  its summary.
- daemon19 `policy-distill-strip-v1`: a distilled smaller student of the
  policy-only champion, deployed without a value head. The Small5 proof does
  not apply to this profile — it distils the value path, and this champion's
  value head is exactly zero — so `go:compress:v9 --profile daemon19` runs a
  policy lane instead: plain actor corpora (the teacher supplies the labels by
  being run on each position), KL over the legal moves, the student's value
  head held at zero so the same lossless strip applies to it, and a gate on
  held-out argmax agreement, which is the only quantity a strict-K=1
  deployment consumes. Being lossy, it is gated like any lossy transform:
  reported parity, a regenerated golden fixture, and a lexicographic paired
  arena it must not lose.

Derivatives are owned by post-training polish. They are not warm starts or
promotion candidates.

## Playbook composition

The certified Small5 playbook is consulted before neural fallback. Its entries
are opponent/behavior-specific exploit proofs, not general policy labels: a
line is a *chain* of decisions whose win guarantee holds only while every one
of them is reproduced.

Residual stripping is therefore **line-safe** and bound to the deployed model
SHA. An entry is dropped only when the deployed production decision selects the
certified action exactly, at both proven dispatch ticks. The successor is then
the certified successor by construction, so no line is interrupted and nothing
cascades. Unreachable states (no path from any root) are dropped as well.

Outcome-based pruning — dropping an entry because the network's own
continuation still won some sampled rollouts — is unsafe and available only
behind `--outcome-prune` for size experiments. A certificate's guarantee is
"wins under every timing and tie-break draw", and no number of samples
establishes that; each wrong prune additionally cascades its followups away,
so the line has nothing left to fall back on.

Measured 2026-08-17 on one 192-game Illuminati certified-root corpus, all
against the same unpruned baseline of 192/192:

| Build | Wins | Certified turns/game | Packed |
|---|---:|---:|---:|
| unpruned generation output | 192/192 | 20.8 | 3.87 MB |
| line-safe strip | 192/192 | 17.7 | 3.61 MB |
| + outcome prune, 4 draws, pure-neural counterfactual | 128/192 | 2.0 | 3.59 MB |
| + outcome prune, 1 draw, playbook-assisted counterfactual | 127/192 | 1.8 | 2.53 MB |

Strengthening the counterfactual (playbook-free) and replaying four draws
changed nothing material: 64 guaranteed wins for 19 KB. Aggressive pruning of
one corpus barely moves the packed size anyway, because the size lives in the
five larger corpora.

The alignment credit is what makes stripping work at all. It is part of an
entry's lookup key, so a runtime that zeroes it on a neural turn strands every
later entry of a line whose stripped move the network just reproduced (183/192
in the same corpus). Every combined runtime therefore spends exactly one board
of credit per turn regardless of who chose the move: `sim/go-combined-arena.ts`,
`tools/combined-standalone/main.ts`, and `game/lib/features/remaining.ts`.

```sh
bun run go:playbook:residual
bun run go:playbook:pack
bun run go:combined:arena --unrouted-baseline
bun run go:playbook:install     # embeds it into the V9 worker
bun run go:combined:standalone
```

A miss falls through to the production neural selector, and the playbook is
consulted again on the next turn. Rebuild and revalidate the residual whenever
the champion or deployed derivative changes.

`go:combined:arena --unrouted-baseline` is the gate. Certified roots are a
biased subpopulation of the phase ring, so the routed arms must be read against
`neuralUnrouted` (the neural baseline of ordinary play) rather than against
`neuralOnly` at the same roots — on Illuminati the deployed net scores 75.5%
unrouted but only 45.3% at certified roots, so a routed build that recovers
merely to 66% is a regression, not a win. `--original-playbook` re-runs the
identical corpus against the unpruned generation output; the stripped build
must match its wins.

## Invariants

- Champion files are immutable outside `go:promote --apply`.
- Training never starts from a lossy derivative.
- Arena seeds are burned before evaluation in `promotion-seeds.json`.
- Live play and arenas resolve the same selector configuration.
- K=1 daemon19 cannot silently invoke a value head.
- Small5 value evaluation receives only post-White-response boards.
- No correctness gate is weakened to reduce payload size.
