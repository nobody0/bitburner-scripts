import { gameGlobal } from "../globals.ts";
import { buildView, drainCompletions, initDriver, pump, type DriverState } from "../dispatch-driver.ts";
import { set, type GameState } from "../state.ts";
import { workerGlobals } from "../worker-shared.ts";
import type { DriverContext, FeatureDriver } from "./index.ts";

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

/** Drop the ledger, the heap and the realm rendezvous. Called on a BitNode
 * reset, where the entire fleet the heap describes has ceased to exist.
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
  set(game, "farm", {
    target,
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

export const hacking: FeatureDriver = {
  id: "hacking",
  everyMs: 200,
  tick({ ns, state: game }: DriverContext) {
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
    const result = pump(ns, driver, view, completions);
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
  },
};
