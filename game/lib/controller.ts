import type { NS } from "@ns";
import type { FeatureOverrides } from "../../shared/features/profile.ts";
import { roundSigFigs } from '../../shared/format.ts';
import { capsDelta, type Capabilities } from "../../shared/features/unlock.ts";
import { PRIORITY, type Claim, type SlotState } from "../../shared/strategy/arbiter.ts";
import { classifyReset, type PrestigeKind, type ResetIdentity } from "../../shared/reset.ts";
import { coordinate, emptyDigest, postNeeds, type Coordination } from "../../shared/strategy/coordination.ts";
import type { Need } from "../../shared/strategy/needs.ts";
import { forecastAt, unknownForecast, usableForecastSec } from "../../shared/strategy/progression/forecast.ts";
import { FEATURE_IDS } from "../../shared/features/ids.ts";
import type { ArenaPlan, BrokerRequest } from '../../shared/ram/broker.ts';
import { priceCalls } from "./dodge.ts";
import { isScriptDeath } from "./errors.ts";
import { bestIncomePerSec, bestReinvestmentReturnPerDollarSec, slotRates } from "./income.ts";
import { ContributionCache } from "./features/contributions.ts";
import { hackingState, plannerPassId, pumpOnWake, takeTargetSwitch } from "./features/hacking.ts";
import { noteTickLateness, resetTickHealth } from "./tick-health.ts";
import { armWake, sleepOrWake } from "./wake.ts";
import { workerGlobals } from "./worker-shared.ts";
import { takeRouteChange } from "./features/remaining.ts";
import { driverEnabled, featureModule, grantsFor, resetAllFeatures, selectDueModules } from "./features/index.ts";
import type { ClaimContext, NeedContext } from "./features/index.ts";
import { isRamClaim, type FeatureClaim } from "./features/claims.ts";
import { sweepFleet } from "./fleet.ts";
import { gameGlobal } from "./globals.ts";
import { initProbeRunner, runGateProbe, runProbes } from "./probe-runner.ts";
import { ALL_PROBES, probeCadenceMs } from "./probes/index.ts";
import { brokerHosts, DodgeBrokerDriver } from "./ram.ts";
import { caps, initState, merge, set, type GameState } from "./state.ts";
import { republish, type TelemetrySink } from "./telemetry-sink.ts";
import type { Telemetry } from "./telemetry.ts";

import { reclaimForDodge, settleBrokerShareExits } from './dispatch-driver.ts';

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
  TELEMETRY: if (__TELEMETRY__) tel!.event("start.boot", { mode, build: __BUILD_ID__, epoch });
  ns.tprint(`start.js online (${mode}, build ${__BUILD_ID__})`);

  const state = initState();
  if (featureOverrides) state.featureOverrides = featureOverrides;
  const probes = initProbeRunner();
  const ramBroker = new DodgeBrokerDriver();
  const brokerStarvationReported = new Set<string>();
  // Every arena build reports the pooling verdict of the planner pass it can
  // see. Several builds share one pass — the sweep's gate arena, the probe
  // arena and the feature pass all run with no pump between them — so the pass
  // id is what stops the broker's demotion window from being spent inside a
  // single tick.
  const buildArena = (at: number) => {
    ramBroker.broker.observePooling(hackingState().memory.dispatch.pooling, plannerPassId());
    return ramBroker.broker.arena(brokerPlacement(state), at, state.topics.farm?.moneyPerSecPerGb ?? 0);
  };

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
  let publishedArena: string | undefined;
  // Broker arena publication is change-filtered; queue and demand state remain
  // unconditional game state even in a --perf build.
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
      const pid = ns.exec("start.js", "home", { threads: 1, temporary: true }, "handoff", pushedBuild);
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
      // cold-home arena may fit a rooted 64 GB client comfortably
      // once the broker can place it fleet-wide.
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
      const gateArena = buildArena(Date.now());
      await runGateProbe(ns, state, (gb, id) => brokerAcquire(
        ns, tel, ramBroker, state, gateArena, gb, { by: 'gate', id, lane: 'default', priority: PRIORITY['probe:gate'] },
      ));
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
      const probeArena = buildArena(Date.now());
      await runProbes(ns, probes, state, (gb, id) => brokerAcquire(
        ns, tel, ramBroker, state, probeArena, gb, { by: 'probe', id, lane: 'default', priority: PRIORITY['probe:background'] },
      ));
    }

    // Feature pass, refresh/act: refresh (evaluate -> store) -> collect
    // (pure) -> arbitrate (pure) -> tick (act). Splitting it this way is what
    // lets features coordinate at all — every due feature's published state
    // and wants are known before any of them acts, so the endgame route, the
    // single Player.currentWork slot and the money pool are each decided once
    // rather than claimed by whoever the loop happened to reach first.
    const now = Date.now();
    const active = caps(state);
    const arena = buildArena(now);
    // The broker queue owns RAM starvation. A request that cannot be placed
    // remains queued, and only a request that has actually waited past the
    // starvation threshold grows the arena on a later pass.
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
      ramPrice: (methods) => priceCalls(ns, methods),
    };
    const transientClaims: FeatureClaim[] = [];
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
    const allClaims = contributions.claims(transientClaims);
    const ramClaims = allClaims.filter(isRamClaim);
    const claims: Claim[] = allClaims
      .filter((claim): claim is Claim => !isRamClaim(claim))
      .map((claim): Claim => {
        if (claim.shape !== "continuous") return claim;
        const valueCurve = featureModule(claim.by).valueCurve?.(claim, claimContext);
        return valueCurve ? { ...claim, valueCurve } : claim;
      });

    // 3) One pure allocation of money, the work slot and dodge RAM.
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
          state,
          caps: active,
          activeFeatures,
          arena,
          tick,
          board,
          grants: grantsFor(coordination.arbitration, driver.id, ramClaims),
          horizons,
          ...(plan?.route !== undefined ? { route: plan.route } : {}),
          // Placement is rebuilt AT CLAIM TIME, not from the pass-start
          // snapshot: the farm driver ticks earlier in this same loop and
          // re-packs every free fleet block, so a stale free-list best-fits
          // onto a host that is already full again — the live reserveOn check
          // then fails and the dodge starves for the whole pass (measured:
          // half the install profile's time-to-goal). The live heap also lets
          // the pick fall through to home's reserve, which exists for this.
          acquireDodge: (gb, request) => brokerAcquire(ns, tel, ramBroker, state, arena, gb, request),
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

    const ready = ramBroker.drain(brokerPlacement(state), hackingState().memory.dispatch.heap, arena, Date.now());
    for (const request of ready) {
      if (FEATURE_IDS.includes(request.by as (typeof FEATURE_IDS)[number])) state.featureLastRun[request.by] = 0;
    }
    if (ready.some((request) => request.by === 'gate')) {
      await runGateProbe(ns, state, (gb, id) => brokerAcquire(
        ns, tel, ramBroker, state, arena, gb, { by: 'gate', id, lane: 'default', priority: PRIORITY['probe:gate'] },
      ));
    }
    if (ready.some((request) => request.by === 'probe')) {
      await runProbes(ns, probes, state, (gb, id) => brokerAcquire(
        ns, tel, ramBroker, state, arena, gb, { by: 'probe', id, lane: 'default', priority: PRIORITY['probe:background'] },
      ));
    }
    const brokerSnapshot = ramBroker.snapshot(Date.now());
    publishedArena = publishArena(state, arena, brokerSnapshot, publishedArena);
    TELEMETRY: if (__TELEMETRY__) {
      const starving = new Set(brokerSnapshot.starvation.map((request) => `${request.by}\0${request.id}\0${request.lane}`));
      for (const request of brokerSnapshot.starvation) {
        const key = `${request.by}\0${request.id}\0${request.lane}`;
        if (brokerStarvationReported.has(key)) continue;
        brokerStarvationReported.add(key);
        tel!.event('ram.starvation', { by: request.by, id: request.id, gb: request.gb, waitMs: request.waitMs, lane: request.lane });
      }
      for (const key of brokerStarvationReported) if (!starving.has(key)) brokerStarvationReported.delete(key);
    }

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
        // only process exits, let the broker lease that exact block, then run
        // the planner with the lease visible as foreign usage.
        const brokerShareExits = settleBrokerShareExits(hackingState());
        if (brokerShareExits.length === 0) {
          pumpOnWake(ns, state, active, arena.reserves, usableForecastSec(horizons.install));
        }
        const wakeArena = buildArena(Date.now());
        const wakeReady = ramBroker.drain(
          brokerPlacement(state),
          hackingState().memory.dispatch.heap,
          wakeArena,
          Date.now(),
        );
        if (brokerShareExits.length > 0) {
          pumpOnWake(ns, state, active, wakeArena.reserves, usableForecastSec(horizons.install));
        }
        for (const request of wakeReady) {
          if (FEATURE_IDS.includes(request.by as (typeof FEATURE_IDS)[number])) state.featureLastRun[request.by] = 0;
        }
        if (wakeReady.some((request) => request.by === 'gate')) {
          await runGateProbe(ns, state, (gb, id) => brokerAcquire(
            ns, tel, ramBroker, state, wakeArena, gb, { by: 'gate', id, lane: 'default', priority: PRIORITY['probe:gate'] },
          ));
        }
        if (wakeReady.some((request) => request.by === 'probe')) {
          await runProbes(ns, probes, state, (gb, id) => brokerAcquire(
            ns, tel, ramBroker, state, wakeArena, gb, { by: 'probe', id, lane: 'default', priority: PRIORITY['probe:background'] },
          ));
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

/** Where a dodge stub may run right now, and how much room each host has.
 *
 * Built from the two ledgers the controller already holds — the sweep's scan
 * and the dispatcher's heap — so it costs no ns call. The deployed set is the
 * sweep's own record of which hosts it has scp'd to this session; since the
 * sweep copies the worker and the stub together, "the worker is here" and "the
 * stub is here" are the same fact. */
function brokerPlacement(state: GameState) {
  const servers = state.topics.servers;
  if (!servers) return [];
  const fleet = hackingState();
  return brokerHosts(servers, fleet.deployed, fleet.memory.dispatch.heap);
}

function brokerAcquire(
  ns: NS,
  tel: Telemetry | undefined,
  driver: DodgeBrokerDriver,
  state: GameState,
  arena: ArenaPlan,
  gb: number,
  request: Omit<BrokerRequest, 'gb' | 'class'>,
) {
  const hosts = brokerPlacement(state);
  const brokerRequest = { ...request, gb, class: driver.broker.classify(gb, arena) };
  const acquired = driver.request(
    brokerRequest,
    hosts,
    hackingState().memory.dispatch.heap,
    arena,
    Date.now(),
  );
  if (acquired.status === 'placed') return acquired;

  const execution = reclaimForDodge(ns, hackingState(), brokerRequest, hosts);
  TELEMETRY: if (__TELEMETRY__ && execution.preempted && execution.plan.action === 'preempt') {
    const victim = execution.plan.victim;
    tel!.event('ram.preempt', {
      victim: {
        workerId: victim.workerId,
        ...(victim.opId !== undefined ? { opId: victim.opId } : {}),
        host: victim.hostname,
        kind: victim.kind,
        segment: victim.segment,
        gb: roundSigFigs(victim.gb, 3),
      },
      beneficiary: {
        by: brokerRequest.by,
        id: brokerRequest.id,
        lane: brokerRequest.lane,
        gb: roundSigFigs(brokerRequest.gb, 3),
        priority: brokerRequest.priority,
      },
      reason: execution.plan.reason,
      threshold: execution.plan.threshold,
      shareGb: roundSigFigs(execution.plan.shareGb, 3),
    });
  }
  if (!execution.preempted) return acquired;

  // ns.kill releases real RAM synchronously. The executor has already routed
  // the dispatch ledger through reportFailed/workerExit, so retry the queue
  // before the farm gets another chance to count this block.
  const after = brokerPlacement(state);
  driver.drain(after, hackingState().memory.dispatch.heap, arena, Date.now());
  return driver.request(
    brokerRequest,
    after,
    hackingState().memory.dispatch.heap,
    arena,
    Date.now(),
  );
}

function publishArena(
  state: GameState,
  arena: ArenaPlan,
  snapshot: ReturnType<DodgeBrokerDriver['snapshot']>,
  published: string | undefined,
): string {
  const sig3 = (value: number): number => roundSigFigs(value, 3);
  const digest = {
    hosts: arena.hosts,
    arenaGb: sig3(arena.arenaGb),
    targetGb: sig3(arena.targetGb),
    guaranteedDynamicGb: sig3(arena.guaranteedDynamicGb),
    measuredDynamicGb: sig3(arena.measuredDynamicGb),
    queueDepth: snapshot.queueDepth,
    largestWaitingGb: sig3(snapshot.largestWaitingGb),
    neededForLargestWaitingGb: sig3(snapshot.neededForLargestWaitingGb),
    waits: snapshot.waits.map((request) => ({
      by: request.by,
      id: request.id,
      gb: sig3(request.gb),
      waitMs: Math.round(request.waitMs / 1_000) * 1_000,
      class: request.class,
      lane: request.lane,
    })),
    starvation: snapshot.starvation.map((request) => ({
      by: request.by,
      id: request.id,
      gb: sig3(request.gb),
      waitMs: Math.round(request.waitMs / 1_000) * 1_000,
    })),
    demand: snapshot.demand,
    promoted: arena.promoted,
    farmCostPerSec: sig3(arena.farmCostPerSec),
  };
  const encoded = JSON.stringify(digest);
  if (encoded !== published) set(state, 'ramArena', digest);
  return encoded;
}

/** Last-published signature of each half of the coordination digest. */
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
