#pragma once

#include "go/features.hpp"

#include <array>
#include <cstddef>
#include <cstdint>
#include <iosfwd>
#include <random>
#include <span>
#include <string_view>
#include <vector>

namespace bitburner::go {

struct ValuePrediction {
  double win_probability{};
  double terminal_power{};
  double remaining_turns{};
};

struct ValueTarget {
  double win_probability{};
  double terminal_power{};
  double remaining_turns{};
};

struct TrainingExample {
  CandidateFeatures features;
  ValueTarget target;
};

// A position-local policy target. Every candidate is evaluated against the
// same board and known immediate opponent response; preferred_index is either
// the frozen teacher's action or the best observed rollout action.
struct CandidateRankingGroup {
  std::vector<const CandidateFeatures*> candidates;
  std::size_t preferred_index{};
};

struct PreparedValueInput {
  Board before;
  std::vector<double> hidden_preactivation;
  std::vector<double> spatial_dense;
  std::vector<double> spatial_activation;
  std::vector<int> spatial_pool_counts;
  int opponent_index{};
};

// Dependency-free reference network. The first trainer deliberately favors a
// small reproducible CPU implementation; a Metal/MLX backend can replace its
// batched kernels without changing the feature or artifact contracts.
class CandidateValueNetwork {
 public:
  static constexpr std::size_t output_size = 3;

  CandidateValueNetwork(
    int extent,
    std::size_t hidden,
    std::uint64_t seed,
    int opponent_features = 7,
    bool local_context = false,
    bool result_board_only = false,
    bool spatial_board = false
  );

  [[nodiscard]] ValuePrediction predict(const CandidateFeatures& features) const;
  [[nodiscard]] PreparedValueInput prepare(
    const Board& before,
    int opponent_index = 0
  ) const;
  [[nodiscard]] ValuePrediction predict(
    const PreparedValueInput& prepared,
    const Move& candidate,
    const Move& response,
    const Board& after
  ) const;
  [[nodiscard]] double train_batch(
    std::span<const TrainingExample> examples,
    double learning_rate,
    std::size_t thread_count = 1,
    bool freeze_trunk = false
  );
  [[nodiscard]] double train_ranking_batch(
    std::span<const CandidateRankingGroup> groups,
    double learning_rate,
    std::size_t thread_count = 1,
    bool freeze_trunk = false
  );
  void save(std::ostream& output) const;
  [[nodiscard]] static CandidateValueNetwork load(std::istream& input);
  [[nodiscard]] static CandidateValueNetwork project_profile(
    const CandidateValueNetwork& source,
    int extent,
    int opponent_features,
    int fixed_opponent = -1
  );
  [[nodiscard]] static CandidateValueNetwork widen(
    const CandidateValueNetwork& source,
    std::size_t hidden,
    std::uint64_t seed,
    double symmetry_break = 1e-4
  );
  [[nodiscard]] static CandidateValueNetwork with_local_context(
    const CandidateValueNetwork& source
  );
  [[nodiscard]] static CandidateValueNetwork with_result_board_only(
    const CandidateValueNetwork& source
  );
  [[nodiscard]] int extent() const { return extent_; }
  [[nodiscard]] int opponent_features() const { return opponent_features_; }
  [[nodiscard]] std::size_t input_size() const { return input_size_; }
  [[nodiscard]] std::size_t hidden() const { return hidden_; }
  [[nodiscard]] bool uses_local_context() const { return local_context_; }
  [[nodiscard]] bool result_board_only() const { return result_board_only_; }
  [[nodiscard]] bool spatial_board() const { return spatial_board_; }

 private:
  int extent_{};
  int opponent_features_{};
  std::size_t input_size_{};
  std::size_t dense_input_size_{};
  std::size_t hidden_{};
  std::size_t head_count_{};
  bool local_context_{};
  bool result_board_only_{};
  bool spatial_board_{};
  static constexpr std::size_t spatial_channels = 8;
  static constexpr int spatial_pool_extent = 5;
  std::vector<double> w1_;
  std::vector<double> b1_;
  std::vector<double> w2_;
  std::vector<double> b2_;
  std::vector<double> convolution_;
  std::vector<double> convolution_bias_;

  struct EncodedInput {
    std::vector<double> raw;
    std::vector<double> dense;
    std::vector<double> convolution_activation;
    std::vector<int> pool_counts;
  };

  [[nodiscard]] std::vector<double> flattened(const CandidateFeatures& features) const;
  [[nodiscard]] EncodedInput encoded(const CandidateFeatures& features) const;
  [[nodiscard]] ValuePrediction decode(
    std::vector<double> hidden_preactivation,
    int opponent_index
  ) const;
};

double expected_training_power_per_turn(
  const ValuePrediction& prediction,
  int elapsed_rounds = 0
);

}  // namespace bitburner::go
