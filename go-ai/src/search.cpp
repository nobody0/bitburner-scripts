#include "go/search.hpp"

#include "go/arena.hpp"
#include "go/analysis.hpp"
#include "go/reward.hpp"
#include "go/rules.hpp"

#include <algorithm>
#include <cmath>
#include <cstddef>
#include <limits>
#include <optional>
#include <sstream>
#include <stdexcept>
#include <unordered_set>
#include <utility>

namespace bitburner::go {
namespace {

struct Branch {
  Move response;
  double probability{};
  Position after;
  std::string edge_key;
};

struct Candidate {
  Move move;
  std::vector<Branch> branches;
  double prior{};
};

struct PathEntry {
  std::string edge_key;
  int round{};
};

struct SelectionScore {
  double win{};
  double utility{};
};

double heuristic_value(const Board& board, Opponent opponent);

std::string move_key(Move move) {
  if (move.no_op) return "n" + std::to_string(move.point.x) + "," + std::to_string(move.point.y);
  return move.pass ? "p" : std::to_string(move.point.x) + "," + std::to_string(move.point.y);
}

std::string state_key(const Position& position, Opponent opponent, int elapsed_rounds) {
  const auto hash_text = [](std::string_view text) {
    std::uint64_t hash = 1'469'598'103'934'665'603ULL;
    for (const unsigned char byte : text) {
      hash ^= byte;
      hash *= 1'099'511'628'211ULL;
    }
    return hash;
  };
  std::uint64_t history = 0;
  for (const auto& prior : position.previous_hashes) {
    std::uint64_t value = hash_text(prior);
    value ^= value >> 30;
    value *= 0xbf58476d1ce4e5b9ULL;
    value ^= value >> 27;
    value *= 0x94d049bb133111ebULL;
    history ^= value ^ (value >> 31);
  }
  return std::to_string(static_cast<int>(opponent)) + '|' + std::to_string(elapsed_rounds)
    + '|' + std::to_string(position.consecutive_passes) + '|'
    + std::to_string(hash_text(board_hash(position.board))) + '|' + std::to_string(history);
}

ReplyForecast legal_forecast(const Position& position, ReplyForecast forecast) {
  const std::unordered_set<std::string> history(
    position.previous_hashes.begin(), position.previous_hashes.end());
  forecast.replies.erase(std::remove_if(
    forecast.replies.begin(), forecast.replies.end(), [&](const WeightedReply& reply) {
      return !reply.move.pass && !reply.move.no_op
        && !play_move(position.board, reply.move.point, Stone::white, history).has_value();
    }), forecast.replies.end());
  if (forecast.replies.empty()) {
    return {.replies = {{.move = Move::pass_turn(), .probability = 1.0,
      .branch = ReplyBranch::pass}}, .exact = true};
  }
  double total = 0;
  for (const auto& reply : forecast.replies) total += reply.probability;
  for (auto& reply : forecast.replies) reply.probability /= total;
  std::unordered_set<std::string> moves;
  for (const auto& reply : forecast.replies) moves.insert(move_key(reply.move));
  forecast.exact = moves.size() == 1;
  return forecast;
}

std::vector<Candidate> candidates(
  const Position& position,
  Opponent opponent,
  double current_seed,
  int elapsed_rounds,
  int max_candidates = 0
) {
  struct OrderedMove {
    Move move;
    Position after_black;
    double order{};
  };
  std::vector<OrderedMove> moves;
  const double centre = (position.board.size - 1) / 2.0;
  const std::unordered_set<std::string> history(
    position.previous_hashes.begin(), position.previous_hashes.end());
  for (int x = 0; x < position.board.size; ++x) for (int y = 0; y < position.board.size; ++y) {
    const Point point{x, y};
    auto played = play_move(position.board, point, Stone::black, history);
    if (!played) continue;
    Position after_black = position;
    after_black.previous_hashes.push_back(board_hash(position.board));
    after_black.board = std::move(played->board);
    after_black.consecutive_passes = 0;
    int adjacent = 0;
    constexpr int dx[] = {0, 1, 0, -1};
    constexpr int dy[] = {1, 0, -1, 0};
    for (int direction = 0; direction < 4; ++direction) {
      const char cell = at(position.board, point.x + dx[direction], point.y + dy[direction]);
      adjacent += cell == 'X' ? 3 : cell == 'O' ? 2 : cell == '.' ? 1 : 0;
    }
    const double centrality = position.board.size - std::abs(point.x - centre) - std::abs(point.y - centre);
    moves.push_back({
      .move = Move::at(point.x, point.y),
      .after_black = std::move(after_black),
      .order = played->captures * 1'000.0 + adjacent * 10.0 + centrality * 0.02,
    });
  }
  Position after_pass = position;
  apply_to_position(after_pass, Move::pass_turn(), Stone::black);
  const Score pass_score = score_board(after_pass.board, opponent_komi(opponent));
  const double pass_order = position.consecutive_passes > 0 && pass_score.black >= pass_score.white
    ? 10'000.0 : -1.0;
  moves.push_back({.move = Move::pass_turn(), .after_black = std::move(after_pass), .order = pass_order});
  if (max_candidates > 0 && static_cast<int>(moves.size()) > max_candidates) {
    std::stable_sort(moves.begin(), moves.end(), [](const OrderedMove& left, const OrderedMove& right) {
      return left.order > right.order;
    });
    const auto pass = std::find_if(moves.begin(), moves.end(), [](const OrderedMove& value) { return value.move.pass; });
    const bool pass_retained = pass < moves.begin() + max_candidates;
    OrderedMove saved_pass;
    if (!pass_retained) saved_pass = *pass;
    moves.resize(static_cast<std::size_t>(max_candidates));
    if (!pass_retained) moves.back() = std::move(saved_pass);
  }
  const std::string root = state_key(position, opponent, elapsed_rounds);
  std::vector<Candidate> result;
  result.reserve(moves.size());
  for (auto& ordered : moves) {
    const Move move = ordered.move;
    Position& after_black = ordered.after_black;
    ReplyForecast forecast;
    if (after_black.consecutive_passes >= 2) {
      forecast = {.replies = {{.move = Move::pass_turn(), .probability = 1, .branch = ReplyBranch::pass}}, .exact = true};
    } else {
      forecast = legal_forecast(
        after_black, predict_opponent_replies(after_black, opponent, current_seed));
    }
    Candidate candidate{.move = move};
    for (const auto& reply : forecast.replies) {
      Position after = after_black;
      if (after.consecutive_passes < 2) apply_to_position(after, reply.move, Stone::white);
      candidate.branches.push_back({
        .response = reply.move,
        .probability = reply.probability,
        .after = std::move(after),
        .edge_key = root + ">" + move_key(move) + ">" + move_key(reply.move),
      });
      const Score immediate = score_board(candidate.branches.back().after.board, opponent_komi(opponent));
      const double immediate_value = position.board.size == 5
        ? immediate.black - immediate.white
        : heuristic_value(candidate.branches.back().after.board, opponent);
      candidate.prior += reply.probability * std::tanh(
        immediate_value / static_cast<double>(position.board.size * position.board.size));
    }
    result.push_back(std::move(candidate));
  }
  return result;
}

const EdgeStatistics* find_stats(const std::unordered_map<std::string, EdgeStatistics>& edges, const std::string& key) {
  const auto found = edges.find(key);
  return found == edges.end() ? nullptr : &found->second;
}

SelectionScore candidate_score(
  const Candidate& candidate,
  const std::unordered_map<std::string, EdgeStatistics>& edges,
  std::uint64_t parent_visits,
  double exploration
) {
  SelectionScore value;
  for (const auto& branch : candidate.branches) {
    const EdgeStatistics* stats = find_stats(edges, branch.edge_key);
    if (!stats || stats->visits == 0) {
      const double bonus = exploration * std::sqrt(std::log(static_cast<double>(parent_visits + 2)));
      value.win += branch.probability * bonus;
      value.utility += branch.probability * (candidate.prior + bonus);
      continue;
    }
    const double mean = stats->utility_sum / static_cast<double>(stats->visits);
    const double bonus = exploration * std::sqrt(std::log(static_cast<double>(parent_visits + 1)) / stats->visits);
    value.win += branch.probability * (stats->wins / static_cast<double>(stats->visits) + bonus);
    value.utility += branch.probability * (mean + bonus);
  }
  return value;
}

std::size_t choose_candidate(
  const std::vector<Candidate>& options,
  const std::unordered_map<std::string, EdgeStatistics>& edges,
  double exploration,
  std::mt19937_64& random
) {
  std::uint64_t visits = 0;
  for (const auto& candidate : options) for (const auto& branch : candidate.branches) {
    if (const auto* stats = find_stats(edges, branch.edge_key)) visits += stats->visits;
  }
  SelectionScore best{-std::numeric_limits<double>::infinity(), -std::numeric_limits<double>::infinity()};
  std::vector<std::size_t> selected;
  for (std::size_t index = 0; index < options.size(); ++index) {
    const SelectionScore score = candidate_score(options[index], edges, visits, exploration);
    if (score.win > best.win || (score.win == best.win && score.utility > best.utility)) {
      best = score;
      selected = {index};
    } else if (score.win == best.win && score.utility == best.utility) selected.push_back(index);
  }
  std::uniform_int_distribution<std::size_t> tie(0, selected.size() - 1);
  return selected[tie(random)];
}

std::size_t sample_branch(const Candidate& candidate, std::mt19937_64& random) {
  std::uniform_real_distribution<double> unit(0.0, 1.0);
  const double roll = unit(random);
  double cumulative = 0;
  for (std::size_t index = 0; index < candidate.branches.size(); ++index) {
    cumulative += candidate.branches[index].probability;
    if (roll <= cumulative) return index;
  }
  return candidate.branches.size() - 1;
}

double random_seed(std::mt19937_64& random) {
  std::uniform_int_distribution<int> tick(0, 149'999);
  return static_cast<double>(tick(random) * 200);
}

double cohesion(Opponent opponent, int size) {
  if (size != 5) return 0.55;
  switch (opponent) {
    case Opponent::slum_snakes: return 0.25;
    case Opponent::illuminati: return 0.4;
    case Opponent::black_hand: return 1.1;
    case Opponent::tetrads:
    case Opponent::daedalus: return 0.8;
    default: return 0.55;
  }
}

// Native counterpart of the frozen teacher's static evaluator. Unlike area
// score alone, this prices atari exposure, liberties, connected chains, and a
// small amount of central influence. It is used only for nonterminal leaves.
double heuristic_value(const Board& board, Opponent opponent) {
  int black_stones = 0;
  int white_stones = 0;
  for (int x = 0; x < board.size; ++x) for (int y = 0; y < board.size; ++y) {
    black_stones += at(board, x, y) == 'X';
    white_stones += at(board, x, y) == 'O';
  }
  const Score score = score_board(board, opponent_komi(opponent));
  double value = score.black - score.white - black_stones + white_stones;
  const double chain_cohesion = cohesion(opponent, board.size);
  const double centre = (board.size - 1) / 2.0;
  const Analysis analysis = analyze_board(board);
  for (const auto& chain : analysis.chains) {
    if (chain.color != 'X' && chain.color != 'O') continue;
    const double stones = static_cast<double>(chain.points.size());
    const int liberties = static_cast<int>(chain.liberties.size());
    double strength = liberties == 1 ? -stones
      : stones * (liberties == 2 ? 0.8 : 1.0) + std::min(liberties, 4) * 0.18;
    if (liberties > 1) strength += std::max(stones - 1.0, 0.0) * chain_cohesion;
    double influence = 0;
    for (const auto point : chain.points) {
      influence += std::max(0.0,
        centre - (std::abs(point.x - centre) + std::abs(point.y - centre)) * 0.25);
    }
    strength += influence * 0.04;
    value += chain.color == 'X' ? strength : -strength;
  }
  return value;
}

void random_rollout(
  Position& position,
  Opponent opponent,
  int& rounds,
  int cap,
  int rollout_depth,
  std::mt19937_64& random
) {
  const int end_round = rounds + rollout_depth;
  while (position.consecutive_passes < 2 && rounds * 2 < cap && rounds < end_round) {
    const auto legal = legal_moves(position, Stone::black);
    Move black = Move::pass_turn();
    if (!legal.empty()) {
      std::uniform_int_distribution<std::size_t> choice(0, legal.size() - 1);
      const auto point = legal[choice(random)];
      black = Move::at(point.x, point.y);
    }
    apply_to_position(position, black, Stone::black);
    if (position.consecutive_passes < 2) {
      const auto forecast = predict_opponent_replies(position, opponent, random_seed(random));
      const Candidate wrapper{.branches = [&] {
        std::vector<Branch> branches;
        for (const auto& reply : forecast.replies) branches.push_back({.response = reply.move, .probability = reply.probability});
        return branches;
      }()};
      apply_to_position(position, wrapper.branches[sample_branch(wrapper, random)].response, Stone::white);
    }
    ++rounds;
  }
}

}  // namespace

void apply_to_position(Position& position, Move move, Stone player) {
  if (move.no_op) return;
  if (move.pass) { ++position.consecutive_passes; return; }
  const std::unordered_set<std::string> history(position.previous_hashes.begin(), position.previous_hashes.end());
  const auto played = play_move(position.board, move.point, player, history);
  if (!played) throw std::logic_error("search transition is illegal");
  position.previous_hashes.push_back(board_hash(position.board));
  position.board = played->board;
  position.consecutive_passes = 0;
}

SearchGraph::SearchGraph(SearchConfig config) : config_(config) {
  if (config_.simulations < 0 || config_.tree_depth <= 0 || config_.graph_capacity == 0) {
    throw std::invalid_argument("search dimensions must be nonnegative/positive");
  }
}

SearchDecision SearchGraph::search(
  const Position& root,
  Opponent opponent,
  double current_reply_seed,
  int elapsed_rounds,
  std::mt19937_64& random
) {
  const int cap = 4 * root.board.size * root.board.size;
  const auto root_candidates = candidates(
    root, opponent, current_reply_seed, elapsed_rounds, config_.root_search_width);
  for (int simulation = 0; simulation < config_.simulations; ++simulation) {
    Position position = root;
    std::vector<PathEntry> path;
    int rounds = elapsed_rounds;
    for (int depth = 0; depth < config_.tree_depth && position.consecutive_passes < 2 && rounds * 2 < cap; ++depth) {
      const double seed = depth == 0 ? current_reply_seed : random_seed(random);
      const auto options = depth == 0
        ? root_candidates
        : candidates(position, opponent, seed, rounds, config_.branch_width);
      const Candidate& selected = options[choose_candidate(options, edges_, config_.exploration, random)];
      const Branch& branch = selected.branches[sample_branch(selected, random)];
      path.push_back({.edge_key = branch.edge_key, .round = rounds});
      position = branch.after;
      ++rounds;
    }
    if (config_.rollout_depth > 0 && position.consecutive_passes < 2 && rounds * 2 < cap) {
      random_rollout(position, opponent, rounds, cap, config_.rollout_depth, random);
    }
    const bool terminal = position.consecutive_passes >= 2 || rounds * 2 >= cap;
    const Score score = score_board(position.board, opponent_komi(opponent));
    const auto reward = terminal_reward(score, opponent_name(opponent), root.board.size);
    const bool heuristic_leaf = !terminal && root.board.size > 5;
    const double leaf = heuristic_leaf ? heuristic_value(position.board, opponent) : score.black - score.white;
    const double won = heuristic_leaf
      ? 1.0 / (1.0 + std::exp(-leaf / 4.0))
      : static_cast<double>(reward.won);
    const double utility = !heuristic_leaf
      ? reward.training_power / std::max(rounds, 1)
      : leaf / static_cast<double>(root.board.size * root.board.size);
    for (const auto& visited : path) {
      auto found = edges_.find(visited.edge_key);
      if (found == edges_.end()) {
        if (edges_.size() >= config_.graph_capacity) continue;
        found = edges_.emplace(visited.edge_key, EdgeStatistics{}).first;
      }
      auto& stats = found->second;
      ++stats.visits;
      stats.wins += won;
      stats.utility_sum += utility;
      stats.terminal_power_sum += reward.training_power;
      stats.remaining_rounds_sum += std::max(rounds - visited.round, 1);
      stats.best_utility = std::max(stats.best_utility, utility);
    }
  }

  std::size_t best_index = 0;
  SelectionScore best_value{-1, -std::numeric_limits<double>::infinity()};
  SearchDecision decision;
  for (std::size_t index = 0; index < root_candidates.size(); ++index) {
    const Candidate& candidate = root_candidates[index];
    double visits = 0;
    double wins = 0;
    double utility = 0;
    for (const auto& branch : candidate.branches) {
      const auto* stats = find_stats(edges_, branch.edge_key);
      if (!stats || stats->visits == 0) {
        decision.targets.push_back({
          .move = candidate.move,
          .features = encode_candidate(root.board, candidate.move, branch.response, branch.after.board,
            config_.feature_extent, static_cast<int>(opponent)),
          .target = {
            .win_probability = 1.0 / (1.0 + std::exp(-candidate.prior * 4.0)),
            .terminal_power = 0,
            .remaining_turns = 1,
          },
          .mean_utility = candidate.prior,
          .visits = 1,
        });
        continue;
      }
      visits += branch.probability * stats->visits;
      wins += branch.probability * stats->wins / stats->visits;
      utility += branch.probability * stats->utility_sum / stats->visits;
      decision.targets.push_back({
        .move = candidate.move,
        .features = encode_candidate(root.board, candidate.move, branch.response, branch.after.board,
          config_.feature_extent, static_cast<int>(opponent)),
        .target = {
          .win_probability = stats->wins / stats->visits,
          .terminal_power = stats->terminal_power_sum / stats->visits,
          .remaining_turns = stats->remaining_rounds_sum / stats->visits,
        },
        .mean_utility = stats->utility_sum / stats->visits,
        .visits = stats->visits,
      });
    }
    const SelectionScore value{visits > 0 ? wins
      : 1.0 / (1.0 + std::exp(-candidate.prior * 4.0)),
      visits > 0 ? utility : candidate.prior};
    if (value.win > best_value.win || (value.win == best_value.win && value.utility > best_value.utility)) {
      best_value = value;
      best_index = index;
    }
  }
  decision.move = root_candidates[best_index].move;
  Position after_black = root;
  apply_to_position(after_black, decision.move, Stone::black);
  decision.known_replies = after_black.consecutive_passes >= 2
    ? ReplyForecast{.replies = {{.move = Move::pass_turn(), .probability = 1, .branch = ReplyBranch::pass}}, .exact = true}
    : legal_forecast(
      after_black, predict_opponent_replies(after_black, opponent, current_reply_seed));
  return decision;
}

}  // namespace bitburner::go
