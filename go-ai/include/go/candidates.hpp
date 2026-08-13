#pragma once

#include "go/state.hpp"

#include <vector>

namespace bitburner::go {

// Canonical deployment shortlist. A nonpositive limit retains every legal
// placement. Pass is appended by callers so it cannot be displaced.
std::vector<Move> ordered_legal_moves(const Position& position, int limit = 0);

inline constexpr int daemon19_candidate_limit = 96;

}  // namespace bitburner::go
