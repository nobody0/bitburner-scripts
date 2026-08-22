import type { GameState } from "./state.ts";
import type { ArtifactIdentity } from "../../shared/run-identity.ts";
import type { GoNeuralRuntime } from "./go-neural-worker.ts";

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
  /** Persistent V9 worker. Its GPU device and position cache survive a
   * controller handoff in the shared page realm. */
  goNeuralWorker?: { buildId: string; runtime: GoNeuralRuntime };
  /** The stock feature's self-measured trade ledger. See `StockFlows`. */
  stockFlows?: StockFlows;
}

/** What the stock driver measured around its own trades, rather than read back
 * from the game's money-sources ledger — which counts an open position's
 * purchase as money GONE, so it reads deeply negative exactly while the
 * strategy is working.
 *
 * Parked here rather than in a module `let` for the same reason as
 * `farmTarget`: a build push replaces the module instance but not the world, so
 * module-level counters would restart at zero and the next trade would
 * republish those zeroes over the accumulated total — erasing money that was
 * really earned from both the viewer's earnings curve and `earnedSinceInstall`.
 * An install is the only thing that may reset these, and it does so explicitly
 * through `resetStockState`. */
export interface StockFlows {
  /** Cumulative cash moved by our trades — each batch's (after − before), both
   * read inside the same dodge stub, so the two samples cannot skew. With the
   * live book, `tradeCashFlow + portfolioValue` is the market's measured wealth
   * contribution. */
  tradeCashFlow: number;
  /** When the first trade landed, so a rate has a denominator. */
  tradeFlowSince?: number;
  /** Cumulative cash spent on WSE/TIX/4S unlocks. Tracked apart from
   * `tradeCashFlow` because the two feed different consumers: the trading RATE
   * must exclude unlocks (a $25b purchase is not a trading loss), while
   * cumulative EARNINGS must still count the spend — the game's own ledger
   * debits unlocks under the "stock" source, so the correction in
   * `earnedSinceInstall` would otherwise erase them entirely. */
  unlockSpend: number;
}

export const gameGlobal = globalThis as typeof globalThis & GameGlobals;
