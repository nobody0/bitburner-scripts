import type { NS, Server } from "@ns";
import { dodge } from "./lib/dodge.ts";
import { gameGlobal } from "./lib/globals.ts";
import {
  canRoot,
  deployWorker,
  listPortOpeners,
  reapStrayScripts,
  reclaimFleet,
  rootServers,
} from "./lib/net.ts";
import {
  buildView,
  drainCompletions,
  initDriver,
  pump,
  resyncHeap,
  WORKER_SCRIPT,
} from "./lib/dispatch-driver.ts";
import { initProbeRunner, runProbes, type ProbeRunner } from "./lib/probe-runner.ts";
import { collectServers } from "./lib/scan.ts";
import { initTelemetry, type Telemetry } from "./lib/telemetry.ts";
import { watchNs, type WatchedNS } from "./lib/watched-ns.ts";

/** Single entry point for both boot situations (autoexec: `start.js main`):
 *  - COLD: the game just loaded. The JS realm is fresh (gameGlobal empty) and
 *    with "Exclude Running Scripts from Save" nothing else survived — full
 *    sweep: scan, root, redeploy the whole fleet.
 *  - HANDOFF: a newer build was pushed; the previous instance exec'd us with
 *    ("handoff", buildId) and exited. The realm and the remote starters
 *    survive — inherit state, only retarget when the pick changes.
 *  Either way the controller-epoch guard makes the newest instance the only
 *  controller: an older loop sees the bumped epoch and exits — no kills.
 *
 * Fresh-game RAM budget (8 GB home): start.js ~3.4 GB static + transient
 * dodge stub <= 4.1 GB = 7.5 GB peak; handoff overlap 2 x 3.4 = 6.8 GB. Fits.
 */

/** Dispatcher pass cadence: one HWGW spacer. Ticks use absolute deadlines
 * with a catch-up clamp so a game stall cannot produce a burst of passes. */
const TICK_MS = 200;
const PLAYER_EVERY_TICKS = 10; // 2s
const SWEEP_EVERY_TICKS = 150; // 30s

export async function main(ns: NS): Promise<void> {
  const mode = ns.args[0] === "handoff" ? "handoff" : "cold";
  const epoch = (gameGlobal.controllerEpoch ?? 0) + 1;
  gameGlobal.controllerEpoch = epoch;

  let tel: Telemetry | undefined;
  let g: WatchedNS = ns;
  try {
    TELEMETRY: if (__TELEMETRY__) {
      tel = initTelemetry(ns, "start.js");
      g = watchNs(ns, tel);
    }
    await runController(ns, g, tel, mode, epoch);
  } catch (error) {
    // ScriptDeath is Bitburner's normal cancellation marker (manual kill,
    // reload, or an interrupted ns call), not a controller crash.
    TELEMETRY: if (!isScriptDeath(error) && __TELEMETRY__) {
      try {
        tel!.event("start.crash", { build: __BUILD_ID__, mode, epoch, error: errorDetails(error) });
        tel!.flush();
      } catch {
        // Reporting must never replace the original controller failure.
      }
    }
    throw error;
  }
}

async function runController(
  ns: NS,
  g: WatchedNS,
  tel: Telemetry | undefined,
  mode: "cold" | "handoff",
  epoch: number,
): Promise<void> {
  TELEMETRY: if (__TELEMETRY__) tel!.event("start.boot", { mode, build: __BUILD_ID__, epoch });
  ns.tprint(`start.js online (${mode}, build ${__BUILD_ID__})`);

  // Sentinel opener count (legacy watchHuman trick): guarantees the first
  // sweep always roots + deploys, which covers the cold-boot dead fleet.
  let openerCount = -1;
  let currentTarget = mode === "handoff" ? (gameGlobal.farmTarget ?? "") : "";
  let reportedRespawnFailure: string | undefined;

  // HWGW engine (shared/strategy) plus its thin game-side driver.
  const driver = initDriver();
  let servers: Record<string, Server> = gameGlobal.servers ?? {};
  let player = g.getPlayer();
  let nextTick = Date.now();
  let lastRollup = 0;
  let pumpMaxMs = 0;

  // Feature probes are telemetry-only: perf builds drop the assignment, and
  // every use below sits in a TELEMETRY branch, so the whole probe table
  // tree-shakes out of the bundle.
  let probes: ProbeRunner | undefined;
  TELEMETRY: if (__TELEMETRY__) probes = initProbeRunner();

  for (let tick = 0; ; tick++) {
    // Yield to a newer controller (manual restart, double autoexec, handoff).
    if (gameGlobal.controllerEpoch !== epoch) {
      TELEMETRY: if (__TELEMETRY__) {
        tel!.event("start.superseded", { epoch });
        tel!.dispose();
      }
      return;
    }

    // Self-update: a newer build was pushed -> hand off to a fresh instance.
    const pushedBuild = ns.read("build-id.txt").trim();
    if (pushedBuild !== "" && pushedBuild !== __BUILD_ID__) {
      const pid = ns.exec("start.js", "home", 1, "handoff", pushedBuild);
      if (pid !== 0) {
        reportedRespawnFailure = undefined;
        TELEMETRY: if (__TELEMETRY__) {
          tel!.event("start.respawn", { from: __BUILD_ID__, to: pushedBuild });
          tel!.dispose();
        }
        return;
      }
      if (reportedRespawnFailure !== pushedBuild) {
        reportedRespawnFailure = pushedBuild;
        TELEMETRY: if (__TELEMETRY__) {
          tel!.event("start.respawn_failed", { from: __BUILD_ID__, to: pushedBuild });
        }
        ns.tprint(`WARNING: failed to start build ${pushedBuild}; keeping ${__BUILD_ID__} online and retrying`);
      }
      await ns.sleep(TICK_MS);
      continue;
    }
    reportedRespawnFailure = undefined;

    if (tick % PLAYER_EVERY_TICKS === 0) {
      player = g.getPlayer();
      gameGlobal.player = player;
    }

    if (tick % SWEEP_EVERY_TICKS === 0) {
      // 1) Scan the whole network (typed snapshot -> globals + UI).
      servers = await dodge(ns, collectServers);
      gameGlobal.servers = servers;
      TELEMETRY: if (__TELEMETRY__) tel!.state("servers", servers);

      // 1a) Cold boot: this realm is fresh, so every script still running is
      //     an orphan whose RAM we can never account for. Reclaim the fleet
      //     once, before the dispatcher tries to allocate anything.
      if (tick === 0 && mode === "cold") {
        const self = ns.pid;
        const reclaimed = await dodge(ns, (stubNs) => reclaimFleet(stubNs, servers, self), 1.5);
        if (reclaimed.length > 0) {
          ns.tprint(`reclaimed ${reclaimed.length} host(s) from orphaned scripts`);
          TELEMETRY: if (__TELEMETRY__) tel!.event("fleet.reclaimed", { hosts: reclaimed });
        }
        servers = await dodge(ns, collectServers);
        gameGlobal.servers = servers;
      }

      // 2) Root anything newly rootable.
      const openers = await dodge(ns, listPortOpeners, 0.5);
      const rootable = Object.values(servers).filter((s) => !s.hasAdminRights && canRoot(s, openers));
      if (openers.length !== openerCount || rootable.length > 0) {
        openerCount = openers.length;
        if (rootable.length > 0) {
          const hosts = rootable.map((s) => s.hostname);
          const rooted = await dodge(ns, (stubNs) => rootServers(stubNs, hosts, openers), 1);
          for (const host of rooted) servers[host]!.hasAdminRights = true;
          TELEMETRY: if (__TELEMETRY__) tel!.event("net.rooted", { hosts: rooted, openers });
        }
      }

      // 3) Deploy the puppet worker (dodged: scp stays out of our RAM bill)
      //    and reconcile the heap with the game's real usage.
      const deployed = await dodge(ns, (stubNs) => deployWorker(stubNs, WORKER_SCRIPT, servers), 1);
      for (const host of deployed) driver.deployed.add(host);

      // 3a) Safety net: retire old architectures and kill unreachable
      //     workers. Liveness comes from the realm registry (survives build
      //     handoffs), never from this instance's ledger.
      const registered = new Set(driver.globals.worker_info?.keys() ?? []);
      const reaped = await dodge(
        ns,
        (stubNs) => reapStrayScripts(stubNs, deployed, WORKER_SCRIPT, registered),
        1,
      );
      if (reaped.workers > 0 || reaped.retired > 0) {
        TELEMETRY: if (__TELEMETRY__) tel!.event("fleet.reaped", reaped);
      }

      const drifted = resyncHeap(driver, servers);
      TELEMETRY: if (__TELEMETRY__ && drifted.length > 0) tel!.event("heap.resync", { hosts: drifted });

      // 4) Feature probes, last in the sweep: they are pure observation, so
      //    they yield to rooting and deployment for the dodge mutex. The
      //    runner prices itself against whatever home RAM the heap left free.
      TELEMETRY: if (__TELEMETRY__) {
        await runProbes(ns, probes!, tel!, { player, servers });
      }
    }

    // Dispatcher pass: absorb worker completions, plan, launch.
    if (Object.keys(servers).length > 0) {
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
      if (target !== currentTarget) {
        TELEMETRY: if (__TELEMETRY__) tel!.event("farm.targetSwitch", { from: currentTarget, to: target });
        currentTarget = target;
        gameGlobal.farmTarget = target;
      }
      TELEMETRY: if (__TELEMETRY__ && elapsed > 5) tel!.event("dispatch.slow", { ms: elapsed, launched: result.launched });

      // 1 Hz rollup — never per-op events (they would be ~3 per 16ms).
      TELEMETRY: if (__TELEMETRY__ && Date.now() - lastRollup >= 1_000) {
        lastRollup = Date.now();
        const stats = driver.memory.dispatch.stats;
        tel!.state("farm", {
          target,
          prepTarget: result.directive.prep?.host,
          segOrder: result.directive.segments.map((segment) => segment.kind),
          inFlight: { ...driver.memory.dispatch.inFlight },
          launched: { ...stats.launched },
          landed: { ...stats.landed },
          allocFails: stats.allocFails,
          execFails: driver.execFails,
          batchesSkipped: stats.batchesSkipped,
          pumpMaxMs,
          totals: { moneyEarned: stats.moneyEarned, hacks: stats.hacks },
        });
        pumpMaxMs = 0;
      }
    }

    // Absolute deadline with catch-up clamp (legacy accumulated drift).
    nextTick += TICK_MS;
    const now = Date.now();
    if (nextTick < now - TICK_MS) nextTick = now;
    await ns.sleep(Math.max(0, nextTick - now));
  }
}

function isScriptDeath(error: unknown): boolean {
  return error instanceof Error && error.name === "ScriptDeath";
}

function errorDetails(error: unknown): { name: string; message: string; stack?: string } {
  if (!(error instanceof Error)) return { name: "UnknownError", message: String(error) };
  return {
    name: error.name,
    message: error.message,
    ...(error.stack ? { stack: error.stack } : {}),
  };
}
