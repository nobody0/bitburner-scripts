# Targeting & dispatch (as built)

Picks the best hack target, farms it with HWGW batches, preps the next target
in the background, and switches when it pays. The pure engine
(`shared/strategy/*`, `shared/ram/heap.ts`) runs identically in the simulator
(virtual clock — the A/B oracle) and in the game (thin driver), so a policy
measured in sim transfers directly.

For the proven predecessor batcher's window model, pooled-worker architecture,
thread-strength arithmetic and batch economics — plus a line-by-line gap map to
this implementation — see [`spec/jit-reference.md`](jit-reference.md). That
reference is `nobody01/bitburnerscript@master`
(`servers/home/imports/batchPlanner.ts`, `batchRunner.ts`), **not** the `@2023`
branch's unwired `src/_lib/batchers/jit.ts`.

## Cadences and budgets

| Loop | Trigger | Budget | Measured |
|---|---|---|---|
| Dispatcher pass | every 200 ms heartbeat plus exact deadline/completion wakes | ≤10 ms | 0.01–0.03 ms |
| Evaluator slice | ≥2 s, `clamp(ceil(N/10),1,8)` targets | ≤2 ms | 0.1–0.9 ms / 8 targets |
| Decision gate | ≥5 s, or invalidation | ≤200 ms | 3–21 ms / 100 targets |
| Sweep | 30 s, dodged | — | scan + root + deploy + heap resync |

Enforced by `tests/heap.test.ts`, `sim/tests/targeting.test.ts` (bench),
`sim/tests/dispatch.test.ts` (bench), and `dispatch.slow` telemetry at runtime.

The dispatcher figure is **not yet a claim about a loaded fleet**: its bench
drives ~20 in-flight ops, while a live 32k-op fleet once produced a 63-second
pass. Two reasons the number cannot simply be re-measured in the simulator:
`sim/realm/timers.ts` virtualises `performance.now`, so `pumpMaxMs` under a
scenario is virtual time and blind to real CPU, and the bench is the one place
that escapes it by building `SimWorld` without installing the realm. Scaling
that bench, and gating on a deterministic work-unit counter rather than wall
clock, is outstanding.

## Per-target solve (`shared/strategy/targeting.ts`)

At the prepped state (minSec, moneyMax M), for steal fraction s:
`H = round(s/hackPercent)`, `G = ceil(1.01·growThreads(k, M, M(1−s), M))`,
`W1 = ceil(1.02·0.002·H/weakenEffect)`,
`W2 = ceil(1.02·0.004·G/weakenEffect)`.
Income `E = c·s·M`; RAM-seconds `R = t_h·(1.7H + 1.75·3.2·G + 1.75·4·W)`.
**Score = E/R in $/GB/sec** — the RAM-bound unit. The insight came from an
earlier rewrite's `analyze-profit.js` (`nobody0/bitburner`, no longer checked
out; see README's citation note), with exact Newton grow threads here instead
of its log approximation. The `@2023` predecessor scores by duration-weighted
money per thread instead (`src/_lib/optimizer.ts:123`); `@master` scores by
`moneyPerMs` derived from the achieved batch interval
(`imports/batchPlanner.ts:864-865`). The
Q2 audit proved the two are not constant-factor conversions (hack is 1.70 GB,
grow/weaken 1.75 GB), but they are monotonic in the same duration-weighted
non-hack/hack ratio and therefore induce the same ordering.

The solver also reports expected hacking experience per batch and per
GB-second. Hack threads contribute `0.25 + 0.75*chance` times their full
experience (failure awards one quarter); grow and weaken threads contribute
fully. Dollars, including stock manipulation, remain the primary objective.
Experience only breaks an equal-dollar choice, most importantly BN8's exact
zero-dollar fallback.

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
incumbent's **effective per-GB rate** (`farmIncomeRate/fleetGb`, ≤ its raw
score) is skipped without solving. The threshold is the rate, not the score,
because the two consumers of the ranking differ: the farm switch compares
scores (needs > incumbent·1.1), but the prep pick compares *rates* —
`score·min(fleetGb, depthCapGb)` — so on a fleet beyond the incumbent's depth
cap a LOWER-score candidate with a deeper pipeline can legitimately win the
prep pick; thresholding on raw score would prune exactly that upgrade and
re-create the n00dles lock-in (caught in review by three independent passes;
pinned by the depth-capped-incumbent regression in the invariance suite).
Guards: the threshold only comes from an incumbent solved at the *current*
generation, the incumbent itself is never pruned, and when the incumbent earns
nothing (cold start, BN8's zero-gain targets) pruning stands down entirely —
the BN8 fallback ranks by expected experience rate and can deliberately select
a cold target for the farm path to prepare. `sim/tests/evaluator-prune.test.ts` walks randomized rolled
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
saturating at the farm's **depth cap** (the topology-aware `jitSaturationGb`
when the model carries one, else `max(1, floor(weakenTime/INTERVAL))·ramPerBatch`
GB, `shared/strategy/economics.ts`) — so a depth-capped farm preps for free, and a 3-hour prep on a 30-minute
horizon is visibly worthless. Highest positive `net` wins, over a 2%-of-horizon
churn epsilon. `prepTime` uses the real prep segment share (25%), not a guess.
Measured: −14% median time to earn:1e9 vs the old 5%-margin
`rate·(T − prepTime)` pick (planner driver, 10/10 seeds faster).

When NOTHING is prepped yet, the farm pick itself is prep-aware: candidates are
ranked by `score·max(0, T − prepTime)` rather than raw score, because the
pipeline-aware score can rank a rich server above a small one whose prep the
early fleet can actually finish.

A money-driven farm switch requires **all** of: candidate prepped (sec ≤ min+1,
money ≥ 90 % max), +10 % hysteresis on same-generation scores, 60 s dwell. When
every dollar score is zero, the evaluator instead chooses the best expected
experience-rate target after the dwell even if it is cold; the farm dispatcher
prepares it before batching.
**Segment order** is value-driven prep/farm followed by `[charge, share]` when
those claimants have positive nominal allotments. Share is rounded down to
whole 4 GB workers; its rounding remainder stays with farm. Charge is a
host-local one-shot allocation and share remains the final, evictable tail.
The old ≥25 % reorder rule
(and an economics-driven 60 % prep share) was A/B-tested and LOST — the model
prefers a big share because the farm's loss is share-invariant when RAM-bound,
but the dispatcher's per-pass prep op cap means prep cannot actually use it.

## HWGW dispatcher (`shared/strategy/dispatch.ts`)

Four ops land H → W1 → G → W2, `SPACER_MS = 10 ms` apart (two worker-precision
quanta — live engine lateness oscillates 5-10 ms, and a one-quantum gap flipped
adjacent landings; see `shared/strategy/jit.ts`); each batch is anchored at
least `INTERVAL_MS = 4·SPACER_MS = 40 ms` after the previous one (collision
guard, pure bookkeeping — no ns reads). `additionalMsec = landing − now −
duration`.

`SPACER_MS` is a LANDING separation, not a launch budget; the launch slack is
`JIT_LAUNCH_GUARD_MS = 230 ms` and is absorbed entirely by `additionalMsec`.
Conflating the two previously cost a factor of forty in pipeline depth — see
`spec/jit-reference.md` §2 before changing either.

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
- **shotgun**: two independent triggers. The CORRECTNESS trigger —
  `hackMs < SHOTGUN_HACK_MS (100 ms)`, the extreme-late-game regime where hack
  times collapse below the spacer grid — enters immediately, bypassing the
  dwell. The ECONOMIC trigger fires when RAM out-holds the landing grid:
  `ramBoundedBatches (farmGb/ramPerBatch)` exceeds
  `timeBoundedBatches (weakenMs at PREPPED security / minInterval)` by the
  `SHOTGUN_BOUND_HYSTERESIS = 1.2` margin — JIT's worker reuse pays when RAM
  binds, but a time-bound fleet idles RAM the minimum spacing can never
  schedule, and shotgun's same-deadline volleys need no spacing at all. The
  economic arm respects the 30 s dwell in both directions. Thread math is
  HGW's taken to the limit:
  every op of every batch in a wave lands the SAME engine tick
  (`additionalMsec = weakenTime − ownDuration`; the weakens land naturally),
  and the engine's same-tick rule — equal-deadline timers fire in
  registration order — turns LAUNCH order into arrival order. Batches are
  therefore emitted **H, G, W** (hack-first, unlike batched modes'
  weaken-first landings): after batch N's weaken the server is back at
  (minSec, moneyMax), so batch N+1's sizing is exact at its own arrival, and
  the landing-state fold reproduces the same sequencing pure-side (equal
  landings sort by opId = launch order). No anchor and no landing-grid depth
  cap — one wave is everything the farm budget holds, up to 256 batches per
  pass, bounded only by the engine-capacity rail (`MAX_LIVE_WORKERS`, reported
  via `stats.capped.processes`) — and always
  one-shot workers (nothing repeats inside a pool window at that structure).
  The tie-break proof (per-batch H → G+ → W+ effect order inside one tick,
  bands held across waves) is pinned in `sim/tests/dispatch.test.ts`.

`DispatchOptions.modeOverride` forces a mode (the sim's A/B lever); the rollup
reports `mode`.

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
pinned in `sim/tests/prediction.test.ts`. A second, coarser gate acts on
OBSERVED security: when the target's live `hackDifficulty` has drifted more
than `SECURITY_RECOVERY_DRIFT = 3·PREPPED_SEC_TOLERANCE` above min, the target
drains — no new leading weakens are admitted, started batches cash in, and the
prep path weakens the drift back — because per-batch skips alone let a spiral
feed itself.

**A running same-kind solve is a stable physical envelope.** Skill growth
continuously changes the fresh optimum, but H/G launch strength is already
late-bound to the landing context. Retiring the physical shape on those
re-solves created periodic deadline waves and a weaken-time drain/rebuild
sawtooth, so a shrink now keeps the generation. A pure upsize may replace it
only when the complete candidate schedule dominates the incumbent and still
fits the cap; component-wise quota unions are forbidden because their sum can
exceed the capacity that validated either input.

Only a batch-kind change requires a generation handoff: never-started batches
are cancelled, started batches drain at their own recorded role quotas
(`RetiringJitRuntime`, one retiring generation at a time), and the new
generation plans against `segmentCap − retiringCommitted`, re-fitting as the
old generation shrinks.
At runtime creation the dispatcher also evaluates a cadence-LEAN alternative
shape (`leanCadenceAlternative`): when the score-optimal shape packs a slow
grid and a leaner shape's faster cadence decisively wins
(`> 1.25×` realized rate), the lean shape remains locked for that target/mode.
Target switches use the same drain-not-flush semantics.

**A pass costs pool count, not process count.** The in-flight ledger holds one
entry per op — tens of thousands at depth — so `DispatchMemory` carries
indices over it (`byTarget`, `ourGbByHost`, `weakenPending`, `heldGbByRole`,
plus per-target landing/pending aggregates such as `landingByTarget` and
`pendingReservedGbByTarget`) written only by `trackOp`/`untrackOp`. A `Tracked` is immutable once
registered, which is what makes them safe; `tests/dispatch-index.test.ts` holds
each against a full recompute after every mutation. They replaced eight full
ledger walks per pass — one of them inside the per-batch loop, so
O(batches x ops) — which is what pegged a core and starved the game engine's
timers for 63 s at a stretch on a live 32k-worker fleet.

Prep fires in **non-overlapping waves per host** (a new wave only when the host
has no WAVE ops in flight — the counter is kept symmetric on the tracked
ledger, so farm-batch completions on a desynced farm host can never unlock an
overlapping second wave), so plans can never overshoot. A security wave is W1
alone; a money wave launches G and its W2 cover TOGETHER, the cover sized to
the grow threads that actually launched under the op cap and budget. Prep work
always spreads; only hack demands contiguity.

## RAM engine (`shared/ram/heap.ts`)

Inherited from an earlier rewrite (`nobody0/bitburner`, no longer checked out;
neither predecessor branch has a heap — `@2023` re-reads used RAM every pass,
`@master` tracks a per-client `reservedRamForCurrentBatch` scalar) — 21 clz32
slabs, home
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
Idle workers are indexed by `(kind, role)` then exact thread count, so a take
costs the size of the take rather than the size of the pool; the index
reproduces the selection order of the scan it replaced (descending threads,
then ascending `workerId`), which is what keeps the emitted action stream
unchanged. Resident RAM is summed per host and per role at spawn and exit
(`gbByHost`, `gbByRole`) — a worker owns its block for its whole process life,
so nothing moves on a job boundary. Pooling self-gates on live-op pressure (`POOL_PRESSURE_OPS`, just
before HGW's threshold) AND on the batch launch period fitting the idle window
(`POOL_REUSE_WINDOW_MS` — early-game depth-1 pipelines would strand every
worker). `stats.execs` (fresh processes) against `launched` (ops) is the churn
figure. Pinned by `tests/worker-pool.test.ts` (index against the old scan), the
pool-ledger test in `sim/tests/dispatch.test.ts`, and the real serve-loop tests
in `sim/tests/worker-serve.test.ts`.

The gates above were set by a measurement — −20 % time-to-goal with pooling
always on, attributed to idle workers stranding game RAM between jobs — that
**needs re-taking before it is trusted again**. It was made while `planTake`
scanned and sorted every resident worker on every call, a cost that existed
only on the pooled path, so "always on" was also "always quadratic"; the
attribution to stranding was never isolated from it. Two further changes have
since moved the same ground: the landing gap fell 200 ms → 5 ms, raising
pipeline depth and with it the fraction of idle windows that see a next job,
and role-envelope reservation now holds role RAM across the interval anyway.
Re-running the always-on arm is cheap and settles whether the gates still earn
their keep.

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
together. Stock selection remains purely economic; once a naturally selected
position has a reachable server, its live manipulation intent makes the farm
follow that exposure.

## Telemetry

One 1 Hz `farm` rollup (`shared/telemetry/state-map.ts`): target, prep target,
segment order, in-flight and landed counts, alloc/exec failures, pump time,
cumulative totals, batch/landing-order diagnostics, and the launch-health
counters `launchLate` (per-role lateness behind a reorder) and `quotaSkips`
(launches deferred by a full role or segment quota, keyed
`phase:role:cause`). Transition events only: `farm.targetSwitch`,
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

- An idle share/exp or prep segment's RAM SPILLS to the farm instead of idling —
  measured −13% median on hacking-early (18.5m → 16.1m, no seed worse). Share
  work itself IS now dispatched (`launchShare`, `shared/strategy/dispatch.ts`,
  with the marginal-value cutover in `shared/strategy/share.ts`).
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
