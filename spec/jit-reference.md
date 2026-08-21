# JIT batcher technique reference

This document records the scheduling technique in the **proven** predecessor
batcher without adopting its mutable-global architecture. The useful artifact is
the timing and economic reasoning, not the old control structure.

## 0. Which predecessor

Both checkouts are the same GitLab repository,
[`nobody01/bitburnerscript`](https://gitlab.com/nobody01/bitburnerscript), at
different points in its history. They are **not** interchangeable, and the
batcher citations in this document are all to the later one.

| Short name | Branch / commit | Batcher | Use it for |
|---|---|---|---|
| `bitburner-master` | `master` @ `dc0720b` (42 commits) | `servers/home/imports/batchPlanner.ts`, `batchRunner.ts` | **The batcher.** Pooled resident workers, `additionalMsec` landing control, fractional thread strength, batch handoff. This is the version that ran well. |
| `bitburner-2023` | `2023` @ `43e8585` (54 commits) | `src/_lib/batchers/{jit,filler,prepare,shotgun}.ts`, `src/_lib/optimizer.ts` | Factions/augmentations, progression, stock, the `stubCall` RAM dodger. Its production path was `shotgun`+`prepare`+`filler`; **`jit.ts` was unwired work-in-progress and must not be cited as proven.** |

Do not re-anchor to `bitburner-2023`'s `jit.ts`: earlier revisions of this
document derived the whole window model from it, and §2 describes what that
cost.

## 1. Architecture: pooled resident workers

The single largest structural difference from a naive batcher is that a worker
process is spawned **once** and then re-tasked, rather than exec'd per
operation. `launchPool` execs every worker in a pool and leaves each parked on a
promise (`batchRunner.ts:8-76`); `startPool` later hands each one its task by
resolving `startCallback` (`batchRunner.ts:135-194`). RAM is reserved at plan
time and held for the pool's lifetime, so the steady state contains no exec
cost, no module-load latency, and no allocation race between batches.

A `ScriptWorker` carries three distinct thread counts, and keeping them separate
is what makes the arithmetic exact (`batchPlanner.ts:59-91`):

- `threadsSpawnedAs` — the integer thread count the process was exec'd with.
  Always rounded **up**, because the RAM is charged either way.
- `threadsStrengthActual` — `threadsSpawnedAs × coreBonus`. What the worker
  *can* do.
- `threadsToUse` — the fractional strength it is asked to do on this
  invocation, converted back through `coreBonus` at start time
  (`batchRunner.ts:162-166`).

`coreBonus = 1 + (cpuCores - 1) / 16` applies to grow and weaken only, never to
hack (`batchPlanner.ts:356`, `:388`). Client search order follows directly:
hack pools scan from the front of a list sorted core-ascending-then-RAM, grow
and weaken pools scan from the back, so core-bearing hosts are spent on the
operations that can use them (`batchPlanner.ts:322-346`, `:417-468`).

We have both halves: the pooled workers (`game/lib/dispatch-driver.ts` pool,
`game/lib/worker-shared.ts` job queue) and, since the 2024 re-audit, the
fractional-strength separation — `threads` / `effectThreads` /
`strengthThreads`, documented at the head of `shared/strategy/worker-pool.ts`.
See §9 for what it bought and for the one invariant that keeps it safe.

## 2. The window model — and the constant this project got wrong

Two timing constants exist and they measure different things
(`batchPlanner.ts:7-14`):

```text
JOB_LATE_FINISH = 3     // LANDING separation: how far apart effects land
POSSIBLE_LAGS   = 200   // LAUNCH slack: how late JS may be without moving a landing
```

`JOB_LATE_FINISH` chains the landings inside a batch — each job ends 3 ms after
its predecessor (`batchPlanner.ts:504-511`) — and `unsafeEndTime`, the minimum
separation between consecutive batches, is derived from it as
`(lastEnd - firstEnd) + JOB_LATE_FINISH`, i.e. ~12 ms for a three-job HGW batch
(`batchPlanner.ts:542-546`, `:550-558`).

`POSSIBLE_LAGS` never spaces a landing. It is added to `requiredTime` when
sizing how many pools a job needs (`batchPlanner.ts:537-540`) and it gates the
too-early check (`batchRunner.ts:394`). It is the width of the window in which
the JavaScript side may be late, and it is absorbed entirely by
`additionalMsec`.

That absorption is the whole point. The engine computes an operation's end time
from the moment the Netscript call is *made*, so passing
`additionalMsec = targetEndTime - now - requiredTime` (`batchRunner.ts:141-157`)
makes the landing independent of when JS got around to it. Two calls issued
50 ms apart in wall-clock can still land 3 ms apart.

**This repository conflated the two.** `MINIMUM_LANDING_GAP_MS` was
`40 × MINIMUM_WORKER_PRECISION_MS = 200 ms`, justified in-comment by "promise
continuation, exec and browser-timer jitter" — which is precisely the quantity
`additionalMsec` cancels, and which we already cancel more precisely than the
reference does by sending an absolute `delayUntil` deadline resolved inside the
worker immediately before the call (`game/lib/worker-shared.ts:18-22`,
`game/worker/worker.ts:63-65`) rather than computing it at dispatch. Since
`depthCapGb = floor(weakenMs / interval) × ramPerBatch`
(`shared/strategy/dispatch.ts`) scales inversely with the interval, that cost a
factor of forty in pipeline depth. The gap is now one handoff quantum, 5 ms,
and the HWGW interval 20 ms.

The conflation had propagated: two anchors and the overdue-retry backoff were
also spelled `SPACER_MS` while meaning "a launch budget", and each broke as soon
as the spacer stopped being generous. When auditing a timing constant here, the
question is always which of the two independent budgets it belongs to.

### Why 3 ms is survivable: oversized weaken as ordering insurance

Landing 3 ms apart means occasional misordering under a GC pause. The reference
does not try to prevent this; it makes it self-correcting
(`batchPlanner.ts:21-27`):

```text
THREAD_HACK_DOWNSCALE   = 0.999999   // hack slightly under-sized
THREAD_WEAKEN_UPSCALE   = 1.001      // weaken slightly over-sized
```

The comment is explicit that the weaken upscale "is also an insurance against
lags messing up the job order, because the weaken is oversized those previously
already queued weakens will fix that singular mess up." A batch that lands out
of order leaves a small security residue, and the next already-queued weaken —
being 0.1 % larger than it needs to be — absorbs it instead of starting a
spiral. Hack is downscaled by a matching hair so it can never overdraw.

Its own TODO notes the upscale should become dynamic in the number of in-flight
jobs, which is the obvious refinement.

**Porting the upscale needs one adjustment, and getting it wrong is expensive.**
The reference's thread counts are fractional, so `x * 1.001` really is +0.1%.
Ours are integers behind a `ceil`, and `ceil(x * 1.001)` turns that margin into
a WHOLE extra thread whenever `x` is near-integral — on a five-thread weaken,
+20%. Measured: on a 256 GB fleet that single extra thread pushed the JIT role
envelope past a `chooseJitSchedule` quantization boundary and **doubled the
batch interval, 7.6s → 15.1s**, halving hack throughput. The insurance is
therefore added, not multiplied: `ceil(exact) + floor(exact * 0.001)`, so it is
inert at small counts (where `ceil`'s own residue already covers a mis-order)
and a true 0.1% at scale (`shared/strategy/targeting.ts`, `weakenThreadsFor`).

The general lesson: because role RAM enters `chooseJitSchedule` through
`ceil(holdMs / interval)`, small thread-count changes are not small — they can
move the achievable cadence by a whole factor.

### Trigger deferral: why weaken completions, not timers, are the mechanism

**The priority order is: hit the target window first, minimise idle RAM
second.** Padding is idle time — a worker holding RAM while doing no native
work, accounted here as `gb × paddingMs` — so it is worth removing, but never
at the cost of a window.

The constraint that makes this subtle is that **an operation's duration is
fixed from the target's security at the moment the Netscript call is made, not
when the batch was planned.** Security fluctuates continuously as hacks and
grows land. So a scheduler that simply wakes on a timer and launches may find
security elevated, compute a longer duration than planned, and discover the
landing is no longer reachable at all.

Weaken completions are what resolve this: a weaken landing is the point at
which security is known to be back at (or near) minimum, and therefore the only
reliably safe moment to start work whose timing was solved at minimum security.
That is why the predecessor drives job starts off weaken completion promises
and treats the periodic batcher pass as a kickstart and recovery path, not as
the mechanism. `@2023` names the technique explicitly in
`getClosestWeakenTrigger`: before launching, it scans for a weaken finishing
closer to the wanted start and, if one exists, does **not** launch — it returns,
lets that weaken complete, and reconsiders from the completion-driven loop.
Launching early would work, but it would pay padding for the whole interval.

Our generalisation is `latestJitStart` (`shared/strategy/jit.ts`). Rather than
scanning for the nearest weaken, it divides the interval before a landing at
every predicted security event, computes the latest start in each interval that
still reaches the landing under the launch guard, and takes the latest valid
candidate. This subsumes the weaken scan — a weaken is just one kind of
security event — and it selects the same thing the scan is reaching for: the
last safe moment, which is the one with the least padding. When no guarded
future deadline remains it returns `now`, leaving the live-duration check at
dispatch to either launch immediately or abandon the dependent suffix.

The consequence for wake sources: the deadline timer and the periodic tick may
launch work, but neither can *guarantee* a safe window on its own. Only a
weaken completion does. Any change that makes the timer the primary driver, or
that widens launch windows, has to keep the completion path as the guarantee.

## 3. Job chaining: measured end times, not planned ones

Each job keeps `openEndTimes`, a queue of the actual expected end times of its
running pools (`batchPlanner.ts:150`). A follow-up job launches relative to the
**measured** end time of its predecessor, not to the plan
(`batchRunner.ts:367-443`):

```text
intendedTimeBetweenJobs = job.endTime - prevJob.endTime        // from the plan
currentTimeBetweenJobs  = (now + job.requiredTime) - prevOpenEndTime
diffToTarget            = intended - current
```

- `diffToTarget > POSSIBLE_LAGS` — too early, return and retry later.
- `diffToTarget < 0` — the window was missed. Prep batches launch anyway with
  no padding (late beats aborted); cycle batches abort.
- otherwise — launch with `targetedEndTime = now + requiredTime + diffToTarget`.

On success the consumed window is shifted off the predecessor and a new one
pushed for the successor (`batchRunner.ts:455-466`). The pipeline is therefore
self-correcting against drift rather than replaying a fixed schedule.

**Abort accounting.** A missed window increments `abortionCounter` on the failed
job *and on every downstream job in start order* (`batchRunner.ts:414-418`), so
that `completionCounter + abortionCounter` stays equal to `repeat` for every job
and the batch can still be recognized as finished. Our `batchesSkipped` has no
equivalent propagation and currently counts several unrelated causes.

## 4. Capacity: pools per job, and what sets the interval

Jobs have different durations (H:G:W = 1:3.2:4, `batchPlanner.ts:502`), so a
weaken job needs roughly four times as many resident pools as a hack job to
sustain the same cadence. That ratio is `poolsRequiredPerMaxParallel`, computed
against the longest job (`batchPlanner.ts:532-540`), and the achievable batch
interval falls out of the pools actually reserved
(`batchPlanner.ts:550-558`):

```text
lowestSupportedTimeBetweenBatches =
  max( JOB_LATE_FINISH,
       unsafeEndTime,
       max over jobs of (requiredTime + POSSIBLE_LAGS + JOB_LATE_FINISH) / poolCount )
```

`planMaxPools` then grows `maxParallel` until reservation fails, trims the
excess, and prices the batch from the interval it achieved
(`batchPlanner.ts:830-866`). Capacity is discovered, not assumed. `maxParallel`
is separately capped at 25 000 by `HIGHEST_MAX_PARALLEL`, documented as the
stable fraction of the game's ~400 k process ceiling
(`batchPlanner.ts:16-19`).

## 5. Sizing: three shapes, level lookahead, graceful degradation

**Three batch shapes.** Rather than solving one parameterization, the reference
fixes each of H, G, W in turn as the free integer variable, derives the other
two, and takes the best by `moneyPerMs` (`batchPlanner.ts:908-1004`):
`jit|HxGW` (fix hack, `growThreadsFractional` for grow), `jit|HGxW` (fix grow,
`hacksForGrows` for hack, `batchPlanner.ts:702-732`), and `jit|HGWx` (fix
weaken, `hackAndGrowForWeaken` for both, `:733-771`). Each search walks the
integer upward and stops after five consecutive non-improvements
(`batchPlanner.ts:974-978`). Both closed-form solvers deliberately over-estimate
and then walk the result down by 0.25 % until the batch verifiably returns the
server to max money (`:717-727`, `:755-766`).

**Future-level lookahead.** Hack percentage is evaluated when the hack *lands*,
not when it is launched, so a batch planned at the current level over-hacks
while the player is gaining experience. `updateBatch` projects the level at
landing and re-solves against it (`batchRunner.ts:321-327`):

```text
futureHackingLevel = calculateSkill(
  exp.hacking + totalExpPerMs * (hacktime + JOB_LATE_FINISH + POSSIBLE_LAGS), ...)
```

`totalExpPerMs` is maintained from the active batches' own `expPerMs`
(`batchRunner.ts:764-779`). Ours is `projectedSkill`
(`shared/strategy/prediction.ts`) driven by the measured `hackingExpRate` EMA;
it corrects the hack's STRENGTH rather than re-solving its thread count. See §9.

**Degrade, don't abort.** Two mechanisms keep a batch productive rather than
skipping it:

- At launch, hack strength is capped by the square of the target's current money
  fraction (`batchRunner.ts:446-449`):
  `threadStrengthToUseMax = plannedAs × (money/moneyMax)²`. An under-money target
  self-corrects over a few batches instead of stalling. We do shrink too — a
  pending hack is resized down and the event counted as
  `missedWindow["arrival-money"]` rather than dropped (pinned by
  `sim/tests/dispatch.test.ts` "shrinks a pending hack when money falls after
  planning but before dispatch"). The curve differs; the behaviour does not.
- `updateRunningBatchStrategy` re-derives the whole batch from the **smallest
  pool actually reserved** — weaken first, then grow limited by what that weaken
  can support, then hack limited by that grow (`batchPlanner.ts:1011-1072`). A
  partially-filled batch shrinks coherently instead of desynchronizing.

## 6. Target selection and handoff

Target choice integrates cumulative earnings over a horizon, net of prep time,
with reinvestment modelled by a precomputed table of RAM purchases ordered by
gain-per-cost (`batchPlanner.ts:1105-1198`, `:1241-1336`). The horizon shrinks
as an install approaches — 30 min normally, 5 min at `finishUp`, 1 min at
`ending` (`batchRunner.ts:667-672`).

Our `incomePresentValue` with a continuous reinvestment rate and prep cost as
foregone income (`shared/strategy/economics.ts:77-146`) is the same idea in
closed form and is the stronger of the two. The install-proximity horizon shrink
is the part we lack.

**Handoff.** The reference farms one target at a time — `activeTargetBatch` plus
`nextTargetBatch` and a queued slot for each (`batchRunner.ts:765-820`). What
keeps RAM busy across a switch is not concurrency but drain-and-backfill:

- `phaseOutBatch` retires a batch by setting `repeat` to what has already been
  launched (`batchRunner.ts:617-620`) — it drains, it does not kill.
- `reserveRamForBatch` reserves the incoming prep batch's RAM first, then a
  throwaway cycle batch is solved for the **old** target out of the remainder
  and run until the switch completes (`batchRunner.ts:586-599`,
  `batchPlanner.ts:1211-1231`).

Genuine multi-target concurrent farming is absent here too — it was never
successfully implemented in either predecessor — so it remains an open
opportunity for this project rather than a regression against the reference.

## 7. Map to this project

**HAVE** — present, at least as strong. **PARTIAL** — same goal, material
semantic gap. **MISSING** — no equivalent.

| Technique | Reference | Ours | Status |
|---|---|---|---|
| Pooled resident workers re-tasked without exec | `batchRunner.ts:8-76`, `:135-194` | `game/lib/dispatch-driver.ts` pool, `game/lib/worker-shared.ts` | **HAVE** |
| `additionalMsec` makes landings independent of launch jitter | `batchRunner.ts:141-157` | `game/lib/worker-shared.ts`, `game/worker/worker.ts` | **HAVE** — better: absolute deadline resolved in-worker |
| Landing separation distinct from launch slack | `batchPlanner.ts:7-14` | `shared/strategy/jit.ts` | **HAVE** — see §2 |
| Weaken over-scaled as ordering insurance | `batchPlanner.ts:21-27` | `shared/strategy/jit.ts` | **HAVE** |
| Fractional thread strength vs spawned threads | `batchPlanner.ts:59-91`, `batchRunner.ts:162-166` | `HgwAction.strengthThreads`, `worker-pool.ts` | **HAVE** — see §9 |
| Core bonus drives client search order | `batchPlanner.ts:322-346`, `:417-468` | `shared/ram/heap.ts` core-aware conversion | **HAVE** |
| Chain follow-ups off measured end times | `batchRunner.ts:367-466` | `shared/strategy/dispatch.ts` landing grid | **N/A** — its `openEndTimes` is a capacity handoff FIFO; `jitCapacity`'s per-role integer slot reservation is the same guarantee, made statically |
| Abort counter propagates to downstream jobs | `batchRunner.ts:414-418` | `missedWindow` by cause + `landingOrder` | **HAVE** — a miss drops only its own batch's suffix, and causes are labelled rather than pooled |
| Pools-per-job scaled by duration ratio | `batchPlanner.ts:532-558` | `shared/strategy/jit.ts` role envelope | **HAVE** |
| Interval discovered from reserved capacity | `batchPlanner.ts:830-866` | `chooseJitSchedule` | **HAVE** |
| Three batch shapes searched, best by `moneyPerMs` | `batchPlanner.ts:908-1004` | `solveCycle` exhaustive H search | **N/A below `EXACT_THREAD_LIMIT`**; measured worth <0.15% above it (audit Q5) — see §9 |
| Solver over-estimates then walks down to verified max money | `batchPlanner.ts:702-771` | exact integer solve | **HAVE** — different method, same guarantee |
| Hacking level projected to landing time | `batchRunner.ts:321-327` | `projectedSkill`, `landingCtxFactory` | **HAVE** on the JIT *and* eager paths (shotgun exempt: one engine tick) — see §9 |
| Hack shrunk instead of skipped when arrival money is low | `batchRunner.ts:446-449` | `hackThreadsAtLanding` + `strengthThreads` | **HAVE** — better: no reservation churn, exact rather than ceil'd |
| Running batch re-derived from smallest reserved pool | `batchPlanner.ts:1011-1072` | `sizeBatchAtLanding`, reserve-before-emit | **HAVE** — different shape: we never emit a partially-filled batch, so there is nothing to re-derive |
| Horizon-integrated target choice net of prep | `batchPlanner.ts:1241-1336` | `shared/strategy/economics.ts` | **HAVE** — better: closed-form, continuous reinvestment |
| Horizon shrinks as install approaches | `batchRunner.ts:667-672` | `game/lib/features/hacking.ts` `installSec` -> `horizonMs` | **HAVE** |
| Retiring batch drains rather than dies | `batchRunner.ts:617-620` | `abandonJitPending` | **HAVE** — it releases only UNLAUNCHED reservations; in-flight ops complete |
| Old target backfills leftover RAM during new-target prep | `batchRunner.ts:586-599` | farm and prep are concurrent segments | **N/A** — see §9 |
| Measured landing error per op | `batchRunner.ts:177-193` | `DispatchStats.landingError` | **HAVE** |
| Multi-target concurrent farming | — | — | **MISSING in both** — open opportunity |

## 8. How to tune against this reference

Use a settled measurement window and watch these together:

1. **Padding/native RAM-ms ratio** — `ramWork.paddingGbMsBySegment.farm /
   ramWork.nativeGbMsBySegment.farm` (`shared/telemetry/topics/hacking.ts`).
   Padding should scale with the launch guards, not with the gap between weaken
   time and hack time. Exact zero is not the goal.
2. **Landed/launched hack ratio** — the end-to-end window-survival metric.
   `sim/tests/scenario-jit.test.ts` (jit-stress) requires > 0.8.
3. **Median idle RAM share** — `free / (farm + prep + share + free)`. The stress
   scenario requires < 0.5 and asserts farm RAM never reaches zero. This is the
   metric the landing-gap conflation was suppressing.
4. **Money per second** — slope of cumulative `totals.moneyEarned`.
5. **Measured landing error** — `landingError` (mean/min/max/maxAbs) in the farm
   rollup. The reference logs the same quantity per pool against
   `pool.expectedEndTime` (`batchRunner.ts:177-193`, computed but commented
   out). `maxAbsMs` above one landing gap means effects are reordering; a mean
   far from zero means the duration model is biased. Read it from a LIVE run:
   the simulator lands ops exactly on plan, so it reports ~0 there by
   construction and cannot validate `MINIMUM_LANDING_GAP_MS` on its own (§9).

## 9. The 2024 re-audit

What the 2024 single-target batcher had that this project did not — and, more
usefully, what was deliberately NOT ported, with the reason.

### Closed: fractional thread strength

`BasicHGWOptions.threads` is documented "Accepts positive non integer values"
and must be `<=` the script's thread count. We passed no `threads` option at
all, so a worker always acted at its full spawned count. The reference kept
three counts per worker and converted between them at start time; we now keep
the same separation under different names, stated once at the head of
`shared/strategy/worker-pool.ts`:

```text
threads          INTEGER, what RAM was billed for. Never fractional.
effectThreads    one-core-equivalent strength of that block (the solver's unit).
strengthThreads  the strength ASKED of it on one invocation; <= threads.
```

**Only `threads` may reach the JIT capacity math.** Role RAM enters
`chooseJitSchedule` through `ceil(holdMs / interval)`, so a size that moves can
move the whole batch interval (§2), whereas a strength that moves costs nothing.
`sim/tests/dispatch.test.ts` pins exactly this: with a non-zero
`hackingExpRate`, the hack's strength drops while `depthCapGb`, the support
thread counts and every role size stay identical.

What it bought:

- **Pooled hack reuse.** `planTake` demanded an EXACT thread match for hack,
  because a hack must land as one call. It may now reuse any worker at least the
  op's size, best fit. Grow gained a matching remainder step. Weaken deliberately
  did not: over-weakening clamps at `minDifficulty` and IS the ordering
  insurance, so asking a weaken worker for exactly its computed strength would
  remove protection for nothing.
- **Exact prep fortify.** `allocFor` rounds effect units up into whole threads;
  the prep grow now spends that residue instead of over-growing and
  over-fortifying past what W2 was sized to cover.
- **A free arrival-money shrink.** The shrink used to release the committed
  block and re-place a smaller one. It now just asks for less, so the
  reservation never returns to the heap where a lower-priority tenant could take
  it, and `hackThreadsAtLanding` returns an unrounded correction rather than
  over-shrinking by up to a whole thread.

### Closed: hacking level projected to the landing instant

Hack DURATION is fixed when the Netscript call is made, and was already priced
live each pass. Hack PERCENTAGE is read when the hack LANDS, so a batch solved
at level L over-steals if it lands at L+n and its grow — sized for the smaller
steal — no longer restores the server. `projectedSkill`
(`shared/strategy/prediction.ts`) and `landingCtxFactory`
(`shared/strategy/dispatch.ts`) close it at two sites: batch sizing, and the
dispatch-time re-check, which has the shortest horizon and therefore the
smallest error.

Deliberately NOT re-solved into `hackThreads`, for the reason above — the
correction rides on `strengthThreads` alone.

**A prerequisite that was silently wrong.** The skill curve uses
`mults.hacking × BitNodeMultipliers.HackingLevelMultiplier`, and the node
multiplier was never reaching the pure layer. It is 0.35 in BN4 and 0.25 in BN9,
so every forward projection of the hacking level ran about threefold hot there —
the evaluator's prep-time discount and its experience valuation, not only the new
code. `HackNodeMults.HackingLevelMultiplier` now carries it and
`evaluator.ts:hackingLevelMult` is the single place it is applied.

### Closed: measured landing error

`CompletionEvent` carried no timestamp, so landing error was unfalsifiable
outside the simulator. It now carries `at`, stamped by the worker in its own
`atExit` (not by the pump, which may run milliseconds later), and
`DispatchStats.landingError` keeps a signed distribution.

This immediately paid for itself. The comment at the JIT admission check named
its own blocker — "needs a wake at the weaken landing rather than a poll; land
that first" — and that wake now exists (weaken completions bypass both
`WAKE_MIN_MS` and `WAKE_MAX_PER_FRAME`, and spread fragments coalesce on a
trailing timer). Re-measured with the prerequisite satisfied, the tightening is
**still** a large loss: on share-churn it cut launched hacks 2,497 → 729 and
income $9.39e7 → $1.55e7/s. The prerequisite was not the problem, and the
comment now says so.

Note the instrument's limit, recorded honestly: the simulator lands ops exactly
on plan (measured mean −6e−12 ms), so it cannot price this trade at all. The
measurement has to come from the live game.

### Closed: the two engine-capacity rails

Neither predecessor row covered these and neither did the table, but the
reference had both and we had neither.

**A live-process ceiling.** RAM accounting bounds GB, not process COUNT. A fleet
with free GB and a short hack time plans more depth than the browser's
JavaScript heap can hold, and shotgun had no depth cap at all ("bounded by RAM
alone"). The failure mode is an out-of-memory tab, not a refused `exec`, so
nothing upstream reports it. `MAX_LIVE_WORKERS` is the observed V8 ceiling,
400k, applied directly — it is already a count of workers. The reference
expressed the same limit indirectly, dividing it by its per-batch pool weights
to reach a parallel-BATCH number (`batchPlanner.ts:16-19`); that division
belongs to its accounting, not ours, since we count processes as processes. The
rail is checked in both `planJitBatches` (where depth is committed) and
`launchBatches` (where it is spent). `liveProcessCount` is O(1): pooled workers plus one-shot ops, less the
busy pooled ops the two would otherwise double-count.

**A per-pass launch bound.** Every action becomes a synchronous `ns.exec` — the
driver loop has no `await` and no cap — so an unbounded pass starves the
engine's timers for the length of the whole wave. The JIT path already
self-limited through `MAX_PREP_OPS_PER_PASS`; shotgun and the eager path did
not. The reference solved it twice: serialized spawns (`batchRunner.ts:65`) and
5 job-starts per scheduler call (`:346`). We cannot copy the `await` — the pump
is invoked without one, so an async pump would let two passes interleave — so
`MAX_LAUNCH_ACTIONS_PER_PASS` lives in the pure layer where the simulator sees
it too. Checked at BATCH granularity and counting the batch about to be emitted:
splitting a batch could put a hack in flight whose weaken cover was never
launched.

Both rails report through `stats.capped` rather than dropping silently. A
persistently non-zero `capped.processes` is the interesting one — it means the
cadence wants more depth than the browser can carry.

### Closed: grow late-bound, weaken deliberately not

Late binding was hack-only. Grow is the other operation where "too much" costs
something, and the asymmetry decides the clamp:

- **Over-growing is not free.** Growth clamps at `moneyMax`, so the surplus buys
  nothing, but its `GROW_FORTIFY` is charged anyway — and W2 was sized for the
  PLANNED grow. It is the one error that can outrun its own cover.
- **Under-growing costs money for one batch**, then the next hack's
  arrival-money brake sizes itself down to match.

So `growThreadsAtLanding` (`shared/strategy/prediction.ts`) re-derives the
requirement from the predicted arrival money and clamps it to the committed
weaken cover, never above it, even when the money says a larger grow would pay.

**Weaken is exempt, permanently.** It always runs at its full spawned strength:
the RAM is committed by the time it launches, over-weakening clamps harmlessly
at `minDifficulty`, and the surplus IS the ordering insurance of section 2. No
`strengthThreads` is ever set on a weaken op — pinned by a test.

This is the useful half of the reference's `updateRunningBatchStrategy`
(`batchPlanner.ts:1011-1072`), which also clamped weaken down to its smallest
reserved pool. We do not: full weaken strength IS the cover budget, so the chain
runs one direction only, weaken (fixed) → grow → hack.

**One trap worth recording.** `launchDueJit` folds the in-flight ledger through
a single forward cursor, which is only valid for non-decreasing landings. Within
a batch the grow lands AFTER the hack but launches WELL BEFORE it (grow runs
~3.2x longer), so the loop reaches them in the opposite order to their landings.
Sharing one cursor takes the O(ledger) fallback on essentially every hack and
restores exactly the O(depth^2) pass the cursor exists to remove. Each KIND is
monotonic in isolation, so hack and grow get one cursor each.

### Closed: hack steered away from cored hosts

Cores multiply grow and weaken and do nothing for hack, so a hack on a cored
host is pure waste — same RAM, and it denies the bonus to the only operations
that can spend it. A core-aware request already prefers cores implicitly (more
cores means fewer real threads means less GB); the contiguous placement path now
pushes the other way for requests that cannot use them. It is a PREFERENCE
ranked below capacity and above the fit tie-break, so hack still places on a
cored host when nothing else fits. The reference reaches the same arrangement by
sorting clients core-ascending and scanning hack from the front while grow and
weaken scan from the back, so the two meet in the middle
(`batchPlanner.ts:327-345`, `:420-429`).

Note the direction: it is the inverse of the naive reading. Cores boost grow and
weaken, never hack (`shared/formulas.ts`, matching `batchPlanner.ts:356`).

### NOT ported, with reasons

Three rows were listed as gaps and are not:

- **Three batch shapes** (`jit|HxGW`, `HGxW`, `HGWx`). The reference needs them
  because its thread counts are FRACTIONAL: fixing G or W as the integer
  variable reaches lattice points its H-walk skips, and its search stops after
  five consecutive non-improvements. Ours are `ceil`ed, so H determines the whole
  batch, and `solveCycle` exhausts every integer H up to `EXACT_THREAD_LIMIT`.
  Below that bound the H search strictly subsumes all three shapes. Above it we
  fall back to a grid-plus-refinement heuristic, and *there* a second
  parameterization could still have found something — that, not the general
  claim, was the open question. **Measured and closed:** the heuristic stays
  within 0.15% of the exhaustive oracle, because the score surface is flat
  across that region, so another anchor lands on the same plateau. Numbers and
  method in audit Q5, `tests/hacking-audit.test.ts`.
- **Chaining off measured end times.** `openEndTimes` is a capacity handoff
  FIFO: a follow-up launches when a slot from its predecessor is free. Our
  per-role `jitCapacity` reserves `ceil(holdMs / interval)` slots up front, which
  is the same guarantee made statically rather than discovered per launch.
- **Drain-and-backfill on target switch.** The reference farms ONE target at a
  time, so a switch would stop income entirely; `phaseOutBatch` plus a throwaway
  cycle batch on the old target is the workaround. We do not have that problem:
  farm and prep are concurrent segments with separate RAM, so the old target
  keeps farming for the whole of the new one's prep (pinned by the
  `farmAndPrep` assertion in `sim/tests/scenario-jit.test.ts`). The drain half is
  present too — `abandonJitPending` releases only UNLAUNCHED reservations and
  lets in-flight ops complete.

### Still open

- **Multi-target concurrent farming.** Absent in both. Still the largest
  structural opportunity.
- **Live landing-error measurement**, which is instrumented but has to be read
  off a real run before either timing tightening can be judged. Now split per
  op kind (`landingErrorByKind`) and rendered in the hacking tab; before that
  it was published and displayed nowhere, so the reading these two decisions
  wait on could not be taken by looking at the game.
- **The `POOL_PRESSURE_OPS` gate**, still resting on a measurement the code
  declares invalid. Blocked on a fixture: `jit-process-pressure` earns nothing
  (12 virtual minutes, 6.2 TB in use, zero landings of any kind), and a 16 TB
  JIT fixture reaches only ~395 concurrent ops after 180 s — well below the
  1,000 gate. See the gap-analysis entry in `spec/progress.md`.
