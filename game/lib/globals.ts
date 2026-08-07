import type { GameState } from "./state.ts";

/** Typed cross-script cache on globalThis (same JS realm trick the dodger
 * uses). Everything the controller knows about the world lives in one store
 * (./state.ts), keyed by StateMap — so the cache, the telemetry stream and the
 * ns getters that feed them all agree at compile time.
 *
 * The realm outlives any single start.js instance, which is what makes a build
 * handoff cheap: the incoming controller inherits the whole world instead of
 * re-probing it. */
export interface GameGlobals {
  /** Newest start.js instance bumps this; older loops see it and exit. */
  controllerEpoch?: number;
  /** Servers, player, capabilities, farm rollup, every feature topic. */
  state?: GameState;
  /** Active farm target, retained across handoffs so a build push does not
   * look like a target switch. */
  farmTarget?: string;
}

export const gameGlobal = globalThis as typeof globalThis & GameGlobals;
