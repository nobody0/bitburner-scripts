#include "ipvgobruteforce/packed_board.hpp"

#ifndef IPVGO_DISABLE_RULE_CACHE_LINK
#include "ipvgobruteforce/symmetry_rule_cache.hpp"
#endif

#include "go/rules.hpp"

#include <array>
#include <bit>
#include <iomanip>
#include <sstream>
#include <stdexcept>

namespace ipvgobruteforce {
namespace {

std::uint64_t mix(std::uint64_t value) {
  value ^= value >> 30;
  value *= 0xbf58476d1ce4e5b9ULL;
  value ^= value >> 27;
  value *= 0x94d049bb133111ebULL;
  return value ^ (value >> 31);
}

std::uint64_t cell_bits(char cell) {
  switch (cell) {
    case '.': return 0;
    case 'X': return 1;
    case 'O': return 2;
    case '#': return 3;
    default: throw std::invalid_argument("invalid IPvGO cell");
  }
}

char bits_cell(std::uint64_t bits) {
  constexpr std::array<char, 4> cells{'.', 'X', 'O', '#'};
  return cells.at(static_cast<std::size_t>(bits));
}

std::uint32_t cell(PackedBoard board, std::uint32_t index) {
  return static_cast<std::uint32_t>((board >> (index * 2U)) & 3ULL);
}

PackedBoard set_cell(PackedBoard board, std::uint32_t index, std::uint32_t value) {
  const std::uint32_t shift = index * 2U;
  return (board & ~(3ULL << shift)) | (static_cast<PackedBoard>(value) << shift);
}

std::uint32_t neighbors(std::uint32_t index) {
  const std::uint32_t x = index / 5U;
  const std::uint32_t y = index % 5U;
  std::uint32_t result = 0;
  if (x > 0) result |= 1U << (index - 5U);
  if (x < 4) result |= 1U << (index + 5U);
  if (y > 0) result |= 1U << (index - 1U);
  if (y < 4) result |= 1U << (index + 1U);
  return result;
}

std::uint32_t group_mask(PackedBoard board, std::uint32_t seed, std::uint32_t color) {
  std::uint32_t group = 0;
  std::uint32_t pending = 1U << seed;
  while (pending != 0) {
    const auto index = static_cast<std::uint32_t>(std::countr_zero(pending));
    const std::uint32_t bit = 1U << index;
    pending &= ~bit;
    if ((group & bit) != 0 || cell(board, index) != color) continue;
    group |= bit;
    pending |= neighbors(index) & ~group;
  }
  return group;
}

std::uint32_t liberty_mask(PackedBoard board, std::uint32_t group) {
  std::uint32_t liberties = 0;
  while (group != 0) {
    const auto index = static_cast<std::uint32_t>(std::countr_zero(group));
    group &= ~(1U << index);
    std::uint32_t adjacent = neighbors(index);
    while (adjacent != 0) {
      const auto neighbor = static_cast<std::uint32_t>(std::countr_zero(adjacent));
      adjacent &= ~(1U << neighbor);
      if (cell(board, neighbor) == 0) liberties |= 1U << neighbor;
    }
  }
  return liberties;
}

PackedBoard clear_group(PackedBoard board, std::uint32_t group) {
  while (group != 0) {
    const auto index = static_cast<std::uint32_t>(std::countr_zero(group));
    group &= ~(1U << index);
    board = set_cell(board, index, 0);
  }
  return board;
}

}  // namespace

PackedBoard pack_board(const bitburner::go::Board& board) {
  if (board.size != 5 || board.columns.size() != 5) {
    throw std::invalid_argument("compact graph requires a 5x5 board");
  }
  PackedBoard result = 0;
  for (int x = 0; x < 5; ++x) {
    if (board.columns[static_cast<std::size_t>(x)].size() != 5) {
      throw std::invalid_argument("compact graph requires five complete columns");
    }
    for (int y = 0; y < 5; ++y) {
      result |= cell_bits(board.columns[static_cast<std::size_t>(x)][static_cast<std::size_t>(y)])
        << static_cast<unsigned>(2 * (x * 5 + y));
    }
  }
  return result;
}

bitburner::go::Board unpack_board(PackedBoard packed) {
  bitburner::go::Board board{.size = 5, .columns = std::vector<std::string>(5, std::string(5, '.'))};
  for (int x = 0; x < 5; ++x) for (int y = 0; y < 5; ++y) {
    const unsigned shift = static_cast<unsigned>(2 * (x * 5 + y));
    board.columns[static_cast<std::size_t>(x)][static_cast<std::size_t>(y)]
      = bits_cell((packed >> shift) & 3ULL);
  }
  return board;
}

PackedPosition pack_position(const bitburner::go::Position& position) {
  if (position.consecutive_passes < 0 || position.consecutive_passes > 2) {
    throw std::invalid_argument("invalid consecutive pass count");
  }
  PackedPosition result{
    .board = pack_board(position.board),
    .consecutive_passes = static_cast<std::uint8_t>(position.consecutive_passes),
  };
  result.previous_boards.reserve(position.previous_hashes.size());
  for (const std::string& hash : position.previous_hashes) {
    result.previous_boards.push_back(pack_board(bitburner::go::board_from_hash(5, hash)));
  }
  return result;
}

bitburner::go::Position unpack_position(const PackedPosition& packed) {
  bitburner::go::Position result{
    .board = unpack_board(packed.board),
    .consecutive_passes = packed.consecutive_passes,
  };
  result.previous_hashes.reserve(packed.previous_boards.size());
  for (const PackedBoard board : packed.previous_boards) {
    result.previous_hashes.push_back(bitburner::go::board_hash(unpack_board(board)));
  }
  return result;
}

std::uint64_t position_fingerprint(const PackedPosition& position) {
  std::uint64_t result = mix(position.board ^ (static_cast<std::uint64_t>(position.consecutive_passes) << 61));
  result ^= mix(static_cast<std::uint64_t>(position.previous_boards.size()) + 0x9e3779b97f4a7c15ULL);
  for (std::size_t index = 0; index < position.previous_boards.size(); ++index) {
    result = mix(result ^ mix(position.previous_boards[index]
      + static_cast<std::uint64_t>(index) * 0x9e3779b97f4a7c15ULL));
  }
  return result;
}

std::string packed_board_hex(PackedBoard board) {
  std::ostringstream result;
  result << "0x" << std::hex << std::setw(13) << std::setfill('0') << board;
  return result.str();
}

int occupied_cells(PackedBoard board) {
  int result = 0;
  for (int cell = 0; cell < 25; ++cell) {
    const std::uint64_t bits = (board >> static_cast<unsigned>(cell * 2)) & 3ULL;
    result += bits == 1 || bits == 2;
  }
  return result;
}

PackedMoveReplay replay_packed_move_uncached(
  PackedBoard original,
  bitburner::go::Point point,
  bitburner::go::Stone mover
) {
  PackedMoveReplay result{.board = original};
  if (point.x < 0 || point.y < 0 || point.x >= 5 || point.y >= 5) return result;
  const std::uint32_t coordinate = static_cast<std::uint32_t>(point.x * 5 + point.y);
  const std::uint32_t color = mover == bitburner::go::Stone::black ? 1U : 2U;
  if (cell(original, coordinate) != 0) return result;

  PackedBoard board = set_cell(original, coordinate, color);
  const std::uint32_t enemy = color == 1U ? 2U : 1U;
  std::uint32_t checked = 0;
  std::uint32_t adjacent = neighbors(coordinate);
  while (adjacent != 0) {
    const auto index = static_cast<std::uint32_t>(std::countr_zero(adjacent));
    adjacent &= ~(1U << index);
    if (cell(board, index) != enemy || (checked & (1U << index)) != 0) continue;
    const std::uint32_t group = group_mask(board, index, enemy);
    checked |= group;
    if (liberty_mask(board, group) == 0) {
      result.captures += static_cast<std::uint32_t>(std::popcount(group));
      board = clear_group(board, group);
    }
  }
  if (result.captures == 0) {
    const std::uint32_t own_group = group_mask(board, coordinate, color);
    if (liberty_mask(board, own_group) == 0) {
      result.captures = 0;
      return result;
    }
  }
  result.board = board;
  result.legal = true;
  return result;
}

PackedMoveReplay replay_packed_move(
  PackedBoard board,
  bitburner::go::Point point,
  bitburner::go::Stone mover
) {
#ifdef IPVGO_DISABLE_RULE_CACHE_LINK
  return replay_packed_move_uncached(board, point, mover);
#else
  return symmetry_cached_local_replay(board, point, mover);
#endif
}

}  // namespace ipvgobruteforce
