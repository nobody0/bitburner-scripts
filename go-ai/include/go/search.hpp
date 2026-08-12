#pragma once

#include "go/features.hpp"
#include "go/network.hpp"
#include "go/opponent.hpp"
#include "go/state.hpp"

#include <cstddef>
#include <cstdint>
#include <random>
#include <string>
#include <unordered_map>
#include <vector>

namespace bitburner::go {

struct EdgeStatistics {
  std::uint64_t visits{};
  double wins{};
  double utility_sum{};
  double terminal_power_sum{};
  double remaining_rounds_sum{};
  double best_utility{-1e300};
};

struct SearchConfig {
  int simulations{96};
  int tree_depth{12};
  double exploration{1.4};
  std::size_t graph_capacity{500'000};
  int feature_extent{19};
  // Root decisions always rate every legal move. Deeper hypothetical turns
  // retain only this many cheaply ordered moves before running the expensive
  // fixed-opponent forecast.
  int branch_width{32};
  // Root shortlist for the offline search teacher. Values at or above the
  // number of legal moves are exhaustive (always true on 5x5).
  int root_search_width{32};
  // Random continuation rounds after the explicit tree. Zero evaluates the
  // reached board directly, which is both less noisy and far cheaper on 19x19.
  int rollout_depth{0};
};

struct SearchTrainingTarget {
  Move move{Move::pass_turn()};
  CandidateFeatures features;
  ValueTarget target;
  double mean_utility{};
  std::uint64_t visits{};
};

struct SearchDecision {
  Move move{Move::pass_turn()};
  ReplyForecast known_replies;
  std::vector<SearchTrainingTarget> targets;
};

class SearchGraph {
 public:
  explicit SearchGraph(SearchConfig config = {});

  SearchDecision search(
    const Position& position,
    Opponent opponent,
    double current_reply_seed,
    int elapsed_rounds,
    std::mt19937_64& random
  );

  [[nodiscard]] std::size_t edge_count() const { return edges_.size(); }
  [[nodiscard]] const SearchConfig& config() const { return config_; }

 private:
  SearchConfig config_;
  std::unordered_map<std::string, EdgeStatistics> edges_;
};

// Exact transition helper shared by self-play and tests.
void apply_to_position(Position& position, Move move, Stone player);

}  // namespace bitburner::go
