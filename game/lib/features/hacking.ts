import type { NS } from "@ns";
import { effectiveBitNodeMultipliers } from "../../../shared/features/bitnode.ts";
import { skillFromExp } from "../../../shared/formulas.ts";
import { roundSigFigs } from "../../../shared/format.ts";
import { formatMoney } from "../../../shared/format.ts";
import { sfLevel } from "../../../shared/features/unlock.ts";
import { PRIORITY, stepWaitDiscount, type Claim } from "../../../shared/strategy/arbiter.ts";
import {
  advanceInfrastructureFrontier,
  deferPrerequisitePurchase,
  scoreHomeRam,
  scoreInfrastructure,
  type ScoredInfrastructure,
} from "../../../shared/strategy/infrastructure.ts";
import { coarseHorizonSec } from "../../../shared/strategy/investment.ts";
import { solveCycle, type PrepPlan } from "../../../shared/strategy/targeting.ts";
import { BATCH_KINDS, currentShareBonus, type DispatchStats } from "../../../shared/strategy/dispatch.ts";
import { poolCounts } from "../../../shared/strategy/worker-pool.ts";
import {
  PORT_OPENER_PROGRAMS,
  preferProgramCreation,
  programCreateTimeMs,
  type ProgramAlternative,
  type ProgramOption,
} from "../../../shared/strategy/career/programs.ts";
import { needValueSeconds, type Need } from "../../../shared/strategy/needs.ts";
import { planNextOpener } from "../../../shared/strategy/access/openers.ts";
import {
  backdoorCostSeconds,
  NOMINAL_VALUE_SEC_PER_WEIGHT,
  rankingValueSec,
} from "../../../shared/strategy/access/value.ts";
import {
  passiveRepPerSec,
  passiveRepPerSecPerShareBonus,
  workRepPerSec,
  workRepPerSecPerShareBonus,
  type RepContext,
  type WorkType,
} from "../../../shared/strategy/factions/rep.ts";
import { capitalIndependentScore, farmExperienceRate, farmIncomeRate } from "../../../shared/strategy/economics.ts";
import { installHorizonSec, nodeHorizonSec, usableForecastSec } from "../../../shared/strategy/progression/forecast.ts";
import { growingProgressSecondsPerRelativeRate, linearSecondsPerRelativeRate } from "../../../shared/strategy/progression/marginal.ts";
import type { MeasuredMarginal } from "../../../shared/strategy/progression/marginal.ts";
import { hackRungValue, relativeGainSaving, type HackMarginalInput } from "../../../shared/strategy/share.ts";
import type { ChargePricingInput } from "../../../shared/strategy/stanek/charge.ts";
import type { FarmPipeline, FarmRollup } from "../../../shared/telemetry/topics/hacking.ts";
import {
  marginalCostPerGb,
  roundedRamPurchase,
  type RamSource,
  type RamSupplyQuote,
  type RamSupplyState,
} from "../../../shared/strategy/ram-supply.ts";
import { TOR_COST } from "../../../shared/strategy/dnet/rates.ts";
import { bestIncomePerSec, bestReinvestmentReturnPerDollarSec, moneyRateValue, moneyStepValue } from "../income.ts";
import { buildView, drainCompletions, initDriver, pump, type DriverState } from "../dispatch-driver.ts";
import { merge, recordProbeFailure, set, type GameState } from "../state.ts";
import { takeTickLateness } from "../tick-health.ts";
import { signalWake } from "../wake.ts";
import { workerGlobals } from "../worker-shared.ts";
import { isScriptDeath } from "../errors.ts";
import type { ClaimContext, DriverContext, FeatureDriver, FeatureModule, NeedContext } from "./index.ts";

/** The hacking driver: one HWGW dispatcher pass per heartbeat or worker wake.
 *
 * All decisions live in shared/strategy; this only moves data. It runs at
 * TICK_MS as a fallback, while cancellable JIT deadline and completion wakes
 * service landing windows without waiting for another heartbeat. Every other feature is
 * slower by orders of magnitude, which is the whole reason the frame schedules
 * by cadence rather than running everything every pass. */

let state: DriverState | undefined;
let farmTarget = "";

export function hackingState(): DriverState {
  return (state ??= initDriver());
}

/** Drop the ledger, the heap and the realm rendezvous. Registered as this
 * module's `reset` hook and called on a BitNode reset, where the entire fleet
 * the heap describes has ceased to exist. Still exported by name because the
 * simulator calls it directly: Bun caches modules for the life of a process,
 * so a second run in the same process would otherwise inherit the first one's
 * heap and dispatcher stats.
 *
 * Every script was killed at a node reset, so every registered op is
 * unreportable and every pending completion describes a game that no longer
 * exists. Left alone they would leak across resets and make reapStrayScripts
 * treat dead ops as live. */
export function resetHackingState(): void {
  const globals = workerGlobals();
  globals.worker_info!.clear();
  globals.worker_jobs!.clear();
  globals.worker_wake!.clear();
  globals.dispatch_done!.length = 0;
  globals.dispatch_wake = undefined;
  globals.dispatch_wake_pending = false;
  globals.dispatch_wake_targets?.clear();
  if (globals.dispatch_weaken_timer !== undefined) clearTimeout(globals.dispatch_weaken_timer);
  globals.dispatch_weaken_timer = undefined;
  globals.charge_context_pending = false;
  for (const deadline of globals.dispatch_jit_timers?.values() ?? []) clearTimeout(deadline.timer);
  globals.dispatch_jit_timers?.clear();
  if (shotgunPumpTimer !== undefined) clearTimeout(shotgunPumpTimer);
  shotgunPumpTimer = undefined;
  shotgunPumpTarget = undefined;
  farmTarget = "";
  state = initDriver();
  pumpMaxMs = 0;
  pumpMsSum = 0;
  pumpCount = 0;
  pumpWindowAt = 0;
  wakeSkipGap = 0;
  wakeSkipFrame = 0;
  weakenWindowPumps = 0;
  lastWakePumps = 0;
  lastRollup = 0;
  lastTotals = undefined;
  moneyRateEma = 0;
  expRateEma = 0;
  lastPumpAt = 0;
  wakesThisFrame = 0;
  wakePumps = 0;
  routeHackingSkillGoal = undefined;
  latestShareValue = undefined;
  latestChargeValue = undefined;
  switched = undefined;
  backdoorBackoff.clear();
  backdoorInFlight = false;
  openerInFlight = false;
  lastServerAccessAt = 0;
  infrastructureInFlight = false;
  lastInfrastructureResult = undefined;
}

/** Peak pump duration since the last rollup, reported so a dispatcher pass
 * that starts eating the tick budget is visible before it starts missing
 * slots. */
let pumpMaxMs = 0;
/** The same cost as a SHARE of wall time, which peak duration cannot express.
 * Summed here, divided at the drain. */
let pumpMsSum = 0;
let pumpCount = 0;
/** `performance.now()` when the current occupancy window opened. */
let pumpWindowAt = 0;
let lastRollup = 0;
/** EMA-smoothed income rates over rollup deltas (~30 s time constant), so
 * career's income comparison sees a stable figure instead of batch spikes. */
let lastTotals: { money: number; exp: number; at: number } | undefined;
let moneyRateEma = 0;
let expRateEma = 0;
/** Wake-pass throttles: a wake pump only runs when the last pump of ANY kind
 * is at least this old, and at most this many wake pumps run per frame (the
 * promise already coalesces same-instant completions; the cap covers a spread
 * of landings inside one frame). */
const WAKE_MIN_MS = 25;
const WAKE_MAX_PER_FRAME = 4;
let lastPumpAt = 0;
let wakesThisFrame = 0;
let wakePumps = 0;
/** Wake pumps the two throttles above refused, split by which one refused it,
 * and how often the minimum-security weaken window bypassed both. Published
 * because a throttle whose refusals are invisible cannot be tuned: the ratio
 * of `gap` to `frame` to bypass is exactly what says whether the planner is
 * being asked too often or is simply too expensive. */
let wakeSkipGap = 0;
let wakeSkipFrame = 0;
let weakenWindowPumps = 0;
/** `wakePumps` at the last drain, so the panel can show a RATE. The cumulative
 * counter has been published since the wake path was added and rendered
 * nowhere; a per-second figure is the form that is actually readable. */
let lastWakePumps = 0;
/** Latest open hacking-skill outcome from the needs board. Wake-driven pumps
 * run outside a feature context, so they reuse the last scheduled tick's
 * pure-board decision. */
let routeHackingSkillGoal: number | undefined;
type ShareValue = NonNullable<Parameters<typeof pump>[4]>["shareValue"];
let latestShareValue: ShareValue | undefined;
let latestChargeValue: ChargePricingInput | undefined;

function chargeValue(game: GameState): ChargePricingInput | undefined {
  const marginals = game.topics.progression?.plan?.marginals;
  const fragments = game.topics.stanek?.fragments?.filter((fragment) => fragment.chargeable !== false);
  if (!marginals || !fragments?.length) return undefined;
  return {
    fragments,
    moneySecondsPerRelativeRate: marginals.money.secondsPerRelativeRate,
    hackingSecondsPerRelativeRate: marginals.hacking.secondsPerRelativeRate,
    ...(game.topics.fleet?.scriptIncome ? { totalMoneyPerSec: game.topics.fleet.scriptIncome[0] } : {}),
    ...(game.topics.fleet?.scriptExpGain !== undefined
      ? { totalHackingExpPerSec: game.topics.fleet.scriptExpGain }
      : {}),
  };
}

function shareValue(game: GameState, caps: DriverContext["caps"]): ShareValue | undefined {
  // Share buys faction-rep rate, and every point of faction rep (and the
  // favor it becomes) is erased when the node ends by destroy. Near that ending,
  // only uses that advance the remaining destroy route retain value.
  if (game.topics.progression?.plan?.endingByDestroy === true) return undefined;
  const marginals = game.topics.progression?.plan?.marginals;
  if (!marginals) return undefined;
  const player = game.topics.player;
  const intent = game.topics.factions?.plan?.objective?.intent;
  const standing = intent ? game.topics.factions?.standings?.find((entry) => entry.name === intent.faction) : undefined;
  const bonus = game.topics.fleet?.sharePower ?? 1;
  const currentWork = game.topics.career?.currentWork;
  // Share may consume the residual free tail whenever the ACTIVE work already
  // earns faction rep: the bonus multiplies a rate being produced anyway, and
  // share workers stop on demand. This is deliberately a statement about the
  // present, not a forecast: work planners price reputation with the current
  // measured sharePower.
  const currentWorkEarnsRep = currentWork?.type === "FACTION"
    && (currentWork.workType === "hacking" || currentWork.workType === "field" || currentWork.workType === "security");
  let reputationSecondsPerBonus = 0;
  let reputationHackingSecondsPerRelativeRate = 0;
  let reputationHackingMarginalKnown = true;
  if (player && intent && standing) {
    const nodeMults = effectiveBitNodeMultipliers(caps.bitNode, sfLevel(caps.sourceFiles, 12), game.topics.progression?.multipliers);
    const repCtx: RepContext = {
      factionWorkRepGain: nodeMults?.["FactionWorkRepGain"] ?? 1,
      factionPassiveRepGain: nodeMults?.["FactionPassiveRepGain"] ?? 1,
      shareBonus: bonus,
      sf15Level: sfLevel(caps.sourceFiles, 15),
      hasFocusAug: (game.topics.factions?.ownedAugs ?? []).includes("Neuroreceptor Management Implant"),
    };
    const person = { skills: player.skills, mults: { faction_rep: player.mults.faction_rep } };
    const activeType = currentWork?.type === "FACTION" && currentWork.detail === intent.faction
      && (currentWork.workType === "hacking" || currentWork.workType === "field" || currentWork.workType === "security")
      ? currentWork.workType as WorkType
      : undefined;
    const rate = activeType
      ? workRepPerSec(activeType, person, standing.favor, repCtx, true)
      : game.topics.factions?.joined.includes(intent.faction)
        ? passiveRepPerSec(person, standing.favor, repCtx)
        : 0;
    const slope = activeType
      ? workRepPerSecPerShareBonus(activeType, person, standing.favor, repCtx, true)
      : rate > 0
        ? passiveRepPerSecPerShareBonus(person, standing.favor, repCtx)
        : 0;
    // packages.ts prices this exact work as repGap / repPerSec. Its local
    // seconds-per-relative-rate is therefore closed-form; share contributes
    // `slope` rep/sec per bonus unit.
    // Favor-purpose intents are rep work too: repSec is the same rep-earning
    // clock either way, and gating on "augmentations" left share (and its rep
    // pricing) dark through every favor-building stretch of the route.
    if (rate > 0) {
      reputationSecondsPerBonus = linearSecondsPerRelativeRate(intent.repSec) * slope / rate;
      const totalExpPerSec = game.topics.fleet?.scriptExpGain;
      const value = growingProgressSecondsPerRelativeRate({
        gap: rate * intent.repSec,
        initialProgress: player.exp.hacking,
        progressPerSec: totalExpPerSec ?? 0,
        rateAtProgress: (experience) => {
          const projected = {
            ...person,
            skills: {
              ...person.skills,
              hacking: skillFromExp(experience, player.mults.hacking ?? 1),
            },
          };
          return activeType
            ? workRepPerSec(activeType, projected, standing.favor, repCtx, true)
            : passiveRepPerSec(projected, standing.favor, repCtx);
        },
      });
      if (value === undefined) reputationHackingMarginalKnown = false;
      else reputationHackingSecondsPerRelativeRate = value;
    }
  }
  if (!reputationHackingMarginalKnown) return undefined;
  return {
    moneySecondsPerRelativeRate: marginals.money.secondsPerRelativeRate,
    hackingSecondsPerRelativeRate:
      marginals.hacking.secondsPerRelativeRate + reputationHackingSecondsPerRelativeRate,
    ...(game.topics.fleet?.scriptIncome ? { totalMoneyPerSec: game.topics.fleet.scriptIncome[0] } : {}),
    ...(game.topics.fleet?.scriptExpGain !== undefined
      ? { totalHackingExpPerSec: game.topics.fleet.scriptExpGain }
      : {}),
    reputationSecondsPerBonus,
    ...(currentWorkEarnsRep ? { currentWorkEarnsRep: true } : {}),
  };
}

/** Arm the planner's earliest native-invocation deadline on a realm timer.
 * The ordinary heartbeat remains the fallback, while this wake avoids paying
 * another feature's variable frame time as worker padding. */
function scheduleJitWake(at: number | undefined, target?: string): void {
  const globals = workerGlobals();
  const key = target ?? "";
  const timers = globals.dispatch_jit_timers ??= new Map();
  const current = timers.get(key);
  if (at === undefined) {
    if (current) clearTimeout(current.timer);
    timers.delete(key);
    return;
  }
  if (current && current.at <= at + 1) return;
  if (current) clearTimeout(current.timer);
  const timer = setTimeout(() => {
    timers.delete(key);
    signalWake(globals, target);
  }, Math.max(0, at - performance.now()));
  timers.set(key, { timer, at });
}

let shotgunPumpTimer: ReturnType<typeof setTimeout> | undefined;
let shotgunPumpTarget: string | undefined;

/** Shotgun continuation is independent of completion/JIT wakes: a completion
 * must never turn into another launch burst merely because it arrived first. */
function scheduleShotgunPump(delayMs: number | undefined, target?: string): void {
  if (shotgunPumpTimer !== undefined) clearTimeout(shotgunPumpTimer);
  shotgunPumpTimer = undefined;
  shotgunPumpTarget = undefined;
  if (delayMs === undefined || target === undefined) return;
  shotgunPumpTimer = setTimeout(() => {
    shotgunPumpTimer = undefined;
    shotgunPumpTarget = target;
    signalWake(workerGlobals());
  }, Math.max(0, delayMs));
}

interface PumpCostReport {
  /** Planner ms per ms of wall clock over the window. Undefined until a window
   * has actually elapsed. */
  occupancy?: number;
  meanMs: number;
  maxMs: number;
  count: number;
  /** Wake pumps per second over the window. */
  wakeRate?: number;
  skipped: { gap: number; frame: number };
  weakenWindowPumps: number;
}

/** Drain the planner cost window. Called once per rollup; the window is the
 * span between two drains, so occupancy is measured against real wall time
 * rather than against an assumed cadence. */
function takePumpCost(): PumpCostReport {
  const at = performance.now();
  const wallMs = pumpWindowAt === 0 ? 0 : at - pumpWindowAt;
  const wakeDelta = wakePumps - lastWakePumps;
  const report: PumpCostReport = {
    ...(wallMs > 0 ? { occupancy: pumpMsSum / wallMs } : {}),
    meanMs: pumpCount === 0 ? 0 : pumpMsSum / pumpCount,
    maxMs: pumpMaxMs,
    count: pumpCount,
    ...(wallMs > 0 ? { wakeRate: (wakeDelta * 1_000) / wallMs } : {}),
    skipped: { gap: wakeSkipGap, frame: wakeSkipFrame },
    weakenWindowPumps,
  };
  pumpWindowAt = at;
  pumpMaxMs = 0;
  pumpMsSum = 0;
  pumpCount = 0;
  wakeSkipGap = 0;
  wakeSkipFrame = 0;
  weakenWindowPumps = 0;
  lastWakePumps = wakePumps;
  return report;
}

/** Whether the farm target changed on the last tick, for the controller's
 * transition event. Cleared by reading it. */
let switched: { from: string; to: string } | undefined;

export function takeTargetSwitch(): { from: string; to: string } | undefined {
  const value = switched;
  switched = undefined;
  return value;
}

/** Observed landing-order signatures, bounded for publication.
 *
 * The dispatcher's map is unbounded in principle — every distinct reorder is a
 * new key — but the distribution is extremely top-heavy: one signature per
 * healthy mode plus a short tail. Publishing the top few and totalling the
 * rest keeps the record flat regardless of how creatively a bad run reorders. */
const LANDING_SIGNATURES_PUBLISHED = 6;

function landingOrderDigest(stats: DispatchStats): FarmRollup["landingOrder"] {
  if (stats.landingOrderBatches === 0) return undefined;
  const ranked = [...stats.landingOrders.values()].sort((a, b) => b.batches - a.batches);
  const published = ranked.slice(0, LANDING_SIGNATURES_PUBLISHED);
  const other = ranked.slice(LANDING_SIGNATURES_PUBLISHED).reduce((sum, entry) => sum + entry.batches, 0);
  let inOrder = 0;
  for (const entry of ranked) if (entry.observed === entry.planned) inOrder += entry.batches;
  return {
    batches: stats.landingOrderBatches,
    inOrder,
    ...(stats.landingOrderIncomplete > 0 ? { incomplete: stats.landingOrderIncomplete } : {}),
    patterns: published.map((entry) => ({ ...entry })),
    ...(other > 0 ? { otherBatches: other } : {}),
    anomalies: stats.landingOrderAnomalies.map((entry) => ({ ...entry })),
  };
}

/** Estimated seconds until a prep target becomes farmable, and WHICH
 * constraint set that estimate.
 *
 * Two independent floors. The latency floor is one weaken (plus the G+W2 phase
 * when the plan has one): even infinite RAM cannot beat the game's own op
 * durations. The RAM floor is the plan's GB·seconds divided by the GB the prep
 * segment actually holds. Reporting which one binds is the whole point —
 * buying RAM does nothing for a latency-bound prep. */
function prepEta(plan: PrepPlan, segmentGb: number): NonNullable<FarmPipeline["eta"]> {
  if (plan.prepped) return { seconds: 0, bound: "latency", prepped: true };
  const latencySec = plan.weakenTimeS + (plan.growWeakenTimeS ?? 0);
  const ramSec = segmentGb > 0 ? plan.ramSec / segmentGb : Infinity;
  const bound = ramSec > latencySec ? "ram" : "latency";
  const seconds = Math.max(latencySec, Number.isFinite(ramSec) ? ramSec : latencySec);
  return { seconds, bound, prepped: false };
}

/** Build the pipeline list from the directive the dispatcher is executing.
 *
 * Everything here is read from state the dispatcher already holds — no ns
 * calls — because this runs inside the 1 Hz rollup. In-flight counts are
 * derived by walking the tracked-op table rather than kept as per-target
 * counters in the hot path: the table has a few thousand entries at most and
 * this walk happens once a second, whereas a counter would cost work on every
 * launch and every landing. */
function pipelines(game: GameState, driver: DriverState): FarmPipeline[] {
  const dispatch = driver.memory.dispatch;
  const directive = dispatch.evaluator.directive;
  const inFlightByHost = new Map<string, { hack: number; grow: number; weaken: number }>();
  for (const tracked of dispatch.tracked.values()) {
    let counts = inFlightByHost.get(tracked.target);
    if (!counts) {
      counts = { hack: 0, grow: 0, weaken: 0 };
      inFlightByHost.set(tracked.target, counts);
    }
    counts[tracked.kind]++;
  }
  const gbOf = (kind: "farm" | "prep"): number => dispatch.segmentGb[kind];
  const vitals = (host: string): Partial<FarmPipeline> => {
    const server = game.topics.servers?.[host];
    return {
      ...(server?.moneyAvailable !== undefined ? { money: server.moneyAvailable } : {}),
      ...(server?.moneyMax !== undefined ? { moneyMax: server.moneyMax } : {}),
      ...(server?.hackDifficulty !== undefined ? { security: server.hackDifficulty } : {}),
      ...(server?.minDifficulty !== undefined ? { minSecurity: server.minDifficulty } : {}),
    };
  };

  const out: FarmPipeline[] = [];
  const farm = directive.farm;
  if (farm) {
    // During a small solve transition the scheduler may deliberately keep the
    // last executable shape alive while it places the replacement. Report the
    // shape actually feeding the target queue, not the evaluator's candidate.
    const solution = dispatch.jitRuntimeByTarget.get(farm.host)?.solution ?? farm.solution;
    out.push({
      host: farm.host,
      role: "farm",
      mode: dispatch.mode,
      segment: "farm",
      gb: roundSigFigs(gbOf("farm"), 3),
      inFlight: inFlightByHost.get(farm.host) ?? { hack: 0, grow: 0, weaken: 0 },
      ...vitals(farm.host),
      planThreads: {
        hack: solution.hackThreads,
        grow: solution.growThreads,
        weaken: solution.weaken1Threads + solution.weaken2Threads,
      },
      moneyPerSecPerGb: roundSigFigs(solution.score, 3),
      hackTimeMs: Math.round(solution.hackTimeS * 1_000),
      weakenTimeMs: Math.round(solution.weakenTimeS * 1_000),
    });
  }
  const prepEtaOf = (plan: PrepPlan, segmentGb: number): NonNullable<FarmPipeline["eta"]> => {
    const eta = prepEta(plan, segmentGb);
    return { ...eta, seconds: roundSigFigs(eta.seconds, 3) };
  };
  const prep = directive.prep;
  if (prep) {
    out.push({
      host: prep.host,
      role: "prep",
      segment: "prep",
      gb: roundSigFigs(gbOf("prep"), 3),
      inFlight: inFlightByHost.get(prep.host) ?? { hack: 0, grow: 0, weaken: 0 },
      ...vitals(prep.host),
      eta: prepEtaOf(prep.plan, gbOf("prep")),
    });
  }
  return out;
}

function rollup(game: GameState, driver: DriverState, target: string, prepTarget?: string, segOrder?: string[]): void {
  const stats = driver.memory.dispatch.stats;
  const targetSolveExact = driver.memory.dispatch.evaluator.directive.farm?.solution.exact;

  const now = Date.now();
  if (lastTotals) {
    const dtSec = (now - lastTotals.at) / 1_000;
    if (dtSec > 0) {
      const alpha = Math.min(1, dtSec / 30);
      moneyRateEma += ((stats.moneyEarned - lastTotals.money) / dtSec - moneyRateEma) * alpha;
      expRateEma += ((stats.expEarned - lastTotals.exp) / dtSec - expRateEma) * alpha;
    }
  }
  lastTotals = { money: stats.moneyEarned, exp: stats.expEarned, at: now };

  // Target vitals come from the sweep snapshot: the 1 Hz rollup must not add
  // ns getters of its own, and the hot-path live reads already feed the
  // dispatcher — this is display/telemetry, 30 s staleness is fine.
  const targetServer = target ? game.topics.servers?.[target] : undefined;
  const heap = driver.memory.dispatch.heap;
  const pool = poolCounts(driver.memory.dispatch.pool);
  const segmentGb = driver.memory.dispatch.segmentGb;
  const farmSolution = driver.memory.dispatch.evaluator.directive.farm?.solution;
  const prepBudgetGb = driver.memory.dispatch.evaluator.directive.segments.find((segment) => segment.kind === "prep")?.gb ?? 0;
  const share = driver.memory.dispatch.evaluator.directive.share;
  const charge = driver.memory.dispatch.evaluator.directive.charge;
  const landingOrder = landingOrderDigest(stats);
  const pumpCost = takePumpCost();
  const lateness = takeTickLateness();

  set(game, "farm", {
    target,
    ...(targetSolveExact !== undefined ? { targetSolveExact } : {}),
    ...(farmSolution?.score !== undefined ? { moneyPerSecPerGb: farmSolution.score } : {}),
    ...(farmSolution ? { moneyPerSecPerGbCapitalIndependent: capitalIndependentScore(farmSolution) } : {}),
    ...(prepTarget !== undefined ? { prepTarget } : {}),
    prepBudgetGb,
    ...(segOrder !== undefined ? { segOrder } : {}),
    pipelines: pipelines(game, driver),
    mode: driver.memory.dispatch.mode,
    inFlight: { ...driver.memory.dispatch.inFlight },
    launched: { ...stats.launched },
    landed: { ...stats.landed },
    moneyRate: moneyRateEma,
    expRate: expRateEma,
    // The FORWARD rates, from the solution already committed to the fleet. The
    // EMAs above only ever describe work that has landed, so during a warm-up
    // they say the farm produces nothing — and a course or a crime then wins
    // the work slot against a farm that is minutes from being the best
    // producer of both currencies. Same numbers the RAM valuation already
    // prices infrastructure with; they were simply never announced.
    predicted: {
      moneyPerSec: farmIncomeRate(farmSolution, segmentGb.farm),
      expPerSec: farmExperienceRate(farmSolution, segmentGb.farm),
    },
    ...(targetServer?.hackDifficulty !== undefined ? { security: targetServer.hackDifficulty } : {}),
    ...(targetServer?.minDifficulty !== undefined ? { minSecurity: targetServer.minDifficulty } : {}),
    ...(targetServer?.moneyAvailable !== undefined ? { money: targetServer.moneyAvailable } : {}),
    ...(targetServer?.moneyMax !== undefined ? { moneyMax: targetServer.moneyMax } : {}),
    ramPie: {
      farm: segmentGb.farm,
      prep: segmentGb.prep,
      charge: segmentGb.charge,
      share: segmentGb.share,
      free: heap.freeTotal(),
      reserve: heap.reservedTotal,
    },
    allocFails: stats.allocFails,
    allocFailsByPhase: stats.allocFailsByPhase,
    execs: stats.execs,
    ...(pool.workers > 0
      ? { pool }
      : {}),
    pooling: driver.memory.dispatch.pooling,
    ...(stats.stockOps > 0 ? { stockOps: stats.stockOps } : {}),
    ...(driver.memory.dispatch.depthCapGb !== undefined ? { depthCapGb: driver.memory.dispatch.depthCapGb } : {}),
    ...(share ? { shareDecision: {
      threads: [...driver.memory.dispatch.shareWorkers.values()].reduce((sum, worker) => sum + worker.threads, 0),
      bonus: roundSigFigs(currentShareBonus(driver.memory.dispatch), 3),
      cutoverGb: roundSigFigs(share.cutoverGb, 3),
      allotmentGb: roundSigFigs(share.allotmentGb, 3),
      hackMarginal: roundSigFigs(share.hackMarginal.state === "measured" ? share.hackMarginal.value : 0, 3),
      shareMarginal: roundSigFigs(share.shareMarginal, 3),
      ...(latestShareValue?.currentWorkEarnsRep && !(share.reputationSecondsPerBonus > 0)
        ? { freeTail: true }
        : {}),
    } } : {}),
    ...(charge?.fragment ? { chargeDecision: {
      fragmentId: charge.fragment.id,
      threads: [...driver.memory.dispatch.chargeWorkers.values()].reduce((sum, worker) => sum + worker.threads, 0),
      allotmentGb: roundSigFigs(charge.allotmentGb, 3),
      valueSeconds: roundSigFigs(charge.valueSeconds, 3),
      opportunitySeconds: roundSigFigs(charge.opportunitySeconds, 3),
    } } : {}),
    ...(stats.padding.count > 0 ? { padding: {
      meanMs: roundSigFigs(stats.padding.sumMs / stats.padding.count, 3),
      maxMs: roundSigFigs(stats.padding.maxMs, 3),
    } } : {}),
    ...(stats.landingError.count > 0 ? { landingError: {
      meanMs: roundSigFigs(stats.landingError.sumMs / stats.landingError.count, 3),
      minMs: roundSigFigs(stats.landingError.minMs, 3),
      maxMs: roundSigFigs(stats.landingError.maxMs, 3),
      maxAbsMs: roundSigFigs(stats.landingError.maxAbsMs, 3),
    } } : {}),
    ...(stats.landingError.count > 0 ? { landingErrorByKind: Object.fromEntries(
      (["hack", "grow", "weaken"] as const)
        .filter((kind) => stats.landingErrorByKind[kind].count > 0)
        .map((kind) => {
          const d = stats.landingErrorByKind[kind];
          return [kind, {
            meanMs: roundSigFigs(d.sumMs / d.count, 3),
            minMs: roundSigFigs(d.minMs, 3),
            maxMs: roundSigFigs(d.maxMs, 3),
            maxAbsMs: roundSigFigs(d.maxAbsMs, 3),
          }];
        }),
    ) } : {}),
    execFails: driver.execFails,
    ...(Object.values(stats.jitLaunchLate).some((entry) => entry.n > 0) ? {
      launchLate: Object.fromEntries(
        (Object.entries(stats.jitLaunchLate) as ["h" | "w1" | "g" | "w2", typeof stats.jitLaunchLate.h][])
          .filter(([, entry]) => entry.n > 0)
          .map(([role, entry]) => [role, {
            n: entry.n,
            meanMs: roundSigFigs(entry.sumMs / entry.n, 3),
            maxMs: roundSigFigs(entry.maxMs, 3),
            overWindow: entry.overWindow,
          }]),
      ),
    } : {}),
    ...(Object.keys(stats.jitQuotaSkips).length > 0 ? { quotaSkips: stats.jitQuotaSkips } : {}),
    batchesSkipped: stats.batchesSkipped,
    ...(stats.batchesSkipped > 0 ? { batchesSkippedBy: {
      deadline: roundSigFigs(stats.batchesSkippedBy.deadline, 3),
      "arrival-security": roundSigFigs(stats.batchesSkippedBy["arrival-security"], 3),
      "arrival-money": roundSigFigs(stats.batchesSkippedBy["arrival-money"], 3),
      placement: roundSigFigs(stats.batchesSkippedBy.placement, 3),
    } } : {}),
    ...(stats.orphanLandings > 0 ? { orphanLandings: stats.orphanLandings } : {}),
    missedWindow: {
      deadline: roundSigFigs(stats.missedWindow.deadline, 3),
      "arrival-security": roundSigFigs(stats.missedWindow["arrival-security"], 3),
      "arrival-money": roundSigFigs(stats.missedWindow["arrival-money"], 3),
      placement: roundSigFigs(stats.missedWindow.placement, 3),
    },
    ...(landingOrder ? { landingOrder } : {}),
    // Only kinds that have actually run: an all-zero row for a mode this save
    // has never used is noise in both the record and the panel.
    //
    // `abandoned` counts too. A kind whose every batch died before settling has
    // `batches === 0`, and filtering on that alone dropped the one case most
    // worth publishing — a mode that is running and failing looked identical to
    // a mode that was never used.
    batches: Object.fromEntries(
      BATCH_KINDS.filter((kind) =>
        stats.batchesByKind[kind].batches > 0 || stats.batchesByKind[kind].abandoned > 0
      ).map((kind) => [kind, stats.batchesByKind[kind]]),
    ),
    ...(stats.recentBatches.length > 0 ? { recentBatches: stats.recentBatches.map((batch) => ({ ...batch })) } : {}),
    allocation: {
      threads: stats.threadsBySegmentKind,
      effectThreads: stats.effectThreadsBySegmentKind,
    },
    ramWork: {
      nativeGbMs: stats.nativeRamMs,
      paddingGbMs: stats.paddingRamMs,
      nativeGbMsByKind: stats.nativeRamMsByKind,
      paddingGbMsByKind: stats.paddingRamMsByKind,
      nativeGbMsBySegment: stats.nativeRamMsBySegment,
      paddingGbMsBySegment: stats.paddingRamMsBySegment,
      nativeGbMsBySegmentKind: stats.nativeRamMsBySegmentKind,
      paddingGbMsBySegmentKind: stats.paddingRamMsBySegmentKind,
    },
    pumpMaxMs: pumpCost.maxMs,
    ...(pumpCost.occupancy !== undefined ? { pumpOccupancy: pumpCost.occupancy } : {}),
    ...(pumpCost.count > 0 ? { pumpMs: {
      meanMs: roundSigFigs(pumpCost.meanMs, 3),
      maxMs: roundSigFigs(pumpCost.maxMs, 3),
      count: pumpCost.count,
    } } : {}),
    wakePumps,
    ...(pumpCost.wakeRate !== undefined ? { wakePumpRate: roundSigFigs(pumpCost.wakeRate, 3) } : {}),
    wakePumpsSkipped: pumpCost.skipped,
    weakenWindow: { pumps: pumpCost.weakenWindowPumps },
    ...(lateness ? { engineLatenessMs: {
      meanMs: roundSigFigs(lateness.meanMs, 3),
      maxMs: roundSigFigs(lateness.maxMs, 3),
    } } : {}),
    // The independent variable of the whole cost curve. Every rebuild-and-sort
    // in the dispatcher pass is priced in this number, so publishing the two
    // together is what makes "cost grows with depth" readable off the panel.
    ledger: {
      tracked: driver.memory.dispatch.tracked.size,
      pendingBatches: driver.memory.dispatch.pendingJitBatchCount,
      pendingOps: driver.memory.dispatch.pendingJitOpCount,
      onTarget: driver.memory.dispatch.byTarget.get(target)?.size ?? 0,
    },
    totals: { moneyEarned: stats.moneyEarned, hacks: stats.hacks },
  });
}

/** Per-host exponential retry backoff for failed backdoor attempts: 30 s to
 * 10 min. This recovers from transient terminal/resident races without retrying
 * a structurally impossible walk every pass. Cleared on reset. */
const backdoorBackoff = new Map<string, { attempts: number; nextAt: number }>();
const BACKDOOR_BACKOFF_BASE_MS = 30_000;
const BACKDOOR_BACKOFF_CAP_MS = 600_000;

function backdoorRetryBlocked(host: string, now: number): boolean {
  return (backdoorBackoff.get(host)?.nextAt ?? 0) > now;
}

function recordBackdoorFailure(host: string, now: number): void {
  const attempts = (backdoorBackoff.get(host)?.attempts ?? 0) + 1;
  const delay = Math.min(BACKDOOR_BACKOFF_CAP_MS, BACKDOOR_BACKOFF_BASE_MS * 2 ** (attempts - 1));
  backdoorBackoff.set(host, { attempts, nextAt: now + delay });
}
let backdoorInFlight = false;
let openerInFlight = false;
let lastServerAccessAt = 0;
let requestedProgram: ProgramOption | undefined;
/** BN-seconds the requested write is worth — see `ServerAccessPlan`. Carried
 * beside the program because `needs()` posts the need and only the access plan
 * knows what the file unlocks. */
let requestedProgramValueSec: number | undefined;
let infrastructureInFlight = false;
let lastInfrastructureResult: { action: string; ok: boolean; detail: string; at: number } | undefined;

/** Marginal farm income from one more home core. The target solve is repeated
 * with exactly the current and next core count over home's usable capacity.
 * This stays conservative: only the home slice receives the improvement. */
function homeCoreIncomeDelta(ctx: Pick<ClaimContext, "state">): number {
  const driver = hackingState();
  const farm = driver.memory.dispatch.evaluator.directive.farm;
  const hackCtx = driver.memory.dispatch.evaluator.ctx;
  const target = farm ? ctx.state.topics.servers?.[farm.host] : undefined;
  const home = driver.memory.dispatch.heap.host("home");
  // The game hard-caps home at eight cores.
  // Source: https://github.com/bitburner-official/bitburner-src/blob/3162fd2590e221eadd0c0fbd46151913f7c4c41c/src/NetscriptFunctions/Singularity.ts#L595-L618
  if (!farm || !hackCtx || !target || !home || home.cores >= 8) return 0;
  const usable = Math.max(0, home.maxRam - home.reserved);
  if (usable < 2) return 0;
  const statics = {
    hostname: target.hostname,
    minDifficulty: target.minDifficulty ?? 1,
    moneyMax: target.moneyMax ?? 0,
    requiredHackingSkill: target.requiredHackingSkill ?? Infinity,
    serverGrowth: target.serverGrowth ?? 0,
    baseDifficulty: target.baseDifficulty ?? 1,
  };
  const caps = { batchGb: usable, hackBlockGb: usable, growBlockGb: usable };
  const solvedBefore = solveCycle(hackCtx, statics, home.cores, caps);
  const solvedAfter = solveCycle(hackCtx, statics, home.cores + 1, caps);
  const before = solvedBefore ? capitalIndependentScore(solvedBefore) : 0;
  const after = solvedAfter ? capitalIndependentScore(solvedAfter) : 0;
  return Math.max(0, after - before) * usable;
}

/** Income enabled by an exact RAM rung after any hypothetical earlier rungs
 * granted in the same arbitration pass. */
function marginalRamIncome(
  ctx: Pick<ClaimContext, "state">,
  priorAddedRam: number,
  addedRam: number,
): number | undefined {
  const fleet = ctx.state.topics.fleet;
  if (!fleet) return undefined;
  // Claims are collected before this tick's hacking driver runs. On the first
  // pass the rollup has not published `farm.moneyPerSecPerGb` yet; coercing
  // that absence to zero posted a real economic claim worth exactly zero.
  // Prefer the current evaluator solve when it exists, otherwise use the last
  // published rollup, and preserve absence until either source has evidence.
  // Capital-independent on purpose: this number prices a PURCHASE, and the
  // solve's stock-manipulation term is income the purchase's own spend would
  // remove (see capitalIndependentScore).
  const solution = hackingState().memory.dispatch.evaluator.directive.farm?.solution;
  const solvedPerGb = solution ? capitalIndependentScore(solution) : undefined;
  // The rollup fallback must be the capital-independent field too: the plain
  // `moneyPerSecPerGb` is the blended score, and reading it here whenever the
  // directive is momentarily absent during an evaluator reset
  // reintroduced the manipulation double-count on exactly the passes that
  // re-arbitrate pooled money.
  const observedPerGb = solvedPerGb ?? ctx.state.topics.farm?.moneyPerSecPerGbCapitalIndependent;
  if (observedPerGb === undefined) return undefined;
  const perGb = Math.max(0, observedPerGb);
  const depthCap = ctx.state.topics.farm?.depthCapGb;
  const fleetGb = Math.max(
    0,
    (fleet.maxRam ?? 0) - (ctx.state.topics.ramArena?.arenaGb ?? 0) + Math.max(0, priorAddedRam),
  );
  const demandCeiling = depthCap !== undefined
    ? depthCap + (ctx.state.topics.farm?.prepBudgetGb ?? 0)
    : Infinity;
  return perGb * Math.max(
    0,
    Math.min(fleetGb + Math.max(0, addedRam), demandCeiling) - Math.min(fleetGb, demandCeiling),
  );
}

function ramSupplyState(ctx: Pick<ClaimContext, "state" | "caps">): RamSupplyState {
  const fleet = ctx.state.topics.fleet;
  if (!fleet) return {};
  const mults = effectiveBitNodeMultipliers(
    ctx.caps.bitNode,
    sfLevel(ctx.caps.sourceFiles, 12),
    ctx.state.topics.progression?.multipliers,
  );
  const cloudServers = Object.values(ctx.state.topics.servers ?? {}).filter((server) =>
    server.purchasedByPlayer
    && server.hostname !== "home"
    && !server.hostname.startsWith("hacknet-server-")
  );
  const homeAvailable = fleet.homeRamUpgradeCost !== undefined
    && Number.isFinite(fleet.homeRamUpgradeCost);
  const limit = fleet.purchased.limit ?? 0;
  const maxRam = fleet.purchased.maxRamPerServer ?? 0;
  return {
    ...(homeAvailable ? {
      home: {
        currentRam: fleet.home.maxRam,
        costMultiplier: mults?.HomeComputerRamCost ?? 1,
      },
    } : {}),
    ...(maxRam >= 2 ? {
      cloud: {
        costMultiplier: mults?.CloudServerCost ?? 1,
        softcap: mults?.CloudServerSoftcap ?? 1,
        maxRam,
        // The sweep can lag a just-completed purchase. The action path
        // advances `fleet.purchased` immediately, so use the larger observed
        // count and never spend a slot twice while the server topic catches up.
        slotsAvailable: Math.max(0, limit - Math.max(cloudServers.length, fleet.purchased.count ?? 0)),
        servers: cloudServers.map((server) => ({ host: server.hostname, ram: server.maxRam })),
      },
    } : {}),
  };
}

type RamInvestmentContext = Pick<ClaimContext, "state" | "caps" | "horizons">;

function productiveRamInputs(ctx: RamInvestmentContext): HackMarginalInput | undefined {
  const marginals = ctx.state.topics.progression?.plan?.marginals;
  if (!marginals) return undefined;
  const solution = hackingState().memory.dispatch.evaluator.directive.farm?.solution;
  const scriptIncome = ctx.state.topics.fleet?.scriptIncome?.[0];
  const scriptExp = ctx.state.topics.fleet?.scriptExpGain;
  // The point-in-time script getter can be zero between batch workers. The
  // hacking rollup's EMA is measured over landed work and remains meaningful
  // across that gap, so prefer either positive observation over a transient 0.
  const totalMoneyPerSec = Math.max(scriptIncome ?? 0, ctx.state.topics.farm?.moneyRate ?? 0);
  const totalHackingExpPerSec = Math.max(scriptExp ?? 0, ctx.state.topics.farm?.expRate ?? 0);
  return {
    moneySecondsPerRelativeRate: marginals.money.secondsPerRelativeRate,
    hackingSecondsPerRelativeRate: marginals.hacking.secondsPerRelativeRate,
    ...(scriptIncome !== undefined || ctx.state.topics.farm?.moneyRate !== undefined ? { totalMoneyPerSec } : {}),
    ...(scriptExp !== undefined || ctx.state.topics.farm?.expRate !== undefined ? { totalHackingExpPerSec } : {}),
    // Capital-independent: this marginal prices money PURCHASES, so the
    // stock-manipulation share of the score — income that only exists while
    // the market's bankroll stays deployed — must not justify spending that
    // bankroll (see capitalIndependentScore).
    moneyPerSecPerGb: solution ? capitalIndependentScore(solution) : 0,
    hackingExpPerSecPerGb: solution?.experienceScore ?? 0,
  };
}

const MARGINALS_UNPUBLISHED: MeasuredMarginal = {
  state: "unknown",
  reason: "progression RAM marginals have not been published",
};

/** BN-seconds one exact rung saves — the hyperbolic whole-purchase valuation
 * (shared/strategy/share.ts#hackRungValue), not the per-GB tangent line, so a
 * rung that triples a rate is priced at the 75% of the gated time it actually
 * saves rather than an impossible 300%. */
function productiveRungValue(ctx: RamInvestmentContext, addedRam: number): MeasuredMarginal {
  const inputs = productiveRamInputs(ctx);
  return inputs ? hackRungValue(inputs, addedRam) : MARGINALS_UNPUBLISHED;
}

interface RamInvestment {
  source: RamSource | "homeCore";
  supply?: RamSupplyQuote;
  option: ScoredInfrastructure;
  claimAmount: number;
  valuePerDollar: MeasuredMarginal;
}

function investmentRank(investment: RamInvestment): number {
  // Unknown BN-time value must not erase a productive spender. Before the
  // BN-seconds model, infrastructure ranked by direct $/sec/$; retaining that
  // order is the explicit fallback while the arbiter treats the step as
  // unpriced and applies its legacy greedy-by-priority rule.
  return investment.valuePerDollar.state === "measured"
    ? investment.valuePerDollar.value
    : investment.option.returnPerDollarSec;
}

/** An investment must carry EVIDENCE of value before it may claim money.
 *
 * Two admissible kinds, both calculations rather than rules:
 *  - a measured-positive BN-seconds value per dollar (the economic auction
 *    then prices it against every other claim in the band); or
 *  - while that conversion is still unmeasured, a positive closed-form
 *    expected return — the option's own `returnPerDollarSec`, computed from
 *    the vendored formulas WITH the node's multipliers. This is the bootstrap
 *    fallback: a spender whose formulas say it earns must not be erased just
 *    because the BN-time model has no measurements yet.
 *
 * What is NOT admissible is the case both are zero: the formulas already
 * multiplied in everything that scales income (`ScriptHackMoneyGain`, the
 * manipulation value of held positions), so a zero there is a measurement of
 * worthlessness, not an absence of one. An unpriced hard claim must not spend
 * on a farm whose calculated return is zero. When the market later holds a
 * manipulable position, the farm
 * score's `stockIncome` term turns this same gate back on BY CALCULATION. */
function isEvidencedInvestment(investment: RamInvestment): boolean {
  return investment.valuePerDollar.state === "measured"
    ? investment.valuePerDollar.value > 0
    : investment.option.returnPerDollarSec > 0;
}

/** Select one continuous supply segment. Nominal dollars/GB comes from the
 * closed-form supply model; survival enters only through the existing node
 * (home) and install (cloud) horizons. No source preference is encoded. */
function ramInvestment(ctx: RamInvestmentContext, now = Date.now()): RamInvestment | undefined {
  const fleet = ctx.state.topics.fleet;
  if (!fleet) return undefined;

  const nodeHorizon = nodeHorizonSec(ctx.horizons.node);
  const candidates: RamInvestment[] = [];

  // Cores remain on the same infrastructure frontier. They are not RAM
  // supply, so price their observed $/sec/$ delta directly through the common
  // money-rate conversion instead of fabricating GB.
  const coreCost = fleet.homeCoreUpgradeCost;
  if (coreCost !== undefined && Number.isFinite(coreCost) && coreCost > 0 && fleet.home.cores < 8) {
    const incomePerSec = homeCoreIncomeDelta(ctx);
    const value = moneyRateValue(ctx.state, incomePerSec / coreCost, now);
    candidates.push({
      source: "homeCore",
      option: scoreInfrastructure({
        kind: "homeCore",
        cost: coreCost,
        addedRam: 0,
        incomePerSec,
        horizonSec: nodeHorizon,
      }, nodeHorizon),
      claimAmount: coreCost,
      valuePerDollar: value,
    });
  }

  const fleetGb = Math.max(
    0,
    (fleet.maxRam ?? 0) - (ctx.state.topics.ramArena?.arenaGb ?? 0),
  );
  const depthCap = ctx.state.topics.farm?.depthCapGb;
  const demandCeiling = depthCap === undefined
    ? undefined
    : depthCap + (ctx.state.topics.farm?.prepBudgetGb ?? 0);
  const headroomGb = demandCeiling === undefined
    ? Infinity
    : Math.max(0, demandCeiling - fleetGb);
  if (headroomGb > 0) {

  const installHorizon = installHorizonSec(ctx.horizons);
  const state = ramSupplyState(ctx);
  const cash = ctx.state.topics.player?.money ?? 0;
  candidates.push(...(["home", "cloud"] as const).flatMap((source) => {
    // Prefer the largest rung we can actually BUY, not the theoretically
    // cheapest-per-GB one.
    //
    // Below the softcap knee cloud cost is linear (`ram * 55000`), so every
    // size has identical $/GB and a cheapest-per-GB tie-break selects the
    // largest, potentially unaffordable rung. Prefer the largest rung within
    // current cash so bootstrap income can compound.
    //
    // `roundedRamPurchase` already answers "largest rung within this budget";
    // the marginal quote remains the fallback so an unaffordable-but-superior
    // rung can still be saved toward rather than being lost.
    const supply = roundedRamPurchase(source, state, cash) ?? marginalCostPerGb(source, state);
    if (!supply) return [];
    const lifetime = source === "home" ? nodeHorizon : installHorizon;
    const lifetimeFraction = Math.min(1, Math.max(0, lifetime) / Math.max(1, nodeHorizon));
    const valuableGb = Math.min(headroomGb, supply.availableGb);
    if (!(valuableGb > 0)) return [];
    const incomePerSec = marginalRamIncome(ctx, 0, supply.addedRam);
    if (incomePerSec === undefined) return [];
    // Whole-rung hyperbolic value, not per-GB tangent times GB: a rung big
    // enough to triple a rate saves 75% of the gated time, never 300% of it.
    // Valued over the PRODUCTIVE slice only — the same demand ceiling the
    // money channel already applies inside marginalRamIncome. RAM past the
    // farm's pipeline cap produces neither money nor experience, and crediting
    // the whole rung's GB let a 256 GB home step claim to triple the exp rate
    // a ~70 GB-headroom farm could never triple.
    const rung = productiveRungValue(ctx, Math.min(supply.addedRam, valuableGb));
    const valuePerDollar: MeasuredMarginal = rung.state === "measured"
      ? { state: "measured", value: rung.value * lifetimeFraction / Math.max(1, supply.cost) }
      : rung;
    const option = scoreInfrastructure({
      kind: supply.kind,
      cost: supply.cost,
      addedRam: supply.addedRam,
      incomePerSec,
      targetRam: supply.targetRam,
      ...(supply.host ? { host: supply.host } : {}),
      horizonSec: lifetime,
    }, lifetime);
    // Claim the COST OF THE NEXT RUNG, not the value of all the headroom.
    //
    // Valuation is continuous (the supply curve prices every GB), but the
    // purchase is one indivisible rung. Claiming `valuableGb * costPerGb`
    // requests a per-pass slice that may never cover the executable rung.
    //
    // Aligning claim == grant == execution on the rung cost is what lets the
    // reserve accumulate to something buyable. The curve still decides WHETHER
    // the rung is worth its price; this only fixes HOW MUCH is asked for.
    return [{ source, supply, option, claimAmount: supply.cost, valuePerDollar }];
  }));
  }
  // Rank candidates by what would actually be realized: an unaffordable rung
  // is not bought now, it is SAVED FOR, and the save-up wait forfeits the
  // compounding an affordable alternative would have started immediately. This
  // function publishes a single claim, so the comparison cannot happen in the
  // arbiter — an unaffordable winner hides every affordable alternative from
  // it. Price the wait with the same DCF primitive the arbiter applies to step
  // claims, so an unaffordable candidate cannot hide a productive affordable one.
  const evidenced = candidates.filter(isEvidencedInvestment);
  const money = ctx.state.topics.player?.money ?? 0;
  const income = bestIncomePerSec(ctx.state);
  const affordableReturn = evidenced.reduce(
    (best, candidate) => candidate.claimAmount <= money
      ? Math.max(best, candidate.option.returnPerDollarSec)
      : best,
    0,
  );
  const discountedRank = (candidate: RamInvestment): number => {
    const shortfall = Math.max(0, candidate.claimAmount - money);
    if (!(shortfall > 0)) return investmentRank(candidate);
    // An unpriceable wait keeps the raw rank — unknown evidence must not
    // silently change a decision, mirroring the arbiter's step rule.
    if (income.state !== "measured" || !(income.value > 0)) return investmentRank(candidate);
    return investmentRank(candidate) * stepWaitDiscount(shortfall / income.value, affordableReturn);
  };
  return evidenced.sort((a, b) =>
    discountedRank(b) - discountedRank(a)
    || (a.supply?.costPerGb ?? Infinity) - (b.supply?.costPerGb ?? Infinity)
    || (b.supply?.addedRam ?? 0) - (a.supply?.addedRam ?? 0)
  )[0];
}

// No `valueCurve` here on purpose. `infrastructure:ram` is emitted as an
// indivisible `shape: "step"` claim (see the note on its allocation below), and
// the controller only asks for a value curve for CONTINUOUS claims — so a
// curve keyed on that id could never be reached. The rung's economics travel
// on the step's own `value` instead.

/** The grant behind ONE of this feature's money claims. `ctx.grants.money`
 * sums every money grant for the feature, and hacking posts two independent
 * claims (port opener, infrastructure) — gating each purchase on the sum lets
 * a single grant fund both in the same tick, spending cash the arbiter
 * reserved for higher-priority claims. */
function moneyGrantFor(ctx: DriverContext, claimId: string): number {
  let total = 0;
  for (const grant of ctx.grants.result.grants) {
    if (grant.by === "hacking" && grant.resource === "money" && grant.claimId === claimId) total += grant.amount;
  }
  return total;
}

async function executeInfrastructure(ctx: DriverContext, investment: RamInvestment): Promise<void> {
  const continuousGrant = moneyGrantFor(ctx, "infrastructure:ram");
  // The value model is continuous in dollars/GB. Execution is necessarily
  // lumpy: only a complete game purchase rung may be bought. A partial grant
  // remains cash and is reconsidered next pass; it is never rounded inside
  // the marginal curve.
  let decision = investment.option;
  if (investment.source === "cloud") {
    const rounded = roundedRamPurchase("cloud", ramSupplyState(ctx), continuousGrant);
    if (!rounded) return;
    const lifetime = installHorizonSec(ctx.horizons);
    decision = scoreInfrastructure({
      kind: rounded.kind,
      cost: rounded.cost,
      addedRam: rounded.addedRam,
      incomePerSec: marginalRamIncome(ctx, 0, rounded.addedRam) ?? investment.option.incomePerSec,
      targetRam: rounded.targetRam,
      ...(rounded.host ? { host: rounded.host } : {}),
      horizonSec: lifetime,
    }, lifetime);
  }
  const steps = continuousGrant + 1e-9 >= decision.cost ? 1 : 0;
  if (infrastructureInFlight || steps <= 0) return;

  infrastructureInFlight = true;
  const at = Date.now();
  const grantedCost = decision.cost;
  try {
    // Only homeRam is a LADDER: `steps` rungs, each a separate call, and a
    // partial climb still counts as a refusal because the grant funded all of
    // them. Every other kind is one call whose boolean is the whole answer.
    let ok: boolean;
    if (decision.kind === "homeRam") {
      let bought = 0;
      for (; bought < steps; bought++) {
        if (!await ctx.nsp("singularity.upgradeHomeRam")) break;
      }
      ok = bought === steps;
    } else if (decision.kind === "homeCore") {
      ok = await ctx.nsp("singularity.upgradeHomeCores");
    } else if (decision.kind === "buyServer") {
      ok = await ctx.nsp("cloud.purchaseServer", "pserv", decision.targetRam!) !== "";
    } else {
      ok = await ctx.nsp("cloud.upgradeServer", decision.host!, decision.targetRam!);
    }
    lastInfrastructureResult = {
      action: decision.kind,
      ok,
      detail: ok
        ? "bought " + steps + " " + decision.kind + " rung(s) for " + formatMoney(grantedCost)
        : "purchase refused",
      at,
    };
    const publishedPlan = ctx.state.topics.fleet?.infrastructurePlan;
    if (publishedPlan) {
      merge(ctx.state, "fleet", { infrastructurePlan: { ...publishedPlan, lastResult: lastInfrastructureResult } });
    }
    if (ok) {
      const fleet = ctx.state.topics.fleet;
      const player = ctx.state.topics.player;
      if (player) {
        // A successful purchase proves this exact spend. Advance the held
        // balance now so the 200 ms feature loop cannot authorize more rungs
        // against a sweep sample that still contains the pre-purchase cash.
        merge(ctx.state, "player", { money: Math.max(0, player.money - grantedCost) });
      }
      const advanced = decision.kind === "buyServer" || decision.kind === "upgradeServer"
        ? advanceInfrastructureFrontier(fleet?.infrastructureOptions ?? [], fleet?.purchased, decision)
        : undefined;
      merge(ctx.state, "fleet", {
        ...(decision.kind === "homeRam" ? { homeRamUpgradeCost: Infinity } : {}),
        ...(decision.kind === "homeCore" ? { homeCoreUpgradeCost: Infinity } : {}),
        ...(advanced
          ? { infrastructureOptions: advanced.options, ...(advanced.purchased ? { purchased: advanced.purchased } : {}) }
          : {}),
      });
    }
  } finally {
    infrastructureInFlight = false;
  }
}
/** Satisfy server-access (`root` and `backdoor`) needs from the board.
 *
 * This is the needs board doing its job end to end: `factions` posts
 * `{kind:"backdoor", subject:"CSEC"}` because CyberSec requires it, without
 * knowing or caring how a backdoor is installed; `hacking` owns servers, so it
 * delivers. Neither feature references the other.
 *
 * Failure handling is a per-host exponential backoff (never a permanent
 * latch), and only OPENER PURCHASES keep the flat 10-second gate: a backdoor
 * takes hackingTime/4 and is already single-flight, so gating successes too
 * merely delayed the next cheap install by ten idle seconds each.
 * Source: https://github.com/bitburner-official/bitburner-src/blob/3162fd2590e221eadd0c0fbd46151913f7c4c41c/src/NetscriptFunctions/Singularity.ts#L518-L533 */
async function serveServerAccessNeeds(ctx: DriverContext): Promise<void> {
  const now = Date.now();

  const plan = serverAccessPlan(ctx);
  if (!plan) return;
  requestedProgram = plan.writeProgram;
  requestedProgramValueSec = plan.writeProgramValueSec;

  // Not rooted yet: the blocker is usually a missing port opener, and
  // nothing else in the loop will ever buy one. Rooting servers is
  // hacking's job, so acquiring the means to root them is too. This is
  // load-bearing rather than incidental — CSEC needs one open port, so
  // without a cracker the entire faction ladder is unreachable.
  if (plan.primary.action === "port-opener" && !plan.writeProgram) {
    if (now - lastServerAccessAt < 10_000) return;
    if (await buyPortOpener(ctx, plan.primary.server.numOpenPortsRequired ?? 0)) lastServerAccessAt = now;
    return;
  }

  // Either the primary action IS the backdoor, or the career slot is writing
  // an opener and this is the backdoor that runs ALONGSIDE it. A write costs
  // player time — not RAM and not money — so returning here froze the whole
  // access pipeline for the ten to thirty minutes of a create-program job.
  const pending = plan.primary.action === "backdoor" ? plan.primary : plan.concurrentBackdoor;
  if (!pending) return;
  const { host, server } = pending;

  if (backdoorInFlight || backdoorRetryBlocked(host, now)) return;
  backdoorInFlight = true;
  try {
    // The LONG proxy, not the general one: `installBackdoor` awaits for
    // hackingTime/4 — minutes on a real target — and Bitburner allows one
    // Netscript call per script at a time, so running it on `nsp` would hold
    // every other read in the automation behind this one errand. The walk that
    // precedes it rides the same resident because it is one sequence: the
    // terminal must still be sitting on `host` when the install begins.
    const parents = new Map<string, string | undefined>([["home", undefined]]);
    const queue = ["home"];
    for (let index = 0; index < queue.length && !parents.has(host); index++) {
      const current = queue[index]!;
      for (const neighbour of await ctx.nspLong("scan", current)) {
        if (parents.has(neighbour)) continue;
        parents.set(neighbour, current);
        queue.push(neighbour);
      }
    }
    if (!parents.has(host)) throw new Error(`no network route from home to ${host}`);

    const route: string[] = [];
    for (let current: string | undefined = host; current && current !== "home"; current = parents.get(current)) {
      route.push(current);
    }
    if (!await ctx.nspLong("singularity.connect", "home" as never)) {
      throw new Error("could not return terminal connection to home");
    }
    for (const hop of route.reverse()) {
      if (!await ctx.nspLong("singularity.connect", hop as never)) {
        throw new Error(`network route to ${host} failed at ${hop}`);
      }
    }
    await ctx.nspLong("singularity.installBackdoor");
    backdoorBackoff.delete(host);
    server.backdoorInstalled = true;
  } catch (error) {
    if (isScriptDeath(error)) throw error;
    // A broken connect chain or a thrown install. Backed off per host so it
    // does not relaunch every pass — and REPORTED through the probe-failure
    // channel: a silent latch here cost a whole join once (the error was
    // invisible for two hours of run).
    recordBackdoorFailure(host, now);
    recordProbeFailure(ctx.state, `backdoor:${host}`, error);
  } finally {
    backdoorInFlight = false;
  }
}

export type ServerAccessAction = {
  action: "backdoor" | "port-opener";
  host: string;
  server: NonNullable<GameState["topics"]["servers"]>[string];
};

/** Dear openers only buy for targets within this many multiples of current
 * skill: near enough that the blocking-priority spend is actually imminent.
 * Cheap openers stay unbounded so early route needs can buy them before other
 * investments consume the bankroll. */
const OPENER_SKILL_ANTICIPATION = 4;
/** An opener at or below this price is "cheap": always bought ahead. Above
 * it, the skill-proximity bound applies — a $250m SQLInject for a 505-skill
 * target must not outbid compounding investment hours ahead of use. */
const OPENER_ANTICIPATION_COST_CAP = 10e6;

/** Wall-clock cost of installing one backdoor: hackTime/4 at the acting
 * skill, from the evaluator's precomputed hack context. Nominal fallback
 * before the first planner pass, matching the requirement interpreter. */
function backdoorActionSec(state: GameState, server: ServerAccessAction["server"]): number {
  const hackCtx = hackingState().memory.dispatch.evaluator.ctx;
  const player = state.topics.player;
  if (!hackCtx || !player) return NOMINAL_VALUE_SEC_PER_WEIGHT;
  return backdoorCostSeconds({
    requiredHackingSkill: server.requiredHackingSkill ?? 1,
    hackDifficulty: server.hackDifficulty ?? server.minDifficulty ?? 1,
    ctx: hackCtx,
    hackingExp: player.exp?.hacking ?? 0,
    hackingSkillMult: player.mults?.hacking ?? 1,
    ...(state.topics.farm?.expRate !== undefined ? { expPerSec: state.topics.farm.expRate } : {}),
  }).actionSec;
}

/** Highest hacking-skill requirement among open backdoor needs worth training
 * toward: the need carries a measured `valueSec` and that value exceeds the
 * measured wait to reach the requirement. Feeds `routeHackingSkillGoal`, so
 * `skillGateRuntimeSecondsPerExp` prices fleet exp toward the gate. */
function backdoorSkillGoal(ctx: Pick<DriverContext, "board" | "state">): number | undefined {
  const servers = ctx.state.topics.servers ?? {};
  const player = ctx.state.topics.player;
  const hackCtx = hackingState().memory.dispatch.evaluator.ctx;
  if (!player || !hackCtx) return undefined;
  let goal: number | undefined;
  for (const need of ctx.board.open) {
    if (need.kind !== "backdoor" || need.valueSec === undefined || !need.subject) continue;
    const server = servers[need.subject];
    const required = server?.requiredHackingSkill;
    if (!server || required === undefined || required <= player.skills.hacking) continue;
    const cost = backdoorCostSeconds({
      requiredHackingSkill: required,
      hackDifficulty: server.hackDifficulty ?? server.minDifficulty ?? 1,
      ctx: hackCtx,
      hackingExp: player.exp?.hacking ?? 0,
      hackingSkillMult: player.mults?.hacking ?? 1,
      ...(ctx.state.topics.farm?.expRate !== undefined ? { expPerSec: ctx.state.topics.farm.expRate } : {}),
    });
    if (need.valueSec <= cost.skillWaitSec) continue;
    goal = goal === undefined ? required : Math.max(goal, required);
  }
  return goal;
}

/** One access candidate with what the board says its outcome is worth. */
interface RankedAccessCandidate {
  entry: ServerAccessAction;
  /** BN-seconds the board says this outcome saves — measured where a poster
   * priced it, the nominal weight fallback otherwise. */
  valueSec: number;
  /** Value per wall-clock second the action costs, which is what ranks it. */
  score: number;
  ports: number;
}

/** Select the exact board action both claim collection and execution use.
 *
 * Candidates are ranked by VALUE DENSITY — the total BN-seconds the board says
 * the outcome saves (measured `valueSec` where posted, the nominal
 * weight-based fallback otherwise) per wall-clock second the action costs —
 * instead of the old strict [root, backdoor] tiers. An opener purchase is
 * effectively instant, so prerequisite buying still naturally precedes a long
 * install; a ready CSEC backdoor at high skill (seconds) floats over a
 * half-hour megacorp install; and a high-value backdoor no longer waits for
 * every root on the board. The guard rails from the tiered version are kept
 * verbatim: bounded opener anticipation, prerequisite deferral, and the rule
 * that a root-only need never escalates into an unrequested backdoor. */
function rankServerAccessCandidates(
  ctx: Pick<ClaimContext, "board" | "state" | "activeFeatures">,
): RankedAccessCandidate[] {
  const servers = ctx.state.topics.servers ?? {};
  const player = ctx.state.topics.player;
  if (!player) return [];
  const now = Date.now();
  const measured = needValueSeconds(ctx.board, ["root", "backdoor"]);
  // Per (action, host) candidate value: same-key needs already summed into
  // `measured`; unmeasured posters contribute the ranking fallback.
  const candidates = new Map<string, { entry: ServerAccessAction; costSec: number }>();
  const fallback = new Map<string, number>();
  for (const need of ctx.board.open) {
    if (need.kind !== "root" && need.kind !== "backdoor") continue;
    const host = need.subject;
    const wantsBackdoor = need.kind === "backdoor";
    if (!host || (wantsBackdoor && backdoorRetryBlocked(host, now))) continue;
    const server = servers[host];
    if (!server || (wantsBackdoor ? server.backdoorInstalled : server.hasAdminRights)) continue;
    const key = `${need.kind}:${host}`;
    if (need.valueSec === undefined) fallback.set(key, (fallback.get(key) ?? 0) + rankingValueSec(need));
    if (candidates.has(key)) continue;
    // Port openers are MONEY, not skill: buy them the moment the need exists
    // so the root is ready when the skill arrives. Gating the purchase behind
    // the skill check closed the buying window on factions-join — by the time
    // hacking crossed CSEC's requirement, the bankroll had been spent on
    // fleet and BruteSSH stayed unaffordable for the rest of the run. But the
    // anticipation is BOUNDED: the opener claim runs at blocking priority,
    // and a target whose skill requirement is many multiples away (505-skill
    // run4theh111z early in a run) would divert a $250m opener spend from
    // compounding investment hours before the backdoor is actionable.
    if (!server.hasAdminRights) {
      if ((server.numOpenPortsRequired ?? 0) === 0) continue;
      // Do not turn a wanted future backdoor into a higher-priority savings
      // target while another subsystem is waiting on cash right now. Ready
      // backdoors remain free to execute, and a genuinely blocking opener is
      // still allowed through.
      if (deferPrerequisitePurchase(need.urgency, ctx.board.open)) continue;
      const program = programForPortNeed(ctx.state, server.numOpenPortsRequired ?? 0);
      const dear = (program?.purchaseCost ?? 0) > OPENER_ANTICIPATION_COST_CAP;
      if (dear && (server.requiredHackingSkill ?? Infinity) > player.skills.hacking * OPENER_SKILL_ANTICIPATION) {
        continue;
      }
      candidates.set(key, {
        entry: { action: "port-opener", host, server },
        costSec: openerAcquireSec(ctx, program),
      });
      continue;
    }
    // A root-only need is satisfied by the fleet sweep once the opener exists;
    // it must never escalate into installing an unrequested backdoor.
    if (!wantsBackdoor) continue;
    // The backdoor itself DOES need the skill (and the connect chain).
    if (player.skills.hacking < (server.requiredHackingSkill ?? Infinity)) continue;
    candidates.set(key, {
      entry: { action: "backdoor", host, server },
      costSec: Math.max(1, backdoorActionSec(ctx.state, server)),
    });
  }
  const ranked: RankedAccessCandidate[] = [];
  for (const [key, candidate] of candidates) {
    const valueSec = (measured[key] ?? 0) + (fallback.get(key) ?? 0);
    ranked.push({
      entry: candidate.entry,
      valueSec,
      score: valueSec / candidate.costSec,
      ports: candidate.entry.server.numOpenPortsRequired ?? 0,
    });
  }
  // Lowest-port opener breaks a score tie: its next program is cheapest.
  ranked.sort((a, b) => b.score - a.score || a.ports - b.ports);
  return ranked;
}

/** Wall-clock cost of ACQUIRING an opener, which is NOT the cost of the
 * darkweb call. Buying is effectively instant; writing occupies the career
 * slot for the whole create-program time. Pricing a write at one second gave
 * every opener candidate its raw `valueSec` as a score, so a ten-minute
 * BruteSSH write outranked every ready backdoor on the board. */
function openerAcquireSec(
  ctx: Pick<ClaimContext, "state" | "activeFeatures">,
  program: ProgramOption | undefined,
): number {
  if (!program || !writeInsteadOfBuy(ctx, program)) return 1;
  const skills = ctx.state.topics.player?.skills;
  const timeMs = skills ? programCreateTimeMs(program, skills.hacking, skills.intelligence) : Infinity;
  return Number.isFinite(timeMs) ? Math.max(1, timeMs / 1_000) : 1;
}

function writeInsteadOfBuy(
  ctx: Pick<ClaimContext, "state" | "activeFeatures">,
  program: ProgramOption,
): boolean {
  return ctx.activeFeatures.has("career") && shouldWriteProgram(ctx.state, program);
}

export interface ServerAccessPlan {
  /** Best candidate by value density — what this feature acts on. */
  primary: ServerAccessAction;
  /** Program the career slot should write instead of buying `primary`. */
  writeProgram?: ProgramOption;
  /** BN-seconds that writing it is worth: the board's own value for EVERY
   * server the new opener unblocks, not just `primary`. One opener typically
   * roots several hosts, and the file is worth all of them.
   *
   * Career prices the write against crime and faction work in BN-seconds, so
   * this number has to be one too. Posting the need on the nominal weight
   * instead gave every opener the same invented 2,400 — BruteSSH for a starter
   * box and SQLInject for a megacorp — which is not comparable to a rate priced
   * from a measured marginal. */
  writeProgramValueSec?: number;
  /** Best backdoor to install WHILE that write occupies the career slot. The
   * write spends player time only, so the backdoor pipeline must keep
   * running rather than idling behind it. */
  concurrentBackdoor?: ServerAccessAction;
}

/** The board's route-terminal root need for this host, if any. The flag is
 * set by the route stage machine (RouteNeed.terminal); both the write-vs-buy
 * bypass and the claim escalation key off it, and they must move together —
 * half-applying this condition is exactly how the measured 37-minute
 * one-root-from-victory stall comes back. */
function terminalRootNeed(board: Pick<ClaimContext, "board">["board"], host: string | undefined): boolean {
  return host !== undefined
    && board.open.some((need) => need.terminal === true && need.kind === "root" && need.subject === host);
}

export function serverAccessPlan(
  ctx: Pick<ClaimContext, "board" | "state" | "activeFeatures"> & Partial<Pick<ClaimContext, "horizons">>,
): ServerAccessPlan | undefined {
  const candidates = rankServerAccessCandidates(ctx);
  const primary = candidates[0]?.entry;
  if (!primary) return undefined;
  if (primary.action !== "port-opener") return { primary };
  const program = programForPortNeed(ctx.state, primary.server.numOpenPortsRequired ?? 0);
  // A progression-posted blocking root need is the route's terminal blocker:
  // completion is worth the whole remaining horizon, so calendar time — not
  // money — is the scarce resource, and a multi-hour create-program can never
  // beat an instant purchase. The write-vs-buy comparison below cannot see
  // this on its own: at the endgame nothing bids for money, the waterline
  // vanishes, and its no-model fallback (forgone slot money < buy cost) reads
  // a $250m SQLInject as precious next to a "free" write that the slot never
  // actually schedules.
  const routeBlockingRoot = terminalRootNeed(ctx.board, primary.host);
  if (!program || routeBlockingRoot || !writeInsteadOfBuy(ctx, program)) return { primary };
  const concurrentBackdoor = candidates.find((entry) => entry.entry.action === "backdoor")?.entry;
  return {
    primary,
    writeProgram: program,
    writeProgramValueSec: openerUnlockValueSec(ctx, candidates),
    ...(concurrentBackdoor ? { concurrentBackdoor } : {}),
  };
}

/** What the NEXT opener unlocks, in BN-seconds.
 *
 * Writing one program takes the port count from `owned` to `owned + 1`, so every
 * pending candidate needing at most that many ports stops being blocked by a
 * missing cracker. Summing them is the honest value of the file; taking only the
 * primary would under-price an opener that roots half the board at once.
 *
 * Clamped to the node horizon because an unlock cannot save more run than there
 * is run left — the same bound `factionGateSavedSeconds` puts on an access
 * blocker, and the same horizon the write's occupancy is charged against. */
function openerUnlockValueSec(
  ctx: Pick<ClaimContext, "state"> & Partial<Pick<ClaimContext, "horizons">>,
  candidates: readonly RankedAccessCandidate[],
): number {
  const unlockedPorts = (ctx.state.topics.fleet?.portOpeners ?? 0) + 1;
  let total = 0;
  for (const candidate of candidates) {
    if (candidate.entry.action !== "port-opener") continue;
    if ((candidate.entry.server.numOpenPortsRequired ?? 0) > unlockedPorts) continue;
    total += candidate.valueSec;
  }
  return Math.min(total, nodeHorizonSec(ctx.horizons?.node));
}

/** Darkweb port openers, cheapest first — the order the game unlocks ports in.
 * Source prices: https://github.com/bitburner-official/bitburner-src/blob/3162fd2590e221eadd0c0fbd46151913f7c4c41c/src/DarkWeb/DarkWebItems.ts#L5-L10
 * Source effects: https://github.com/bitburner-official/bitburner-src/blob/3162fd2590e221eadd0c0fbd46151913f7c4c41c/src/NetscriptFunctions.ts#L549-L620 */
const PORT_OPENERS = ["BruteSSH.exe", "FTPCrack.exe", "relaySMTP.exe", "HTTPWorm.exe", "SQLInject.exe"] as const;

function programForPortNeed(game: GameState, portsRequired: number): ProgramOption | undefined {
  const owned = game.topics.fleet?.portOpeners ?? 0;
  if (owned >= portsRequired) return undefined;
  return PORT_OPENER_PROGRAMS[owned];
}

function programsForPortNeed(game: GameState, portsRequired: number): readonly ProgramOption[] {
  const owned = game.topics.fleet?.portOpeners ?? 0;
  return PORT_OPENER_PROGRAMS.slice(owned, portsRequired);
}

/** Positive evidence of TOR, and only positive evidence — an atomic budget
 * that omits the router when we do not actually own it under-funds the grant
 * by TOR_COST and the purchase then fails on the router rather than the
 * program.
 *
 * Owning port openers is NOT evidence: `createProgram` writes BruteSSH.exe and
 * the rest with no dark web at all, which is exactly the branch
 * `preferProgramCreation` takes when money is tight. So the flag is set only
 * where a dark web purchase actually succeeded, plus darknet access — which
 * means DarkscapeNavigator was bought (and therefore TOR first), or BN15/SF15
 * granted both. */
function hasTor(game: GameState): boolean {
  return game.topics.fleet?.hasTor === true
    || game.topics.capabilities?.unlocked.dnet === "yes";
}

function portOpenerPurchaseCost(game: GameState, portsRequired: number): number {
  return (hasTor(game) ? 0 : TOR_COST) + programsForPortNeed(game, portsRequired)
    .reduce((total, program) => total + program.purchaseCost, 0);
}

/** Re-score the next opener from the world already held in state. This is run
 * at the 1 Hz rollup boundary, not in claims(), because target solves are the
 * expensive half of the dispatcher and claim collection must remain pure. */
function evaluateEconomicOpener(game: GameState) {
  const fleet = game.topics.fleet;
  const player = game.topics.player;
  const hackCtx = hackingState().memory.dispatch.evaluator.ctx;
  if (!fleet || !player || !hackCtx) return undefined;
  return planNextOpener({
    servers: Object.values(game.topics.servers ?? {}),
    hackingSkill: player.skills.hacking,
    hackContext: hackCtx,
    fleetGb: Math.max(0, fleet.maxRam - (game.topics.ramArena?.arenaGb ?? 0)),
    ownedOpeners: fleet.portOpeners ?? 0,
    hasTor: hasTor(game),
    ...(hackingState().memory.dispatch.evaluator.directive.farm
      ? { currentFarm: hackingState().memory.dispatch.evaluator.directive.farm }
      : {}),
  });
}

function economicOpenerValue(ctx: ClaimContext, plan: { addedMoneyPerSec: number; addedHackingExpPerSec: number }): MeasuredMarginal {
  const values: number[] = [];
  const unknown: string[] = [];
  const money = moneyStepValue(ctx.state, plan.addedMoneyPerSec, ctx.now);
  if (money.state === "measured") values.push(money.value);
  else unknown.push(money.reason);

  const marginal = ctx.state.topics.progression?.plan?.marginals?.hacking;
  const observed = Math.max(
    0,
    ctx.state.topics.fleet?.scriptExpGain ?? 0,
    ctx.state.topics.farm?.expRate ?? 0,
    marginal?.atRatePerSec ?? 0,
  );
  if (marginal?.state === "estimated" && observed > 0 && plan.addedHackingExpPerSec > 0) {
    values.push(marginal.secondsPerRelativeRate * relativeGainSaving(plan.addedHackingExpPerSec / observed));
  } else if (plan.addedHackingExpPerSec > 0) {
    unknown.push(marginal?.reason ?? "the progression hacking marginal is not published");
  }
  if (values.length > 0) return { state: "measured", value: values.reduce((sum, value) => sum + value, 0) };
  return { state: "unknown", reason: unknown.join("; ") || "the opener unlock has no priced progression channel" };
}

function shouldWriteProgram(game: GameState, program: ProgramOption): boolean {
  const skills = game.topics.player?.skills;
  if (!skills) return false;
  const timeMs = programCreateTimeMs(program, skills.hacking, skills.intelligence);
  if (!Number.isFinite(timeMs)) return false;
  return preferProgramCreation(
    program,
    skills.hacking,
    skills.intelligence,
    careerAlternative(game, timeMs / 1_000),
    hasTor(game),
    moneyValueSecPerDollar(game),
  );
}

/** What the player-work slot would do over a `writeSec` window if it were not
 * writing this program — the write's real opportunity cost.
 *
 * Read this from the auction rather than career's menu: the opportunity cost
 * includes every feature bidding for the slot. `arbitration.slotValues` is the
 * complete bid set and its current worth.
 *
 * The scaling is the part that is easy to get wrong. A bid's `valueSec` is the
 * BN-seconds a SUSTAINED rate is worth over the rest of the route; occupying the
 * slot for `writeSec` of that route forfeits the corresponding fraction of it,
 * never the whole thing. */
function careerAlternative(game: GameState, writeSec: number): ProgramAlternative {
  const ranked = (game.topics.career?.plan?.ranked ?? [])
    .filter((entry) => !entry.label.startsWith("program:"));
  const moneyPerSec = Math.max(0, ...ranked.map((entry) => entry.moneyPerSec));

  let bestSlotValueSec = Math.max(0, ranked[0]?.score ?? 0);
  for (const bid of game.topics.arbitration?.slotValues ?? []) {
    // Career's own bid is either this write or the option already counted
    // above; every other bidder is a use of the slot career cannot see.
    if (bid.by === "career" || bid.valueSec === undefined) continue;
    bestSlotValueSec = Math.max(bestSlotValueSec, bid.valueSec);
  }

  const node = game.topics.progression?.plan?.forecasts?.node;
  const horizonSec = nodeHorizonSec(node);
  const occupied = horizonSec > 0 ? Math.min(1, Math.max(0, writeSec) / horizonSec) : 1;
  return { moneyPerSec, valueSec: bestSlotValueSec * occupied };
}

/** The arbiter's own shadow price of a dollar, in BN-seconds. Taken as the
 * highest money waterline: that is what the next dollar is worth to the
 * best-priced claim the auction could not fully fund, which is exactly the
 * cost of spending it on a port opener instead. Absent until some money band
 * carries a priced claim, and the caller then falls back to money-only. */
function moneyValueSecPerDollar(game: GameState): number | undefined {
  const waterlines = game.topics.arbitration?.waterlines ?? [];
  let best = 0;
  for (const waterline of waterlines) {
    if (waterline.resource === "money" && waterline.lambda > best) best = waterline.lambda;
  }
  return best > 0 ? best : undefined;
}

/** Buy every port opener needed for the selected server in one atomic grant.
 * Darkweb purchases are immediate, and stretching a five-port blocker over
 * five 30-second fleet observations can miss an otherwise completed node.
 * Returns true if anything was bought.
 *
 * Used by both blocking access needs and the economically priced fleet unlock;
 * neither path may spend without its own exact arbiter grant. */
async function buyPortOpener(ctx: DriverContext, portsRequired: number, claimId?: string): Promise<boolean> {
  if (portsRequired === 0) return false;
  const program = programForPortNeed(ctx.state, portsRequired);
  const requiredGrant = portOpenerPurchaseCost(ctx.state, portsRequired);
  // Never let an imperative purchase bypass the shared money policy.
  if (!program || openerInFlight || moneyGrantFor(ctx, claimId ?? `port-opener:${program.name}`) < requiredGrant) return false;
  openerInFlight = true;
  try {
    const files = new Set(await ctx.nsp("ls", "home", ".exe"));
    const owned = PORT_OPENERS.filter((name) => files.has(name));
    const missing = PORT_OPENERS.filter((name) => !files.has(name));
    let acquired = owned.length;
    // TOR first; it is a precondition and idempotent.
    // Source: https://github.com/bitburner-official/bitburner-src/blob/3162fd2590e221eadd0c0fbd46151913f7c4c41c/src/NetscriptFunctions/Singularity.ts#L401-L442
    if (owned.length < portsRequired && missing.length > 0 && await ctx.nsp("singularity.purchaseTor")) {
      for (const name of missing.slice(0, portsRequired - owned.length)) {
        if (!await ctx.nsp("singularity.purchaseProgram", name as never)) break;
        acquired++;
      }
    }
    const before = ctx.state.topics.fleet?.portOpeners ?? 0;
    // `hasTor` rides the PROGRAM purchase, not the call: purchaseTor is never
    // reached when the openers are already owned, and the count is unchanged
    // when it refuses. A dark web program that actually landed is the only
    // proof the router exists.
    if (acquired > before) {
      merge(ctx.state, "fleet", { portOpeners: acquired, hasTor: true, openerPlan: null });
    }
    return acquired > before;
  } catch (error) {
    if (isScriptDeath(error)) throw error;
    // No singularity access — the crackers must come from elsewhere.
    return false;
  } finally {
    openerInFlight = false;
  }
}

/** One dispatcher pump: build the view, drain completions, plan, launch, and
 * track the target switch. Shared by the scheduled tick and the wake pass —
 * the wake pass IS a pump, just triggered by a landing instead of the clock. */
async function runPump(
  ns: NS,
  game: GameState,
  caps: DriverContext["caps"],
  arenaReserves: Readonly<Record<string, number>>,
  installSec: number | undefined,
  sharePricing: ShareValue | undefined,
  chargePricing: ChargePricingInput | undefined,
  trigger?:
    | { kind: "target-wake"; target: string; source: "completion" | "deadline" }
    | { kind: "shotgun-pump"; target: string },
): Promise<Awaited<ReturnType<typeof pump>> | undefined> {
  const servers = game.topics.servers;
  const player = game.topics.player;
  if (!servers || !player || Object.keys(servers).length === 0) return undefined;

  const driver = hackingState();

  // Only the farm and prep targets get live reads; everything else comes
  // from the sweep snapshot.
  const active = driver.memory.dispatch.evaluator.directive;
  const hot = trigger
    ? [trigger.target]
    : [active.farm?.host, active.prep?.host].filter((h): h is string => Boolean(h));
  // The stock feature's manipulation intent rides along: hack pushes a
  // symbol's forecast down and grow pushes it up, so in a node where the
  // market matters the farm's best target is not the richest server but the
  // one whose price movement is worth the most. See spec/targeting.md.
  // Source: https://github.com/bitburner-official/bitburner-src/blob/3162fd2590e221eadd0c0fbd46151913f7c4c41c/src/StockMarket/PlayerInfluencing.ts#L17-L60
  const view = await buildView(
    driver,
    servers,
    player,
    hot,
    effectiveBitNodeMultipliers(
      caps.bitNode,
      sfLevel(caps.sourceFiles, 12),
      game.topics.progression?.multipliers,
    ),
    game.topics.stock?.manipulation,
    expRateEma,
  );
  const completions = drainCompletions(driver, trigger?.target);
  if (!trigger) driver.globals.dispatch_wake_targets?.clear();
  const reinvestmentReturnPerDollarSec = bestReinvestmentReturnPerDollarSec(game);

  const started = performance.now();
  // pooling: farm batch ops ride pooled serve workers (worker.ts serve mode),
  // collapsing exec churn — the browser-side cost of a fresh WorkerScript per
  // op — to near zero at depth.
  const result = await pump(ns, driver, view, completions, {
    arenaReserves,
    pooling: true,
    ...(installSec !== undefined ? { horizonMs: installSec * 1_000 } : {}),
    ...(reinvestmentReturnPerDollarSec > 0 ? { reinvestmentReturnPerDollarSec } : {}),
    ...(routeHackingSkillGoal !== undefined ? { hackingSkillGoal: routeHackingSkillGoal } : {}),
    ...(trigger ? { trigger } : {}),
    ...(sharePricing ? { shareValue: sharePricing } : {}),
    ...(chargePricing ? { chargeValue: chargePricing } : {}),
  });
  const shotgunWake = result.nextWakes.find((wake) => wake.purpose === "shotgun");
  if (!trigger || trigger.kind === "shotgun-pump") {
    scheduleShotgunPump(shotgunWake?.ms, shotgunWake?.target);
  }
  const jitWakes = result.nextWakes.filter((wake) => wake.purpose !== "shotgun");
  if (trigger?.kind === "target-wake") {
    const next = jitWakes.find((wake) => wake.target === trigger.target);
    scheduleJitWake(next ? view.time + next.ms : undefined, trigger.target);
  } else {
    const wanted = new Set(jitWakes.map((wake) => wake.target ?? ""));
    for (const key of driver.globals.dispatch_jit_timers?.keys() ?? []) {
      if (!wanted.has(key)) scheduleJitWake(undefined, key || undefined);
    }
    for (const wake of jitWakes) {
      scheduleJitWake(view.time + wake.ms, wake.target);
    }
  }
  const elapsed = performance.now() - started;
  if (elapsed > pumpMaxMs) pumpMaxMs = elapsed;
  if (pumpWindowAt === 0) pumpWindowAt = started;
  pumpMsSum += elapsed;
  pumpCount++;
  lastPumpAt = performance.now();

  const target = result.directive.farm?.host ?? "";
  const current = farmTarget;
  if (target !== current) {
    switched = { from: current, to: target };
    farmTarget = target;
  }
  return result;
}

/** The wake pass: a worker completion just landed (the controller raced its
 * tick sleep against `dispatch_wake`). One trimmed pump — no rollup, no
 * infrastructure, no board service. Its value is WHEN it runs: heap RAM frees
 * up to a full spacer early, and after a W2 landing the hot-path live reads
 * see the target provably at min security, so recomputed durations and
 * isPrepped are exact. Throttled: never within WAKE_MIN_MS of any pump, at
 * most WAKE_MAX_PER_FRAME per frame. */
export async function pumpOnWake(
  ns: NS,
  game: GameState,
  caps: DriverContext["caps"],
  arenaReserves: Readonly<Record<string, number>>,
  installSec: number | undefined,
): Promise<void> {
  const driver = hackingState();
  // A target wake may race the engine turn which applies a completed charge's
  // multiplier. Leave the target queues latched for the heartbeat that first
  // refreshes Player; launching with the old hacking_speed would misplace the
  // whole landing grid.
  if (driver.globals.charge_context_pending) return;
  const done = driver.globals.dispatch_done ?? [];
  const targets = new Set(driver.globals.dispatch_wake_targets ?? []);
  for (const completion of done) if (completion.target) targets.add(completion.target);
  const shotgunTarget = shotgunPumpTarget;
  shotgunPumpTarget = undefined;
  if (shotgunTarget) targets.add(shotgunTarget);

  // Each target gets its own pass. A weaken on B can bypass throttling for B,
  // but cannot make A's farm queue eligible or refresh A's live state.
  for (const target of targets) {
    const now = performance.now();
    const targetDone = done.filter((completion) => completion.target === target);
    const weakenWindow = targetDone.some((completion) => completion.kind === "weaken");
    // A wake with no completion behind it is a SCHEDULED launch deadline: the
    // JIT grid armed a realm timer for this exact instant. The throttles below
    // exist to coalesce completion floods; refusing a deadline wake instead
    // moves the launch to a later frame, which caps the whole pipeline at
    // (WAKE_MAX_PER_FRAME + heartbeats)/sec batches — measured 24.1 launched
    // of 50 planned per second on the one-server lane, with landings sliding
    // 0.4-0.9 s late on the skill-jump lane.
    const shotgunContinuation = target === shotgunTarget;
    const scheduled = shotgunContinuation || targetDone.length === 0;
    if (!weakenWindow && !scheduled && now - lastPumpAt < WAKE_MIN_MS) {
      wakeSkipGap++;
      continue;
    }
    if (!weakenWindow && !scheduled && wakesThisFrame >= WAKE_MAX_PER_FRAME) {
      wakeSkipFrame++;
      continue;
    }
    driver.globals.dispatch_wake_targets?.delete(target);
    if (weakenWindow) weakenWindowPumps++;
    wakesThisFrame++;
    wakePumps++;
    await runPump(
      ns,
      game,
      caps,
      arenaReserves,
      installSec,
      latestShareValue,
      latestChargeValue,
      shotgunContinuation
        ? { kind: "shotgun-pump", target }
        : { kind: "target-wake", target, source: targetDone.length > 0 ? "completion" : "deadline" },
    );
  }
}

export const hacking: FeatureDriver = {
  id: "hacking",
  everyMs: 200,
  async tick(ctx: DriverContext) {
    const { ns, state: game } = ctx;
    // Stanek applies multiplier changes on the engine turn after a successful
    // charge. Refresh before this heartbeat can launch target work under the
    // old duration context; target-local wakes never perform this realm-wide
    // maintenance.
    const globals = workerGlobals();
    if (globals.charge_context_pending) {
      set(game, "player", await ctx.nsp("getPlayer"));
      globals.charge_context_pending = false;
    }
    wakesThisFrame = 0;
    routeHackingSkillGoal = ctx.board.open
      .filter((need) => need.kind === "skill" && need.subject === "hacking")
      .reduce<number | undefined>(
        (highest, need) => highest === undefined ? need.target : Math.max(highest, need.target),
        undefined,
      );
    // Open backdoor needs whose skill requirement is not met yet are ALSO
    // skill gates: exp shrinks the wait (and the install itself). Admitted
    // only when the need's measured value exceeds the measured wait, so an
    // early 505-skill run4theh111z cannot hijack the farm's exp valuation.
    const accessSkillGoal = backdoorSkillGoal(ctx);
    if (accessSkillGoal !== undefined) {
      routeHackingSkillGoal = Math.max(routeHackingSkillGoal ?? 0, accessSkillGoal);
    }

    // The reserve is computed per pass, not constant: it tracks the broker
    // arena, which grows under actual starvation, so an expensive singularity
    // read stays affordable instead of being crowded out by the dispatcher
    // taking every free gigabyte.
    //
    // The horizon is the endgame route's expected remaining run time: a
    // target that would only pay off after the run is expected to end is not
    // worth prepping, however good its steady-state rate. The game has no
    // money GOAL (that is the sim's device), so the run horizon is the only
    // finite bound the evaluator gets here. Converted to ms at this boundary:
    // everything below planFarm is ms-native.
    const installSec = usableForecastSec(ctx.horizons.install);
    latestShareValue = shareValue(game, ctx.caps);
    latestChargeValue = chargeValue(game);
    const result = await runPump(
      ns,
      game,
      ctx.caps,
      ctx.arena.reserves,
      installSec,
      latestShareValue,
      latestChargeValue,
    );
    if (!result) return;
    const driver = hackingState();
    const target = result.directive.farm?.host ?? "";

    // 1 Hz rollup — never per-op state (it would be ~3 writes per 16 ms).
    const now = Date.now();
    if (now - lastRollup >= 1_000) {
      lastRollup = now;
      rollup(
        game,
        driver,
        target,
        result.directive.prep?.host,
        result.directive.segments.map((segment) => segment.kind),
      );
      const infrastructure = ramInvestment(ctx);
      const openerPlan = evaluateEconomicOpener(game);
      const infrastructureOption = infrastructure?.option;
      const homeRamCost = game.topics.fleet?.homeRamUpgradeCost;
      const homeRam = homeRamCost === undefined ? undefined : scoreHomeRam({
        currentRam: game.topics.fleet!.home.maxRam,
        upgradeCost: homeRamCost,
        incomePerSecPerGb: game.topics.farm?.moneyPerSecPerGb ?? 0,
        horizonSec: nodeHorizonSec(ctx.horizons.node),
      });
      if (game.topics.fleet) {
        merge(game, "fleet", {
          openerPlan: openerPlan ?? null,
          ...(homeRam ? { homeRamPlan: {
            cost: game.topics.fleet!.homeRamUpgradeCost!,
            addedRam: homeRam.addedRam,
            incomePerSec: homeRam.incomePerSec,
            paybackSec: homeRam.paybackSec,
            netOverHorizon: homeRam.netOverHorizon,
            worthBuying: homeRam.worthBuying,
            ...(lastInfrastructureResult?.action === "homeRam" ? { lastResult: lastInfrastructureResult } : {}),
          } } : {}),
          infrastructurePlan: {
            evaluatedAt: now,
            // Coarse for the DIGEST: the raw forecast ticks down every second
            // and re-published one store record per second all run.
            horizonSec: coarseHorizonSec(nodeHorizonSec(ctx.horizons.node)),
            moneyAvailable: game.topics.player?.money ?? 0,
            moneyGranted: ctx.grants.money,
            incomePerSecPerGb: game.topics.farm?.moneyPerSecPerGb ?? 0,
            reinvestmentReturnPerDollarSec: infrastructureOption?.returnPerDollarSec ?? 0,
            ...(infrastructureOption ? { buy: {
              kind: infrastructureOption.kind,
              cost: infrastructureOption.cost,
              ...(infrastructureOption.host ? { host: infrastructureOption.host } : {}),
              ...(infrastructureOption.targetRam ? { targetRam: infrastructureOption.targetRam } : {}),
            } } : {}),
            rankedTotal: infrastructureOption ? 1 : 0,
            ranked: infrastructureOption ? [infrastructureOption].map((entry) => ({
              kind: entry.kind,
              ...(entry.host ? { host: entry.host } : {}),
              ...(entry.targetRam ? { targetRam: entry.targetRam } : {}),
              addedRam: entry.addedRam,
              cost: entry.cost,
              incomePerSec: entry.incomePerSec,
              returnPerDollarSec: entry.returnPerDollarSec,
              paybackSec: entry.paybackSec,
              netOverHorizon: entry.netOverHorizon,
              worthBuying: entry.worthBuying,
              selected: true,
            })) : [],
            ...(lastInfrastructureResult ? { lastResult: lastInfrastructureResult } : {}),
          },
        });
      }
    }

    // Fire-and-forget for the same reason as the backdoors below: proxy calls
    // serialise on their resident, and the dispatcher must not await a
    // multi-second purchase run on its 200 ms cadence.
    // `infrastructureInFlight` keeps it single-flight.
    const investment = ramInvestment(ctx);
    const openerPlan = game.topics.fleet?.openerPlan ?? undefined;
    if (openerPlan && moneyGrantFor(ctx, `opener-investment:${openerPlan.program}`) + 1e-9 >= openerPlan.cost) {
      void buyPortOpener(ctx, openerPlan.targetOpeners, `opener-investment:${openerPlan.program}`)
        .catch((error) => { if (isScriptDeath(error)) throw error; });
    }
    // Only attempt a rung the grant actually covers.
    //
    // The claim is CONTINUOUS — it asks for `valuableGb * costPerGb`, the
    // whole value of the headroom — while execution buys ONE indivisible rung
    // at `option.cost`. Those are different numbers, and the water-filled
    // grant is bounded by the pool, so execution must verify that the grant
    // covers the indivisible purchase.
    //
    // Skipping is not a denial: money keeps accruing, the grant grows with
    // it, and the rung is bought on the pass it becomes affordable. That is
    // the accumulate-to-rung behaviour a lumpy purchase needs from a
    // continuous valuation.
    const grantedMoney = ctx.grants.money;
    if (investment && grantedMoney + 1e-9 >= investment.option.cost) {
      void executeInfrastructure(ctx, investment).catch((error) => {
        if (isScriptDeath(error)) throw error;
        lastInfrastructureResult = { action: investment.option.kind, ok: false, detail: String(error), at: Date.now() };
      });
    }

    // Serve the board LAST, so a backdoor can never delay a
    // dispatcher pass. Fire-and-forget: the dispatcher must not await a
    // multi-second backdoor on its 200 ms cadence.
    if (ctx.board.byKind.backdoor.length > 0 || ctx.board.byKind.root.length > 0) {
      void serveServerAccessNeeds(ctx);
    }
  },
};

export const hackingModule: FeatureModule = {
  driver: hacking,
  reset: (state) => {
    resetHackingState();
    requestedProgram = undefined;
    requestedProgramValueSec = undefined;
    // The rollups this feature publishes. Cumulative totals live in the
    // dispatcher stats resetHackingState just cleared; dropping the last
    // rollups stops the UI showing the old node's earnings until the next
    // one lands. (The server snapshot is the fleet substrate's, not ours —
    // the controller rescans it.)
    delete state.topics.farm;
    delete state.topics.fleet;
  },
  claims: (ctx) => {
    const claims: Claim[] = [];
    const plan = serverAccessPlan(ctx);
    requestedProgram = plan?.writeProgram;
    requestedProgramValueSec = plan?.writeProgramValueSec;
    if (plan?.primary.action === "port-opener" && !plan.writeProgram) {
      const pending = plan.primary;
      const program = programForPortNeed(ctx.state, pending.server.numOpenPortsRequired ?? 0);
      if (program) {
        const purchaseCost = portOpenerPurchaseCost(ctx.state, pending.server.numOpenPortsRequired ?? 0);
        // A route-TERMINAL root need escalates the purchase above faction
        // reserve bands because the node cannot finish without that opener.
        const routeBlocking = terminalRootNeed(ctx.board, pending.host);
        claims.push(
          {
            by: "hacking",
            id: `port-opener:${program.name}`,
            resource: "money",
            amount: purchaseCost,
            priority: routeBlocking
              ? PRIORITY["hacking:critical-access"]
              : PRIORITY["hacking:blocking-prerequisite"],
            // This is a savings target as well as an eventual atomic spend.
            // While the full TOR + program price is not yet available, reserve
            // every dollar the higher-priority prerequisite wins. Otherwise an
            // indivisible denial leaves the pool untouched and the cheaper
            // infrastructure claim behind it repeatedly drains the bankroll
            // before BruteSSH can ever become affordable.
            mode: "reserve",
            shape: "continuous",
          },
        );
      }
    }
    const openerPlan = ctx.state.topics.fleet?.openerPlan ?? undefined;
    if (openerPlan && plan?.primary.action !== "port-opener") {
      const value = economicOpenerValue(ctx, openerPlan);
      claims.push(
        {
          by: "hacking",
          id: `opener-investment:${openerPlan.program}`,
          resource: "money",
          amount: openerPlan.cost,
          priority: PRIORITY["income:investment"],
          mode: "spend",
          shape: "step",
          pricing: "economic",
          value,
          ratePerSec: openerPlan.addedMoneyPerSec,
          returnPerDollarSec: openerPlan.addedMoneyPerSec / openerPlan.cost,
        },
      );
    }
    const investment = ramInvestment(ctx, ctx.now);
    if (investment) {
      const allocation = investment.valuePerDollar.state === "measured"
        ? {
            shape: "step" as const,
            pricing: "economic" as const,
            value: { state: "measured" as const, value: investment.valuePerDollar.value * investment.claimAmount },
          }
        : {
            // A spender with no BN-seconds conversion retains the pre-model
            // exact-rung behavior.
            //
            // Be precise about what "hard" costs, because the obvious reading
            // is wrong: `resolveClaims` runs every hard step in the band
            // through `resolveAtomicClaim` BEFORE the continuous water-fill and
            // before the economic-step auction, so this rung is not ranked
            // against `hacknet:upgrade` or a stock position by `compareClaims`
            // at all — it takes its cost off the top of `income:investment`.
            // That is a real divergence from spec/strategy/bitnodes/bn08.md,
            // which says the whole band is ordered by return per dollar per
            // second.
            //
            // Measured before changing it (bn1-speedrun seeds 1-3 and a BN8
            // stock+hacking config, `pricing: "hard"` vs `pricing: "economic"`
            // with the unknown value passed through): byte-identical runs, same
            // times, same record counts. The unpriced rung is granted either
            // way — the economic path's unpriceable fallback is just as
            // unconditional, only later in the band — so the divergence is
            // currently unobservable and reclassifying buys nothing. Left as
            // `hard` because it is the behavior the benchmarks were taken on;
            // revisit it together with the fallback's position relative to the
            // water-fill, which is what actually decides the contested case.
            shape: "step" as const,
            pricing: "hard" as const,
            value: { state: "measured" as const, value: Infinity },
          };
      claims.push(
        {
          by: "hacking",
          id: "infrastructure:ram",
          resource: "money",
          amount: investment.claimAmount,
          priority: PRIORITY["income:investment"],
          mode: "spend",
          // A RUNG IS INDIVISIBLE, even though its value is continuous.
          //
          // The supply curve prices every GB smoothly, but a partial grant
          // toward a server rung buys nothing. Valuation stays continuous and
          // ALLOCATION becomes a step: the
          // reserve accumulates until one exact rung is affordable, then buys
          // it. `pricing: "economic"` keeps it ranked against lambda rather
          // than jumping the hard-priority lattice.
          ...allocation,
          ratePerSec: investment.option.returnPerDollarSec * investment.claimAmount,
          returnPerDollarSec: investment.option.returnPerDollarSec,
        },
      );
    }
    return claims;
  },
  needs: (_ctx: NeedContext): Need[] => requestedProgram
    ? [{
        by: "hacking",
        kind: "file",
        subject: requestedProgram.name,
        target: 1,
        have: 0,
        weight: 8,
        // What the file is actually worth: the board's own value for every
        // server this opener unblocks (`ServerAccessPlan.writeProgramValueSec`).
        // `weight` stays for the urgency ordering the board does with it, but
        // `rankingValueSec` prefers a measured `valueSec`, so the nominal
        // 8 x 300 stops being consulted the moment we can price the unlock —
        // and career stops comparing an invented constant against a crime rate
        // priced from a measured marginal.
        ...(requestedProgramValueSec !== undefined && requestedProgramValueSec > 0
          ? { valueSec: requestedProgramValueSec }
          : {}),
        urgency: "blocking",
      }]
    : [],
};
