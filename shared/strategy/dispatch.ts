import {
  GROW_FORTIFY,
  growthLogPerThread,
  growThreads,
  growTimeSeconds,
  HACK_FORTIFY,
  hackExpGain,
  hackPercent,
  hackTimeSeconds,
  makeHackContext,
  weakenEffect,
  weakenTimeSeconds,
  type HackContext,
} from "../formulas.ts";
import { Heap, type Reservation } from "../ram/heap.ts";
import type { Action, CompletionEvent, ServerView, StockInfluence, WorldView } from "../world.ts";
import { WORKER_RAM } from "../world.ts";
import { intelligenceBonus } from "./factions/rep.ts";
import type { SharePricingInput } from "./share.ts";
import type { ChargePricingInput } from "./stanek/charge.ts";
import type { Segment, SegmentKind, TargetDirective } from "./directive.ts";
import {
  FARM_SOLVE_SHARE,
  WORKER_RAM_FLOOR,
  adaptSegmentsToFleet,
  initEvaluator,
  hackingLevelMult,
  staticsOf,
  stepEvaluator,
  type EvaluatorMemory,
  type FleetCapacity,
} from "./evaluator.ts";
import { isPrepped, PREPPED_SEC_TOLERANCE, solveCycle, solvePrep, type CycleSolution, type RamCaps } from "./targeting.ts";
import { coreEffect } from "../ram/heap.ts";
import { addGb, bump, drainGb, subGb } from "../tally.ts";
import { decideMode, type FarmMode } from "./mode.ts";
import { cheapestCloudQuote } from "./ram-supply.ts";
import { applyLedgerOp, compareLedgerOps, growThreadsAtLanding, hackThreadsAtLanding, predictAtLanding, projectedSkill, sizeBatchAtLanding, type LedgerOp, type PredictedState } from "./prediction.ts";
import {
  initPool,
  noteExit,
  noteJobDone,
  noteJobStart,
  noteSpawn,
  planTake,
  poolCounts,
  type WorkerPoolMemory,
} from "./worker-pool.ts";
import {
  chooseJitSchedule,
  cycleJitRoles,
  cycleWorstDifficulty,
  HGW_MIN_INTERVAL_MS,
  HWGW_MIN_INTERVAL_MS,
  jitCapacity,
  JIT_LAUNCH_GUARD_MS as TIMING_JIT_LAUNCH_GUARD_MS,
  latestJitStart,
  MINIMUM_LANDING_GAP_MS,
  MINIMUM_WORKER_PRECISION_MS,
  WORKER_STARTUP_GUARD_MS as TIMING_WORKER_STARTUP_GUARD_MS,
  type JitRole,
  type JitSchedule,
  type JitSecurityEvent,
} from "./jit.ts";

/** HWGW batch dispatcher — pure. Plans slow support first, then emits each
 * operation near its native start so the effects land H → W1 → G → W2,
 * `SPACER` apart. The same code runs in the sim and game, so A/B transfers.
 *
 * Landing math per op: additionalMsec = landing − now − duration. Anchoring the
 * batch anchor is at least its capacity-derived interval after the previous
 * one, which is the collision guard (pure bookkeeping — no ns reads).
 *
 * RAM: the JIT role envelope reserves executable capacity, not speculative
 * heap entries. Each due op allocates real RAM; a missed/failed support step
 * cancels the dependent pending suffix before its hack can launch. Shotgun and
 * borrowed prep RAM retain the simpler batch-atomic eager path.
 * Source (additionalMsec is added to each duration at invocation): https://github.com/bitburner-official/bitburner-src/blob/3162fd2590e221eadd0c0fbd46151913f7c4c41c/src/Netscript/NetscriptHelpers.tsx#L537-L561 and https://github.com/bitburner-official/bitburner-src/blob/3162fd2590e221eadd0c0fbd46151913f7c4c41c/src/NetscriptFunctions.ts#L266-L286 */

export const SPACER_MS = MINIMUM_LANDING_GAP_MS;
/** Public aliases retained for dispatcher tests and diagnostics. */
export const WORKER_STARTUP_GUARD_MS = TIMING_WORKER_STARTUP_GUARD_MS;
export const JIT_LAUNCH_GUARD_MS = TIMING_JIT_LAUNCH_GUARD_MS;
/** Distinct prep effects use the same proven timer guard as farm effects. This
 * is landing precision, not a minimum time for staying on a target. */
export const PREP_ORDER_MS = SPACER_MS;
export const INTERVAL_MS = HWGW_MIN_INTERVAL_MS; // == targeting's BATCH_INTERVAL_S · 1000
/** Fallback retry cadence for an op that is due but could not be placed. */
export const OVERDUE_RETRY_MS = TIMING_WORKER_STARTUP_GUARD_MS;
/** How far ahead one pass may reach for launchable work, spending padding to
 * avoid a wake per landing gap. Capped by the reservation lead
 * (JIT_LAUNCH_GUARD_MS - WORKER_STARTUP_GUARD_MS) so an op reached early has
 * already been reserved, and truncated at the next weaken landing at use. */
export const JIT_LAUNCH_WINDOW_MS = TIMING_JIT_LAUNCH_GUARD_MS - TIMING_WORKER_STARTUP_GUARD_MS;
/** Cap launches per pass so one scheduler call stays inside the tick budget. */
export const MAX_BATCHES_PER_PASS = 8;
/** Batch-RAM drift (either direction) beyond which a re-solve hands the
 * pipeline to a new shape generation instead of adjusting in place. Inside the
 * band, a shrink keeps the reserved shape and an upsize adopts directly. */
export const JIT_RESHAPE_RATIO = 1.25;
/** Launch-gate tolerance over the schedule's HACK-role quota. Quotas are
 * recomputed from CURRENT durations while in-flight ops hold RAM at the
 * longer durations they launched with, so under continuous skill growth the
 * quota sits persistently a few slots under reality; the hack — launched last
 * and carrying the money — then lands seconds late or not at all (measured on
 * the speed-step lane: 26k hack launch-skips, "w1 landed where h was due",
 * income half of what the same code earns with the slack). Hack ONLY: h is
 * the smallest role RAM so the overfill cannot crowd the heap; the same slack
 * on grow or the weakens measurably destroys the share-churn lane
 * ($9.7e7 -> $1.1e7/s) — their overfill crowds the RAM share/dodge traffic
 * needs.
 * Scheduling stays honest; the heap remains the hard capacity bound. */
export const JIT_QUOTA_SLACK = 1.5;
/** Observed security drift beyond which the farm stops admitting batches and
 * recovers the target first (weakens only). Above the prepped tolerance so a
 * single slightly-late weaken never triggers it; low enough that a mis-order
 * cascade cannot compound — every batch solved against min security steals
 * and grows wrong once the target sits multiple points above it. */
export const SECURITY_RECOVERY_DRIFT = 3 * PREPPED_SEC_TOLERANCE;
/** Heartbeat-only producer budget. At a 5 ms landing cadence a 200 ms
 * heartbeat consumes forty batches, so the old eight-batch limit could only
 * stay full because completion wakes incorrectly performed planning too. */
export const MAX_JIT_BATCHES_PER_MAINTENANCE = 512;
/** Shotgun emits a whole wave per pass — every batch lands the same engine
 * tick, so there is no interleave to protect, only the pump budget. */
export const SHOTGUN_BATCHES_PER_PASS = 256;
/** Up to 24 source slabs per prep phase. A correct distributed grow needs an
 * atomic grow plus its own interleaved weaken, hence two calls per slab; using
 * the old 24-CALL ceiling would halve grow concurrency merely because the
 * cover became explicit. W1 may use the whole call ceiling for fragments,
 * and RAM remains the primary bound in either phase. */
export const MAX_PREP_SLABS_PER_PASS = 24;
export const MAX_PREP_OPS_PER_PASS = 2 * MAX_PREP_SLABS_PER_PASS;
/** Pooled workers idle out after this long (worker.ts IDLE_MS — keep the two
 * in agreement): pooling is only worth it when the batch launch period fits
 * inside it, so a worker's next job arrives before its process exits. */
export const POOL_REUSE_WINDOW_MS = 5_000;
/** Live in-flight ops below which pooling stays OFF even when reuse would
 * work. The gate exists because pooling measured −20 % time-to-goal on a 4 TB
 * profile with it always on, attributed to idle workers stranding RAM between
 * jobs, against browser-side relief (exec churn) — so it engages only when the
 * process count is actually pressuring the browser, just before HGW does.
 *
 * That attribution is UNVERIFIED and the number needs re-taking. It was
 * measured while `planTake` scanned and sorted every resident worker per call,
 * a cost carried only by the pooled path, so "always on" was also "always
 * quadratic"; stranding was never isolated from it. The scan is gone
 * (shared/strategy/worker-pool.ts idle index) and two other changes moved the
 * same ground since — the landing gap fell 200 ms → 5 ms, raising depth and so
 * the share of idle windows that see a next job, and role-envelope reservation
 * holds role RAM across the interval regardless.
 *
 * Re-taking it is blocked on a fixture, and the obstacle is DEPTH rather than
 * fleet size: a 16 TB JIT fixture reaches only ~395 concurrent tracked ops
 * after 180 s of virtual time, well under this gate. `jit-process-pressure`
 * was written for exactly this and produces no landings at all (see the Known
 * gaps in spec/progress.md), so repairing it is step zero. */
export const POOL_PRESSURE_OPS = 1_000;
const JIT_ROLE_PRIORITY: Record<JitRole["role"], number> = { w1: 0, w2: 1, g: 2, h: 3 };
/** Consecutive arrival-money hack zeroings treated as a pipeline desync (see
 * DispatchMemory.hackZeroStreak). One is routine safety-brake noise; a run
 * means the predicted ledger has drifted from the observable server. */
export const HACK_ZERO_DESYNC_STREAK = 3;
/** Smallest hack strength still worth dispatching.
 *
 * Fractional `opts.threads` means an arrival-money shrink no longer bottoms out
 * at a whole thread, so the cancel threshold has to be stated rather than
 * inherited from integer arithmetic. A tenth of a thread steals a tenth of one
 * thread's percentage — far below the landing-gap's worth of income, and it
 * still costs a process, a landing slot and a fold entry. Cancelling frees the
 * block for the next batch instead. */
export const MIN_HACK_STRENGTH_THREADS = 0.1;
/** Hard ceiling on concurrently live worker PROCESSES.
 *
 * The engine keeps every running script in memory; past this many the browser's
 * JavaScript heap is the binding constraint, not RAM, and the failure mode is
 * an out-of-memory tab rather than a refused exec. Nothing in the RAM
 * accounting bounds process COUNT: a fleet with plenty of free GB and a very
 * short hack time will happily plan more batches than the engine can hold, and
 * shotgun has no depth cap at all.
 *
 * 400k is the observed V8 ceiling, and it is a count of WORKERS, so it is
 * applied here directly. The reference expressed the same limit indirectly,
 * dividing it by its per-batch pool weights to get a parallel-BATCH number
 * (imports/batchPlanner.ts:16-19); that division belongs to its accounting,
 * not to ours, because we count processes as processes.
 *
 * Treat it as a safety rail, not a target: reaching it means the cadence wants
 * more depth than the browser can carry, and the clamp is reported through
 * `stats.capped.processes` so that shows up in telemetry instead of as a
 * crash. */
export const MAX_LIVE_WORKERS = 400_000;
/** Ceiling on launch actions emitted in ONE pass.
 *
 * Every action becomes a synchronous `ns.exec` in the driver — the loop at
 * game/lib/dispatch-driver.ts has no await and no cap of its own — so an
 * unbounded pass blocks the engine's timers for as long as it takes to spawn
 * the whole wave, which is exactly the freeze this bounds. The JIT path
 * already self-limits through MAX_PREP_OPS_PER_PASS; shotgun and the eager
 * path did not.
 *
 * The reference solved the same problem twice over: it serialized every spawn
 * behind an await (imports/batchRunner.ts:65) and capped work per scheduler
 * call at 5 job-starts (:346). We cannot copy the await — the pump is invoked
 * without one, so making it async would let two passes interleave — so the
 * bound has to live here, in the pure layer, where the simulator sees it too.
 *
 * Checked at BATCH granularity, never per action: cutting a batch in half
 * could emit a hack whose weaken cover is still unlaunched. The check counts
 * the batch about to be emitted, so this is a true ceiling rather than a
 * threshold that the last batch may overshoot. Work not emitted this pass is
 * not lost; the next tick or wake continues from the same pending state.
 *
 * Farm launches only. Prep waves are bounded separately and independently by
 * MAX_PREP_OPS_PER_PASS. */
export const MAX_LAUNCH_ACTIONS_PER_PASS = 256;

/** Real fractional threads for a requested one-core EFFECT.
 *
 * The solver works in one-core effect units; Netscript's `opts.threads` wants
 * REAL threads on the host the block actually landed on. Inverting the block's
 * own effect-per-real-thread converts between them — the same conversion the
 * reference did with its per-host coreBonus (imports/batchRunner.ts:162-166).
 *
 * Never above the spawned count: the engine throws when `opts.threads` exceeds
 * the process's own thread count, and a throw mid-batch loses the whole op. */
function resolveStrength(
  threads: number,
  effectThreads: number,
  /** Effect this call should perform, when that is less than the block is
   * worth. Absent = use the whole block. */
  strengthEffect?: number,
): { strengthThreads: number; usedEffect: number } {
  const coreRatio = threads > 0 ? effectThreads / threads : 1;
  const usedEffect = strengthEffect === undefined
    ? effectThreads
    : Math.min(effectThreads, strengthEffect);
  // `usedEffect` is what the in-flight ledger must fold: security fortify and
  // growth both scale with the effect actually performed, not with the block.
  return { strengthThreads: Math.min(threads, usedEffect / coreRatio), usedEffect };
}

/** Worst-case worker processes one batch of this shape occupies: HWGW lands
 * four ops, HGW three. Pooling may serve some without a fresh process, so this
 * over-counts, which is the safe direction for a capacity rail. */
function opsPerBatchFor(kind: CycleSolution["kind"]): number {
  return kind === "hgw" ? 3 : 4;
}

/** Live worker processes: resident pooled workers, plus the one-shot ops that
 * own a process of their own.
 *
 * `tracked` holds both pooled and one-shot ops, and a BUSY pooled worker is
 * counted by both, so the busy count is subtracted to avoid double counting.
 * Idle pooled workers hold a process without a tracked op and are counted by
 * `workers`. O(1) — this is consulted per batch on the hot path. */
export function liveProcessCount(memory: DispatchMemory): number {
  const { workers, busy } = poolCounts(memory.pool);
  return workers + Math.max(0, memory.tracked.size - busy);
}
export interface Tracked {
  /** SOURCE host the op's RAM is reserved on. */
  hostname: string;
  /** TARGET host the op acts on. */
  target: string;
  kind: "hack" | "grow" | "weaken";
  segment: SegmentKind;
  gb: number;
  /** True only for ops launched by a prep wave: the prepInFlight counter is
   * incremented at launch and decremented on release for exactly these ops,
   * so farm-batch completions on the same target can never unlock an
   * overlapping second wave. */
  wave: boolean;
  /** When this op's effect applies (ms, view.time clock) — the in-flight
   * ledger the landing-state prediction folds over. */
  landing?: number;
  /** Core-adjusted one-core-equivalent threads (grow/weaken strength). */
  effectThreads?: number;
  /** REAL fractional threads the op was dispatched at, when that is less than
   * the block it occupies. Security fortify scales with this, not with the
   * block, so the in-flight ledger must fold it — `jitSecurityEvents` turns it
   * into `HACK_FORTIFY * threads` for `latestJitStart`, and deriving it from
   * `gb / WORKER_RAM[kind]` instead would over-state every downstream
   * operation's difficulty and launch it early into needless padding. */
  strengthThreads?: number;
  /** Pooled op: the serve worker running it. The WORKER owns the heap
   * reservation (freed on its workerExit), not the op. */
  workerId?: number;
  /** This op's action also SPAWNED the worker (its first job), so a failed
   * exec must tear the pool entry down again. */
  spawned?: boolean;
  /** Steady-state JIT pipeline role. Capacity is reserved per role so a long
   * weaken can never consume the RAM a later grow or hack is counting on. */
  jitRole?: JitRole["role"];
  /** Shape generation of the batch this op belongs to (see PendingJitBatch);
   * the retiring generation's held-RAM ledger drains only on its own ops. */
  jitGeneration?: number;
  /** Telemetry identity of the batch this op belongs to. Scheduling and
   * failure recovery deliberately do not route through this id. */
  batchId?: number;
  /** Direct owner for a pending JIT suffix. Batch-local exec recovery follows
   * this reference; batchId remains telemetry identity, never a scheduler key. */
  pendingBatch?: PendingJitBatch;
}

interface PendingJitOp {
  role: JitRole["role"];
  kind: "hack" | "grow" | "weaken";
  /** One-core effect units, and the SIZE of the operation: RAM, the per-role
   * quota, the reservation and the JIT cadence are all derived from it. It must
   * therefore never shrink in response to a transient landing-state change —
   * role RAM reaches `chooseJitSchedule` through `ceil(holdMs / interval)`, so
   * a thread count that moves can move the whole batch interval. Reduce
   * `strengthThreads` instead. */
  threads: number;
  /** One-core effect units this op should actually PERFORM, when the landing
   * state no longer supports the full planned size. Absent = perform all of
   * `threads`. Costs nothing to reduce: `opts.threads` is fractional, so the
   * already-committed block simply does less. */
  strengthThreads?: number;
  /** Hack only: the PLAN-TIME strength ceiling from the level lookahead, in
   * effect units. Kept apart from `strengthThreads` because that field carries
   * the per-pass arrival-money result: folding the two together turned a
   * transient shrink into a permanent one, since the next pass then read its
   * own previous output back as the plan ceiling and could only ratchet down. */
  planStrengthThreads?: number;
  /** Grow only: the largest grow, in effect units, that this batch's committed
   * weaken cover can neutralise.
   *
   * Captured at PLAN time and never re-read from the batch, because by the
   * time the grow launches its W2 has usually already launched and been
   * spliced out of `batch.ops` — W2 lands last but starts first, weaken being
   * the longest operation. Reading the cover live would therefore find nothing
   * and silently disable the clamp exactly when it matters. */
  coverThreads?: number;
  /** Conservative launch deadline. `latestJitStart` derives it from the
   * operation's landing, native duration, and security-boundary timeline. */
  startAt: number;
  /** Launch deadline minus the existing measured dispatch-latency budget. */
  reserveAt?: number;
  landing: number;
  stock: boolean;
  /** Original max-money solve. Dispatch-time money validation may only reduce
   * the already-planned hack, never expand it past its support solve. */
  baseHackThreads?: number;
  /** Physical heap block committed before the worker launch window. Once the
   * action is emitted ownership transfers to `tracked`/workerExit. */
  reservation?: Reservation;
  reservedAt?: number;
  /** A due contiguous allocation already failed. If its window expires, the
   * miss is fragmentation/placement rather than scheduler lateness. */
  placementBlocked?: boolean;
  /** Owning target. Kept directly on the op so reservation accounting never
   * has to recover ownership through a batch-id lookup. */
  target: string;
}

interface PendingJitBatch {
  target: string;
  ops: PendingJitOp[];
  /** Irrevocable once the first operation is emitted. Planning may discard an
   * unstarted batch, but after its leading weaken consumes RAM the remaining
   * grow/hack suffix must be launched so that support is cashed in. */
  started?: boolean;
  /** Identifies THIS batch (decisionId is shared by every batch of a planning
   * decision). A failed exec can then drop the one batch it belonged to
   * instead of the whole pipeline. */
  batchId: number;
  decisionId: number;
  /** Cause counters describe a batch decision, not scheduler attempts. */
  countedMisses?: Partial<Record<MissedWindowReason, true>>;
  /** Monotonic revision used by the target-local deadline heap. Heap entries
   * are immutable snapshots; advancing this batch invalidates the old one. */
  wakeRevision?: number;
  /** Which shape generation planned this batch. During a generational handoff
   * the retiring generation's batches place under THEIR OWN recorded caps, not
   * the incoming shape's. Absent = generation 0. */
  generation?: number;
}

interface BatchWakeEntry {
  at: number;
  revision: number;
  batch: PendingJitBatch;
}

interface TargetWakeQueue {
  heap: BatchWakeEntry[];
}

interface CachedJitRuntime {
  /** Last executable solve for this target. A newly selected, larger solve may
   * not fit the current topology; retaining this one lets the farm downscale
   * instead of abandoning JIT for the padded atomic path. */
  solution: CycleSolution;
  schedule: JitSchedule;
  segmentCapGb: number;
  pooling: boolean;
  reservationMode: JitReservationMode;
  /** RAM of one invocation for each role. Together with the incrementally
   * maintained pending counts this makes a draining pipeline's remaining peak
   * computable in O(roles), independent of queue depth. */
  roleGb: Record<JitRole["role"], number>;
  /** Shape generation this runtime plans under (see PendingJitBatch). */
  generation: number;
}

/** The outgoing shape of a generational handoff (spec/jit-reference.md §6,
 * `phaseOutBatch`): it admits nothing new, its started batches cash in fully
 * under its own caps, and the incoming generation back-fills the RAM it
 * releases. Cleared when nothing of the generation remains. */
interface RetiringJitRuntime {
  solution: CycleSolution;
  schedule: JitSchedule;
  generation: number;
  /** Launched old-generation farm RAM by role, snapshotted at handoff and
   * drained as its completions land. Deliberately an approximation (any
   * completion for the target drains it first): the quota split it feeds is a
   * smoothness device — the heap and the arrival brakes stay the safety. */
  heldGbByRole: Record<JitRole["role"], number>;
}

type JitReservationMode = "protected" | "launch";

/** Prep weaken cover is launched first and owns the landing slot. The atomic
 * grow waits outside RAM until this deadline. */
interface PendingPrepGrow {
  target: string;
  segment: SegmentKind;
  /** The prep wave this grow belongs to. A wave is a batch: its W1 cover and
   * its atomic grow are launched a pass apart but settle as one unit of work,
   * and only the whole wave answers "did this prep land". */
  batchId: number;
  kind: "grow";
  threads: number;
  /** One-core placement ceiling. W2 covers this, so moving an atomic grow off
   * the provisional high-core host cannot leave residual security.
   *
   * This hedges the PENDING case only. Once the grow is placed it is dispatched
   * at its exact strength (`strengthThreads`), so its fortify is known rather
   * than bounded, and the ledger folds `Tracked.strengthThreads` instead. */
  maxThreads: number;
  effectThreads: number;
  startAt: number;
  landing: number;
  stock: boolean;
  placementBlocked?: boolean;
}

export type MissedWindowReason = "deadline" | "arrival-security" | "arrival-money" | "placement";
export type MissedWindowCounts = Record<MissedWindowReason, number>;
export interface LandingErrorStats {
  count: number;
  sumMs: number;
  minMs: number;
  maxMs: number;
  maxAbsMs: number;
}

export interface DispatchStats {
  launched: { hack: number; grow: number; weaken: number };
  landed: { hack: number; grow: number; weaken: number };
  moneyEarned: number;
  /** Estimated from the formulas at completion (see the dispatch loop). */
  expEarned: number;
  hacks: number;
  allocFails: number;
  allocFailsByPhase: { jit: number; prep: number; eager: number };
  batchesSkipped: number;
  /** `batchesSkipped` split by cause, so the scalar can be read as the several
   * distinct phenomena it pools: an arrival-money brake working as designed and
   * a placement failure starving the pipeline are otherwise the same number.
   * Raw counts — the parts sum to the whole. */
  batchesSkippedBy: MissedWindowCounts;
  /** Batches not planned or launched because a safety rail was hit rather than
   * because the economics said no: `processes` is the live-worker ceiling
   * (MAX_LIVE_WORKERS), `passActions` the per-pass emission bound
   * (MAX_LAUNCH_ACTIONS_PER_PASS). Both are clamps, not errors — but a
   * persistently non-zero `processes` means the cadence wants more depth than
   * the browser can hold, which is worth seeing rather than crashing on. */
  capped: { processes: number; passActions: number };
  /** How late past its startAt each JIT op actually launched, by role. The
   * mis-ordered "w1 landed where h was due" rows are exactly launches later
   * than the guard window; this names the delayed role directly. */
  jitLaunchLate: Record<"h" | "w1" | "g" | "w2", { n: number; sumMs: number; maxMs: number; overWindow: number }>;
  /** Launches deferred by a full role quota, by phase:role. */
  jitQuotaSkips: Record<string, number>;
  /** Cumulative safety/window outcomes under the same labels, deduped per batch
   * (or per JIT decision) — it answers "did this batch miss", where
   * `batchesSkippedBy` counts the skips. The two therefore do not have to
   * agree, and one exceeding the other is not a bug. */
  missedWindow: MissedWindowCounts;
  /** Ops that needed a fresh process (one-shots + pool spawns). The pooling
   * win is this staying flat while `launched` keeps climbing. */
  execs: number;
  /** Ops launched carrying a `{stock:true}` influence flag. The only visible
   * link between "manipulation intended" and "nudges actually rolled" — a
   * manipulation run where this stays 0 has an open influence loop. */
  stockOps: number;
  /** Completions from ops this dispatcher never launched — workers that
   * outlived an install or a reload. Kept out of `landed` so that counter
   * stays comparable with `launched`, and reported rather than dropped
   * because a run with a large number here is still paying for those
   * processes' RAM without controlling them. */
  orphanLandings: number;
  /** Distribution of the additionalMsec each launched op actually carried.
   * Padding is RAM held while doing no native work, so the tuning target is
   * the SMALLEST launch guard that still keeps missedWindow at zero: watch
   * `maxMs` approach the guard while `deadline` stays 0, and shrink the guard
   * until misses appear. Counted per op, so `sumMs / count` is the mean. */
  padding: { count: number; sumMs: number; maxMs: number };
  /** Distribution of OBSERVED minus PLANNED landing time, in ms, over ops this
   * dispatcher launched. Signed: negative is early, positive is late.
   *
   * This is the instrument the landing grid was previously missing. Two timing
   * tightenings are documented in this file as measured-better but disabled
   * (pricing durations at minimum security, and deferring admission to the live
   * deadline); both trade padding against missed windows, and neither can be
   * judged in the live game without knowing how far landings actually slip.
   * `sumMs / count` is the mean; `maxAbsMs` is the tail that matters, since a
   * single landing more than one gap late is a reordering. */
  landingError: LandingErrorStats;
  /** The same distribution split by op kind, which is the granularity a
   * correction would have to act at: a late HACK reorders a batch against its
   * own cover, while a late weaken only over-covers. The aggregate cannot
   * distinguish "one role is systematically late" from "everything jitters",
   * and those call for opposite responses. The simulator lands ops exactly on
   * plan (mean -6e-12 ms), so this is readable only from a live run. */
  landingErrorByKind: { hack: LandingErrorStats; grow: LandingErrorStats; weaken: LandingErrorStats };
  /** GB·ms scheduled inside native hack/grow/weaken durations. */
  nativeRamMs: number;
  /** GB·ms held only by additionalMsec. This is scheduler waste, not work. */
  paddingRamMs: number;
  nativeRamMsByKind: { hack: number; grow: number; weaken: number };
  paddingRamMsByKind: { hack: number; grow: number; weaken: number };
  nativeRamMsBySegment: Record<SegmentKind, number>;
  paddingRamMsBySegment: Record<SegmentKind, number>;
  /** The cross product of the two breakdowns above. Neither one alone can
   * answer "how is the FARM's RAM split across hack/grow/weaken": the by-kind
   * totals fold a prep wave's grows in with the farm's, and a prep wave is
   * exactly when the split is least representative. */
  nativeRamMsBySegmentKind: Record<SegmentKind, ByKind>;
  paddingRamMsBySegmentKind: Record<SegmentKind, ByKind>;
  /** Threads launched, per segment and kind. The RAM figures above are the
   * right denominator for capacity questions, but the thread counts are what
   * the cycle solve actually chose, and cores move the two apart: a
   * high-core host needs fewer grow/weaken THREADS for the same effect while
   * occupying proportionally the same RAM per thread. */
  threadsBySegmentKind: Record<SegmentKind, ByKind>;
  /** One-core-equivalent effect the same launches actually bought. Divided by
   * `threadsBySegmentKind` this is the REALIZED core multiplier per kind —
   * the measured answer to "what are the cores doing for the farm", which no
   * static core count can give: it depends on which hosts the placer chose.
   * Hack is unaffected by cores, so its ratio stays at 1 and is the control. */
  effectThreadsBySegmentKind: Record<SegmentKind, ByKind>;
  /** Planned/observed intra-batch landing-order pairs, counted by signature.
   *
   * Per-op telemetry is impossible here — landings run at ~1 per 20 ms at
   * scale — but the QUESTION per-op telemetry would answer is small: did this
   * batch's effects land in the order the cycle planned? That collapses to a
   * counter per distinct pair, so batches planned under different cycle shapes
   * cannot be misgraded against whichever plan happened to run most recently. */
  landingOrders: Map<string, { planned: string; observed: string; batches: number }>;
  /** COMPLETE batches whose landing order was verified (the denominator). */
  landingOrderBatches: number;
  /** Batches that landed having never launched a hack.
   *
   * Counted apart from the order histogram rather than folded into it, because
   * it is a different failure: not "the effects arrived in the wrong order" but
   * "support was paid for and nothing was stolen". A dropped batch suffix
   * (see the failed-exec handling) produces exactly this, and averaging it in
   * with the reorders would hide the more expensive of the two. */
  landingOrderIncomplete: number;
  /** Bounded ring of the most recent MIS-ordered batches. Anomalies are rare
   * by construction — that is what makes keeping examples affordable, and a
   * count alone does not say which two effects swapped. */
  landingOrderAnomalies: { at: number; observed: string; planned: string; target: string }[];
  /** Per-batch work, summed by batch kind. This is the counter set the viewer
   * shows: a farm cycle and a prep wave are different units of work, and
   * adding their ops together produces a number that describes neither. */
  batchesByKind: Record<BatchKind, BatchAggregate>;
  /** The most recently settled batches, newest last. Bounded. */
  recentBatches: SettledBatch[];
}

export type ByKind = { hack: number; grow: number; weaken: number };

/** What a batch IS.
 *
 * The unit the farm actually reasons in. A per-op counter cannot answer "is a
 * batch cheap", "does a prep wave land whole" or "how much did one cycle
 * earn", because those are properties of the group, not of an op; and per-op
 * telemetry is impossible here anyway (landings run at ~1 per 20 ms). Naming
 * the group is what makes the aggregate meaningful. */
export type BatchKind = "hwgw" | "hgw" | "shotgun" | "prep";

export const BATCH_KINDS: readonly BatchKind[] = ["hwgw", "hgw", "shotgun", "prep"];

/** A batch still collecting its landings. */
interface OpenBatch {
  id: number;
  kind: BatchKind;
  target: string;
  segment: SegmentKind;
  startedAt: number;
  /** Roles in the order they were LAUNCHED; sorted by landing rank to form
   * the intended order. Empty for a batch with no landing grid. */
  planned: JitRole["role"][];
  observed: JitRole["role"][];
  ops: number;
  landed: number;
  threads: ByKind;
  gb: number;
  moneyEarned: number;
  hacks: number;
}

/** Everything one settled batch contributed, summed per kind. Cumulative, so
 * the viewer differentiates for a rate the same way it does the op counters. */
export interface BatchAggregate {
  batches: number;
  ops: number;
  landed: number;
  threads: ByKind;
  gb: number;
  moneyEarned: number;
  hacks: number;
  /** Summed start-to-settle spans, for a mean batch duration. */
  spanMs: number;
  /** Batches that HAD a landing grid, and so could be graded on order at
   * all. The denominator `inOrder` is a fraction of; without it a kind that
   * mis-ordered every single batch is indistinguishable from a kind that never
   * lands on a grid, and that is exactly the failure worth seeing. */
  graded: number;
  /** Batches whose effects landed in the planned order. */
  inOrder: number;
  /** Batches that settled having never launched a hack. */
  noHack: number;
  /** Batches EVICTED without ever settling, and the work they took with them.
   *
   * This is where op loss actually lives. A batch only settles once its last
   * op arrives (`noteBatchLanding` returns early below `ops`), so a settled
   * batch has `landed === ops` by construction and a "settled with fewer
   * landings" counter can never fire. A batch that loses an op instead never
   * settles at all and is evicted by `openBatch`, which used to drop it
   * silently — so the one failure mode these counters exist to expose was the
   * one they structurally could not.
   *
   * `abandonedOps - abandonedLanded` is the ops that were paid for and never
   * arrived. */
  abandoned: number;
  abandonedOps: number;
  abandonedLanded: number;
}

/** One settled batch, retained for display. Deliberately small and bounded:
 * an aggregate says the farm is healthy, an example says which batch was not. */
export interface SettledBatch {
  id: number;
  kind: BatchKind;
  target: string;
  at: number;
  spanMs: number;
  ops: number;
  landed: number;
  threads: ByKind;
  gb: number;
  moneyEarned: number;
  order?: string;
  planned?: string;
}

/** Intended landing order of the JIT roles, which is the order `cycleJitRoles`
 * emits them in (shared/strategy/jit.ts): hack steals first, its cover weaken
 * lands next, grow restores the money, and W2 removes grow's security. Launch
 * order is the reverse-ish (longest op first, JIT_ROLE_PRIORITY); only the
 * LANDING order is the batch's correctness condition. */
const LANDING_RANK: Record<JitRole["role"], number> = { h: 0, w1: 1, g: 2, w2: 3 };

/** Mis-ordered batches retained for inspection. */
const LANDING_ANOMALY_RING = 12;
/** Batches whose landings are being accumulated. Bounded because an op that
 * never lands (a failed exec whose batch was dropped) would otherwise leave
 * its entry behind forever. */
const LANDING_TRACK_LIMIT = 512;
/** Settled batches retained as examples, newest last.
 *
 * Read once a second by the rollup, so this is also the SAMPLE RATE of the
 * viewer's per-batch history: a farm settling faster than this overflows the
 * ring between reads. At eight it caught 96 of ~965 batches on a measured run,
 * which is enough to name one bad batch and far too few to reason about the
 * distribution of them. Sixty-four keeps the payload a digest — one rollup
 * carries at most this many small flat records, once a second — while making
 * per-batch health answerable. The true count travels alongside it (the
 * per-kind `batches` sums), so the viewer states its sampling rate rather than
 * implying the sample is the population. */
const RECENT_BATCH_RING = 64;

function emptyByKind(): ByKind {
  return { hack: 0, grow: 0, weaken: 0 };
}

function emptyBySegmentKind(): Record<SegmentKind, ByKind> {
  return { farm: emptyByKind(), prep: emptyByKind(), charge: emptyByKind(), share: emptyByKind() };
}

function emptyBatchAggregate(): BatchAggregate {
  return {
    batches: 0,
    ops: 0,
    landed: 0,
    threads: emptyByKind(),
    gb: 0,
    moneyEarned: 0,
    hacks: 0,
    spanMs: 0,
    graded: 0,
    inOrder: 0,
    noHack: 0,
    abandoned: 0,
    abandonedOps: 0,
    abandonedLanded: 0,
  };
}

export interface ShareWorker {
  workerId: number;
  hostname: string;
  threads: number;
  gb: number;
  effectiveThreads: number;
  stopping: boolean;
  /** When the stop was (last) sent. A stop can race the worker's boot and land
   * before its mailbox exists; ageing the request lets the dispatcher re-send
   * instead of treating `stopping` as settled forever. */
  stopRequestedAt?: number;
}

export interface ChargeWorker {
  opId: number;
  hostname: string;
  threads: number;
  gb: number;
}

export interface DispatchMemory {
  heap: Heap;
  evaluator: EvaluatorMemory;
  tracked: Map<number, Tracked>;
  /** Derived indices over `tracked`, maintained by `trackOp`/`untrackOp` —
   * which are the ONLY writers of `tracked`, and every `Tracked` field is fixed
   * for the entry's life, so an index can never silently go stale.
   *
   * They exist because a dispatcher pass used to walk the whole ledger eight
   * times, and the ledger is one entry per in-flight op: 32k observed live,
   * ~400k targeted. That made a pass O(ops), and with the per-batch `ledger()`
   * closure O(batches x ops), which is what pegged a core and starved the game
   * engine's timers for 63 s at a stretch. `tests/dispatch-index.test.ts` holds
   * each index against a full recompute after every mutation. */
  byTarget: Map<string, Map<number, Tracked>>;
  /** Per-target landing queue, kept in landing/op-id order. Unlike byTarget,
   * this is scheduler order and removes the full-ledger sort from every wake. */
  landingByTarget: Map<string, LandingQueue>;

  /** SOURCE host -> GB held by non-pooled tracked ops. A pooled op's RAM
   * belongs to its worker, which the pool ledger counts instead. */
  ourGbByHost: Map<string, number>;
  /** `weakenGroupKey` -> unsettled fragments of that logical weaken landing. */
  weakenPending: Map<string, number>;
  /** JIT role -> GB held by non-pooled farm ops carrying that role. */
  heldGbByRole: Record<JitRole["role"], number>;
  inFlight: { hack: number; grow: number; weaken: number };
  segmentGb: Record<SegmentKind, number>;
  /** Long-lived, cooperatively stoppable fragment consumers. */
  shareWorkers: Map<number, ShareWorker>;
  /** Non-cancellable one-shot Stanek calls. */
  chargeWorkers: Map<number, ChargeWorker>;
  /** host -> op count in flight, so prep fires in non-overlapping waves. */
  prepInFlight: Map<string, number>;
  /** Logical distributed weaken landings which have lost at least one
   * fragment. Retained across pumps until the final fragment settles, so a
   * later successful fragment cannot turn a partial weaken into a false
   * min-security observation. */
  failedWeakenGroups: Set<string>;
  nextOpId: number;
  /** Monotonic id issued by `openBatch` for every batch it registers. */
  nextBatchId: number;
  nextServerIndex: number;
  lastAnchor: number;
  /** Consecutive hacks zeroed by the arrival-money validation. Support ops
   * keep landing while every hack is spliced out, and later grows are sized
   * from the same depressed predicted ledger, so one lost grow can otherwise
   * become a permanent zero-hack steady state. A short streak proves the
   * ledger no longer matches reality; the pipeline is then rebuilt from the
   * OBSERVED server state (prep path included). */
  hackZeroStreak: number;
  /** Target/mode pipeline decision whose repeated scheduler retries must not
   * inflate cumulative missed-window counters. */
  jitDecisionId: number;
  countedJitDecisionMisses: Set<string>;
  /** Last observed pure clock, used when a driver reports an exec failure
   * immediately after a planning pass. */
  lastDispatchAt: number;
  /** Long-lived target pipelines. This is the sole pending-batch source of
   * truth: targets never share a scheduling queue. */
  jitByTarget: Map<string, PendingJitBatch[]>;
  pendingJitBatchCount: number;
  pendingJitOpCount: number;
  /** Unstarted batch count by target. Downscale checks this before touching a
   * queue, so a fully committed 100k-deep pipeline remains O(1) per heartbeat. */
  unstartedJitBatchCountByTarget: Map<string, number>;
  /** Target/role counts for unlaunched JIT work. This is the compact forecast
   * index used when farm capacity is transferred to prep: no heartbeat may
   * walk a 100k-deep queue merely to learn its remaining envelope. */
  pendingJitRoleCountByTarget: Map<string, Record<JitRole["role"], number>>;
  /** Target-owned scheduler queues. They contain batch cursors, never jobs
   * from another server, and are read from the head on a completion wake. */
  jitWakeByTarget: Map<string, TargetWakeQueue>;
  /** Heartbeat-derived launch policy consumed by the target wake hot path. */
  jitRuntimeByTarget: Map<string, CachedJitRuntime>;
  /** Outgoing shape generation per target during a handoff (at most one). */
  retiringJitByTarget: Map<string, RetiringJitRuntime>;
  /** Current shape generation per target; bumped by each handoff. */
  jitGenerationByTarget: Map<string, number>;
  /** Pending one-shot reservations maintained incrementally per target/role. */
  pendingReservedGbByTarget: Map<string, Record<JitRole["role"], number>>;
  /** Targets intentionally draining at the batch boundary after a live safety
   * reduction. They admit no leading weakens until every started suffix lands. */
  drainingJitTargets: Set<string>;
  /** Last directive after fleet adaptation; target wakes never recompute it. */
  activeDirective?: TargetDirective;

  /** Batches still collecting their landings, keyed by batch id. An entry is
   * created when the batch's first op launches and settled when its last one
   * lands; see `stats.batchesByKind`. */
  batches: Map<number, OpenBatch>;
  /** Atomic prep grows waiting for their invocation windows. Their covering
   * W2 calls are already resident, so W2 always starts before G. */
  prepPending: PendingPrepGrow[];
  /** Farm scheduling mode (shared/strategy/mode.ts) with its flap guard. */
  mode: FarmMode;
  modeSince: number;
  /** Lazily-solved HGW solution for the CURRENT farm target — target
   * selection stays on the HWGW score (the orderings track); only the chosen
   * target pays for a second solve, re-done per context generation. */
  hgw?: { host: string; generation: number; solution?: CycleSolution };
  /** Pooled serve workers (shared/strategy/worker-pool.ts). */
  pool: WorkerPoolMemory;
  /** Existing pressure decision, published for arena promotion. */
  pooling: boolean;
  /** The current farm target's pipeline demand ceiling in GB — one batch per
   * interval for one weakenTime (shared/strategy/economics.ts depthCapGb).
   * RAM beyond it earns nothing on THIS target; infrastructure valuation
   * reads it so a purchase past saturation prices at its true marginal
   * income (~0) instead of the linear per-GB rate (measured: a $450m 16 TB
   * server bought half-idle on bn1-speedrun). Cleared when the farm stops or
   * retargets — a dead target's ceiling must not price live purchases. */
  depthCapGb?: number;
  /** Which host depthCapGb was computed for, so a retarget invalidates it. */
  depthCapHost?: string;
  /** The farm's STABLE parallel footprint on the current target: the executable
   * JIT role envelope (`chooseJitSchedule().totalGb`), i.e. one reusable slot
   * per role at the cadence this fleet can actually sustain. Unlike
   * `depthCapGb` (the minimum-interval saturation figure used to price future
   * infrastructure) this is what the pipeline will really be holding a moment
   * from now, so it is the correct amount to withhold from freely-preemptible
   * tenants. Cleared with the farm/target, like depthCapGb. */
  farmEnvelopeGb?: number;
  /** What the farm can launch in one dispatch pass on the current target: the
   * amount a freely-preemptible tenant must stay clear of. Sizing it is a
   * measured tradeoff, since free RAM is not idle RAM — a growing pipeline
   * claims it next pass and farm income compounds into fleet size. On the
   * share-churn lane: whole envelope 0.007 idle / $1.89e7/s, one pass (this)
   * 0.058 / $2.65e7/s, one batch 0.049 / $1.45e7/s. */
  farmPassDemandGb?: number;
  /** `stats.allocFails` as of the last FULL pass's share-eviction gate. The
   * gate compares against this rather than a same-pass snapshot so allocation
   * failures on target-wake hot passes (which return before the gate) still
   * register as real contention on the next heartbeat. */
  allocFailsHandled: number;
  stats: DispatchStats;
}

export interface DispatchOptions {
  /** Why this pass is running. A target wake is deliberately narrower than a
   * heartbeat: it absorbs that target's completions and may advance only that
   * target's already-selected pipeline. In particular, a weaken landing on a
   * prep target can never launch farm work for another server. */
  trigger?:
    | { kind: "tick" }
    | { kind: "target-wake"; target: string; source: "completion" | "deadline" };
  /** Per-host executable dodge arena withheld from farm allocation. */
  arenaReserves?: Readonly<Record<string, number>>;
  /** Money still needed for the active goal — sets the switch horizon. */
  goalRemaining?: number;
  /** Expected remaining run time in ms (the endgame route's estimate). Caps
   *  the evaluator's amortization horizon alongside the goal. */
  horizonMs?: number;
  /** Best observed marginal income/sec per invested dollar. */
  reinvestmentReturnPerDollarSec?: number;
  /** Route-owned hacking skill gate. The evaluator prices XP as direct
   * completion progress until this level is reached. */
  hackingSkillGoal?: number;
  /** Emit buyServer/upgradeHomeRam actions. In the live game the shared
   *  investment arbiter owns home/cloud/Hacknet spending, so the driver leaves
   *  this off; the sim's farm mode runs no feature drivers or arbiter, so the
   *  dispatcher is its only owner and must keep emitting them. */
  buyInfrastructure?: boolean;
  /** Force a farm mode (the sim's A/B lever and an emergency valve); omits
   *  the decideMode policy entirely. */
  modeOverride?: FarmMode;
  /** Route farm batch ops through pooled serve workers (game driver). The
   *  sim's planner path leaves it off — its world executes ops directly and
   *  landings are identical either way; what pooling changes is exec churn,
   *  which only the game (and the sim's synthetic-ns path) exhibits. */
  pooling?: boolean;
  /** A/B valve for staged steady-state launches. Defaults on. */
  jit?: boolean;
  /** Sources on which the worker bundle is known to exist. The live driver
   * passes its deployment ledger; the planner simulator omits this because
   * its actions execute directly. A newly bought/rooted host is not usable RAM
   * until deployment completes. */
  sourceHosts?: ReadonlySet<string>;
  /** Existing forecast/ETA currency for marginal farm-vs-share sizing. */
  shareValue?: SharePricingInput;
  chargeValue?: ChargePricingInput;
}

export function initDispatch(): DispatchMemory {
  return {
    heap: new Heap(),
    evaluator: initEvaluator(),
    tracked: new Map(),
    landingByTarget: new Map(),
    byTarget: new Map(),
    ourGbByHost: new Map(),
    weakenPending: new Map(),
    heldGbByRole: { h: 0, w1: 0, g: 0, w2: 0 },
    inFlight: { hack: 0, grow: 0, weaken: 0 },
    segmentGb: { farm: 0, prep: 0, charge: 0, share: 0 },
    shareWorkers: new Map(),
    chargeWorkers: new Map(),
    prepInFlight: new Map(),
    failedWeakenGroups: new Set(),
    nextOpId: 1,
    nextBatchId: 1,
    nextServerIndex: 0,
    allocFailsHandled: 0,
    lastAnchor: -Infinity,
    hackZeroStreak: 0,
    jitDecisionId: 0,
    countedJitDecisionMisses: new Set(),
    lastDispatchAt: 0,
    jitByTarget: new Map(),
    pendingJitBatchCount: 0,
    pendingJitOpCount: 0,
    unstartedJitBatchCountByTarget: new Map(),
    pendingJitRoleCountByTarget: new Map(),
    jitWakeByTarget: new Map(),
    jitRuntimeByTarget: new Map(),
    retiringJitByTarget: new Map(),
    jitGenerationByTarget: new Map(),
    pendingReservedGbByTarget: new Map(),
    drainingJitTargets: new Set(),
    batches: new Map(),
    prepPending: [],
    mode: "hwgw",
    modeSince: -Infinity,
    pool: initPool(),
    pooling: false,
    stats: {
      launched: { hack: 0, grow: 0, weaken: 0 },
      landed: { hack: 0, grow: 0, weaken: 0 },
      moneyEarned: 0,
      expEarned: 0,
      hacks: 0,
      allocFails: 0,
      allocFailsByPhase: { jit: 0, prep: 0, eager: 0 },
      batchesSkipped: 0,
      batchesSkippedBy: { deadline: 0, "arrival-security": 0, "arrival-money": 0, placement: 0 },
      capped: { processes: 0, passActions: 0 },
      jitLaunchLate: {
        h: { n: 0, sumMs: 0, maxMs: 0, overWindow: 0 },
        w1: { n: 0, sumMs: 0, maxMs: 0, overWindow: 0 },
        g: { n: 0, sumMs: 0, maxMs: 0, overWindow: 0 },
        w2: { n: 0, sumMs: 0, maxMs: 0, overWindow: 0 },
      },
      jitQuotaSkips: {},
      missedWindow: { deadline: 0, "arrival-security": 0, "arrival-money": 0, placement: 0 },
      execs: 0,
      stockOps: 0,
      orphanLandings: 0,
      padding: { count: 0, sumMs: 0, maxMs: 0 },
      landingError: { count: 0, sumMs: 0, minMs: 0, maxMs: 0, maxAbsMs: 0 },
      landingErrorByKind: {
        hack: { count: 0, sumMs: 0, minMs: 0, maxMs: 0, maxAbsMs: 0 },
        grow: { count: 0, sumMs: 0, minMs: 0, maxMs: 0, maxAbsMs: 0 },
        weaken: { count: 0, sumMs: 0, minMs: 0, maxMs: 0, maxAbsMs: 0 },
      },
      nativeRamMs: 0,
      paddingRamMs: 0,
      nativeRamMsByKind: { hack: 0, grow: 0, weaken: 0 },
      paddingRamMsByKind: { hack: 0, grow: 0, weaken: 0 },
      nativeRamMsBySegment: { farm: 0, prep: 0, charge: 0, share: 0 },
      paddingRamMsBySegment: { farm: 0, prep: 0, charge: 0, share: 0 },
      nativeRamMsBySegmentKind: emptyBySegmentKind(),
      paddingRamMsBySegmentKind: emptyBySegmentKind(),
      threadsBySegmentKind: emptyBySegmentKind(),
      effectThreadsBySegmentKind: emptyBySegmentKind(),
      landingOrders: new Map(),
      landingOrderBatches: 0,
      landingOrderIncomplete: 0,
      landingOrderAnomalies: [],
      batchesByKind: {
        hwgw: emptyBatchAggregate(),
        hgw: emptyBatchAggregate(),
        shotgun: emptyBatchAggregate(),
        prep: emptyBatchAggregate(),
      },
      recentBatches: [],
    },
  };
}

/** Bounded prefix of the per-host free list handed to the solver; beyond it
 * the slot count is saturated anyway. */
const HOST_BLOCKS_LIMIT = 64;

function syncTopology(
  memory: DispatchMemory,
  view: WorldView,
  arenaReserves: Readonly<Record<string, number>> = {},
  sourceHosts?: ReadonlySet<string>,
): FleetCapacity {
  // Our own in-flight ops are transient — their RAM frees within one batch
  // cycle, so they must NOT shrink what the solver may plan with. Foreign
  // usage (the controller's own footprint, anything else running) is standing
  // and must: sizing a hack block to `maxRam − reserved` on a home that also
  // hosts the controller produced blocks that could NEVER be placed, which is
  // how a 32 GB home stalled the dispatcher outright.
  const ours = new Map<string, number>(memory.ourGbByHost);
  for (const [hostname, gb] of memory.pool.gbByHost) {
    ours.set(hostname, (ours.get(hostname) ?? 0) + gb);
  }
  for (const worker of memory.shareWorkers.values()) {
    ours.set(worker.hostname, (ours.get(worker.hostname) ?? 0) + worker.gb);
  }
  for (const worker of memory.chargeWorkers.values()) {
    ours.set(worker.hostname, (ours.get(worker.hostname) ?? 0) + worker.gb);
  }
  for (const batch of allJitBatches(memory)) {
    for (const op of batch.ops) {
      for (const block of op.reservation?.blocks ?? []) {
        const gb = block.threads * WORKER_RAM[op.kind];
        ours.set(block.hostname, (ours.get(block.hostname) ?? 0) + gb);
      }
    }
  }
  let fleetGb = 0;
  let largestBlockGb = 0;
  const hostBlocksGb: number[] = [];
  const freeNowBlocksGb: number[] = [];
  const chargeBlocks: NonNullable<FleetCapacity["chargeBlocks"]> = [];
  let effectiveShareThreads = 0;
  let allocatableShareGb = 0;
  for (const server of view.servers) {
    if (!server.hasAdminRights || server.maxRam < 2) continue;
    if (sourceHosts && !sourceHosts.has(server.hostname)) {
      // Keep an existing heap host quarantined too. Merely skipping the fresh
      // capacity sum leaves its old bucket allocatable after a cloud upgrade
      // replaced the machine (and therefore erased its scripts).
      const existing = memory.heap.host(server.hostname);
      memory.heap.upsert(
        server.hostname,
        server.maxRam,
        existing?.used ?? server.usedRam,
        server.cpuCores,
        server.maxRam,
      );
      continue;
    }
    const reserved = Math.min(server.maxRam, Math.max(0, arenaReserves[server.hostname] ?? 0));
    const existing = memory.heap.host(server.hostname);
    // The heap owns `used` (reservation ledger); topology comes from the view.
    memory.heap.upsert(
      server.hostname,
      server.maxRam,
      existing?.used ?? server.usedRam,
      server.cpuCores,
      reserved,
    );
    const ledgerUsed = memory.heap.host(server.hostname)?.used ?? 0;
    const externalUsed = Math.max(0, ledgerUsed - (ours.get(server.hostname) ?? 0));
    const placeable = Math.max(0, server.maxRam - reserved - externalUsed);
    // Capacity is what the farm can actually place after standing foreign
    // usage (notably start.js), while our transient workers remain reusable.
    // Counting max-reserved here fabricated the controller's 3.6 GB as farm
    // capacity once the old home reserve disappeared.
    fleetGb += placeable;
    if (placeable > largestBlockGb) largestBlockGb = placeable;
    if (placeable >= WORKER_RAM.hack) hostBlocksGb.push(placeable);
    if (placeable >= WORKER_RAM.charge) chargeBlocks.push({ hostname: server.hostname, gb: placeable, cores: server.cpuCores });
    const shareThreads = Math.floor(placeable / WORKER_RAM.share);
    effectiveShareThreads += shareThreads * intelligenceBonus(view.player.intelligence, 2) * coreEffect(server.cpuCores);
    allocatableShareGb += shareThreads * WORKER_RAM.share;
    const freeNow = memory.heap.freeOn(server.hostname);
    if (freeNow >= WORKER_RAM.grow) freeNowBlocksGb.push(freeNow);
  }
  hostBlocksGb.sort((a, b) => b - a);
  freeNowBlocksGb.sort((a, b) => b - a);
  const prepWaveGb = hostBlocksGb
    .slice(0, MAX_PREP_OPS_PER_PASS)
    .reduce((sum, blockGb) => sum + Math.floor(blockGb / WORKER_RAM.grow) * WORKER_RAM.grow, 0);
  const prepFreeGb = freeNowBlocksGb
    .slice(0, MAX_PREP_OPS_PER_PASS)
    .reduce((sum, blockGb) => sum + Math.floor(blockGb / WORKER_RAM.grow) * WORKER_RAM.grow, 0);
  const previousPrepHost = memory.evaluator.directive.prep?.host;
  const prepWaveInFlight = previousPrepHost !== undefined && (memory.prepInFlight.get(previousPrepHost) ?? 0) > 0;
  if (hostBlocksGb.length > HOST_BLOCKS_LIMIT) hostBlocksGb.length = HOST_BLOCKS_LIMIT;
  const effectiveShareThreadsPerGb = allocatableShareGb > 0 ? effectiveShareThreads / allocatableShareGb : 0;
  return { fleetGb, largestBlockGb, hostBlocksGb, chargeBlocks, prepWaveGb, prepFreeGb, prepWaveInFlight, effectiveShareThreadsPerGb };
}

/** The last landing still expected on a target, or -Infinity when nothing is in
 * flight there.
 *
 * Walks the target's ledger rather than maintaining an index, because it is
 * read on exactly one kind of pass: the one that re-anchors a pipeline after
 * `lastAnchor` was reset. An index would have to survive `untrackOp` removing
 * the current maximum, which costs a rescan on every completion — the hot path
 * — to save a walk on a rare one. */
function lastLandingOn(memory: DispatchMemory, target: string): number {
  let latest = -Infinity;
  const onTarget = memory.byTarget.get(target);
  if (!onTarget) return latest;
  for (const tracked of onTarget.values()) {
    if (tracked.landing !== undefined && tracked.landing > latest) latest = tracked.landing;
  }
  return latest;
}

/** The logical weaken landing a fragment belongs to. A spread weaken lands as
 * several calls at one instant and only its last fragment proves min security,
 * so the group — not the op — is the unit that settles. */
function weakenGroupKey(target: string, landing: number): string {
  return `${target}\u0000${landing}`;
}

/** Register an in-flight op, and every index derived from it.
 *
 * With `untrackOp` this is the ONLY writer of `memory.tracked`. Keeping that
 * true is what lets the indices be trusted: a `Tracked` is immutable once
 * registered, so no index can drift except through these two functions.
 * Exported so tests seed the ledger through the same door rather than
 * writing `tracked` directly and leaving every index empty behind them. */
interface LandingQueue {
  chunks: LedgerEntry[][];
  size: number;
}

const LANDING_CHUNK_MAX = 256;

function flattenLandingQueue(queue: LandingQueue | undefined): LedgerEntry[] {
  if (!queue) return [];
  const entries: LedgerEntry[] = [];
  for (const chunk of queue.chunks) entries.push(...chunk);
  return entries;
}

function insertTrackedLanding(memory: DispatchMemory, opId: number, tracked: Tracked): void {
  if (tracked.landing === undefined) return;
  const threads = trackedStrength(tracked);
  const entry: LedgerEntry = {
    op: {
      kind: tracked.kind,
      threads,
      effectThreads: tracked.effectThreads ?? threads,
      landing: tracked.landing,
      opId,
    },
  };
  let queue = memory.landingByTarget.get(tracked.target);
  if (!queue) {
    queue = { chunks: [[]], size: 0 };
    memory.landingByTarget.set(tracked.target, queue);
  }
  let chunkAt = 0;
  let chunkHi = queue.chunks.length;
  while (chunkAt < chunkHi) {
    const mid = (chunkAt + chunkHi) >>> 1;
    const last = queue.chunks[mid]!.at(-1);
    if (last && compareLedgerOps(last.op, entry.op) < 0) chunkAt = mid + 1;
    else chunkHi = mid;
  }
  if (chunkAt === queue.chunks.length) chunkAt--;
  const chunk = queue.chunks[Math.max(0, chunkAt)]!;
  let lo = 0;
  let hi = chunk.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (compareLedgerOps(chunk[mid]!.op, entry.op) <= 0) lo = mid + 1;
    else hi = mid;
  }
  chunk.splice(lo, 0, entry);
  queue.size++;
  if (chunk.length > LANDING_CHUNK_MAX) {
    queue.chunks.splice(Math.max(0, chunkAt) + 1, 0, chunk.splice(chunk.length >>> 1));
  }
}

function removeTrackedLanding(memory: DispatchMemory, opId: number, tracked: Tracked): void {
  if (tracked.landing === undefined) return;
  const queue = memory.landingByTarget.get(tracked.target);
  if (!queue) return;
  for (let chunkAt = 0; chunkAt < queue.chunks.length; chunkAt++) {
    const chunk = queue.chunks[chunkAt]!;
    if ((chunk.at(-1)?.op.landing ?? -Infinity) < tracked.landing) continue;
    if ((chunk[0]?.op.landing ?? Infinity) > tracked.landing) break;
    const at = chunk.findIndex((entry) => entry.op.opId === opId);
    if (at < 0) continue;
    chunk.splice(at, 1);
    queue.size--;
    if (chunk.length === 0 && queue.chunks.length > 1) queue.chunks.splice(chunkAt, 1);
    break;
  }
  if (queue.size === 0) memory.landingByTarget.delete(tracked.target);
}
export function trackOp(memory: DispatchMemory, opId: number, tracked: Tracked): void {
  memory.tracked.set(opId, tracked);
  let onTarget = memory.byTarget.get(tracked.target);
  if (!onTarget) {
    onTarget = new Map();
    memory.byTarget.set(tracked.target, onTarget);
  }
  // Per-target insertion order matches global insertion order, which the
  // ledger folds depend on: opId order decides which of two same-instant ops
  // folds first, and that is observable.
  onTarget.set(opId, tracked);
  insertTrackedLanding(memory, opId, tracked);
  if (tracked.workerId === undefined) {
    addGb(memory.ourGbByHost, tracked.hostname, tracked.gb);
    if (tracked.segment === "farm" && tracked.jitRole) {
      memory.heldGbByRole[tracked.jitRole] += tracked.gb;
      // Symmetric with untrackOp's drain: a retiring-generation suffix op that
      // launches AFTER the handoff must credit the retiring ledger, or its
      // completion later drains GB that were never added — the ledger sinks
      // past zero, the handoff clears while old RAM is still resident, and
      // the retiring quota gate never tightens within a pass.
      const retiring = memory.retiringJitByTarget.get(tracked.target);
      if (retiring && (tracked.jitGeneration ?? 0) === retiring.generation) {
        retiring.heldGbByRole[tracked.jitRole] += tracked.gb;
      }
    }
  }
  if (tracked.kind === "weaken" && tracked.landing !== undefined) {
    bump(memory.weakenPending, weakenGroupKey(tracked.target, tracked.landing), 1);
  }
}

/** Drop an op from `tracked` and unwind its indices. */
function untrackOp(memory: DispatchMemory, opId: number, tracked: Tracked): void {
  memory.tracked.delete(opId);
  const onTarget = memory.byTarget.get(tracked.target);
  if (onTarget) {
    onTarget.delete(opId);
    removeTrackedLanding(memory, opId, tracked);
    if (onTarget.size === 0) memory.byTarget.delete(tracked.target);
  }
  if (tracked.workerId === undefined) {
    subGb(memory.ourGbByHost, tracked.hostname, tracked.gb);
    if (tracked.segment === "farm" && tracked.jitRole) {
      memory.heldGbByRole[tracked.jitRole] = drainGb(memory.heldGbByRole[tracked.jitRole], tracked.gb);
      // Exact generational attribution: only the retiring generation's own
      // completions drain its ledger. The earlier retiring-first heuristic
      // zeroed the counter early and then billed leftover old-generation RAM
      // to the ACTIVE quota — measured on the speed-step lane as 143k grow
      // and 26k hack launch-skips with hacks landing seconds late.
      const retiring = memory.retiringJitByTarget.get(tracked.target);
      if (retiring && (tracked.jitGeneration ?? 0) === retiring.generation) {
        retiring.heldGbByRole[tracked.jitRole] =
          drainGb(retiring.heldGbByRole[tracked.jitRole], tracked.gb);
      }
    }
  }
  if (tracked.kind === "weaken" && tracked.landing !== undefined) {
    bump(memory.weakenPending, weakenGroupKey(tracked.target, tracked.landing), -1);
  }
}

function release(memory: DispatchMemory, opId: number): void {
  const tracked = memory.tracked.get(opId);
  if (!tracked) return;
  // A pooled op's RAM belongs to its WORKER for the process's whole life —
  // the heap and segment ledgers move on the worker's `workerExit`, never on
  // a job completion.
  if (tracked.workerId === undefined) {
    memory.heap.free(tracked.hostname, tracked.gb);
    memory.segmentGb[tracked.segment] -= tracked.gb;
  }
  untrackOp(memory, opId, tracked);
  memory.inFlight[tracked.kind]--;
  // prepInFlight is symmetric with the launch-time increment: exactly the ops
  // launchPrepWave marked `wave` decrement it, keyed by TARGET. (It used to be
  // guessed from completion targets, which let farm-batch completions drain a
  // desynced farm host's counter and unlock overlapping prep waves.)
  if (tracked.wave) bump(memory.prepInFlight, tracked.target, -1);
}

/** Tear down a pool worker's reservation exactly once: noteExit is the
 * idempotence guard (a second call finds no entry and frees nothing). */
function releaseWorker(memory: DispatchMemory, workerId: number): void {
  const worker = noteExit(memory.pool, workerId);
  if (!worker) return;
  memory.heap.free(worker.hostname, worker.gb);
  memory.segmentGb.farm -= worker.gb;
}

/** A share worker owns one heap block for its process lifetime. Completion is
 * the sole release point, matching pooled workers and making duplicate exits
 * harmless. */
function releaseShareWorker(memory: DispatchMemory, workerId: number): void {
  const worker = memory.shareWorkers.get(workerId);
  if (!worker) return;
  memory.shareWorkers.delete(workerId);
  memory.heap.free(worker.hostname, worker.gb);
  memory.segmentGb.share -= worker.gb;
}

function releaseChargeWorker(memory: DispatchMemory, opId: number): void {
  const worker = memory.chargeWorkers.get(opId);
  if (!worker) return;
  memory.chargeWorkers.delete(opId);
  memory.heap.free(worker.hostname, worker.gb);
  memory.segmentGb.charge -= worker.gb;
}

export function currentShareBonus(memory: DispatchMemory): number {
  const effectiveThreads = 1 + [...memory.shareWorkers.values()]
    .reduce((sum, worker) => sum + worker.effectiveThreads, 0);
  return 1 + Math.log(effectiveThreads) / 25;
}

/** How long a requested stop may go unanswered before it is re-sent. A share
 * slice is 10 s but the worker races it against the stop mailbox, so an
 * honored stop resolves in milliseconds; anything slower means the request was
 * lost (classically: it raced the worker's boot). */
const SHARE_STOP_RETRY_MS = 2_000;

/** Ask enough divisible workers to leave for hacking's currently unfilled
 * budget. The mailbox action is cooperative: worker.ts races the active share
 * slice against it, then atExit produces the sole heap-release completion.
 *
 * Workers already stopping COUNT toward `wantedGb`: their RAM is on the way,
 * and ignoring it made every repeated call evict a fresh worker on top of the
 * pending ones. Re-sending stale stops is the full pass's job (see the retry
 * sweep in `dispatch`), not this function's. */
export function requestShareStops(
  memory: DispatchMemory,
  actions: Action[],
  wantedGb: number,
  selected?: ReadonlySet<number>,
): number {
  let requested = 0;
  for (const worker of [...memory.shareWorkers.values()].sort((a, b) => b.gb - a.gb)) {
    if (selected && !selected.has(worker.workerId)) continue;
    if (!worker.stopping) {
      worker.stopping = true;
      worker.stopRequestedAt = memory.lastDispatchAt;
      actions.push({ type: "stopShare", opId: worker.workerId });
    }
    requested += worker.gb;
    if (requested + 1e-9 >= wantedGb) break;
  }
  return requested;
}

/** Consume process-exit accounting without running a planning pass. The game
 * adapter uses this before a broker drain so newly real-free RAM is leased
 * before the farm can count it again. Both release helpers are idempotent. */
export function releaseWorkerExits(memory: DispatchMemory, workerIds: Iterable<number>): void {
  for (const workerId of workerIds) {
    releaseShareWorker(memory, workerId);
    releaseChargeWorker(memory, workerId);
    releaseWorker(memory, workerId);
  }
}

function launchShare(
  memory: DispatchMemory,
  actions: Action[],
  intelligence: number,
  /** Upper bound on NEW share RAM this pass. The caller withholds the farm's
   * stable pipeline footprint; without it share takes every momentarily-free
   * block and the farm has to evict it again a pass later — which on a small
   * fleet is not merely churn but starvation, because one 4 GB share thread is
   * most of an 8 GB bootstrap home. */
  maxGb = Infinity,
): void {
  const threads = Math.min(
    memory.heap.capacity(WORKER_RAM.share),
    Math.floor(Math.max(0, maxGb) / WORKER_RAM.share),
  );
  if (threads < 1) return;
  const allocation = memory.heap.allocate({
    blockSize: WORKER_RAM.share,
    threads,
    policy: "spread",
  });
  if (!allocation.ok) return;
  for (const block of allocation.reservation.blocks) {
    const workerId = memory.nextOpId++;
    const gb = block.threads * WORKER_RAM.share;
    memory.shareWorkers.set(workerId, {
      workerId,
      hostname: block.hostname,
      threads: block.threads,
      gb,
      effectiveThreads: block.threads * intelligenceBonus(intelligence, 2) * coreEffect(block.cores),
      stopping: false,
    });
    memory.segmentGb.share += gb;
    memory.stats.execs++;
    actions.push({ type: "share", source: block.hostname, threads: block.threads, opId: workerId });
  }
}

/** Fill the largest residual host blocks with one-shot charge calls. Each call
 * consumes every whole charge thread left on its selected host; it is never
 * stopped or broker-preempted once launched. */
function launchCharge(
  memory: DispatchMemory,
  actions: Action[],
  fragment: { x: number; y: number },
  maxGb: number,
): void {
  let remaining = Math.max(0, maxGb);
  const hosts = [...memory.heap.hosts()]
    .map((host) => ({ host, threads: Math.floor(memory.heap.freeOn(host.hostname) / WORKER_RAM.charge) }))
    .filter((entry) => entry.threads > 0)
    .sort((a, b) => b.threads - a.threads || b.host.cores - a.host.cores || a.host.hostname.localeCompare(b.host.hostname));
  for (const { host, threads: available } of hosts) {
    const threads = Math.min(available, Math.floor(remaining / WORKER_RAM.charge));
    if (threads < 1) break;
    const gb = threads * WORKER_RAM.charge;
    const reservation = memory.heap.reserveOn(host.hostname, gb);
    if (!reservation) continue;
    const opId = memory.nextOpId++;
    memory.chargeWorkers.set(opId, { opId, hostname: host.hostname, threads, gb });
    memory.segmentGb.charge += gb;
    memory.stats.execs++;
    actions.push({ type: "charge", source: host.hostname, threads, opId, x: fragment.x, y: fragment.y });
    remaining -= gb;
  }
}

/** Roll back ops the driver could not actually start (sim rejection, ns.exec
 * returning pid 0). Without this the reservation would never be freed — the
 * exact leak the earlier rewrite's dispatcher had (`nobody0/bitburner`; see
 * README's citation note). A pooled op that failed to START also means its
 * worker is gone (spawn failed) or dead (job post found no mailbox), so the
 * worker's reservation goes with it. */
export function releaseFailed(memory: DispatchMemory, opIds: Iterable<number>): void {
  const failedBatches = new Set<PendingJitBatch>();
  for (const opId of opIds) {
    if (memory.shareWorkers.has(opId)) {
      releaseShareWorker(memory, opId);
      continue;
    }
    if (memory.chargeWorkers.has(opId)) {
      releaseChargeWorker(memory, opId);
      continue;
    }
    const tracked = memory.tracked.get(opId);
    if (!tracked) continue;
    if (tracked.pendingBatch) failedBatches.add(tracked.pendingBatch);
    if (tracked.wave) {
      memory.prepPending = memory.prepPending.filter((op) => op.target !== tracked.target);
    }
    if (tracked.workerId !== undefined) releaseWorker(memory, tracked.workerId);
    release(memory, opId);
  }
  // Drop only the batches that actually lost an op, not the whole pipeline.
  // An exec failure is a RAM-accounting disagreement with the game, not
  // evidence the other batches are unsound, and it is common: 576 in one live
  // install, each of which used to discard every pending batch after their
  // weakens had already launched. Safe for the same reason the deadline path
  // is: hack starts last, so a dropped remainder only leaves support
  // over-covered, and the arrival-security brake re-validates each batch.
  if (failedBatches.size > 0) {
    const affectedTargets = new Set<string>();
    for (const batch of failedBatches) {
      for (const op of batch.ops) releasePendingReservation(memory, op, memory.lastDispatchAt);
      clearPendingJitBatch(memory, batch);
      affectedTargets.add(batch.target);
    }
    for (const target of affectedTargets) compactJitPipeline(memory, target);
  }
}

/** One dispatcher pass: absorb completions, refresh the directive, launch work. */
export function dispatch(
  view: WorldView,
  memory: DispatchMemory,
  completions: CompletionEvent[],
  options: DispatchOptions = {},
): { actions: Action[]; directive: TargetDirective; switched?: { from?: string; to: string } } {
  const wakeTarget = options.trigger?.kind === "target-wake" ? options.trigger.target : undefined;
  const arenaReserves = options.arenaReserves ?? {};
  memory.lastDispatchAt = view.time;
  const byHost = new Map(view.servers.map((s) => [s.hostname, s]));
  const weakenWakeTargets = new Set<string>();
  const successfulWeakenGroups = new Set<string>();
  // group key -> that group's target, so settling never parses the key back
  const touchedWeakenGroups = new Map<string, string>();
  for (const completion of completions) {
    if (completion.kind === "sleep") continue;
    if (completion.kind === "charge") {
      if (completion.opId !== undefined) releaseChargeWorker(memory, completion.opId);
      continue;
    }
    if (completion.kind === "workerExit") {
      // Pooled and share workers both release only on process exit. Each map
      // is its own idempotence guard, so a duplicate cannot double-free.
      if (completion.opId !== undefined) {
        releaseWorkerExits(memory, [completion.opId]);
      }
      continue;
    }
    // Counted only for an op this memory actually launched. A completion can
    // arrive from a worker THIS dispatcher never dispatched — processes that
    // outlived an install, or a reload — and folding those in made `landed`
    // exceed `launched` by two orders of magnitude on a fresh install (846
    // orphan hack landings against 76 real launches), which silently broke
    // every launched-vs-landed comparison built on the pair. Money and exp
    // below are deliberately still counted: that income is real regardless of
    // who launched the op.
    if (completion.opId !== undefined && memory.tracked.has(completion.opId)) {
      memory.stats.landed[completion.kind]++;
      // Landing ERROR: observed minus planned, signed, on one clock. Landing
      // ORDER is verified per batch already, but order cannot say by HOW MUCH
      // an effect slipped, and that magnitude is what decides whether the
      // landing gap and the launch guards are the right size. Only ops we
      // launched are measured — an orphan has no planned landing to compare to.
      const planned = memory.tracked.get(completion.opId)?.landing;
      if (completion.at !== undefined && planned !== undefined) {
        noteLandingError(memory.stats, completion.at - planned, completion.kind);
      }
    } else {
      memory.stats.orphanLandings++;
    }
    if (completion.kind === "hack" && completion.result?.success) {
      memory.stats.moneyEarned += completion.result.moneyGained ?? 0;
      memory.stats.hacks++;
    }
    // Exp is ESTIMATED because the worker return carries no exp figure. All
    // three ops award the same per-thread exp; a failed hack awards a quarter.
    // Live success is inferred from a positive hack return, so in BN8 (where a
    // successful hack also returns $0) this telemetry estimate is conservative:
    // Netscript exposes no success bit that distinguishes the two zero results.
    // Source: https://github.com/bitburner-official/bitburner-src/blob/3162fd2590e221eadd0c0fbd46151913f7c4c41c/src/Netscript/NetscriptHelpers.tsx#L561-L637 and https://github.com/bitburner-official/bitburner-src/blob/3162fd2590e221eadd0c0fbd46151913f7c4c41c/src/NetscriptFunctions.ts#L286-L308
    if (memory.evaluator.ctx && completion.threads) {
      const base = completion.target ? byHost.get(completion.target)?.baseDifficulty : undefined;
      if (base !== undefined) {
        const perThread = hackExpGain(memory.evaluator.ctx, base);
        const failedHack = completion.kind === "hack" && !completion.result?.success;
        memory.stats.expEarned += completion.threads * (failedHack ? perThread / 4 : perThread);
      }
    }
    if (completion.opId !== undefined) {
      const tracked = memory.tracked.get(completion.opId);
      if (tracked?.kind === "weaken" && tracked.landing !== undefined) {
        const group = weakenGroupKey(tracked.target, tracked.landing);
        touchedWeakenGroups.set(group, tracked.target);
        if (completion.result === undefined) memory.failedWeakenGroups.add(group);
        else successfulWeakenGroups.add(group);
      }
      if (tracked?.batchId !== undefined) {
        // Attribution goes through the tracked table, not the wire: the op
        // already echoes its `opId`, and that resolves to the batch it was
        // launched for. Nothing has to be added to the worker protocol.
        //
        // The completions array is the order the workers reported their
        // landings in, which is the only ordering evidence that exists: a
        // CompletionEvent carries no timestamp of its own, and effects
        // separated by MINIMUM_LANDING_GAP_MS can share a millisecond.
        noteBatchLanding(
          memory,
          tracked.batchId,
          view.time,
          tracked.jitRole,
          completion.kind === "hack" && completion.result?.success ? completion.result.moneyGained ?? 0 : 0,
          completion.kind === "hack" && Boolean(completion.result?.success),
        );
      }
      if (tracked?.workerId !== undefined) noteJobDone(memory.pool, tracked.workerId, view.time);
      release(memory, completion.opId);
    }
  }

  // A spread weaken is one logical effect emitted as several worker calls.
  // Only its LAST successful fragment proves the target is at the security
  // boundary. The worker-side debounce merely coalesces wakeups; this ledger
  // check is the correctness barrier and also rejects a group with any failed
  // fragment in this completion drain.
  for (const [group, target] of touchedWeakenGroups) {
    // `weakenPending` counts exactly the unsettled fragments of this group, so
    // its presence IS "a fragment of this landing is still in flight".
    if (memory.weakenPending.has(group)) continue;
    if (successfulWeakenGroups.has(group) && !memory.failedWeakenGroups.has(group)) {
      weakenWakeTargets.add(target);
    }
    memory.failedWeakenGroups.delete(group);
  }

  if (wakeTarget !== undefined) {
    // Completion/deadline interrupts are the strict hot path. Everything
    // below this branch (topology, evaluator, mode selection and planning) is
    // heartbeat maintenance and must not scale a weaken window with depth.
    const directive = memory.activeDirective ?? memory.evaluator.directive;
    const actions: Action[] = [];
    const server = byHost.get(wakeTarget);
    if (server) {
      const launchCtx = makeHackContext(
        { skill: view.player.hackingSkill, intelligence: view.player.intelligence, mults: view.player.mults },
        view.nodeMults ?? {},
      );
      // Not gated on the CURRENT farm host: a switched-away target retains its
      // runtime so its STARTED batches keep launching their suffixes here (the
      // retire-in-place contract above the switch branch). The sweep releases
      // the runtime once the queue empties.
      const runtime = memory.jitRuntimeByTarget.get(wakeTarget);
      if (runtime) {
        const due = dueWakeBatches(
          memory,
          wakeTarget,
          view.time + JIT_LAUNCH_WINDOW_MS,
          MAX_LAUNCH_ACTIONS_PER_PASS,
        );
        if (due.length > 0) {
          launchDueJit(
            memory,
            actions,
            server,
            view.time,
            launchCtx,
            runtime.schedule,
            runtime.segmentCapGb,
            runtime.pooling,
            runtime.reservationMode,
            landingCtxFactory(view, launchCtx),
            due,
            true,
          );
          // launchDueJit has early exits for placement/deadline recovery. The
          // extracted concrete batches must retain their own next cursor in
          // every case; duplicate snapshots are revision-invalidated.
          for (const batch of due) queueBatchWake(memory, batch);
        }
      }
      if (directive.prep?.host === wakeTarget && !isPrepped(server)) {
        const segmentCap = directive.segments.find((segment) => segment.kind === "prep")?.gb ?? 0;
        launchDuePrep(
          memory,
          actions,
          server,
          view.time,
          launchCtx,
          segmentCap,
          weakenWakeTargets.has(wakeTarget),
        );
      }
      // The FARM host in its prep phase parks money-grows in prepPending with
      // a precise startAt, and their launch window past it is one LAUNCH_SLACK
      // — the same 200 ms as the heartbeat. The wake timer for that instant
      // fires here; without this branch it launched nothing and the grow
      // coin-flipped against the next heartbeat, usually dropping on its
      // deadline while its already-flying weaken cover landed uselessly.
      // Measured live: waves of W-only launches, 216 deadline misses, minutes
      // of a 78 TB fleet at 0.2% before a 112 GB grow requirement completed.
      if (
        directive.farm?.host === wakeTarget && runtime === undefined &&
        !isPrepped(server) && targetJitQueue(memory, wakeTarget).length === 0
      ) {
        const segmentCap = directive.segments.find((segment) => segment.kind === "farm")?.gb ?? 0;
        launchDuePrep(
          memory,
          actions,
          server,
          view.time,
          launchCtx,
          segmentCap,
          weakenWakeTargets.has(wakeTarget),
        );
      }
    }
    let nextAt = nextTargetWakeAt(memory, wakeTarget);
    for (const op of memory.prepPending) {
      if (op.target === wakeTarget) nextAt = Math.min(nextAt, op.startAt);
    }
    if (Number.isFinite(nextAt)) {
      actions.push({
        type: "sleep",
        ms: nextAt <= view.time ? OVERDUE_RETRY_MS : nextAt - view.time,
        target: wakeTarget,
      });
    }
    return { actions, directive };
  }

  const capacity = syncTopology(memory, view, arenaReserves, options.sourceHosts);
  const evaluatorGenerationAtPassStart = memory.evaluator.generation;
  const modeAtPassStart = memory.mode;
  // Target wakes are scheduling interrupts, not economic decision points.
  // The 200 ms heartbeat remains the sole owner of target and segment changes.
  const stepped = stepEvaluator(
    view,
    memory.evaluator,
    capacity,
    options.goalRemaining ?? Infinity,
    options.horizonMs ?? Infinity,
    {
      ...(options.reinvestmentReturnPerDollarSec !== undefined
        ? { reinvestmentReturnPerDollarSec: options.reinvestmentReturnPerDollarSec }
        : {}),
      ...(options.hackingSkillGoal !== undefined ? { hackingSkillGoal: options.hackingSkillGoal } : {}),
      ...(options.shareValue ? { shareValue: options.shareValue } : {}),
      ...(options.chargeValue ? { chargeValue: options.chargeValue } : {}),
    },
  );
  memory.evaluator = stepped.memory;
  const requestedSegments = adaptSegmentsToFleet(stepped.directive.segments, capacity.fleetGb);
  const requestedFarmCapGb = requestedSegments.find((segment) => segment.kind === "farm")?.gb ?? 0;

  // A target/mode decision may invalidate unlaunched work, but its already
  // resident support still owns physical RAM until landing. Drop the suffix
  // before sizing the retained claim so only work which can still execute is
  // protected from prep.
  if (stepped.switched) {
    // Retire the outgoing target instead of flushing globally (the
    // reference's drain-and-backfill, spec/jit-reference.md §6): its STARTED
    // batches keep launching their suffixes through the target-wake path with
    // live validation — abandoning them stranded in-flight hacks whose
    // follow-ups never came, which husked a live target to 0.13% of max money
    // at +12.7 security. Unstarted batches are cancelled; the runtime stays
    // so the wake path retains schedule and caps until the queue empties
    // (swept below).
    const from = stepped.switched.from;
    if (from !== undefined && targetJitQueue(memory, from).some((batch) => batch.started)) {
      cancelUnstartedJitTarget(memory, from, view.time);
    } else if (from !== undefined) {
      abandonJitTarget(memory, from, view.time);
    }
    memory.lastAnchor = -Infinity;
    memory.jitDecisionId++;
  }
  // Sweep fully-drained retired targets: no queue, not the current farm host —
  // release their runtime and wake bookkeeping. Only while a farm directive
  // exists: with none, "not the farm host" would sweep a merely-paused
  // pipeline.
  if (stepped.directive.farm) {
    for (const target of [...memory.jitRuntimeByTarget.keys()]) {
      if (target === stepped.directive.farm.host) continue;
      if (targetJitQueue(memory, target).length === 0) abandonJitTarget(memory, target, view.time);
    }
  }
  if (stepped.directive.farm) {
    const target = stepped.directive.farm.host;
    const runtime = memory.jitRuntimeByTarget.get(target);
    const requestedPrepGb = requestedSegments.find((segment) => segment.kind === "prep")?.gb ?? 0;
    const prep = stepped.directive.prep ? byHost.get(stepped.directive.prep.host) : undefined;
    const inactivePrepSpillGb = !prep || isPrepped(prep) ? requestedPrepGb : 0;
    const admissionGb = requestedFarmCapGb + inactivePrepSpillGb;
    if (runtime && runtime.schedule.totalGb > admissionGb + 1e-9) {
      // Stop at the leading-weaken boundary before computing the retained
      // claim, so prep can receive released reservations in this same pass.
      cancelUnstartedJitTarget(memory, target, view.time);
    }
  }
  const committedFarmGb = stepped.directive.farm
    ? remainingFarmCommitmentGb(memory, stepped.directive.farm.host)
    : memory.segmentGb.farm;
  const directive = {
    ...stepped.directive,
    segments: protectFarmCommitment(requestedSegments, committedFarmGb),
  };
  memory.activeDirective = directive;
  const activeTargets = new Set([directive.farm?.host, directive.prep?.host].filter((host): host is string => Boolean(host)));
  memory.prepPending = memory.prepPending.filter((op) => activeTargets.has(op.target));

  const actions: Action[] = [];
  const now = view.time;
  // Durations MUST be computed at launch from live state (security drift, a
  // level-up since the solve): the cached solution's times would land ops off
  // their slots. Our formulas are bit-identical to the game's, so recomputing
  // here reproduces the engine's duration exactly.
  const launchCtx = makeHackContext(
    { skill: view.player.hackingSkill, intelligence: view.player.intelligence, mults: view.player.mults },
    view.nodeMults ?? {},
  );
  // Same context projected forward to a landing instant, for the one quantity
  // that is read at landing rather than at call time: the hack percentage.
  const landingCtxAt = landingCtxFactory(view, launchCtx);

  // Rooting is fleet upkeep. Infrastructure purchases are opt-in: in the live
  // game the shared investment arbiter owns home/cloud/Hacknet spending, but
  // the sim's farm mode has no other owner (see DispatchOptions).
  for (const server of view.servers) {
    // nuke checks only open-port count; hacking skill is checked later by hack,
    // so zero-port servers can be rooted as fleet upkeep immediately.
    // Source: https://github.com/bitburner-official/bitburner-src/blob/3162fd2590e221eadd0c0fbd46151913f7c4c41c/src/NetscriptFunctions.ts#L531-L547
    if (!server.hasAdminRights && server.numOpenPortsRequired === 0) {
      actions.push({ type: "nuke", target: server.hostname });
    }
  }
  if (options.buyInfrastructure) {
    const cloud = cheapestCloudQuote(view.prices.cloudServer);
    const owned = view.servers.filter((s) => s.purchasedByPlayer && s.hostname !== "home").length;
    if (cloud && owned < view.prices.cloudServerLimit && view.player.money >= cloud.cost) {
      actions.push({ type: "buyServer", ram: cloud.ram, name: `pserv-${memory.nextServerIndex++}` });
    }
    if (view.player.money >= view.prices.upgradeHomeRam) {
      actions.push({ type: "upgradeHomeRam" });
    }
  }
  // RAM with no current owner farms instead of idling. A live prep wave is
  // handled below: unused prep demand may be borrowed only until its landing,
  // so the next preparation wave is never delayed by speculative farm work.
  const prepServer = directive.prep ? byHost.get(directive.prep.host) : undefined;
  const prepActive = prepServer !== undefined && !isPrepped(prepServer);
  // The demand ceiling describes the CURRENT farm target; without one (or on
  // a retarget) the stale value would keep pricing infrastructure against a
  // target no longer farmed. The farm branch below re-derives it each pass.
  if (!directive.farm || memory.depthCapHost !== directive.farm.host) {
    memory.depthCapGb = undefined;
    memory.depthCapHost = undefined;
    memory.farmEnvelopeGb = undefined;
    memory.farmPassDemandGb = undefined;
  }
  let spillGb = 0;
  let requestedSpillGb = 0;
  memory.pooling = false;
  for (const segment of directive.segments) {
    if (segment.kind === "prep" && !prepActive) spillGb += Math.max(0, segment.gb - memory.segmentGb.prep);
  }
  for (const segment of requestedSegments) {
    if (segment.kind === "prep" && !prepActive) requestedSpillGb += Math.max(0, segment.gb - memory.segmentGb.prep);
  }
  const farmPriority = directive.segments.findIndex((segment) => segment.kind === "farm");
  const segmentIsActive = (segment: (typeof directive.segments)[number]): boolean =>
    segment.gb > 1e-9 && (segment.kind !== "prep" || prepActive);
  const higherPriorityPrep = farmPriority >= 0 && directive.segments
    .slice(0, farmPriority)
    .some((segment) => segment.kind === "prep" && segmentIsActive(segment));
  const lowerPriorityDemand = farmPriority >= 0 && directive.segments
    .slice(farmPriority + 1)
    .some(segmentIsActive);
  const shareThreat = (directive.share?.reputationSecondsPerBonus ?? 0) > 0;
  const farmReservationMode: JitReservationMode = shareThreat || memory.shareWorkers.size > 0
    ? "protected"
    : higherPriorityPrep
      ? "launch"
      : lowerPriorityDemand
        ? "protected"
        : "launch";
  if (farmReservationMode !== "protected") {
    // A commit-time farm reservation is valuable only when work below farm in
    // the arbiter's current ordering could consume the block. With no such
    // demand, farm-vs-farm contention is zero-sum: committing the winner early
    // merely fixes topology on staler information. Active higher-priority prep
    // also wins. Release only reservations whose own launch window has not
    // opened; due farm work remains committed because its support is sunk.
    for (const batch of allJitBatches(memory)) {
      for (const op of batch.ops) {
        if (op.reservation && jitLaunchAt(op) > now) releasePendingReservation(memory, op, now);
      }
    }
  }

  for (const segment of directive.segments) {
    let segmentCap = segment.kind === "farm" ? segment.gb + spillGb : segment.gb;
    let borrow: { gb: number; landingDeadline: number } | undefined;
    // Proper JIT keeps a stable role envelope and must never be replaced by an
    // eager wave merely because prep has temporary slack. Only modes which
    // have no pending JIT suffix may borrow against prep's next landing.
    if (
      segment.kind === "farm" && prepActive && directive.prep &&
      (options.jit === false || memory.mode === "shotgun")
    ) {
      let landingDeadline = -Infinity;
      for (const tracked of memory.byTarget.get(directive.prep.host)?.values() ?? []) {
        if (tracked.wave && tracked.landing !== undefined) {
          landingDeadline = Math.max(landingDeadline, tracked.landing);
        }
      }
      if (Number.isFinite(landingDeadline)) {
        const nextPrepStart = memory.prepPending
          .filter((op) => op.target === directive.prep!.host)
          .reduce((earliest, op) => Math.min(earliest, op.startAt), Infinity);
        if (Number.isFinite(nextPrepStart)) landingDeadline = Math.min(landingDeadline, nextPrepStart);
        const prepSegment = directive.segments.find((candidate) => candidate.kind === "prep");
        const unusedPrepGb = Math.max(0, (prepSegment?.gb ?? 0) - memory.segmentGb.prep);
        const alreadyBorrowedGb = Math.max(0, memory.segmentGb.farm - segmentCap);
        const borrowGb = Math.max(0, unusedPrepGb - alreadyBorrowedGb);
        if (borrowGb > 0) {
          segmentCap += borrowGb;
          borrow = { gb: borrowGb, landingDeadline };
        }
      }
    }
    let budget = segmentCap - memory.segmentGb[segment.kind];
    if (budget <= 0) continue;

    if (segment.kind === "farm" && directive.farm) {
      const server = byHost.get(directive.farm.host);
      if (!server) continue;
      if (isPrepped(server) || targetJitQueue(memory, server.hostname).length > 0) {
        // Mode: HOW to farm this target (shared/strategy/mode.ts). Decided
        // here — where the farm server and live ctx are in hand — with the
        // dwell carried in memory. Shotgun is wired in launchBatches.
        // Mode is a steady-state choice. Price the prepped hack duration, not
        // a transient fortify between batch landings.
        const hackMs = hackTimeSeconds(launchCtx, server.minDifficulty, server.requiredHackingSkill) * 1_000;
        const weakenMs = weakenTimeSeconds(launchCtx, server.hackDifficulty, server.requiredHackingSkill) * 1_000;
        const mode = options.modeOverride
          ?? decideMode({
            hackMs,
            liveOps: memory.tracked.size,
            lastMode: memory.mode,
            lastModeSince: memory.modeSince,
            now,
          });
        if (mode !== memory.mode) {
          // Pending plans have the old mode's role shape and quotas. Hacks are
          // emitted only after every support op in their batch, so abandoning
          // this unlaunched suffix is safe; already-running support is benign.
          abandonJitPending(memory, now);
          memory.lastAnchor = -Infinity;
          memory.jitDecisionId++;
          memory.mode = mode;
          memory.modeSince = now;
        }
        // Shotgun (Q4) uses the HGW thread math taken to its limit: all three
        // ops of a batch land the same tick, so the shape is HGW's.
        const wantHgw = memory.mode === "hgw" || memory.mode === "shotgun";
        const hgwSolution = wantHgw ? hgwSolutionFor(memory, view, directive.farm.host, capacity) : undefined;
        const solution = hgwSolution ?? directive.farm.solution;
        // Prefer shotgun's smaller H/G/W shape. If its oversized grow cannot
        // fit one host, retain the cached HWGW sizing but still use a genuine
        // same-deadline FIFO wave: H/W1/G/W2. Dropping W1 from an HWGW solution
        // would leave hack security uncovered.
        const shotgun = memory.mode === "shotgun";
        const requestedFarmAdmissionGb = requestedFarmCapGb + requestedSpillGb;
        if (
          memory.drainingJitTargets.has(server.hostname) &&
          targetJitQueue(memory, server.hostname).length === 0 &&
          memory.segmentGb.farm <= 1e-9
        ) {
          memory.drainingJitTargets.delete(server.hostname);
        }
        const committedFarmNowGb = remainingFarmCommitmentGb(memory, server.hostname);
        const currentRuntime = memory.jitRuntimeByTarget.get(server.hostname);
        // A retiring generation clears once nothing of it remains — no queued
        // batch and no launched RAM. Admission never stopped, so unlike the
        // old drain gate there is no dead window to wait out.
        const retiringNow = memory.retiringJitByTarget.get(server.hostname);
        if (retiringNow) {
          const stillQueued = targetJitQueue(memory, server.hostname)
            .some((batch) => (batch.generation ?? 0) === retiringNow.generation);
          if (!stillQueued && retiringCommittedGb(memory, server.hostname) <= 1e-6) {
            memory.retiringJitByTarget.delete(server.hostname);
          }
        }
        // Upsizing was once adopted in place and any downsizing flushed the
        // pipeline. Neither survives contact with an exp surge (the solve
        // shrinks a few percent per skill generation; measured live: plan
        // h12→h9 flushed 2.7 TB of in-flight work back to 222 GB minutes
        // after a restart, ~50% duty forever). Reference semantics instead
        // (spec/jit-reference.md §5-6): the RESERVED shape is stable — batch
        // strengths rescale inside it per launch — and only a drift past
        // JIT_RESHAPE_RATIO (or a kind change) triggers a genuine re-shape:
        // a generational handoff, never a flush. At most one generation
        // retires at a time; further drift waits for the handoff to finish.
        const kindChanged = currentRuntime !== undefined && currentRuntime.solution.kind !== solution.kind;
        // A pure upsize (no role smaller) adopts in place exactly as before:
        // the new envelope dominates the old batches. Only a SHRINK retains or
        // hands off.
        const nextRoleGb = emptyJitRoleCounts();
        for (const role of jitRoles(solution, server, launchCtx)) nextRoleGb[role.role] = role.gb;
        const anyShrink = currentRuntime !== undefined &&
          (["h", "w1", "g", "w2"] as const).some(
            (role) => nextRoleGb[role] + 1e-9 < currentRuntime.roleGb[role],
          );
        // Material drift in EITHER direction hands off: the solver is bistable
        // near grid boundaries (measured on the speed-step lane: h96->h46->h93
        // oscillation), and adopting a doubled hack in place launched blocks
        // that could not place in the standing grid — 2.2 s late landings and
        // a target drained to 6% money. Small drift stays in place: a shrink
        // retains the reserved shape, a small upsize adopts (its envelope
        // dominates the old batches).
        const driftRatio = currentRuntime === undefined || solution.ramPerBatch <= 1e-9
          ? 1
          : Math.max(
              solution.ramPerBatch / currentRuntime.solution.ramPerBatch,
              currentRuntime.solution.ramPerBatch / Math.max(1e-9, solution.ramPerBatch),
            );
        const materialChange = kindChanged || driftRatio > JIT_RESHAPE_RATIO;
        const reshape = currentRuntime !== undefined &&
          materialChange &&
          !memory.retiringJitByTarget.has(server.hostname);
        if (reshape) {
          // phaseOut: never-started batches are cancelled, started ones cash
          // in fully under the outgoing generation's own caps, and the new
          // generation's first landing sits past everything the old one
          // queued (the reference's targetUnsafeUntil).
          cancelUnstartedJitTarget(memory, server.hostname, now);
          // THIS target's launched RAM only: memory.heldGbByRole is global
          // across targets, and a switched-away target's still-flying farm ops
          // must not be baked into a snapshot they can never drain (untrackOp
          // drains by tracked.target, so foreign GB would latch the handoff
          // open forever and under-size every future schedule).
          const retiringHeldGbByRole = emptyJitRoleCounts();
          for (const tracked of memory.tracked.values()) {
            if (
              tracked.workerId === undefined &&
              tracked.segment === "farm" && tracked.jitRole &&
              tracked.target === server.hostname &&
              (tracked.jitGeneration ?? 0) === currentRuntime!.generation
            ) {
              retiringHeldGbByRole[tracked.jitRole] += tracked.gb;
            }
          }
          memory.retiringJitByTarget.set(server.hostname, {
            solution: currentRuntime!.solution,
            schedule: currentRuntime!.schedule,
            generation: currentRuntime!.generation,
            heldGbByRole: retiringHeldGbByRole,
          });
          memory.jitGenerationByTarget.set(server.hostname, currentRuntime!.generation + 1);
          memory.jitRuntimeByTarget.delete(server.hostname);
          // The grid continues uninterrupted: generations interleave on the
          // landing grid safely because the planning ledger is op-accurate
          // across shapes, each generation launches under its own quota, and
          // the arrival brakes re-validate every batch. Anchoring the new
          // generation past the old one's last landing instead cost a
          // pipeline-depth gap per handoff (measured: share-churn income
          // $9.8e7 -> $4.0e7/s).
        }
        // A shrink inside the drift band — or ANY material change while a
        // handoff is still in flight — keeps the reserved shape as the
        // planning shape: never a mix of shapes mid-pipeline. Small pure
        // upsizes fall through with `undefined` and adopt in place.
        const retainedSolution = !reshape && currentRuntime !== undefined && (anyShrink || materialChange)
          ? currentRuntime.solution
          : undefined;
        // Everything below plans under this shape; deriving interval/depth/
        // pooling from the NEW solve while batches launch under the retained
        // one decided pooling from the wrong shape's arithmetic.
        const planningSolution = retainedSolution ?? solution;
        // Security death-spiral guard: mis-ordered landings can let fortify
        // outrun the weakens (observed live: farming at 16.3 security against
        // a minimum of 8, hacks failing and every solve mispriced). Predicted
        // arrival brakes cannot catch this — after a mis-order the predicted
        // ledger is exactly what is wrong — so gate on the OBSERVED drift:
        // stop admitting new batches, let the queue cash in under the brakes,
        // and the unprepped-farm path below weakens the target back before
        // batching resumes.
        if (
          targetJitQueue(memory, server.hostname).length > 0 &&
          server.hackDifficulty > server.minDifficulty + SECURITY_RECOVERY_DRIFT
        ) {
          memory.drainingJitTargets.add(server.hostname);
        }
        const forcedDrain = memory.drainingJitTargets.has(server.hostname);
        const drainingJit =
          options.jit !== false && !shotgun &&
          committedFarmNowGb > 1e-9 && (
            committedFarmNowGb > requestedFarmAdmissionGb + 1e-9 || forcedDrain
          );
        if (drainingJit) {
          // Reduction happens at the batch boundary. Planned leading weakens
          // are cancellable; a batch whose first op was emitted is not.
          cancelUnstartedJitTarget(memory, server.hostname, now);
          budget = segmentCap - memory.segmentGb.farm;
        }
        // Pooling only pays when a worker's NEXT job arrives before its idle
        // timeout. The steady-state launch period is weakenTime over the
        // achievable depth — depth from the SEGMENT total, not this pass's
        // residual budget (which shrinks to ~one batch once the pipeline is
        // full and would read as "no reuse" forever). When RAM or weakenTime
        // keeps depth low — the whole early game — a pooled worker would idle
        // out before reuse, degenerating to spawn-per-op plus an idle timeout
        // of stranded RAM (measured: +11 % time-to-goal on a 16 GB start).
        const interval = planningSolution.kind === "hgw" ? HGW_MIN_INTERVAL_MS : INTERVAL_MS;
        memory.depthCapGb = Math.max(1, Math.floor(weakenMs / interval)) * planningSolution.ramPerBatch;
        memory.depthCapHost = directive.farm.host;
        const depth = Math.max(
          1,
          Math.min(Math.floor(weakenMs / interval), Math.floor(segmentCap / planningSolution.ramPerBatch)),
        );
        // Shotgun uses ONE-SHOT workers only: thousands of distinct same-tick
        // ops make pooling pointless (nothing repeats within a worker's idle
        // window at that structure).
        const pooling =
          // Borrowed prep RAM has a hard return deadline. Reusing an idle
          // pooled worker costs no NEW allocation, but keeps its existing RAM
          // alive past that deadline; let such workers idle out instead.
          borrow === undefined &&
          memory.mode !== "shotgun" &&
          options.pooling === true &&
          memory.tracked.size > POOL_PRESSURE_OPS &&
          weakenMs / depth <= POOL_REUSE_WINDOW_MS;
        memory.pooling ||= pooling;
        launchBatches(
          memory,
          actions,
          planningSolution,
          server,
          now,
          budget,
          segmentCap,
          launchCtx,
          view.stockInfluence?.[server.hostname],
          pooling,
          shotgun,
          options.jit !== false,
          borrow,
          capacity.hostBlocksGb,
          farmReservationMode,
          landingCtxAt,
          !drainingJit,
        );
      } else {
        launchDuePrep(memory, actions, server, now, launchCtx, segmentCap, weakenWakeTargets.has(server.hostname));
        budget = segmentCap - memory.segmentGb[segment.kind];
        if (budget <= 0) continue;
        launchPrepWave(memory, actions, view, server, budget, "farm");
      }
    } else if (segment.kind === "prep" && directive.prep) {
      const server = byHost.get(directive.prep.host);
      if (!server || isPrepped(server)) continue;
      launchDuePrep(memory, actions, server, now, launchCtx, segmentCap, weakenWakeTargets.has(server.hostname));
      budget = segmentCap - memory.segmentGb[segment.kind];
      if (budget <= 0) continue;
      launchPrepWave(memory, actions, view, server, budget, "prep");
    }
  }

  const nonShareDeficitGb = directive.segments
    .filter((segment) => segment.kind !== "share")
    .reduce((sum, segment) => sum + Math.max(0, segment.gb - memory.segmentGb[segment.kind]), 0);
  const hadShareWorkers = memory.shareWorkers.size > 0;
  // Share runs when reputation is on the chosen route (the crossing priced a
  // positive rep value — favor targets included) OR the CURRENT work already
  // earns reputation. The second arm costs hacking nothing by construction:
  // share only ever consumes the residual the farm/prep planners left behind
  // this pass, and the planners already treat share-held RAM as placeable
  // (syncTopology counts share workers as transient "ours"), so share never
  // shrinks what hacking may plan with. The live bonus it produces is also the
  // signal back to the work planner — career/factions price rep work with the
  // MEASURED sharePower, so turning share on when rep work is active is what
  // makes rep-producing work win future comparisons. No forecast "achievable
  // bonus" is ever announced; that value fluctuates with fleet load and would
  // let a speculative number steer work selection.
  const shareEnabled =
    (directive.share?.reputationSecondsPerBonus ?? 0) > 0 ||
    options.shareValue?.currentWorkEarnsRep === true;
  // Hacking has first refusal, triggered by REAL contention only: a pending
  // jit/prep op whose placement actually failed. The previous trigger —
  // unused-allotment deficit — was phantom demand: the JIT farm is designed
  // not to consume its whole segment, so share was stopped on 2338 of 2338
  // passes of the scenario-share rep lane (908 stop-all cycles, 2443 execs vs
  // 180 with share off) while the farm never failed to place anything.
  // Placement-gated stops measured 1141 execs (-53%) with farm work
  // bit-identical, at -4.3% reputation on that single seed. Freeing at least
  // one whole block matters because a failed atomic hack/grow placement can be
  // a contiguity deficit rather than a total-capacity deficit.
  // Compared against the count CONSUMED by the previous full pass, not this
  // pass's start: most launching happens on target-wake hot passes that return
  // long before this gate, and their alloc failures — plus ops the deadline
  // path already dropped, destroying the placementBlocked evidence — were
  // invisible to a same-pass delta. Share then never yielded to real
  // contention it had itself caused.
  const farmPlacementBlocked =
    someJitBatch(memory, (batch) => batch.ops.some((op) => !op.reservation && op.placementBlocked)) ||
    memory.prepPending.some((op) => op.placementBlocked) ||
    memory.stats.allocFails > memory.allocFailsHandled;
  memory.allocFailsHandled = memory.stats.allocFails;

  // Charge is a one-second, non-preemptible investment. Admit it only after
  // hacking/prep have planned this heartbeat, while the pipeline is stable,
  // and keep the entire stable farm envelope available. This is intentionally
  // stronger than the share reserve: share can yield; charge cannot.
  const chargeFragment = directive.charge?.fragment;
  const chargeSuppressed =
    stepped.switched !== undefined ||
    memory.evaluator.generation !== evaluatorGenerationAtPassStart ||
    memory.mode !== modeAtPassStart ||
    memory.drainingJitTargets.size > 0 ||
    memory.prepPending.length > 0 ||
    farmPlacementBlocked ||
    [...memory.shareWorkers.values()].some((worker) => worker.stopping);
  const chargeSegmentGb = directive.segments.find((segment) => segment.kind === "charge")?.gb ?? 0;
  const chargeDeficitGb = Math.max(0, chargeSegmentGb - memory.segmentGb.charge);
  if (
    chargeFragment && !chargeSuppressed &&
    chargeDeficitGb > memory.heap.freeTotal() + 1e-9 && memory.shareWorkers.size > 0
  ) {
    requestShareStops(memory, actions, chargeDeficitGb - memory.heap.freeTotal());
  }
  if (chargeFragment && !chargeSuppressed) {
    const farmReserveGb = Math.max(
      memory.farmPassDemandGb ?? 0,
      Math.max(0, (memory.farmEnvelopeGb ?? 0) - memory.segmentGb.farm),
      nonShareDeficitGb,
    );
    const safeResidualGb = Math.max(0, memory.heap.freeTotal() - farmReserveGb);
    launchCharge(memory, actions, chargeFragment, Math.max(chargeDeficitGb, safeResidualGb));
  }
  // Deliberately NOT a predictive stop keyed on pending launch deadlines.
  // In a deep pipeline there is always work due inside any yield window, so it
  // degenerates into stopping share every pass: measured share-churn
  // $2.65e7 -> $6.83e6/s, batchesSkipped 47 -> 129. Reacting to a real blocked
  // placement, with the reserve keeping those rare, beat it decisively.
  // Share must never SQUAT inside a host's reserved arena. launchShare cannot
  // allocate into a reserve, but reserves GROW after share is resident (the
  // arena covers the largest dodge step any unlocked feature has declared so
  // far), and a dodge stub's exec retries are milliseconds apart — far faster
  // than a cooperative share stop. A share worker left inside a grown reserve
  // therefore crashes the un-brokered sweep dodges outright (measured: the
  // small-fleet scenario controller died execing its 4.1GB stub on home).
  // Evict per host, sized to the shortfall.
  let reserveShortfall = false;
  if (memory.shareWorkers.size > 0) {
    const hostnames = new Set([...memory.shareWorkers.values()].map((worker) => worker.hostname));
    for (const hostname of hostnames) {
      const host = memory.heap.host(hostname);
      if (!host) continue;
      const shortfallGb = host.reserved - (host.maxRam - host.used);
      if (shortfallGb <= 1e-9) continue;
      reserveShortfall = true;
      const onHost = new Set(
        [...memory.shareWorkers.values()]
          .filter((worker) => worker.hostname === hostname)
          .map((worker) => worker.workerId),
      );
      requestShareStops(memory, actions, shortfallGb, onHost);
    }
  }
  if (!shareEnabled) {
    requestShareStops(memory, actions, Infinity);
  } else if (farmPlacementBlocked && memory.shareWorkers.size > 0) {
    requestShareStops(
      memory,
      actions,
      Math.max(WORKER_RAM.share, nonShareDeficitGb - memory.heap.freeTotal()),
    );
  }

  // Re-send stops that have gone unanswered past the retry window. Without
  // this, one stop lost to the boot race left `stopping` latched forever: the
  // worker kept sharing, its RAM stayed held, launchShare stayed gated off,
  // and the broker's share-exit-pending wait never resolved (observed live as
  // share holding a 65 TB fleet with hacking starved).
  for (const worker of memory.shareWorkers.values()) {
    if (!worker.stopping) continue;
    if (now - (worker.stopRequestedAt ?? now) < SHARE_STOP_RETRY_MS) continue;
    worker.stopRequestedAt = now;
    actions.push({ type: "stopShare", opId: worker.workerId });
  }
  const shareStopping = [...memory.shareWorkers.values()].some((worker) => worker.stopping);
  if (shareEnabled && !shareStopping && !reserveShortfall && (!farmPlacementBlocked || !hadShareWorkers)) {
    // Reserve what the farm can launch in one pass; share takes the rest.
    //
    // Share is evictable, so the reserve only needs to cover what the farm can
    // claim before share could answer: one pass of launches, because
    // planJitBatches runs earlier in this same pass and its weakens go
    // immediately. Two variants measured worse — scaling the reserve down by
    // envelope headroom collapsed it to zero exactly when the farm was busiest
    // (live: hack in-flight hit 0 while share held most of a 24 TB fleet), and
    // capping it at a fraction of free RAM cost 10x income on share-churn
    // ($7.74e7 -> $7.24e6/s), because idle RAM is the farm's growth headroom.
    // Batch-shaped demand covers the farm only once its pipeline exists.
    // While the farm target is still PREPPING, its demand is a scheduled prep
    // wave that never writes farmPassDemandGb, and a zero reserve here let
    // share soak the whole fleet between waves — forcing an evict/re-soak
    // churn in which prep crawled at $0/s. The same holds for an active prep
    // segment: its waves are time-phased, so the RAM they are still owed is
    // real demand even though nothing holds it this instant.
    const farmServer = directive.farm ? byHost.get(directive.farm.host) : undefined;
    const farmPrepping = farmServer !== undefined &&
      !isPrepped(farmServer) && targetJitQueue(memory, farmServer.hostname).length === 0;
    const farmSegmentGb = directive.segments.find((segment) => segment.kind === "farm")?.gb ?? 0;
    const farmReserveGb = farmPrepping
      ? Math.max(0, farmSegmentGb - memory.segmentGb.farm)
      : memory.farmPassDemandGb
        ?? Math.max(0, (memory.farmEnvelopeGb ?? 0) - memory.segmentGb.farm);
    const prepSegmentGb = directive.segments.find((segment) => segment.kind === "prep")?.gb ?? 0;
    const prepReserveGb = prepActive ? Math.max(0, prepSegmentGb - memory.segmentGb.prep) : 0;
    const reserveGb = farmReserveGb + prepReserveGb;
    const surplusGb = memory.heap.freeTotal() - reserveGb;
    // Stanek is deliberately absent: charge strength favors one occasional
    // LARGE contiguous call (highestCharge under a log, repetitions^0.07), the
    // opposite of a freely preemptible fragment consumer.
    launchShare(memory, actions, view.player.intelligence, surplusGb);
  }


  // Publish the earliest pending invocation deadline as a pure sleep action.
  // The standalone planner executes it directly; the game driver turns it
  // into a cancellable realm-timer wake alongside its 200 ms heartbeat. Both
  // paths therefore exercise the same schedule without injecting a clock into
  // strategy code.
  if (memory.jitByTarget.size > 0 || memory.prepPending.length > 0) {
    const deadlines = new Map<string, { overdue: boolean; next: number }>();
    const noteDeadline = (target: string, at: number): void => {
      const deadline = deadlines.get(target) ?? { overdue: false, next: Infinity };
      if (at <= now) deadline.overdue = true;
      else deadline.next = Math.min(deadline.next, at);
      deadlines.set(target, deadline);
    };
    for (const batch of allJitBatches(memory)) {
      for (const op of batch.ops) {
        noteDeadline(batch.target, op.reservation ? jitLaunchAt(op) : jitReserveAt(op));
      }
    }
    for (const op of memory.prepPending) noteDeadline(op.target, op.startAt);
    // An overdue op is one that could not be placed, almost always because its
    // RAM is not free yet. That frees on a completion, which wakes us anyway,
    // so this is a fallback retry rather than the primary path — and retrying
    // faster than a worker can start cannot succeed. Deliberately NOT the
    // landing gap: a backoff and a landing separation are unrelated, and tying
    // them together turns a tight grid into a spin.
    for (const [target, deadline] of deadlines) {
      const exactMs = Number.isFinite(deadline.next) ? deadline.next - now : Infinity;
      actions.push({
        type: "sleep",
        ms: deadline.overdue ? Math.min(OVERDUE_RETRY_MS, exactMs) : exactMs,
        target,
      });
    }
  }

  return { actions, directive, switched: stepped.switched };
}

/** The HGW twin of the directive's cached HWGW solution, solved lazily for
 * the chosen farm target only and cached per context generation. */
function hgwSolutionFor(
  memory: DispatchMemory,
  view: WorldView,
  host: string,
  capacity: FleetCapacity,
): CycleSolution | undefined {
  const generation = memory.evaluator.generation;
  if (memory.hgw && memory.hgw.host === host && memory.hgw.generation === generation) {
    return memory.hgw.solution;
  }
  const ctx = memory.evaluator.ctx;
  const server = view.servers.find((s) => s.hostname === host);
  if (!ctx || !server) return undefined;
  const fleetGb = capacity.fleetGb;
  const caps: RamCaps = {
    batchGb: Math.max(WORKER_RAM_FLOOR, fleetGb * FARM_SOLVE_SHARE),
    hackBlockGb: Math.max(WORKER_RAM_FLOOR, capacity.largestBlockGb),
    growBlockGb: Math.max(WORKER_RAM_FLOOR, capacity.largestBlockGb),
    ...(capacity.hostBlocksGb ? { hostBlocksGb: capacity.hostBlocksGb } : {}),
    farmGb: Math.max(WORKER_RAM_FLOOR, fleetGb * FARM_SOLVE_SHARE),
  };
  const influence = view.stockInfluence?.[host];
  const manipulation =
    influence && influence.valuePerOp > 0 ? { valuePerOp: influence.valuePerOp, side: influence.side } : undefined;
  const solution = solveCycle(ctx, staticsOf(server), 1, caps, manipulation, "hgw");
  memory.hgw = { host, generation, ...(solution ? { solution } : {}) };
  return solution;
}

function allocFor(
  kind: "hack" | "grow" | "weaken",
  threads: number,
): { blockSize: number; threads: number; policy: "contiguous" | "homeFirst" | "spread"; coreAware: boolean } {
  return {
    blockSize: WORKER_RAM[kind],
    threads,
    // Hack and grow must each land as one call. Splitting grow is not neutral:
    // the first call raises security before the next call calculates its
    // multiplier, so the split grows less money than the solved atomic op.
    // Weaken is exactly additive and consumes fragments. Cores amplify
    // grow/weaken; hack has no core term.
    // Source: https://github.com/bitburner-official/bitburner-src/blob/3162fd2590e221eadd0c0fbd46151913f7c4c41c/src/Server/formulas/grow.ts#L20-L28 and https://github.com/bitburner-official/bitburner-src/blob/3162fd2590e221eadd0c0fbd46151913f7c4c41c/src/Server/ServerHelpers.ts#L287-L295
    policy: kind === "weaken" ? "spread" : "contiguous",
    coreAware: kind !== "hack",
  };
}

function opDurationMs(
  kind: "hack" | "grow" | "weaken",
  ctx: HackContext,
  difficulty: number,
  requiredSkill: number,
): number {
  if (kind === "hack") return hackTimeSeconds(ctx, difficulty, requiredSkill) * 1_000;
  if (kind === "grow") return growTimeSeconds(ctx, difficulty, requiredSkill) * 1_000;
  return weakenTimeSeconds(ctx, difficulty, requiredSkill) * 1_000;
}

function accountRamWork(
  memory: DispatchMemory,
  segment: SegmentKind,
  kind: "hack" | "grow" | "weaken",
  gb: number,
  nativeMs: number,
  paddingMs: number,
): void {
  const nativeRamMs = gb * Math.max(0, nativeMs);
  const paddingRamMs = gb * Math.max(0, paddingMs);
  memory.stats.padding.count++;
  memory.stats.padding.sumMs += Math.max(0, paddingMs);
  memory.stats.padding.maxMs = Math.max(memory.stats.padding.maxMs, paddingMs);
  memory.stats.nativeRamMs += nativeRamMs;
  memory.stats.paddingRamMs += paddingRamMs;
  memory.stats.nativeRamMsByKind[kind] += nativeRamMs;
  memory.stats.paddingRamMsByKind[kind] += paddingRamMs;
  memory.stats.nativeRamMsBySegment[segment] += nativeRamMs;
  memory.stats.paddingRamMsBySegment[segment] += paddingRamMs;
  memory.stats.nativeRamMsBySegmentKind[segment][kind] += nativeRamMs;
  memory.stats.paddingRamMsBySegmentKind[segment][kind] += paddingRamMs;
}

/** Threads are counted separately from RAM because they answer a different
 * question: RAM is what the fleet spent, threads are what the solve asked for.
 * Cores move them apart — a grow thread on an 8-core host does the work of
 * more than one, so a core upgrade should show as the grow share of THREADS
 * falling while its share of RAM per thread stays fixed. */
function accountThreads(
  memory: DispatchMemory,
  segment: SegmentKind,
  kind: "hack" | "grow" | "weaken",
  threads: number,
  effectThreads = threads,
): void {
  memory.stats.threadsBySegmentKind[segment][kind] += threads;
  memory.stats.effectThreadsBySegmentKind[segment][kind] += effectThreads;
}

/** Start a batch and return its id.
 *
 * Every launch group calls this — a JIT cycle, a shotgun cycle, a prep wave —
 * so that a completion can be attributed back to the unit of work it belonged
 * to. The id is what the whole per-batch accounting hangs off; ops carry it on
 * `Tracked` and hand it back through the `opId` they echo in their completion,
 * so nothing has to be added to the worker protocol to make this work. */
function openBatch(
  memory: DispatchMemory,
  kind: BatchKind,
  target: string,
  segment: SegmentKind,
  at: number,
): number {
  const id = memory.nextBatchId++;
  memory.batches.set(id, {
    id,
    kind,
    target,
    segment,
    startedAt: at,
    planned: [],
    observed: [],
    ops: 0,
    landed: 0,
    threads: emptyByKind(),
    gb: 0,
    moneyEarned: 0,
    hacks: 0,
  });
  // Oldest-first eviction. A batch that loses an op to a failed exec never
  // settles, so without this the map would only grow. Evicting the oldest is
  // right because a batch settles within roughly one batch interval; anything
  // still open after this many is abandoned, not slow.
  //
  // The eviction is COUNTED, not silent. An abandoned batch is precisely a
  // batch that lost an op, so dropping it without a trace made real op loss
  // invisible to every counter in this file — see `BatchAggregate.abandoned`.
  while (memory.batches.size > LANDING_TRACK_LIMIT) {
    const oldest = memory.batches.entries().next();
    if (oldest.done) break;
    const [oldestId, abandoned] = oldest.value;
    const aggregate = memory.stats.batchesByKind[abandoned.kind];
    aggregate.abandoned++;
    aggregate.abandonedOps += abandoned.ops;
    aggregate.abandonedLanded += abandoned.landed;
    memory.batches.delete(oldestId);
  }
  return id;
}

/** Register one launched op against its batch. */
function noteBatchOp(
  memory: DispatchMemory,
  batchId: number,
  kind: "hack" | "grow" | "weaken",
  threads: number,
  gb: number,
  role?: JitRole["role"],
): void {
  const batch = memory.batches.get(batchId);
  if (!batch) return;
  batch.ops++;
  batch.threads[kind] += threads;
  batch.gb += gb;
  if (role !== undefined) batch.planned.push(role);
}

function signature(roles: readonly JitRole["role"][]): string {
  return roles.join("-");
}

/** Record one landing against its batch, settling the batch once its last op
 * has arrived. */
function noteBatchLanding(
  memory: DispatchMemory,
  batchId: number,
  at: number,
  role: JitRole["role"] | undefined,
  earned: number,
  hacked: boolean,
): void {
  const batch = memory.batches.get(batchId);
  if (!batch) return;
  batch.landed++;
  batch.moneyEarned += earned;
  if (hacked) batch.hacks++;
  if (role !== undefined) batch.observed.push(role);
  if (batch.landed < batch.ops) return;
  memory.batches.delete(batchId);
  settleBatch(memory, batch, at);
}

/** Fold a finished batch into the per-kind aggregate, and check its ordering.
 *
 * The order check is only meaningful for a batch with a landing grid — the
 * JIT roles. A prep wave and a shotgun cycle land as a group with no intended
 * internal sequence, so they contribute work and money but no verdict. */
function settleBatch(memory: DispatchMemory, batch: OpenBatch, at: number): void {
  const aggregate = memory.stats.batchesByKind[batch.kind];
  aggregate.batches++;
  aggregate.ops += batch.ops;
  aggregate.landed += batch.landed;
  aggregate.gb += batch.gb;
  aggregate.moneyEarned += batch.moneyEarned;
  aggregate.hacks += batch.hacks;
  aggregate.spanMs += Math.max(0, at - batch.startedAt);
  for (const kind of ["hack", "grow", "weaken"] as const) aggregate.threads[kind] += batch.threads[kind];
  // No loss check here: `noteBatchLanding` only reaches this function once
  // `landed >= ops`, so an incomplete batch never arrives. Loss is counted on
  // the abandon path in `openBatch` instead.
  if (batch.planned.length > 0) aggregate.graded++;

  let observed: string | undefined;
  let planned: string | undefined;
  if (batch.planned.length > 0) {
    if (!batch.planned.includes("h")) {
      // Support that lands with no steal to protect is a different failure
      // from support arriving out of order, and the costlier of the two: it is
      // paid for in full and earns nothing.
      aggregate.noHack++;
      memory.stats.landingOrderIncomplete++;
    } else {
      planned = signature([...batch.planned].sort((a, b) => LANDING_RANK[a] - LANDING_RANK[b]));
      observed = signature(batch.observed);
      memory.stats.landingOrderBatches++;
      const key = planned + "\u0000" + observed;
      const order = memory.stats.landingOrders.get(key);
      if (order) order.batches++;
      else memory.stats.landingOrders.set(key, { planned, observed, batches: 1 });
      if (observed === planned) {
        aggregate.inOrder++;
      } else {
        memory.stats.landingOrderAnomalies.push({ at, observed, planned, target: batch.target });
        if (memory.stats.landingOrderAnomalies.length > LANDING_ANOMALY_RING) {
          memory.stats.landingOrderAnomalies.shift();
        }
      }
    }
  }

  memory.stats.recentBatches.push({
    id: batch.id,
    kind: batch.kind,
    target: batch.target,
    at,
    spanMs: Math.max(0, at - batch.startedAt),
    ops: batch.ops,
    landed: batch.landed,
    threads: { ...batch.threads },
    gb: batch.gb,
    moneyEarned: batch.moneyEarned,
    ...(observed !== undefined ? { order: observed } : {}),
    ...(planned !== undefined ? { planned } : {}),
  });
  if (memory.stats.recentBatches.length > RECENT_BATCH_RING) memory.stats.recentBatches.shift();
}

function noteMissedWindow(memory: DispatchMemory, reason: MissedWindowReason): void {
  memory.stats.missedWindow[reason]++;
}

/** One skipped batch, attributed. Every `batchesSkipped` increment goes
 * through here so the scalar and the per-cause split cannot drift apart. */
function noteBatchSkipped(memory: DispatchMemory, reason: MissedWindowReason): void {
  memory.stats.batchesSkipped++;
  memory.stats.batchesSkippedBy[reason]++;
}

function noteJitDecisionMissedWindow(
  memory: DispatchMemory,
  decisionId: number,
  reason: MissedWindowReason,
): boolean {
  const key = decisionId + "\u0000" + reason;
  if (memory.countedJitDecisionMisses.has(key)) return false;
  memory.countedJitDecisionMisses.add(key);
  noteMissedWindow(memory, reason);
  return true;
}

function noteBatchMissedWindow(
  memory: DispatchMemory,
  batch: PendingJitBatch,
  reason: MissedWindowReason,
): boolean {
  // Counted once per BATCH for every reason. Deadline/placement used to be
  // deduped per DECISION on the theory that scheduler retries of one decision
  // should not inflate the counter — but a miss now costs exactly the batch it
  // happened to (the drop below), so per-batch IS per-occurrence, and the old
  // dedupe hid a steady-state failure loop as a single count: a live run that
  // dropped its whole pipeline every weakenTime for 4.7 hours telemetered as
  // `deadline: 1` while earning $0.
  batch.countedMisses ??= {};
  if (batch.countedMisses[reason]) return false;
  batch.countedMisses[reason] = true;
  noteMissedWindow(memory, reason);
  return true;
}

function accountReservedPadding(
  memory: DispatchMemory,
  op: PendingJitOp,
  now: number,
): void {
  if (!op.reservation || op.reservedAt === undefined) return;
  const gbMs = op.reservation.gb * Math.max(0, now - op.reservedAt);
  memory.stats.paddingRamMs += gbMs;
  memory.stats.paddingRamMsByKind[op.kind] += gbMs;
  memory.stats.paddingRamMsBySegment.farm += gbMs;
  op.reservedAt = now;
}

function releasePendingReservation(memory: DispatchMemory, op: PendingJitOp, now: number): void {
  if (!op.reservation) return;
  accountReservedPadding(memory, op, now);
  const targetHeld = memory.pendingReservedGbByTarget.get(op.target);
  if (targetHeld) targetHeld[op.role] = Math.max(0, targetHeld[op.role] - op.reservation.gb);
  memory.segmentGb.farm -= op.reservation.gb;
  op.reservation.release();
  op.reservation = undefined;
  op.reservedAt = undefined;
}

function pendingReservedByRole(
  memory: DispatchMemory,
  target: string,
): Record<JitRole["role"], number> {
  let held = memory.pendingReservedGbByTarget.get(target);
  if (!held) {
    held = { h: 0, w1: 0, g: 0, w2: 0 };
    memory.pendingReservedGbByTarget.set(target, held);
  }
  return held;
}

function batchWakeAt(batch: PendingJitBatch): number {
  let at = Infinity;
  for (const op of batch.ops) {
    at = Math.min(at, op.reservation ? op.startAt : op.reserveAt ?? op.startAt);
  }
  return at;
}

function wakeEntryLess(a: BatchWakeEntry, b: BatchWakeEntry): boolean {
  return a.at < b.at || (a.at === b.at && a.batch.batchId < b.batch.batchId);
}

function pushWakeEntry(queue: TargetWakeQueue, entry: BatchWakeEntry): void {
  const heap = queue.heap;
  heap.push(entry);
  let at = heap.length - 1;
  while (at > 0) {
    const parent = (at - 1) >>> 1;
    if (!wakeEntryLess(entry, heap[parent]!)) break;
    heap[at] = heap[parent]!;
    at = parent;
  }
  heap[at] = entry;
}

function popWakeEntry(queue: TargetWakeQueue): BatchWakeEntry | undefined {
  const heap = queue.heap;
  const first = heap[0];
  const last = heap.pop();
  if (!first || !last || heap.length === 0) return first;
  let at = 0;
  while (true) {
    const left = at * 2 + 1;
    if (left >= heap.length) break;
    const right = left + 1;
    const child = right < heap.length && wakeEntryLess(heap[right]!, heap[left]!) ? right : left;
    if (!wakeEntryLess(heap[child]!, last)) break;
    heap[at] = heap[child]!;
    at = child;
  }
  heap[at] = last;
  return first;
}

function queueBatchWake(memory: DispatchMemory, batch: PendingJitBatch): void {
  if (batch.ops.length === 0) return;
  let queue = memory.jitWakeByTarget.get(batch.target);
  if (!queue) {
    queue = { heap: [] };
    memory.jitWakeByTarget.set(batch.target, queue);
  }
  const revision = (batch.wakeRevision ?? 0) + 1;
  batch.wakeRevision = revision;
  pushWakeEntry(queue, { at: batchWakeAt(batch), revision, batch });
}

/** Pop only batch cursors whose next action is inside this wake's horizon.
 * Stale heap snapshots are repaired lazily, so heartbeat launches and failed
 * execs never require a depth-wide rebuild before the next completion wake. */
function dueWakeBatches(
  memory: DispatchMemory,
  target: string,
  horizon: number,
  max: number,
): PendingJitBatch[] {
  const queue = memory.jitWakeByTarget.get(target);
  if (!queue) return [];
  const due: PendingJitBatch[] = [];
  while (due.length < max) {
    const entry = queue.heap[0];
    if (!entry) break;
    if (entry.revision !== (entry.batch.wakeRevision ?? 0) || entry.batch.ops.length === 0) {
      popWakeEntry(queue);
      continue;
    }
    const actual = batchWakeAt(entry.batch);
    if (Math.abs(actual - entry.at) > 1e-9) {
      popWakeEntry(queue);
      queueBatchWake(memory, entry.batch);
      continue;
    }
    if (entry.at > horizon) break;
    popWakeEntry(queue);
    // Invalidate this snapshot while the batch is being advanced.
    entry.batch.wakeRevision = entry.revision + 1;
    due.push(entry.batch);
  }
  if (queue.heap.length === 0) memory.jitWakeByTarget.delete(target);
  return due;
}

function nextTargetWakeAt(memory: DispatchMemory, target: string): number {
  const queue = memory.jitWakeByTarget.get(target);
  if (!queue) return Infinity;
  while (queue.heap.length > 0) {
    const entry = queue.heap[0]!;
    if (entry.revision !== (entry.batch.wakeRevision ?? 0) || entry.batch.ops.length === 0) {
      popWakeEntry(queue);
      continue;
    }
    const actual = batchWakeAt(entry.batch);
    if (Math.abs(actual - entry.at) > 1e-9) {
      popWakeEntry(queue);
      queueBatchWake(memory, entry.batch);
      continue;
    }
    return actual;
  }
  memory.jitWakeByTarget.delete(target);
  return Infinity;
}

function targetJitQueue(memory: DispatchMemory, target: string): PendingJitBatch[] {
  return memory.jitByTarget.get(target) ?? [];
}

function emptyJitRoleCounts(): Record<JitRole["role"], number> {
  return { h: 0, w1: 0, g: 0, w2: 0 };
}

function pendingJitRoleCounts(
  memory: DispatchMemory,
  target: string,
): Record<JitRole["role"], number> {
  let counts = memory.pendingJitRoleCountByTarget.get(target);
  if (!counts) {
    counts = emptyJitRoleCounts();
    memory.pendingJitRoleCountByTarget.set(target, counts);
  }
  return counts;
}

function bumpPendingJitRole(
  memory: DispatchMemory,
  target: string,
  role: JitRole["role"],
  delta: number,
): void {
  const counts = pendingJitRoleCounts(memory, target);
  counts[role] = Math.max(0, counts[role] + delta);
  if (counts.h + counts.w1 + counts.g + counts.w2 === 0) {
    memory.pendingJitRoleCountByTarget.delete(target);
  }
}

function* allJitBatches(memory: DispatchMemory): IterableIterator<PendingJitBatch> {
  for (const pipeline of memory.jitByTarget.values()) yield* pipeline;
}

function someJitBatch(
  memory: DispatchMemory,
  predicate: (batch: PendingJitBatch) => boolean,
): boolean {
  for (const batch of allJitBatches(memory)) if (predicate(batch)) return true;
  return false;
}

function enqueueJitBatch(memory: DispatchMemory, batch: PendingJitBatch): void {
  let queue = memory.jitByTarget.get(batch.target);
  if (!queue) {
    queue = [];
    memory.jitByTarget.set(batch.target, queue);
  }
  queue.push(batch);
  memory.pendingJitBatchCount++;
  memory.pendingJitOpCount += batch.ops.length;
  memory.unstartedJitBatchCountByTarget.set(
    batch.target,
    (memory.unstartedJitBatchCountByTarget.get(batch.target) ?? 0) + 1,
  );
  const counts = pendingJitRoleCounts(memory, batch.target);
  for (const op of batch.ops) counts[op.role]++;
  queueBatchWake(memory, batch);
}

function removePendingJitOp(memory: DispatchMemory, batch: PendingJitBatch, op: PendingJitOp): void {
  const at = batch.ops.indexOf(op);
  if (at < 0) return;
  batch.ops.splice(at, 1);
  memory.pendingJitOpCount--;
  bumpPendingJitRole(memory, batch.target, op.role, -1);
  if (batch.ops.length === 0) {
    memory.pendingJitBatchCount--;
    if (!batch.started) bumpUnstartedJitBatch(memory, batch.target, -1);
  }
}

function clearPendingJitBatch(memory: DispatchMemory, batch: PendingJitBatch): void {
  if (batch.ops.length === 0) return;
  memory.pendingJitOpCount -= batch.ops.length;
  memory.pendingJitBatchCount--;
  if (!batch.started) bumpUnstartedJitBatch(memory, batch.target, -1);
  for (const op of batch.ops) bumpPendingJitRole(memory, batch.target, op.role, -1);
  batch.ops.length = 0;
  batch.wakeRevision = (batch.wakeRevision ?? 0) + 1;
}

function bumpUnstartedJitBatch(memory: DispatchMemory, target: string, delta: number): void {
  const next = Math.max(0, (memory.unstartedJitBatchCountByTarget.get(target) ?? 0) + delta);
  if (next > 0) memory.unstartedJitBatchCountByTarget.set(target, next);
  else memory.unstartedJitBatchCountByTarget.delete(target);
}

function markJitBatchStarted(memory: DispatchMemory, batch: PendingJitBatch): void {
  if (batch.started) return;
  batch.started = true;
  bumpUnstartedJitBatch(memory, batch.target, -1);
}

/** Cancel only batches which have not crossed the physical start boundary.
 * This is the downscale primitive: stop admitting leading weakens, while
 * every batch whose support is already running retains its complete suffix. */
function cancelUnstartedJitTarget(memory: DispatchMemory, target: string, now: number): void {
  if ((memory.unstartedJitBatchCountByTarget.get(target) ?? 0) === 0) return;
  const pipeline = memory.jitByTarget.get(target);
  if (!pipeline) return;
  for (const batch of pipeline) {
    if (batch.started || batch.ops.length === 0) continue;
    for (const op of batch.ops) releasePendingReservation(memory, op, now);
    clearPendingJitBatch(memory, batch);
    // JIT opens its telemetry batch while planning. With no launched op there
    // is no work to settle or classify as abandoned/no-hack.
    const open = memory.batches.get(batch.batchId);
    if (open?.ops === 0) memory.batches.delete(batch.batchId);
  }
  compactJitPipeline(memory, target);
}

/** Launched RAM the retiring generation still holds. The incoming schedule is
 * sized against the segment minus this, and re-fits each pass as it drains —
 * the deliberate approximation standing in for exact fragmentation. */
function retiringCommittedGb(memory: DispatchMemory, target: string): number {
  const retiring = memory.retiringJitByTarget.get(target);
  if (!retiring) return 0;
  return retiring.heldGbByRole.h + retiring.heldGbByRole.w1 +
    retiring.heldGbByRole.g + retiring.heldGbByRole.w2;
}

function compactJitPipeline(memory: DispatchMemory, target: string): void {
  const queue = targetJitQueue(memory, target).filter((batch) => batch.ops.length > 0);
  if (queue.length > 0) memory.jitByTarget.set(target, queue);
  else memory.jitByTarget.delete(target);
}

/** Abandon the predicted suffix through the same physical reservation handles
 * that a successful launch transfers to workerExit accounting. */
function abandonJitPending(memory: DispatchMemory, now: number): void {
  for (const batch of allJitBatches(memory)) {
    for (const op of batch.ops) releasePendingReservation(memory, op, now);
    batch.wakeRevision = (batch.wakeRevision ?? 0) + 1;
  }
  memory.jitByTarget.clear();
  memory.jitWakeByTarget.clear();
  memory.jitRuntimeByTarget.clear();
  memory.retiringJitByTarget.clear();
  memory.pendingReservedGbByTarget.clear();
  memory.pendingJitRoleCountByTarget.clear();
  memory.unstartedJitBatchCountByTarget.clear();
  memory.drainingJitTargets.clear();
  memory.pendingJitBatchCount = 0;
  memory.pendingJitOpCount = 0;
  memory.hackZeroStreak = 0;
}

/** Drop one target's unlaunched suffix without disturbing any other target's
 * queue or wake. A topology/segment change is target-local; turning it into a
 * global flush recreates the cross-server coupling these queues exist to
 * remove. */
function abandonJitTarget(memory: DispatchMemory, target: string, now: number): void {
  // A fully-drained pipeline has no jitByTarget entry (compactJitPipeline
  // deletes it), but the runtime/wake/flag bookkeeping below can still exist —
  // the sweep relies on this function releasing them, so no early return.
  const batches = memory.jitByTarget.get(target) ?? [];
  for (const batch of batches) {
    for (const op of batch.ops) releasePendingReservation(memory, op, now);
    if (batch.ops.length > 0) {
      memory.pendingJitBatchCount--;
      memory.pendingJitOpCount -= batch.ops.length;
    }
    batch.wakeRevision = (batch.wakeRevision ?? 0) + 1;
  }
  memory.jitByTarget.delete(target);
  memory.jitWakeByTarget.delete(target);
  memory.jitRuntimeByTarget.delete(target);
  memory.retiringJitByTarget.delete(target);
  memory.pendingReservedGbByTarget.delete(target);
  memory.pendingJitRoleCountByTarget.delete(target);
  memory.unstartedJitBatchCountByTarget.delete(target);
  memory.drainingJitTargets.delete(target);
  memory.hackZeroStreak = 0;
}

/** Maximum farm RAM the already-committed pipeline can still need at one
 * instant. This is O(roles), not O(depth): each role's fixed schedule quota is
 * capped by the incrementally maintained number of remaining invocations.
 * Current resident RAM is a hard floor, covering eager work and pooled workers
 * which cannot be assigned a future release instant here. */
function remainingFarmCommitmentGb(memory: DispatchMemory, target: string): number {
  const runtime = memory.jitRuntimeByTarget.get(target);
  if (!runtime) return memory.segmentGb.farm;
  const pending = memory.pendingJitRoleCountByTarget.get(target) ?? emptyJitRoleCounts();
  const reserved = memory.pendingReservedGbByTarget.get(target) ?? { h: 0, w1: 0, g: 0, w2: 0 };
  let peak = 0;
  for (const role of ["h", "w1", "g", "w2"] as const) {
    const roleGb = runtime.roleGb[role];
    const resident = memory.heldGbByRole[role] + memory.pool.gbByRole[role] + reserved[role];
    if (roleGb <= 0) {
      peak += resident;
      continue;
    }
    // Reservations are already represented by their pending invocation, so
    // only launched/pool RAM is converted back into occupied slot count.
    const remainingSlots = pending[role] + Math.ceil(
      (memory.heldGbByRole[role] + memory.pool.gbByRole[role]) / roleGb - 1e-12,
    );
    peak += Math.max(resident, Math.min(runtime.schedule.quotaGb[role], remainingSlots * roleGb));
  }
  return Math.max(memory.segmentGb.farm, peak);
}

/** Raise farm's effective cap to its sunk commitment and reclaim that space
 * from the lowest-priority other segments first. The requested cap remains a
 * separate admission boundary; this adjusted plan exists only so prep/share
 * cannot consume RAM an old farm suffix still needs while it drains. */
function protectFarmCommitment(segments: readonly Segment[], committedGb: number): Segment[] {
  const adjusted = segments.map((segment) => ({ ...segment }));
  const farmAt = adjusted.findIndex((segment) => segment.kind === "farm");
  if (farmAt < 0) return adjusted;
  const fleetGb = adjusted.reduce((sum, segment) => sum + segment.gb, 0);
  const wanted = Math.min(fleetGb, Math.max(adjusted[farmAt]!.gb, committedGb));
  let transfer = wanted - adjusted[farmAt]!.gb;
  if (transfer <= 1e-9) return adjusted;
  // Segment order is priority order. Work from the tail so share/lower-value
  // prep yields before a higher-priority claim, while committed work still
  // overrides every speculative allocation when necessary.
  for (let at = adjusted.length - 1; at >= 0 && transfer > 1e-9; at--) {
    if (at === farmAt) continue;
    const take = Math.min(adjusted[at]!.gb, transfer);
    adjusted[at]!.gb -= take;
    transfer -= take;
  }
  adjusted[farmAt]!.gb = wanted - transfer;
  // A cap protects quantity, not topology. During a drain, dispatch the
  // retained farm envelope before speculative prep/share so divisible prep
  // cannot fragment the atomic host blocks an already-committed H/G role
  // still needs. Once the commitment fits the requested farm allotment this
  // function takes the early return above and restores evaluator priority.
  const [farm] = adjusted.splice(farmAt, 1);
  adjusted.unshift(farm!);
  return adjusted;
}

/** Highest security an invocation can observe in a correctly interleaved
 * pipeline. Planning start windows against this state means a landing effect
 * can make the NEXT operation due early, but never make it already late. The
 * action's final padding is still calculated from the live duration. */
function jitWorstDifficulty(solution: CycleSolution, server: ServerView): number {
  return jitWorstDifficultyFor(solution.kind, solution.hackThreads, solution.growThreads, server);
}

function jitWorstDifficultyFor(
  kind: CycleSolution["kind"],
  hackThreads: number,
  growThreads: number,
  server: ServerView,
): number {
  // The steady-state peak starts at min security, but `isPrepped` admits a
  // small residual. That LIVE difficulty is part of the first batch's timing:
  // using only the lower steady-state peak can make W1 look as though it need
  // not start yet. If the next controller frame is delayed, the real longer
  // weaken then misses its landing and the target can never enter steady
  // state. This conservative bound makes bootstrap W1 launch immediately;
  // later deadlines are still tightened by `latestJitStart` at weaken wakes.
  return Math.max(
    server.hackDifficulty,
    cycleWorstDifficulty(kind, server.minDifficulty, hackThreads, growThreads),
  );
}

/* Timing is priced at the CONSERVATIVE difficulty (`max(live, min + 0.002H +
 * 0.004G)`), not at min security, even though a farm cycle's invariant is
 * (min security, max money). Pricing at min is only sound if every launch is
 * GUARANTEED to happen at min, which is what gating on a weaken completion
 * would buy; without it a launch lands anywhere in the cycle, where HGW sits
 * above min between the hack and its weaken, so the real duration exceeds the
 * plan. Measured: pricing at min cut mean padding 704.6 -> 458.6 ms but took
 * deadline misses 0 -> 5887 and income $1.484e12 -> $1.233e12. Tighten the
 * timing only together with weaken-gated admission. */
function jitRoles(
  solution: CycleSolution,
  server: ServerView,
  ctx: HackContext,
  pooling = false,
): JitRole[] {
  const difficulty = jitWorstDifficulty(solution, server);
  const required = server.requiredHackingSkill;
  // A role slot is not reusable at its landing: the one-shot serve worker
  // idles POOL_REUSE_WINDOW_MS before exiting, and only its workerExit frees
  // the heap block. Sizing quotas from the bare duration booked slots the
  // fleet cannot actually recycle in time — the op that needed slot N+1 was
  // then ALWAYS blocked past its launch deadline, which is what fed the
  // pipeline-wipe loop (see the deadline-miss handler). Under pooling an idle
  // worker IS the next slot (planTake reuses it), so only the exit/handoff
  // guard applies there.
  const slotLingerMs = pooling ? 0 : POOL_REUSE_WINDOW_MS;
  return cycleJitRoles(
    {
      kind: solution.kind,
      hackGb: solution.hackThreads * WORKER_RAM.hack,
      weaken1Gb: solution.weaken1Threads * WORKER_RAM.weaken,
      growGb: solution.growThreads * WORKER_RAM.grow,
      weaken2Gb: solution.weaken2Threads * WORKER_RAM.weaken,
    },
    (kind) => opDurationMs(kind, ctx, difficulty, required),
    JIT_LAUNCH_GUARD_MS + MINIMUM_WORKER_PRECISION_MS + slotLingerMs,
  );
}

/** A ledger op with a back-reference to the pending op it came from, so the
 * launch loop can identify the operation it is currently validating without
 * rebuilding the ledger to exclude it. */
interface LedgerEntry {
  op: LedgerOp;
  source?: PendingJitOp;
}

/** The ledger with back-references, in construction order. Callers that fold
 * it sort by `compareLedgerOps`; `jitSecurityEvents` relies on construction
 * order, so sorting here would change which security boundary wins a tie. */
/** Fold one observed landing error into the running distribution. */
function noteLandingError(
  stats: DispatchStats,
  errorMs: number,
  kind?: CompletionEvent["kind"],
): void {
  if (kind === "hack" || kind === "grow" || kind === "weaken") {
    accumulateLandingError(stats.landingErrorByKind[kind], errorMs);
  }
  accumulateLandingError(stats.landingError, errorMs);
}

function accumulateLandingError(d: LandingErrorStats, errorMs: number): void {
  if (d.count === 0) {
    d.minMs = errorMs;
    d.maxMs = errorMs;
  } else {
    if (errorMs < d.minMs) d.minMs = errorMs;
    if (errorMs > d.maxMs) d.maxMs = errorMs;
  }
  d.count++;
  d.sumMs += errorMs;
  d.maxAbsMs = Math.max(d.maxAbsMs, Math.abs(errorMs));
}

/** Hack context at a future instant, given the measured experience rate.
 *
 * Hack DURATION is fixed when the Netscript call is made, and is already priced
 * from live state each pass. Hack PERCENTAGE is evaluated when the hack LANDS,
 * so a batch solved at level L over-steals if it lands at L+n — and its grow,
 * sized for the smaller steal, then fails to restore the server. The reference
 * projects the level and re-solves (imports/batchRunner.ts:317-327).
 *
 * Returns the SAME context object when the projected level is unchanged, which
 * is the overwhelmingly common case, so callers can compare by identity and a
 * pass planning eight batches builds at most one or two contexts. Keyed on the
 * integer level alone — no timestamps, so there is nothing to invalidate. */
function landingCtxFactory(
  view: WorldView,
  ctx: HackContext,
): (horizonMs: number) => HackContext {
  const expPerSec = view.player.hackingExpRate ?? 0;
  const currentSkill = view.player.hackingSkill;
  if (!(expPerSec > 0)) return () => ctx;
  const projection = {
    hackingExp: view.player.hackingExp,
    expPerSec,
    hackingMult: hackingLevelMult(view),
    currentSkill,
  };
  const cache = new Map<number, HackContext>();
  return (horizonMs: number): HackContext => {
    const skill = projectedSkill(projection, horizonMs);
    if (skill === currentSkill) return ctx;
    let projected = cache.get(skill);
    if (!projected) {
      projected = makeHackContext(
        { skill, intelligence: view.player.intelligence, mults: view.player.mults },
        view.nodeMults ?? {},
      );
      cache.set(skill, projected);
    }
    return projected;
  };
}

/** REAL threads a tracked op's effects will apply with.
 *
 * `gb / WORKER_RAM[kind]` recovers the block it occupies, which is what RAM was
 * billed for. When the op was dispatched at a reduced fractional strength that
 * block is an OVER-estimate, and the whole point of the ledger is fortify —
 * over-stating it makes every downstream operation look slower than it is and
 * launch early into padding it did not need. */
function trackedStrength(tracked: Tracked): number {
  return tracked.strengthThreads ?? tracked.gb / WORKER_RAM[tracked.kind];
}

/** Earliest weaken landing strictly after `now`, or Infinity.
 *
 * A min-query, not a sort. It used to be `.find()` over the sorted ledger,
 * which forced that whole ledger to be built and sorted on EVERY pass even
 * though the fold that also reads it usually touches nothing. Scanning the two
 * sources directly answers the same question without materialising ~11,500
 * entries. `prepPending` cannot contribute — its ops are all grows. */
function nextWeakenLandingAfter(memory: DispatchMemory, host: string, now: number): number {
  let earliest = Infinity;
  const queue = memory.landingByTarget.get(host);
  if (queue) {
    // The chunks are landing-ordered, so the FIRST future weaken in them is the
    // earliest tracked one — but it is only a candidate: an unlaunched pending
    // weaken can still land sooner, and returning here outright dropped the
    // pending scan below and reported a later boundary than the real one.
    tracked:
    for (const chunk of queue.chunks) {
      if ((chunk.at(-1)?.op.landing ?? -Infinity) <= now) continue;
      for (const entry of chunk) {
        if (entry.op.landing <= now) continue;
        if (entry.op.kind === "weaken") {
          earliest = entry.op.landing;
          break tracked;
        }
      }
    }
  }
  for (const batch of targetJitQueue(memory, host)) {
    for (const op of batch.ops) {
      if (op.kind !== "weaken") continue;
      if (op.landing > now && op.landing < earliest) earliest = op.landing;
    }
  }
  return earliest;
}

function jitLedgerEntries(memory: DispatchMemory, host: string): LedgerEntry[] {
  const tracked = flattenLandingQueue(memory.landingByTarget.get(host));
  const entries: LedgerEntry[] = [];
  let pendingId = -1;
  for (const batch of targetJitQueue(memory, host)) {
    for (const op of batch.ops) {
      entries.push({
        op: {
          kind: op.kind,
          threads: op.threads,
          effectThreads: op.threads,
          landing: op.landing,
          opId: pendingId--,
        },
        source: op,
      });
    }
  }
  for (const op of memory.prepPending) {
    if (op.target !== host) continue;
    entries.push({
      op: {
        kind: "grow",
        threads: op.threads,
        fortifyThreads: op.maxThreads,
        effectThreads: op.effectThreads,
        landing: op.landing,
        opId: pendingId--,
      },
    });
  }
  entries.sort((a, b) => compareLedgerOps(a.op, b.op));
  const merged: LedgerEntry[] = [];
  let trackedAt = 0;
  let pendingAt = 0;
  while (trackedAt < tracked.length || pendingAt < entries.length) {
    const left = tracked[trackedAt];
    const right = entries[pendingAt];
    if (!right || (left && compareLedgerOps(left.op, right.op) <= 0)) {
      merged.push(left!);
      trackedAt++;
    } else {
      merged.push(right);
      pendingAt++;
    }
  }
  return merged;
}

/** The ledger without back-references, optionally excluding one pending op.
 *
 * Deliberately NOT expressed as a filter over `jitLedgerEntries`. An omitted
 * op there would still consume an opId, leaving a gap in the descending
 * sequence; the ids are the tie-break for equal landings, and shifting them
 * changes which of two same-instant ops folds first. That is observable —
 * `sim/tests/dispatch.test.ts` "re-validates arrival security immediately
 * before dispatching a pending hack" fails on it. The duplication is the
 * cheaper of the two costs. */
function jitLedger(memory: DispatchMemory, host: string, omit?: PendingJitOp): LedgerOp[] {
  if (omit === undefined) {
    return jitLedgerEntries(memory, host).map((entry) => entry.op);
  }
  const ops: LedgerOp[] = [];
  for (const [opId, tracked] of memory.byTarget.get(host) ?? []) {
    if (tracked.landing === undefined) continue;
    const threads = trackedStrength(tracked);
    ops.push({
      kind: tracked.kind,
      threads,
      effectThreads: tracked.effectThreads ?? threads,
      landing: tracked.landing,
      opId,
    });
  }
  let pendingId = -1;
  for (const batch of targetJitQueue(memory, host)) {
    for (const op of batch.ops) {
      if (op === omit) continue;
      ops.push({
        kind: op.kind,
        threads: op.threads,
        effectThreads: op.threads,
        landing: op.landing,
        opId: pendingId--,
      });
    }
  }
  for (const op of memory.prepPending) {
    if (op.target !== host) continue;
    ops.push({
      kind: "grow",
      threads: op.threads,
      fortifyThreads: op.maxThreads,
      effectThreads: op.effectThreads,
      landing: op.landing,
      opId: pendingId--,
    });
  }
  return ops;
}

/** Re-evaluate an operation's invocation deadline against the complete future
 * security ledger. This retains the launch guard, but pays padding before a
 * security boundary only when crossing that boundary would make the desired
 * landing unreachable. */
function jitStartAt(
  op: Pick<PendingJitOp, "kind" | "landing">,
  events: readonly JitSecurityEvent[],
  server: ServerView,
  now: number,
  ctx: HackContext,
): number {
  const required = server.requiredHackingSkill;
  return latestJitStart({
    now,
    landing: op.landing,
    currentDifficulty: server.hackDifficulty,
    minDifficulty: server.minDifficulty,
    events,
    eventsSorted: true,
    durationMs: (difficulty) => opDurationMs(op.kind, ctx, difficulty, required),
    launchGuardMs: JIT_LAUNCH_GUARD_MS,
  });
}

/** The future security timeline for a target, built at most once per caller and
 * only if something actually asks for it.
 *
 * Both callers need it only for an op whose reserve window has already opened,
 * which in steady state is a handful out of a pipeline of thousands — while
 * building it costs a full ledger materialisation plus a sort of that. Paying
 * O(ledger log ledger) per pass to discover that nothing needed it is the shape
 * of cost that made a deep pipeline unschedulable. */
function lazySecurityEvents(
  memory: DispatchMemory,
  host: string,
  ctx: HackContext,
): () => JitSecurityEvent[] {
  let events: JitSecurityEvent[] | undefined;
  return () => events ??= jitSecurityEvents(jitLedger(memory, host), ctx);
}

function jitSecurityEvents(ledger: readonly LedgerOp[], ctx: HackContext): JitSecurityEvent[] {
  const weakenPerThread = weakenEffect(ctx, 1, 1);
  return ledger.map((event) => ({
    at: event.landing,
    order: event.opId,
    deltaDifficulty: event.kind === "hack"
      ? HACK_FORTIFY * event.threads
      : event.kind === "grow"
        ? GROW_FORTIFY * (event.fortifyThreads ?? event.threads)
        : -weakenPerThread * event.effectThreads,
  })).sort((a, b) => a.at - b.at || a.order - b.order);
}

/** Launch prep grows at the closest safe invocation window. Their W2 cover
 * was launched when the wave was planned, so this function can never emit G
 * before W2. A weaken-completion pump forces a fresh fold: this is the mature
 * JIT rendezvous rule which avoids sampling a busy target between effects. */
function launchDuePrep(
  memory: DispatchMemory,
  actions: Action[],
  server: ServerView,
  now: number,
  ctx: HackContext,
  segmentCapGb: number,
  weakenWake = false,
): void {
  const ops = memory.prepPending.filter((op) => op.target === server.hostname);
  if (ops.length === 0) return;
  const events = lazySecurityEvents(memory, server.hostname, ctx);
  for (const op of ops) {
    if (weakenWake || op.startAt <= now) op.startAt = jitStartAt(op, events(), server, now, ctx);
  }
  ops.sort((a, b) => a.startAt - b.startAt || a.landing - b.landing);

  let emitted = 0;
  for (const op of ops) {
    if (emitted >= MAX_PREP_SLABS_PER_PASS || op.startAt > now) break;
    const liveDuration = opDurationMs("grow", ctx, server.hackDifficulty, server.requiredHackingSkill);
    const padding = op.landing - now - liveDuration;
    if (padding < WORKER_STARTUP_GUARD_MS - 1e-9) {
      memory.prepPending.splice(memory.prepPending.indexOf(op), 1);
      const prepReason = op.placementBlocked ? "placement" : "deadline";
      noteBatchSkipped(memory, prepReason);
      noteMissedWindow(memory, prepReason);
      continue;
    }
    // Re-place the atomic effect at launch time. Holding its provisional host
    // would turn the reservation itself into the idle RAM JIT removes. The
    // ACTUAL reservation is the segment-cap authority: charging the one-core
    // security-cover ceiling here would reject a valid grow that re-lands on
    // the high-core host deliberately kept free for it.
    const fallback = memory.heap.allocate(allocFor("grow", op.effectThreads));
    if (!fallback.ok) {
      memory.stats.allocFails++;
      memory.stats.allocFailsByPhase.prep++;
      op.placementBlocked = true;
      break;
    }
    const reservation = fallback.reservation;
    if (memory.segmentGb[op.segment] + reservation.gb > segmentCapGb + 1e-9) {
      reservation.release();
      break;
    }
    const block = reservation.blocks[0]!;
    const opId = memory.nextOpId++;
    const gb = block.threads * WORKER_RAM.grow;
    // `allocFor` rounds effect units UP into whole real threads, so the block
    // is worth at least what was asked for and usually a little more. Asking
    // for the exact strength spends that residue instead of over-growing and
    // over-fortifying: fortify scales with the REAL threads the call runs at,
    // and W2 was sized for `op.effectThreads`, not for the rounded-up block.
    const blockEffect = block.threads * coreEffect(block.cores);
    const effectThreads = Math.min(op.effectThreads, blockEffect);
    const strengthThreads = effectThreads / coreEffect(block.cores);
    actions.push({
      type: "grow",
      target: server.hostname,
      source: block.hostname,
      threads: block.threads,
      ...(strengthThreads < block.threads ? { strengthThreads } : {}),
      opId,
      phase: "prep",
      ...(padding > 0 ? { additionalMsec: padding } : {}),
      ...(op.stock ? { stock: true } : {}),
    });
    trackOp(memory, opId, {
      hostname: block.hostname,
      target: server.hostname,
      kind: "grow",
      segment: op.segment,
      gb,
      wave: true,
      landing: op.landing,
      effectThreads,
      strengthThreads,
      batchId: op.batchId,
    });
    memory.inFlight.grow++;
    memory.segmentGb[op.segment] += gb;
    bump(memory.prepInFlight, server.hostname, 1);
    memory.stats.launched.grow++;
    memory.stats.execs++;
    if (op.stock) memory.stats.stockOps++;
    accountRamWork(memory, op.segment, "grow", gb, liveDuration, padding);
    accountThreads(memory, op.segment, "grow", block.threads, effectThreads);
    noteBatchOp(memory, op.batchId, "grow", block.threads, gb);
    memory.prepPending.splice(memory.prepPending.indexOf(op), 1);
    emitted++;
  }
}

/** Enforce the dependency order inside one JIT batch. A shorter op can have an
 * earlier native deadline than its support near the shotgun boundary; moving
 * support earlier (never a dependent later) preserves its full startup guard
 * and spends only the padding required for W* -> G -> H launch order. */
function orderJitStarts(ops: PendingJitOp[]): void {
  const hack = ops.find((op) => op.role === "h");
  const grow = ops.find((op) => op.role === "g");
  if (grow && hack) grow.startAt = Math.min(grow.startAt, hack.startAt);
  const dependentStart = Math.min(grow?.startAt ?? Infinity, hack?.startAt ?? Infinity);
  for (const op of ops) {
    if (op.role === "w1" || op.role === "w2") op.startAt = Math.min(op.startAt, dependentStart);
  }
}

/** Commit before the operation's own guarded launch deadline by the measured
 * dispatch-latency portion of that guard. This is a derived timestamp, not a
 * fixed wall-clock lead from the current scheduler pump. */
function jitReserveAt(op: PendingJitOp): number {
  return op.reserveAt ?? op.startAt - (JIT_LAUNCH_GUARD_MS - WORKER_STARTUP_GUARD_MS);
}

function jitLaunchAt(op: PendingJitOp): number {
  return op.startAt;
}

/** Reserve each planned op at its conservative commit deadline, then launch at
 * the end of the measured dispatch-latency budget. The block is protected
 * from lower-priority work without launching a padded worker a weaken-time
 * early. */
function launchDueJit(
  memory: DispatchMemory,
  actions: Action[],
  server: ServerView,
  now: number,
  ctx: HackContext,
  schedule: JitSchedule,
  segmentCapGb: number,
  pooling: boolean,
  reservationMode: JitReservationMode,
  /** Hack context projected to a future instant — see landingCtxFactory. */
  ctxAt: (horizonMs: number) => HackContext = () => ctx,
  pipelineOverride?: PendingJitBatch[],
  hotWake = false,
): boolean {
  const pipeline = pipelineOverride ?? targetJitQueue(memory, server.hostname);
  const required = server.requiredHackingSkill;
  // The hottest instance of the lazy build: this function runs twice per pass,
  // before and after planning.
  const events = hotWake ? undefined : lazySecurityEvents(memory, server.hostname, ctx);
  for (const batch of hotWake ? [] : pipeline) {
    if (batch.target !== server.hostname) continue;
    // The initial worst-security deadline is a lower bound. Refine only when
    // that bound actually opens; later batches land after this op and cannot
    // insert a new fortify before it. Re-folding every future op against the
    // whole ledger on every 200 ms tick is quadratic at deep pipelines.
    for (const op of batch.ops) {
      // A weaken wake changes the ledger, but future ops were seeded from the
      // conservative worst-security deadline and remain safe. Re-fold only
      // when that bound opens. Re-folding the entire deep pipeline at every
      // weaken landing is O(pending × ledger) and dominated long simulations
      // without changing which not-yet-due operation could launch.
      if (!op.reservation && jitReserveAt(op) <= now) {
        op.startAt = jitStartAt(op, events!(), server, now, ctx);
        op.reserveAt = op.startAt - (JIT_LAUNCH_GUARD_MS - WORKER_STARTUP_GUARD_MS);
      }
    }
    orderJitStarts(batch.ops);
  }
  // A pooled job does not own RAM; its resident worker is counted exactly once
  // by the pool ledger, whether the worker is busy or idle.
  const heldByRole: Record<JitRole["role"], number> = {
    h: memory.heldGbByRole.h + memory.pool.gbByRole.h,
    w1: memory.heldGbByRole.w1 + memory.pool.gbByRole.w1,
    g: memory.heldGbByRole.g + memory.pool.gbByRole.g,
    w2: memory.heldGbByRole.w2 + memory.pool.gbByRole.w2,
  };
  const pendingHeld = pendingReservedByRole(memory, server.hostname);
  if (!hotWake && pendingHeld.h + pendingHeld.w1 + pendingHeld.g + pendingHeld.w2 === 0) {
    for (const batch of pipeline) {
      for (const op of batch.ops) pendingHeld[op.role] += op.reservation?.gb ?? 0;
    }
  }
  for (const role of ["h", "w1", "g", "w2"] as const) heldByRole[role] += pendingHeld[role];
  // Generational split during a handoff: the retiring shape's batches place
  // under their own recorded caps, and the incoming shape's held RAM excludes
  // what the retiring generation still holds. Approximate by design (see
  // RetiringJitRuntime) — the heap and the arrival brakes stay the safety.
  const retiring = memory.retiringJitByTarget.get(server.hostname);
  const quotaGbFor = (batch: PendingJitBatch, role: JitRole["role"]): number =>
    retiring !== undefined && (batch.generation ?? 0) === retiring.generation
      ? retiring.schedule.quotaGb[role]
      : schedule.quotaGb[role];
  const heldGbFor = (batch: PendingJitBatch, role: JitRole["role"]): number =>
    retiring === undefined
      ? heldByRole[role]
      : (batch.generation ?? 0) === retiring.generation
        ? retiring.heldGbByRole[role]
        : Math.max(0, heldByRole[role] - retiring.heldGbByRole[role]);

  // Commit due blocks before emitting any work. Pool workers are themselves
  // physical role reservations, so the early heap commitment is needed only
  // on the one-shot path.
  if (!pooling) {
    reservePending:
    for (const batch of pipeline) {
      if (batch.target !== server.hostname) continue;
      const ordered = [...batch.ops].sort(
        (a, b) => a.startAt - b.startAt || JIT_ROLE_PRIORITY[a.role] - JIT_ROLE_PRIORITY[b.role],
      );
      for (const op of ordered) {
        if (op.reservation || jitReserveAt(op) > now) continue;
        const requestedGb = op.threads * WORKER_RAM[op.kind];
        if (jitLaunchAt(op) > now && reservationMode === "launch") continue;
        const roleCapGb = Math.max(
          quotaGbFor(batch, op.role) * (op.role === "h" ? JIT_QUOTA_SLACK : 1),
          requestedGb,
        );
        if (
          heldGbFor(batch, op.role) + requestedGb > roleCapGb + 1e-9 ||
          memory.segmentGb.farm + requestedGb > segmentCapGb + 1e-9
        ) {
          // Skip THIS batch, not every remaining one. Within a batch the
          // dependency rule holds — stop once a required op cannot be
          // committed — but batches are independent, and a labeled break meant
          // one saturated role stopped reservations pipeline-wide. Measured on
          // the tolerance-bootstrap soak: the hack role capped on 1.6M of 1.6M
          // passes, so hacks were never reserved and therefore never launched,
          // while the pending set grew unboundedly and nothing registered as a
          // miss (an unreserved op is skipped before the deadline check).
          memory.stats.jitQuotaSkips[`reserve:${op.role}`] =
            (memory.stats.jitQuotaSkips[`reserve:${op.role}`] ?? 0) + 1;
          continue reservePending;
        }
        const allocation = memory.heap.allocate(allocFor(op.kind, op.threads));
        if (!allocation.ok) {
          // Ask share to yield the moment the RESERVE fails rather than at the
          // end of the pass: this is one launch guard before the deadline, so
          // the cooperative exit still frees the block for next pass's retry.
          // The block is not released here — the game owns it until the
          // worker's exit — so this pass must not try to place into it.
          // Evict for the WHOLE envelope deficit, not this op's crumb: after
          // a flush the farm regrows toward its envelope, and one-op-per-10s
          // eviction crawled while share re-soaked the freed RAM each tick
          // (measured live: share held 30 TB against a 117 TB demand at ~$0).
          // Fires only on a real failed placement, so steady state — where
          // the farm deliberately under-fills its envelope — is untouched.
          requestShareStops(memory, actions, Math.max(
            requestedGb,
            (memory.farmEnvelopeGb ?? 0) - memory.segmentGb.farm,
          ));
          op.placementBlocked = true;
          break reservePending;
        }
        if (
          heldGbFor(batch, op.role) + allocation.reservation.gb > roleCapGb + 1e-9 ||
          memory.segmentGb.farm + allocation.reservation.gb > segmentCapGb + 1e-9
        ) {
          allocation.reservation.release();
          break reservePending;
        }
        op.reservation = allocation.reservation;
        op.reservedAt = now;
        pendingHeld[op.role] += allocation.reservation.gb;
        heldByRole[op.role] += allocation.reservation.gb;
        memory.segmentGb.farm += allocation.reservation.gb;
      }
    }
  }

  // Arrival prediction, folded ONCE across the whole pass.
  //
  // Each hack needs the state at its own landing, excluding itself. Rebuilding
  // and re-sorting the whole ledger per hack is O(depth) work per hack and
  // therefore O(depth^2) per pass, which dominates once a deep pipeline is
  // running. Hacks are reached in batch order and a batch's hack lands first,
  // so their landings are non-decreasing and one forward cursor serves them
  // all. `foldPredicted` returns the state at `at` with `skip` withheld;
  // `commitFolded` then folds that op's FINAL threads, which is what keeps the
  // cursor correct across the shrink and removal this loop performs.
  //
  // Caveat: within a group of exactly equal landings the withheld op folds
  // last rather than in opId order. Equal landings are already a modelled
  // tie-break rather than a Netscript guarantee (see prediction.ts).
  const foldStatics = staticsOf(server);
  /** Built on first use, like `lazySecurityEvents` and for the same reason.
   *
   * A settled pipeline validates nothing on most passes: measured at depth, a
   * steady-state pass built and sorted the whole ledger TWICE (once per
   * `launchDueJit` call) and the fold below consumed NONE of it. Even when it
   * does fold it drains well under 1% before the pass hits its launch cap.
   * See sim/tests/dispatch-scaling.test.ts. */
  let builtLedger: LedgerEntry[] | undefined;
  const ledgerEntriesOf = (): LedgerEntry[] => builtLedger ??= jitLedgerEntries(memory, server.hostname);

  // Read HERE, not at the launch loop below that consumes it. This used to be
  // a `.find()` over the eagerly built ledger above, so it saw the pipeline as
  // it stood BEFORE the reservation pass; taking the reading at the point of
  // use instead would silently retime the launch horizon.
  const nextWeakenLanding = hotWake ? Infinity : nextWeakenLandingAfter(memory, server.hostname, now);

  /** One forward cursor over the shared, already-sorted ledger.
   *
   * A cursor is only valid for a sequence of NON-DECREASING landings; the
   * fallback below keeps it correct otherwise, but at O(ledger) per call. That
   * matters because hack and grow are validated in the same loop and their
   * landings interleave: within a batch the grow lands after the hack, yet it
   * launches well before it (grow runs ~3.2x longer), so the loop reaches them
   * in the opposite order to their landings. Sharing one cursor would take the
   * slow path on essentially every hack and restore exactly the O(depth^2)
   * pass this cursor was introduced to remove.
   *
   * Each KIND is monotonic in isolation — batches are reached in order and a
   * given role lands once per batch — so each kind gets its own cursor and
   * both stay O(ledger) for the whole pass. */
  const makeFold = () => {
    let ledgerIndex = 0;
    let foldedAt = -Infinity;
    let foldState: PredictedState = {
      hackDifficulty: server.hackDifficulty,
      moneyAvailable: server.moneyAvailable,
    };
    let withheld: LedgerEntry | undefined;
    return {
      /** State at `at` with `skip` withheld. */
      predicted: (at: number, skip: PendingJitOp): PredictedState => {
        if (hotWake) {
          // A weaken wake proves the security boundary, but the instantaneous
          // MONEY is not an arrival prediction: in a valid interleaved grid it
          // is routinely low after an earlier H and before that batch's G.
          // Treating that transient sample as this later hack's landing money
          // cancelled the hack while all of its support was already paid for.
          // The batch was sized against the ordered ledger and failures remove
          // their own dependent suffix, so retain that plan cap here. Live
          // duration and the startup/deadline check below remain authoritative.
          return {
            hackDifficulty: Math.max(server.minDifficulty, server.hackDifficulty),
            moneyAvailable: server.moneyMax,
          };
        }
        // Landings should be non-decreasing; if that ever fails, fall back to
        // the exact whole-ledger fold rather than silently reusing a cursor
        // that has already advanced past `at`.
        if (at < foldedAt) {
          return predictAtLanding(
            ctx,
            foldStatics,
            { hackDifficulty: server.hackDifficulty, moneyAvailable: server.moneyAvailable },
            jitLedger(memory, server.hostname, skip),
            at,
          );
        }
        foldedAt = at;
        const ledgerEntries = ledgerEntriesOf();
        while (ledgerIndex < ledgerEntries.length && ledgerEntries[ledgerIndex]!.op.landing <= at) {
          const entry = ledgerEntries[ledgerIndex]!;
          ledgerIndex++;
          if (entry.source === skip) withheld = entry;
          else foldState = applyLedgerOp(ctx, foldStatics, foldState, entry.op);
        }
        return foldState;
      },
      /** Fold the withheld op at the size it was actually dispatched at, or
       * drop it when the loop removed it. */
      commit: (threads: number | undefined): void => {
        const entry = withheld;
        withheld = undefined;
        if (!entry || threads === undefined || threads <= 0) return;
        foldState = applyLedgerOp(ctx, foldStatics, foldState, {
          ...entry.op,
          threads,
          effectThreads: threads,
        });
      },
    };
  };
  const hackFold = makeFold();
  const growFold = makeFold();
  const foldPredicted = hackFold.predicted;
  const commitFolded = hackFold.commit;

  // How far past `now` this pass may reach forward for work.
  //
  // Waking once per operation start is one pass per landing-gap, which at a
  // tight grid is most of the scheduler's cost. Launching an operation early
  // does not move its landing — additionalMsec absorbs the difference — so a
  // window is affordable; what it costs is padding, RAM resident while doing
  // no native work, which is why it is bounded rather than open-ended.
  //
  // It is truncated at the next weaken landing, and that truncation is the
  // important half. A weaken completion is the only moment security is known
  // to be back at minimum, so it is both the safest trigger and the one with
  // the least padding. Reaching past it would launch against a security the
  // plan did not assume and pay for the whole interval; deferring to it is the
  // generalisation `latestJitStart` already applies when choosing startAt
  // (spec/jit-reference.md section 2). The periodic pass gets things rolling
  // and recovers; the weaken wake remains the guarantee.
  const launchHorizon = Math.min(now + JIT_LAUNCH_WINDOW_MS, nextWeakenLanding);

  let emitted = 0;
  batches:
  for (const batch of pipeline) {
    if (batch.target !== server.hostname) continue;
    // A batch with nothing inside the launch horizon has nothing to launch, and
    // copy-sorting its ops to discover that is pure allocation. At depth this
    // loop reaches thousands of pending batches twice per pass and all but a
    // handful are far-future.
    //
    // Deliberately a `continue` and not a `break`: batch anchors are USUALLY
    // increasing, but a re-plan can re-anchor, and a break on that assumption
    // stalled the pipeline outright (`tracked` 20 -> 5 in the dispatcher's own
    // load test). The cap check is repeated here so skipping a batch cannot
    // change when the pass reports itself full.
    let earliest = Infinity;
    for (const op of batch.ops) earliest = Math.min(earliest, jitLaunchAt(op));
    if (earliest > launchHorizon) {
      if (emitted >= MAX_PREP_OPS_PER_PASS) return true;
      continue;
    }
    const ordered = [...batch.ops].sort(
      (a, b) => a.startAt - b.startAt || JIT_ROLE_PRIORITY[a.role] - JIT_ROLE_PRIORITY[b.role],
    );
    for (const op of ordered) {
      if (emitted >= MAX_PREP_OPS_PER_PASS) return true;
      if (jitLaunchAt(op) > launchHorizon) continue;
      if (!pooling && !op.reservation) continue;

      // The plan-time fold sizes support, but only this point observes every
      // state change which happened while H waited outside RAM. Validate H
      // before the live-duration deadline: raised arrival security is the
      // safety brake firing, not an accidental scheduler miss.
      if (op.kind === "hack") {
        const statics = foldStatics;
        const predicted = foldPredicted(op.landing, op);
        const baseHackThreads = op.baseHackThreads ?? op.threads;
        // The percentage this hack will steal is read at its LANDING, so the
        // re-check has to use the level projected to then. Closest site to the
        // landing, therefore the shortest horizon and the smallest projection
        // error — and it composes with the plan-time cap below rather than
        // replacing it.
        const landingCtx = ctxAt(op.landing - now + JIT_LAUNCH_GUARD_MS);
        let safeHackThreads = hackThreadsAtLanding(landingCtx, statics, predicted, baseHackThreads);
        if (safeHackThreads === undefined && batch.started) {
          // Do not cancel a started batch, but do not launch its hack into an
          // unsafe security state either. Keep the suffix pending; the
          // already-flying weaken will wake this target at the safe boundary.
          noteBatchMissedWindow(memory, batch, "arrival-security");
          commitFolded(undefined);
          continue;
        }
        if (safeHackThreads === undefined) {
          heldByRole[op.role] -= op.reservation?.gb ?? 0;
          releasePendingReservation(memory, op, now);
          removePendingJitOp(memory, batch, op);
          noteBatchSkipped(memory, "arrival-security");
          noteBatchMissedWindow(memory, batch, "arrival-security");
          commitFolded(undefined);
          continue;
        }
        // Never above the plan-time strength: that one already accounts for the
        // level lookahead against the steal this batch's grow was built for.
        let shrunkThreads = Math.min(op.threads, op.planStrengthThreads ?? Infinity, safeHackThreads);
        if (shrunkThreads < op.threads - 1e-9) {
          // Ask the committed block for LESS rather than re-placing a smaller
          // one. `opts.threads` is fractional, so the same worker performs the
          // reduced hack directly; releasing and re-allocating would return the
          // block to the heap where a lower-priority tenant could take it, and
          // would break pooled reuse by changing the size the cached solution
          // sized its workers for. `op.threads` therefore stays put — it is
          // what RAM, the role quota and the JIT cadence are all sized on.
          op.strengthThreads = shrunkThreads;
          noteBatchMissedWindow(memory, batch, "arrival-money");
        } else {
          delete op.strengthThreads;
        }
        // The cancel threshold is on STRENGTH now, not on the block: a hack
        // worth a fraction of a thread is not worth an op, and the block it
        // would have run on is better released to the next batch.
        if (shrunkThreads < MIN_HACK_STRENGTH_THREADS) {
          if (batch.started) {
            // A started batch is irrevocable. Even a tiny remaining steal is
            // preferable to paying for support and intentionally earning
            // nothing; its grow remains over-covered by the planned W2.
            shrunkThreads = Math.min(op.threads, MIN_HACK_STRENGTH_THREADS);
            op.strengthThreads = shrunkThreads;
            memory.drainingJitTargets.add(server.hostname);
            cancelUnstartedJitTarget(memory, server.hostname, now);
          } else {
          // The shrink path above no longer releases, so cancelling has to:
          // this op is leaving the batch and its block would otherwise stay
          // charged to the role until the reservation aged out.
          heldByRole[op.role] -= op.reservation?.gb ?? 0;
          releasePendingReservation(memory, op, now);
          removePendingJitOp(memory, batch, op);
          noteBatchSkipped(memory, "arrival-money");
          noteBatchMissedWindow(memory, batch, "arrival-money");
          // A run of money-zeroed hacks is a desync, not bad luck: every
          // later grow was sized from the same short predicted ledger, so
          // the money deficit is self-perpetuating. Rebuild from depth 0 —
          // planning re-predicts from the OBSERVED server state, and a
          // genuinely under-money target falls to the prep path exactly as
          // the shrunken-envelope recovery below does.
          if (++memory.hackZeroStreak >= HACK_ZERO_DESYNC_STREAK) {
            abandonJitPending(memory, now);
            memory.lastAnchor = -Infinity;
            return false;
          }
          commitFolded(undefined);
          continue;
          }
        }
        memory.hackZeroStreak = 0;
        commitFolded(op.strengthThreads ?? op.threads);
      }

      // Grow is the other dynamic operation, and the last chance to size it
      // against what the hack ahead of it actually took rather than what the
      // plan assumed it would take. The brake above may have shrunk that hack
      // moments ago, in which case the planned grow is now too large — and an
      // over-grow costs security the committed W2 was never sized to cover.
      //
      // Weaken is deliberately absent from this branch. It always runs at its
      // full spawned strength: the RAM is already paid for, the surplus clamps
      // harmlessly at minDifficulty, and it is the ordering insurance that lets
      // the 5 ms landing grid survive a misordering at all.
      if (op.kind === "grow") {
        const predicted = growFold.predicted(op.landing, op);
        // Captured when the batch was planned — see PendingJitOp.coverThreads
        // for why this cannot be read off the batch at launch time.
        const coverThreads = op.coverThreads ?? op.threads;
        const sizedGrow = growThreadsAtLanding(
          ctx,
          foldStatics,
          predicted,
          op.threads,
          coverThreads,
        );
        if (sizedGrow !== undefined && sizedGrow > 0 && sizedGrow < op.threads - 1e-9) {
          // Same reasoning as the hack shrink: ask the committed block for
          // less rather than re-placing a smaller one. `op.threads` stays put
          // because RAM, the role quota and the cadence are all sized on it.
          op.strengthThreads = sizedGrow;
        } else {
          delete op.strengthThreads;
        }
        growFold.commit(op.strengthThreads ?? op.threads);
      }

      // This is deliberately live: Netscript fixes duration when the HGW call
      // is invoked, not when the batch was planned.
      const liveDuration = opDurationMs(op.kind, ctx, server.hackDifficulty, required);
      const padding = op.landing - now - liveDuration;
      // Deferring to the LIVE deadline would bound padding, and works in
      // isolation: replacing this admission with `if (padding >
      // JIT_LAUNCH_GUARD_MS) continue;` measured mean 162.8 ms / max 230 ms
      // against ~704 ms today. It is not enabled because that window is only
      // ~200 ms wide and nothing guarantees this loop reaches an op inside it:
      // 316,883 deferrals produced 6,619 ops that overshot below the startup
      // allowance between passes, costing 18% of income.
      //
      // RE-MEASURED after the weaken-landing wake landed (it now bypasses both
      // WAKE_MIN_MS and WAKE_MAX_PER_FRAME, game/lib/features/hacking.ts, and
      // spread weakens coalesce on a trailing timer in game/worker/worker.ts).
      // That was the prerequisite this comment used to name, and it is NOT
      // sufficient: on scenario-jit share-churn the deferral still cut launched
      // hacks 2,497 -> 729 and income $9.39e7 -> $1.55e7/s, with the fleet
      // failing to compound past 5.7 TB instead of 62 TB. Whatever reaches the
      // op late, a weaken wake does not fix it. The next step is the landing
      // error distribution (stats.landingError) measured in the LIVE game,
      // where jitter is real — the simulator lands ops exactly on plan
      // (measured mean -6e-12 ms), so it cannot price this trade at all.
      // The worker converts our absolute padding deadline immediately before
      // invoking Netscript. Less than the measured startup allowance is no
      // longer a safe launch even if the pure duration still fits on paper.
      if (padding < WORKER_STARTUP_GUARD_MS - 1e-9) {
        const reason = op.placementBlocked ? "placement" : "deadline";
        const firstMiss = noteBatchMissedWindow(memory, batch, reason);
        if (batch.started) {
          // Late SUPPORT still launches: a weaken or grow landing outside its
          // spacer only over-covers, and discarding it wastes the batch's
          // already-flying siblings. A late HACK is bounded instead: it may
          // slip within its pre-grow window (one spacer of margin — landing
          // after its own w1 is cosmetic, w1 covers the fortify either way),
          // but a hack that would land past its own GROW must never launch:
          // it steals money nothing will restore — chained across batches
          // this husked a live target to 0.13% of max money at +12.7
          // security. Its support flies as over-cover ("support landed,
          // nothing stolen"), the only safe outcome.
          // The pre-grow window is shape-dependent: HWGW lands g two spacers
          // after h (h, w1, g, w2), HGW only one (h, g, w2). A quota for w1
          // exists exactly when the shape has a w1 leg.
          const preGrowMs = quotaGbFor(batch, "w1") > 0 ? 2 * SPACER_MS : SPACER_MS;
          if (op.kind === "hack" && padding < WORKER_STARTUP_GUARD_MS - preGrowMs - 1e-9) {
            heldByRole[op.role] -= op.reservation?.gb ?? 0;
            releasePendingReservation(memory, op, now);
            removePendingJitOp(memory, batch, op);
            if (firstMiss) noteBatchSkipped(memory, reason);
            continue;
          }
        } else {
          if (firstMiss) noteBatchSkipped(memory, reason);
        // A miss costs exactly THIS batch: its unlaunched suffix is dropped
        // and every other batch keeps its own schedule. Dropping the suffix is
        // always security-safe — ops launch in W → G → H order, so whatever is
        // still pending can only leave already-flying support over-covered
        // (extra weaken, or a clamped over-grow), never a hack uncovered. The
        // previous behaviour abandoned the ENTIRE pending pipeline for one
        // late op; combined with a systematically late op (role quota
        // saturation) that turned into a plan → launch-weakens → wipe loop
        // that farmed $0/s at 1% RAM for hours while the deduped counter
        // reported a single miss. Later batches were sized with this batch's
        // effects in the predicted ledger, but every divergence is on the safe
        // side: a dropped hack leaves MORE money than predicted (validation
        // only ever shrinks, so later hacks under-steal), a dropped grow
        // leaves less (the arrival-money brake shrinks the affected hacks),
        // and a wholesale desync still trips the hackZeroStreak rebuild.
        for (const pending of batch.ops) {
          if (pending.reservation) heldByRole[pending.role] -= pending.reservation.gb;
          releasePendingReservation(memory, pending, now);
        }
        clearPendingJitBatch(memory, batch);
        continue batches;
        }
      }

      const requestedGb = op.threads * WORKER_RAM[op.kind];
      const poolPlan = op.reservation
        ? { take: [], missThreads: 0 }
        : pooling
        ? planTake(memory.pool, op.kind, op.threads, new Set(), op.role)
        : { take: [], missThreads: op.threads };
      const missRequestedGb = poolPlan.missThreads * WORKER_RAM[op.kind];
      // `isPrepped` intentionally admits a small residual security/money
      // tolerance. The first batch then has a larger W1 and/or G than the
      // minimum-security steady-state role used to derive `schedule`. Let one
      // such bootstrap op own its role exclusively: it is still bounded by
      // the real segment and allocator below, while later steady-state ops
      // wait for it to clear. Applying the steady-state quota literally here
      // deadlocks a perfectly usable target forever (no RAM is allocated, so
      // nothing can change the state that made the role larger).
      const roleCapGb = Math.max(
        quotaGbFor(batch, op.role) * (op.role === "h" ? JIT_QUOTA_SLACK : 1),
        requestedGb,
      );
      // Quotas gate NEW commitments, never RAM this op already holds.
      //
      // An op with a reservation contributes `missRequestedGb === 0`, so the
      // test below degenerates to `held > cap` — and `held` counts that very
      // reservation. A role even marginally over quota (measured: w2 held 40
      // against a 39 GB quota) could therefore never launch what it had
      // already committed, so it never released it either: reservations piled
      // up until the role was permanently full, no hack ever launched, and
      // nothing registered as a miss because an unlaunched op is skipped
      // before the deadline check.
      if (
        missRequestedGb > 1e-9 && (
          heldGbFor(batch, op.role) + missRequestedGb > roleCapGb + 1e-9 ||
          memory.segmentGb.farm + missRequestedGb > segmentCapGb + 1e-9
        )
      ) {
        // Skip THIS batch, not the whole pass.
        //
        // Within a batch the rule stands: never emit a dependent hack once a
        // required support launch is blocked, so the rest of this batch is
        // abandoned for now (it stays pending and retries next pass). But
        // other batches are independent, and aborting the entire loop meant a
        // saturated role blocked every unrelated op that was due. Measured on
        // a 970 TB fleet: the hack quota filled 110 times, and each time the
        // grows and weakens of other batches lost their launch windows —
        // 274 grow and 43 w2 deadline misses, with 0 alloc failures and
        // hundreds of TB free. Landing order is carried by each op's own
        // `landing` plus additionalMsec, not by launch order, so letting a
        // later batch launch first is safe.
        memory.stats.jitQuotaSkips[`launch:${op.role}`] =
          (memory.stats.jitQuotaSkips[`launch:${op.role}`] ?? 0) + 1;
        continue batches;
      }
      let reservation: Reservation | undefined = op.reservation;
      if (!reservation && poolPlan.missThreads >= 1) {
        const allocation = memory.heap.allocate(allocFor(op.kind, poolPlan.missThreads));
        if (!allocation.ok) {
          requestShareStops(memory, actions, Math.max(
            missRequestedGb,
            (memory.farmEnvelopeGb ?? 0) - memory.segmentGb.farm,
          ));
          if (!op.placementBlocked) {
            memory.stats.allocFails++;
            memory.stats.allocFailsByPhase.jit++;
          }
          op.placementBlocked = true;
          return true;
        }
        reservation = allocation.reservation;
      }
      if (
        !op.reservation && (
          heldGbFor(batch, op.role) + (reservation?.gb ?? 0) > roleCapGb + 1e-9 ||
          memory.segmentGb.farm + (reservation?.gb ?? 0) > segmentCapGb + 1e-9
        )
      ) {
        reservation?.release();
        return true;
      }

      const track = (
        hostname: string,
        threads: number,
        effectThreads: number,
        gb: number,
        worker?: { id: number; spawn: boolean },
        /** One-core effect units this call should actually perform, when that
         * is less than the block is worth. Absent = use the whole block. */
        strengthEffect?: number,
      ): void => {
        const opId = memory.nextOpId++;
        const { strengthThreads, usedEffect } = resolveStrength(threads, effectThreads, strengthEffect);
        const reduced = strengthThreads < threads - 1e-9;
        actions.push({
          type: op.kind,
          target: server.hostname,
          source: hostname,
          threads,
          ...(reduced ? { strengthThreads } : {}),
          opId,
          ...(padding > 0 ? { additionalMsec: padding } : {}),
          ...(op.stock ? { stock: true } : {}),
          ...(worker ? { worker } : {}),
        });
        trackOp(memory, opId, {
          hostname,
          target: server.hostname,
          kind: op.kind,
          segment: "farm",
          gb,
          wave: false,
          landing: op.landing,
          effectThreads: usedEffect,
          ...(reduced ? { strengthThreads } : {}),
          jitRole: op.role,
          jitGeneration: batch.generation ?? 0,
          batchId: batch.batchId,
          pendingBatch: batch,
          ...(worker ? { workerId: worker.id, spawned: worker.spawn } : {}),
        });
        memory.inFlight[op.kind]++;
        memory.stats.launched[op.kind]++;
        {
          const entry = memory.stats.jitLaunchLate[op.role];
          const late = now - op.startAt;
          entry.n++;
          entry.sumMs += late;
          entry.maxMs = Math.max(entry.maxMs, late);
          if (late > JIT_LAUNCH_WINDOW_MS) entry.overWindow++;
        }
        if (!worker || worker.spawn) memory.stats.execs++;
        if (op.stock) memory.stats.stockOps++;
        accountRamWork(memory, "farm", op.kind, gb, liveDuration, padding);
        // Deliberately the SPAWNED figures: this pair answers "what are the
        // cores returning for the RAM I paid for", and hack's 1.0 ratio is its
        // control. Charging it the reduced strength would move that control.
        accountThreads(memory, "farm", op.kind, threads, effectThreads);
        noteBatchOp(memory, batch.batchId, op.kind, threads, gb, op.role);
      };

      // The op's reduced strength has to reach the CALLS, or the whole
      // arrival-time clamp is inert. A hack is one call, so its strength maps
      // straight onto it; a pooled grow may be composed from several idle
      // workers, so the reduction is spread across them in proportion to what
      // each was going to perform. Scaling rather than draining a running
      // remainder is what keeps every call at a positive strength — a call
      // asked for zero threads is rejected outright by the engine.
      const blockEffectOf = (blockThreads: number, cores: number): number =>
        op.kind === "hack" ? blockThreads : blockThreads * coreEffect(cores);
      let plannedEffect = 0;
      for (const take of poolPlan.take) plannedEffect += take.strengthEffect;
      for (const block of reservation?.blocks ?? []) {
        plannedEffect += blockEffectOf(block.threads, block.cores);
      }
      const strengthScale =
        op.strengthThreads !== undefined && op.strengthThreads > 0 && plannedEffect > 0
          ? Math.min(1, op.strengthThreads / plannedEffect)
          : 1;

      markJitBatchStarted(memory, batch);
      for (const { worker, strengthEffect } of poolPlan.take) {
        noteJobStart(memory.pool, worker.workerId);
        track(worker.hostname, worker.threads, worker.effectThreads, worker.gb, {
          id: worker.workerId,
          spawn: false,
        }, strengthEffect * strengthScale);
      }
      for (const block of reservation?.blocks ?? []) {
        const workerId = memory.nextOpId++;
        const gb = block.threads * WORKER_RAM[op.kind];
        const effectThreads = blockEffectOf(block.threads, block.cores);
        noteSpawn(
          memory.pool,
          {
            workerId,
            hostname: block.hostname,
            kind: op.kind,
            role: op.role,
            threads: block.threads,
            effectThreads,
            gb,
          },
          now,
        );
        track(
          block.hostname,
          block.threads,
          effectThreads,
          gb,
          { id: workerId, spawn: true },
          strengthScale < 1 ? effectThreads * strengthScale : undefined,
        );
      }
      if (op.reservation) {
        accountReservedPadding(memory, op, now);
        pendingHeld[op.role] = Math.max(0, pendingHeld[op.role] - op.reservation.gb);
        op.reservation = undefined;
        op.reservedAt = undefined;
      } else {
        heldByRole[op.role] += reservation?.gb ?? 0;
        memory.segmentGb.farm += reservation?.gb ?? 0;
      }
      removePendingJitOp(memory, batch, op);
      if (batch.ops.length > 0) {
        const next = batch.ops.reduce((best, candidate) =>
          candidate.startAt < best.startAt ? candidate : best
        );
        const actualLanding = now + liveDuration + Math.max(0, padding);
        const relativeLanding = next.landing - op.landing;
        next.landing = actualLanding + relativeLanding;
        next.startAt = next.landing - opDurationMs(
          next.kind,
          ctx,
          server.hackDifficulty,
          required,
        ) - JIT_LAUNCH_GUARD_MS;
        next.reserveAt = next.startAt - (JIT_LAUNCH_GUARD_MS - WORKER_STARTUP_GUARD_MS);
      }
      emitted += poolPlan.take.length + (reservation?.blocks.length ?? 0);
    }
  }
  if (hotWake) {
    for (const batch of pipeline) queueBatchWake(memory, batch);
  } else {
    compactJitPipeline(memory, server.hostname);
  }
  return true;
}

function planJitBatches(
  memory: DispatchMemory,
  solution: CycleSolution,
  server: ServerView,
  now: number,
  ctx: HackContext,
  schedule: JitSchedule,
  /** Hack context projected to a future instant — see landingCtxFactory. */
  ctxAt: (horizonMs: number) => HackContext,
  influence?: StockInfluence,
): void {
  const required = server.requiredHackingSkill;
  const weakenMs = opDurationMs("weaken", ctx, server.hackDifficulty, required);
  const worstWeakenMs = opDurationMs("weaken", ctx, jitWorstDifficulty(solution, server), required);
  const maxDepth = Math.max(1, 1 + Math.ceil(worstWeakenMs / schedule.intervalMs));
  const statics = staticsOf(server);
  // Farm ops only ever launch at min security (enforced in launchDueJit), so
  // that is the security their durations are priced at. Anything higher would
  // make every start time earlier than needed and be paid as additionalMsec.
  const worstDifficulty = jitWorstDifficulty(solution, server);
  // Fold the existing pipeline once, and not until something asks. Each pass
  // may append eight batches, and a fresh walk of every tracked and pending
  // operation for every append made planning quadratic at the deep pipelines
  // unlocked by late-game RAM. Building it up front instead was still wasted
  // whenever the loop's first act — a depth guard a settled pipeline trips
  // immediately — returned before reading a single op.
  let builtPlanningLedger: LedgerOp[] | undefined;
  let planningOpId = 0;
  const planningLedgerOf = (): LedgerOp[] => {
    if (!builtPlanningLedger) {
      builtPlanningLedger = jitLedger(memory, server.hostname);
      // Pending ids continue below the ops already in the ledger; see
      // `jitLedgerEntries` on why the descending sequence must not have gaps.
      planningOpId = -builtPlanningLedger.length - 1;
    }
    return builtPlanningLedger;
  };
  let planningLedgerAt = 0;
  let planningFoldAt = -Infinity;
  let planningState: PredictedState = {
    hackDifficulty: server.hackDifficulty,
    moneyAvailable: server.moneyAvailable,
  };
  const predictedAt = (anchor: number): PredictedState => {
    const ledger = planningLedgerOf();
    if (anchor < planningFoldAt) {
      return predictAtLanding(
        ctx,
        statics,
        { hackDifficulty: server.hackDifficulty, moneyAvailable: server.moneyAvailable },
        ledger,
        anchor,
        true,
      );
    }
    planningFoldAt = anchor;
    while (planningLedgerAt < ledger.length && ledger[planningLedgerAt]!.landing <= anchor) {
      planningState = applyLedgerOp(ctx, statics, planningState, ledger[planningLedgerAt]!);
      planningLedgerAt++;
    }
    return planningState;
  };
  const pending = (
    role: JitRole["role"],
    kind: PendingJitOp["kind"],
    threads: number,
    landing: number,
    stock: boolean,
  ): PendingJitOp => ({
    target: server.hostname,
    role,
    kind,
    threads,
    startAt: landing - opDurationMs(kind, ctx, worstDifficulty, required) - JIT_LAUNCH_GUARD_MS,
    landing,
    stock,
  });

  // Pending ops are not processes yet, but every one of them is a process the
  // moment its deadline arrives, so the ceiling has to be applied where depth
  // is COMMITTED rather than only where it is launched. Planning past it would
  // just build a queue that launchDueJit then refuses.
  const opsPerBatch = opsPerBatchFor(solution.kind);
  for (let planned = 0; planned < MAX_JIT_BATCHES_PER_MAINTENANCE; planned++) {
    const targetDepth = targetJitQueue(memory, server.hostname).length;
    if (targetDepth + memory.inFlight.hack >= maxDepth) return;
    if (
      liveProcessCount(memory) + memory.pendingJitOpCount + opsPerBatch >
        MAX_LIVE_WORKERS
    ) {
      memory.stats.capped.processes++;
      return;
    }
    // A cheap floor only: the exact one depends on batchWorstDifficulty, which
    // is not known until the batch is sized, so any startAt still left in the
    // past is corrected by the shift below.
    //
    // The third term only ever binds on a RE-ANCHOR. Within a pipeline
    // `lastAnchor` is monotone (every anchor is at least one interval past the
    // previous one), so a shrinking interval cannot walk a new landing back
    // into an old one. After a reset (`abandonJitPending` and friends set
    // `lastAnchor` to -Infinity) the floor is just `now + weakenMs`, and a
    // weaken that has just got SHORTER — which is exactly what an IPvGO win
    // against Illuminati does, and is also a plausible cause of the desync
    // reset that got us here — places that floor INSIDE the tail of the
    // abandoned pipeline, whose landings were laid out on the longer horizon.
    // Two effects a few milliseconds apart are not ordered by anything, so the
    // new batch's hack can land under the old pipeline's cover instead of its
    // own. Clearing the last in-flight landing by one interval costs nothing
    // when nothing is in flight, which is the common re-anchor.
    let anchor = Math.max(
      now + weakenMs,
      memory.lastAnchor + schedule.intervalMs,
    );
    if (memory.lastAnchor === -Infinity) {
      const tail = lastLandingOn(memory, server.hostname);
      if (tail > -Infinity) anchor = Math.max(anchor, tail + schedule.intervalMs);
    }
    const predicted = predictedAt(anchor);
    const sized = sizeBatchAtLanding(ctx, statics, predicted, solution);
    if (!sized) {
      if (noteJitDecisionMissedWindow(memory, memory.jitDecisionId, "arrival-security")) {
        noteBatchSkipped(memory, "arrival-security");
      }
      return;
    }
    const ops: PendingJitOp[] = solution.kind === "hgw"
      ? [
          pending("w2", "weaken", sized.weaken2Threads, anchor + 2 * SPACER_MS, false),
          pending("g", "grow", sized.growThreads, anchor + SPACER_MS, influence?.side === "long"),
          pending("h", "hack", sized.hackThreads, anchor, influence?.side === "short"),
        ]
      : [
          pending("w1", "weaken", sized.weaken1Threads, anchor + SPACER_MS, false),
          pending("w2", "weaken", sized.weaken2Threads, anchor + 3 * SPACER_MS, false),
          pending("g", "grow", sized.growThreads, anchor + 2 * SPACER_MS, influence?.side === "long"),
          pending("h", "hack", sized.hackThreads, anchor, influence?.side === "short"),
        ];
    const pendingGrow = ops.find((op) => op.kind === "grow");
    if (pendingGrow) {
      // W2 always runs at its full spawned strength, so its planned effect
      // units are exactly the security budget available. How much of that
      // budget belongs to the GROW depends on the shape: HWGW puts W1 between
      // the hack and the grow, so W2 covers the grow alone, while HGW has no
      // W1 and its single W2 must also absorb the hack's fortify and whatever
      // security the batch was admitted above minimum.
      const coverAmount = sized.weaken2Threads * weakenEffect(ctx, 1, 1);
      const growShare = solution.kind === "hgw"
        ? coverAmount -
          Math.max(0, predicted.hackDifficulty - statics.minDifficulty) -
          HACK_FORTIFY * sized.hackThreads
        : coverAmount;
      pendingGrow.coverThreads = Math.max(0, growShare) / GROW_FORTIFY;
    }
    const pendingHack = ops.find((op) => op.kind === "hack");
    if (pendingHack) {
      pendingHack.baseHackThreads = solution.hackThreads;
      // Level lookahead. The hack's PERCENTAGE is read when it lands, so at a
      // higher level the same thread count steals more than the grow beside it
      // was sized to restore. Deliberately NOT re-solved: changing the thread
      // count would move ramPerBatch, the role envelope and therefore the
      // cadence. Hold the size and ask for the strength that yields the steal
      // this batch was actually built around. Skewing the horizon late (plus
      // one launch guard) over-estimates the level, which under-steals — the
      // recoverable direction.
      const landingCtx = ctxAt(pendingHack.landing - now + JIT_LAUNCH_GUARD_MS);
      if (landingCtx !== ctx) {
        const percentAtLanding = hackPercent(landingCtx, statics.minDifficulty, required);
        if (percentAtLanding > 0) {
          const forSteal = solution.stealFraction / percentAtLanding;
          if (forSteal < pendingHack.threads) {
            pendingHack.planStrengthThreads = forSteal;
            pendingHack.strengthThreads = forSteal;
          }
        }
      }
    }
    const batchWorstDifficulty = jitWorstDifficultyFor(
      solution.kind,
      sized.hackThreads,
      sized.growThreads,
      server,
    );
    for (const op of ops) {
      op.startAt = op.landing - opDurationMs(op.kind, ctx, batchWorstDifficulty, required) - JIT_LAUNCH_GUARD_MS;
    }
    // An op whose startAt is already in the past can never launch on time, and
    // the whole batch depends on it. Shift by the exact deficit rather than
    // padding the anchor with a worst-case guess: the anchor is chosen before
    // batchWorstDifficulty is known, so a guess large enough to always cover
    // this would cost cadence on every batch instead of the rare one.
    const deficit = ops.reduce((worst, op) => Math.max(worst, now - op.startAt), 0);
    if (deficit > 0) {
      anchor += deficit;
      for (const op of ops) {
        op.landing += deficit;
        op.startAt += deficit;
      }
    }
    orderJitStarts(ops);
    for (const op of ops) {
      op.reserveAt = op.startAt - (JIT_LAUNCH_GUARD_MS - WORKER_STARTUP_GUARD_MS);
    }
    const retained = ops.filter((op) => op.threads >= 1);
    enqueueJitBatch(memory, {
      target: server.hostname,
      ops: retained,
      batchId: openBatch(memory, solution.kind === "hgw" ? "hgw" : "hwgw", server.hostname, "farm", now),
      decisionId: memory.jitDecisionId,
      generation: memory.jitGenerationByTarget.get(server.hostname) ?? 0,
    });
    for (const op of [...retained].sort((a, b) => a.landing - b.landing)) {
      planningLedgerOf().push({
        kind: op.kind,
        threads: op.threads,
        effectThreads: op.threads,
        landing: op.landing,
        opId: planningOpId--,
      });
    }
    memory.lastAnchor = anchor;
  }
}

function launchBatches(
  memory: DispatchMemory,
  actions: Action[],
  solution: CycleSolution,
  server: ServerView,
  now: number,
  budgetGb: number,
  segmentCapGb: number,
  ctx: HackContext,
  /** What `stock` wants this host's symbol to do, when it wants anything.
   *  Exactly ONE side of the batch carries the flag: a long is driven by the
   *  grow and a short by the hack. Flagging both would cancel the nudges out —
   *  in steady state the grow restores precisely what the hack took, so the two
   *  influence rolls are equal and opposite. */
  influence?: StockInfluence,
  pooling = false,
  shotgun = false,
  jit = true,
  /** Extra prep RAM this pass may borrow. Every op of a batch using it must
   * land before the current prep wave, so the next wave can reclaim it. */
  borrow?: { gb: number; landingDeadline: number },
  hostBlocksGb?: readonly number[],
  reservationMode: JitReservationMode = "protected",
  /** Hack context projected to a future instant, used by the JIT and eager
   * paths alike. Shotgun ignores it: it lands a whole batch in one tick, so
   * there is no launch-to-landing gap for a level to move in. The default is
   * "no projection", for callers that have no exp-rate estimate yet. */
  ctxAt: (horizonMs: number) => HackContext = () => ctx,
  /** False while a previously committed pipeline drains into a smaller farm
   * segment. Existing cursors still launch; only creation of new batches is
   * stopped, so prep gains capacity as the remaining role peak falls. */
  admitJitBatches = true,
): void {
  const host = server.hostname;
  const difficulty = server.hackDifficulty;
  const required = server.requiredHackingSkill;
  const hackMs = hackTimeSeconds(ctx, difficulty, required) * 1_000;
  const growMs = growTimeSeconds(ctx, difficulty, required) * 1_000;
  const weakenMs = weakenTimeSeconds(ctx, difficulty, required) * 1_000;
  // HGW batches have three landings, so their interval is one spacer shorter.
  const intervalMs = solution.kind === "hgw" ? HGW_MIN_INTERVAL_MS : INTERVAL_MS;

  // Proper steady-state JIT. The integer role envelope is a real capacity
  // guarantee (not average-RAM wishful accounting): if it fits, weakens launch
  // first and the shorter grow/hack processes wait outside RAM until their
  // conservative start windows. Borrowed prep RAM has a return deadline and
  // shotgun deliberately relies on same-tick FIFO, so both retain the eager
  // batch-atomic implementation below.
  if (jit && memory.mode !== "shotgun" && !shotgun && borrow === undefined) {
    const drainingRuntime = !admitJitBatches && targetJitQueue(memory, host).length > 0
      ? memory.jitRuntimeByTarget.get(host)
      : undefined;
    // During a generational handoff the incoming schedule is sized against
    // what the retiring generation has not yet released; it re-fits (and
    // speeds up) each pass as that drains — back-fill, not flush.
    const scheduleCapGb = Math.max(0, segmentCapGb - retiringCommittedGb(memory, host));
    let jitSolution = drainingRuntime?.solution ?? solution;
    let roles = jitRoles(jitSolution, server, ctx, pooling);
    let schedule = drainingRuntime?.schedule ?? chooseJitSchedule(
        roles,
        scheduleCapGb,
        intervalMs,
        hostBlocksGb ? { hostBlocksGb, divisibleBlockGb: WORKER_RAM.weaken } : undefined,
      );
    let worstWeakenMs = opDurationMs("weaken", ctx, jitWorstDifficulty(jitSolution, server), required);
    // A solve can grow by a few hack threads after a level/fleet generation
    // while the physical topology is unchanged. If that larger atomic hack no
    // longer packs, keep the last executable solve and recompute its cadence
    // against TODAY'S segment and hosts. This is the normal downscale path:
    // preserve JIT windows and income instead of flushing support and falling
    // into weaken-time hack padding merely because the newest optimum is too
    // large to place.
    if (!drainingRuntime && (!schedule || schedule.intervalMs >= worstWeakenMs)) {
      const cached = memory.jitRuntimeByTarget.get(host);
      // The cache belongs to this target and mode and is consulted only after
      // the current optimum failed. Retargets/mode changes clear it, while a
      // later topology expansion retries the optimum before this branch, so a
      // substantially smaller executable solve is continuity, not pinning.
      if (cached && cached.solution.kind === solution.kind) {
        const fallbackRoles = jitRoles(cached.solution, server, ctx, pooling);
        const fallback = chooseJitSchedule(
          fallbackRoles,
          scheduleCapGb,
          cached.solution.kind === "hgw" ? HGW_MIN_INTERVAL_MS : INTERVAL_MS,
          hostBlocksGb ? { hostBlocksGb, divisibleBlockGb: WORKER_RAM.weaken } : undefined,
        );
        const fallbackWorstWeakenMs = opDurationMs(
          "weaken",
          ctx,
          jitWorstDifficulty(cached.solution, server),
          required,
        );
        if (fallback && fallback.intervalMs < fallbackWorstWeakenMs) {
          jitSolution = cached.solution;
          roles = fallbackRoles;
          schedule = fallback;
          worstWeakenMs = fallbackWorstWeakenMs;
        }
      }
    }
    if (!schedule || schedule.intervalMs >= worstWeakenMs) {
      // Neither the optimum nor its last executable shape fits the new farm
      // allotment. Solve the same target/mode under the actual segment and
      // atomic-host caps. This is a genuine JIT downscale: it changes batch
      // strength, not timing safety, and is attempted only on a rare capacity
      // transition rather than on every pump.
      const largestBlockGb = Math.min(scheduleCapGb, hostBlocksGb?.[0] ?? scheduleCapGb);
      const manipulation = influence && influence.valuePerOp > 0
        ? { valuePerOp: influence.valuePerOp, side: influence.side }
        : undefined;
      const downscaled = solveCycle(ctx, staticsOf(server), 1, {
        batchGb: Math.max(WORKER_RAM_FLOOR, scheduleCapGb),
        hackBlockGb: Math.max(WORKER_RAM_FLOOR, largestBlockGb),
        growBlockGb: Math.max(WORKER_RAM_FLOOR, largestBlockGb),
        ...(hostBlocksGb ? { hostBlocksGb: [...hostBlocksGb] } : {}),
        farmGb: Math.max(WORKER_RAM_FLOOR, scheduleCapGb),
      }, manipulation, solution.kind);
      if (downscaled) {
        const downscaledRoles = jitRoles(downscaled, server, ctx, pooling);
        const downscaledSchedule = chooseJitSchedule(
          downscaledRoles,
          scheduleCapGb,
          downscaled.kind === "hgw" ? HGW_MIN_INTERVAL_MS : INTERVAL_MS,
          hostBlocksGb ? { hostBlocksGb, divisibleBlockGb: WORKER_RAM.weaken } : undefined,
        );
        const downscaledWorstWeakenMs = opDurationMs(
          "weaken",
          ctx,
          jitWorstDifficulty(downscaled, server),
          required,
        );
        if (downscaledSchedule && downscaledSchedule.intervalMs < downscaledWorstWeakenMs) {
          jitSolution = downscaled;
          roles = downscaledRoles;
          schedule = downscaledSchedule;
          worstWeakenMs = downscaledWorstWeakenMs;
        }
      }
    }
    if (schedule && schedule.intervalMs < worstWeakenMs) {
      const roleGb = emptyJitRoleCounts();
      for (const role of roles) roleGb[role.role] = role.gb;
      if (drainingRuntime) {
        // The hot wake consumes this cap without revisiting segment policy.
        // Tighten it as the retained peak falls, while preserving the old role
        // schedule which the remaining batches were committed against.
        drainingRuntime.segmentCapGb = segmentCapGb;
        drainingRuntime.reservationMode = reservationMode;
      } else {
        memory.jitRuntimeByTarget.set(host, {
          solution: jitSolution,
          schedule,
          segmentCapGb,
          pooling,
          reservationMode,
          roleGb,
          generation: memory.jitGenerationByTarget.get(host) ?? 0,
        });
      }
      // Saturation is the minimum-interval role envelope, not the envelope of
      // the slower cadence today's fleet can afford. Infrastructure purchases
      // may unlock each faster step, so treating the present cadence as an
      // absolute cap creates a self-fulfilling RAM-growth stall.
      memory.depthCapGb = jitSolution.jitSaturationGb ?? jitCapacity(roles, intervalMs).totalGb;
      memory.depthCapHost = host;
      // The executable envelope: what a sustained pipeline on this target
      // actually holds. Share reserves against it (see the share block in
      // `dispatch`) so a freely-preemptible tenant can never occupy RAM the
      // farm is about to reclaim for its next batch.
      memory.farmEnvelopeGb = schedule.totalGb;
      // How much the farm can newly claim before a share stop could land.
      // `planJitBatches` runs earlier in this same pass and its weakens launch
      // immediately, so that RAM cannot be recovered by asking share for it
      // afterwards — which is precisely why a reserve is needed even though
      // share is preemptible and prep/other batches are not.
      memory.farmPassDemandGb = MAX_BATCHES_PER_PASS * jitSolution.ramPerBatch;
      if (!launchDueJit(memory, actions, server, now, ctx, schedule, segmentCapGb, pooling, reservationMode, ctxAt)) return;
      if (admitJitBatches && !memory.drainingJitTargets.has(host)) {
        planJitBatches(memory, jitSolution, server, now, ctx, schedule, ctxAt, influence);
      }
      launchDueJit(memory, actions, server, now, ctx, schedule, segmentCapGb, pooling, reservationMode, ctxAt);
      return;
    }
    // A shrinking allotment is a drain, never permission to open an eager
    // replacement wave. With no pending cursor left, resident farm workers
    // simply finish and the retained claim falls on their completions.
    if (!admitJitBatches) return;
    // Pending batches have not launched their hack yet. If the farm segment
    // shrank below the executable role envelope, abandon them safely and let
    // the simple atomic path take over once the target is genuinely prepped.
    if (targetJitQueue(memory, host).length > 0) {
      abandonJitTarget(memory, host, now);
      memory.lastAnchor = -Infinity;
      if (!isPrepped(server)) return;
    }
  }
  const maxDepth = Math.max(1, Math.floor(weakenMs / intervalMs));
  let remaining = budgetGb;
  let nominalRemaining = Math.max(0, budgetGb - (borrow?.gb ?? 0));
  const consumeAllocation = (gb: number): void => {
    remaining -= gb;
    nominalRemaining = Math.max(0, nominalRemaining - gb);
  };

  // The in-flight ledger for THIS target, materialised once and then topped up
  // so batch N+1's prediction still sees batch N's ops.
  //
  // Rebuilding it per batch walked every op in flight each time; at late-game
  // depth that was the largest single entry in a profile of the running game.
  // `trackOp`/`untrackOp` are the only writers of `byTarget` and this loop only
  // ever adds, so entries already consumed cannot change underneath us — and
  // reading them back gives the real opIds and core-adjusted `effectThreads`
  // that synthesising entries from the planned batch would have got wrong.
  const ledgerOps: LedgerOp[] = [];
  let consumed = 0;
  const ledger = (): LedgerOp[] => {
    const onTarget = memory.byTarget.get(host);
    if (!onTarget || onTarget.size === consumed) return ledgerOps;
    // Walk the map but build only what is new. A Map iterator held across
    // calls does NOT work here: it visits entries appended mid-iteration, but
    // once it has reported `done` it is finished for good, so it silently
    // stopped yielding the ops this loop had just tracked. The skip is a bare
    // counter loop; the allocation, `trackedStrength`, and the ordered insert
    // are what cost, and those still happen once per op.
    let index = 0;
    for (const [opId, t] of onTarget) {
      if (index++ < consumed) continue;
      if (t.landing === undefined) continue;
      const threads = trackedStrength(t);
      const op = { kind: t.kind, threads, effectThreads: t.effectThreads ?? threads, landing: t.landing, opId };
      // Insert in `compareLedgerOps` order rather than appending and letting
      // every consumer re-sort. Insertion order is opId order, which is NOT
      // landing order, so the position has to be searched for — but only for
      // the handful of ops added since the last call.
      let lo = 0;
      let hi = ledgerOps.length;
      while (lo < hi) {
        const mid = (lo + hi) >>> 1;
        if (compareLedgerOps(ledgerOps[mid]!, op) <= 0) lo = mid + 1;
        else hi = mid;
      }
      ledgerOps.splice(lo, 0, op);
    }
    consumed = onTarget.size;
    return ledgerOps;
  };
  const statics = staticsOf(server);

  const perPass = shotgun ? SHOTGUN_BATCHES_PER_PASS : MAX_BATCHES_PER_PASS;
  // Both rails are read at BATCH granularity. Emitting a partial batch would
  // put a hack in flight whose weaken cover was never launched, so a rail that
  // trips has to stop the whole batch before its first action, never between.
  const actionsAtPassStart = actions.length;
  const opsPerBatch = opsPerBatchFor(solution.kind);
  for (let launched = 0; launched < perPass; launched++) {
    const batchesInFlight = memory.inFlight.hack;
    // Shotgun has no interleave to protect — depth is bounded by RAM, by the
    // live-process ceiling, and by the per-pass emission bound below.
    if (!shotgun && batchesInFlight >= maxDepth) return;
    // A batch is at most one process per op; requiring the whole batch to fit
    // keeps the check batch-atomic like the two above it.
    if (liveProcessCount(memory) + opsPerBatch > MAX_LIVE_WORKERS) {
      memory.stats.capped.processes++;
      return;
    }
    if (actions.length - actionsAtPassStart + opsPerBatch > MAX_LAUNCH_ACTIONS_PER_PASS) {
      memory.stats.capped.passActions++;
      return;
    }
    // Under pooling the budget check moves after the pool plan — a batch
    // composed entirely of idle workers needs no new RAM at all.
    if (!pooling && remaining < solution.ramPerBatch) return;

    // Anchor. Batched modes: far enough out that every padding is positive,
    // and at least one interval after the previous batch (collision guard).
    // Shotgun: every op of every batch this pass lands at the SAME instant —
    // now + weakenTime, the weakens' natural landing — and the engine's
    // observed equal-deadline FIFO behavior is intended to turn launch order
    // into arrival order. Batches are emitted H, G, W: after
    // batch N's W the server is back at (minSec, moneyMax), so batch N+1's
    // sizing is exact at its own arrival. That is also why the emit order
    // here is hack-first, unlike batched modes' weaken-first landings. Upstream
    // preserves exec/start order through cached-module promise continuations,
    // but does not expose same-deadline ordering as a Netscript API contract.
    // Source: https://github.com/bitburner-official/bitburner-src/blob/3162fd2590e221eadd0c0fbd46151913f7c4c41c/src/NetscriptWorker.ts#L48-L66
    const anchor = shotgun
      // Even weaken needs positive padding: its worker starts asynchronously,
      // so `now + weakenMs` would make it land after the shared FIFO deadline.
      ? now + weakenMs + JIT_LAUNCH_GUARD_MS
      // A launch budget, not a landing separation: ops are placed at
      // `landing - duration - JIT_LAUNCH_GUARD_MS`, so an anchor closer than
      // that guard puts the first weaken's startAt in the past and the whole
      // batch is dropped.
      : Math.max(now + weakenMs + JIT_LAUNCH_GUARD_MS, memory.lastAnchor + intervalMs);

    // Landing-state prediction (Q1): fold the in-flight ledger to the hack's
    // landing. isPrepped admits min+1 sec / 90 % money, so sizing against the
    // LIVE state under-steals and over/under-grows; sizing against the
    // PREDICTED state keeps the money band tight. A predicted security above
    // the tolerance skips the batch outright — percent and duration
    // assumptions would both be wrong.
    const predicted = predictAtLanding(
      ctx,
      statics,
      { hackDifficulty: server.hackDifficulty, moneyAvailable: server.moneyAvailable },
      // `ledger()` maintains landing order, so the fold skips the filtered
      // copy and the re-sort it would otherwise pay on every batch.
      ledger(),
      anchor,
      true,
    );
    const sized = sizeBatchAtLanding(ctx, statics, predicted, solution);
    if (!sized) {
      noteBatchSkipped(memory, "arrival-security");
      noteMissedWindow(memory, "arrival-security");
      return;
    }
    const safeHackThreads = hackThreadsAtLanding(ctx, statics, predicted, solution.hackThreads) ?? 0;
    if (safeHackThreads < solution.hackThreads) {
      noteMissedWindow(memory, "arrival-money");
      if (safeHackThreads < 1) {
        noteBatchSkipped(memory, "arrival-money");
      }
    }
    // `hackThreadsAtLanding` is UNROUNDED by design, so the correction rides on
    // the call's strength instead of costing a whole thread. A process count is
    // an integer though, and hack is not core-aware, so `allocFor` passes
    // `threads` through verbatim and a fraction would reach `ns.exec`. Spawn
    // the ceiling, carry the remainder as strength — what the JIT path does,
    // and what the reference's worker does (scripts/worker.ts:23-46).
    const hackThreads = Math.min(solution.hackThreads, Math.ceil(safeHackThreads));
    // Level lookahead, same rule and rationale as the JIT path above. Only the
    // exemption differs: SHOTGUN lands its whole batch in one engine tick, so
    // no level can move between launch and landing, while an eager HWGW batch
    // still lands a full weaken-time out and needs the cap.
    let levelStrength = Infinity;
    if (!shotgun) {
      const landingCtx = ctxAt(anchor - now + JIT_LAUNCH_GUARD_MS);
      if (landingCtx !== ctx) {
        const percentAtLanding = hackPercent(landingCtx, statics.minDifficulty, required);
        if (percentAtLanding > 0) levelStrength = solution.stealFraction / percentAtLanding;
      }
    }
    const cappedStrength = Math.min(safeHackThreads, levelStrength);
    const hackStrength = cappedStrength < hackThreads - 1e-9 ? cappedStrength : undefined;

    const ops = (
      shotgun
        ? solution.kind === "hgw"
          ? [
              { kind: "hack" as const, threads: hackThreads, duration: hackMs, landing: anchor, stock: influence?.side === "short" },
              { kind: "grow" as const, threads: sized.growThreads, duration: growMs, landing: anchor, stock: influence?.side === "long" },
              { kind: "weaken" as const, threads: sized.weaken2Threads, duration: weakenMs, landing: anchor, stock: false },
            ]
          : [
              { kind: "hack" as const, threads: hackThreads, duration: hackMs, landing: anchor, stock: influence?.side === "short" },
              { kind: "weaken" as const, threads: sized.weaken1Threads, duration: weakenMs, landing: anchor, stock: false },
              { kind: "grow" as const, threads: sized.growThreads, duration: growMs, landing: anchor, stock: influence?.side === "long" },
              { kind: "weaken" as const, threads: sized.weaken2Threads, duration: weakenMs, landing: anchor, stock: false },
            ]
        : solution.kind === "hgw"
        ? [
            { kind: "hack" as const, threads: hackThreads, duration: hackMs, landing: anchor, stock: influence?.side === "short" },
            { kind: "grow" as const, threads: sized.growThreads, duration: growMs, landing: anchor + SPACER_MS, stock: influence?.side === "long" },
            { kind: "weaken" as const, threads: sized.weaken2Threads, duration: weakenMs, landing: anchor + 2 * SPACER_MS, stock: false },
          ]
        : [
            { kind: "hack" as const, threads: hackThreads, duration: hackMs, landing: anchor, stock: influence?.side === "short" },
            { kind: "weaken" as const, threads: sized.weaken1Threads, duration: weakenMs, landing: anchor + SPACER_MS, stock: false },
            { kind: "grow" as const, threads: sized.growThreads, duration: growMs, landing: anchor + 2 * SPACER_MS, stock: influence?.side === "long" },
            { kind: "weaken" as const, threads: sized.weaken2Threads, duration: weakenMs, landing: anchor + 3 * SPACER_MS, stock: false },
          ]
    ).filter((op) => op.threads >= 1);

    const finalLanding = ops.reduce((latest, op) => Math.max(latest, op.landing), -Infinity);
    const oneCoreBatchGb = ops.reduce((gb, op) => gb + op.threads * WORKER_RAM[op.kind], 0);
    if (!pooling && borrow && oneCoreBatchGb > nominalRemaining && finalLanding >= borrow.landingDeadline) {
      return;
    }

    if (ops.some((op) => op.landing - now - op.duration < 0)) {
      noteBatchSkipped(memory, "deadline");
      noteMissedWindow(memory, "deadline");
      return;
    }

    // Registered LAZILY, on the first op actually emitted. Opening it here
    // instead leaves a record behind on every path that still returns without
    // launching (both allocations below can fail), and a zero-op batch never
    // settles: it sits in `memory.batches` until the bound evicts it, pushing
    // out live batches whose landings are still being counted.
    let openedBatchId = 0;
    const batchOf = (): number =>
      (openedBatchId ||= openBatch(
        memory,
        shotgun ? "shotgun" : solution.kind === "hgw" ? "hgw" : "hwgw",
        host,
        "farm",
        now,
      ));

    const emitOp = (
      op: (typeof ops)[number],
      hostname: string,
      threads: number,
      effectThreads: number,
      gb: number,
      worker?: { id: number; spawn: boolean },
      /** One-core effect this call should perform, when a reused worker is
       * larger than the op needs. Absent = use the whole block. */
      strengthEffect?: number,
    ): void => {
      const opId = memory.nextOpId++;
      // Two independent ceilings on the same call: the batch-level hack
      // strength (arrival money, and the landing-level cap) and the pool's
      // block-level one when a reused worker is larger than the op needs.
      // The binding constraint is whichever is smaller.
      const effectCap = op.kind === "hack" && hackStrength !== undefined
        ? Math.min(strengthEffect ?? Infinity, hackStrength)
        : strengthEffect;
      const { strengthThreads, usedEffect } = resolveStrength(threads, effectThreads, effectCap);
      const reduced = strengthThreads < threads - 1e-9;
      actions.push({
        type: op.kind,
        target: host,
        source: hostname,
        threads,
        ...(reduced ? { strengthThreads } : {}),
        opId,
        additionalMsec: op.landing - now - op.duration,
        ...(op.stock ? { stock: true } : {}),
        ...(worker ? { worker } : {}),
      });
      trackOp(memory, opId, {
        hostname,
        target: host,
        kind: op.kind,
        segment: "farm",
        gb,
        wave: false,
        landing: op.landing,
        effectThreads: usedEffect,
        ...(reduced ? { strengthThreads } : {}),
        batchId: batchOf(),
        ...(worker ? { workerId: worker.id, spawned: worker.spawn } : {}),
      });
      memory.inFlight[op.kind]++;
      memory.stats.launched[op.kind]++;
      if (op.stock) memory.stats.stockOps++;
      if (!worker || worker.spawn) memory.stats.execs++;
      accountRamWork(memory, "farm", op.kind, gb, op.duration, op.landing - now - op.duration);
      // No jitRole: this path emits a whole batch at once rather than onto a
      // landing grid, so it has no intra-batch order to verify. It is still a
      // batch, and still worth measuring as one.
      accountThreads(memory, "farm", op.kind, threads, effectThreads);
      noteBatchOp(memory, batchOf(), op.kind, threads, gb);
    };

    if (!pooling) {
      const allocation = memory.heap.allocateAll(ops.map((op) => allocFor(op.kind, op.threads)));
      if (!allocation.ok) {
        memory.stats.allocFails++;
        memory.stats.allocFailsByPhase.eager++;
        return;
      }
      memory.lastAnchor = anchor;
      ops.forEach((op, index) => {
        const reservation = allocation.reservations[index]!;
        for (const block of reservation.blocks) {
          // One action per block; the reservation is shared, so it is released
          // when the LAST block of the op completes (release is idempotent and
          // guarded by tracked-map membership).
          emitOp(
            op,
            block.hostname,
            block.threads,
            op.kind === "hack" ? block.threads : block.threads * coreEffect(memory.heap.host(block.hostname)?.cores ?? 1),
            block.threads * WORKER_RAM[op.kind],
          );
        }
        consumeAllocation(reservation.gb);
        memory.segmentGb.farm += reservation.gb;
      });
      continue;
    }

    // Pooled path: compose each op from idle serve workers first (their RAM is
    // already committed — a pool hit costs no allocation and no exec), then
    // batch-atomically allocate only the remainders and SPAWN workers on those
    // blocks. Within a regime every batch repeats the same thread counts, so
    // after spin-up nearly every op is a pool hit.
    // Planning is batch-atomic, so workers cannot be marked busy until every
    // op and every miss is placeable. Reserve IDs locally as each op plans;
    // otherwise W1 and W2 can both select the same idle weaken worker and the
    // serve loop runs their timed jobs sequentially.
    const reservedWorkers = new Set<number>();
    const plans = ops.map((op) => {
      const plan = planTake(memory.pool, op.kind, op.threads, reservedWorkers);
      for (const { worker } of plan.take) reservedWorkers.add(worker.workerId);
      return plan;
    });
    const missGb = plans.reduce((sum, plan, i) => sum + plan.missThreads * WORKER_RAM[ops[i]!.kind], 0);
    if (remaining < missGb) return;
    if (borrow && missGb > nominalRemaining && finalLanding >= borrow.landingDeadline) return;
    const missRequests = ops
      .map((op, i) => ({ op, miss: plans[i]!.missThreads }))
      .filter((entry) => entry.miss >= 1)
      .map((entry) => allocFor(entry.op.kind, entry.miss));
    let reservations: { blocks: { hostname: string; threads: number }[]; gb: number }[] = [];
    if (missRequests.length > 0) {
      const allocation = memory.heap.allocateAll(missRequests);
      if (!allocation.ok) {
        memory.stats.allocFails++;
        memory.stats.allocFailsByPhase.eager++;
        return;
      }
      reservations = allocation.reservations;
    }
    memory.lastAnchor = anchor;
    let reservationIndex = 0;
    ops.forEach((op, index) => {
      const plan = plans[index]!;
      for (const { worker, strengthEffect } of plan.take) {
        noteJobStart(memory.pool, worker.workerId);
        emitOp(op, worker.hostname, worker.threads, worker.effectThreads, worker.gb, {
          id: worker.workerId,
          spawn: false,
        }, strengthEffect);
      }
      if (plan.missThreads >= 1) {
        const reservation = reservations[reservationIndex++]!;
        for (const block of reservation.blocks) {
          const workerId = memory.nextOpId++;
          const gb = block.threads * WORKER_RAM[op.kind];
          const effectThreads =
            op.kind === "hack" ? block.threads : block.threads * coreEffect(memory.heap.host(block.hostname)?.cores ?? 1);
          noteSpawn(
            memory.pool,
            { workerId, hostname: block.hostname, kind: op.kind, threads: block.threads, effectThreads, gb },
            now,
          );
          emitOp(op, block.hostname, block.threads, effectThreads, gb, { id: workerId, spawn: true });
        }
        consumeAllocation(reservation.gb);
        memory.segmentGb.farm += reservation.gb;
      }
    });
  }
}

/** Prep fires in non-overlapping waves per host: while any prep op for a host
 * is in flight we wait, so plans can never overshoot. */
function launchPrepWave(
  memory: DispatchMemory,
  actions: Action[],
  view: WorldView,
  server: ServerView,
  budgetGb: number,
  segment: SegmentKind,
): void {
  // A normal farm batch exposes deliberately transient money/security states
  // between H, W1, G, and W2. Completion wakes can schedule this function at
  // any of those landings, so never interpret that midpoint as a prep need.
  // Once the final tracked batch op lands, a genuine desync may prep normally.
  for (const tracked of memory.byTarget.get(server.hostname)?.values() ?? []) {
    if (tracked.segment === "farm" && !tracked.wave) return;
  }
  if (memory.prepPending.some((op) => op.target === server.hostname)) return;
  if ((memory.prepInFlight.get(server.hostname) ?? 0) > 0) return;

  const ctx = memory.evaluator.ctx;
  if (!ctx) return;

  // Solve the prep plan for THIS host (µs-cheap) rather than reusing another
  // host's plan: weaken to min security first, then grow to max money.
  const plan = solvePrep(ctx, staticsOf(server), {
    hackDifficulty: server.hackDifficulty,
    moneyAvailable: server.moneyAvailable,
  });
  // Prep grows push the price UP for free: the op is launched either way, so for
  // a LONG position the flag costs nothing and buys a nudge. Prep never hacks,
  // so a short gets nothing from this path.
  const growInfluences = view.stockInfluence?.[server.hostname]?.side === "long";

  // Weaken work is divisible and spreads across slabs. Grow is deliberately
  // different: one grow wave is ONE call on ONE host. Same-landing grow calls
  // execute sequentially, so a split grow makes every call after the first
  // observe raised security and produce less money than the solver priced.
  // Returns REAL threads launched (post core adjustment), because grow's
  // security fortify scales with real threads.
  // W1 lands at its native duration. The grow phase below uses padding to
  // alternate G -> W2 -> G -> W2, so every atomic grow observes min security.
  // Every landing is recorded so prediction sees the whole prep pipeline.
  const nativeLanding = {
    weaken: view.time + weakenTimeSeconds(ctx, server.hackDifficulty, server.requiredHackingSkill) * 1_000,
    grow: view.time + growTimeSeconds(ctx, server.hackDifficulty, server.requiredHackingSkill) * 1_000,
  };

  // One wave is one batch. Its W1 cover and its atomic grows are launched a
  // pass or more apart, but they settle as a single unit of work — "did this
  // prep land whole" is a question about the wave, never about one grow.
  //
  // Registered LAZILY, on the first op actually emitted: several paths below
  // return having launched nothing (no placeable W1, no grow/weaken pair), and
  // a zero-op batch never settles — it would sit in `memory.batches` until the
  // bound evicted a live batch to make room for it.
  let openedBatchId = 0;
  const batchOf = (): number =>
    (openedBatchId ||= openBatch(memory, "prep", server.hostname, segment, view.time));

  let ops = 0;
  let budgetRemainingGb = budgetGb;
  const emitReservation = (
    kind: "weaken" | "grow",
    reservation: Reservation,
    opCap: number,
    landing = nativeLanding[kind],
  ): number => {
    let effectThreads = 0;
    for (const block of reservation.blocks) {
      if (ops >= opCap) {
        // Never launched -> never completes -> free it now (the rewrite's leak).
        memory.heap.free(block.hostname, block.threads * WORKER_RAM[kind]);
        continue;
      }
      const opId = memory.nextOpId++;
      actions.push({
        type: kind,
        target: server.hostname,
        source: block.hostname,
        threads: block.threads,
        opId,
        phase: "prep",
        ...(landing > nativeLanding[kind] ? { additionalMsec: landing - nativeLanding[kind] } : {}),
        ...(kind === "grow" && growInfluences ? { stock: true } : {}),
      });
      trackOp(memory, opId, {
        hostname: block.hostname,
        target: server.hostname,
        kind,
        segment,
        gb: block.threads * WORKER_RAM[kind],
        wave: true,
        landing,
        effectThreads: block.threads * coreEffect(memory.heap.host(block.hostname)?.cores ?? 1),
        batchId: batchOf(),
      });
      memory.inFlight[kind]++;
      memory.stats.launched[kind]++;
      memory.stats.execs++;
      if (kind === "grow" && growInfluences) memory.stats.stockOps++;
      accountRamWork(
        memory,
        segment,
        kind,
        block.threads * WORKER_RAM[kind],
        nativeLanding[kind] - view.time,
        landing - nativeLanding[kind],
      );
      accountThreads(memory, segment, kind, block.threads, block.threads * coreEffect(memory.heap.host(block.hostname)?.cores ?? 1));
      noteBatchOp(memory, batchOf(), kind, block.threads, block.threads * WORKER_RAM[kind]);
      memory.segmentGb[segment] += block.threads * WORKER_RAM[kind];
      bump(memory.prepInFlight, server.hostname, 1);
      effectThreads += block.threads * coreEffect(block.cores);
      budgetRemainingGb -= block.threads * WORKER_RAM[kind];
      ops++;
    }
    return effectThreads;
  };
  const launchKind = (
    kind: "weaken" | "grow",
    wantedThreads: number,
    opCap: number,
    landing = nativeLanding[kind],
  ): number => {
    if (wantedThreads < 1 || ops >= opCap) return 0;
    const affordable = Math.floor(budgetRemainingGb / WORKER_RAM[kind]);
    // Share is not capacity the prep wave has to work around: count it as
    // available and take it below if the placement actually needs it. Prep is
    // the tenant that CANNOT be cancelled without losing progress, so it
    // outranks share unconditionally.
    const shareGb = [...memory.shareWorkers.values()].reduce((sum, worker) => sum + worker.gb, 0);
    const placeable = Math.min(wantedThreads, affordable, memory.heap.capacity(WORKER_RAM[kind]));
    const threads = Math.min(
      wantedThreads,
      affordable,
      memory.heap.capacity(WORKER_RAM[kind]) + Math.floor(shareGb / WORKER_RAM[kind]),
    );
    if (threads < 1) return 0;
    const request = { blockSize: WORKER_RAM[kind], threads, policy: "spread" as const, coreAware: true };
    const allocation = memory.heap.allocate(request);
    if (!allocation.ok) {
      requestShareStops(memory, actions, threads * WORKER_RAM[kind]);
      // Share's RAM is not free until its workers actually exit, so counting it
      // above only states the DEMAND. Fall back to what is placeable right now
      // rather than losing the pass: a partial W1 is progress the wave keeps,
      // and refusing it stalled prep for as long as any share worker was
      // resident — the tenant this ordering exists to outrank.
      if (placeable >= 1 && placeable < threads) {
        const partial = memory.heap.allocate({ ...request, threads: placeable });
        if (partial.ok) return emitReservation(kind, partial.reservation, opCap, landing);
      }
      memory.stats.allocFails++;
      memory.stats.allocFailsByPhase.prep++;
      return 0;
    }
    return emitReservation(kind, allocation.reservation, opCap, landing);
  };

  // W1, G and W2 may share one in-flight wave, but only the weakens are eager:
  // launch W1 first, establish W2, and leave G outside RAM until its JIT
  // deadline. If complete W1 cannot be reserved, launch only the partial
  // weaken and defer every grow. Launching the W2 threads as extra
  // grows — the old behaviour — over-grew the target and left the grow's
  // security for the NEXT wave's W1 to clean up: self-correcting, but a whole
  // extra weaken-time of prep latency and wasted grow RAM. The cover is sized
  // to the grow that ACTUALLY launched (op cap and budget truncate the plan),
  // with one op slot held back so the grow cannot starve its weaken cover.
  if (plan.weaken1Threads > 0) {
    const w1Landing = nativeLanding.weaken + JIT_LAUNCH_GUARD_MS;
    const weakened = launchKind("weaken", plan.weaken1Threads, MAX_PREP_OPS_PER_PASS, w1Landing);
    if (weakened + 1e-9 < plan.weaken1Threads) return;
  }

  interface GrowWaveReservation {
    grow: Reservation;
    weaken: Reservation;
    realGrowThreads: number;
    maxGrowThreads: number;
    effectGrowThreads: number;
  }
  // W2 is the slow role and therefore establishes the wave. Give its worker a
  // real startup margin, then place G immediately before it. Later pairs keep
  // the proven G -> W2 -> G -> W2 landing grid; latestJitStart decides whether
  // each grow invokes before the first fortify or at a later weaken rendezvous.
  const w1Landing = plan.weaken1Threads > 0
    ? nativeLanding.weaken + JIT_LAUNCH_GUARD_MS
    : undefined;
  const firstWeakenLanding = w1Landing === undefined
    ? nativeLanding.weaken + JIT_LAUNCH_GUARD_MS
    : w1Landing + 2 * PREP_ORDER_MS;
  const pairLandings = (index: number): { grow: number; weaken: number } => ({
    grow: firstWeakenLanding + 2 * index * PREP_ORDER_MS - PREP_ORDER_MS,
    weaken: firstWeakenLanding + 2 * index * PREP_ORDER_MS,
  });
  const reserveGrowWave = (
    effectThreads: number,
    maxGb: number,
    maxOps: number,
  ): GrowWaveReservation | undefined => {
    if (effectThreads < 1) return undefined;
    const growResult = memory.heap.allocate({
      blockSize: WORKER_RAM.grow,
      threads: effectThreads,
      policy: "contiguous",
      coreAware: true,
    });
    if (!growResult.ok) return undefined;
    const grow = growResult.reservation;
    const growBlock = grow.blocks[0];
    const realGrowThreads = growBlock?.threads ?? 0;
    const effectGrowThreads = realGrowThreads * coreEffect(growBlock?.cores ?? 1);
    const maxGrowThreads = Math.ceil(effectGrowThreads - 1e-12);
    const coverEffectThreads = Math.ceil((GROW_FORTIFY * maxGrowThreads) / weakenEffect(ctx, 1, 1));
    const weakenResult = memory.heap.allocate({
      blockSize: WORKER_RAM.weaken,
      threads: coverEffectThreads,
      policy: "spread",
      coreAware: true,
    });
    const weaken = weakenResult.ok ? weakenResult.reservation : undefined;
    if (
      !weaken ||
      weaken.blocks.length + 1 > maxOps ||
      grow.gb + weaken.gb > maxGb + 1e-9
    ) {
      if (weaken) weaken.release();
      grow.release();
      return undefined;
    }
    return { grow, weaken, realGrowThreads, maxGrowThreads, effectGrowThreads };
  };

  const pairs: GrowWaveReservation[] = [];
  const growK = growthLogPerThread(ctx, server.minDifficulty, server.serverGrowth, 1);
  let predictedMoney = server.moneyAvailable;
  let reservedGb = 0;
  let reservedOps = 0;
  while (predictedMoney < server.moneyMax && reservedOps + 2 <= MAX_PREP_OPS_PER_PASS) {
    const wantedGrow = growK === -Infinity
      ? 0
      : growThreads(growK, server.moneyMax, predictedMoney, server.moneyMax);
    if (!Number.isFinite(wantedGrow) || wantedGrow < 1) break;
    // Find the largest safe atomic pair on the remaining heap. Feasibility is
    // monotone for a fixed remaining topology: a smaller grow needs no more
    // contiguous RAM and no more weaken cover. Trial reservations are
    // released exactly before the next probe.
    let low = 1;
    let high = Math.min(
      Math.ceil(wantedGrow),
      memory.heap.contiguousCapacity(WORKER_RAM.grow, true),
    );
    let best = 0;
    while (low <= high) {
      const mid = Math.floor((low + high) / 2);
      const trial = reserveGrowWave(mid, budgetRemainingGb - reservedGb, MAX_PREP_OPS_PER_PASS - reservedOps);
      if (trial) {
        best = mid;
        trial.weaken.release();
        trial.grow.release();
        low = mid + 1;
      } else {
        high = mid - 1;
      }
    }
    if (best < 1) break;
    const pair = reserveGrowWave(best, budgetRemainingGb - reservedGb, MAX_PREP_OPS_PER_PASS - reservedOps);
    if (!pair) break;
    pairs.push(pair);
    reservedGb += pair.grow.gb + pair.weaken.gb;
    reservedOps += pair.grow.blocks.length + pair.weaken.blocks.length;
    // Grow has an additive `+ realThreads` term as well as its multiplier.
    // Re-solving from predicted money makes these genuinely separate atomic
    // calls; subtracting effect threads would incorrectly model one split call.
    predictedMoney = Math.min(
      server.moneyMax,
      (predictedMoney + pair.realGrowThreads) * Math.exp(growK * pair.effectGrowThreads),
    );
  }
  if (pairs.length === 0) return;

  // Launch every cover first. Grow reservations above were feasibility probes,
  // not resident work: release each one and retain only its JIT descriptor.
  // This is the distributed/slab-friendly equivalent of one huge grow while
  // preserving the rule that every actual grow is one atomic Netscript call.
  for (let i = 0; i < pairs.length; i++) {
    const pair = pairs[i]!;
    const { grow: growLanding, weaken: weakenLanding } = pairLandings(i);
    pair.grow.release();
    emitReservation("weaken", pair.weaken, MAX_PREP_OPS_PER_PASS, weakenLanding);
    memory.prepPending.push({
      target: server.hostname,
      segment,
      batchId: batchOf(),
      kind: "grow",
      threads: pair.realGrowThreads,
      maxThreads: pair.maxGrowThreads,
      effectThreads: pair.effectGrowThreads,
      startAt: growLanding - (nativeLanding.grow - view.time) - JIT_LAUNCH_GUARD_MS,
      landing: growLanding,
      stock: growInfluences,
    });
  }
}
