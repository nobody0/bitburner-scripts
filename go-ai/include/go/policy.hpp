#pragma once

#include "go/network.hpp"
#include "go/opponent.hpp"
#include "go/state.hpp"

namespace bitburner::go {

struct PolicyDecision {
  Move move{Move::pass_turn()};
  ReplyForecast known_replies;
  double win_probability{};
  double power_per_round{};
};

PolicyDecision choose_with_network(
  const Position& position,
  Opponent opponent,
  double current_reply_seed,
  int elapsed_rounds,
  const CandidateValueNetwork& network
);

}  // namespace bitburner::go
