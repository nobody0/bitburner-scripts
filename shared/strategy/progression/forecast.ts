import type { FactionIntent } from "../factions/plan.ts";
import type { ProgressResource, RouteEta } from "./eta.ts";

/** Forecasts are anchored rather than rewritten on every controller pass. The
 * countdown is derived from expectedAt; a new estimate is made on the
 * progression planner's one-minute observation cadence or immediately when
 * its structural basis changes. Fresh-install rates change by orders of
 * magnitude in ten minutes, so a longer anchor is not a usable ROI horizon. */
export const FORECAST_RECALIBRATION_MS = 60_000;
export const FORECAST_STALE_MS = 3 * FORECAST_RECALIBRATION_MS;
export const INSTALL_FINAL_SWEEP_SEC = 60;

/** Fallback amortization window for investment decisions when no usable
 * forecast exists (unknown or stale). "No forecast" happens routinely — before
 * the first augmentation package is committed, and again for a while after any
 * structural change — and treating it as a zero-second horizon freezes every
 * income purchase exactly when the bootstrap depends on them. One hour is the
 * conservative planning window, not a claim about the run's length. */
export const DEFAULT_PLANNING_HORIZON_SEC = 3_600;

export type ForecastConfidence = "measured" | "mixed" | "fallback";

export interface ForecastComponent {
  what: string;
  /** Stable semantic identity; `what` is free-form diagnostic text. */
  resource: ProgressResource;
  sec: number;
  measured: boolean;
  /** Parallel components overlap; sequential components are added after the
   * slowest parallel component. */
  mode: "parallel" | "sequential";
  critical: boolean;
}

export interface EstimatedForecast {
  state: "estimated" | "stale";
  estimatedAt: number;
  nextRecalibrationAt: number;
  expectedAt: number;
  remainingSec: number;
  confidence: ForecastConfidence;
  basis: string;
  components: ForecastComponent[];
}

export interface UnknownForecast {
  state: "unknown";
  evaluatedAt: number;
  nextRecalibrationAt: number;
  basis: string;
  reason: string;
}

export type TimeForecast = EstimatedForecast | UnknownForecast;

export interface PlanningHorizons {
  /** Remaining time until the current BitNode is expected to end. */
  node: TimeForecast;
  /** Remaining time until the next augmentation installation. */
  install: TimeForecast;
}

function confidence(components: readonly ForecastComponent[]): ForecastConfidence {
  if (components.length === 0) return "measured";
  if (components.every((part) => !part.measured)) return "fallback";
  return components.every((part) => part.measured) ? "measured" : "mixed";
}

export function unknownForecast(now: number, basis: string, reason: string): UnknownForecast {
  return {
    state: "unknown",
    evaluatedAt: now,
    nextRecalibrationAt: now + FORECAST_RECALIBRATION_MS,
    basis,
    reason,
  };
}

export function estimatedForecast(
  now: number,
  basis: string,
  components: readonly Omit<ForecastComponent, "critical">[],
): EstimatedForecast {
  const parallelMax = components
    .filter((part) => part.mode === "parallel")
    .reduce((max, part) => Math.max(max, Math.max(0, part.sec)), 0);
  const sequential = components
    .filter((part) => part.mode === "sequential")
    .reduce((sum, part) => sum + Math.max(0, part.sec), 0);
  const totalSec = parallelMax + sequential;
  const resolved = components.map((part) => ({
    ...part,
    sec: Math.max(0, part.sec),
    critical: part.mode === "sequential" || Math.max(0, part.sec) === parallelMax,
  }));
  return {
    state: "estimated",
    estimatedAt: now,
    nextRecalibrationAt: now + FORECAST_RECALIBRATION_MS,
    expectedAt: now + totalSec * 1_000,
    remainingSec: totalSec,
    confidence: confidence(resolved),
    basis,
    components: resolved,
  };
}

/** Refresh the derived countdown and expose missed recalibrations as stale.
 * No fixed floor or ceiling is applied. */
export function forecastAt(forecast: TimeForecast, now: number): TimeForecast {
  if (forecast.state === "unknown") return forecast;
  return {
    ...forecast,
    state: now - forecast.estimatedAt > FORECAST_STALE_MS ? "stale" : "estimated",
    remainingSec: Math.max(0, (forecast.expectedAt - now) / 1_000),
  };
}

/** A stale or unknown forecast is not silently converted into a made-up
 * horizon. Callers must choose an explicit conservative behavior. */
export function usableForecastSec(forecast: TimeForecast): number | undefined {
  return forecast.state === "estimated" ? forecast.remainingSec : undefined;
}

/** Seconds of run left to plan against, with the documented fallback applied.
 *
 * The one expression every "how much of the remaining run does this buy" answer
 * has to share. The buy-vs-write gate, the value of an access unlock and the
 * occupancy discount on a bounded work-slot bid all divide by this; if any two of
 * them picked a different horizon, one would post a need the other permanently
 * outranks and the work would never happen.
 *
 * Pass an already-refreshed forecast (`forecastAt(node, now)`) — `usableForecastSec`
 * deliberately reports nothing for a stale or unknown one, and `undefined` here
 * means the conservative window, not a claim about the run's length. */
export function nodeHorizonSec(node: TimeForecast | undefined): number {
  return (node ? usableForecastSec(node) : undefined) ?? DEFAULT_PLANNING_HORIZON_SEC;
}

/** Below this many forecast seconds to the install, investment spending is
 * braked (the `progression:imminent-install` reserve). */
export const IMMINENT_INSTALL_SEC = 300;

/** Planning horizon for state erased by augmentation installation, capped by
 * the node horizon and a conservative fallback when no install ETA exists. */
export function installHorizonSec(horizons: PlanningHorizons): number {
  const node = usableForecastSec(horizons.node) ?? DEFAULT_PLANNING_HORIZON_SEC;
  const install = usableForecastSec(horizons.install);
  return install !== undefined ? Math.min(install, node) : Math.min(node, DEFAULT_PLANNING_HORIZON_SEC);
}

export function shouldReforecast(previous: TimeForecast | undefined, now: number, basis: string): boolean {
  if (!previous) return true;
  return previous.basis !== basis || now >= previous.nextRecalibrationAt;
}

export function nodeForecast(now: number, route: RouteEta | undefined, basis: string): TimeForecast {
  if (!route) return unknownForecast(now, basis, "no available BitNode completion route");
  // A complete route must read as NO forecast, not a zero-second one: the act
  // that ends the node is deliberately unwired (a human clicks), so that state
  // can persist indefinitely — and a 0 s horizon would freeze every feature's
  // spending while it does.
  if (route.complete) return unknownForecast(now, basis, "route complete — terminal execution is armed separately");
  return estimatedForecast(
    now,
    basis,
    route.parts.map((part) => ({
      what: part.what,
      resource: part.resource,
      sec: part.sec,
      measured: part.measured,
      mode: "sequential" as const,
    })),
  );
}

export interface InstallForecastView {
  installNow: boolean;
  /** Cadence has committed to reset and feature blockers are being drained. */
  installWanted?: boolean;
  queuedCount: number;
  phase: "start" | "finishUp" | "ending";
  intent?: Omit<FactionIntent, "why">;
  workMeasured: boolean;
  moneyMeasured: boolean;
  finalSweepReady: boolean;
  /** Work the faction planner has already committed to finishing despite the
   * cadence request. This includes both the base package that happened to be
   * in flight and an accepted <=1% post-plan push. */
  committedPackageSec?: number;
  /** Remaining time for reset-activated value to reach the renewal cadence
   * threshold. A package breakpoint is not automatically an install. */
  cadenceSec?: number;
  /** A finite-count route may require a substantial funded tranche even after
   * the generic economic cadence crosses. There is no honest ETA until the
   * planner can forecast that discrete set. */
  countCadenceReady?: boolean;
  /** Whether the selected route can survive an economic reset right now. */
  optionalInstallAllowed?: boolean;
  /** Earliest reset imposed by the selected route. */
  mandatory?: { sec: number; measured: boolean; why: string };
}

/** Estimate the current committed install cycle. The faction intent already
 * models unlock and player work as sequential inside unlockSec/repSec while
 * money production overlaps them. We retain those components separately for
 * diagnosis and take the critical path here. */
export function installForecast(now: number, view: InstallForecastView, basis: string): TimeForecast {
  if (view.installNow) return estimatedForecast(now, basis, []);

  if (view.installWanted) {
    return estimatedForecast(now, basis, [
      ...(view.committedPackageSec !== undefined && view.committedPackageSec > 0
        ? [{
            what: "finish committed augmentation package",
            resource: "reputation" as const,
            sec: view.committedPackageSec,
            measured: view.workMeasured,
            mode: "sequential" as const,
          }]
        : []),
      {
        what: "committed install blockers and final sweep",
        resource: "install",
        sec: view.finalSweepReady ? 0 : INSTALL_FINAL_SWEEP_SEC,
        measured: false,
        mode: "sequential",
      },
    ]);
  }

  const mandatoryComponents = view.mandatory
    ? [
        {
          what: view.mandatory.why,
          resource: "install" as const,
          sec: Math.max(0, view.mandatory.sec),
          measured: view.mandatory.measured,
          mode: "parallel" as const,
        },
        {
          what: "mandatory install final sweep",
          resource: "install" as const,
          sec: INSTALL_FINAL_SWEEP_SEC,
          measured: false,
          mode: "sequential" as const,
        },
      ]
    : undefined;

  const intent = view.intent;
  if (view.optionalInstallAllowed === false) {
    return mandatoryComponents
      ? estimatedForecast(now, basis, mandatoryComponents)
      : unknownForecast(now, basis, "the selected route stage forbids an optional install");
  }
  if (view.countCadenceReady === false) {
    return unknownForecast(
      now,
      basis,
      "the funded augmentation set has not reached the route's reset tranche",
    );
  }
  if (!intent) {
    if (view.queuedCount > 0 && view.phase === "ending") {
      return estimatedForecast(now, basis, [{
        what: "final purchase and donation sweep",
        resource: "install",
        sec: view.finalSweepReady ? 0 : INSTALL_FINAL_SWEEP_SEC,
        measured: false,
        mode: "sequential",
      }]);
    }
    return mandatoryComponents
      ? estimatedForecast(now, basis, mandatoryComponents)
      : unknownForecast(now, basis, "no committed augmentation package yet");
  }

  const workSec = Math.max(0, intent.unlockSec + intent.repSec);
  const economicComponents = [
    { what: "faction unlock and reputation", resource: "reputation", sec: workSec, measured: view.workMeasured, mode: "parallel" },
    { what: "package money", resource: "money", sec: Math.max(0, intent.moneySec), measured: view.moneyMeasured, mode: "parallel" },
    ...(view.cadenceSec !== undefined
      ? [{
          what: "install cadence value crossing",
          resource: "augmentations" as const,
          sec: Math.max(0, view.cadenceSec),
          measured: true,
          mode: "parallel" as const,
        }]
      : []),
    {
      what: "final purchase and donation sweep",
      resource: "install",
      sec: INSTALL_FINAL_SWEEP_SEC,
      measured: false,
      mode: "sequential",
    },
  ] as const;
  const economicSec = Math.max(workSec, Math.max(0, intent.moneySec), Math.max(0, view.cadenceSec ?? 0)) + INSTALL_FINAL_SWEEP_SEC;
  const mandatorySec = view.mandatory ? Math.max(0, view.mandatory.sec) + INSTALL_FINAL_SWEEP_SEC : Infinity;
  return estimatedForecast(now, basis, mandatoryComponents && mandatorySec < economicSec ? mandatoryComponents : economicComponents);
}
