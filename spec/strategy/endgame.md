# Endgame: choosing how the BitNode ends

How the controller decides *which way to finish the current node*, how long it
guesses that will take, and how that guess steers every other feature. The
route model itself (what the four routes are, what each requires) lives in
`shared/strategy/progression/endgame.ts`; this document covers the decision
built on top of it.

## The decision

Four routes reach `enterBitNode`, sharing almost no prerequisites. Three
acquire The Red Pill; Bladeburner is the independent no-pill proof:

| Route | Ends the node by | Modelled in |
|---|---|---|
| `daedalus` | 30 augs (node-dependent) → $100b → skill gate → 2.5m rep → Red Pill → install → regrow | `endgame.ts` |
| `gang` | in BN2, create a gang → 2.5m gang-faction rep → Red Pill → install → regrow | `endgame.ts` |
| `labyrinth` | walk the darknet labyrinth (BN15 or SF15; not BN8) → Red Pill → install → regrow | `endgame.ts` |
| `bladeburner` | all 21 black operations — no pill, no hacking requirement | `endgame.ts` |

Once per progression cadence (60 s) the `progression` module's **refresh**:

1. builds an `EndgameView` from the store — every input is already acquired
   by an existing probe (`getResetInfo`, player/karma, faction and gang state,
   the augmentation catalog, and the Bladeburner action table); the refresh
   composes, it never calls ns;
2. runs `stepEndgame` for availability, completeness and blockers;
3. estimates each route's remaining time (`eta.ts`, below);
4. picks the fastest available, executable route with hysteresis
   (`chooseRoute`); mechanically available but currently unautomatable routes
   remain visible in telemetry and cannot win the comparison;
5. publishes the route record plus independent forecasts for the next
   augmentation installation and BitNode completion on `progression.plan`.

Forecasts are anchored at `expectedAt`, not rewritten as a fresh duration on
every controller pass. Their displayed remaining time counts down from that
anchor. The model is recomputed every minute, or immediately when a
structural milestone changes (route, blocker, package, install phase, queue or
readiness). After three minutes without a successful recalculation it becomes
explicitly `stale`; absent evidence is `unknown`. Neither state is converted to
a scalar default, and there is no floor or ceiling.

The controller hands `{route, horizons: {install, node}}` to every driver. The
route decision is **cached and stable by construction**:
a challenger must beat the incumbent's *current* estimate by
`ROUTE_SWITCH_MARGIN` (25%) after `ROUTE_DWELL_MS` (10 min), and a stale plan
is dropped on a node reset — each module clears its own published topics in
`reset(state)`, because a topic that survives the reset is live data from a
dead node (the first route decision of a new node once read the old run's
Red Pill out of a stale aug list). A complete route wins immediately.

## The estimate is a heuristic, never a measurement

`eta.ts` composes each route's remaining time from gap ÷ rate parts:

- **Rates are observed this run** — the progression driver samples money
  earned, hacking/combat skill, aug count, Daedalus rep, black-op count and
  bladeburner rank into 30-minute sliding windows (`RateTracker`). A series
  that goes *down* (an install reset money) restarts its window rather than
  reporting a negative rate.
- **"Unknown" stays expressible** — a series whose zero could be FABRICATED
  (its backing probe has not landed yet: black-op count, Daedalus rep, aug
  count) is sampled only when the reading is real. A phantom `(t0, 0)` sample
  would sit in the window and inflate the rate ~24x when the true value
  arrives — the increase-jump passes the decrease-only reset guard by design.
  `blackOpsComplete` is additionally derived on the cheap 30 s core probe
  (the next uncompleted op's index in `getBlackOpNames`, 0 GB) instead of
  waiting minutes for the ~28 GB action-table probe.
- **Missing rates select a fallback constant** — pessimistic and **finite**.
  An `Infinity` would annihilate the route from the comparison (the
  unworkable-faction lesson in `spec/progress.md`); "probably slow, still a
  route" is the honest statement. Every fallback lives at the top of `eta.ts`
  as a named export.
- **Parallel work is priced as the slowest track, not the sum** — Daedalus's
  augs/money/skill gate accrues while the run plays; black ops overlap the
  rank climb.
- **The Red Pill tail is shared by all three acquisition routes** — install
  overhead plus the post-install
  regrow (the install resets hacking to 1; the `The-Cave → w0r1d_d43m0n` link
  only exists after it), discounted because the freshly installed set speeds
  the second climb.
- **The labyrinth is multi-install** — six reward installs plus The Red Pill
  outside BN15, four reward installs plus The Red Pill in BN15. The walk time
  is an explicit guess (`LABYRINTH_WALK_SEC`) and marked `measured: false`, so the
  calibration loop can see exactly which figure was invented.

Every part carries `{what, sec, measured}`. `measured: false` means a
fallback produced it; the distinction is load-bearing for tuning.

## Two feedback loops, one log

The run log (`runs/*.jsonl`) carries three records that close the loop:

- `endgame.route` (event, on change only): the chosen route, its estimate,
  and **every** route's per-part breakdown at decision time.
- `progression.plan` (state, on change): the standing decision with refreshed
  estimates.
- `bitnode.reset` (event): `{to, from, elapsedMs, route, guessedEndAt,
  decidedAt}` — the actual outcome next to the last guess. Emitted FIRST in
  the reset branch, before the reset walk deletes the plan and before the
  awaited rescan can throw: this is the one record that closes the loop for
  the whole node, and a failed post-reset sweep must not be able to lose it.

From these, offline:

1. **Calibration** — predicted vs actual, attributable per part because the
   breakdown was recorded, not just the total. A wrong fallback constant and a
   wrong formula look different in this data.
2. **Optimization** — a part that is *honestly* slow is a feature to improve.
   Linked to calibration but independent of it: making augs cheaper changes
   the game; fixing the aug-rate estimate changes the guess.

Live next-node selection follows `BITNODE_SPEEDRUN_PLAN`
(`shared/strategy/progression/bitnode-order.ts`), which `decide.ts` consumes as
`ACTIVE_BITNODE_TARGETS` — the default `targets` of `chooseNextBitNode`. Its
`BASELINE_ORDER` and `DEFAULT_BITNODE_TARGETS` lists, like the small-set
`orderingCost`/`bestOrdering` helpers, are analytical and policy data rather
than the runtime policy; the full intended route lives in
`spec/strategy/speedrun-benchmark.md` and is restored into the live plan as each
feature controller lands. Any future measured reordering should update the
explicit target list rather than silently changing completion execution.

## How features consume the decision

`DriverContext` carries the route and both forecasts every tick:

- **Install horizon** — reset-sensitive value. Hacknet upgrades, hacking pump
  spending and stock positions must repay before augmentation prestige
  destroys them.
- **Node horizon** — persistent value. Faction packages, home infrastructure
  and stock API access can repay across installations, so a multi-day estimate
  remains multi-day.
- **`route`** — a bias, never a gate: a driver may weight priorities by it
  (Bladeburner combat/rank, BN2 gang reputation, Daedalus augmentation count,
  or labyrinth charisma) but must not refuse unrelated useful work because of
  it. Career, factions, gang, Bladeburner and Go consume the published needs,
  route weights or horizons today.

Unknown or stale forecasts do not silently become a made-up hour. Each
consumer chooses an explicit conservative behavior. Estimated forecasts carry
parallel/sequential components, critical-path flags and measured-versus-model
provenance; the UI and telemetry retain that same typed evidence.

Player-work competition uses the same overlap rule. Algorithms is not credited
with all hacking progress merely because it owns the work slot: the hacking
fleet's measured XP continues while either Algorithms or faction work runs.
Career converts the live level gate to raw remaining XP through the nonlinear
skill curve, subtracts the XP the fleet will earn during the competing route
reputation interval, and prices only the wall-clock time Algorithms can still
remove. If background hacking closes the gate during that reputation work, the
course has zero route priority; if no background XP exists, it retains its full
blocking priority. Once the competing route package is complete the discount
disappears, so this is an observed-rate allocation heuristic rather than an
always-faction special case.

## Installs and terminal execution

The install forecast is the current planning horizon: optional economic resets
use the renewal/payback verdict, while route-mandatory resets bypass it. The
Daedalus consolidation starts after one third of the live node count. A cycle
that starts before the closing quarter must cover at least half its remaining
distinct slots; a cycle that starts inside the closing quarter must finish the
count gate. This distinguishes a substantial 13→23 tranche from a wasteful
20→23 reset. The final sweep gives each count slot a node-relative value that
declines toward closure, jointly orders funded NeuroFlux levels with one-shots,
and installs only after factions, stock, grafting and the queue agree.

Before that consolidation region, route-count value enters cadence only when
the funded distinct batch covers at least one third of the remaining finite
gate. This does not hardcode BN1's 30-augmentation requirement and does not
forbid a mechanically required reset; it prevents a handful of attractive
multipliers from paying a whole cold bootstrap while barely advancing the
selected route. Favor activation is valued once per faction-wide reputation
curve, after assigning shared augmentations to their best seller. Augmentations
at one faction are nested reputation breakpoints, so counting the same favor
rate improvement once for every offer would manufacture reset value.

Purchases are strictly end-loaded. Reputation-complete augmentations form a
candidate bank, not a promise to buy the entire bank: when the boundary opens,
the solver freezes the best dependency-safe subset covered by cash plus bounded
liquidation proceeds, forces any route-critical augmentation into that subset,
then executes the minimum-cost legal order under the 1.9× queue escalation.
An unaffordable optional wish list therefore cannot hold a funded Red Pill
hostage. The banked Red Pill opens a route-mandatory transaction even while the
real queue is empty; `installReady` remains false until the sweep has actually
purchased it. Optional post-plan reputation work is capped at 1% of elapsed
time in the current install; merely buying another already-affordable item at
the frozen boundary consumes none of that work budget.

Completed-cycle augmentation rates also reject startup-partial cycles shorter
than one minute and clear their sliding count window on prestige. A save or
harness that starts with a queue and preloaded reputation has only observed the
button press, not a reproducible fresh-install acquisition curve.

The armed two-pass augmentation transaction and two-pass
`destroyW0r1dD43m0n` call are wired. Automatic node completion requires BN4 or
SF4; otherwise the plan publishes the selected next node for manual action.
The destroy action waits for both the post-install hacking level and admin
rights on `w0r1d_d43m0n`.

Labyrinth mechanics and ETA are modelled, including every mandatory reward
install, but its host-local authentication/stasis executor is not. Therefore
the live view marks it `actionable: false`: it is reported but cannot lock the
run onto an unexecutable route. If The Red Pill is acquired manually, its
shared install/regrow/destroy tail becomes actionable automatically.
