#pragma once

#include "go/opponent.hpp"
#include "go/reward.hpp"

#include <cstdint>
#include <random>
#include <vector>

namespace bitburner::go {

enum class BlackPolicy { random, known_reply_greedy };

struct GameConfig {
  Opponent opponent{Opponent::illuminati};
  int board_size{5};
  std::uint64_t seed{};
};

struct GameStep {
  std::string before;
  Move black;
  double current_reply_seed{};
  Move white;
  std::string after;
};

struct GameResult {
  GameConfig config;
  bool completed{};
  bool won{};
  int rounds{};
  Score score;
  TerminalReward reward;
  std::vector<GameStep> trace;
};

GameResult play_game(const GameConfig& config, BlackPolicy policy, bool include_trace = false);
double opponent_komi(Opponent opponent);

}  // namespace bitburner::go
