#include "go/arena.hpp"
#include "go/board_generator.hpp"
#include "go/features.hpp"
#include "go/network.hpp"
#include "go/opponent.hpp"
#include "go/reward.hpp"
#include "go/rng.hpp"
#include "go/rules.hpp"
#include "go/search.hpp"

#include <cmath>
#include <cstdlib>
#include <iostream>
#include <sstream>
#include <stdexcept>
#include <string>
#include <vector>

namespace {

using namespace bitburner::go;

void require(bool condition, const std::string& message) {
  if (!condition) throw std::runtime_error(message);
}

void rules() {
  const Board capture{.size = 3, .columns = {".X.", "XO.", ".X."}};
  const auto played = play_move(capture, {1, 2}, Stone::black);
  require(played.has_value(), "capture move must be legal");
  require(played->captures == 1, "capture count");
  require(board_hash(played->board) == ".X.X.X.X.", "capture board");

  const Board suicide{.size = 3, .columns = {".X.", "X.X", ".X."}};
  require(!play_move(suicide, {1, 1}, Stone::white), "suicide must be illegal");

  const Board empty{.size = 5, .columns = {".....", ".....", "..X..", ".....", "....."}};
  const Score score = score_board(empty, 7.5);
  require(score.black == 1 && score.white == 7.5, "almost-empty territory exception");

  Position no_op{.board = empty, .previous_hashes = {"prior"}, .consecutive_passes = 1};
  const Move rejected_priority{.pass = false, .no_op = true, .point = {0, 0}};
  apply_to_position(no_op, rejected_priority, Stone::white);
  require(board_hash(no_op.board) == board_hash(empty), "rejected AI priority move leaves board unchanged");
  require(no_op.previous_hashes == std::vector<std::string>{"prior"},
    "rejected AI priority move does not add position history");
  require(no_op.consecutive_passes == 1, "rejected AI priority move is not a pass");
}

void random_stream() {
  const auto values = whrng(1000, 2);
  require(values.size() == 2, "WHRNG count");
  require(std::abs(values[0] - 0.016930906199656093) < 1e-15, "WHRNG first value");
  require(std::abs(values[1] - 0.8952539112379991) < 1e-15, "WHRNG second value");
}

void rewards() {
  const auto win = terminal_reward({.black = 10, .white = 9.5}, "Illuminati", 5);
  require(win.won, "tie-or-better is black win");
  require(win.game_power == 80, "single-game Power excludes streak state");
  require(win.training_power == win.game_power, "wins are not penalized");

  const auto loss = terminal_reward({.black = 10, .white = 10.5}, "Illuminati", 5);
  require(!loss.won, "lower black score is loss");
  require(loss.game_power == 80, "single-game Power excludes streak state");
  require(loss.training_power == 40, "training halves a losing game's Power");
}

void features_and_training() {
  static_assert(CandidateValueNetwork::output_size == 3);
  const Board before{.size = 3, .columns = {"#..", ".X.", "..O"}};
  const Board after{.size = 3, .columns = {"#..", ".XX", ".OO"}};
  const auto features = encode_candidate(before, Move::at(1, 2), Move::at(2, 1), after, 5);
  require(features.planes.size() == 8 * 25, "feature shape");
  require(plane(features, FeaturePlane::before_unplayable)[0] == 1, "offline node encoded");
  require(plane(features, FeaturePlane::before_unplayable)[4 * 5 + 4] == 1, "padding encoded as unplayable");
  require(plane(features, FeaturePlane::candidate)[1 * 5 + 2] == 1, "candidate plane");
  require(plane(features, FeaturePlane::response)[2 * 5 + 1] == 1, "response plane");

  TrainingExample example{
    .features = features,
    .target = {.win_probability = 1, .terminal_power = 120, .remaining_turns = 4},
  };
  CandidateValueNetwork network(5, 16, 7);
  const double initial = network.train_batch(std::span<const TrainingExample>(&example, 1), 0.01);
  double final = initial;
  for (int iteration = 0; iteration < 300; ++iteration) {
    final = network.train_batch(std::span<const TrainingExample>(&example, 1), 0.01);
  }
  require(final < initial * 0.05, "reference network must learn a rollout target");

  CandidateValueNetwork ranker(5, 16, 17);
  auto alternate = features;
  alternate.candidate_pass = true;
  CandidateRankingGroup ranking{
    .candidates = {&features, &alternate},
    .preferred_index = 1,
  };
  for (int step = 0; step < 200; ++step) {
    (void)ranker.train_ranking_batch(
      std::span<const CandidateRankingGroup>(&ranking, 1), 0.02
    );
  }
  require(
    ranker.predict(alternate).win_probability > ranker.predict(features).win_probability,
    "position-local ranking must learn the preferred candidate"
  );
  std::stringstream serialized;
  network.save(serialized);
  const auto restored = CandidateValueNetwork::load(serialized);
  const auto original_prediction = network.predict(features);
  const auto prepared_prediction = network.predict(
    network.prepare(before), Move::at(1, 2), Move::at(2, 1), after);
  require(std::abs(original_prediction.win_probability - prepared_prediction.win_probability) < 1e-12,
    "prepared inference preserves win prediction");
  require(std::abs(original_prediction.terminal_power - prepared_prediction.terminal_power) < 1e-10,
    "prepared inference preserves Power prediction");
  require(std::abs(original_prediction.remaining_turns - prepared_prediction.remaining_turns) < 1e-10,
    "prepared inference preserves turns prediction");
  const auto localized = CandidateValueNetwork::with_local_context(network);
  const auto localized_prediction = localized.predict(features);
  require(localized.uses_local_context(), "localized network enables candidate-relative context");
  require(localized.input_size() == network.input_size() + local_context_size,
    "localized network adds only the fixed relative context window");
  require(std::abs(original_prediction.win_probability - localized_prediction.win_probability) < 1e-12,
    "zero-initialized local context preserves the source policy exactly");
  const auto board_only = CandidateValueNetwork::with_result_board_only(network);
  require(board_only.result_board_only(), "board-value conversion enables result-board-only input");
  require(board_only.input_size() == 3 * 25 + 7,
    "board-value network has only result stones, unplayable cells, and enemy identity");
  auto same_result_different_action = encode_candidate(
    Board{.size = 3, .columns = {"...", "...", "..."}},
    Move::pass_turn(), Move::pass_turn(), after, 5, 0);
  const auto board_value = board_only.predict(features);
  const auto invariant_value = board_only.predict(same_result_different_action);
  require(board_value.win_probability == invariant_value.win_probability,
    "board value is invariant to the prior board and explicit move coordinates");
  require(board_value.terminal_power == invariant_value.terminal_power,
    "board value Power is invariant to the prior board and explicit move coordinates");
  const auto prepared_board_value = board_only.predict(
    board_only.prepare(before, 0), Move::at(1, 2), Move::at(2, 1), after);
  require(board_value.win_probability == prepared_board_value.win_probability,
    "prepared board-value inference evaluates the resulting board");
  std::stringstream board_serialized;
  board_only.save(board_serialized);
  const auto board_restored = CandidateValueNetwork::load(board_serialized);
  require(board_restored.result_board_only(), "v6 model preserves board-value architecture");
  require(board_restored.predict(features).win_probability == board_value.win_probability,
    "v6 board-value model round trip");
  const auto restored_prediction = restored.predict(features);
  require(original_prediction.win_probability == restored_prediction.win_probability, "model win head round trip");
  require(original_prediction.terminal_power == restored_prediction.terminal_power, "model Power head round trip");
  require(original_prediction.remaining_turns == restored_prediction.remaining_turns, "model turns head round trip");
  require(restored.opponent_features() == 7, "v3 model preserves opponent feature count");

  CandidateValueNetwork small_profile(5, 8, 8, 6);
  require(small_profile.input_size() == 8 * 25 + 2 + 6, "small profile has six enemy bits");
  CandidateValueNetwork daemon_profile(19, 8, 9, 0);
  require(daemon_profile.input_size() == 8 * 19 * 19 + 2, "daemon profile has no enemy bits");
  CandidateValueNetwork small_board_profile(5, 8, 18, 6, false, true);
  require(small_board_profile.input_size() == 3 * 25 + 6,
    "small board-value profile has 81 inputs");
  CandidateValueNetwork daemon_board_profile(19, 8, 19, 0, false, true);
  require(daemon_board_profile.input_size() == 3 * 19 * 19,
    "daemon board-value profile has 1083 inputs");
  CandidateValueNetwork spatial_profile(5, 16, 20, 6, false, true, true);
  require(spatial_profile.spatial_board(), "spatial profile enables shared-weight board trunk");
  require(spatial_profile.input_size() == 3 * 25 + 6,
    "spatial profile still exposes only result-board and enemy inputs");
  const auto spatial_value = spatial_profile.predict(features);
  const auto spatial_invariant = spatial_profile.predict(same_result_different_action);
  require(spatial_value.win_probability == spatial_invariant.win_probability,
    "spatial board value is invariant to explicit move coordinates");
  const auto prepared_spatial_value = spatial_profile.predict(
    spatial_profile.prepare(before, 0), Move::at(1, 2), Move::at(2, 1), after);
  require(std::abs(spatial_value.win_probability - prepared_spatial_value.win_probability) < 1e-12,
    "incremental spatial inference preserves win prediction");
  require(std::abs(spatial_value.terminal_power - prepared_spatial_value.terminal_power) < 1e-10,
    "incremental spatial inference preserves Power prediction");
  const double spatial_initial = spatial_profile.train_batch(
    std::span<const TrainingExample>(&example, 1), 0.01);
  double spatial_final = spatial_initial;
  for (int iteration = 0; iteration < 100; ++iteration) {
    spatial_final = spatial_profile.train_batch(
      std::span<const TrainingExample>(&example, 1), 0.01);
  }
  require(spatial_final < spatial_initial,
    "spatial board-value trunk backpropagates a rollout target");
  std::stringstream spatial_serialized;
  spatial_profile.save(spatial_serialized);
  const auto spatial_restored = CandidateValueNetwork::load(spatial_serialized);
  require(spatial_restored.spatial_board(), "v7 model preserves spatial architecture");
  require(spatial_restored.predict(features).win_probability
      == spatial_profile.predict(features).win_probability,
    "v7 spatial model round trip");

  CandidateValueNetwork padded(19, 16, 10);
  const auto compact = CandidateValueNetwork::project_profile(padded, 5, 6);
  const auto padded_features = encode_candidate(before, Move::at(1, 2), Move::at(2, 1), after, 19, 3);
  const auto compact_features = encode_candidate(before, Move::at(1, 2), Move::at(2, 1), after, 5, 3);
  const auto padded_prediction = padded.predict(padded_features);
  const auto compact_prediction = compact.predict(compact_features);
  require(std::abs(padded_prediction.win_probability - compact_prediction.win_probability) < 1e-12,
    "small projection preserves win prediction");
  require(std::abs(padded_prediction.terminal_power - compact_prediction.terminal_power) < 1e-10,
    "small projection preserves Power prediction");

  const auto widened = CandidateValueNetwork::widen(compact, 37, 11);
  const auto widened_prediction = widened.predict(compact_features);
  require(std::abs(widened_prediction.win_probability - compact_prediction.win_probability) < 1e-12,
    "widening preserves win prediction");
  require(std::abs(widened_prediction.terminal_power - compact_prediction.terminal_power) < 1e-10,
    "widening preserves Power prediction");
  require(widened.hidden() == 37, "widening changes hidden width");

  const ValuePrediction high_power{.win_probability = 1, .terminal_power = 80, .remaining_turns = 2};
  const ValuePrediction low_power{.win_probability = 1, .terminal_power = 40, .remaining_turns = 2};
  require(
    expected_training_power_per_turn(high_power) == expected_training_power_per_turn(low_power) * 2,
    "Power per turn is terminal training Power divided by total rounds"
  );
}

void opponent_and_arena() {
  const auto generated = initial_board(13, Opponent::netburners, 1000, 2'779'096'653U);
  require(board_hash(generated) == "#.#..#.#..###..........###..........###............##.............................................................................#.........................#...##.......",
    "native obstacle generation fixture");

  const Position empty{.board = board_from_hash(5, ".........................")};
  const auto reply = predict_opponent_replies(empty, Opponent::illuminati, 1000);
  require(reply.exact && reply.replies.size() == 1, "empty Illuminati reply is exact");
  require(reply.replies[0].move.point == Point{2, 2}, "empty Illuminati takes center corner option");
  require(reply.replies[0].branch == ReplyBranch::corner, "empty Illuminati branch");
  require(reply.replies[0].wait.cycle_waits_after_seed == 3, "empty Illuminati wait trace");

  const GameConfig config{.opponent = Opponent::illuminati, .board_size = 5, .seed = 42};
  const auto first = play_game(config, BlackPolicy::known_reply_greedy, true);
  const auto second = play_game(config, BlackPolicy::known_reply_greedy, true);
  require(first.completed && second.completed, "native arena games complete");
  require(first.won == second.won && first.rounds == second.rounds
    && first.score.black == second.score.black && first.score.white == second.score.white,
    "native arena is deterministic for a corpus seed");
  require(first.trace.size() == second.trace.size(), "native arena trace is deterministic");
}

void monte_carlo_search() {
  const Position position{.board = initial_board(5, Opponent::illuminati, 81'000, 17)};
  SearchGraph first({.simulations = 12, .tree_depth = 5, .exploration = 1.2,
    .graph_capacity = 10'000, .feature_extent = 5});
  SearchGraph second(first.config());
  std::mt19937_64 first_random(1234);
  std::mt19937_64 second_random(1234);
  const auto a = first.search(position, Opponent::illuminati, 9'200, 0, first_random);
  const auto b = second.search(position, Opponent::illuminati, 9'200, 0, second_random);
  require(a.move.pass == b.move.pass && a.move.point == b.move.point, "search is deterministic for its corpus seed");
  require(!a.targets.empty() && first.edge_count() > 0 && first.edge_count() <= first.config().graph_capacity,
    "search creates bounded visited edges and replay targets");
  for (const auto& target : a.targets) {
    require(target.features.opponent_index == static_cast<int>(Opponent::illuminati), "enemy is a one-hot feature");
    require(target.features.planes.size() == 8 * 25, "seed is not present in spatial features");
    require(target.visits > 0 && target.target.remaining_turns > 0, "terminal backup reaches visited actions");
  }
  CandidateValueNetwork network(5, 8, 9);
  require(network.input_size() == 8 * 25 + 2 + 7, "network input is planes, pass bits, and enemy only");
}

}  // namespace

int main() {
  try {
    rules();
    random_stream();
    rewards();
    features_and_training();
    opponent_and_arena();
    monte_carlo_search();
    return EXIT_SUCCESS;
  } catch (const std::exception& error) {
    std::cerr << error.what() << '\n';
    return EXIT_FAILURE;
  }
}
