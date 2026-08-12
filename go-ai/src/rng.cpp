#include "go/rng.hpp"

#include <algorithm>
#include <cmath>

namespace bitburner::go {

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
