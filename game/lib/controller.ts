import type { NS } from "@ns";
import type { FeatureOverrides } from "../../shared/features/profile.ts";
import { roundSigFigs } from '../../shared/format.ts';
import { capsDelta } from "../../shared/features/unlock.ts";
import type { Claim, SlotState } from "../../shared/strategy/arbiter.ts";
import { classifyReset, type PrestigeKind, type ResetIdentity } from "../../shared/reset.ts";
import { coordinate, emptyDigest, postNeeds, type Coordination } from "../../shared/strategy/coordination.ts";
import type { Need } from "../../shared/strategy/needs.ts";
import { forecastAt, unknownForecast, usableForecastSec } from "../../shared/strategy/progression/forecast.ts";
import { FEATURE_IDS } from "../../shared/features/ids.ts";
import { HOME_RESERVE_GB, ramArena, type ArenaPlan, type BrokerHost } from '../../shared/ram/broker.ts';
import { setProxyEventSink, type ProxyPlacer } from "./ns-proxy.ts";
import { disposeProxies, nsp, nspLong, residentAsks, setProxyPlacer } from "./proxies.ts";
import { isScriptDeath } from "./errors.ts";
import { bestIncomePerSec, bestReinvestmentReturnPerDollarSec, slotRates } from "./income.ts";
import { ContributionCache } from "./features/contributions.ts";
import { hackingState, pumpOnWake, takeTargetSwitch } from "./features/hacking.ts";
import { noteTickLateness, resetTickHealth } from "./tick-health.ts";
import { armWake, realmSleep, sleepOrWake } from "./wake.ts";
import { workerGlobals } from "./worker-shared.ts";
import { handoffLaunch, temporaryRunOptions } from "./launch-shared.ts";
import { takeRouteChange } from "./features/remaining.ts";
import { driverEnabled, featureModule, grantsFor, resetAllFeatures, selectDueModules } from "./features/index.ts";
import type { ClaimContext, NeedContext } from "./features/index.ts";
import { sweepFleet } from "./fleet.ts";
import { takeGateSignal } from "./gate-signal.ts";
import { gameGlobal } from "./globals.ts";
import { initProbeRunner, runGateProbe, runProbes } from "./probe-runner.ts";
import { ALL_PROBES, probeCadenceMs } from "./probes/index.ts";
import { caps, initState, merge, set, type GameState } from "./state.ts";
import { republish, type TelemetrySink } from "./telemetry-sink.ts";
import type { Telemetry } from "./telemetry.ts";

import { killWorkersForCritical, settleArenaShareExits } from './dispatch-driver.ts';

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
  TELEMETRY: if (__TELEMETRY__) {
    tel!.event("start.boot", { mode, build: __BUILD_ID__, epoch });
    // ns-proxy.ts has no `tel`; give it a sink so slow exec retries are
    // visible. Cleared alongside each dispose below so a superseded
    // controller's tel never receives a successor's events.
    setProxyEventSink((name, data) => tel!.event(name, data));
  }
  ns.tprint(`start.js online (${mode}, build ${__BUILD_ID__})`);

  const state = initState();
  if (featureOverrides) state.featureOverrides = featureOverrides;
  const probes = initProbeRunner();
  const buildArena = () =>
    ramArena(arenaHosts(state), residentAsks(), state.topics.farm?.moneyPerSecPerGb ?? 0);

  // Placement for an ns resident: the biggest block the fleet can offer,
  // between the floor its pending call needs and the budget it would like.
  //
  // Asking for a RANGE is what makes the resident track the fleet with no
  // ladder logic of its own. At cold boot only home's reserve exists, so it is
  // granted that; as n00dles and then foodnstuff root, the next respawn is
  // simply granted more. A resident stands for the whole run, so it prefers
  // the arena hosts the farm planner already keeps clear over a batcher host
  // whose RAM the dispatcher wants back.
  const placeResident: ProxyPlacer = (minGb, preferredGb) => {
    const heap = hackingState().memory.dispatch.heap;
    const arenaSet = new Set(buildArena().hosts);
    const hosts = arenaHosts(state);
    const host = hosts
      .filter((candidate) => candidate.rooted && candidate.deployed && candidate.freeGb >= minGb)
      .sort((a, b) =>
        Number(arenaSet.has(b.hostname)) - Number(arenaSet.has(a.hostname))
        || b.freeGb - a.freeGb
        || a.hostname.localeCompare(b.hostname))[0];
    if (!host) {
      // HOME'S RESERVE IS THE FLOOR, and it exists for exactly this.
      //
      // The fleet view is built BY a proxied call (`collectServers` in the
      // sweep) and it lags: on a cold boot there is no view at all, and after
      // one there is a snapshot that still counts the resident this respawn
      // just killed. Both make the sweep unplaceable, and an unplaceable sweep
      // never refreshes the view that would place it — the run deadlocks.
      //
      // `HOME_RESERVE_GB` is held farm-free unconditionally and is sized for
      // precisely this. So anything that fits the reserve places on home
      // without a lease, whatever the snapshot claims. Anything larger waits
      // for the arena's carve to open a real block.
      if (minGb > HOME_RESERVE_GB) return undefined;
      return { host: "home", gb: minGb, release: () => {} };
    }
    const gb = Math.round(Math.min(preferredGb, host.freeGb) * 100) / 100;
    // A host the heap does not describe (home before the first sweep) is taken
    // without a lease.
    if (heap?.host(host.hostname) === undefined) {
      return { host: host.hostname, gb, release: () => {} };
    }
    const lease = heap.reserveOn(host.hostname, gb, true);
    if (!lease) return undefined;
    return { host: host.hostname, gb, release: () => lease.release() };
  };

  // The residents were created in start.ts, sized to home, because the run
  // identity is read before this loop exists. Now that there is a fleet view,
  // hand them the real placer: the next respawn takes the best block going.
  setProxyPlacer(placeResident);

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
  // not rewritten every pass. Tracked per HALF — the needs board and the
  // arbiter's verdict are separate topics now and move at very different
  // rates, so one signature over both would republish the slow topic at the
  // fast one's rate. An empty record means "nothing posted".
  let publishedCoordination: CoordinationMarks = {};
  // Change-filtered: the arena moves only when the fleet or a resident's ask
  // does, and a state record republishes its whole topic.
  let publishedArena: string | undefined;
  // Standing needs, by poster. Replaced wholesale when that feature next
  // runs, so a satisfied need disappears the moment its poster stops asking.
  const contributions = new ContributionCache();

  for (let tick = 0; ; tick++) {
    // Yield to a newer controller (manual restart, double autoexec, handoff).
    if (gameGlobal.controllerEpoch !== epoch) {
      TELEMETRY: if (__TELEMETRY__) {
        tel!.event("start.superseded", { epoch });
        tel!.dispose();
        setProxyEventSink(undefined);
      }
      // Unconditional, and outside the telemetry label: a superseded
      // controller that leaves its residents running holds their RAM for the
      // rest of the run, and the successor cannot see them to reap them.
      await disposeProxies();
      return;
    }

    // Self-update: a newer build was pushed -> hand off to a fresh instance.
    const pushedBuild = ns.read("build-id.txt").trim();
    if (pushedBuild !== "" && pushedBuild !== __BUILD_ID__) {
      // Share is the only worker mode with no natural completion/idle drain.
      // Resolve its descriptor-installed lifetime gate before handing control
      // to the new build; one-shots finish and pooled workers idle out.
      for (const [id, worker] of workerGlobals().worker_info ?? []) {
        if (worker.mode !== "share") continue;
        worker.stop?.();
        TELEMETRY: if (__TELEMETRY__) tel!.event("worker.retire", { id, mode: worker.mode });
      }
      const pid = await handoffLaunch(
        { kind: "start", buildId: pushedBuild },
        (launchId) => ns.exec("start.js", "home", temporaryRunOptions({ threads: 1 }), launchId),
      );
      if (pid !== 0) {
        TELEMETRY: if (__TELEMETRY__) {
          tel!.event("start.respawn", { from: __BUILD_ID__, to: pushedBuild });
          tel!.dispose();
            setProxyEventSink(undefined);
        }
        await disposeProxies();
        return;
      }
      if (reportedRespawnFailure !== pushedBuild) {
        reportedRespawnFailure = pushedBuild;
        TELEMETRY: if (__TELEMETRY__) {
          tel!.event("start.respawn_failed", { from: __BUILD_ID__, to: pushedBuild });
        }
        ns.tprint(`WARNING: failed to start build ${pushedBuild}; keeping ${__BUILD_ID__} online and retrying`);
      }
      // Realm timer, matching the main tick's `sleepOrWake`: this loop never
      // parks on an ns call, so no future async arm can trip the engine's
      // concurrency kill. The `ns.read` above surfaces a kill next pass.
      await realmSleep(TICK_MS);
      continue;
    }
    reportedRespawnFailure = undefined;

    // `playerDirty` short-circuits the cadence rather than replacing it: a
    // multiplier change makes the held snapshot wrong, not just old, and the
    // batcher derives every operation duration from it. Costs one extra
    // proxied read on the tick after such a change and nothing otherwise —
    // the 0.5 GB is the resident's, paid once for the run.
    if (tick % PLAYER_EVERY_TICKS === 0 || state.playerDirty) {
      set(state, "player", await nsp("getPlayer"));
      state.playerObservedAt = Date.now();
      state.playerDirty = false;
    }

    // Taken unconditionally so a recheck coinciding with a sweep tick still
    // clears the signal. The modulo keying keeps the 30 s cadence unshifted.
    const gateWake = takeGateSignal();
    if (gateWake || tick % SWEEP_EVERY_TICKS === 0) {
      await sweepFleet(ns, state, tel, coldSweep);
      coldSweep = false;

      // The capability gate, last in the sweep: pure observation, so it yields
      // to rooting and deployment.
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
      await runGateProbe(state);
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
        // Through publishDigest, so the ARBITRATION topic is cleared too. It
        // is its own record now; merging the empty digest into `progression`
        // only stamped a dead field there and left the previous node's grants,
        // denials and waterlines live for income.ts and hacking.ts to price
        // the new node's spending against.
        publishDigest(state, emptyDigest(), {});
        workSlot = undefined;
        publishedCoordination = {};
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
      await runProbes(ns, probes, state);
    }

    // Feature pass, refresh/act: refresh (evaluate -> store) -> collect
    // (pure) -> arbitrate (pure) -> tick (act). Splitting it this way is what
    // lets features coordinate at all — every due feature's published state
    // and wants are known before any of them acts, so the endgame route, the
    // single Player.currentWork slot and the money pool are each decided once
    // rather than claimed by whoever the loop happened to reach first.
    const now = Date.now();
    const active = caps(state);
    const arena = buildArena();
    const dueModules = selectDueModules(state.featureLastRun, active, now);
    const activeFeatures = new Set(
      FEATURE_IDS.filter((id) => driverEnabled(featureModule(id).driver, active)),
    );

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
    const needContext: NeedContext = { state, caps: active, now, activeFeatures };
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
      board,
      horizons,
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
    const claims: Claim[] = contributions.claims(transientClaims)
      .map((claim): Claim => {
        if (claim.shape !== "continuous") return claim;
        const valueCurve = featureModule(claim.by).valueCurve?.(claim, claimContext);
        return valueCurve ? { ...claim, valueCurve } : claim;
      });

    // 3) One pure allocation of money and the work slot.
    const coordination = coordinate({
      now,
      money: state.topics.player?.money ?? 0,
      board,
      claims,
      expectedIncomePerSec: bestIncomePerSec(state),
      rates: slotRates(state, board),
      reinvestmentReturnPerDollarSec: bestReinvestmentReturnPerDollarSec(state),
      // The remaining pool is deliberately not forwarded: a FeatureModule's
      // next rung is a pure function of its own ladder, and the arbiter
      // re-prices affordability itself on the following iteration.
      nextStep: (claim) => featureModule(claim.by).nextStep?.(claim, claimContext),
      ...(workSlot ? { slot: workSlot } : {}),
    });
    for (const warning of coordination.arbitration.warnings) ns.print("WARNING: " + warning);
    workSlot = coordination.arbitration.slot;
    publishedCoordination = publishCoordination(state, coordination.digest, publishedCoordination);

    // 4) Tick each due driver with its own share.
    for (const module of dueModules) {
      const driver = module.driver;
      state.featureLastRun[driver.id] = now;
      try {
        await driver.tick({
          ns,
          nsp,
          nspLong,
          state,
          caps: active,
          activeFeatures,
          arena,
          tick,
          board,
          grants: grantsFor(coordination.arbitration, driver.id),
          horizons,
          ...(plan?.route !== undefined ? { route: plan.route } : {}),
          freeCriticalRam: (neededGb) => killWorkersForCritical(ns, hackingState(), neededGb),
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

    publishedArena = publishArena(state, arena, publishedArena);

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
        // A worker releases real RAM before its completion is drained. Settle
        // only process exits, so the arena's reserve claims that exact block,
        // then run the planner with it visible as foreign usage.
        const arenaShareExits = settleArenaShareExits(hackingState());
        if (arenaShareExits.length === 0) {
          await pumpOnWake(ns, state, active, arena.reserves, usableForecastSec(horizons.install));
        }
        if (arenaShareExits.length > 0) {
          const wakeArena = buildArena();
          await pumpOnWake(ns, state, active, wakeArena.reserves, usableForecastSec(horizons.install));
        }
      } catch (error) {
        if (isScriptDeath(error)) throw error;
        TELEMETRY: if (__TELEMETRY__) {
          tel!.event("feature.failed", { feature: "hacking", phase: "wake", error: String(error) });
        }
      }
    }
    // How late this iteration actually reached its own deadline — the timer
    // fired late, or the pass before it overran. Both exits of the loop above
    // land here, and the quantity was already being computed for the catch-up
    // clamp at the top and discarded. It is the ground truth for main-thread
    // starvation: the engine's own cycle is driven by the same timer queue.
    noteTickLateness(Date.now() - nextTick);
  }
}

/** Where a resident may run right now, and how much room each host has.
 *
 * Built from the two ledgers the controller already holds — the sweep's scan
 * and the dispatcher's heap — so it costs no ns call. The deployed set is the
 * sweep's own record of which hosts it has scp'd to this session; since the
 * sweep copies the worker and the resident together, "the worker is here" and
 * "the resident is here" are the same fact. */
function arenaHosts(state: GameState): BrokerHost[] {
  const servers = state.topics.servers;
  if (!servers) return [];
  const fleet = hackingState();
  const heap = fleet.memory.dispatch.heap;
  return Object.values(servers).map((server) => ({
    hostname: server.hostname,
    maxRam: server.maxRam,
    freeGb: heap?.host(server.hostname)
      ? heap.freeOn(server.hostname, true)
      : Math.max(0, server.maxRam - server.ramUsed),
    rooted: server.hasAdminRights,
    deployed: server.hostname === 'home' || fleet.deployed.has(server.hostname),
  }));
}

function publishArena(state: GameState, arena: ArenaPlan, published: string | undefined): string {
  const sig3 = (value: number): number => roundSigFigs(value, 3);
  const digest = {
    hosts: arena.hosts,
    arenaGb: sig3(arena.arenaGb),
    targetGb: sig3(arena.targetGb),
    guaranteedDynamicGb: sig3(arena.guaranteedDynamicGb),
    farmCostPerSec: sig3(arena.farmCostPerSec),
  };
  const encoded = JSON.stringify(digest);
  if (encoded !== published) set(state, 'ramArena', digest);
  return encoded;
}
interface CoordinationMarks {
  needs?: string;
  arbitration?: string;
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
  published: CoordinationMarks,
): CoordinationMarks {
  if (digest === undefined) {
    // Nothing posted. Clear once — a stale board left on screen after the
    // feature that posted it went quiet reads as "still blocked" when the
    // truth is "nobody asked". Returning empty marks is what makes it once:
    // every later pass takes the line above and does no work at all.
    if (published.needs === undefined && published.arbitration === undefined) return published;
    publishDigest(state, emptyDigest(), {});
    return {};
  }
  return publishDigest(state, digest, published);
}

/** The needs board rides on `progression`; the arbiter's verdict is its own
 * topic. They are computed together but move at very different rates — the
 * board is stable for minutes, the verdict changes as the money does — and a
 * state record republishes its whole topic, so keeping them together made the
 * board pay the verdict's rate. */
function publishDigest(
  state: GameState,
  digest: NonNullable<Coordination["digest"]>,
  published: CoordinationMarks,
): CoordinationMarks {
  const needs = JSON.stringify(digest.needs);
  const arbitration = JSON.stringify(digest.arbitration);
  // Filtered per half, not over the pair. `merge` marks its topic dirty
  // unconditionally, so a combined signature republished the WHOLE of
  // `progression` — plan, multipliers, moneySources and all — every time the
  // verdict moved, which is nearly every pass. That is exactly the cost the
  // split was made to remove, and a single signature does not remove it.
  if (needs !== published.needs) merge(state, "progression", { needs: digest.needs });
  if (arbitration !== published.arbitration) set(state, "arbitration", digest.arbitration);
  return { needs, arbitration };
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
  delete state.probeBatch;
  gameGlobal.farmTarget = undefined;
  // Tick lateness measures this loop, not a feature, so it is reset here with
  // the rest of the controller's own state.
  resetTickHealth();
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
