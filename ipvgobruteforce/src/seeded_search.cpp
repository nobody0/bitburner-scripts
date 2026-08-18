#include "ipvgobruteforce/seeded_search.hpp"

#include "ipvgobruteforce/move_order.hpp"
#include "ipvgobruteforce/symmetry_rule_cache.hpp"

#include "go/rng.hpp"
#include "go/rules.hpp"
#include "go/transition.hpp"

#include <algorithm>
#include <bit>
#include <cmath>
#include <cstdint>
#include <filesystem>
#include <fstream>
#include <future>
#include <limits>
#include <optional>
#include <queue>
#include <sstream>
#include <stdexcept>
#include <string>
#include <string_view>
#include <type_traits>
#include <unordered_map>
#include <unordered_set>
#include <utility>
#include <vector>

namespace ipvgobruteforce {
namespace {

using namespace bitburner::go;

constexpr std::uint64_t snapshot_magic = 0x4950564753454544ULL;  // IPV GSEED
constexpr std::uint32_t snapshot_version = 16;
constexpr std::uint64_t fnv_offset = 14695981039346656037ULL;
constexpr std::uint64_t fnv_prime = 1099511628211ULL;

constexpr std::uint64_t text_fingerprint(std::string_view text) {
  std::uint64_t result = fnv_offset;
  for (const char byte : text) {
    result ^= static_cast<unsigned char>(byte);
    result *= fnv_prime;
  }
  return result;
}

constexpr std::uint64_t snapshot_model_id = text_fingerprint(
  "ipvgo-seeded-v16|v3.0.1|absolute-playtime-epoch-across-wrap|exact-history|phase-policy|branch-exact-ai-wait-cycles-plus-runtime-and|playable-area-best-first-dinkelbach-root-ratio-branch-and-bound|controlled-later-next-phase|post-white-power|math-random-and");

/** Expected engine ticks wasted per later-edge (slot-1) action: the runtime
 * waits from a base-phase arrival to base+1, which happens for roughly half
 * of the sub-tick dispatch offsets. Charged per route in policy selection so
 * a narrower proof never silently beats a genuinely faster windowed line. */
constexpr long double later_edge_wait_penalty_turns = 0.5L;

std::uint32_t normalize_phase(std::uint64_t phase) {
  return static_cast<std::uint32_t>(phase % seeded_phase_count);
}

bool state_key_less(const SeededStateKey& left, const SeededStateKey& right) {
  if (left.alignment_credit != right.alignment_credit) {
    return left.alignment_credit < right.alignment_credit;
  }
  if (left.round_depth != right.round_depth) return left.round_depth < right.round_depth;
  if (left.phase != right.phase) return left.phase < right.phase;
  if (left.position.board != right.position.board) return left.position.board < right.position.board;
  if (left.position.consecutive_passes != right.position.consecutive_passes) {
    return left.position.consecutive_passes < right.position.consecutive_passes;
  }
  return left.position.previous_boards < right.position.previous_boards;
}

std::string reply_signature(const WeightedReply& reply) {
  std::ostringstream output;
  output << reply.move.pass << ':' << reply.move.no_op << ':' << reply.move.point.x << ':'
    << reply.move.point.y << ':' << reply.wait.cycle_waits_after_seed << ':'
    << reply.wait.fixed_sleep_ms_after_seed;
  return output.str();
}

std::uint64_t mix(std::uint64_t value) {
  value ^= value >> 30U;
  value *= 0xbf58476d1ce4e5b9ULL;
  value ^= value >> 27U;
  value *= 0x94d049bb133111ebULL;
  return value ^ (value >> 31U);
}

std::uint64_t state_fingerprint(const SeededStateKey& state) {
  return mix(position_fingerprint(state.position)
    ^ (static_cast<std::uint64_t>(state.phase) * 0x9e3779b97f4a7c15ULL)
    ^ (static_cast<std::uint64_t>(state.round_depth) * 0xd6e8feb86659fd93ULL)
    ^ (static_cast<std::uint64_t>(state.alignment_credit) * 0xa0761d6478bd642fULL));
}

class SnapshotWriter {
 public:
  explicit SnapshotWriter(std::ostream& output) : output_(output) {}

  template <typename T>
  void integer(T value) requires std::is_integral_v<T> {
    using Unsigned = std::make_unsigned_t<T>;
    const Unsigned bits = static_cast<Unsigned>(value);
    for (std::size_t index = 0; index < sizeof(T); ++index) {
      byte(static_cast<std::uint8_t>(bits >> (index * 8U)), true);
    }
  }

  void floating(double value) { integer(std::bit_cast<std::uint64_t>(value)); }

  void finish() {
    const std::uint64_t final = checksum_;
    for (std::size_t index = 0; index < sizeof(final); ++index) {
      byte(static_cast<std::uint8_t>(final >> (index * 8U)), false);
    }
  }

 private:
  void byte(std::uint8_t value, bool checksum) {
    output_.put(static_cast<char>(value));
    if (!output_) throw std::runtime_error("failed writing seeded snapshot");
    if (checksum) {
      checksum_ ^= value;
      checksum_ *= fnv_prime;
    }
  }

  std::ostream& output_;
  std::uint64_t checksum_{fnv_offset};
};

class SnapshotReader {
 public:
  explicit SnapshotReader(std::istream& input) : input_(input) {}

  template <typename T>
  T integer() requires std::is_integral_v<T> {
    using Unsigned = std::make_unsigned_t<T>;
    Unsigned result = 0;
    for (std::size_t index = 0; index < sizeof(T); ++index) {
      result |= static_cast<Unsigned>(byte(true)) << (index * 8U);
    }
    return static_cast<T>(result);
  }

  double floating() { return std::bit_cast<double>(integer<std::uint64_t>()); }

  void finish() {
    std::uint64_t stored = 0;
    for (std::size_t index = 0; index < sizeof(stored); ++index) {
      stored |= static_cast<std::uint64_t>(byte(false)) << (index * 8U);
    }
    if (stored != checksum_) throw std::runtime_error("seeded snapshot checksum mismatch");
    if (input_.peek() != std::char_traits<char>::eof()) {
      throw std::runtime_error("seeded snapshot has trailing data");
    }
  }

 private:
  std::uint8_t byte(bool checksum) {
    const int value = input_.get();
    if (value == std::char_traits<char>::eof()) throw std::runtime_error("truncated seeded snapshot");
    const auto result = static_cast<std::uint8_t>(value);
    if (checksum) {
      checksum_ ^= result;
      checksum_ *= fnv_prime;
    }
    return result;
  }

  std::istream& input_;
  std::uint64_t checksum_{fnv_offset};
};

struct StateBucket {
  SeededStateKey key;
  GraphStatus status{GraphStatus::unknown};
  bool expanded{};
  std::vector<std::uint32_t> outgoing_actions;
  std::vector<std::uint32_t> incoming_actions;
};

struct ActionBucket {
  std::uint32_t parent{};
  Move move;
  std::uint8_t wait_ticks{};
  /** 0/1 when an aligned move chooses its next-board slot; 255 otherwise. */
  std::uint8_t timing_choice{255};
  SeededActionClass action_class{SeededActionClass::exact_single_reply};
  GraphStatus status{GraphStatus::unknown};
  std::uint32_t remaining_wins{};
  std::vector<std::uint32_t> successors;
};

struct PolicyQuality {
  long double total_power{};
  long double total_turns{};
  long double routes{};
};

struct OptimizationBound {
  long double value{};
  bool exact{};
};

struct SnapshotStateRecord {
  SeededStateKey key;
  GraphStatus status{GraphStatus::unknown};
  bool expanded{};
};

struct SnapshotActionRecord {
  std::uint32_t parent{};
  Move move;
  std::uint8_t wait_ticks{};
  std::uint8_t timing_choice{255};
  SeededActionClass action_class{SeededActionClass::exact_single_reply};
  GraphStatus status{GraphStatus::unknown};
  std::uint32_t remaining_wins{};
  std::vector<std::uint32_t> successors;
};

struct SnapshotImage {
  Opponent opponent{Opponent::netburners};
  double komi{};
  SeededTimingModel timing;
  std::uint32_t max_rounds{};
  std::uint32_t start_id{};
  std::uint64_t expanded_states{};
  std::uint64_t proof_updates{};
  std::uint64_t collapsed_expansions{};
  std::uint64_t seed_evaluations{};
  std::uint64_t white_reply_outcomes{};
  std::vector<SnapshotStateRecord> states;
  std::vector<SnapshotActionRecord> actions;
};

struct FrontierEntry {
  std::uint32_t round_depth{};
  bool offered_win{};
  std::uint32_t power_twice{};
  std::uint32_t turns{1};
  int black_stones{};
  int white_stones{};
  std::size_t history_size{};
  std::uint32_t state{};

  friend bool operator<(const FrontierEntry& left, const FrontierEntry& right) {
    if (left.offered_win != right.offered_win) return left.offered_win < right.offered_win;
    // Best-first discovery: prefer the board already offering the strongest
    // power/turn route. This is ordering only; GraphStatus still requires every
    // adversarial timing successor to be a proven win.
    const std::uint64_t left_rate = static_cast<std::uint64_t>(left.power_twice) * right.turns;
    const std::uint64_t right_rate = static_cast<std::uint64_t>(right.power_twice) * left.turns;
    if (left_rate != right_rate) return left_rate < right_rate;
    if (left.power_twice != right.power_twice) return left.power_twice < right.power_twice;
    if (left.round_depth != right.round_depth) return left.round_depth > right.round_depth;
    if (left.black_stones != right.black_stones) return left.black_stones < right.black_stones;
    if (left.white_stones != right.white_stones) return left.white_stones > right.white_stones;
    if (left.history_size != right.history_size) return left.history_size > right.history_size;
    return left.state > right.state;
  }
};

struct SolvedEntry {
  int empty_cells{};
  std::uint32_t state{};

  friend bool operator<(const SolvedEntry& left, const SolvedEntry& right) {
    if (left.empty_cells != right.empty_cells) return left.empty_cells < right.empty_cells;
    return left.state > right.state;
  }
};

std::pair<int, int> stone_counts(PackedBoard board) {
  int black = 0;
  int white = 0;
  for (unsigned coordinate = 0; coordinate < 25; ++coordinate) {
    const std::uint64_t value = (board >> (coordinate * 2U)) & 3ULL;
    black += value == 1U;
    white += value == 2U;
  }
  return {black, white};
}

std::uint32_t black_power_twice(PackedBoard board, double komi) {
  const Score score = symmetry_cached_score(board, komi);
  return static_cast<std::uint32_t>(std::llround(score.black * 2.0));
}

std::uint32_t playable_area(PackedBoard board) {
  std::uint32_t result = 0;
  for (unsigned coordinate = 0; coordinate < 25; ++coordinate) {
    result += ((board >> (coordinate * 2U)) & 3ULL) != 3ULL;
  }
  return result;
}

class SeededGraph {
 public:
  SeededGraph(Position start, std::uint32_t phase, Opponent opponent, double komi,
    SeededTimingModel timing, std::uint32_t max_rounds, SeededMoveHint move_hint = {})
    : expected_start_{pack_position(start), normalize_phase(phase), 0}, opponent_(opponent),
      komi_(komi), timing_(timing), max_rounds_(max_rounds), move_hint_(std::move(move_hint)) {
    if (max_rounds_ == 0) throw std::invalid_argument("seeded max rounds must be positive");
    if (timing_.alignment_boards == 0) {
      throw std::invalid_argument("seeded alignment budget must be positive");
    }
    start_id_ = add_state(expected_start_);
  }

  static SeededGraph load(const std::filesystem::path& path, const Position& start,
    std::uint32_t phase, Opponent opponent, double komi, SeededTimingModel timing,
    std::uint32_t max_rounds, SeededMoveHint move_hint = {}) {
    SeededGraph graph(start, phase, opponent, komi, timing, max_rounds, std::move(move_hint));
    std::ifstream input(path, std::ios::binary);
    if (!input) throw std::runtime_error("cannot read seeded snapshot " + path.string());
    SnapshotReader reader(input);
    if (reader.integer<std::uint64_t>() != snapshot_magic
      || reader.integer<std::uint32_t>() != snapshot_version
      || reader.integer<std::uint64_t>() != snapshot_model_id
      || reader.integer<std::uint32_t>() != seeded_phase_count) {
      throw std::runtime_error("seeded snapshot schema/model mismatch");
    }
    if (static_cast<Opponent>(reader.integer<std::uint32_t>()) != opponent
      || reader.floating() != komi
      || reader.integer<std::uint32_t>() != timing.runtime_uncertainty_ticks
      || reader.integer<std::uint32_t>() != timing.ai_seed_slip_ticks
      || reader.integer<std::uint32_t>() != timing.playtime_epoch
      || static_cast<bool>(reader.integer<std::uint8_t>()) != timing.include_fractional_wait_rounding
      || reader.integer<std::uint8_t>() != timing.alignment_boards
      || reader.integer<std::uint32_t>() != max_rounds) {
      throw std::runtime_error("seeded snapshot configuration mismatch");
    }
    const std::uint32_t stored_start = reader.integer<std::uint32_t>();
    const std::uint64_t state_count = reader.integer<std::uint64_t>();
    const std::uint64_t action_count = reader.integer<std::uint64_t>();
    graph.expanded_states_ = reader.integer<std::uint64_t>();
    graph.proof_updates_ = reader.integer<std::uint64_t>();
    graph.collapsed_expansions_ = reader.integer<std::uint64_t>();
    graph.seed_evaluations_ = reader.integer<std::uint64_t>();
    graph.white_reply_outcomes_ = reader.integer<std::uint64_t>();
    graph.states_.clear();
    graph.actions_.clear();
    graph.primary_index_.clear();
    graph.collision_index_.clear();
    graph.frontier_ = {};
    graph.states_.reserve(static_cast<std::size_t>(state_count));
    graph.actions_.reserve(static_cast<std::size_t>(action_count));
    for (std::uint64_t index = 0; index < state_count; ++index) {
      StateBucket state;
      state.key.position.board = reader.integer<PackedBoard>();
      state.key.position.consecutive_passes = reader.integer<std::uint8_t>();
      state.key.phase = reader.integer<std::uint32_t>();
      state.key.round_depth = reader.integer<std::uint32_t>();
      state.key.alignment_credit = reader.integer<std::uint8_t>();
      state.status = static_cast<GraphStatus>(reader.integer<std::uint8_t>());
      state.expanded = static_cast<bool>(reader.integer<std::uint8_t>());
      const std::uint32_t history = reader.integer<std::uint32_t>();
      state.key.position.previous_boards.reserve(history);
      for (std::uint32_t item = 0; item < history; ++item) {
        state.key.position.previous_boards.push_back(reader.integer<PackedBoard>());
      }
      graph.states_.push_back(std::move(state));
    }
    for (std::uint64_t index = 0; index < action_count; ++index) {
      ActionBucket action;
      action.parent = reader.integer<std::uint32_t>();
      action.wait_ticks = reader.integer<std::uint8_t>();
      action.timing_choice = reader.integer<std::uint8_t>();
      action.move.pass = static_cast<bool>(reader.integer<std::uint8_t>());
      action.move.no_op = static_cast<bool>(reader.integer<std::uint8_t>());
      action.move.point.x = reader.integer<std::int8_t>();
      action.move.point.y = reader.integer<std::int8_t>();
      action.action_class = static_cast<SeededActionClass>(reader.integer<std::uint8_t>());
      action.status = static_cast<GraphStatus>(reader.integer<std::uint8_t>());
      action.remaining_wins = reader.integer<std::uint32_t>();
      const std::uint32_t successors = reader.integer<std::uint32_t>();
      action.successors.reserve(successors);
      for (std::uint32_t item = 0; item < successors; ++item) {
        action.successors.push_back(reader.integer<std::uint32_t>());
      }
      graph.actions_.push_back(std::move(action));
    }
    reader.finish();
    if (stored_start >= graph.states_.size()
      || !(graph.states_[stored_start].key == graph.expected_start_)) {
      throw std::runtime_error("seeded snapshot start state mismatch");
    }
    graph.start_id_ = stored_start;
    graph.rebuild_runtime();
    graph.validate();
    return graph;
  }

  void save(const std::filesystem::path& path) const {
    if (path.empty()) return;
    write_snapshot_image(snapshot_image(), path);
  }

  SeededGraphResult run(const SeededGraphLimits& limits, const std::filesystem::path& snapshot,
    const std::filesystem::path& certificate, const SeededGraphProgress& progress,
    const SeededGraphStopCheck& keep_running) {
    std::uint64_t run_expansions = 0;
    bool interrupted = false;
    std::future<void> checkpoint;
    const auto finish_checkpoint = [&] {
      if (checkpoint.valid()) checkpoint.get();
    };
    const auto start_checkpoint = [&] {
      if (snapshot.empty()) return;
      finish_checkpoint();
      SnapshotImage image = snapshot_image();
      checkpoint = std::async(std::launch::async,
        [image = std::move(image), snapshot] { write_snapshot_image(image, snapshot); });
    };
    // Re-admit partially expanded winning states from an interrupted run.
    for (std::uint32_t id = 0; id < states_.size(); ++id) {
      if (ready_for_black_work(id)) enqueue(id);
    }
    // Recomputing the admissible root bound is linear in the materialized DAG.
    // Follow the selected unresolved subtree for a batch, but stop descending
    // once a route can no longer beat the incumbent. The next bound pass then
    // decides whether aggregate sibling values require refining that branch.
    constexpr std::uint32_t optimization_batch_size = 10'000;
    std::uint32_t optimization_batch_remaining = 0;
    PolicyQuality optimization_incumbent;
    std::priority_queue<FrontierEntry> optimization_work;
    while (true) {
      if (keep_running && !keep_running()) {
        interrupted = true;
        break;
      }
      bool worked = false;
      while (states_.size() < limits.max_states && run_expansions < limits.max_expansions) {
        std::optional<std::uint32_t> state;
        if (states_[start_id_].status == GraphStatus::win) {
          while (!optimization_work.empty() && !state) {
            const std::uint32_t candidate = optimization_work.top().state;
            optimization_work.pop();
            if (ready_for_black_work(candidate)) state = candidate;
          }
          if (!state && optimization_batch_remaining == 0) {
            optimization_incumbent = optimal_policy();
            state = optimization_frontier();
            if (!state) break;
            optimization_batch_remaining = optimization_batch_size;
          } else if (!state) {
            optimization_batch_remaining = 0;
            continue;
          }
        } else {
          while (!frontier_.empty()) {
            const std::uint32_t candidate = frontier_.top().state;
            frontier_.pop();
            if (ready_for_black_work(candidate)) {
              state = candidate;
              break;
            }
          }
        }
        if (!state) break;
        expand(*state);
        if (optimization_batch_remaining > 0) {
          --optimization_batch_remaining;
          for (const std::uint32_t action_id : states_[*state].outgoing_actions) {
            if (actions_[action_id].status == GraphStatus::loss) continue;
            for (const std::uint32_t successor : actions_[action_id].successors) {
              const StateBucket& child = states_[successor];
              const long double per_route = static_cast<long double>(playable_area(
                  child.key.position.board)) * optimization_incumbent.total_turns
                - static_cast<long double>(child.key.round_depth + 1U)
                  * optimization_incumbent.total_power;
              if (per_route > 0.0L && ready_for_black_work(successor)) {
                optimization_work.push(frontier_entry(successor));
              }
            }
          }
          if (optimization_batch_remaining == 0) optimization_work = {};
          else if (optimization_work.empty()) optimization_batch_remaining = 0;
        }
        ++run_expansions;
        ++expanded_states_;
        worked = true;
        break;
      }
      if (!worked) break;
      if (!snapshot.empty() && limits.checkpoint_every > 0
        && run_expansions % limits.checkpoint_every == 0) start_checkpoint();
      if (progress && limits.progress_every > 0 && run_expansions % limits.progress_every == 0
        && !progress(stats())) {
        interrupted = true;
        break;
      }
    }
    // A background checkpoint may describe an earlier complete expansion.
    // Join it before atomically publishing the final, current graph.
    finish_checkpoint();
    save(snapshot);
    const GraphStatus internal_start_status = states_[start_id_].status;
    const bool bounded_failure = internal_start_status == GraphStatus::loss
      && expected_start_.position.consecutive_passes < 2;
    const bool optimal_complete = power_optimal_complete(start_id_);
    const bool incomplete_optimal_win = internal_start_status == GraphStatus::win
      && !optimal_complete;
    SeededGraphResult result{
      .start_status = bounded_failure || incomplete_optimal_win
        ? GraphStatus::unknown : internal_start_status,
      .stats = stats(),
      .exhausted = frontier_count() == 0,
      .interrupted = interrupted,
      .horizon_exhausted = bounded_failure,
      .winning_incumbent = internal_start_status == GraphStatus::win,
      .incumbent_expected_power_per_turn = internal_start_status == GraphStatus::win
        ? incumbent_power_per_turn() : 0.0,
      .power_optimal_within_horizon = optimal_complete,
    };
    if (result.winning_incumbent && !certificate.empty()) {
      const auto certificate_result = save_certificate(certificate, optimal_complete);
      result.certificate_states = certificate_result.states;
      result.certificate_terminal_wins = certificate_result.terminals;
      result.certificate_expected_power_per_turn = certificate_result.expected_power_per_turn;
      result.certificate_materialized_optimal = true;
    }
    return result;
  }

 private:
  std::uint32_t epoch_at(std::uint32_t phase) const {
    // A per-root proof is bounded to at most max_rounds (currently 40), far
    // below the 150,000-tick WHRNG ring. Therefore a phase lower than the root
    // phase can only have crossed the ring once. Keep the absolute epoch used
    // by JavaScript's floating-point WHRNG seed instead of silently folding it
    // back onto the root epoch.
    return timing_.playtime_epoch + (phase < expected_start_.phase ? 1U : 0U);
  }

  SnapshotImage snapshot_image() const {
    SnapshotImage image{
      .opponent = opponent_,
      .komi = komi_,
      .timing = timing_,
      .max_rounds = max_rounds_,
      .start_id = start_id_,
      .expanded_states = expanded_states_,
      .proof_updates = proof_updates_,
      .collapsed_expansions = collapsed_expansions_,
      .seed_evaluations = seed_evaluations_,
      .white_reply_outcomes = white_reply_outcomes_,
    };
    image.states.reserve(states_.size());
    for (const StateBucket& state : states_) {
      image.states.push_back({state.key, state.status, state.expanded});
    }
    image.actions.reserve(actions_.size());
    for (const ActionBucket& action : actions_) {
      image.actions.push_back({action.parent, action.move, action.wait_ticks,
        action.timing_choice, action.action_class, action.status,
        action.remaining_wins, action.successors});
    }
    return image;
  }

  static void write_snapshot_image(const SnapshotImage& image,
    const std::filesystem::path& path) {
    if (path.has_parent_path()) std::filesystem::create_directories(path.parent_path());
    const std::filesystem::path temporary = path.string() + ".tmp";
    {
      std::ofstream output(temporary, std::ios::binary | std::ios::trunc);
      if (!output) throw std::runtime_error("cannot write seeded snapshot " + temporary.string());
      SnapshotWriter writer(output);
      writer.integer(snapshot_magic);
      writer.integer(snapshot_version);
      writer.integer(snapshot_model_id);
      writer.integer(seeded_phase_count);
      writer.integer(static_cast<std::uint32_t>(image.opponent));
      writer.floating(image.komi);
      writer.integer(image.timing.runtime_uncertainty_ticks);
      writer.integer(image.timing.ai_seed_slip_ticks);
      writer.integer(image.timing.playtime_epoch);
      writer.integer(static_cast<std::uint8_t>(image.timing.include_fractional_wait_rounding));
      writer.integer(image.timing.alignment_boards);
      writer.integer(image.max_rounds);
      writer.integer(image.start_id);
      writer.integer(static_cast<std::uint64_t>(image.states.size()));
      writer.integer(static_cast<std::uint64_t>(image.actions.size()));
      writer.integer(image.expanded_states);
      writer.integer(image.proof_updates);
      writer.integer(image.collapsed_expansions);
      writer.integer(image.seed_evaluations);
      writer.integer(image.white_reply_outcomes);
      for (const SnapshotStateRecord& state : image.states) {
        writer.integer(state.key.position.board);
        writer.integer(state.key.position.consecutive_passes);
        writer.integer(state.key.phase);
        writer.integer(state.key.round_depth);
        writer.integer(state.key.alignment_credit);
        writer.integer(static_cast<std::uint8_t>(state.status));
        writer.integer(static_cast<std::uint8_t>(state.expanded));
        writer.integer(static_cast<std::uint32_t>(state.key.position.previous_boards.size()));
        for (const PackedBoard board : state.key.position.previous_boards) writer.integer(board);
      }
      for (const SnapshotActionRecord& action : image.actions) {
        writer.integer(action.parent);
        writer.integer(action.wait_ticks);
        writer.integer(action.timing_choice);
        writer.integer(static_cast<std::uint8_t>(action.move.pass));
        writer.integer(static_cast<std::uint8_t>(action.move.no_op));
        writer.integer(static_cast<std::int8_t>(action.move.point.x));
        writer.integer(static_cast<std::int8_t>(action.move.point.y));
        writer.integer(static_cast<std::uint8_t>(action.action_class));
        writer.integer(static_cast<std::uint8_t>(action.status));
        writer.integer(action.remaining_wins);
        writer.integer(static_cast<std::uint32_t>(action.successors.size()));
        for (const std::uint32_t successor : action.successors) writer.integer(successor);
      }
      writer.finish();
      output.flush();
      if (!output) throw std::runtime_error("failed flushing seeded snapshot");
    }
    std::filesystem::rename(temporary, path);
  }
  std::optional<std::uint32_t> indexed(const SeededStateKey& key) const {
    const std::uint64_t fingerprint = state_fingerprint(key);
    const auto primary = primary_index_.find(fingerprint);
    if (primary == primary_index_.end()) return std::nullopt;
    if (states_[primary->second].key == key) return primary->second;
    const auto collision = collision_index_.find(fingerprint);
    if (collision == collision_index_.end()) return std::nullopt;
    for (const std::uint32_t id : collision->second) if (states_[id].key == key) return id;
    return std::nullopt;
  }

  bool ready_for_black_work(std::uint32_t id) const {
    const StateBucket& state = states_[id];
    if (state.expanded) return false;
    if (state.key.position.consecutive_passes >= 2 || state.key.round_depth >= max_rounds_) {
      return false;
    }
    if (state.status == GraphStatus::win) {
      return states_[start_id_].status == GraphStatus::win;
    }
    if (state.status == GraphStatus::loss) return false;
    return std::none_of(state.outgoing_actions.begin(), state.outgoing_actions.end(),
      [&](std::uint32_t action) { return actions_[action].status == GraphStatus::unknown; });
  }

  bool power_optimal_complete(std::uint32_t root) const {
    if (states_[root].status != GraphStatus::win) return false;
    const PolicyQuality incumbent = optimal_policy();
    std::unordered_map<std::uint32_t, OptimizationBound> bound_cache;
    const OptimizationBound bound = optimization_bound(root, incumbent, bound_cache);
    // The incumbent itself has transformed value zero. If the admissible upper
    // bound is also non-positive, no other winning policy can improve P/T.
    return bound.value <= 1e-12L;
  }

  OptimizationBound optimization_bound(std::uint32_t id, const PolicyQuality& incumbent,
    std::unordered_map<std::uint32_t, OptimizationBound>& cache) const {
    if (const auto found = cache.find(id); found != cache.end()) return found->second;
    const StateBucket& state = states_[id];
    const long double negative_infinity = -std::numeric_limits<long double>::infinity();
    if (state.status == GraphStatus::loss) {
      return cache.emplace(id, OptimizationBound{negative_infinity, true}).first->second;
    }
    if (state.key.position.consecutive_passes >= 2) {
      const long double power = symmetry_cached_score(state.key.position.board, komi_).black;
      const long double transformed = power * incumbent.total_turns
        - static_cast<long double>(state.key.round_depth) * incumbent.total_power;
      return cache.emplace(id, OptimizationBound{transformed, true}).first->second;
    }

    OptimizationBound best{negative_infinity, state.expanded};
    if (!state.expanded) {
      // Every continuation needs at least one more Black turn and can earn at
      // at most every playable point. A positive value remains deliberately unbounded:
      // an unresolved AND subtree may contain many routes. A non-positive
      // per-route bound is already a valid bound for any such policy.
      const long double per_route = static_cast<long double>(playable_area(
          state.key.position.board)) * incumbent.total_turns
        - static_cast<long double>(state.key.round_depth + 1U) * incumbent.total_power;
      best = {per_route > 0.0L
        ? std::numeric_limits<long double>::infinity() : per_route, false};
    }
    for (const std::uint32_t action_id : state.outgoing_actions) {
      const ActionBucket& action = actions_[action_id];
      if (action.status == GraphStatus::loss) continue;
      OptimizationBound candidate{0.0L, true};
      for (const std::uint32_t successor : action.successors) {
        const OptimizationBound child = optimization_bound(successor, incumbent, cache);
        if (child.value == negative_infinity) {
          candidate = {negative_infinity, true};
          break;
        }
        candidate.value += child.value;
        candidate.exact = candidate.exact && child.exact;
      }
      if (candidate.value > best.value) best = candidate;
      else if (candidate.value == best.value) best.exact = best.exact || candidate.exact;
    }
    return cache.emplace(id, best).first->second;
  }

  std::optional<std::uint32_t> find_optimization_frontier(std::uint32_t id,
    const PolicyQuality& incumbent,
    std::unordered_map<std::uint32_t, OptimizationBound>& cache,
    std::unordered_set<std::uint32_t>& visited) const {
    if (!visited.insert(id).second) return std::nullopt;
    const StateBucket& state = states_[id];
    if (state.status == GraphStatus::loss || state.key.position.consecutive_passes >= 2) {
      return std::nullopt;
    }
    if (!state.expanded) return id;

    std::vector<std::pair<long double, std::uint32_t>> ordered;
    ordered.reserve(state.outgoing_actions.size());
    for (const std::uint32_t action_id : state.outgoing_actions) {
      const ActionBucket& action = actions_[action_id];
      if (action.status == GraphStatus::loss) continue;
      long double value = 0.0L;
      for (const std::uint32_t successor : action.successors) {
        value += optimization_bound(successor, incumbent, cache).value;
      }
      ordered.emplace_back(value, action_id);
    }
    std::sort(ordered.begin(), ordered.end(), [](const auto& left, const auto& right) {
      return left.first > right.first;
    });
    for (const auto& [value, action_id] : ordered) {
      if (value <= 0.0L) break;
      const ActionBucket& action = actions_[action_id];
      std::vector<std::pair<long double, std::uint32_t>> successors;
      successors.reserve(action.successors.size());
      for (const std::uint32_t successor : action.successors) {
        const OptimizationBound bound = optimization_bound(successor, incumbent, cache);
        if (!bound.exact) successors.emplace_back(bound.value, successor);
      }
      std::sort(successors.begin(), successors.end(), [](const auto& left, const auto& right) {
        return left.first > right.first;
      });
      for (const auto& [_, successor] : successors) {
        if (const auto found = find_optimization_frontier(
            successor, incumbent, cache, visited)) return found;
      }
    }
    return std::nullopt;
  }

  std::optional<std::uint32_t> optimization_frontier() const {
    const PolicyQuality incumbent = optimal_policy();
    std::unordered_map<std::uint32_t, OptimizationBound> bound_cache;
    const OptimizationBound root = optimization_bound(start_id_, incumbent, bound_cache);
    if (root.value <= 1e-12L) return std::nullopt;
    std::unordered_set<std::uint32_t> visited;
    return find_optimization_frontier(start_id_, incumbent, bound_cache, visited);
  }

  void insert_index(std::uint32_t id) {
    const std::uint64_t fingerprint = state_fingerprint(states_[id].key);
    const auto [found, inserted] = primary_index_.emplace(fingerprint, id);
    if (inserted || states_[found->second].key == states_[id].key) return;
    auto [collision, fresh] = collision_index_.try_emplace(fingerprint);
    if (fresh) collision->second.push_back(found->second);
    collision->second.push_back(id);
    ++fingerprint_collisions_;
  }

  std::uint32_t add_state(SeededStateKey key) {
    if (key.position.consecutive_passes >= 2) key.phase = 0;
    if (const auto found = indexed(key)) {
      ++transposition_hits_;
      return *found;
    }
    if (states_.size() >= std::numeric_limits<std::uint32_t>::max()) {
      throw std::overflow_error("seeded graph exceeded 32-bit state IDs");
    }
    const std::uint32_t id = static_cast<std::uint32_t>(states_.size());
    StateBucket state{.key = std::move(key)};
    if (state.key.position.consecutive_passes >= 2) {
      const Score score = symmetry_cached_score(state.key.position.board, komi_);
      state.status = score.black > score.white ? GraphStatus::win : GraphStatus::loss;
      state.expanded = true;
    } else if (state.key.round_depth >= max_rounds_) {
      // Internal bounded-game loss only. The public result maps a disproven
      // root horizon to UNKNOWN; a WIN remains a genuine game certificate.
      state.status = GraphStatus::loss;
      state.expanded = true;
    }
    states_.push_back(std::move(state));
    insert_index(id);
    if (states_.back().status == GraphStatus::unknown) enqueue(id);
    return id;
  }

  void enqueue(std::uint32_t id) {
    frontier_.push(frontier_entry(id));
  }

  FrontierEntry frontier_entry(std::uint32_t id) const {
    const StateBucket& state = states_[id];
    const auto [black, white] = stone_counts(state.key.position.board);
    const Score score = symmetry_cached_score(state.key.position.board, komi_);
    return {
      .round_depth = state.key.round_depth,
      .offered_win = state.key.position.consecutive_passes > 0 && score.black > score.white,
      .power_twice = black_power_twice(state.key.position.board, komi_),
      .turns = std::max(1U, state.key.round_depth),
      .black_stones = black,
      .white_stones = white,
      .history_size = state.key.position.previous_boards.size(),
      .state = id,
    };
  }

  void set_state_status(std::uint32_t id, GraphStatus status) {
    if (status == GraphStatus::unknown || states_[id].status == status) return;
    if (states_[id].status != GraphStatus::unknown) {
      throw std::logic_error("contradictory seeded state status");
    }
    states_[id].status = status;
    std::priority_queue<SolvedEntry> solved;
    solved.push({25 - occupied_cells(states_[id].key.position.board), id});
    while (!solved.empty()) {
      const std::uint32_t solved_id = solved.top().state;
      solved.pop();
      const GraphStatus solved_status = states_[solved_id].status;
      for (const std::uint32_t action_id : states_[solved_id].incoming_actions) {
        ActionBucket& action = actions_[action_id];
        if (action.status != GraphStatus::unknown) continue;
        if (solved_status == GraphStatus::loss) {
          action.status = GraphStatus::loss;
        } else {
          if (action.remaining_wins == 0) throw std::logic_error("seeded action counter underflow");
          if (--action.remaining_wins == 0) action.status = GraphStatus::win;
        }
        if (action.status == GraphStatus::unknown) continue;
        ++proof_updates_;
        StateBucket& parent = states_[action.parent];
        if (parent.status != GraphStatus::unknown) continue;
        if (action.status == GraphStatus::win) {
          parent.status = GraphStatus::win;
          if (!parent.expanded && states_[start_id_].status == GraphStatus::win) {
            enqueue(action.parent);
          }
          solved.push({25 - occupied_cells(parent.key.position.board), action.parent});
        } else if (!parent.expanded) {
          // Lazy OR expansion: a disproven preferred Black action unlocks the
          // next ordered action. The parent itself remains an exact
          // phase/history state and is never board-only merged.
          enqueue(action.parent);
        } else if (parent.expanded && !parent.outgoing_actions.empty()
          && std::all_of(parent.outgoing_actions.begin(), parent.outgoing_actions.end(),
            [&](std::uint32_t sibling) { return actions_[sibling].status == GraphStatus::loss; })) {
          parent.status = GraphStatus::loss;
          solved.push({25 - occupied_cells(parent.key.position.board), action.parent});
        }
      }
    }
  }

  void add_action(std::uint32_t parent, Move move, std::uint8_t wait_ticks,
    std::uint8_t timing_choice, SeededActionClass action_class,
    std::vector<std::uint32_t> successors) {
    std::sort(successors.begin(), successors.end());
    successors.erase(std::unique(successors.begin(), successors.end()), successors.end());
    if (successors.empty()) throw std::logic_error("seeded action has no successor");
    ActionBucket action{
      .parent = parent,
      .move = move,
      .wait_ticks = wait_ticks,
      .timing_choice = timing_choice,
      .action_class = action_class,
      .remaining_wins = static_cast<std::uint32_t>(successors.size()),
      .successors = std::move(successors),
    };
    for (const std::uint32_t successor : action.successors) {
      if (states_[successor].status == GraphStatus::loss) action.status = GraphStatus::loss;
      if (states_[successor].status == GraphStatus::win) --action.remaining_wins;
    }
    if (action.status == GraphStatus::unknown && action.remaining_wins == 0) {
      action.status = GraphStatus::win;
    }
    const std::uint32_t action_id = static_cast<std::uint32_t>(actions_.size());
    actions_.push_back(std::move(action));
    states_[parent].outgoing_actions.push_back(action_id);
    for (const std::uint32_t successor : actions_.back().successors) {
      states_[successor].incoming_actions.push_back(action_id);
    }
    if (actions_.back().status == GraphStatus::win) set_state_status(parent, GraphStatus::win);
  }

  void expand(std::uint32_t state_id) {
    if (states_[state_id].status == GraphStatus::win) {
      for (const std::uint32_t action_id : states_[state_id].outgoing_actions) {
        if (actions_[action_id].status != GraphStatus::win) continue;
        for (const std::uint32_t successor : actions_[action_id].successors) {
          if (ready_for_black_work(successor)) enqueue(successor);
        }
      }
    }
    const Position position = unpack_position(states_[state_id].key.position);
    const auto moves = ordered_black_moves(position, komi_);
    const auto attempted = [&](Move move, std::uint8_t wait_ticks,
      std::uint8_t timing_choice) {
      return std::any_of(states_[state_id].outgoing_actions.begin(),
        states_[state_id].outgoing_actions.end(), [&](std::uint32_t action) {
          return actions_[action].wait_ticks == wait_ticks
            && actions_[action].timing_choice == timing_choice
            && (wait_ticks != 0 || actions_[action].move == move);
        });
    };

    while (true) {
      struct Candidate {
        Move move;
        std::uint8_t wait_ticks{};
        std::uint8_t timing_choice{255};
        SeededTransition transition;
        bool immediate_win{};
        bool hinted{};
        std::uint32_t worst_power_twice{std::numeric_limits<std::uint32_t>::max()};
        std::uint64_t total_power_twice{};
        int worst_black{std::numeric_limits<int>::max()};
        int worst_white{};
        std::size_t stable_order{};
      };
      std::vector<Candidate> candidates;
      const auto better = [](const Candidate& left, const Candidate& right) {
        if (left.immediate_win != right.immediate_win) return left.immediate_win;
        if (left.hinted != right.hinted) return left.hinted;
        const bool left_exact = left.transition.action_class
          != SeededActionClass::unseeded_defense_tie;
        const bool right_exact = right.transition.action_class
          != SeededActionClass::unseeded_defense_tie;
        if (left_exact != right_exact) return left_exact;
        if (left.worst_power_twice != right.worst_power_twice) {
          return left.worst_power_twice > right.worst_power_twice;
        }
        const std::uint64_t left_average = left.total_power_twice
          * right.transition.successors.size();
        const std::uint64_t right_average = right.total_power_twice
          * left.transition.successors.size();
        if (left_average != right_average) return left_average > right_average;
        if (left.worst_black != right.worst_black) return left.worst_black > right.worst_black;
        if (left.worst_white != right.worst_white) return left.worst_white < right.worst_white;
        if ((left.wait_ticks == 0) != (right.wait_ticks == 0)) return left.wait_ticks == 0;
        if (left.wait_ticks != right.wait_ticks) return left.wait_ticks < right.wait_ticks;
        if (left.timing_choice != right.timing_choice) {
          return left.timing_choice < right.timing_choice;
        }
        if (left.transition.successors.size() != right.transition.successors.size()) {
          return left.transition.successors.size() < right.transition.successors.size();
        }
        return left.stable_order < right.stable_order;
      };
      const bool timing_controlled = states_[state_id].key.alignment_credit > 0;
      const std::optional<Move> hinted_move = move_hint_
        ? move_hint_(position, states_[state_id].key.phase) : std::nullopt;
      // A controlled action always targets the later adjacent completion.
      // From any sub-tick offset, the response can arrive either there or one
      // phase earlier; runtime can wait from the earlier result to the target,
      // but it can never undo an arrival that overshot an earlier target.
      const std::size_t timing_variants = 1U;
      const std::size_t move_spec_count = moves.size() * timing_variants;
      for (std::size_t order = 0; order < move_spec_count; ++order) {
        const std::size_t move_index = order / timing_variants;
        const std::uint8_t timing_choice = !timing_controlled
          ? 255U : 1U;
        const std::uint8_t wait_ticks = 0U;
        const Move move = moves[move_index];
        if (attempted(move, wait_ticks, timing_choice)) continue;
        SeededTimingModel action_timing = timing_;
        action_timing.playtime_epoch = epoch_at(states_[state_id].key.phase);
        if (timing_controlled) {
          action_timing.runtime_uncertainty_ticks = 0;
          action_timing.include_fractional_wait_rounding = false;
        }
        SeededTransition candidate_transition = seeded_action_transition(
          position, states_[state_id].key.phase, move, opponent_, action_timing);
        if (timing_controlled && timing_choice != 0) {
          for (SeededStateKey& successor : candidate_transition.successors) {
            if (successor.position.consecutive_passes < 2) {
              successor.phase = normalize_phase(
                static_cast<std::uint64_t>(successor.phase) + timing_choice);
            }
          }
        }
        Candidate candidate{
          .move = move,
          .wait_ticks = wait_ticks,
          .timing_choice = timing_choice,
          .transition = std::move(candidate_transition),
          .immediate_win = true,
          .hinted = hinted_move && *hinted_move == move,
          .stable_order = order,
        };
        seed_evaluations_ += candidate.transition.seed_evaluations;
        white_reply_outcomes_ += candidate.transition.white_reply_outcomes;
        for (const SeededStateKey& successor : candidate.transition.successors) {
          const Score score = symmetry_cached_score(successor.position.board, komi_);
          const auto [black, white] = stone_counts(successor.position.board);
          const std::uint32_t power = static_cast<std::uint32_t>(
            std::llround(score.black * 2.0));
          candidate.worst_power_twice = std::min(candidate.worst_power_twice, power);
          candidate.total_power_twice += power;
          candidate.worst_black = std::min(candidate.worst_black, black);
          candidate.worst_white = std::max(candidate.worst_white, white);
          candidate.immediate_win = candidate.immediate_win
            && successor.position.consecutive_passes >= 2 && score.black > score.white;
        }
        candidates.push_back(std::move(candidate));
      }

      // ALIGN is a genuine Black OR action. Admit it independently of ordinary
      // placement ordering so timing control is considered immediately.
      if (!attempted(Move{}, 1U, 255U)) {
        SeededTransition transition;
        transition.successors.push_back({
          states_[state_id].key.position,
          normalize_phase(static_cast<std::uint64_t>(states_[state_id].key.phase) + 1U),
          0,
          timing_.alignment_boards,
        });
        const Score score = symmetry_cached_score(states_[state_id].key.position.board, komi_);
        const auto [black, white] = stone_counts(states_[state_id].key.position.board);
        const std::uint32_t power = static_cast<std::uint32_t>(
          std::llround(score.black * 2.0));
        candidates.push_back({
          .move = Move{},
          .wait_ticks = 1U,
          .timing_choice = 255U,
          .transition = std::move(transition),
          .immediate_win = false,
          .worst_power_twice = power,
          .total_power_twice = power,
          .worst_black = black,
          .worst_white = white,
          .stable_order = move_spec_count,
        });
      }
      if (candidates.empty()) {
        states_[state_id].expanded = true;
        if (!states_[state_id].outgoing_actions.empty()
          && std::all_of(states_[state_id].outgoing_actions.begin(),
            states_[state_id].outgoing_actions.end(), [&](std::uint32_t action) {
              return actions_[action].status == GraphStatus::loss;
            })) {
          set_state_status(state_id, GraphStatus::loss);
        }
        return;
      }

      std::stable_sort(candidates.begin(), candidates.end(), better);
      std::vector<std::size_t> selected_candidates;
      const bool optimizing = states_[state_id].status == GraphStatus::win;
      if (optimizing) {
        selected_candidates.resize(candidates.size());
        for (std::size_t index = 0; index < candidates.size(); ++index) {
          selected_candidates[index] = index;
        }
      } else {
        // Materialize one OR candidate at a time. The global best-first queue
        // decides which unresolved branch receives the next expansion. Under
        // ordinary timing uncertainty, prove ALIGN first: it turns the next
        // alignment_boards replies into controlled single-phase transitions
        // and usually establishes a robust incumbent before exploring the
        // much larger unaligned AND tree. This is ordering only.
        const bool tried_any = !states_[state_id].outgoing_actions.empty();
        const bool tried_alignment = std::any_of(states_[state_id].outgoing_actions.begin(),
          states_[state_id].outgoing_actions.end(), [&](std::uint32_t action) {
            return actions_[action].wait_ticks != 0;
          });
        const auto alignment = std::find_if(candidates.begin(), candidates.end(),
          [](const Candidate& candidate) { return candidate.wait_ticks != 0; });
        const auto immediate = std::find_if(candidates.begin(), candidates.end(),
          [](const Candidate& candidate) {
            return candidate.wait_ticks == 0 && candidate.immediate_win;
          });
        if (!tried_any && immediate != candidates.end()) {
          selected_candidates.push_back(static_cast<std::size_t>(immediate - candidates.begin()));
        } else if (!tried_any && !timing_controlled
            && timing_.runtime_uncertainty_ticks != 0 && alignment != candidates.end()) {
          selected_candidates.push_back(static_cast<std::size_t>(alignment - candidates.begin()));
        } else if (tried_any && !tried_alignment && alignment != candidates.end()) {
          selected_candidates.push_back(static_cast<std::size_t>(alignment - candidates.begin()));
        } else {
          const auto ordinary = std::find_if(candidates.begin(), candidates.end(),
            [](const Candidate& candidate) { return candidate.wait_ticks == 0; });
          selected_candidates.push_back(static_cast<std::size_t>(
            (ordinary == candidates.end() ? candidates.begin() : ordinary) - candidates.begin()));
        }
      }
      for (const std::size_t candidate_index : selected_candidates) {
        Candidate& selected = candidates[candidate_index];
        SeededTransition& transition = selected.transition;
        std::vector<std::uint32_t> successors;
        successors.reserve(transition.successors.size());
        for (SeededStateKey& key : transition.successors) {
          key.round_depth = states_[state_id].key.round_depth + 1U;
          if (selected.wait_ticks == 0) {
            key.alignment_credit = states_[state_id].key.alignment_credit > 0
              ? static_cast<std::uint8_t>(states_[state_id].key.alignment_credit - 1U) : 0U;
          }
          successors.push_back(add_state(std::move(key)));
        }
        add_action(state_id, selected.move, selected.wait_ticks,
          selected.timing_choice, transition.action_class, std::move(successors));
      }
      if (!optimizing && states_[state_id].status == GraphStatus::win) {
        if (states_[start_id_].status == GraphStatus::win) continue;
        return;
      }
      if (states_[state_id].status != GraphStatus::win) {
        const bool unresolved = std::any_of(states_[state_id].outgoing_actions.begin(),
          states_[state_id].outgoing_actions.end(), [&](std::uint32_t action) {
            return actions_[action].status == GraphStatus::unknown;
          });
        if (unresolved) return;
        continue;
      }
      states_[state_id].expanded = true;
      if (states_[state_id].status == GraphStatus::unknown
          && std::all_of(states_[state_id].outgoing_actions.begin(),
            states_[state_id].outgoing_actions.end(), [&](std::uint32_t action) {
              return actions_[action].status == GraphStatus::loss;
            })) {
        set_state_status(state_id, GraphStatus::loss);
      }
      return;
    }
  }

  std::uint64_t frontier_count() const {
    auto frontier = frontier_;
    std::uint64_t result = 0;
    while (!frontier.empty()) {
      result += ready_for_black_work(frontier.top().state);
      frontier.pop();
    }
    return result;
  }

  SeededGraphStats stats() const {
    SeededGraphStats result{
      .states = states_.size(),
      .expanded_states = expanded_states_,
      .actions = actions_.size(),
      .frontier = frontier_count(),
      .proof_updates = proof_updates_,
      .collapsed_expansions = collapsed_expansions_,
      .seed_evaluations = seed_evaluations_,
      .white_reply_outcomes = white_reply_outcomes_,
      .transposition_hits = transposition_hits_,
      .fingerprint_collisions = fingerprint_collisions_,
    };
    result.estimated_bytes += states_.capacity() * sizeof(StateBucket)
      + actions_.capacity() * sizeof(ActionBucket);
    result.minimum_history_depth = states_.empty()
      ? 0 : std::numeric_limits<std::uint64_t>::max();
    std::uint64_t total_history_depth = 0;
    std::uint64_t total_round_depth = 0;
    for (const StateBucket& state : states_) {
      result.winning_states += state.status == GraphStatus::win;
      result.losing_states += state.status == GraphStatus::loss;
      result.horizon_cutoffs += state.key.position.consecutive_passes < 2
        && state.key.round_depth >= max_rounds_;
      result.estimated_bytes += state.key.position.previous_boards.capacity() * sizeof(PackedBoard)
        + state.outgoing_actions.capacity() * sizeof(std::uint32_t)
        + state.incoming_actions.capacity() * sizeof(std::uint32_t);
      const std::uint64_t depth = state.key.position.previous_boards.size();
      result.minimum_history_depth = std::min(result.minimum_history_depth, depth);
      result.maximum_history_depth = std::max(result.maximum_history_depth, depth);
      total_history_depth += depth;
      result.maximum_round_depth = std::max<std::uint64_t>(
        result.maximum_round_depth, state.key.round_depth);
      total_round_depth += state.key.round_depth;
    }
    for (const ActionBucket& action : actions_) {
      result.edges += action.successors.size();
      result.phase_branches += action.successors.size();
      result.estimated_bytes += action.successors.capacity() * sizeof(std::uint32_t);
      result.exact_single_reply_actions += action.action_class == SeededActionClass::exact_single_reply;
      result.exact_seed_window_actions += action.action_class == SeededActionClass::exact_seed_window;
      result.unseeded_defense_tie_actions += action.action_class == SeededActionClass::unseeded_defense_tie;
      result.voluntary_wait_actions += action.wait_ticks != 0;
    }
    result.average_history_depth = states_.empty() ? 0.0
      : static_cast<double>(total_history_depth) / static_cast<double>(states_.size());
    result.average_round_depth = states_.empty() ? 0.0
      : static_cast<double>(total_round_depth) / static_cast<double>(states_.size());
    return result;
  }

  void rebuild_runtime() {
    primary_index_.clear();
    collision_index_.clear();
    frontier_ = {};
    for (StateBucket& state : states_) {
      state.outgoing_actions.clear();
      state.incoming_actions.clear();
    }
    for (std::uint32_t id = 0; id < states_.size(); ++id) insert_index(id);
    for (std::uint32_t action_id = 0; action_id < actions_.size(); ++action_id) {
      ActionBucket& action = actions_[action_id];
      if (action.parent >= states_.size()) throw std::runtime_error("seeded snapshot action parent out of range");
      states_[action.parent].outgoing_actions.push_back(action_id);
      for (const std::uint32_t successor : action.successors) {
        if (successor >= states_.size()) throw std::runtime_error("seeded snapshot successor out of range");
        states_[successor].incoming_actions.push_back(action_id);
      }
    }
    for (std::uint32_t id = 0; id < states_.size(); ++id) {
      if (ready_for_black_work(id)) enqueue(id);
    }
  }

  void validate() const {
    for (const StateBucket& state : states_) {
      if (state.key.phase >= seeded_phase_count) throw std::runtime_error("seeded snapshot phase out of range");
      if (state.key.round_depth > max_rounds_) {
        throw std::runtime_error("seeded snapshot round depth exceeds its horizon");
      }
      if (state.key.alignment_credit > timing_.alignment_boards) {
        throw std::runtime_error("seeded snapshot alignment credit is invalid");
      }
      if (state.key.position.consecutive_passes >= 2) {
        const Score score = symmetry_cached_score(state.key.position.board, komi_);
        const GraphStatus expected = score.black > score.white ? GraphStatus::win : GraphStatus::loss;
        if (!state.expanded || state.status != expected || !state.outgoing_actions.empty()) {
          throw std::runtime_error("seeded snapshot terminal state is inconsistent");
        }
      } else if (state.key.round_depth == max_rounds_
        && (!state.expanded || state.status != GraphStatus::loss
          || !state.outgoing_actions.empty())) {
        throw std::runtime_error("seeded snapshot horizon cutoff is inconsistent");
      }
    }
    for (const ActionBucket& action : actions_) {
      if (action.wait_ticks > 1) {
        throw std::runtime_error("seeded snapshot wait offset is invalid");
      }
      if (action.wait_ticks != 0 && (action.move.pass || action.move.no_op)) {
        throw std::runtime_error("seeded snapshot wait is encoded as a Go move");
      }
      const bool controlled_parent = states_[action.parent].key.alignment_credit > 0;
      if ((action.wait_ticks != 0 && action.timing_choice != 255)
        || (action.wait_ticks == 0 && controlled_parent && action.timing_choice > 1)
        || (action.wait_ticks == 0 && !controlled_parent && action.timing_choice != 255)) {
        throw std::runtime_error("seeded snapshot timing choice is inconsistent");
      }
      if (!std::is_sorted(action.successors.begin(), action.successors.end())
        || std::adjacent_find(action.successors.begin(), action.successors.end()) != action.successors.end()) {
        throw std::runtime_error("seeded snapshot successors are not canonical");
      }
      bool loss = false;
      std::uint32_t remaining = 0;
      for (const std::uint32_t successor : action.successors) {
        if (states_[successor].key.round_depth
          != states_[action.parent].key.round_depth + 1U) {
          throw std::runtime_error("seeded snapshot edge has inconsistent round depth");
        }
        if (action.wait_ticks != 0) {
          if (states_[successor].key.position != states_[action.parent].key.position
            || states_[successor].key.phase != normalize_phase(
              static_cast<std::uint64_t>(states_[action.parent].key.phase) + 1U)
            || states_[successor].key.alignment_credit != timing_.alignment_boards) {
            throw std::runtime_error("seeded snapshot phase-alignment edge is inconsistent");
          }
        } else {
          const std::uint8_t expected_credit = controlled_parent
            ? static_cast<std::uint8_t>(states_[action.parent].key.alignment_credit - 1U) : 0U;
          if (states_[successor].key.alignment_credit != expected_credit) {
            throw std::runtime_error("seeded snapshot alignment consumption is inconsistent");
          }
        }
        loss = loss || states_[successor].status == GraphStatus::loss;
        remaining += states_[successor].status != GraphStatus::win;
      }
      if (action.status == GraphStatus::unknown && (loss || remaining != action.remaining_wins)) {
        throw std::runtime_error("seeded snapshot unknown action is inconsistent");
      }
      if (action.status == GraphStatus::win && (loss || remaining != 0 || action.remaining_wins != 0)) {
        throw std::runtime_error("seeded snapshot winning action is inconsistent");
      }
      if (action.status == GraphStatus::loss && !loss) {
        throw std::runtime_error("seeded snapshot losing action is inconsistent");
      }
    }
  }

  struct CertificateResult {
    std::uint64_t states{};
    std::uint64_t terminals{};
    double expected_power_per_turn{};
  };

  PolicyQuality policy_quality(std::uint32_t id,
    long double rate,
    std::unordered_map<std::uint32_t, PolicyQuality>& quality_cache,
    std::unordered_map<std::uint32_t, std::uint32_t>* selected_actions) const {
    if (const auto found = quality_cache.find(id); found != quality_cache.end()) {
      return found->second;
    }
    const StateBucket& state = states_[id];
    if (state.key.position.consecutive_passes >= 2) {
      const Score score = symmetry_cached_score(state.key.position.board, komi_);
      return quality_cache.emplace(id, PolicyQuality{
        score.black, static_cast<long double>(state.key.round_depth), 1.0L}).first->second;
    }
    const auto better_quality = [&](const PolicyQuality& left, const PolicyQuality& right) {
      const long double left_value = left.total_power - rate * left.total_turns;
      const long double right_value = right.total_power - rate * right.total_turns;
      if (left_value != right_value) return left_value > right_value;
      if (left.total_power != right.total_power) return left.total_power > right.total_power;
      return left.total_turns < right.total_turns;
    };
    std::optional<PolicyQuality> best;
    std::uint32_t best_action = 0;
    for (const std::uint32_t action_id : state.outgoing_actions) {
      const ActionBucket& action = actions_[action_id];
      if (action.status != GraphStatus::win) continue;
      PolicyQuality candidate;
      for (const std::uint32_t successor : action.successors) {
        const PolicyQuality child = policy_quality(
          successor, rate, quality_cache, selected_actions);
        candidate.total_power += child.total_power;
        candidate.total_turns += child.total_turns;
        candidate.routes += child.routes;
      }
      // A later-edge (slot-1) action proves only the base+1 arrival; the
      // runtime realizes it by waiting whenever White lands on the base
      // phase, wasting half an engine tick in expectation. Charge that so the
      // optimizer keeps following the wider base branch wherever it is
      // genuinely more valuable. optimization_bound stays admissible: it
      // underestimates turns, which only loosens the upper bound.
      if (action.wait_ticks == 0 && action.timing_choice == 1) {
        candidate.total_turns += later_edge_wait_penalty_turns * candidate.routes;
      }
      if (!best || better_quality(candidate, *best)) {
        best = candidate;
        best_action = action_id;
      }
    }
    if (!best) throw std::logic_error("winning seeded state lacks a winning action");
    if (selected_actions) (*selected_actions)[id] = best_action;
    quality_cache.emplace(id, *best);
    return *best;
  }

  PolicyQuality optimal_policy(
    std::unordered_map<std::uint32_t, std::uint32_t>* selected_actions = nullptr) const {
    long double rate = 0.0L;
    PolicyQuality quality;
    PolicyQuality previous{-1.0L, -1.0L, -1.0L};
    for (unsigned iteration = 0; iteration < 64; ++iteration) {
      std::unordered_map<std::uint32_t, PolicyQuality> cache;
      quality = policy_quality(start_id_, rate, cache, nullptr);
      if (quality.total_power == previous.total_power
        && quality.total_turns == previous.total_turns) break;
      previous = quality;
      const long double next = quality.total_power / quality.total_turns;
      if (std::abs(next - rate) <= 1e-12L) {
        rate = next;
        break;
      }
      rate = next;
    }
    std::unordered_map<std::uint32_t, PolicyQuality> cache;
    return policy_quality(start_id_, rate, cache, selected_actions);
  }

  double incumbent_power_per_turn() const {
    const PolicyQuality quality = optimal_policy();
    return static_cast<double>(quality.total_power / quality.total_turns);
  }

  CertificateResult save_certificate(const std::filesystem::path& path,
    bool globally_optimal) const {
    if (path.has_parent_path()) std::filesystem::create_directories(path.parent_path());
    const std::filesystem::path temporary = path.string() + ".tmp";
    std::ofstream output(temporary, std::ios::trunc);
    if (!output) throw std::runtime_error("cannot write seeded certificate " + temporary.string());
    std::unordered_map<std::uint32_t, std::uint32_t> selected_actions;
    const PolicyQuality root_quality = optimal_policy(&selected_actions);

    output << "# ipvgo-seeded-certificate-v6\n"
      << "# start_phase\t" << expected_start_.phase << "\n"
      << "# runtime_uncertainty_ticks\t" << timing_.runtime_uncertainty_ticks << "\n"
      << "# ai_seed_slip_ticks\t" << timing_.ai_seed_slip_ticks << "\n"
      << "# playtime_epoch\t" << timing_.playtime_epoch << "\n"
      << "# alignment_boards\t" << static_cast<unsigned>(timing_.alignment_boards) << "\n"
      << "# max_rounds\t" << max_rounds_ << "\n"
      << "# objective\taggregate_power_per_turn_over_materialized_winning_actions\n"
      << "# objective_scope\t" << (globally_optimal
        ? "all_legal_actions_within_max_rounds"
        : "resolved_winning_actions_incumbent_only") << "\n"
      << "# expected_power_per_turn\t" << static_cast<double>(
        root_quality.total_power / root_quality.total_turns) << "\n"
      << "state_id\tphase\tround\talign_credit\tboard\tpasses\thistory\taction\taction_class\tsuccessors\n";
    std::vector<std::uint32_t> pending{start_id_};
    std::unordered_set<std::uint32_t> visited;
    std::uint64_t terminals = 0;
    while (!pending.empty()) {
      const std::uint32_t id = pending.back();
      pending.pop_back();
      if (!visited.insert(id).second) continue;
      const StateBucket& state = states_[id];
      output << id << '\t' << state.key.phase << '\t' << state.key.round_depth << '\t'
        << static_cast<unsigned>(state.key.alignment_credit) << '\t'
        << board_hash(unpack_board(state.key.position.board)) << '\t'
        << static_cast<unsigned>(state.key.position.consecutive_passes) << '\t';
      for (std::size_t index = 0; index < state.key.position.previous_boards.size(); ++index) {
        if (index) output << ',';
        output << packed_board_hex(state.key.position.previous_boards[index]);
      }
      if (state.key.position.consecutive_passes >= 2) {
        const Score score = symmetry_cached_score(state.key.position.board, komi_);
        if (score.black <= score.white || state.status != GraphStatus::win) {
          throw std::logic_error("seeded certificate contains a non-winning terminal");
        }
        ++terminals;
        output << "\tterminal\tterminal\t\n";
        continue;
      }
      const auto action = selected_actions.find(id);
      if (action == selected_actions.end()) {
        throw std::logic_error("winning seeded state lacks a winning action");
      }
      const ActionBucket& selected = actions_[action->second];
      if (selected.status != GraphStatus::win) {
        throw std::logic_error("seeded certificate selected a non-winning action");
      }
      std::vector<SeededStateKey> replayed_keys;
      if (selected.wait_ticks != 0) {
        replayed_keys.push_back({state.key.position,
          normalize_phase(static_cast<std::uint64_t>(state.key.phase) + selected.wait_ticks),
          state.key.round_depth + 1U, timing_.alignment_boards});
      } else {
        SeededTimingModel replay_timing = timing_;
        replay_timing.playtime_epoch = epoch_at(state.key.phase);
        if (state.key.alignment_credit > 0) {
          replay_timing.runtime_uncertainty_ticks = 0;
          replay_timing.include_fractional_wait_rounding = false;
        }
        SeededTransition replayed = seeded_action_transition(
          unpack_position(state.key.position), state.key.phase, selected.move, opponent_, replay_timing);
        replayed_keys = std::move(replayed.successors);
        for (SeededStateKey& key : replayed_keys) {
          if (state.key.alignment_credit > 0 && selected.timing_choice != 0
            && key.position.consecutive_passes < 2) {
            key.phase = normalize_phase(
              static_cast<std::uint64_t>(key.phase) + selected.timing_choice);
          }
          key.round_depth = state.key.round_depth + 1U;
          key.alignment_credit = state.key.alignment_credit > 0
            ? static_cast<std::uint8_t>(state.key.alignment_credit - 1U) : 0U;
          if (key.position.consecutive_passes >= 2) key.phase = 0;
        }
      }
      std::vector<std::uint32_t> replayed_ids;
      replayed_ids.reserve(replayed_keys.size());
      for (const SeededStateKey& key : replayed_keys) {
        const auto successor = indexed(key);
        if (!successor) {
          std::ostringstream message;
          message << "seeded certificate replay produced a missing state: parent=" << id
            << " phase=" << state.key.phase << " round=" << state.key.round_depth
            << " credit=" << static_cast<unsigned>(state.key.alignment_credit)
            << " wait=" << static_cast<unsigned>(selected.wait_ticks)
            << " slot=" << static_cast<unsigned>(selected.timing_choice)
            << " successor_phase=" << key.phase << " successor_round=" << key.round_depth
            << " successor_credit=" << static_cast<unsigned>(key.alignment_credit)
            << " stored=";
          for (const std::uint32_t stored : selected.successors) {
            message << stored << ':' << states_[stored].key.phase << ':'
              << states_[stored].key.round_depth << ':'
              << static_cast<unsigned>(states_[stored].key.alignment_credit) << ',';
          }
          throw std::logic_error(message.str());
        }
        replayed_ids.push_back(*successor);
      }
      std::sort(replayed_ids.begin(), replayed_ids.end());
      replayed_ids.erase(std::unique(replayed_ids.begin(), replayed_ids.end()), replayed_ids.end());
      if (replayed_ids != selected.successors) {
        throw std::logic_error("seeded certificate action outcomes differ from exact replay");
      }
      if (std::any_of(selected.successors.begin(), selected.successors.end(),
        [&](std::uint32_t successor) {
          return states_[successor].status != GraphStatus::win;
        })) {
        throw std::logic_error("seeded certificate action has a non-winning adversarial outcome");
      }
      if (selected.wait_ticks != 0) output << "\talign\t";
      else if (selected.move.pass) {
        output << "\tpass";
        if (selected.timing_choice != 255) {
          output << "@slot" << static_cast<unsigned>(selected.timing_choice);
        }
        output << '\t';
      }
      else {
        output << '\t' << selected.move.point.x << ',' << selected.move.point.y;
        if (selected.timing_choice != 255) {
          output << "@slot" << static_cast<unsigned>(selected.timing_choice);
        }
        output << '\t';
      }
      output << seeded_action_class_name(selected.action_class) << '\t';
      for (std::size_t index = 0; index < selected.successors.size(); ++index) {
        if (index) output << ',';
        output << selected.successors[index];
        pending.push_back(selected.successors[index]);
      }
      output << '\n';
    }
    output.flush();
    if (!output) throw std::runtime_error("failed flushing seeded certificate");
    output.close();
    std::filesystem::rename(temporary, path);
    return {visited.size(), terminals,
      static_cast<double>(root_quality.total_power / root_quality.total_turns)};
  }

  SeededStateKey expected_start_;
  Opponent opponent_;
  double komi_{};
  SeededTimingModel timing_;
  std::uint32_t max_rounds_{};
  SeededMoveHint move_hint_;
  std::uint32_t start_id_{};
  std::vector<StateBucket> states_;
  std::vector<ActionBucket> actions_;
  std::unordered_map<std::uint64_t, std::uint32_t> primary_index_;
  std::unordered_map<std::uint64_t, std::vector<std::uint32_t>> collision_index_;
  std::priority_queue<FrontierEntry> frontier_;
  std::uint64_t expanded_states_{};
  std::uint64_t proof_updates_{};
  std::uint64_t collapsed_expansions_{};
  std::uint64_t seed_evaluations_{};
  std::uint64_t white_reply_outcomes_{};
  std::uint64_t transposition_hits_{};
  std::uint64_t fingerprint_collisions_{};
};

}  // namespace

SeededTransition seeded_action_transition(const Position& position, std::uint32_t dispatch_phase,
  Move black_move, Opponent opponent, const SeededTimingModel& timing) {
  if (dispatch_phase >= seeded_phase_count) throw std::invalid_argument("dispatch phase out of range");
  Position after_black = position;
  apply_to_position(after_black, black_move, Stone::black);
  SeededTransition result;
  if (after_black.consecutive_passes >= 2) {
    result.successors.push_back({pack_position(after_black), 0});
    return result;
  }

  bool unseeded_tie = false;
  std::unordered_set<std::string> reply_signatures;
  for (std::uint32_t slip = 0; slip <= timing.ai_seed_slip_ticks; ++slip) {
    const std::uint64_t unwrapped_seed_phase = static_cast<std::uint64_t>(dispatch_phase) + 1U + slip;
    const std::uint32_t seed_phase = normalize_phase(unwrapped_seed_phase);
    const std::uint64_t seed_epoch = static_cast<std::uint64_t>(timing.playtime_epoch)
      + unwrapped_seed_phase / seeded_phase_count;
    const double seed_playtime = static_cast<double>(seed_epoch) * go_whrng_period_ms
      + static_cast<double>(seed_phase) * go_engine_cycle_ms;
    const ReplyForecast forecast = predict_opponent_replies(
      after_black, opponent, seed_playtime);
    ++result.seed_evaluations;
    unseeded_tie = unseeded_tie || !forecast.exact;
    result.white_reply_outcomes += forecast.replies.size();
    for (const WeightedReply& reply : forecast.replies) {
      reply_signatures.insert(reply_signature(reply));
      Position after_white = after_black;
      apply_to_position(after_white, reply.move, Stone::white);
      // getMove() samples WHRNG after its first 200 ms wait. It then performs
      // a branch-dependent number of additional waitCycle() calls before the
      // makeMove() promise resolves. Priority/fallback selection and the final
      // White placement are real, distinct waits. Fixed pattern sleeps add
      // their completed ticks; their remainder is covered by the adjacent
      // runtime uncertainty below.
      const std::uint64_t earliest = static_cast<std::uint64_t>(dispatch_phase)
        + 1U + slip
        + static_cast<std::uint64_t>(std::max(0, reply.wait.cycle_waits_after_seed))
        + static_cast<std::uint64_t>(std::max(0, reply.wait.fixed_sleep_ms_after_seed))
          / static_cast<std::uint64_t>(go_engine_cycle_ms);
      for (std::uint32_t runtime = 0; runtime <= timing.runtime_uncertainty_ticks; ++runtime) {
        result.successors.push_back({pack_position(after_white),
          normalize_phase(earliest + runtime)});
      }
    }
  }
  std::sort(result.successors.begin(), result.successors.end(), state_key_less);
  result.successors.erase(std::unique(result.successors.begin(), result.successors.end()),
    result.successors.end());
  result.action_class = unseeded_tie ? SeededActionClass::unseeded_defense_tie
    : reply_signatures.size() == 1 ? SeededActionClass::exact_single_reply
    : SeededActionClass::exact_seed_window;
  return result;
}

SeededGraphResult search_seeded_graph(const Position& start, std::uint32_t start_phase,
  Opponent opponent, double komi, const SeededTimingModel& timing,
  const SeededGraphLimits& limits, const std::filesystem::path& snapshot, bool resume,
  const std::filesystem::path& certificate, const SeededGraphProgress& progress,
  const SeededGraphStopCheck& keep_running, const SeededMoveHint& move_hint) {
  if (start.board.size != 5) {
    throw std::invalid_argument("packed single-seed proof requires a 5x5 board");
  }
  SeededGraph graph = resume
    ? SeededGraph::load(snapshot, start, start_phase, opponent, komi, timing,
      limits.max_rounds, move_hint)
    : SeededGraph(start, start_phase, opponent, komi, timing, limits.max_rounds, move_hint);
  return graph.run(limits, snapshot, certificate, progress, keep_running);
}

const char* seeded_action_class_name(SeededActionClass value) {
  switch (value) {
    case SeededActionClass::exact_single_reply: return "exact-single";
    case SeededActionClass::exact_seed_window: return "exact-window";
    case SeededActionClass::unseeded_defense_tie: return "math-random-tie";
  }
  return "unknown";
}

}  // namespace ipvgobruteforce
