#pragma once

#include "go/analysis.hpp"

#include <vector>

namespace bitburner::go {

std::vector<Point> pattern_moves(
  const Board& board,
  Stone player,
  const std::vector<Point>& available,
  bool smart
);

}  // namespace bitburner::go
