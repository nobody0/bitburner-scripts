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
| 4 | stock | **done** |
| 5 | gang | **done** |
| 6 | corp | **done** |
| 7 | bladeburner | **done** |
| 8 | sleeves | **done** |
| 9 | go | **done** |
| 10 | stanek | **done** |
| 11 | dnet | **done** |
| 12 | side | **done** |
| 13 | progression | **done*** — decision layer live (endgame route + horizon); the act half (install / destroy) is deliberately unwired |
| 14 | endgame route + refresh/act split | **done** — see below |

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
(20.6 / 18.2 / 18.2 minutes on seeds 1–3), and the only probe still reported
unaffordable is `side.infiltration` at a genuine 15 GB against a 13.9 GB budget.

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
| 4 | stock | Risk-adjusted return net of commission and 4S | Commission-aware minimum trade size; refuses to trade without a forecast rather than paying $200k a round trip to guess. |
| 5 | gang | Respect/money/territory without the wanted penalty | **Coupled** exact assignment — the wanted penalty is gang-wide, so per-member argmax optimises the wrong function. Analytic ascension crossover. |
| 6 | corp | Sequence divisions, cities, products, investment | Staged script with per-stage precondition and expected effect. **Optimality boundary stated openly** — near-optimal *within the modelled stage graph*, not globally. |
| 7 | bladeburner | Climb rank fastest **without dying** | Every decision uses the **pessimistic** end of the `[min,max]` chance interval; Black Ops refused below 95%. Stamina floor and chaos ceiling. |
| 8 | sleeves | Allocate N sleeves across the task menu | Exact per-sleeve argmax (sleeves do not interfere). Shock scales output down linearly, so recovery dominates. |
| 9 | go | Wins, territory, streaks | Depth-bounded negamax with liberty-aware evaluation; **exhaustive at 5x5**. |
| 10 | stanek | Pack the grid, then charge | **Exhaustive packing is PROVABLY optimal** — the strongest evidence in the roster. Correctly leaves out a large fragment to fit two smaller ones. |
| 11 | dnet | Traverse under a stasis-link budget | Exact max-reachable search; links spent where they unlock the most. |
| 12 | side | Solve every contract; rank infiltrations | **17 solvers proven against known correct answers** — proof, not measurement. An unknown type returns `undefined`, never a guess. |
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
- **Q1 — predictive sizing at landing?** **OPEN.** The strongest idea in the
  predecessor repo; needs a measured A/B before adoption.
- **Q4 — shotgun fallback?** **OPEN, low priority.** `intervalFactor < 1` does
  occur on small early fleets, but that is also where total throughput is
  tiny, so the upside is small.

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
  act with `{route, horizonSec}` in their context. This resolves the ordering
  circularity ("endgame needs enriched state; features need the route") the
  same way the needs→claims phases already resolved theirs.
- **The progression driver is no longer decorative** — its refresh builds the
  `EndgameView` entirely from store topics (every input was already probed),
  chooses the route, and publishes `{route, expectedEndAt, decidedAt,
  routeWhy, routes[]}` on `progression.plan`. Its previously stubbed
  `stepProgression` inputs are real now: `affordableValueProduct` from the
  offer catalog's multipliers, `earnedThisRun` from `getMoneySources` (all
  sources, not just hacking — in a non-hacking node the old farm-only figure
  kept the phase machine in `start` forever), `runSec` from `lastAugReset`,
  and `queued` is pending-not-installed rather than all owned.
- **Horizon threading** — the `horizonSec` literals replaced with the derived
  horizon; `stepEvaluator` gained a `horizonCapMs` that bounds the prep/switch
  amortization window (binding only when the expected end is nearer than the
  existing 30-minute ceiling — that parity claim is evaluator-only; the
  hacknet/stock windows DID change, see the review round below).
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
margin/dwell/incumbent-loss behaviour, and the horizon clamps. Full suite 534
pass. Typecheck clean.

### Phase 14 review round — 11 verified findings, all fixed

An 8-angle review with adversarial verification (13 candidates, 3 refuted)
ran over the slice before it merged. Every confirmed finding was fixed:

- **The horizon was the wrong quantity for hacknet/stock** — the node-end ETA
  spans augmentation installs, and installs destroy exactly what those
  features buy; a fallback-guessed multi-day ETA also pinned it at the 24 h
  ceiling from the first refresh (~24x looser than the replaced 3600 s
  literals). `planningHorizonSec` now caps at `INSTALL_CADENCE_SEC` (3600, a
  named heuristic until installs are modelled) and short expected ends still
  pass through.
- **Stale topics survived a node reset** — `reset()` became `reset(state)`;
  every module clears its own published topics (progression field-level: the
  gate batch already wrote the new node's identity). Pinned by a new
  registry-walk test. The concrete bug: the new node's first route decision
  read the old run's Red Pill out of stale `factions.ownedAugs`.
- **A complete route froze investment** — etaSec 0 published
  `expectedEndAt = now`, flooring every horizon at 60 s indefinitely while
  the unwired act half waits for a manual finish. A complete route now
  publishes no expected end (`expectedEndFrom`), reading as the default.
- **A quiet publisher decayed the horizon** — `refreshedAt` on the plan plus
  a `PLAN_STALE_MS` guard: a plan whose refresh has died stops steering.
- **`blackOpsComplete` fabricated 0 pre-probe** — now optional ("unknown"
  expressible), derived on the cheap core probe from `getBlackOpNames`
  (0 GB) + `nextBlackOp`, and rate sampling skips unknown series (also
  Daedalus rep and aug count) so a phantom 0→N jump cannot contaminate the
  30-minute rate window.
- **`FactionsView.horizonSec` was dead** — declared, populated, read by
  nothing, and the spec claimed a consumer; removed (the donate-vs-work
  crossover is rate-based).
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

## Known gaps in the current implementation

Stated plainly rather than buried, because several features are implemented to
the *strategy* level without full end-to-end execution:

- **Corporation actions are not executed.** The stage machine, its
  preconditions and its digest are complete and tested; issuing the calls
  against an unmodelled world is the one thing this project refuses to do.
- **Darknet authentication is refused, not faked.** `authenticate(host,
  password)` needs a password behind the darknet's own discovery mechanic; the
  driver reports that rather than calling with an invented credential.
- **Sim models exist for factions, crime and hacknet only.** Gang, corp,
  bladeburner, sleeves, go, stanek and dnet have pure strategy + driver +
  tests, but no `sim/features/` model — so they are unit-proven, not yet
  simulator-proven. Their ns calls report `unmodeled()` rather than
  fabricating.
- **UI tabs beyond `factions` do not yet render their `plan` digest.** The
  digests are published; the panels show the underlying state. That now
  includes the endgame route decision on `progression.plan`.
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

## Open audit questions (hacking)

Raised by the legacy review; none acted on without measurement, and a negative
result is a valid outcome to record here.

1. Does sizing a hack for the target's **predicted state at landing**
   (`src/_lib/simulation.ts`) beat sizing from current state?
2. Does `intervalFactor < 1` — the point where JIT cannot keep up — actually
   occur in our runs, and is a shotgun fallback worth having?
