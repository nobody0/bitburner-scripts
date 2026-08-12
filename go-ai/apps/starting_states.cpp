#include "go/board_generator.hpp"
#include "go/rules.hpp"

#include <algorithm>
#include <cstdint>
#include <cstdlib>
#include <iostream>
#include <stdexcept>
#include <string>
#include <unordered_set>

namespace {

using namespace bitburner::go;

std::uint64_t choose(int n, int k) {
  if (k < 0 || k > n) return 0;
  k = std::min(k, n - k);
  std::uint64_t value = 1;
  for (int index = 1; index <= k; ++index) value = value * static_cast<std::uint64_t>(n - k + index) / static_cast<std::uint64_t>(index);
  return value;
}

std::string with_white(const Board& board, Point point) {
  Board result = board;
  result.columns[static_cast<std::size_t>(point.x)][static_cast<std::size_t>(point.y)] = 'O';
  return board_hash(result);
}

}  // namespace

int main() {
  try {
    // WHRNG repeats every 30,000 seconds; engine time advances in 200 ms ticks.
    constexpr int seed_phases = 150'000;
    std::unordered_set<std::string> obstacle_boards;
    std::unordered_set<std::string> illuminati_boards;
    std::size_t largest_handicap_choice = 0;
    for (int tick = 0; tick < seed_phases; ++tick) {
      const double seed = static_cast<double>(tick * 200);
      const auto ordinary = starting_board_family(5, Opponent::netburners, seed);
      obstacle_boards.insert(board_hash(ordinary.board_before_handicap));
      const auto illuminati = starting_board_family(5, Opponent::illuminati, seed);
      largest_handicap_choice = std::max(largest_handicap_choice, illuminati.possible_handicap_points.size());
      if (illuminati.possible_handicap_points.empty()) {
        illuminati_boards.insert(board_hash(illuminati.board_before_handicap));
      } else {
        for (const auto point : illuminati.possible_handicap_points) {
          illuminati_boards.insert(with_white(illuminati.board_before_handicap, point));
        }
      }
    }
    const auto daemon = starting_board_family(19, Opponent::world_daemon, 0);
    const auto daemon_count = choose(static_cast<int>(daemon.possible_handicap_points.size()), daemon.handicap);
    std::unordered_set<std::string> combined = obstacle_boards;
    combined.insert(illuminati_boards.begin(), illuminati_boards.end());
    std::cout << "seed_phases\t" << seed_phases << '\n'
      << "5x5_obstacle_boards\t" << obstacle_boards.size() << '\n'
      << "5x5_illuminati_starting_boards\t" << illuminati_boards.size() << '\n'
      << "5x5_all_unique_starting_boards\t" << combined.size() << '\n'
      << "5x5_max_handicap_locations\t" << largest_handicap_choice << '\n'
      << "world_daemon_board_size\t" << daemon.board_before_handicap.size << '\n'
      << "world_daemon_handicap_locations\t" << daemon.possible_handicap_points.size() << '\n'
      << "world_daemon_handicap_stones\t" << daemon.handicap << '\n'
      << "world_daemon_starting_boards\t" << daemon_count << '\n';
    return EXIT_SUCCESS;
  } catch (const std::exception& error) {
    std::cerr << error.what() << '\n';
    return EXIT_FAILURE;
  }
}
