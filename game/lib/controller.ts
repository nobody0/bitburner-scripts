import type { NS } from "@ns";
import { roundSigFigs } from '../../shared/format.ts';
import { capsDelta } from "../../shared/features/unlock.ts";
import type { Claim, SlotState } from "../../shared/strategy/arbiter.ts";
import { classifyReset, type PrestigeKind, type ResetIdentity } from "../../shared/reset.ts";
import { coordinate, emptyDigest, postNeeds, type Coordination } from "../../shared/strategy/coordination.ts";
import type { Need } from "../../shared/strategy/needs.ts";
import { forecastAt, unknownForecast, usableForecastSec } from "../../shared/strategy/progression/forecast.ts";
import { FEATURE_IDS, type FeatureId } from "../../shared/features/ids.ts";
import { HOME_RESERVE_GB, ramArena, type ArenaPlan, type BrokerHost } from '../../shared/ram/broker.ts';
import { parseSyncControl, SYNC_CONTROL_FILE } from "../../shared/deployment.ts";
import { setProxyEventSink, type ProxyPlacer } from "./ns-proxy.ts";
import { disposeProxies, nsp, nspLong, residentAsks, setProxyPlacer } from "./proxies.ts";
import { isScriptDeath } from "./errors.ts";
import { bestIncomePerSec, bestReinvestmentReturnPerDollarSec, slotRates } from "./income.ts";
import { ContributionCache } from "./features/contributions.ts";
import { hackingState, pumpOnWake, takeTargetSwitch } from "./features/hacking.ts";
import { noteTickLateness, resetTickHealth } from "./tick-health.ts";
import { armWake, realmSleep, sleepOrWake } from "./wake.ts";
import { workerGlobals } from "./worker-shared.ts";
import { takeRouteChange } from "./features/remaining.ts";
import { driverEnabled, featureModule, grantsFor, resetAllFeatures, selectDueModules } from "./features/index.ts";
import type { ClaimContext, NeedContext } from "./features/index.ts";
import { sweepFleet } from "./fleet.ts";
import { takeGateSignal } from "./gate-signal.ts";
import { clearControllerGlobals, gameGlobal } from "./globals.ts";
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
/** The 30 s fleet sweep: scan, root, deploy, and run the capability gate whose
 * delta the reset walk keys off. Probe cadence is derived separately below. */
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

/** Runtime permissions for the controller. These are orchestration controls,
 * never game observations or strategy inputs. The live defaults select the
 * complete feature registry and hold the irreversible BitNode boundary. */
export interface ControllerRunPolicy {
  selectedFeatures?: ReadonlySet<FeatureId>;
  allowBitNodeCompletion?: boolean;
}

export async function runController(
  ns: NS,
  tel: Telemetry | undefined,
  sink: TelemetrySink | undefined,
  policy: ControllerRunPolicy = {},
): Promise<void> {
  TELEMETRY: if (__TELEMETRY__) {
    tel!.event("start.boot", { build: __BUILD_ID__ });
    // ns-proxy.ts has no `tel`; give it a sink so slow exec retries are
    // visible. Cleared when the controller exits for sync.
    setProxyEventSink((name, data) => tel!.event(name, data));
  }
  ns.tprint(`main.js online (build ${__BUILD_ID__})`);

  const state = initState();
  const selectedFeatures = policy.selectedFeatures ?? new Set(FEATURE_IDS);
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
      // the COMMON resident. It must not be a refusal ceiling: a resident
      // whose minimum has grown past it would get `undefined` here forever —
      // and since every view refresh is itself a proxied call, that is a
      // permanent deadlock, not a wait. Attempt home at the minimum instead: on
      // the post-install boot home is empty and the exec succeeds; against a
      // busy farm the exec fails and the respawn retries exactly as it does
      // today, but never permanently.
      return { host: "home", gb: minGb, release: () => {} };
    }
    const gb = Math.round(Math.min(preferredGb, host.freeGb) * 100) / 100;
    // A host the heap does not describe (home before the first sweep) is taken
    // without a lease.
    if (heap?.host(host.hostname) === undefined) {
      return { host: host.hostname, gb, release: () => {} };
    }
    // Try the preferred size first, then step down to the minimum and home's
    // unconditional reserve. A later respawn can grow the resident again.
    const minLeaseGb = Math.round(minGb * 100) / 100;
    const preferredLease = heap.reserveOn(host.hostname, gb, true);
    const lease = preferredLease ?? heap.reserveOn(host.hostname, minLeaseGb, true);
    if (!lease) {
      return { host: "home", gb: minGb, release: () => {} };
    }
    return { host: host.hostname, gb: preferredLease ? gb : minLeaseGb, release: () => lease.release() };
  };

  // The residents were created in start.ts, sized to home, because the run
  // identity is read before this loop exists. Now that there is a fleet view,
  // hand them the real placer: the next respawn takes the best block going.
  setProxyPlacer(placeResident);

  let reportedActivationFailure: string | undefined;
  let nextTick = Date.now();
  // A BitNode reset makes the next sweep behave like a cold boot: the fleet
  // the heap describes has ceased to exist.
  let coldSweep = true;
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

  // Loop-body dodge work must never take the controller down: a DodgeExecError
  // is one lost placement race (the farm refilled a host between the broker's
  // stale free-RAM view and the exec), and every one of these paths reruns on
  // its own cadence. Kills still propagate — ScriptDeath is a shutdown, not a failure.
  const contained = async (phase: string, run: () => Promise<void>): Promise<void> => {
    try {
      await run();
    } catch (error) {
      if (isScriptDeath(error)) throw error;
      TELEMETRY: if (__TELEMETRY__) {
        tel!.event("feature.failed", { feature: "controller", phase, error: String(error) });
      }
    }
  };

  for (let tick = 0; ; tick++) {
    const sync = parseSyncControl(ns.read(SYNC_CONTROL_FILE));
    if (sync) {
      const pid = ns.exec("start.js", "home", {
        threads: 1,
        temporary: true,
        preventDuplicates: true,
      });
      if (pid !== 0) {
        TELEMETRY: if (__TELEMETRY__) {
          tel!.dispose();
          setProxyEventSink(undefined);
        }
        await disposeProxies();
        clearControllerGlobals();
        return;
      }
      if (reportedActivationFailure !== sync.id) {
        reportedActivationFailure = sync.id;
        ns.tprint(`WARNING: failed to activate staged sync ${sync.id}; retrying`);
      }
    } else {
      reportedActivationFailure = undefined;
    }

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
        await contained("reset-sweep", () => sweepFleet(ns, state, tel, true));
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
    // Run after the sweep block so a sweep tick publishes its gate and fresh
    // server scan before acquisition probes observe them.
    if (tick % PROBE_EVERY_TICKS === 0) {
      await runProbes(ns, probes, state, selectedFeatures);
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
    const dueModules = selectDueModules(state.featureLastRun, active, now)
      .filter((module) => selectedFeatures.has(module.driver.id));
    const activeFeatures = new Set(
      FEATURE_IDS.filter((id) => selectedFeatures.has(id) && driverEnabled(featureModule(id).driver, active)),
    );

    // A locked/disabled feature cannot leave a stale need, reservation or slot
    // claim behind merely because it will never become due again.
    for (const id of FEATURE_IDS) {
      if (selectedFeatures.has(id) && driverEnabled(featureModule(id).driver, active)) continue;
      contributions.remove(id);
    }

    // 0) Refresh: evaluation only, before any need, claim or tick. Each due
    //    module re-derives its published digest from the store. The meta
    //    module (progression) refreshes LAST so its endgame route decision
    //    reads every other feature's state as refreshed by THIS pass, not the
    //    previous one — the resolution of the "endgame needs the enriched
    //    state, features need the chosen route" ordering. The sort is stable,
    //    so everyone else keeps registry order.
    const needContext: NeedContext = { state, caps: active, now, selectedFeatures, activeFeatures };
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
          selectedFeatures,
          activeFeatures,
          arena,
          tick,
          board,
          grants: grantsFor(coordination.arbitration, driver.id),
          horizons,
          ...(plan?.route !== undefined ? { route: plan.route } : {}),
          freeCriticalRam: (neededGb) => killWorkersForCritical(ns, hackingState(), neededGb),
          allowBitNodeCompletion: policy.allowBitNodeCompletion === true,
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
    // Wake-storm bound. A wake pump can itself CAUSE the next wake: the pump
    // stops or starts a share worker, its atExit signals, and the loop runs
    // again — a self-sustaining cycle that can starve the tick body. A real
    // 200 ms window fits at most a handful of genuine landing bursts, so the
    // cap converts the pathological
    // cycle into an ordinary tick.
    let wakeRaces = 0;
    let lastWakePumpAt = 0;
    while ((clock = Date.now()) < nextTick) {
      if (wakeRaces >= 32) {
        // Sleep out the rest of the window WITHOUT racing the wake: breaking
        // here instead would run the next pass on the same instant, the still-
        // pending wake would win the next race immediately, and the cycle
        // would repeat with the clock frozen forever.
        await realmSleep(nextTick - clock);
        break;
      }
      if ((await sleepOrWake(nextTick - clock, wakePromise)) === "tick") break;
      wakeRaces++;
      wakePromise = armWake(workerGlobals());
      if (active.unlocked["hacking"] !== "yes") continue;
      // Coalesce wake-pumps to one per landing slot. The wake exists to catch
      // the min-security instant after a weaken lands; on a large fleet
      // landings are continuous, so pumping the full planner per landing would
      // do unbounded work per unit of game time. Extra wakes
      // inside one slot coalesce into the next allowed pump; nothing is lost
      // because the pump reads the completion QUEUE, not the wake itself.
      if (Date.now() - lastWakePumpAt < 50) continue;
      lastWakePumpAt = Date.now();
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
  // Registry-owned resets prevent feature topics from surviving into a new
  // node and contaminating its first route decision.
  resetAllFeatures(state, kind);
  state.featureLastRun = {};
  state.mirrors = {};
  state.mirrorDirty.clear();
  state.probeFailures = {};
  delete state.probeBatch;
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
