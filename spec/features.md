# Features

A **feature** is one optimization problem that can be attacked in isolation:
its own state, its own objective, its own simulator model. Features rejoin
each other only through shared money and time, which is what makes the
composed "beat this BitNode" problem tractable — solve each separately, then
compose under the active node's multipliers.

The list is derived from the BitNodes for a reason: each node picks one
feature, multiplies it, and asks you to win the game with it. That makes the
node roster the game's own statement of where the separable problems are.

This document describes the feature **machinery**. What the features are
actually *for* — per-BitNode rules, what each feature needs and yields, and how
they depend on each other — lives in [spec/strategy/](strategy/README.md).

One feature = one entry in `shared/features/registry.ts` + at least one topic
in `shared/telemetry/topics/` + one probe in `game/lib/probes/` + one driver in
`game/lib/features/` + one tab in `ui/app/tabs/`. `tests/features.test.ts`
enforces that the five stay in sync.

## The roster

| Feature | Tab | BitNode theme | Unlock gate (RAM) |
|---|---|---|---|
| `progression` | BitNode | BN12 The Recursion | always |
| `hacking` | Hacking | BN1 Source Genesis, BN5 Artificial Intelligence | always |
| `factions` | Factions | BN4 The Singularity | BN4 or SF4 |
| `career` | Career | BN11 The Big Crash | always |
| `hacknet` | Hacknet | BN9 Hacktocracy | always |
| `stock` | Stocks | BN8 Ghost of Wall Street | always |
| `gang` | Gang | BN2 Rise of the Underworld | `gang.inGang()` — **0 GB** |
| `corp` | Corp | BN3 Corporatocracy | `corporation.hasCorporation()` — **0 GB** |
| `bladeburner` | Bladeburner | BN6, BN7 Bladeburners | `bladeburner.inBladeburner()` — **0 GB** |
| `sleeves` | Sleeves | BN10 Digital Carbon | BN10 or SF10 |
| `go` | Go | BN14 IPvGO Subnet Takeover | `go.getGameState()` — **0 GB** |
| `stanek` | Stanek | BN13 They're lunatics | BN13 or SF13 |
| `dnet` | Darknet | BN15 The Secrets of the Dark Net | BN15, SF15, or `DarkscapeNavigator.exe` |
| `side` | Side | — | always |

Notes on the boundaries, since several are judgement calls:

- **Grafting** lives inside `factions`: it is another way to acquire the same
  augmentations, not a separate objective. It is gated by BN10/SF10 rather
  than SF4, so its probe section carries its own try/catch.
- **Karma** lives inside `career` because it is a *precondition* other
  features wait on — BN2's gang needs -54,000 of it.
- **Coding contracts** live in `side`: universal income with no BitNode of its
  own. Infiltration and the casino are intentionally outside the automation
  roster because their gameplay is DOM-driven and has no action API.
- **BN1** is themed by `hacking` — it unlocks nothing else. **BN12** is themed
  by `progression`, being the node about the reset loop itself.
- **`stock` is always playable**, and that is a correction rather than a
  convenience. The market is MONEY-gated: a WSE account costs $200m and the TIX
  API $5b, with no source file and no BitNode requirement — the same shape as
  buying a hacknet node. Gating the feature on `hasWseAccount()` made the
  purchase unreachable, because a driver never runs while its own feature reads
  "no", so nothing could ever buy the thing that would unlock it. The account
  flags now travel as ordinary state on the topic and the driver climbs the
  ladder itself; `restrictions.disable4SData` still tells it when the forecast
  cannot be bought at all. Its probes carry `when` guards so a locked market
  costs one 0.2 GB flag read per minute and nothing else.

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
Four tiers, by what a body is allowed to touch:

1. **Local** (`probes/local.ts`) — derived from the sweep snapshot
   (`ns.getPlayer`, the servers map). No ns call at all, so it always runs.
   Karma, skills, joined factions and fleet totals live here, so those panels
   are never empty.
2. **Direct** (`probes/direct.ts`) — synchronous reads on `start.js`'s own
   `ns`. The runner re-prices every declared method against the live API each
   pass and refuses the call if anything stopped being 0 GB, so an API change
   is reported as drift rather than paid for out of the controller's
   allocation.
3. **Gates** (`probes/gates.ts`) — every unlock test the game offers, once per
   sweep. All of them are free or nearly so, and `ns.getResetInfo` at 1 GB
   fills the whole BitNode tab. Cheapest high-value probe we have — and the
   only one the *controller* cannot run without, since `Capabilities` is what
   gates the feature drivers.
4. **Priced** (`probes/priced.ts`) — everything with a price, split into
   `core` and detail tiers per feature. The body awaits `ctx.nsp(path, ...)`,
   which runs the member on the ns resident (`spec/ns-proxy.md`); nothing here
   is billed to `start.js`.

There is no `methods` table and no budget arithmetic anywhere in this
subsystem any more. The resident prices each member the first time a body
calls it, memoises it, and respawns into a larger allocation when its budget
fills — so the call *is* the price and the two cannot drift apart. That also
retired `SteppedProbe`: a probe body is now plain sequential code. What none of
this fixes is one *indivisible* expensive call: a single
`SingularityFn3` at SF4 level 1 costs 80 GB, which simply raises the floor the
resident's placer has to satisfy before that call runs.

Rules for probe bodies:

- **Name the member as a string path**, never as a property. Bitburner charges
  by member NAME across the whole bundle regardless of the receiver, so
  `ns["gang"]["inGang"]` billed `start.js` exactly as `ns.gang.inGang`
  would; only the string escapes the static parser. The path is typed, so a
  wrong one is a compile error rather than a probe that silently never runs.
- **Guard every call that can throw.** `ns.gang.*`, `ns.bladeburner.*`,
  `ns.grafting.*`, `ns.stock.getPosition` and `ns.getBitNodeMultipliers` throw
  rather than returning empty when unavailable. The runner isolates each probe
  from its neighbours; a probe must isolate any sub-API gated differently from
  its own `requires`.
- **Cadences are plain literals** — house style only, since probes are now
  compiled into every build and nothing tree-shakes. Do not reintroduce a test
  for it.

## Driving

The write side is `game/lib/features/`, scheduled by `game/lib/controller.ts`.
A probe reads one feature's state; a **module** owns everything needed to act
on it.

```ts
interface FeatureModule {
  driver: FeatureDriver;
  reset?(state: GameState): void;    // drop module state AND published topics
  refresh?(ctx: NeedContext): void;  // evaluate store → store, before any act
  claims?(ctx: ClaimContext): Claim[];  // PURE — bids for contended resources
  needs?(ctx: NeedContext): Need[];     // PURE — outcomes wanted from others
}

interface FeatureDriver {
  id: FeatureId;
  everyMs: number;          // plain literal, like a probe cadence
  requires?: FeatureId;     // ticks only while caps.unlocked[requires] === "yes"
  tick(ctx: DriverContext): void | Promise<void>;
}
```

Bundling the four is what lets the controller name no feature. `FEATURE_DRIVERS`
is *derived* from `FEATURE_MODULES` rather than being a second hand-maintained
list, and `onBitNodeReset` walks the registry calling every `reset?.()` instead
of calling `resetHackingState()` directly — so a new feature that caches
anything across a node reset cannot leak it because someone forgot to edit the
loop. `tests/features.test.ts` pins all of this.

### The feature pass — refresh, then act

Five phases, and the ordering is load-bearing:

```
refresh each due module (evaluate → store; progression LAST)
   →  collect needs (pure)  →  collect claims against the completed board (pure)
   →  one arbitration  →  tick each due driver with its own grants + forecasts
```

Needs come first so a feature can bid harder *because* another is blocked on
it. Claims are collected only from modules whose driver is due, so a feature
can never win a grant on a tick it would not run to spend it.

**Refresh** is the evaluation half of a feature: read the store, re-derive the
published digest (including any ETA contributions), write it back — no ns
access. **Tick** is the act half. Splitting them resolves the ordering problem
the endgame decision poses: the route choice needs every feature's enriched
state, and every feature's actions need the chosen route. So each pass
refreshes the due modules first — with `progression`, the meta module,
deliberately ordered last so its route decision reads *this* pass's state —
and then hands every driver `{route, horizons: {install, node}}` in its context
(see `spec/strategy/endgame.md`). Only `progression` implements `refresh`
today; a feature adopts it the moment its evaluation needs to be visible to
others before anyone acts.

`dnet` is the one feature whose work runs somewhere other than `home`: sessions
are per-PID and several of its calls only work from the target host, so it owns
agent entrypoints under `game/dnet/`. Its remote-execution model and the
expiry rule that follows are in [`spec/dnet.md`](dnet.md).

### Cross-feature coordination

Two mechanisms, deliberately distinct, both pure and both rendered:

- **The needs board** (`shared/strategy/needs.ts`) broadcasts a desired
  *outcome and its worth* — never a method. `factions` posts
  `{kind:"karma", target:-45}`; `career` folds the board into objective weights
  and decides for itself whether that is Mugs or Homicides. `gang` later posts
  `{kind:"karma", target:-54000}` the same way, and the two weights *add*,
  because delivering the outcome once unblocks both.
- **The arbiter** (`shared/strategy/arbiter.ts`) allocates the two genuinely
  contended resources: money and the single `Player.currentWork` slot. RAM used
  to be a third, because every dodge bought a transient stub that had to be
  admitted; the ns residents own theirs for the whole run, so there is nothing
  left to contend. The work slot needs pre-emption rules rather than fairness
  ones because
  `ns.singularity.workForFaction` silently *cancels* whatever is running — the
  loser is not delayed, its progress is destroyed.

  It also keeps the **alternatives**. A time claim announces the RATES holding
  the slot would produce — dollars, reputation, experience — and the arbiter
  scores it as `Σ (our rate / the best rate anyone can manage) × what a relative
  increase in that channel is worth`, in BN-seconds off the route
  (`shared/strategy/income.ts`, priced by `ProgressionMarginals`). The band
  lattice survives only for claims that are not a rate at all: the lock on an
  in-flight crime, a mandatory route install, a terminal action. Those always
  outrank a priced bid, and everything else is decided by measurement rather
  than by a constant — which is the point, because "money outranks reputation"
  is true in one node and false in the next.

  That valuation prices a rate held for the rest of the route, so a claimant
  that must **occupy** the slot before it delivers anything is scored on the
  part of the run it leaves behind: `1 - occupied/horizon`, from
  `deliveryFraction` in `shared/strategy/income.ts`. A twenty-minute program
  write is twenty minutes reputation does not accrue, and a write that would
  still be running when the node ends is worth nothing. The discount is applied
  to the resulting value and never to the announced rate — `raiseBest` lifts the
  alternatives table to our own rate, so a multiplier on the rate divides
  straight back out. Only the time still LEFT is charged: the elapsed part is
  sunk, and charging it every pass would mean a write that cannot start can
  never accumulate the progress that would let it start.

Both hang off the `progression` telemetry topic. That is not a feature id, and
deliberately so: they describe the relationships *between* features, so giving
them one would be a category error.

`selectDue(drivers, lastRun, caps, now)` is pure and unit-tested: it is the
whole scheduling rule, and it is where the capability gate is enforced. Two
properties matter.

- **`unknown` never ticks** (see [Capabilities](#capabilities)). Acting on an
  unprobed feature spends a proxied call discovering an API that throws.
- **An unlock is not a wait.** When the gate batch reports a feature moving to
  `yes`, the controller deletes its `featureLastRun` entry so it ticks on the
  next pass instead of serving out a cadence it was never eligible for. A
  feature that changes what the gate reads (the darkscape purchase) raises the
  gate signal (`game/lib/gate-signal.ts`) so the sweep — and therefore the
  unlock — happens on the next pass instead of the 30-second cadence.

`hacking` is the only driver with a 200 ms fallback heartbeat; JIT deadline and
completion wakes service exact HWGW landing windows without waiting another tick.
Everything else is slower by orders of magnitude, which is the reason the
frame schedules by cadence at all rather
than running every driver every pass.

All fourteen are implemented; there is no `inert()` helper any more. `corp` is
implemented to the *strategy* level only and refuses to issue its calls; `dnet`
issues its own on live hosts through the controller/prober/agent pipeline, while
`stepDarknet` stays a pure ranking with no action for a driver to carry out
(`spec/progress.md`, and for dnet's reasons `spec/dnet.md`). Seven have their own
file (`hacking`, `factions`, `career`, `hacknet`, `stock`, `dnet`, `side`) because
they needed more than the common shape; the other seven (`progression`, `gang`,
`corp`, `bladeburner`, `sleeves`, `go`, `stanek`) share
`features/remaining.ts`, which is a statement about their SHAPE — build a view,
call one pure `step*`, execute at most one action per tick — not
about their size. Any of them moves to its own file the moment it needs more.

The network sweep — scan, reclaim, root, deploy, reap, heap resync — lives in
`game/lib/fleet.ts` as an infrastructure module: the shape of a feature
refresh (read the game, write the store), but deliberately not a registry
feature, because a rooted fleet is what every feature spends. Hacking is only
its first customer, so the sweep belongs to none of them, takes no part in
needs/claims arbitration, and the controller runs it first.

### Runtime continuity and prestige

Deployment and game-world reset are independent. Sync deliberately kills every
script and clears controller-owned realm state before `main.js` starts again;
there is no runtime adoption path. A fresh page load likewise bootstraps from
observation. Under a surviving realm, `shared/reset.ts`
classifies the tuple `(currentNode, lastAugReset, lastNodeReset)` as `none`,
`augmentation`, or `bitnode`; BitNode wins because source-file prestige also
advances the augmentation timestamp. Comparing `lastNodeReset` also catches
re-entering the same BitNode, which a node-number comparison cannot.

On augmentation or BitNode prestige everything derived from the world we left
is dropped — the server snapshot, every feature's published topics, the
multiplier cache, the dispatcher ledger and heap, and the realm worker registry
— and the controller rescans and reclaims immediately rather than waiting for
the next sweep.
`reset(state, kind)` takes the store precisely so each module clears its OWN
topics: a per-field delete blacklist in the controller cannot keep up with
what features publish, and a topic that survives the reset is live data from
a dead node (a stale aug list once handed the new node's first endgame route
decision the old run's Red Pill). Progression clears field-level rather than
its whole topic — the gate batch that *detected* the reset has already
written the new node's identity into it.

Two rules that are easy to get backwards:

- **The server snapshot goes too.** The sweep scans *before* the gate batch
  reports the new node, so whether that scan saw the old world or the new one
  depends on when the reset landed. A snapshot that is only probably fresh is
  the same class of bug as a heap describing a dead fleet. Rescan; do not keep
  it to save latency.
- **The realm worker registry is cleared on world reset and clean sync.** In
  both cases every script was killed, so every op id in it is unreportable.
- **`stock`'s self-measured trade ledger is controller-owned state.** It is the
  only record of what the market
  actually earned — the game's own money-sources ledger counts an open
  position's purchase as money gone — and it is republished onto the topic at
  every trade. A clean sync gets a fresh module and therefore a fresh ledger;
  there is intentionally no deployment-continuity exception. World resets call
  `resetStockState` explicitly.

## The simulator

`sim/features/` models are each wired to the real `EngineSubsystems` hook and
each drive a deterministic isolation profile that runs the **real** controller
to a goal. Features without one have pure strategy, a driver and unit tests — so
they are unit-proven, not simulator-proven, and their ns calls report
`unmodeled()` rather than fabricating a value. `spec/simulator.md` is the
authoritative list of which is which.

The composed BitNode-level simulation is the point of splitting them this way.
