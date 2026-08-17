#pragma once

#include "go/opponent.hpp"
#include "go/state.hpp"

#include <cstdint>
#include <optional>
#include <vector>

namespace bitburner::go {

// Reproduces v3.0.1 obstacle generation. handicap_seed controls the one
// intentionally unseeded Math.random branch separately from WHRNG.
Board initial_board(int requested_size, Opponent opponent, double obstacle_seed, std::uint32_t handicap_seed);

struct StartingBoardFamily {
  Board board_before_handicap;
  int handicap{};
  // Upstream chooses distinct points from this fixed expansion list. On 5x5,
  // the center is included when the separate 20% shortcut can choose it.
  std::vector<Point> possible_handicap_points;
  /** True when upstream applyHandicap can place no stone at all: its expansion
   * move list is empty, so outside the optional 20% 5x5 center shortcut the
   * placement loop has nothing to choose and the board stays unmodified. */
  bool handicap_may_be_absent{};
};

StartingBoardFamily starting_board_family(int requested_size, Opponent opponent, double obstacle_seed);

struct StartingBoardVariant {
  Board board;
  /** The placed handicap stone; empty for the no-stone outcome. */
  std::optional<Point> handicap_point;
};

/** Every distinct initial board the unseeded handicap placement can produce
 * from one family, including the no-stone outcome when it is possible.
 * Supports at most one handicap stone (the packed 5x5 system). */
std::vector<StartingBoardVariant> starting_board_variants(const StartingBoardFamily& family);

}  // namespace bitburner::go
