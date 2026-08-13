#pragma once

#include <cstddef>

namespace bitburner::go {

inline constexpr std::size_t value_output_size = 3;

struct ValuePrediction {
  double win_probability{};
  double terminal_power{};
  double remaining_turns{};
};

}  // namespace bitburner::go
