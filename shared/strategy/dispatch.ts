import { growTimeSeconds, hackTimeSeconds, makeHackContext, weakenTimeSeconds, type HackContext } from "../formulas.ts";
import { Heap } from "../ram/heap.ts";
import type { Action, CompletionEvent, ServerView, StockInfluence, WorldView } from "../world.ts";
import { WORKER_RAM } from "../world.ts";
import type { SegmentKind, TargetDirective } from "./directive.ts";
import {
  initEvaluator,
  staticsOf,
  stepEvaluator,
  type EvaluatorMemory,
  type FleetCapacity,
} from "./evaluator.ts";
import { isPrepped, solvePrep, type CycleSolution } from "./targeting.ts";

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
 * that never lands cannot leak. */

export const SPACER_MS = 200;
export const INTERVAL_MS = 4 * SPACER_MS;
/** Cap launches per pass so one scheduler call stays inside the tick budget. */
export const MAX_BATCHES_PER_PASS = 8;
export const MAX_PREP_OPS_PER_PASS = 6;
const PSERV_RAM = 64;
const BUY_HEADROOM = 2;

interface Tracked {
  hostname: string;
  kind: "hack" | "grow" | "weaken";
  segment: SegmentKind;
  gb: number;
}

export interface DispatchStats {
  launched: { hack: number; grow: number; weaken: number };
  landed: { hack: number; grow: number; weaken: number };
  moneyEarned: number;
  hacks: number;
  allocFails: number;
  batchesSkipped: number;
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
  stats: DispatchStats;
}

export interface DispatchOptions {
  /** GB kept free on home for the controller and dodge stubs. */
  homeReserveGb?: number;
  /** Money still needed for the active goal — sets the switch horizon. */
  goalRemaining?: number;
  /** Expected remaining run time in ms (the endgame route's estimate). Caps
   *  the evaluator's amortization horizon alongside the goal. */
  horizonMs?: number;
  /** Emit buyServer/upgradeHomeRam actions. In the live game the shared
   *  investment arbiter owns home/cloud/Hacknet spending, so the driver leaves
   *  this off; the sim's farm mode runs no feature drivers or arbiter, so the
   *  dispatcher is its only owner and must keep emitting them. */
  buyInfrastructure?: boolean;
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
    stats: {
      launched: { hack: 0, grow: 0, weaken: 0 },
      landed: { hack: 0, grow: 0, weaken: 0 },
      moneyEarned: 0,
      hacks: 0,
      allocFails: 0,
      batchesSkipped: 0,
    },
  };
}

function syncTopology(memory: DispatchMemory, view: WorldView, homeReserveGb: number): FleetCapacity {
  let fleetGb = 0;
  let largestBlockGb = 0;
  for (const server of view.servers) {
    if (!server.hasAdminRights || server.maxRam < 2) continue;
    const reserved = server.hostname === "home" ? homeReserveGb : 0;
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
    if (usable > largestBlockGb) largestBlockGb = usable;
  }
  return { fleetGb, largestBlockGb };
}

function release(memory: DispatchMemory, opId: number): void {
  const tracked = memory.tracked.get(opId);
  if (!tracked) return;
  memory.heap.free(tracked.hostname, tracked.gb);
  memory.tracked.delete(opId);
  memory.inFlight[tracked.kind]--;
  memory.segmentGb[tracked.segment] -= tracked.gb;
}

/** Roll back ops the driver could not actually start (sim rejection, ns.exec
 * returning pid 0). Without this the reservation would never be freed — the
 * exact leak the earlier rewrite's dispatcher had (`nobody0/bitburner`; see
 * README's citation note). */
export function releaseFailed(memory: DispatchMemory, opIds: Iterable<number>): void {
  for (const opId of opIds) {
    const tracked = memory.tracked.get(opId);
    if (!tracked) continue;
    const host = tracked.hostname;
    release(memory, opId);
    const inFlight = memory.prepInFlight.get(host);
    if (inFlight !== undefined) {
      if (inFlight > 1) memory.prepInFlight.set(host, inFlight - 1);
      else memory.prepInFlight.delete(host);
    }
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

  for (const completion of completions) {
    if (completion.kind === "sleep") continue;
    memory.stats.landed[completion.kind]++;
    if (completion.kind === "hack" && completion.result?.success) {
      memory.stats.moneyEarned += completion.result.moneyGained ?? 0;
      memory.stats.hacks++;
    }
    if (completion.target) {
      const remaining = (memory.prepInFlight.get(completion.target) ?? 0) - 1;
      if (remaining > 0) memory.prepInFlight.set(completion.target, remaining);
      else memory.prepInFlight.delete(completion.target);
    }
    if (completion.opId !== undefined) release(memory, completion.opId);
  }

  const capacity = syncTopology(memory, view, homeReserveGb);
  const stepped = stepEvaluator(
    view,
    memory.evaluator,
    capacity,
    options.goalRemaining ?? Infinity,
    options.horizonMs ?? Infinity,
  );
  memory.evaluator = stepped.memory;
  const directive = stepped.directive;

  const byHost = new Map(view.servers.map((s) => [s.hostname, s]));
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
  for (const segment of directive.segments) {
    const budget = segment.gb - memory.segmentGb[segment.kind];
    if (budget <= 0) continue;

    if (segment.kind === "farm" && directive.farm) {
      const server = byHost.get(directive.farm.host);
      if (!server) continue;
      if (isPrepped(server)) {
        launchBatches(memory, actions, directive.farm.solution, server, now, budget, launchCtx, view.stockInfluence?.[server.hostname]);
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

function allocFor(
  memory: DispatchMemory,
  kind: "hack" | "grow" | "weaken",
  threads: number,
): { blockSize: number; threads: number; policy: "contiguous" | "homeFirst" | "spread"; coreAware: boolean } {
  return {
    blockSize: WORKER_RAM[kind],
    threads,
    // hack must land as one call; grow prefers home for its core bonus;
    // weaken is perfectly divisible and eats fragments.
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
): void {
  const host = server.hostname;
  const difficulty = server.hackDifficulty;
  const required = server.requiredHackingSkill;
  const hackMs = hackTimeSeconds(ctx, difficulty, required) * 1_000;
  const growMs = growTimeSeconds(ctx, difficulty, required) * 1_000;
  const weakenMs = weakenTimeSeconds(ctx, difficulty, required) * 1_000;
  const maxDepth = Math.max(1, Math.floor(weakenMs / INTERVAL_MS));
  let remaining = budgetGb;

  for (let launched = 0; launched < MAX_BATCHES_PER_PASS; launched++) {
    const batchesInFlight = memory.inFlight.hack;
    if (batchesInFlight >= maxDepth) return;
    if (remaining < solution.ramPerBatch) return;

    // Anchor: far enough out that every padding is positive, and at least one
    // INTERVAL after the previous batch (collision guard).
    const anchor = Math.max(now + weakenMs + SPACER_MS, memory.lastAnchor + INTERVAL_MS);
    const ops = [
      { kind: "hack" as const, threads: solution.hackThreads, duration: hackMs, landing: anchor, stock: influence?.side === "short" },
      { kind: "weaken" as const, threads: solution.weaken1Threads, duration: weakenMs, landing: anchor + SPACER_MS, stock: false },
      { kind: "grow" as const, threads: solution.growThreads, duration: growMs, landing: anchor + 2 * SPACER_MS, stock: influence?.side === "long" },
      { kind: "weaken" as const, threads: solution.weaken2Threads, duration: weakenMs, landing: anchor + 3 * SPACER_MS, stock: false },
    ].filter((op) => op.threads >= 1);

    if (ops.some((op) => op.landing - now - op.duration < 0)) {
      memory.stats.batchesSkipped++;
      return;
    }

    const allocation = memory.heap.allocateAll(ops.map((op) => allocFor(memory, op.kind, op.threads)));
    if (!allocation.ok) {
      memory.stats.allocFails++;
      return;
    }

    memory.lastAnchor = anchor;
    ops.forEach((op, index) => {
      const reservation = allocation.reservations[index]!;
      for (const block of reservation.blocks) {
        const opId = memory.nextOpId++;
        // One action per block; the reservation is shared, so it is released
        // when the LAST block of the op completes (release is idempotent and
        // guarded by tracked-map membership).
        actions.push({
          type: op.kind,
          target: host,
          source: block.hostname,
          threads: block.threads,
          opId,
          additionalMsec: op.landing - now - op.duration,
          ...(op.stock ? { stock: true } : {}),
        });
        memory.tracked.set(opId, {
          hostname: block.hostname,
          kind: op.kind,
          segment: "farm",
          gb: block.threads * WORKER_RAM[op.kind],
        });
        memory.inFlight[op.kind]++;
        memory.stats.launched[op.kind]++;
      }
      remaining -= reservation.gb;
      memory.segmentGb.farm += reservation.gb;
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
  if ((memory.prepInFlight.get(server.hostname) ?? 0) > 0) return;

  const ctx = memory.evaluator.ctx;
  if (!ctx) return;

  // Solve the prep plan for THIS host (µs-cheap) rather than reusing another
  // host's plan: weaken to min security first, then grow to max money.
  const plan = solvePrep(ctx, staticsOf(server), {
    hackDifficulty: server.hackDifficulty,
    moneyAvailable: server.moneyAvailable,
  });
  const kind: "weaken" | "grow" = plan.weaken1Threads > 0 ? "weaken" : "grow";
  const wanted = kind === "weaken" ? plan.weaken1Threads : plan.growThreads + plan.weaken2Threads;
  if (wanted < 1) return;

  // Prep grows push the price UP for free: the op is launched either way, so for
  // a LONG position the flag costs nothing and buys a nudge. Prep never hacks,
  // so a short gets nothing from this path.
  const growInfluences = view.stockInfluence?.[server.hostname]?.side === "long";

  // Prep work is divisible, so it always spreads (a 50-thread grow must not
  // demand one contiguous block) and is sized to what the fleet can place.
  const affordable = Math.floor(budgetGb / WORKER_RAM[kind]);
  const threads = Math.min(wanted, affordable, memory.heap.capacity(WORKER_RAM[kind]));
  if (threads < 1) return;

  const allocation = memory.heap.allocate({ blockSize: WORKER_RAM[kind], threads, policy: "spread", coreAware: true });
  if (!allocation.ok) {
    memory.stats.allocFails++;
    return;
  }

  let ops = 0;
  for (const block of allocation.reservation.blocks) {
    if (ops >= MAX_PREP_OPS_PER_PASS) {
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
      ...(kind === "grow" && growInfluences ? { stock: true } : {}),
    });
    memory.tracked.set(opId, {
      hostname: block.hostname,
      kind,
      segment,
      gb: block.threads * WORKER_RAM[kind],
    });
    memory.inFlight[kind]++;
    memory.stats.launched[kind]++;
    memory.segmentGb[segment] += block.threads * WORKER_RAM[kind];
    memory.prepInFlight.set(server.hostname, (memory.prepInFlight.get(server.hostname) ?? 0) + 1);
    ops++;
  }
}
