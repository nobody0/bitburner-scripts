import type { OpponentWaitTrace } from "../opponent.ts";
import type { GoDecision, GoView } from "../rules.ts";
import { normalizeGoPlaytime } from "../rng.ts";

export type GoWorkerOpponentResponse =
  | { type: "move"; x: number; y: number }
  | { type: "pass" | "gameOver"; x: null; y: null };

export type GoWorkerAction =
  | { type: "move"; x: number; y: number }
  | { type: "pass" };

export interface GoWorkerContinuationHint {
  seed: number;
  probability: number;
  response: { type: "move"; x: number; y: number } | { type: "pass" };
  wait: OpponentWaitTrace;
}

export interface GoWorkerEvaluation {
  decision: GoDecision;
  /** Production is WebGPU. Simulator aggregate runs label their deliberately
   * collapsed policy interior so telemetry cannot claim action parity. */
  backend?: "webgpu" | "aggregate";
  preparationMs: number;
  finalizationMs: number;
  modelProfile: "small5" | "daemon19";
  modelExtent: number;
  cached: boolean;
  /** True only when the page consumed a worker-initiated prediction rather
   * than issuing an RPC, even if that RPC itself hit worker memory. */
  pushed: boolean;
  /** Compact timing metadata for the chosen action only. The worker retains
   * successor boards; the main thread needs only this trace to advance the
   * public bonus-cycle count before the next probe refresh. */
  continuations: GoWorkerContinuationHint[];
}

export interface GoWorkerPrediction {
  /** Identifies the Black move whose possible White response produced this
   * position. The game accepts pushed work only from its most recent commit. */
  parentTurnId: string;
  positionId: string;
  dispatchPlaytime: number;
  seeds: number[];
  response: GoWorkerContinuationHint["response"];
  value: GoWorkerEvaluation;
}

export type GoWorkerRequest =
  | { type: "install"; requestId: number; positionId: string; view: GoView; parentTurnId?: string }
  | { type: "evaluate"; requestId: number; positionId: string; seeds: number[] }
  | {
    type: "commit";
    turnId: string;
    positionId: string;
    seeds: number[];
    dispatchPlaytime: number;
    dispatchWallAt: number;
    nextRolloverAt: number;
    bonusCycles: number;
    action: GoWorkerAction;
  }
  | {
    type: "confirm";
    turnId: string;
    response: GoWorkerOpponentResponse;
    positionId: string;
    observedPlaytime: number;
    observedAt: number;
  }
  | { type: "reset"; requestId: number };

export type GoWorkerResponse =
  | { type: "ready" }
  | { type: "evicted"; positionId: string }
  | { type: "predicted"; prediction: GoWorkerPrediction }
  | { type: "confirmed"; turnId: string; positionId: string; clockDrifted: boolean; terminal: boolean }
  | { type: "desynced"; turnId: string; message: string }
  | { type: "installed"; requestId: number; positionId: string; preparationMs: number; cached: boolean }
  | { type: "evaluated"; requestId: number; positionId: string; seeds: number[]; value: GoWorkerEvaluation }
  | { type: "reset"; requestId: number }
  | { type: "error"; requestId?: number; message: string };

/** Compact identity of every V9 decision input. The full view is sent once
 * with `install`; subsequent evaluations carry only this id and their seed
 * set. Two independent 32-bit hashes make accidental aliasing negligible,
 * while the worker still retains the canonical string to reject a collision. */
export function goNeuralPositionIdentity(view: GoView): { id: string; canonical: string } {
  const canonical = JSON.stringify({
    b: view.board.rows,
    p: view.previousBoards,
    c: view.currentPlayer,
    s: view.status,
    o: view.opponent,
    // JSON.stringify maps Infinity to null. Preserve the exhaustive audit mode
    // as a distinct input instead of aliasing it with an invalid value.
    l: view.candidateLimit === Number.POSITIVE_INFINITY ? "all" : view.candidateLimit,
    q: view.consecutivePasses,
    k: view.komi,
    // Only the fields the decision reads. `nextGame.why` is regenerated from
    // live install-remaining seconds on every controller pass, so hashing it
    // would give the same position a new identity each turn and defeat both
    // the worker's position cache and every pushed continuation.
    n: view.nextGame ? { o: view.nextGame.opponent, b: view.nextGame.boardSize } : undefined,
  });
  let left = 0x811c9dc5;
  let right = 0x9e3779b9;
  for (let index = 0; index < canonical.length; index++) {
    const code = canonical.charCodeAt(index);
    left = Math.imul(left ^ code, 0x01000193) >>> 0;
    right = Math.imul(right ^ (code + index), 0x85ebca6b) >>> 0;
  }
  return { id: `${left.toString(36)}-${right.toString(36)}`, canonical };
}

export function goSeedSetKey(seeds: readonly number[]): string {
  return seeds.map(normalizeGoPlaytime).join(",");
}
