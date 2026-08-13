#include "go/opponent.hpp"

#include "go/analysis.hpp"
#include "go/patterns.hpp"
#include "go/rng.hpp"
#include "go/rules.hpp"

#include <algorithm>
#include <array>
#include <cmath>
#include <cstddef>
#include <limits>
#include <optional>
#include <stdexcept>
#include <string>
#include <unordered_map>
#include <unordered_set>
#include <utility>
#include <vector>

namespace bitburner::go {
namespace {

struct MoveOption {
  Point point;
  int old_liberties{};
  int new_liberties{};
  bool creates_life{};
};

struct OptionSpace {
  Position position;
  Analysis analysis;
  std::vector<Point> legal;
  std::unordered_set<int> legal_set;
  std::vector<Point> available;
  std::vector<MoveOption> expansions;
  std::vector<MoveOption> growth_moves;
  std::vector<MoveOption> defenses;
  std::optional<MoveOption> surround;
  std::vector<MoveOption> eyes;
  std::optional<MoveOption> eye_block;
  std::vector<Point> patterns;
  std::vector<MoveOption> jumps;
  std::optional<MoveOption> corner;
  bool contested{};
  bool end_game{};
};

struct Options {
  std::optional<MoveOption> capture;
  std::optional<MoveOption> defend_capture;
  std::optional<MoveOption> eye_move;
  std::optional<MoveOption> eye_block;
  std::optional<MoveOption> pattern;
  std::optional<MoveOption> growth;
  std::optional<MoveOption> expansion;
  std::optional<MoveOption> jump;
  std::optional<MoveOption> defend;
  std::optional<MoveOption> surround;
  std::optional<MoveOption> corner;
  std::optional<MoveOption> random;
};

struct Choice { Point point; ReplyBranch branch; };

template <typename T>
std::optional<T> pick(const std::vector<T>& values, double roll) {
  if (values.empty()) return std::nullopt;
  const auto index = static_cast<std::size_t>(std::floor(roll * static_cast<double>(values.size())));
  return values.at(std::min(index, values.size() - 1));
}

int key(const Board& board, Point point) { return point.x * board.size + point.y; }

const Chain* chain_at(const Analysis& analysis, Point point) {
  if (point.x < 0 || point.y < 0 || point.x >= analysis.board.size || point.y >= analysis.board.size) return nullptr;
  const int index = analysis.chain_at[static_cast<std::size_t>(key(analysis.board, point))];
  return index < 0 ? nullptr : &analysis.chains[static_cast<std::size_t>(index)];
}

std::vector<Point> legal_moves_from_analysis(
  const Position& position,
  Stone player,
  const Analysis& analysis
) {
  const int size = position.board.size;
  const char own = static_cast<char>(player);
  const char enemy = static_cast<char>(player == Stone::black ? Stone::white : Stone::black);
  const std::string current = position.previous_hashes.empty() ? std::string{} : board_hash(position.board);
  const std::unordered_set<std::string> history(
    position.previous_hashes.begin(), position.previous_hashes.end());
  std::vector<Point> result;
  for (int x = 0; x < size; ++x) for (int y = 0; y < size; ++y) {
    if (at(position.board, x, y) != '.') continue;
    bool survives = false;
    bool captures = false;
    for (int direction = 0; direction < 4; ++direction) {
      const int nx = x + (direction == 1 ? 1 : direction == 3 ? -1 : 0);
      const int ny = y + (direction == 0 ? 1 : direction == 2 ? -1 : 0);
      if (nx < 0 || ny < 0 || nx >= size || ny >= size) continue;
      const char cell = at(position.board, nx, ny);
      if (cell == '.') {
        survives = true;
        continue;
      }
      const Chain* chain = chain_at(analysis, {nx, ny});
      if (!chain) continue;
      if (cell == own && chain->liberties.size() > 1) survives = true;
      else if (cell == enemy && chain->liberties.size() == 1) captures = true;
    }
    if (!survives && !captures) continue;
    const Point point{x, y};
    if (captures) {
      if (play_move(position.board, point, player, history)) result.push_back(point);
      continue;
    }
    bool repeated = false;
    const std::size_t changed = static_cast<std::size_t>(x * size + y);
    if (position.previous_hashes.size() > 4) {
      std::string next = current;
      next[changed] = own;
      repeated = history.contains(next);
      if (!repeated) result.push_back(point);
      continue;
    }
    for (const auto& previous : position.previous_hashes) {
      if (previous.size() != current.size() || previous[changed] != own) continue;
      bool equal = true;
      for (std::size_t index = 0; index < current.size(); ++index) {
        if (index != changed && previous[index] != current[index]) {
          equal = false;
          break;
        }
      }
      if (equal) {
        repeated = true;
        break;
      }
    }
    if (!repeated) result.push_back(point);
  }
  return result;
}

std::vector<MoveOption> expansion_moves(
  const Board& board,
  const Analysis& analysis,
  const std::vector<Point>& available
) {
  std::vector<Point> open;
  for (const auto point : available) {
    const auto neighbors = cardinal(board, point.x, point.y);
    if (neighbors.size() == 4 && std::all_of(neighbors.begin(), neighbors.end(), [&](Point neighbor) {
      return at(board, neighbor.x, neighbor.y) == '.';
    })) open.push_back(point);
  }
  const auto points = open.empty() ? disputed_moves(analysis, available, 1) : open;
  std::vector<MoveOption> result;
  for (const auto point : points) result.push_back({.point = point, .old_liberties = -1, .new_liberties = -1});
  return result;
}

std::vector<MoveOption> liberty_growth_moves(
  const Analysis& analysis,
  Stone player,
  const std::vector<Point>& available
) {
  std::vector<unsigned char> allowed(
    static_cast<std::size_t>(analysis.board.size * analysis.board.size));
  for (const auto point : available) allowed[static_cast<std::size_t>(key(analysis.board, point))] = 1;
  std::vector<MoveOption> result;
  for (const auto& chain : analysis.chains) {
    if (chain.color != static_cast<char>(player)) continue;
    for (const auto point : chain.liberties) {
      if (allowed[static_cast<std::size_t>(key(analysis.board, point))] == 0) continue;
      const Chain* weakest = weakest_neighbor_chain(analysis, point.x, point.y, player);
      const int old_count = weakest ? static_cast<int>(weakest->liberties.size()) : 99;
      const int new_count = static_cast<int>(effective_liberties(analysis, point.x, point.y, player).size());
      if (new_count > 1 && new_count >= old_count) {
        result.push_back({.point = point, .old_liberties = old_count, .new_liberties = new_count});
      }
    }
  }
  return result;
}

std::optional<MoveOption> maximum_growth(const std::vector<MoveOption>& moves, double roll) {
  if (moves.empty()) return std::nullopt;
  int maximum = std::numeric_limits<int>::min();
  for (const auto& move : moves) maximum = std::max(maximum, move.new_liberties - move.old_liberties);
  std::vector<MoveOption> best;
  for (const auto& move : moves) if (move.new_liberties - move.old_liberties == maximum) best.push_back(move);
  return pick(best, roll);
}

std::vector<MoveOption> defend_candidates(const std::vector<MoveOption>& moves) {
  std::vector<MoveOption> increases;
  int maximum = std::numeric_limits<int>::min();
  for (const auto& move : moves) if (move.old_liberties <= 1 && move.new_liberties > move.old_liberties) {
    increases.push_back(move);
    maximum = std::max(maximum, move.new_liberties - move.old_liberties);
  }
  std::vector<MoveOption> result;
  if (maximum < 1) return result;
  for (const auto& move : increases) if (move.new_liberties - move.old_liberties == maximum) result.push_back(move);
  return result;
}

std::optional<MoveOption> surround_move(
  const Analysis& analysis,
  Stone player,
  const std::vector<Point>& available,
  bool smart
) {
  const Stone enemy = player == Stone::black ? Stone::white : Stone::black;
  std::vector<unsigned char> allowed(
    static_cast<std::size_t>(analysis.board.size * analysis.board.size));
  for (const auto point : available) allowed[static_cast<std::size_t>(key(analysis.board, point))] = 1;
  std::optional<MoveOption> first_atari;
  std::optional<MoveOption> first_surround;
  for (const auto& chain : analysis.chains) if (chain.color == static_cast<char>(enemy)) {
    for (const auto point : chain.liberties) {
      if (allowed[static_cast<std::size_t>(key(analysis.board, point))] == 0) continue;
      const int effective = static_cast<int>(effective_liberties(analysis, point.x, point.y, player).size());
      const Chain* weakest = weakest_neighbor_chain(analysis, point.x, point.y, enemy);
      const int old_count = weakest ? static_cast<int>(weakest->liberties.size()) : 99;
      if (effective <= 2 && old_count > 2) continue;
      MoveOption move{.point = point, .old_liberties = old_count, .new_liberties = old_count - 1};
      if (old_count <= 1) return move;
      if (old_count == 2) {
        bool one_liberty_group = weakest != nullptr && !weakest->liberties.empty();
        int first_group = std::numeric_limits<int>::min();
        if (weakest) for (const auto liberty : weakest->liberties) {
          const Chain* group = chain_at(analysis, liberty);
          const int id = group ? group->id : -1;
          if (first_group == std::numeric_limits<int>::min()) first_group = id;
          else if (id != first_group) {
            one_liberty_group = false;
            break;
          }
        }
        if (effective >= 2 || (one_liberty_group && static_cast<int>(weakest->points.size()) > 3) || !smart) {
          if (!first_atari) first_atari = move;
        }
      } else if (effective >= 2 && !first_surround) {
        first_surround = move;
      }
    }
  }
  return first_atari ? first_atari : first_surround;
}

std::vector<MoveOption> eye_creation_moves(
  const Board& board,
  const Analysis& analysis,
  Stone player,
  const std::vector<Point>& available,
  int max_liberties = 99,
  bool stop_at_first_life = false
) {
  const auto current_by_chain = eyes_by_chain(analysis, player);
  int current_living = 0;
  int current_eye_count = 0;
  std::unordered_set<int> living;
  for (std::size_t index = 0; index < current_by_chain.size(); ++index) {
    if (!current_by_chain[index].empty()) ++current_eye_count;
    if (current_by_chain[index].size() >= 2) { ++current_living; living.insert(static_cast<int>(index)); }
  }
  std::vector<unsigned char> allowed(static_cast<std::size_t>(board.size * board.size));
  for (const auto point : available) allowed[static_cast<std::size_t>(key(board, point))] = 1;
  std::vector<Point> candidates;
  for (std::size_t index = 0; index < analysis.chains.size(); ++index) {
    const Chain& chain = analysis.chains[index];
    if (chain.color != static_cast<char>(player) || chain.points.size() <= 1
      || static_cast<int>(chain.liberties.size()) > max_liberties || living.contains(static_cast<int>(index))) continue;
    for (const auto point : chain.liberties) {
      if (allowed[static_cast<std::size_t>(key(board, point))] == 0) continue;
      const auto neighborhood = cardinal(board, point.x, point.y);
      const int friendly_or_edge = 4 - static_cast<int>(neighborhood.size())
        + static_cast<int>(std::count_if(neighborhood.begin(), neighborhood.end(), [&](Point neighbor) {
          return at(board, neighbor.x, neighbor.y) == static_cast<char>(player);
        }));
      const bool has_empty = std::any_of(neighborhood.begin(), neighborhood.end(), [&](Point neighbor) {
        return at(board, neighbor.x, neighbor.y) == '.';
      });
      if (friendly_or_edge >= 2 && has_empty) candidates.push_back(point);
    }
  }
  std::vector<MoveOption> result;
  std::unordered_map<int, std::pair<int, int>> outcomes;
  for (const auto point : candidates) {
    const int encoded_point = key(board, point);
    auto found = outcomes.find(encoded_point);
    if (found == outcomes.end()) {
      const auto new_eyes = all_eyes(analyze_board(evaluate_move(board, point, player)), player);
      const int new_living = static_cast<int>(std::count_if(new_eyes.begin(), new_eyes.end(), [](const auto& eyes) {
        return eyes.size() >= 2;
      }));
      const int new_eye_count = static_cast<int>(std::count_if(new_eyes.begin(), new_eyes.end(), [](const auto& eyes) {
        return !eyes.empty();
      }));
      found = outcomes.emplace(encoded_point, std::pair{new_living, new_eye_count}).first;
    }
    const auto [new_living, new_eye_count] = found->second;
    if (new_living > current_living || (new_eye_count > current_eye_count && new_living == current_living)) {
      result.push_back({.point = point, .creates_life = new_living > current_living});
      if (stop_at_first_life && new_living > current_living) break;
    }
  }
  std::stable_sort(result.begin(), result.end(), [](const MoveOption& left, const MoveOption& right) {
    return left.creates_life > right.creates_life;
  });
  return result;
}

std::optional<MoveOption> eye_block_move(
  const Board& board,
  const Analysis& analysis,
  Stone player,
  const std::vector<Point>& available
) {
  const Stone enemy = player == Stone::black ? Stone::white : Stone::black;
  const auto moves = eye_creation_moves(board, analysis, enemy, available, 5);
  std::vector<MoveOption> life;
  std::vector<MoveOption> eye;
  for (const auto& move : moves) (move.creates_life ? life : eye).push_back(move);
  if (life.size() == 1) return life.front();
  if (life.empty() && eye.size() == 1) return eye.front();
  return std::nullopt;
}

std::optional<MoveOption> corner_move(const Board& board) {
  const int edge = board.size - 1;
  const int inner = edge - 2;
  const std::array<std::array<int, 4>, 4> areas{{
    {{inner, inner, edge, edge}}, {{0, inner, 2, edge}}, {{0, 0, 2, 2}}, {{inner, 0, edge, 2}},
  }};
  const std::array<Point, 4> points{{{inner, inner}, {2, inner}, {2, 2}, {inner, 2}}};
  for (std::size_t index = 0; index < areas.size(); ++index) {
    int count = 0;
    bool empty = true;
    for (int x = areas[index][0]; x <= areas[index][2]; ++x) for (int y = areas[index][1]; y <= areas[index][3]; ++y) {
      const char cell = at(board, x, y);
      if (cell == '#') continue;
      ++count;
      empty = empty && cell == '.';
    }
    if (count >= 7 && empty) return MoveOption{.point = points[index]};
  }
  return std::nullopt;
}

OptionSpace prepare_option_space(const Position& position, bool smart) {
  OptionSpace space{.position = position, .analysis = analyze_board(position.board)};
  space.legal = legal_moves_from_analysis(position, Stone::white, space.analysis);
  for (const auto point : space.legal) space.legal_set.insert(key(position.board, point));
  space.available = disputed_territory(position, Stone::white, smart, space.analysis, space.legal);
  const auto contested = disputed_moves(space.analysis, space.available);
  space.contested = !contested.empty();
  space.end_game = !space.contested && position.consecutive_passes > 0;
  space.expansions = expansion_moves(position.board, space.analysis, space.available);
  space.growth_moves = liberty_growth_moves(space.analysis, Stone::white, space.available);
  space.defenses = defend_candidates(space.growth_moves);
  space.surround = surround_move(space.analysis, Stone::white, space.available, smart);
  if (!space.end_game) {
    space.eyes = eye_creation_moves(position.board, space.analysis, Stone::white, space.available, 99, true);
    space.eye_block = eye_block_move(position.board, space.analysis, Stone::white, space.available);
    space.patterns = pattern_moves(position.board, Stone::white, space.available, smart);
  }
  for (const auto& expansion : space.expansions) {
    const Point point = expansion.point;
    const std::array<Point, 4> distant{{{point.x, point.y + 2}, {point.x + 2, point.y}, {point.x, point.y - 2}, {point.x - 2, point.y}}};
    if (std::any_of(distant.begin(), distant.end(), [&](Point other) {
      return at(position.board, other.x, other.y) == 'O';
    })) space.jumps.push_back(expansion);
  }
  space.corner = corner_move(position.board);
  return space;
}

Options make_options(const OptionSpace& space, double option_roll, std::optional<MoveOption> defend) {
  Options result;
  if (space.surround && space.surround->new_liberties == 0) result.capture = space.surround;
  if (defend && defend->old_liberties == 1 && defend->new_liberties > 1) result.defend_capture = defend;
  if (!space.eyes.empty()) result.eye_move = space.eyes.front();
  result.eye_block = space.eye_block;
  if (const auto point = pick(space.patterns, option_roll)) result.pattern = MoveOption{.point = *point};
  if (!space.end_game) result.growth = maximum_growth(space.growth_moves, option_roll);
  result.expansion = pick(space.expansions, option_roll);
  result.jump = pick(space.jumps, option_roll);
  result.defend = defend;
  result.surround = space.surround;
  result.corner = space.corner;
  if (space.contested) if (const auto point = pick(space.available, option_roll)) result.random = MoveOption{.point = *point};
  return result;
}

std::optional<MoveOption> async_option(const std::optional<MoveOption>& option, ReplyWait& wait) {
  ++wait.cycle_waits_after_seed;
  return option;
}

std::optional<MoveOption> pattern_option(const Options& options, ReplyWait& wait, int size) {
  wait.fixed_sleep_ms_after_seed += size * 10;
  return options.pattern;
}

std::optional<Choice> illuminati(const Options& options, double roll, ReplyWait& wait, int size) {
  if (async_option(options.capture, wait)) {
    return Choice{async_option(options.capture, wait)->point, ReplyBranch::capture};
  }
  if (async_option(options.defend_capture, wait)) {
    return Choice{async_option(options.defend_capture, wait)->point, ReplyBranch::defend_capture};
  }
  if (options.eye_move) return Choice{options.eye_move->point, ReplyBranch::eye_move};
  if (options.surround && options.surround->new_liberties <= 1) return Choice{options.surround->point, ReplyBranch::surround};
  if (options.eye_block) return Choice{options.eye_block->point, ReplyBranch::eye_block};
  if (options.corner) return Choice{options.corner->point, ReplyBranch::corner};
  const int has_moves = static_cast<int>(options.eye_move.has_value()) + static_cast<int>(options.eye_block.has_value())
    + static_cast<int>(options.growth.has_value()) + static_cast<int>(options.defend.has_value())
    + static_cast<int>(options.surround.has_value());
  if (pattern_option(options, wait, size) && (roll > 0.25 || has_moves == 0)) {
    return Choice{pattern_option(options, wait, size)->point, ReplyBranch::pattern};
  }
  if (roll > 0.4 && options.jump) return Choice{options.jump->point, ReplyBranch::jump};
  if (roll < 0.6 && options.surround && options.surround->new_liberties <= 2) {
    return Choice{options.surround->point, ReplyBranch::surround};
  }
  return std::nullopt;
}

std::optional<Choice> priority(
  const Options& options,
  Opponent opponent,
  double roll,
  ReplyWait& wait,
  int size
) {
  if (opponent == Opponent::netburners) {
    if (roll < 0.2) return illuminati(options, roll, wait, size);
    if (roll < 0.4 && options.expansion) return Choice{options.expansion->point, ReplyBranch::expansion};
    if (roll < 0.6 && options.growth) return Choice{options.growth->point, ReplyBranch::growth};
    if (roll < 0.75 && options.random) return Choice{options.random->point, ReplyBranch::random};
    return std::nullopt;
  }
  if (opponent == Opponent::slum_snakes) {
    if (async_option(options.defend_capture, wait)) {
      return Choice{async_option(options.defend_capture, wait)->point, ReplyBranch::defend_capture};
    }
    if (roll < 0.2) return illuminati(options, roll, wait, size);
    if (roll < 0.6 && options.growth) return Choice{options.growth->point, ReplyBranch::growth};
    if (roll < 0.65 && options.random) return Choice{options.random->point, ReplyBranch::random};
    return std::nullopt;
  }
  if (opponent == Opponent::black_hand) {
    if (async_option(options.capture, wait)) {
      return Choice{async_option(options.capture, wait)->point, ReplyBranch::capture};
    }
    if (options.surround && options.surround->new_liberties <= 1) return Choice{options.surround->point, ReplyBranch::surround};
    if (async_option(options.defend_capture, wait)) {
      return Choice{async_option(options.defend_capture, wait)->point, ReplyBranch::defend_capture};
    }
    if (options.surround && options.surround->new_liberties <= 2) return Choice{options.surround->point, ReplyBranch::surround};
    if (roll < 0.3) return illuminati(options, roll, wait, size);
    if (roll < 0.75 && options.surround) return Choice{options.surround->point, ReplyBranch::surround};
    if (roll < 0.8 && options.random) return Choice{options.random->point, ReplyBranch::random};
    return std::nullopt;
  }
  if (opponent == Opponent::tetrads) {
    if (async_option(options.capture, wait)) return Choice{async_option(options.capture, wait)->point, ReplyBranch::capture};
    if (async_option(options.defend_capture, wait)) {
      return Choice{async_option(options.defend_capture, wait)->point, ReplyBranch::defend_capture};
    }
    if (pattern_option(options, wait, size)) return Choice{pattern_option(options, wait, size)->point, ReplyBranch::pattern};
    if (options.surround && options.surround->new_liberties <= 1) return Choice{options.surround->point, ReplyBranch::surround};
    return roll < 0.4 ? illuminati(options, roll, wait, size) : std::nullopt;
  }
  if (opponent == Opponent::daedalus) return roll < 0.9 ? illuminati(options, roll, wait, size) : std::nullopt;
  return illuminati(options, roll, wait, size);
}

WeightedReply reply_for(
  const Options& options,
  const OptionSpace& space,
  Opponent opponent,
  double faction_roll,
  double fallback_roll
) {
  ReplyWait wait;
  if (const auto first = priority(options, opponent, faction_roll, wait, space.position.board.size)) {
    ++wait.cycle_waits_after_seed;
    return {.move = Move::at(first->point.x, first->point.y), .branch = first->branch, .wait = wait};
  }
  std::vector<Choice> fallbacks;
  if (options.growth) fallbacks.push_back({options.growth->point, ReplyBranch::growth});
  if (options.surround) fallbacks.push_back({options.surround->point, ReplyBranch::surround});
  if (options.defend) fallbacks.push_back({options.defend->point, ReplyBranch::defend});
  if (options.expansion) fallbacks.push_back({options.expansion->point, ReplyBranch::expansion});
  if (pattern_option(options, wait, space.position.board.size)) fallbacks.push_back({options.pattern->point, ReplyBranch::pattern});
  if (options.eye_move) fallbacks.push_back({options.eye_move->point, ReplyBranch::eye_move});
  if (options.eye_block) fallbacks.push_back({options.eye_block->point, ReplyBranch::eye_block});
  fallbacks.erase(std::remove_if(fallbacks.begin(), fallbacks.end(), [&](const Choice& choice) {
    return !space.legal_set.contains(key(space.position.board, choice.point));
  }), fallbacks.end());
  const auto choice = pick(fallbacks, fallback_roll);
  wait.cycle_waits_after_seed += choice ? 2 : 1;
  if (!choice) return {.move = Move::pass_turn(), .branch = ReplyBranch::pass, .wait = wait};
  return {.move = Move::at(choice->point.x, choice->point.y), .branch = choice->branch, .wait = wait};
}

bool same_reply(const WeightedReply& left, const WeightedReply& right) {
  return left.move.pass == right.move.pass && left.move.point == right.move.point && left.branch == right.branch
    && left.wait.cycle_waits_after_seed == right.wait.cycle_waits_after_seed
    && left.wait.fixed_sleep_ms_after_seed == right.wait.fixed_sleep_ms_after_seed;
}

}  // namespace

std::string_view opponent_name(Opponent opponent) {
  switch (opponent) {
    case Opponent::netburners: return "Netburners";
    case Opponent::slum_snakes: return "Slum Snakes";
    case Opponent::black_hand: return "The Black Hand";
    case Opponent::tetrads: return "Tetrads";
    case Opponent::daedalus: return "Daedalus";
    case Opponent::illuminati: return "Illuminati";
    case Opponent::world_daemon: return "????????????";
  }
  throw std::invalid_argument("unknown opponent");
}

Opponent parse_opponent(std::string_view name) {
  for (const auto opponent : {Opponent::netburners, Opponent::slum_snakes, Opponent::black_hand,
    Opponent::tetrads, Opponent::daedalus, Opponent::illuminati, Opponent::world_daemon}) {
    if (opponent_name(opponent) == name) return opponent;
  }
  throw std::invalid_argument("unknown opponent " + std::string(name));
}

std::string_view branch_name(ReplyBranch branch) {
  switch (branch) {
    case ReplyBranch::capture: return "capture";
    case ReplyBranch::defend_capture: return "defendCapture";
    case ReplyBranch::eye_move: return "eyeMove";
    case ReplyBranch::surround: return "surround";
    case ReplyBranch::eye_block: return "eyeBlock";
    case ReplyBranch::corner: return "corner";
    case ReplyBranch::pattern: return "pattern";
    case ReplyBranch::jump: return "jump";
    case ReplyBranch::growth: return "growth";
    case ReplyBranch::defend: return "defend";
    case ReplyBranch::expansion: return "expansion";
    case ReplyBranch::random: return "random";
    case ReplyBranch::pass: return "pass";
  }
  throw std::invalid_argument("unknown branch");
}

ReplyForecast predict_opponent_replies(const Position& position, Opponent opponent, double total_playtime_ms) {
  const auto rolls = whrng(total_playtime_ms, 4);
  const bool smart = opponent == Opponent::netburners ? false
    : opponent == Opponent::slum_snakes ? rolls[0] < 0.3
    : opponent == Opponent::black_hand ? rolls[0] < 0.8
    : true;
  const OptionSpace space = prepare_option_space(position, smart);
  std::vector<std::optional<MoveOption>> defenses;
  if (space.defenses.empty()) defenses.push_back(std::nullopt);
  else for (const auto& defense : space.defenses) defenses.push_back(defense);
  ReplyForecast forecast;
  const double probability = 1.0 / static_cast<double>(defenses.size());
  for (const auto& defense : defenses) {
    WeightedReply reply = reply_for(make_options(space, rolls[1], defense), space, opponent, rolls[2], rolls[3]);
    reply.probability = probability;
    const auto duplicate = std::find_if(forecast.replies.begin(), forecast.replies.end(), [&](const WeightedReply& current) {
      return same_reply(current, reply);
    });
    if (duplicate == forecast.replies.end()) forecast.replies.push_back(reply);
    else duplicate->probability += probability;
  }
  // Upstream validates fallback moves, but not faction-priority moves. A
  // priority move can therefore very rarely be rejected by positional
  // superko. Bitburner logs the attempted coordinate and advances the player
  // without changing the board or counting a pass, so preserve the coordinate
  // and mark that exact no-op instead of crashing or reweighting the forecast.
  const std::unordered_set<std::string> history(
    position.previous_hashes.begin(), position.previous_hashes.end());
  for (auto& reply : forecast.replies) {
    if (!reply.move.pass
      && !play_move(position.board, reply.move.point, Stone::white, history).has_value()) {
      reply.move.no_op = true;
    }
  }
  std::unordered_set<int> moves;
  for (const auto& reply : forecast.replies) moves.insert(reply.move.pass ? -1 : key(position.board, reply.move.point));
  forecast.exact = moves.size() <= 1;
  return forecast;
}

}  // namespace bitburner::go
