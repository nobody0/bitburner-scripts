#pragma once

#include "go/decision.hpp"
#include "go/network_v9.hpp"

#include <vector>

namespace bitburner::go {

/** Deployed policy-only actor.  This is deliberately strict K=1: it returns
 * the highest-logit legal placement or pass and never consults the untrained
 * V9 value/auxiliary heads. */
Move select_strict_v9_move(
  const Position& position,
  Opponent opponent,
  double current_reply_seed,
  int elapsed_rounds,
  const GoNetworkV9& network
);

/** All legal placements plus pass, descending by policy logit with the same
 * stable scan-order tie break as production. */
std::vector<Move> rank_strict_v9_moves(
  const Position& position,
  Opponent opponent,
  double current_reply_seed,
  int elapsed_rounds,
  const GoNetworkV9& network
);

PolicyDecision choose_with_v9(
  const Position& position,
  Opponent opponent,
  const std::vector<double>& current_reply_seeds,
  int elapsed_rounds,
  const GoNetworkV9& network,
  int candidate_limit = 0
);

PolicyDecision choose_with_v9(
  const Position& position,
  Opponent opponent,
  double current_reply_seed,
  int elapsed_rounds,
  const GoNetworkV9& network,
  int candidate_limit = 0
);

}  // namespace bitburner::go
