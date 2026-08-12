#pragma once

#include "go/state.hpp"

#include <cstddef>
#include <span>
#include <vector>

namespace bitburner::go {

// Before/after boards plus the candidate and its known response. Padding and
// IPvGO offline nodes share the unplayable plane: both are unavailable walls.
enum class FeaturePlane : std::size_t {
  before_black,
  before_white,
  before_unplayable,
  candidate,
  response,
  after_black,
  after_white,
  after_unplayable,
  count,
};

struct CandidateFeatures {
  int extent{};
  int opponent_index{};
  bool candidate_pass{};
  bool response_pass{};
  std::vector<float> planes;
  std::vector<float> local_context;
};

inline constexpr int local_context_radius = 3;
inline constexpr std::size_t local_context_size = 4 * 3 * 7 * 7;

CandidateFeatures encode_candidate(
  const Board& before,
  const Move& candidate,
  const Move& response,
  const Board& after,
  int extent,
  int opponent_index = 0
);

std::span<const float> plane(const CandidateFeatures& features, FeaturePlane id);

}  // namespace bitburner::go
