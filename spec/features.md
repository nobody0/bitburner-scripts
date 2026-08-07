# Features

A **feature** is one optimization problem that can be attacked in isolation:
its own state, its own objective, its own simulator model. Features rejoin
each other only through shared money and time, which is what makes the
composed "beat this BitNode" problem tractable — solve each separately, then
compose under the active node's multipliers.

The list is derived from the BitNodes for a reason: each node picks one
feature, multiplies it, and asks you to win the game with it. That makes the
node roster the game's own statement of where the separable problems are.

One feature = one entry in `shared/features/registry.ts` + at least one topic
in `shared/telemetry/topics/` + one probe in `game/lib/probes/` + one tab in
`ui/app/tabs/`. `tests/features.test.ts` enforces that the four stay in sync.

## The roster

| Feature | Tab | BitNode theme | Unlock gate (RAM) |
|---|---|---|---|
| `progression` | BitNode | BN12 The Recursion | always |
| `hacking` | Hacking | BN1 Source Genesis, BN5 Artificial Intelligence | always |
| `factions` | Factions | BN4 The Singularity | BN4 or SF4 |
| `career` | Career | BN11 The Big Crash | always |
| `hacknet` | Hacknet | BN9 Hacktocracy | always |
| `stock` | Stocks | BN8 Ghost of Wall Street | `stock.hasWseAccount()` — 0.05 GB |
| `gang` | Gang | BN2 Rise of the Underworld | `gang.inGang()` — **0 GB** |
| `corp` | Corp | BN3 Corporatocracy | `corporation.hasCorporation()` — **0 GB** |
| `bladeburner` | Bladeburner | BN6, BN7 Bladeburners | `bladeburner.inBladeburner()` — **0 GB** |
| `sleeves` | Sleeves | BN10 Digital Carbon | BN10 or SF10 |
| `go` | Go | BN14 IPvGO Subnet Takeover | `go.getGameState()` — **0 GB** |
| `stanek` | Stanek | BN13 They're lunatics | BN13 or SF13 |
| `dnet` | Darknet | BN15 The Secrets of the Dark Net | BN15 or SF15 |
| `side` | Side | — | always |

Notes on the boundaries, since several are judgement calls:

- **Grafting** lives inside `factions`: it is another way to acquire the same
  augmentations, not a separate objective. It is gated by BN10/SF10 rather
  than SF4, so its probe section carries its own try/catch.
- **Karma** lives inside `career` because it is a *precondition* other
  features wait on — BN2's gang needs -54,000 of it.
- **Coding contracts and infiltration** share `side`: universal income with no
  BitNode of their own. The casino belongs here conceptually but exposes no
  ns API (it is DOM-driven), so `Feature.api` records that and the panel says
  so rather than waiting forever.
- **BN1** is themed by `hacking` — it unlocks nothing else. **BN12** is themed
  by `progression`, being the node about the reset loop itself.

## Capabilities

`shared/features/unlock.ts` turns the gate readings into a
`Record<FeatureId, "yes" | "no" | "unknown">` plus a human reason. The three
states are distinct on purpose:

- `yes` — play it, and expect telemetry.
- `no` — locked; the tab renders the reason and the feature's problem
  statement, which is a more useful screen than an empty one.
- `unknown` — the gate has not run (RAM, or the call threw). Never rendered as
  locked, because "we have not looked" and "you cannot" are different facts.

## Probing

The read side is `game/lib/probes/`, scheduled by `game/lib/probe-runner.ts`.
Three cost tiers, because home RAM is the binding constraint — the heap hands
the dispatcher everything above `HOME_RESERVE_GB`:

1. **Local** (`probes/local.ts`) — derived from the sweep snapshot
   (`ns.getPlayer`, the servers map). No ns call, no dodge, always runs. Karma,
   skills, joined factions and fleet totals live here, so those panels are
   never empty regardless of budget.
2. **Gates** (`probes/gates.ts`) — one dodge, ~1.1 GB, every sweep. Every
   unlock test the game offers is free or nearly so, and `ns.getResetInfo` at
   1 GB fills the whole BitNode tab. Cheapest high-value probe we have.
3. **Dodged** (`probes/dodged.ts`) — everything else, split into `core` and
   detail tiers per feature. The runner prices each with
   `ns.getFunctionRamCost` (0 GB, and it already folds in the singularity
   16/4/1 multiplier), packs what fits the current budget into one stub, and
   emits `probe.skipped {id, cost, budget}` for the rest. A panel that stays
   empty says why.

Rules for probe bodies:

- **Bracket notation on the stub's own ns** (`stubNs["gang"]["inGang"]()`), or
  the static parser charges `start.js` and the dodge saves nothing.
- **Guard every call that can throw.** `ns.gang.*`, `ns.bladeburner.*`,
  `ns.grafting.*`, `ns.stock.getPosition` and `ns.getBitNodeMultipliers` throw
  rather than returning empty when unavailable. The runner isolates each probe
  from its batch-mates; a probe must isolate any sub-API gated differently
  from its own `requires`.
- **Cadences must be plain literals.** `everyMs: 2 * MINUTE` defeats esbuild's
  purity analysis and pins the whole probe object into `--perf` bundles.
  `tests/features.test.ts` greps for this.
- **`methods` must name real ns functions.** A typo makes
  `getFunctionRamCost` throw, the runner guess a price, and the probe quietly
  never run. The test checks every name against the type definitions.

## The simulator

Nothing in `sim/` models a non-hacking feature yet. `Feature.problem` is the
placeholder contract: it states, in one line, the question a future
`sim/features/<id>.ts` has to answer. The composed BitNode-level simulation is
the point of splitting them this way.
