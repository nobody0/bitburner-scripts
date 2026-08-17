import type { GoBoard } from "../teacher/strategy/decide.ts";
import {
  KataGoAdvisor,
  type KataGoAdvice,
  type KataGoForcedEvaluation,
  type KataGoMove,
} from "./advisor.ts";

export interface PredictedKataGoReply {
  move: KataGoMove;
  after: GoBoard;
  /** Exact terminal outcome, including a winning line where White passes and
   * Black will end the game with a pass on the next round. */
  exactScore?: { X: number; O: number };
  exactRemainingRounds?: 1 | 2;
}

export interface PredictiveKataGoInput {
  board: GoBoard;
  previousBoards: readonly string[][];
  consecutivePasses: number;
  elapsedRounds: number;
  komi: number;
  policyVisits: number;
  replyVisits: number;
  candidates: number;
  predict: (candidate: KataGoMove) => Promise<PredictedKataGoReply>;
}

export interface PredictiveCandidate {
  move: KataGoMove;
  predictedWhite: KataGoMove;
  prior?: number;
  evaluation: KataGoForcedEvaluation;
  exactOutcome: boolean;
  powerPerRound: number;
}

function terminalRank(candidate: PredictiveCandidate): number {
  if (!candidate.exactOutcome) return 0;
  return candidate.evaluation.winrate >= 1 ? 1 : -1;
}

export function comparePredictiveCandidates(
  a: PredictiveCandidate,
  b: PredictiveCandidate,
): number {
  // This is intentionally lexicographic. A microscopic win-probability edge
  // beats any amount of Power, mirroring the bespoke trainer's selection.
  return b.evaluation.winrate - a.evaluation.winrate
    || terminalRank(b) - terminalRank(a)
    || b.powerPerRound - a.powerPerRound
    || (b.prior ?? -1) - (a.prior ?? -1)
    || key(a.move).localeCompare(key(b.move));
}

export interface PredictiveKataGoAdvice extends KataGoAdvice {
  predictedWhite: KataGoMove;
  candidateCount: number;
  exactTerminal: boolean;
  selectionValue: number;
  candidates: PredictiveCandidate[];
}

function key(move: KataGoMove): string {
  return move === "pass" ? "pass" : `${move[0]},${move[1]}`;
}

function estimatedBlackScore(evaluation: KataGoForcedEvaluation, board: GoBoard, komi: number): number {
  const playable = board.rows.reduce((sum, column) =>
    sum + [...column].filter((cell) => cell !== "#").length, 0);
  return Math.max(0, Math.min(playable, (playable + komi + evaluation.scoreLead) / 2));
}

function estimatedPowerPerRound(
  evaluation: KataGoForcedEvaluation,
  reply: PredictedKataGoReply,
  input: PredictiveKataGoInput,
): number {
  if (reply.exactScore && reply.exactRemainingRounds) {
    return reply.exactScore.X / Math.max(input.elapsedRounds + reply.exactRemainingRounds, 1);
  }
  const empty = reply.after.rows.reduce((sum, column) =>
    sum + [...column].filter((cell) => cell === ".").length, 0);
  // Both candidates have consumed the current Black/White round. For the
  // unresolved suffix, two placements per round plus one closing pass round
  // is a deliberately simple, monotonic duration estimate.
  const estimatedRemaining = Math.max(1, Math.ceil(empty / 2) + 1);
  const blackScore = estimatedBlackScore(evaluation, reply.after, input.komi);
  return blackScore / Math.max(input.elapsedRounds + 1 + estimatedRemaining, 1);
}

/** Composes stock KataGo analysis with IPvGO's exact one-reply prediction.
 * KataGo itself remains unaware of the opponent identity and WHRNG seed. */
export class PredictiveKataGoAdvisor {
  constructor(private readonly kata: KataGoAdvisor) {}

  async advise(input: PredictiveKataGoInput): Promise<PredictiveKataGoAdvice> {
    const shortlist = await this.kata.shortlist(
      input.board,
      input.previousBoards,
      input.komi,
      input.policyVisits,
      Math.max(1, Math.floor(input.candidates)),
    );
    if (input.consecutivePasses > 0 && !shortlist.some((candidate) => candidate.move === "pass")) {
      shortlist.push({ move: "pass", visits: 0, prior: 0 });
    }

    // The vendored oracle uses process-global state, so predictions must be
    // resolved serially. Kata queries are submitted only after that phase.
    const predicted: {
      advice: KataGoAdvice;
      reply: PredictedKataGoReply;
    }[] = [];
    for (const advice of shortlist) {
      predicted.push({ advice, reply: await input.predict(advice.move) });
    }

    const evaluated = await Promise.all(predicted.map(async ({ advice, reply }): Promise<PredictiveCandidate> => {
      let evaluation: KataGoForcedEvaluation;
      const exactOutcome = reply.exactScore !== undefined;
      if (reply.exactScore) {
        const scoreLead = reply.exactScore.X - reply.exactScore.O;
        evaluation = {
          visits: 0,
          winrate: scoreLead >= 0 ? 1 : 0,
          scoreLead,
        };
      } else {
        evaluation = await this.kata.evaluateForcedReply(
          input.board,
          input.komi,
          input.replyVisits,
          advice.move,
          reply.move,
        );
      }
      return {
        move: advice.move,
        predictedWhite: reply.move,
        ...(advice.prior !== undefined ? { prior: advice.prior } : {}),
        evaluation,
        exactOutcome,
        powerPerRound: estimatedPowerPerRound(evaluation, reply, input),
      };
    }));
    evaluated.sort(comparePredictiveCandidates);
    const selected = evaluated[0];
    if (!selected) throw new Error("KataGo predictive shortlist was empty");
    return {
      move: selected.move,
      proposalMoves: evaluated.map((candidate) => candidate.move),
      visits: selected.evaluation.visits,
      ...(selected.prior !== undefined ? { prior: selected.prior } : {}),
      winrate: selected.evaluation.winrate,
      scoreLead: selected.evaluation.scoreLead,
      predictedWhite: selected.predictedWhite,
      candidateCount: evaluated.length,
      exactTerminal: selected.exactOutcome,
      selectionValue: selected.powerPerRound,
      candidates: evaluated,
    };
  }
}
