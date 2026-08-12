#include "go/features.hpp"

#include <algorithm>
#include <stdexcept>

namespace bitburner::go {
namespace {

void encode_board(std::vector<float>& output, int extent, std::size_t base, const Board& board) {
  const auto area = static_cast<std::size_t>(extent * extent);
  const auto black = base + static_cast<std::size_t>(FeaturePlane::before_black) * area;
  const auto white = base + static_cast<std::size_t>(FeaturePlane::before_white) * area;
  const auto unavailable = base + static_cast<std::size_t>(FeaturePlane::before_unplayable) * area;
  for (int x = 0; x < extent; ++x) {
    for (int y = 0; y < extent; ++y) {
      const auto index = static_cast<std::size_t>(x * extent + y);
      const char cell = x < board.size && y < board.size
        ? board.columns.at(static_cast<std::size_t>(x)).at(static_cast<std::size_t>(y))
        : '#';
      output[black + index] = cell == 'X' ? 1.0F : 0.0F;
      output[white + index] = cell == 'O' ? 1.0F : 0.0F;
      output[unavailable + index] = cell == '#' ? 1.0F : 0.0F;
    }
  }
}

void encode_local(
  std::vector<float>& output,
  std::size_t anchor,
  const Board& board,
  const Move& center
) {
  if (center.pass) return;
  constexpr int width = local_context_radius * 2 + 1;
  constexpr std::size_t anchor_size = 3 * width * width;
  const std::size_t base = anchor * anchor_size;
  for (int dx = -local_context_radius; dx <= local_context_radius; ++dx) {
    for (int dy = -local_context_radius; dy <= local_context_radius; ++dy) {
      const int x = center.point.x + dx;
      const int y = center.point.y + dy;
      const char cell = x >= 0 && y >= 0 && x < board.size && y < board.size
        ? board.columns[static_cast<std::size_t>(x)][static_cast<std::size_t>(y)] : '#';
      const int channel = cell == 'X' ? 0 : cell == 'O' ? 1 : cell == '#' ? 2 : -1;
      if (channel < 0) continue;
      const auto point = static_cast<std::size_t>(
        (dx + local_context_radius) * width + dy + local_context_radius);
      output[base + static_cast<std::size_t>(channel * width * width) + point] = 1.0F;
    }
  }
}

}  // namespace

CandidateFeatures encode_candidate(
  const Board& before,
  const Move& candidate,
  const Move& response,
  const Board& after,
  int extent,
  int opponent_index
) {
  if (extent < before.size || extent < after.size) throw std::invalid_argument("feature extent is smaller than board");
  if (opponent_index < 0 || opponent_index >= 7) throw std::invalid_argument("opponent feature index must be 0..6");
  const auto area = static_cast<std::size_t>(extent * extent);
  CandidateFeatures features{
    .extent = extent,
    .opponent_index = opponent_index,
    .candidate_pass = candidate.pass,
    .response_pass = response.pass,
    .planes = std::vector<float>(static_cast<std::size_t>(FeaturePlane::count) * area),
    .local_context = std::vector<float>(local_context_size),
  };
  encode_board(features.planes, extent, 0, before);

  if (!candidate.pass) {
    features.planes[static_cast<std::size_t>(FeaturePlane::candidate) * area
      + static_cast<std::size_t>(candidate.point.x * extent + candidate.point.y)] = 1.0F;
  }
  if (!response.pass) {
    features.planes[static_cast<std::size_t>(FeaturePlane::response) * area
      + static_cast<std::size_t>(response.point.x * extent + response.point.y)] = 1.0F;
  }

  // Reuse the board encoder's three contiguous planes at the after-board offset.
  const auto after_base = (static_cast<std::size_t>(FeaturePlane::after_black)
    - static_cast<std::size_t>(FeaturePlane::before_black)) * area;
  encode_board(features.planes, extent, after_base, after);
  encode_local(features.local_context, 0, before, candidate);
  encode_local(features.local_context, 1, after, candidate);
  encode_local(features.local_context, 2, before, response);
  encode_local(features.local_context, 3, after, response);
  return features;
}

std::span<const float> plane(const CandidateFeatures& features, FeaturePlane id) {
  const auto area = static_cast<std::size_t>(features.extent * features.extent);
  const auto offset = static_cast<std::size_t>(id) * area;
  return {features.planes.data() + offset, area};
}

}  // namespace bitburner::go
