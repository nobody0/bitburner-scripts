#pragma once

#include <string>
#include <vector>

namespace bitburner::go {

enum class Stone : char { black = 'X', white = 'O' };

struct Point {
  int x{};
  int y{};

  friend bool operator==(const Point&, const Point&) = default;
};

struct Move {
  bool pass{};
  // The upstream AI can very rarely select a priority move invalidated by
  // positional superko. The game logs the attempted coordinate, advances to
  // Black, but neither changes the board nor counts a pass.
  bool no_op{};
  Point point{};

  static Move at(int x, int y) { return {.pass = false, .no_op = false, .point = {x, y}}; }
  static Move pass_turn() { return {.pass = true, .no_op = false, .point = {-1, -1}}; }

  friend bool operator==(const Move&, const Move&) = default;
};

struct Board {
  int size{};
  // Bitburner's public board is column-major: columns[x][y].
  std::vector<std::string> columns;
};

struct Position {
  Board board;
  // Complete positional-superko history, most recent position first.
  std::vector<std::string> previous_hashes;
  int consecutive_passes{};
};

struct PlayedMove {
  Board board;
  int captures{};
};

struct Score {
  double black{};
  double white{};
};

}  // namespace bitburner::go
