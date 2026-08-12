#include "go/patterns.hpp"

#include "go/rules.hpp"

#include <algorithm>
#include <array>
#include <string>
#include <unordered_set>
#include <vector>

namespace bitburner::go {
namespace {

using Pattern = std::array<std::string, 3>;

const std::array<Pattern, 13> base_patterns{{
  {{"XOX", "...", "???"}},
  {{"XO.", "...", "?.?"}},
  {{"XO?", "X..", "o.?"}},
  {{".O.", "X..", "..."}},
  {{"XO?", "O.x", "?x?"}},
  {{"XO?", "O.X", "???"}},
  {{"?X?", "O.O", "xxx"}},
  {{"OX?", "x.O", "???"}},
  {{"X.?", "O.?", "   "}},
  {{"OX?", "X.O", "   "}},
  {{"?X?", "o.O", "   "}},
  {{"?XO", "o.o", "   "}},
  {{"?OX", "X.O", "   "}},
}};

Pattern rotate(const Pattern& value) {
  return {{{value[2][0], value[1][0], value[0][0]},
    {value[2][1], value[1][1], value[0][1]},
    {value[2][2], value[1][2], value[0][2]}}};
}

Pattern vertical(const Pattern& value) { return {{value[2], value[1], value[0]}}; }

const std::vector<Pattern>& patterns() {
  static const std::vector<Pattern> result = [] {
    std::vector<Pattern> rotated;
    rotated.reserve(base_patterns.size() * 4);
    for (const auto& base : base_patterns) {
      Pattern current = base;
      for (int turn = 0; turn < 4; ++turn) {
        rotated.push_back(current);
        current = rotate(current);
      }
    }
    const std::size_t count = rotated.size();
    for (std::size_t index = 0; index < count; ++index) rotated.push_back(vertical(rotated[index]));
    // Upstream's horizontal transform inserts commas with Array.join(). Those
    // malformed patterns can never match, so omitting them is behaviorally exact.
    return rotated;
  }();
  return result;
}

bool matches(char token, char cell, bool outside, Stone player) {
  const char own = static_cast<char>(player);
  const char enemy = static_cast<char>(player == Stone::black ? Stone::white : Stone::black);
  if (token == 'X') return !outside && cell == own;
  if (token == 'O') return !outside && cell == enemy;
  if (token == 'x') return outside || cell != enemy;
  if (token == 'o') return outside || cell != own;
  if (token == '.') return !outside && cell == '.';
  if (token == ' ') return !outside && cell == '#';
  return token == '?';
}

}  // namespace

std::vector<Point> pattern_moves(
  const Board& board,
  Stone player,
  const std::vector<Point>& available,
  bool smart
) {
  std::unordered_set<int> allowed;
  for (const auto point : available) allowed.insert(point.x * board.size + point.y);
  const Analysis analysis = analyze_board(board);
  std::vector<Point> result;
  for (int x = 0; x < board.size; ++x) for (int y = 0; y < board.size; ++y) {
    if (!allowed.contains(x * board.size + y)) continue;
    bool matched_pattern = false;
    for (const auto& pattern : patterns()) {
      bool matched = true;
      int index = 0;
      for (int dx = -1; dx <= 1 && matched; ++dx) for (int dy = -1; dy <= 1; ++dy) {
        const int px = x + dx;
        const int py = y + dy;
        const bool outside = px < 0 || py < 0 || px >= board.size || py >= board.size;
        const char cell = outside ? '#' : at(board, px, py);
        const char token = pattern[static_cast<std::size_t>(index / 3)][static_cast<std::size_t>(index % 3)];
        ++index;
        if (!matches(token, cell, outside, player)) { matched = false; break; }
      }
      if (matched) { matched_pattern = true; break; }
    }
    if (matched_pattern && (!smart || effective_liberties(analysis, x, y, player).size() > 1)) {
      result.push_back({x, y});
    }
  }
  return result;
}

}  // namespace bitburner::go
