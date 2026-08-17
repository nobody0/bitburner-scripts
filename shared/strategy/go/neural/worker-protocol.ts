import type { OpponentWaitTrace } from "../opponent.ts";
import type { GoDecision, GoView } from "../rules.ts";
import { normalizeGoPlaytime } from "../rng.ts";

export type GoWorkerOpponentResponse =
  | { type: "move"; x: number; y: number }
  | { type: "pass" | "gameOver"; x: null; y: null };

export type GoWorkerAction =
  | { type: "move"; x: number; y: number }
  | { type: "pass" }
  | { type: "cheatTwoMoves"; x1: number; y1: number; x2: number; y2: number }
  | { type: "cheatRemoveRouter" | "cheatDestroyNode" | "cheatRepairNode"; x: number; y: number };

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
  /** White-response seeds derived by the worker from dispatchPlaytime and the
   * position's held bonus-cycle count. */
  opponentSeeds: number[];
  preparationMs: number;
  finalizationMs: number;
  modelProfile: "small5" | "daemon19";
  modelExtent: number;
  cached: boolean;
  /** True only when the page consumed a worker-initiated prediction rather
   * than issuing an RPC, even if that RPC itself hit worker memory. */
  pushed: boolean;
  /** Compact timing metadata for the chosen action only. The worker retains
   * successor boards; the main thread uses presence of these hints to arm a
   * speculative commit while observing bonus cycles authoritatively. */
  continuations: GoWorkerContinuationHint[];
}

export interface GoWorkerPrediction {
  /** Identifies the Black move whose possible White response produced this
   * position. The game accepts pushed work only from its most recent commit. */
  parentTurnId: string;
  positionId: string;
  dispatchPlaytime: number;
  response: GoWorkerContinuationHint["response"];
  value: GoWorkerEvaluation;
}

/** Certified playbook action mirror of the merged-playbook facade shape. */
export type GoWorkerPlaybookAction =
  | { kind: "move"; x: number; y: number }
  | { kind: "pass" | "align" }
  | { kind: "sleep"; variant: number };

export interface GoWorkerCertified {
  action: GoWorkerPlaybookAction;
  /** Credit the controller must hold after acting on this entry. */
  alignmentCredit: number;
  /** Full credit granted once an align wait completes. */
  alignmentBoards: number;
}

export interface GoWorkerPlaybookRoute {
  enemy: string;
  entryPhase: number;
  /** Whole 200 ms phases between the queried playtime and the entry phase. */
  waits: number;
  /** Absolute engine tick of the entry phase for the queried playtime. */
  entryPlaytime: number;
}

export type GoWorkerRequest =
  | { type: "install"; requestId: number; positionId: string; view: GoView; parentTurnId?: string }
  | { type: "evaluate"; requestId: number; positionId: string; dispatchPlaytime: number }
  // Playbook lookups are pure table reads outside the evaluation queue. The
  // certified result depends on the alignment credit, which is deliberately
  // not part of the position identity, so these are never cached.
  | { type: "playbook"; requestId: number; positionId: string; dispatchPlaytime: number; credit: number }
  | { type: "playbookRoute"; requestId: number; playtime: number; opponent: string }
  | {
    type: "commit";
    turnId: string;
    positionId: string;
    dispatchPlaytime: number;
    dispatchWallAt: number;
    nextRolloverAt: number;
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
  | { type: "evaluated"; requestId: number; positionId: string; dispatchPlaytime: number; value: GoWorkerEvaluation }
  | { type: "playbook"; requestId: number; certified?: GoWorkerCertified }
  | { type: "playbookRoute"; requestId: number; route?: GoWorkerPlaybookRoute }
  | { type: "reset"; requestId: number }
  | { type: "error"; requestId?: number; message: string };

/** Compact identity of every V9 decision input. The full view is sent once
 * with `install`; subsequent evaluations carry only this id and the public
 * dispatch tick. Two independent 32-bit hashes make accidental aliasing negligible,
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
    // When candidateLimit is undefined the engine resolves the deployment
    // default from the board size (GO_PROFILE_CANDIDATE_LIMITS) and the
    // opponent (GO_OPPONENT_SEARCH) — both hashed here, as `b` and `o` — so
    // identical canonical strings always resolve the same K and deep-search
    // budget within a process. Any future default that depends on state
    // outside this canonical string must be added here.
    l: view.candidateLimit === Number.POSITIVE_INFINITY ? "all" : view.candidateLimit,
    q: view.consecutivePasses,
    k: view.komi,
    z: view.bonusCycles,
    h: view.cheat ? {
      u: view.cheat.unlocked,
      c: view.cheat.count,
      p: view.cheat.successByCount[view.cheat.count],
      k: view.cheat.candidateLimit,
      d: view.cheat.doubleMoveLimit,
    } : undefined,
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

export function goDispatchKey(dispatchPlaytime: number): string {
  return String(normalizeGoPlaytime(dispatchPlaytime));
}
