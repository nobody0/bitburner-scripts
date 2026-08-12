#pragma once

#include "go/state.hpp"

#include <string_view>

namespace bitburner::go {

struct TerminalReward {
  bool won{};
  double game_power{};
  // Training deliberately halves a losing game's Power while win count remains
  // the lexicographically primary objective.
  double training_power{};
};

double difficulty_multiplier(std::string_view opponent, int board_size);
TerminalReward terminal_reward(
  const Score& score,
  std::string_view opponent,
  int board_size
);

}  // namespace bitburner::go
