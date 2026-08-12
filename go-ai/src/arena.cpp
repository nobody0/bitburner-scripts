#include "go/arena.hpp"

#include "go/board_generator.hpp"
#include "go/rules.hpp"

#include <algorithm>
#include <cmath>
#include <cstddef>
#include <limits>
#include <stdexcept>
#include <unordered_set>

namespace bitburner::go {
namespace {

void apply(Position& position, Move move, Stone player) {
  if (move.no_op) return;
  if (move.pass) {
    ++position.consecutive_passes;
    return;
  }
  const std::unordered_set<std::string> history(position.previous_hashes.begin(), position.previous_hashes.end());
  const auto played = play_move(position.board, move.point, player, history);
  if (!played) throw std::logic_error("arena policy produced illegal move");
  position.previous_hashes.push_back(board_hash(position.board));
  position.board = played->board;
  position.consecutive_passes = 0;
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

double immediate_value(Position after_black, const ReplyForecast& forecast, Opponent opponent) {
  double expected = 0;
  for (const auto& reply : forecast.replies) {
    Position after = after_black;
    apply(after, reply.move, Stone::white);
    const Score score = score_board(after.board, opponent_komi(opponent));
    const double difference = score.black - score.white;
    const bool terminal = after.consecutive_passes >= 2;
    const double value = terminal ? (difference >= 0 ? 10'000.0 : -10'000.0) + difference : difference;
    expected += reply.probability * value;
  }
  return expected;
}

Move select_black(
  const Position& position,
  Opponent opponent,
  double current_seed,
  BlackPolicy policy,
  std::mt19937_64& random
) {
  const auto legal = legal_moves(position, Stone::black);
  if (legal.empty()) return Move::pass_turn();
  if (policy == BlackPolicy::random) {
    std::uniform_int_distribution<std::size_t> selected(0, legal.size() - 1);
    const Point point = legal[selected(random)];
    return Move::at(point.x, point.y);
  }
  std::vector<Move> candidates;
  candidates.reserve(legal.size() + 1);
  for (const auto point : legal) candidates.push_back(Move::at(point.x, point.y));
  candidates.push_back(Move::pass_turn());
  double best = -std::numeric_limits<double>::infinity();
  std::vector<Move> best_moves;
  for (const auto candidate : candidates) {
    Position after_black = position;
    apply(after_black, candidate, Stone::black);
    const double value = immediate_value(
      after_black,
      predict_opponent_replies(after_black, opponent, current_seed),
      opponent
    );
    if (value > best + 1e-12) {
      best = value;
      best_moves = {candidate};
    } else if (std::abs(value - best) <= 1e-12) {
      best_moves.push_back(candidate);
    }
  }
  std::uniform_int_distribution<std::size_t> selected(0, best_moves.size() - 1);
  return best_moves[selected(random)];
}

}  // namespace

double opponent_komi(Opponent opponent) {
  switch (opponent) {
    case Opponent::netburners: return 1.5;
    case Opponent::slum_snakes:
    case Opponent::black_hand: return 3.5;
    case Opponent::tetrads:
    case Opponent::daedalus: return 5.5;
    case Opponent::illuminati: return 7.5;
    case Opponent::world_daemon: return 9.5;
  }
  throw std::invalid_argument("unknown opponent");
}

GameResult play_game(const GameConfig& config, BlackPolicy policy, bool include_trace) {
  std::mt19937_64 random(config.seed);
  std::uniform_int_distribution<std::uint32_t> random_u32;
  std::uniform_int_distribution<int> seed_tick(0, 149'999);
  const double board_seed = static_cast<double>(seed_tick(random) * 200);
  Position position{
    .board = initial_board(config.board_size, config.opponent, board_seed, random_u32(random)),
  };
  GameResult result{.config = config};
  const int cap = 4 * config.board_size * config.board_size;
  while (position.consecutive_passes < 2 && result.rounds * 2 < cap) {
    const std::string before = board_hash(position.board);
    const double current_seed = static_cast<double>(seed_tick(random) * 200);
    const Move black = select_black(position, config.opponent, current_seed, policy, random);
    apply(position, black, Stone::black);
    Move white = Move::pass_turn();
    if (position.consecutive_passes < 2) {
      const auto forecast = predict_opponent_replies(position, config.opponent, current_seed);
      white = sample_reply(forecast, random);
      apply(position, white, Stone::white);
    }
    ++result.rounds;
    if (include_trace) result.trace.push_back({
      .before = before,
      .black = black,
      .current_reply_seed = current_seed,
      .white = white,
      .after = board_hash(position.board),
    });
  }
  result.completed = position.consecutive_passes >= 2;
  result.score = score_board(position.board, opponent_komi(config.opponent));
  result.reward = terminal_reward(result.score, opponent_name(config.opponent), config.board_size);
  result.won = result.reward.won;
  return result;
}

}  // namespace bitburner::go
