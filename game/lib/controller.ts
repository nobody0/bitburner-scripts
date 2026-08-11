import type { NS } from "@ns";
import type { FeatureOverrides } from "../../shared/features/profile.ts";
import { capsDelta, type Capabilities } from "../../shared/features/unlock.ts";
import type { HostRam } from "../../shared/ram/placement.ts";
import type { Claim, SlotState } from "../../shared/strategy/arbiter.ts";
import { classifyReset, type PrestigeKind, type ResetIdentity } from "../../shared/reset.ts";
import { coordinate, emptyDigest, postNeeds, type Coordination } from "../../shared/strategy/coordination.ts";
import type { Need } from "../../shared/strategy/needs.ts";
import { forecastAt, unknownForecast, usableForecastSec } from "../../shared/strategy/progression/forecast.ts";
import { FEATURE_IDS } from "../../shared/features/ids.ts";
import { fleetDodgeReserveGb, homeReserveGb } from "../../shared/ram/reserve.ts";
import { priceCalls } from "./dodge.ts";
import { isScriptDeath } from "./errors.ts";
import { ContributionCache } from "./features/contributions.ts";
import { hackingState, pumpOnWake, takeTargetSwitch } from "./features/hacking.ts";
import { armWake, sleepOrWake } from "./wake.ts";
import { workerGlobals } from "./worker-shared.ts";
import { takeRouteChange } from "./features/remaining.ts";
import { driverEnabled, featureModule, featureRamDemand, grantsFor, resetAllFeatures, selectDueModules } from "./features/index.ts";
import type { ClaimContext, NeedContext } from "./features/index.ts";
import { sweepFleet } from "./fleet.ts";
import { gameGlobal } from "./globals.ts";
import { dodgeBudget, initProbeRunner, runGateProbe, runProbes } from "./probe-runner.ts";
import { ALL_PROBES, probeCadenceMs } from "./probes/index.ts";
import { acquireDodge, dodgeHosts } from "./ram.ts";
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
export const TICK_MS = 200;
const PLAYER_EVERY_TICKS = 10; // 2s
/** The fleet sweep: scan, root, deploy, and the capability gate whose delta the
 *  reset walk keys off. Genuinely 30 s work — it is not the probe cadence, which
 *  it used to be by accident. */
const SWEEP_EVERY_TICKS = 150; // 30s
/** How long the demand-driven fleet reserve stays engaged after the last
 * probe-starvation report, so it cannot flap at probe cadence. */
const FLEET_RESERVE_HOLD_MS = 600_000;
/** Acquisition cadence, DERIVED from the probe table rather than chosen here.
 *
 *  Whatever the fastest `everyMs` in the table is, that is how often the runner is
 *  called; each probe's own `everyMs` gates it from there. So a feature declares
 *  the cadence its subject needs and gets it, instead of silently inheriting the
 *  sweep's — which is what made the local tier ask for 5 s and receive 30 s for
 *  the whole life of the project.
 *
 *  Floored at one tick: nothing can be read faster than the frame. A probe whose
 *  cadence rounds down to a single tick will therefore be sampled more often than
 *  it asked for, so a probe consumer must be idempotent under oversampling. */
export const PROBE_EVERY_TICKS = Math.max(1, Math.floor(probeCadenceMs(ALL_PROBES) / TICK_MS));

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
  // The fleet reserve (home-reserve shortfall spilled onto a fleet host) is
  // DEMAND-DRIVEN: it engages only while probes actually report themselves
  // unaffordable, and holds for a while so it does not flap at probe cadence.
  // A standing reserve taxed every small-fleet profile ~10-25% of its farm for
  // insurance most runs never needed; a starving profile (BN8's market
  // sampler) latches it within one sweep.
  let fleetReserveHoldUntil = 0;
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

    if (tick % PLAYER_EVERY_TICKS === 0) {
      set(state, "player", ns.getPlayer());
      state.playerObservedAt = Date.now();
    }

    if (tick % SWEEP_EVERY_TICKS === 0) {
      await sweepFleet(ns, state, tel, coldSweep);
      coldSweep = false;

      // The capability gate, last in the sweep: pure observation, so it yields to
      // rooting and deployment for the dodge mutex. It prices itself against the
      // whole realm's spare RAM, not just home's — a probe that cannot fit a
      // 4.5 GB home reserve may fit a rooted 64 GB client comfortably
      // (shared/ram/placement.ts).
      //
      // The gate belongs to the sweep and not to the acquisition cadence below,
      // in both directions: capabilities change on the scale of a BitNode, and
      // this is the one reading the controller must be able to ACT on — the reset
      // walk keys off the prestige epochs, and a reset detected between sweeps would
      // leave the fleet and every cached decision describing a dead game.
      //
      // Captured BEFORE it: the gate batch overwrites lastNodeReset with the NEW
      // node's start the moment a reset is observed, so the old node's start —
      // the thing its elapsed time is measured from — is only readable first.
      const previousProgression = state.topics.progression;
      const previousReset = resetIdentity(previousProgression);
      const nodeStartedAt = previousProgression?.lastNodeReset;
      const before = caps(state);
      const gateHosts = placement(state);
      await runGateProbe(ns, state, gateHosts, (gb) =>
        acquireDodge(gateHosts, hackingState().memory.dispatch.heap, gb),
      );
      const delta = capsDelta(before, caps(state));
      const currentReset = resetIdentity(state.topics.progression);
      const resetKind = classifyReset(previousReset, currentReset);

      if (resetKind !== "none") {
        // Emitted FIRST — before the reset walk deletes the plan and before
        // the awaited rescan below gets a chance to throw. This is the one
        // record that closes the guess-vs-actual calibration loop for the
        // whole node (elapsed actual next to the last guess, matched offline
        // against the endgame.route decisions in the same run log); a failed
        // post-reset sweep must not be able to lose it. `capabilities`
        // already reports the new node — the gate batch is what detected the
        // change — and the plan still describes the node that just ended,
        // because the gate batch merges only gate fields.
        TELEMETRY: if (__TELEMETRY__) {
          if (resetKind === "bitnode") {
            const endedPlan = previousProgression?.plan;
            tel!.event("bitnode.reset", {
              to: currentReset!.currentNode,
              ...(previousReset !== undefined ? { from: previousReset.currentNode } : {}),
              ...(nodeStartedAt !== undefined ? { elapsedMs: Date.now() - nodeStartedAt } : {}),
              ...(endedPlan?.route !== undefined ? { route: endedPlan.route } : {}),
              ...(endedPlan && endedPlan.forecasts.node.state !== "unknown"
                ? { guessedEndAt: endedPlan.forecasts.node.expectedAt }
                : {}),
              ...(endedPlan?.decidedAt !== undefined ? { decidedAt: endedPlan.decidedAt } : {}),
            });
          } else {
            tel!.event("augmentation.reset", {
              ...(previousReset !== undefined ? { elapsedMs: Date.now() - previousReset.lastAugReset } : {}),
              fromAugCount: previousProgression?.augCount ?? 0,
              toAugCount: state.topics.progression?.augCount ?? 0,
            });
          }
        }
        onWorldReset(state, resetKind);
        merge(state, "progression", emptyDigest());
        workSlot = undefined;
        publishedCoordination = undefined;
        contributions.clear();
        // Rescan and reclaim NOW, not on the next sweep. Waiting would leave
        // the dispatcher with no world to farm for 30 s, and would leave the
        // new node's orphans holding RAM for just as long.
        await sweepFleet(ns, state, tel, true);
        TELEMETRY: if (__TELEMETRY__) republish(state);
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

    // Acquisition, on the probe table's OWN cadence rather than the sweep's.
    //
    // `PROBE_EVERY_TICKS` is derived from the fastest `everyMs` anything declares,
    // and each probe's own `everyMs` gates it from there — so a feature whose
    // subject has a clock of its own asks for that cadence and gets it, and a
    // ten-minute probe costs nothing extra for being scheduled alongside a fast
    // one. Adding a probe that needs to be read every second needs no change
    // here.
    //
    // Runs AFTER the sweep block so that on a sweep tick the gate lands first and
    // this pass sees fresh capabilities and a fresh scan — the ordering the sweep
    // used to give it by construction.
    if (tick % PROBE_EVERY_TICKS === 0) {
      const probeHosts = placement(state);
      await runProbes(ns, probes, state, probeHosts, (gb) =>
        acquireDodge(probeHosts, hackingState().memory.dispatch.heap, gb),
      );
    }

    // Feature pass, refresh/act: refresh (evaluate -> store) -> collect
    // (pure) -> arbitrate (pure) -> tick (act). Splitting it this way is what
    // lets features coordinate at all — every due feature's published state
    // and wants are known before any of them acts, so the endgame route, the
    // single Player.currentWork slot and the money pool are each decided once
    // rather than claimed by whoever the loop happened to reach first.
    const now = Date.now();
    const active = caps(state);
    const hosts = placement(state);
    const budgetGb = dodgeBudget(hosts);
    const {
      reserveGb,
      fleetReserveGb: reserveShortfallGb,
      contiguousFleetReserveGb,
    } = computeReserve(state, active);
    // A live starvation re-records its skip on every retry; an entry that has
    // stopped refreshing is a need that went away without a successful retry
    // (dodge.ts only deletes on grant+lease). Age those out here, or one dead
    // entry re-arms the reserve hold for the rest of the run.
    for (const [id, skip] of Object.entries(state.probeSkips)) {
      if (skip.at !== undefined && Date.now() - skip.at > FLEET_RESERVE_HOLD_MS) delete state.probeSkips[id];
    }
    if (reserveShortfallGb > 0 && Object.keys(state.probeSkips).length > 0) {
      fleetReserveHoldUntil = Date.now() + FLEET_RESERVE_HOLD_MS;
    }
    // BN8 starts with the market API and hacked cash is worthless. Reserve the
    // spill host from the first pass so fallback prep/experience work cannot
    // occupy it for a full weaken cycle before the market sampler first runs.
    // Other nodes retain the demand-driven hold and its zero steady-state cost.
    const stockPrimary = active.bitNode === 8;
    const fleetReserveGb = reserveShortfallGb > 0 && (stockPrimary || Date.now() < fleetReserveHoldUntil)
      // The standing BN8 reserve must fit the executable stub, not just its
      // dynamic calls. Otherwise an XP worker can consume the apparent slack
      // and make the market action miss its tick.
      ? (stockPrimary ? contiguousFleetReserveGb : reserveShortfallGb)
      : 0;
    const dueModules = selectDueModules(state.featureLastRun, active, now);

    // A locked/disabled feature cannot leave a stale need, reservation or slot
    // claim behind merely because it will never become due again.
    for (const id of FEATURE_IDS) {
      if (driverEnabled(featureModule(id).driver, active)) continue;
      contributions.remove(id);
    }

    // 0) Refresh: evaluation only, before any need, claim or tick. Each due
    //    module re-derives its published digest from the store. The meta
    //    module (progression) refreshes LAST so its endgame route decision
    //    reads every other feature's state as refreshed by THIS pass, not the
    //    previous one — the resolution of the "endgame needs the enriched
    //    state, features need the chosen route" ordering. The sort is stable,
    //    so everyone else keeps registry order.
    const needContext: NeedContext = { state, caps: active, now };
    const refreshOrder = [...dueModules].sort(
      (a, b) => Number(a.driver.id === "progression") - Number(b.driver.id === "progression"),
    );
    for (const module of refreshOrder) {
      if (!module.refresh) continue;
      try {
        module.refresh(needContext);
      } catch (error) {
        if (isScriptDeath(error)) throw error;
        TELEMETRY: if (__TELEMETRY__) {
          tel!.event("feature.failed", { feature: module.driver.id, phase: "refresh", error: String(error) });
        }
      }
    }

    // The route decision just published (or the standing one from an earlier
    // pass) is what every driver plans against below. Reset-sensitive value
    // reads the install forecast; persistent value reads the node forecast.
    // Both count down from their anchor and preserve unknown/stale explicitly.
    const plan = state.topics.progression?.plan;
    const horizons = plan?.forecasts
      ? {
          node: forecastAt(plan.forecasts.node, now),
          install: forecastAt(plan.forecasts.install, now),
        }
      : {
          node: unknownForecast(now, "unpublished-node", "progression has not produced a node forecast"),
          install: unknownForecast(now, "unpublished-install", "progression has not produced an install forecast"),
        };

    // 1) Needs first: a feature may bid harder BECAUSE another is blocked on
    //    it, so the board must be complete before any claim is collected.
    //
    //    Needs PERSIST between ticks, per poster. A need is a standing
    //    statement: "a backdoor on CSEC is wanted" does not stop being true on
    //    the ticks when its poster's driver is not due. Collecting only from
    //    due modules would show a 200 ms consumer an empty board on 149 of
    //    every 150 ticks, and it would never act on anything.
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
    const claimContext: ClaimContext = {
      ...needContext,
      budgetGb,
      board,
      horizons,
      ramPrice: (methods) => priceCalls(ns, methods),
    };
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
          fleetReserveGb,
          tick,
          board,
          grants: grantsFor(coordination.arbitration, driver.id),
          horizons,
          ...(plan?.route !== undefined ? { route: plan.route } : {}),
          // Placement is rebuilt AT CLAIM TIME, not from the pass-start
          // snapshot: the farm driver ticks earlier in this same loop and
          // re-packs every free fleet block, so a stale free-list best-fits
          // onto a host that is already full again — the live reserveOn check
          // then fails and the dodge starves for the whole pass (measured:
          // half the install profile's time-to-goal). The live heap also lets
          // the pick fall through to home's reserve, which exists for this.
          acquireDodge: (gb) => acquireDodge(placement(state), hackingState().memory.dispatch.heap, gb),
        });
      } catch (error) {
        // One feature must never take the loop down with it — but a kill is
        // not a feature bug. ScriptDeath comes out of whatever ns call the
        // driver was awaiting when the script was killed; swallowing it would
        // turn "we were killed" into a retry loop that reports a crash every
        // tick until the next await happens to rethrow.
        // Source: https://github.com/bitburner-official/bitburner-src/blob/3162fd2590e221eadd0c0fbd46151913f7c4c41c/src/Netscript/killWorkerScript.ts#L63-L91
        if (isScriptDeath(error)) throw error;
        TELEMETRY: if (__TELEMETRY__) {
          tel!.event("feature.failed", { feature: driver.id, error: String(error) });
        }
      }
    }

    const switched = takeTargetSwitch();
    TELEMETRY: if (__TELEMETRY__ && switched) tel!.event("farm.targetSwitch", switched);

    // The decision record for the calibration loop: the chosen route with its
    // per-part estimate breakdown, emitted only when the route CHANGES so the
    // log carries decisions, not heartbeats.
    const routeSwitch = takeRouteChange();
    TELEMETRY: if (__TELEMETRY__ && routeSwitch) tel!.event("endgame.route", routeSwitch);

    TELEMETRY: if (__TELEMETRY__) sink!.flush(state);

    // Absolute deadline with catch-up clamp; a `sleep(TICK_MS)` loop
    // accumulates drift instead.
    //
    // The sleep is raced against the worker-completion wake (game/lib/wake.ts):
    // a landing frees heap RAM immediately and — after a weaken — is the one
    // provable min-security instant, so the hacking driver gets an extra
    // trimmed pump right then instead of up to a full spacer later. The realm
    // timer (never ns.sleep — concurrent ns calls kill the script) is
    // sim-virtualized, so both worlds order this identically. Re-armed BEFORE
    // pumping so a completion landing during the pump is never lost.
    // Source: https://github.com/bitburner-official/bitburner-src/blob/3162fd2590e221eadd0c0fbd46151913f7c4c41c/src/Netscript/NetscriptHelpers.tsx#L398-L431
    nextTick += TICK_MS;
    let clock = Date.now();
    if (nextTick < clock - TICK_MS) nextTick = clock;
    let wakePromise = armWake(workerGlobals());
    while ((clock = Date.now()) < nextTick) {
      if ((await sleepOrWake(nextTick - clock, wakePromise)) === "tick") break;
      wakePromise = armWake(workerGlobals());
      if (active.unlocked["hacking"] !== "yes") continue;
      try {
        pumpOnWake(ns, state, active, reserveGb, fleetReserveGb, usableForecastSec(horizons.install));
      } catch (error) {
        if (isScriptDeath(error)) throw error;
        TELEMETRY: if (__TELEMETRY__) {
          tel!.event("feature.failed", { feature: "hacking", phase: "wake", error: String(error) });
        }
      }
    }
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
function computeReserve(
  state: GameState,
  active: Capabilities,
): { reserveGb: number; fleetReserveGb: number; contiguousFleetReserveGb: number } {
  const home = state.topics.servers?.["home"];
  const result = homeReserveGb({
    enabled: FEATURE_IDS.filter((id) => active.unlocked[id] === "yes"),
    demand: featureRamDemand(state, active),
    homeMaxRam: home?.maxRam ?? 8,
  });
  const previous = state.topics.progression?.homeReserve;
  if (!previous || previous.gb !== result.reserveGb || previous.capped !== result.capped) {
    merge(state, "progression", {
      homeReserve: {
        gb: result.reserveGb,
        capped: result.capped,
        ...(result.driver !== undefined ? { driver: result.driver } : {}),
      },
    });
  }
  // A capped reserve is not just REPORTED any more: the shortfall spills onto
  // the largest fleet host (dispatch syncTopology), so the feature step that
  // outgrew a small home still has a launch site. This is what keeps the
  // 10 GB market sampler alive on an 8 GB home once the farm fills the fleet.
  const fleetReserveGb = result.capped ? Math.max(0, result.wantedGb - result.reserveGb) : 0;
  return {
    reserveGb: result.reserveGb,
    fleetReserveGb,
    contiguousFleetReserveGb: fleetDodgeReserveGb(result),
  };
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

/** Prestige under a live realm: everything derived from the world we left
 * describes a game that no longer exists. Drop all of it and re-arm the
 * multiplier latch.
 *
 * That includes the server snapshot. The sweep scans before the gate batch
 * reports the new node, so whether that scan saw the old world or the new one
 * depends on exactly when the reset landed — and a snapshot that is only
 * probably fresh is the same class of bug as the heap describing a dead fleet.
 * The caller rescans immediately rather than keeping it. */
function onWorldReset(state: GameState, kind: PrestigeKind): void {
  // Every module's own reset, by registry walk rather than by name — module
  // state AND each feature's published topics, which is why the walk takes
  // the state. Naming features (or their topic fields) here is exactly the
  // coupling the registry removes: the per-field delete blacklist this used
  // to carry left one feature's topic alive across a reset, and the new
  // node's first route decision read the old run's Red Pill out of it.
  resetAllFeatures(state, kind);
  state.featureLastRun = {};
  state.mirrors = {};
  state.mirrorDirty.clear();
  state.probeFailures = {};
  state.probeSkips = {};
  delete state.probeBatch;
  gameGlobal.farmTarget = undefined;
  // The server snapshot is the fleet substrate's, owned by no feature; the
  // caller rescans immediately rather than keeping it.
  delete state.topics.servers;
}

function resetIdentity(progression: GameState["topics"]["progression"]): ResetIdentity | undefined {
  if (!progression) return undefined;
  return {
    currentNode: progression.bitNode,
    lastAugReset: progression.lastAugReset,
    lastNodeReset: progression.lastNodeReset,
  };
}
