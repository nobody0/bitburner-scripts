import type { GameState } from "./state.ts";
import type { ArtifactIdentity } from "../../shared/run-identity.ts";
import type { GoNeuralRuntime } from "./go-neural-worker.ts";

/** Typed cross-script cache on globalThis (same JS realm trick the dodger
 * uses). Everything the controller knows about the world lives in one store
 * (./state.ts), keyed by StateMap — so the cache, the telemetry stream and the
 * ns getters that feed them all agree at compile time.
 *
 * Scripts are page-realm ES modules, so explicit cleanup is required when the
 * controller restarts without a page reload.
 * Source: https://github.com/bitburner-official/bitburner-src/blob/3162fd2590e221eadd0c0fbd46151913f7c4c41c/src/NetscriptJSEvaluator.ts#L208-L223 */
export interface GameGlobals {
  /** Servers, player, capabilities, farm rollup, every feature topic. */
  state?: GameState;
  /** Current install identity, rebuilt from the durable lineage marker. */
  artifactIdentity?: ArtifactIdentity;
  /** Current controller's V9 worker and position cache. */
  goNeuralWorker?: { buildId: string; runtime: GoNeuralRuntime };
}

export const gameGlobal = globalThis as typeof globalThis & GameGlobals;

/** Drop controller-owned realm state before the post-sync main.js launch. */
export function clearControllerGlobals(): void {
  gameGlobal.goNeuralWorker?.runtime.dispose();
  delete gameGlobal.state;
  delete gameGlobal.artifactIdentity;
  delete gameGlobal.goNeuralWorker;
}
