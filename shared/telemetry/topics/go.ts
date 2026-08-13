/** Go (IPvGO) feature — BN14's theme. Problem: a board game. Maximise
 * territory captured per game against each faction opponent, since win streaks
 * grant escalating stat/hacking bonuses. Board play is self-contained; the
 * opponent choice is intentionally coupled to the other features' needs. */

import type {
  GoCurrentPlayer,
  GoFactionOpponent,
  GoMove,
  GoOpponent,
  GoObservedBoardSize,
  GoRewardOpponent,
  GoStatus,
} from "../../strategy/go/rules.ts";
import type { GoEtaDemand, GoGameCandidate } from "../../strategy/go/rewards.ts";
import type { GO_OPPONENT_MODEL } from "../../strategy/go/opponent.ts";

export interface GoOpponentStats {
  opponent: GoRewardOpponent;
  wins: number;
  losses: number;
  winStreak: number;
  highestWinStreak: number;
  rep: number;
  bonusPercent: number;
  bonusDescription: string;
}

export type GoActionDigest =
  | { type: "move"; x: number; y: number }
  | { type: "pass" | "resume" }
  | { type: "newGame"; opponent: GoRewardOpponent; boardSize: 5 | 7 | 9 | 13 };
export type GoMoveDigest = Omit<GoMove, "why">;
export type GoEtaDemandDigest = Omit<GoEtaDemand, "why">;
export type GoGameCandidateDigest = Omit<GoGameCandidate, "why" | "transientDemand"> & {
  transientDemand?: GoEtaDemandDigest;
};

export interface GoState {
  /** Core and board probes can land independently, so acquired fields are
   * optional until their owning probe has succeeded at least once. */
  status?: GoStatus;
  currentPlayer?: GoCurrentPlayer;
  opponent?: GoOpponent;
  boardSize?: GoObservedBoardSize;
  /** Row strings exactly as ns.go.getBoardState returns them. Small: at most
   * 19 strings of 19 chars. */
  board?: string[];
  /** Complete prior-position history for the game's positional superko rule. */
  previousBoards?: string[][];
  whiteScore?: number;
  blackScore?: number;
  komi?: number;
  bonusCycles?: number;
  moveCount?: number;
  /** Controlled empty territory per colour, from ns.go.analysis. */
  territory?: { black: number; white: number };
  stats?: GoOpponentStats[];
  plan?: GoPlan;
  /** Outcome paired with the latest decision. Historical state records retain
   * each pair, while the live topic stays bounded to one turn. */
  lastTurn?: GoTurnResult;
}

export interface GoPlan {
  action: GoActionDigest;
  ranked: GoMoveDigest[];
  /** Exact public state consumed by the pure planner. This avoids pairing a
   * pre-move ranking with the post-move board emitted later in the same tick. */
  input: {
    at: number;
    board: string[];
    previousBoards: string[][];
    status: GoStatus;
    currentPlayer: GoCurrentPlayer;
    opponent: GoRewardOpponent;
    blackScore?: number;
    whiteScore?: number;
    komi?: number;
    bonusCycles?: number;
  };
  planning: { finalistCount: number; positionValue: number };
  prediction?: {
    model: typeof GO_OPPONENT_MODEL;
    /** Value-network execution path actually used for this decision. */
    backend?: "webgpu";
    /** Weight profile that rated the candidates. */
    modelProfile?: "small5" | "daemon19";
    /** Set when the board is smaller than the profile's feature extent, i.e.
     * an inherited 7x7-13x13 game rated by padded World Daemon weights. Those
     * weights never saw such a position in training. */
    paddedToExtent?: number;
    /** Milliseconds of engine-cycle headroom the dispatch expected. */
    rolloverMarginMs?: number;
    /** True when the turn deliberately waited for the next engine cycle. */
    waitedForRollover?: boolean;
    sampledTotalPlaytime: number;
    sampledAt: number;
    decisionAt: number;
    preparationMs: number;
    finalizationMs: number;
    totalPlanningMs: number;
    /** Time from the controller learning that Black owns the turn until the
     * irreversible makeMove/passTurn call. */
    readyToDispatchMs?: number;
    engineCycleMs: number;
    aiWaitMs: number;
    seedCandidates: number[];
    /** Public engine tick read immediately before the Go call. */
    dispatchPlaytime: number;
    /** Number of warm replans after finalization crossed a tick boundary. */
    boundaryRetries: number;
    /** Whether the position-wide preparation already existed when foreground
     * planning began. */
    positionCacheHit?: boolean;
    /** Whether the worker had pushed the matching next-turn decision before
     * foreground planning began. */
    pushedPredictionHit?: boolean;
    /** Whether dispatch-time assurance found its exact seed set complete. */
    seedCacheHit?: boolean;
  };
  /** Full opponent/board comparison in the same ETA units used to decide. */
  selection: {
    preferred: GoGameCandidateDigest;
    candidates: GoGameCandidateDigest[];
    context: {
      goPower: number;
      hasSourceFile14: boolean;
      favorRepCap: number;
      installRemainingSec?: number;
      joinedFactions: string[];
      demands: Partial<Record<GoRewardOpponent, GoEtaDemandDigest>>;
      factionFavor: Partial<Record<GoFactionOpponent, { favor: number; remainingWorkSec: number }>>;
    };
  };
}

export type GoResponse =
  | { type: "move"; x: number; y: number }
  | { type: "pass" | "gameOver"; x: null; y: null };

export interface GoTurnResult {
  at: number;
  durationMs: number;
  action: GoActionDigest;
  opponentResponse?: GoResponse;
  /** Expected seed support; an unseeded defense tie splits one seed's weight. */
  predictionSupport?: { matching: number; total: number };
  timing?: {
    alignment: "none" | "same-slot" | "boundary-replan";
    dispatchPlaytime?: number;
    seed?: number;
    readyToDispatchMs?: number;
  };
  ok: boolean;
  detail: string;
}
