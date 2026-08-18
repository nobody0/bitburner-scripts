#pragma once

#include "ipvgobruteforce/seeded_search.hpp"

#include <cstdint>
#include <filesystem>
#include <vector>

namespace ipvgobruteforce {

struct PowerTurn {
  std::uint32_t power{};
  std::uint32_t turns{1};

  friend bool operator==(const PowerTurn&, const PowerTurn&) = default;
};

bool better_power_turn(const PowerTurn& left, const PowerTurn& right);

struct PolicyProfile {
  std::uint32_t phase{};
  std::vector<PowerTurn> outcomes;
};

struct RouteChoice {
  std::uint32_t entry_phase{};
  std::uint32_t waits{};
  PowerTurn worst;

  friend bool operator==(const RouteChoice&, const RouteChoice&) = default;
};

struct RouteProfileChoice {
  RouteChoice route;
  std::vector<PowerTurn> outcomes;
};

class PolicyRouteOracle {
 public:
  explicit PolicyRouteOracle(std::vector<PolicyProfile> profiles);

  static PolicyRouteOracle load(const std::filesystem::path& quality_tsv);

  /** Best validated future certificate. elapsed_turns is charged before the
   * first optional DODGE; minimum_waits is zero for a freshly generated board
   * and one when abandoning an in-progress board. */
  RouteChoice best(std::uint32_t phase, std::uint32_t elapsed_turns,
    std::uint32_t minimum_waits = 0) const;

  RouteProfileChoice best_profile(std::uint32_t phase,
    std::uint32_t elapsed_turns, std::uint32_t minimum_waits = 0) const;

  const PolicyProfile* profile_at(std::uint32_t phase) const;
  std::uint64_t fingerprint() const;

  const std::vector<PolicyProfile>& profiles() const { return profiles_; }

 private:
  std::vector<PolicyProfile> profiles_;
  std::vector<std::int32_t> phase_profile_;
};

double power_per_turn(PowerTurn value);

}  // namespace ipvgobruteforce
