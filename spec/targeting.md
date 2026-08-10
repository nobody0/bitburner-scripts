# Targeting & dispatch (as built)

Picks the best hack target, farms it with HWGW batches, preps the next target
in the background, and switches when it pays. The pure engine
(`shared/strategy/*`, `shared/ram/heap.ts`) runs identically in the simulator
(virtual clock — the A/B oracle) and in the game (thin driver), so a policy
measured in sim transfers directly.

## Cadences and budgets

| Loop | Trigger | Budget | Measured |
|---|---|---|---|
| Dispatcher pass | every 200 ms tick (one spacer) | ≤10 ms | 0.01–0.03 ms |
| Evaluator slice | ≥2 s, `clamp(ceil(N/10),1,8)` targets | ≤2 ms | 0.1–0.9 ms / 8 targets |
| Decision gate | ≥5 s, or invalidation | ≤200 ms | 3–21 ms / 100 targets |
| Sweep | 30 s, dodged | — | scan + root + deploy + heap resync |

Enforced by `tests/heap.test.ts`, `sim/tests/targeting.test.ts` (bench),
`sim/tests/dispatch.test.ts` (bench), and `dispatch.slow` telemetry at runtime.

## Per-target solve (`shared/strategy/targeting.ts`)

At the prepped state (minSec, moneyMax M), for steal fraction s:
`H = round(s/hackPercent)`, `G = growThreads(k, M, M(1−s), M)`,
`W1 = ceil(0.002·H/weakenEffect)`, `W2 = ceil(0.004·G/weakenEffect)`.
Income `E = c·s·M`; RAM-seconds `R = t_h·(1.7H + 1.75·3.2·G + 1.75·4·W)`.
**Score = E/R in $/GB/sec** — the RAM-bound unit. The insight came from an
earlier rewrite's `analyze-profit.js` (`nobody0/bitburner`, no longer checked
out; see README's citation note), with exact Newton grow threads here instead
of its log approximation. The predecessor scripts on disk score by
duration-weighted money per thread instead (`src/_lib/optimizer.ts:123`). The
Q2 audit proved the two are not constant-factor conversions (hack is 1.70 GB,
grow/weaken 1.75 GB), but they are monotonic in the same duration-weighted
non-hack/hack ratio and therefore induce the same ordering.

Search first derives a finite hack-thread ceiling from the 95% steal cap, the
contiguous hack-block cap, and total batch RAM. Domains of at most **1,024**
threads evaluate every integer candidate and return `exact: true`. Larger
domains use a 16-point grid uniform in −log(1−s), 8 golden-section refines, and
bounded integer neighborhoods around every promising point; those results are
explicitly labelled `exact: false`. **Feasibility is part of the search**:
`RamCaps.batchGb` bounds
the batch, `hackBlockGb` bounds the hack op alone (hack must land as ONE call
— splitting compounds the steal and desyncs the grow sizing). If no grid point
fits, a bisection finds the largest feasible batch. Without this the solver
happily returns a 240 GB batch for an 84 GB fleet and nothing ever launches.

**The score is pipeline-aware when the caps carry `hostBlocksGb` + `farmGb`**
(the dispatcher always passes them). Every op holds its RAM from launch until
it lands ~weakenTime later, so a contiguous hack slot serves at most one batch
per weakenTime: with `S = Σ floor(hostFreeGb/hackGb)` slots the launch period
is `P = max(R/farmGb, weakenTime/S, INTERVAL)` and the score becomes
`E/(P·farmGb)`. When RAM binds this degenerates to exactly `E/R`, so small
fleets are unaffected; what it changes is the regime where one oversized hack
block monopolises the largest host and collapses the pipeline to depth 1 — the
32 GB-home stall (`spec/simulator.md`, finding 2, fixed).

`solvePrep` returns W1→G→W2 from the *current* state plus a latency floor:
`prepTime = max(weakenTime, ramSec / prepGb)`.

## Evaluator (`shared/strategy/evaluator.ts`)

Steady-state scores depend only on static fields + HackContext, so the
round-robin works off the 30 s snapshot; dynamic security/money feed only prep
plans of the hot set. A context **generation** guards every cached solution —
a >2 % skill change, a fleet-RAM change >10 %, or a new root bumps it and
forces a re-score, so an argmax never mixes generations.

### Provable candidate pruning (`shared/strategy/bounds.ts`)

The per-generation re-score is the evaluator's only real cost (up to 1,024
Newton grow-solves per target). Most of it is provably wasted: the world's
servers are rolled ONCE per BitNode from `{min,max}` metadata ranges
(`initForeignServers` → `getRandomIntInclusive`; ranges transcribed in
`shared/features/servers.ts`, parity-pinned), and at any given skill only a
handful can contest the optimum. `scoreUpperBound` is a ~10-flop closed form
proven ≥ `solveCycle`'s score for **every** thread count, batch shape
(hwgw/hgw), `RamCaps` (caps only shrink the feasible set) and the
pipeline-aware period (which never beats `ramSec/farmGb`); stock manipulation
value is a numerator term, so manipulated hosts need no exemption. The
derivation (s cancels between income and the per-s floor of each RAM term; the
grow floor `G ≥ s/(k + 1/m₀)` handles grow's $1/thread additive credit, which
otherwise falsifies the bound on money-poor servers) lives in bounds.ts; the
machine check is `sim/tests/bounds.test.ts` — a seeded adversarial sweep
asserting `score ≤ UB` with **exact** `<=`, plus the `growThreads`
post-conditions and formula monotonicities the interval arithmetic rests on.

The evaluator prunes with it: a candidate whose bound cannot reach the
incumbent farm score is skipped without solving — a farm switch needs
score > incumbent·1.1 and a prep pick needs positive net (score strictly above
the incumbent), so the skip is decision-free by construction. Guards: the
threshold only comes from an incumbent solved at the *current* generation, the
incumbent itself is never pruned, and when the incumbent earns nothing
(cold start, BN8's zero-gain targets) pruning stands down entirely — those
fallbacks rank by prep-aware value, where a low-score fast-prep target can
legitimately win. `sim/tests/evaluator-prune.test.ts` walks randomized rolled
timelines (skill/fleet jumps, roots appearing, prepped states flapping, stock
positions opening/closing, a BN8 scenario) twice — prune on vs off — and
asserts byte-identical decisions; measured ~2–3× on evaluator time with
174–617 solves skipped per 400-step timeline.

**What is deliberately NOT claimed:** component-wise dominance ("richer +
easier + faster-growing always wins") is false in general — near the 95 %
steal cap the solver's granularity is `floor(0.95/p)·p`, discontinuous in p,
and in the interval/slot-floored pipeline regime a marginally better server
can lose more steal to that floor than its chance advantage recovers. Static
removal therefore never rests on dominance; everything reduces to
UB-vs-achieved-score at the live roll.

### The contention table (`shared/strategy/target-bands.ts`, generated)

`computeTargetBands` answers the roll-independent question: per skill band,
which hosts can contest the RAM-unbound optimum for ANY roll of the world
RNG? A host is excluded only when its best-possible-roll upper bound cannot
reach the worst-possible-roll guaranteed floor (the always-feasible one-thread
batch, priced by interval arithmetic over the pinned-monotone formulas) of
some always-eligible host. Contract: BN1 mults, neutral player, RAM unbound,
root assumed, no stock influence. It never gates the runtime evaluator (which
prunes exactly, from live rolls) — it exists for the question asked *before*
servers are scanned: progression planning, port-opener pricing, UI. Bands are
tight early (2–4 contenders below skill 30) and honestly wide late (~40 at
1,500 — real roll variance, the req≈skill/2 regime). Regenerate with
`bun run bands` after a vendor bump; `sim/tests/target-bands.test.ts` pins
staleness and rolls whole worlds asserting every argmax is a listed
contender.

## Switching (in the gate)

`rate = score × fleetGb`; horizon
`T = clamp(min(goalRemaining/rate, runRemaining), 60 s, 30 min)`, where
`runRemaining` is the endgame route's expected remaining run time
(`spec/strategy/endgame.md`) — in the game the goal term is ∞, so the run
horizon is the only finite bound, and it binds once the expected end is
nearer than 30 min.

**Prep pick is opportunity-cost based** (`shared/strategy/economics.ts` — the
legacy scripts' 15-minute rule generalized): `net = gain − lost` where
`gain = (rateNew − rateCur)·max(0, T − prepTime)` and
`lost = [rateCur(fleet) − rateCur(fleet·(1−share))]·prepTime`, with rates
saturating at the farm's **depth cap** (`ceil(weakenTime/INTERVAL)·ramPerBatch`
GB) — so a depth-capped farm preps for free, and a 3-hour prep on a 30-minute
horizon is visibly worthless. Highest positive `net` wins, over a 2%-of-horizon
churn epsilon. `prepTime` uses the real prep segment share (25%), not a guess.
Measured: −14% median time to earn:1e9 vs the old 5%-margin
`rate·(T − prepTime)` pick (planner driver, 10/10 seeds faster).

When NOTHING is prepped yet, the farm pick itself is prep-aware: candidates are
ranked by `score·max(0, T − prepTime)` rather than raw score, because the
pipeline-aware score can rank a rich server above a small one whose prep the
early fleet can actually finish.

A farm switch requires **all** of: candidate prepped (sec ≤ min+1, money ≥ 90 %
max), +10 % hysteresis on same-generation scores, 60 s dwell.
**Segment order** is fixed `[farm, prep, share]`. The old ≥25 % reorder rule
(and an economics-driven 60 % prep share) was A/B-tested and LOST — the model
prefers a big share because the farm's loss is share-invariant when RAM-bound,
but the dispatcher's per-pass prep op cap means prep cannot actually use it.

## HWGW dispatcher (`shared/strategy/dispatch.ts`)

Four ops land H → W1 → G → W2, `SPACER = 200 ms` apart; each batch is anchored
at least `4·SPACER` after the previous one (collision guard, pure bookkeeping —
no ns reads). `additionalMsec = landing − now − duration`.

**Farm modes** (`shared/strategy/mode.ts`) are a separate axis from target
choice: the evaluator answers WHICH target, `decideMode` answers HOW to farm
it, per pass, with a 30 s dwell against flapping.

- **hwgw** (default): the four-op batch above.
- **hgw**: drop W1, overscale the grow against the hack's fortify (its growth
  log is taken at `min + 0.002·H`), one weaken covers both fortifies; landings
  H → G → W a spacer apart, batch interval `3·SPACER`. Score is near-parity
  (±5 %, pinned) — the point is **3 processes per batch instead of 4**, for
  when the BROWSER's process count, not game RAM, binds. Entered above 1,500
  live ops, released below 1,000 (hysteresis). The HGW solution is solved
  lazily for the chosen farm target only (`solveCycle(..., "hgw")`, cached per
  context generation); target RANKING stays on the HWGW score — the orderings
  track. Effects round-trip pinned in `sim/tests/targeting.test.ts`, landing
  order + bands in `sim/tests/dispatch.test.ts` (`modeOverride: "hgw"`).
- **shotgun**: when `weakenTime` holds fewer than 2 interleaved batches
  (`intervalFactor < 1`, Q4 — the extreme-late-game regime where hack times
  collapse below the spacer grid). Thread math is HGW's taken to the limit:
  every op of every batch in a wave lands the SAME engine tick
  (`additionalMsec = weakenTime − ownDuration`; the weakens land naturally),
  and the engine's same-tick rule — equal-deadline timers fire in
  registration order — turns LAUNCH order into arrival order. Batches are
  therefore emitted **H, G, W** (hack-first, unlike batched modes'
  weaken-first landings): after batch N's weaken the server is back at
  (minSec, moneyMax), so batch N+1's sizing is exact at its own arrival, and
  the landing-state fold reproduces the same sequencing pure-side (equal
  landings sort by opId = launch order). No anchor, no depth cap — one wave is
  everything the farm budget holds, up to 256 batches per pass — and always
  one-shot workers (nothing repeats inside a pool window at that structure).
  The tie-break proof (per-batch H → G+ → W+ effect order inside one tick,
  bands held across waves) is pinned in `sim/tests/dispatch.test.ts`.

`DispatchOptions.modeOverride` forces a mode (the sim's A/B lever); the rollup
reports `mode` + `modeWhy`.

**Durations are computed at launch from live state**, never from the cached
solution: security drift or a level-up between solve and launch would otherwise
land ops off their slots. Our formulas are bit-identical to the game's
(`sim/tests/formulas-parity.test.ts`), so the recomputed duration matches the
engine exactly — verified by asserting observed landing times in
`sim/tests/dispatch.test.ts`.

**Thread counts are sized against the PREDICTED landing state** (Q1,
`shared/strategy/prediction.ts`): every tracked op carries its landing and
core-adjusted effect threads, and before each batch the dispatcher folds that
in-flight ledger to the hack's landing. Predicted security above the prepped
tolerance skips the batch (counted in `batchesSkipped`); otherwise the hack
keeps its solved fraction and the grow/W2 cover is re-solved from the
predicted post-hack money, so a target admitted at 90 % money no longer
under-grows into a downward drift. Fold parity with the vendored effects is
pinned in `sim/tests/prediction.test.ts`.

Prep fires in **non-overlapping waves per host** (a new wave only when the host
has no WAVE ops in flight — the counter is kept symmetric on the tracked
ledger, so farm-batch completions on a desynced farm host can never unlock an
overlapping second wave), so plans can never overshoot. A security wave is W1
alone; a money wave launches G and its W2 cover TOGETHER, the cover sized to
the grow threads that actually launched under the op cap and budget. Prep work
always spreads; only hack demands contiguity.

## RAM engine (`shared/ram/heap.ts`)

Inherited from an earlier rewrite (`nobody0/bitburner`, no longer checked out;
the predecessor scripts on disk have no heap at all) — 21 clz32 slabs, home
pinned last, three policies (contiguous best-fit for hack, home-first for
grow's core bonus, ascending-slab spread for weaken/prep so fragments get eaten
first), two-phase-commit spread, O(1) rebucket through one `#update` choke
point — with its defects fixed:

- reservations release per block and are **idempotent**; ops the driver could
  not start are rolled back via `reportFailed` (the rewrite leaked them);
- allocation failure is a typed value `{wanted, grantable, freeTotal}`, counted
  in telemetry — never silent ratio starvation;
- **one** home-reserve constant (`HOME_RESERVE_GB`, imported by `net.ts`);
- batch-atomic `allocateAll`: all four ops or none.

Double-entry: the sim tracks per-source RAM independently, and
`sim/tests/dispatch.test.ts` asserts the two ledgers agree — a disagreement is
a test failure, not a silent overcommit. In game, `resyncHeap` reconciles
against real `ramUsed` on each sweep and emits `heap.resync`.

## Worker protocol (`game/worker/worker.ts`)

One puppet script for all three ops, launched
`{ threads, temporary: true, ramOverride: WORKER_RAM[kind] }` with an integer
opId. It reads its descriptor from `worker_info` on globalThis (written
*before* exec, so the race to `undefined` cannot happen) and registers
`ns.atExit` *before* awaiting the op — every exit path pushes to the
`dispatch_done` mailbox and pokes `dispatch_wake`, so RAM frees on kills and
reloads too. A fresh realm (game reload) has no descriptor: the worker exits
silently and the controller rebuilds its ledger from the next sweep.

**Pooled serve workers** (`worker.ts` serve mode + `shared/strategy/worker-pool.ts`):
a serve worker has fixed kind and threads for its process's life, loops over
jobs from the `worker_jobs` realm mailbox (parked on a `worker_wake` resolver
raced against a 5 s idle timeout), and reports a `workerExit` completion when
its process ends — the moment its heap reservation frees (the WORKER owns the
RAM; job completions merely flip it idle). Ops compose from idle workers
(exact-match for hack — one call — greedy largest-first for the divisible
kinds) plus a batch-atomically allocated remainder that spawns new workers.
Pooling is a BROWSER-RAM relief valve, not a throughput win: idle workers
strand game RAM between jobs (measured −20 % time-to-goal with it always on),
so it self-gates on live-op pressure (`POOL_PRESSURE_OPS`, just before HGW's
threshold) AND on the batch launch period fitting the idle window
(`POOL_REUSE_WINDOW_MS` — early-game depth-1 pipelines would strand every
worker). `stats.execs` (fresh processes) against `launched` (ops) is the churn
figure. Pinned by the pool-ledger test in `sim/tests/dispatch.test.ts` and the
real serve-loop tests in `sim/tests/worker-serve.test.ts`.

The `dispatch_wake` poke is the trigger for the **weaken-landing wake**
(`game/lib/wake.ts`): the controller races its tick sleep against a promise
armed over that slot and, when a completion wins the race, runs one trimmed
dispatcher pump immediately (`pumpOnWake`). Landings free heap RAM up to a
full spacer earlier, and the pump after a W2 landing reads the target at its
provable min-security instant — the legacy scripts' `weakenFinishedProm` idea,
realized without any new pure logic because durations are recomputed at launch
from the live view anyway. Same-instant completions coalesce into one wake
(the resolver disarms itself), wake pumps are throttled (25 ms since any pump,
≤4 per frame), and the race uses the sim-virtualized realm timer, never
`ns.sleep` — concurrent ns calls from one script are fatal. Cumulative count
in the rollup as `wakePumps`.

## Stock manipulation: the second income term

`hack(host, {stock: true})` lowers the corresponding stock's second-order
forecast and `grow(host, {stock: true})` raises it
(`StockMarket/PlayerInfluencing.ts`), so in a node where the market matters the
best farm target is not the richest server but the one whose price movement is
worth the most. `solveCycle` therefore scores TWO income terms into the same
`$/GB/sec`:

```
score = (income + stockIncome) / ramSec
income      = chance · steal · moneyMax · ScriptHackMoneyGain
stockIncome = chance · steal · valuePerOp
```

Five things make this work rather than merely look plausible:

- **Exactly one op per batch carries the flag.** A long is driven by the GROW, a
  short by the HACK. On a successful steady-state batch the grow restores what
  the hack took, so flagging both produces equal and opposite influence in
  expectation.
- **`moneyMax` cancels out of the manipulation rate.** The influence roll is
  against `moneyMoved / server.moneyMax`, a FRACTION, so two servers with the
  same steal fraction and batch time manipulate their symbols equally well
  however rich they are. That inverts ordinary target selection: `joesguns` (JGN)
  and `foodnstuff` (FNS) are among the cheapest manipulators in the game.
  Measured in `sim/tests/stock-market.test.ts`.
- **`ScriptHackMoneyGain` scales only the hacking term.** Influence is computed
  from `moneyDrained`, before the player's cut. BN8 sets the cut to **0** and the
  drain rate to 0.3, so hacking earns literally nothing while manipulating at
  near-full strength — the farm still has to run, for experience and for prices.
  Omitting this multiplier (as the solver did) reported every BN8 target as
  profitable.
- **Both steady-state sides are weighted by hack chance.** A failed hack leaves
  the server at `moneyMax`; the later grow then adds no money, so neither op has
  any influence probability. `solveCycle` weights both sides by `chance`
  accordingly (pinned by the long/short parity test in
  `sim/tests/targeting.test.ts`).
- **Prep grows are flagged too, for a long.** The op is launched either way, so
  the nudge is free. Prep never hacks, so a short gets nothing from that path.

`valuePerOp` comes from `stock` on its topic (`stock.manipulation`, keyed by
hostname) and reaches the solver through `WorldView.stockInfluence`. A change in
it bumps the evaluator's context generation exactly as a skill or fleet change
does — a position opening or closing changes what a target is WORTH, and a stale
cache would keep optimising for a position that no longer exists.

### The magnitudes, measured

Worth stating plainly, because it decides how much this term can ever matter. A
nudge moves the equilibrium forecast by 0.001, so a $10b position on a 0.002 mean
log step held for 100 ticks is worth a few **thousand** dollars per influencing
op — against **tens of millions** of hacked money per batch. So:

- **Outside a node that nerfs hacking, manipulation does not move target choice.**
  It is a rounding error on the score, and that is the correct outcome: handing
  the farm to a small server for a few thousand dollars would cost far more than
  it earns. `sim/tests/dispatch.test.ts` pins that BN1 declines it.
- **In BN8 the same intent wins the target outright**, because `income` is
  *exactly* zero and any positive `stockIncome` is the whole score. Same test,
  same intent, `bitnode: 8`.

That asymmetry is why the two multipliers had to be separated rather than folded
together, and why `stock` also biases its own choice toward symbols whose host the
farm can reach (`MANIPULATION_PREFERENCE`) — the loop only closes if both halves
choose each other.

## Telemetry

One 1 Hz `farm` rollup (`shared/telemetry/state-map.ts`): target, prep target,
segment order, in-flight and landed counts, alloc/exec failures, pump time,
cumulative totals. Transition events only: `farm.targetSwitch`,
`dispatch.slow` (>5 ms), `heap.resync`. **Per-op events are never emitted** —
at scale that would be ~3 events per 16 ms.

## Static RAM (`tests/ram-budget.test.ts`)

`start.js` = 3.60 GB: base 1.6 + `getPlayer` 0.5 + `exec` 1.3 +
`getServerSecurityLevel` 0.1 + `getServerMoneyAvailable` 0.1. The last two are
the hot-target live reads — **the hot path never dodges**. Everything else
(scan, scp, ls, nuke) lives inside dodge closures with bracket notation; the
test fails if any of them leaks into the controller's bill. Peak on a fresh
8 GB home: 3.6 + 4.1 (transient dodge stub) = 7.7 GB.

## Sim A/B results (baseline = the old naive planner)

| Goal | Fleet | Baseline | HWGW | Speedup |
|---|---|---|---|---|
| earn:1e6 | 8 GB home + early net | 2.17 h | 18.2 m | 7.1× |
| earn:1e9 | 8 GB home + early net | 13.1 h | 6.13 h | 2.1× |
| earn:1e9 | 1 TB home | — | 23.1 m | — |

10/10 seeds reached, zero `action.failed` (no RAM overcommit), security and
money bands held during farming.

## Known gaps

- Share/exp segment is declared but not yet dispatched. Its RAM (and an idle
  prep segment's) now SPILLS to the farm instead of idling — measured −13%
  median on hacking-early (18.5m → 16.1m, no seed worse) — but share work
  itself still never runs.
- The evaluator never invests in a target upgrade whose prep exceeds the
  horizon, which on a small early fleet is every better target: joesguns
  scores 6× n00dles at skill 30 but preps in hours on 92 GB, so the farm sits
  on n00dles for the whole run. The ranking is right, the missing piece is
  long-horizon prep amortization (skill growth shrinks prep time while the
  run ages; treating prep time as a constant overprices it).
- Port openers are acquired on demand for posted backdoor needs; general
  infrastructure purchasing remains outside the target solver. New cloud
  servers are quoted as a bankroll-filtered size ladder (8 GB → max, ×4
  steps), so fleet growth compounds once income allows instead of buying
  8 GB forever.
- The game driver quotes purchases as unavailable (start.js owns them); the
  sim dispatcher buys servers and upgrades home so the A/B includes economy.
