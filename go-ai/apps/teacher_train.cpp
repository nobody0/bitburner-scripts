#include "go/features.hpp"
#include "go/network.hpp"
#include "go/rules.hpp"

#include <algorithm>
#include <cmath>
#include <cstdlib>
#include <fstream>
#include <iomanip>
#include <iostream>
#include <map>
#include <random>
#include <span>
#include <sstream>
#include <stdexcept>
#include <string>
#include <thread>
#include <tuple>
#include <vector>

namespace {

using namespace bitburner::go;

struct Row {
  TrainingExample example;
  int game{};
  int state{};
  int elapsed{};
  bool teacher_selected{};
};

Move parsed_move(int x, int y) {
  return x < 0 || y < 0 ? Move::pass_turn() : Move::at(x, y);
}

std::vector<Row> load_rows(
  const std::string& path,
  int extent,
  int opponent_features
) {
  std::ifstream input(path);
  if (!input) throw std::runtime_error("cannot open teacher data " + path);
  std::vector<Row> rows;
  std::string line;
  while (std::getline(input, line)) {
    if (line.empty() || line.front() == '#') continue;
    std::istringstream fields(line);
    int game = 0;
    int state = 0;
    int candidate_index = 0;
    int opponent = 0;
    int size = 0;
    int elapsed = 0;
    double remaining = 0;
    double won = 0;
    double power = 0;
    int selected = 0;
    int bx = 0;
    int by = 0;
    int wx = 0;
    int wy = 0;
    std::string before_hash;
    std::string after_hash;
    if (!(fields >> game >> state >> candidate_index >> opponent >> size >> elapsed
      >> remaining >> won >> power >> selected >> bx >> by >> wx >> wy
      >> before_hash >> after_hash)) {
      throw std::runtime_error("invalid teacher row: " + line);
    }
    (void)candidate_index;
    if (size > extent) throw std::runtime_error("teacher row exceeds model extent");
    if (opponent_features > 0 && opponent >= opponent_features) {
      throw std::runtime_error("teacher row opponent is outside model profile");
    }
    const Board before = board_from_hash(size, before_hash);
    const Board after = board_from_hash(size, after_hash);
    rows.push_back({
      .example = {
        .features = encode_candidate(before, parsed_move(bx, by), parsed_move(wx, wy), after, extent, opponent),
        .target = {.win_probability = won, .terminal_power = power, .remaining_turns = remaining},
      },
      .game = game,
      .state = state,
      .elapsed = elapsed,
      .teacher_selected = selected != 0,
    });
  }
  if (rows.empty()) throw std::runtime_error("teacher dataset is empty");
  return rows;
}

double example_loss(const ValuePrediction& prediction, const ValueTarget& target) {
  const double win_difference = prediction.win_probability - target.win_probability;
  const double power_difference = std::log1p(prediction.terminal_power) - std::log1p(target.terminal_power);
  const double turns_difference = std::log1p(prediction.remaining_turns) - std::log1p(target.remaining_turns);
  return (win_difference * win_difference + power_difference * power_difference
    + turns_difference * turns_difference) / 3.0;
}

struct Metrics {
  double loss{};
  int states{};
  int predicted_wins{};
  int best_wins{};
  int teacher_matches{};
  double predicted_utility{};
  double best_utility{};
};

enum class RankingTarget { none, teacher, rollout };

std::vector<CandidateRankingGroup> ranking_groups(
  const std::vector<Row>& rows,
  RankingTarget target
) {
  if (target == RankingTarget::none) return {};
  std::map<std::pair<int, int>, std::vector<const Row*>> states;
  for (const auto& row : rows) states[{row.game, row.state}].push_back(&row);
  std::vector<CandidateRankingGroup> groups;
  groups.reserve(states.size());
  for (const auto& [key, candidates] : states) {
    (void)key;
    std::size_t preferred = 0;
    if (target == RankingTarget::teacher) {
      const auto selected = std::find_if(candidates.begin(), candidates.end(),
        [](const Row* row) { return row->teacher_selected; });
      if (selected == candidates.end()) continue;
      preferred = static_cast<std::size_t>(selected - candidates.begin());
    } else {
      double best_win = -1;
      double best_utility = -1;
      for (std::size_t index = 0; index < candidates.size(); ++index) {
        const auto& row = *candidates[index];
        const double win = row.example.target.win_probability;
        const double utility = row.example.target.terminal_power
          / std::max(row.elapsed + row.example.target.remaining_turns, 1.0);
        if (win > best_win || (win == best_win && utility > best_utility)) {
          preferred = index;
          best_win = win;
          best_utility = utility;
        }
      }
    }
    CandidateRankingGroup group;
    group.preferred_index = preferred;
    group.candidates.reserve(candidates.size());
    for (const Row* row : candidates) group.candidates.push_back(&row->example.features);
    groups.push_back(std::move(group));
  }
  return groups;
}

Metrics evaluate(
  const CandidateValueNetwork& network,
  const std::vector<Row>& rows,
  std::size_t thread_count
) {
  std::map<std::pair<int, int>, std::vector<const Row*>> states;
  for (const auto& row : rows) states[{row.game, row.state}].push_back(&row);
  std::vector<const std::vector<const Row*>*> grouped;
  grouped.reserve(states.size());
  for (const auto& [key, candidates] : states) {
    (void)key;
    grouped.push_back(&candidates);
  }
  const std::size_t workers = std::max<std::size_t>(1,
    std::min(thread_count, std::max(rows.size(), grouped.size())));
  std::vector<Metrics> partial(workers);
  std::vector<std::jthread> threads;
  threads.reserve(workers);
  for (std::size_t worker = 0; worker < workers; ++worker) {
    threads.emplace_back([&, worker] {
      auto& result = partial[worker];
      for (std::size_t index = worker; index < rows.size(); index += workers) {
        const auto& row = rows[index];
        result.loss += example_loss(network.predict(row.example.features), row.example.target);
      }
      for (std::size_t index = worker; index < grouped.size(); index += workers) {
        const auto& candidates = *grouped[index];
        const Row* predicted = nullptr;
        const Row* best = nullptr;
        double predicted_win = -1;
        double predicted_utility = -1;
        double best_win = -1;
        double best_utility = -1;
        for (const Row* row : candidates) {
          const auto value = network.predict(row->example.features);
          const double value_utility = expected_training_power_per_turn(value, row->elapsed);
          if (value.win_probability > predicted_win
            || (value.win_probability == predicted_win && value_utility > predicted_utility)) {
            predicted = row;
            predicted_win = value.win_probability;
            predicted_utility = value_utility;
          }
          const double target_win = row->example.target.win_probability;
          const double target_utility = row->example.target.terminal_power
            / std::max(row->elapsed + row->example.target.remaining_turns, 1.0);
          if (target_win > best_win || (target_win == best_win && target_utility > best_utility)) {
            best = row;
            best_win = target_win;
            best_utility = target_utility;
          }
        }
        if (!predicted || !best) throw std::logic_error("empty teacher state group");
        result.states++;
        result.predicted_wins += static_cast<int>(predicted->example.target.win_probability >= 0.5);
        result.best_wins += static_cast<int>(best->example.target.win_probability >= 0.5);
        result.teacher_matches += predicted->teacher_selected;
        result.predicted_utility += predicted->example.target.terminal_power
          / std::max(predicted->elapsed + predicted->example.target.remaining_turns, 1.0);
        result.best_utility += best_utility;
      }
    });
  }
  threads.clear();
  Metrics result;
  for (const auto& value : partial) {
    result.loss += value.loss;
    result.states += value.states;
    result.predicted_wins += value.predicted_wins;
    result.best_wins += value.best_wins;
    result.teacher_matches += value.teacher_matches;
    result.predicted_utility += value.predicted_utility;
    result.best_utility += value.best_utility;
  }
  result.loss /= rows.size();
  return result;
}

void print_metrics(std::string_view label, int epoch, const Metrics& metrics) {
  const double states = std::max(metrics.states, 1);
  std::cout << label << " epoch=" << epoch << " loss=" << metrics.loss
    << " selected_win_rate=" << metrics.predicted_wins / states
    << " oracle_best_win_rate=" << metrics.best_wins / states
    << " teacher_action_match=" << metrics.teacher_matches / states
    << " selected_power_per_round=" << metrics.predicted_utility / states
    << " oracle_best_power_per_round=" << metrics.best_utility / states << '\n';
}

void save(const CandidateValueNetwork& network, const std::string& path) {
  std::ofstream output(path);
  if (!output) throw std::runtime_error("cannot create model " + path);
  network.save(output);
}

}  // namespace

int main(int argc, char** argv) {
  try {
    if (argc < 5) {
      throw std::invalid_argument(
        "usage: go_cpp_teacher_train DATASET EPOCHS SEED MODEL [HIDDEN] [THREADS] [LEARNING_RATE] [INIT_MODEL] [PROFILE] [all|heads|rank] [none|teacher|rollout] [RANK_LEARNING_RATE]"
      );
    }
    const int epochs = std::stoi(argv[2]);
    const std::uint64_t seed = std::stoull(argv[3]);
    const std::string model_path = argv[4];
    const std::size_t hidden = argc >= 6 ? std::stoull(argv[5]) : 64;
    const std::size_t threads = argc >= 7 ? std::stoull(argv[6])
      : std::max(1U, std::thread::hardware_concurrency());
    const double learning_rate = argc >= 8 ? std::stod(argv[7]) : 0.005;
    const std::string init_model = argc >= 9 ? argv[8] : "";
    const std::string profile = argc >= 10 ? argv[9] : "shared";
    const std::string training_scope = argc >= 11 ? argv[10] : "all";
    if (training_scope != "all" && training_scope != "heads" && training_scope != "rank") {
      throw std::invalid_argument("training scope must be all, heads, or rank");
    }
    const std::string ranking_name = argc >= 12 ? argv[11] : "none";
    const RankingTarget ranking_target = ranking_name == "none" ? RankingTarget::none
      : ranking_name == "teacher" ? RankingTarget::teacher
      : ranking_name == "rollout" ? RankingTarget::rollout
      : throw std::invalid_argument("ranking target must be none, teacher, or rollout");
    const double rank_learning_rate = argc >= 13 ? std::stod(argv[12]) : learning_rate;
    const auto dimensions = [&] {
      if (profile == "shared") return std::pair{19, 7};
      if (profile == "small5") return std::pair{5, 6};
      if (profile == "daemon19") return std::pair{19, 0};
      if (profile == "daemon19-local") return std::pair{19, 0};
      if (profile == "daemon19-board") return std::pair{19, 0};
      if (profile == "small5-board") return std::pair{5, 6};
      if (profile == "daemon19-spatial") return std::pair{19, 0};
      if (profile == "small5-spatial") return std::pair{5, 6};
      throw std::invalid_argument("unknown model profile");
    }();
    CandidateValueNetwork network = [&] {
      if (init_model.empty()) {
        return CandidateValueNetwork(dimensions.first, hidden, seed, dimensions.second,
          profile == "daemon19-local",
          profile == "daemon19-board" || profile == "small5-board"
            || profile == "daemon19-spatial" || profile == "small5-spatial",
          profile == "daemon19-spatial" || profile == "small5-spatial");
      }
      std::ifstream input(init_model);
      if (!input) throw std::runtime_error("cannot open initial model " + init_model);
      return CandidateValueNetwork::load(input);
    }();
    const auto all = load_rows(argv[1], network.extent(), network.opponent_features());
    std::vector<Row> training;
    std::vector<Row> held_out;
    for (const auto& row : all) {
      (row.game % 5 == 0 ? held_out : training).push_back(row);
    }
    if (training.empty() || held_out.empty()) {
      training = all;
      held_out = all;
    }
    save(network, model_path + ".0.model");
    std::mt19937_64 random(seed ^ 0x7ea4c3ULL);
    std::cout << std::setprecision(8) << "rows=" << all.size()
      << " training=" << training.size() << " held_out=" << held_out.size()
      << " hidden=" << hidden << " outputs=3 threads=" << threads
      << " extent=" << network.extent()
      << " opponent_features=" << network.opponent_features()
      << " spatial_board=" << network.spatial_board()
      << " training_scope=" << training_scope
      << " ranking=" << ranking_name
      << " learning_rate=" << learning_rate
      << " rank_learning_rate=" << rank_learning_rate
      << " initialization=" << (init_model.empty() ? "random" : init_model) << '\n';
    print_metrics("train", 0, evaluate(network, training, threads));
    print_metrics("heldout", 0, evaluate(network, held_out, threads));
    // Each network call creates one gradient shard per worker. Larger batches
    // amortize thread startup and shard reduction while retaining enough SGD
    // steps per epoch for the current corpora.
    constexpr std::size_t batch_size = 512;
    constexpr std::size_t ranking_batch_size = 128;
    for (int epoch = 1; epoch <= epochs; ++epoch) {
      std::shuffle(training.begin(), training.end(), random);
      if (training_scope != "rank") {
        for (std::size_t offset = 0; offset < training.size(); offset += batch_size) {
          const std::size_t count = std::min(batch_size, training.size() - offset);
          std::vector<TrainingExample> batch;
          batch.reserve(count);
          for (std::size_t index = 0; index < count; ++index) {
            batch.push_back(training[offset + index].example);
          }
          (void)network.train_batch(batch, learning_rate, threads, training_scope == "heads");
        }
      }
      auto groups = ranking_groups(training, ranking_target);
      std::shuffle(groups.begin(), groups.end(), random);
      for (std::size_t offset = 0; offset < groups.size(); offset += ranking_batch_size) {
        const std::size_t count = std::min(ranking_batch_size, groups.size() - offset);
        (void)network.train_ranking_batch(
          std::span<const CandidateRankingGroup>(groups.data() + offset, count),
          rank_learning_rate,
          threads,
          training_scope == "heads"
        );
      }
      if (epoch == 1 || epoch % 5 == 0 || epoch == epochs) {
        print_metrics("train", epoch, evaluate(network, training, threads));
        print_metrics("heldout", epoch, evaluate(network, held_out, threads));
        save(network, model_path + "." + std::to_string(epoch) + ".model");
      }
    }
    save(network, model_path);
    return EXIT_SUCCESS;
  } catch (const std::exception& error) {
    std::cerr << error.what() << '\n';
    return EXIT_FAILURE;
  }
}
