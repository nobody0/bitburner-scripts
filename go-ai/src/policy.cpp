#include "go/policy.hpp"

#include "go/features.hpp"
#include "go/search.hpp"
#include "go/rules.hpp"

#include <limits>
#include <vector>

namespace bitburner::go {

PolicyDecision choose_with_network(
  const Position& position,
  Opponent opponent,
  double current_reply_seed,
  int elapsed_rounds,
  const CandidateValueNetwork& network
) {
  std::vector<Move> moves;
  for (const auto point : legal_moves(position, Stone::black)) moves.push_back(Move::at(point.x, point.y));
  moves.push_back(Move::pass_turn());
  PolicyDecision best{.win_probability = -1,
    .power_per_round = -std::numeric_limits<double>::infinity()};
  const auto prepared = network.prepare(position.board, static_cast<int>(opponent));
  for (const Move move : moves) {
    Position after_black = position;
    apply_to_position(after_black, move, Stone::black);
    const ReplyForecast forecast = after_black.consecutive_passes >= 2
      ? ReplyForecast{.replies = {{.move = Move::pass_turn(), .probability = 1, .branch = ReplyBranch::pass}}, .exact = true}
      : predict_opponent_replies(after_black, opponent, current_reply_seed);
    double win_probability = 0;
    double power_per_round = 0;
    for (const auto& reply : forecast.replies) {
      Position after = after_black;
      if (after.consecutive_passes < 2) apply_to_position(after, reply.move, Stone::white);
      const auto prediction = network.predict(prepared, move, reply.move, after.board);
      win_probability += reply.probability * prediction.win_probability;
      power_per_round += reply.probability * expected_training_power_per_turn(
        prediction, elapsed_rounds);
    }
    if (win_probability > best.win_probability
      || (win_probability == best.win_probability && power_per_round > best.power_per_round)) {
      best = {.move = move, .known_replies = forecast,
        .win_probability = win_probability,
        .power_per_round = power_per_round};
    }
  }
  return best;
}

}  // namespace bitburner::go
