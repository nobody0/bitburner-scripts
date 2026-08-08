import type { NS } from "@ns";
import { gameGlobal } from "../globals.ts";
import { buildView, drainCompletions, initDriver, pump, type DriverState } from "../dispatch-driver.ts";
import { set, type GameState } from "../state.ts";
import { workerGlobals } from "../worker-shared.ts";
import { isScriptDeath } from "../errors.ts";
import { actionRamClaim, featureDodge } from "./dodge.ts";
import type { ClaimContext, DriverContext, FeatureDriver, FeatureModule } from "./index.ts";

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
  globals.dispatch_done!.length = 0;
  state = initDriver();
  pumpMaxMs = 0;
  lastRollup = 0;
  switched = undefined;
  backdoorAttempted.clear();
  backdoorInFlight = false;
  lastBackdoorAt = 0;
}

/** Peak pump duration since the last rollup, reported so a dispatcher pass
 * that starts eating the tick budget is visible before it starts missing
 * slots. */
let pumpMaxMs = 0;
let lastRollup = 0;

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
  set(game, "farm", {
    target,
    ...(targetSolveExact !== undefined ? { targetSolveExact } : {}),
    ...(prepTarget !== undefined ? { prepTarget } : {}),
    ...(segOrder !== undefined ? { segOrder } : {}),
    inFlight: { ...driver.memory.dispatch.inFlight },
    launched: { ...stats.launched },
    landed: { ...stats.landed },
    allocFails: stats.allocFails,
    execFails: driver.execFails,
    batchesSkipped: stats.batchesSkipped,
    pumpMaxMs: takePumpMaxMs(),
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
    if (player.skills.hacking < (server.requiredHackingSkill ?? Infinity)) continue;
    if (!server.hasAdminRights) {
      if ((server.numOpenPortsRequired ?? 0) === 0) continue;
      return { action: "port-opener", host, server };
    }
    return { action: "backdoor", host, server };
  }
  return undefined;
}

/** Darkweb port openers, cheapest first — the order the game unlocks ports in. */
const PORT_OPENERS = ["BruteSSH.exe", "FTPCrack.exe", "relaySMTP.exe", "HTTPWorm.exe", "SQLInject.exe"] as const;

/** Buy the next port opener we lack, if a needed server requires more ports
 * than we can currently open. Returns true if anything was bought.
 *
 * Deliberately narrow: this runs ONLY to unblock a posted backdoor need, so
 * the fleet does not spend money on crackers nothing has asked for. */
async function buyPortOpener(ctx: DriverContext, portsRequired: number): Promise<boolean> {
  if (portsRequired === 0) return false;
  try {
    const outcome = await featureDodge(
      ctx,
      "hacking",
      "action:port-opener",
      PORT_OPENER_CALLS,
      (stubNs: NS) => {
        const owned = new Set(stubNs["ls"]("home", ".exe"));
        const missing = PORT_OPENERS.filter((program) => !owned.has(program));
        if (owned.size >= portsRequired || missing.length === 0) return false;
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

export const hacking: FeatureDriver = {
  id: "hacking",
  everyMs: 200,
  tick(ctx: DriverContext) {
    const { ns, state: game, homeReserveGb } = ctx;
    const servers = game.topics.servers;
    const player = game.topics.player;
    if (!servers || !player || Object.keys(servers).length === 0) return;

    const driver = hackingState();

    // Only the farm and prep targets get live reads; everything else comes
    // from the sweep snapshot.
    const active = driver.memory.dispatch.evaluator.directive;
    const hot = [active.farm?.host, active.prep?.host].filter((h): h is string => Boolean(h));
    const view = buildView(ns, driver, servers, player, hot);
    const completions = drainCompletions(driver);

    const started = Date.now();
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
    const result = pump(ns, driver, view, completions, { homeReserveGb, horizonMs: ctx.horizonSec * 1000 });
    const elapsed = Date.now() - started;
    if (elapsed > pumpMaxMs) pumpMaxMs = elapsed;

    const target = result.directive.farm?.host ?? "";
    const current = gameGlobal.farmTarget ?? "";
    if (target !== current) {
      switched = { from: current, to: target };
      gameGlobal.farmTarget = target;
    }

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
    // The rollups this feature publishes. Cumulative totals live in the
    // dispatcher stats resetHackingState just cleared; dropping the last
    // rollups stops the UI showing the old node's earnings until the next
    // one lands. (The server snapshot is the fleet substrate's, not ours —
    // the controller rescans it.)
    delete state.topics.farm;
    delete state.topics.fleet;
  },
  claims: (ctx) => {
    const action = nextBackdoorAction(ctx)?.action;
    if (action === "backdoor") {
      return [actionRamClaim(ctx, "hacking", "action:backdoor", BACKDOOR_CALLS, "install requested backdoor")];
    }
    if (action === "port-opener") {
      return [actionRamClaim(ctx, "hacking", "action:port-opener", PORT_OPENER_CALLS, "acquire required port opener")];
    }
    return [];
  },
};
