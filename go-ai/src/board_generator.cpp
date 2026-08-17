#include "go/board_generator.hpp"

#include "go/analysis.hpp"
#include "go/rng.hpp"
#include "go/rules.hpp"

#include <algorithm>
#include <array>
#include <cmath>
#include <cstddef>
#include <optional>
#include <stdexcept>
#include <string>
#include <utility>
#include <vector>

namespace bitburner::go {
namespace {

class WhRandom {
 public:
  explicit WhRandom(double seed) : values_(whrng(seed, 512)) {}
  int integer(double lower, double upper) {
    if (next_ >= values_.size()) throw std::runtime_error("obstacle RNG buffer exhausted");
    return static_cast<int>(lower + std::floor((upper - lower + 1.0) * values_[next_++]));
  }
 private:
  std::vector<double> values_;
  std::size_t next_{};
};

class LcgRandom {
 public:
  explicit LcgRandom(std::uint32_t state) : state_(state) {}
  double random() {
    state_ = state_ * 1'664'525U + 1'013'904'223U;
    return static_cast<double>(state_) / 4'294'967'296.0;
  }
 private:
  std::uint32_t state_;
};

int scale(int size) {
  constexpr std::array<int, 5> sizes{{5, 7, 9, 13, 19}};
  const auto found = std::find(sizes.begin(), sizes.end(), size);
  if (found == sizes.end()) throw std::invalid_argument("unsupported board size");
  return static_cast<int>(std::distance(sizes.begin(), found));
}

Board rotate(const Board& board) {
  Board result{.size = board.size, .columns = std::vector<std::string>(static_cast<std::size_t>(board.size), std::string(static_cast<std::size_t>(board.size), '#'))};
  for (int x = 0; x < board.size; ++x) for (int y = 0; y < board.size; ++y) {
    result.columns[static_cast<std::size_t>(x)][static_cast<std::size_t>(y)] = at(board, board.size - 1 - y, x);
  }
  return result;
}

Board rotate_n(Board board, int count) {
  for (int index = 0; index < count; ++index) board = rotate(board);
  return board;
}

void add_dead_corner(Board& board, WhRandom& random, int size, bool stale_after_half_turn = false) {
  int current_size = size;
  for (int x = 0; x < size && x < current_size; ++x) {
    if (random.integer(0, 1) != 0) --current_size;
    for (int y = 0; y < board.size && y < current_size; ++y) {
      const int target_x = stale_after_half_turn ? board.size - 1 - x : x;
      const int target_y = stale_after_half_turn ? board.size - 1 - y : y;
      if (at(board, x, y) != '#') {
        board.columns[static_cast<std::size_t>(target_x)][static_cast<std::size_t>(target_y)] = '#';
      }
    }
  }
}

Board random_rotation(Board board, WhRandom& random) { return rotate_n(std::move(board), random.integer(0, 3)); }

Board add_dead_corners(Board board, WhRandom& random) {
  const int size = scale(board.size) + 1;
  add_dead_corner(board, random, size);
  if (random.integer(0, 3) == 0) {
    board = rotate_n(std::move(board), 2);
    // PointState coordinates are reset only after all obstacles. The second
    // corner therefore writes through coordinates left stale by the 180° turn.
    add_dead_corner(board, random, size - 2, true);
  }
  return random_rotation(std::move(board), random);
}

Board add_center_break(Board board, WhRandom& random) {
  const int maximum_offset = scale(board.size);
  const int x = random.integer(0, maximum_offset * 2) - maximum_offset + board.size / 2;
  const int length = random.integer(1, std::floor(board.size / 2.0 - 1.0));
  for (int y = 0; y < length; ++y) board.columns[static_cast<std::size_t>(x)][static_cast<std::size_t>(y)] = '#';
  return random_rotation(std::move(board), random);
}

Board remove_rows(Board board, WhRandom& random) {
  const int count = std::max(random.integer(-2, scale(board.size)), 1);
  for (int x = 0; x < count; ++x) std::fill(board.columns[static_cast<std::size_t>(x)].begin(), board.columns[static_cast<std::size_t>(x)].end(), '#');
  return rotate_n(std::move(board), 3);
}

Board add_edge_nodes(Board board, WhRandom& random, int maximum) {
  for (int edge = 0; edge < 4; ++edge) {
    const int count = random.integer(0, maximum);
    for (int index = 0; index < count; ++index) {
      const int y = std::max(random.integer(-2, board.size - 1), 0);
      board.columns.front()[static_cast<std::size_t>(y)] = '#';
    }
    board = rotate(board);
  }
  return board;
}

void remove_islands(Board& board) {
  const Analysis analysis = analyze_board(board);
  for (const auto& chain : analysis.chains) if (chain.color == '.' && chain.points.size() <= 2) {
    for (const auto point : chain.points) board.columns[static_cast<std::size_t>(point.x)][static_cast<std::size_t>(point.y)] = '#';
  }
}

std::vector<Point> expansion_points(const Board& board) {
  std::vector<Point> result;
  for (int x = 0; x < board.size; ++x) for (int y = 0; y < board.size; ++y) {
    if (at(board, x, y) != '.') continue;
    const auto neighbors = cardinal(board, x, y);
    if (neighbors.size() == 4 && std::all_of(neighbors.begin(), neighbors.end(), [&](Point point) {
      return at(board, point.x, point.y) == '.';
    })) result.push_back({x, y});
  }
  return result;
}

int handicap(int size, Opponent opponent) {
  if (opponent != Opponent::illuminati && opponent != Opponent::world_daemon) return 0;
  switch (size) {
    case 5: return 1;
    case 7: return 3;
    case 9: return 4;
    case 13: return 5;
    case 19: return 7;
    default: return 0;
  }
}

void apply_handicap(Board& board, int count, LcgRandom& random) {
  if (count <= 0) return;
  int available = 0;
  for (const auto& column : board.columns) available += static_cast<int>(std::count(column.begin(), column.end(), '.'));
  if (available < 26 && at(board, 2, 2) != '#' && random.random() < 0.2) {
    board.columns[2][2] = 'O';
    return;
  }
  auto options = expansion_points(board);
  for (int index = 0; index < count && !options.empty(); ++index) {
    const auto selected = static_cast<std::size_t>(std::floor(random.random() * static_cast<double>(options.size())));
    const Point point = options[selected];
    board.columns[static_cast<std::size_t>(point.x)][static_cast<std::size_t>(point.y)] = 'O';
    options.erase(options.begin() + static_cast<std::ptrdiff_t>(selected));
  }
}

}  // namespace

StartingBoardFamily starting_board_family(int requested_size, Opponent opponent, double obstacle_seed) {
  if (opponent == Opponent::world_daemon) {
    const std::array<std::string, 19> shape{{
      "########...########", "######.#...#.######", "###.#..#...#..#.###",
      ".#..#..#...#..#..#.", ".#.....#...#.....#.", "...................",
      "...................", "...................", "...................",
      ".....##.....##.....", "....###.....###....", "....##.......##....",
      "....#.........#....", ".........#.........", "#........#........#",
      "##.......#.......##", "##.......#.......##", "###.............###",
      "####...........####",
    }};
    Board board{.size = 19, .columns = std::vector<std::string>(shape.begin(), shape.end())};
    board = rotate(board);
    std::vector<Point> daemon_points = expansion_points(board);
    const bool daemon_absent = handicap(19, opponent) > 0 && daemon_points.empty();
    return {
      .board_before_handicap = board,
      .handicap = handicap(19, opponent),
      .possible_handicap_points = std::move(daemon_points),
      .handicap_may_be_absent = daemon_absent,
    };
  }
  Board board{.size = requested_size, .columns = std::vector<std::string>(static_cast<std::size_t>(requested_size), std::string(static_cast<std::size_t>(requested_size), '.'))};
  WhRandom random(obstacle_seed);
  const bool remove_corner = random.integer(0, 4) == 0;
  const bool remove_row = !remove_corner && random.integer(0, 4) == 0;
  // Upstream keeps the raw 0..3 result of `a && b && random(0, 3)`.
  // Its truthiness decides whether to add the center break, while its numeric
  // value is also included in obstacleTypeCount. Collapsing this to bool makes
  // rolls 2 and 3 generate too many edge obstacles.
  const int center_break_roll = !remove_corner && !remove_row ? random.integer(0, 3) : 0;
  const int obstacle_types = static_cast<int>(remove_corner) + static_cast<int>(remove_row) + center_break_roll;
  const int edge_dead = random.integer(1, (scale(board.size) + 2 - obstacle_types) * 1.5);
  if (remove_corner) board = add_dead_corners(std::move(board), random);
  if (center_break_roll != 0) board = add_center_break(std::move(board), random);
  board = random_rotation(std::move(board), random);
  if (remove_row) board = remove_rows(std::move(board), random);
  board = add_edge_nodes(std::move(board), random, edge_dead);
  if (board_hash(board).find('#') == std::string::npos) board.columns[0][0] = '#';
  remove_islands(board);
  std::vector<Point> points = expansion_points(board);
  // The unseeded placement loop only draws from the expansion list. When that
  // list is empty, the 20% center shortcut (added below when reachable) is the
  // sole way a stone appears, so the no-stone outcome is possible too.
  const bool may_be_absent = handicap(board.size, opponent) > 0 && points.empty();
  int available = 0;
  for (const auto& column : board.columns) available += static_cast<int>(std::count(column.begin(), column.end(), '.'));
  if (requested_size == 5 && available < 26 && at(board, 2, 2) != '#'
    && std::find(points.begin(), points.end(), Point{2, 2}) == points.end()) points.push_back({2, 2});
  return {
    .board_before_handicap = board,
    .handicap = handicap(board.size, opponent),
    .possible_handicap_points = std::move(points),
    .handicap_may_be_absent = may_be_absent,
  };
}

Board initial_board(int requested_size, Opponent opponent, double obstacle_seed, std::uint32_t handicap_seed) {
  auto family = starting_board_family(requested_size, opponent, obstacle_seed);
  Board board = std::move(family.board_before_handicap);
  LcgRandom unseeded(handicap_seed);
  apply_handicap(board, family.handicap, unseeded);
  return board;
}

std::vector<StartingBoardVariant> starting_board_variants(const StartingBoardFamily& family) {
  if (family.handicap > 1 && !family.possible_handicap_points.empty()) {
    throw std::invalid_argument("starting_board_variants supports at most one handicap stone");
  }
  std::vector<StartingBoardVariant> result;
  std::vector<std::string> seen;
  const auto add = [&](Board board, std::optional<Point> point) {
    std::string hash = board_hash(board);
    if (std::find(seen.begin(), seen.end(), hash) != seen.end()) return;
    seen.push_back(std::move(hash));
    result.push_back({std::move(board), point});
  };
  if (family.handicap > 0) {
    for (const Point point : family.possible_handicap_points) {
      Board board = family.board_before_handicap;
      board.columns[static_cast<std::size_t>(point.x)][static_cast<std::size_t>(point.y)] = 'O';
      add(std::move(board), point);
    }
  }
  if (family.handicap <= 0 || family.possible_handicap_points.empty()
    || family.handicap_may_be_absent) {
    add(family.board_before_handicap, std::nullopt);
  }
  return result;
}

}  // namespace bitburner::go
