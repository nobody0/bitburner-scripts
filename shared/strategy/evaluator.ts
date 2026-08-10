import { makeHackContext, skillFromExp, weakenTimeSeconds, type HackContext } from "../formulas.ts";
import { scoreUpperBound } from "./bounds.ts";
import { evaluatePrep, farmIncomeRate, prepTimeDiscount } from "./economics.ts";
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
/** Farm switch hysteresis on same-generation scores. */
export const SWITCH_MARGIN = 0.1;
/** Minimum time on a target before switching away. */
export const DWELL_MS = 60_000;
export const HORIZON_MIN_MS = 60_000;
/** Prep INVESTMENT may amortize further out than the 30-minute farming
 * horizon: a target upgrade pays for the rest of the run, and capping its
 * window at 30 minutes priced every multi-hour prep on a small fleet out of
 * existence permanently (the n00dles lock-in). Bounded so an unbounded run
 * forecast cannot justify arbitrarily speculative preps. */
export const PREP_HORIZON_MAX_MS = 4 * 3_600_000;
/** Segment shares. A larger prep share was A/B-tested and LOST: RAM-bound
 * prep economics always prefer it in the model (the farm's loss is
 * share-invariant), but the dispatcher's per-pass op cap means prep cannot
 * actually use it — the farm just shrank for nothing. Median +14% time to
 * earn:1e9 with the fixed 25% share vs the adaptive/reordering variants. */
export const FARM_SHARE = 0.75;
export const PREP_SHARE = 0.25;
/** Fleet RAM change that invalidates cached (RAM-capped) solutions. */
export const FLEET_DELTA = 0.1;
/** Smallest sensible batch cap: one hack thread plus its support. */
export const WORKER_RAM_FLOOR = 16;

/** What the dispatcher knows about placeable RAM, from its heap. */
export interface FleetCapacity {
  fleetGb: number;
  /** Largest single FREE block (hack must land as one call; standing foreign
   * usage like the controller's own footprint is already subtracted). */
  largestBlockGb: number;
  /** Free GB per host, descending, bounded prefix — feeds the solver's
   * pipeline-aware launch-rate bound. Optional so hand-built capacities in
   * tests keep working; without it the solver scores per RAM-second only. */
  hostBlocksGb?: number[];
}

export interface TargetEntry {
  statics: TargetStatics;
  /** Undefined when ineligible OR pruned this generation (the upper bound
   * could not reach the incumbent's rate — bounds.ts); either way the entry
   * takes no part in ranking. `memory.prunedSolves` counts the skips. */
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
  /** Cumulative count of exhaustive solves skipped by the upper-bound prune. */
  prunedSolves: number;
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
    prunedSolves: 0,
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
  // Netscript rejects purchased targets and requires root for every HGW op;
  // only hack adds the skill requirement, enforced by isEligible below.
  // Source: https://github.com/bitburner-official/bitburner-src/blob/3162fd2590e221eadd0c0fbd46151913f7c4c41c/src/Hacking/netscriptCanHack.ts#L12-L55
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
  /** `prune: false` disables the upper-bound solve skip — the A/B lever the
   * invariance suite uses to prove pruning changes no decision. */
  opts?: { prune?: boolean },
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
    // The farm segment is the launch-rate denominator; hostBlocksGb lets the
    // solver count hack SLOTS, so a block only one host can hold is priced at
    // the depth-1 pipeline it actually buys (the 32 GB-home stall).
    ...(capacity.hostBlocksGb ? { hostBlocksGb: capacity.hostBlocksGb } : {}),
    farmGb: Math.max(WORKER_RAM_FLOOR, fleetGb * FARM_SHARE),
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

  // One solve choke point, shared by the slice and the gate. The prune is
  // PROVABLY decision-free against both consumers of `ranked`:
  //  - the farm switch compares SCORES (needs > incumbent·1.1), and a pruned
  //    candidate has score ≤ UB ≤ threshold ≤ incumbent score;
  //  - the prep pick compares RATES (economics.ts: rate = score·min(fleetGb,
  //    depthCapGb), so a LOWER-score candidate with a deeper pipeline can
  //    beat a depth-capped incumbent — which is why the threshold is the
  //    incumbent's EFFECTIVE per-GB rate, farmIncomeRate/fleetGb, not its raw
  //    score. Then candidateRate ≤ UB·fleetGb ≤ threshold·fleetGb =
  //    incumbentRate, so the net can never go positive. Thresholding on raw
  //    score instead would re-create the n00dles lock-in: a huge fleet farming
  //    a tiny fast target prunes exactly the rich slow upgrade whose RATE
  //    would have won the prep pick.
  // The upper bound (bounds.ts) is ≥ the candidate's score under every cap
  // and batch shape, stock value included. Remaining guards, each
  // load-bearing:
  //  - threshold only from an incumbent solved at the CURRENT generation (a
  //    stale score could overstate the fleet's worth and over-prune);
  //  - no pruning when the incumbent earns nothing (threshold ≤ 0): the
  //    cold-start and BN8 fallbacks rank by prep-aware value, where a
  //    low-score fast-prep target can legitimately win;
  //  - the incumbent itself is never pruned (its solution feeds the
  //    directive);
  //  - the bound is nudged up one part in 1e9 before the comparison, so a
  //    float-rounding shortfall in the bound can only make pruning less
  //    aggressive, never wrong.
  const pruneEnabled = opts?.prune ?? true;
  const incumbentEntry = memory.directive.farm ? memory.entries.get(memory.directive.farm.host) : undefined;
  const solveEntry = (entry: TargetEntry): void => {
    if (entry.generation === memory.generation) return;
    entry.generation = memory.generation;
    if (!isEligible(ctx, entry.statics)) {
      entry.solution = undefined;
      return;
    }
    const manipulation = manipulationFor(entry.statics.hostname);
    if (pruneEnabled && entry !== incumbentEntry && incumbentEntry?.generation === memory.generation && fleetGb > 0) {
      const threshold = farmIncomeRate(incumbentEntry.solution, fleetGb) / fleetGb;
      if (threshold > 0 && scoreUpperBound(ctx, entry.statics, manipulation?.valuePerOp ?? 0) * (1 + 1e-9) <= threshold) {
        entry.solution = undefined;
        memory.prunedSolves++;
        return;
      }
    }
    entry.solution = solveCycle(ctx, entry.statics, 1, caps, manipulation);
  };

  // Round-robin slice: B = clamp(ceil(N/10), 1, 8) targets per tick.
  if (now - memory.lastSliceAt >= SLICE_MIN_MS && memory.order.length > 0) {
    memory.lastSliceAt = now;
    const batch = Math.min(8, Math.max(1, Math.ceil(memory.order.length / 10)));
    for (let i = 0; i < batch; i++) {
      const hostname = memory.order[memory.cursor % memory.order.length]!;
      memory.cursor++;
      const entry = memory.entries.get(hostname);
      if (entry) solveEntry(entry);
    }
  }

  const gateDue = memory.forceGate || now - memory.lastGateAt >= GATE_MIN_MS;
  if (!gateDue) return { memory, directive: memory.directive };

  memory.lastGateAt = now;
  memory.forceGate = false;

  // Gate: score everything at the current generation so the argmax never
  // mixes generations. The incumbent goes first — its fresh score is the
  // prune threshold for everyone else.
  if (incumbentEntry) solveEntry(incumbentEntry);
  for (const entry of memory.entries.values()) solveEntry(entry);

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

  // Memoized per gate: prepOf is consulted by the bestPrepped find, the
  // cold-start value loop and the prep pick — identical inputs within one
  // gate (view and statics are fixed for the call), so one solve each.
  const prepPlans = new Map<string, PrepPlan | undefined>();
  const prepOf = (entry: TargetEntry): PrepPlan | undefined => {
    const hostname = entry.statics.hostname;
    if (prepPlans.has(hostname)) return prepPlans.get(hostname);
    const server = byHost.get(hostname);
    const plan = server
      ? solvePrep(ctx, entry.statics, {
          hackDifficulty: server.hackDifficulty,
          moneyAvailable: server.moneyAvailable,
        })
      : undefined;
    prepPlans.set(hostname, plan);
    return plan;
  };

  // Horizon bounds how far prep time is amortized (and caps skill staleness).
  // Two ceilings apply: how long the GOAL still needs at the current rate,
  // and how long the RUN is expected to last at all — whichever ends first.
  const currentRate = currentScore * fleetGb;
  const goalHorizonMs = currentRate > 0 ? (goalRemaining / currentRate) * 1000 : PREP_HORIZON_MAX_MS;
  // Prep INVESTMENT amortizes over the run, not the 30-minute farm window.
  const prepHorizonMs = Math.min(PREP_HORIZON_MAX_MS, Math.max(HORIZON_MIN_MS, Math.min(goalHorizonMs, horizonCapMs)));

  // Skill growth DURING a prep shrinks the prep: at the measured exp rate,
  // estimate the skill when the prep would finish and average the candidate's
  // weaken-time ratio over the window (shared/strategy/economics.ts). Without
  // this a 3-hour quote at today's skill vetoes an upgrade that would in fact
  // finish in half that.
  const expRate = view.player.hackingExpRate ?? 0;
  const prepScaleOf = (entry: TargetEntry, prepSeconds: number): number => {
    if (expRate <= 0 || !Number.isFinite(prepSeconds) || prepSeconds <= 0) return 1;
    const futureSkill = skillFromExp(
      view.player.hackingExp + expRate * prepSeconds,
      view.player.mults.hacking ?? 1,
    );
    if (futureSkill <= view.player.hackingSkill) return 1;
    const futureCtx = makeHackContext(
      { skill: futureSkill, intelligence: view.player.intelligence, mults: view.player.mults },
      view.nodeMults ?? {},
    );
    const nowSec = weakenTimeSeconds(ctx, entry.statics.baseDifficulty, entry.statics.requiredHackingSkill);
    const futureSec = weakenTimeSeconds(futureCtx, entry.statics.baseDifficulty, entry.statics.requiredHackingSkill);
    if (!(nowSec > 0)) return 1;
    return prepTimeDiscount(futureSec / nowSec);
  };

  // Farm pick: the best PREPPED candidate — `ranked` is sorted, so the first
  // prepped one is it — with hysteresis + dwell against the incumbent. An
  // unprepped better candidate becomes the prep target instead.
  let farmEntry: TargetEntry | undefined = current?.solution ? current : undefined;
  let switched: { from?: string; to: string } | undefined;
  const dwellOk = now - memory.farmSince >= DWELL_MS;
  const bestPrepped = ranked.find((candidate) => prepOf(candidate)?.prepped);
  if (bestPrepped && bestPrepped !== farmEntry) {
    const better = bestPrepped.solution!.score > currentScore * (1 + SWITCH_MARGIN);
    const noIncumbent = !farmEntry || !current?.solution;
    if (noIncumbent || (better && dwellOk)) {
      switched = { from: farmEntry?.statics.hostname, to: bestPrepped.statics.hostname };
      farmEntry = bestPrepped;
      memory.farmSince = now;
    }
  }
  if (!bestPrepped && (!farmEntry || currentScore <= 0)) {
    // Only entered when the result can matter: with an EARNING incumbent both
    // consumers below are unreachable (`!farmEntry` and `currentScore <= 0`),
    // and the momentary not-prepped dip after every hack landing used to run
    // this whole per-candidate solve loop for nothing.
    //
    // Nothing prepped anywhere: farm the best target anyway (the dispatcher
    // preps it, then fires hacks). "Best" here MUST be prep-aware, not raw
    // score: the pipeline-aware score can rank a 50M-money server above a
    // small one, but on a small fleet its prep takes hours — hours of zero
    // income. Weigh each candidate by the income it can deliver within the
    // prep horizon AFTER its own (skill-discounted) prep finishes.
    //
    // The INCUMBENT competes on the same terms — this is not only the cold
    // start. A 0-score incumbent used to hold the slot forever while nothing
    // was prepped, which is how a BN8 farm spent six hours prepping a
    // worthless target while the only positive-score (manipulated) hosts sat
    // ignored.
    const prepBudgetGb = Math.max(1, fleetGb * FARM_SHARE);
    const valueOf = (candidate: TargetEntry): number => {
      const plan = prepOf(candidate);
      if (!plan) return -1;
      const rawSec = prepTimeSeconds(plan, prepBudgetGb);
      const scaledSec = rawSec * prepScaleOf(candidate, rawSec);
      return candidate.solution!.score * Math.max(0, prepHorizonMs - scaledSec * 1000);
    };
    let bestValue = -1;
    let best: TargetEntry | undefined;
    for (const candidate of ranked) {
      const value = valueOf(candidate);
      if (value > bestValue) {
        bestValue = value;
        best = candidate;
      }
    }
    if (!farmEntry) {
      farmEntry = bestValue > 0 ? best : ranked[0];
      if (farmEntry && farmEntry.statics.hostname !== currentHost) {
        switched = { from: currentHost, to: farmEntry.statics.hostname };
        memory.farmSince = now;
      }
    } else if (
      // Contest the incumbent ONLY when it earns nothing at all. An earning
      // farm target dips out of `prepped` for a moment after every hack lands,
      // and contesting it in those windows yanks the farm onto a cold target
      // (measured: hacking-early 16.1m -> 20.6m). A worthwhile upgrade of an
      // EARNING farm goes through the prep pick below and switches when
      // prepped; only a zero-score incumbent (BN8's worthless-money targets)
      // has nothing to lose by switching cold.
      best &&
      best !== farmEntry &&
      currentScore <= 0 &&
      dwellOk &&
      bestValue > 0
    ) {
      switched = { from: farmEntry.statics.hostname, to: best.statics.hostname };
      farmEntry = best;
      memory.farmSince = now;
    }
  }

  // Prep pick: highest opportunity-cost NET over the horizon — income gained
  // after the switch minus income the farm loses while the prep segment holds
  // its share (shared/strategy/economics.ts; the legacy 15-minute rule
  // generalized to the farm's depth cap). A flat score margin can't see that
  // a 3-hour prep on a 30-minute horizon is worthless, or that a depth-capped
  // farm preps for free. Measured: −14% median time to earn:1e9 vs the old
  // 5%-margin rate·(T−prepTime) pick, 10/10 seeds.
  const farmModel = farmEntry?.solution;
  const currentRateNow = farmIncomeRate(farmModel, fleetGb);
  let prepEntry: TargetEntry | undefined;
  let prepPlan: PrepPlan | undefined;
  let bestNet = 0.02 * currentRateNow * (prepHorizonMs / 1_000); // churn epsilon
  for (const candidate of ranked) {
    if (candidate === farmEntry) continue;
    const plan = prepOf(candidate);
    if (!plan || plan.prepped) continue;
    const rawPrepSec = prepTimeSeconds(plan, Math.max(1, fleetGb * PREP_SHARE));
    const economics = evaluatePrep({
      current: farmModel,
      candidate: candidate.solution!,
      plan,
      fleetGb,
      horizonMs: prepHorizonMs,
      prepTimeScale: prepScaleOf(candidate, rawPrepSec),
      shares: [PREP_SHARE],
    });
    if (!economics || economics.net <= bestNet) continue;
    bestNet = economics.net;
    prepEntry = candidate;
    prepPlan = plan;
  }

  const segments: Segment[] = [
    { kind: "farm", gb: fleetGb * FARM_SHARE },
    { kind: "prep", gb: fleetGb * PREP_SHARE },
    { kind: "share", gb: 0 },
  ];

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
