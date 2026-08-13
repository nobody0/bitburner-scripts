#pragma once

#include "go/opponent.hpp"
#include "go/state.hpp"

namespace bitburner::go {

struct PolicyDecision {
  Move move{Move::pass_turn()};
  ReplyForecast known_replies;
  double win_probability{};
  double power_per_round{};
};

}  // namespace bitburner::go
