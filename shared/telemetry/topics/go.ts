/** Go (IPvGO) feature — BN14's theme. Problem: a board game. Maximise
 * territory captured per game against each faction opponent, since win streaks
 * grant escalating stat/hacking bonuses. Board play is self-contained; the
 * opponent choice is intentionally coupled to the other features' needs. */

import type {
  GoCurrentPlayer,
  GoMove,
  GoOpponent,
  GoObservedBoardSize,
  GoRewardOpponent,
  GoStatus,
} from "../../strategy/go/rules.ts";
import type { GoEtaDemand, GoGameCandidate } from "../../strategy/go/rewards.ts";
import type { GoDispatchBreakdown } from "../../strategy/go/tick.ts";
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
  | { type: "cheatTwoMoves"; x1: number; y1: number; x2: number; y2: number }
  | { type: "cheatRemoveRouter" | "cheatDestroyNode" | "cheatRepairNode"; x: number; y: number }
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
  cheat?: {
    unlocked: boolean;
    count: number;
    successChance: number;
  };
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
    /** Read back by `sameGoPosition` to decide whether a stored plan still
     * describes the live position. */
    status: GoStatus;
    currentPlayer: GoCurrentPlayer;
    komi?: number;
  };
  planning: { finalistCount: number; positionValue: number };
  /** Full opponent/board comparison in the same ETA units used to decide. */
  selection: {
    preferred: GoGameCandidateDigest;
    candidates: GoGameCandidateDigest[];
    /** New-game scheduling verdict: play the preferred candidate, fit a
     * filler game inside its certified entry window, or hold the cadence. */
    schedule?: { kind: "play" | "filler" | "hold"; fillerOpponent?: GoRewardOpponent; holdSec?: number; why: string };
    /** Whether the next game would repay the fleet RAM its dodge displaces,
     * and the numbers behind the answer. Published even when it PASSES: a Go
     * that has gone quiet must say which of "not worth it" and "broken" it is,
     * and a silent early return says neither. `opponent` is whose value pays —
     * a filler is priced by the window it fills, not by itself. */
    ramGate?: {
      pays: boolean;
      opponent: GoRewardOpponent;
      utilityPerSec: number;
      displacedGb: number;
      usableGb: number;
      why: string;
    };
    context: {
      goPower: number;
      hasSourceFile14: boolean;
      favorRepCap: number;
      installRemainingSec?: number;
      joinedFactions: string[];
      /** Each announcer's measured share of live money production, the input
       * that decides how much of a money bottleneck each reward may claim. */
      incomeShares?: Record<string, number>;
      demands: Partial<Record<GoRewardOpponent, GoEtaDemandDigest>>;
    };
  };
}

/** How the dispatched action was computed and timed.
 *
 * This belongs to the completed turn, not to the forward-looking plan: Go
 * re-enters planning on a microtask after each turn, so a digest parked on
 * `plan` is replaced by the next provisional plan before most viewers ever
 * see it. */
export interface GoTurnPrediction {
  model: typeof GO_OPPONENT_MODEL;
  /** Value-network execution path actually used for this decision. */
  backend?: "webgpu" | "aggregate";
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
  /** Absent when the worker already held the prepared position: no
   * preparation ran this turn, so there is nothing to report. Zero would
   * read as instantaneous work rather than as work that did not happen. */
  preparationMs?: number;
  /** Worker-clock cost of the seed-exact evaluation. On a pushed prediction
   * hit this was measured speculatively during the previous White response,
   * not on this turn's critical path; `pushedPredictionHit` says which. */
  finalizationMs: number;
  totalPlanningMs: number;
  /** Time from the controller learning that Black owns the turn until the
   * irreversible makeMove/passTurn call, split into disjoint segments.
   * Absent when no such boundary was held, rather than approximated. */
  dispatchBreakdown?: GoDispatchBreakdown;
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
  /** True when the dispatched action came from the certified merged
   * playbook rather than the neural decision. */
  playbook?: true;
}

export type GoResponse =
  | { type: "move"; x: number; y: number }
  | { type: "pass" | "gameOver"; x: null; y: null };

export interface GoTurnResult {
  at: number;
  durationMs: number;
  action: GoActionDigest;
  opponentResponse?: GoResponse;
  /** Forecast weight the model placed on the reply that actually arrived.
   * `matching / total` is a per-turn predictive hit rate, not a self-check. */
  predictionSupport?: { matching: number; total: number };
  /** Absent on turns that dispatched without seed assurance: a reset, a
   * resume, or the unseeded fallback. Its presence is what distinguishes
   * those from an aligned turn, so nothing else needs to record alignment. */
  prediction?: GoTurnPrediction;
  ok: boolean;
  detail: string;
}
