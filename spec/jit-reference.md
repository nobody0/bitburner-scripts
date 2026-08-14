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

Earlier revisions of this document derived the whole window model from
`bitburner-2023/src/_lib/batchers/jit.ts`. That was the wrong anchor: it is the
abandoned branch's unfinished batcher. The most consequential error it
introduced is described in §2.

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

We already have the pooled-worker half of this (`game/lib/dispatch-driver.ts`
worker pool, `game/lib/worker-shared.ts` job queue). We do **not** have the
fractional-strength triple; our thread counts are integers throughout.

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
(`batchRunner.ts:764-779`). We have no equivalent anywhere in
`shared/strategy/`.

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
| `additionalMsec` makes landings independent of launch jitter | `batchRunner.ts:141-157` | `game/lib/worker-shared.ts:18-22`, `game/worker/worker.ts:63-65` | **HAVE** — better: absolute deadline resolved in-worker |
| Landing separation distinct from launch slack | `batchPlanner.ts:7-14` | `shared/strategy/jit.ts` | **HAVE** — see §2 |
| Weaken over-scaled as ordering insurance | `batchPlanner.ts:21-27` | `shared/strategy/jit.ts` | **HAVE** |
| Fractional thread strength vs spawned threads | `batchPlanner.ts:59-91`, `batchRunner.ts:162-166` | — | **MISSING** — our thread counts are integers throughout |
| Core bonus drives client search order | `batchPlanner.ts:322-346`, `:417-468` | `shared/ram/heap.ts` core-aware conversion | **HAVE** |
| Chain follow-ups off measured end times | `batchRunner.ts:367-466` | `shared/strategy/dispatch.ts` landing grid | **PARTIAL** — we retain a fixed grid rather than chaining off observed completions |
| Abort counter propagates to downstream jobs | `batchRunner.ts:414-418` | `batchesSkipped` | **PARTIAL** — no propagation, and the counter conflates causes |
| Pools-per-job scaled by duration ratio | `batchPlanner.ts:532-558` | `shared/strategy/jit.ts` role envelope | **HAVE** |
| Interval discovered from reserved capacity | `batchPlanner.ts:830-866` | `chooseJitSchedule` | **HAVE** |
| Three batch shapes searched, best by `moneyPerMs` | `batchPlanner.ts:908-1004` | single shape | **MISSING** |
| Solver over-estimates then walks down to verified max money | `batchPlanner.ts:702-771` | exact integer solve | **HAVE** — different method, same guarantee |
| Hacking level projected to landing time | `batchRunner.ts:321-327` | — | **MISSING** |
| Hack shrunk instead of skipped when arrival money is low | `batchRunner.ts:446-449` | pending-hack resize + `missedWindow["arrival-money"]` | **HAVE** — different curve, same behaviour |
| Running batch re-derived from smallest reserved pool | `batchPlanner.ts:1011-1072` | — | **MISSING** |
| Horizon-integrated target choice net of prep | `batchPlanner.ts:1241-1336` | `shared/strategy/economics.ts:77-146` | **HAVE** — better: closed-form, continuous reinvestment |
| Horizon shrinks as install approaches | `batchRunner.ts:667-672` | — | **MISSING** |
| Retiring batch drains rather than dies | `batchRunner.ts:617-620` | — | **MISSING** |
| Old target backfills leftover RAM during new-target prep | `batchRunner.ts:586-599` | — | **MISSING** |
| Multi-target concurrent farming | — | — | **MISSING in both** — open opportunity |

## 8. How to tune against this reference

Use a settled measurement window and watch these together:

1. **Padding/native RAM-ms ratio** — `ramWork.paddingGbMsBySegment.farm /
   ramWork.nativeGbMsBySegment.farm` (`shared/telemetry/topics/hacking.ts`).
   Padding should scale with the launch guards, not with the gap between weaken
   time and hack time. Exact zero is not the goal.
2. **Landed/launched hack ratio** — the end-to-end window-survival metric.
   `sim/tests/scenario-jit-stress.test.ts` requires > 0.8.
3. **Median idle RAM share** — `free / (farm + prep + share + free)`. The stress
   scenario requires < 0.5 and asserts farm RAM never reaches zero. This is the
   metric the landing-gap conflation was suppressing.
4. **Money per second** — slope of cumulative `totals.moneyEarned`.

**Measured landing error is the missing instrument.** The reference logs both
start error and end error per pool against the predicted time
(`batchRunner.ts:177-193`, commented out but computed from
`pool.expectedEndTime`). Our `landing` is planned-only and `CompletionEvent`
carries no timestamp, so the landing gap cannot currently be falsified in the
live game — only in simulation. Until that exists, changes to
`MINIMUM_LANDING_GAP_MS` are validated against the simulator alone.
