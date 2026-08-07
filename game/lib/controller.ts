import type { NS, Server } from "@ns";
import { capsDelta } from "../../shared/features/unlock.ts";
import { resyncHeap, WORKER_SCRIPT } from "./dispatch-driver.ts";
import { dodge } from "./dodge.ts";
import { isScriptDeath } from "./errors.ts";
import { hackingState, resetHackingState, takeTargetSwitch } from "./features/hacking.ts";
import { FEATURE_DRIVERS, selectDue } from "./features/index.ts";
import { gameGlobal } from "./globals.ts";
import {
  canRoot,
  deployWorker,
  listPortOpeners,
  reapStrayScripts,
  reclaimFleet,
  rootServers,
} from "./net.ts";
import { dodgeBudget, initProbeRunner, runProbes } from "./probe-runner.ts";
import { collectServers } from "./scan.ts";
import { caps, initState, set, type GameState } from "./state.ts";
import { republish, type TelemetrySink } from "./telemetry-sink.ts";
import type { Telemetry } from "./telemetry.ts";

/** The core loop.
 *
 * Structure, and the reason for it: everything that READS the game writes to
 * the store (./state.ts) unconditionally; the feature drivers decide from the
 * store; telemetry is one flush at the end of the tick. A --perf build scans,
 * roots, deploys, probes, gates and dispatches identically — it just never
 * opens a socket. Every `TELEMETRY:` guard in this file wraps a send and
 * nothing else.
 *
 * Dispatcher pass cadence: one HWGW spacer. Ticks use absolute deadlines with
 * a catch-up clamp so a game stall cannot produce a burst of passes. */
const TICK_MS = 200;
const PLAYER_EVERY_TICKS = 10; // 2s
const SWEEP_EVERY_TICKS = 150; // 30s

export async function runController(
  ns: NS,
  tel: Telemetry | undefined,
  sink: TelemetrySink | undefined,
  mode: "cold" | "handoff",
  epoch: number,
): Promise<void> {
  TELEMETRY: if (__TELEMETRY__) tel!.event("start.boot", { mode, build: __BUILD_ID__, epoch });
  ns.tprint(`start.js online (${mode}, build ${__BUILD_ID__})`);

  const state = initState();
  const probes = initProbeRunner();

  // Sentinel opener count (legacy watchHuman trick): guarantees the first
  // sweep always roots + deploys, which covers the cold-boot dead fleet.
  let openerCount = -1;
  let reportedRespawnFailure: string | undefined;
  let nextTick = Date.now();
  // A BitNode reset makes the next sweep behave like a cold boot: the fleet
  // the heap describes has ceased to exist.
  let coldSweep = mode === "cold";

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

    if (tick % PLAYER_EVERY_TICKS === 0) set(state, "player", ns.getPlayer());

    if (tick % SWEEP_EVERY_TICKS === 0) {
      openerCount = await sweep(ns, state, tel, coldSweep, openerCount);
      coldSweep = false;

      // Acquisition, last in the sweep: pure observation, so it yields to
      // rooting and deployment for the dodge mutex. The runner prices itself
      // against whatever home RAM the heap left free.
      const before = caps(state);
      await runProbes(ns, probes, state);
      const delta = capsDelta(before, caps(state));

      if (delta.bitNodeChanged) {
        onBitNodeReset(state);
        // Rescan and reclaim NOW, not on the next sweep. Waiting would leave
        // the dispatcher with no world to farm for 30 s, and would leave the
        // new node's orphans holding RAM for just as long. The sentinel
        // opener count forces the root pass to run: a fresh node owns no
        // crackers and has nothing rooted.
        openerCount = await sweep(ns, state, tel, true, -1);
        TELEMETRY: if (__TELEMETRY__) {
          republish(state);
          tel!.event("bitnode.reset", { to: caps(state).bitNode });
        }
      }
      for (const id of delta.unlocked) {
        // Tick the newly-playable feature on the next pass rather than making
        // it wait out a cadence it was never eligible for.
        delete state.featureLastRun[id];
        TELEMETRY: if (__TELEMETRY__) tel!.event("feature.unlocked", { feature: id });
      }
      TELEMETRY: if (__TELEMETRY__ && delta.locked.length > 0) {
        tel!.event("feature.locked", { features: delta.locked });
      }
    }

    // Feature pass: every driver whose capability gate is open and whose
    // cadence is due.
    const now = Date.now();
    const servers = state.topics.servers;
    const budgetGb = servers ? dodgeBudget(servers) : 0;
    const active = caps(state);
    for (const driver of selectDue(FEATURE_DRIVERS, state.featureLastRun, active, now)) {
      state.featureLastRun[driver.id] = now;
      try {
        await driver.tick({ ns, state, caps: active, budgetGb, tick });
      } catch (error) {
        // One feature must never take the loop down with it — but a kill is
        // not a feature bug. ScriptDeath comes out of whatever ns call the
        // driver was awaiting when the script was killed; swallowing it would
        // turn "we were killed" into a retry loop that reports a crash every
        // tick until the next await happens to rethrow.
        if (isScriptDeath(error)) throw error;
        TELEMETRY: if (__TELEMETRY__) {
          tel!.event("feature.failed", { feature: driver.id, error: String(error) });
        }
      }
    }

    const switched = takeTargetSwitch();
    TELEMETRY: if (__TELEMETRY__ && switched) tel!.event("farm.targetSwitch", switched);

    TELEMETRY: if (__TELEMETRY__) sink!.flush(state);

    // Absolute deadline with catch-up clamp (legacy accumulated drift).
    nextTick += TICK_MS;
    const clock = Date.now();
    if (nextTick < clock - TICK_MS) nextTick = clock;
    await ns.sleep(Math.max(0, nextTick - clock));
  }
}

/** Network sweep: scan, reclaim, root, deploy, reap, reconcile. Returns the
 * opener count to carry into the next sweep.
 *
 * Controller-level rather than a feature driver, because a rooted fleet is
 * what every feature spends — hacking is only its first customer. Every step
 * is dodged, so none of it is charged to the controller's static RAM. */
async function sweep(
  ns: NS,
  state: GameState,
  tel: Telemetry | undefined,
  cold: boolean,
  openerCount: number,
): Promise<number> {
  // 1) Scan the whole network (typed snapshot -> store + UI).
  set(state, "servers", await dodge(ns, collectServers));

  // 1a) Cold boot: this realm is fresh, so every script still running is an
  //     orphan whose RAM we can never account for. Reclaim the fleet once,
  //     before the dispatcher tries to allocate anything.
  if (cold) {
    const self = ns.pid;
    const snapshot = state.topics.servers!;
    const reclaimed = await dodge(ns, (stubNs) => reclaimFleet(stubNs, snapshot, self), 1.5);
    if (reclaimed.length > 0) {
      ns.tprint(`reclaimed ${reclaimed.length} host(s) from orphaned scripts`);
      TELEMETRY: if (__TELEMETRY__) tel!.event("fleet.reclaimed", { hosts: reclaimed });
    }
    set(state, "servers", await dodge(ns, collectServers));
  }

  const servers = state.topics.servers!;
  const driver = hackingState();

  // 2) Root anything newly rootable.
  const openers = await dodge(ns, listPortOpeners, 0.5);
  const rootable = Object.values(servers).filter((s: Server) => !s.hasAdminRights && canRoot(s, openers));
  if (openers.length !== openerCount || rootable.length > 0) {
    openerCount = openers.length;
    if (rootable.length > 0) {
      const hosts = rootable.map((s: Server) => s.hostname);
      const rooted = await dodge(ns, (stubNs) => rootServers(stubNs, hosts, openers), 1);
      for (const host of rooted) servers[host]!.hasAdminRights = true;
      TELEMETRY: if (__TELEMETRY__) tel!.event("net.rooted", { hosts: rooted, openers });
    }
  }

  // 3) Deploy the puppet worker (dodged: scp stays out of our RAM bill).
  const deployed = await dodge(ns, (stubNs) => deployWorker(stubNs, WORKER_SCRIPT, servers), 1);
  for (const host of deployed) driver.deployed.add(host);

  // 3a) Safety net: retire old architectures and kill unreachable workers.
  //     Liveness comes from the realm registry (survives build handoffs),
  //     never from this instance's ledger.
  const registered = new Set(driver.globals.worker_info?.keys() ?? []);
  const reaped = await dodge(ns, (stubNs) => reapStrayScripts(stubNs, deployed, WORKER_SCRIPT, registered), 1);
  TELEMETRY: if (__TELEMETRY__ && (reaped.workers > 0 || reaped.retired > 0)) {
    tel!.event("fleet.reaped", reaped);
  }

  // 4) Reconcile the heap with the game's real usage.
  const drifted = resyncHeap(driver, servers);
  TELEMETRY: if (__TELEMETRY__ && drifted.length > 0) tel!.event("heap.resync", { hosts: drifted });

  return openerCount;
}

/** A node reset under a live realm: everything derived from the world we left
 * describes a game that no longer exists. Drop all of it and re-arm the
 * multiplier latch.
 *
 * That includes the server snapshot. The sweep scans before the gate batch
 * reports the new node, so whether that scan saw the old world or the new one
 * depends on exactly when the reset landed — and a snapshot that is only
 * probably fresh is the same class of bug as the heap describing a dead fleet.
 * The caller rescans immediately rather than keeping it. */
function onBitNodeReset(state: GameState): void {
  resetHackingState();
  state.featureLastRun = {};
  gameGlobal.farmTarget = undefined;
  delete state.topics.servers;
  // Cumulative totals live in the dispatcher stats that resetHackingState just
  // cleared; dropping the last rollups stops the UI showing the old node's
  // earnings until the next one lands.
  delete state.topics.farm;
  delete state.topics.fleet;
  if (state.topics.progression) delete state.topics.progression.multipliers;
}
