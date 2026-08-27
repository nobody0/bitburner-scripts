# Feature automation progress

Running record of the fourteen-slice feature build-out: what is done, what
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
| 6 | corp | **strategy only †** — the stage machine is complete; the calls are not issued |
| 7 | bladeburner | **done** |
| 8 | sleeves | **done** |
| 9 | go | **done** |
| 10 | stanek | **done** |
| 11 | dnet | **done** — the controller/prober/agent pipeline (`game/dnet/`) surveys, bleeds, cracks and plants on live darknet hosts; every one of the 24 password models has a solver (`shared/strategy/dnet/solvers/`), the labyrinth walker included; and the feature acts on the net: memoryReallocation (reclaim), phishing, caches, stock propaganda (promote), stasis pins and induced migrations are wired as orders in `game/dnet/orders.ts`, and backdoors — the one darknet action that can only be taken from home's terminal — as a dodge in `game/lib/features/dnet.ts`. The storm is farmed too: `shared/strategy/dnet/plan.ts` gates `unleashStormSeed` on the prepared net (links spent, walker pinned, phish window freshly dead), the farm's seed hunt grinds blocks for the 15% roll, the controller quiet-periods and `stormWipe`s after a fire, and the sim models the seed drop and the phased burst (`dnet.webstorm` in `DNET_ASSUMPTIONS`). Stasis spares sit per air-gapped band (`stasisTargetDepths` — depth-mass allocation, band-center placement) and `planInduce` files every worthwhile push in parallel, `ferry` included: the only deliberate way across an air gap is pushing a credentialed host with its resident riding |
| 12 | side | **done** |
| 13 | progression | **done** — endgame route, install barrier, two-pass arm/execute, and post-install restart are live |
| 14 | endgame route + refresh/act split | **done** — see below |
| 15 | stock rebuild + hack/grow manipulation tie-in | **done** — see below |


**† strategy only** — pure strategy, driver, telemetry, tab and unit tests all
exist, but the driver refuses to issue the calls rather than acting against an
unmodelled world. See *Known gaps* below; the roster and that section must agree.

## Completed work

### Provenance corrections

#### Second correction: the batcher reference is `@master`, not `@2023`

The batcher was anchored to the wrong branch — `bitburner-2023`'s `jit.ts` is
unwired work-in-progress. The proven batcher is
`nobody01/bitburnerscript@master` (`dc0720b`), and `spec/jit-reference.md` was
rewritten against it; §0 there carries the branch table and §2 the window model
this got wrong. `@2023` remains the reference for factions, augmentations,
progression, stock and the `stubCall` dodger, so citations must now name the
branch.

*What shipped:* `MINIMUM_LANDING_GAP_MS` 200ms -> **5ms**, a new
`LAUNCH_SLACK_MS = 200` carrying the jitter budget separately, and
`THREAD_WEAKEN_UPSCALE` as ordering insurance (added, not multiplied). HWGW
batch interval **800ms -> 20ms**. `JIT_LAUNCH_GUARD_MS` is numerically unchanged
at 230ms, now derived from the launch slack rather than the landing gap.

*Measured, and not recorded elsewhere:* the overdue-retry backoff was
`min(SPACER_MS, exact)`, which at 5ms became a spin — ~1.2M planner passes over
900s of simulated time, and one dispatch fixture going from ~1s to 472s of
wall-clock. It is now `OVERDUE_RETRY_MS = WORKER_STARTUP_GUARD_MS`: retrying
faster than a worker can start cannot succeed, and the RAM it waits on frees on
a completion, which wakes the dispatcher anyway. An intermediate 20ms gap was
tried first and was unnecessary; once the anchors and the spin were fixed, 5ms
is clean.

#### First correction: `@2023`, not `nobody0/bitburner`

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

**0.4 RAM funding.** Three mechanisms: dodges may run on fleet hosts under a
pure placement policy (`shared/ram/placement.ts`); `SteppedProbe` prices a probe
at its largest **step** rather than the sum of its methods, keeping partial
results; and the home reserve is feature-aware (`shared/ram/reserve.ts`) — base
plus the largest step any *unlocked* feature declares, clamped to 40% of home,
reported as a blocker when capped rather than silently starving the feature.
The dodger and `SteppedProbe` are both retired now; `spec/ns-proxy.md` carries
what replaced them, and the placement policy, the heap lease, `reclaimFleet`'s
per-process hosts and the exec retry live on there.

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

The extractor's own checks caught four bugs, each of which would have produced
plausible-looking wrong data. Two are traps that recur whenever the tables are
re-extracted: the faction constructor *param* is `keepOnInstall` but the class
stores it as `keep`, so reading the param name yields a uniform and entirely
plausible `false` (real count: 12); and `JSON.stringify(Infinity)` is `null`,
which reads as "no price", so the emitter writes real `Infinity` to keep
unpurchasable augs distinct from The Red Pill's genuine `0`.

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

Also landed: `SimNsHost.onPrestige` (an install kills every process, so
`game/`'s module-level ledger and the realm slots must be dropped — the hook
lives in `sim/` because `game/` must stay unaware it is simulated), the `Engine`
constructed **after** the world so a subsystem can close over real state, and
`--only` / `--features` on `sim/run.ts` rejecting unknown names, because a
typo'd `--only hackign` that quietly ran everything would invalidate the
measurement silently.

### Measured cost of Phase 0

`earn:1e6`, seeds 1–3, game driver: **20.6 / 18.2 / 18.2 m** unchanged through
0.1 (byte-identical) and 0.4, ending at **20.8 / 18.4 / 18.4 m** after 0.6. The
~1% slowdown is real and expected — probes now place dodges on fleet hosts,
taking RAM the dispatcher was previously free to use — and it buys state that
was **previously impossible to acquire at all** on an 8 GB home: the gate batch
went from never running to running 40+ times per run.

### Phase 1 — factions

The full vertical slice, and the reference the other twelve copy.

**Pure strategy** (`shared/strategy/factions/`): a `PlayerRequirement`
interpreter, the reputation/favor/donation math, augmentation valuation and
purchase ordering, exact ban-graph objective selection, and the decision
function. No faction table is hardcoded in `shared/` — requirements are read at
runtime from `ns.singularity.getFactionInviteRequirements`, and the vendored
table exists only so the SIMULATOR can answer the same query.

**Evidence — exact oracles for the reusable math:**

| Claim | Oracle |
|---|---|
| rep/favor/donation math | bit-identical to the vendored originals (`toBe`, 30 cases incl. share bonus, SF15, BitNode mults) |
| purchase ordering | brute force over all permutations, 40 random sets |
| purchase ordering under prerequisites | brute force over all *legal* permutations, 30 random branching DAGs |

**Choosing and paying are separate orders, and both are used.** Each queued
non-SoA purchase multiplies the price of every later one by 1.9, and an
augmentation does nothing until it is installed — so within a reset there is no
reason to want a cheap one early, and the dearest item belongs in the cheapest
slot. The set is therefore chosen by VALUE and bought by PRICE: the package
frontier picks what is worth having, `orderPurchases` decides the
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

That blocking chain is not the only reason to own TOR and crackers. Hacking
also evaluates the next missing opener as an ordinary income investment: the
real target solver prices newly available farm targets, and every host that
becomes rootable contributes its RAM to the post-purchase fleet. The claim is
one tier at a time and competes at `income:investment`; explicit root/backdoor
needs retain `hacking:blocking-prerequisite`. TOR ownership proven by the
Darkscape path is reused rather than budgeted twice.

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
| 9 | go | Wins, territory, streaks | Upstream-oracle arena; trained value network over legal candidates and their seeded faction replies, executed as a WebGPU compute shader. See `spec/go-ai.md`. |
| 10 | stanek | Pack the grid, then charge | **Exhaustive packing is PROVABLY optimal** — the strongest evidence in the roster. Correctly leaves out a large fragment to fit two smaller ones. |
| 11 | dnet | Traverse under a stasis-link budget | The controller/prober/agent pipeline explores and authenticates from resident processes, farms cache sources, reclaims RAM, promotes stocks, pins and migrates hosts, fires prepared storms, and walks the labyrinth. The simulator implements all 23 APIs and the complete cache/clue/contract reward lifecycle. |
| 12 | side | Solve every coding contract | **All 30 v3.0.1 contract types implemented** with exact registry coverage and known-answer tests. Discovery is ls-only; staged batches peak at `attempt` RAM, and a first rejection is logged and quarantined rather than retried. Infiltration stays manual. |
| 13 | progression | Install timing, reset cadence, node order | Exact favor crossover (`addRepToFavor`); directly tested live milestone selector, with a small-set ordering oracle retained for offline comparisons. |

### The hacking audit

Five questions from the legacy review, answered rather than assumed
(`tests/hacking-audit.test.ts`). All are closed; Q3 produced and fixed a real
loss, and Q5 (added in the 2024-batcher gap analysis) closed a standing open
question in `spec/jit-reference.md` without a code change:

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
- **Q5 — is a second batch parameterization worth building above
  `EXACT_THREAD_LIMIT`?** **CLOSED, no change.** The 2024 batcher brute-forces
  three anchors (`HxGW`/`HGxW`/`HGWx`) because its thread counts are
  fractional; ours are `ceil`ed, so below the exact limit the H-scan provably
  subsumes all three. `spec/jit-reference.md` left the question open ABOVE it,
  where we fall back to a grid plus golden-section refinement. Measured against
  the same independent exhaustive oracle Q3 used, extended past the limit: the
  H-only heuristic gives up **0.010-0.144%** across five large-domain cases, an
  order of magnitude below the 0.89% that justified Q3's fix, and **0%** under
  a binding RAM cap (the domain collapses into the exact regime). The reason is
  visible in the results — the heuristic picks 12,600 threads where the oracle
  picks 4,575 and still scores within 0.04%, because the score surface is FLAT
  across that region, so a second anchor lands on the same plateau. Pinned at
  `gap < 0.15%`.

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
   the slot at `career:blocking-need` whenever any blocking need exists, which
   outranks `factions:work` — so career held the slot permanently
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
  sub-heuristic. Estimates are computable from current evidence and tuned from
  logged prediction-versus-outcome data later.
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
`ScriptHackMoneyGain` entered `HackContext` at the same time, scaling the hacking
term but not the manipulation term; [spec/targeting.md](targeting.md) carries the
reason and the BN1/BN8 magnitudes it produces.

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

The magnitude that bounds what the tie-in can ever be worth — thousands of
dollars per influencing op against tens of millions per batch, so it is a
rounding error outside BN8 and the entire score inside it — is measured in
[spec/targeting.md](targeting.md); both directions are pinned in
`sim/tests/dispatch.test.ts`.

### Phase 16 — Go strategy and independent time forecasts

- Replaced the scalar, capped planning window with the typed
  `PlanningHorizons` contract. The install and BitNode forecasts are uncapped,
  anchored, recalculated every minute or on structural milestones, and
  preserve unknown/stale states plus critical-path component evidence.
- The progression panel now shows both countdowns, expected wall-clock times,
  confidence/recalibration age and parallel/sequential component tables.
  Telemetry retains the same typed objects for later calibration.
- Implemented rules-correct Go play with a trained value network (`go-ai/`) over
  legal candidates and their handcrafted faction-reply forecasts, driven by the
  public `totalPlaytime` WHRNG seed. TypeScript inference runs only as a WebGPU
  compute shader; missing or lost WebGPU fails explicitly. The production bundle
  imports no game source. Simulator parity tests import the pinned v3.0.1 board/RNG/effect
  implementations and detect drift.
- Replaced fixed opponent selection with ETA valuation across every opponent
  on the throughput-optimal 5x5 board. Node-power, difficulty, streak/comeback effects,
  nonlinear rep-to-favor conversion and the SF14 cap are exact transcriptions;
  win/score priors are fitted by upstream-AI tournaments and must be refitted
  whenever a new model is promoted.
  Game-duration coefficients remain heuristic planning inputs.
- Go telemetry records the public decision input, seed uncertainty, predicted
  replies, observed support and all reward candidates. The UI exposes the
  selected board/opponent and the transient/favor seconds behind its choice.

*Evidence:* `bun run typecheck`; the full `bun test` suite, including Go rules,
WHRNG/effect/favor parity and upstream faction-AI strategy tournaments.

## Profile ledger (baseline `8995e17` → `328b7ce`, 2026-08-09)

Virtual time-to-goal per profile, all listed seeds; runs archived under
`runs/baseline-8995e17/` and `runs/final-328b7ce/`.

| profile | baseline | final | note |
|---|---|---|---|
| factions-install | 6.0m ×3 | **4.0s ×3** | install-path convergence (drain ceiling, claim anticipation, wakes) |
| factions-donation | 4.5m ×3 | **2.0m ×3** | same fixes carried over |
| hacking-early | 18.5m median ×5 | **16.1m median** | idle-segment spillover; no seed worse |
| hacking-only | NOT reached ×3 (earn:1e9) | 42–44m (earn:5e6) | goal recalibrated to fixture physics — the old goal was ~100× out of reach and gave no gradient |
| career-karma | ~8.5m | ~8.9m | neutral; applyToCompany throw-spam 2,350 → ~18 per run |
| factions-join | **unfinishable** (40+ min real/seed, killed) | completes (~2–4 min real); goal NOT reached ×3 | sim pathology fixed; joining CyberSec within 2h remains a strategy gap (skill growth too slow on the fresh fixture — see targeting.md long-horizon prep gap) |
| stock-only | 5.95h / NOT / 5.26h | unchanged | untouched this pass |
| stock-manipulation | NOT / NOT / 5.76h | NOT ×3 | ALREADY ANOMALOUS: the hacking-assisted profile trails stock-only, and the one borderline seed slipped past the horizon after the churn fixes shifted timing. Open investigation. |
| bn1-speedrun | 2.83/3.02/2.83h | **2.53/2.43/2.71h** | −11% median; universityCourse throw-spam 26,643 → ~80 per run |

## Profile ledger, second pass (`328b7ce` → `4864d7f`, 2026-08-09)

The open-items pass: NeuroFlux price parity, the stock-manipulation regression,
and long-horizon prep investment. Runs under `runs/final3/`.

| profile | before | after | note |
|---|---|---|---|
| factions-install | 4.0s, **9** NFG levels | 46.8s, **41** NFG levels | NFG parity: the plan compounded the 1.9x queue multiplier per LEVEL where the game charges it once per NAME; the drain now converts ~$1.4b that used to be deleted by the reset. The slower clock IS the win. |
| factions-donation | 2.0m | 2.0m | unchanged |
| hacking-early | 16.1m median | 16.1m median | unchanged after making the fleet reserve demand-driven (a standing reserve had cost +28%) |
| hacking-only | 42.3m median | 44.0m median | −4%: occasional demand-driven reserve engagement, inside the acceptance bound; buys probe liveness |
| career-karma | ~8.9m | ~8.9m | unchanged |
| factions-join | goal unreached | goal unreached | still blocked on early skill growth; long-horizon prep correctly refuses a ~10h prep on a 23 GB share |
| stock-only | 5.95h/NOT/5.26h | unchanged | untouched |
| stock-manipulation | NOT/NOT/5.76h | NOT/NOT/**5.26h** | sampler starvation fixed (probe.skipped 374 → 0, market ticks 906 → full), influence filtered to real hosts, farm graduates to joesguns at 46.7m via long-horizon prep. `stockOps` still 0 — see the open item below. |
| bn1-speedrun | 2.43–2.71h | 2.69–2.75h | mostly the honest cost of complete NFG drains at every install (the faster number rode the pricing bug); ~3% is the reserve, measured by disabling it |

**Open (stock-manipulation, economic layer):** influence intents publish for
hours but no influencing op ever launches (`stats.stockOps` = 0): positions
deploy in the first minutes and entries never revisit the ranking head, so
`promoteManipulable` is inert — verified by three byte-identical A/B runs
(preference 0.25 → 0.6, and a farm-target preference). The next lever is the
entry/rotation mechanic itself, not the ranking.

## Profile ledger, third pass (`4864d7f` → `e1c3a14`, 2026-08-09)

The BN-time pass. The objective function is BitNode completion time —
augmentations die with the node, so every install/drain decision is priced by
its acceleration of the REMAINDER. Runs under `runs/final4/`.

| profile | before | after | note |
|---|---|---|---|
| bn1-speedrun | 2.69–2.75h | **2.43/2.45/2.46h** | best of any generation. The regression decomposed: zero installs in this profile (the NFG drain was innocent); MAX_PREP_OPS_PER_PASS=6 left the now-always-active prep segment idle while blocking spillover (utilization 90%→72%). Raised to 24. Riding along: RAM priced at MARGINAL income vs the published depth cap (a $450m 16 TB server had been bought half-idle), and the spilled fleet reserve best-fits the smallest host so the largest contiguous hack block survives. |
| factions-join | goal NEVER reached | **88m/93m/88m** | four chain fixes: near-complete non-objective gates post needs; a stalled objective latch (10 min, zero rep progress) yields to the frontier; port openers buy on money not skill (BruteSSH at t=0, CSEC rooted at 0.5m); invitations that foreclose nothing are accepted regardless of objective. |
| stock-manipulation | NOT/NOT/5.26h | NOT/NOT/5.25h, **stockOps 0 → 342** | the speculative intent closes the loop: one intent for the farm-pushable symbol BEFORE any position, the farm's flagged ops push the forecast, the estimator measures it, entries buy the manufactured edge. Farm graduates to joesguns at 19.5m (was 46.7m). Distributions tie stock-only; per-seed spread is shared-RNG divergence. The push physics cap at this fleet scale (~1 flagged grow/min ⇒ ~0.007 forecast/run) — the mechanism pays at bigger fleets. |
| factions-install / donation / hacking-early / hacking-only / career-karma | — | 46.8s / 2.0m / 16.1m / 44.0m / ~8.9m | all unchanged |

New policy, encoded: **the NeuroFlux drain is gated by the remaining node
horizon** (`NFG_MIN_PAYBACK_SEC`) — a +1% level repays ~1% of the remainder,
so a minutes-long remainder drains nothing. Unknown horizons keep the full
drain.

## Profile ledger, fourth pass (`30972c9` → `ac65d1b`, 2026-08-10)

The money pass: the two-loop money model, the arbitration/horizon audit, and
the fixes both surfaced. Runs under `runs/final6/`.

**The two-loop money model, now encoded.** BitNodes: nothing survives the
node — installs are suppressed when the remaining node time cannot repay the
install overhead (`INSTALL_MIN_PAYBACK_SEC`). Installs: only augmentations
survive, and every queued purchase escalates later ones 1.9x — so purchases
are END-LOADED: no mid-run buying, no mid-run aug-fund reserve; the money
compounds in investments; at the endgame the final sweep converts the whole
bankroll (plus the stock book's liquidation value) dearest-first. Package
completion and `shouldRecommendInstall` are REP-based: the frontier moves to
the next package while finished ones stay unbought until the sweep.

**Audit fixes** (details in the commit messages of `a83d40f`/`ac65d1b`):
corp's unspendable standing $150b reserve removed; career training runs
under a standing 30s-window reserve with a real admission bar; factions reads
per-claim grants (aug/graft/donation/travel) and verifies the fund before a
purchase; donations post at their own 70 band; install-lifetime horizons
never fall back above the node's (`installHorizonSec`); a
`progression:imminent-install` reserve (50) brakes investment bands when the
reset is forecast within `IMMINENT_INSTALL_SEC`; the former phase-keyed
`HOME_RAM_BUDGET` veto has been deleted in favor of central value curves;
the cash/earned `ending` arm remains only as the install and liquidation
state-machine trigger (allocation curves cannot initiate that handshake);
the arbiter's `RETURN_TOLERANCE` band makes "similar payback →
bigger earner" real while fast payback stays the primary key.

**Fixes the sweep itself surfaced:** the backdoor service head-of-line block
(a $250m opener for a far faction queued ahead of CSEC's ready backdoor);
dodge-stub EXEC failures now typed (`DodgeExecError`) and retryable instead
of silently latching one-attempt actions — and they feed the same starvation
signal probes use, so the demand-driven fleet reserve serves ACTIONS too;
reported horizons are 2-significant-figure coarse so forecast ticking cannot
re-publish digests every second.

| profile | third pass | fourth pass |
|---|---|---|
| factions-join | 88.1m/93m/88.1m | **85.1m/90m/85.1m** |
| factions-donation | 2.0m | **1.5m** (donations at 70, end-loaded flow) |
| factions-install / hacking-early / hacking-only / career-karma / bn1-speedrun / stock-only | — | unchanged (46.8s / 16.1m / 44.0m / ~8.9m / 2.44–2.46h / 5.95h-NOT-5.26h) |
| stock-manipulation | NOT/NOT/5.25h | NOT/NOT/5.79h — decision-timing noise on the known-volatile pair |

**Losing A/B, recorded:** an always-on small-home fleet reserve (vs the
demand-driven latch) — hacking-early 16.1m → 20.6m, bn1 +3%; only
factions-join liked it (−3.4%). The demand-driven latch stays: it BECOMES the
dedicated dodge host exactly when starvation is observed, now for feature
actions as well as probes.

## Profile ledger, fifth pass (install cadence & route heuristics, 2026-08-10)

The install-timing pass: when is a reset worth it, decided marginally rather
than by the cash-ratio proxy. Runs under `final7` (baseline `runs/final6`).

**The cadence rule is a renewal problem, not an amortization.** The first cut
compared the frontier's marginal push rate against `queuedValue/(nodeRemaining
+overhead)` — which makes a LONG node forbid installs. That has the physics
backwards: an activated multiplier accelerates all of the remaining node, so a
long node wants frequent small installs. Value accrues while pushing (rate p,
the frontier's own `marginalRate`) but only activates at an install; a cycle
of length T pays `p·T²/2` in inactive accrual plus the flat overhead O, and
the per-second loss is minimized at `T* = sqrt(2·O/p)`. So: **install when
the accrued reset value clears `sqrt(2·O·p)`** (× the 1.25 margin), with
`INSTALL_MIN_PAYBACK_SEC` still protecting the node's very end and
`routeRequiresInstall`/favor-crossings unchanged as fast-paths
(`installVerdict` in shared/strategy/progression/decide.ts).

**The accrued side is unit-consistent with the frontier.** `packageValue` is
`count + quality + favor terms`, so the reset side counts the same three:
each queued or SWEEP-REALIZABLE augmentation (joined faction, rep met, price
within the bankroll — purchases are end-loaded, so mid-cycle the queue is
empty by design and the realizable set is what opens the gate) contributes
1 + its mult-only log score (clamped ≥ 0; cost mults sit below 1), plus
banked-but-unrealized favor priced with packageValue's own
futureRateGain/crossesDonation at current rep. Without the favor term a
favor-purpose objective could never conclude; without the count term cheap
augs could never clear the threshold.

**Liveness class fixed, four members:** (1) empty-queue gate deadlock — the
sweep is triggered BY installWanted, which required a queue, which only the
sweep fills (`resetRealizable` opens the gate; a new `augmentations` blocker
holds the reset until the sweep converts something, because the game's
`installAugmentations` is a NO-OP with nothing queued and an armed empty
install sat forever); (2) frontier boot noise — a missing push rate now
verdicts "install" only when a published factions plan names no intent
(`frontierIdle`), not while the feature is still booting; (3) the permanent
verdict latch replaced by a symmetric 90s dwell — the only point of no return
is the sweep reaching ready/armed (a boot-noise latch had locked whole
cycles); (4) stale offers from factions a prestige just removed manufactured
install pressure in a cycle with nothing joined — the realizable scan now
filters to joined factions, which is all the sweep can buy from anyway.

**Route measurement:** bladeburner's leg now falls back to the plan's own
scored `rankPerSec` (forward estimate, marked measured) before the static
prior when the rank tracker has no signal; `endgame.route` re-emits on
MATERIAL recalibration (>25% eta movement or a part flipping to measured,
≤1/10min) so the decision record shows the self-correction the topic always
had. Deferred, still tracked in Known gaps: route-aware feature biasing
beyond factions (`ctx.route` consumers), grafting's push-without-reset role
(sim-unmodelled).

**UI:** the progression tab gains the endgame-route card (all routes, chosen
marked, per-part measured-vs-model breakdown), the install-cadence card
(verdict, accrued vs threshold, banked-favor component, favor-crossings
table — previously published but rendered nowhere), and an accrued-vs-
threshold time chart; `ui/app/lib/chart.ts` generalized to multi-series,
injectable y-formatter, per-canvas geometry (the module-level geom singleton
would have corrupted hover on any second chart).

**New profiles** (both BN4): `install-cadence` — banked-rep fixture (owns
nothing, rep banked at CyberSec/Sector-12/Aevum), goal `installs:2`, 125m.
The first fixture owned every augmentation, and the rule correctly refused
to install for 5 favor — a fixture where later installs are worthless cannot
prove cadence, so the fixture was redesigned until each install is genuinely
optimal. `install-favor` — fresh-ish start, CashRoot only, goal
`favor:CyberSec:75, installs:2`, 6h; the honest favor-conversion experiment.
A sim regression test (sim/tests/factions-strategy.test.ts) pins two
consecutive installs prestiging cleanly with the second driven by the
marginal verdict.

### SF12.30 full-BN calibration (August 2026)

The full BN1 harness includes career/city/karma/combat, companies, Hacknet,
stock and Go, with every augmentation purchase end-loaded into one frozen,
dependency-safe transaction. A post-plan push is accepted only when its
remaining work is at most 1% of elapsed time in the current install.

Pinned seed-1 observations used during tuning:

| policy/checkpoint | observed state |
|---|---|
| count-first closing baseline | installs at 1.210h (8), 2.938h (6), 7.248h (15); count 30 |
| route-selected combat valuation | same first two installs; closing 15-aug install at **5.948h** |
| nonlinear skill value, normalized cadence | one 12-aug install at **1.719h**; at 4h count 13 + 7 banked; at 6h count 13 + 12 banked |
| start-relative consolidation + funded closure | installs at **1.719h (12)**, **3.713h (10)** and **5.974h (7 distinct + 1 residual NFG)**; installed count reaches exactly 30, with no late partial reset |
| late Red-Pill fixture | predicted 2.339h from the 2h checkpoint, observed **2.314h** (about 1.2% error) |

The end-loaded handshake regression now completes that late fixture at
**2.3136h**. Its second/final transaction lands at 2.2869h with 15 distinct
entries (including The Red Pill and NFG) and six funded NFG purchases total;
the zero-price Red Pill is correctly paid last. The final live route sample at
2.2017h predicted 402 seconds remaining and the observed remainder was about
403 seconds. An unaffordable optional bank no longer blocks the terminal set:
the mandatory closure opens the transaction, the affordable subset and its
order freeze once, and install permission still waits for real ownership.

The `bn1-progression` startup fixture also exposed censored rate leakage: its
preloaded queue reset in four seconds and was being extrapolated forever as a
fresh-cycle augmentation rate. Startup-partial cycles below one minute are now
discarded and the augmentation-rate window clears on prestige; the post-reset
20-slot estimate changed from a falsely measured 8 seconds to an explicit
unmeasured 36,000-second prior.

The skill-value correction follows the exact game curve
`skill = mult * (32 ln(exp + 534.6) - 200)`: direct stat multipliers receive
local time-to-target sensitivity `target/(32*activeMult)`, then all weights
are normalized back to the fixed route-value budget so the units cannot cause
tiny premature installs. Known banked direct multipliers scale only the
post-install forecast; they never appear in live skills before prestige.

NFG mechanics were rechecked against pinned v3.0.1: repeated levels merge into
one `Player.augmentations` entry, while Daedalus checks that array's length.
Thus NFG contributes at most one distinct invite slot (SF12.30 starts at count
1), although additional funded levels remain valuable acceleration and are
jointly interleaved by the exact purchase-order solver.

Count consolidation is evaluated from the installed count at cycle start. A
substantial 13→23 tranche is allowed because it banks over half the remaining
gate; the following cycle starts inside the closing quarter and must reach 30.
At a mandatory boundary the transaction first freezes a funded, reputation-ready
distinct closure and only then spends residual cash on optional quality/NFG.
This also preempts an unfinished optional package: in the SF12.30 run the
seven-slot bank closed at 5.974h instead of continuing another projected 6.75h
of BitRunners work. Package ranking and final-set ranking now share the same
node-relative count-slot weight rather than using declining pressure in one
layer and a flat +1 in the other.

| profile | old rule | new rule |
|---|---|---|
| install-cadence | 1 install, then push-forever (0/3 seeds) | **reached ×3: 2 installs in 70.2m** — boot noise self-corrects at 20m via the dwell, value accrues while the Tian Di Hui package is worked, its landing clears the ~2.9 threshold and the verdict concludes the cycle |
| install-favor | NOT ×3 (6h): one install, cycles never conclude | 2 installs on seeds 1/3 (72m+280m, 42m+249m), 1 on seed 2; favor:75 still NOT in 6h — favor conversion works and late cycles stay alive (verdict honestly "push" at zero accrued value), but the goal is rep-physics-bound (recorded, kept as the stretch profile) |
| all nine existing profiles | — | per-seed parity with final6 (bn1 2.44–2.46h, join 85.1/90.1/85.1m, stock-only 5.95h/NOT/5.26h, hacking/career identical); stock-manipulation stays 1-of-3 with the reaching seed swapped (known decision-timing noise); factions-install 48s → 4.0s — the conclude-signal converts the cash in hand instead of waiting out the farm |

### Simulation tier cleanup (August 2026)

BN-level profiles now carry only stable optimization targets. Focused tests own
mechanism regressions, and one-off policy comparisons remain reproducible from
the CLI instead of running in every `bun test`:

```
# Former hacking-only profile: hacking-early differs only by goal and seeds.
bun run sim -- --profile hacking-early --goal earn:5e6 --seeds 1..3

# Go treatment/control comparison formerly asserted by bn1-progression-profile.
bun run sim -- --profile jit-lategame --seeds 1
bun run sim -- --profile jit-lategame --seeds 1 --only hacking,factions,progression
```

Retired profiles: `jit-process-pressure` (worker-count/HGW/pooling are covered
by the focused JIT, dispatch, and mode tests); `install-favor` (the favor goal
never landed on any seed and was rep-physics-bound, while `install-cadence`
pins two reachable installs); `stock-manipulation` and its `-mid`/`-large`
aliases (the comparison was unstable and tied its control; focused stock
strategy and dispatch scenarios pin the mechanism). The `hacking-only` alias
was merged into `hacking-early` via the command above. `stock-only` now uses
an 8h horizon so its 6h-boundary outcomes are measurements rather than
censoring.

### JIT batcher tuning surface

The profile ledgers above are the top tier: BitNode outcomes say what the
automation optimises toward. The fast JIT scenarios are the diagnostic tier:
they isolate why a profile moved and keep the best-known local measurement in
the same file as its regression guard.

- `sim/tests/scenario-jit.test.ts` (jit-target-switch) isolates old-target work still
  in flight when the evaluator retargets.
- `sim/tests/scenario-jit.test.ts` (jit-share-churn) isolates cooperative 10-second
  share slices yielding pipeline RAM and reclaiming it afterward.
- `sim/tests/scenario-jit.test.ts` (jit-fragmentation) isolates contiguous hack
  placement while cloud and home slabs change under a live pipeline.
- `sim/tests/scenario-jit.test.ts` (jit-stress) remains the all-at-once integration
  case after the three focused scenarios pass.

Each focused file records median idle share, landed/launched hacks, and steady
money/sec with an explicit tolerance. When tuning beats a number, update the
recorded optimum and its assertion in the same change; never move the ledger
downward to bless a regression.

A third tier sits below these: **pure-solver optima with an exhaustive oracle**,
which need no run at all and so can be asserted in `bun test`.

- `tests/hacking-audit.test.ts` (Q3) — exact integer thread search below
  `EXACT_THREAD_LIMIT`, oracle-matched to 12 decimal places.
- `tests/hacking-audit.test.ts` (Q5) — heuristic thread search ABOVE that limit.
  Recorded optimum: **worst-case 0.144% below exhaustive** (0.010-0.144% over
  five cases; 0% under a binding RAM cap, where the domain collapses into the
  exact regime). Asserted at `gap < 0.15%`.

Two tuning knobs are deliberately NOT tuned — deferred admission
(`spec/jit-reference.md` §9, measured twice and both times a loss) and
`POOL_PRESSURE_OPS` (blocked on a fixture; see Known gaps). Each stays put
because the measurement that would justify moving it has been taken and says
no, or cannot yet be taken.

## Profile ledger, sixth pass (2024-batcher gap analysis, 2026-08-19)

Four gaps closed, three questions answered without code, one blocked. Write-up
in the subsection below.

| profile | before | after | note |
|---|---|---|---|
| hacking-early (`--goal earn:5e6 --seeds 1..3`) | 16.1 m median | **29.9 / 30.3 / 29.9 m** | New recorded number. A REGRESSION from an earlier pass's polish, not from this one: byte-identical output including record counts with this pass's changes reverted and re-applied (it never enters the eager path, where both fixes live). Recovery outstanding. |
| jit-process-pressure | — | **produces nothing** | Retired from the default tier, and broken — it is the fixture the pooling gate needs. Numbers in Known gaps. |

One new measurement: **pooling engagement depth is ~395 concurrent ops after
180 s** on a 16 TB JIT fixture, against a `POOL_PRESSURE_OPS` gate of 1,000 —
so the obstacle to re-measuring that gate is pipeline DEPTH, not fleet size.
(Audit Q5, the thread-search optimum, is recorded above.)

### Gap analysis against the 2024 single-target batcher

`bitburner-2024` (`imports/batchPlanner.ts`, `batchRunner.ts`,
`scripts/worker.ts`) was near-optimal at batching one target. Reviewed end to
end.

**Closed.**

- **Fractional hack threads reached `ns.exec` on the eager/shotgun path.**
  `hackThreadsAtLanding` is unrounded by design so the arrival-money correction
  rides on strength; hack is not core-aware, so `allocFor` passed `threads`
  through to `ns.exec({threads})` verbatim. Now spawns `ceil` and carries the
  remainder as `strengthThreads` — what the JIT path always did, and what
  2024's worker does (`scripts/worker.ts:23-46`).
- **The eager path had no landing-level lookahead.** `ctxAt` was threaded into
  `launchBatches` and used only by the JIT branch, on a comment that justifies
  the exemption for SHOTGUN alone. An eager HWGW batch lands a full weaken-time
  after launch. Same strength cap now applies; shotgun stays exempt. 2024
  projects to landing on every shape (`batchRunner.ts:321-327`).
- **`batchesSkipped` pooled every cause.** `batchesSkippedBy` added, every
  increment through one `noteBatchSkipped` so the two cannot drift.
- **The landing-error instrument was invisible** — published to telemetry,
  rendered nowhere, so the live reading two disabled timing tightenings wait on
  could not be taken by looking at the game. Now split per op kind and shown in
  the hacking tab.
- **The batch panel's only chart was a curve drawn twice.** It plotted per-kind
  `ops` against `landed`, captioned as the band of ops that never arrived.
  `noteBatchLanding` returns early below `ops`, so a settled batch is complete
  by construction and those two sums are equal in every run that can exist: the
  band was identically zero, `BatchAggregate.lostOps` was unreachable, and the
  "N lost" badge could not fire. `tests/ui-farm-rates.test.ts` had been pinning
  the intent with a hand-written `ops: 300, landed: 298`, which is why it
  survived. Real loss went to a silent `delete` in `openBatch`'s eviction —
  a batch that loses an op never settles at all. That eviction is now counted
  (`abandoned`, `abandonedOps`, `abandonedLanded`), the run-level residual
  `launched - landed - inFlight` is drawn, and the invariant is pinned against a
  real dispatcher in `sim/tests/dispatch.test.ts`.
- **Per-kind means described no batch that existed.** Batches within one kind
  differ by orders of magnitude in size, so the cumulative per-kind mean the
  card led with was a figure no individual batch resembled. The card now leads
  with one mark per settled batch, defaulting to `$/GB·s` so a prep wave and a
  HWGW cycle are asked the same question; measured on a 20-minute sim run that
  spread is 3.1x inside a single kind. The per-kind sums remain, demoted, and
  the settled-batch ring says what fraction of the population it sampled.
- **The batch history dropped batches and sometimes discarded itself.** The
  viewer deduped the rollup's overlapping ring on a high-water mark, but ids are
  assigned when a batch OPENS and the ring is ordered by when it SETTLED, from
  one counter shared by prep waves and farm cycles. A prep wave spans a whole
  grow, so its low id routinely arrives late: it was silently dropped, and when
  it landed last in the ring it read as a restarted counter and cleared the
  entire accumulated history. Deduped on a set of seen ids now; a genuine
  install is still detected, on the cumulative counters where it is unambiguous.

**Answered, no code.**

- **Deferred admission** is 2024's `diffToTarget > POSSIBLE_LAGS` branch — the
  experiment already measured twice here, both times a loss
  (`spec/jit-reference.md` §9 carries the numbers). Its prerequisite is the live
  landing-error distribution, which the item above unblocks.
- **RAM reinvestment in target selection already exists**, and beats 2024's
  discrete `prepareGrowthTable` ladder: `incomePresentValue`
  (`shared/strategy/economics.ts`) discounts at a measured marginal return from
  `infrastructure.ts`, and `evaluatePrep` compounds fleet RAM *during* prep via
  `growingRamWorkSeconds`. (`prepScaleOf` in `evaluator.ts` is the SKILL
  discount — a different correction, easy to mistake for this one.)
- **A second batch parameterization is not worth building** — audit Q5 above.

**Blocked.** `POOL_PRESSURE_OPS` cannot be re-measured without a fixture that
reaches the pooled regime; see Known gaps. Changing it without the measurement
would repeat the mistake its own comment documents.

*Evidence:* 1,498 pass / 0 fail, typecheck clean. Both correctness fixes have
regression tests verified to FAIL against the pre-fix code.

## BN1 route ledger, seventh pass (cold-start install cadence, 2026-08-20)

`bn1-full` had never been measured. Screening it (seed 1, four-hour slices,
`bun run tools/bn1-screen.ts`) found a cold BN1 that **never installed a single
augmentation** and reported a route estimate of 1,138 hours. Three defects in a
chain, each found by measuring the next one down:

| what | before | after |
|---|---|---|
| first install | **never** | **1.47 h** |
| augmentations at 4 h | 0 | 4 (6 on the full benchmark) |
| route ETA at 4 h | 1,137.7 h | **53.5 h** |
| regrow leg | 654.3 h | 2.5 h |
| work slot held by `factions` | 11% | **80%** |
| `career` mean slot bid | 4.66e12 BN-s | 7.1e5 BN-s |

**1. The early count tranche demanded a quarter of the whole gate.**
`earlyCountBatchAllowed` required `ceil(30 × 1/4)` = eight distinct funded
augmentations before the FIRST install was permitted. A cold BN1 start has one
faction joined at that point — CyberSec, which offers five in total — so the
gate could not open from where the planner had reached. Its demand scales with
what REMAINS, making it strictest at the start of the gate and loosest at the
end, which is the opposite of the reset cost it exists to protect against.
Consolidation already guards the expensive half, so the early tranche only has
to reject a one-augmentation reset: `DAEDALUS_EARLY_BATCH_PROGRESS_FRACTION`
1/4 → 1/15.

**2. The cumulative-progress fit extrapolated without a prior to anchor it.**
`cycleProgressEtaWithPrior` guards the power fit with a completed cycle's shape,
but the first cycle of a fresh node has no prior, so the raw fit ran. Twenty
minutes in, with income at a healthy $28.7k/s against a $100b gap — forty days
linear — it returned **8.78e13 s, 2.8 million years**, on 30.6% of samples.
`fallbackSec` is the caller's linear estimate at the recently measured rate, and
acceleration (the only thing the fit exists to capture) can only shorten an
estimate; an extrapolation is now bounded by it. Interpolation inside the
observed span is exact and untouched.

**3. Faction work never announced that it produces augmentations.** That 2.8e13-second
money leg became a 1.7e14 BN-second money marginal, and `career` — which
produces money — bid 4.66e12 BN-seconds and held `Player.currentWork` on 90% of
passes. Bounding the fit fixed the magnitude but not the ordering: `career` still
outbid faction work about 120:1 on money alone, which is self-defeating, because
the $100b gate is reached through multipliers that only an install grants and only
reputation unlocks the augmentations an install activates. Faction work now
announces the route's count leg at `package size / package ETA`, and the slot
auction sees both sides of what reputation buys.

The chain was self-confirming: no install meant no multipliers, so the hacking
curve stayed flat, so the fit read the plateau as the future regime, so the
estimate grew the longer the run went on.

On the full benchmark (`bn1-full`, seed 1, 24 h horizon) the run now installs on
cadence — **3.26 h and 4.50 h, 11 of 30 augmentations by 5.64 h** — with the
route estimate at ~40 h. It does **not** reach `bn:1` inside the horizon, which
by the standing target (an optimal BN1 is under eight hours) is the next defect
to diagnose rather than a number to accept. Recorded in
`sim/tests/baselines/bn1.json`, failures included: a measured failure is the
starting point of the next improvement.

**`bn1-speedrun` is separately regressed, and not by this pass.** The ledger
tracks 2.43–2.46 h from an older generation. Measured on this branch by stashing
only this pass's changes, seed 1 takes **7.44 h without them and 6.23 h with
them** — so the route work recovered 16%, and the ~3× loss against the tracked
number predates it and is outstanding. Those archived runs predate the
controller-facing coding-contract runtime; current runs model the ten-minute
generation interval and its reward lifecycle.

## Dispatcher pass cost at depth (2026-08-21)

A live BN run froze: the planner owned the main thread (`pumpOccupancy` 0.99,
`pumpMs` ~150 ms at 7–8 pumps/sec) with 10,770 pending batches and 36,600
tracked ops. Depth is by design — `MAX_LIVE_WORKERS` is 400,000 and the
pipeline is meant to reach it — so every fix here is cost-side.

A Chrome performance profile of the running game found it, after a sim-only
profile had pointed at the wrong path entirely: the `jit-lategame` fixture
exercises the JIT launcher, while the frozen game was in the classic
`launchBatches` path. Recording the real game needs `bun run sync --readable`,
or every frame reads `start.js:1:<column>`.

| what | before | after |
|---|---|---|
| `jitTopologyFits`, 10x finer grid | 7x the cost | flat (~1x) |
| `jitTopologyFits`, 20 ms grid | 0.737 ms | **0.0034 ms** |
| dispatcher pass, ~3,300 batches | 18.0 ms | **5.7 ms** |
| pass at 1k / 20k in-flight | 0.56 / 6.58 ms | **0.19 / 5.26 ms** |

- **Slot packing built one array entry per slot.** `slotsFor` is
  `holdMs / intervalMs`, so a three-minute weaken on a 20 ms grid is ~9,000
  identical blocks, materialised and sorted and then best-fitted one at a time
  — and `chooseJitSchedule` binary searches, so it ran a dozen times a pass.
  Best-fit over equal sizes collapses (the smallest free block that still holds
  one keeps winning until it cannot), so runs of `{gb, count}` place the same
  packing. Verified against the previous implementation on 200,000 randomized
  role/topology/interval combinations, zero divergences; guarded by a ratio in
  `tests/jit.test.ts` that fails on the old code.
- **The classic launcher rebuilt its whole ledger per batch.** `launchBatches`
  walked every tracked op on the target for each batch it planned. It now
  materialises once and tops up, keeping landing order so `predictAtLanding`
  skips a filtered copy and a re-sort as well.
- **The JIT launcher built ledgers nothing read.** `nextWeakenLanding` was a
  `.find()` over the fully sorted ledger, which forced that build every pass;
  it is a min-query and is now scanned directly. The fold ledger and the
  planning ledger are built on first use — a settled pass consumed none of the
  former and tripped the depth guard before reading the latter.
- **Folds allocated a state object per op.** `applyLedgerOpInto` writes through
  one; at depth the pure form was hundreds of thousands of short-lived objects
  per pass, visible as major GC in the profile.

**Open.** `sim/tests/dispatch-scaling.test.ts` now reads ratio ~27 against a
bound of 25 — not a slowdown (both depths got faster) but a smaller constant
exposing the `O(n log n)` sorting still left in `launchDueJit`. The bound is a
ratchet and must not be loosened; closing it means maintaining the ledger in
landing order across `trackOp`/`untrackOp` instead of rebuilding it.

## BN8 market fidelity, darknet propaganda, and stock-only run cost (2026-08-21)

Three things, in that order: audit the market, model the one modifier that was
still stubbed, then make the profile cheap enough to iterate on. The audit came
first because tuning a wrong simulator only makes it wrong faster.

**The price engine was already sound and was not touched.** A line diff of every
vendored `StockMarket/*.ts` against the pinned upstream checkout shows
differences only in import paths and the declared substitutions. What diverged
was the surface we wrote ourselves:

- **`ns.stock.getVolatility` dropped the darknet multiplier.** Upstream returns
  `stock.mv * getDarknetVolatilityMult(symbol) / 100`; we returned `mv / 100`.
  Latent while the stub returned 1, and exactly the call a promotion strategy
  reads to see its own effect.
- **`ns.stock.getOrders` had no BitNode gate.** Upstream needs TIX **and** BN8 or
  SF8.3 and throws otherwise; we answered `{}` to anyone with TIX. An empty book
  is observed state only once past the rung.
- **`getPurchaseCost` / `getSaleGain` were priced but not implemented.**
  `ram-costs.ts` charged for both while the namespace proxy reported them
  unmodelled — a RAM budget for a call the runtime refuses.
- **`purchaseWseAccount` re-rolled a live market.** Upstream guards on
  `isStockMarketInitialized()`. Buying TIX first is legal, and in that order the
  WSE purchase destroyed every price and every position. The sibling guard in
  `purchaseTixApi` was wrong the other way: it tested `SymbolToStockMap`, which
  `initSymbolToStockMap` only ever overwrites and never clears.
- **The shorts gate read owned, not active, source files.** Upstream uses
  `activeSourceFileLvl`, where a BitNodeOptions override at any level — zero
  included — replaces what the player owns.

**The darknet volatility boost is now modelled end to end.** `DarkNet/` cannot be
vendored, so the charge curve, the 0.4x per-cycle decay and the
wait/charge/charisma formulas are transcribed, with both upstream files added to
the `drift-pins` hash table. `ns.dnet.promoteStock` deposits charges in
`sim/features/dnet.ts`; the adapter hooks are injected rather than stubbed, so
the vendored price engine and `getVolatility` cannot disagree. Charges clear on
prestige, on the same boundary that destroys the portfolio. See
`spec/dnet.md` for the formulas.

**Run cost.** The premise going in was that the BN8 sim was slow. It was not —
one seed of `stock-only` was 2.4 s, and a full eight virtual hours with the goal
disabled was 3.8 s. What *was* wasteful was cheap to fix, and a CPU profile
(`bun --cpu-prof`) picked the targets rather than reasoning did:

| what | before | after |
|---|---|---|
| `stock-only`, 3 seeds, wall clock | 5.48 s | **2.42 s** |
| one seed, full 8 h horizon | 3.82 s | **3.40 s** |
| `Object.entries` self time in that run | 247 ms | **79 ms** |

- **Multi-seed runs were sequential.** The fan-out to one child process per seed
  is required — `currentNodeMults`, the `StockMarket` singleton and the patched
  timers are all module state — but `await proc.exited` sat inside the loop,
  leaving 11 of 12 cores idle. That isolation is precisely what makes the seeds
  safe to run concurrently.
- **`manipulable` re-scanned the network per symbol.** `rankSymbol` asked
  `Object.entries(symbolByHost).some(...)` for each of 33 symbols, at controller
  cadence, for the whole run. The set of influenceable symbols is inverted once
  per pass instead.
- **The symbol/host join was rebuilt every pass from live state.** A server's
  organization is fixed in the game's own table and so is a stock's, so the join
  is a constant — `SYMBOL_BY_HOST`, already in the bundle and already pinned
  against vendored `SERVER_METADATA.org`. The driver now uses it, `farmableHosts`
  walks the 33 known stock hosts instead of the whole network, and the
  `stock.organizations` probe — whose only consumer was that rebuild, and which
  paid `getOrganization` RAM to rediscover what the bundle ships — is gone.

All three seeds reach the goal at the same virtual time with the same record
count as before, which is the bar this work had to clear.

**Open.** The largest remaining cost in a `stock-only` profile is not stock:
`JSON.stringify` is 12.6% of the run, almost all of it `publishArena`'s
change-filter encoding the RAM arena digest on every 200 ms controller pass, with
`bestAnnounced`'s `join` at 4.3% behind it. Both are controller-wide and were out
of scope here.

## Stock correctness pass and the staged capability ladder (2026-08-21)

A review of the stock stack (strategy, driver, probes, sim wiring) plus the
simulations that turn its capability rungs into measured experiments. Fixes
first, so every baseline below was recorded on corrected behavior:

- **The price sampler had zero margin.** `stock.tick`/`stock.forecast` polled at
  exactly 4,000 ms — equal to `msPerStockUpdateMin`, the tick interval during
  stored-cycle catch-up — so any stub latency straddled two ticks, compounding
  two moves into one observed step and corrupting the volatility inversion and
  the cycle clock. Both probes now sample at 3 s (`SEC_3`), and the ladder's
  blind lane asserts ≥580 of ~600 hourly ticks observed.
- **The documented confidence gate is now the implemented one.**
  `ForecastEstimate.confident` (samples ≥ `FORECAST_PRIOR_STRENGTH`) rides
  `RankedSymbol` into `planEntry`; the weaker `isConfident` re-check is gone.
- **The $25b 4S pricer un-shrinks with the estimator's own factor.**
  `estimateSignal` exposes its Beta shrink `n/(n+k)`; `fourSigmaGainPerSec`
  divides by it instead of asserting ×2, and looks symbols up through a Map
  instead of an O(n²) `find`.
- Dead `StockView.moneyGranted` removed; `resetStockState`'s double reset
  dropped; `planExits`' misnamed `holdTicks` renamed to `guaranteedTicks`.
- **Synthetic SF8 now grants WSE+TIX** (`sim/game-run.ts` reads
  `world.player.sourceFiles`, matching `canAccessBitNodeFeature(8)` — owned SF8
  in any node), and **`disable4SData` is a first-class run option** wired into
  both `ns.getResetInfo().bitNodeOptions` and the market's purchase gates.

**The ladder** (`stock-ladder-blind|4s|shorts`, `sim/tests/stock-ladder-profile.test.ts`,
`bun run long stock`): one BN5 world, three strictly increasing capability
rungs — blind (no 4S by node option, no shorts, signals inferred from prices),
+4S TIX API, +owned SF8.2. The blind lane pins fidelity: every acted-on signal
estimated, zero 4S purchases, and every recovered volatility inside its
transcribed generation range AND equal to the actual hidden roll read off the
vendored market (the shared-roll grid inversion solves after one hour of
ticks). The upgrade lane pins monotonicity at a fixed horizon across the five
profile seeds: `median(4s) >= median(blind)`, `median(shorts) >= median(4s)`.

**The interplay pair** (`bn8-manipulation-control|bn8-manipulation`,
`sim/tests/bn8-manipulation-profile.test.ts`): the three low-tier symbol hosts
in BN8, where `ScriptHackMoneyGain: 0` makes `{stock:true}` manipulation the
only thing hacking can add and `DarknetMoneyMultiplier: 0` zeroes darknet
income but not propaganda. Both sides run fidelity-clean with dnet enabled.

**The route leg** (`bn8-full`, `bitnode-route`, route `bn8-first`):
`EntranceIdentity` now admits a declared-fresh BN-N entrance (entrance BitNode
must equal the leg's), so a market-first route needs no checkpoint. The smoke
lane (`sim/tests/bn8-full-profile.test.ts`) proves the full surface is
simulatable — zero unmodeled, node-granted WSE+TIX on the first account probe.

**FINDING, pinned in both BN8 lanes: the unmeasured RAM-investment fallback
drains the node grant before the market can trade.** Hacking's
`infrastructure:ram` claim is granted unconditionally while its BN-time value
is unmeasured (`pricing: "hard", value: Infinity` — the deliberate BN1
bootstrap rule). In BN8 the largest affordable rung is a $225m 256 GB server,
the farm it feeds pays $0 forever, and the market — the node's only income —
is left below one round trip and cannot even measure its own value to
counter-bid; hacknet's Netburners-milestone nodes ride the same window. The
$250m node grant is gone within minutes, `tradesMade` stays 0 for the whole
horizon while the stock-only control multiplies the same bankroll. The repair
belongs to the interplay tuning: the option's own vendored-formula expectation
is a KNOWN zero in BN8, not an absent measurement, so the fallback must not
apply — and when it lands, the pinned FINDING cases in both lanes fail by
design and become the real uplift/trading assertions.

Also recorded: the pre-fix sampler risk of compound steps inside `history.ts`
(a corpus-solve failure with a median roll estimate above 1) is second-order
now that the cadence is 3 s, and remains unhardened by choice.

## The BN8 capital drain, repaired by calculation (2026-08-21)

The finding above — the whole node grant converted into zero-return servers
before the market's first trade — is retired by three fixes, each a
calculation the model was already entitled to make rather than a rule keyed on
a node number:

1. **Investments must carry evidence** (`isEvidencedInvestment`,
   game/lib/features/hacking.ts). The unmeasured-value fallback ("unknown must
   not erase a productive spender") now applies only to a spender whose OWN
   closed-form expectation — computed from the vendored formulas WITH the
   node's multipliers — is positive. A zero there is a measurement of
   worthlessness, not an absence of one: BN8's farm income is a known zero, so
   its RAM rungs stop claiming money the moment the formulas say so, and start
   again by the same calculation once a held position gives ops manipulation
   value (`stockIncome` in the target score). BN1's bootstrap is untouched
   because its expected income is positive from the first solve.
2. **Marginals publish their operating point** (`ResourceMarginal.atRatePerSec`,
   shared/strategy/progression/marginal.ts → game/lib/income.ts). The money
   marginal is a derivative taken at `max(measured rate, FALLBACK_MONEY_PER_SEC)`
   — the same rate the route ETA itself is priced with. `moneyRateValue` now
   converts absolute $/sec at that exact operating point when no income has
   been measured, instead of refusing. The refusal was circular starvation:
   the FIRST income source of a node can never show a measured income before
   it is funded, so it silently lost every auction to any claim that happened
   to be priceable (BN8: experience-valued fleet RAM).
3. **The market defends its working capital** (`StockPlan.reserve`,
   shared/strategy/stock/decide.ts → the stock driver's `mode: "reserve"`
   claim). Between entries — while the estimator gathers samples or the best
   edge sits inside the band — the bankroll's expected trading rate (the
   larger of the closed-form blind rate and the best ranked candidate's
   expectation) is posted under the position claim id. A competitor must now
   out-price the market's expected return to take the cash, and the reserved
   money is simply still there when an entry clears its gates.

Measured on `bn8-manipulation` seed 1 (30 virtual minutes): before — $250m →
$80k, zero trades, 8 servers bought; after — zero servers bought, 4 trades,
realized profit +$8.7m, wealth $258.5m.

Running the same seed for the full two hours exposed the next layers of the
same auction, each fixed by another calculation:

- **Sale proceeds were a stale-topic windfall.** A liquidation's cash landed
  in the arbiter's pool up to two passes before the market's own view (the
  sweep-sampled player topic) knew about it, and the reserve — sized on the
  stale pocket change — was absent for exactly that window ($390m scooped by a
  $318m rung in 500 ms). Two fixes: the reserve is sized over the whole
  BANKROLL (cash + book at liquidation value; claims are full-ambition
  requests, the pool bounds what is actually reserved), and a trade batch now
  advances `topics.player.money` from the cash its own stub read — the exact
  pattern executeInfrastructure already used after purchases.
- **Money purchases were priced with capital-coupled income.** The farm score
  blends hacked income with `stockIncome` — manipulation value that exists
  only while the market's bankroll stays deployed. Pricing a purchase OF that
  bankroll with it double-counts the same dollars (the market's reserve
  already bids the return on that capital). `capitalIndependentScore` strips
  the stock share out of `marginalRamIncome`, `hackMarginalValue`'s money
  channel and `homeCoreIncomeDelta`; RAM ALLOCATION keeps the blended score,
  because allocating RAM consumes no capital.
- **The measured trading rate was built from misaligned ledgers.** The money-
  sources probe's 2-minute-stale net cashflow (which counts an open position's
  purchase as money GONE) mixed with a live portfolio value made the market's
  measured rate vanish at precisely the post-sale pass the reserve most needs
  it. The driver now tracks its own trade cashflow — each batch's
  after-minus-before cash, both read inside the same stub — and adds the live
  book; `moneyRateValue`'s cumulative income likewise adds the book back so a
  deployed portfolio no longer understates every money-priced claim (measured:
  17x) relative to non-money channels.

**The lane's remaining pinned finding — the tuning step's calibration
target.** With every distortion above removed, the auction is honest and the
model still eventually converts the grown bankroll into fleet RAM on its
EXPERIENCE value: under progression's install-horizon marginals, money and
hacking-exp seconds price at similar scale (~1e4 s per relative rate), so a
$318m home rung that roughly triples exp throughput out-values the reserve's
~2.6x smaller relative money gain. Measured, seed 1, two hours: control
(market alone) $250m → $404m; treatment $250m → $74k after +$88m of realized
trading profit. Whether the install-horizon marginal may price a node whose
only money source is the market — the $100b Daedalus gate lives on the NODE
horizon — is the calibration question `bn8-manipulation` now measures
directly.

**Still open, pinned by `bn8-full-profile.test.ts`:** the 8 GB cold start.
The market is PROBE-BLIND for its first ~3.5 virtual minutes (the known
dodge-budget starvation for fresh 8 GB homes — first `stock` topic record at
t=212 s on seed 1), so no plan exists, so not even the reserve is posted, while
progression's route marginals land at ~200 s and briefly make RAM the only
priced bidder. The $250m is spent in that ~10 s gap. The repair is the probe
starvation itself, or pricing home RAM's probe-enabling value; the stock-side
economics are proven sound wherever the market can see.

Also observed while verifying: `sim/tests/scenario-bootstrap.test.ts`
(`infrastructure.length > 0`), one `sim/tests/dnet-unlock.test.ts` case, and
three hacking scenario lanes (`scenario-share`, two `scenario-jit` cases) fail
on the BASE commit with a clean tree — pre-existing breakage unrelated to this
work, each verified by a stash-and-rerun.

## The exp/money inversion and the probe convoy, repaired by calculation (2026-08-21)

The follow-up pass to the drain repair. Its instruction was explicit: never a
node-keyed rule, always a computed value — and every defect below turned out to
be a place where the computation was wrong, not missing.

**The 8 GB cold start's probe half is solved; its allocation half is the
remaining pin.** The probe runner's single per-pass slot had
head-of-line blocking: earliest-deadline-first re-selected the same
unplaceable 4.6 GB probe every pass, its acquire came back queued, and the
pass returned — so even the 0.2 GB stock account probe waited ~3.5 virtual
minutes for the farm to happen to free RAM (bn8-full seed 1: first stock topic
at t=212 s; the node grant was spent by then-priceable RAM claims in the blind
window). The runner now falls through to the next due probe that can actually
place; the blocked head's broker request stays queued, so its starvation
feedback still grows the arena. Measured after: the market's first trades land
inside the 15-minute smoke window from a cold 8 GB home. What the probe fix
does NOT settle by itself is the cold-start ALLOCATION with the full surface
live: RAM claims become priceable (exp rates measure immediately) while the
market's measured rate cannot exist before its first trades, and the route's
unmeasured money rate was one flat hacking-era constant.

**The cold-start allocation is settled by a node-aware money PRIOR.** When no
income has been measured, `sampledRates` now composes the rate per channel
from the node's own transcribed multipliers instead of assuming the flat
`FALLBACK_MONEY_PER_SEC`: the hacking channel is that fallback scaled by
`ScriptHackMoney x ScriptHackMoneyGain` (exactly the tuned constant in BN1,
exactly zero in BN8), plus — when WSE+TIX are accessible — the market's
closed-form blind trading rate on the current bankroll
(`blindBankrollRatePerSec`, the same vendored-generation-ranges estimate the
unlock ladder already prices with). A rough node-aware guess beats a precise
wrong-node number: the money gate then reads ~2.3e7 seconds at the blind rate
instead of ~4e5 at the fallback, the money marginal dwarfs the exp marginal
from the first pass, and the reserve defends the grant before any income
exists. Measured on the bn8-full 15-minute smoke (8 GB cold start, full
surface): $229m of the $250m grant still working with zero RAM spend and live
trading, against the $11k the finding pinned.

**The exp-over-money inversion was five computational errors stacked:**

1. **A realized trading loss reset the route's money tracker.** RateTracker's
   decrease-clearing is its prestige detector; a cumulative-earnings series
   dips on every losing round trip, so the window never accumulated and
   `rates.moneyPerSec` read ~0 — the route then priced money at the 250k/s
   FALLBACK (63x the market's real ~20k/s at that bankroll), making
   S_hacking (4.1e6 s) tower over S_money (396k s). The exact inversion of the
   truth. The moneyEarned tracker is now monotone (small decreases clamp to
   the running maximum) and is cleared explicitly at the prestige boundary
   sampledRates already detects, like the augs tracker.
2. **Route earnings used the position-blind ledger.** `sinceInstall.total`
   plunges by a position's whole cost at every open; the route's rates and
   cycle curve now read `earnedSinceInstall` (game/lib/income.ts) — ledger
   total with the stock component replaced by the driver's self-tracked trade
   cashflow plus the open book at COST basis (monotone except realized
   losses, which the tracker above absorbs).
3. **Rungs were priced on the tangent line.** `secondsPerRelativeRate` is a
   derivative; multiplying it by a +294% relative gain claimed 2.94 nodes of
   saved time on one clock. Whole-purchase values now use the exact
   hyperbolic saving `g/(1+g)` (`relativeGainSaving`,
   `hackRungValue` in shared/strategy/share.ts; same form in
   `moneyRateValue`), identical to the derivative at small g.
4. **The exp channel ignored the demand ceiling.** The money channel always
   capped a rung's productive GB by the farm's pipeline demand
   (`marginalRamIncome`); the exp channel credited the whole rung. Both now
   value only `min(addedRam, valuableGb)`.
5. **A fully-covered band quoted zero scarcity.** `waterFill` returns
   lambda 0 when the pool covers all continuous demand, so any priced step
   bought ahead of a working-capital reserve that demanded every dollar at
   1.72e-3. Economic steps are now priced against the lambda their own grant
   would DISPLACE — the band's clearing price with the pool reduced by the
   step's cost (floored at $1 of pool so an oversize step prices against the
   first displaced dollar). The one behavior pin this moved
   (tests/arbiter.test.ts "callback's next rung") was asserting a
   value-DESTROYING allocation (460 against the curve-only 500) and now pins
   the corrected auction.

Supporting seams from the same pass: route marginals take the LARGER of the
install and node slopes so one clock cannot mask the other's dependency (the
$100b Daedalus gate lives on the node clock); trades advance
`topics.player.money` from the cash their own stub read, closing the stale-
topic window a $390m liquidation was scooped through; the working-capital
reserve is sized over the whole bankroll and posted ALONGSIDE the entry claim
under its own id (`working-capital`), so no pass is undefended; and money
purchases are priced from the capital-independent farm score
(`capitalIndependentScore`), because manipulation income exists only while
the bankroll it would spend stays deployed.

**Measured, bn8-manipulation, 2h.** Before the pass: treatment $74k terminal
against the control's $404m. After: treatment $482m/$256m/$537m on seeds
1/2/3 against controls $404m/$682m/$557m — every seed keeps and grows the
$250m grant. Controls are byte-identical to the pre-pass baseline; the
BN1 guards (`hacking-early` 12.9m byte-stable, bn1-progression, the stock
ladder) are unchanged.

**Manipulable preference (v1) and its follow-up.** The solver's ranking now
breaks genuine return-on-capital ties toward manipulable symbols — at equal
calculated return, the farm's push optionality is free — and the plan digest
publishes `manipulable` per ranked entry so tuning can see it. The full
version needs the one quantity nothing measures yet: the ops-per-second the
farm would deliver to a PROSPECTIVE position (the realized rate exists only
while manipulating, `stats.stockOps`). Publishing a measured
influence-ops-per-second for the current farm target, and folding
`manipulationValuePerOp x thatRate` into the candidate's expected profit,
is the designed next step; folding an invented rate in instead is how an
estimator starts trading on its own guesses.

Remaining for tuning (measured, not fixed): one treatment seed still buys one
$318m rung at a boundary pass (staying above the viability floor). The
reserve's claim rate is refreshed at the auction boundary from the live
measurement rather than the one-tick-stale plan, which narrows the windows
but does not close every one. A rebase onto upstream work reshuffled pass
timings and surfaced the last member of the one-pass-hole family: an ENTRY
whose buy is RAM-starved for a few passes leaves its granted-but-unspent
bankroll in a band with no continuous claim (the reserve had subtracted
entry.cost), and a rung took it at lambda zero. The reserve is now floored at
the viability floor whenever the auction is CONTESTED — any money bid last
pass from a feature other than the market and progression's install machinery
— so no pass composition can drop a market-only economy below the point where
a trade clears its commissions. Both miscalibrations of that insurance were
measured before landing on this: a full-bankroll overlap froze trading
entirely (three seeds, $250m defended, zero trades ever — the reserve's own
hyperbolic curve out-bid its flat-valued entry), and an unconditional floor
cost a 7% median shortfall on the isolation ladder, a pure premium with no
counterparty to insure against. The per-seed lane invariant is exactly that
floor.
The uplift question — treatment BEATING control — remains the manipulation
tuning target.

**The full-day leg exposed two more layers, both repaired by calculation.**
The first 24h bn8-full benchmark ran VALID end to end (283,872 records, zero
unmodeled, zero crashes) but ended at $284k with no install: at t≈56 min
progression ordered a liquidation for an install it then never performed, the
solver's liquidate branch posted NO reserve by design ("reset imminent,
overrides everything"), and the freed $247m book was eaten by infrastructure
claims at zero opposition — after which no trade could ever clear its $200k
round trip again. Two fixes: (1) the working-capital reserve now STANDS during
liquidation — conversion is for the INSTALL, whose own higher-priority claims
outrank the reserve, so it blocks only peers; (2) the reserve's value curve is
no longer flat-marginal: the same closed form its rate comes from has two
fixed $100k commissions per round trip, so it implies a computable viability
floor (`blindViableBankroll` ≈ $31m blind), and the q-th reserved dollar is
priced hyperbolically against that floor — taking the LAST viable dollars of
a market-only economy must out-bid the whole enterprise by the model's own
arithmetic. Measured (bn8-full seed 1): hour one ends with the full $250m
grant intact where it previously ended at $38k and dead. The standing
liquidation reserve shifts the manipulation fixture's paths too (2h seeds now
$482m/$119m/$537m; seed 2 still concedes its one $318m rung) — every seed
keeps a live, trading economy above the viability floor, which is what the
lane now pins per seed; holding the full grant everywhere stays the tuning
target.

**A second harness discovery: `--perf` is a different TRAJECTORY, not the same
run without records.** The telemetry sink's batched sends live on the virtual
timer queue, so switching telemetry off reorders equal-deadline timers from
the first pass — measured: the same seed's `faction.joined` lands at
...61706527 vs ...37914297 microseconds, and the divergence compounds into a
genuinely different run. `tests/build-perf.test.ts` pins per-pass stored-state
behavior, which holds; trajectory equality was never true. Consequence: the
24h `--compact --perf` bn8-full benchmark samples a DIFFERENT path than the
telemetry-on lane, and that path still contains a reserve-absent drain window
(byte-identical across the liquidation-reserve and viability-curve fixes,
proving the window it dies through is one those fixes never see — most likely
a probe-timing hold where the stock topic's book reads zero while the cash is
deployed). The telemetry-on trajectory is healthy through hour one with the
full grant. Open item: either give the reserve a bankroll source that cannot
be probe-stale (the driver's own tradeCashFlow implies the book), or accept
that benchmark trajectories need the same per-window defenses chased on the
lane trajectories.

A harness lesson from verifying it: the one-run-per-process contract
(spec/simulator.md) is real for OUTCOMES, not just for crashes. A treatment
run that ends at $482m first-in-process ends at $248m as the sixth sequential
`runGame` in the same Bun process — module state in the game's drivers
carries across runs and legitimately changes decisions. The BN8 lanes were
restructured so every `runGame` is its own lane case (the runner spawns one
process per registered case); multi-run cases like the stock ladder remain
tolerable only because their assertions are medians and range checks rather
than per-run economics.

## Known gaps in the current implementation

Stated plainly rather than buried, because several features are implemented to
the *strategy* level without full end-to-end execution:

- **Corporation actions are not executed.** The stage machine, its
  preconditions and its digest are complete and tested; issuing the calls
  against an unmodelled world is the one thing this project refuses to do.
- **Sim models exist for factions, crime, hacknet, stock, Go and dnet.** The
  darknet model covers all 23 APIs, mutation/restart, sessions, labyrinth and
  storms, cache/clue rewards, live stock grants and coding contracts for fresh
  and multi-install controller runs. Its declared boundary is save/offline/UI
  state, not a fabricated controller-visible value. Gang, corp,
  bladeburner, sleeves and stanek have pure strategy + driver + tests, but no
  complete system model — so their ns calls report `unmodeled()` rather than
  fabricating. Go additionally runs differential strategy tournaments against
  the pinned upstream faction AI.
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
    converge rather than match: the drain freezes a funded order and removes
    purchases from it as they complete. That convergence is the invariant to
    preserve, not field-by-field equality.

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
- **The darknet volatility boost is modelled; the STRATEGY does not use it yet.**
  `ns.dnet.promoteStock` raises a symbol's volatility only — it does not change
  forecasts and earns nothing directly. The simulator now implements it end to
  end: charges live in `sim/features/dnet.ts`, the adapter's
  `getDarknetVolatilityMult` / `scaleDarknetVolatilityIncreases` are injected
  rather than stubbed, so the vendored price engine and `ns.stock.getVolatility`
  both see the boost, and it decays 0.4x at each market cycle. It is a live BN8
  lever — the node zeroes the darknet's income multipliers but not propaganda,
  and access needs only `DarkscapeNavigator.exe`. What is still open is whether
  `shared/strategy/stock/` should spend threads on it: nothing plans a promotion
  today.
- **Route bias is heuristic, not an exact downstream schedule.** Factions now
  values augmentations against the selected route and the ETA-selected
  Daedalus hacking/combat alternative; career and Go consume the route's
  published needs. Corp, sleeves and Stanek still use their own local value
  models rather than translating every route component into weights.
- **Player-work XP is marginal, not exclusive.** Algorithms converts a level
  gate to raw remaining experience with the nonlinear skill curve, then counts
  normal hacking XP as background progress under both choices. During a
  competing route-reputation interval, only the wall-clock Algorithms still
  removes receives priority. Before the explicit skill gate, the same priority
  decays as `courseXP / (courseXP + fleetXP)`, preserving the cold bootstrap
  without starving reputation after the hacking fleet takes over.
- **SF12.30 cadence checkpoint (seed 1).** The marginal-XP change exposed a
  favor/count interaction that reset at 1.63 h with only four new augmentations.
  Favor is now counted once per faction curve and early count value requires a
  funded third of the remaining node-relative gate. The corrected run had no
  install at 2 h with seven augs banked, then installed twelve at 2.59 h
  (`runs/1786550754662-sim-sf12-30-count-cadence-release-seed1.jsonl`).
- **The labyrinth route fallback is uncalibrated** (`LABYRINTH_WALK_SEC`). The
  walk is implemented and simulated; the route ETA still marks its fallback
  unmeasured until completed walks provide a stable calibration.
- **`POOL_PRESSURE_OPS` is unmeasured, and blocked on a broken fixture.** Its
  own comment states that the -20% result behind it was taken while `planTake`
  was quadratic, so "always on" was also "always quadratic" and stranding was
  never isolated. Re-measuring needs a fixture that reaches the pooled regime,
  and none exists: the deepest available reaches ~395 concurrent ops against
  a gate of 1,000, and `jit-process-pressure` — the profile written for exactly
  this — produces no landings at all (12 virtual minutes on a 128 TB home,
  6.2 TB in use, `landed` zero for hack, grow and weaken; retired from the
  default tier, which is why it went unnoticed). Repairing that profile is a
  prerequisite, not housekeeping, and the constant is left alone rather than
  guessed at.
- **`hacking-early` regressed 16.1 m -> 29.9 m** during an earlier pass's
  polish. Recorded in the sixth ledger pass; the cause is known, the recovery
  is not yet done.

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
