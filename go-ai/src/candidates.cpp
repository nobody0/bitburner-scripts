#include "go/candidates.hpp"

#include "go/rules.hpp"

#include <algorithm>
#include <cmath>
#include <string>
#include <unordered_set>

namespace bitburner::go {

std::vector<Move> ordered_legal_moves(const Position& position, int limit) {
  struct Ordered { Move move; double score{}; };
  std::vector<Ordered> ordered;
  const double centre = (position.board.size - 1) / 2.0;
  const std::unordered_set<std::string> history(
    position.previous_hashes.begin(), position.previous_hashes.end());
  for (int x = 0; x < position.board.size; ++x) for (int y = 0; y < position.board.size; ++y) {
    const auto played = play_move(position.board, {x, y}, Stone::black, history);
    if (!played) continue;
    int adjacent = 0;
    constexpr int dx[] = {0, 1, 0, -1};
    constexpr int dy[] = {1, 0, -1, 0};
    for (int direction = 0; direction < 4; ++direction) {
      const char cell = at(position.board, x + dx[direction], y + dy[direction]);
      adjacent += cell == 'X' ? 3 : cell == 'O' ? 2 : cell == '.' ? 1 : 0;
    }
    const double centrality = position.board.size
      - std::abs(x - centre) - std::abs(y - centre);
    ordered.push_back({Move::at(x, y),
      played->captures * 1'000.0 + adjacent * 10.0 + centrality * 0.02});
  }
  if (limit > 0 && static_cast<int>(ordered.size()) > limit) {
    std::stable_sort(ordered.begin(), ordered.end(), [](const Ordered& left, const Ordered& right) {
      if (left.score != right.score) return left.score > right.score;
      if (left.move.point.x != right.move.point.x) return left.move.point.x < right.move.point.x;
      return left.move.point.y < right.move.point.y;
    });
    ordered.resize(static_cast<std::size_t>(limit));
  }
  std::vector<Move> result;
  result.reserve(ordered.size());
  for (const auto& item : ordered) result.push_back(item.move);
  return result;
}

}  // namespace bitburner::go
