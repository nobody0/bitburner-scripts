#include "go/arena.hpp"
#include "go/board_generator.hpp"
#include "go/candidates.hpp"
#include "go/opponent.hpp"
#include "go/reward.hpp"
#include "go/rng.hpp"
#include "go/rules.hpp"
#include "go/transition.hpp"

#include <algorithm>
#include <array>
#include <atomic>
#include <chrono>
#include <cmath>
#include <cstdlib>
#include <iomanip>
#include <iostream>
#include <mutex>
#include <optional>
#include <random>
#include <sstream>
#include <stdexcept>
#include <string>
#include <thread>
#include <unordered_map>
#include <vector>

namespace {

using namespace bitburner::go;

constexpr std::array<Opponent, 6> ordinary_opponents{
  Opponent::netburners, Opponent::slum_snakes, Opponent::black_hand,
  Opponent::tetrads, Opponent::daedalus, Opponent::illuminati,
};

using ProfileClock = std::chrono::steady_clock;

struct WorkProfile {
  std::uint64_t candidate_generation_ns{};
  std::uint64_t opponent_analysis_ns{};
  std::uint64_t protocol_serialization_ns{};
  std::uint64_t candidates{};
  std::uint64_t replies{};

  WorkProfile& operator+=(const WorkProfile& other) {
    candidate_generation_ns += other.candidate_generation_ns;
    opponent_analysis_ns += other.opponent_analysis_ns;
    protocol_serialization_ns += other.protocol_serialization_ns;
    candidates += other.candidates;
    replies += other.replies;
    return *this;
  }
};

std::uint64_t elapsed_ns(ProfileClock::time_point started) {
  return static_cast<std::uint64_t>(
    std::chrono::duration_cast<std::chrono::nanoseconds>(
      ProfileClock::now() - started).count());
}

double sampled_seed(std::mt19937_64& random, bool portable = false) {
  // Live decisions are aligned to 200 ms ticks. Across WHRNG's 30,000-second
  // period this gives 150,000 distinct reachable phases.
  if (portable) return static_cast<double>((random() % 150'000) * 200);
  std::uniform_int_distribution<int> tick(0, 149'999);
  return static_cast<double>(tick(random) * 200);
}

// The index is what the learner needs, not the move: a superko-rejected reply
// and a pass both leave the board untouched, so a played reply cannot be
// recovered from the resulting position afterwards.
std::size_t sample_reply_index(
  const ReplyForecast& forecast,
  std::mt19937_64& random,
  bool portable = false
) {
  if (forecast.replies.empty()) throw std::runtime_error("opponent forecast has no replies");
  std::uniform_real_distribution<double> unit(0.0, 1.0);
  // The engine is standardized but the distributions are not. Benchmark mode
  // uses an exact 53-bit conversion so libc++ and libstdc++ see identical work.
  const double roll = portable
    ? static_cast<double>(random() >> 11) * 0x1.0p-53
    : unit(random);
  double cumulative = 0;
  for (std::size_t index = 0; index < forecast.replies.size(); ++index) {
    cumulative += forecast.replies[index].probability;
    if (roll <= cumulative) return index;
  }
  return forecast.replies.size() - 1;
}

struct Slot {
  int id{};
  int episode{};
  Opponent opponent{Opponent::netburners};
  Position position;
  std::mt19937_64 environment;
  std::mt19937_64 counterfactual;
  double dispatch_playtime{};
  /** Wall-clock milliseconds past the last engine rollover at dispatch. The
   * engine converts wall time to Player.totalPlaytime in 200 ms ticks, so the
   * branch-exact reply base slips one extra tick whenever this offset plus
   * the turn's fractional time crosses a rollover. White's seed is
   * unaffected: its first wait is a full cycle, so the seed phase is always
   * dispatch + 1 regardless of the offset. */
  double sub_tick_offset_ms{};
  int rounds{};
  bool portable_benchmark{};
  std::vector<Move> candidates;
  std::vector<Position> candidate_positions;
  std::vector<std::string> candidate_boards;
  // Index of the sampled reply within each candidate's forecast, in the same
  // order the V9 record lists them.
  std::vector<std::size_t> candidate_reply_indices;
  std::vector<double> candidate_next_dispatch_playtimes;
  std::vector<double> candidate_next_offsets;
  std::string v9_original_input;
  std::string v9_behavior;
  std::string v9_future_behavior;
  std::vector<std::string> v9_candidates;
};

struct TransitionEvent {
  int slot{};
  int episode{};
  int turn{};
  int opponent{};
  std::string after_reply;
  std::size_t reply_index{};
};

struct ResultEvent {
  int slot{};
  int episode{};
  bool won{};
  double power{};
  int rounds{};
};

Slot make_slot(
  int id,
  int episode,
  std::uint64_t game_seed,
  std::size_t opponent_offset,
  const std::string& profile,
  bool portable_benchmark = false
) {
  Slot slot{
    .id = id,
    .episode = episode,
    .opponent = profile == "small5"
      ? ordinary_opponents[(static_cast<std::size_t>(episode) + opponent_offset)
          % ordinary_opponents.size()]
      : Opponent::world_daemon,
    .environment = std::mt19937_64(game_seed),
    .counterfactual = std::mt19937_64(game_seed ^ 0x6a09e667f3bcc909ULL),
    .portable_benchmark = portable_benchmark,
  };
  const int size = profile == "small5" ? 5 : 19;
  const double board_seed = sampled_seed(slot.environment, portable_benchmark);
  slot.dispatch_playtime = board_seed;
  // The live controller resets and dispatches early in the entry tick (its
  // safe opening window is the first 50 ms).
  slot.sub_tick_offset_ms = static_cast<double>(slot.environment() % 50ULL);
  slot.position.board = initial_board(
    size, slot.opponent, board_seed,
    static_cast<std::uint32_t>(slot.environment()));
  return slot;
}

std::string encoded_input(const Position& position, const Move& response) {
  const int size = position.board.size;
  std::string legal(static_cast<std::size_t>(size * size), '0');
  for (const Point point : legal_moves(position, Stone::black)) {
    legal[static_cast<std::size_t>(point.x * size + point.y)] = '1';
  }
  return board_hash(position.board) + '|' + legal + '|'
    + std::to_string(position.consecutive_passes) + '|'
    + (response.pass ? "1" : "0") + '|' + (response.no_op ? "1" : "0");
}

std::string comma_values(const std::vector<float>& values) {
  std::ostringstream output;
  output << std::setprecision(9);
  for (std::size_t index = 0; index < values.size(); ++index) {
    if (index) output << ',';
    output << values[index];
  }
  return output.str();
}

void prepare_candidates(Slot& slot, WorkProfile* profile = nullptr) {
  const auto enumeration_started = profile ? ProfileClock::now() : ProfileClock::time_point{};
  slot.candidates.clear();
  slot.candidate_positions.clear();
  slot.candidate_boards.clear();
  slot.candidate_reply_indices.clear();
  slot.candidate_next_dispatch_playtimes.clear();
  slot.candidate_next_offsets.clear();
  slot.v9_original_input.clear();
  slot.v9_behavior.clear();
  slot.v9_future_behavior.clear();
  slot.v9_candidates.clear();
  slot.candidates = ordered_legal_moves(slot.position, 0);
  slot.candidates.push_back(Move::pass_turn());
  // Training covers every legal move. The heuristic shortlist is recorded per
  // candidate so recall on the moves outside it stays measurable.
  std::unordered_map<int, bool> heuristic_shortlist;
  if (slot.position.board.size >= 19) {
    for (const Move move : ordered_legal_moves(slot.position, daemon19_candidate_limit)) {
      heuristic_shortlist.emplace(move.point.x * slot.position.board.size + move.point.y, true);
    }
  } else {
    for (const Move move : slot.candidates) {
      if (!move.pass) heuristic_shortlist.emplace(
        move.point.x * slot.position.board.size + move.point.y, true);
    }
  }
  if (profile) {
    profile->candidate_generation_ns += elapsed_ns(enumeration_started);
    profile->candidates += slot.candidates.size();
  }
  const auto header_started = profile ? ProfileClock::now() : ProfileClock::time_point{};
  const double reply_seed = aligned_opponent_seed(slot.dispatch_playtime);
  slot.v9_original_input = encoded_input(slot.position, Move{});
  const double komi = slot.position.board.size == 5 ? opponent_komi(slot.opponent) : -1.0;
  slot.v9_behavior = comma_values(encode_opponent_turn_behavior(
    opponent_turn_behavior(slot.opponent, reply_seed), komi));
  slot.v9_future_behavior = comma_values(
    encode_opponent_future_behavior(slot.opponent, komi));
  if (profile) profile->protocol_serialization_ns += elapsed_ns(header_started);
  slot.v9_candidates.reserve(slot.candidates.size());
  slot.candidate_positions.reserve(slot.candidates.size());
  slot.candidate_boards.reserve(slot.candidates.size());
  slot.candidate_reply_indices.reserve(slot.candidates.size());
  slot.candidate_next_dispatch_playtimes.reserve(slot.candidates.size());
  slot.candidate_next_offsets.reserve(slot.candidates.size());
  // One draw per turn: other scripts and Black's own planning consume an
  // uncontrolled 5..90 ms of CPU between observing the reply and the next
  // dispatch. Shared across candidates so counterfactuals stay paired; drawn
  // from raw 64-bit output so libc++ and libstdc++ benchmarks agree.
  const double turn_jitter_ms = 5.0 + static_cast<double>(slot.counterfactual() % 86ULL);
  for (const Move move : slot.candidates) {
    const auto candidate_started = profile ? ProfileClock::now() : ProfileClock::time_point{};
    Position after_black = slot.position;
    apply_to_position(after_black, move, Stone::black);
    if (profile) profile->candidate_generation_ns += elapsed_ns(candidate_started);
    ReplyForecast forecast;
    if (after_black.consecutive_passes >= 2) {
      forecast = {.replies = {{
        .move = Move::pass_turn(), .probability = 1.0,
        .branch = ReplyBranch::pass,
      }}, .exact = true};
    } else {
      const auto opponent_started = profile ? ProfileClock::now() : ProfileClock::time_point{};
      forecast = predict_opponent_replies(after_black, slot.opponent, reply_seed);
      if (profile) profile->opponent_analysis_ns += elapsed_ns(opponent_started);
    }
    if (profile) profile->replies += forecast.replies.size();
    const auto transition_started = profile ? ProfileClock::now() : ProfileClock::time_point{};
    const std::size_t reply_index = sample_reply_index(
      forecast, slot.counterfactual, slot.portable_benchmark);
    const Move reply = forecast.replies[reply_index].move;
    slot.candidate_reply_indices.push_back(reply_index);
    const ReplyWait wait = forecast.replies[reply_index].wait;
    // Branch-exact wall time (pre-seed cycle + per-branch waitCycles + fixed
    // pattern sleeps) plus the turn's uncontrolled jitter, converted to ticks
    // through the tracked sub-tick offset. This reproduces live play's
    // base/base+1 arrival window instead of always landing on the base.
    const double wall_ms = go_engine_cycle_ms
      * (1.0 + static_cast<double>(std::max(0, wait.cycle_waits_after_seed)))
      + static_cast<double>(std::max(0, wait.fixed_sleep_ms_after_seed))
      + turn_jitter_ms;
    const double advanced_ms = slot.sub_tick_offset_ms + wall_ms;
    const double elapsed_ticks = std::floor(advanced_ms / go_engine_cycle_ms);
    slot.candidate_next_dispatch_playtimes.push_back(normalize_go_playtime(
      slot.dispatch_playtime + elapsed_ticks * go_engine_cycle_ms));
    slot.candidate_next_offsets.push_back(
      advanced_ms - elapsed_ticks * go_engine_cycle_ms);
    Position after = after_black;
    if (after.consecutive_passes < 2) apply_to_position(after, reply, Stone::white);
    slot.candidate_boards.push_back(board_hash(after.board));
    if (profile) profile->candidate_generation_ns += elapsed_ns(transition_started);
    {
      const auto serialization_started = profile
        ? ProfileClock::now() : ProfileClock::time_point{};
      std::ostringstream record;
      const int move_index = move.pass ? after.board.size * after.board.size
        : move.point.x * after.board.size + move.point.y;
      const bool in_heuristic_shortlist = move.pass || heuristic_shortlist.contains(move_index);
      record << move_index << '~' << (in_heuristic_shortlist ? 1 : 0)
        << '~' << std::setprecision(17);
      for (std::size_t index = 0; index < forecast.replies.size(); ++index) {
        if (index) record << '^';
        const auto& weighted = forecast.replies[index];
        Position outcome = after_black;
        if (outcome.consecutive_passes < 2) {
          apply_to_position(outcome, weighted.move, Stone::white);
        }
        record << weighted.probability << ',' << static_cast<int>(weighted.branch)
          << ',' << encoded_input(outcome, weighted.move);
        if (outcome.consecutive_passes >= 2) {
          const auto terminal = terminal_reward(
            score_board(outcome.board, opponent_komi(slot.opponent)),
            opponent_name(slot.opponent), outcome.board.size);
          record << ',' << (terminal.won ? 1 : 0) << ',' << terminal.training_power;
        } else {
          record << ",-,-";
        }
      }
      slot.v9_candidates.push_back(record.str());
      if (profile) profile->protocol_serialization_ns += elapsed_ns(serialization_started);
    }
    slot.candidate_positions.push_back(std::move(after));
  }
}

void prepare_all(
  std::vector<Slot>& slots,
  int thread_count,
  WorkProfile* profile = nullptr
) {
  const std::size_t workers = std::min(
    slots.size(), static_cast<std::size_t>(std::max(thread_count, 1)));
  std::atomic<std::size_t> next{};
  std::exception_ptr failure;
  std::mutex failure_mutex;
  std::vector<WorkProfile> slot_profiles;
  if (profile) slot_profiles.resize(slots.size());
  const auto work = [&] {
    try {
      while (true) {
        const std::size_t index = next.fetch_add(1);
        if (index >= slots.size()) break;
        prepare_candidates(slots[index], profile ? &slot_profiles[index] : nullptr);
      }
    } catch (...) {
      std::lock_guard lock(failure_mutex);
      if (!failure) failure = std::current_exception();
    }
  };
  std::vector<std::thread> threads;
  threads.reserve(workers > 0 ? workers - 1 : 0);
  for (std::size_t worker = 1; worker < workers; ++worker) threads.emplace_back(work);
  work();
  for (auto& thread : threads) thread.join();
  if (failure) std::rethrow_exception(failure);
  if (profile) {
    for (const auto& slot_profile : slot_profiles) *profile += slot_profile;
  }
}

}  // namespace

int main(int argc, char** argv) {
  try {
    if (argc < 5 || argc > 8) {
      throw std::invalid_argument(
        "usage: go_cpp_gpu_env GAMES SEED ENVIRONMENTS small5|daemon19 [THREADS] [v9] [deterministic-benchmark]");
    }
    const int games = std::stoi(argv[1]);
    const std::uint64_t seed = std::stoull(argv[2]);
    const int environments = std::stoi(argv[3]);
    const std::string profile = argv[4];
    const int thread_count = argc >= 6 ? std::stoi(argv[5])
      : static_cast<int>(std::max(1U, std::thread::hardware_concurrency()));
    if (argc >= 7 && std::string(argv[6]) != "v9") {
      throw std::invalid_argument("v9 is the only supported topology");
    }
    const bool portable_benchmark = argc >= 8
      && std::string(argv[7]) == "deterministic-benchmark";
    if (argc >= 8 && !portable_benchmark) {
      throw std::invalid_argument("unknown GPU environment execution mode");
    }
    if (games <= 0 || environments <= 0 || thread_count <= 0) {
      throw std::invalid_argument("GAMES, ENVIRONMENTS, and THREADS must be positive");
    }
    if (profile != "small5" && profile != "daemon19") {
      throw std::invalid_argument("profile must be small5 or daemon19");
    }

    std::mt19937_64 schedule(seed);
    const std::size_t opponent_offset = static_cast<std::size_t>(
      schedule() % ordinary_opponents.size());
    std::vector<std::uint64_t> game_seeds(static_cast<std::size_t>(games));
    for (auto& game_seed : game_seeds) game_seed = schedule();

    int next_episode = 0;
    int completed = 0;
    std::vector<Slot> slots;
    const int initial = std::min(games, environments);
    slots.reserve(static_cast<std::size_t>(environments));
    for (int id = 0; id < initial; ++id) {
      slots.push_back(make_slot(
        id, next_episode, game_seeds[static_cast<std::size_t>(next_episode)],
        opponent_offset, profile, portable_benchmark));
      ++next_episode;
    }

    std::vector<TransitionEvent> transitions;
    std::vector<ResultEvent> results;
    std::uint64_t profile_block = 0;
    std::cout << std::setprecision(17);
    while (!slots.empty()) {
      WorkProfile work_profile;
      for (const auto& transition : transitions) {
        std::cout << "T\t" << transition.slot << '\t' << transition.episode << '\t'
          << transition.turn << '\t' << transition.opponent << '\t'
          << transition.after_reply << '\t' << transition.reply_index << '\n';
      }
      transitions.clear();
      for (const auto& result : results) {
        std::cout << "R\t" << result.slot << '\t' << result.episode << '\t'
          << (result.won ? 1 : 0) << '\t' << result.power << '\t'
          << result.rounds << '\n';
      }
      results.clear();
      const auto prepare_started = portable_benchmark
        ? ProfileClock::now() : ProfileClock::time_point{};
      prepare_all(slots, thread_count, portable_benchmark ? &work_profile : nullptr);
      const std::uint64_t prepare_wall_ns = portable_benchmark
        ? elapsed_ns(prepare_started) : 0;
      const auto output_started = portable_benchmark
        ? ProfileClock::now() : ProfileClock::time_point{};
      for (auto& slot : slots) {
        std::cout << "S9\t" << slot.id << '\t' << slot.episode << '\t'
          << static_cast<int>(slot.opponent) << '\t' << slot.rounds << '\t'
          << slot.v9_behavior << '\t' << slot.v9_future_behavior << '\t'
          << slot.v9_original_input << '\t'
          << slot.v9_candidates.size();
        for (const auto& candidate : slot.v9_candidates) std::cout << '\t' << candidate;
        std::cout << '\n';
      }
      std::cout << "READY\n" << std::flush;
      if (portable_benchmark) {
        const std::uint64_t output_wall_ns = elapsed_ns(output_started);
        std::cerr << "PROFILE\t" << profile_block++ << '\t' << slots.size() << '\t'
          << work_profile.candidate_generation_ns << '\t'
          << work_profile.opponent_analysis_ns << '\t'
          << work_profile.protocol_serialization_ns << '\t'
          << prepare_wall_ns << '\t' << output_wall_ns << '\t'
          << work_profile.candidates << '\t' << work_profile.replies << '\n';
      }

      std::unordered_map<int, std::pair<int, std::size_t>> actions;
      std::string line;
      while (std::getline(std::cin, line) && line != "GO") {
        std::istringstream input(line);
        char tag = 0;
        int slot = -1;
        int episode = -1;
        std::size_t action = 0;
        if (!(input >> tag >> slot >> episode >> action) || tag != 'A') {
          throw std::runtime_error("invalid GPU actor action: " + line);
        }
        if (!actions.emplace(slot, std::pair{episode, action}).second) {
          throw std::runtime_error("duplicate GPU actor action");
        }
      }
      if (!std::cin) throw std::runtime_error("GPU actor closed the environment stream");
      if (actions.size() != slots.size()) {
        throw std::runtime_error("GPU actor did not answer every active environment");
      }

      for (auto& slot : slots) {
        const auto found = actions.find(slot.id);
        if (found == actions.end() || found->second.first != slot.episode
          || found->second.second >= slot.candidates.size()) {
          throw std::runtime_error("GPU actor returned an invalid action");
        }
        const std::size_t action = found->second.second;
        const int turn = slot.rounds;
        slot.position = std::move(slot.candidate_positions[action]);
        slot.dispatch_playtime = slot.candidate_next_dispatch_playtimes[action];
        slot.sub_tick_offset_ms = slot.candidate_next_offsets[action];
        ++slot.rounds;
        transitions.push_back({
          .slot = slot.id,
          .episode = slot.episode,
          .turn = turn,
          .opponent = static_cast<int>(slot.opponent),
          .after_reply = board_hash(slot.position.board),
          .reply_index = slot.candidate_reply_indices[action],
        });
      }

      for (std::size_t index = slots.size(); index-- > 0;) {
        auto& slot = slots[index];
        const int max_rounds = 8 * slot.position.board.size * slot.position.board.size;
        if (slot.position.consecutive_passes < 2 && slot.rounds < max_rounds) continue;
        if (slot.position.consecutive_passes < 2) {
          throw std::runtime_error(
            "V9 environment game did not terminate before the safety cap");
        }
        const auto reward = terminal_reward(
          score_board(slot.position.board, opponent_komi(slot.opponent)),
          opponent_name(slot.opponent), slot.position.board.size);
        results.push_back({
          .slot = slot.id,
          .episode = slot.episode,
          .won = reward.won,
          .power = reward.training_power,
          .rounds = slot.rounds,
        });
        ++completed;
        if (next_episode < games) {
          slot = make_slot(
            slot.id, next_episode, game_seeds[static_cast<std::size_t>(next_episode)],
            opponent_offset, profile, portable_benchmark);
          ++next_episode;
        } else {
          slots.erase(slots.begin() + static_cast<std::ptrdiff_t>(index));
        }
      }
    }

    for (const auto& transition : transitions) {
      std::cout << "T\t" << transition.slot << '\t' << transition.episode << '\t'
        << transition.turn << '\t' << transition.opponent << '\t'
        << transition.after_reply << '\t' << transition.reply_index << '\n';
    }
    for (const auto& result : results) {
      std::cout << "R\t" << result.slot << '\t' << result.episode << '\t'
        << (result.won ? 1 : 0) << '\t' << result.power << '\t'
        << result.rounds << '\n';
    }
    std::cout << "DONE\t" << completed << '\n' << std::flush;
    return EXIT_SUCCESS;
  } catch (const std::exception& error) {
    std::cerr << error.what() << '\n';
    return EXIT_FAILURE;
  }
}
