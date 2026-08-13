#include "go/analysis.hpp"

#include "go/rules.hpp"

#include <algorithm>
#include <array>
#include <cstddef>
#include <limits>
#include <unordered_set>

namespace bitburner::go {
namespace {

int encoded(const Board& board, Point point) { return point.x * board.size + point.y; }

const Chain* chain_at(const Analysis& analysis, Point point) {
  if (point.x < 0 || point.y < 0 || point.x >= analysis.board.size || point.y >= analysis.board.size) return nullptr;
  const int index = analysis.chain_at[static_cast<std::size_t>(encoded(analysis.board, point))];
  return index < 0 ? nullptr : &analysis.chains[static_cast<std::size_t>(index)];
}

struct Spread { int north; int east; int south; int west; };

Spread spread(const Chain& chain) {
  Spread result{chain.points.front().y, chain.points.front().x, chain.points.front().y, chain.points.front().x};
  for (const auto point : chain.points) {
    result.north = std::max(result.north, point.y);
    result.east = std::max(result.east, point.x);
    result.south = std::min(result.south, point.y);
    result.west = std::min(result.west, point.x);
  }
  return result;
}

const std::vector<int>& neighboring_chain(const Analysis& analysis, int chain_index) {
  const auto index = static_cast<std::size_t>(chain_index);
  if (analysis.neighbor_ready[index] == 0) {
    analysis.neighbor_cache[index] = neighboring_chains(analysis, analysis.chains[index].points);
    analysis.neighbor_ready[index] = 1;
  }
  return analysis.neighbor_cache[index];
}

bool fully_encircles(
  const Analysis& analysis,
  const Chain& candidate,
  const std::vector<int>& neighbors,
  std::size_t kept_index
) {
  const int size = analysis.board.size;
  const int area = size * size;
  std::vector<unsigned char> removed(static_cast<std::size_t>(area));
  for (std::size_t index = 0; index < neighbors.size(); ++index) {
    if (index == kept_index) continue;
    for (const auto point : analysis.chains[static_cast<std::size_t>(neighbors[index])].points) {
      removed[static_cast<std::size_t>(encoded(analysis.board, point))] = 1;
    }
  }
  std::vector<unsigned char> expanded(static_cast<std::size_t>(area));
  std::vector<int> stack;
  stack.reserve(static_cast<std::size_t>(area));
  const int start = encoded(analysis.board, candidate.points.front());
  expanded[static_cast<std::size_t>(start)] = 1;
  stack.push_back(start);
  while (!stack.empty()) {
    const int value = stack.back();
    stack.pop_back();
    const int x = value / size;
    const int y = value % size;
    for (int direction = 0; direction < 4; ++direction) {
      const int nx = x + (direction == 1 ? 1 : direction == 3 ? -1 : 0);
      const int ny = y + (direction == 0 ? 1 : direction == 2 ? -1 : 0);
      if (nx < 0 || ny < 0 || nx >= size || ny >= size) continue;
      const int next = nx * size + ny;
      if (expanded[static_cast<std::size_t>(next)] != 0) continue;
      if (at(analysis.board, nx, ny) != '.' && removed[static_cast<std::size_t>(next)] == 0) continue;
      expanded[static_cast<std::size_t>(next)] = 1;
      stack.push_back(next);
    }
  }
  std::vector<unsigned char> found(analysis.chains.size());
  int count = 0;
  for (int value = 0; value < area; ++value) {
    if (expanded[static_cast<std::size_t>(value)] == 0) continue;
    const int x = value / size;
    const int y = value % size;
    for (int direction = 0; direction < 4; ++direction) {
      const int nx = x + (direction == 1 ? 1 : direction == 3 ? -1 : 0);
      const int ny = y + (direction == 0 ? 1 : direction == 2 ? -1 : 0);
      if (nx < 0 || ny < 0 || nx >= size || ny >= size) continue;
      const int next = nx * size + ny;
      if (expanded[static_cast<std::size_t>(next)] != 0) continue;
      const int chain = analysis.chain_at[static_cast<std::size_t>(next)];
      if (chain < 0 || analysis.chains[static_cast<std::size_t>(chain)].color == '.'
        || found[static_cast<std::size_t>(chain)] != 0) continue;
      found[static_cast<std::size_t>(chain)] = 1;
      if (++count > 1) return false;
    }
  }
  return count == 1;
}

}  // namespace

std::vector<Point> cardinal(const Board& board, int x, int y) {
  const std::array<Point, 4> ordered{{{x, y + 1}, {x + 1, y}, {x, y - 1}, {x - 1, y}}};
  std::vector<Point> result;
  result.reserve(4);
  for (const auto point : ordered) if (at(board, point.x, point.y) != '#') result.push_back(point);
  return result;
}

Analysis analyze_board(const Board& board) {
  const int area = board.size * board.size;
  Analysis result{.board = board, .chain_at = std::vector<int>(static_cast<std::size_t>(area), -1)};
  std::vector<unsigned char> assigned(static_cast<std::size_t>(area));
  std::vector<int> liberty_mark(static_cast<std::size_t>(area));
  std::vector<int> stack;
  std::vector<int> discovered;
  int mark = 0;
  for (int x = 0; x < board.size; ++x) for (int y = 0; y < board.size; ++y) {
    const int start = x * board.size + y;
    const char color = at(board, x, y);
    if (color == '#' || assigned[static_cast<std::size_t>(start)] != 0) continue;
    discovered.clear();
    stack.clear();
    stack.push_back(start);
    assigned[static_cast<std::size_t>(start)] = 1;
    discovered.push_back(start);
    while (!stack.empty()) {
      const int value = stack.back();
      stack.pop_back();
      const int px = value / board.size;
      const int py = value % board.size;
      for (int direction = 0; direction < 4; ++direction) {
        const int nx = px + (direction == 1 ? 1 : direction == 3 ? -1 : 0);
        const int ny = py + (direction == 0 ? 1 : direction == 2 ? -1 : 0);
        if (nx < 0 || ny < 0 || nx >= board.size || ny >= board.size) continue;
        const int next = nx * board.size + ny;
        if (assigned[static_cast<std::size_t>(next)] == 0 && at(board, nx, ny) == color) {
          assigned[static_cast<std::size_t>(next)] = 1;
          discovered.push_back(next);
          stack.push_back(next);
        }
      }
    }
    std::vector<int> sorted = discovered;
    std::sort(sorted.begin(), sorted.end());
    Chain chain{.id = start, .color = color};
    for (const int value : sorted) chain.points.push_back({value / board.size, value % board.size});
    if (color != '.') {
      ++mark;
      for (const int value : discovered) {
        const int px = value / board.size;
        const int py = value % board.size;
        for (int direction = 0; direction < 4; ++direction) {
          const int nx = px + (direction == 1 ? 1 : direction == 3 ? -1 : 0);
          const int ny = py + (direction == 0 ? 1 : direction == 2 ? -1 : 0);
          if (nx < 0 || ny < 0 || nx >= board.size || ny >= board.size
            || at(board, nx, ny) != '.') continue;
          const int next = nx * board.size + ny;
          if (liberty_mark[static_cast<std::size_t>(next)] == mark) continue;
          liberty_mark[static_cast<std::size_t>(next)] = mark;
          chain.liberties.push_back({nx, ny});
        }
      }
    }
    const int chain_index = static_cast<int>(result.chains.size());
    result.chains.push_back(std::move(chain));
    for (const auto point : result.chains.back().points) {
      result.chain_at[static_cast<std::size_t>(encoded(board, point))] = chain_index;
    }
  }
  result.neighbor_cache.resize(result.chains.size());
  result.neighbor_ready.resize(result.chains.size());
  return result;
}

std::vector<int> neighboring_chains(const Analysis& analysis, const std::vector<Point>& points) {
  const std::size_t area = static_cast<std::size_t>(analysis.board.size * analysis.board.size);
  std::vector<unsigned char> own(area);
  for (const auto point : points) own[static_cast<std::size_t>(encoded(analysis.board, point))] = 1;
  std::vector<unsigned char> found(analysis.chains.size());
  std::vector<int> result;
  for (const auto point : points) for (int direction = 0; direction < 4; ++direction) {
    const int nx = point.x + (direction == 1 ? 1 : direction == 3 ? -1 : 0);
    const int ny = point.y + (direction == 0 ? 1 : direction == 2 ? -1 : 0);
    if (nx < 0 || ny < 0 || nx >= analysis.board.size || ny >= analysis.board.size) continue;
    const int value = nx * analysis.board.size + ny;
    if (own[static_cast<std::size_t>(value)] != 0 || at(analysis.board, nx, ny) == '.') continue;
    const int index = analysis.chain_at[static_cast<std::size_t>(value)];
    if (index < 0 || found[static_cast<std::size_t>(index)] != 0) continue;
    found[static_cast<std::size_t>(index)] = 1;
    result.push_back(index);
  }
  return result;
}

std::vector<Point> effective_liberties(const Analysis& analysis, int x, int y, Stone player) {
  const char own = static_cast<char>(player);
  std::vector<unsigned char> seen(
    static_cast<std::size_t>(analysis.board.size * analysis.board.size));
  std::vector<Point> result;
  std::array<const Chain*, 4> allied{};
  int allied_count = 0;
  for (int direction = 0; direction < 4; ++direction) {
    const int nx = x + (direction == 1 ? 1 : direction == 3 ? -1 : 0);
    const int ny = y + (direction == 0 ? 1 : direction == 2 ? -1 : 0);
    if (nx < 0 || ny < 0 || nx >= analysis.board.size || ny >= analysis.board.size) continue;
    const char cell = at(analysis.board, nx, ny);
    if (cell == '.') {
      const int value = nx * analysis.board.size + ny;
      if (seen[static_cast<std::size_t>(value)] == 0) {
        seen[static_cast<std::size_t>(value)] = 1;
        result.push_back({nx, ny});
      }
    } else if (cell == own) {
      allied[static_cast<std::size_t>(allied_count++)] = chain_at(analysis, {nx, ny});
    }
  }
  for (int index = 0; index < allied_count; ++index) if (allied[static_cast<std::size_t>(index)]) {
    for (const auto point : allied[static_cast<std::size_t>(index)]->liberties) {
      const int value = encoded(analysis.board, point);
      if ((point.x == x && point.y == y) || seen[static_cast<std::size_t>(value)] != 0) continue;
      seen[static_cast<std::size_t>(value)] = 1;
      result.push_back(point);
    }
  }
  return result;
}

const Chain* weakest_neighbor_chain(const Analysis& analysis, int x, int y, Stone player) {
  const Chain* weakest = nullptr;
  for (int direction = 0; direction < 4; ++direction) {
    const int nx = x + (direction == 1 ? 1 : direction == 3 ? -1 : 0);
    const int ny = y + (direction == 0 ? 1 : direction == 2 ? -1 : 0);
    if (nx < 0 || ny < 0 || nx >= analysis.board.size || ny >= analysis.board.size
      || at(analysis.board, nx, ny) != static_cast<char>(player)) continue;
    const Chain* chain = chain_at(analysis, {nx, ny});
    if (chain && (!weakest || chain->liberties.size() < weakest->liberties.size())) weakest = chain;
  }
  return weakest;
}

std::vector<EyeCandidate> potential_eyes(const Analysis& analysis, Stone player, std::optional<int> requested_max_size) {
  int node_count = 0;
  for (const auto& column : analysis.board.columns) {
    node_count += static_cast<int>(std::count_if(column.begin(), column.end(), [](char cell) { return cell != '#'; }));
  }
  const int max_size = requested_max_size.value_or(std::min(static_cast<int>(node_count * 0.4), 11));
  std::vector<EyeCandidate> result;
  for (std::size_t index = 0; index < analysis.chains.size(); ++index) {
    const Chain& chain = analysis.chains[index];
    if (chain.color != '.' || static_cast<int>(chain.points.size()) > max_size) continue;
    const auto& neighbors = neighboring_chain(analysis, static_cast<int>(index));
    const bool has_white = std::any_of(neighbors.begin(), neighbors.end(), [&](int neighbor) {
      return analysis.chains[static_cast<std::size_t>(neighbor)].color == 'O';
    });
    const bool has_black = std::any_of(neighbors.begin(), neighbors.end(), [&](int neighbor) {
      return analysis.chains[static_cast<std::size_t>(neighbor)].color == 'X';
    });
    if (player == Stone::white ? has_white && !has_black : has_black && !has_white) {
      result.push_back({.chain = static_cast<int>(index), .neighbors = neighbors});
    }
  }
  return result;
}

std::vector<std::vector<int>> eyes_by_chain(const Analysis& analysis, Stone player) {
  const int board_max = analysis.board.size - 1;
  std::vector<std::vector<int>> result(analysis.chains.size());
  for (const auto& candidate : potential_eyes(analysis, player)) {
    if (candidate.neighbors.empty()) continue;
    std::vector<int> encircling;
    if (candidate.neighbors.size() == 1) {
      encircling = candidate.neighbors;
    } else {
      const Spread candidate_spread = spread(analysis.chains[static_cast<std::size_t>(candidate.chain)]);
      for (std::size_t index = 0; index < candidate.neighbors.size(); ++index) {
        const int neighbor_index = candidate.neighbors[index];
        const Spread neighbor_spread = spread(analysis.chains[static_cast<std::size_t>(neighbor_index)]);
        if (!(neighbor_spread.north > candidate_spread.north || (candidate_spread.north == board_max && neighbor_spread.north == board_max))
          || !(neighbor_spread.east > candidate_spread.east || (candidate_spread.east == board_max && neighbor_spread.east == board_max))
          || !(neighbor_spread.south < candidate_spread.south || (candidate_spread.south == 0 && neighbor_spread.south == 0))
          || !(neighbor_spread.west < candidate_spread.west || (candidate_spread.west == 0 && neighbor_spread.west == 0))) continue;
        if (fully_encircles(
          analysis,
          analysis.chains[static_cast<std::size_t>(candidate.chain)],
          candidate.neighbors,
          index
        )) encircling.push_back(neighbor_index);
      }
    }
    for (const int neighbor : encircling) result[static_cast<std::size_t>(neighbor)].push_back(candidate.chain);
  }
  return result;
}

std::vector<std::vector<int>> all_eyes(const Analysis& analysis, Stone player) {
  std::vector<std::vector<int>> result;
  for (auto& eyes : eyes_by_chain(analysis, player)) if (!eyes.empty()) result.push_back(std::move(eyes));
  return result;
}

std::vector<Point> disputed_territory(
  const Position& position,
  Stone player,
  bool exclude_friendly_eyes,
  const Analysis& analysis,
  const std::vector<Point>& legal
) {
  const std::size_t area = static_cast<std::size_t>(position.board.size * position.board.size);
  std::vector<Point> valid = legal;
  if (exclude_friendly_eyes) {
    std::vector<unsigned char> friendly(area);
    for (const auto& eyes : all_eyes(analysis, player)) if (eyes.size() >= 2) {
      for (const int eye : eyes) for (const auto point : analysis.chains[static_cast<std::size_t>(eye)].points) {
        friendly[static_cast<std::size_t>(encoded(position.board, point))] = 1;
      }
    }
    valid.erase(std::remove_if(valid.begin(), valid.end(), [&](Point point) {
      return friendly[static_cast<std::size_t>(encoded(position.board, point))] != 0;
    }), valid.end());
  }
  const Stone opponent = player == Stone::black ? Stone::white : Stone::black;
  const auto enemy_spaces = potential_eyes(analysis, opponent);
  std::vector<unsigned char> inside(area);
  std::vector<unsigned char> playable(area);
  for (const auto& space : enemy_spaces) {
    const Chain& empty = analysis.chains[static_cast<std::size_t>(space.chain)];
    std::vector<unsigned char> space_points(area);
    for (const auto point : empty.points) {
      const auto index = static_cast<std::size_t>(encoded(position.board, point));
      inside[index] = 1;
      space_points[index] = 1;
    }
    for (const int border_index : space.neighbors) {
      const Chain& border = analysis.chains[static_cast<std::size_t>(border_index)];
      if (border.liberties.size() > 4) continue;
      const auto& neighbors = neighboring_chain(analysis, border_index);
      if (std::none_of(neighbors.begin(), neighbors.end(), [&](int index) {
        return analysis.chains[static_cast<std::size_t>(index)].color == static_cast<char>(player);
      })) continue;
      std::vector<Point> liberties_inside;
      for (const auto liberty : border.liberties) {
        if (space_points[static_cast<std::size_t>(encoded(position.board, liberty))] != 0) {
          liberties_inside.push_back(liberty);
        }
      }
      if (liberties_inside.size() != border.liberties.size()) continue;
      for (const auto liberty : liberties_inside) {
        playable[static_cast<std::size_t>(encoded(position.board, liberty))] = 1;
      }
    }
  }
  valid.erase(std::remove_if(valid.begin(), valid.end(), [&](Point point) {
    const auto index = static_cast<std::size_t>(encoded(position.board, point));
    return inside[index] != 0 && playable[index] == 0;
  }), valid.end());
  return valid;
}

std::vector<Point> disputed_moves(const Analysis& analysis, const std::vector<Point>& available, int max_chain_size) {
  std::vector<Point> result;
  // Every point in an empty chain has the same neighboring-chain verdict.
  // Cache it by chain index instead of walking the same region once per point.
  std::vector<signed char> disputed(analysis.chains.size(), -1);
  for (const auto point : available) {
    const int chain_index = analysis.chain_at[static_cast<std::size_t>(encoded(analysis.board, point))];
    if (chain_index < 0) continue;
    const Chain& chain = analysis.chains[static_cast<std::size_t>(chain_index)];
    if (static_cast<int>(chain.points.size()) > max_chain_size) continue;
    auto& verdict = disputed[static_cast<std::size_t>(chain_index)];
    if (verdict < 0) {
      const auto& neighbors = neighboring_chain(analysis, chain_index);
      bool white = false;
      bool black = false;
      for (const int index : neighbors) {
        const Chain& neighbor = analysis.chains[static_cast<std::size_t>(index)];
        if (static_cast<int>(neighbor.points.size()) > max_chain_size) continue;
        white = white || neighbor.color == 'O';
        black = black || neighbor.color == 'X';
      }
      verdict = white && black ? 1 : 0;
    }
    if (verdict > 0) result.push_back(point);
  }
  return result;
}

}  // namespace bitburner::go
