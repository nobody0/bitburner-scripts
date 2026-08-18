#include "ipvgobruteforce/policy_routes.hpp"

#include <algorithm>
#include <fstream>
#include <limits>
#include <optional>
#include <stdexcept>
#include <string>
#include <string_view>
#include <tuple>

namespace ipvgobruteforce {
namespace {

std::vector<std::string> split(std::string_view text, char delimiter) {
  std::vector<std::string> result;
  std::size_t begin = 0;
  for (;;) {
    const std::size_t end = text.find(delimiter, begin);
    result.emplace_back(text.substr(begin, end == std::string_view::npos
      ? text.size() - begin : end - begin));
    if (end == std::string_view::npos) return result;
    begin = end + 1;
  }
}

// Unit note: certificate `turns` count Black rounds (several 200 ms engine
// ticks each — branch-dependent AI waits, typically two to six), while `waits`
// and `elapsed` count single ticks. Adding them treats a dodge tick as costly
// as a full round, which biases DODGE/ENTER trade-offs optimistically for
// entering in wall-clock terms. Certificates were proved against this same
// objective, so changing it requires regenerating every corpus; see README.
PowerTurn shifted_worst(const PolicyProfile& profile, std::uint32_t elapsed,
  std::uint32_t waits) {
  std::optional<PowerTurn> worst;
  for (const PowerTurn outcome : profile.outcomes) {
    const std::uint64_t total = static_cast<std::uint64_t>(outcome.turns)
      + elapsed + waits;
    if (total > std::numeric_limits<std::uint32_t>::max()) {
      throw std::overflow_error("policy route turn count exceeds 32 bits");
    }
    const PowerTurn shifted{outcome.power, static_cast<std::uint32_t>(total)};
    if (!worst || better_power_turn(*worst, shifted)) worst = shifted;
  }
  if (!worst) throw std::logic_error("empty policy profile");
  return *worst;
}

std::vector<PowerTurn> shifted_profile(const PolicyProfile& profile,
  std::uint32_t elapsed, std::uint32_t waits) {
  std::vector<PowerTurn> result;
  result.reserve(profile.outcomes.size());
  for (const PowerTurn outcome : profile.outcomes) {
    const std::uint64_t total = static_cast<std::uint64_t>(outcome.turns)
      + elapsed + waits;
    if (total > std::numeric_limits<std::uint32_t>::max()) {
      throw std::overflow_error("policy route turn count exceeds 32 bits");
    }
    result.push_back({outcome.power, static_cast<std::uint32_t>(total)});
  }
  return result;
}

}  // namespace

bool better_power_turn(const PowerTurn& left, const PowerTurn& right) {
  return static_cast<std::uint64_t>(left.power) * right.turns
    > static_cast<std::uint64_t>(right.power) * left.turns;
}

double power_per_turn(PowerTurn value) {
  return static_cast<double>(value.power) / std::max(1U, value.turns);
}

PolicyRouteOracle::PolicyRouteOracle(std::vector<PolicyProfile> profiles)
  : profiles_(std::move(profiles)), phase_profile_(seeded_phase_count, -1) {
  if (profiles_.empty()) throw std::invalid_argument("policy route oracle requires a profile");
  std::sort(profiles_.begin(), profiles_.end(), [](const auto& left, const auto& right) {
    return left.phase < right.phase;
  });
  for (std::size_t index = 0; index < profiles_.size(); ++index) {
    PolicyProfile& profile = profiles_[index];
    if (profile.phase >= seeded_phase_count || profile.outcomes.empty()) {
      throw std::invalid_argument("invalid policy profile");
    }
    if (phase_profile_[profile.phase] != -1) {
      throw std::invalid_argument("duplicate policy profile phase");
    }
    phase_profile_[profile.phase] = static_cast<std::int32_t>(index);
  }
}

PolicyRouteOracle PolicyRouteOracle::load(const std::filesystem::path& path) {
  std::ifstream input(path);
  if (!input) throw std::runtime_error("cannot read policy qualities " + path.string());
  std::string line;
  if (!std::getline(input, line)
      || line != "phase\tworst_power_per_round\tworst_power_per_second\toutcomes_power:max_round") {
    throw std::runtime_error("unsupported policy quality schema");
  }
  std::vector<PolicyProfile> profiles;
  while (std::getline(input, line)) {
    if (line.empty()) continue;
    const auto fields = split(line, '\t');
    if (fields.size() != 4) throw std::runtime_error("malformed policy quality row");
    PolicyProfile profile{.phase = static_cast<std::uint32_t>(std::stoul(fields[0]))};
    for (const std::string& token : split(fields[3], ',')) {
      const auto pair = split(token, ':');
      if (pair.size() != 2) throw std::runtime_error("malformed policy outcome");
      profile.outcomes.push_back({static_cast<std::uint32_t>(std::stoul(pair[0])),
        static_cast<std::uint32_t>(std::stoul(pair[1]))});
    }
    profiles.push_back(std::move(profile));
  }
  return PolicyRouteOracle(std::move(profiles));
}

RouteChoice PolicyRouteOracle::best(std::uint32_t phase, std::uint32_t elapsed_turns,
  std::uint32_t minimum_waits) const {
  if (phase >= seeded_phase_count || minimum_waits >= seeded_phase_count) {
    throw std::invalid_argument("policy route query is out of range");
  }
  std::optional<RouteChoice> best;
  constexpr std::uint32_t maximum_power = 25;
  const std::uint32_t first_phase = static_cast<std::uint32_t>(
    (static_cast<std::uint64_t>(phase) + minimum_waits) % seeded_phase_count);
  const auto first = std::lower_bound(profiles_.begin(), profiles_.end(), first_phase,
    [](const PolicyProfile& profile, std::uint32_t value) { return profile.phase < value; });
  const std::size_t first_index = first == profiles_.end()
    ? 0U : static_cast<std::size_t>(first - profiles_.begin());
  for (std::size_t offset = 0; offset < profiles_.size(); ++offset) {
    const PolicyProfile& profile = profiles_[(first_index + offset) % profiles_.size()];
    std::uint32_t waits = profile.phase >= phase
      ? profile.phase - phase : seeded_phase_count - phase + profile.phase;
    if (waits < minimum_waits) waits += seeded_phase_count;

    // No unvisited certificate can start before this one. Even a perfect
    // 25-power, one-turn policy cannot beat the incumbent beyond this point.
    const std::uint64_t optimistic_turns = static_cast<std::uint64_t>(elapsed_turns)
      + waits + 1ULL;
    if (best && static_cast<std::uint64_t>(maximum_power) * best->worst.turns
        <= static_cast<std::uint64_t>(best->worst.power) * optimistic_turns) break;

    const PowerTurn worst = shifted_worst(profile, elapsed_turns, waits);
    const RouteChoice candidate{profile.phase, waits, worst};
    if (!best || better_power_turn(candidate.worst, best->worst)
        || (!better_power_turn(best->worst, candidate.worst)
          && std::tie(candidate.waits, candidate.entry_phase)
            < std::tie(best->waits, best->entry_phase))) {
      best = candidate;
    }
  }
  if (!best) throw std::logic_error("policy route query found no future certificate");
  return *best;
}

RouteProfileChoice PolicyRouteOracle::best_profile(std::uint32_t phase,
  std::uint32_t elapsed_turns, std::uint32_t minimum_waits) const {
  const RouteChoice route = best(phase, elapsed_turns, minimum_waits);
  const PolicyProfile* profile = profile_at(route.entry_phase);
  if (profile == nullptr) throw std::logic_error("selected route lacks a profile");
  return {route, shifted_profile(*profile, elapsed_turns, route.waits)};
}

const PolicyProfile* PolicyRouteOracle::profile_at(std::uint32_t phase) const {
  if (phase >= seeded_phase_count) return nullptr;
  const std::int32_t id = phase_profile_[phase];
  return id < 0 ? nullptr : &profiles_[static_cast<std::size_t>(id)];
}

std::uint64_t PolicyRouteOracle::fingerprint() const {
  std::uint64_t hash = 14695981039346656037ULL;
  const auto add = [&](std::uint32_t value) {
    for (unsigned byte = 0; byte < 4; ++byte) {
      hash ^= static_cast<std::uint8_t>(value >> (byte * 8U));
      hash *= 1099511628211ULL;
    }
  };
  for (const PolicyProfile& profile : profiles_) {
    add(profile.phase);
    add(static_cast<std::uint32_t>(profile.outcomes.size()));
    for (const PowerTurn outcome : profile.outcomes) {
      add(outcome.power);
      add(outcome.turns);
    }
  }
  return hash;
}

}  // namespace ipvgobruteforce
