#include "go/arena.hpp"
#include "go/board_generator.hpp"
#include "go/network.hpp"
#include "go/policy.hpp"
#include "go/reward.hpp"
#include "go/rules.hpp"
#include "go/search.hpp"

#include <algorithm>
#include <array>
#include <atomic>
#include <cstdlib>
#include <fstream>
#include <iomanip>
#include <iostream>
#include <map>
#include <random>
#include <stdexcept>
#include <string>
#include <thread>
#include <vector>

namespace {

using namespace bitburner::go;

constexpr std::array<Opponent, 7> opponents{{
  Opponent::netburners, Opponent::slum_snakes, Opponent::black_hand,
  Opponent::tetrads, Opponent::daedalus, Opponent::illuminati,
  Opponent::world_daemon,
}};
constexpr std::array<int, 4> ordinary_sizes{{5, 7, 9, 13}};

struct ScheduledGame {
  std::uint64_t seed{};
  Opponent opponent{};
  int size{};
};

struct Result {
  bool won{};
  int rounds{};
  TerminalReward reward{};
};

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

Result play(const ScheduledGame& game, const CandidateValueNetwork& network) {
  std::mt19937_64 environment(game.seed);
  Position position{.board = initial_board(
    game.size, game.opponent, sampled_seed(environment),
    static_cast<std::uint32_t>(environment()))};
  int rounds = 0;
  const int cap = 4 * game.size * game.size;
  while (position.consecutive_passes < 2 && rounds * 2 < cap) {
    const auto decision = choose_with_network(
      position, game.opponent, sampled_seed(environment), rounds, network);
    apply_to_position(position, decision.move, Stone::black);
    if (position.consecutive_passes < 2) {
      apply_to_position(position, sample_reply(decision.known_replies, environment), Stone::white);
    }
    ++rounds;
  }
  const auto reward = terminal_reward(
    score_board(position.board, opponent_komi(game.opponent)),
    opponent_name(game.opponent), game.size);
  return {.won = reward.won, .rounds = rounds, .reward = reward};
}

struct Aggregate {
  int games{};
  int wins{};
  int rounds{};
  double power{};
};

}  // namespace

int main(int argc, char** argv) {
  try {
    if (argc < 4) {
      throw std::invalid_argument(
        "usage: go_cpp_evaluate_mixed GAMES SEED MODEL [MODEL ...] [--small5] [--threads N]");
    }
    const int games = std::stoi(argv[1]);
    const std::uint64_t seed = std::stoull(argv[2]);
    std::size_t threads = std::max(1U, std::thread::hardware_concurrency());
    bool small5 = false;
    int model_end = argc;
    for (int argument = 3; argument < argc; ++argument) {
      if (std::string(argv[argument]) == "--threads") {
        if (argument + 1 >= argc) throw std::invalid_argument("--threads requires a value");
        threads = std::max<std::size_t>(1, std::stoull(argv[argument + 1]));
        model_end = std::min(model_end, argument);
        ++argument;
      } else if (std::string(argv[argument]) == "--small5") {
        small5 = true;
        model_end = std::min(model_end, argument);
      }
    }
    if (model_end == 3) throw std::invalid_argument("at least one model is required");

    std::mt19937_64 schedule(seed);
    std::vector<ScheduledGame> corpus(static_cast<std::size_t>(games));
    const std::size_t opponent_count = small5 ? 6 : opponents.size();
    for (std::size_t index = 0; index < corpus.size(); ++index) {
      auto& game = corpus[index];
      game.opponent = opponents[index % opponent_count];
      game.size = small5 ? 5 : game.opponent == Opponent::world_daemon
        ? 19 : ordinary_sizes[(index / opponents.size()) % ordinary_sizes.size()];
      game.seed = schedule();
    }
    // Keep the complete corpus stratified, but do not let model evaluation
    // exploit a predictable enemy/size order.
    std::shuffle(corpus.begin(), corpus.end(), schedule);

    std::cout << "model\tgames\twins\twin_rate\ttraining_power/round\tverdict\tchampion\n"
      << std::setprecision(8);
    int champion_wins = -1;
    double champion_power_per_round = -1;
    std::string champion;
    for (int argument = 3; argument < model_end; ++argument) {
      std::ifstream input(argv[argument]);
      if (!input) throw std::runtime_error("cannot open model " + std::string(argv[argument]));
      const auto network = CandidateValueNetwork::load(input);
      std::vector<Result> results(corpus.size());
      std::atomic<std::size_t> next{0};
      std::vector<std::jthread> workers;
      const std::size_t worker_count = std::min<std::size_t>(threads, corpus.size());
      workers.reserve(worker_count);
      for (std::size_t worker = 0; worker < worker_count; ++worker) {
        workers.emplace_back([&] {
          for (;;) {
            const std::size_t index = next.fetch_add(1, std::memory_order_relaxed);
            if (index >= corpus.size()) return;
            results[index] = play(corpus[index], network);
          }
        });
      }
      workers.clear();

      Aggregate total;
      std::array<Aggregate, opponents.size()> by_opponent{};
      std::map<std::pair<std::size_t, int>, Aggregate> by_pair;
      for (std::size_t index = 0; index < corpus.size(); ++index) {
        const auto& game = corpus[index];
        const auto& result = results[index];
        const auto opponent_index = static_cast<std::size_t>(game.opponent);
        for (Aggregate* aggregate : {
          &total, &by_opponent[opponent_index], &by_pair[{opponent_index, game.size}],
        }) {
          aggregate->games++;
          aggregate->wins += result.won;
          aggregate->rounds += result.rounds;
          aggregate->power += result.reward.training_power;
        }
      }
      const double power_per_round = total.power / std::max(total.rounds, 1);
      const bool promote = total.wins > champion_wins
        || (total.wins == champion_wins && power_per_round > champion_power_per_round);
      const std::string verdict = champion_wins < 0 ? "baseline" : promote ? "promote" : "reject";
      if (promote) {
        champion_wins = total.wins;
        champion_power_per_round = power_per_round;
        champion = argv[argument];
      }
      std::cout << argv[argument] << '\t' << games << '\t' << total.wins << '\t'
        << static_cast<double>(total.wins) / std::max(games, 1) << '\t'
        << power_per_round << '\t' << verdict << '\t' << champion << '\n';
      for (std::size_t index = 0; index < opponent_count; ++index) {
        const auto& aggregate = by_opponent[index];
        std::cout << "  " << opponent_name(opponents[index]) << '\t' << aggregate.games << '\t'
          << aggregate.wins << '\t'
          << static_cast<double>(aggregate.wins) / std::max(aggregate.games, 1) << '\t'
          << aggregate.power / std::max(aggregate.rounds, 1) << '\n';
      }
      for (const auto& [pair, aggregate] : by_pair) {
        std::cout << "    " << opponent_name(opponents[pair.first]) << '/' << pair.second
          << '\t' << aggregate.games << '\t' << aggregate.wins << '\t'
          << static_cast<double>(aggregate.wins) / std::max(aggregate.games, 1) << '\t'
          << aggregate.power / std::max(aggregate.rounds, 1) << '\n';
      }
      std::cout << std::flush;
    }
    return EXIT_SUCCESS;
  } catch (const std::exception& error) {
    std::cerr << error.what() << '\n';
    return EXIT_FAILURE;
  }
}
