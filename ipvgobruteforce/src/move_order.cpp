#include "ipvgobruteforce/move_order.hpp"

#include "ipvgobruteforce/packed_board.hpp"
#include "ipvgobruteforce/symmetry_rule_cache.hpp"

#include "go/rules.hpp"

#include <algorithm>
#include <cstdint>
#include <unordered_set>

namespace ipvgobruteforce {

std::vector<bitburner::go::Move> ordered_black_moves(
  const bitburner::go::Position& position,
  double komi
) {
  using namespace bitburner::go;
  struct Candidate {
    Move move;
    bool immediate_terminal_win{};
    double black_power{-1.0};
    int black_stones{-1};
    int white_stones{26};
    std::uint64_t deterministic_random{};
  };
  std::vector<Candidate> candidates;
  const PackedPosition packed_position = pack_position(position);
  const std::uint64_t tie_seed = position_fingerprint(packed_position);
  const std::unordered_set<std::string> history(
    position.previous_hashes.begin(), position.previous_hashes.end());
  for (const Point point : legal_moves(position, Stone::black)) {
    const auto played = play_move(position.board, point, Stone::black, history);
    if (!played) continue;
    const PackedBoard packed = pack_board(played->board);
    int black_stones = 0;
    int white_stones = 0;
    for (unsigned coordinate = 0; coordinate < 25; ++coordinate) {
      const std::uint64_t value = (packed >> (coordinate * 2U)) & 3ULL;
      black_stones += value == 1U;
      white_stones += value == 2U;
    }
    const std::uint64_t coordinate = static_cast<std::uint64_t>(point.x * 5 + point.y);
    std::uint64_t tie = packed ^ (tie_seed + coordinate * 0x9e3779b97f4a7c15ULL);
    tie ^= tie >> 30U;
    tie *= 0xbf58476d1ce4e5b9ULL;
    tie ^= tie >> 27U;
    tie *= 0x94d049bb133111ebULL;
    tie ^= tie >> 31U;
    candidates.push_back({Move::at(point.x, point.y), false,
      symmetry_cached_score(packed, komi).black, black_stones, white_stones, tie});
  }
  const Score score = symmetry_cached_score(packed_position.board, komi);
  candidates.push_back({.move = Move::pass_turn(), .immediate_terminal_win =
    position.consecutive_passes > 0 && score.black > score.white,
    .black_power = score.black});
  std::sort(candidates.begin(), candidates.end(), [](const Candidate& left, const Candidate& right) {
    if (left.immediate_terminal_win != right.immediate_terminal_win) {
      return left.immediate_terminal_win > right.immediate_terminal_win;
    }
    if (left.black_power != right.black_power) return left.black_power > right.black_power;
    if (left.black_stones != right.black_stones) return left.black_stones > right.black_stones;
    if (left.white_stones != right.white_stones) return left.white_stones < right.white_stones;
    return left.deterministic_random < right.deterministic_random;
  });
  std::vector<Move> result;
  result.reserve(candidates.size());
  for (const Candidate& candidate : candidates) result.push_back(candidate.move);
  return result;
}

}  // namespace ipvgobruteforce
