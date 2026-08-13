#pragma once

#include "go/state.hpp"

#include <optional>
#include <unordered_set>
#include <vector>

namespace bitburner::go {

struct Chain {
  int id{};
  char color{};
  std::vector<Point> points;
  std::vector<Point> liberties;
};

struct Analysis {
  Board board;
  std::vector<Chain> chains;
  // x * size + y -> index in chains, or -1 for offline nodes.
  std::vector<int> chain_at;
  mutable std::vector<std::vector<int>> neighbor_cache;
  mutable std::vector<unsigned char> neighbor_ready;
};

struct EyeCandidate {
  int chain{};
  std::vector<int> neighbors;
};

std::vector<Point> cardinal(const Board& board, int x, int y);
Analysis analyze_board(const Board& board);
std::vector<int> neighboring_chains(const Analysis& analysis, const std::vector<Point>& points);
std::vector<Point> effective_liberties(const Analysis& analysis, int x, int y, Stone player);
const Chain* weakest_neighbor_chain(const Analysis& analysis, int x, int y, Stone player);
std::vector<EyeCandidate> potential_eyes(const Analysis& analysis, Stone player, std::optional<int> max_size = std::nullopt);
std::vector<std::vector<int>> eyes_by_chain(const Analysis& analysis, Stone player);
std::vector<std::vector<int>> all_eyes(const Analysis& analysis, Stone player);
std::vector<Point> disputed_territory(
  const Position& position,
  Stone player,
  bool exclude_friendly_eyes,
  const Analysis& analysis,
  const std::vector<Point>& legal
);
std::vector<Point> disputed_moves(
  const Analysis& analysis,
  const std::vector<Point>& available,
  int max_chain_size = 99
);

}  // namespace bitburner::go
