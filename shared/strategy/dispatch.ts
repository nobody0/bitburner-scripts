import {
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
import type { SegmentKind, TargetDirective } from "./directive.ts";
import {
  FARM_SOLVE_SHARE,
  WORKER_RAM_FLOOR,
  initEvaluator,
  staticsOf,
  stepEvaluator,
  type EvaluatorMemory,
  type FleetCapacity,
} from "./evaluator.ts";
import { isPrepped, solveCycle, solvePrep, type CycleSolution, type RamCaps } from "./targeting.ts";
import { coreEffect } from "../ram/heap.ts";
import { decideMode, type FarmMode } from "./mode.ts";
import { predictAtLanding, sizeBatchAtLanding, type LedgerOp } from "./prediction.ts";
import {
  initPool,
  noteExit,
  noteJobDone,
  noteJobStart,
  noteSpawn,
  planTake,
  type WorkerPoolMemory,
} from "./worker-pool.ts";

/** HWGW batch dispatcher — pure. Emits Actions with additionalMsec so the four
 * ops land in order H → W1 → G → W2, `SPACER` apart. The same code runs in the
 * sim (virtual clock) and in the game (real ns), so A/B results transfer.
 *
 * Landing math per op: additionalMsec = landing − now − duration. Anchoring the
 * hack landing at now + weakenTime + SPACER keeps every padding positive; each
 * batch is anchored at least INTERVAL after the previous one, which is the
 * collision guard (pure bookkeeping — no ns reads).
 *
 * RAM: batch-atomic allocation (all four ops or none) from the shared heap.
 * Reservations are released when the matching completion arrives, so an op
 * that never lands cannot leak.
 * Source (additionalMsec is added to each duration at invocation): https://github.com/bitburner-official/bitburner-src/blob/3162fd2590e221eadd0c0fbd46151913f7c4c41c/src/Netscript/NetscriptHelpers.tsx#L537-L561 and https://github.com/bitburner-official/bitburner-src/blob/3162fd2590e221eadd0c0fbd46151913f7c4c41c/src/NetscriptFunctions.ts#L266-L286 */

export const SPACER_MS = 200;
/** Distinct prep effects use the same proven timer guard as farm effects. This
 * is landing precision, not a minimum time for staying on a target. */
export const PREP_ORDER_MS = SPACER_MS;
export const INTERVAL_MS = 4 * SPACER_MS; // == targeting's BATCH_INTERVAL_S · 1000
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
const PSERV_RAM = 64;
const BUY_HEADROOM = 2;

interface Tracked {
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
}

export interface DispatchStats {
  launched: { hack: number; grow: number; weaken: number };
  landed: { hack: number; grow: number; weaken: number };
  moneyEarned: number;
  /** Estimated from the formulas at completion (see the dispatch loop). */
  expEarned: number;
  hacks: number;
  allocFails: number;
  batchesSkipped: number;
  /** Ops that needed a fresh process (one-shots + pool spawns). The pooling
   * win is this staying flat while `launched` keeps climbing. */
  execs: number;
  /** Ops launched carrying a `{stock:true}` influence flag. The only visible
   * link between "manipulation intended" and "nudges actually rolled" — a
   * manipulation run where this stays 0 has an open influence loop. */
  stockOps: number;
}

export interface DispatchMemory {
  heap: Heap;
  evaluator: EvaluatorMemory;
  tracked: Map<number, Tracked>;
  inFlight: { hack: number; grow: number; weaken: number };
  segmentGb: Record<SegmentKind, number>;
  /** host -> op count in flight, so prep fires in non-overlapping waves. */
  prepInFlight: Map<string, number>;
  nextOpId: number;
  nextServerIndex: number;
  lastAnchor: number;
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
  /** GB kept free on home for the controller and dodge stubs. */
  homeReserveGb?: number;
  /** Home-reserve SHORTFALL to keep free on the largest fleet host instead —
   *  nonzero only when the 40% home cap truncated the wanted reserve
   *  (shared/ram/reserve.ts `capped`). Dodge placement may spend it exactly
   *  like home's reserve. */
  fleetReserveGb?: number;
  /** Money still needed for the active goal — sets the switch horizon. */
  goalRemaining?: number;
  /** Expected remaining run time in ms (the endgame route's estimate). Caps
   *  the evaluator's amortization horizon alongside the goal. */
  horizonMs?: number;
  /** Best observed marginal income/sec per invested dollar. */
  reinvestmentReturnPerDollarSec?: number;
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
}

export function initDispatch(): DispatchMemory {
  return {
    heap: new Heap(),
    evaluator: initEvaluator(),
    tracked: new Map(),
    inFlight: { hack: 0, grow: 0, weaken: 0 },
    segmentGb: { farm: 0, prep: 0, share: 0 },
    prepInFlight: new Map(),
    nextOpId: 1,
    nextServerIndex: 0,
    lastAnchor: -Infinity,
    mode: "hwgw",
    modeSince: -Infinity,
    modeWhy: "initial",
    pool: initPool(),
    stats: {
      launched: { hack: 0, grow: 0, weaken: 0 },
      landed: { hack: 0, grow: 0, weaken: 0 },
      moneyEarned: 0,
      expEarned: 0,
      hacks: 0,
      allocFails: 0,
      batchesSkipped: 0,
      execs: 0,
      stockOps: 0,
    },
  };
}

/** Bounded prefix of the per-host free list handed to the solver; beyond it
 * the slot count is saturated anyway. */
const HOST_BLOCKS_LIMIT = 64;

function syncTopology(
  memory: DispatchMemory,
  view: WorldView,
  homeReserveGb: number,
  fleetReserveGb = 0,
): FleetCapacity {
  // Our own in-flight ops are transient — their RAM frees within one batch
  // cycle, so they must NOT shrink what the solver may plan with. Foreign
  // usage (the controller's own footprint, anything else running) is standing
  // and must: sizing a hack block to `maxRam − reserved` on a home that also
  // hosts the controller produced blocks that could NEVER be placed, which is
  // how a 32 GB home stalled the dispatcher outright.
  const ours = new Map<string, number>();
  for (const tracked of memory.tracked.values()) {
    ours.set(tracked.hostname, (ours.get(tracked.hostname) ?? 0) + tracked.gb);
  }
  // A home too small to hold the full feature-step reserve (the 40% cap in
  // shared/ram/reserve.ts) spills the SHORTFALL onto a fleet host, so the
  // biggest declared probe step stays affordable somewhere. Without this the
  // farm packs every fleet block and the probe that is a feature's only
  // signal source starves — measured: stock-manipulation observed 906/3600
  // market ticks because the 10 GB sampler lost every sweep.
  //
  // SMALLEST host that fits, not the largest: the hack block must land as ONE
  // contiguous call, so carving the reserve out of the biggest host shrinks
  // `largestBlockGb` for every solve (measured on bn1-speedrun: fleet
  // utilization fell ~90% → ~72% with the reserve parked on the top host).
  // Same best-fit policy as dodgeHost. The largest host is a fallback only
  // while the reserve itself still fits on it: consuming an undersized host
  // would reduce farm capacity without making the starved dodge executable.
  let reserveHost: string | undefined;
  if (fleetReserveGb > 0) {
    const fitsGb = fleetReserveGb + 4; // stub base + a couple of threads of churn
    let largest: string | undefined;
    let largestRam = 0;
    let smallestFit: string | undefined;
    let smallestFitRam = Infinity;
    for (const server of view.servers) {
      if (!server.hasAdminRights || server.hostname === "home" || server.maxRam < 2) continue;
      if (server.maxRam > largestRam || (server.maxRam === largestRam && server.hostname < (largest ?? "￿"))) {
        largest = server.hostname;
        largestRam = server.maxRam;
      }
      if (
        server.maxRam >= fitsGb &&
        (server.maxRam < smallestFitRam || (server.maxRam === smallestFitRam && server.hostname < (smallestFit ?? "￿")))
      ) {
        smallestFit = server.hostname;
        smallestFitRam = server.maxRam;
      }
    }
    reserveHost = smallestFit ?? (largestRam >= fleetReserveGb ? largest : undefined);
  }
  let fleetGb = 0;
  let largestBlockGb = 0;
  const hostBlocksGb: number[] = [];
  const freeNowBlocksGb: number[] = [];
  for (const server of view.servers) {
    if (!server.hasAdminRights || server.maxRam < 2) continue;
    const reserved =
      server.hostname === "home"
        ? homeReserveGb
        : server.hostname === reserveHost
          ? fleetReserveGb
          : 0;
    const existing = memory.heap.host(server.hostname);
    // The heap owns `used` (reservation ledger); topology comes from the view.
    memory.heap.upsert(
      server.hostname,
      server.maxRam,
      existing?.used ?? server.usedRam,
      server.cpuCores,
      reserved,
    );
    const usable = Math.max(0, server.maxRam - reserved);
    fleetGb += usable;
    const ledgerUsed = memory.heap.host(server.hostname)?.used ?? 0;
    const externalUsed = Math.max(0, ledgerUsed - (ours.get(server.hostname) ?? 0));
    const placeable = Math.max(0, server.maxRam - reserved - externalUsed);
    if (placeable > largestBlockGb) largestBlockGb = placeable;
    if (placeable >= WORKER_RAM.hack) hostBlocksGb.push(placeable);
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
  return { fleetGb, largestBlockGb, hostBlocksGb, prepWaveGb, prepFreeGb, prepWaveInFlight };
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

/** Roll back ops the driver could not actually start (sim rejection, ns.exec
 * returning pid 0). Without this the reservation would never be freed — the
 * exact leak the earlier rewrite's dispatcher had (`nobody0/bitburner`; see
 * README's citation note). A pooled op that failed to START also means its
 * worker is gone (spawn failed) or dead (job post found no mailbox), so the
 * worker's reservation goes with it. */
export function releaseFailed(memory: DispatchMemory, opIds: Iterable<number>): void {
  for (const opId of opIds) {
    const tracked = memory.tracked.get(opId);
    if (!tracked) continue;
    if (tracked.workerId !== undefined) releaseWorker(memory, tracked.workerId);
    release(memory, opId);
  }
}

/** One dispatcher pass: absorb completions, refresh the directive, launch work. */
export function dispatch(
  view: WorldView,
  memory: DispatchMemory,
  completions: CompletionEvent[],
  options: DispatchOptions = {},
): { actions: Action[]; directive: TargetDirective; switched?: { from?: string; to: string } } {
  // Default 0: the pure engine reserves nothing. The game driver passes
  // HOME_RESERVE_GB so dodge stubs always have headroom.
  const homeReserveGb = options.homeReserveGb ?? 0;

  const byHost = new Map(view.servers.map((s) => [s.hostname, s]));
  for (const completion of completions) {
    if (completion.kind === "sleep") continue;
    if (completion.kind === "workerExit") {
      // A serve worker's process ended (idle timeout, kill, reload): its RAM
      // frees NOW, not when its jobs completed.
      if (completion.opId !== undefined) releaseWorker(memory, completion.opId);
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
      if (tracked?.workerId !== undefined) noteJobDone(memory.pool, tracked.workerId, view.time);
      release(memory, completion.opId);
    }
  }

  const capacity = syncTopology(memory, view, homeReserveGb, options.fleetReserveGb ?? 0);
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
    },
  );
  memory.evaluator = stepped.memory;
  const directive = stepped.directive;

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
    const pservCost = view.prices.cloudServer[PSERV_RAM] ?? Infinity;
    const owned = view.servers.filter((s) => s.purchasedByPlayer && s.hostname !== "home").length;
    if (owned < view.prices.cloudServerLimit && view.player.money >= BUY_HEADROOM * pservCost) {
      actions.push({ type: "buyServer", ram: PSERV_RAM, name: `pserv-${memory.nextServerIndex++}` });
    }
    if (view.player.money >= BUY_HEADROOM * view.prices.upgradeHomeRam) {
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
  for (const segment of directive.segments) {
    if (segment.kind === "share") spillGb += Math.max(0, segment.gb - memory.segmentGb.share);
    if (segment.kind === "prep" && !prepActive) spillGb += Math.max(0, segment.gb - memory.segmentGb.prep);
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
    const budget = segmentCap - memory.segmentGb[segment.kind];
    if (budget <= 0) continue;

    if (segment.kind === "farm" && directive.farm) {
      const server = byHost.get(directive.farm.host);
      if (!server) continue;
      if (isPrepped(server)) {
        // Mode: HOW to farm this target (shared/strategy/mode.ts). Decided
        // here — where the farm server and live ctx are in hand — with the
        // dwell carried in memory. Shotgun is wired in launchBatches.
        const weakenMs = weakenTimeSeconds(launchCtx, server.hackDifficulty, server.requiredHackingSkill) * 1_000;
        const decision = options.modeOverride
          ? { mode: options.modeOverride, why: "override" }
          : decideMode({
              weakenMs,
              liveOps: memory.tracked.size,
              lastMode: memory.mode,
              lastModeSince: memory.modeSince,
              now,
            });
        if (decision.mode !== memory.mode) {
          memory.mode = decision.mode;
          memory.modeSince = now;
        }
        memory.modeWhy = decision.why;
        // Shotgun (Q4) uses the HGW thread math taken to its limit: all three
        // ops of a batch land the same tick, so the shape is HGW's.
        const wantHgw = memory.mode === "hgw" || memory.mode === "shotgun";
        const hgwSolution = wantHgw ? hgwSolutionFor(memory, view, directive.farm.host, capacity) : undefined;
        const solution = hgwSolution ?? directive.farm.solution;
        // A shotgun wave is intrinsically H/G/W. If that larger support shape
        // does not fit the current caps, retain the cached four-op HWGW shape;
        // emitting three ops sized from an HWGW solution leaves hack security
        // uncovered.
        const shotgun = memory.mode === "shotgun" && hgwSolution !== undefined;
        // Pooling only pays when a worker's NEXT job arrives before its idle
        // timeout. The steady-state launch period is weakenTime over the
        // achievable depth — depth from the SEGMENT total, not this pass's
        // residual budget (which shrinks to ~one batch once the pipeline is
        // full and would read as "no reuse" forever). When RAM or weakenTime
        // keeps depth low — the whole early game — a pooled worker would idle
        // out before reuse, degenerating to spawn-per-op plus an idle timeout
        // of stranded RAM (measured: +11 % time-to-goal on a 16 GB start).
        const interval = solution.kind === "hgw" ? 3 * SPACER_MS : INTERVAL_MS;
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
        launchBatches(
          memory,
          actions,
          solution,
          server,
          now,
          budget,
          launchCtx,
          view.stockInfluence?.[server.hostname],
          pooling,
          shotgun,
          borrow,
        );
      } else {
        launchPrepWave(memory, actions, view, server, budget, "farm");
      }
    } else if (segment.kind === "prep" && directive.prep) {
      const server = byHost.get(directive.prep.host);
      if (!server || isPrepped(server)) continue;
      launchPrepWave(memory, actions, view, server, budget, "prep");
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
    // Hack must land as one call; steady-state grow prefers home for its core
    // bonus and may spread when no single host fits. Prediction folds those
    // blocks separately. Prep grow uses an explicit contiguous request. Weaken
    // is exactly additive and consumes fragments. Cores amplify grow/weaken;
    // hack has no core term.
    // Source: https://github.com/bitburner-official/bitburner-src/blob/3162fd2590e221eadd0c0fbd46151913f7c4c41c/src/Server/formulas/grow.ts#L20-L28 and https://github.com/bitburner-official/bitburner-src/blob/3162fd2590e221eadd0c0fbd46151913f7c4c41c/src/Server/ServerHelpers.ts#L287-L295
    policy: kind === "hack" ? "contiguous" : kind === "grow" ? "homeFirst" : "spread",
    coreAware: kind !== "hack",
  };
}

function launchBatches(
  memory: DispatchMemory,
  actions: Action[],
  solution: CycleSolution,
  server: ServerView,
  now: number,
  budgetGb: number,
  ctx: HackContext,
  /** What `stock` wants this host's symbol to do, when it wants anything.
   *  Exactly ONE side of the batch carries the flag: a long is driven by the
   *  grow and a short by the hack. Flagging both would cancel the nudges out —
   *  in steady state the grow restores precisely what the hack took, so the two
   *  influence rolls are equal and opposite. */
  influence?: StockInfluence,
  pooling = false,
  shotgun = false,
  /** Extra prep RAM this pass may borrow. Every op of a batch using it must
   * land before the current prep wave, so the next wave can reclaim it. */
  borrow?: { gb: number; landingDeadline: number },
): void {
  const host = server.hostname;
  const difficulty = server.hackDifficulty;
  const required = server.requiredHackingSkill;
  const hackMs = hackTimeSeconds(ctx, difficulty, required) * 1_000;
  const growMs = growTimeSeconds(ctx, difficulty, required) * 1_000;
  const weakenMs = weakenTimeSeconds(ctx, difficulty, required) * 1_000;
  // HGW batches have three landings, so their interval is one spacer shorter.
  const intervalMs = solution.kind === "hgw" ? 3 * SPACER_MS : INTERVAL_MS;
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
    const anchor = shotgun ? now + weakenMs : Math.max(now + weakenMs + SPACER_MS, memory.lastAnchor + intervalMs);

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
      return;
    }

    const ops = (
      shotgun
        ? [
            { kind: "hack" as const, threads: sized.hackThreads, duration: hackMs, landing: anchor, stock: influence?.side === "short" },
            { kind: "grow" as const, threads: sized.growThreads, duration: growMs, landing: anchor, stock: influence?.side === "long" },
            { kind: "weaken" as const, threads: sized.weaken2Threads, duration: weakenMs, landing: anchor, stock: false },
          ]
        : solution.kind === "hgw"
        ? [
            { kind: "hack" as const, threads: sized.hackThreads, duration: hackMs, landing: anchor, stock: influence?.side === "short" },
            { kind: "grow" as const, threads: sized.growThreads, duration: growMs, landing: anchor + SPACER_MS, stock: influence?.side === "long" },
            { kind: "weaken" as const, threads: sized.weaken2Threads, duration: weakenMs, landing: anchor + 2 * SPACER_MS, stock: false },
          ]
        : [
            { kind: "hack" as const, threads: sized.hackThreads, duration: hackMs, landing: anchor, stock: influence?.side === "short" },
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
    };

    if (!pooling) {
      const allocation = memory.heap.allocateAll(ops.map((op) => allocFor(op.kind, op.threads)));
      if (!allocation.ok) {
        memory.stats.allocFails++;
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
      memory.segmentGb[segment] += block.threads * WORKER_RAM[kind];
      memory.prepInFlight.set(server.hostname, (memory.prepInFlight.get(server.hostname) ?? 0) + 1);
      effectThreads += block.threads * coreEffect(block.cores);
      budgetRemainingGb -= block.threads * WORKER_RAM[kind];
      ops++;
    }
    return effectThreads;
  };
  const launchKind = (kind: "weaken" | "grow", wantedThreads: number, opCap: number): number => {
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
      return 0;
    }
    return emitReservation(kind, allocation.reservation, opCap);
  };

  // W1, G and W2 may share one in-flight wave; padding, not launch time,
  // makes security land first. If the complete W1 cannot be reserved, launch
  // only the partial weaken and defer every grow rather than grow at high
  // security. Launching the W2 threads as extra
  // grows — the old behaviour — over-grew the target and left the grow's
  // security for the NEXT wave's W1 to clean up: self-correcting, but a whole
  // extra weaken-time of prep latency and wasted grow RAM. The cover is sized
  // to the grow that ACTUALLY launched (op cap and budget truncate the plan),
  // with one op slot held back so the grow cannot starve its weaken cover.
  if (plan.weaken1Threads > 0) {
    const weakened = launchKind("weaken", plan.weaken1Threads, MAX_PREP_OPS_PER_PASS);
    if (weakened + 1e-9 < plan.weaken1Threads) return;
  }

  interface GrowWaveReservation {
    grow: Reservation;
    weaken: Reservation;
    effectGrowThreads: number;
  }
  let firstGrowLanding: number;
  if (plan.weaken1Threads > 0) {
    firstGrowLanding = nativeLanding.weaken + PREP_ORDER_MS;
  } else {
    // Already at minimum security: the first grow needs no leading weaken and
    // should land at its native deadline. Its W2 may land later; only the NEXT
    // grow has to wait until that cover has restored minimum security.
    firstGrowLanding = nativeLanding.grow;
  }
  const firstWeakenLanding = Math.max(nativeLanding.weaken, firstGrowLanding + PREP_ORDER_MS);
  const pairLandings = (index: number): { grow: number; weaken: number } => ({
    grow: index === 0 ? firstGrowLanding : firstWeakenLanding + (2 * index - 1) * PREP_ORDER_MS,
    weaken: index === 0 ? firstWeakenLanding : firstWeakenLanding + 2 * index * PREP_ORDER_MS,
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
    const coverEffectThreads = Math.ceil((0.004 * realGrowThreads) / weakenEffect(ctx, 1, 1));
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
    return { grow, weaken, effectGrowThreads };
  };

  const pairs: GrowWaveReservation[] = [];
  let remainingEffectThreads = plan.growThreads;
  let reservedGb = 0;
  let reservedOps = 0;
  while (remainingEffectThreads >= 1 && reservedOps + 2 <= MAX_PREP_OPS_PER_PASS) {
    // Find the largest safe atomic pair on the remaining heap. Feasibility is
    // monotone for a fixed remaining topology: a smaller grow needs no more
    // contiguous RAM and no more weaken cover. Trial reservations are
    // released exactly before the next probe.
    let low = 1;
    let high = Math.min(
      Math.ceil(remainingEffectThreads),
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
    remainingEffectThreads -= pair.effectGrowThreads;
  }
  if (pairs.length === 0) return;

  // Each grow is one call, but the fleet can carry several pairs at once.
  // Alternate their landings so pair i's weaken has restored min security
  // before pair i+1 grows. This is the distributed/slab-friendly equivalent
  // of one huge atomic grow and avoids the 8 GB-home utilization cliff.
  for (let i = 0; i < pairs.length; i++) {
    const pair = pairs[i]!;
    const { grow: growLanding, weaken: weakenLanding } = pairLandings(i);
    // Cover first in launch order; landing order is still G -> W2.
    emitReservation("weaken", pair.weaken, MAX_PREP_OPS_PER_PASS, weakenLanding);
    emitReservation("grow", pair.grow, MAX_PREP_OPS_PER_PASS, growLanding);
  }
}
