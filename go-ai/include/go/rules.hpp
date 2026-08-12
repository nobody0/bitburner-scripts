#pragma once

#include "go/state.hpp"

#include <optional>
#include <string>
#include <unordered_set>
#include <vector>

namespace bitburner::go {

char at(const Board& board, int x, int y);
std::string board_hash(const Board& board);
Board board_from_hash(int size, const std::string& hash);

// Upstream AI analysis sometimes evaluates a hypothetical without first
// checking legality. A suicidal hypothetical removes its newly placed chain.
Board evaluate_move(const Board& board, Point move, Stone stone);

std::optional<PlayedMove> play_move(
  const Board& board,
  Point move,
  Stone stone,
  const std::unordered_set<std::string>& previous_hashes = {}
);

std::vector<Point> legal_moves(const Position& position, Stone stone);
Score score_board(const Board& board, double komi);

}  // namespace bitburner::go
