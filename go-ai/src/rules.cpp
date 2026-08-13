#include "go/rules.hpp"

#include <array>
#include <cstddef>
#include <stdexcept>
#include <utility>

namespace bitburner::go {
namespace {

Stone other(Stone stone) {
  return stone == Stone::black ? Stone::white : Stone::black;
}

Board write(const Board& board, int x, int y, char cell) {
  Board result = board;
  result.columns.at(static_cast<std::size_t>(x)).at(static_cast<std::size_t>(y)) = cell;
  return result;
}

struct Group {
  std::vector<int> stones;
  int liberties{};
};

Group group(const Board& board, int x, int y) {
  const int size = board.size;
  const char colour = at(board, x, y);
  Group result;
  if (colour != static_cast<char>(Stone::black) && colour != static_cast<char>(Stone::white)) return result;

  std::vector<unsigned char> seen(static_cast<std::size_t>(size * size));
  std::vector<unsigned char> liberty_seen(static_cast<std::size_t>(size * size));
  std::vector<int> stack;
  stack.push_back(x * size + y);
  seen[static_cast<std::size_t>(x * size + y)] = 1;
  constexpr std::array<std::pair<int, int>, 4> directions{{{1, 0}, {-1, 0}, {0, 1}, {0, -1}}};
  while (!stack.empty()) {
    const int point = stack.back();
    stack.pop_back();
    result.stones.push_back(point);
    const int px = point / size;
    const int py = point % size;
    for (const auto [dx, dy] : directions) {
      const int nx = px + dx;
      const int ny = py + dy;
      if (nx < 0 || ny < 0 || nx >= size || ny >= size) continue;
      const auto next = static_cast<std::size_t>(nx * size + ny);
      const char cell = at(board, nx, ny);
      if (cell == colour && seen[next] == 0) {
        seen[next] = 1;
        stack.push_back(static_cast<int>(next));
      } else if (cell == '.' && liberty_seen[next] == 0) {
        liberty_seen[next] = 1;
        ++result.liberties;
      }
    }
  }
  return result;
}

}  // namespace

char at(const Board& board, int x, int y) {
  if (x < 0 || y < 0 || x >= board.size || y >= board.size) return '#';
  return board.columns.at(static_cast<std::size_t>(x)).at(static_cast<std::size_t>(y));
}

std::string board_hash(const Board& board) {
  std::string result;
  result.reserve(static_cast<std::size_t>(board.size * board.size));
  for (const auto& column : board.columns) result += column;
  return result;
}

Board board_from_hash(int size, const std::string& hash) {
  if (size <= 0 || hash.size() != static_cast<std::size_t>(size * size)) {
    throw std::invalid_argument("board hash does not match size");
  }
  Board board{.size = size};
  board.columns.reserve(static_cast<std::size_t>(size));
  for (int x = 0; x < size; ++x) {
    board.columns.push_back(hash.substr(static_cast<std::size_t>(x * size), static_cast<std::size_t>(size)));
  }
  return board;
}

Board evaluate_move(const Board& board, Point move, Stone stone) {
  if (at(board, move.x, move.y) == '#') return board;
  Board next = write(board, move.x, move.y, static_cast<char>(stone));
  bool captured_enemy = false;
  std::vector<unsigned char> checked(static_cast<std::size_t>(board.size * board.size));
  constexpr std::array<std::pair<int, int>, 4> directions{{{0, 1}, {1, 0}, {0, -1}, {-1, 0}}};
  for (const auto [dx, dy] : directions) {
    const int nx = move.x + dx;
    const int ny = move.y + dy;
    if (nx < 0 || ny < 0 || nx >= board.size || ny >= board.size) continue;
    const auto neighbor = static_cast<std::size_t>(nx * board.size + ny);
    if (at(next, nx, ny) != static_cast<char>(other(stone)) || checked[neighbor] != 0) continue;
    const Group enemy = group(next, nx, ny);
    for (const int point : enemy.stones) checked[static_cast<std::size_t>(point)] = 1;
    if (enemy.liberties != 0) continue;
    captured_enemy = true;
    for (const int point : enemy.stones) next = write(next, point / board.size, point % board.size, '.');
  }
  if (!captured_enemy) {
    const Group own = group(next, move.x, move.y);
    if (own.liberties == 0) for (const int point : own.stones) {
      next = write(next, point / board.size, point % board.size, '.');
    }
  }
  return next;
}

std::optional<PlayedMove> play_move(
  const Board& board,
  Point move,
  Stone stone,
  const std::unordered_set<std::string>& previous_hashes
) {
  if (at(board, move.x, move.y) != '.') return std::nullopt;
  Board next = write(board, move.x, move.y, static_cast<char>(stone));
  int captures = 0;
  std::vector<unsigned char> checked(static_cast<std::size_t>(board.size * board.size));
  constexpr std::array<std::pair<int, int>, 4> directions{{{1, 0}, {-1, 0}, {0, 1}, {0, -1}}};
  for (const auto [dx, dy] : directions) {
    const int nx = move.x + dx;
    const int ny = move.y + dy;
    if (nx < 0 || ny < 0 || nx >= board.size || ny >= board.size) continue;
    const auto neighbor = static_cast<std::size_t>(nx * board.size + ny);
    if (at(next, nx, ny) != static_cast<char>(other(stone)) || checked[neighbor] != 0) continue;
    const Group enemy = group(next, nx, ny);
    for (const int point : enemy.stones) checked[static_cast<std::size_t>(point)] = 1;
    if (enemy.liberties != 0) continue;
    captures += static_cast<int>(enemy.stones.size());
    for (const int point : enemy.stones) next = write(next, point / board.size, point % board.size, '.');
  }
  if (group(next, move.x, move.y).liberties == 0) return std::nullopt;
  if (previous_hashes.contains(board_hash(next))) return std::nullopt;
  return PlayedMove{.board = std::move(next), .captures = captures};
}

std::vector<Point> legal_moves(const Position& position, Stone stone) {
  const std::unordered_set<std::string> history(position.previous_hashes.begin(), position.previous_hashes.end());
  const int size = position.board.size;
  const int area = size * size;
  std::vector<int> liberties(static_cast<std::size_t>(area), -1);
  for (int x = 0; x < size; ++x) for (int y = 0; y < size; ++y) {
    const int point = x * size + y;
    const char cell = at(position.board, x, y);
    if ((cell != 'X' && cell != 'O') || liberties[static_cast<std::size_t>(point)] >= 0) continue;
    const Group found = group(position.board, x, y);
    for (const int member : found.stones) {
      liberties[static_cast<std::size_t>(member)] = found.liberties;
    }
  }
  std::vector<Point> result;
  const std::string current_hash = history.empty() ? std::string{} : board_hash(position.board);
  constexpr std::array<std::pair<int, int>, 4> directions{{{1, 0}, {-1, 0}, {0, 1}, {0, -1}}};
  for (int x = 0; x < size; ++x) for (int y = 0; y < size; ++y) {
    if (at(position.board, x, y) != '.') continue;
    bool survives = false;
    bool captures = false;
    for (const auto [dx, dy] : directions) {
      const int nx = x + dx;
      const int ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= size || ny >= size) continue;
      const char cell = at(position.board, nx, ny);
      if (cell == '.') survives = true;
      else if (cell == static_cast<char>(stone)
        && liberties[static_cast<std::size_t>(nx * size + ny)] > 1) survives = true;
      else if (cell == static_cast<char>(other(stone))
        && liberties[static_cast<std::size_t>(nx * size + ny)] == 1) captures = true;
    }
    bool repeats = false;
    if (survives && !captures && !history.empty()) {
      std::string next_hash = current_hash;
      next_hash[static_cast<std::size_t>(x * size + y)] = static_cast<char>(stone);
      repeats = history.contains(next_hash);
    }
    if (captures ? play_move(position.board, {x, y}, stone, history).has_value()
      : survives && !repeats) {
      result.push_back({x, y});
    }
  }
  return result;
}

Score score_board(const Board& board, double komi) {
  double black = 0;
  double white = komi;
  const int area = board.size * board.size;
  std::vector<unsigned char> seen(static_cast<std::size_t>(area));
  constexpr std::array<std::pair<int, int>, 4> directions{{{1, 0}, {-1, 0}, {0, 1}, {0, -1}}};
  for (int x = 0; x < board.size; ++x) {
    for (int y = 0; y < board.size; ++y) {
      const char cell = at(board, x, y);
      if (cell == 'X') {
        ++black;
        continue;
      }
      if (cell == 'O') {
        ++white;
        continue;
      }
      const auto start = static_cast<std::size_t>(x * board.size + y);
      if (cell != '.' || seen[start] != 0) continue;

      int region_size = 0;
      bool borders_black = false;
      bool borders_white = false;
      std::vector<int> stack{static_cast<int>(start)};
      while (!stack.empty()) {
        const int point = stack.back();
        stack.pop_back();
        const auto index = static_cast<std::size_t>(point);
        if (seen[index] != 0) continue;
        const int px = point / board.size;
        const int py = point % board.size;
        if (at(board, px, py) != '.') continue;
        seen[index] = 1;
        ++region_size;
        for (const auto [dx, dy] : directions) {
          const int nx = px + dx;
          const int ny = py + dy;
          if (nx < 0 || ny < 0 || nx >= board.size || ny >= board.size) continue;
          const char adjacent = at(board, nx, ny);
          if (adjacent == '.') stack.push_back(nx * board.size + ny);
          else if (adjacent == 'X') borders_black = true;
          else if (adjacent == 'O') borders_white = true;
        }
      }
      if (region_size <= area - 3 && borders_black != borders_white) {
        if (borders_black) black += region_size;
        else white += region_size;
      }
    }
  }
  return {.black = black, .white = white};
}

}  // namespace bitburner::go
