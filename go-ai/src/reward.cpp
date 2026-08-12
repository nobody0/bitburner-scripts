#include "go/reward.hpp"

#include <algorithm>
#include <stdexcept>

namespace bitburner::go {

double difficulty_multiplier(std::string_view opponent, int board_size) {
  if (opponent == "Illuminati" && board_size == 5) return 8.0;
  double komi = 0;
  if (opponent == "Netburners") komi = 1.5;
  else if (opponent == "Slum Snakes" || opponent == "The Black Hand") komi = 3.5;
  else if (opponent == "Tetrads" || opponent == "Daedalus") komi = 5.5;
  else if (opponent == "Illuminati") komi = 7.5;
  else if (opponent == "????????????") komi = 9.5;
  else throw std::invalid_argument("unknown Go opponent");
  return (komi + 0.5) * 0.25;
}

TerminalReward terminal_reward(
  const Score& score,
  std::string_view opponent,
  int board_size
) {
  const bool won = score.black >= score.white;
  const double power = score.black * difficulty_multiplier(opponent, board_size);
  return {
    .won = won,
    .game_power = power,
    .training_power = won ? power : power * 0.5,
  };
}

}  // namespace bitburner::go
