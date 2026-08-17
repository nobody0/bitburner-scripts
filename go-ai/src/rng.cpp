#include "go/rng.hpp"

#include <algorithm>
#include <cmath>

namespace bitburner::go {

double normalize_go_playtime(double total_playtime_ms) {
  const double phase = std::fmod(total_playtime_ms, go_whrng_period_ms);
  return phase < 0 ? phase + go_whrng_period_ms : phase;
}

double aligned_opponent_seed(double dispatch_playtime_ms) {
  return normalize_go_playtime(dispatch_playtime_ms + go_engine_cycle_ms);
}

double next_go_dispatch_playtime(
  double dispatch_playtime_ms,
  int cycle_waits_after_seed,
  int fixed_sleep_ms_after_seed
) {
  const double wall_ms = go_engine_cycle_ms
    + static_cast<double>(std::max(0, cycle_waits_after_seed)) * go_engine_cycle_ms
    + static_cast<double>(std::max(0, fixed_sleep_ms_after_seed));
  const double elapsed_ticks = std::floor(wall_ms / go_engine_cycle_ms);
  return normalize_go_playtime(dispatch_playtime_ms + elapsed_ticks * go_engine_cycle_ms);
}

std::vector<double> whrng(double total_playtime_ms, int count) {
  const double seed = std::fmod(total_playtime_ms / 1000.0, 30000.0);
  double s1 = seed;
  double s2 = seed;
  double s3 = seed;
  std::vector<double> values;
  values.reserve(static_cast<std::size_t>(std::max(0, count)));
  for (int index = 0; index < count; ++index) {
    s1 = std::fmod(171.0 * s1, 30269.0);
    s2 = std::fmod(172.0 * s2, 30307.0);
    s3 = std::fmod(170.0 * s3, 30323.0);
    values.push_back(std::fmod(s1 / 30269.0 + s2 / 30307.0 + s3 / 30323.0, 1.0));
  }
  return values;
}

}  // namespace bitburner::go
