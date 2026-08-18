#include "ipvgobruteforce/symmetry.hpp"

#include <stdexcept>

namespace ipvgobruteforce {
namespace {

std::uint32_t cell(PackedBoard board, int x, int y) {
  return static_cast<std::uint32_t>((board >> (2U * static_cast<unsigned>(x * 5 + y))) & 3ULL);
}

PackedBoard set_cell(PackedBoard board, int x, int y, std::uint32_t value) {
  const unsigned shift = 2U * static_cast<unsigned>(x * 5 + y);
  return (board & ~(3ULL << shift)) | (static_cast<PackedBoard>(value) << shift);
}

}  // namespace

bitburner::go::Point transform_point(bitburner::go::Point point, BoardSymmetry symmetry) {
  if (point.x < 0 || point.y < 0 || point.x >= 5 || point.y >= 5) return point;
  int x = point.x;
  int y = point.y;
  const unsigned encoded = static_cast<unsigned>(symmetry);
  if (encoded >= 4U) x = 4 - x;
  for (unsigned turn = 0; turn < encoded % 4U; ++turn) {
    const int next_x = 4 - y;
    y = x;
    x = next_x;
  }
  return {x, y};
}

BoardSymmetry inverse_symmetry(BoardSymmetry symmetry) {
  for (const BoardSymmetry candidate : all_board_symmetries) {
    bool identity = true;
    for (int x = 0; x < 5 && identity; ++x) for (int y = 0; y < 5; ++y) {
      if (transform_point(transform_point({x, y}, symmetry), candidate)
        != bitburner::go::Point{x, y}) {
        identity = false;
        break;
      }
    }
    if (identity) return candidate;
  }
  throw std::logic_error("D4 element has no inverse");
}

PackedBoard transform_board(PackedBoard board, BoardSymmetry symmetry) {
  PackedBoard result = 0;
  for (int x = 0; x < 5; ++x) for (int y = 0; y < 5; ++y) {
    const auto target = transform_point({x, y}, symmetry);
    result = set_cell(result, target.x, target.y, cell(board, x, y));
  }
  return result;
}

CanonicalBoard canonicalize_board(PackedBoard board) {
  CanonicalBoard result{board, BoardSymmetry::identity};
  for (const BoardSymmetry symmetry : all_board_symmetries) {
    const PackedBoard candidate = transform_board(board, symmetry);
    if (candidate < result.board) result = {candidate, symmetry};
  }
  return result;
}

}  // namespace ipvgobruteforce
