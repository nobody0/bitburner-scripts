#include "go/network_v9.hpp"

#include <algorithm>
#include <cmath>
#include <istream>
#include <ostream>
#include <random>
#include <stdexcept>
#include <string>

namespace bitburner::go {
namespace {

double sigmoid(double value) {
  return value >= 0 ? 1.0 / (1.0 + std::exp(-value))
    : std::exp(value) / (1.0 + std::exp(value));
}

double positive(double value) {
  const double softplus = value > 20 ? value
    : value < -20 ? std::exp(value) : std::log1p(std::exp(value));
  return std::expm1(std::min(softplus, 40.0));
}

void write_vector(std::ostream& output, const std::vector<double>& values) {
  output << values.size();
  for (const double value : values) output << ' ' << value;
  output << '\n';
}

std::vector<double> read_vector(std::istream& input, std::size_t expected) {
  std::size_t count = 0;
  if (!(input >> count) || count != expected) throw std::invalid_argument("invalid V9 tensor shape");
  std::vector<double> result(count);
  for (double& value : result) if (!(input >> value)) throw std::invalid_argument("truncated V9 tensor");
  return result;
}

}  // namespace

GoNetworkV9 GoNetworkV9::create(
  int extent,
  std::size_t channels,
  std::size_t residual_blocks,
  std::size_t value_hidden,
  std::size_t value_tower,
  std::size_t behavior_features,
  std::uint64_t seed,
  std::size_t input_channels
) {
  if (extent <= 0 || channels == 0 || residual_blocks == 0 || value_hidden == 0
    || value_tower == 0 || behavior_features == 0
    || (input_channels != base_input_channels
      && input_channels != tactical_input_channels)) {
    throw std::invalid_argument("invalid V9 dimensions");
  }
  GoNetworkV9 result;
  result.extent_ = extent;
  result.channels_ = channels;
  result.residual_blocks_ = residual_blocks;
  result.value_hidden_ = value_hidden;
  result.value_tower_ = value_tower;
  result.behavior_features_ = behavior_features;
  result.input_channels_ = input_channels;
  const std::size_t pooled = channels * pool_extent * pool_extent;
  result.stem_.resize(channels * input_channels * 9);
  result.stem_bias_.resize(channels);
  result.residual_.resize(residual_blocks * 2 * channels * channels * 9);
  result.residual_bias_.resize(residual_blocks * 2 * channels);
  result.conditioning_w_.resize(residual_blocks * channels * behavior_features);
  result.conditioning_b_.resize(residual_blocks * channels);
  result.value_w1_.resize(value_hidden * pooled);
  result.value_b1_.resize(value_hidden);
  result.value_w2_.resize(value_tower * value_hidden);
  result.value_b2_.resize(value_tower);
  result.value_out_w_.resize(value_output_size * value_tower);
  result.value_out_b_.resize(value_output_size);
  result.policy_w_.resize(channels);
  result.policy_b_.resize(1);
  result.pass_w_.resize(pooled);
  result.pass_b_.resize(1);
  result.branch_w_.resize(reply_branch_count * channels);
  result.branch_b_.resize(reply_branch_count);
  result.pass_branch_w_.resize(reply_branch_count * pooled);
  result.pass_branch_b_.resize(reply_branch_count);

  std::mt19937_64 random(seed);
  const auto initialize = [&random](std::vector<double>& values, double scale) {
    std::normal_distribution<double> distribution(0.0, scale);
    std::generate(values.begin(), values.end(), [&] { return distribution(random); });
  };
  initialize(result.stem_, std::sqrt(2.0 / static_cast<double>(input_channels * 9)));
  initialize(result.residual_, std::sqrt(2.0 / static_cast<double>(channels * 9)));
  initialize(result.conditioning_w_, 1.0 / std::sqrt(static_cast<double>(behavior_features)));
  initialize(result.value_w1_, std::sqrt(2.0 / static_cast<double>(pooled)));
  initialize(result.value_w2_, std::sqrt(2.0 / static_cast<double>(value_hidden)));
  initialize(result.value_out_w_, std::sqrt(2.0 / static_cast<double>(value_tower)));
  initialize(result.policy_w_, 1.0 / std::sqrt(static_cast<double>(channels)));
  initialize(result.pass_w_, 1.0 / std::sqrt(static_cast<double>(pooled)));
  initialize(result.branch_w_, 1.0 / std::sqrt(static_cast<double>(channels)));
  initialize(result.pass_branch_w_, 1.0 / std::sqrt(static_cast<double>(pooled)));
  return result;
}

V9Prediction GoNetworkV9::predict_impl(const V9Input& input, bool policy_only) const {
  const std::size_t area = static_cast<std::size_t>(extent_ * extent_);
  if (input.board.size > extent_ || input.legal_black.size() != area
    || input.behavior.size() != behavior_features_) {
    throw std::invalid_argument("V9 input shape mismatch");
  }
  std::vector<double> planes(input_channels_ * area);
  std::vector<char> cells(area, '#');
  for (int x = 0; x < extent_; ++x) for (int y = 0; y < extent_; ++y) {
    const std::size_t point = static_cast<std::size_t>(x * extent_ + y);
    const char cell = x < input.board.size && y < input.board.size
      ? input.board.columns[static_cast<std::size_t>(x)][static_cast<std::size_t>(y)] : '#';
    cells[point] = cell;
    planes[point] = cell == 'X';
    planes[area + point] = cell == 'O';
    planes[2 * area + point] = cell == '#';
    planes[3 * area + point] = input.legal_black[point];
    planes[4 * area + point] = input.consecutive_passes;
    planes[5 * area + point] = input.elapsed_fraction;
    planes[6 * area + point] = input.response_pass;
    planes[7 * area + point] = input.response_no_op;
  }
  if (input_channels_ == tactical_input_channels) {
    const auto neighbors = [&](std::size_t point) {
      std::array<std::size_t, 4> values{};
      std::size_t count = 0;
      const int x = static_cast<int>(point / static_cast<std::size_t>(extent_));
      const int y = static_cast<int>(point % static_cast<std::size_t>(extent_));
      if (x > 0) values[count++] = point - static_cast<std::size_t>(extent_);
      if (x + 1 < extent_) values[count++] = point + static_cast<std::size_t>(extent_);
      if (y > 0) values[count++] = point - 1;
      if (y + 1 < extent_) values[count++] = point + 1;
      return std::pair{values, count};
    };
    struct Group {
      char color{};
      std::vector<std::size_t> stones;
      std::vector<std::size_t> liberties;
    };
    std::vector<Group> groups;
    std::vector<int> group_at(area, -1);
    for (std::size_t start = 0; start < area; ++start) {
      if ((cells[start] != 'X' && cells[start] != 'O') || group_at[start] >= 0) continue;
      const int group_id = static_cast<int>(groups.size());
      groups.push_back(Group{.color = cells[start]});
      auto& group = groups.back();
      std::vector<std::size_t> pending{start};
      std::vector<bool> liberty_seen(area);
      group_at[start] = group_id;
      while (!pending.empty()) {
        const std::size_t point = pending.back();
        pending.pop_back();
        group.stones.push_back(point);
        const auto [adjacent, count] = neighbors(point);
        for (std::size_t index = 0; index < count; ++index) {
          const std::size_t other = adjacent[index];
          if (cells[other] == '.' && !liberty_seen[other]) {
            liberty_seen[other] = true;
            group.liberties.push_back(other);
          } else if (cells[other] == group.color && group_at[other] < 0) {
            group_at[other] = group_id;
            pending.push_back(other);
          }
        }
      }
      std::size_t plane = tactical_input_channels;
      if (group.color == 'X' && group.liberties.size() == 1) plane = 8;
      else if (group.color == 'X' && group.liberties.size() == 2) plane = 9;
      else if (group.color == 'O' && group.liberties.size() == 1) plane = 10;
      else if (group.color == 'O' && group.liberties.size() == 2) plane = 11;
      if (plane < tactical_input_channels) {
        for (const std::size_t stone : group.stones) planes[plane * area + stone] = 1;
      }
    }
    for (std::size_t point = 0; point < area; ++point) {
      if (input.legal_black[point] == 0) continue;
      std::vector<int> friendly_groups, captured_groups;
      const auto [adjacent, adjacent_count] = neighbors(point);
      for (std::size_t index = 0; index < adjacent_count; ++index) {
        const std::size_t other = adjacent[index];
        const int group_id = group_at[other];
        if (group_id < 0) continue;
        auto& destination = cells[other] == 'X' ? friendly_groups : captured_groups;
        const auto& group = groups[static_cast<std::size_t>(group_id)];
        if (cells[other] == 'O'
          && (group.liberties.size() != 1 || group.liberties.front() != point)) continue;
        if (std::find(destination.begin(), destination.end(), group_id) == destination.end()) {
          destination.push_back(group_id);
        }
      }
      std::vector<bool> captured(area), merged(area), liberty(area);
      std::size_t captured_count = 0;
      for (const int group_id : captured_groups) {
        for (const std::size_t stone : groups[static_cast<std::size_t>(group_id)].stones) {
          captured[stone] = true;
          ++captured_count;
        }
      }
      std::vector<std::size_t> merged_stones{point};
      merged[point] = true;
      for (const int group_id : friendly_groups) {
        for (const std::size_t stone : groups[static_cast<std::size_t>(group_id)].stones) {
          merged[stone] = true;
          merged_stones.push_back(stone);
        }
      }
      std::size_t liberty_count = 0;
      for (const std::size_t stone : merged_stones) {
        const auto [others, count] = neighbors(stone);
        for (std::size_t index = 0; index < count; ++index) {
          const std::size_t other = others[index];
          if (!liberty[other]
            && (captured[other] || (cells[other] == '.' && !merged[other]))) {
            liberty[other] = true;
            ++liberty_count;
          }
        }
      }
      planes[12 * area + point] = captured_count > 0;
      planes[13 * area + point] = captured_count >= 2;
      planes[14 * area + point] = liberty_count == 1;
      planes[15 * area + point] = friendly_groups.size() >= 2;
    }
  }
  const auto convolve = [&](const std::vector<double>& source,
    const std::vector<double>& weights, const std::vector<double>& biases,
    std::size_t weight_base, std::size_t bias_base,
    std::size_t inputs, std::size_t outputs) {
    std::vector<double> target(outputs * area);
    for (std::size_t output = 0; output < outputs; ++output) {
      for (int x = 0; x < extent_; ++x) for (int y = 0; y < extent_; ++y) {
        double value = biases[bias_base + output];
        for (std::size_t channel = 0; channel < inputs; ++channel) {
          for (int dx = -1; dx <= 1; ++dx) for (int dy = -1; dy <= 1; ++dy) {
            const int nx = x + dx, ny = y + dy;
            if (nx < 0 || ny < 0 || nx >= extent_ || ny >= extent_) continue;
            const std::size_t weight = weight_base
              + ((output * inputs + channel) * 3 + static_cast<std::size_t>(dx + 1)) * 3
              + static_cast<std::size_t>(dy + 1);
            value += weights[weight] * source[channel * area
              + static_cast<std::size_t>(nx * extent_ + ny)];
          }
        }
        target[output * area + static_cast<std::size_t>(x * extent_ + y)] = value;
      }
    }
    return target;
  };
  std::vector<double> spatial = convolve(
    planes, stem_, stem_bias_, 0, 0, input_channels_, channels_);
  for (double& value : spatial) value = std::tanh(value);
  const std::size_t kernel = channels_ * channels_ * 9;
  for (std::size_t block = 0; block < residual_blocks_; ++block) {
    auto middle = convolve(spatial, residual_, residual_bias_,
      block * 2 * kernel, block * 2 * channels_, channels_, channels_);
    for (double& value : middle) value = std::tanh(value);
    auto update = convolve(middle, residual_, residual_bias_,
      block * 2 * kernel + kernel, block * 2 * channels_ + channels_, channels_, channels_);
    for (std::size_t channel = 0; channel < channels_; ++channel) {
      double condition = conditioning_b_[block * channels_ + channel];
      const std::size_t row = (block * channels_ + channel) * behavior_features_;
      for (std::size_t feature = 0; feature < behavior_features_; ++feature) {
        condition += conditioning_w_[row + feature] * input.behavior[feature];
      }
      for (std::size_t point = 0; point < area; ++point) {
        const std::size_t index = channel * area + point;
        spatial[index] = std::tanh(spatial[index] + update[index] + condition);
      }
    }
  }
  const std::size_t pooled_size = channels_ * pool_extent * pool_extent;
  std::vector<double> pooled(pooled_size);
  std::array<int, pool_extent * pool_extent> counts{};
  for (int x = 0; x < extent_; ++x) for (int y = 0; y < extent_; ++y) {
    const std::size_t bin = static_cast<std::size_t>(
      (x * pool_extent / extent_) * pool_extent + y * pool_extent / extent_);
    ++counts[bin];
    const std::size_t point = static_cast<std::size_t>(x * extent_ + y);
    for (std::size_t channel = 0; channel < channels_; ++channel) {
      pooled[channel * 25 + bin] += spatial[channel * area + point];
    }
  }
  for (std::size_t channel = 0; channel < channels_; ++channel) {
    for (std::size_t bin = 0; bin < 25; ++bin) pooled[channel * 25 + bin] /= counts[bin];
  }
  std::array<double, value_output_size> value_raw{};
  if (!policy_only) {
    std::vector<double> hidden(value_hidden_);
    for (std::size_t output = 0; output < value_hidden_; ++output) {
      double value = value_b1_[output];
      for (std::size_t index = 0; index < pooled_size; ++index) {
        value += value_w1_[output * pooled_size + index] * pooled[index];
      }
      hidden[output] = std::tanh(value);
    }
    std::vector<double> tower(value_tower_);
    for (std::size_t output = 0; output < value_tower_; ++output) {
      double value = value_b2_[output];
      for (std::size_t index = 0; index < value_hidden_; ++index) {
        value += value_w2_[output * value_hidden_ + index] * hidden[index];
      }
      tower[output] = std::tanh(value);
    }
    for (std::size_t output = 0; output < value_raw.size(); ++output) {
      value_raw[output] = value_out_b_[output];
      for (std::size_t index = 0; index < value_tower_; ++index) {
        value_raw[output] += value_out_w_[output * value_tower_ + index] * tower[index];
      }
    }
  }
  V9Prediction result{
    .value = {
      .win_probability = sigmoid(value_raw[0]),
      .terminal_power = positive(value_raw[1]),
      .remaining_turns = positive(value_raw[2]),
    },
    .move_logits = std::vector<double>(area + 1),
    .branch_logits = policy_only
      ? std::vector<std::array<double, reply_branch_count>>()
      : std::vector<std::array<double, reply_branch_count>>(area + 1),
  };
  for (std::size_t point = 0; point < area; ++point) {
    double policy = policy_b_[0];
    for (std::size_t channel = 0; channel < channels_; ++channel) {
      policy += policy_w_[channel] * spatial[channel * area + point];
    }
    result.move_logits[point] = policy;
    if (!policy_only) {
      for (std::size_t branch = 0; branch < reply_branch_count; ++branch) {
        double value = branch_b_[branch];
        for (std::size_t channel = 0; channel < channels_; ++channel) {
          value += branch_w_[branch * channels_ + channel] * spatial[channel * area + point];
        }
        result.branch_logits[point][branch] = value;
      }
    }
  }
  if (global_policy_rank_ != 0) {
    std::vector<double> context(global_policy_rank_);
    for (std::size_t output = 0; output < global_policy_rank_; ++output) {
      double value = global_policy_b1_[output];
      for (std::size_t index = 0; index < pooled_size; ++index) {
        value += global_policy_w1_[output * pooled_size + index] * pooled[index];
      }
      context[output] = std::tanh(value);
    }
    for (std::size_t point = 0; point < area; ++point) {
      double value = global_policy_b2_[point];
      for (std::size_t index = 0; index < global_policy_rank_; ++index) {
        value += global_policy_w2_[point * global_policy_rank_ + index] * context[index];
      }
      result.move_logits[point] += value;
    }
  }
  result.move_logits[area] = pass_b_[0];
  for (std::size_t index = 0; index < pooled_size; ++index) {
    result.move_logits[area] += pass_w_[index] * pooled[index];
  }
  if (!policy_only) {
    for (std::size_t branch = 0; branch < reply_branch_count; ++branch) {
      double value = pass_branch_b_[branch];
      for (std::size_t index = 0; index < pooled_size; ++index) {
        value += pass_branch_w_[branch * pooled_size + index] * pooled[index];
      }
      result.branch_logits[area][branch] = value;
    }
  }
  return result;
}

V9Prediction GoNetworkV9::predict(const V9Input& input) const {
  return predict_impl(input, false);
}

std::vector<double> GoNetworkV9::predict_policy(const V9Input& input) const {
  return predict_impl(input, true).move_logits;
}

void GoNetworkV9::save(std::ostream& output) const {
  output.precision(17);
  output << (input_channels_ == tactical_input_channels
      ? "bitburner-go-value-v9-tactical-global-policy-v1\n"
      : global_policy_rank_ ? "bitburner-go-value-v9-global-policy-v1\n"
                            : "bitburner-go-value-v9\n")
    << extent_ << ' ' << channels_ << ' '
    << residual_blocks_ << ' ' << value_hidden_ << ' ' << value_tower_ << ' '
    << behavior_features_ << ' ' << reply_branch_count;
  if (global_policy_rank_) output << ' ' << global_policy_rank_;
  output << '\n';
  for (const auto* vector : {&stem_, &stem_bias_, &residual_, &residual_bias_,
    &conditioning_w_, &conditioning_b_, &value_w1_, &value_b1_, &value_w2_,
    &value_b2_, &value_out_w_, &value_out_b_, &policy_w_, &policy_b_, &pass_w_,
    &pass_b_, &branch_w_, &branch_b_, &pass_branch_w_, &pass_branch_b_}) {
    write_vector(output, *vector);
  }
  if (global_policy_rank_) for (const auto* vector : {
    &global_policy_w1_, &global_policy_b1_, &global_policy_w2_, &global_policy_b2_}) {
    write_vector(output, *vector);
  }
}

GoNetworkV9 GoNetworkV9::load(std::istream& input) {
  std::string magic;
  int extent = 0;
  std::size_t channels = 0, blocks = 0, hidden = 0, tower = 0, behavior = 0, branches = 0;
  if (!(input >> magic)
    || (magic != "bitburner-go-value-v9"
      && magic != "bitburner-go-value-v9-global-policy-v1"
      && magic != "bitburner-go-value-v9-tactical-global-policy-v1")
    || !(input >> extent >> channels >> blocks >> hidden >> tower >> behavior >> branches)
    || branches != reply_branch_count) throw std::invalid_argument("unsupported V9 checkpoint");
  const bool global_policy = magic != "bitburner-go-value-v9";
  const std::size_t input_channels = magic ==
      "bitburner-go-value-v9-tactical-global-policy-v1"
    ? tactical_input_channels : base_input_channels;
  std::size_t policy_rank = 0;
  if (global_policy && !(input >> policy_rank)) {
    throw std::invalid_argument("invalid V9 global policy rank");
  }
  GoNetworkV9 result = create(
    extent, channels, blocks, hidden, tower, behavior, 0, input_channels);
  const std::size_t pooled = channels * 25;
  result.stem_ = read_vector(input, channels * input_channels * 9);
  result.stem_bias_ = read_vector(input, channels);
  result.residual_ = read_vector(input, blocks * 2 * channels * channels * 9);
  result.residual_bias_ = read_vector(input, blocks * 2 * channels);
  result.conditioning_w_ = read_vector(input, blocks * channels * behavior);
  result.conditioning_b_ = read_vector(input, blocks * channels);
  result.value_w1_ = read_vector(input, hidden * pooled);
  result.value_b1_ = read_vector(input, hidden);
  result.value_w2_ = read_vector(input, tower * hidden);
  result.value_b2_ = read_vector(input, tower);
  result.value_out_w_ = read_vector(input, value_output_size * tower);
  result.value_out_b_ = read_vector(input, value_output_size);
  result.policy_w_ = read_vector(input, channels);
  result.policy_b_ = read_vector(input, 1);
  result.pass_w_ = read_vector(input, pooled);
  result.pass_b_ = read_vector(input, 1);
  result.branch_w_ = read_vector(input, reply_branch_count * channels);
  result.branch_b_ = read_vector(input, reply_branch_count);
  result.pass_branch_w_ = read_vector(input, reply_branch_count * pooled);
  result.pass_branch_b_ = read_vector(input, reply_branch_count);
  if (global_policy) {
    if (policy_rank == 0) throw std::invalid_argument("invalid V9 global policy rank");
    result.global_policy_rank_ = policy_rank;
    result.global_policy_w1_ = read_vector(input, policy_rank * pooled);
    result.global_policy_b1_ = read_vector(input, policy_rank);
    result.global_policy_w2_ = read_vector(input,
      static_cast<std::size_t>(extent * extent) * policy_rank);
    result.global_policy_b2_ = read_vector(input,
      static_cast<std::size_t>(extent * extent));
  }
  return result;
}

}  // namespace bitburner::go
