#include "go/arena.hpp"
#include "go/board_generator.hpp"
#include "go/network.hpp"
#include "go/policy.hpp"
#include "go/reward.hpp"
#include "go/rules.hpp"
#include "go/search.hpp"

#include <algorithm>
#include <atomic>
#include <cstdlib>
#include <fstream>
#include <iomanip>
#include <iostream>
#include <random>
#include <stdexcept>
#include <string>
#include <thread>
#include <vector>

namespace {

using namespace bitburner::go;

double sampled_seed(std::mt19937_64& random) {
  std::uniform_int_distribution<int> tick(0, 149'999);
  return static_cast<double>(tick(random) * 200);
}

Move sample_reply(const ReplyForecast& forecast, std::mt19937_64& random) {
  std::uniform_real_distribution<double> unit(0.0, 1.0);
  const double roll = unit(random);
  double sum = 0;
  for (const auto& reply : forecast.replies) {
    sum += reply.probability;
    if (roll <= sum) return reply.move;
  }
  return forecast.replies.empty() ? Move::pass_turn() : forecast.replies.back().move;
}

struct Result { bool won; int rounds; TerminalReward reward; };

Result play(std::uint64_t game_seed, Opponent opponent, int size, const CandidateValueNetwork& network) {
  std::mt19937_64 environment(game_seed);
  Position position{.board = initial_board(size, opponent, sampled_seed(environment), static_cast<std::uint32_t>(environment()))};
  int rounds = 0;
  const int cap = 4 * size * size;
  while (position.consecutive_passes < 2 && rounds * 2 < cap) {
    const auto decision = choose_with_network(position, opponent, sampled_seed(environment), rounds, network);
    apply_to_position(position, decision.move, Stone::black);
    if (position.consecutive_passes < 2) apply_to_position(position, sample_reply(decision.known_replies, environment), Stone::white);
    ++rounds;
  }
  const auto reward = terminal_reward(score_board(position.board, opponent_komi(opponent)), opponent_name(opponent), size);
  return {.won = reward.won, .rounds = rounds, .reward = reward};
}

}  // namespace

int main(int argc, char** argv) {
  try {
    if (argc < 6) throw std::invalid_argument(
      "usage: go_cpp_evaluate GAMES SEED OPPONENT SIZE MODEL [MODEL ...] [--threads N]");
    const int games = std::stoi(argv[1]);
    const std::uint64_t seed = std::stoull(argv[2]);
    const Opponent opponent = parse_opponent(argv[3]);
    const int size = opponent == Opponent::world_daemon ? 19 : std::stoi(argv[4]);
    std::size_t threads = std::max(1U, std::thread::hardware_concurrency());
    int model_end = argc;
    for (int argument = 5; argument < argc; ++argument) {
      if (std::string(argv[argument]) == "--threads") {
        if (argument + 1 >= argc) throw std::invalid_argument("--threads requires a value");
        threads = std::max<std::size_t>(1, std::stoull(argv[argument + 1]));
        model_end = std::min(model_end, argument);
        ++argument;
      }
    }
    if (model_end == 5) throw std::invalid_argument("at least one model is required");
    std::mt19937_64 schedule(seed);
    std::vector<std::uint64_t> game_seeds(static_cast<std::size_t>(games));
    for (auto& game_seed : game_seeds) game_seed = schedule();
    std::cout << "model\tgames\twins\twin_rate\ttraining_power/round\tverdict\tchampion\n" << std::setprecision(8);
    int champion_wins = -1;
    double champion_power_per_round = -1;
    std::string champion;
    for (int argument = 5; argument < model_end; ++argument) {
      std::ifstream input(argv[argument]);
      if (!input) throw std::runtime_error("cannot open model " + std::string(argv[argument]));
      const auto network = CandidateValueNetwork::load(input);
      std::vector<Result> results(game_seeds.size());
      std::atomic<std::size_t> next{0};
      std::vector<std::jthread> workers;
      const std::size_t worker_count = std::min<std::size_t>(threads, game_seeds.size());
      workers.reserve(worker_count);
      for (std::size_t worker = 0; worker < worker_count; ++worker) {
        workers.emplace_back([&] {
          for (;;) {
            const auto index = next.fetch_add(1, std::memory_order_relaxed);
            if (index >= game_seeds.size()) return;
            results[index] = play(game_seeds[index], opponent, size, network);
          }
        });
      }
      workers.clear();
      int wins = 0;
      int rounds = 0;
      double power = 0;
      for (const auto& result : results) {
        wins += result.won;
        rounds += result.rounds;
        power += result.reward.training_power;
      }
      const double power_per_round = power / std::max(rounds, 1);
      const bool promote = wins > champion_wins
        || (wins == champion_wins && power_per_round > champion_power_per_round);
      const std::string verdict = champion_wins < 0 ? "baseline" : promote ? "promote" : "reject";
      if (promote) {
        champion_wins = wins;
        champion_power_per_round = power_per_round;
        champion = argv[argument];
      }
      std::cout << argv[argument] << '\t' << games << '\t' << wins << '\t'
        << static_cast<double>(wins) / std::max(games, 1) << '\t'
        << power_per_round << '\t' << verdict << '\t' << champion << std::endl;
    }
    return EXIT_SUCCESS;
  } catch (const std::exception& error) {
    std::cerr << error.what() << '\n';
    return EXIT_FAILURE;
  }
}
