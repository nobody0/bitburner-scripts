#include "go/arena.hpp"
#include "go/board_generator.hpp"
#include "go/network_v9.hpp"
#include "go/opponent.hpp"
#include "go/policy_v9.hpp"
#include "go/reward.hpp"
#include "go/rng.hpp"
#include "go/rules.hpp"
#include "go/transition.hpp"

#include <algorithm>
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

  require(aligned_opponent_seed(1000) == 1200,
    "opponent seed follows the initial engine wait");
  require(next_go_dispatch_playtime(1000, 0, 0) == 1200,
    "a reply with no post-seed waits advances one tick");
  require(next_go_dispatch_playtime(1000, 2, 0) == 1600,
    "post-seed waitCycle calls advance distinct ticks");
  require(next_go_dispatch_playtime(1000, 2, 399) == 1800,
    "fixed pattern sleeps advance only completed engine ticks");
  require(next_go_dispatch_playtime(29'999'800, 0, 0) == 0,
    "training playtime wraps at the WHRNG period");
}

void rewards() {
  const auto win = terminal_reward({.black = 10, .white = 9.5}, "Illuminati", 5);
  require(win.won, "tie-or-better is black win");
  require(win.game_power == 80, "single-game Power excludes streak state");
  require(win.training_power == 10, "training utility is unscaled Black score");

  const auto loss = terminal_reward({.black = 10, .white = 10.5}, "Illuminati", 5);
  require(!loss.won, "lower black score is loss");
  require(loss.game_power == 80, "single-game Power excludes streak state");
  require(loss.training_power == 5, "training halves unscaled score on a loss");
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

void behavior_and_v9() {
  const auto slum = opponent_turn_behavior(Opponent::slum_snakes, 1000);
  const auto rolls = whrng(1000, 4);
  require(slum.smart == (rolls[0] < 0.3), "smart mode is exactly seed resolved");
  require(slum.option_roll == rolls[1] && slum.faction_roll == rolls[2]
    && slum.fallback_roll == rolls[3], "behavior exposes the three used rolls");
  require(slum.priority_ranks[static_cast<std::size_t>(ReplyBranch::defend_capture)] == 1,
    "Slum Snakes exposes defend-first semantics without an identity input");
  require(encode_opponent_turn_behavior(slum, 3.5).size() == behavior_base_features + 1,
    "small5 behavior includes komi");
  require(encode_opponent_turn_behavior(
    opponent_turn_behavior(Opponent::world_daemon, 1000)).size() == behavior_base_features,
    "daemon behavior omits fixed komi");
  const auto future = encode_opponent_future_behavior(Opponent::slum_snakes, 3.5);
  require(future.size() == behavior_base_features + 1,
    "small5 future behavior includes komi");
  require(future[0] == 0.3F && future[1] == -1.0F
    && future[2] == -1.0F && future[3] == -1.0F,
    "future behavior preserves smart tendency and marks unknown rolls");

  const auto model = GoNetworkV9::create(
    5, 4, 1, 8, 4, behavior_base_features + 1, 99);
  V9Input input{
    .board = board_from_hash(5, "........................."),
    .legal_black = std::vector<float>(25, 1.0F),
    .behavior = encode_opponent_turn_behavior(
      opponent_turn_behavior(Opponent::illuminati, 1000), 7.5),
  };
  const auto prediction = model.predict(input);
  require(model.predict_policy(input) == prediction.move_logits,
    "policy-only inference exactly matches full-reference policy logits");
  require(prediction.move_logits.size() == 26 && prediction.branch_logits.size() == 26,
    "V9 emits every point plus pass");
  for (const auto& branches : prediction.branch_logits) for (const double value : branches) {
    require(std::isfinite(value), "V9 branch logits are finite");
  }
  std::stringstream checkpoint;
  model.save(checkpoint);
  const auto restored = GoNetworkV9::load(checkpoint);
  const auto round_trip = restored.predict(input);
  require(round_trip.value.win_probability == prediction.value.win_probability
    && round_trip.move_logits == prediction.move_logits,
    "V9 checkpoint round trip is exact");
  const Position position{.board = input.board};
  const auto decision = choose_with_v9(
    position, Opponent::illuminati, 1000, 0, model);
  require(decision.move.pass || play_move(position.board, decision.move.point, Stone::black),
    "V9 proposal/value policy returns a legal move or pass");
  require(!decision.known_replies.replies.empty(),
    "V9 policy carries exact replies for its finalist");
  require(!decision.finalists.empty(), "V9 policy exposes its audited finalist set");
  const auto repeated_seed = choose_with_v9(
    position, Opponent::illuminati, std::vector<double>{1000, 1000}, 0, model);
  require(repeated_seed.move.pass == decision.move.pass
    && repeated_seed.move.point == decision.move.point
    && repeated_seed.finalists == decision.finalists,
    "duplicating one seed preserves the selector decision and finalist set");
  const auto strict_actor = choose_with_v9(
    position, Opponent::illuminati, 1000, 0, model, 1);
  require(strict_actor.finalists.size() == 1,
    "strict K=1 never widens into value-head arbitration");
  require(select_strict_v9_move(position, Opponent::illuminati, 1000, 0, model)
      == strict_actor.move,
    "policy-only actor matches K=1 selection without value arbitration");
  std::stringstream v9_checkpoint;
  model.save(v9_checkpoint);
  require(GoNetworkV9::load(v9_checkpoint).extent() == 5,
    "V9 checkpoint restores through the V9 loader");
}

}  // namespace

int main() {
  try {
    rules();
    random_stream();
    rewards();
    opponent_and_arena();
    behavior_and_v9();
    return EXIT_SUCCESS;
  } catch (const std::exception& error) {
    std::cerr << error.what() << '\n';
    return EXIT_FAILURE;
  }
}
