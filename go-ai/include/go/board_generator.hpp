#pragma once

#include "go/opponent.hpp"
#include "go/state.hpp"

#include <cstdint>
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
};

StartingBoardFamily starting_board_family(int requested_size, Opponent opponent, double obstacle_seed);

}  // namespace bitburner::go
