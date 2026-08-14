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
import { solveCycle } from "../../../shared/strategy/targeting.ts";
import { currentShareBonus } from "../../../shared/strategy/dispatch.ts";
import { PORT_OPENER_PROGRAMS, preferProgramCreation, type ProgramOption } from "../../../shared/strategy/career/programs.ts";
import type { Need } from "../../../shared/strategy/needs.ts";
import {
  passiveRepPerSec,
  passiveRepPerSecPerShareBonus,
  workRepPerSec,
  workRepPerSecPerShareBonus,
  type RepContext,
  type WorkType,
} from "../../../shared/strategy/factions/rep.ts";
import { DEFAULT_PLANNING_HORIZON_SEC, installHorizonSec, usableForecastSec, type PlanningHorizons } from "../../../shared/strategy/progression/forecast.ts";
import { growingProgressSecondsPerRelativeRate, linearSecondsPerRelativeRate } from "../../../shared/strategy/progression/marginal.ts";
import type { MeasuredMarginal } from "../../../shared/strategy/progression/marginal.ts";
import { hackMarginalValue } from "../../../shared/strategy/share.ts";
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
  backdoorAttempted.clear();
  backdoorInFlight = false;
  lastServerAccessAt = 0;
  infrastructureInFlight = false;
  lastInfrastructureResult = undefined;
}

/** Peak pump duration since the last rollup, reported so a dispatcher pass
 * that starts eating the tick budget is visible before it starts missing
 * slots. */
let pumpMaxMs = 0;
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
  const marginals = game.topics.progression?.plan?.marginals;
  if (!marginals) return undefined;
  const player = game.topics.player;
  const intent = game.topics.factions?.plan?.objective?.intent;
  const standing = intent ? game.topics.factions?.standings?.find((entry) => entry.name === intent.faction) : undefined;
  const bonus = game.topics.fleet?.sharePower ?? 1;
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
    const work = game.topics.career?.currentWork;
    const activeType = work?.type === "FACTION" && work.detail === intent.faction
      && (work.workType === "hacking" || work.workType === "field" || work.workType === "security")
      ? work.workType as WorkType
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
    if (rate > 0 && intent.purpose === "augmentations") {
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

export function takePumpMaxMs(): number {
  const value = pumpMaxMs;
  pumpMaxMs = 0;
  return value;
}

/** Whether the farm target changed on the last tick, for the controller's
 * transition event. Cleared by reading it. */
let switched: { from: string; to: string } | undefined;

export function takeTargetSwitch(): { from: string; to: string } | undefined {
  const value = switched;
  switched = undefined;
  return value;
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
  const poolWorkers = [...driver.memory.dispatch.pool.workers.values()];
  const segmentGb = driver.memory.dispatch.segmentGb;
  const prepBudgetGb = driver.memory.dispatch.evaluator.directive.segments.find((segment) => segment.kind === "prep")?.gb ?? 0;
  const share = driver.memory.dispatch.evaluator.directive.share;

  set(game, "farm", {
    target,
    ...(targetSolveExact !== undefined ? { targetSolveExact } : {}),
    ...(driver.memory.dispatch.evaluator.directive.farm?.solution.score !== undefined
      ? { moneyPerSecPerGb: driver.memory.dispatch.evaluator.directive.farm.solution.score }
      : {}),
    ...(prepTarget !== undefined ? { prepTarget } : {}),
    prepBudgetGb,
    ...(segOrder !== undefined ? { segOrder } : {}),
    mode: driver.memory.dispatch.mode,
    inFlight: { ...driver.memory.dispatch.inFlight },
    launched: { ...stats.launched },
    landed: { ...stats.landed },
    moneyRate: moneyRateEma,
    expRate: expRateEma,
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
    ...(poolWorkers.length > 0
      ? { pool: { workers: poolWorkers.length, busy: poolWorkers.filter((worker) => worker.busy).length } }
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
    } } : {}),
    execFails: driver.execFails,
    batchesSkipped: stats.batchesSkipped,
    missedWindow: {
      deadline: roundSigFigs(stats.missedWindow.deadline, 3),
      "arrival-security": roundSigFigs(stats.missedWindow["arrival-security"], 3),
      "arrival-money": roundSigFigs(stats.missedWindow["arrival-money"], 3),
      placement: roundSigFigs(stats.missedWindow.placement, 3),
    },
    ramWork: {
      nativeGbMs: stats.nativeRamMs,
      paddingGbMs: stats.paddingRamMs,
      nativeGbMsByKind: stats.nativeRamMsByKind,
      paddingGbMsByKind: stats.paddingRamMsByKind,
      nativeGbMsBySegment: stats.nativeRamMsBySegment,
      paddingGbMsBySegment: stats.paddingRamMsBySegment,
    },
    pumpMaxMs: takePumpMaxMs(),
    wakePumps,
    totals: { moneyEarned: stats.moneyEarned, hacks: stats.hacks },
  });
}

/** Hosts we have already backdoored (or tried and failed), so a need that
 * cannot be satisfied does not relaunch a stub every pass. Cleared on reset. */
const backdoorAttempted = new Set<string>();
/** ns functions each dodged closure calls. PRICED at runtime rather than
 * guessed: a constant budget has to be at least the sum of the call costs, and
 * getting that wrong kills the stub outright (see dodge.ts#priceCalls). */
const BACKDOOR_CALLS = ["scan", "singularity.connect", "singularity.installBackdoor"] as const;
const PORT_OPENER_CALLS = ["ls", "singularity.purchaseTor", "singularity.purchaseProgram"] as const;
let backdoorInFlight = false;
let lastServerAccessAt = 0;
let requestedProgram: ProgramOption | undefined;
const HOME_RAM_METHODS = ["singularity.upgradeHomeRam"] as const;
const HOME_CORE_METHODS = ["singularity.upgradeHomeCores"] as const;
const CLOUD_BUY_METHODS = ["cloud.purchaseServer"] as const;
const CLOUD_UPGRADE_METHODS = ["cloud.upgradeServer"] as const;
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
  const before = solveCycle(hackCtx, statics, home.cores, caps)?.score ?? 0;
  const after = solveCycle(hackCtx, statics, home.cores + 1, caps)?.score ?? 0;
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
  const solvedPerGb = hackingState().memory.dispatch.evaluator.directive.farm?.solution.score;
  const observedPerGb = solvedPerGb ?? ctx.state.topics.farm?.moneyPerSecPerGb;
  if (observedPerGb === undefined) return undefined;
  const perGb = Math.max(0, observedPerGb);
  const depthCap = ctx.state.topics.farm?.depthCapGb;
  const fleetGb = Math.max(
    0,
    (fleet.maxRam ?? 0) - (ctx.state.topics.progression?.ramArena?.arenaGb ?? 0) + Math.max(0, priorAddedRam),
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

function productiveRamMarginal(ctx: RamInvestmentContext): MeasuredMarginal {
  const marginals = ctx.state.topics.progression?.plan?.marginals;
  if (!marginals) return { state: "unknown", reason: "progression RAM marginals have not been published" };
  const solution = hackingState().memory.dispatch.evaluator.directive.farm?.solution;
  const scriptIncome = ctx.state.topics.fleet?.scriptIncome?.[0];
  const scriptExp = ctx.state.topics.fleet?.scriptExpGain;
  // The point-in-time script getter can be zero between batch workers. The
  // hacking rollup's EMA is measured over landed work and remains meaningful
  // across that gap, so prefer either positive observation over a transient 0.
  const totalMoneyPerSec = Math.max(scriptIncome ?? 0, ctx.state.topics.farm?.moneyRate ?? 0);
  const totalHackingExpPerSec = Math.max(scriptExp ?? 0, ctx.state.topics.farm?.expRate ?? 0);
  return hackMarginalValue({
    moneySecondsPerRelativeRate: marginals.money.secondsPerRelativeRate,
    hackingSecondsPerRelativeRate: marginals.hacking.secondsPerRelativeRate,
    ...(scriptIncome !== undefined || ctx.state.topics.farm?.moneyRate !== undefined ? { totalMoneyPerSec } : {}),
    ...(scriptExp !== undefined || ctx.state.topics.farm?.expRate !== undefined ? { totalHackingExpPerSec } : {}),
    moneyPerSecPerGb: solution?.score ?? 0,
    hackingExpPerSecPerGb: solution?.experienceScore ?? 0,
  });
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

/** Select one continuous supply segment. Nominal dollars/GB comes from the
 * closed-form supply model; survival enters only through the existing node
 * (home) and install (cloud) horizons. No source preference is encoded. */
function ramInvestment(ctx: RamInvestmentContext, now = Date.now()): RamInvestment | undefined {
  const fleet = ctx.state.topics.fleet;
  if (!fleet) return undefined;

  const nodeHorizon = usableForecastSec(ctx.horizons.node) ?? DEFAULT_PLANNING_HORIZON_SEC;
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

  const marginal = productiveRamMarginal(ctx);
  const fleetGb = Math.max(
    0,
    (fleet.maxRam ?? 0) - (ctx.state.topics.progression?.ramArena?.arenaGb ?? 0),
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
    const valuePerDollar: MeasuredMarginal = marginal.state === "measured"
      ? { state: "measured", value: marginal.value * lifetimeFraction / supply.costPerGb }
      : marginal;
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
  return candidates.sort((a, b) =>
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
 * Deliberately conservative — one backdoor attempt per host and all access
 * actions throttled: a backdoor takes hackingTime/4 and would otherwise be
 * reconsidered on every 200 ms tick.
 * Source: https://github.com/bitburner-official/bitburner-src/blob/3162fd2590e221eadd0c0fbd46151913f7c4c41c/src/NetscriptFunctions/Singularity.ts#L518-L533 */
async function serveServerAccessNeeds(ctx: DriverContext): Promise<void> {
  const now = Date.now();
  if (now - lastServerAccessAt < 10_000) return;

  const pending = nextServerAccessAction(ctx);
  if (!pending) return;
  const { host, server, action } = pending;

  // Not rooted yet: the blocker is usually a missing port opener, and
  // nothing else in the loop will ever buy one. Rooting servers is
  // hacking's job, so acquiring the means to root them is too. This is
  // load-bearing rather than incidental — CSEC needs one open port, so
  // without a cracker the entire faction ladder is unreachable.
  if (action === "port-opener") {
    const program = programForPortNeed(ctx.state, server.numOpenPortsRequired ?? 0);
    requestedProgram = program && ctx.activeFeatures.has("career") && shouldWriteProgram(ctx.state, program)
      ? program
      : undefined;
    if (requestedProgram) return;
    if (await buyPortOpener(ctx, server.numOpenPortsRequired ?? 0)) lastServerAccessAt = now;
    return;
  }

  if (backdoorInFlight) return;
  backdoorInFlight = true;
  lastServerAccessAt = now;
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
      backdoorAttempted.add(host);
      server.backdoorInstalled = true;
    }
  } catch (error) {
    if (isScriptDeath(error)) throw error;
    backdoorAttempted.add(host);
    // No singularity access, or the connection failed. Recorded by the
    // attempt set so we do not retry forever — and REPORTED through the
    // probe-failure channel: a silent latch here cost a whole join (the
    // error was invisible for two hours of run).
    recordProbeFailure(ctx.state, `backdoor:${host}`, error);
  } finally {
    backdoorInFlight = false;
  }
}

type ServerAccessAction = {
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

/** Select the exact board action both claim collection and execution use. */
function nextServerAccessAction(ctx: Pick<ClaimContext, "board" | "state">): ServerAccessAction | undefined {
  const servers = ctx.state.topics.servers ?? {};
  const player = ctx.state.topics.player;
  if (!player) return undefined;
  // Terminal roots form the first tier and cannot be delayed by starting a
  // faction backdoor. Within the backdoor tier, an action ready RIGHT NOW
  // beats buying another opener. Among opener purchases the lowest-port host
  // wins (its next program is cheapest); returning the first board entry used
  // to let a $250m future SQLInject block CSEC's ready backdoor for 30 minutes.
  let opener: ServerAccessAction | undefined;
  for (const tier of [ctx.board.byKind.root, ctx.board.byKind.backdoor]) {
    for (const need of tier) {
      if (need.have >= need.target) continue;
      const host = need.subject;
      const wantsBackdoor = need.kind === "backdoor";
      if (!host || (wantsBackdoor && backdoorAttempted.has(host))) continue;
      const server = servers[host];
      if (!server || (wantsBackdoor ? server.backdoorInstalled : server.hasAdminRights)) continue;
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
        if (!opener || (server.numOpenPortsRequired ?? 0) < (opener.server.numOpenPortsRequired ?? 0)) {
          opener = { action: "port-opener", host, server };
        }
        continue;
      }
      // A root-only need is satisfied by the fleet sweep once the opener exists;
      // it must never escalate into installing an unrequested backdoor.
      if (!wantsBackdoor) continue;
      // The backdoor itself DOES need the skill (and the connect chain).
      if (player.skills.hacking < (server.requiredHackingSkill ?? Infinity)) continue;
      return { action: "backdoor", host, server };
    }
    if (opener) return opener;
  }
  return opener;
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
  const playerWorkIncome = Math.max(0, ...(game.topics.career?.plan?.ranked ?? []).map((entry) => entry.moneyPerSec));
  return preferProgramCreation(
    program,
    skills.hacking,
    skills.intelligence,
    playerWorkIncome,
    (game.topics.fleet?.portOpeners ?? 0) > 0,
  );
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
  if (!weakenWindow && now - lastPumpAt < WAKE_MIN_MS) return;
  if (!weakenWindow && wakesThisFrame >= WAKE_MAX_PER_FRAME) return;
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
        horizonSec: usableForecastSec(ctx.horizons.node) ?? DEFAULT_PLANNING_HORIZON_SEC,
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
            horizonSec: coarseHorizonSec(usableForecastSec(ctx.horizons.node) ?? DEFAULT_PLANNING_HORIZON_SEC),
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
    const pending = nextServerAccessAction(ctx);
    const action = pending?.action;
    if (action === "backdoor") {
      claims.push(actionRamClaim(ctx, "hacking", "action:backdoor", BACKDOOR_CALLS, "install requested backdoor"));
    }
    if (action === "port-opener") {
      const program = pending ? programForPortNeed(ctx.state, pending.server.numOpenPortsRequired ?? 0) : undefined;
      requestedProgram = program && ctx.activeFeatures.has("career") && shouldWriteProgram(ctx.state, program)
        ? program
        : undefined;
      if (!requestedProgram && program) {
        const purchaseCost = portOpenerPurchaseCost(ctx.state, pending!.server.numOpenPortsRequired ?? 0);
        claims.push(
          actionRamClaim(ctx, "hacking", "action:port-opener", PORT_OPENER_CALLS, "acquire required port opener"),
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
            why: `buy TOR and the port openers needed to root ${pending!.host}`,
          },
        );
      }
    } else {
      requestedProgram = undefined;
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
          `buy economically justified ${investment.option.kind}`,
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
          why: investment.option.why,
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
        urgency: "blocking",
        why: `writing ${requestedProgram.name} is cheaper than buying it at current player-work income`,
      }]
    : [],
};
