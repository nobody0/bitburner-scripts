# Route legs

The speedrun route, cut into benchable legs. A **leg** is **one BitNode
completion**. `BITNODE_SPEEDRUN_PLAN` milestones are shorthand — `{node: 4,
level: 3}` means "complete BN4 three times" — so the derivation decomposes
each milestone into its individual completions: `bn4.1`, `bn4.2`, `bn4.3`,
the run's first three completed BitNodes. A later milestone decomposes only
into the levels still missing — `14.3` after `14.1` yields `bn14.2` and
`bn14.3`, never `.1`–`.3` unconditionally. The table's *milestone* column
shows which plan entry each completion belongs to. This document ties the
completion order ([`speedrun-benchmark.md`](speedrun-benchmark.md)) to the
benches that measure and improve each leg. It is generated — see
**Regenerating** below — so it cannot drift from the code.

Derivation: `sim/route-legs.ts` (`deriveRouteLegs`).
Bench profiles: `sim/profiles.ts` (`routeLegProfiles`). Measured
exits: `sim/tests/baselines/route-legs.json`. Per-node trajectories, including
the open defects a leg is currently losing to:
`sim/tests/baselines/bn4.json` (leg 0), `bn1.json`, `bn15.json`.

## Entrance state

- **Source-Files** are fully determined by the route order: leg *i* enters
  holding everything the earlier completions earned — including its own
  node's partial level mid-milestone (`bn4.2` enters BN4 owning SF4.1, and
  the profile also sets `sourceFileLevel` so the node's own multipliers
  escalate the way a real re-entry does). Nothing is injected anywhere on
  this route — leg 0 (`bn4.1`) is fresh BN4, where Singularity is
  node-native.
- **Features** are never restricted on a route leg. Every feature naturally
  unlocked by the entrance runs and probes normally. `--only` and profile
  feature selection are reserved for `feature-scenario` experiments; an
  unmodeled full-surface call invalidates the leg instead of being masked.
- **Intelligence** is not derivable from the order alone: it is whatever the
  previous leg actually finished with. A leg's entrance intelligence therefore
  prefers the **measured exit** of the leg before it (recorded in the chain
  ledger, `sim/tests/baselines/route-legs.json`, only from observed
  goal-reaching runs) and falls back to a placeholder **estimate**: 0 through
  the `bn5.1` leg (installs zero intelligence without owned SF5), then
  +10 per completion. Route-leg sim runs print
  `exit intelligence: <n>` and persist it in the `sim.result` record
  (`strategy.actualSkills.intelligence`) so the ledger can be filled leg by
  leg. Updating a leg's measured exit changes every downstream entrance — and
  its scenario fingerprint — by design; re-measure downstream legs in order.

## Bench semantics

- One bench measures exactly one leg: **enter the node holding the derived
  state and reach the destruction that earns this leg's level** (`bn:<node>`
  goal), which is the run's first destruction from that entrance. Because a
  leg is a single completion, nothing about a leg is unbenchable — a
  mid-milestone leg like `bn4.2` is just a run whose entrance carries the
  partial SF4.1 and `sourceFileLevel: 1`.
- A leg does not restrict its surface at all: it schedules the complete
  controller surface and fails loudly on any gap it meets, so an unmodeled
  call invalidates the leg rather than being masked. What is filtered is which
  legs get PUBLISHED — `COVERED_ROUTE_NODES` (`sim/profiles.ts`) lists the
  nodes whose defining mechanics the simulator models, and only their legs get
  a bench profile. Owning an unmodeled node's Source-File is fine, since
  `applySourceFile` is only multipliers; it is PLAYING that node that is not
  modeled.
- Legs are covered by generated `bitnode-route` profiles named
  `leg-bn<node>.<level>` on route id `all-sf3-bn4-first`, for every node whose
  defining systems the sim models. **Running an entire BitNode IS the
  speedrun**, so there is no separate class of full-node benchmark: the legs
  are it. The former `bn1-full`, `bn8-full` and `bn15-full` merged into
  `leg-bn1.1`, `leg-bn8.1` and `leg-bn15.1` — `bn1-full`'s entrance was
  already identical, while the other two now enter holding the Source-Files
  the route earns before them, so their old measurements are archived rather
  than carried (`sim/tests/baselines/bn15.json`).
- What sits beside the legs is only the **feature-scenario** fixtures (jit,
  dnet-lab, the stock ladder, the progression and manipulation pairs): they
  ask a narrow question about one feature and can never be promoted into
  route evidence.
- Completing a node requires lifting the operator hold on
  `destroyW0r1dD43m0n`. It stays held in the live game, where the boundary is
  one-way; `sim/run.ts` lifts it for every `bitnode-route` run because the
  leg's goal IS the destruction, and `GameRunOptions.allowBitNodeCompletion`
  restores the previous value when the run ends.
- Chained legs run with a `chained` entrance identity (never `fresh`), so a
  granted entrance can never masquerade as a cold start in ledgers. The
  harness's declared SF4.3 automation allowance still applies uniformly and is
  recorded in `sim.meta`; on this route it is redundant inside BN4
  (node-native Singularity) and subsumed from `bn1.1` on (the entrance
  carries the SF4.3 earned across the first three legs).
- Legs describe the **intended full route**, not the subset the controller can
  walk today. `DISABLED_BITNODES` is a statement about controller readiness,
  so entrances accumulate through disabled milestones too: `leg-bn8.1` enters
  holding SF2.3 even while BN2 is disabled, and a live run at that point in
  the route would differ because it skips those milestones. That is
  deliberate — the alternative would silently shift every later leg's entrance
  each time a controller lands, invalidating the measurements taken before it.
  A leg's entrance changes only when the ROUTE changes.

## The legs

<!-- route-legs:begin -->
| # | leg | milestone | entrance Source-Files | int (source) | enabled | bench profile | measured exit int |
|---:|---|---|---|---|---|---|---|
| 0 | `bn4.1` | 4.3 | — | 0 (estimated) | yes | `leg-bn4.1` | — |
| 1 | `bn4.2` | 4.3 | 4.1 | 0 (estimated) | yes | `leg-bn4.2` | — |
| 2 | `bn4.3` | 4.3 | 4.2 | 0 (estimated) | yes | `leg-bn4.3` | — |
| 3 | `bn1.1` | 1.3 | 4.3 | 0 (estimated) | yes | `leg-bn1.1` | — |
| 4 | `bn1.2` | 1.3 | 1.1, 4.3 | 0 (estimated) | yes | `leg-bn1.2` | — |
| 5 | `bn1.3` | 1.3 | 1.2, 4.3 | 0 (estimated) | yes | `leg-bn1.3` | — |
| 6 | `bn15.1` | 15.3 | 1.3, 4.3 | 0 (estimated) | yes | `leg-bn15.1` | — |
| 7 | `bn15.2` | 15.3 | 1.3, 4.3, 15.1 | 0 (estimated) | yes | `leg-bn15.2` | — |
| 8 | `bn15.3` | 15.3 | 1.3, 4.3, 15.2 | 0 (estimated) | yes | `leg-bn15.3` | — |
| 9 | `bn14.1` | 14.1 | 1.3, 4.3, 15.3 | 0 (estimated) | yes | `leg-bn14.1` | — |
| 10 | `bn5.1` | 5.1 | 1.3, 4.3, 14.1, 15.3 | 0 (estimated) | yes | `leg-bn5.1` | — |
| 11 | `bn2.1` | 2.3 | 1.3, 4.3, 5.1, 14.1, 15.3 | 10 (estimated) | no | — | — |
| 12 | `bn2.2` | 2.3 | 1.3, 2.1, 4.3, 5.1, 14.1, 15.3 | 20 (estimated) | no | — | — |
| 13 | `bn2.3` | 2.3 | 1.3, 2.2, 4.3, 5.1, 14.1, 15.3 | 30 (estimated) | no | — | — |
| 14 | `bn14.2` | 14.3 | 1.3, 2.3, 4.3, 5.1, 14.1, 15.3 | 40 (estimated) | yes | `leg-bn14.2` | — |
| 15 | `bn14.3` | 14.3 | 1.3, 2.3, 4.3, 5.1, 14.2, 15.3 | 50 (estimated) | yes | `leg-bn14.3` | — |
| 16 | `bn5.2` | 5.3 | 1.3, 2.3, 4.3, 5.1, 14.3, 15.3 | 60 (estimated) | yes | `leg-bn5.2` | — |
| 17 | `bn5.3` | 5.3 | 1.3, 2.3, 4.3, 5.2, 14.3, 15.3 | 70 (estimated) | yes | `leg-bn5.3` | — |
| 18 | `bn12.1` | 12.3 | 1.3, 2.3, 4.3, 5.3, 14.3, 15.3 | 80 (estimated) | yes | — | — |
| 19 | `bn12.2` | 12.3 | 1.3, 2.3, 4.3, 5.3, 12.1, 14.3, 15.3 | 90 (estimated) | yes | — | — |
| 20 | `bn12.3` | 12.3 | 1.3, 2.3, 4.3, 5.3, 12.2, 14.3, 15.3 | 100 (estimated) | yes | — | — |
| 21 | `bn8.1` | 8.3 | 1.3, 2.3, 4.3, 5.3, 12.3, 14.3, 15.3 | 110 (estimated) | no | `leg-bn8.1` | — |
| 22 | `bn8.2` | 8.3 | 1.3, 2.3, 4.3, 5.3, 8.1, 12.3, 14.3, 15.3 | 120 (estimated) | no | `leg-bn8.2` | — |
| 23 | `bn8.3` | 8.3 | 1.3, 2.3, 4.3, 5.3, 8.2, 12.3, 14.3, 15.3 | 130 (estimated) | no | `leg-bn8.3` | — |
| 24 | `bn10.1` | 10.3 | 1.3, 2.3, 4.3, 5.3, 8.3, 12.3, 14.3, 15.3 | 140 (estimated) | no | — | — |
| 25 | `bn10.2` | 10.3 | 1.3, 2.3, 4.3, 5.3, 8.3, 10.1, 12.3, 14.3, 15.3 | 150 (estimated) | no | — | — |
| 26 | `bn10.3` | 10.3 | 1.3, 2.3, 4.3, 5.3, 8.3, 10.2, 12.3, 14.3, 15.3 | 160 (estimated) | no | — | — |
| 27 | `bn9.1` | 9.3 | 1.3, 2.3, 4.3, 5.3, 8.3, 10.3, 12.3, 14.3, 15.3 | 170 (estimated) | no | — | — |
| 28 | `bn9.2` | 9.3 | 1.3, 2.3, 4.3, 5.3, 8.3, 9.1, 10.3, 12.3, 14.3, 15.3 | 180 (estimated) | no | — | — |
| 29 | `bn9.3` | 9.3 | 1.3, 2.3, 4.3, 5.3, 8.3, 9.2, 10.3, 12.3, 14.3, 15.3 | 190 (estimated) | no | — | — |
| 30 | `bn13.1` | 13.3 | 1.3, 2.3, 4.3, 5.3, 8.3, 9.3, 10.3, 12.3, 14.3, 15.3 | 200 (estimated) | no | — | — |
| 31 | `bn13.2` | 13.3 | 1.3, 2.3, 4.3, 5.3, 8.3, 9.3, 10.3, 12.3, 13.1, 14.3, 15.3 | 210 (estimated) | no | — | — |
| 32 | `bn13.3` | 13.3 | 1.3, 2.3, 4.3, 5.3, 8.3, 9.3, 10.3, 12.3, 13.2, 14.3, 15.3 | 220 (estimated) | no | — | — |
| 33 | `bn6.1` | 6.3 | 1.3, 2.3, 4.3, 5.3, 8.3, 9.3, 10.3, 12.3, 13.3, 14.3, 15.3 | 230 (estimated) | no | — | — |
| 34 | `bn6.2` | 6.3 | 1.3, 2.3, 4.3, 5.3, 6.1, 8.3, 9.3, 10.3, 12.3, 13.3, 14.3, 15.3 | 240 (estimated) | no | — | — |
| 35 | `bn6.3` | 6.3 | 1.3, 2.3, 4.3, 5.3, 6.2, 8.3, 9.3, 10.3, 12.3, 13.3, 14.3, 15.3 | 250 (estimated) | no | — | — |
| 36 | `bn7.1` | 7.3 | 1.3, 2.3, 4.3, 5.3, 6.3, 8.3, 9.3, 10.3, 12.3, 13.3, 14.3, 15.3 | 260 (estimated) | no | — | — |
| 37 | `bn7.2` | 7.3 | 1.3, 2.3, 4.3, 5.3, 6.3, 7.1, 8.3, 9.3, 10.3, 12.3, 13.3, 14.3, 15.3 | 270 (estimated) | no | — | — |
| 38 | `bn7.3` | 7.3 | 1.3, 2.3, 4.3, 5.3, 6.3, 7.2, 8.3, 9.3, 10.3, 12.3, 13.3, 14.3, 15.3 | 280 (estimated) | no | — | — |
| 39 | `bn11.1` | 11.3 | 1.3, 2.3, 4.3, 5.3, 6.3, 7.3, 8.3, 9.3, 10.3, 12.3, 13.3, 14.3, 15.3 | 290 (estimated) | no | — | — |
| 40 | `bn11.2` | 11.3 | 1.3, 2.3, 4.3, 5.3, 6.3, 7.3, 8.3, 9.3, 10.3, 11.1, 12.3, 13.3, 14.3, 15.3 | 300 (estimated) | no | — | — |
| 41 | `bn11.3` | 11.3 | 1.3, 2.3, 4.3, 5.3, 6.3, 7.3, 8.3, 9.3, 10.3, 11.2, 12.3, 13.3, 14.3, 15.3 | 310 (estimated) | no | — | — |
| 42 | `bn3.1` | 3.3 | 1.3, 2.3, 4.3, 5.3, 6.3, 7.3, 8.3, 9.3, 10.3, 11.3, 12.3, 13.3, 14.3, 15.3 | 320 (estimated) | no | — | — |
| 43 | `bn3.2` | 3.3 | 1.3, 2.3, 3.1, 4.3, 5.3, 6.3, 7.3, 8.3, 9.3, 10.3, 11.3, 12.3, 13.3, 14.3, 15.3 | 330 (estimated) | no | — | — |
| 44 | `bn3.3` | 3.3 | 1.3, 2.3, 3.2, 4.3, 5.3, 6.3, 7.3, 8.3, 9.3, 10.3, 11.3, 12.3, 13.3, 14.3, 15.3 | 340 (estimated) | no | — | — |
<!-- route-legs:end -->

## Checkpoints

A leg's entrance is derived, so the checkpoint that starts it is **minted**
rather than captured from a game — `shared/save/encode.ts` writes the save
JSON (the exact inverse of `decode.ts`), `sim/save-mint.ts` builds the
snapshot from a `RouteLeg`, and `tools/mint-leg-save.ts` compresses and
registers it.

```
bun run tools/mint-leg-save.ts bn4.1   # the route's starting checkpoint
bun run bench:sim:leg-bn4.1            # how you actually RUN leg 0
```

Note which command is which. **Minting a leg's checkpoint is not how you run
that leg.** Seeding any run from a save is a reduced surface — see *Minted
saves are checkpoints, not benches* below — so
`--profile leg-bn4.1 --save leg-bn4.1-start` cannot reach `bn:4`: it hits
`unmodeled("subsystem", "augmentation prestige")` the moment the controller
installs, and records a fidelity gap rather than a result. The bench runs from
the leg's synthetic entrance, which is the same state the blob encodes.

`saves/leg-bn4.1-start.json.gz` is committed: the route has a real first
checkpoint, and `tests/save-mint.test.ts` holds it equal to what the
derivation says leg 0 is.

**The chain mints itself.** When a leg run reaches its goal at `valid`
fidelity — the gate is the repository's own `assertPromotableSession` — the
run mints the NEXT leg's checkpoint, writes it beside the run's artifacts and
registers it if the id is free. The entrance's Source-Files come from the
route, never from the completing run's own next-node forecast: the harness
grants SF4.3 to every controller run, so a leg inside BN4 believes it has
already earned the node and points at BN1. Only the intelligence is taken
from the run, because it is the one part of an entrance the order cannot
predict. A registered blob is never overwritten silently — the run prints the
`--force` command instead.

**Minted saves are checkpoints, not benches.** Seeding a run from any save
disables prestige (so `installs:2` is unreachable), disables Go and Stanek,
and forces `scenario: "save-snapshot"`. The benches therefore keep running
from the synthetic entrances above; a minted blob is for custody and lineage.
`save:restore` refuses minted entries outright: they satisfy the simulator's
decoder, but the repo cannot verify the full key set the real game needs
without vendoring upstream `SaveObject.ts`, and restoring overwrites a live
save with no backup.

## Regenerating

```
bun tools/route-legs.ts          # print the table
bun tools/route-legs.ts --write  # splice it into this file
```

`tests/route-legs.test.ts` regenerates the table and fails when the copy above
is stale.
