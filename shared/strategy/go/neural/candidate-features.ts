/** Exact candidate facts computed after Black and the seeded White response. */
import {
  GO_OPPONENT_BRANCHES,
  predictOpponentReplies,
} from "../opponent.ts";
import {
  group,
  playMove,
  scoreBoard,
  type GoBoard,
  type GoRewardOpponent,
} from "../rules.ts";

export const GO_CANDIDATE_RESPONSE_FEATURES = GO_OPPONENT_BRANCHES.length + 11;

function stones(board: GoBoard, color: "X" | "O"): number {
  return board.rows.reduce((sum, row) => sum
    + [...row].filter((cell) => cell === color).length, 0);
}

/**
 * Shared scorer input for one legal Black action. It deliberately contains no
 * teacher action or outcome label. The first 13 values are the exact White
 * branch distribution; the remainder describes the actual post-reply result.
 */
export function candidateResponseFeatures(
  board: GoBoard,
  previousBoards: readonly string[][],
  consecutivePasses: number,
  opponent: GoRewardOpponent,
  komi: number,
  opponentSeed: number,
  action: number,
): Float32Array {
  const area = board.size * board.size;
  if (!Number.isSafeInteger(action) || action < 0 || action > area) {
    throw new Error("candidate response action is outside the board");
  }
  const history = new Set(previousBoards.map((prior) => prior.join("")));
  const pass = action === area;
  const x = Math.floor(action / board.size), y = action % board.size;
  const played = pass ? undefined : playMove(board, x, y, "X", history);
  if (!pass && !played) throw new Error("candidate response action is illegal");
  const afterBlack = played?.board ?? board;
  const blackPasses = pass ? consecutivePasses + 1 : 0;
  const responseHistory = pass ? previousBoards : [board.rows, ...previousBoards];
  const result = new Float32Array(GO_CANDIDATE_RESPONSE_FEATURES);
  const branchOffset = 0;
  const dxIndex = GO_OPPONENT_BRANCHES.length;
  const dyIndex = dxIndex + 1;
  const passIndex = dxIndex + 2;
  const noOpIndex = dxIndex + 3;
  const survivesIndex = dxIndex + 4;
  const libertiesIndex = dxIndex + 5;
  const blackCaptureIndex = dxIndex + 6;
  const whiteCaptureIndex = dxIndex + 7;
  const terminalIndex = dxIndex + 8;
  const blackPowerIndex = dxIndex + 9;
  const marginIndex = dxIndex + 10;
  const whiteBefore = stones(board, "O");
  const blackAfterMove = stones(afterBlack, "X");
  const blackCapture = whiteBefore - stones(afterBlack, "O");

  const replies = blackPasses >= 2
    ? [{ move: undefined, probability: 1, branch: "pass" as const }]
    : predictOpponentReplies(
      afterBlack, opponent, opponentSeed, responseHistory, blackPasses).replies;
  const replyHistory = new Set(responseHistory.map((prior) => prior.join("")));
  for (const reply of replies) {
    const probability = reply.probability;
    const branch = GO_OPPONENT_BRANCHES.indexOf(reply.branch);
    result[branchOffset + branch]! += probability;
    if (!reply.move) result[passIndex]! += probability;
    else {
      result[dxIndex]! += probability * (reply.move.x - x) / Math.max(board.size - 1, 1);
      result[dyIndex]! += probability * (reply.move.y - y) / Math.max(board.size - 1, 1);
    }
    const white = reply.move
      ? playMove(afterBlack, reply.move.x, reply.move.y, "O", replyHistory)
      : undefined;
    if (reply.move && !white) result[noOpIndex]! += probability;
    const afterReply = white?.board ?? afterBlack;
    const responsePasses = reply.move ? blackPasses : blackPasses + 1;
    if (responsePasses >= 2) result[terminalIndex]! += probability;
    const survived = !pass && afterReply.rows[x]![y] === "X";
    if (survived) {
      result[survivesIndex]! += probability;
      result[libertiesIndex]! += probability
        * Math.min(group(afterReply, x, y).liberties, 4) / 4;
    }
    result[whiteCaptureIndex]! += probability
      * Math.max(0, blackAfterMove - stones(afterReply, "X")) / area;
    const score = scoreBoard(afterReply, komi);
    result[blackPowerIndex]! += probability * score.X / area;
    result[marginIndex]! += probability * (score.X - score.O) / area;
  }
  result[blackCaptureIndex] = blackCapture / area;
  return result;
}
