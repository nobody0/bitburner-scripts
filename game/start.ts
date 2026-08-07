import type { NS, Server } from "@ns";
import { dodge } from "./lib/dodge.ts";
import { gameGlobal } from "./lib/globals.ts";
import {
  canRoot,
  collectProcesses,
  deployStarters,
  listPortOpeners,
  planDeploy,
  rootServers,
} from "./lib/net.ts";
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

const TICK_MS = 2_000;
const SWEEP_EVERY_TICKS = 15;

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

  // Migration: retire the pre-startup-phase main.js if it is still running
  // (it would respawn-loop on the next build push). Harmless no-op otherwise.
  await dodge(ns, (stubNs) => stubNs["scriptKill"]("main.js", "home"), 1);

  // Sentinel opener count (legacy watchHuman trick): guarantees the first
  // sweep always roots + deploys, which covers the cold-boot dead fleet.
  let openerCount = -1;
  let currentTarget = mode === "handoff" ? (gameGlobal.starterTarget ?? "") : "";
  let reportedRespawnFailure: string | undefined;

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

    const player = g.getPlayer();
    gameGlobal.player = player;

    if (tick % SWEEP_EVERY_TICKS === 0) {
      // 1) Scan the whole network (typed snapshot -> globals + UI).
      const servers = await dodge(ns, collectServers);
      gameGlobal.servers = servers;
      TELEMETRY: if (__TELEMETRY__) tel!.state("servers", servers);

      // 2) Root anything newly rootable. Openers change rarely (the player
      //    buys/creates an .exe), so the sentinel + count comparison keeps
      //    this sweep cheap.
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

      // 3) Spread the starter worker onto every useful rooted server. The
      //    target choice is a placeholder heuristic — the real targeting
      //    engine is the next phase (spec/targeting.md).
      const target = pickStarterTarget(servers, player.skills.hacking);
      const retarget = target !== currentTarget && currentTarget !== "";
      const processes = await dodge(ns, (stubNs) => collectProcesses(stubNs, Object.keys(servers)), 0.5);
      const plans = planDeploy(servers, processes, target);
      const deployed = await dodge(ns, (stubNs) => deployStarters(stubNs, plans, target), 2.5);
      if (deployed.started.length > 0 || deployed.failed.length > 0 || retarget) {
        TELEMETRY: if (__TELEMETRY__) {
          tel!.event("net.deployed", {
            target,
            retarget,
            started: deployed.started,
            failed: deployed.failed,
            hosts: plans.length,
          });
        }
      }
      currentTarget = target;
      gameGlobal.starterTarget = target;
    }

    await ns.sleep(TICK_MS);
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

/** Placeholder until the targeting phase: richest x fastest-growing server we
 * can already hack (same shape as the sim planner's pickTarget). */
function pickStarterTarget(servers: Record<string, Server>, skill: number): string {
  const candidates = Object.values(servers).filter(
    (s) =>
      s.hasAdminRights &&
      !s.purchasedByPlayer &&
      s.hostname !== "home" &&
      (s.moneyMax ?? 0) > 0 &&
      (s.requiredHackingSkill ?? 1) <= skill,
  );
  candidates.sort((a, b) => (b.moneyMax ?? 0) * (b.serverGrowth ?? 0) - (a.moneyMax ?? 0) * (a.serverGrowth ?? 0));
  return candidates[0]?.hostname ?? "n00dles";
}
