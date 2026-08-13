#pragma once

#include "go/opponent.hpp"
#include "go/value.hpp"

#include <array>
#include <cstddef>
#include <cstdint>
#include <iosfwd>
#include <vector>

namespace bitburner::go {

struct V9Input {
  Board board;
  std::vector<float> legal_black;
  float consecutive_passes{};
  float elapsed_fraction{};
  float response_pass{};
  float response_no_op{};
  std::vector<float> behavior;
};

struct V9Prediction {
  ValuePrediction value;
  /** Intersection order followed by pass. */
  std::vector<double> move_logits;
  /** Same candidate order as move_logits; thirteen semantic White branches. */
  std::vector<std::array<double, reply_branch_count>> branch_logits;
};

/** Breaking V9 reference topology. Training lives in PyTorch; this dependency-
 * free implementation is the serialization and numerical-parity oracle. */
class GoNetworkV9 {
 public:
  static constexpr std::size_t input_channels = 8;
  static constexpr int pool_extent = 5;

  static GoNetworkV9 create(
    int extent,
    std::size_t channels,
    std::size_t residual_blocks,
    std::size_t value_hidden,
    std::size_t value_tower,
    std::size_t behavior_features,
    std::uint64_t seed
  );
  static GoNetworkV9 load(std::istream& input);
  void save(std::ostream& output) const;
  [[nodiscard]] V9Prediction predict(const V9Input& input) const;

  [[nodiscard]] int extent() const { return extent_; }
  [[nodiscard]] std::size_t channels() const { return channels_; }
  [[nodiscard]] std::size_t residual_blocks() const { return residual_blocks_; }
  [[nodiscard]] std::size_t value_hidden() const { return value_hidden_; }
  [[nodiscard]] std::size_t value_tower() const { return value_tower_; }
  [[nodiscard]] std::size_t behavior_features() const { return behavior_features_; }

 private:
  int extent_{};
  std::size_t channels_{};
  std::size_t residual_blocks_{};
  std::size_t value_hidden_{};
  std::size_t value_tower_{};
  std::size_t behavior_features_{};

  std::vector<double> stem_, stem_bias_, residual_, residual_bias_;
  std::vector<double> conditioning_w_, conditioning_b_;
  std::vector<double> value_w1_, value_b1_, value_w2_, value_b2_, value_out_w_, value_out_b_;
  std::vector<double> policy_w_, policy_b_, pass_w_, pass_b_;
  std::vector<double> branch_w_, branch_b_, pass_branch_w_, pass_branch_b_;
};

}  // namespace bitburner::go
