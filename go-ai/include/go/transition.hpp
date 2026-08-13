#pragma once

#include "go/state.hpp"

namespace bitburner::go {

void apply_to_position(Position& position, Move move, Stone player);

}  // namespace bitburner::go
