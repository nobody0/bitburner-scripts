#include "go/arena.hpp"

#include <algorithm>
#include <array>
#include <cstdlib>
#include <iomanip>
#include <iostream>
#include <map>
#include <optional>
#include <random>
#include <stdexcept>
#include <string>

namespace {

using namespace bitburner::go;

struct Aggregate {
  int games{};
  int wins{};
  int completed{};
  int rounds{};
  double game_power{};
  double training_power{};
};

std::string move_name(Move move) {
  return move.pass ? "pass" : std::to_string(move.point.x) + "," + std::to_string(move.point.y);
}

}  // namespace

int main(int argc, char** argv) {
  try {
    const int games = argc >= 2 ? std::stoi(argv[1]) : 64;
    const std::uint64_t seed = argc >= 3 ? std::stoull(argv[2]) : 0x5eedULL;
    const BlackPolicy policy = argc >= 4 && std::string(argv[3]) == "random"
      ? BlackPolicy::random : BlackPolicy::known_reply_greedy;
    const auto fixed_opponent = argc >= 5 ? std::optional<Opponent>(parse_opponent(argv[4])) : std::nullopt;
    const auto fixed_size = argc >= 6 ? std::optional<int>(std::stoi(argv[5])) : std::nullopt;
    const std::array<Opponent, 7> opponents{{Opponent::netburners, Opponent::slum_snakes,
      Opponent::black_hand, Opponent::tetrads, Opponent::daedalus, Opponent::illuminati,
      Opponent::world_daemon}};
    const std::array<int, 4> sizes{{5, 7, 9, 13}};
    std::mt19937_64 random(seed);
    std::uniform_int_distribution<std::size_t> enemy(0, opponents.size() - 1);
    std::uniform_int_distribution<std::size_t> size(0, sizes.size() - 1);
    std::map<std::pair<Opponent, int>, Aggregate> totals;
    for (int index = 0; index < games; ++index) {
      const Opponent selected_opponent = fixed_opponent.value_or(opponents[enemy(random)]);
      const GameConfig config{
        .opponent = selected_opponent,
        .board_size = selected_opponent == Opponent::world_daemon ? 19 : fixed_size.value_or(sizes[size(random)]),
        .seed = random(),
      };
      const auto game = play_game(config, policy);
      auto& aggregate = totals[{config.opponent, config.board_size}];
      ++aggregate.games;
      aggregate.wins += game.won;
      aggregate.completed += game.completed;
      aggregate.rounds += game.rounds;
      aggregate.game_power += game.reward.game_power;
      aggregate.training_power += game.reward.training_power;
    }
    std::cout << std::setprecision(6) << "opponent\tsize\tgames\twin_rate\tcompleted\tgame_power/round\ttraining_power/round\n";
    Aggregate all;
    for (const auto& [key, value] : totals) {
      std::cout << opponent_name(key.first) << '\t' << key.second << '\t' << value.games << '\t'
        << static_cast<double>(value.wins) / value.games << '\t'
        << static_cast<double>(value.completed) / value.games << '\t'
        << value.game_power / std::max(value.rounds, 1) << '\t'
        << value.training_power / std::max(value.rounds, 1) << '\n';
      all.games += value.games;
      all.wins += value.wins;
      all.completed += value.completed;
      all.rounds += value.rounds;
      all.game_power += value.game_power;
      all.training_power += value.training_power;
    }
    std::cout << "ALL\t-\t" << all.games << '\t' << static_cast<double>(all.wins) / all.games << '\t'
      << static_cast<double>(all.completed) / all.games << '\t'
      << all.game_power / std::max(all.rounds, 1) << '\t'
      << all.training_power / std::max(all.rounds, 1) << '\n';

    // End with one complete traceable game, matching the training unit.
    const GameConfig demo{.opponent = Opponent::illuminati, .board_size = 5, .seed = random()};
    const auto game = play_game(demo, policy, true);
    std::cout << "demo\t" << opponent_name(demo.opponent) << '\t' << demo.board_size << '\t'
      << (game.won ? "win" : "loss") << '\t' << game.rounds << '\t'
      << game.score.black << ':' << game.score.white << '\n';
    for (std::size_t index = 0; index < game.trace.size(); ++index) {
      const auto& step = game.trace[index];
      std::cout << "turn\t" << index << '\t' << move_name(step.black) << '\t'
        << step.current_reply_seed << '\t' << move_name(step.white) << '\t' << step.after << '\n';
    }
    return EXIT_SUCCESS;
  } catch (const std::exception& error) {
    std::cerr << error.what() << '\n';
    return EXIT_FAILURE;
  }
}
