import type { NS } from "@ns";
import { effectiveBitNodeMultipliers } from "../../../shared/features/bitnode.ts";
import { sfLevel } from "../../../shared/features/unlock.ts";
import { PRIORITY, type Claim } from "../../../shared/strategy/arbiter.ts";
import {
  scoreHomeRam,
  stepInfrastructure,
  type InfrastructureDecision,
  type InfrastructureOption,
  type ScoredInfrastructure,
} from "../../../shared/strategy/infrastructure.ts";
import { FARM_SHARE } from "../../../shared/strategy/evaluator.ts";
import { solveCycle } from "../../../shared/strategy/targeting.ts";
import { PORT_OPENER_PROGRAMS, preferProgramCreation, type ProgramOption } from "../../../shared/strategy/career/programs.ts";
import type { Need } from "../../../shared/strategy/needs.ts";
import { DEFAULT_PLANNING_HORIZON_SEC, usableForecastSec } from "../../../shared/strategy/progression/forecast.ts";
import { gameGlobal } from "../globals.ts";
import { buildView, drainCompletions, initDriver, pump, type DriverState } from "../dispatch-driver.ts";
import { merge, set, type GameState } from "../state.ts";
import { workerGlobals } from "../worker-shared.ts";
import { isScriptDeath } from "../errors.ts";
import { actionRamClaim, featureDodge } from "./dodge.ts";
import type { ClaimContext, DriverContext, FeatureDriver, FeatureModule, NeedContext } from "./index.ts";

/** The hacking driver: one HWGW dispatcher pass per tick.
 *
 * All decisions live in shared/strategy; this only moves data. It runs at
 * TICK_MS — one HWGW spacer — because batch ops land on 200 ms slots and a
 * slower cadence would simply miss them. Every other feature is slower by
 * orders of magnitude, which is the whole reason the frame schedules by
 * cadence rather than running everything every pass. */

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
  globals.dispatch_done!.length = 0;
  state = initDriver();
  pumpMaxMs = 0;
  lastRollup = 0;
  lastTotals = undefined;
  moneyRateEma = 0;
  expRateEma = 0;
  lastPumpAt = 0;
  wakesThisFrame = 0;
  wakePumps = 0;
  switched = undefined;
  backdoorAttempted.clear();
  backdoorInFlight = false;
  lastBackdoorAt = 0;
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
  const segmentGb = driver.memory.dispatch.segmentGb;

  set(game, "farm", {
    target,
    ...(targetSolveExact !== undefined ? { targetSolveExact } : {}),
    ...(driver.memory.dispatch.evaluator.directive.farm?.solution.score !== undefined
      ? { moneyPerSecPerGb: driver.memory.dispatch.evaluator.directive.farm.solution.score }
      : {}),
    ...(prepTarget !== undefined ? { prepTarget } : {}),
    ...(segOrder !== undefined ? { segOrder } : {}),
    mode: driver.memory.dispatch.mode,
    modeWhy: driver.memory.dispatch.modeWhy,
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
    execs: stats.execs,
    ...(stats.stockOps > 0 ? { stockOps: stats.stockOps } : {}),
    ...(driver.memory.dispatch.depthCapGb !== undefined ? { depthCapGb: driver.memory.dispatch.depthCapGb } : {}),
    execFails: driver.execFails,
    batchesSkipped: stats.batchesSkipped,
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
const BACKDOOR_CALLS = ["singularity.connect", "singularity.installBackdoor"] as const;
const PORT_OPENER_CALLS = ["ls", "singularity.purchaseTor", "singularity.purchaseProgram"] as const;
let backdoorInFlight = false;
let lastBackdoorAt = 0;
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
  const caps = { batchGb: usable, hackBlockGb: usable };
  const before = solveCycle(hackCtx, statics, home.cores, caps)?.score ?? 0;
  const after = solveCycle(hackCtx, statics, home.cores + 1, caps)?.score ?? 0;
  return Math.max(0, after - before) * usable;
}

function infrastructureDecision(ctx: Pick<ClaimContext, "state" | "horizons">): InfrastructureDecision {
  // Two lifetimes, two horizons. Home RAM and cores survive augmentation
  // installs, so they amortize over the whole node. Purchased cloud servers
  // are destroyed by prestigeAugmentation, so they only have until the next
  // install to repay — pricing them against the node horizon buys servers
  // that are wiped before they break even.
  const nodeHorizonSec = usableForecastSec(ctx.horizons.node) ?? DEFAULT_PLANNING_HORIZON_SEC;
  const installHorizonSec = usableForecastSec(ctx.horizons.install) ?? DEFAULT_PLANNING_HORIZON_SEC;
  const fleet = ctx.state.topics.fleet;
  if (!fleet) return stepInfrastructure([], nodeHorizonSec);
  const perGb = Math.max(0, ctx.state.topics.farm?.moneyPerSecPerGb ?? 0);
  // MARGINAL income, not linear: the farm's demand saturates at the current
  // target's pipeline depth cap (grossed up by the farm segment share), and
  // RAM beyond it earns nothing until the target changes. Pricing every GB at
  // the average rate bought a $450m 16 TB server the farm could only half
  // fill (measured on bn1-speedrun: fleet utilization 90% -> 72%).
  const depthCap = ctx.state.topics.farm?.depthCapGb;
  const fleetGb = fleet.maxRam ?? 0;
  const demandCeiling = depthCap !== undefined ? depthCap / FARM_SHARE : Infinity;
  const marginalIncome = (addedRam: number): number =>
    perGb * Math.max(0, Math.min(fleetGb + addedRam, demandCeiling) - Math.min(fleetGb, demandCeiling));
  const options: InfrastructureOption[] = [];
  if (fleet.homeRamUpgradeCost !== undefined) {
    options.push({
      kind: "homeRam",
      cost: fleet.homeRamUpgradeCost,
      addedRam: fleet.home.maxRam,
      incomePerSec: marginalIncome(fleet.home.maxRam),
      targetRam: fleet.home.maxRam * 2,
    });
  }
  if (fleet.homeCoreUpgradeCost !== undefined && fleet.home.cores < 8) {
    options.push({
      kind: "homeCore",
      cost: fleet.homeCoreUpgradeCost,
      addedRam: 0,
      incomePerSec: homeCoreIncomeDelta(ctx),
    });
  }
  // The probe quotes a ladder of new-server sizes; only sizes the CURRENT
  // bankroll covers may compete. The winner executes in this same pass, so an
  // aspirational quote would not merely lose — it would win the ranking and
  // then block the whole infrastructure lane until the money materialized.
  const money = ctx.state.topics.player?.money ?? 0;
  for (const quote of fleet.infrastructureOptions ?? []) {
    if (quote.kind === "buyServer" && quote.cost > money) continue;
    options.push({ ...quote, incomePerSec: marginalIncome(quote.addedRam), horizonSec: installHorizonSec });
  }
  return stepInfrastructure(options, nodeHorizonSec);
}

function infrastructureMethods(kind: InfrastructureOption["kind"]): readonly string[] {
  if (kind === "homeRam") return HOME_RAM_METHODS;
  if (kind === "homeCore") return HOME_CORE_METHODS;
  if (kind === "buyServer") return CLOUD_BUY_METHODS;
  return CLOUD_UPGRADE_METHODS;
}

function infrastructureClaimId(kind: InfrastructureOption["kind"]): string {
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

async function executeInfrastructure(ctx: DriverContext, decision: ScoredInfrastructure): Promise<void> {
  if (infrastructureInFlight || moneyGrantFor(ctx, `infrastructure:${decision.kind}`) < decision.cost) return;
  infrastructureInFlight = true;
  const at = Date.now();
  try {
    const outcome = await featureDodge(
      ctx,
      "hacking",
      infrastructureClaimId(decision.kind),
      infrastructureMethods(decision.kind),
      (stubNs: NS) => {
        if (decision.kind === "homeRam") return stubNs["singularity"]["upgradeHomeRam"]();
        if (decision.kind === "homeCore") return stubNs["singularity"]["upgradeHomeCores"]();
        if (decision.kind === "buyServer") {
          return stubNs["cloud"]["purchaseServer"]("pserv", decision.targetRam!) !== "";
        }
        return stubNs["cloud"]["upgradeServer"](decision.host!, decision.targetRam!);
      },
    );
    const ok = outcome.ok && Boolean(outcome.value);
    lastInfrastructureResult = {
      action: decision.kind,
      ok,
      detail: ok ? `bought ${decision.kind} for $${Math.round(decision.cost).toLocaleString()}` : outcome.ok ? "purchase refused" : outcome.reason,
      at,
    };
    const publishedPlan = ctx.state.topics.fleet?.infrastructurePlan;
    if (publishedPlan) {
      merge(ctx.state, "fleet", { infrastructurePlan: { ...publishedPlan, lastResult: lastInfrastructureResult } });
    }
    if (ok) {
      merge(ctx.state, "fleet", {
        ...(decision.kind === "homeRam" ? { homeRamUpgradeCost: Infinity } : {}),
        ...(decision.kind === "homeCore" ? { homeCoreUpgradeCost: Infinity } : {}),
        ...(decision.kind === "buyServer" || decision.kind === "upgradeServer" ? { infrastructureOptions: [] } : {}),
      });
    }
  } finally {
    infrastructureInFlight = false;
  }
}

/** Satisfy `backdoor` needs from the board.
 *
 * This is the needs board doing its job end to end: `factions` posts
 * `{kind:"backdoor", subject:"CSEC"}` because CyberSec requires it, without
 * knowing or caring how a backdoor is installed; `hacking` owns servers, so it
 * delivers. Neither feature references the other.
 *
 * Deliberately conservative — one attempt per host, throttled, and skipped
 * entirely while a batch-critical pass is running: a backdoor takes
 * hackingTime/4 and would otherwise be launched on every 200 ms tick. */
async function serveBackdoorNeeds(ctx: DriverContext): Promise<void> {
  if (backdoorInFlight) return;
  const now = Date.now();
  if (now - lastBackdoorAt < 10_000) return;

  const pending = nextBackdoorAction(ctx);
  if (!pending) return;
  const { host, server, action } = pending;

  // Not rooted yet: the blocker is usually a missing port opener, and
  // nothing else in the loop will ever buy one. Rooting servers is
  // hacking's job, so acquiring the means to root them is too. This is
  // load-bearing rather than incidental — CSEC needs one open port, so
  // without a cracker the entire faction ladder is unreachable.
  if (action === "port-opener") {
    const program = programForPortNeed(ctx.state, server.numOpenPortsRequired ?? 0);
    requestedProgram = program && shouldWriteProgram(ctx.state, program) ? program : undefined;
    if (requestedProgram) return;
    if (await buyPortOpener(ctx, server.numOpenPortsRequired ?? 0)) lastBackdoorAt = now;
    return;
  }

  backdoorInFlight = true;
  lastBackdoorAt = now;
  try {
    const outcome = await featureDodge(ctx, "hacking", "action:backdoor", BACKDOOR_CALLS, async (stubNs: NS) => {
      stubNs["singularity"]["connect"](host as never);
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
    // attempt set so we do not retry forever.
  } finally {
    backdoorInFlight = false;
  }
}

type BackdoorAction = {
  action: "backdoor" | "port-opener";
  host: string;
  server: NonNullable<GameState["topics"]["servers"]>[string];
};

/** Select the exact board action both claim collection and execution use. */
function nextBackdoorAction(ctx: Pick<ClaimContext, "board" | "state">): BackdoorAction | undefined {
  const servers = ctx.state.topics.servers ?? {};
  const player = ctx.state.topics.player;
  if (!player) return undefined;
  for (const need of ctx.board.byKind.backdoor) {
    if (need.have >= need.target) continue;
    const host = need.subject;
    if (!host || backdoorAttempted.has(host)) continue;
    const server = servers[host];
    if (!server || server.backdoorInstalled) continue;
    // Port openers are MONEY, not skill: buy them the moment the need exists
    // so the root is ready when the skill arrives. Gating the purchase behind
    // the skill check closed the buying window on factions-join — by the time
    // hacking crossed CSEC's requirement, the bankroll had been spent on
    // fleet and BruteSSH stayed unaffordable for the rest of the run.
    if (!server.hasAdminRights) {
      if ((server.numOpenPortsRequired ?? 0) === 0) continue;
      return { action: "port-opener", host, server };
    }
    // The backdoor itself DOES need the skill (and the connect chain).
    if (player.skills.hacking < (server.requiredHackingSkill ?? Infinity)) continue;
    return { action: "backdoor", host, server };
  }
  return undefined;
}

/** Darkweb port openers, cheapest first — the order the game unlocks ports in. */
const PORT_OPENERS = ["BruteSSH.exe", "FTPCrack.exe", "relaySMTP.exe", "HTTPWorm.exe", "SQLInject.exe"] as const;

function programForPortNeed(game: GameState, portsRequired: number): ProgramOption | undefined {
  const owned = game.topics.fleet?.portOpeners ?? 0;
  if (owned >= portsRequired) return undefined;
  return PORT_OPENER_PROGRAMS[owned];
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

/** Buy the next port opener we lack, if a needed server requires more ports
 * than we can currently open. Returns true if anything was bought.
 *
 * Deliberately narrow: this runs ONLY to unblock a posted backdoor need, so
 * the fleet does not spend money on crackers nothing has asked for. */
async function buyPortOpener(ctx: DriverContext, portsRequired: number): Promise<boolean> {
  if (portsRequired === 0) return false;
  const program = programForPortNeed(ctx.state, portsRequired);
  // The arbiter reserves the conservative TOR + program price. Never let an
  // imperative purchase bypass the shared money policy.
  if (!program || moneyGrantFor(ctx, `port-opener:${program.name}`) < program.purchaseCost + 200_000) return false;
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
        if (owned.length >= portsRequired || missing.length === 0) return false;
        // TOR first; it is a precondition and idempotent.
        if (!stubNs["singularity"]["purchaseTor"]()) return false;
        return stubNs["singularity"]["purchaseProgram"](missing[0] as never);
      },
    );
    return outcome.ok && outcome.value;
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
  homeReserveGb: number,
  fleetReserveGb: number,
  installSec: number | undefined,
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

  const started = Date.now();
  // pooling: farm batch ops ride pooled serve workers (worker.ts serve mode),
  // collapsing exec churn — the browser-side cost of a fresh WorkerScript per
  // op — to near zero at depth.
  const result = pump(ns, driver, view, completions, {
    homeReserveGb,
    ...(fleetReserveGb > 0 ? { fleetReserveGb } : {}),
    pooling: true,
    ...(installSec !== undefined ? { horizonMs: installSec * 1_000 } : {}),
  });
  const elapsed = Date.now() - started;
  if (elapsed > pumpMaxMs) pumpMaxMs = elapsed;
  lastPumpAt = Date.now();

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
export function pumpOnWake(
  ns: NS,
  game: GameState,
  caps: DriverContext["caps"],
  homeReserveGb: number,
  fleetReserveGb: number,
  installSec: number | undefined,
): void {
  const now = Date.now();
  if (now - lastPumpAt < WAKE_MIN_MS) return;
  if (wakesThisFrame >= WAKE_MAX_PER_FRAME) return;
  wakesThisFrame++;
  wakePumps++;
  runPump(ns, game, caps, homeReserveGb, fleetReserveGb, installSec);
}

export const hacking: FeatureDriver = {
  id: "hacking",
  everyMs: 200,
  async tick(ctx: DriverContext) {
    const { ns, state: game, homeReserveGb } = ctx;
    wakesThisFrame = 0;

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
    const result = runPump(ns, game, ctx.caps, homeReserveGb, ctx.fleetReserveGb, installSec);
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
      const infrastructure = infrastructureDecision(ctx);
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
            why: homeRam.why,
            ...(lastInfrastructureResult?.action === "homeRam" ? { lastResult: lastInfrastructureResult } : {}),
          } } : {}),
          infrastructurePlan: {
            evaluatedAt: now,
            horizonSec: usableForecastSec(ctx.horizons.node) ?? DEFAULT_PLANNING_HORIZON_SEC,
            moneyAvailable: game.topics.player?.money ?? 0,
            moneyGranted: ctx.grants.money,
            incomePerSecPerGb: game.topics.farm?.moneyPerSecPerGb ?? 0,
            ...(infrastructure.buy ? { buy: {
              kind: infrastructure.buy.kind,
              cost: infrastructure.buy.cost,
              ...(infrastructure.buy.host ? { host: infrastructure.buy.host } : {}),
              ...(infrastructure.buy.targetRam ? { targetRam: infrastructure.buy.targetRam } : {}),
            } } : {}),
            why: infrastructure.why,
            ...(infrastructure.hold ? { hold: infrastructure.hold } : {}),
            rankedTotal: infrastructure.ranked.length,
            ranked: infrastructure.ranked.slice(0, 8).map((entry, index) => ({
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
              selected: index === 0 && Boolean(infrastructure.buy),
              why: entry.why,
            })),
            ...(lastInfrastructureResult ? { lastResult: lastInfrastructureResult } : {}),
          },
        });
      }
    }

    // Fire-and-forget for the same reason as the backdoors below: the
    // purchase dodge serializes on the global dodge mutex, and the dispatcher
    // must not await a multi-second dodge on its 200 ms cadence.
    // `infrastructureInFlight` keeps it single-flight.
    const investment = infrastructureDecision(ctx).buy;
    if (investment) {
      void executeInfrastructure(ctx, investment).catch((error) => {
        if (isScriptDeath(error)) throw error;
        lastInfrastructureResult = { action: investment.kind, ok: false, detail: String(error), at: Date.now() };
      });
    }

    // Serve the board LAST, so a backdoor's dodge can never delay a
    // dispatcher pass. Fire-and-forget: the dispatcher must not await a
    // multi-second backdoor on its 200 ms cadence.
    if (ctx.board.byKind.backdoor.length > 0) void serveBackdoorNeeds(ctx);
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
    const claims: Claim[] = [];
    const pending = nextBackdoorAction(ctx);
    const action = pending?.action;
    if (action === "backdoor") {
      claims.push(actionRamClaim(ctx, "hacking", "action:backdoor", BACKDOOR_CALLS, "install requested backdoor"));
    }
    if (action === "port-opener") {
      const program = pending ? programForPortNeed(ctx.state, pending.server.numOpenPortsRequired ?? 0) : undefined;
      requestedProgram = program && shouldWriteProgram(ctx.state, program) ? program : undefined;
      if (!requestedProgram && program) {
        claims.push(
          actionRamClaim(ctx, "hacking", "action:port-opener", PORT_OPENER_CALLS, "acquire required port opener"),
          {
            by: "hacking",
            id: `port-opener:${program.name}`,
            resource: "money",
            amount: program.purchaseCost + 200_000,
            priority: PRIORITY["hacking:infrastructure"],
            mode: "spend",
            divisible: false,
            why: `buy TOR and ${program.name} to reach a requested backdoor`,
          },
        );
      }
    } else {
      requestedProgram = undefined;
    }
    const investment = infrastructureDecision(ctx).buy;
    if (investment) {
      const claimId = infrastructureClaimId(investment.kind);
      claims.push(
        actionRamClaim(ctx, "hacking", claimId, infrastructureMethods(investment.kind), `buy economically justified ${investment.kind}`),
        {
          by: "hacking",
          id: `infrastructure:${investment.kind}`,
          resource: "money",
          amount: investment.cost,
          priority: PRIORITY["income:investment"],
          mode: "spend",
          divisible: false,
          ratePerSec: investment.incomePerSec,
          returnPerDollarSec: investment.returnPerDollarSec,
          why: investment.why,
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
