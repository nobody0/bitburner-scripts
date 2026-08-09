// Vendored from bitburner-src v3.0.1:src/Go/boardAnalysis/scoring.ts (4 symbols, extracted by
// tools/vendor.ts — the rest of that file is not portable) — DO NOT EDIT
import type { Board, BoardState, PointState } from "../Types";
import { GoColor } from "../Enums";
import { getKomi } from "./KomiOracle";
import { getAllChains, getPlayerNeighbors } from "./boardAnalysis";
import { isNotNullish } from "../boardState/boardState";

export function getScore(boardState: BoardState) {
  const komi = getKomi(boardState) ?? 6.5;
  const whitePieces = getColoredPieceCount(boardState, GoColor.white);
  const blackPieces = getColoredPieceCount(boardState, GoColor.black);
  const territoryScores = getTerritoryScores(boardState.board);

  return {
    [GoColor.white]: {
      pieces: whitePieces,
      territory: territoryScores[GoColor.white],
      komi: komi,
      sum: whitePieces + territoryScores[GoColor.white] + komi,
    },
    [GoColor.black]: {
      pieces: blackPieces,
      territory: territoryScores[GoColor.black],
      komi: 0,
      sum: blackPieces + territoryScores[GoColor.black],
    },
  };
}

function getColoredPieceCount(boardState: BoardState, color: GoColor) {
  return boardState.board.reduce(
    (sum, row) => sum + row.filter(isNotNullish).filter((point) => point.color === color).length,
    0,
  );
}

function getTerritoryScores(board: Board) {
  const emptyTerritoryChains = getAllChains(board).filter((chain) => chain?.[0]?.color === GoColor.empty);

  return emptyTerritoryChains.reduce(
    (scores, currentChain) => {
      const chainColor = checkTerritoryOwnership(board, currentChain);
      return {
        [GoColor.white]: scores[GoColor.white] + (chainColor === GoColor.white ? currentChain.length : 0),
        [GoColor.black]: scores[GoColor.black] + (chainColor === GoColor.black ? currentChain.length : 0),
      };
    },
    {
      [GoColor.white]: 0,
      [GoColor.black]: 0,
    },
  );
}

function checkTerritoryOwnership(board: Board, emptyPointChain: PointState[]) {
  if (emptyPointChain.length > board[0].length ** 2 - 3) {
    return null;
  }

  const playerNeighbors = getPlayerNeighbors(board, emptyPointChain);
  const hasWhitePieceNeighbors = playerNeighbors.find((p) => p.color === GoColor.white);
  const hasBlackPieceNeighbors = playerNeighbors.find((p) => p.color === GoColor.black);
  const isWhiteTerritory = hasWhitePieceNeighbors && !hasBlackPieceNeighbors;
  const isBlackTerritory = hasBlackPieceNeighbors && !hasWhitePieceNeighbors;
  return isWhiteTerritory ? GoColor.white : isBlackTerritory ? GoColor.black : null;
}
