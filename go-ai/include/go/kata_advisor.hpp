#pragma once

#include "go/state.hpp"

#include <memory>
#include <optional>
#include <string>
#include <vector>

namespace bitburner::go {

struct KataCandidate {
  Move move{Move::pass_turn()};
  Move predicted_white{Move::pass_turn()};
  Board after;
  std::optional<Score> exact_score;
  std::optional<int> exact_remaining_rounds;
};

struct KataAdvice {
  Move selected{Move::pass_turn()};
  std::vector<Move> ranked;
};

struct KataAdvisorConfig {
  std::string worker;
  std::string binary;
  std::string model;
  std::string analysis_config;
  std::string mode;
  int visits{};
  int policy_visits{};
  int candidates{};
};

// A single persistent Bun/KataGo process is shared by population workers. The
// client serializes requests because the analysis engine owns one command
// stream; native teacher and champion episodes remain parallel.
class KataAdvisorClient {
 public:
  explicit KataAdvisorClient(KataAdvisorConfig config);
  ~KataAdvisorClient();

  KataAdvisorClient(const KataAdvisorClient&) = delete;
  KataAdvisorClient& operator=(const KataAdvisorClient&) = delete;
  KataAdvisorClient(KataAdvisorClient&&) = delete;
  KataAdvisorClient& operator=(KataAdvisorClient&&) = delete;

  KataAdvice advise(
    const Position& position,
    double komi,
    int elapsed_rounds,
    const std::vector<KataCandidate>& candidates
  );

 private:
  struct Implementation;
  std::unique_ptr<Implementation> implementation_;
};

}  // namespace bitburner::go
