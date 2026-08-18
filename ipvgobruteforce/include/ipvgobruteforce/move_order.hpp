#pragma once

#include "go/state.hpp"

#include <vector>

namespace ipvgobruteforce {

/** Proof-neutral Black action ordering: immediate winning second pass, then
 * most resulting Black stones, least resulting White stones, stable hash tie. */
std::vector<bitburner::go::Move> ordered_black_moves(
  const bitburner::go::Position& position,
  double komi
);

}  // namespace ipvgobruteforce
