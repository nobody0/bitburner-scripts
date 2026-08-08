import type { NS, Server } from "@ns";
import type { FeatureOverrides } from "../../shared/features/profile.ts";
import { capsDelta, type Capabilities } from "../../shared/features/unlock.ts";
import type { HostRam } from "../../shared/ram/placement.ts";
import type { Claim, SlotState } from "../../shared/strategy/arbiter.ts";
import { coordinate, emptyDigest, postNeeds, type Coordination } from "../../shared/strategy/coordination.ts";
import type { Need } from "../../shared/strategy/needs.ts";
import { DEFAULT_HORIZON_SEC } from "../../shared/strategy/progression/eta.ts";
import { FEATURE_IDS, type FeatureId } from "../../shared/features/ids.ts";
import { homeReserveGb } from "../../shared/ram/reserve.ts";
import { resyncHeap, WORKER_BASE_SCRIPT, workerScript } from "./dispatch-driver.ts";
import { dodge, dodgeStubScript, priceCalls } from "./dodge.ts";
import { isScriptDeath } from "./errors.ts";
import { ContributionCache } from "./features/contributions.ts";
import { hackingState, takeTargetSwitch } from "./features/hacking.ts";
import { driverEnabled, featureModule, featureRamDemand, grantsFor, resetAllFeatures, selectDueModules } from "./features/index.ts";
import type { ClaimContext, NeedContext } from "./features/index.ts";
import { gameGlobal } from "./globals.ts";
import {
  canRoot,
  deployFleet,
  listPortOpeners,
  reapStrayScripts,
  reclaimFleet,
  rootServers,
} from "./net.ts";
import { dodgeBudget, homeDodgeBudget, initProbeRunner, runProbes } from "./probe-runner.ts";
import { acquireDodge, dodgeHosts } from "./ram.ts";
import { collectServers } from "./scan.ts";
import { caps, initState, merge, set, type GameState } from "./state.ts";
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
  /** Injected feature switches. Absent in the game; a simulation supplies them
   *  to isolate one feature. A decision, so deliberately not behind TELEMETRY. */
  featureOverrides?: FeatureOverrides,
): Promise<void> {
  TELEMETRY: if (__TELEMETRY__) tel!.event("start.boot", { mode, build: __BUILD_ID__, epoch });
  ns.tprint(`start.js online (${mode}, build ${__BUILD_ID__})`);

  const state = initState();
  if (featureOverrides) state.featureOverrides = featureOverrides;
  const probes = initProbeRunner();

  // Sentinel opener count: guarantees the first sweep always roots + deploys,
  // which covers the cold-boot dead fleet.
  let openerCount = -1;
  let reportedRespawnFailure: string | undefined;
  let nextTick = Date.now();
  // A BitNode reset makes the next sweep behave like a cold boot: the fleet
  // the heap describes has ceased to exist.
  let coldSweep = mode === "cold";
  // Who holds Player.currentWork, carried between passes. The arbiter is pure,
  // so the incumbency it needs to protect a running activity from a marginally
  // better bidder has to live out here.
  let workSlot: SlotState | undefined;
  // Last coordination digest written to the store, so an unchanged board is
  // not rewritten every pass. `undefined` means "nothing posted".
  let publishedCoordination: string | undefined;
  // Standing needs, by poster. Replaced wholesale when that feature next
  // runs, so a satisfied need disappears the moment its poster stops asking.
  const contributions = new ContributionCache();

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
      // against the whole realm's spare RAM, not just home's — a probe that
      // cannot fit a 4.5 GB home reserve may fit a rooted 64 GB client
      // comfortably (shared/ram/placement.ts).
      const before = caps(state);
      const probeHosts = placement(state);
      await runProbes(ns, probes, state, probeHosts, (gb) =>
        acquireDodge(probeHosts, hackingState().memory.dispatch.heap, gb),
      );
      const delta = capsDelta(before, caps(state));

      if (delta.bitNodeChanged) {
        onBitNodeReset(state);
        merge(state, "progression", emptyDigest());
        workSlot = undefined;
        publishedCoordination = undefined;
        contributions.clear();
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

    // Feature pass, in three phases: collect (pure) -> arbitrate (pure) ->
    // tick. Splitting it this way is what lets features coordinate at all —
    // every due feature's wants are known before any of them acts, so the
    // single Player.currentWork slot and the money pool are allocated once
    // rather than claimed by whoever the loop happened to reach first.
    const now = Date.now();
    const active = caps(state);
    const hosts = placement(state);
    const budgetGb = dodgeBudget(hosts);
    const reserveGb = computeReserve(state, active);
    const dueModules = selectDueModules(state.featureLastRun, active, now);

    // A locked/disabled feature cannot leave a stale need, reservation or slot
    // claim behind merely because it will never become due again.
    for (const id of FEATURE_IDS) {
      if (driverEnabled(featureModule(id).driver, active)) continue;
      contributions.remove(id);
    }

    // 1) Needs first: a feature may bid harder BECAUSE another is blocked on
    //    it, so the board must be complete before any claim is collected.
    //
    //    Needs PERSIST between ticks, per poster. A need is a standing
    //    statement: "a backdoor on CSEC is wanted" does not stop being true on
    //    the ticks when its poster's driver is not due. Collecting only from
    //    due modules would show a 200 ms consumer an empty board on 149 of
    //    every 150 ticks, and it would never act on anything.
    const needContext: NeedContext = { state, caps: active, now };
    for (const module of dueModules) {
      if (!module.needs) continue;
      try {
        contributions.replaceNeeds(module.driver.id, module.needs(needContext));
      } catch (error) {
        if (isScriptDeath(error)) throw error;
        TELEMETRY: if (__TELEMETRY__) {
          tel!.event("feature.failed", { feature: module.driver.id, phase: "needs", error: String(error) });
        }
      }
    }
    const needs: Need[] = contributions.needs();

    // 2) Claims, collected against the completed board.
    const board = postNeeds(needs);
    const claimContext: ClaimContext = { ...needContext, budgetGb, board, ramPrice: (methods) => priceCalls(ns, methods) };
    const transientClaims: Claim[] = [];
    for (const module of dueModules) {
      if (!module.claims) {
        contributions.replaceClaims(module.driver.id, []);
        continue;
      }
      try {
        const fresh = module.claims(claimContext);
        transientClaims.push(...contributions.replaceClaims(module.driver.id, fresh));
      } catch (error) {
        if (isScriptDeath(error)) throw error;
        TELEMETRY: if (__TELEMETRY__) {
          tel!.event("feature.failed", { feature: module.driver.id, phase: "claims", error: String(error) });
        }
      }
    }
    const claims: Claim[] = contributions.claims(transientClaims);

    // 3) One pure allocation of money, the work slot and dodge RAM.
    const coordination = coordinate({
      now,
      money: state.topics.player?.money ?? 0,
      ramGb: budgetGb,
      board,
      claims,
      ...(workSlot ? { slot: workSlot } : {}),
    });
    workSlot = coordination.arbitration.slot;
    publishedCoordination = publishCoordination(state, coordination.digest, publishedCoordination);

    // 4) Tick each due driver with its own share.
    for (const module of dueModules) {
      const driver = module.driver;
      state.featureLastRun[driver.id] = now;
      try {
        await driver.tick({
          ns,
          state,
          caps: active,
          budgetGb,
          dodgeHosts: hosts,
          homeReserveGb: reserveGb,
          tick,
          board,
          grants: grantsFor(coordination.arbitration, driver.id),
          horizonSec: DEFAULT_HORIZON_SEC,
          acquireDodge: (gb) => acquireDodge(hosts, hackingState().memory.dispatch.heap, gb),
        });
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

    // Absolute deadline with catch-up clamp; a `sleep(TICK_MS)` loop
    // accumulates drift instead.
    nextTick += TICK_MS;
    const clock = Date.now();
    if (nextTick < clock - TICK_MS) nextTick = clock;
    await ns.sleep(Math.max(0, nextTick - clock));
  }
}

/** Where a dodge stub may run right now, and how much room each host has.
 *
 * Built from the two ledgers the controller already holds — the sweep's scan
 * and the dispatcher's heap — so it costs no ns call. The deployed set is the
 * sweep's own record of which hosts it has scp'd to this session; since the
 * sweep copies the worker and the stub together, "the worker is here" and "the
 * stub is here" are the same fact. */
function placement(state: GameState): HostRam[] {
  const servers = state.topics.servers;
  if (!servers) return [];
  const fleet = hackingState();
  return dodgeHosts(servers, fleet.deployed, fleet.memory.dispatch.heap);
}

/** Home RAM to keep out of the dispatcher's hands this pass.
 *
 * Recomputed rather than constant because it depends on which features are
 * unlocked: each declares the largest dodge step it needs, and the reserve has
 * to cover the biggest of them or that feature's probe is unaffordable forever
 * (see shared/ram/reserve.ts). A reserve that had to be capped is written to
 * the store as a blocker — the feature is not silently starved. */
function computeReserve(state: GameState, active: Capabilities): number {
  const home = state.topics.servers?.["home"];
  const result = homeReserveGb({
    enabled: FEATURE_IDS.filter((id) => active.unlocked[id] === "yes"),
    demand: featureRamDemand(),
    homeMaxRam: home?.maxRam ?? 8,
  });
  const previous = state.topics.progression?.homeReserve;
  if (!previous || previous.gb !== result.reserveGb || previous.capped !== result.capped) {
    merge(state, "progression", {
      homeReserve: {
        gb: result.reserveGb,
        capped: result.capped,
        ...(result.driver !== undefined ? { driver: result.driver } : {}),
        why: result.why,
      },
    });
  }
  return result.reserveGb;
}

/** Write the coordination digest into the store, but only when it changed.
 *
 * Store writes are unconditional (the acquisition rule), so this runs in a
 * --perf build exactly as it does in a telemetry build. The change filter is
 * therefore not a telemetry optimisation, it is what keeps the machinery
 * genuinely free while nothing is using it: a hacking-only run posts no needs
 * and no claims, `digest` is undefined every pass, and nothing is ever
 * written or marked dirty.
 *
 * Returns the new published-digest marker for the caller to carry. */
function publishCoordination(
  state: GameState,
  digest: Coordination["digest"],
  published: string | undefined,
): string | undefined {
  if (digest === undefined) {
    // Nothing posted. Clear once — a stale board left on screen after the
    // feature that posted it went quiet reads as "still blocked" when the
    // truth is "nobody asked".
    if (published !== undefined) merge(state, "progression", emptyDigest());
    return undefined;
  }
  const encoded = JSON.stringify(digest);
  if (encoded === published) return published;
  merge(state, "progression", digest);
  return encoded;
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

  // 3) Deploy the fleet payload — puppet worker AND dodge stub — so any rooted
  //    host can serve a dodge (dodged: scp stays out of our RAM bill).
  const deployed = await dodge(ns, (stubNs) => deployFleet(stubNs, [workerScript(), dodgeStubScript()], servers), 1);
  for (const host of deployed) driver.deployed.add(host);

  // 3a) Safety net: retire old architectures and kill unreachable workers.
  //     Liveness comes from the realm registry (survives build handoffs),
  //     never from this instance's ledger.
  const registered = new Set(driver.globals.worker_info?.keys() ?? []);
  const reaped = await dodge(ns, (stubNs) => reapStrayScripts(stubNs, deployed, WORKER_BASE_SCRIPT, registered), 1);
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
  // Every module's own reset, by registry walk rather than by name. Naming
  // features here is exactly the coupling the module registry removes: a new
  // feature that caches anything across a node reset would otherwise leak
  // silently until someone remembered to edit this function.
  resetAllFeatures();
  state.featureLastRun = {};
  gameGlobal.farmTarget = undefined;
  delete state.topics.servers;
  // Cumulative totals live in the dispatcher stats the reset walk above just
  // cleared; dropping the last rollups stops the UI showing the old node's
  // earnings until the next one lands.
  delete state.topics.farm;
  delete state.topics.fleet;
  if (state.topics.progression) delete state.topics.progression.multipliers;
}
