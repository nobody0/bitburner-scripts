#pragma once

#include "go/state.hpp"

#include <string_view>
#include <vector>

namespace bitburner::go {

enum class Opponent { netburners, slum_snakes, black_hand, tetrads, daedalus, illuminati, world_daemon };
enum class ReplyBranch {
  capture,
  defend_capture,
  eye_move,
  surround,
  eye_block,
  corner,
  pattern,
  jump,
  growth,
  defend,
  expansion,
  random,
  pass,
};

struct ReplyWait {
  int cycle_waits_after_seed{};
  int fixed_sleep_ms_after_seed{};
};

struct WeightedReply {
  Move move{Move::pass_turn()};
  double probability{};
  ReplyBranch branch{ReplyBranch::pass};
  ReplyWait wait;
};

struct ReplyForecast {
  std::vector<WeightedReply> replies;
  bool exact{};
};

std::string_view opponent_name(Opponent opponent);
Opponent parse_opponent(std::string_view name);
std::string_view branch_name(ReplyBranch branch);

// total_playtime_ms is the current seed observed after the AI's initial wait.
// The sole remaining ambiguity is the upstream unseeded defense tie-break.
ReplyForecast predict_opponent_replies(
  const Position& position,
  Opponent opponent,
  double total_playtime_ms
);

}  // namespace bitburner::go
