# Feature automation progress

Running record of the thirteen-slice feature build-out: what is done, what
evidence supports it, and what is deferred with the reason. Updated after each
feature.

The acceptance bar for a feature is the full vertical slice:

1. specified from the pinned v3.0.1 source,
2. pure strategy in `shared/strategy/<id>/`, unit-tested,
3. every decision input acquired unconditionally into `GameState`,
4. a real driver module (`driver` + `reset` + `claims` + `needs`), no longer inert,
5. telemetry fields + transition events, `--perf` identical but quieter,
6. a UI tab rendering state, decisions, reasons, blockers and outcomes,
7. a faithful `sim/` model with a deterministic isolation profile that runs the
   **real** controller to a meaningful goal,
8. near-optimality supported by an oracle, a formula, or a measured baseline.

## Status

| # | Feature | Status |
|---|---|---|
| — | reference repo swapped | **done** |
| — | provenance citations repointed | **done** |
| — | hacking audit (4 measured questions) | **done** — 2 closed, 2 open with reasons |
| 0 | groundwork — modules, needs, arbiter, RAM | **done** |
| 0.5 | groundwork — vendor extractors + ground truth | **done** |
| 0.6 | groundwork — sim player/engine/profiles/goals | **done** |
| 1 | factions | **done** |
| 2 | career | **done** |
| 3 | hacknet | **done** |
| 4 | stock | **done** — rebuilt in phase 15; the first version could not place a trade |
| 5 | gang | **done** |
| 6 | corp | **done** |
| 7 | bladeburner | **done** |
| 8 | sleeves | **done** |
| 9 | go | **done** |
| 10 | stanek | **done** |
| 11 | dnet | **done** |
| 12 | side | **done** |
| 13 | progression | **done** — endgame route, install barrier, two-pass arm/execute, and post-install restart are live |
| 14 | endgame route + refresh/act split | **done** — see below |
| 15 | stock rebuild + hack/grow manipulation tie-in | **done** — see below |

## Completed work

### Provenance corrections

The predecessor was misidentified. The reference is now
**`gitlab.com/nobody01/bitburnerscript` branch `2023`** (commit `43e8585`),
which has the faction/augmentation planner, four batchers, an optimizer, a
predictive target simulation and the full reset/BitNode loop. The previous
checkout (`nobody0/bitburner`) was an abandoned rewrite with none of that.

Citations across ~12 files were repointed, and — this is the part that needed
care — designs that came from the abandoned rewrite are now attributed to it
**by name** rather than silently repointed at a file that does not contain them.
Verified by search against the real predecessor:

| Design | Present in `nobody01@2023`? |
|---|---|
| `stubCall` RAM dodger | **yes** — `src/_lib/stub-call.ts` |
| duration-weighted `moneyPerThread` target score | **yes** — `src/_lib/optimizer.ts:123` |
| core bonus in thread accounting | **yes** — `src/_lib/cluster.ts:159` |
| separate worker binary per batch role | **yes** — `src/workers/` |
| slab/clz32 RAM heap | **no** — nowhere in the repo |
| `analyze-profit` / `$/GB/sec` scoring | **no** |
| `PROGRAMS_MAP`, `canRoot`, `watchHuman`, `isUseful` | **no** |
| reservation leak, single-binary worker trick | **no** |

### Phase 0 — groundwork

**0.1 Feature modules.** `FeatureModule { driver, reset?, claims?, needs?,
peakStepGb? }` with a `FEATURE_MODULES` registry; `FEATURE_DRIVERS` is derived
from it so there is one list, not two. The controller's feature pass is now
collect-needs → collect-claims → arbitrate → tick, and `onBitNodeReset` walks
the registry instead of calling `resetHackingState()` by name.

*Evidence:* controlled A/B against the pre-change tree over 3 seeds — the only
differing byte in the entire record stream was the `--label` passed on the CLI.
Phase 0.1 is provably behaviour-neutral. `tests/features.test.ts` pins that
every id has exactly one module, that reset hooks are reached by registry walk,
and that the controller mentions only the two features it is allowed to
(`progression` as the meta layer it schedules last and reads the route from,
`hacking` as the heap owner for dodge placement; the network sweep itself has
since moved to `game/lib/fleet.ts`).

**0.2/0.3 Needs board and arbiter.** Both pure and deterministic.
`shared/strategy/needs.ts` broadcasts desired *outcomes* (`{kind:"karma",
target:-45}`) with a per-kind satisfaction direction — karma counts DOWN, and
getting that backwards is what would make a satisfied gang precondition look
permanently blocking. `shared/strategy/arbiter.ts` allocates money, the single
`Player.currentWork` slot and dodge RAM.

*Bug caught by its own test:* `career:blocking-need` was initially set 5 points
above `factions:work`, which is **less** than `PREEMPT_MARGIN`. The priority
would have been decorative — a blocking need arising while faction work was
already running could never have interrupted it. Now 75 vs 60, with
`tests/arbiter.test.ts` pinning `career:blocking-need > factions:work +
PREEMPT_MARGIN` so it cannot silently regress.

**0.4 RAM funding.** Three mechanisms, in the order of how much they buy:

- **Dodge on fleet hosts.** `dodge(ns, fn, gb, { host })` plus a pure placement
  policy (`shared/ram/placement.ts`): small budgets prefer home for latency,
  large ones take the smallest fleet host that fits so large contiguous blocks
  survive for hack ops. The stub now ships to every rooted host alongside the
  worker.
- **Multi-step probes.** `SteppedProbe` runs one dodge per step, so a probe's
  launch price is the largest **step** rather than the sum of its methods.
  Partial results are kept and the step that did not fit is reported with its
  own price.
- **Feature-aware home reserve.** `shared/ram/reserve.ts`: base plus the largest
  step any *unlocked* feature declares, clamped to 40% of home and never below
  base. A capped reserve is reported as a blocker rather than silently starving
  the feature.

Three correctness details that are easy to get wrong, each pinned by a test:

- `reclaimFleet` now handles **the stub's own host** per-process, not just home.
  Since dodges can land on the fleet, a blanket `killall` there would kill the
  stub doing the killing and hang the dodge until its 10 s watchdog fired —
  every cold boot, non-deterministically, depending only on placement.
- Placement **allocates through the heap** (`Heap.reserveOn`). Without the
  lease a stub occupies RAM the heap still believes is free, and the two
  allocators fight over the same gigabytes, with `ns.exec` returning 0 forever.
- `ns.exec` of the stub **retries** 10× with `sleep(0)` between, from
  `src/_lib/stub-call.ts:11-39`. A transient RAM blip was previously a lost
  probe and a 30 s wait.

*Evidence, and the headline result:* a fresh 8 GB BN1 home previously could not
afford **any** probe — `capabilities` was never emitted and no gated feature
could ever be discovered. `sim/tests/ns.test.ts` used to pin that as a known
defect; it now pins the inverse, with the home-only arithmetic kept as a
separate test so the motivation cannot quietly stop being true. In a live
`earn:1e6` run the gate batch now runs 41 times, time-to-goal is unchanged
(20.6 / 18.2 / 18.2 minutes on seeds 1–3). Manual infiltration is deliberately
outside the probe roster, so it consumes no dodge budget.

*A second bug caught by running it:* `acquireDodge` treated "the heap has never
seen this host" as "cannot place here". The heap is empty on the first sweep, so
every cold-boot probe reported itself skipped at a price the budget plainly
covered. Fixed — an unknown host has no competing reservations, so the lease is
a no-op.

**0.5 Vendor extractors and ground truth.** `tools/vendor.ts` gained two modes.
`extractSymbols` slices any set of named top-level declarations (terminating at
a *column-zero* closer, since every nested one is indented). `extractDataTable`
**transpiles and evaluates** rather than parsing — the faction table is JSX
prose full of apostrophes and braces, so no regex could find the end of an
entry. Free identifiers come from an explicit `scope`, which makes any new
upstream dependency a `ReferenceError` naming the symbol: the drift detector.

Now vendored: the 34 factions with both flattened `toJSON()` requirements and
the structured condition tree, all 137 augmentations, the donation and
reputation formulas (with share-bonus and SF15 level as explicit injections
rather than silently-wrong constants), and the enum/constant files that are the
scope.

Four bugs the extractor's own checks caught, each of which would have produced
plausible-looking wrong data:

| Symptom | Cause |
|---|---|
| 34 factions, expected 33 | The plan's premise was wrong. Both `FactionName` and the table have **34** — `ShadowsOfAnarchy` is easy to miss because it is special-cased everywhere. |
| `keepOnInstall` false for all 34 | The constructor *param* is `keepOnInstall`; the class stores it as `keep`. Reading the param name yields `undefined` everywhere, which `!!` turns into a uniform, entirely plausible `false`. Real count: 12. |
| `programs` treated as a multiplier | `BigD's Big ... Brain` grants programs; folding a string array — or `startingMoney`'s 1e6 — into `mults` would have dominated a log-sum score. |
| Unpurchasable augs priced `null` | `JSON.stringify(Infinity)` is `null`, which reads as "no price". The emitter now writes real `Infinity`, keeping it distinct from The Red Pill's genuine `0`. |

`UnstableCircadianModulator` randomises its multipliers at load time, so there
is no correct value to vendor. Its fixed price, rep cost and faction are kept
and the multipliers are explicitly marked `multsUnknown` — freezing one
arbitrary roll would have been a fabricated value the planner then scored.

*Evidence:* `sim/tests/vendor-tables.test.ts` (14 tests) pins each of the above
plus the nested-OR structure, the resolved `delayedCondition`, the city ban
graph, and cross-table referential integrity (every offering faction and every
prerequisite resolves).

**0.6 Sim groundwork.** `sim/core/player.ts` adds `SimPlayer` — the non-`Person`
half (karma, kills, entropy, city, jobs, factions, invitations, augmentations,
queued augmentations, source files, the single work slot). Kept separate from
`Person` deliberately: the vendored formulas take an `IPerson` and a sleeve is
one too, so bolting player-only fields onto that object would make it
impossible to hand a sleeve to the same formula without lying about its type.

`SimWorld.playerRecord()` is rewritten to **copy** every nested object. The
previous implementation spread `this.person`, so `skills`, `exp` and `mults` all
aliased the live objects — the controller's stored "snapshot" silently tracked
the world, and any test comparing them would have passed for the wrong reason.
Pinned by four new tests in `sim/tests/world.test.ts`.

Also landed: `SimNsHost.engine` (so an ns call can poke a counter as
`Singularity.checkFactionInvitations` does) and `SimNsHost.onPrestige` (an
install kills every process, so `game/`'s module-level ledger and the realm
slots must be dropped — the hook lives in `sim/` because `game/` must stay
unaware it is simulated); the `Engine` is now constructed **after** the world so
a subsystem can close over real state; `SimProfile.bitnode`/`startingMoney`;
`--only` / `--features` on `sim/run.ts` (unknown names are rejected, because a
typo'd `--only hackign` that quietly ran everything would invalidate the
measurement silently); `GoalContext.augmentations`; and `SaveSeed.playerState` /
`SaveSeed.factions` plus `SavePlayer.factionInvitations` and `numPeopleKilled`.

*A bug the typechecker caught:* `playerRecord` initially returned a `bitNodeN`
field. `Player` has no such field — the active node comes from
`ns.getResetInfo().currentNode`. That would have been a fabricated value the
strategy could have read and the real game would never supply.

*A profile bug fixed:* the `factions` profile ran in **BN1**, where
`deriveCapabilities` reports `factions: "no"` — every faction probe and the
driver were gated off, so its goal was unreachable no matter how long the run
lasted. Now `factions-join` with `bitnode: 4`.

### Measured cost of Phase 0

`earn:1e6`, seeds 1–3, game driver:

| | seed 1 | seed 2 | seed 3 |
|---|---|---|---|
| before Phase 0 | 20.6m | 18.2m | 18.2m |
| after 0.1 (modules) | 20.6m | 18.2m | 18.2m |
| after 0.4 (fleet dodging) | 20.6m | 18.2m | 18.2m |
| after 0.6 (all groundwork) | 20.8m | 18.4m | 18.4m |

Phase 0.1 was byte-identical. The ~1% slowdown at the end is real and expected:
probes now place dodges on fleet hosts, which takes RAM the dispatcher was
previously free to use. That is the price of acquiring state that was
**previously impossible to acquire at all** on an 8 GB home — the gate batch
went from never running to running 40+ times per run. Recorded here rather than
smoothed over.

### Phase 1 — factions

The full vertical slice, and the reference the other twelve copy.

**Pure strategy** (`shared/strategy/factions/`): a `PlayerRequirement`
interpreter, the reputation/favor/donation math, augmentation valuation and
purchase ordering, exact ban-graph objective selection, and the decision
function. No faction table is hardcoded in `shared/` — requirements are read at
runtime from `ns.singularity.getFactionInviteRequirements`, and the vendored
table exists only so the SIMULATOR can answer the same query.

**Evidence — four exact oracles, not heuristics:**

| Claim | Oracle |
|---|---|
| rep/favor/donation math | bit-identical to the vendored originals (`toBe`, 30 cases incl. share bonus, SF15, BitNode mults) |
| faction selection | exhaustive over all 2^n subsets, 60 seeded random ban graphs |
| purchase ordering | brute force over all permutations, 40 random sets |
| purchase ordering under prerequisites | brute force over all *legal* permutations, 30 random branching DAGs |

**Choosing and paying are separate orders, and both are used.** Each queued
non-SoA purchase multiplies the price of every later one by 1.9, and an
augmentation does nothing until it is installed — so within a reset there is no
reason to want a cheap one early, and the dearest item belongs in the cheapest
slot. The set is therefore chosen by VALUE and bought by PRICE: `selectFactions`
and the package frontier pick what is worth having, `orderPurchases` decides the
sequence, and every cost estimate is taken from the ordered sequence rather than
from today's queue depth. Pricing a batch in value order overstates it, which
loses packages comparisons they should win and leaves the last purchases
unaffordable after the first ones have inflated the multiplier.

This was the ordering machinery's first production caller. `orderPurchases` and
its brute-force oracles existed for several phases while every live path still
walked value order — the tests were green and the behaviour was wrong, which is
the failure mode a test suite cannot catch on its own.

**What it is worth, measured on the real catalogue** — each faction's twelve
best-scoring augmentations, prerequisites closed in, priced before and after:

| Faction | Augs | Value order | Cost order | Saved |
|---|---|---|---|---|
| CyberSec | 5 | $0.45b | $0.45b | 0% |
| NiteSec | 10 | $76.1b | $42.9b | **43.7%** |
| The Black Hand | 12 | $1 482b | $635b | **57.1%** |
| BitRunners | 14 | $6 959b | $4 609b | **33.8%** |

CyberSec's value order was already cost-optimal, which is why the early game never
exposed this. The saving grows with package size because the escalation is
exponential in it.

A caution the first attempt at this measurement earned: a baseline that sorts purely
by value is **not** the prior behaviour and reports the fix as a *loss*. Bitburner's
prerequisite chains run cheap-to-dear (Netburner Module $250m → Core Implant $2.5b →
Core V2 $4.5b), so an unconstrained descending-cost order is illegal — those
purchases simply fail in game. Production has always closed prerequisites in first,
and both columns above are precedence-legal by assertion.

**The budget includes the market book, and purchases wait for it.** Ordering only
pays off against the bankroll the run will actually have, and a large part of that
is usually not cash: `stock` holds a portfolio which is liquidated before every
install, because `progression` will not reset while the book is open. So
`settlingMoney` — cash plus the book, net of the exit spread and one commission per
position — is what every affordability and ETA question in the feature uses. Two
consequences:

- **The objective no longer shrinks to fit cash.** The package frontier converts a
  money shortfall into an ETA and rejects anything that misses the horizon; priced
  against cash alone, a run with its wealth in the market plans a smaller package
  than it can afford.
- **A cash shortfall on the dearest item stops the walk instead of falling through
  to a cheaper one.** Falling through *is* the ordering mistake, and it is
  permanent — the skipped item now costs 1.9x more forever. Money left unspent is
  also money the market keeps compounding, so waiting is not a sacrifice.

**Patience has to be able to end, and two of its bounds exist only for that.**
Waiting is bounded by money with a settlement date and never by income over the
horizon — `horizonSec` is `Infinity` when the forecast has no answer, which is
exactly when an income-based rule would wait for ever. Reputation shortfalls and
gaps the book cannot close fall through rather than wait. And **the first purchase
of a run is never held**, which is the subtle one: the book is liquidated when
`progression` reaches its `ending` phase, and `phaseOf` requires a non-empty install
queue to get there, so holding out for the book while nothing is queued waits for a
liquidation the waiting itself prevents. Nothing else breaks that cycle —
`installWanted` is gated on the same empty queue, so the install barrier is never
even consulted. Buying one item bootstraps the phase machine, and since the walk is
dearest-first it is the dearest item currently affordable. All four bounds are
regression-tested in `tests/factions.test.ts`.

**The final-sweep drain spends DOWN from a frozen snapshot and never waits on
income.** Measured on the `factions-install` profile (6.0m → 4.0s median, 3/3
seeds, one order of magnitude twice over): the drain used to test each escalated
NeuroFlux level against LIVE cash, so a fast farm out-earned the 1.9x price
ladder level after level and the install landed only when the race was
momentarily lost — worse, the install barrier tested the same live cash and held
whenever income had caught up again. Now the drain freezes `drainCeiling` (cash
on hand when the drain starts, cleared on any non-drain decision), each intent
must clear `min(ceiling, cash on hand)`, and the published ceiling is what
`purchasableAugmentation` tests too, with NeuroFlux judged by the drain's own
locally-escalated intent rather than the stale probed offer. Three cadence fixes
ride along: the purchase RAM claim is anticipated whenever the plan funds a buy
(same contract as the workForFaction claim), a successful purchase or a pending
affordable drain asks for an early wake instead of the 30-second cadence, and a
concluded drain raises the install signal (`game/lib/install-signal.ts`) so
progression's first evaluation does not wait out its 60-second cadence. A favor
crossing plus a concluded faction sweep now count as `installWanted` directly —
the crossing is a step change, and the `money > earned/2` phase gate protected a
conversion that had already happened.

**The exact ordering solver is used only where money changes hands.** It is
exponential — 0.3 ms at ten items, 40 ms at sixteen — and the package frontier
prices a candidate per (faction, reputation breakpoint), hundreds of times per
decision. Wiring the solver in there cost seconds per decision to sharpen numbers
that only ever feed a comparison against other estimates. `estimatedCost` (greedy,
most-expensive-first) serves the estimates: exact without prerequisites, pessimistic
with them, so the batch selector may drop a candidate the solver would have fitted
but can never return a plan we cannot pay for.

**The four predecessor bugs are named regression tests**, each of which made a
whole branch of the game unreachable: the `not` case returning false because
`[]` is truthy (the entire criminal ladder), `someCondition` returning false
unconditionally, `numAugmentations` treated as unachievable (Daedalus), and the
hacknet/bladeburner/infiltration `return false` TODOs (Netburners,
Bladeburners, Shadows of Anarchy).

**The cross-feature mechanism demonstrably closes.** `sim/profiles.ts`'s
`factions-join` runs the REAL controller in BN4 to `faction:CyberSec`, reached
on all 3 seeds in 1.81–1.84 h. The chain, with neither feature naming the other:

```
factions posts Need{kind:"backdoor", subject:"CSEC"}   (it needs the outcome)
  -> hacking buys TOR + BruteSSH.exe                   (it owns servers)
  -> the sweep roots CSEC
  -> hacking installs the backdoor
  -> the engine's invitation counter fires
  -> factions joins CyberSec
```

Hacking is unregressed by the slice (20.8 / 18.4 / 18.4 min on `earn:1e6`,
identical to the post-Phase-0 baseline).

**Bugs found while building it**, most by the tests and oracles written
alongside:

| Bug | Consequence |
|---|---|
| `negate({type:"not",…})` UNWRAPS, so negated leaves were evaluated **positively** | every negated requirement inverted |
| greedy purchase order ignores that a cheap prerequisite unlocks an expensive dependant | 20% overpayment; replaced with an exact subset DP |
| needs were collected only from **due** modules | a 200 ms consumer saw an empty board on 149 of every 150 ticks and never acted |
| `claims()` derived the work-slot bid from the previous decision | could never bootstrap — the decision needed the slot, the slot needed the claim |
| backdoor dodges pinned to home at 4–5 GB | never fit a fresh home's ~4.4 GB free, so the whole ladder silently never started |
| the augmentation list capped at 200 (faction, augmentation) pairs | truncates in enum order, where CyberSec is 31st — early factions scored ZERO and were never chosen |
| `let bitnode = 1` in `sim/run.ts` | `bitnode ?? profile?.bitnode` is always 1, so a profile's BitNode was silently ignored and every faction feature stayed gated off |
| sim `getAugmentationsFromFaction` required membership | upstream does not (Singularity.ts:128) — the planner could never value a faction it had not joined, which is exactly the decision it must make |

**Deliberately deferred within this slice**, each reporting rather than faking:
`commitCrime`/`getCrimeStats` (lands with `career`, where the crime model
belongs); grafting; company reputation. The `factions-rep`, `factions-aug`,
`factions-install` and `factions-donate` profiles are not yet written — the
first three need no new modelling, and `factions-donate` needs the one
registered save fixture, since favor cannot be earned within a run.

### Phases 2-13 — the remaining twelve

Every feature now has a real driver module; `inert()` is gone from
`game/lib/features/index.ts` entirely. Each has pure strategy in
`shared/strategy/<id>/`, a decision digest on its telemetry topic, and tests.

| # | Feature | Objective | Evidence |
|---|---|---|---|
| 2 | career | Serve the needs board; be the income floor | **Exhaustive argmax** over the 12-crime action set is the provable optimum for a fixed stat vector; exact time-to-karma integral. `career-karma` reaches karma -9 in **8.6 min**. |
| 3 | hacknet | Cumulative production minus spend over the horizon | **0/1-knapsack DP** oracle; greedy matches the DP optimum. Beats the "level to 80 then RAM" baseline. |
| 4 | stock | Money at the end of the RUN, net of spread, commission and the regime cycle | Model of the real price engine (shared volatility roll, 75-tick cycle, second-order forecast), **pinned against the vendored source**; break-even derived rather than assumed; beats both buy-and-hold and the predecessor's forecast>0.6 rule at matched exposure; trades profitably **without 4S** off recovered signal; liquidates before every install. |
| 5 | gang | Respect/money/territory without the wanted penalty | **Coupled** exact assignment — the wanted penalty is gang-wide, so per-member argmax optimises the wrong function. Analytic ascension crossover. |
| 6 | corp | Sequence divisions, cities, products, investment | Staged script with per-stage precondition and expected effect. **Optimality boundary stated openly** — near-optimal *within the modelled stage graph*, not globally. |
| 7 | bladeburner | Climb rank fastest **without dying** | Every decision uses the **pessimistic** end of the `[min,max]` chance interval; Black Ops refused below 95%. Stamina floor and chaos ceiling. |
| 8 | sleeves | Allocate N sleeves across the task menu | Exact per-sleeve argmax (sleeves do not interfere). Shock scales output down linearly, so recovery dominates. |
| 9 | go | Wins, territory, streaks | Depth-bounded negamax with liberty-aware evaluation; **exhaustive at 5x5**. |
| 10 | stanek | Pack the grid, then charge | **Exhaustive packing is PROVABLY optimal** — the strongest evidence in the roster. Correctly leaves out a large fragment to fit two smaller ones. |
| 11 | dnet | Traverse under a stasis-link budget | Exact max-reachable search; links spent where they unlock the most. |
| 12 | side | Solve every coding contract | **All 30 v3.0.1 contract types implemented** with exact registry coverage and known-answer tests. Discovery is ls-only; staged batches peak at `attempt` RAM, and a first rejection is logged and quarantined rather than retried. Infiltration stays manual. |
| 13 | progression | Install timing, reset cadence, node order | Exact favor crossover (`addRepToFavor`); exhaustive node ordering for a small set, measured against the predecessor's real 15-node ordering. |

### The hacking audit

Four questions from the legacy review, answered rather than assumed
(`sim/tests/hacking-audit.test.ts`). Two are closed; Q3 produced and fixed a
real loss:

- **Q2 — is their duration-weighted `moneyPerThread` a better score than our
  `$/GB/sec`?** **CLOSED, no change.** They are not constant-factor
  conversions because hack uses 1.70 GB while grow/weaken use 1.75 GB. They do
  still induce the same ordering: both are monotonic in the same
  duration-weighted non-hack/hack thread ratio.
- **Q3 — does an exhaustive hack-thread search beat our derivation?**
  **CLOSED, fixed.** Yes: the old search chose 14 threads at 18.9084 $/GB/s
  where 11 threads scores 19.0776, a 0.89% loss. `solveCycle` now exhausts all
  integer candidates through 1,024 threads and labels larger-domain results
  heuristic via `exact: false`; an independent oracle compares scores in the
  same units, including `hackTimeSec`.
- **Q1 — predictive sizing at landing?** **CLOSED, adopted.**
  `shared/strategy/prediction.ts` folds the dispatcher's own in-flight ledger
  (tracked ops now carry landings and core-adjusted effect threads) to the
  hack's landing instant; the batch skips outright when predicted security
  exceeds the prepped tolerance and re-solves its grow/W2 cover from the
  predicted post-hack money. Fold parity vs the vendored effects, tie-break
  determinism and the resize/skip rules are pinned in
  `sim/tests/prediction.test.ts`. The A/B (planner driver, earn:1e9 ×10 seeds,
  earn:1e6 ×10) measured NEUTRAL on clean runs — the sim's steady bands rarely
  enter the tolerance window — and it was adopted as the correctness net for
  the states that do (90 % money admits, in-flight drift, desyncs). Unlike the
  legacy `simulation.ts` timeline it replaces conceptually, there is NO cache
  to invalidate: a fresh fold per launch is microseconds.
- **Q4 — shotgun fallback?** **CLOSED, implemented.** `decideMode`
  (`shared/strategy/mode.ts`) drops to shotgun when weakenTime holds fewer
  than two interleaved batches; the wave lands every op in one engine tick in
  launch order H → G → W (see spec/targeting.md, farm modes). The legacy
  scripts' central trick — same-tick FIFO as the ordering mechanism, with
  each op padded to weakenTime from its own start — carried over, minus their
  empty hack-size guard and with the landing-state fold reproducing the
  sequencing pure-side. Tie-break and band proofs pinned in
  `sim/tests/dispatch.test.ts`.

### Found by running in the REAL GAME

The simulator cannot catch every class of bug, and a live run proved it.

**Dodge budgets were guessed, not priced.** The drivers passed literal GB
budgets to `dodge()` — `2.5` for `singularity.joinFaction`. The game reported:

```
RAM USAGE ERROR lib/dodge-stub.js@aevum-police (PID - 328)
singularity.joinFaction: Dynamic RAM usage calculated to be greater than RAM
allocation. Dynamic RAM Usage: 4.60GiB  RAM Allocation: 4.10GiB
```

The arithmetic is exact: allocation `1.6 (stub) + 2.5 (guess) = 4.10`; dynamic
`1.6 + 3.0 (joinFaction) = 4.60`. **`joinFaction` is `SF4Cost(SingularityFn2)`
= 3.0 GB, so 2.5 was short even at SF4 level 3 where the multiplier is 1x** —
the guess was wrong at *every* SF4 level, not merely the expensive ones.

Fixed by `priceCalls()` in `game/lib/dodge.ts`: every driver now prices its
closure from `ns.getFunctionRamCost` (free, and it already folds in the
16/4/1 singularity multiplier) plus a 0.5 GB margin. `tests/features.test.ts`
pins that no driver passes a numeric literal as a budget.

**Why the simulator missed it:** `sim/ns` does not enforce dynamic RAM, so an
under-allocated stub runs there quite happily. This is a genuine limit of the
simulator's fidelity and is recorded here rather than papered over.

**Three data points disagreed about what the player was doing.** The game showed
a Heist; the Factions tab said "next work Tetrads (hacking)"; the Career tab had
said something else again. Only one activity can run, so at most one could be
right. Four distinct bugs, in a chain:

1. **`workTypes` was never probed.** The telemetry type had the field; no probe
   filled it; the view defaulted missing data to "offers all three". Tetrads is
   `hacking: false, field: true, security: true`, so the driver issued
   `workForFaction(Tetrads, "hacking")` — refused every 30 s, forever, while
   the panel reported it as the plan. Fixed by probing
   `ns.singularity.getFactionWorkTypes` for EVERY faction (not just joined
   ones — the planner estimates reputation time before deciding to join), and
   by defaulting unknown to **offers nothing**: not working for one probe cycle
   is cheap, working the wrong type forever is not.
2. **A long crime could be cancelled mid-flight.** `career` had no `holdUntil`
   on its work claim, so `factions` (60) preempted `career:income` (30) at
   will. Had the call succeeded it would have cancelled a ten-minute Heist at
   1.5% done. `career` now holds the slot for the crime's REMAINING time,
   computed from `cyclesWorked` — recomputing `now + duration` each tick would
   extend the hold forever, which is as broken as releasing it too early.
3. **Factions starved itself.** It posted every objective blocker as
   `urgency: "blocking"`, including Daedalus's hacking 2500. `career` claims
   the slot at `career:blocking-need` (75) whenever any blocking need exists,
   which outranks `factions:work` (60) — so career held the slot permanently
   chasing a requirement hours away, and factions could never work for the
   reputation it was itself asking for. Urgency is now `blocking` only when the
   blocker is the LAST one for that faction (clearing it unlocks a join now).
4. **The panel presented an intent as an activity.** It now says explicitly
   *"would work X but another feature holds Player.currentWork — only one
   activity can run at a time"*.

*A regression caught by re-running the sim, not by tests:* scoring an unworkable
faction's reputation ETA as `Infinity` divided its value to exactly zero, which
dropped it from the objective entirely — so probing work types properly emptied
the whole plan and nothing happened at all. Unworkable factions are now
penalised heavily (`UNWORKABLE_REP_SEC`) rather than annihilated.

**Two UI defects from the same session**, both in `ui/`:

- *Scroll position reset on every frame.* Panels are re-rendered from an HTML
  string, and replacing `innerHTML` destroys every scroll offset in the
  subtree — on a live run that fires on each flush, yanking the page back to
  the top while you read it. `renderView` now captures and restores page and
  per-card scroll, but only across a re-render of the SAME tab.
- *Long prose forced horizontal scroll.* `td { white-space: nowrap }` is right
  for numeric columns and wrong for a requirement tree. `table()` gained an
  opt-in `wrap` column list; the factions tab marks its prose columns.

### Phase 14 — the endgame route decision, and the refresh/act split

The gap this closed: `stepEndgame` modelled the three ways a node ends but was
called only by tests; no route was ever chosen; nothing estimated how long any
path would take; the decision existed in no telemetry record; and every
feature that was BUILT to take an "expected remaining run time" was fed a
hard-coded `horizonSec: 3_600` (hacknet, stock, factions) or `Infinity`
(hacking's `goalRemaining`). Full write-up: `spec/strategy/endgame.md`.

What landed, in dependency order:

- **`shared/strategy/progression/eta.ts`** — per-route time HEURISTICS (gap ÷
  observed rate, finite pessimistic fallbacks, parallel tracks priced as the
  slowest not the sum, the shared Red Pill install+regrow tail) and
  `chooseRoute` with a 25 % switch margin and 10-minute dwell. Every part is
  `{what, sec, measured}` so a wrong total is attributable to the specific
  sub-heuristic. `BitNodeEntry.hours` re-documented as a heuristic — it was
  framed as "measured hours, once known", which is the wrong model: the
  estimate must be computable NOW, always, and tuned from the log later.
- **The refresh/act split** (`FeatureModule.refresh`) — evaluation runs for
  every due module before any needs/claims/tick, with `progression` ordered
  LAST so its route decision reads the pass's refreshed state; drivers then
  act with `{route, horizons: {install, node}}` in their context. This resolves the ordering
  circularity ("endgame needs enriched state; features need the route") the
  same way the needs→claims phases already resolved theirs.
- **The progression driver is no longer decorative** — its refresh builds the
  `EndgameView` entirely from store topics (every input was already probed),
  chooses the route, and publishes the route plus independently anchored
  install/node forecasts on `progression.plan`. Its previously stubbed
  `stepProgression` inputs are real now: `affordableValueProduct` from the
  offer catalog's multipliers, `earnedThisRun` from `getMoneySources` (all
  sources, not just hacking — in a non-hacking node the old farm-only figure
  kept the phase machine in `start` forever), `runSec` from `lastAugReset`,
  and `queued` is pending-not-installed rather than all owned.
- **Forecast threading** — reset-sensitive consumers read the install forecast;
  persistent consumers read the BitNode forecast. Neither has a fixed cap or
  scalar fallback, and `stepEvaluator` bounds prep/switch amortization by the
  relevant usable forecast.
- **The sweep moved to `game/lib/fleet.ts`** — infrastructure with the shape
  of a feature refresh, owned by no feature; the controller keeps gating,
  phase ordering and the decide step.
- **Telemetry closes both loops** — `endgame.route` on change (with the full
  per-route breakdown) and `bitnode.reset` enriched with `{from, elapsedMs,
  route, guessedEndAt, decidedAt}`. The old node's start time is captured
  BEFORE the probe pass, because the gate batch overwrites `lastNodeReset`
  with the new node's the moment a reset is observed.

*Evidence:* 19 new tests (`tests/endgame-eta.test.ts`) pin finiteness (no
route annihilated by Infinity — the unworkable-faction lesson, relearned
deliberately this time), measured-vs-fallback marking, the shared-tail
collapse once the pill is owned, parallel-track pricing, switch
margin/dwell/incumbent-loss behaviour, and explicit uncapped/stale forecasts. Full suite 534
pass. Typecheck clean.

### Phase 14 review round — 11 verified findings, all fixed

An 8-angle review with adversarial verification (13 candidates, 3 refuted)
ran over the slice before it merged. Every confirmed finding was fixed:

- **One horizon was the wrong quantity for hacknet/stock** — the node-end ETA
  spans augmentation installs, while installs destroy exactly what those
  features buy. The final contract therefore carries separate install and
  BitNode forecasts rather than capping one scalar.
- **Stale topics survived a node reset** — `reset()` became `reset(state)`;
  every module clears its own published topics (progression field-level: the
  gate batch already wrote the new node's identity). Pinned by a new
  registry-walk test. The concrete bug: the new node's first route decision
  read the old run's Red Pill out of stale `factions.ownedAugs`.
- **Complete and quiet routes froze investment** — both are now represented by
  an explicit zero estimate or unknown/stale evidence; no fixed floor or
  default can silently steer consumers.
- **`blackOpsComplete` fabricated 0 pre-probe** — now optional ("unknown"
  expressible), derived on the cheap core probe from `getBlackOpNames`
  (0 GB) + `nextBlackOp`, and rate sampling skips unknown series (also
  Daedalus rep and aug count) so a phantom 0→N jump cannot contaminate the
  30-minute rate window.
- **`FactionsView.horizonSec` was dead at review time** — the final package
  planner now consumes the usable BitNode forecast to reject work or grafting
  that cannot finish in the current node. Unknown remains explicit as an
  unbounded planning window, not an invented duration.
- **`bitnode.reset` could be lost** — emitted after the awaited post-reset
  sweep, so a sweep failure dropped the node's one calibration record; now
  emitted first in the branch, which also deleted the snapshot local.
- **`openerCount` was functionally dead** — the review proved its gate
  reduced to `rootable.length > 0`; the parameter, return value and both -1
  sentinels are deleted (pre-existing, faithfully moved code).
- **`pump` had grown a swappable positional number tail** — collapsed to an
  options object; `goalRemaining` dropped from the game path entirely (the
  sim's device, set on `planFarm` directly).
- **The drift detector did not follow the sweep** — it now scans
  `game/lib/fleet.ts` with its own allowlist.
- **The EndgameView test fixture was duplicated byte-for-byte** — shared via
  `tests/fixtures/endgame-view.ts`.

Refuted by verification, recorded so they are not re-raised: the evaluator's
tighter horizon band is deliberate layering, not clamp duplication; the sim's
default `game` driver exercises the horizon end-to-end (only the opt-in
planner A/B loop omits it, by design); the refresh-order sort survived on no
angle once sized.

Suite after fixes: 539 pass, typecheck clean.

### Phase 15 — the stock market, rebuilt, and the hacking tie-in

The previous stock feature was marked done and **could not place a trade**. A
review found the cause and eight further defects; all are fixed, and the feature
now owns the second half of BN8's mechanic.

**The deadlock.** The money claim was derived from what executed last pass, the
execution from the grant, and the grant from the claim — with `moneyGranted` 0 on
the first pass the cycle never closed, so no purchase of any kind was reachable.
`stepStock` now returns a PLAN sized at full ambition with no reference to the
grant; the claim is posted from the plan and `fundedActions` cuts it to what was
granted afterwards.

**The rest of the defect list.** Stale positions caused a duplicate buy (and a
fresh $200k commission) on every 4 s tick until the 30 s probe caught up —
`getPosition` now runs inside the trade stub. `has4SData` was inferred from
whether `getForecast` threw, conflating the $1b ticker data with the $25b script
API; both are probed directly at 0.05 GB, and the **$1b purchase is now never
made at all**, because `getForecast` checks the API flag and buying the API does
not require the data first. Shorts were emitted without checking BN8/SF8.2, and
because the entry loop took only the top-ranked symbol and stopped, one bearish
symbol blocked every long below it — the loop now walks the ranking and
`canShort` gates the side. Nothing had ever bought WSE or TIX, which was
unreachable by construction: see the always-playable note in
[spec/features.md](features.md).

**What the strategy models now**, all of it read out of the price engine rather
than assumed: the shared per-tick volatility roll (so the mean move is half
what `getVolatility` reports), the spread (10x–200x the commission on any
position worth opening, and previously invisible — the probe wrote the mid price
into both `ask` and `bid`), the 75-tick regime cycle (detected from simultaneous
0.5 crossings, after which the period is known exactly), the second-order
forecast as the leading indicator, and a position's own market impact. Break-even
is derived from those rather than assumed at ten ticks, and a horizon shorter
than break-even is answered with cash.

**Two horizons, not one.** A position dies at the next install
(`prestigeAugmentation` → `initStockMarket` zeroes every holding and credits no
money, which the game's own warning states); WSE, TIX and 4S survive every
install and die only with the BitNode. The old shared `horizonSec` was wrong for
both — capped at the install cadence it made the 4S API unaffordable below ~$100b,
which in BN8 is unreachable without it.

**Without 4S it still trades.** `v` is one draw shared by all 33 symbols, so one
symbol's step calibrates every other's volatility; and the tick sign is a
Bernoulli draw on the forecast, so the up-tick frequency estimates it. Both are
recovered in `history.ts` and verified against the real engine to within 2%. The
probe cadence moved from 30 s to 4 s because none of it is observable at a
sampling rate slower than the 6 s tick.

**The hacking tie-in.** `stock` publishes a per-host intent and a dollar value per
influencing op; `solveCycle` adds it as a second income term to the same
`$/GB/sec` score, and the dispatcher sets `{stock: true}` on the grow for a long
and the hack for a short — never both, since their successful steady-state
influences oppose each other.
`ScriptHackMoneyGain` entered `HackContext` at the same time: it scales the
hacking term and NOT the manipulation term, because influence is measured from
`moneyDrained` before the player's cut, and omitting it reported every BN8 target
as profitable while it earned nothing. See [spec/targeting.md](targeting.md).

*Evidence:* 129 new tests. `sim/tests/stock-parity.test.ts` pins the two shipped
transcriptions field-by-field against the vendored source (including three
constants that are inline literals upstream, matched against the source text).
`stock-market.test.ts` asserts the model's claims against the real price engine —
the half-volatility step to 4 decimal places, the shared roll to 1e-9, the exact
75-tick period, that `moneyMax` cancels out of the manipulation rate, and that an
install destroys the portfolio. `stock-strategy.test.ts` runs the solver against
that engine across seven seeds: it beats buy-and-hold and the predecessor's
`forecast > 0.6` rule at matched exposure, makes money with no 4S at all, gains
from manipulation, and ends every liquidating run flat.

**Five findings came out of the simulator and changed the code, not the test.**
This is the whole reason the market is modelled from the real source rather than
from the same transcription the strategy uses:

1. **Cycle flips repeatedly UNDO a manipulation campaign.** 3000 ticks of maximum
   pressure reach the extreme with cycles suppressed and do not with cycles
   running, because a bull/bear flip turns accumulated `otlkMag` from an asset
   into a liability. So a nudge cannot be priced at its theoretical value, and a
   hold has to be bounded by the cycle clock.
2. **The solver was losing to the naive rule — on exposure, not judgement.** 61%
   invested against 98%: the portfolio cap was a fraction of CASH, which shrinks
   as it is spent, so it converged on half its intended size. It is a fraction of
   the bankroll now, concentration replaced equal weighting, and the baseline was
   given the same capital policy so what remains measures the decision rule.
3. **No probe could run faster than the 30 s sweep.** `runProbes` was only ever
   called from the fleet sweep, which silently made 30 s the floor for every
   `everyMs` in the table — the local tier had asked for 5 s and received 30 s for
   the whole life of the project, and Go asks for 2 s. The market ticks at 6 s: the
   first end-to-end run observed 39 of 200 ticks and measured JGN's volatility 3.5x
   too high, because an aliased sample reports five ticks of compounded movement as
   one. Fixed generally rather than for stock: the controller now DERIVES its
   acquisition interval from the fastest `everyMs` anything declares
   (`probeCadenceMs`), each probe's own `everyMs` gates it from there, and the
   capability gate stays on the sweep because the reset walk keys off its delta.
   199 of 200 ticks after the change, and the measurement landed dead centre of the
   true range. Two tests pin the bargain — that the caller honours a declared
   cadence, and that a probe declaring a fast one stays cheap enough to afford it.
4. **The earnings rollup only fired on an HGW landing**, so a run with no farm
   credited `moneyEarned` and never published it — an `earn:` goal was unreachable
   however much the run made. `SimWorld.pulse()` drives it from the engine, which
   covers hacknet too.
5. **The manipulation loop needs BOTH halves to choose each other.** `hacking`
   priced price impact correctly, but `stock` picked symbols on pure edge, landed
   on three megacorps whose servers were out of skill range, and the tie-in idled
   through 380 grows without moving a price. `stock` now prefers symbols whose host
   the farm can drive (`MANIPULATION_PREFERENCE`), as a documented policy rather
   than an invented dollar value.

And one measured magnitude worth recording, because it bounds what the tie-in can
ever be worth: an influencing op is worth a few THOUSAND dollars against tens of
MILLIONS of hacked money per batch. So manipulation does not move target choice
outside a node that nerfs hacking — and in BN8, where `ScriptHackMoneyGain` is
exactly 0, it is the entire score. Both directions are pinned in
`sim/tests/dispatch.test.ts`.

### Phase 16 — Go strategy and independent time forecasts

- Replaced the scalar, capped planning window with the typed
  `PlanningHorizons` contract. The install and BitNode forecasts are uncapped,
  anchored, recalculated every ten minutes or on structural milestones, and
  preserve unknown/stale states plus critical-path component evidence.
- The progression panel now shows both countdowns, expected wall-clock times,
  confidence/recalibration age and parallel/sequential component tables.
  Telemetry retains the same typed objects for later calibration.
- Implemented rules-correct Go play with a fixed-budget tactical shortlist and a handcrafted
  faction-reply forecast driven by the public `totalPlaytime` WHRNG seed. The
  production bundle imports no game source. Simulator parity tests import the
  pinned v3.0.1 board/RNG/effect implementations and detect drift.
- Replaced fixed opponent selection with ETA valuation across every opponent
  on the throughput-optimal 5x5 board. Node-power, difficulty, streak/comeback effects,
  nonlinear rep-to-favor conversion and the SF14 cap are exact transcriptions;
  win/score priors and shortlist ordering are fitted by upstream-AI tournaments.
  Game-duration coefficients remain heuristic planning inputs.
- Go telemetry records the public decision input, seed uncertainty, predicted
  replies, observed support and all reward candidates. The UI exposes the
  selected board/opponent and the transient/favor seconds behind its choice.

*Evidence:* `bun run typecheck`; the full `bun test` suite, including Go rules,
WHRNG/effect/favor parity and upstream faction-AI strategy tournaments.

## Known gaps in the current implementation

Stated plainly rather than buried, because several features are implemented to
the *strategy* level without full end-to-end execution:

- **Corporation actions are not executed.** The stage machine, its
  preconditions and its digest are complete and tested; issuing the calls
  against an unmodelled world is the one thing this project refuses to do.
- **Darknet authentication is refused, not faked.** `authenticate(host,
  password)` needs a password behind the darknet's own discovery mechanic; the
  driver reports that rather than calling with an invented credential.
- **Sim models exist for factions, crime, hacknet, stock and Go.** Gang, corp,
  bladeburner, sleeves, stanek and dnet have pure strategy + driver + tests,
  but no complete system model — so their ns calls report `unmodeled()` rather
  than fabricating. Go additionally runs differential strategy tournaments
  against the pinned upstream faction AI.
- **Installs use an explicit barrier**, and `phase === "ending"` is not it. The
  phase is the ANNOUNCEMENT — the signal to `stock` and `factions` that it is time
  to convert everything. Permission to reset is the conjunction of four barriers,
  each owned by the feature that knows: the book is flat (`stock.plan.flat`), the
  faction purchase/donation sweep has finished, no augmentation is still
  purchasable, and no paid graft is in flight. A ready plan is armed for exactly
  one controller pass before `installAugmentations` executes, so the final state is
  observable — and once the barriers clear there is nothing further to wait for.

  Two details that are load-bearing rather than incidental:

  - **`stock` publishes its own readiness**; progression does not scan positions.
    A snapshot says nothing about INTENT, and an exit decided but not yet executed
    or an entry wanted on the next pass are both invisible in one while both mean
    the book is not flat. `flat` is the market's own answer, like
    `factions.plan.recommendInstall`.
  - **NeuroFlux Governor holds the barrier like anything else, and the barrier
    still clears.** It is the one repeatable augmentation, which invites the
    assumption that blocking on it can never end. It can: `getAugCost` scales both
    its price and its reputation requirement by 1.14 per level on top of the
    1.9-per-queued escalation, so every level bought makes the next strictly dearer
    in BOTH currencies and the affordable set runs out. Money does not survive an
    install and a permanent multiplier does, so buying as many levels as the cash
    allows is the POINT of the last-chance drain, not a distraction from it.

    The barrier (`nextPurchasableAugmentation`, over probed offers and cash) and
    what `factions` actually buys (`nextPurchase`, over the catalogue and the
    granted budget) are **two predicates, not one**, because a barrier blocking on
    something `factions` declines to buy is a deadlock by construction. They
    converge rather than match: the drain re-plans every tick against the cash
    genuinely left, so an augmentation this pass's batch passed over is reconsidered
    once the items ahead of it are bought and the budget has shrunk to fit it. That
    convergence is the invariant to preserve, not field-by-field equality.

    That deadlock was real, and the barrier is what exposed it: the driver's
    `aug-fund` claim was derived from `plan.objective`, which is complete by the
    time the drain runs, so the drain was granted nothing and bought nothing. Every
    install had been silently discarding the cash on hand. The claim now comes from
    `plan.nextBuy`, which the decision publishes at unlimited money — the purchase
    needs a grant, the grant needs a claim, and a claim read off the already-funded
    action can never bootstrap.
- **Limit and stop orders are not used** (BN8 or SF8.3). The solver places none,
  so the simulator's `processOrders` is a no-op and `ns.stock.placeOrder` reports
  `unmodeled()` rather than filling an order that would never trigger.
- **BN15's darknet volatility boost is a neutral 1x.** `getDarknetVolatilityMult`
  genuinely raises a symbol's volatility upstream, decaying at each market cycle,
  but `dnet` has no simulation model to drive it. The vendored price engine calls
  through an adapter, so the day darknet lands the mechanic connects with no
  further change.
- **`ctx.route` has no consumer yet.** The chosen route reaches every driver's
  context, but no feature biases its priorities by it so far (bladeburner
  when it IS the route, combat stats for the Daedalus combat branch). The
  horizon half is consumed; the route half is plumbing awaiting its first
  customer.
- **The labyrinth walk is a pure guess** (`LABYRINTH_WALK_SEC`): the darknet
  labyrinth mechanic is unmodelled, so the route's estimate carries an
  explicit unmeasured constant until a walk is implemented and measured.

## Deferred, tracked, not hidden

Each is an `unmodeled()` call or an explicit UI blocker, never a fabricated
value:

- `graftAugmentation` / `waitForOngoingGrafting` — needs a second work type with
  entropy on completion.
- `b1tflum3` / `destroyW0r1dD43m0n` — structural: `currentNodeMults` is module
  state and `sim/run.ts` is one BitNode per process. BitNode ordering is
  therefore evaluated analytically across runs, not inside one.
- `UnstableCircadianModulator` multipliers — time-seeded upstream.
- The casino — no ns API at all (it is DOM-driven).
- **SF4 level 1 outside BN4** — a single `SingularityFn3` call is 5 GB × 16 =
  80 GB and cannot be split further. Multi-step dodging does not help an
  indivisible call, so `factions` reports an explicit blocker rather than
  spinning. Fully fundable in BN4 or at SF4 level 3.
