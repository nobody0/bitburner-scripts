# Endgame: choosing how the BitNode ends

How the controller decides *which way to finish the current node*, how long it
guesses that will take, and how that guess steers every other feature. The
route model itself (what the three routes are, what each requires) lives in
`shared/strategy/progression/endgame.ts`; this document covers the decision
built on top of it.

## The decision

Three routes reach `enterBitNode`, sharing almost no prerequisites:

| Route | Ends the node by | Modelled in |
|---|---|---|
| `daedalus` | 30 augs (node-dependent) → $100b → skill gate → 2.5m rep → Red Pill → install → regrow | `endgame.ts` |
| `labyrinth` | walk the darknet labyrinth (BN15 or SF15; not BN8) → Red Pill → install → regrow | `endgame.ts` |
| `bladeburner` | all 20 black operations — no pill, no hacking requirement | `endgame.ts` |

Once per progression cadence (60 s) the `progression` module's **refresh**:

1. builds an `EndgameView` from the store — every input is already acquired
   by an existing probe (`getResetInfo`, faction standings, the aug catalog,
   the bladeburner action table, `getPlayer`); the refresh composes, it never
   calls ns;
2. runs `stepEndgame` for availability, completeness and blockers;
3. estimates each route's remaining time (`eta.ts`, below);
4. picks the fastest available route with hysteresis (`chooseRoute`);
5. publishes the whole record on `progression.plan`:
   `{route, expectedEndAt, decidedAt, refreshedAt, routeWhy, routes[]}`.

Two deliberate absences in that record: a **complete** route publishes no
`expectedEndAt` — it "ends now", but the act half that would end it is
unwired, and now-as-the-end would floor every horizon at 60 s for the rest of
the manually-ended run — and `refreshedAt` exists so a plan whose publisher
has gone quiet (`PLAN_STALE_MS`) stops steering instead of decaying the
horizon as it ages. `decidedAt` cannot serve as the freshness marker: it
deliberately survives refreshes that keep the same route.

The controller then derives `horizonSec` (below) and hands
`{route, horizonSec}` to every driver's context. The decision is **cached and
stable by construction**: it is recomputed only on the progression cadence,
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
- **The Red Pill tail is shared** — install overhead plus the post-install
  regrow (the install resets hacking to 1; the `The-Cave → w0r1d_d43m0n` link
  only exists after it), discounted because the freshly installed set speeds
  the second climb.
- **The labyrinth walk is an explicit guess** (`LABYRINTH_WALK_SEC`) — the
  mechanic is unmodelled, and the part is marked `measured: false` so the
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

`BitNodeEntry.hours` in `decide.ts` (cross-node ordering) is the same kind of
number: a heuristic estimate to be tuned from the log, never a known constant.

## How features consume the decision

`DriverContext` carries both values every tick:

- **`horizonSec`** — `planningHorizonSec`: expected remaining run time,
  **capped by `INSTALL_CADENCE_SEC`** and staleness-guarded, defaulting to
  `DEFAULT_HORIZON_SEC` (3600) when no plan exists or the route is complete.
  The install cap is load-bearing, not a convenience clamp: the node ETA
  spans many augmentation installs, and an install destroys exactly what the
  consumers buy (hacknet nodes, stock access, skills) — so their payoff
  window is bounded by the NEXT install, while a fallback-guessed multi-day
  node ETA would otherwise have widened every investment test ~24x from the
  first refresh. A short expected end still passes through: the "run ends in
  ten minutes, stop investing" signal survives the cap. Consumers:
  - `hacknet` / `stock`: net-over-horizon investment tests — an upgrade or a
    4S purchase that cannot repay itself within the horizon is refused.
  - `hacking`: caps the evaluator's prep/switch amortization window
    (`stepEvaluator`'s `horizonCapMs`) — a target that only pays off after
    the expected end is not worth switching to. The cap binds only when the
    expected end is nearer than the existing 30-minute ceiling.
  - `factions` deliberately does NOT consume it: the donate-vs-work
    crossover is rate-based (`incomePerSec`), and a horizon field it never
    read was removed rather than left documented-but-dead.
- **`route`** — a bias, never a gate: a driver may weight priorities by it
  (bladeburner when it *is* the route; combat stats for the Daedalus combat
  branch) but must not refuse to play because of it. Nothing consumes it yet;
  the field exists so the first consumer is a local change.

Staleness is tolerated by design: the plan persists in the realm store across
build handoffs, refreshes on the progression cadence, and every consumer sits
behind the same hysteresis that keeps the route itself stable.

## Deliberately not wired

Acting on the decision — installing the queued augmentations, walking the
labyrinth, calling `destroyW0r1dD43m0n` — ends the run, kills every process
and is irreversible. The act half of the progression driver stays empty until
the prestige path is proven end to end (see `spec/progress.md`). The decision
is published and recorded; nothing executes it.
