#pragma once

#include "ipvgobruteforce/packed_board.hpp"

#include "go/rules.hpp"

#include <cstddef>
#include <cstdint>
#include <vector>

namespace ipvgobruteforce {

struct SymmetryRuleCacheConfig {
  bool enabled{true};
  std::uint64_t max_entries{500'000};
  std::uint64_t max_bytes{256ULL * 1024ULL * 1024ULL};
};

struct SymmetryRuleCacheStats {
  std::uint64_t hits{};
  std::uint64_t misses{};
  std::uint64_t duplicate_computations{};
  std::uint64_t evictions{};
  std::uint64_t rejected_admissions{};
  std::uint64_t entries{};
  std::uint64_t bytes{};
  std::uint64_t contention_nanoseconds{};
};

/** Runtime-only, process-wide cache. Reconfiguration clears it and must happen
 * before solver workers start. It is intentionally absent from snapshots. */
void configure_symmetry_rule_cache(const SymmetryRuleCacheConfig& config);
void clear_symmetry_rule_cache();
SymmetryRuleCacheConfig symmetry_rule_cache_config();
SymmetryRuleCacheStats symmetry_rule_cache_stats();

PackedMoveReplay symmetry_cached_local_replay(
  PackedBoard board,
  bitburner::go::Point point,
  bitburner::go::Stone mover
);

bitburner::go::Score symmetry_cached_score(PackedBoard board, double komi);

}  // namespace ipvgobruteforce
