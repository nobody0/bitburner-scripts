#pragma once

#include "go/decision.hpp"
#include "go/network_v9.hpp"

namespace bitburner::go {

PolicyDecision choose_with_v9(
  const Position& position,
  Opponent opponent,
  double current_reply_seed,
  int elapsed_rounds,
  const GoNetworkV9& network,
  int candidate_limit = 0
);

}  // namespace bitburner::go
