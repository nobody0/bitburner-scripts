#pragma once

#include "ipvgobruteforce/packed_board.hpp"

#include "go/opponent.hpp"
#include "go/state.hpp"

#include <cstdint>
#include <filesystem>
#include <functional>
#include <optional>
#include <vector>

namespace ipvgobruteforce {

inline constexpr std::uint32_t seeded_phase_count = 150'000;

enum class GraphStatus : std::uint8_t { unknown, win, loss };

enum class SeededActionClass : std::uint8_t {
  exact_single_reply,
  exact_seed_window,
  unseeded_defense_tie,
};

struct SeededTimingModel {
  /** Additional ticks after the branch-exact mandatory AI waits. Ordinary
   * 5x5 play retains both adjacent completion phases. */
  std::uint32_t runtime_uncertainty_ticks{1};
  /** Possible extra engine ticks before White constructs WHRNG. */
  std::uint32_t ai_seed_slip_ticks{};
  /** Absolute 30,000-second Player.totalPlaytime epoch used by WHRNG. */
  std::uint32_t playtime_epoch{};
  /** Legacy snapshot field. Fractional AI sleeps are already contained by the
   * unified completion window and must not create another successor tick. */
  bool include_fractional_wait_rounding{true};
  /** Safe exact-next-board choices established by one smart alignment. */
  std::uint8_t alignment_boards{9};

  friend bool operator==(const SeededTimingModel&, const SeededTimingModel&) = default;
};

struct SeededStateKey {
  PackedPosition position;
  std::uint32_t phase{};
  std::uint32_t round_depth{};
  /** Remaining exact next-board timing choices established by alignment. */
  std::uint8_t alignment_credit{};

  friend bool operator==(const SeededStateKey&, const SeededStateKey&) = default;
};

struct SeededTransition {
  SeededActionClass action_class{SeededActionClass::exact_single_reply};
  std::vector<SeededStateKey> successors;
  std::uint64_t seed_evaluations{};
  std::uint64_t white_reply_outcomes{};
};

/** Exact phase-aware transition primitive used by the graph and parity tests. */
SeededTransition seeded_action_transition(
  const bitburner::go::Position& position,
  std::uint32_t dispatch_phase,
  bitburner::go::Move black_move,
  bitburner::go::Opponent opponent,
  const SeededTimingModel& timing
);

struct SeededGraphLimits {
  std::uint64_t max_states{8'000'000};
  std::uint64_t max_expansions{8'000'000};
  std::uint64_t progress_every{1'000};
  std::uint64_t checkpoint_every{10'000};
  std::uint32_t max_rounds{40};
};

struct SeededGraphStats {
  std::uint64_t states{};
  std::uint64_t expanded_states{};
  std::uint64_t actions{};
  std::uint64_t edges{};
  std::uint64_t frontier{};
  std::uint64_t winning_states{};
  std::uint64_t losing_states{};
  std::uint64_t proof_updates{};
  std::uint64_t collapsed_expansions{};
  std::uint64_t exact_single_reply_actions{};
  std::uint64_t exact_seed_window_actions{};
  std::uint64_t unseeded_defense_tie_actions{};
  std::uint64_t voluntary_wait_actions{};
  std::uint64_t seed_evaluations{};
  std::uint64_t white_reply_outcomes{};
  std::uint64_t phase_branches{};
  std::uint64_t transposition_hits{};
  std::uint64_t fingerprint_collisions{};
  std::uint64_t horizon_cutoffs{};
  std::uint64_t minimum_history_depth{};
  std::uint64_t maximum_history_depth{};
  double average_history_depth{};
  std::uint64_t maximum_round_depth{};
  double average_round_depth{};
  std::uint64_t estimated_bytes{};
};

struct SeededGraphResult {
  GraphStatus start_status{GraphStatus::unknown};
  SeededGraphStats stats;
  bool exhausted{};
  bool interrupted{};
  bool horizon_exhausted{};
  bool winning_incumbent{};
  double incumbent_expected_power_per_turn{};
  std::uint64_t certificate_states{};
  std::uint64_t certificate_terminal_wins{};
  /** Aggregate power/turn of the exported policy, weighting each distinct AND
   * successor route once. */
  double certificate_expected_power_per_turn{};
  /** True when every certificate decision maximizes the aggregate objective
   * over all winning actions materialized at that exact state. This is not a
   * claim that bounded search materialized every legal action. */
  bool certificate_materialized_optimal{};
  /** Every legal Black action was resolved wherever it could affect the
   * exported policy, proving its aggregate objective within max_rounds. */
  bool power_optimal_within_horizon{};
};

using SeededGraphProgress = std::function<bool(const SeededGraphStats&)>;
using SeededGraphStopCheck = std::function<bool()>;
/** Untrusted action-ordering advice. A hinted move receives no proof credit;
 * the graph still regenerates and resolves every adversarial successor. */
using SeededMoveHint = std::function<std::optional<bitburner::go::Move>(
  const bitburner::go::Position&, std::uint32_t)>;

/** Persistent AND/OR graph for one exact reset/dispatch phase. */
SeededGraphResult search_seeded_graph(
  const bitburner::go::Position& start,
  std::uint32_t start_phase,
  bitburner::go::Opponent opponent,
  double komi,
  const SeededTimingModel& timing,
  const SeededGraphLimits& limits,
  const std::filesystem::path& snapshot,
  bool resume,
  const std::filesystem::path& certificate,
  const SeededGraphProgress& progress = {},
  const SeededGraphStopCheck& keep_running = {},
  const SeededMoveHint& move_hint = {}
);

const char* seeded_action_class_name(SeededActionClass value);

}  // namespace ipvgobruteforce
