#pragma once

#include "ipvgobruteforce/packed_board.hpp"

#include <array>
#include <cstdint>

namespace ipvgobruteforce {

/** D4 element: rotate clockwise by (value % 4) quarter turns after optionally
 * reflecting across the vertical axis (value >= 4). */
enum class BoardSymmetry : std::uint8_t {
  identity = 0,
  rotate90 = 1,
  rotate180 = 2,
  rotate270 = 3,
  reflect = 4,
  reflect_rotate90 = 5,
  reflect_rotate180 = 6,
  reflect_rotate270 = 7,
};

constexpr std::array<BoardSymmetry, 8> all_board_symmetries{
  BoardSymmetry::identity, BoardSymmetry::rotate90,
  BoardSymmetry::rotate180, BoardSymmetry::rotate270,
  BoardSymmetry::reflect, BoardSymmetry::reflect_rotate90,
  BoardSymmetry::reflect_rotate180, BoardSymmetry::reflect_rotate270,
};

bitburner::go::Point transform_point(bitburner::go::Point point, BoardSymmetry symmetry);
BoardSymmetry inverse_symmetry(BoardSymmetry symmetry);
PackedBoard transform_board(PackedBoard board, BoardSymmetry symmetry);

struct CanonicalBoard {
  PackedBoard board{};
  /** Maps the caller's orientation to board. */
  BoardSymmetry orientation{BoardSymmetry::identity};

  friend bool operator==(const CanonicalBoard&, const CanonicalBoard&) = default;
};

CanonicalBoard canonicalize_board(PackedBoard board);

}  // namespace ipvgobruteforce
