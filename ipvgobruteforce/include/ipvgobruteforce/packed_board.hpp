#pragma once

#include "go/state.hpp"

#include <cstdint>
#include <string>
#include <vector>

namespace ipvgobruteforce {

/** A 5x5 board uses exactly 50 low bits: two bits per column-major cell.
 * 00 empty, 01 Black, 10 White, 11 offline. */
using PackedBoard = std::uint64_t;

struct PackedPosition {
  PackedBoard board{};
  std::uint8_t consecutive_passes{};
  std::vector<PackedBoard> previous_boards;

  friend bool operator==(const PackedPosition&, const PackedPosition&) = default;
};

struct PackedMoveReplay {
  PackedBoard board{};
  std::uint32_t captures{};
  bool legal{};

  friend bool operator==(const PackedMoveReplay&, const PackedMoveReplay&) = default;
};

PackedBoard pack_board(const bitburner::go::Board& board);
bitburner::go::Board unpack_board(PackedBoard board);
PackedPosition pack_position(const bitburner::go::Position& position);
bitburner::go::Position unpack_position(const PackedPosition& position);

/** Fast primary index. Equality is still checked against PackedPosition, so a
 * 64-bit fingerprint collision never merges two game states. */
std::uint64_t position_fingerprint(const PackedPosition& position);
std::string packed_board_hex(PackedBoard board);
int occupied_cells(PackedBoard board);

/** Board-local 5x5 placement replay with deliberately empty history. */
PackedMoveReplay replay_packed_move(
  PackedBoard board,
  bitburner::go::Point point,
  bitburner::go::Stone mover
);

/** The uncached primitive is exposed for parity tests and cache population.
 * Solver code should normally call replay_packed_move(). */
PackedMoveReplay replay_packed_move_uncached(
  PackedBoard board,
  bitburner::go::Point point,
  bitburner::go::Stone mover
);

}  // namespace ipvgobruteforce
