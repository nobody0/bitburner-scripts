import { makeHackContext, type HackContext } from "../formulas.ts";
import type { ServerView, WorldView } from "../world.ts";
import type { Segment, TargetDirective } from "./directive.ts";
import {
  isEligible,
  prepTimeSeconds,
  solveCycle,
  solvePrep,
  type CycleSolution,
  type ManipulationValue,
  type PrepPlan,
  type RamCaps,
  type TargetStatics,
} from "./targeting.ts";

/** Incremental target evaluation. Steady-state scores depend only on static
 * fields + HackContext, so the round-robin can work off a stale snapshot: a
 * few servers per tick (slice budget << 10ms), argmax at the pass end.
 * Dynamic security/money only feeds prep plans of the hot set.
 *
 * Never mix context generations in one argmax: a skill jump bumps the
 * generation and re-scores before comparing. */

export const SLICE_MIN_MS = 2_000;
export const GATE_MIN_MS = 5_000;
export const SKILL_DELTA = 0.02;
/** Prep candidate must beat the farm target by this much to be worth prepping. */
export const PREP_MARGIN = 0.05;
/** Farm switch hysteresis on same-generation scores. */
export const SWITCH_MARGIN = 0.1;
/** Minimum time on a target before switching away. */
export const DWELL_MS = 60_000;
/** Candidate this much better reorders segments so prep outranks farm. */
export const REORDER_MARGIN = 0.25;
export const HORIZON_MIN_MS = 60_000;
export const HORIZON_MAX_MS = 1_800_000;
/** Default segment shares (the reorder rule swaps farm/prep priority). */
export const FARM_SHARE = 0.75;
export const PREP_SHARE = 0.25;
export const REORDER_PREP_SHARE = 0.6;
/** Fleet RAM change that invalidates cached (RAM-capped) solutions. */
export const FLEET_DELTA = 0.1;
/** Smallest sensible batch cap: one hack thread plus its support. */
const WORKER_RAM_FLOOR = 16;

/** What the dispatcher knows about placeable RAM, from its heap. */
export interface FleetCapacity {
  fleetGb: number;
  /** Largest single host (hack must land as one call). */
  largestBlockGb: number;
}

export interface TargetEntry {
  statics: TargetStatics;
  solution?: CycleSolution;
  /** ctx generation `solution` was computed under. */
  generation: number;
}

export interface EvaluatorMemory {
  entries: Map<string, TargetEntry>;
  order: string[];
  cursor: number;
  ctx?: HackContext;
  generation: number;
  ctxSkill: number;
  fleetGb: number;
  lastSliceAt: number;
  lastGateAt: number;
  directive: TargetDirective;
  farmSince: number;
  /** Set when something invalidates scores before the next scheduled gate. */
  forceGate: boolean;
  /** Fingerprint of the stock influence the cached solutions were scored under.
   *  A position opening or closing changes what a target is WORTH, not what it
   *  can do, so it has to invalidate the cache the same way a skill jump does —
   *  otherwise the farm keeps optimising for a position that no longer exists. */
  influenceKey: string;
}

export function initEvaluator(): EvaluatorMemory {
  return {
    entries: new Map(),
    order: [],
    cursor: 0,
    generation: 0,
    ctxSkill: -1,
    fleetGb: 0,
    lastSliceAt: -Infinity,
    lastGateAt: -Infinity,
    directive: { segments: [], ctxGeneration: -1, decidedAt: -Infinity },
    farmSince: -Infinity,
    forceGate: true,
    influenceKey: "",
  };
}

/** Stable fingerprint of the stock feature's manipulation intent.
 *
 * The value is bucketed to half-decades (`round(log10(v) * 2)`, so ~3.2x per
 * bucket) deliberately: a position drifting in mark-to-market value is not a
 * reason to re-solve every target, but opening, closing or reversing one — or a
 * change big enough to reorder the score — is. */
export function influenceFingerprint(view: WorldView): string {
  const influence = view.stockInfluence;
  if (!influence) return "";
  return Object.keys(influence)
    .sort()
    .map((host) => {
      const entry = influence[host]!;
      const magnitude = entry.valuePerOp > 0 ? Math.round(Math.log10(entry.valuePerOp) * 2) : -999;
      return `${host}:${entry.side}:${magnitude}`;
    })
    .join(",");
}

export function staticsOf(server: ServerView): TargetStatics {
  return {
    hostname: server.hostname,
    minDifficulty: server.minDifficulty,
    moneyMax: server.moneyMax,
    requiredHackingSkill: server.requiredHackingSkill,
    serverGrowth: server.serverGrowth,
    baseDifficulty: server.baseDifficulty,
  };
}

export function isCandidate(server: ServerView): boolean {
  return server.hasAdminRights && !server.purchasedByPlayer && server.hostname !== "home" && server.moneyMax > 0;
}

function contextFor(view: WorldView): HackContext {
  return makeHackContext(
    {
      skill: view.player.hackingSkill,
      intelligence: view.player.intelligence,
      mults: view.player.mults,
    },
    view.nodeMults ?? {},
  );
}

/** One evaluation step: refresh the candidate set, solve a slice of targets,
 * and — when the gate is due — pick farm/prep targets and segment order. */
export function stepEvaluator(
  view: WorldView,
  memory: EvaluatorMemory,
  capacity: FleetCapacity,
  goalRemaining: number,
  /** Expected remaining RUN time in ms (the endgame route's estimate). Caps
   *  the amortization horizon: a target whose prep only pays off after the
   *  run is expected to end is not worth switching to, however good its
   *  steady-state rate. Infinity preserves the goal-only behaviour. */
  horizonCapMs = Infinity,
): { memory: EvaluatorMemory; directive: TargetDirective; switched?: { from?: string; to: string } } {
  const now = view.time;

  // Context generation: a meaningful skill change invalidates every score.
  if (
    !memory.ctx ||
    memory.ctxSkill <= 0 ||
    Math.abs(view.player.hackingSkill - memory.ctxSkill) / Math.max(1, memory.ctxSkill) > SKILL_DELTA
  ) {
    memory.ctx = contextFor(view);
    memory.ctxSkill = view.player.hackingSkill;
    memory.generation++;
    memory.forceGate = true;
  }
  const ctx = memory.ctx;

  // Solutions must be executable: a batch that cannot fit the farm segment is
  // worthless however well it scores. A big fleet change re-solves everything.
  const fleetGb = capacity.fleetGb;
  const caps: RamCaps = {
    batchGb: Math.max(WORKER_RAM_FLOOR, fleetGb * FARM_SHARE),
    hackBlockGb: Math.max(WORKER_RAM_FLOOR, capacity.largestBlockGb),
  };
  if (memory.fleetGb <= 0 || Math.abs(fleetGb - memory.fleetGb) / Math.max(1, memory.fleetGb) > FLEET_DELTA) {
    memory.fleetGb = fleetGb;
    memory.generation++;
    memory.forceGate = true;
  }

  // A change in what `stock` wants re-prices every target, so it bumps the
  // generation exactly as a skill or fleet change does. Cheap: the fingerprint
  // is stable while a position is merely drifting in value.
  const influenceKey = influenceFingerprint(view);
  if (influenceKey !== memory.influenceKey) {
    memory.influenceKey = influenceKey;
    memory.generation++;
    memory.forceGate = true;
  }
  const manipulationFor = (hostname: string): ManipulationValue | undefined => {
    const entry = view.stockInfluence?.[hostname];
    return entry && entry.valuePerOp > 0 ? { valuePerOp: entry.valuePerOp, side: entry.side } : undefined;
  };

  // Candidate set (new roots appear here and get solved on their first slice).
  const candidates = view.servers.filter(isCandidate);
  if (candidates.length !== memory.order.length) {
    memory.order = candidates.map((s) => s.hostname);
    memory.forceGate = true;
  }
  for (const server of candidates) {
    const existing = memory.entries.get(server.hostname);
    if (existing) existing.statics = staticsOf(server);
    else memory.entries.set(server.hostname, { statics: staticsOf(server), generation: -1 });
  }

  // Round-robin slice: B = clamp(ceil(N/10), 1, 8) targets per tick.
  if (now - memory.lastSliceAt >= SLICE_MIN_MS && memory.order.length > 0) {
    memory.lastSliceAt = now;
    const batch = Math.min(8, Math.max(1, Math.ceil(memory.order.length / 10)));
    for (let i = 0; i < batch; i++) {
      const hostname = memory.order[memory.cursor % memory.order.length]!;
      memory.cursor++;
      const entry = memory.entries.get(hostname);
      if (!entry) continue;
      if (entry.generation !== memory.generation) {
        entry.solution = isEligible(ctx, entry.statics) ? solveCycle(ctx, entry.statics, 1, caps, manipulationFor(entry.statics.hostname)) : undefined;
        entry.generation = memory.generation;
      }
    }
  }

  const gateDue = memory.forceGate || now - memory.lastGateAt >= GATE_MIN_MS;
  if (!gateDue) return { memory, directive: memory.directive };

  memory.lastGateAt = now;
  memory.forceGate = false;

  // Gate: score everything at the current generation (cheap — see the bench;
  // 100 targets ≈ 0.6ms) so the argmax never mixes generations.
  for (const entry of memory.entries.values()) {
    if (entry.generation !== memory.generation) {
      entry.solution = isEligible(ctx, entry.statics) ? solveCycle(ctx, entry.statics, 1, caps, manipulationFor(entry.statics.hostname)) : undefined;
      entry.generation = memory.generation;
    }
  }

  const byHost = new Map(view.servers.map((s) => [s.hostname, s]));
  const ranked = [...memory.entries.values()]
    .filter((e) => e.solution && byHost.get(e.statics.hostname)?.hasAdminRights)
    .sort((a, b) => b.solution!.score - a.solution!.score);
  if (ranked.length === 0) {
    memory.directive = { segments: [], ctxGeneration: memory.generation, decidedAt: now };
    return { memory, directive: memory.directive };
  }

  const currentHost = memory.directive.farm?.host;
  const current = currentHost ? memory.entries.get(currentHost) : undefined;
  const currentScore = current?.solution?.score ?? 0;

  const prepOf = (entry: TargetEntry): PrepPlan | undefined => {
    const server = byHost.get(entry.statics.hostname);
    if (!server) return undefined;
    return solvePrep(ctx, entry.statics, {
      hackDifficulty: server.hackDifficulty,
      moneyAvailable: server.moneyAvailable,
    });
  };

  // Horizon bounds how far prep time is amortized (and caps skill staleness).
  // Two ceilings apply: how long the GOAL still needs at the current rate,
  // and how long the RUN is expected to last at all — whichever ends first.
  const currentRate = currentScore * fleetGb;
  const goalHorizonMs = currentRate > 0 ? (goalRemaining / currentRate) * 1000 : HORIZON_MAX_MS;
  const horizonMs = Math.min(HORIZON_MAX_MS, Math.max(HORIZON_MIN_MS, Math.min(goalHorizonMs, horizonCapMs)));

  // Farm pick: best PREPPED candidate, with hysteresis + dwell against the
  // incumbent. An unprepped better candidate becomes the prep target instead.
  let farmEntry: TargetEntry | undefined = current?.solution ? current : undefined;
  let switched: { from?: string; to: string } | undefined;
  const dwellOk = now - memory.farmSince >= DWELL_MS;
  for (const candidate of ranked) {
    const plan = prepOf(candidate);
    if (!plan?.prepped) continue;
    const better = candidate.solution!.score > currentScore * (1 + SWITCH_MARGIN);
    if (!farmEntry || (better && dwellOk) || !current?.solution) {
      if (candidate !== farmEntry) {
        switched = { from: farmEntry?.statics.hostname, to: candidate.statics.hostname };
        farmEntry = candidate;
        memory.farmSince = now;
      }
      break;
    }
    break;
  }
  if (!farmEntry) {
    // Nothing prepped yet: farm the best eligible target anyway (the
    // dispatcher will only fire hacks once it is actually prepped).
    farmEntry = ranked[0];
    if (farmEntry && farmEntry.statics.hostname !== currentHost) {
      switched = { from: currentHost, to: farmEntry.statics.hostname };
      memory.farmSince = now;
    }
  }

  // Prep pick: highest rate*(T - prepTime), must beat the farm target.
  const farmScore = farmEntry?.solution?.score ?? 0;
  let prepEntry: TargetEntry | undefined;
  let prepPlan: PrepPlan | undefined;
  let prepValue = 0;
  const prepGbGuess = Math.max(1, fleetGb * 0.5);
  for (const candidate of ranked) {
    if (candidate === farmEntry) continue;
    if (candidate.solution!.score <= farmScore * (1 + PREP_MARGIN)) continue;
    const plan = prepOf(candidate);
    if (!plan || plan.prepped) continue;
    const rate = candidate.solution!.score * fleetGb;
    const value = rate * Math.max(0, horizonMs - prepTimeSeconds(plan, prepGbGuess) * 1000);
    if (value > prepValue) {
      prepValue = value;
      prepEntry = candidate;
      prepPlan = plan;
    }
  }

  // Segment order: prep outranks farm when the candidate is much better.
  const reorder = prepEntry !== undefined && prepEntry.solution!.score >= farmScore * (1 + REORDER_MARGIN);
  const segments: Segment[] = [];
  if (reorder) {
    segments.push(
      { kind: "prep", gb: fleetGb * REORDER_PREP_SHARE },
      { kind: "farm", gb: fleetGb * (1 - REORDER_PREP_SHARE) },
    );
  } else {
    segments.push({ kind: "farm", gb: fleetGb * FARM_SHARE }, { kind: "prep", gb: fleetGb * PREP_SHARE });
  }
  segments.push({ kind: "share", gb: 0 });

  memory.directive = {
    farm:
      farmEntry && farmEntry.solution
        ? { host: farmEntry.statics.hostname, statics: farmEntry.statics, solution: farmEntry.solution }
        : undefined,
    prep: prepEntry && prepPlan ? { host: prepEntry.statics.hostname, statics: prepEntry.statics, plan: prepPlan } : undefined,
    segments,
    ctxGeneration: memory.generation,
    decidedAt: now,
  };
  return { memory, directive: memory.directive, switched };
}
