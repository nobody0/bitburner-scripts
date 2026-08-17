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

std::vector<Move> rank_strict_v9_moves(
  const Position& position,
  Opponent opponent,
  double current_reply_seed,
  int elapsed_rounds,
  const GoNetworkV9& network
) {
  if (position.board.size > network.extent()) {
    throw std::invalid_argument("V9 network extent is smaller than the board");
  }
  std::vector<Move> moves = ordered_legal_moves(position);
  moves.push_back(Move::pass_turn());
  const double komi = network.behavior_features() == behavior_base_features + 1
    ? opponent_komi(opponent) : -1.0;
  const auto move_logits = network.predict_policy(input_for(
    position, network, encode_opponent_turn_behavior(
      opponent_turn_behavior(opponent, current_reply_seed), komi), elapsed_rounds));
  std::stable_sort(moves.begin(), moves.end(), [&](const Move& left, const Move& right) {
    return move_logits[move_index(left, network.extent())]
      > move_logits[move_index(right, network.extent())];
  });
  return moves;
}

Move select_strict_v9_move(
  const Position& position,
  Opponent opponent,
  double current_reply_seed,
  int elapsed_rounds,
  const GoNetworkV9& network
) {
  return rank_strict_v9_moves(
    position, opponent, current_reply_seed, elapsed_rounds, network).front();
}

PolicyDecision choose_with_v9(
  const Position& position,
  Opponent opponent,
  const std::vector<double>& current_reply_seeds,
  int elapsed_rounds,
  const GoNetworkV9& network,
  int candidate_limit
) {
  if (current_reply_seeds.empty()) {
    throw std::invalid_argument("V9 selection requires at least one reply seed");
  }
  if (position.board.size > network.extent()) {
    throw std::invalid_argument("V9 network extent is smaller than the board");
  }
  std::vector<Move> moves = ordered_legal_moves(position);
  moves.push_back(Move::pass_turn());
  const double komi = network.behavior_features() == behavior_base_features + 1
    ? opponent_komi(opponent) : -1.0;
  const std::vector<float> value_behavior = encode_opponent_future_behavior(opponent, komi);
  std::vector<V9Prediction> proposals;
  proposals.reserve(current_reply_seeds.size());
  for (const double seed : current_reply_seeds) {
    proposals.push_back(network.predict(input_for(
      position, network, encode_opponent_turn_behavior(
        opponent_turn_behavior(opponent, seed), komi), elapsed_rounds)));
  }
  const auto average_logit = [&](std::size_t candidate) {
    double result = 0;
    for (const auto& proposal : proposals) {
      result += proposal.move_logits[move_index(moves[candidate], network.extent())];
    }
    return result / static_cast<double>(proposals.size());
  };

  int limit = candidate_limit > 0 ? candidate_limit : 8;
  limit = std::clamp(limit, 1, static_cast<int>(moves.size()));
  std::vector<std::size_t> ranked(moves.size());
  for (std::size_t index = 0; index < ranked.size(); ++index) ranked[index] = index;
  std::stable_sort(ranked.begin(), ranked.end(), [&](std::size_t left, std::size_t right) {
    return average_logit(left) > average_logit(right);
  });
  // K=1 is the deployed global-policy actor.  Its value/auxiliary heads are
  // intentionally untrained, so never widen it into value arbitration.
  if (limit > 1 && limit < static_cast<int>(ranked.size())) {
    const double boundary = average_logit(ranked[static_cast<std::size_t>(limit - 1)])
      - average_logit(ranked[static_cast<std::size_t>(limit)]);
    if (boundary < 0.25) limit = std::min<int>(ranked.size(), limit * 2);
  }
  std::unordered_set<std::size_t> retained;
  if (limit == 1) {
    // Strict K=1 selects the seed-averaged policy argmax and nothing else.
    // Per-seed reservation would retain one candidate per disagreeing seed,
    // silently widening a policy-only decision into value arbitration.
    retained.insert(ranked.front());
  } else {
    const int reserve = std::max(
      1, limit / std::max(2 * static_cast<int>(current_reply_seeds.size()), 1));
    for (std::size_t seed_index = 0; seed_index < proposals.size(); ++seed_index) {
      std::vector<std::size_t> by_seed(moves.size());
      for (std::size_t index = 0; index < by_seed.size(); ++index) by_seed[index] = index;
      std::stable_sort(by_seed.begin(), by_seed.end(), [&](std::size_t left, std::size_t right) {
        return proposals[seed_index].move_logits[move_index(moves[left], network.extent())]
          > proposals[seed_index].move_logits[move_index(moves[right], network.extent())];
      });
      retained.insert(by_seed.begin(), by_seed.begin() + std::min<int>(reserve, by_seed.size()));
    }
    for (const std::size_t index : ranked) {
      if (static_cast<int>(retained.size()) >= limit) break;
      retained.insert(index);
    }
  }

  PolicyDecision best{
    .win_probability = -1,
    .power_per_round = -std::numeric_limits<double>::infinity(),
  };
  std::vector<Move> finalist_moves;
  for (std::size_t index = 0; index < moves.size(); ++index) {
    if (retained.contains(index)) finalist_moves.push_back(moves[index]);
  }
  for (std::size_t index = 0; index < moves.size(); ++index) {
    if (!retained.contains(index)) continue;
    const Move move = moves[index];
    Position after_black = position;
    apply_to_position(after_black, move, Stone::black);
    ReplyForecast combined{.exact = true};
    for (const double seed : current_reply_seeds) {
      const ReplyForecast forecast = after_black.consecutive_passes >= 2
        ? ReplyForecast{.replies = {{
            .move = Move::pass_turn(), .probability = 1,
            .branch = ReplyBranch::pass,
          }}, .exact = true}
        : predict_opponent_replies(after_black, opponent, seed);
      combined.exact = combined.exact && forecast.exact;
      for (auto reply : forecast.replies) {
        reply.probability /= static_cast<double>(current_reply_seeds.size());
        combined.replies.push_back(std::move(reply));
      }
    }
    double win_probability = 0;
    double score_per_round = 0;
    for (const auto& reply : combined.replies) {
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
        .finalists = finalist_moves,
        .known_replies = combined,
        .win_probability = win_probability,
        .power_per_round = score_per_round,
      };
    }
  }
  return best;
}

PolicyDecision choose_with_v9(
  const Position& position,
  Opponent opponent,
  double current_reply_seed,
  int elapsed_rounds,
  const GoNetworkV9& network,
  int candidate_limit
) {
  return choose_with_v9(
    position, opponent, std::vector<double>{current_reply_seed},
    elapsed_rounds, network, candidate_limit);
}

}  // namespace bitburner::go
