#pragma once

#include <vector>

namespace bitburner::go {

std::vector<double> whrng(double total_playtime_ms, int count);

inline constexpr double go_engine_cycle_ms = 200.0;
inline constexpr double go_whrng_period_ms = 30'000'000.0;

double normalize_go_playtime(double total_playtime_ms);

// The opponent constructs WHRNG after its first engine-cycle wait.
double aligned_opponent_seed(double dispatch_playtime_ms);

// Advance Player.totalPlaytime through the selected upstream reply. The trace
// excludes the initial wait but includes every later waitCycle call, including
// the final placement wait for a non-pass move.
double next_go_dispatch_playtime(
  double dispatch_playtime_ms,
  int cycle_waits_after_seed,
  int fixed_sleep_ms_after_seed
);

}  // namespace bitburner::go
