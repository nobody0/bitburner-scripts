import type { FactionIntent } from "../factions/plan.ts";
import type { RouteEta } from "./eta.ts";

/** Forecasts are anchored rather than rewritten on every controller pass. The
 * countdown is derived from expectedAt; a new estimate is made every ten
 * minutes or immediately when its structural basis changes. */
export const FORECAST_RECALIBRATION_MS = 10 * 60_000;
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

/** The planning horizon for INSTALL-lifetime purchases (cloud servers,
 * hacknet, stock positions — everything prestigeAugmentation wipes).
 *
 * Never exceeds the NODE's own horizon, on EITHER path: the two forecasts
 * are computed independently, so a usable 2-hour install estimate can
 * coexist with a route that ends the node in 20 minutes — and an install
 * can never outlive its node. */
/** Below this many forecast seconds to the install, investment spending is
 * braked (the `progression:imminent-install` reserve). */
export const IMMINENT_INSTALL_SEC = 300;

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
  if (route.complete) return unknownForecast(now, basis, "route complete — ending the node is a manual act");
  return estimatedForecast(
    now,
    basis,
    route.parts.map((part) => ({
      what: part.what,
      sec: part.sec,
      measured: part.measured,
      mode: "sequential" as const,
    })),
  );
}

export interface InstallForecastView {
  installNow: boolean;
  queuedCount: number;
  phase: "start" | "finishUp" | "ending";
  intent?: Omit<FactionIntent, "why">;
  workMeasured: boolean;
  moneyMeasured: boolean;
  finalSweepReady: boolean;
}

/** Estimate the current committed install cycle. The faction intent already
 * models unlock and player work as sequential inside unlockSec/repSec while
 * money production overlaps them. We retain those components separately for
 * diagnosis and take the critical path here. */
export function installForecast(now: number, view: InstallForecastView, basis: string): TimeForecast {
  if (view.installNow) return estimatedForecast(now, basis, []);

  const intent = view.intent;
  if (!intent) {
    if (view.queuedCount > 0 && view.phase === "ending") {
      return estimatedForecast(now, basis, [{
        what: "final purchase and donation sweep",
        sec: view.finalSweepReady ? 0 : INSTALL_FINAL_SWEEP_SEC,
        measured: false,
        mode: "sequential",
      }]);
    }
    return unknownForecast(now, basis, "no committed augmentation package yet");
  }

  const workSec = Math.max(0, intent.unlockSec + intent.repSec);
  return estimatedForecast(now, basis, [
    { what: "faction unlock and reputation", sec: workSec, measured: view.workMeasured, mode: "parallel" },
    { what: "package money", sec: Math.max(0, intent.moneySec), measured: view.moneyMeasured, mode: "parallel" },
    {
      what: "final purchase and donation sweep",
      sec: INSTALL_FINAL_SWEEP_SEC,
      measured: false,
      mode: "sequential",
    },
  ]);
}
