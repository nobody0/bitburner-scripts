# Bitburner IPvGO neural trainer

This subtree owns the native Go environment, V9 training, teacher-data
composition, full-f32 checkpoints, and champion promotion. Production inference
is shared with `shared/strategy/go/neural/`; certified opponent-exploit data is
generated under `ipvgobruteforce/`.

Start with [`TRAINING_CHECKPOINT.md`](TRAINING_CHECKPOINT.md). It is the single
restart document for current champions, retained corpora, live candidates, and
the next bounded experiment. Runtime evidence is in
[`BASELINES.md`](BASELINES.md), CUDA transport in
[`MAC_TO_WINDOWS_HANDOFF.md`](MAC_TO_WINDOWS_HANDOFF.md), and post-promotion
handling in [`DEPLOYMENT.md`](DEPLOYMENT.md).

## Objective

Train a student that eventually exceeds all three teachers:

- **KataGo** supplies generally strong Go actions. It does not understand the
  deterministic Bitburner opponent exploit.
- **Certified/handcrafted playbooks** supply opponent- and seed-specific bait
  selected by completed Power per total turn. These moves are often bad Go and
  are authoritative only with the exact behavior input that made them safe.
- **The installed champion** retains neural discoveries and supplies reachable
  student states. Champion disagreement with KataGo can also indicate an
  opponent exploit; it is evidence to evaluate, not automatic truth.

Promotion is lexicographic: wins first, then loss-penalized Black Power per
total turn on an exact win tie, then fewer turns. The live win-streak bonus is
not an input; placing win probability first captures its nonlinear value.

## Production contracts

| Profile | Selection contract |
|---|---|
| `daemon19` | Strict K=1. The exact behavior-conditioned policy chooses one legal action; the value head is not consulted. |
| `small5` | K=4 root shortlist, exact White reply for every finalist, then the production round-two finalizer. |

A Black action is never valued on the greedy board immediately after Black
plays. Candidate comparison begins only after the exact predicted White reply.
The rules engine remains authoritative for legality, superko, passes, terminal
state, timing, and opponent response.

## V9 inputs and outputs

V9 combines a full-resolution residual trunk with a pooled whole-board
correction. The maintained tactical profile receives Black, White, legal, and
exact liberty/capture/self-atari/connection planes plus the semantic opponent
behavior vector for the upcoming White decision. It does not receive raw
opponent identity or a seed integer.

The checkpoint can emit:

- legal-action proposal logits;
- an auxiliary opponent-response branch prediction used during training;
- post-reply win probability, terminal loss-penalized Black Power, and
  remaining turns.

Only outputs used by a profile's production contract affect live selection.
The auxiliary branch is stripped at export because TypeScript resolves the
actual branch exactly.

## Data invariants

- Every record identifies its teacher authority and exact environment/timing
  provenance.
- Playbook actions stay coupled to behavior features; they are not converted
  into unconditional board labels.
- KataGo actor labels do not create KataGo value targets.
- Terminal values come only from completed continuations.
- Related routes, paired teacher environments, and identical f32 neural inputs
  belong to one split component.
- A retained corpus must validate with zero proposal/value split overlap,
  semantic duplicates, errors, and warnings.

Compose and validate retained snapshots with:

```sh
bun run go:compose:corpus -- --output OUTPUT.jsonl.gz INPUT.jsonl.gz [...]
bun run go:validate:corpus -- OUTPUT.jsonl.gz
```

Do not repair an incompatible corpus in place. Regenerate it under the current
timing/encoding contract and publish a new immutable component split.

## Training and promotion

Python owns replay, optimization, losses, checkpoints, and numerical parity.
C++ owns exhaustive environments and exact replies. TypeScript owns certified
exports, WebGPU inference, and promotion arenas.

```sh
bun run go:train:v9 -- --help
bun run go:screen:v9 -- --help
bun run go:promote -- --help
```

Held-out actor/ranking metrics are diagnostics. A candidate advances only when
the theory-specific diagnostic moves in the intended direction and a fresh
production WebGPU arena improves. Promotion uses unused playtime, handicap,
and defense streams recorded in `promotion-seeds.json`; failed or interrupted
gates remain burned.

Apply gates require at least 2,048 games per opponent for Small5 and 512 games
for daemon19. `go:promote --apply` is the only operation allowed to replace a
champion model.

## Persistent evidence direction

The correction book is an append-only, model-independent graph. Exact
state/rule edges survive model generations; logits, chosen actions, evaluator
versions, continuation results, and confidence are versioned observations.
When model and book disagree, evaluate both branches with identical future
timing/defense streams and comparable budgets. Keep the worse branch and its
recovery states. Export immutable snapshots and prioritize new evidence by
approximate reach probability times confidence-adjusted regret.

Growing this graph does not weaken the promotion contract: each increment must
still beat a matched control and a fresh arena.

## Verification

Before handing off a candidate or changing a champion:

```sh
bun run typecheck
bun test
go-ai/.venv-gpu/bin/python -m pytest go-ai/gpu
```

Then run C++ parity, export/golden checks, and the production WebGPU gate in the
order documented by [`DEPLOYMENT.md`](DEPLOYMENT.md).
