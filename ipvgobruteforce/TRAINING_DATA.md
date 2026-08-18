# Certified V9.5 training data

The certified exporter converts proven Small5 playbook decisions into
behavior-conditioned actor supervision. These actions maximize completed Power
per total turn against a predictable opponent; many are deliberately risky and
are not general Go authority.

## Current source snapshot

Use only the six immutable files matching:

```text
data/training/*-certified-v9.5-epoch2697-v16-absolute-seed-20260821.jsonl.gz
```

Each has a `.summary.json` and `.conflicts.tsv` companion. The retained combined
component split is:

```text
../go-ai/corpora/v9-small5-certified-v16-absolute-seed-component-split-20260821-c48379.jsonl.gz
```

Its SHA-256 is
`8c5c56eb299b727401c1aec7eeefca9b17ee54621f3d50a6e1de5c50e9d850d3`.
It contains 491,708 actor rows, 49,171 held out, and validates with zero input
overlap, duplicates, errors, or warnings.

## Export contract

`arena/export-certified-v9.ts` records the exact board, legal actions,
absolute `playtimeEpoch`, semantic opponent behavior vector, certified action,
opponent, certificate/seed/phase provenance, and route identity.

Absolute epoch is required: later WHRNG draws are not periodic in a modulo
phase. The actor label is valid only with its behavior vector. Raw phase and
seed remain provenance; the network receives the existing semantic behavior
encoding rather than brittle identifiers.

The exporter:

- collapses identical neural inputs with the same action;
- excludes inputs whose retained histories are indistinguishable to V9 but
  demand different actions;
- excludes wait/alignment and terminal nodes;
- emits only legal placement/pass actions;
- does not invent value targets from proof trees.

## Composition

Per-opponent exports are source authority, not independently split training
inputs. Compose all six together so complete routes and shared f32 inputs stay
in one component:

```sh
bun run go:compose:corpus -- \
  --output ../go-ai/corpora/OUTPUT.jsonl.gz \
  data/training/*-v16-absolute-seed-20260821.jsonl.gz
bun run go:validate:corpus -- ../go-ai/corpora/OUTPUT.jsonl.gz
```

Require zero proposal/value overlap, semantic duplicates, errors, and warnings
before retaining the output.

## Training authority

Certified rows teach seed/opponent exploits. Mix them with KataGo or champion
retention so the student does not generalize bait from board geometry alone.
KataGo agreement identifies moves that are plausibly good independent of the
opponent branch, but disagreement does not invalidate a completed certificate.

This snapshot is actor-only. Terminal/ranking records require separately
completed matched continuations and their true rollout author. Never synthesize
terminal Power, remaining turns, or win labels from an unfinished proof node.

## Persistent evidence graph

Future exports append model-independent state/rule edges and versioned
observations. On book/model disagreement, evaluate both branches over identical
future timing streams, keep the worse continuation and recovery states, and
rank expansion by reach probability times confidence-adjusted regret. Publish
immutable component-safe snapshots; do not rewrite this certified source.
