import type { GameState } from "./state.ts";
import type { ArtifactIdentity } from "../../shared/run-identity.ts";

/** Typed cross-script cache on globalThis (same JS realm trick the dodger
 * uses). Everything the controller knows about the world lives in one store
 * (./state.ts), keyed by StateMap — so the cache, the telemetry stream and the
 * ns getters that feed them all agree at compile time.
 *
 * The realm outlives any single start.js instance, which is what makes a build
 * handoff cheap: the incoming controller inherits the whole world instead of
 * re-probing it. Scripts are page-realm ES modules; a page reload creates the
 * fresh realm used by the cold path.
 * Source: https://github.com/bitburner-official/bitburner-src/blob/3162fd2590e221eadd0c0fbd46151913f7c4c41c/src/NetscriptJSEvaluator.ts#L208-L223 */
export interface GameGlobals {
  /** Newest start.js instance bumps this; older loops see it and exit. */
  controllerEpoch?: number;
  /** Servers, player, capabilities, farm rollup, every feature topic. */
  state?: GameState;
  /** Active farm target, retained across handoffs so a build push does not
   * look like a target switch. */
  farmTarget?: string;
  /** Current install identity. Survives deployment handoffs in the page realm;
   * prestige kills the process and the next cold start resolves fresh epochs. */
  artifactIdentity?: ArtifactIdentity;
}

export const gameGlobal = globalThis as typeof globalThis & GameGlobals;
