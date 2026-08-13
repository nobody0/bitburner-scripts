#pragma once

#include "go/state.hpp"

#include <string_view>

namespace bitburner::go {

struct TerminalReward {
  bool won{};
  /** Exact game reward, retained for reporting only. */
  double game_power{};
  /** Opponent-normalized learning utility: raw Black score, halved on a loss.
   * The immutable difficulty multiplier must not dilute within-game move
   * ranking. Kept under the historical field name until telemetry migrates. */
  double training_power{};
};

double difficulty_multiplier(std::string_view opponent, int board_size);
TerminalReward terminal_reward(
  const Score& score,
  std::string_view opponent,
  int board_size
);

}  // namespace bitburner::go
