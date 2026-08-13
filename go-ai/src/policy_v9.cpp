#include "go/policy_v9.hpp"

#include "go/arena.hpp"
#include "go/candidates.hpp"
#include "go/reward.hpp"
#include "go/rules.hpp"
#include "go/transition.hpp"

#include <algorithm>
#include <cmath>
#include <limits>
#include <stdexcept>
#include <string>
#include <unordered_set>

namespace bitburner::go {
namespace {

std::vector<float> legal_vector(const Position& position, int extent) {
  std::vector<float> result(static_cast<std::size_t>(extent * extent));
  for (const Point point : legal_moves(position, Stone::black)) {
    result[static_cast<std::size_t>(point.x * extent + point.y)] = 1;
  }
  return result;
}

V9Input input_for(
  const Position& position,
  const GoNetworkV9& network,
  const std::vector<float>& behavior,
  int elapsed_rounds,
  const Move& response = Move{}
) {
  return {
    .board = position.board,
    .legal_black = legal_vector(position, network.extent()),
    .consecutive_passes = static_cast<float>(position.consecutive_passes) / 2,
    .elapsed_fraction = static_cast<float>(elapsed_rounds)
      / std::max(2 * network.extent() * network.extent(), 1),
    .response_pass = response.pass ? 1.0F : 0.0F,
    .response_no_op = response.no_op ? 1.0F : 0.0F,
    .behavior = behavior,
  };
}

std::size_t move_index(const Move& move, int extent) {
  return move.pass ? static_cast<std::size_t>(extent * extent)
    : static_cast<std::size_t>(move.point.x * extent + move.point.y);
}

}  // namespace

PolicyDecision choose_with_v9(
  const Position& position,
  Opponent opponent,
  double current_reply_seed,
  int elapsed_rounds,
  const GoNetworkV9& network,
  int candidate_limit
) {
  if (position.board.size > network.extent()) {
    throw std::invalid_argument("V9 network extent is smaller than the board");
  }
  std::vector<Move> moves = ordered_legal_moves(position);
  moves.push_back(Move::pass_turn());
  const double komi = network.behavior_features() == behavior_base_features + 1
    ? opponent_komi(opponent) : -1.0;
  const std::vector<float> behavior = encode_opponent_turn_behavior(
    opponent_turn_behavior(opponent, current_reply_seed), komi);
  const std::vector<float> value_behavior = network.extent() >= 19
    ? std::vector<float>(behavior.size(), 0.0F) : behavior;
  const auto proposal = network.predict(input_for(
    position, network, behavior, elapsed_rounds));

  int limit = candidate_limit > 0 ? candidate_limit : 8;
  limit = std::clamp(limit, 1, static_cast<int>(moves.size()));
  std::vector<std::size_t> ranked(moves.size());
  for (std::size_t index = 0; index < ranked.size(); ++index) ranked[index] = index;
  std::stable_sort(ranked.begin(), ranked.end(), [&](std::size_t left, std::size_t right) {
    return proposal.move_logits[move_index(moves[left], network.extent())]
      > proposal.move_logits[move_index(moves[right], network.extent())];
  });
  if (limit < static_cast<int>(ranked.size())) {
    const double boundary = proposal.move_logits[move_index(
      moves[ranked[static_cast<std::size_t>(limit - 1)]], network.extent())]
      - proposal.move_logits[move_index(
        moves[ranked[static_cast<std::size_t>(limit)]], network.extent())];
    if (boundary < 0.25) limit = std::min<int>(ranked.size(), limit * 2);
  }
  std::unordered_set<std::size_t> retained(
    ranked.begin(), ranked.begin() + static_cast<std::ptrdiff_t>(limit));

  PolicyDecision best{
    .win_probability = -1,
    .power_per_round = -std::numeric_limits<double>::infinity(),
  };
  for (std::size_t index = 0; index < moves.size(); ++index) {
    if (!retained.contains(index)) continue;
    const Move move = moves[index];
    Position after_black = position;
    apply_to_position(after_black, move, Stone::black);
    const ReplyForecast forecast = after_black.consecutive_passes >= 2
      ? ReplyForecast{.replies = {{
          .move = Move::pass_turn(), .probability = 1,
          .branch = ReplyBranch::pass,
        }}, .exact = true}
      : predict_opponent_replies(after_black, opponent, current_reply_seed);
    double win_probability = 0;
    double score_per_round = 0;
    for (const auto& reply : forecast.replies) {
      Position after = after_black;
      if (after.consecutive_passes < 2) {
        apply_to_position(after, reply.move, Stone::white);
      }
      ValuePrediction value;
      if (after.consecutive_passes >= 2) {
        const Score score = score_board(after.board, opponent_komi(opponent));
        const bool won = score.black >= score.white;
        value = {
          .win_probability = won ? 1.0 : 0.0,
          .terminal_power = score.black * (won ? 1.0 : 0.5),
          .remaining_turns = 1,
        };
      } else {
        value = network.predict(input_for(
          after, network, value_behavior, elapsed_rounds + 1, reply.move)).value;
      }
      win_probability += reply.probability * value.win_probability;
      score_per_round += reply.probability * value.terminal_power
        / std::max(elapsed_rounds + value.remaining_turns, 1e-6);
    }
    if (win_probability > best.win_probability
      || (win_probability == best.win_probability
        && score_per_round > best.power_per_round)) {
      best = {
        .move = move,
        .known_replies = forecast,
        .win_probability = win_probability,
        .power_per_round = score_per_round,
      };
    }
  }
  return best;
}

}  // namespace bitburner::go
