import {
  growthLogPerThread,
  growThreads,
  growTimeSeconds,
  hackExpGain,
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
import type { SegmentKind, TargetDirective } from "./directive.ts";
import {
  FARM_SOLVE_SHARE,
  WORKER_RAM_FLOOR,
  adaptSegmentsToFleet,
  initEvaluator,
  staticsOf,
  stepEvaluator,
  type EvaluatorMemory,
  type FleetCapacity,
} from "./evaluator.ts";
import { isPrepped, solveCycle, solvePrep, type CycleSolution, type RamCaps } from "./targeting.ts";
import { coreEffect } from "../ram/heap.ts";
import { decideMode, type FarmMode } from "./mode.ts";
import { cheapestCloudQuote } from "./ram-supply.ts";
import { applyLedgerOp, compareLedgerOps, hackThreadsAtLanding, predictAtLanding, sizeBatchAtLanding, type LedgerOp, type PredictedState } from "./prediction.ts";
import {
  initPool,
  noteExit,
  noteJobDone,
  noteJobStart,
  noteSpawn,
  planTake,
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
 * work. Pooling trades in-game throughput (idle workers strand RAM between
 * jobs — measured −20 % time-to-goal on a 4 TB profile with it always on)
 * for browser-side relief (exec churn), so it engages only when the process
 * count is actually pressuring the browser, just before HGW does. */
export const POOL_PRESSURE_OPS = 1_000;
const JIT_ROLE_PRIORITY: Record<JitRole["role"], number> = { w1: 0, w2: 1, g: 2, h: 3 };

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
  /** Pooled op: the serve worker running it. The WORKER owns the heap
   * reservation (freed on its workerExit), not the op. */
  workerId?: number;
  /** This op's action also SPAWNED the worker (its first job), so a failed
   * exec must tear the pool entry down again. */
  spawned?: boolean;
  /** Steady-state JIT pipeline role. Capacity is reserved per role so a long
   * weaken can never consume the RAM a later grow or hack is counting on. */
  jitRole?: JitRole["role"];
}

interface PendingJitOp {
  role: JitRole["role"];
  kind: "hack" | "grow" | "weaken";
  /** One-core effect units. Core-aware placement may use fewer real threads. */
  threads: number;
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
}

interface PendingJitBatch {
  target: string;
  ops: PendingJitOp[];
  decisionId: number;
  /** Cause counters describe a batch decision, not scheduler attempts. */
  countedMisses?: Partial<Record<MissedWindowReason, true>>;
}

type JitReservationMode = "protected" | "launch";

/** Prep weaken cover is launched first and owns the landing slot. The atomic
 * grow waits outside RAM until this deadline. */
interface PendingPrepGrow {
  target: string;
  segment: SegmentKind;
  kind: "grow";
  threads: number;
  /** One-core placement ceiling. W2 covers this, so moving an atomic grow off
   * the provisional high-core host cannot leave residual security. */
  maxThreads: number;
  effectThreads: number;
  startAt: number;
  landing: number;
  stock: boolean;
  placementBlocked?: boolean;
}

export type MissedWindowReason = "deadline" | "arrival-security" | "arrival-money" | "placement";
export type MissedWindowCounts = Record<MissedWindowReason, number>;

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
  /** Cumulative, cause-labelled safety/window outcomes. Unlike
   * batchesSkipped this distinguishes a real miss from the brake working. */
  missedWindow: MissedWindowCounts;
  /** Ops that needed a fresh process (one-shots + pool spawns). The pooling
   * win is this staying flat while `launched` keeps climbing. */
  execs: number;
  /** Ops launched carrying a `{stock:true}` influence flag. The only visible
   * link between "manipulation intended" and "nudges actually rolled" — a
   * manipulation run where this stays 0 has an open influence loop. */
  stockOps: number;
  /** GB·ms scheduled inside native hack/grow/weaken durations. */
  nativeRamMs: number;
  /** GB·ms held only by additionalMsec. This is scheduler waste, not work. */
  paddingRamMs: number;
  nativeRamMsByKind: { hack: number; grow: number; weaken: number };
  paddingRamMsByKind: { hack: number; grow: number; weaken: number };
  nativeRamMsBySegment: Record<SegmentKind, number>;
  paddingRamMsBySegment: Record<SegmentKind, number>;
}

export interface ShareWorker {
  workerId: number;
  hostname: string;
  threads: number;
  gb: number;
  effectiveThreads: number;
  stopping: boolean;
}

export interface DispatchMemory {
  heap: Heap;
  evaluator: EvaluatorMemory;
  tracked: Map<number, Tracked>;
  inFlight: { hack: number; grow: number; weaken: number };
  segmentGb: Record<SegmentKind, number>;
  /** Long-lived, cooperatively stoppable fragment consumers. */
  shareWorkers: Map<number, ShareWorker>;
  /** host -> op count in flight, so prep fires in non-overlapping waves. */
  prepInFlight: Map<string, number>;
  /** Logical distributed weaken landings which have lost at least one
   * fragment. Retained across pumps until the final fragment settles, so a
   * later successful fragment cannot turn a partial weaken into a false
   * min-security observation. */
  failedWeakenGroups: Set<string>;
  nextOpId: number;
  nextServerIndex: number;
  lastAnchor: number;
  /** Target/mode pipeline decision whose repeated scheduler retries must not
   * inflate cumulative missed-window counters. */
  jitDecisionId: number;
  countedJitDecisionMisses: Set<string>;
  /** Last observed pure clock, used when a driver reports an exec failure
   * immediately after a planning pass. */
  lastDispatchAt: number;
  /** Batches whose slow support has been planned but whose shorter operations
   * have not reached their just-in-time launch windows yet. */
  jitPending: PendingJitBatch[];
  /** Atomic prep grows waiting for their invocation windows. Their covering
   * W2 calls are already resident, so W2 always starts before G. */
  prepPending: PendingPrepGrow[];
  /** Farm scheduling mode (shared/strategy/mode.ts) with its flap guard. */
  mode: FarmMode;
  modeSince: number;
  modeWhy: string;
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
  stats: DispatchStats;
}

export interface DispatchOptions {
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
}

export function initDispatch(): DispatchMemory {
  return {
    heap: new Heap(),
    evaluator: initEvaluator(),
    tracked: new Map(),
    inFlight: { hack: 0, grow: 0, weaken: 0 },
    segmentGb: { farm: 0, prep: 0, share: 0 },
    shareWorkers: new Map(),
    prepInFlight: new Map(),
    failedWeakenGroups: new Set(),
    nextOpId: 1,
    nextServerIndex: 0,
    lastAnchor: -Infinity,
    jitDecisionId: 0,
    countedJitDecisionMisses: new Set(),
    lastDispatchAt: 0,
    jitPending: [],
    prepPending: [],
    mode: "hwgw",
    modeSince: -Infinity,
    modeWhy: "initial",
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
      missedWindow: { deadline: 0, "arrival-security": 0, "arrival-money": 0, placement: 0 },
      execs: 0,
      stockOps: 0,
      nativeRamMs: 0,
      paddingRamMs: 0,
      nativeRamMsByKind: { hack: 0, grow: 0, weaken: 0 },
      paddingRamMsByKind: { hack: 0, grow: 0, weaken: 0 },
      nativeRamMsBySegment: { farm: 0, prep: 0, share: 0 },
      paddingRamMsBySegment: { farm: 0, prep: 0, share: 0 },
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
  const ours = new Map<string, number>();
  for (const tracked of memory.tracked.values()) {
    if (tracked.workerId !== undefined) continue;
    ours.set(tracked.hostname, (ours.get(tracked.hostname) ?? 0) + tracked.gb);
  }
  for (const worker of memory.pool.workers.values()) {
    ours.set(worker.hostname, (ours.get(worker.hostname) ?? 0) + worker.gb);
  }
  for (const worker of memory.shareWorkers.values()) {
    ours.set(worker.hostname, (ours.get(worker.hostname) ?? 0) + worker.gb);
  }
  for (const batch of memory.jitPending) {
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
  return { fleetGb, largestBlockGb, hostBlocksGb, prepWaveGb, prepFreeGb, prepWaveInFlight, effectiveShareThreadsPerGb };
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
  memory.tracked.delete(opId);
  memory.inFlight[tracked.kind]--;
  // prepInFlight is symmetric with the launch-time increment: exactly the ops
  // launchPrepWave marked `wave` decrement it, keyed by TARGET. (It used to be
  // guessed from completion targets, which let farm-batch completions drain a
  // desynced farm host's counter and unlock overlapping prep waves.)
  if (tracked.wave) {
    const remaining = (memory.prepInFlight.get(tracked.target) ?? 0) - 1;
    if (remaining > 0) memory.prepInFlight.set(tracked.target, remaining);
    else memory.prepInFlight.delete(tracked.target);
  }
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

export function currentShareBonus(memory: DispatchMemory): number {
  const effectiveThreads = 1 + [...memory.shareWorkers.values()]
    .reduce((sum, worker) => sum + worker.effectiveThreads, 0);
  return 1 + Math.log(effectiveThreads) / 25;
}

/** Ask enough divisible workers to leave for hacking's currently unfilled
 * budget. The mailbox action is cooperative: worker.ts races the active share
 * slice against it, then atExit produces the sole heap-release completion. */
export function requestShareStops(
  memory: DispatchMemory,
  actions: Action[],
  wantedGb: number,
  selected?: ReadonlySet<number>,
): number {
  let requested = 0;
  for (const worker of [...memory.shareWorkers.values()].sort((a, b) => b.gb - a.gb)) {
    if (worker.stopping || (selected && !selected.has(worker.workerId))) continue;
    worker.stopping = true;
    actions.push({ type: "stopShare", opId: worker.workerId });
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
    releaseWorker(memory, workerId);
  }
}

function launchShare(memory: DispatchMemory, actions: Action[], intelligence: number): void {
  const threads = memory.heap.capacity(WORKER_RAM.share);
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

/** Roll back ops the driver could not actually start (sim rejection, ns.exec
 * returning pid 0). Without this the reservation would never be freed — the
 * exact leak the earlier rewrite's dispatcher had (`nobody0/bitburner`; see
 * README's citation note). A pooled op that failed to START also means its
 * worker is gone (spawn failed) or dead (job post found no mailbox), so the
 * worker's reservation goes with it. */
export function releaseFailed(memory: DispatchMemory, opIds: Iterable<number>): void {
  let jitFailed = false;
  for (const opId of opIds) {
    if (memory.shareWorkers.has(opId)) {
      releaseShareWorker(memory, opId);
      continue;
    }
    const tracked = memory.tracked.get(opId);
    if (!tracked) continue;
    if (tracked.jitRole !== undefined) jitFailed = true;
    if (tracked.wave) {
      memory.prepPending = memory.prepPending.filter((op) => op.target !== tracked.target);
    }
    if (tracked.workerId !== undefined) releaseWorker(memory, tracked.workerId);
    release(memory, opId);
  }
  // Every later pending batch was sized against the failed effect. None has
  // launched its hack yet (hack is the last native start), so abandoning the
  // suffix preserves correctness; already-started support is harmless.
  if (jitFailed) {
    abandonJitPending(memory, memory.lastDispatchAt);
    memory.lastAnchor = -Infinity;
  }
}

/** One dispatcher pass: absorb completions, refresh the directive, launch work. */
export function dispatch(
  view: WorldView,
  memory: DispatchMemory,
  completions: CompletionEvent[],
  options: DispatchOptions = {},
): { actions: Action[]; directive: TargetDirective; switched?: { from?: string; to: string } } {
  const arenaReserves = options.arenaReserves ?? {};
  memory.lastDispatchAt = view.time;

  const byHost = new Map(view.servers.map((s) => [s.hostname, s]));
  const weakenWakeTargets = new Set<string>();
  const successfulWeakenGroups = new Set<string>();
  const touchedWeakenGroups = new Set<string>();
  const weakenGroup = (target: string, landing: number): string => `${target}\u0000${landing}`;
  for (const completion of completions) {
    if (completion.kind === "sleep") continue;
    if (completion.kind === "workerExit") {
      // Pooled and share workers both release only on process exit. Each map
      // is its own idempotence guard, so a duplicate cannot double-free.
      if (completion.opId !== undefined) {
        releaseWorkerExits(memory, [completion.opId]);
      }
      continue;
    }
    memory.stats.landed[completion.kind]++;
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
        const group = weakenGroup(tracked.target, tracked.landing);
        touchedWeakenGroups.add(group);
        if (completion.result === undefined) memory.failedWeakenGroups.add(group);
        else successfulWeakenGroups.add(group);
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
  for (const group of touchedWeakenGroups) {
    const separator = group.indexOf("\u0000");
    const target = group.slice(0, separator);
    const landing = Number(group.slice(separator + 1));
    const pendingFragment = [...memory.tracked.values()].some(
      (tracked) => tracked.kind === "weaken" && tracked.target === target && tracked.landing === landing,
    );
    if (pendingFragment) continue;
    if (successfulWeakenGroups.has(group) && !memory.failedWeakenGroups.has(group)) {
      weakenWakeTargets.add(target);
    }
    memory.failedWeakenGroups.delete(group);
  }

  const capacity = syncTopology(memory, view, arenaReserves, options.sourceHosts);
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
    },
  );
  memory.evaluator = stepped.memory;
  const directive = {
    ...stepped.directive,
    segments: adaptSegmentsToFleet(stepped.directive.segments, capacity.fleetGb),
  };
  const activeTargets = new Set([directive.farm?.host, directive.prep?.host].filter((host): host is string => Boolean(host)));
  memory.prepPending = memory.prepPending.filter((op) => activeTargets.has(op.target));

  // An unlaunched JIT batch contains only support work at this point: hack is
  // always the last native call to start. On a retarget, dropping those plans
  // can therefore only leave harmless extra weaken/grow support in flight; it
  // cannot expose a hack without its covers. Later plans depended on the same
  // predicted ledger, so discard the whole pending suffix together.
  if (stepped.switched) {
    abandonJitPending(memory, view.time);
    memory.lastAnchor = -Infinity;
    memory.jitDecisionId++;
  }

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
  }
  let spillGb = 0;
  memory.pooling = false;
  for (const segment of directive.segments) {
    if (segment.kind === "prep" && !prepActive) spillGb += Math.max(0, segment.gb - memory.segmentGb.prep);
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
    for (const batch of memory.jitPending) {
      for (const op of batch.ops) {
        if (op.reservation && jitLaunchAt(op) > now) releasePendingReservation(memory, op, now);
      }
    }
  }

  for (const segment of directive.segments) {
    let segmentCap = segment.kind === "farm" ? segment.gb + spillGb : segment.gb;
    let borrow: { gb: number; landingDeadline: number } | undefined;
    if (segment.kind === "farm" && prepActive && directive.prep) {
      let landingDeadline = -Infinity;
      for (const tracked of memory.tracked.values()) {
        if (tracked.wave && tracked.target === directive.prep.host && tracked.landing !== undefined) {
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
      if (isPrepped(server) || memory.jitPending.some((batch) => batch.target === server.hostname)) {
        // Mode: HOW to farm this target (shared/strategy/mode.ts). Decided
        // here — where the farm server and live ctx are in hand — with the
        // dwell carried in memory. Shotgun is wired in launchBatches.
        // Mode is a steady-state choice. Price the prepped hack duration, not
        // a transient fortify between batch landings.
        const hackMs = hackTimeSeconds(launchCtx, server.minDifficulty, server.requiredHackingSkill) * 1_000;
        const weakenMs = weakenTimeSeconds(launchCtx, server.hackDifficulty, server.requiredHackingSkill) * 1_000;
        const decision = options.modeOverride
          ? { mode: options.modeOverride, why: "override" }
          : decideMode({
              hackMs,
              liveOps: memory.tracked.size,
              lastMode: memory.mode,
              lastModeSince: memory.modeSince,
              now,
            });
        if (decision.mode !== memory.mode) {
          // Pending plans have the old mode's role shape and quotas. Hacks are
          // emitted only after every support op in their batch, so abandoning
          // this unlaunched suffix is safe; already-running support is benign.
          abandonJitPending(memory, now);
          memory.lastAnchor = -Infinity;
          memory.jitDecisionId++;
          memory.mode = decision.mode;
          memory.modeSince = now;
        }
        memory.modeWhy = decision.why;
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
        // Pooling only pays when a worker's NEXT job arrives before its idle
        // timeout. The steady-state launch period is weakenTime over the
        // achievable depth — depth from the SEGMENT total, not this pass's
        // residual budget (which shrinks to ~one batch once the pipeline is
        // full and would read as "no reuse" forever). When RAM or weakenTime
        // keeps depth low — the whole early game — a pooled worker would idle
        // out before reuse, degenerating to spawn-per-op plus an idle timeout
        // of stranded RAM (measured: +11 % time-to-goal on a 16 GB start).
        const interval = solution.kind === "hgw" ? HGW_MIN_INTERVAL_MS : INTERVAL_MS;
        memory.depthCapGb = Math.max(1, Math.floor(weakenMs / interval)) * solution.ramPerBatch;
        memory.depthCapHost = directive.farm.host;
        const depth = Math.max(
          1,
          Math.min(Math.floor(weakenMs / interval), Math.floor(segmentCap / solution.ramPerBatch)),
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
          solution,
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
  // The reputation gate — not `share.allotmentGb` — is the correct predicate
  // here. `allotmentGb` is the RESERVATION the crossing carves out of the farm
  // segment before hack plans; share's actual slice is the residual left after
  // hack has planned within its allotment, and that residual costs hacking
  // nothing by construction. Gating this on the allotment would make share
  // refuse genuinely idle RAM.
  //
  // TODO (measured, unfixed): `nonShareDeficitGb` below is UNUSED ALLOTMENT,
  // not unmet demand. The JIT farm is designed not to consume its whole
  // segment, so on the scenario-share reputation lane the deficit is > 0 on
  // 2338 of 2338 passes (mean 210.6 GB against a mean farm segment of 408.1
  // and mean farm usage of 197.5) while allocFails stays 0 and
  // missedWindow.placement stays 1 for the entire run — the farm never
  // actually failed to place anything. Combined with the `Math.max(
  // WORKER_RAM.share, ...)` floor below, which stops a whole block even when
  // free RAM already covers the deficit, share is stopped every pass and can
  // only relaunch once fully drained (`!hadShareWorkers`): 908 stop-all cycles
  // and 2443 execs against 180 with share disabled.
  //
  // Share itself is NOT stealing from the farm. A/B on that lane: farm work is
  // bit-identical with and without share (nativeGbMs 3.933e7, same moneyRate,
  // same missedWindow) while reputation goes 198.84 -> 269.48 (+35.5%). Only
  // the churn is waste. Gating the stop on an actual blocked placement
  // (`op.placementBlocked` on a pending jit/prep op) instead of the phantom
  // deficit measured 1141 execs (-53%) with farm work still bit-identical, at
  // a cost of 4.3% reputation (269.48 -> 257.96) on this single seed — worth a
  // benchmark pass before adopting.
  const shareEnabled = (directive.share?.reputationSecondsPerBonus ?? 0) > 0;
  if (!shareEnabled) {
    requestShareStops(memory, actions, Infinity);
  } else if (nonShareDeficitGb > 1e-9 && memory.shareWorkers.size > 0) {
    // Hacking has first refusal. Free at least one whole share block even when
    // aggregate free GB looks sufficient: a failed atomic hack/grow placement
    // can be a contiguity deficit rather than a total-capacity deficit.
    requestShareStops(
      memory,
      actions,
      Math.max(WORKER_RAM.share, nonShareDeficitGb - memory.heap.freeTotal()),
    );
  }

  const shareStopping = [...memory.shareWorkers.values()].some((worker) => worker.stopping);
  if (shareEnabled && !shareStopping && (nonShareDeficitGb <= 1e-9 || !hadShareWorkers)) {
    // Stanek is deliberately absent: charge strength favors one occasional
    // LARGE contiguous call (highestCharge under a log, repetitions^0.07), the
    // opposite of a freely preemptible fragment consumer.
    launchShare(memory, actions, view.player.intelligence);
  }


  // Publish the earliest pending invocation deadline as a pure sleep action.
  // The standalone planner executes it directly; the game driver turns it
  // into a cancellable realm-timer wake alongside its 200 ms heartbeat. Both
  // paths therefore exercise the same schedule without injecting a clock into
  // strategy code.
  if (memory.jitPending.length > 0 || memory.prepPending.length > 0) {
    const pendingStarts = [
      ...memory.jitPending.flatMap((batch) => batch.ops.map((op) =>
        op.reservation ? jitLaunchAt(op) : jitReserveAt(op)
      )),
      ...memory.prepPending.map((op) => op.startAt),
    ];
    const overdue = pendingStarts.some((at) => at <= now);
    const nextStart = Math.min(...pendingStarts.filter((at) => at > now));
    const exactMs = Number.isFinite(nextStart) ? nextStart - now : Infinity;
    // An overdue op is one that could not be placed, almost always because its
    // RAM is not free yet. That frees on a completion, which wakes us anyway,
    // so this is a fallback retry rather than the primary path — and retrying
    // faster than a worker can start cannot succeed. Deliberately NOT the
    // landing gap: a backoff and a landing separation are unrelated, and tying
    // them together turns a tight grid into a spin.
    actions.push({
      type: "sleep",
      ms: overdue ? Math.min(OVERDUE_RETRY_MS, exactMs) : exactMs,
    });
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
  memory.stats.nativeRamMs += nativeRamMs;
  memory.stats.paddingRamMs += paddingRamMs;
  memory.stats.nativeRamMsByKind[kind] += nativeRamMs;
  memory.stats.paddingRamMsByKind[kind] += paddingRamMs;
  memory.stats.nativeRamMsBySegment[segment] += nativeRamMs;
  memory.stats.paddingRamMsBySegment[segment] += paddingRamMs;
}

function noteMissedWindow(memory: DispatchMemory, reason: MissedWindowReason): void {
  memory.stats.missedWindow[reason]++;
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
  if (reason === "deadline" || reason === "placement") {
    return noteJitDecisionMissedWindow(memory, batch.decisionId, reason);
  }
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
  memory.segmentGb.farm -= op.reservation.gb;
  op.reservation.release();
  op.reservation = undefined;
  op.reservedAt = undefined;
}

/** Abandon the predicted suffix through the same physical reservation handles
 * that a successful launch transfers to workerExit accounting. */
function abandonJitPending(memory: DispatchMemory, now: number): void {
  for (const batch of memory.jitPending) {
    for (const op of batch.ops) releasePendingReservation(memory, op, now);
  }
  memory.jitPending = [];
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

function jitRoles(
  solution: CycleSolution,
  server: ServerView,
  ctx: HackContext,
): JitRole[] {
  const difficulty = jitWorstDifficulty(solution, server);
  const required = server.requiredHackingSkill;
  return cycleJitRoles(
    {
      kind: solution.kind,
      hackGb: solution.hackThreads * WORKER_RAM.hack,
      weaken1Gb: solution.weaken1Threads * WORKER_RAM.weaken,
      growGb: solution.growThreads * WORKER_RAM.grow,
      weaken2Gb: solution.weaken2Threads * WORKER_RAM.weaken,
    },
    (kind) => opDurationMs(kind, ctx, difficulty, required),
    JIT_LAUNCH_GUARD_MS + MINIMUM_WORKER_PRECISION_MS,
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
function jitLedgerEntries(memory: DispatchMemory, host: string): LedgerEntry[] {
  const entries: LedgerEntry[] = [];
  for (const [opId, tracked] of memory.tracked) {
    if (tracked.target !== host || tracked.landing === undefined) continue;
    const threads = tracked.gb / WORKER_RAM[tracked.kind];
    entries.push({
      op: {
        kind: tracked.kind,
        threads,
        effectThreads: tracked.effectThreads ?? threads,
        landing: tracked.landing,
        opId,
      },
    });
  }
  let pendingId = -1;
  for (const batch of memory.jitPending) {
    if (batch.target !== host) continue;
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
  return entries;
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
  const ops: LedgerOp[] = [];
  for (const [opId, tracked] of memory.tracked) {
    if (tracked.target !== host || tracked.landing === undefined) continue;
    const threads = tracked.gb / WORKER_RAM[tracked.kind];
    ops.push({
      kind: tracked.kind,
      threads,
      effectThreads: tracked.effectThreads ?? threads,
      landing: tracked.landing,
      opId,
    });
  }
  let pendingId = -1;
  for (const batch of memory.jitPending) {
    if (batch.target !== host) continue;
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

function jitSecurityEvents(ledger: readonly LedgerOp[], ctx: HackContext): JitSecurityEvent[] {
  const weakenPerThread = weakenEffect(ctx, 1, 1);
  return ledger.map((event) => ({
    at: event.landing,
    order: event.opId,
    deltaDifficulty: event.kind === "hack"
      ? 0.002 * event.threads
      : event.kind === "grow"
        ? 0.004 * (event.fortifyThreads ?? event.threads)
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
  const ledger = jitLedger(memory, server.hostname);
  const securityEvents = jitSecurityEvents(ledger, ctx);
  for (const op of ops) {
    if (weakenWake || op.startAt <= now) op.startAt = jitStartAt(op, securityEvents, server, now, ctx);
  }
  ops.sort((a, b) => a.startAt - b.startAt || a.landing - b.landing);

  let emitted = 0;
  for (const op of ops) {
    if (emitted >= MAX_PREP_SLABS_PER_PASS || op.startAt > now) break;
    const liveDuration = opDurationMs("grow", ctx, server.hackDifficulty, server.requiredHackingSkill);
    const padding = op.landing - now - liveDuration;
    if (padding < WORKER_STARTUP_GUARD_MS - 1e-9) {
      memory.prepPending.splice(memory.prepPending.indexOf(op), 1);
      memory.stats.batchesSkipped++;
      noteMissedWindow(memory, op.placementBlocked ? "placement" : "deadline");
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
    const effectThreads = block.threads * coreEffect(block.cores);
    actions.push({
      type: "grow",
      target: server.hostname,
      source: block.hostname,
      threads: block.threads,
      opId,
      phase: "prep",
      ...(padding > 0 ? { additionalMsec: padding } : {}),
      ...(op.stock ? { stock: true } : {}),
    });
    memory.tracked.set(opId, {
      hostname: block.hostname,
      target: server.hostname,
      kind: "grow",
      segment: op.segment,
      gb,
      wave: true,
      landing: op.landing,
      effectThreads,
    });
    memory.inFlight.grow++;
    memory.segmentGb[op.segment] += gb;
    memory.prepInFlight.set(server.hostname, (memory.prepInFlight.get(server.hostname) ?? 0) + 1);
    memory.stats.launched.grow++;
    memory.stats.execs++;
    if (op.stock) memory.stats.stockOps++;
    accountRamWork(memory, op.segment, "grow", gb, liveDuration, padding);
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
): boolean {
  const required = server.requiredHackingSkill;
  const ledger = jitLedger(memory, server.hostname);
  const securityEvents = jitSecurityEvents(ledger, ctx);
  for (const batch of memory.jitPending) {
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
        op.startAt = jitStartAt(op, securityEvents, server, now, ctx);
        op.reserveAt = op.startAt - (JIT_LAUNCH_GUARD_MS - WORKER_STARTUP_GUARD_MS);
      }
    }
    orderJitStarts(batch.ops);
  }
  const heldByRole: Record<JitRole["role"], number> = { h: 0, w1: 0, g: 0, w2: 0 };
  for (const tracked of memory.tracked.values()) {
    // A pooled job does not own RAM; its resident worker is counted exactly
    // once below, whether the worker is busy or idle.
    if (tracked.segment === "farm" && tracked.jitRole && tracked.workerId === undefined) {
      heldByRole[tracked.jitRole] += tracked.gb;
    }
  }
  for (const worker of memory.pool.workers.values()) {
    if (worker.role) heldByRole[worker.role] += worker.gb;
  }
  for (const batch of memory.jitPending) {
    for (const op of batch.ops) heldByRole[op.role] += op.reservation?.gb ?? 0;
  }

  // Commit due blocks before emitting any work. Pool workers are themselves
  // physical role reservations, so the early heap commitment is needed only
  // on the one-shot path.
  if (!pooling) {
    reservePending:
    for (const batch of memory.jitPending) {
      if (batch.target !== server.hostname) continue;
      const ordered = [...batch.ops].sort(
        (a, b) => a.startAt - b.startAt || JIT_ROLE_PRIORITY[a.role] - JIT_ROLE_PRIORITY[b.role],
      );
      for (const op of ordered) {
        if (op.reservation || jitReserveAt(op) > now) continue;
        const requestedGb = op.threads * WORKER_RAM[op.kind];
        if (jitLaunchAt(op) > now && reservationMode === "launch") continue;
        const roleCapGb = Math.max(schedule.quotaGb[op.role], requestedGb);
        if (
          heldByRole[op.role] + requestedGb > roleCapGb + 1e-9 ||
          memory.segmentGb.farm + requestedGb > segmentCapGb + 1e-9
        ) break reservePending;
        const allocation = memory.heap.allocate(allocFor(op.kind, op.threads));
        if (!allocation.ok) {
          op.placementBlocked = true;
          break reservePending;
        }
        if (
          heldByRole[op.role] + allocation.reservation.gb > roleCapGb + 1e-9 ||
          memory.segmentGb.farm + allocation.reservation.gb > segmentCapGb + 1e-9
        ) {
          allocation.reservation.release();
          break reservePending;
        }
        op.reservation = allocation.reservation;
        op.reservedAt = now;
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
  const ledgerEntries = jitLedgerEntries(memory, server.hostname)
    .sort((a, b) => compareLedgerOps(a.op, b.op));
  let ledgerIndex = 0;
  let foldedAt = -Infinity;
  let foldState: PredictedState = {
    hackDifficulty: server.hackDifficulty,
    moneyAvailable: server.moneyAvailable,
  };
  let withheld: LedgerEntry | undefined;
  const foldPredicted = (at: number, skip: PendingJitOp): PredictedState => {
    // Landings should be non-decreasing; if that ever fails, fall back to the
    // exact whole-ledger fold rather than silently reusing a cursor that has
    // already advanced past `at`.
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
    while (ledgerIndex < ledgerEntries.length && ledgerEntries[ledgerIndex]!.op.landing <= at) {
      const entry = ledgerEntries[ledgerIndex]!;
      ledgerIndex++;
      if (entry.source === skip) withheld = entry;
      else foldState = applyLedgerOp(ctx, foldStatics, foldState, entry.op);
    }
    return foldState;
  };
  /** Fold the withheld op at the size it was actually dispatched at, or drop
   * it when the loop removed it. */
  const commitFolded = (threads: number | undefined): void => {
    const entry = withheld;
    withheld = undefined;
    if (!entry || threads === undefined || threads <= 0) return;
    foldState = applyLedgerOp(ctx, foldStatics, foldState, {
      ...entry.op,
      threads,
      effectThreads: threads,
    });
  };

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
  const nextWeakenLanding = ledgerEntries.find(
    (entry) => entry.op.kind === "weaken" && entry.op.landing > now,
  )?.op.landing ?? Infinity;
  const launchHorizon = Math.min(now + JIT_LAUNCH_WINDOW_MS, nextWeakenLanding);

  let emitted = 0;
  for (const batch of memory.jitPending) {
    if (batch.target !== server.hostname) continue;
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
        const safeHackThreads = hackThreadsAtLanding(ctx, statics, predicted, baseHackThreads);
        if (safeHackThreads === undefined) {
          heldByRole[op.role] -= op.reservation?.gb ?? 0;
          releasePendingReservation(memory, op, now);
          batch.ops.splice(batch.ops.indexOf(op), 1);
          memory.stats.batchesSkipped++;
          noteBatchMissedWindow(memory, batch, "arrival-security");
          commitFolded(undefined);
          continue;
        }
        const shrunkThreads = Math.min(op.threads, safeHackThreads);
        if (shrunkThreads < op.threads) {
          // A committed atomic block may be larger than the newly-safe hack.
          // Release and synchronously re-place the smaller call before any
          // lower-priority allocator can observe the gap.
          heldByRole[op.role] -= op.reservation?.gb ?? 0;
          releasePendingReservation(memory, op, now);
          noteBatchMissedWindow(memory, batch, "arrival-money");
        }
        op.threads = shrunkThreads;
        if (op.threads < 1) {
          batch.ops.splice(batch.ops.indexOf(op), 1);
          memory.stats.batchesSkipped++;
          noteBatchMissedWindow(memory, batch, "arrival-money");
          commitFolded(undefined);
          continue;
        }
        commitFolded(op.threads);
      }

      // This is deliberately live: Netscript fixes duration when the HGW call
      // is invoked, not when the batch was planned.
      const liveDuration = opDurationMs(op.kind, ctx, server.hackDifficulty, required);
      const padding = op.landing - now - liveDuration;
      // The worker converts our absolute padding deadline immediately before
      // invoking Netscript. Less than the measured startup allowance is no
      // longer a safe launch even if the pure duration still fits on paper.
      if (padding < WORKER_STARTUP_GUARD_MS - 1e-9) {
        const reason = op.placementBlocked ? "placement" : "deadline";
        if (noteBatchMissedWindow(memory, batch, reason)) memory.stats.batchesSkipped++;
        abandonJitPending(memory, now);
        return false;
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
      const roleCapGb = Math.max(schedule.quotaGb[op.role], requestedGb);
      if (
        heldByRole[op.role] + missRequestedGb > roleCapGb + 1e-9 ||
        memory.segmentGb.farm + missRequestedGb > segmentCapGb + 1e-9
      ) {
        // Later operations and batches were sized against this effect. Never
        // expose a dependent hack while a required support launch is blocked.
        return true;
      }
      let reservation: Reservation | undefined = op.reservation;
      if (!reservation && poolPlan.missThreads >= 1) {
        const allocation = memory.heap.allocate(allocFor(op.kind, poolPlan.missThreads));
        if (!allocation.ok) {
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
          heldByRole[op.role] + (reservation?.gb ?? 0) > roleCapGb + 1e-9 ||
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
      ): void => {
        const opId = memory.nextOpId++;
        actions.push({
          type: op.kind,
          target: server.hostname,
          source: hostname,
          threads,
          opId,
          ...(padding > 0 ? { additionalMsec: padding } : {}),
          ...(op.stock ? { stock: true } : {}),
          ...(worker ? { worker } : {}),
        });
        memory.tracked.set(opId, {
          hostname,
          target: server.hostname,
          kind: op.kind,
          segment: "farm",
          gb,
          wave: false,
          landing: op.landing,
          effectThreads,
          jitRole: op.role,
          ...(worker ? { workerId: worker.id, spawned: worker.spawn } : {}),
        });
        memory.inFlight[op.kind]++;
        memory.stats.launched[op.kind]++;
        if (!worker || worker.spawn) memory.stats.execs++;
        if (op.stock) memory.stats.stockOps++;
        accountRamWork(memory, "farm", op.kind, gb, liveDuration, padding);
      };

      for (const worker of poolPlan.take) {
        noteJobStart(memory.pool, worker.workerId);
        track(worker.hostname, worker.threads, worker.effectThreads, worker.gb, {
          id: worker.workerId,
          spawn: false,
        });
      }
      for (const block of reservation?.blocks ?? []) {
        const workerId = memory.nextOpId++;
        const gb = block.threads * WORKER_RAM[op.kind];
        const effectThreads = op.kind === "hack" ? block.threads : block.threads * coreEffect(block.cores);
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
        track(block.hostname, block.threads, effectThreads, gb, { id: workerId, spawn: true });
      }
      if (op.reservation) {
        accountReservedPadding(memory, op, now);
        op.reservation = undefined;
        op.reservedAt = undefined;
      } else {
        heldByRole[op.role] += reservation?.gb ?? 0;
        memory.segmentGb.farm += reservation?.gb ?? 0;
      }
      batch.ops.splice(batch.ops.indexOf(op), 1);
      emitted += poolPlan.take.length + (reservation?.blocks.length ?? 0);
    }
  }
  memory.jitPending = memory.jitPending.filter((batch) => batch.ops.length > 0);
  return true;
}

function planJitBatches(
  memory: DispatchMemory,
  solution: CycleSolution,
  server: ServerView,
  now: number,
  ctx: HackContext,
  schedule: JitSchedule,
  influence?: StockInfluence,
): void {
  const required = server.requiredHackingSkill;
  const weakenMs = opDurationMs("weaken", ctx, server.hackDifficulty, required);
  const worstWeakenMs = opDurationMs("weaken", ctx, jitWorstDifficulty(solution, server), required);
  const maxDepth = Math.max(1, 1 + Math.ceil(worstWeakenMs / schedule.intervalMs));
  const statics = staticsOf(server);
  const worstDifficulty = jitWorstDifficulty(solution, server);
  // Fold the existing pipeline once. Each pass may append eight batches; a
  // fresh walk of every tracked and pending operation for every append made
  // planning quadratic at the deep pipelines unlocked by late-game RAM.
  const planningLedger = jitLedger(memory, server.hostname);
  let planningOpId = -planningLedger.length - 1;
  const pending = (
    role: JitRole["role"],
    kind: PendingJitOp["kind"],
    threads: number,
    landing: number,
    stock: boolean,
  ): PendingJitOp => ({
    role,
    kind,
    threads,
    startAt: landing - opDurationMs(kind, ctx, worstDifficulty, required) - JIT_LAUNCH_GUARD_MS,
    landing,
    stock,
  });

  for (let planned = 0; planned < MAX_BATCHES_PER_PASS; planned++) {
    if (memory.jitPending.length + memory.inFlight.hack >= maxDepth) return;
    // A cheap floor only: the exact one depends on batchWorstDifficulty, which
    // is not known until the batch is sized, so any startAt still left in the
    // past is corrected by the shift below.
    let anchor = Math.max(
      now + weakenMs,
      memory.lastAnchor + schedule.intervalMs,
    );
    const predicted = predictAtLanding(
      ctx,
      statics,
      { hackDifficulty: server.hackDifficulty, moneyAvailable: server.moneyAvailable },
      planningLedger,
      anchor,
    );
    const sized = sizeBatchAtLanding(ctx, statics, predicted, solution);
    if (!sized) {
      if (noteJitDecisionMissedWindow(memory, memory.jitDecisionId, "arrival-security")) {
        memory.stats.batchesSkipped++;
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
    const pendingHack = ops.find((op) => op.kind === "hack");
    if (pendingHack) {
      pendingHack.baseHackThreads = solution.hackThreads;
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
    memory.jitPending.push({
      target: server.hostname,
      ops: retained,
      decisionId: memory.jitDecisionId,
    });
    for (const op of retained) {
      planningLedger.push({
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
    const roles = jitRoles(solution, server, ctx);
    const schedule = chooseJitSchedule(
      roles,
      segmentCapGb,
      intervalMs,
      hostBlocksGb ? { hostBlocksGb, divisibleBlockGb: WORKER_RAM.weaken } : undefined,
    );
    const worstWeakenMs = opDurationMs("weaken", ctx, jitWorstDifficulty(solution, server), required);
    if (schedule && schedule.intervalMs < worstWeakenMs) {
      // Saturation is the minimum-interval role envelope, not the envelope of
      // the slower cadence today's fleet can afford. Infrastructure purchases
      // may unlock each faster step, so treating the present cadence as an
      // absolute cap creates a self-fulfilling RAM-growth stall.
      memory.depthCapGb = solution.jitSaturationGb ?? jitCapacity(roles, intervalMs).totalGb;
      memory.depthCapHost = host;
      if (!launchDueJit(memory, actions, server, now, ctx, schedule, segmentCapGb, pooling, reservationMode)) return;
      planJitBatches(memory, solution, server, now, ctx, schedule, influence);
      launchDueJit(memory, actions, server, now, ctx, schedule, segmentCapGb, pooling, reservationMode);
      return;
    }
    // Pending batches have not launched their hack yet. If the farm segment
    // shrank below the executable role envelope, abandon them safely and let
    // the simple atomic path take over once the target is genuinely prepped.
    if (memory.jitPending.some((batch) => batch.target === host)) {
      abandonJitPending(memory, now);
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

  // The in-flight ledger for THIS target, rebuilt per batch (tracked grows as
  // batches launch, so batch N+1's prediction sees batch N's ops).
  const ledger = (): LedgerOp[] => {
    const ops: LedgerOp[] = [];
    for (const [opId, t] of memory.tracked) {
      if (t.target !== host || t.landing === undefined) continue;
      const threads = t.gb / WORKER_RAM[t.kind];
      ops.push({ kind: t.kind, threads, effectThreads: t.effectThreads ?? threads, landing: t.landing, opId });
    }
    return ops;
  };
  const statics = staticsOf(server);

  const perPass = shotgun ? SHOTGUN_BATCHES_PER_PASS : MAX_BATCHES_PER_PASS;
  for (let launched = 0; launched < perPass; launched++) {
    const batchesInFlight = memory.inFlight.hack;
    // Shotgun has no interleave to protect — depth is bounded by RAM alone.
    if (!shotgun && batchesInFlight >= maxDepth) return;
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
      ledger(),
      anchor,
    );
    const sized = sizeBatchAtLanding(ctx, statics, predicted, solution);
    if (!sized) {
      memory.stats.batchesSkipped++;
      noteMissedWindow(memory, "arrival-security");
      return;
    }
    const safeHackThreads = hackThreadsAtLanding(ctx, statics, predicted, solution.hackThreads) ?? 0;
    if (safeHackThreads < solution.hackThreads) {
      noteMissedWindow(memory, "arrival-money");
      if (safeHackThreads < 1) {
        memory.stats.batchesSkipped++;
      }
    }

    const ops = (
      shotgun
        ? solution.kind === "hgw"
          ? [
              { kind: "hack" as const, threads: safeHackThreads, duration: hackMs, landing: anchor, stock: influence?.side === "short" },
              { kind: "grow" as const, threads: sized.growThreads, duration: growMs, landing: anchor, stock: influence?.side === "long" },
              { kind: "weaken" as const, threads: sized.weaken2Threads, duration: weakenMs, landing: anchor, stock: false },
            ]
          : [
              { kind: "hack" as const, threads: safeHackThreads, duration: hackMs, landing: anchor, stock: influence?.side === "short" },
              { kind: "weaken" as const, threads: sized.weaken1Threads, duration: weakenMs, landing: anchor, stock: false },
              { kind: "grow" as const, threads: sized.growThreads, duration: growMs, landing: anchor, stock: influence?.side === "long" },
              { kind: "weaken" as const, threads: sized.weaken2Threads, duration: weakenMs, landing: anchor, stock: false },
            ]
        : solution.kind === "hgw"
        ? [
            { kind: "hack" as const, threads: safeHackThreads, duration: hackMs, landing: anchor, stock: influence?.side === "short" },
            { kind: "grow" as const, threads: sized.growThreads, duration: growMs, landing: anchor + SPACER_MS, stock: influence?.side === "long" },
            { kind: "weaken" as const, threads: sized.weaken2Threads, duration: weakenMs, landing: anchor + 2 * SPACER_MS, stock: false },
          ]
        : [
            { kind: "hack" as const, threads: safeHackThreads, duration: hackMs, landing: anchor, stock: influence?.side === "short" },
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
      memory.stats.batchesSkipped++;
      noteMissedWindow(memory, "deadline");
      return;
    }

    const trackOp = (
      op: (typeof ops)[number],
      hostname: string,
      threads: number,
      effectThreads: number,
      gb: number,
      worker?: { id: number; spawn: boolean },
    ): void => {
      const opId = memory.nextOpId++;
      actions.push({
        type: op.kind,
        target: host,
        source: hostname,
        threads,
        opId,
        additionalMsec: op.landing - now - op.duration,
        ...(op.stock ? { stock: true } : {}),
        ...(worker ? { worker } : {}),
      });
      memory.tracked.set(opId, {
        hostname,
        target: host,
        kind: op.kind,
        segment: "farm",
        gb,
        wave: false,
        landing: op.landing,
        effectThreads,
        ...(worker ? { workerId: worker.id, spawned: worker.spawn } : {}),
      });
      memory.inFlight[op.kind]++;
      memory.stats.launched[op.kind]++;
      if (op.stock) memory.stats.stockOps++;
      if (!worker || worker.spawn) memory.stats.execs++;
      accountRamWork(memory, "farm", op.kind, gb, op.duration, op.landing - now - op.duration);
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
          trackOp(
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
      for (const worker of plan.take) reservedWorkers.add(worker.workerId);
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
      for (const worker of plan.take) {
        noteJobStart(memory.pool, worker.workerId);
        trackOp(op, worker.hostname, worker.threads, worker.effectThreads, worker.gb, {
          id: worker.workerId,
          spawn: false,
        });
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
          trackOp(op, block.hostname, block.threads, effectThreads, gb, { id: workerId, spawn: true });
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
  for (const tracked of memory.tracked.values()) {
    if (tracked.target === server.hostname && tracked.segment === "farm" && !tracked.wave) return;
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
      memory.tracked.set(opId, {
        hostname: block.hostname,
        target: server.hostname,
        kind,
        segment,
        gb: block.threads * WORKER_RAM[kind],
        wave: true,
        landing,
        effectThreads: block.threads * coreEffect(memory.heap.host(block.hostname)?.cores ?? 1),
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
      memory.segmentGb[segment] += block.threads * WORKER_RAM[kind];
      memory.prepInFlight.set(server.hostname, (memory.prepInFlight.get(server.hostname) ?? 0) + 1);
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
    const threads = Math.min(wantedThreads, affordable, memory.heap.capacity(WORKER_RAM[kind]));
    if (threads < 1) return 0;
    const allocation = memory.heap.allocate({
      blockSize: WORKER_RAM[kind],
      threads,
      policy: "spread",
      coreAware: true,
    });
    if (!allocation.ok) {
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
    const coverEffectThreads = Math.ceil((0.004 * maxGrowThreads) / weakenEffect(ctx, 1, 1));
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
