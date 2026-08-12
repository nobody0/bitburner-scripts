#include "go/network.hpp"

#include <algorithm>
#include <cmath>
#include <limits>
#include <istream>
#include <ostream>
#include <stdexcept>
#include <string_view>
#include <thread>

namespace bitburner::go {
namespace {

constexpr std::array<double, CandidateValueNetwork::output_size> loss_weights{{
  1.0 / 3.0, 1.0 / 3.0, 1.0 / 3.0,
}};

double sigmoid(double value) {
  if (value >= 0) {
    const double e = std::exp(-value);
    return 1.0 / (1.0 + e);
  }
  const double e = std::exp(value);
  return e / (1.0 + e);
}

double softplus(double value) {
  return value > 20.0 ? value : value < -20.0 ? std::exp(value) : std::log1p(std::exp(value));
}

double decoded(double log_value) {
  return std::expm1(std::min(log_value, 40.0));
}

std::vector<std::size_t> active_indices(const std::vector<double>& input) {
  std::vector<std::size_t> active;
  active.reserve(input.size() / 4);
  for (std::size_t index = 0; index < input.size(); ++index) {
    if (input[index] != 0.0) active.push_back(index);
  }
  return active;
}

int cell_plane(char cell, FeaturePlane black_plane) {
  const int base = static_cast<int>(black_plane);
  if (cell == 'X') return base;
  if (cell == 'O') return base + 1;
  if (cell == '#') return base + 2;
  return -1;
}

char board_cell(const Board& board, int extent, int x, int y) {
  if (x >= extent || y >= extent) throw std::invalid_argument("point exceeds feature extent");
  return x < board.size && y < board.size
    ? board.columns[static_cast<std::size_t>(x)][static_cast<std::size_t>(y)]
    : '#';
}

}  // namespace

CandidateValueNetwork::CandidateValueNetwork(
  int extent,
  std::size_t hidden,
  std::uint64_t seed,
  int opponent_features,
  bool local_context,
  bool result_board_only,
  bool spatial_board
)
  : extent_(extent),
    opponent_features_(opponent_features),
    input_size_((result_board_only ? 3 : static_cast<int>(FeaturePlane::count))
      * static_cast<std::size_t>(extent * extent) + (result_board_only ? 0 : 2)
      + static_cast<std::size_t>(opponent_features)
      + (local_context ? local_context_size : 0)),
    dense_input_size_(spatial_board
      ? spatial_channels * spatial_pool_extent * spatial_pool_extent
        + static_cast<std::size_t>(opponent_features)
      : input_size_),
    hidden_(hidden),
    head_count_(static_cast<std::size_t>(std::max(opponent_features, 1))),
    local_context_(local_context),
    result_board_only_(result_board_only),
    spatial_board_(spatial_board),
    w1_(hidden * dense_input_size_),
    b1_(hidden),
    w2_(head_count_ * output_size * hidden),
    b2_(head_count_ * output_size),
    convolution_(spatial_board ? spatial_channels * 3 * 3 * 3 : 0),
    convolution_bias_(spatial_board ? spatial_channels : 0) {
  if (local_context_ && result_board_only_) {
    throw std::invalid_argument("local context and result-board-only modes are exclusive");
  }
  if (spatial_board_ && (!result_board_only_ || local_context_)) {
    throw std::invalid_argument("spatial trunk requires result-board-only input");
  }
  if (extent <= 0 || hidden == 0 || opponent_features < 0 || opponent_features > 7) {
    throw std::invalid_argument("invalid network dimensions or opponent feature count");
  }
  std::mt19937_64 random(seed);
  const double first_scale = std::sqrt(2.0 / static_cast<double>(dense_input_size_ + hidden_));
  const double second_scale = std::sqrt(2.0 / static_cast<double>(hidden_ + output_size));
  std::normal_distribution<double> first(0.0, first_scale);
  std::normal_distribution<double> second(0.0, second_scale);
  std::generate(w1_.begin(), w1_.end(), [&] { return first(random); });
  std::generate(w2_.begin(), w2_.end(), [&] { return second(random); });
  std::normal_distribution<double> convolution(0.0, std::sqrt(2.0 / 27.0));
  std::generate(convolution_.begin(), convolution_.end(), [&] { return convolution(random); });
}

std::vector<double> CandidateValueNetwork::flattened(const CandidateFeatures& features) const {
  if (features.extent != extent_
    || features.planes.size() != static_cast<std::size_t>(FeaturePlane::count)
      * static_cast<std::size_t>(extent_ * extent_)
    || (local_context_ && features.local_context.size() != local_context_size)) {
    throw std::invalid_argument("candidate feature shape does not match network");
  }
  if (opponent_features_ > 0 && features.opponent_index >= opponent_features_) {
    throw std::invalid_argument("opponent is outside this network profile");
  }
  std::vector<double> input;
  input.reserve(input_size_);
  if (result_board_only_) {
    const auto area = static_cast<std::size_t>(extent_ * extent_);
    const auto begin = static_cast<std::size_t>(FeaturePlane::after_black) * area;
    for (std::size_t index = begin; index < begin + 3 * area; ++index) {
      input.push_back(features.planes[index]);
    }
  } else {
    for (const float value : features.planes) input.push_back(value);
    input.push_back(features.candidate_pass ? 1.0 : 0.0);
    input.push_back(features.response_pass ? 1.0 : 0.0);
  }
  for (int index = 0; index < opponent_features_; ++index) {
    input.push_back(features.opponent_index == index ? 1.0 : 0.0);
  }
  if (local_context_) for (const float value : features.local_context) input.push_back(value);
  return input;
}

CandidateValueNetwork::EncodedInput CandidateValueNetwork::encoded(
  const CandidateFeatures& features
) const {
  EncodedInput result{.raw = flattened(features)};
  if (!spatial_board_) {
    result.dense = result.raw;
    return result;
  }
  const std::size_t area = static_cast<std::size_t>(extent_ * extent_);
  result.convolution_activation.resize(spatial_channels * area);
  result.pool_counts.assign(spatial_pool_extent * spatial_pool_extent, 0);
  result.dense.assign(dense_input_size_, 0.0);
  for (int x = 0; x < extent_; ++x) for (int y = 0; y < extent_; ++y) {
    const int pool_x = x * spatial_pool_extent / extent_;
    const int pool_y = y * spatial_pool_extent / extent_;
    ++result.pool_counts[static_cast<std::size_t>(pool_x * spatial_pool_extent + pool_y)];
    for (std::size_t channel = 0; channel < spatial_channels; ++channel) {
      double value = convolution_bias_[channel];
      for (int dx = -1; dx <= 1; ++dx) for (int dy = -1; dy <= 1; ++dy) {
        const int nx = x + dx;
        const int ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= extent_ || ny >= extent_) continue;
        const auto point = static_cast<std::size_t>(nx * extent_ + ny);
        for (std::size_t plane = 0; plane < 3; ++plane) {
          const double input = result.raw[plane * area + point];
          if (input == 0.0) continue;
          const auto weight = ((channel * 3 + plane) * 3
            + static_cast<std::size_t>(dx + 1)) * 3 + static_cast<std::size_t>(dy + 1);
          value += convolution_[weight] * input;
        }
      }
      const double activation = std::tanh(value);
      result.convolution_activation[channel * area
        + static_cast<std::size_t>(x * extent_ + y)] = activation;
      const auto pooled = channel * spatial_pool_extent * spatial_pool_extent
        + static_cast<std::size_t>(pool_x * spatial_pool_extent + pool_y);
      result.dense[pooled] += activation;
    }
  }
  for (std::size_t channel = 0; channel < spatial_channels; ++channel) {
    for (std::size_t bin = 0; bin < result.pool_counts.size(); ++bin) {
      result.dense[channel * result.pool_counts.size() + bin]
        /= static_cast<double>(result.pool_counts[bin]);
    }
  }
  const std::size_t opponent_base = spatial_channels * spatial_pool_extent * spatial_pool_extent;
  if (opponent_features_ > 0) {
    result.dense[opponent_base + static_cast<std::size_t>(features.opponent_index)] = 1.0;
  }
  return result;
}

ValuePrediction CandidateValueNetwork::predict(const CandidateFeatures& features) const {
  const auto input = encoded(features).dense;
  const auto active = active_indices(input);
  std::vector<double> hidden(hidden_);
  for (std::size_t h = 0; h < hidden_; ++h) {
    double value = b1_[h];
    const auto offset = h * dense_input_size_;
    for (const std::size_t i : active) value += w1_[offset + i] * input[i];
    hidden[h] = value;
  }
  return decode(std::move(hidden), features.opponent_index);
}

ValuePrediction CandidateValueNetwork::decode(
  std::vector<double> hidden_preactivation,
  int opponent_index
) const {
  for (double& value : hidden_preactivation) value = std::tanh(value);
  const std::size_t head = opponent_features_ > 0
    ? static_cast<std::size_t>(opponent_index) : 0;
  if (head >= head_count_) throw std::invalid_argument("opponent is outside output heads");
  std::array<double, output_size> output{};
  for (std::size_t o = 0; o < output.size(); ++o) {
    double value = b2_[head * output_size + o];
    const auto offset = (head * output_size + o) * hidden_;
    for (std::size_t h = 0; h < hidden_; ++h) {
      value += w2_[offset + h] * hidden_preactivation[h];
    }
    output[o] = o == 0 ? sigmoid(value) : decoded(softplus(value));
  }
  return {
    .win_probability = output[0],
    .terminal_power = output[1],
    .remaining_turns = output[2],
  };
}

PreparedValueInput CandidateValueNetwork::prepare(const Board& before, int opponent_index) const {
  if (before.size > extent_) throw std::invalid_argument("board exceeds feature extent");
  if (opponent_features_ > 0 && (opponent_index < 0 || opponent_index >= opponent_features_)) {
    throw std::invalid_argument("opponent is outside this network profile");
  }
  if (spatial_board_) {
    const auto spatial = encoded(encode_candidate(
      before, Move::pass_turn(), Move::pass_turn(), before, extent_, opponent_index));
    return {.before = before,
      .spatial_dense = spatial.dense,
      .spatial_activation = spatial.convolution_activation,
      .spatial_pool_counts = spatial.pool_counts,
      .opponent_index = opponent_index};
  }
  const auto area = static_cast<std::size_t>(extent_ * extent_);
  const auto scalar = (result_board_only_ ? 3 : static_cast<std::size_t>(FeaturePlane::count)) * area;
  std::vector<double> hidden = b1_;
  for (std::size_t h = 0; h < hidden_; ++h) {
    const auto row = h * input_size_;
    for (int x = 0; x < extent_; ++x) for (int y = 0; y < extent_; ++y) {
      const char cell = board_cell(before, extent_, x, y);
      const auto point = static_cast<std::size_t>(x * extent_ + y);
      const int before_plane = cell_plane(cell, FeaturePlane::before_black);
      const int after_plane = cell_plane(cell, FeaturePlane::after_black);
      if (!result_board_only_ && before_plane >= 0) {
        hidden[h] += w1_[row + static_cast<std::size_t>(before_plane) * area + point];
      }
      const int value_plane = result_board_only_ ? before_plane : after_plane;
      if (value_plane >= 0) {
        hidden[h] += w1_[row + static_cast<std::size_t>(value_plane) * area + point];
      }
    }
    if (opponent_features_ > 0) {
      hidden[h] += w1_[row + scalar + (result_board_only_ ? 0 : 2)
        + static_cast<std::size_t>(opponent_index)];
    }
  }
  return {.before = before, .hidden_preactivation = std::move(hidden), .opponent_index = opponent_index};
}

ValuePrediction CandidateValueNetwork::predict(
  const PreparedValueInput& prepared,
  const Move& candidate,
  const Move& response,
  const Board& after
) const {
  if (spatial_board_) {
    (void)candidate;
    (void)response;
    const std::size_t area = static_cast<std::size_t>(extent_ * extent_);
    const std::size_t bins = spatial_pool_extent * spatial_pool_extent;
    if (prepared.spatial_dense.size() != dense_input_size_
      || prepared.spatial_activation.size() != spatial_channels * area
      || prepared.spatial_pool_counts.size() != bins) {
      throw std::invalid_argument("prepared spatial input does not match network");
    }
    std::vector<unsigned char> affected(area);
    for (int x = 0; x < extent_; ++x) for (int y = 0; y < extent_; ++y) {
      if (board_cell(prepared.before, extent_, x, y) == board_cell(after, extent_, x, y)) continue;
      for (int dx = -1; dx <= 1; ++dx) for (int dy = -1; dy <= 1; ++dy) {
        const int cx = x + dx;
        const int cy = y + dy;
        if (cx >= 0 && cy >= 0 && cx < extent_ && cy < extent_) {
          affected[static_cast<std::size_t>(cx * extent_ + cy)] = 1;
        }
      }
    }
    std::vector<double> dense = prepared.spatial_dense;
    for (int x = 0; x < extent_; ++x) for (int y = 0; y < extent_; ++y) {
      const auto point = static_cast<std::size_t>(x * extent_ + y);
      if (!affected[point]) continue;
      const int pool_x = x * spatial_pool_extent / extent_;
      const int pool_y = y * spatial_pool_extent / extent_;
      const auto bin = static_cast<std::size_t>(pool_x * spatial_pool_extent + pool_y);
      for (std::size_t channel = 0; channel < spatial_channels; ++channel) {
        double value = convolution_bias_[channel];
        for (int dx = -1; dx <= 1; ++dx) for (int dy = -1; dy <= 1; ++dy) {
          const int nx = x + dx;
          const int ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= extent_ || ny >= extent_) continue;
          const char cell = board_cell(after, extent_, nx, ny);
          const int plane = cell == 'X' ? 0 : cell == 'O' ? 1 : cell == '#' ? 2 : -1;
          if (plane < 0) continue;
          const auto weight = ((channel * 3 + static_cast<std::size_t>(plane)) * 3
            + static_cast<std::size_t>(dx + 1)) * 3 + static_cast<std::size_t>(dy + 1);
          value += convolution_[weight];
        }
        const double activation = std::tanh(value);
        dense[channel * bins + bin] += (activation
          - prepared.spatial_activation[channel * area + point])
          / static_cast<double>(prepared.spatial_pool_counts[bin]);
      }
    }
    const auto active = active_indices(dense);
    std::vector<double> hidden(hidden_);
    for (std::size_t h = 0; h < hidden_; ++h) {
      double value = b1_[h];
      const auto offset = h * dense_input_size_;
      for (const std::size_t index : active) value += w1_[offset + index] * dense[index];
      hidden[h] = value;
    }
    return decode(std::move(hidden), prepared.opponent_index);
  }
  if (prepared.hidden_preactivation.size() != hidden_ || prepared.before.size > extent_
    || after.size > extent_) {
    throw std::invalid_argument("prepared candidate shape does not match network");
  }
  const auto area = static_cast<std::size_t>(extent_ * extent_);
  const auto scalar = (result_board_only_ ? 3 : static_cast<std::size_t>(FeaturePlane::count)) * area;
  struct ChangedCell { std::size_t point; int old_plane; int new_plane; };
  std::vector<ChangedCell> changes;
  for (int x = 0; x < extent_; ++x) for (int y = 0; y < extent_; ++y) {
    const char old_cell = board_cell(prepared.before, extent_, x, y);
    const char new_cell = board_cell(after, extent_, x, y);
    if (old_cell == new_cell) continue;
    changes.push_back({
      .point = static_cast<std::size_t>(x * extent_ + y),
      .old_plane = cell_plane(old_cell,
        result_board_only_ ? FeaturePlane::before_black : FeaturePlane::after_black),
      .new_plane = cell_plane(new_cell,
        result_board_only_ ? FeaturePlane::before_black : FeaturePlane::after_black),
    });
  }
  std::vector<double> hidden = prepared.hidden_preactivation;
  const auto context = local_context_
    ? encode_candidate(prepared.before, candidate, response, after, extent_, prepared.opponent_index).local_context
    : std::vector<float>{};
  const std::size_t context_offset = input_size_ - (local_context_ ? local_context_size : 0);
  for (std::size_t h = 0; h < hidden_; ++h) {
    const auto row = h * input_size_;
    if (!result_board_only_) {
      if (candidate.pass) {
        hidden[h] += w1_[row + scalar];
      } else {
        const auto point = static_cast<std::size_t>(candidate.point.x * extent_ + candidate.point.y);
        hidden[h] += w1_[row + static_cast<std::size_t>(FeaturePlane::candidate) * area + point];
      }
      if (response.pass) {
        hidden[h] += w1_[row + scalar + 1];
      } else {
        const auto point = static_cast<std::size_t>(response.point.x * extent_ + response.point.y);
        hidden[h] += w1_[row + static_cast<std::size_t>(FeaturePlane::response) * area + point];
      }
    }
    for (const auto& change : changes) {
      if (change.old_plane >= 0) hidden[h] -= w1_[row
        + static_cast<std::size_t>(change.old_plane) * area + change.point];
      if (change.new_plane >= 0) hidden[h] += w1_[row
        + static_cast<std::size_t>(change.new_plane) * area + change.point];
    }
    for (std::size_t index = 0; index < context.size(); ++index) {
      if (context[index] != 0) hidden[h] += w1_[row + context_offset + index] * context[index];
    }
  }
  return decode(std::move(hidden), prepared.opponent_index);
}

void CandidateValueNetwork::save(std::ostream& output) const {
  output.precision(std::numeric_limits<double>::max_digits10);
  output << (spatial_board_ ? "bitburner-go-value-v7"
      : result_board_only_ ? "bitburner-go-value-v6"
      : local_context_ ? "bitburner-go-value-v5" : "bitburner-go-value-v4")
    << '\n' << extent_ << ' ' << hidden_ << ' '
    << opponent_features_ << '\n';
  const auto write_vector = [&output](const std::vector<double>& values) {
    output << values.size();
    for (const double value : values) output << ' ' << value;
    output << '\n';
  };
  write_vector(w1_);
  write_vector(b1_);
  write_vector(w2_);
  write_vector(b2_);
  if (spatial_board_) {
    write_vector(convolution_);
    write_vector(convolution_bias_);
  }
  if (!output) throw std::runtime_error("failed to write value model");
}

CandidateValueNetwork CandidateValueNetwork::load(std::istream& input) {
  std::string magic;
  int extent = 0;
  int opponent_features = 7;
  std::size_t hidden = 0;
  if (!(input >> magic >> extent >> hidden)
    || (magic != "bitburner-go-value-v2" && magic != "bitburner-go-value-v3"
      && magic != "bitburner-go-value-v4" && magic != "bitburner-go-value-v5"
      && magic != "bitburner-go-value-v6" && magic != "bitburner-go-value-v7")) {
    throw std::runtime_error("invalid value model header");
  }
  if ((magic == "bitburner-go-value-v3" || magic == "bitburner-go-value-v4"
      || magic == "bitburner-go-value-v5" || magic == "bitburner-go-value-v6"
      || magic == "bitburner-go-value-v7")
    && !(input >> opponent_features)) {
    throw std::runtime_error("invalid value model profile");
  }
  CandidateValueNetwork network(extent, hidden, 0, opponent_features,
    magic == "bitburner-go-value-v5",
    magic == "bitburner-go-value-v6" || magic == "bitburner-go-value-v7",
    magic == "bitburner-go-value-v7");
  const auto read_vector = [&input](std::vector<double>& values) {
    std::size_t count = 0;
    if (!(input >> count) || count != values.size()) {
      throw std::runtime_error("invalid value model tensor shape");
    }
    for (double& value : values) {
      if (!(input >> value) || !std::isfinite(value)) {
        throw std::runtime_error("invalid value model weight");
      }
    }
  };
  read_vector(network.w1_);
  read_vector(network.b1_);
  if (magic == "bitburner-go-value-v4" || magic == "bitburner-go-value-v5"
    || magic == "bitburner-go-value-v6" || magic == "bitburner-go-value-v7") {
    read_vector(network.w2_);
    read_vector(network.b2_);
  } else {
    std::vector<double> shared_w2(output_size * hidden);
    std::vector<double> shared_b2(output_size);
    read_vector(shared_w2);
    read_vector(shared_b2);
    for (std::size_t head = 0; head < network.head_count_; ++head) {
      std::copy(shared_w2.begin(), shared_w2.end(),
        network.w2_.begin() + static_cast<std::ptrdiff_t>(head * shared_w2.size()));
      std::copy(shared_b2.begin(), shared_b2.end(),
        network.b2_.begin() + static_cast<std::ptrdiff_t>(head * shared_b2.size()));
    }
  }
  if (magic == "bitburner-go-value-v7") {
    read_vector(network.convolution_);
    read_vector(network.convolution_bias_);
  }
  return network;
}

CandidateValueNetwork CandidateValueNetwork::project_profile(
  const CandidateValueNetwork& source,
  int extent,
  int opponent_features,
  int fixed_opponent
) {
  if (extent > source.extent_ || opponent_features > source.opponent_features_) {
    throw std::invalid_argument("cannot project to a larger model profile");
  }
  if (opponent_features == 0 && source.opponent_features_ > 0
    && (fixed_opponent < 0 || fixed_opponent >= source.opponent_features_)) {
    throw std::invalid_argument("zero-opponent projection requires a valid fixed opponent");
  }
  CandidateValueNetwork target(
    extent, source.hidden_, 0, opponent_features, source.local_context_, source.result_board_only_,
    source.spatial_board_);
  std::fill(target.w1_.begin(), target.w1_.end(), 0.0);
  target.b1_ = source.b1_;
  target.convolution_ = source.convolution_;
  target.convolution_bias_ = source.convolution_bias_;
  for (std::size_t target_head = 0; target_head < target.head_count_; ++target_head) {
    const std::size_t source_head = source.opponent_features_ > 0
      ? static_cast<std::size_t>(opponent_features > 0 ? static_cast<int>(target_head) : fixed_opponent)
      : 0;
    for (std::size_t output = 0; output < output_size; ++output) {
      std::copy_n(source.w2_.begin() + static_cast<std::ptrdiff_t>(
        (source_head * output_size + output) * source.hidden_), source.hidden_,
        target.w2_.begin() + static_cast<std::ptrdiff_t>(
          (target_head * output_size + output) * target.hidden_));
      target.b2_[target_head * output_size + output]
        = source.b2_[source_head * output_size + output];
    }
  }
  const std::size_t source_area = static_cast<std::size_t>(source.extent_ * source.extent_);
  const std::size_t target_area = static_cast<std::size_t>(extent * extent);
  if (source.spatial_board_) {
    if (extent != source.extent_) {
      throw std::invalid_argument("cannot change the extent of a spatial model projection");
    }
    for (std::size_t hidden = 0; hidden < source.hidden_; ++hidden) {
      const std::size_t source_row = hidden * source.dense_input_size_;
      const std::size_t target_row = hidden * target.dense_input_size_;
      const std::size_t pooled = spatial_channels * spatial_pool_extent * spatial_pool_extent;
      std::copy_n(source.w1_.begin() + static_cast<std::ptrdiff_t>(source_row), pooled,
        target.w1_.begin() + static_cast<std::ptrdiff_t>(target_row));
      if (opponent_features > 0) for (int opponent = 0; opponent < opponent_features; ++opponent) {
        target.w1_[target_row + pooled + static_cast<std::size_t>(opponent)]
          = source.w1_[source_row + pooled + static_cast<std::size_t>(opponent)];
      }
    }
    return target;
  }
  if (source.result_board_only_) {
    for (std::size_t hidden = 0; hidden < source.hidden_; ++hidden) {
      const std::size_t source_row = hidden * source.input_size_;
      const std::size_t target_row = hidden * target.input_size_;
      for (std::size_t plane = 0; plane < 3; ++plane) {
        for (int x = 0; x < extent; ++x) for (int y = 0; y < extent; ++y) {
          target.w1_[target_row + plane * target_area + static_cast<std::size_t>(x * extent + y)]
            = source.w1_[source_row + plane * source_area
              + static_cast<std::size_t>(x * source.extent_ + y)];
        }
      }
      if (opponent_features > 0) for (int opponent = 0; opponent < opponent_features; ++opponent) {
        target.w1_[target_row + 3 * target_area + static_cast<std::size_t>(opponent)]
          = source.w1_[source_row + 3 * source_area + static_cast<std::size_t>(opponent)];
      }
    }
    return target;
  }
  const std::size_t source_scalar = static_cast<std::size_t>(FeaturePlane::count) * source_area;
  const std::size_t target_scalar = static_cast<std::size_t>(FeaturePlane::count) * target_area;
  for (std::size_t hidden = 0; hidden < source.hidden_; ++hidden) {
    const std::size_t source_row = hidden * source.input_size_;
    const std::size_t target_row = hidden * target.input_size_;
    for (std::size_t plane = 0; plane < static_cast<std::size_t>(FeaturePlane::count); ++plane) {
      for (int x = 0; x < extent; ++x) for (int y = 0; y < extent; ++y) {
        const std::size_t source_index = plane * source_area
          + static_cast<std::size_t>(x * source.extent_ + y);
        const std::size_t target_index = plane * target_area
          + static_cast<std::size_t>(x * extent + y);
        target.w1_[target_row + target_index] = source.w1_[source_row + source_index];
      }
    }
    // Padding outside the smaller extent is always active in both unplayable
    // planes, so preserve its exact contribution as a hidden bias.
    for (int x = 0; x < source.extent_; ++x) for (int y = 0; y < source.extent_; ++y) {
      if (x < extent && y < extent) continue;
      const std::size_t point = static_cast<std::size_t>(x * source.extent_ + y);
      target.b1_[hidden] += source.w1_[source_row
        + static_cast<std::size_t>(FeaturePlane::before_unplayable) * source_area + point];
      target.b1_[hidden] += source.w1_[source_row
        + static_cast<std::size_t>(FeaturePlane::after_unplayable) * source_area + point];
    }
    target.w1_[target_row + target_scalar] = source.w1_[source_row + source_scalar];
    target.w1_[target_row + target_scalar + 1] = source.w1_[source_row + source_scalar + 1];
    if (opponent_features > 0) {
      for (int opponent = 0; opponent < opponent_features; ++opponent) {
        target.w1_[target_row + target_scalar + 2 + static_cast<std::size_t>(opponent)]
          = source.w1_[source_row + source_scalar + 2 + static_cast<std::size_t>(opponent)];
      }
    } else if (source.opponent_features_ > 0) {
      target.b1_[hidden] += source.w1_[source_row + source_scalar + 2
        + static_cast<std::size_t>(fixed_opponent)];
    }
    if (source.local_context_) {
      const std::size_t source_context = source.input_size_ - local_context_size;
      const std::size_t target_context = target.input_size_ - local_context_size;
      std::copy_n(source.w1_.begin() + static_cast<std::ptrdiff_t>(source_row + source_context),
        local_context_size, target.w1_.begin() + static_cast<std::ptrdiff_t>(target_row + target_context));
    }
  }
  return target;
}

CandidateValueNetwork CandidateValueNetwork::widen(
  const CandidateValueNetwork& source,
  std::size_t hidden,
  std::uint64_t seed,
  double symmetry_break
) {
  if (hidden < source.hidden_ || !std::isfinite(symmetry_break) || symmetry_break < 0) {
    throw std::invalid_argument("widening requires at least the source width and finite nonnegative noise");
  }
  CandidateValueNetwork target(source.extent_, hidden, seed, source.opponent_features_,
    source.local_context_, source.result_board_only_, source.spatial_board_);
  target.convolution_ = source.convolution_;
  target.convolution_bias_ = source.convolution_bias_;
  std::vector<std::size_t> copies(source.hidden_, 0);
  for (std::size_t h = 0; h < hidden; ++h) copies[h % source.hidden_]++;
  for (std::size_t h = 0; h < hidden; ++h) {
    const std::size_t original = h % source.hidden_;
    std::copy_n(source.w1_.begin() + static_cast<std::ptrdiff_t>(original * source.dense_input_size_),
      source.dense_input_size_, target.w1_.begin() + static_cast<std::ptrdiff_t>(h * target.dense_input_size_));
    target.b1_[h] = source.b1_[original];
  }
  std::mt19937_64 random(seed);
  std::normal_distribution<double> noise(0, symmetry_break);
  for (std::size_t head = 0; head < source.head_count_; ++head) {
    for (std::size_t output = 0; output < output_size; ++output) {
      for (std::size_t original = 0; original < source.hidden_; ++original) {
        double noise_sum = 0;
        std::size_t emitted = 0;
        for (std::size_t h = original; h < hidden; h += source.hidden_) {
          const double perturbation = ++emitted == copies[original] ? -noise_sum : noise(random);
          noise_sum += perturbation;
          target.w2_[(head * output_size + output) * hidden + h]
            = source.w2_[(head * output_size + output) * source.hidden_ + original]
              / static_cast<double>(copies[original]) + perturbation;
        }
      }
      target.b2_[head * output_size + output] = source.b2_[head * output_size + output];
    }
  }
  return target;
}

CandidateValueNetwork CandidateValueNetwork::with_local_context(
  const CandidateValueNetwork& source
) {
  if (source.spatial_board_) {
    throw std::invalid_argument("cannot add candidate-local context to a spatial board model");
  }
  if (source.local_context_) return source;
  CandidateValueNetwork target(
    source.extent_, source.hidden_, 0, source.opponent_features_, true);
  std::fill(target.w1_.begin(), target.w1_.end(), 0.0);
  target.b1_ = source.b1_;
  target.w2_ = source.w2_;
  target.b2_ = source.b2_;
  for (std::size_t h = 0; h < source.hidden_; ++h) {
    std::copy_n(source.w1_.begin() + static_cast<std::ptrdiff_t>(h * source.input_size_),
      source.input_size_, target.w1_.begin() + static_cast<std::ptrdiff_t>(h * target.input_size_));
  }
  return target;
}

CandidateValueNetwork CandidateValueNetwork::with_result_board_only(
  const CandidateValueNetwork& source
) {
  if (source.result_board_only_) return source;
  CandidateValueNetwork target(
    source.extent_, source.hidden_, 0, source.opponent_features_, false, true);
  std::fill(target.w1_.begin(), target.w1_.end(), 0.0);
  target.b1_ = source.b1_;
  target.w2_ = source.w2_;
  target.b2_ = source.b2_;
  const std::size_t area = static_cast<std::size_t>(source.extent_ * source.extent_);
  const std::size_t source_scalar = static_cast<std::size_t>(FeaturePlane::count) * area;
  for (std::size_t hidden = 0; hidden < source.hidden_; ++hidden) {
    const std::size_t source_row = hidden * source.input_size_;
    const std::size_t target_row = hidden * target.input_size_;
    for (std::size_t plane = 0; plane < 3; ++plane) {
      const std::size_t source_plane = static_cast<std::size_t>(FeaturePlane::after_black) + plane;
      std::copy_n(source.w1_.begin() + static_cast<std::ptrdiff_t>(source_row + source_plane * area),
        area, target.w1_.begin() + static_cast<std::ptrdiff_t>(target_row + plane * area));
    }
    for (int opponent = 0; opponent < source.opponent_features_; ++opponent) {
      target.w1_[target_row + 3 * area + static_cast<std::size_t>(opponent)]
        = source.w1_[source_row + source_scalar + 2 + static_cast<std::size_t>(opponent)];
    }
  }
  return target;
}

double CandidateValueNetwork::train_batch(
  std::span<const TrainingExample> examples,
  double learning_rate,
  std::size_t thread_count,
  bool freeze_trunk
) {
  if (examples.empty()) return 0;
  struct Gradients {
    std::vector<double> dw1;
    std::vector<double> db1;
    std::vector<double> dw2;
    std::vector<double> db2;
    std::vector<double> dconvolution;
    std::vector<double> dconvolution_bias;
    double loss{};
  };
  const std::size_t workers = std::max<std::size_t>(1, std::min(thread_count, examples.size()));
  std::vector<Gradients> partial;
  partial.reserve(workers);
  for (std::size_t worker = 0; worker < workers; ++worker) {
    partial.push_back({
      .dw1 = std::vector<double>(w1_.size()),
      .db1 = std::vector<double>(b1_.size()),
      .dw2 = std::vector<double>(w2_.size()),
      .db2 = std::vector<double>(b2_.size()),
      .dconvolution = std::vector<double>(convolution_.size()),
      .dconvolution_bias = std::vector<double>(convolution_bias_.size()),
    });
  }
  const auto train_range = [this, examples, &partial](std::size_t worker, std::size_t begin, std::size_t end) {
    auto& gradients = partial[worker];
    for (std::size_t example_index = begin; example_index < end; ++example_index) {
    const auto& example = examples[example_index];
    const auto encoding = encoded(example.features);
    const auto& input = encoding.dense;
    const auto active = active_indices(input);
    std::vector<double> dense_gradient(spatial_board_ ? dense_input_size_ : 0);
    std::vector<double> hidden(hidden_);
    for (std::size_t h = 0; h < hidden_; ++h) {
      double value = b1_[h];
      const auto offset = h * dense_input_size_;
      for (const std::size_t i : active) value += w1_[offset + i] * input[i];
      hidden[h] = std::tanh(value);
    }
    std::array<double, output_size> raw{};
    std::array<double, output_size> log_prediction{};
    const std::array<double, output_size> target{
      std::clamp(example.target.win_probability, 0.0, 1.0),
      std::max(0.0, example.target.terminal_power),
      std::max(0.0, example.target.remaining_turns),
    };
    const std::size_t head = opponent_features_ > 0
      ? static_cast<std::size_t>(example.features.opponent_index) : 0;
    const std::size_t output_base = head * output_size;
    std::array<double, output_size> draw{};
    for (std::size_t o = 0; o < raw.size(); ++o) {
      double value = b2_[output_base + o];
      const auto offset = (output_base + o) * hidden_;
      for (std::size_t h = 0; h < hidden_; ++h) value += w2_[offset + h] * hidden[h];
      raw[o] = value;
      if (o == 0) {
        const double probability = sigmoid(value);
        gradients.loss += -(target[o] * std::log(std::max(probability, 1e-12))
          + (1.0 - target[o]) * std::log(std::max(1.0 - probability, 1e-12))) * loss_weights[o];
        draw[o] = (probability - target[o]) * loss_weights[o];
      } else {
        log_prediction[o] = softplus(value);
        const double difference = log_prediction[o] - std::log1p(target[o]);
        gradients.loss += difference * difference * loss_weights[o];
        draw[o] = 2.0 * difference * loss_weights[o] * sigmoid(value);
      }
      gradients.db2[output_base + o] += draw[o];
      for (std::size_t h = 0; h < hidden_; ++h) gradients.dw2[offset + h] += draw[o] * hidden[h];
    }
    for (std::size_t h = 0; h < hidden_; ++h) {
      double dh = 0;
      for (std::size_t o = 0; o < draw.size(); ++o) {
        dh += w2_[(output_base + o) * hidden_ + h] * draw[o];
      }
      const double dz = dh * (1.0 - hidden[h] * hidden[h]);
      gradients.db1[h] += dz;
      const auto offset = h * dense_input_size_;
      for (const std::size_t i : active) {
        gradients.dw1[offset + i] += dz * input[i];
        if (spatial_board_) dense_gradient[i] += w1_[offset + i] * dz;
      }
    }
    if (spatial_board_) {
      const std::size_t area = static_cast<std::size_t>(extent_ * extent_);
      const std::size_t bins = spatial_pool_extent * spatial_pool_extent;
      for (int x = 0; x < extent_; ++x) for (int y = 0; y < extent_; ++y) {
        const int pool_x = x * spatial_pool_extent / extent_;
        const int pool_y = y * spatial_pool_extent / extent_;
        const auto bin = static_cast<std::size_t>(pool_x * spatial_pool_extent + pool_y);
        const auto point = static_cast<std::size_t>(x * extent_ + y);
        for (std::size_t channel = 0; channel < spatial_channels; ++channel) {
          const double activation = encoding.convolution_activation[channel * area + point];
          const double dz = dense_gradient[channel * bins + bin]
            / static_cast<double>(encoding.pool_counts[bin]) * (1.0 - activation * activation);
          gradients.dconvolution_bias[channel] += dz;
          for (int dx = -1; dx <= 1; ++dx) for (int dy = -1; dy <= 1; ++dy) {
            const int nx = x + dx;
            const int ny = y + dy;
            if (nx < 0 || ny < 0 || nx >= extent_ || ny >= extent_) continue;
            const auto neighbor = static_cast<std::size_t>(nx * extent_ + ny);
            for (std::size_t plane = 0; plane < 3; ++plane) {
              const double raw = encoding.raw[plane * area + neighbor];
              if (raw == 0.0) continue;
              const auto weight = ((channel * 3 + plane) * 3
                + static_cast<std::size_t>(dx + 1)) * 3 + static_cast<std::size_t>(dy + 1);
              gradients.dconvolution[weight] += dz * raw;
            }
          }
        }
      }
    }
    }
  };
  std::vector<std::thread> threads;
  threads.reserve(workers > 1 ? workers : 0);
  for (std::size_t worker = 0; worker < workers; ++worker) {
    const std::size_t begin = examples.size() * worker / workers;
    const std::size_t end = examples.size() * (worker + 1) / workers;
    if (workers == 1) train_range(worker, begin, end);
    else threads.emplace_back(train_range, worker, begin, end);
  }
  for (auto& thread : threads) thread.join();
  auto& total = partial.front();
  for (std::size_t worker = 1; worker < workers; ++worker) {
    total.loss += partial[worker].loss;
    for (std::size_t i = 0; i < total.dw1.size(); ++i) total.dw1[i] += partial[worker].dw1[i];
    for (std::size_t i = 0; i < total.db1.size(); ++i) total.db1[i] += partial[worker].db1[i];
    for (std::size_t i = 0; i < total.dw2.size(); ++i) total.dw2[i] += partial[worker].dw2[i];
    for (std::size_t i = 0; i < total.db2.size(); ++i) total.db2[i] += partial[worker].db2[i];
    for (std::size_t i = 0; i < total.dconvolution.size(); ++i) {
      total.dconvolution[i] += partial[worker].dconvolution[i];
    }
    for (std::size_t i = 0; i < total.dconvolution_bias.size(); ++i) {
      total.dconvolution_bias[i] += partial[worker].dconvolution_bias[i];
    }
  }
  const double scale = learning_rate / static_cast<double>(examples.size());
  if (!freeze_trunk) {
    for (std::size_t i = 0; i < w1_.size(); ++i) w1_[i] -= scale * total.dw1[i];
    for (std::size_t i = 0; i < b1_.size(); ++i) b1_[i] -= scale * total.db1[i];
    for (std::size_t i = 0; i < convolution_.size(); ++i) {
      convolution_[i] -= scale * total.dconvolution[i];
    }
    for (std::size_t i = 0; i < convolution_bias_.size(); ++i) {
      convolution_bias_[i] -= scale * total.dconvolution_bias[i];
    }
  }
  for (std::size_t i = 0; i < w2_.size(); ++i) w2_[i] -= scale * total.dw2[i];
  for (std::size_t i = 0; i < b2_.size(); ++i) b2_[i] -= scale * total.db2[i];
  return total.loss / static_cast<double>(examples.size());
}

double CandidateValueNetwork::train_ranking_batch(
  std::span<const CandidateRankingGroup> groups,
  double learning_rate,
  std::size_t thread_count,
  bool freeze_trunk
) {
  if (groups.empty()) return 0;
  struct Gradients {
    std::vector<double> dw1;
    std::vector<double> db1;
    std::vector<double> dw2;
    std::vector<double> db2;
    std::vector<double> dconvolution;
    std::vector<double> dconvolution_bias;
    double loss{};
  };
  const std::size_t workers = std::max<std::size_t>(1, std::min(thread_count, groups.size()));
  std::vector<Gradients> partial;
  partial.reserve(workers);
  for (std::size_t worker = 0; worker < workers; ++worker) {
    partial.push_back({
      .dw1 = std::vector<double>(w1_.size()),
      .db1 = std::vector<double>(b1_.size()),
      .dw2 = std::vector<double>(w2_.size()),
      .db2 = std::vector<double>(b2_.size()),
      .dconvolution = std::vector<double>(convolution_.size()),
      .dconvolution_bias = std::vector<double>(convolution_bias_.size()),
    });
  }
  const auto train_range = [this, groups, &partial](
    std::size_t worker,
    std::size_t begin,
    std::size_t end
  ) {
    auto& gradients = partial[worker];
    for (std::size_t group_index = begin; group_index < end; ++group_index) {
      const auto& group = groups[group_index];
      if (group.candidates.empty() || group.preferred_index >= group.candidates.size()) {
        throw std::invalid_argument("invalid candidate ranking group");
      }
      struct Forward {
        EncodedInput encoding;
        std::vector<std::size_t> active;
        std::vector<double> hidden;
        double logit{};
        std::size_t head{};
      };
      std::vector<Forward> forwards;
      forwards.reserve(group.candidates.size());
      double maximum = -std::numeric_limits<double>::infinity();
      for (const CandidateFeatures* features : group.candidates) {
        if (!features) throw std::invalid_argument("null candidate in ranking group");
        Forward forward;
        forward.encoding = encoded(*features);
        forward.active = active_indices(forward.encoding.dense);
        forward.hidden.resize(hidden_);
        for (std::size_t h = 0; h < hidden_; ++h) {
          double value = b1_[h];
          const auto offset = h * dense_input_size_;
          for (const std::size_t i : forward.active) {
            value += w1_[offset + i] * forward.encoding.dense[i];
          }
          forward.hidden[h] = std::tanh(value);
        }
        forward.head = opponent_features_ > 0
          ? static_cast<std::size_t>(features->opponent_index) : 0;
        const std::size_t output = forward.head * output_size;
        forward.logit = b2_[output];
        const auto offset = output * hidden_;
        for (std::size_t h = 0; h < hidden_; ++h) {
          forward.logit += w2_[offset + h] * forward.hidden[h];
        }
        maximum = std::max(maximum, forward.logit);
        forwards.push_back(std::move(forward));
      }
      double denominator = 0;
      for (const auto& forward : forwards) denominator += std::exp(forward.logit - maximum);
      const double preferred_probability = std::exp(
        forwards[group.preferred_index].logit - maximum
      ) / denominator;
      gradients.loss -= std::log(std::max(preferred_probability, 1e-12));
      for (std::size_t candidate = 0; candidate < forwards.size(); ++candidate) {
        const auto& forward = forwards[candidate];
        const double probability = std::exp(forward.logit - maximum) / denominator;
        const double draw = probability - static_cast<double>(candidate == group.preferred_index);
        const std::size_t output = forward.head * output_size;
        const auto output_offset = output * hidden_;
        std::vector<double> dense_gradient(spatial_board_ ? dense_input_size_ : 0);
        gradients.db2[output] += draw;
        for (std::size_t h = 0; h < hidden_; ++h) {
          gradients.dw2[output_offset + h] += draw * forward.hidden[h];
          const double dz = w2_[output_offset + h] * draw
            * (1.0 - forward.hidden[h] * forward.hidden[h]);
          gradients.db1[h] += dz;
          const auto input_offset = h * dense_input_size_;
          for (const std::size_t i : forward.active) {
            gradients.dw1[input_offset + i] += dz * forward.encoding.dense[i];
            if (spatial_board_) dense_gradient[i] += w1_[input_offset + i] * dz;
          }
        }
        if (spatial_board_) {
          const std::size_t area = static_cast<std::size_t>(extent_ * extent_);
          const std::size_t bins = spatial_pool_extent * spatial_pool_extent;
          for (int x = 0; x < extent_; ++x) for (int y = 0; y < extent_; ++y) {
            const int pool_x = x * spatial_pool_extent / extent_;
            const int pool_y = y * spatial_pool_extent / extent_;
            const auto bin = static_cast<std::size_t>(pool_x * spatial_pool_extent + pool_y);
            const auto point = static_cast<std::size_t>(x * extent_ + y);
            for (std::size_t channel = 0; channel < spatial_channels; ++channel) {
              const double activation = forward.encoding.convolution_activation[channel * area + point];
              const double dz = dense_gradient[channel * bins + bin]
                / static_cast<double>(forward.encoding.pool_counts[bin])
                * (1.0 - activation * activation);
              gradients.dconvolution_bias[channel] += dz;
              for (int dx = -1; dx <= 1; ++dx) for (int dy = -1; dy <= 1; ++dy) {
                const int nx = x + dx;
                const int ny = y + dy;
                if (nx < 0 || ny < 0 || nx >= extent_ || ny >= extent_) continue;
                const auto neighbor = static_cast<std::size_t>(nx * extent_ + ny);
                for (std::size_t plane = 0; plane < 3; ++plane) {
                  const double raw = forward.encoding.raw[plane * area + neighbor];
                  if (raw == 0.0) continue;
                  const auto weight = ((channel * 3 + plane) * 3
                    + static_cast<std::size_t>(dx + 1)) * 3 + static_cast<std::size_t>(dy + 1);
                  gradients.dconvolution[weight] += dz * raw;
                }
              }
            }
          }
        }
      }
    }
  };
  std::vector<std::thread> threads;
  threads.reserve(workers > 1 ? workers : 0);
  for (std::size_t worker = 0; worker < workers; ++worker) {
    const std::size_t begin = groups.size() * worker / workers;
    const std::size_t end = groups.size() * (worker + 1) / workers;
    if (workers == 1) train_range(worker, begin, end);
    else threads.emplace_back(train_range, worker, begin, end);
  }
  for (auto& thread : threads) thread.join();
  auto& total = partial.front();
  for (std::size_t worker = 1; worker < workers; ++worker) {
    total.loss += partial[worker].loss;
    for (std::size_t i = 0; i < total.dw1.size(); ++i) total.dw1[i] += partial[worker].dw1[i];
    for (std::size_t i = 0; i < total.db1.size(); ++i) total.db1[i] += partial[worker].db1[i];
    for (std::size_t i = 0; i < total.dw2.size(); ++i) total.dw2[i] += partial[worker].dw2[i];
    for (std::size_t i = 0; i < total.db2.size(); ++i) total.db2[i] += partial[worker].db2[i];
    for (std::size_t i = 0; i < total.dconvolution.size(); ++i) {
      total.dconvolution[i] += partial[worker].dconvolution[i];
    }
    for (std::size_t i = 0; i < total.dconvolution_bias.size(); ++i) {
      total.dconvolution_bias[i] += partial[worker].dconvolution_bias[i];
    }
  }
  const double scale = learning_rate / static_cast<double>(groups.size());
  if (!freeze_trunk) {
    for (std::size_t i = 0; i < w1_.size(); ++i) w1_[i] -= scale * total.dw1[i];
    for (std::size_t i = 0; i < b1_.size(); ++i) b1_[i] -= scale * total.db1[i];
    for (std::size_t i = 0; i < convolution_.size(); ++i) {
      convolution_[i] -= scale * total.dconvolution[i];
    }
    for (std::size_t i = 0; i < convolution_bias_.size(); ++i) {
      convolution_bias_[i] -= scale * total.dconvolution_bias[i];
    }
  }
  for (std::size_t i = 0; i < w2_.size(); ++i) w2_[i] -= scale * total.dw2[i];
  for (std::size_t i = 0; i < b2_.size(); ++i) b2_[i] -= scale * total.db2[i];
  return total.loss / static_cast<double>(groups.size());
}

double expected_training_power_per_turn(
  const ValuePrediction& prediction,
  int elapsed_rounds
) {
  return prediction.terminal_power
    / std::max(elapsed_rounds + prediction.remaining_turns, 1e-6);
}

}  // namespace bitburner::go
