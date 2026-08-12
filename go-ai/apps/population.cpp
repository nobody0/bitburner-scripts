#include "go/arena.hpp"
#include "go/board_generator.hpp"
#include "go/features.hpp"
#include "go/kata_advisor.hpp"
#include "go/network.hpp"
#include "go/policy.hpp"
#include "go/reward.hpp"
#include "go/rules.hpp"
#include "go/search.hpp"

#include <algorithm>
#include <array>
#include <atomic>
#include <chrono>
#include <cmath>
#include <cstdlib>
#include <filesystem>
#include <fstream>
#include <iomanip>
#include <iostream>
#include <iterator>
#include <memory>
#include <mutex>
#include <optional>
#include <random>
#include <span>
#include <sstream>
#include <stdexcept>
#include <string>
#include <thread>
#include <utility>
#include <vector>

namespace {

using namespace bitburner::go;

struct RankingState {
  std::vector<CandidateFeatures> candidates;
  std::size_t preferred{};
};

struct ScheduledGame {
  std::uint64_t seed{};
  Opponent opponent{Opponent::netburners};
  int size{};
};

struct Episode {
  std::vector<RankingState> ranking;
  std::vector<TrainingExample> outcome;
  bool won{};
  int rounds{};
  double training_power{};
  bool challenger_selected{};
  bool adviser_selected{};
};

struct Learner {
  std::string name;
  double outcome_rate{};
  double policy_rate{};
  CandidateValueNetwork network;
};

double sampled_seed(std::mt19937_64& random) {
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
  return forecast.replies.empty() ? Move::pass_turn() : forecast.replies.back().move;
}

Move modal_reply(const ReplyForecast& forecast) {
  if (forecast.replies.empty()) return Move::pass_turn();
  return std::max_element(
    forecast.replies.begin(), forecast.replies.end(),
    [](const WeightedReply& left, const WeightedReply& right) {
      return left.probability < right.probability;
    }
  )->move;
}

std::vector<double> rates(std::string text) {
  std::replace(text.begin(), text.end(), ',', ' ');
  std::istringstream input(text);
  std::vector<double> result;
  double value = 0;
  while (input >> value) {
    if (!std::isfinite(value) || value < 0) {
      throw std::invalid_argument("learning rates must be finite and nonnegative");
    }
    result.push_back(value);
  }
  if (result.empty()) throw std::invalid_argument("learning-rate list is empty");
  return result;
}

std::string rate_name(double value) {
  std::ostringstream output;
  output << std::setprecision(8) << value;
  return output.str();
}

CandidateValueNetwork load_model(const std::string& path) {
  std::ifstream input(path);
  if (!input) throw std::runtime_error("cannot open initial model " + path);
  return CandidateValueNetwork::load(input);
}

void save_model(const CandidateValueNetwork& network, const std::filesystem::path& path) {
  auto temporary = path;
  temporary += ".tmp";
  {
    std::ofstream output(temporary);
    if (!output) throw std::runtime_error("cannot create model " + temporary.string());
    network.save(output);
    output.close();
    if (!output) throw std::runtime_error("cannot finish model " + temporary.string());
  }
  std::filesystem::rename(temporary, path);
}

Episode generate_episode(
  std::uint64_t game_seed,
  Opponent opponent,
  int size,
  const SearchConfig& config,
  const CandidateValueNetwork* challenger = nullptr
) {
  std::mt19937_64 environment(game_seed);
  std::mt19937_64 search_random(game_seed ^ 0x5ea2c4ULL);
  Position position{.board = initial_board(
    size, opponent, sampled_seed(environment), static_cast<std::uint32_t>(environment()))};
  SearchGraph graph(config);
  Episode episode;
  struct Played {
    CandidateFeatures features;
    int turn{};
  };
  std::vector<Played> played;
  const int cap = 4 * size * size;
  int rounds = 0;
  while (position.consecutive_passes < 2 && rounds * 2 < cap) {
    const double seed = sampled_seed(environment);
    const Board before = position.board;
    const auto decision = graph.search(position, opponent, seed, rounds, search_random);
    const auto challenger_decision = challenger
      ? std::optional<PolicyDecision>(choose_with_network(
          position, opponent, seed, rounds, *challenger))
      : std::nullopt;
    const Move selected_move = challenger_decision ? challenger_decision->move : decision.move;
    RankingState state;
    bool found_preferred = false;
    Move previous{.pass = false, .point = {-1, -1}};
    for (const auto& target : decision.targets) {
      if (!state.candidates.empty() && target.move == previous) continue;
      if (target.move == selected_move) {
        state.preferred = state.candidates.size();
        found_preferred = true;
      }
      state.candidates.push_back(target.features);
      previous = target.move;
    }
    apply_to_position(position, selected_move, Stone::black);
    Move reply = Move::pass_turn();
    if (position.consecutive_passes < 2) {
      reply = sample_reply(challenger_decision
        ? challenger_decision->known_replies : decision.known_replies, environment);
      apply_to_position(position, reply, Stone::white);
    }
    auto selected_features = encode_candidate(
      before, selected_move, reply, position.board, config.feature_extent,
      static_cast<int>(opponent));
    if (!found_preferred) {
      state.preferred = state.candidates.size();
      state.candidates.push_back(selected_features);
      found_preferred = true;
    }
    if (found_preferred && state.candidates.size() > 1) {
      episode.ranking.push_back(std::move(state));
    }
    played.push_back({
      .features = std::move(selected_features),
      .turn = rounds,
    });
    ++rounds;
  }
  const Score score = score_board(position.board, opponent_komi(opponent));
  const auto reward = terminal_reward(score, opponent_name(opponent), size);
  episode.won = reward.won;
  episode.rounds = rounds;
  episode.training_power = reward.training_power;
  episode.outcome.reserve(played.size());
  for (auto& turn : played) episode.outcome.push_back({
    .features = std::move(turn.features),
    .target = {
      .win_probability = reward.won ? 1.0 : 0.0,
      .terminal_power = reward.training_power,
      .remaining_turns = static_cast<double>(rounds - turn.turn),
    },
  });
  return episode;
}

Episode generate_kata_episode(
  std::uint64_t game_seed,
  Opponent opponent,
  int size,
  int feature_extent,
  KataAdvisorClient& adviser
) {
  std::mt19937_64 environment(game_seed);
  Position position{.board = initial_board(
    size, opponent, sampled_seed(environment), static_cast<std::uint32_t>(environment()))};
  Episode episode;
  struct Played {
    CandidateFeatures features;
    int turn{};
  };
  struct PreparedCandidate {
    KataCandidate wire;
    ReplyForecast forecast;
    CandidateFeatures features;
  };
  std::vector<Played> played;
  const int cap = 4 * size * size;
  int rounds = 0;
  while (position.consecutive_passes < 2 && rounds * 2 < cap) {
    const double seed = sampled_seed(environment);
    const Board before = position.board;
    std::vector<Move> moves;
    for (const Point point : legal_moves(position, Stone::black)) {
      moves.push_back(Move::at(point.x, point.y));
    }
    moves.push_back(Move::pass_turn());
    std::vector<PreparedCandidate> prepared;
    prepared.reserve(moves.size());
    for (const Move candidate : moves) {
      Position after_black = position;
      apply_to_position(after_black, candidate, Stone::black);
      ReplyForecast forecast;
      if (after_black.consecutive_passes >= 2) {
        forecast = {
          .replies = {{
            .move = Move::pass_turn(),
            .probability = 1.0,
            .branch = ReplyBranch::pass,
          }},
          .exact = true,
        };
      } else {
        forecast = predict_opponent_replies(after_black, opponent, seed);
      }
      const Move predicted = modal_reply(forecast);
      Position after = after_black;
      if (after.consecutive_passes < 2) apply_to_position(after, predicted, Stone::white);
      const Score score = score_board(after.board, opponent_komi(opponent));
      const bool terminal = after.consecutive_passes >= 2;
      const bool forced_winning_end = !candidate.pass && predicted.pass && score.black >= score.white;
      KataCandidate wire{
        .move = candidate,
        .predicted_white = predicted,
        .after = after.board,
      };
      if (terminal || forced_winning_end) {
        wire.exact_score = score;
        wire.exact_remaining_rounds = terminal ? 1 : 2;
      }
      prepared.push_back({
        .wire = std::move(wire),
        .forecast = std::move(forecast),
        .features = encode_candidate(
          before, candidate, predicted, after.board, feature_extent,
          static_cast<int>(opponent)),
      });
    }
    std::vector<KataCandidate> wire;
    wire.reserve(prepared.size());
    for (const auto& candidate : prepared) wire.push_back(candidate.wire);
    const KataAdvice advice = adviser.advise(
      position, opponent_komi(opponent), rounds, wire);
    const auto selected_iterator = std::find_if(
      prepared.begin(), prepared.end(), [&](const PreparedCandidate& candidate) {
        return candidate.wire.move == advice.selected;
      });
    if (selected_iterator == prepared.end()) {
      throw std::runtime_error("KataGo adviser selected a move outside the native legal set");
    }
    const std::size_t selected_index = static_cast<std::size_t>(selected_iterator - prepared.begin());

    apply_to_position(position, advice.selected, Stone::black);
    Move reply = Move::pass_turn();
    if (position.consecutive_passes < 2) {
      reply = sample_reply(prepared[selected_index].forecast, environment);
      apply_to_position(position, reply, Stone::white);
    }
    auto selected_features = encode_candidate(
      before, advice.selected, reply, position.board, feature_extent,
      static_cast<int>(opponent));

    RankingState state;
    bool found_preferred = false;
    std::vector<Move> seen;
    for (const Move ranked : advice.ranked) {
      if (std::find(seen.begin(), seen.end(), ranked) != seen.end()) continue;
      const auto iterator = std::find_if(
        prepared.begin(), prepared.end(), [&](const PreparedCandidate& candidate) {
          return candidate.wire.move == ranked;
      });
      if (iterator == prepared.end()) continue;
      seen.push_back(ranked);
      if (ranked == advice.selected) {
        state.preferred = state.candidates.size();
        state.candidates.push_back(selected_features);
        found_preferred = true;
      } else {
        state.candidates.push_back(iterator->features);
      }
    }
    if (!found_preferred) {
      state.preferred = state.candidates.size();
      state.candidates.push_back(selected_features);
    }
    if (state.candidates.size() > 1) episode.ranking.push_back(std::move(state));
    played.push_back({.features = std::move(selected_features), .turn = rounds});
    ++rounds;
  }
  const Score score = score_board(position.board, opponent_komi(opponent));
  const auto reward = terminal_reward(score, opponent_name(opponent), size);
  episode.won = reward.won;
  episode.rounds = rounds;
  episode.training_power = reward.training_power;
  episode.outcome.reserve(played.size());
  for (auto& turn : played) episode.outcome.push_back({
    .features = std::move(turn.features),
    .target = {
      .win_probability = reward.won ? 1.0 : 0.0,
      .terminal_power = reward.training_power,
      .remaining_turns = static_cast<double>(rounds - turn.turn),
    },
  });
  return episode;
}

bool better_episode(const Episode& challenger, const Episode& teacher) {
  if (challenger.won != teacher.won) return challenger.won;
  const double challenger_utility = challenger.training_power / std::max(challenger.rounds, 1);
  const double teacher_utility = teacher.training_power / std::max(teacher.rounds, 1);
  return challenger_utility > teacher_utility;
}

void append_outcomes(Episode& destination, Episode& source) {
  destination.outcome.reserve(destination.outcome.size() + source.outcome.size());
  std::move(
    source.outcome.begin(), source.outcome.end(),
    std::back_inserter(destination.outcome));
}

void train_learner(
  Learner& learner,
  const std::vector<Episode>& episodes,
  bool freeze_trunk
) {
  constexpr std::size_t outcome_batch = 512;
  constexpr std::size_t ranking_batch = 64;
  if (learner.outcome_rate > 0) {
    std::vector<const TrainingExample*> examples;
    for (const auto& episode : episodes) for (const auto& example : episode.outcome) {
      examples.push_back(&example);
    }
    for (std::size_t offset = 0; offset < examples.size(); offset += outcome_batch) {
      const std::size_t count = std::min(outcome_batch, examples.size() - offset);
      std::vector<TrainingExample> batch;
      batch.reserve(count);
      for (std::size_t index = 0; index < count; ++index) batch.push_back(*examples[offset + index]);
      (void)learner.network.train_batch(batch, learner.outcome_rate, 1, freeze_trunk);
    }
  }
  if (learner.policy_rate > 0) {
    std::vector<CandidateRankingGroup> groups;
    for (const auto& episode : episodes) for (const auto& state : episode.ranking) {
      CandidateRankingGroup group{.preferred_index = state.preferred};
      group.candidates.reserve(state.candidates.size());
      for (const auto& candidate : state.candidates) group.candidates.push_back(&candidate);
      groups.push_back(std::move(group));
    }
    for (std::size_t offset = 0; offset < groups.size(); offset += ranking_batch) {
      const std::size_t count = std::min(ranking_batch, groups.size() - offset);
      // The public rate is per decision, matching selfplay. Batch training
      // averages gradients, so multiply by the decision count to retain the
      // same first-order update magnitude while amortizing allocations.
      (void)learner.network.train_ranking_batch(
        std::span<const CandidateRankingGroup>(groups.data() + offset, count),
        learner.policy_rate * static_cast<double>(count), 1, freeze_trunk);
    }
  }
}

}  // namespace

int main(int argc, char** argv) {
  try {
    const auto started = std::chrono::steady_clock::now();
    if (argc < 15) throw std::invalid_argument(
      "usage: go_cpp_population GAMES SEED SIMULATIONS OUT_DIR OPPONENT SIZE CHECKPOINT_EVERY THREADS PROFILE INIT_MODEL OUTCOME_RATES POLICY_RATES BRANCH_WIDTH ROOT_WIDTH [TREE_DEPTH] [ROLLOUT_DEPTH] [teacher|duel|trio] [KATAGO_BINARY] [KATAGO_MODEL] [KATAGO_CONFIG] [KATAGO_VISITS] [KATAGO_POLICY_VISITS] [KATAGO_CANDIDATES] [RETENTION_MODEL] [full|heads] [KATAGO_PROCESSES]"
    );
    const int games = std::stoi(argv[1]);
    const std::uint64_t corpus_seed = std::stoull(argv[2]);
    const int simulations = std::stoi(argv[3]);
    const std::filesystem::path output_dir = argv[4];
    const std::string opponent_argument = argv[5];
    const bool balanced_opponents = opponent_argument == "-";
    const Opponent opponent = balanced_opponents
      ? Opponent::netburners
      : parse_opponent(opponent_argument);
    const int requested_size = std::stoi(argv[6]);
    const int size = opponent == Opponent::world_daemon ? 19 : requested_size;
    const int checkpoint_every = std::stoi(argv[7]);
    const std::size_t threads = std::stoull(argv[8]);
    const std::string profile = argv[9];
    const std::string init_path = argv[10];
    const auto outcome_rates = rates(argv[11]);
    const auto policy_rates = rates(argv[12]);
    const int branch_width = std::stoi(argv[13]);
    const int root_width = std::stoi(argv[14]);
    const int tree_depth = argc >= 16 ? std::stoi(argv[15]) : 2;
    const int rollout_depth = argc >= 17 ? std::stoi(argv[16]) : 0;
    const std::string trajectory_mode = argc >= 18 ? argv[17] : "teacher";
    if (games <= 0 || checkpoint_every <= 0 || threads == 0) {
      throw std::invalid_argument("GAMES, CHECKPOINT_EVERY and THREADS must be positive");
    }
    if (simulations < 0 || tree_depth <= 0 || rollout_depth < 0
      || branch_width <= 0 || root_width <= 0) {
      throw std::invalid_argument("search dimensions are invalid");
    }
    if (profile != "small5" && profile != "daemon19") {
      throw std::invalid_argument("PROFILE must be small5 or daemon19");
    }
    if (trajectory_mode != "teacher" && trajectory_mode != "duel" && trajectory_mode != "trio") {
      throw std::invalid_argument("trajectory mode must be teacher, duel or trio");
    }
    if (profile == "small5" && (size != 5 || (!balanced_opponents && opponent == Opponent::world_daemon))) {
      throw std::invalid_argument("small5 population requires '-' or an ordinary 5x5 opponent");
    }
    if (profile == "daemon19" && (balanced_opponents || opponent != Opponent::world_daemon)) {
      throw std::invalid_argument("daemon19 population requires the World Daemon");
    }
    if (std::filesystem::exists(output_dir) && !std::filesystem::is_empty(output_dir)) {
      throw std::invalid_argument("output directory must be new or empty");
    }
    std::filesystem::create_directories(output_dir);
    const CandidateValueNetwork initial = load_model(init_path);
    const int expected_extent = profile == "small5" ? 5 : 19;
    const int expected_opponents = profile == "small5" ? 6 : 0;
    if (initial.extent() != expected_extent
      || initial.opponent_features() != expected_opponents
      || !initial.result_board_only() || !initial.spatial_board()) {
      throw std::invalid_argument("initial model does not match the requested v7 profile");
    }
    const std::string retention_path = argc >= 25 ? argv[24] : init_path;
    const CandidateValueNetwork retention = load_model(retention_path);
    if (retention.extent() != expected_extent
      || retention.opponent_features() != expected_opponents
      || !retention.result_board_only() || !retention.spatial_board()) {
      throw std::invalid_argument("retention model does not match the requested v7 profile");
    }
    const std::string training_scope = argc >= 26 ? argv[25] : "full";
    if (training_scope != "full" && training_scope != "heads") {
      throw std::invalid_argument("training scope must be full or heads");
    }
    const bool freeze_trunk = training_scope == "heads";
    std::vector<std::unique_ptr<KataAdvisorClient>> kata_advisers;
    std::optional<KataAdvisorConfig> kata_settings;
    const std::size_t kata_processes = argc >= 27 ? std::stoull(argv[26]) : 1;
    if (kata_processes == 0) throw std::invalid_argument("KATAGO_PROCESSES must be positive");
    if (trajectory_mode == "trio") {
#ifdef __APPLE__
      const std::string default_backend = "opencl";
#else
      const std::string default_backend = "eigen";
#endif
      const std::filesystem::path source_dir = GO_AI_SOURCE_DIR;
      std::filesystem::create_directories(source_dir / "katago/results/logs");
      const std::string kata_binary = argc >= 19 ? argv[18]
        : (source_dir / ".deps/KataGo/build" / ("ipvgo-" + default_backend) / "katago").string();
      const std::string kata_model = argc >= 20 ? argv[19]
        : (source_dir / "katago/models" / (profile == "small5"
          ? "rect15-b20c256-s343365760-d96847752.bin.gz"
          : "kata1-b10c128-s146897408-d54258564.txt.gz")).string();
      const std::string kata_config_path = argc >= 21 ? argv[20]
        : (source_dir / "katago/config/analysis.cfg").string();
      const int kata_visits = argc >= 22 ? std::stoi(argv[21]) : (profile == "small5" ? 2 : 8);
      const int kata_policy_visits = argc >= 23 ? std::stoi(argv[22]) : 2;
      const int kata_candidates = argc >= 24 ? std::stoi(argv[23]) : 4;
      if (kata_visits < 2 || kata_policy_visits < 2 || kata_candidates <= 0) {
        throw std::invalid_argument("KataGo visits and candidate dimensions are invalid");
      }
      for (const auto& required : {std::filesystem::path(kata_binary),
        std::filesystem::path(kata_model), std::filesystem::path(kata_config_path)}) {
        if (!std::filesystem::exists(required)) {
          throw std::invalid_argument("missing KataGo adviser dependency " + required.string());
        }
      }
      kata_settings = KataAdvisorConfig{
        .worker = (source_dir / "katago/adviser-worker.ts").string(),
        .binary = kata_binary,
        .model = kata_model,
        .analysis_config = kata_config_path,
        .mode = profile == "small5" ? "predictive" : "plain",
        .visits = kata_visits,
        .policy_visits = kata_policy_visits,
        .candidates = kata_candidates,
      };
      kata_advisers.reserve(kata_processes);
      for (std::size_t process = 0; process < kata_processes; ++process) {
        kata_advisers.push_back(std::make_unique<KataAdvisorClient>(*kata_settings));
      }
    }
    std::vector<Learner> learners;
    for (const double outcome : outcome_rates) for (const double policy : policy_rates) {
      learners.push_back({
        .name = "o" + rate_name(outcome) + "-p" + rate_name(policy),
        .outcome_rate = outcome,
        .policy_rate = policy,
        .network = initial,
      });
    }
    for (const auto& learner : learners) save_model(
      learner.network, output_dir / (learner.name + ".0.model"));

    const int feature_extent = profile == "small5" ? 5 : 19;
    const SearchConfig config{
      .simulations = simulations,
      .tree_depth = tree_depth,
      .exploration = 1.4,
      .graph_capacity = 500'000,
      .feature_extent = feature_extent,
      .branch_width = branch_width,
      .root_search_width = root_width,
      .rollout_depth = rollout_depth,
    };
    std::cout << "profile=" << profile
      << " games=" << games
      << " corpus_seed=" << corpus_seed
      << " opponent=" << (balanced_opponents ? "balanced-six" : opponent_name(opponent))
      << " size=" << size
      << " teacher_simulations=" << simulations
      << " teacher_root_width=" << root_width
      << " teacher_branch_width=" << branch_width
      << " teacher_tree_depth=" << tree_depth
      << " trajectory_mode=" << trajectory_mode
      << " retention_model=" << retention_path
      << " training_scope=" << training_scope
      << (kata_settings ? " kata_mode=" + kata_settings->mode : "")
      << (kata_settings ? " kata_visits=" + std::to_string(kata_settings->visits) : "")
      << (kata_settings ? " kata_policy_visits=" + std::to_string(kata_settings->policy_visits) : "")
      << (kata_settings ? " kata_candidates=" + std::to_string(kata_settings->candidates) : "")
      << (kata_settings ? " kata_processes=" + std::to_string(kata_processes) : "")
      << " threads=" << threads
      << " learners=" << learners.size() << std::endl;
    std::mt19937_64 schedule(corpus_seed);
    constexpr std::array<Opponent, 6> ordinary_opponents{
      Opponent::netburners, Opponent::slum_snakes, Opponent::black_hand,
      Opponent::tetrads, Opponent::daedalus, Opponent::illuminati,
    };
    std::vector<ScheduledGame> scheduled(static_cast<std::size_t>(games));
    const std::size_t opponent_offset = static_cast<std::size_t>(schedule() % ordinary_opponents.size());
    for (int game = 0; game < games; ++game) {
      scheduled[static_cast<std::size_t>(game)] = {
        .seed = schedule(),
        .opponent = balanced_opponents
          ? ordinary_opponents[(static_cast<std::size_t>(game) + opponent_offset) % ordinary_opponents.size()]
          : opponent,
        .size = size,
      };
    }
    int completed = 0;
    int wins = 0;
    int rounds = 0;
    double power = 0;
    int challenger_selected = 0;
    int adviser_selected = 0;
    while (completed < games) {
      const int checkpoint_end = std::min(games,
        ((completed / checkpoint_every) + 1) * checkpoint_every);
      const std::size_t count = static_cast<std::size_t>(checkpoint_end - completed);
      std::vector<Episode> episodes(count);
      // Complete an entire checkpoint through a dynamic queue. World Daemon
      // game lengths vary enough that fixed waves strand most cores behind the
      // slowest game near every wave boundary.
      std::atomic<std::size_t> next_game{0};
      std::atomic<bool> generator_failed{false};
      std::mutex generator_error_mutex;
      std::exception_ptr generator_error;
      std::vector<std::jthread> generators;
      const std::size_t generator_count = std::min(threads, count);
      generators.reserve(generator_count);
      for (std::size_t worker = 0; worker < generator_count; ++worker) {
        generators.emplace_back([&, worker] {
          try {
            for (;;) {
              if (generator_failed.load(std::memory_order_relaxed)) return;
              const std::size_t index = next_game.fetch_add(1, std::memory_order_relaxed);
              if (index >= count) return;
              const auto& game = scheduled[static_cast<std::size_t>(completed) + index];
              auto teacher = generate_episode(game.seed, game.opponent, game.size, config);
              if (trajectory_mode == "duel" || trajectory_mode == "trio") {
                auto challenger = generate_episode(
                  game.seed, game.opponent, game.size, config, &retention);
                if (better_episode(challenger, teacher)) {
                  challenger.challenger_selected = true;
                  append_outcomes(challenger, teacher);
                  episodes[index] = std::move(challenger);
                } else {
                  append_outcomes(teacher, challenger);
                  episodes[index] = std::move(teacher);
                }
              } else {
                episodes[index] = std::move(teacher);
              }
              if (trajectory_mode == "trio") {
                auto advised = generate_kata_episode(
                  game.seed, game.opponent, game.size, feature_extent,
                  *kata_advisers[worker % kata_advisers.size()]);
                if (better_episode(advised, episodes[index])) {
                  advised.adviser_selected = true;
                  append_outcomes(advised, episodes[index]);
                  episodes[index] = std::move(advised);
                } else {
                  append_outcomes(episodes[index], advised);
                }
              }
            }
          } catch (...) {
            std::lock_guard lock(generator_error_mutex);
            if (!generator_error) generator_error = std::current_exception();
            generator_failed.store(true, std::memory_order_relaxed);
          }
        });
      }
      generators.clear();
      if (generator_error) std::rethrow_exception(generator_error);
      for (const auto& episode : episodes) {
        wins += episode.won;
        rounds += episode.rounds;
        power += episode.training_power;
        challenger_selected += episode.challenger_selected;
        adviser_selected += episode.adviser_selected;
      }
      std::atomic<std::size_t> next{0};
      std::vector<std::jthread> trainers;
      const std::size_t training_workers = std::min(threads, learners.size());
      trainers.reserve(training_workers);
      for (std::size_t worker = 0; worker < training_workers; ++worker) {
        trainers.emplace_back([&] {
          for (;;) {
            const std::size_t index = next.fetch_add(1, std::memory_order_relaxed);
            if (index >= learners.size()) return;
            train_learner(learners[index], episodes, freeze_trunk);
          }
        });
      }
      trainers.clear();
      completed += static_cast<int>(count);
      for (const auto& learner : learners) save_model(
        learner.network,
        output_dir / (learner.name + "." + std::to_string(completed) + ".model"));
      const double elapsed_seconds = std::chrono::duration<double>(
        std::chrono::steady_clock::now() - started).count();
      std::cout << std::setprecision(8) << "checkpoint=" << completed
        << " selected_win_rate=" << static_cast<double>(wins) / completed
        << " selected_power_per_round=" << power / std::max(rounds, 1)
        << " challenger_selected=" << challenger_selected
        << " adviser_selected=" << adviser_selected
        << " learners=" << learners.size()
        << " elapsed_seconds=" << elapsed_seconds
        << " games_per_second=" << completed / std::max(elapsed_seconds, 1e-9)
        << std::endl;
    }
    for (const auto& learner : learners) save_model(
      learner.network, output_dir / (learner.name + ".model"));
    return EXIT_SUCCESS;
  } catch (const std::exception& error) {
    std::cerr << error.what() << '\n';
    return EXIT_FAILURE;
  }
}
