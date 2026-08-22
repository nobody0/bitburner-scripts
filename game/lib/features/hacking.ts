import type { NS } from "@ns";
import { effectiveBitNodeMultipliers } from "../../../shared/features/bitnode.ts";
import { skillFromExp } from "../../../shared/formulas.ts";
import { roundSigFigs } from "../../../shared/format.ts";
import { formatMoney } from "../../../shared/format.ts";
import { sfLevel } from "../../../shared/features/unlock.ts";
import { PRIORITY } from "../../../shared/strategy/arbiter.ts";
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
import { farmExperienceRate, farmIncomeRate } from "../../../shared/strategy/economics.ts";
import { installHorizonSec, nodeHorizonSec, usableForecastSec } from "../../../shared/strategy/progression/forecast.ts";
import { growingProgressSecondsPerRelativeRate, linearSecondsPerRelativeRate } from "../../../shared/strategy/progression/marginal.ts";
import type { MeasuredMarginal } from "../../../shared/strategy/progression/marginal.ts";
import { hackMarginalValue, hackRungValue, type HackMarginalInput } from "../../../shared/strategy/share.ts";
import type { FarmPipeline, FarmRollup } from "../../../shared/telemetry/topics/hacking.ts";
import {
  marginalCostPerGb,
  roundedRamPurchase,
  type RamSource,
  type RamSupplyQuote,
  type RamSupplyState,
} from "../../../shared/strategy/ram-supply.ts";
import { gameGlobal } from "../globals.ts";
import { bestReinvestmentReturnPerDollarSec, moneyRateValue } from "../income.ts";
import { buildView, drainCompletions, initDriver, pump, type DriverState } from "../dispatch-driver.ts";
import { merge, recordProbeFailure, set, type GameState } from "../state.ts";
import { takeTickLateness } from "../tick-health.ts";
import { signalWake } from "../wake.ts";
import { workerGlobals } from "../worker-shared.ts";
import { isScriptDeath } from "../errors.ts";
import { actionRamClaim, featureDodge } from "./dodge.ts";
import type { FeatureClaim } from "./claims.ts";
import type { ClaimContext, DriverContext, FeatureDriver, FeatureModule, NeedContext } from "./index.ts";

/** The hacking driver: one HWGW dispatcher pass per heartbeat or worker wake.
 *
 * All decisions live in shared/strategy; this only moves data. It runs at
 * TICK_MS as a fallback, while cancellable JIT deadline and completion wakes
 * service landing windows without waiting for another heartbeat. Every other feature is
 * slower by orders of magnitude, which is the whole reason the frame schedules
 * by cadence rather than running everything every pass. */

/** Module-level, not realm-level: the ledger is per-controller-instance by
 * design. A build handoff gives the incoming controller a fresh ledger while
 * its workers keep running, and liveness is recovered from the realm registry
 * (worker_info) rather than from this — see reapStrayScripts. */
let state: DriverState | undefined;

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
 * The realm registry is cleared here and NOWHERE else. Across a build handoff
 * it must survive — the incoming controller has a fresh ledger while the old
 * workers keep running, and that registry is the only proof they are alive. A
 * node reset is the opposite case: every script was killed, so every op id in
 * there is unreportable and every pending completion describes a game that no
 * longer exists. Left alone they would leak across every reset and make
 * reapStrayScripts treat dead ops as live. */
export function resetHackingState(): void {
  const globals = workerGlobals();
  globals.worker_info!.clear();
  globals.worker_jobs!.clear();
  globals.worker_wake!.clear();
  globals.worker_stop!.clear();
  globals.worker_stop_requested!.clear();
  globals.dispatch_done!.length = 0;
  globals.dispatch_wake = undefined;
  globals.dispatch_wake_pending = false;
  if (globals.dispatch_weaken_timer !== undefined) clearTimeout(globals.dispatch_weaken_timer);
  globals.dispatch_weaken_timer = undefined;
  if (globals.dispatch_jit_timer !== undefined) clearTimeout(globals.dispatch_jit_timer);
  globals.dispatch_jit_timer = undefined;
  globals.dispatch_jit_at = undefined;
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
  plannerPasses = 0;
  routeHackingSkillGoal = undefined;
  latestShareValue = undefined;
  switched = undefined;
  backdoorBackoff.clear();
  backdoorInFlight = false;
  lastServerAccessAt = 0;
  infrastructureInFlight = false;
  lastInfrastructureResult = undefined;
}

/** Peak pump duration since the last rollup, reported so a dispatcher pass
 * that starts eating the tick budget is visible before it starts missing
 * slots. */
let pumpMaxMs = 0;
/** The same cost as a SHARE of wall time, which is the reading peak duration
 * cannot give: a live run held `pumpMaxMs` at a plausible ~92 ms while running
 * ~11 pumps a second, i.e. the planner owned the whole thread and nothing in
 * the panel said so. Summed here, divided at the drain. */
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
/** Monotonic count of pumps that actually ran a `planFarm`. `dispatch.pooling`
 * is recomputed exactly once per pump, so this identifies the pass a pooling
 * reading belongs to — letting the broker ignore the several arena builds that
 * sample one unchanged value within a tick. Starts at 1 after the first pump;
 * 0 means no pass has run yet. */
let plannerPasses = 0;
/** Latest open hacking-skill outcome from the needs board. Wake-driven pumps
 * run outside a feature context, so they reuse the last scheduled tick's
 * pure-board decision. */
let routeHackingSkillGoal: number | undefined;
type ShareValue = NonNullable<Parameters<typeof pump>[4]>["shareValue"];
let latestShareValue: ShareValue | undefined;

function shareValue(game: GameState, caps: DriverContext["caps"]): ShareValue | undefined {
  // Share buys faction-rep rate, and every point of faction rep (and the
  // favor it becomes) is erased when the node ends by destroy. Near that
  // ending the surplus RAM's alternative uses (farm ops, dodges, Go) are the
  // only ones that still exist — measured failure: 99.9% of a 9.13PB fleet
  // soaked into share for an objective nobody was even working, starving the
  // exp climb that WAS the node's critical path.
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
  // present, not a forecast — the work planners keep pricing rep with the
  // MEASURED live sharePower, and seeing it rise once share runs is exactly
  // how "rep is cheap right now" reaches them.
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
function scheduleJitWake(at: number | undefined): void {
  const globals = workerGlobals();
  if (at === undefined) {
    if (globals.dispatch_jit_timer !== undefined) clearTimeout(globals.dispatch_jit_timer);
    globals.dispatch_jit_timer = undefined;
    globals.dispatch_jit_at = undefined;
    return;
  }
  if (globals.dispatch_jit_timer !== undefined && (globals.dispatch_jit_at ?? Infinity) <= at + 1) return;
  if (globals.dispatch_jit_timer !== undefined) clearTimeout(globals.dispatch_jit_timer);
  globals.dispatch_jit_at = at;
  globals.dispatch_jit_timer = setTimeout(() => {
    globals.dispatch_jit_timer = undefined;
    globals.dispatch_jit_at = undefined;
    signalWake(globals);
  }, Math.max(0, at - performance.now()));
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
  if (stats.landingOrderBatches === 0 || stats.landingOrderPlanned === undefined) return undefined;
  const ranked = [...stats.landingOrder.entries()].sort(([, a], [, b]) => b - a);
  const published = ranked.slice(0, LANDING_SIGNATURES_PUBLISHED);
  const other = ranked.slice(LANDING_SIGNATURES_PUBLISHED).reduce((sum, [, count]) => sum + count, 0);
  return {
    planned: stats.landingOrderPlanned,
    batches: stats.landingOrderBatches,
    ...(stats.landingOrderIncomplete > 0 ? { incomplete: stats.landingOrderIncomplete } : {}),
    observed: Object.fromEntries(published),
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
    const solution = farm.solution;
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
    batches: Object.fromEntries(
      BATCH_KINDS.filter((kind) => stats.batchesByKind[kind].batches > 0)
        .map((kind) => [kind, stats.batchesByKind[kind]]),
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
      pendingBatches: driver.memory.dispatch.jitPending.length,
      pendingOps: driver.memory.dispatch.jitPending.reduce((sum, batch) => sum + batch.ops.length, 0),
      onTarget: driver.memory.dispatch.byTarget.get(target)?.size ?? 0,
    },
    totals: { moneyEarned: stats.moneyEarned, hacks: stats.hacks },
  });
}

/** Per-host retry backoff for failed backdoor attempts. The predecessor was a
 * permanent one-attempt latch, and a transient failure (a connect chain broken
 * by a concurrent terminal user, a stub killed mid-flight) silently cost the
 * whole faction join for the rest of the BitNode. Exponential 30s -> 10min:
 * cheap enough to recover from a transient, slow enough that a structurally
 * impossible host does not relaunch a stub every pass. Cleared on reset. */
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
/** ns functions each dodged closure calls. PRICED at runtime rather than
 * guessed: a constant budget has to be at least the sum of the call costs, and
 * getting that wrong kills the stub outright (see dodge.ts#priceCalls). */
const BACKDOOR_CALLS = ["scan", "singularity.connect", "singularity.installBackdoor"] as const;
const PORT_OPENER_CALLS = ["ls", "singularity.purchaseTor", "singularity.purchaseProgram"] as const;
let backdoorInFlight = false;
let lastServerAccessAt = 0;
let requestedProgram: ProgramOption | undefined;
/** BN-seconds the requested write is worth — see `ServerAccessPlan`. Carried
 * beside the program because `needs()` posts the need and only the access plan
 * knows what the file unlocks. */
let requestedProgramValueSec: number | undefined;
const HOME_RAM_METHODS = ["singularity.upgradeHomeRam"] as const;
const HOME_CORE_METHODS = ["singularity.upgradeHomeCores"] as const;
const CLOUD_BUY_METHODS = ["cloud.purchaseServer"] as const;
const CLOUD_UPGRADE_METHODS = ["cloud.upgradeServer"] as const;
let infrastructureInFlight = false;
let lastInfrastructureResult: { action: string; ok: boolean; detail: string; at: number } | undefined;

/** The farm solution's $/GB/sec with the stock-manipulation term removed —
 * what a MONEY purchase may be priced from.
 *
 * `score` blends hacked income with `stockIncome`, the dollar value of the
 * ops' price manipulation on the market's HELD positions. For RAM allocation
 * that blend is correct: allocating RAM consumes no capital. For a purchase it
 * is a double-count — the manipulation income exists only while the bankroll
 * is deployed as positions, so a server bought WITH that bankroll destroys the
 * very income that justified it. Measured before this split (bn8-manipulation
 * seed 1): the market grew $250m to ~$390m and a manipulation-priced $318m
 * home-RAM rung then took all of it, twice in one two-hour run. The market's
 * own reserve claim already bids the return on that capital; counting it again
 * here bids the same dollars twice.
 *
 * Both per-batch terms share `score`'s denominator, so the capital-independent
 * share is the income fraction of the blend. */
function capitalIndependentScore(solution: { score: number; incomePerBatch: number; stockIncomePerBatch: number }): number {
  const money = Math.max(0, solution.incomePerBatch);
  const stock = Math.max(0, solution.stockIncomePerBatch);
  const total = money + stock;
  return total > 0 ? Math.max(0, solution.score) * (money / total) : Math.max(0, solution.score);
}

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
  // directive is momentarily absent (controller handoff, evaluator reset)
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

function productiveRamMarginal(ctx: RamInvestmentContext): MeasuredMarginal {
  const inputs = productiveRamInputs(ctx);
  return inputs ? hackMarginalValue(inputs) : MARGINALS_UNPUBLISHED;
}

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
 * worthlessness, not an absence of one. The unmeasured `hard`/Infinity claim
 * used to fire anyway and, in a node whose farm pays nothing, converted the
 * entire bankroll into servers that could never repay it — starving the one
 * feature (the market) that could have measured a positive return with the
 * same dollars. When the market later holds a manipulable position, the farm
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
    // size has identical $/GB and the cheapest-per-GB tiebreak always returns
    // the biggest rung — 64 GB at $3.3m. During bootstrap that is unaffordable
    // forever: nothing is bought, so income never grows, so it stays
    // unaffordable. That is the same self-reinforcing deadlock
    // `capInfrastructureByObservedFleet` caused earlier in this workstream.
    // Measured on bn1-speedrun seed 1: 4 servers bought all run, fleet 348 GB
    // against 9,052 GB working, and total earnings $15.3m against $1b.
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
    // asks for a number nothing will ever spend: the water-filled grant is a
    // per-pass slice of the pool, it does not accumulate, and execution then
    // attempts a rung the slice never covers. Measured on bn1-speedrun seed 1:
    // only 40 purchases were ever ATTEMPTED across the whole run (4 succeeded,
    // 36 failed "insufficient money"), the fleet crawled to 348 GB against
    // 9,052 GB working, and $1b was never reached.
    //
    // Aligning claim == grant == execution on the rung cost is what lets the
    // reserve accumulate to something buyable. The curve still decides WHETHER
    // the rung is worth its price; this only fixes HOW MUCH is asked for.
    return [{ source, supply, option, claimAmount: supply.cost, valuePerDollar }];
  }));
  }
  return candidates.filter(isEvidencedInvestment).sort((a, b) =>
    investmentRank(b) - investmentRank(a)
    || (a.supply?.costPerGb ?? Infinity) - (b.supply?.costPerGb ?? Infinity)
    || (b.supply?.addedRam ?? 0) - (a.supply?.addedRam ?? 0)
  )[0];
}

// No `valueCurve` here on purpose. `infrastructure:ram` is emitted as an
// indivisible `shape: "step"` claim (see the note on its allocation below), and
// the controller only asks for a value curve for CONTINUOUS claims — so a
// curve keyed on that id could never be reached. The rung's economics travel
// on the step's own `value` instead.

function infrastructureMethods(kind: ScoredInfrastructure["kind"]): readonly string[] {
  if (kind === "homeRam") return HOME_RAM_METHODS;
  if (kind === "homeCore") return HOME_CORE_METHODS;
  if (kind === "buyServer") return CLOUD_BUY_METHODS;
  return CLOUD_UPGRADE_METHODS;
}

function infrastructureClaimId(kind: ScoredInfrastructure["kind"]): string {
  return `action:infrastructure:${kind}`;
}

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
    const outcome = await featureDodge(
      ctx,
      "hacking",
      infrastructureClaimId(decision.kind),
      infrastructureMethods(decision.kind),
      (stubNs: NS) => {
        if (decision.kind === "homeRam") {
          let bought = 0;
          for (; bought < steps; bought++) {
            if (!stubNs["singularity"]["upgradeHomeRam"]()) break;
          }
          return bought;
        }
        if (decision.kind === "homeCore") return stubNs["singularity"]["upgradeHomeCores"]();
        if (decision.kind === "buyServer") {
          return stubNs["cloud"]["purchaseServer"]("pserv", decision.targetRam!) !== "";
        }
        return stubNs["cloud"]["upgradeServer"](decision.host!, decision.targetRam!);
      },
    );
    const ok = outcome.ok && (
      decision.kind === "homeRam" ? outcome.value === steps : Boolean(outcome.value)
    );
    lastInfrastructureResult = {
      action: decision.kind,
      ok,
      detail: ok
        ? "bought " + steps + " " + decision.kind + " rung(s) for " + formatMoney(grantedCost)
        : outcome.ok ? "purchase refused" : outcome.reason,
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
    const outcome = await featureDodge(ctx, "hacking", "action:backdoor", BACKDOOR_CALLS, async (stubNs: NS) => {
      const parents = new Map<string, string | undefined>([["home", undefined]]);
      const queue = ["home"];
      for (let index = 0; index < queue.length && !parents.has(host); index++) {
        const current = queue[index]!;
        for (const neighbour of stubNs.scan(current)) {
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
      if (!stubNs["singularity"]["connect"]("home" as never)) {
        throw new Error("could not return terminal connection to home");
      }
      for (const hop of route.reverse()) {
        if (!stubNs["singularity"]["connect"](hop as never)) {
          throw new Error(`network route to ${host} failed at ${hop}`);
        }
      }
      await stubNs["singularity"]["installBackdoor"]();
    });
    if (outcome.ok) {
      backdoorBackoff.delete(host);
      server.backdoorInstalled = true;
    } else if (!outcome.queued) {
      // The stub launched and failed (broken connect chain, thrown install).
      // Backed off per host so it does not relaunch every pass — and REPORTED
      // through the probe-failure channel: a silent latch here cost a whole
      // join (the error was invisible for two hours of run). A QUEUED dodge is
      // not an attempt: the broker will admit it when RAM frees up.
      recordBackdoorFailure(host, now);
      recordProbeFailure(ctx.state, `backdoor:${host}`, new Error(outcome.reason));
    }
  } catch (error) {
    if (isScriptDeath(error)) throw error;
    recordBackdoorFailure(host, now);
    recordProbeFailure(ctx.state, `backdoor:${host}`, error);
  } finally {
    backdoorInFlight = false;
  }
}

/** RAM priority for the pending backdoor dodge. Baseline probe:detail; the
 * `hacking:critical-access` band (111, above the broker's farm-preemption
 * threshold) is granted only when BOTH hold:
 *  - some poster marked the need BLOCKING (it is the last thing between a
 *    faction and an invite), and
 *  - the need's MEASURED value rate (BN-seconds saved per second of install)
 *    strictly beats the farm value of the RAM the dodge would displace.
 * Unmeasured value never escalates: evicting a worker desyncs a real batch,
 * and a fallback-ranked guess is not evidence that trade is right. */
function backdoorClaimPriority(ctx: ClaimContext, pending: ServerAccessAction): number {
  const base = PRIORITY["probe:detail"];
  const blocking = ctx.board.open.some(
    (need) => need.kind === "backdoor" && need.subject === pending.host && need.urgency === "blocking",
  );
  if (!blocking) return base;
  const valueSec = needValueSeconds(ctx.board, ["backdoor"])[`backdoor:${pending.host}`];
  if (valueSec === undefined) return base;
  const costSec = Math.max(1, backdoorActionSec(ctx.state, pending.server));
  const displaced = productiveRamMarginal(ctx);
  if (displaced.state !== "measured") return base;
  const displacedRate = displaced.value * ctx.ramPrice(BACKDOOR_CALLS);
  return valueSec / costSec > displacedRate ? PRIORITY["hacking:critical-access"] : base;
}

export type ServerAccessAction = {
  action: "backdoor" | "port-opener";
  host: string;
  server: NonNullable<GameState["topics"]["servers"]>[string];
};

/** Dear openers only buy for targets within this many multiples of current
 * skill: near enough that the blocking-priority spend is actually imminent.
 * Cheap openers stay unbounded — buying BruteSSH the moment CSEC's need
 * exists is what keeps the window open before the bankroll is spent on
 * fleet (measured: gating it cost factions-join ~5%). */
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

export function serverAccessPlan(
  ctx: Pick<ClaimContext, "board" | "state" | "activeFeatures"> & Partial<Pick<ClaimContext, "horizons">>,
): ServerAccessPlan | undefined {
  const candidates = rankServerAccessCandidates(ctx);
  const primary = candidates[0]?.entry;
  if (!primary) return undefined;
  if (primary.action !== "port-opener") return { primary };
  const program = programForPortNeed(ctx.state, primary.server.numOpenPortsRequired ?? 0);
  if (!program || !writeInsteadOfBuy(ctx, program)) return { primary };
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

/** Conservative atomic budget: TOR is included even when it may already be
 * owned because the ordinary player snapshot does not expose that fact. */
function portOpenerPurchaseCost(game: GameState, portsRequired: number): number {
  return 200_000 + programsForPortNeed(game, portsRequired)
    .reduce((total, program) => total + program.purchaseCost, 0);
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
    (game.topics.fleet?.portOpeners ?? 0) > 0,
    moneyValueSecPerDollar(game),
  );
}

/** What the player-work slot would do over a `writeSec` window if it were not
 * writing this program — the write's real opportunity cost.
 *
 * READ FROM THE AUCTION, not from career's own menu. The predecessor priced the
 * write against `career.plan.ranked[0]`, so the only alternatives it could see
 * were career's: reputation work — the thing that actually loses twenty minutes
 * to a write — was invisible, and so was any other feature bidding for the same
 * slot. `arbitration.slotValues` is every bid and what it is worth, which is
 * exactly the question being asked here.
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
 * Deliberately narrow: this runs ONLY to unblock a posted root/backdoor need, so
 * the fleet does not spend money on crackers nothing has asked for. */
async function buyPortOpener(ctx: DriverContext, portsRequired: number): Promise<boolean> {
  if (portsRequired === 0) return false;
  const program = programForPortNeed(ctx.state, portsRequired);
  const requiredGrant = portOpenerPurchaseCost(ctx.state, portsRequired);
  // Never let an imperative purchase bypass the shared money policy.
  if (!program || moneyGrantFor(ctx, `port-opener:${program.name}`) < requiredGrant) return false;
  try {
    const outcome = await featureDodge(
      ctx,
      "hacking",
      "action:port-opener",
      PORT_OPENER_CALLS,
      (stubNs: NS) => {
        const files = new Set(stubNs["ls"]("home", ".exe"));
        const owned = PORT_OPENERS.filter((program) => files.has(program));
        const missing = PORT_OPENERS.filter((program) => !files.has(program));
        if (owned.length >= portsRequired || missing.length === 0) return owned.length;
        // TOR first; it is a precondition and idempotent.
        // Source: https://github.com/bitburner-official/bitburner-src/blob/3162fd2590e221eadd0c0fbd46151913f7c4c41c/src/NetscriptFunctions/Singularity.ts#L401-L442
        if (!stubNs["singularity"]["purchaseTor"]()) return owned.length;
        let acquired = owned.length;
        for (const program of missing.slice(0, portsRequired - owned.length)) {
          if (!stubNs["singularity"]["purchaseProgram"](program as never)) break;
          acquired++;
        }
        return acquired;
      },
    );
    if (!outcome.ok) return false;
    const before = ctx.state.topics.fleet?.portOpeners ?? 0;
    if (outcome.value > before) merge(ctx.state, "fleet", { portOpeners: outcome.value });
    return outcome.value > before;
  } catch (error) {
    if (isScriptDeath(error)) throw error;
    // No singularity access — the crackers must come from elsewhere.
    return false;
  }
}

/** One dispatcher pump: build the view, drain completions, plan, launch, and
 * track the target switch. Shared by the scheduled tick and the wake pass —
 * the wake pass IS a pump, just triggered by a landing instead of the clock. */
function runPump(
  ns: NS,
  game: GameState,
  caps: DriverContext["caps"],
  arenaReserves: Readonly<Record<string, number>>,
  installSec: number | undefined,
  sharePricing: ShareValue | undefined,
): ReturnType<typeof pump> | undefined {
  const servers = game.topics.servers;
  const player = game.topics.player;
  if (!servers || !player || Object.keys(servers).length === 0) return undefined;

  const driver = hackingState();

  // Only the farm and prep targets get live reads; everything else comes
  // from the sweep snapshot.
  const active = driver.memory.dispatch.evaluator.directive;
  const hot = [active.farm?.host, active.prep?.host].filter((h): h is string => Boolean(h));
  // The stock feature's manipulation intent rides along: hack pushes a
  // symbol's forecast down and grow pushes it up, so in a node where the
  // market matters the farm's best target is not the richest server but the
  // one whose price movement is worth the most. See spec/targeting.md.
  // Source: https://github.com/bitburner-official/bitburner-src/blob/3162fd2590e221eadd0c0fbd46151913f7c4c41c/src/StockMarket/PlayerInfluencing.ts#L17-L60
  const view = buildView(
    ns,
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
  const completions = drainCompletions(driver);
  const reinvestmentReturnPerDollarSec = bestReinvestmentReturnPerDollarSec(game);

  const started = performance.now();
  // pooling: farm batch ops ride pooled serve workers (worker.ts serve mode),
  // collapsing exec churn — the browser-side cost of a fresh WorkerScript per
  // op — to near zero at depth.
  const result = pump(ns, driver, view, completions, {
    arenaReserves,
    pooling: true,
    ...(installSec !== undefined ? { horizonMs: installSec * 1_000 } : {}),
    ...(reinvestmentReturnPerDollarSec > 0 ? { reinvestmentReturnPerDollarSec } : {}),
    ...(routeHackingSkillGoal !== undefined ? { hackingSkillGoal: routeHackingSkillGoal } : {}),
    ...(sharePricing ? { shareValue: sharePricing } : {}),
  });
  scheduleJitWake(result.nextWakeMs === undefined ? undefined : view.time + result.nextWakeMs);
  const elapsed = performance.now() - started;
  if (elapsed > pumpMaxMs) pumpMaxMs = elapsed;
  if (pumpWindowAt === 0) pumpWindowAt = started;
  pumpMsSum += elapsed;
  pumpCount++;
  lastPumpAt = performance.now();
  plannerPasses++;

  const target = result.directive.farm?.host ?? "";
  const current = gameGlobal.farmTarget ?? "";
  if (target !== current) {
    switched = { from: current, to: target };
    gameGlobal.farmTarget = target;
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
/** Which planner pass the current `dispatch.pooling` value came from. Paired
 * with `RamBroker.observePooling` so a value sampled several times inside one
 * tick counts once. */
export function plannerPassId(): number {
  return plannerPasses;
}

export function pumpOnWake(
  ns: NS,
  game: GameState,
  caps: DriverContext["caps"],
  arenaReserves: Readonly<Record<string, number>>,
  installSec: number | undefined,
): void {
  const now = performance.now();
  // Ordinary completions are throughput hints and may be coalesced. A queued
  // weaken is different: after a spread weaken's trailing debounce, this is
  // the only guaranteed observation point at minimum security. Never discard
  // that launch window merely because another op woke us a few ms earlier.
  const weakenWindow = hackingState().globals.dispatch_done?.some((done) => done.kind === "weaken") ?? false;
  if (!weakenWindow && now - lastPumpAt < WAKE_MIN_MS) {
    wakeSkipGap++;
    return;
  }
  if (!weakenWindow && wakesThisFrame >= WAKE_MAX_PER_FRAME) {
    wakeSkipFrame++;
    return;
  }
  if (weakenWindow) weakenWindowPumps++;
  wakesThisFrame++;
  wakePumps++;
  runPump(ns, game, caps, arenaReserves, installSec, latestShareValue);
}

export const hacking: FeatureDriver = {
  id: "hacking",
  everyMs: 200,
  async tick(ctx: DriverContext) {
    const { ns, state: game } = ctx;
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

    // The reserve is computed per pass, not constant: it grows to cover the
    // largest dodge step any unlocked feature declares, so an expensive
    // singularity probe stays affordable instead of being crowded out by the
    // dispatcher taking every free gigabyte.
    //
    // The horizon is the endgame route's expected remaining run time: a
    // target that would only pay off after the run is expected to end is not
    // worth prepping, however good its steady-state rate. The game has no
    // money GOAL (that is the sim's device), so the run horizon is the only
    // finite bound the evaluator gets here. Converted to ms at this boundary:
    // everything below planFarm is ms-native.
    const installSec = usableForecastSec(ctx.horizons.install);
    latestShareValue = shareValue(game, ctx.caps);
    const result = runPump(ns, game, ctx.caps, ctx.arena.reserves, installSec, latestShareValue);
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

    // Fire-and-forget for the same reason as the backdoors below: the
    // purchase dodge serializes on the global dodge mutex, and the dispatcher
    // must not await a multi-second dodge on its 200 ms cadence.
    // `infrastructureInFlight` keeps it single-flight.
    const investment = ramInvestment(ctx);
    // Only attempt a rung the grant actually covers.
    //
    // The claim is CONTINUOUS — it asks for `valuableGb * costPerGb`, the
    // whole value of the headroom — while execution buys ONE indivisible rung
    // at `option.cost`. Those are different numbers, and the water-filled
    // grant is bounded by the pool, so acting on the claim without checking
    // the grant means attempting a purchase nobody authorised. The old
    // `stepInfrastructure(options, horizon, availableMoney)` filtered on
    // affordability; that filter was lost when the supply curve replaced it.
    //
    // Measured on bn1-speedrun seed 1: EVERY buy decision had granted < cost
    // (4,615 of 4,615), producing 28,859 "purchase refused" results against
    // 46 successes. The fleet crawled 92 -> 284 GB where the working run
    // reached 9,052 GB, and the run never reached $100m.
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

    // Serve the board LAST, so a backdoor's dodge can never delay a
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
    const claims: FeatureClaim[] = [];
    const plan = serverAccessPlan(ctx);
    requestedProgram = plan?.writeProgram;
    requestedProgramValueSec = plan?.writeProgramValueSec;
    // The concurrent backdoor needs its RAM claim too, or falling through to
    // it in the driver would only ever find the dodge unfunded.
    const backdoorTarget = plan?.primary.action === "backdoor" ? plan.primary : plan?.concurrentBackdoor;
    if (backdoorTarget) {
      claims.push(actionRamClaim(
        ctx,
        "hacking",
        "action:backdoor",
        BACKDOOR_CALLS,
        backdoorClaimPriority(ctx, backdoorTarget),
      ));
    }
    if (plan?.primary.action === "port-opener" && !plan.writeProgram) {
      const pending = plan.primary;
      const program = programForPortNeed(ctx.state, pending.server.numOpenPortsRequired ?? 0);
      if (program) {
        const purchaseCost = portOpenerPurchaseCost(ctx.state, pending.server.numOpenPortsRequired ?? 0);
        claims.push(
          actionRamClaim(ctx, "hacking", "action:port-opener", PORT_OPENER_CALLS),
          {
            by: "hacking",
            id: `port-opener:${program.name}`,
            resource: "money",
            amount: purchaseCost,
            priority: PRIORITY["hacking:blocking-prerequisite"],
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
    const investment = ramInvestment(ctx, ctx.now);
    if (investment) {
      const claimId = infrastructureClaimId(investment.option.kind);
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
        actionRamClaim(
          ctx,
          "hacking",
          claimId,
          infrastructureMethods(investment.option.kind),
        ),
        {
          by: "hacking",
          id: "infrastructure:ram",
          resource: "money",
          amount: investment.claimAmount,
          priority: PRIORITY["income:investment"],
          mode: "spend",
          // A RUNG IS INDIVISIBLE, even though its value is continuous.
          //
          // The supply curve prices every GB smoothly, which made
          // `shape: "continuous"` look right — but a continuous claim accepts
          // PARTIAL grants, and a partial grant toward a $3.5m server buys
          // nothing. Measured on bn1-speedrun seed 1 while continuous: the
          // grant covered the rung cost in 1% of decisions (38 of 4,469), only
          // 471 purchases were attempted all run, and the fleet reached 348 GB
          // against 9,052 GB working.
          //
          // So valuation stays continuous and ALLOCATION becomes a step: the
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
