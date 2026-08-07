import type { StateMap } from "../../shared/telemetry/state-map.ts";

/** Typed cross-script cache on globalThis (same JS realm trick the dodger
 * uses). Shapes come from StateMap, so the cache, the telemetry stream, and
 * the ns getters that feed them all agree at compile time. */
export interface GameGlobals {
  servers?: StateMap["servers"];
  player?: StateMap["player"];
  /** Newest start.js instance bumps this; older loops see it and exit. */
  controllerEpoch?: number;
  /** Desired target retained across handoffs for transition telemetry only. */
  starterTarget?: string;
}

export const gameGlobal = globalThis as typeof globalThis & GameGlobals;
