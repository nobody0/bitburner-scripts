#include "go/arena.hpp"
#include "go/board_generator.hpp"
#include "go/network.hpp"
#include "go/reward.hpp"
#include "go/rules.hpp"
#include "go/search.hpp"

#include <algorithm>
#include <array>
#include <cstdlib>
#include <fstream>
#include <iomanip>
#include <iostream>
#include <optional>
#include <random>
#include <stdexcept>
#include <string>
#include <thread>
#include <vector>

namespace {

using namespace bitburner::go;

double current_seed(std::mt19937_64& random) {
  std::uniform_int_distribution<int> tick(0, 149'999);
  return static_cast<double>(tick(random) * 200);
}

Move sample_reply(const ReplyForecast& forecast, std::mt19937_64& random) {
  std::uniform_real_distribution<double> unit(0.0, 1.0);
  const double roll = unit(random);
  double cumulative = 0;
  for (const auto& reply : forecast.replies) {
    cumulative += reply.probability;
    if (roll <= cumulative) return reply.move;
  }
  return forecast.replies.back().move;
}

double replay_loss(const CandidateValueNetwork& network, const std::vector<TrainingExample>& replay) {
  if (replay.empty()) return 0;
  double loss = 0;
  for (const auto& example : replay) {
    const auto prediction = network.predict(example.features);
    const std::array<double, 3> predicted{
      prediction.win_probability, prediction.terminal_power, prediction.remaining_turns,
    };
    const std::array<double, 3> target{
      example.target.win_probability, example.target.terminal_power, example.target.remaining_turns,
    };
    constexpr std::array<double, 3> weights{{1.0 / 3.0, 1.0 / 3.0, 1.0 / 3.0}};
    for (std::size_t index = 0; index < 3; ++index) {
      const double difference = std::log1p(predicted[index]) - std::log1p(target[index]);
      loss += difference * difference * weights[index];
    }
  }
  return loss / replay.size();
}

void save_model(const CandidateValueNetwork& network, const std::string& path) {
  std::ofstream output(path);
  if (!output) throw std::runtime_error("cannot create model " + path);
  network.save(output);
}

}  // namespace

int main(int argc, char** argv) {
  try {
    const int games = argc >= 2 ? std::stoi(argv[1]) : 8;
    const std::uint64_t corpus_seed = argc >= 3 ? std::stoull(argv[2]) : 0x51f1a9ULL;
    const int simulations = argc >= 4 ? std::stoi(argv[3]) : 32;
    const std::string model_path = argc >= 5 ? argv[4] : "go-selfplay.model";
    const auto fixed_opponent = argc >= 6 && std::string_view(argv[5]) != "-"
      ? std::optional<Opponent>(parse_opponent(argv[5])) : std::nullopt;
    const auto fixed_size = argc >= 7 && std::string_view(argv[6]) != "-"
      ? std::optional<int>(std::stoi(argv[6])) : std::nullopt;
    const int checkpoint_every = argc >= 8 ? std::stoi(argv[7]) : std::max(1, games / 4);
    const std::size_t threads = argc >= 9 ? std::stoull(argv[8])
      : std::max(1U, std::thread::hardware_concurrency());
    const std::string profile = argc >= 10 ? argv[9] : "shared";
    const std::string init_model = argc >= 11 ? argv[10] : "";
    const double learning_rate = argc >= 12 ? std::stod(argv[11]) : 0.001;
    const double policy_learning_rate = argc >= 13 ? std::stod(argv[12]) : learning_rate * 0.02;
    const int branch_width = argc >= 14 ? std::stoi(argv[13]) : 32;
    const int rollout_depth = argc >= 15 ? std::stoi(argv[14]) : 0;
    const int tree_depth = argc >= 16 ? std::stoi(argv[15]) : 10;
    const int root_search_width = argc >= 17 ? std::stoi(argv[16]) : 32;
    if (profile != "shared" && profile != "small5" && profile != "daemon19") {
      throw std::invalid_argument("PROFILE must be shared, small5, or daemon19");
    }
    const std::array<Opponent, 7> opponents{{Opponent::netburners, Opponent::slum_snakes,
      Opponent::black_hand, Opponent::tetrads, Opponent::daedalus, Opponent::illuminati,
      Opponent::world_daemon}};
    const std::array<int, 4> sizes{{5, 7, 9, 13}};
    std::mt19937_64 schedule_random(corpus_seed);
    std::mt19937_64 training_random(corpus_seed ^ 0x7a11ULL);
    std::uniform_int_distribution<std::size_t> enemy_roll(
      0, profile == "small5" ? 5 : opponents.size() - 1);
    std::uniform_int_distribution<std::size_t> size_roll(0, sizes.size() - 1);
    const int feature_extent = profile == "small5" ? 5 : 19;
    const SearchConfig search_config{.simulations = simulations, .tree_depth = tree_depth,
      .exploration = 1.4, .graph_capacity = 500'000, .feature_extent = feature_extent,
      .branch_width = branch_width, .root_search_width = root_search_width,
      .rollout_depth = rollout_depth};
    CandidateValueNetwork learner = [&] {
      if (init_model.empty()) return CandidateValueNetwork(
        feature_extent, 64, corpus_seed ^ 0xa11ceULL,
        profile == "small5" ? 6 : profile == "daemon19" ? 0 : 7);
      std::ifstream input(init_model);
      if (!input) throw std::runtime_error("cannot open initial model " + init_model);
      return CandidateValueNetwork::load(input);
    }();
    save_model(learner, model_path + ".0.model");
    std::vector<TrainingExample> replay;
    replay.reserve(100'000);
    int wins = 0;
    int completed = 0;
    int total_rounds = 0;
    double training_power = 0;
    std::size_t total_graph_edges = 0;
    for (int game_index = 0; game_index < games; ++game_index) {
      SearchGraph graph(search_config);
      const Opponent sampled_opponent = opponents[enemy_roll(schedule_random)];
      const int sampled_size = sizes[size_roll(schedule_random)];
      const Opponent opponent = profile == "daemon19" ? Opponent::world_daemon
        : fixed_opponent.value_or(sampled_opponent);
      const int size = profile == "small5" ? 5
        : opponent == Opponent::world_daemon ? 19 : fixed_size.value_or(sampled_size);
      const std::uint64_t game_seed = schedule_random();
      std::mt19937_64 environment_random(game_seed);
      std::mt19937_64 search_random(game_seed ^ 0x5ea2c4ULL);
      const double board_seed = current_seed(environment_random);
      Position position{.board = initial_board(size, opponent, board_seed, static_cast<std::uint32_t>(environment_random()))};
      const int cap = 4 * size * size;
      int rounds = 0;
      std::vector<CandidateFeatures> trajectory;
      while (position.consecutive_passes < 2 && rounds * 2 < cap) {
        const double seed = current_seed(environment_random);
        const Board before = position.board;
        const auto decision = graph.search(position, opponent, seed, rounds, search_random);
        std::vector<const CandidateFeatures*> ranked_candidates;
        std::optional<std::size_t> preferred;
        Move previous{.pass = false, .point = {-1, -1}};
        for (const auto& target : decision.targets) {
          if (!ranked_candidates.empty() && target.move == previous) continue;
          if (target.move == decision.move) preferred = ranked_candidates.size();
          ranked_candidates.push_back(&target.features);
          previous = target.move;
        }
        if (preferred && ranked_candidates.size() > 1 && policy_learning_rate > 0) {
          CandidateRankingGroup group{
            .candidates = std::move(ranked_candidates),
            .preferred_index = *preferred,
          };
          (void)learner.train_ranking_batch(
            std::span<const CandidateRankingGroup>(&group, 1), policy_learning_rate, 1);
        }
        apply_to_position(position, decision.move, Stone::black);
        Move reply = Move::pass_turn();
        if (position.consecutive_passes < 2) {
          reply = sample_reply(decision.known_replies, environment_random);
          apply_to_position(position, reply, Stone::white);
        }
        trajectory.push_back(encode_candidate(
          before, decision.move, reply, position.board, feature_extent, static_cast<int>(opponent)));
        ++rounds;
      }
      const Score score = score_board(position.board, opponent_komi(opponent));
      const auto reward = terminal_reward(score, opponent_name(opponent), size);
      for (std::size_t turn = 0; turn < trajectory.size(); ++turn) {
        replay.push_back({
          .features = std::move(trajectory[turn]),
          .target = {
            .win_probability = reward.won ? 1.0 : 0.0,
            .terminal_power = reward.training_power,
            .remaining_turns = static_cast<double>(trajectory.size() - turn),
          },
        });
      }
      wins += reward.won;
      completed += position.consecutive_passes >= 2;
      total_rounds += rounds;
      training_power += reward.training_power;
      total_graph_edges += graph.edge_count();

      constexpr std::size_t training_window = 4096;
      std::shuffle(replay.begin(), replay.end(), training_random);
      constexpr std::size_t batch = 64;
      const std::size_t used = std::min(replay.size(), training_window);
      const double before = replay_loss(learner, std::vector<TrainingExample>(
        replay.begin(), replay.begin() + static_cast<std::ptrdiff_t>(used)));
      for (std::size_t offset = 0; offset < used; offset += batch) {
        const auto count = std::min(batch, used - offset);
        (void)learner.train_batch(
          std::span<const TrainingExample>(replay.data() + offset, count), learning_rate, threads);
      }
      const double after = replay_loss(learner, std::vector<TrainingExample>(
        replay.begin(), replay.begin() + static_cast<std::ptrdiff_t>(used)));
      std::cout << std::setprecision(7) << "game=" << game_index + 1
        << " opponent=\"" << opponent_name(opponent) << '"'
        << " size=" << size << " result=" << (reward.won ? "win" : "loss")
        << " rounds=" << rounds << " replay=" << replay.size()
        << " graph_edges=" << graph.edge_count() << " loss=" << before << "->" << after << '\n';
      if (replay.size() > 100'000) replay.erase(replay.begin(), replay.begin() + static_cast<std::ptrdiff_t>(replay.size() - 100'000));
      if ((game_index + 1) % checkpoint_every == 0 || game_index + 1 == games) {
        save_model(learner, model_path + "." + std::to_string(game_index + 1) + ".model");
      }
    }
    save_model(learner, model_path);
    std::cout << std::setprecision(7) << "summary games=" << games
      << " win_rate=" << static_cast<double>(wins) / std::max(games, 1)
      << " completed=" << static_cast<double>(completed) / std::max(games, 1)
      << " training_power_per_round=" << training_power / std::max(total_rounds, 1)
      << " replay=" << replay.size() << " graph_edges=" << total_graph_edges
      << " model=" << model_path << '\n';
    return EXIT_SUCCESS;
  } catch (const std::exception& error) {
    std::cerr << error.what() << '\n';
    return EXIT_FAILURE;
  }
}
