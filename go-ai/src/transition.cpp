#include "go/transition.hpp"

#include "go/rules.hpp"

#include <stdexcept>
#include <string>
#include <unordered_set>

namespace bitburner::go {

void apply_to_position(Position& position, Move move, Stone player) {
  if (move.no_op) return;
  if (move.pass) { ++position.consecutive_passes; return; }
  const std::unordered_set<std::string> history(
    position.previous_hashes.begin(), position.previous_hashes.end());
  const auto played = play_move(position.board, move.point, player, history);
  if (!played) throw std::logic_error("position transition is illegal");
  position.previous_hashes.push_back(board_hash(position.board));
  position.board = played->board;
  position.consecutive_passes = 0;
}

}  // namespace bitburner::go
