#include "ipvgobruteforce/seeded_search.hpp"

#include "go/board_generator.hpp"
#include "go/rng.hpp"
#include "go/rules.hpp"

#include <algorithm>
#include <atomic>
#include <chrono>
#include <csignal>
#include <cstdint>
#include <filesystem>
#include <fstream>
#include <iomanip>
#include <iostream>
#include <map>
#include <memory>
#include <mutex>
#include <numeric>
#include <optional>
#include <set>
#include <sstream>
#include <stdexcept>
#include <string>
#include <string_view>
#include <thread>
#include <unordered_map>
#include <unordered_set>
#include <vector>
#include <fcntl.h>
#include <sys/file.h>
#include <unistd.h>

#if defined(__APPLE__)
#include <mach/mach.h>
#include <sys/sysctl.h>
#endif

namespace {

using namespace bitburner::go;
using namespace ipvgobruteforce;
using Clock = std::chrono::steady_clock;

constexpr std::string_view result_schema = "ipvgo-seeded-phase-result-v6";
std::atomic_bool stop_requested{false};

void request_stop(int) { stop_requested.store(true); }

std::vector<std::string> split_tabs(const std::string& line) {
  std::vector<std::string> fields;
  std::size_t begin = 0;
  for (;;) {
    const std::size_t end = line.find('\t', begin);
    fields.push_back(line.substr(begin, end == std::string::npos
      ? line.size() - begin : end - begin));
    if (end == std::string::npos) return fields;
    begin = end + 1;
  }
}

struct MoveHintEntry {
  PackedPosition position;
  std::uint32_t phase{};
  Move move;
};

struct MoveHints {
  std::unordered_map<std::uint64_t, std::vector<MoveHintEntry>> by_position;
  mutable std::atomic_uint64_t exact_hits{};
  mutable std::atomic_uint64_t fallback_hits{};
  mutable std::atomic_uint64_t misses{};

  std::optional<Move> lookup(const Position& position, std::uint32_t phase) const {
    const PackedPosition packed = pack_position(position);
    const auto found = by_position.find(position_fingerprint(packed));
    if (found == by_position.end()) {
      misses.fetch_add(1, std::memory_order_relaxed);
      return std::nullopt;
    }
    const MoveHintEntry* fallback = nullptr;
    for (const MoveHintEntry& entry : found->second) {
      if (!(entry.position == packed)) continue;
      if (entry.phase == phase) {
        exact_hits.fetch_add(1, std::memory_order_relaxed);
        return entry.move;
      }
      if (!fallback) fallback = &entry;
    }
    if (fallback) {
      fallback_hits.fetch_add(1, std::memory_order_relaxed);
      return fallback->move;
    }
    misses.fetch_add(1, std::memory_order_relaxed);
    return std::nullopt;
  }
};

std::shared_ptr<const MoveHints> load_move_hints(const std::filesystem::path& path) {
  auto hints = std::make_shared<MoveHints>();
  const auto load_file = [&](const std::filesystem::path& file) {
    std::ifstream input(file);
    if (!input) throw std::runtime_error("cannot read action hint " + file.string());
    std::string line;
    while (std::getline(input, line)) {
      if (line.empty() || line[0] == '#' || line.starts_with("state_id\t")) continue;
      const std::vector<std::string> fields = split_tabs(line);
      if (fields.size() < 10 || fields[7] == "terminal" || fields[7] == "align") continue;
      Move move;
      std::string action = fields[7];
      if (const std::size_t slot = action.find("@slot"); slot != std::string::npos) {
        action.resize(slot);
      }
      if (action == "pass") {
        move = Move::pass_turn();
      } else {
        const std::size_t comma = action.find(',');
        if (comma == std::string::npos) continue;
        move = Move::at(std::stoi(action.substr(0, comma)), std::stoi(action.substr(comma + 1)));
      }
      PackedPosition position{
        .board = pack_board(board_from_hash(5, fields[4])),
        .consecutive_passes = static_cast<std::uint8_t>(std::stoul(fields[5])),
      };
      std::size_t begin = 0;
      while (begin < fields[6].size()) {
        const std::size_t end = fields[6].find(',', begin);
        position.previous_boards.push_back(std::stoull(fields[6].substr(begin,
          end == std::string::npos ? fields[6].size() - begin : end - begin), nullptr, 0));
        if (end == std::string::npos) break;
        begin = end + 1;
      }
      const std::uint64_t fingerprint = position_fingerprint(position);
      hints->by_position[fingerprint].push_back({
        std::move(position), static_cast<std::uint32_t>(std::stoul(fields[1])), move});
    }
  };
  if (std::filesystem::is_directory(path)) {
    for (const auto& entry : std::filesystem::recursive_directory_iterator(path)) {
      if (entry.is_regular_file() && entry.path().extension() == ".tsv") load_file(entry.path());
    }
  } else {
    load_file(path);
  }
  if (hints->by_position.empty()) {
    throw std::runtime_error("--action-hints contains no playable certificate states");
  }
  return hints;
}

struct Arguments {
  std::map<std::string, std::string> values;
  std::map<std::string, bool> flags;
};

Arguments parse_arguments(int argc, char** argv) {
  Arguments result;
  for (int index = 1; index < argc; ++index) {
    const std::string token = argv[index];
    if (!token.starts_with("--")) throw std::invalid_argument("unexpected argument " + token);
    if (index + 1 < argc && !std::string_view(argv[index + 1]).starts_with("--")) {
      result.values[token] = argv[++index];
    } else {
      result.flags[token] = true;
    }
  }
  return result;
}

std::string value(const Arguments& args, const std::string& name, const std::string& fallback) {
  const auto found = args.values.find(name);
  return found == args.values.end() ? fallback : found->second;
}

std::uint64_t integer(const Arguments& args, const std::string& name, std::uint64_t fallback) {
  const auto found = args.values.find(name);
  return found == args.values.end() ? fallback : std::stoull(found->second);
}

double number(const Arguments& args, const std::string& name, double fallback) {
  const auto found = args.values.find(name);
  return found == args.values.end() ? fallback : std::stod(found->second);
}

bool flag(const Arguments& args, const std::string& name) {
  return args.flags.contains(name);
}

unsigned default_threads() {
  const unsigned detected = std::thread::hardware_concurrency();
  return std::min(12U, detected == 0 ? 1U : detected);
}

const char* status_name(GraphStatus status) {
  switch (status) {
    case GraphStatus::unknown: return "UNKNOWN";
    case GraphStatus::win: return "WIN";
    case GraphStatus::loss: return "LOSS";
  }
  return "INVALID";
}

std::optional<double> system_memory_percent() {
#if defined(__APPLE__)
  std::uint64_t total_bytes = 0;
  std::size_t total_size = sizeof(total_bytes);
  if (sysctlbyname("hw.memsize", &total_bytes, &total_size, nullptr, 0) != 0
      || total_bytes == 0) return std::nullopt;
  mach_port_t host = mach_host_self();
  vm_size_t page_size = 0;
  vm_statistics64_data_t statistics{};
  mach_msg_type_number_t count = HOST_VM_INFO64_COUNT;
  const bool ok = host_page_size(host, &page_size) == KERN_SUCCESS
    && host_statistics64(host, HOST_VM_INFO64,
      reinterpret_cast<host_info64_t>(&statistics), &count) == KERN_SUCCESS;
  mach_port_deallocate(mach_task_self(), host);
  if (!ok) return std::nullopt;
  const std::uint64_t available_pages = statistics.free_count + statistics.inactive_count;
  const std::uint64_t available_bytes = available_pages * static_cast<std::uint64_t>(page_size);
  const std::uint64_t used_bytes = available_bytes >= total_bytes ? 0 : total_bytes - available_bytes;
  return static_cast<double>(used_bytes) * 100.0 / static_cast<double>(total_bytes);
#elif defined(__linux__)
  std::ifstream input("/proc/meminfo");
  std::uint64_t total_kib = 0;
  std::uint64_t available_kib = 0;
  std::string key;
  std::uint64_t amount = 0;
  std::string unit;
  while (input >> key >> amount >> unit) {
    if (key == "MemTotal:") total_kib = amount;
    if (key == "MemAvailable:") available_kib = amount;
  }
  if (total_kib == 0) return std::nullopt;
  return static_cast<double>(total_kib - std::min(total_kib, available_kib)) * 100.0
    / static_cast<double>(total_kib);
#else
  return std::nullopt;
#endif
}

struct PhasePaths {
  std::filesystem::path snapshot;
  std::filesystem::path policy;
  std::filesystem::path result;
};

PhasePaths phase_paths(const std::filesystem::path& root, std::uint32_t phase,
  std::optional<std::uint8_t> handicap_coordinate) {
  std::string name = std::to_string(phase);
  if (handicap_coordinate) name += "-h" + std::to_string(*handicap_coordinate);
  return {
    .snapshot = root / "snapshots" / (name + ".snapshot"),
    .policy = root / "policies" / (name + ".tsv"),
    .result = root / "results" / (name + ".tsv"),
  };
}

std::map<std::string, std::string> read_record(const std::filesystem::path& path) {
  std::ifstream input(path);
  if (!input) throw std::runtime_error("cannot read phase result " + path.string());
  std::map<std::string, std::string> values;
  std::string line;
  while (std::getline(input, line)) {
    const std::size_t split = line.find('\t');
    if (split == std::string::npos) continue;
    values[line.substr(0, split)] = line.substr(split + 1);
  }
  return values;
}

std::string required(const std::map<std::string, std::string>& values, const std::string& key) {
  const auto found = values.find(key);
  if (found == values.end()) throw std::runtime_error("phase result lacks " + key);
  return found->second;
}

bool compatible_result(const std::filesystem::path& path, std::uint32_t phase,
  Opponent opponent, double komi, std::optional<std::uint8_t> handicap_coordinate,
  const SeededTimingModel& timing, const SeededGraphLimits& limits) {
  const auto record = read_record(path);
  const std::string schema = required(record, "schema");
  const bool current = schema == result_schema
    && required(record, "opponent") == opponent_name(opponent)
    && std::stod(required(record, "komi")) == komi
    && std::stoul(required(record, "handicap_coordinate"))
      == static_cast<unsigned>(handicap_coordinate.value_or(255U));
  return current
    && std::stoull(required(record, "phase")) == phase
    && std::stoull(required(record, "runtime_uncertainty_ticks"))
      == timing.runtime_uncertainty_ticks
    && std::stoull(required(record, "ai_seed_slip_ticks")) == timing.ai_seed_slip_ticks
    && std::stoull(required(record, "playtime_epoch")) == timing.playtime_epoch
    && std::stoull(required(record, "fractional_rounding"))
      == static_cast<std::uint64_t>(timing.include_fractional_wait_rounding)
    && std::stoull(required(record, "alignment_boards")) == timing.alignment_boards
    && std::stoull(required(record, "max_rounds")) == limits.max_rounds;
}

void write_result(const std::filesystem::path& path, std::uint32_t phase,
  Opponent opponent, double komi, std::optional<std::uint8_t> handicap_coordinate,
  std::string_view board, const SeededTimingModel& timing, const SeededGraphLimits& limits,
  const SeededGraphResult& result, double elapsed_seconds) {
  const std::filesystem::path temporary = path.string() + ".tmp";
  std::ofstream output(temporary, std::ios::trunc);
  if (!output) throw std::runtime_error("cannot write phase result " + temporary.string());
  const bool complete = result.start_status != GraphStatus::unknown;
  output << "schema\t" << result_schema << '\n'
    << "phase\t" << phase << '\n'
    << "opponent\t" << opponent_name(opponent) << '\n'
    << "komi\t" << komi << '\n'
    << "handicap_coordinate\t"
    << static_cast<unsigned>(handicap_coordinate.value_or(255U)) << '\n'
    << "playtime_ms\t" << static_cast<std::uint64_t>(timing.playtime_epoch) * 30'000'000ULL
      + static_cast<std::uint64_t>(phase) * 200ULL << '\n'
    << "board\t" << board << '\n'
    << "runtime_uncertainty_ticks\t" << timing.runtime_uncertainty_ticks << '\n'
    << "ai_seed_slip_ticks\t" << timing.ai_seed_slip_ticks << '\n'
    << "playtime_epoch\t" << timing.playtime_epoch << '\n'
    << "fractional_rounding\t" << timing.include_fractional_wait_rounding << '\n'
    << "alignment_boards\t" << static_cast<unsigned>(timing.alignment_boards) << '\n'
    << "max_rounds\t" << limits.max_rounds << '\n'
    << "status\t" << status_name(result.start_status) << '\n'
    << "complete\t" << complete << '\n'
    << "exhausted\t" << result.exhausted << '\n'
    << "interrupted\t" << result.interrupted << '\n'
    << "horizon_exhausted\t" << result.horizon_exhausted << '\n'
    << "winning_incumbent\t" << result.winning_incumbent << '\n'
    << "incumbent_expected_power_per_turn\t"
      << result.incumbent_expected_power_per_turn << '\n'
    << "elapsed_seconds\t" << std::fixed << std::setprecision(6) << elapsed_seconds << '\n'
    << "states\t" << result.stats.states << '\n'
    << "expanded\t" << result.stats.expanded_states << '\n'
    << "actions\t" << result.stats.actions << '\n'
    << "edges\t" << result.stats.edges << '\n'
    << "frontier\t" << result.stats.frontier << '\n'
    << "winning_states\t" << result.stats.winning_states << '\n'
    << "losing_states\t" << result.stats.losing_states << '\n'
    << "seed_evaluations\t" << result.stats.seed_evaluations << '\n'
    << "white_outcomes\t" << result.stats.white_reply_outcomes << '\n'
    << "phase_branches\t" << result.stats.phase_branches << '\n'
    << "tie_actions\t" << result.stats.unseeded_defense_tie_actions << '\n'
    << "alignment_actions\t" << result.stats.voluntary_wait_actions << '\n'
    << "horizon_cutoffs\t" << result.stats.horizon_cutoffs << '\n'
    << "maximum_history_depth\t" << result.stats.maximum_history_depth << '\n'
    << "maximum_round_depth\t" << result.stats.maximum_round_depth << '\n'
    << "estimated_bytes\t" << result.stats.estimated_bytes << '\n'
    << "certificate_states\t" << result.certificate_states << '\n'
    << "certificate_terminal_wins\t" << result.certificate_terminal_wins << '\n';
  output << "certificate_expected_power_per_turn\t"
    << result.certificate_expected_power_per_turn << '\n'
    << "certificate_materialized_optimal\t" << result.certificate_materialized_optimal << '\n'
    << "power_optimal_within_horizon\t" << result.power_optimal_within_horizon << '\n';
  output.flush();
  if (!output) throw std::runtime_error("failed writing phase result " + temporary.string());
  output.close();
  std::filesystem::rename(temporary, path);
}

struct Totals {
  std::atomic_uint64_t scheduled{};
  std::atomic_uint64_t skipped{};
  std::atomic_uint64_t finished{};
  std::atomic_uint64_t wins{};
  std::atomic_uint64_t unknown{};
  std::atomic_uint64_t losses{};
  std::atomic_uint64_t failures{};
  std::atomic_uint64_t states{};
  std::atomic_uint64_t expanded{};
};

void usage() {
  std::cout
    << "ipvgo_seeded_batch [options]\n\n"
    << "Runs independent exact-history 5x5 proofs for a deterministic range\n"
    << "of the 150,000 WHRNG phases. No state is merged between phases.\n\n"
    << "  --output-dir PATH         phase artifact root\n"
    << "  --opponent NAME           faction slug/name (default netburners)\n"
    << "  --phase-begin N           inclusive phase (default 0)\n"
    << "  --phase-end N             exclusive phase (default 150000)\n"
    << "  --phase-list PATH         explicit ordered phase list (overrides stride order)\n"
    << "  --board-list PATH         explicit phase<TAB>board roots (overrides phase list)\n"
    << "  --phase-modulus N        retain phases q where q % N equals remainder\n"
    << "  --phase-remainder N      remainder used with --phase-modulus (default 0)\n"
    << "  --threads N               independent phase workers (default min(12, hardware))\n"
    << "  --phase-stride N          coprime visit stride for distributed coverage (default 1)\n"
    << "  --illuminati-variants M   all or first (default all)\n"
    << "  --runtime-ticks N         ordinary timing uncertainty 0..N (default 1)\n"
    << "  --ai-seed-slip-ticks N    AI initial-wait uncertainty (default 0)\n"
    << "  --playtime-epoch N        absolute 30,000-second WHRNG epoch (default 0)\n"
    << "  --alignment-boards N      controlled boards per paid alignment (default 9)\n"
    << "  --max-rounds N            shortest-win horizon (default 40)\n"
    << "  --max-states N            per-phase persistent state cap (default 8000000)\n"
    << "  --max-expansions N        work per phase per batch pass (default 8000000)\n"
    << "  --ram-percent N           checkpoint all active phases at this use (default 90)\n"
    << "  --keep-winning-snapshots  retain large graphs after policy validation\n"
    << "  --action-hints PATH       untrusted certificate used only for move ordering\n"
    << "  --discard-incomplete      bounded discovery pass; do not retain UNKNOWN graphs\n"
    << "  --compact-incomplete      ledger UNKNOWN probes instead of one result file each\n"
    << "  --no-fractional-rounding  disable conservative timer-boundary branch\n";
}

Opponent parse_opponent_cli(std::string_view value) {
  if (value == "netburners" || value == "Netburners") return Opponent::netburners;
  if (value == "slum-snakes" || value == "Slum Snakes") return Opponent::slum_snakes;
  if (value == "black-hand" || value == "The Black Hand") return Opponent::black_hand;
  if (value == "tetrads" || value == "Tetrads") return Opponent::tetrads;
  if (value == "daedalus" || value == "Daedalus") return Opponent::daedalus;
  if (value == "illuminati" || value == "Illuminati") return Opponent::illuminati;
  if (value == "world-daemon" || value == "????????????") return Opponent::world_daemon;
  throw std::invalid_argument("unknown --opponent " + std::string(value));
}

std::string opponent_slug(Opponent opponent) {
  switch (opponent) {
    case Opponent::netburners: return "netburners";
    case Opponent::slum_snakes: return "slum-snakes";
    case Opponent::black_hand: return "black-hand";
    case Opponent::tetrads: return "tetrads";
    case Opponent::daedalus: return "daedalus";
    case Opponent::illuminati: return "illuminati";
    case Opponent::world_daemon: return "world-daemon";
  }
  throw std::invalid_argument("unknown opponent");
}

double komi_for(Opponent opponent) {
  switch (opponent) {
    case Opponent::netburners: return 1.5;
    case Opponent::slum_snakes:
    case Opponent::black_hand: return 3.5;
    case Opponent::tetrads:
    case Opponent::daedalus: return 5.5;
    case Opponent::illuminati: return 7.5;
    case Opponent::world_daemon: return 9.5;
  }
  throw std::invalid_argument("unknown opponent");
}

struct StartBoard {
  Board board;
  std::optional<std::uint8_t> handicap_coordinate;
};

class OutputLock {
 public:
  explicit OutputLock(const std::filesystem::path& output_root) {
    std::filesystem::create_directories(output_root);
    const std::filesystem::path path = output_root / ".batch.lock";
    descriptor_ = ::open(path.c_str(), O_CREAT | O_RDWR, 0644);
    if (descriptor_ < 0 || ::flock(descriptor_, LOCK_EX | LOCK_NB) != 0) {
      if (descriptor_ >= 0) ::close(descriptor_);
      descriptor_ = -1;
      throw std::runtime_error(
        "another seeded batch already owns output directory " + output_root.string());
    }
  }

  ~OutputLock() {
    if (descriptor_ < 0) return;
    ::flock(descriptor_, LOCK_UN);
    ::close(descriptor_);
  }

  OutputLock(const OutputLock&) = delete;
  OutputLock& operator=(const OutputLock&) = delete;

 private:
  int descriptor_{-1};
};

std::vector<StartBoard> start_boards(std::uint32_t phase, Opponent opponent,
  bool all_illuminati_variants, std::uint32_t playtime_epoch) {
  const double playtime_ms = static_cast<double>(playtime_epoch) * go_whrng_period_ms
    + static_cast<double>(phase) * 200.0;
  if (opponent != Opponent::illuminati) {
    return {{initial_board(5, opponent, playtime_ms, 0), std::nullopt}};
  }
  StartingBoardFamily family = starting_board_family(5, opponent, playtime_ms);
  // starting_board_variants also yields the bare board whenever upstream
  // applyHandicap can place no stone (empty expansion list), so the 0.8-likely
  // no-stone opening of a center-only family is proved too.
  std::vector<StartBoard> result;
  for (StartingBoardVariant& variant : starting_board_variants(family)) {
    result.push_back({std::move(variant.board), variant.handicap_point
      ? std::optional<std::uint8_t>(static_cast<std::uint8_t>(
          variant.handicap_point->x * 5 + variant.handicap_point->y))
      : std::nullopt});
    if (!all_illuminati_variants) break;
  }
  if (result.empty()) result.push_back({std::move(family.board_before_handicap), std::nullopt});
  return result;
}

}  // namespace

int main(int argc, char** argv) try {
  const Arguments args = parse_arguments(argc, argv);
  if (flag(args, "--help")) {
    usage();
    return 0;
  }
  std::signal(SIGINT, request_stop);
  std::signal(SIGTERM, request_stop);

  const Opponent opponent = parse_opponent_cli(value(args, "--opponent", "netburners"));
  if (opponent == Opponent::world_daemon) {
    throw std::invalid_argument(
      "ipvgo_seeded_batch is the packed 5x5 generator; use the separate 19x19 generator for World Daemon");
  }
  const double komi = number(args, "--komi", komi_for(opponent));
  const std::string default_output = opponent == Opponent::netburners
    ? "ipvgobruteforce/data/seeded-phases/netburners-5x5-h40-v4"
    : "ipvgobruteforce/data/seeded-phases/" + opponent_slug(opponent) + "-5x5-h40-v1";
  const std::filesystem::path output_root = value(args, "--output-dir",
    default_output);
  const std::uint32_t phase_begin = static_cast<std::uint32_t>(
    integer(args, "--phase-begin", 0));
  const std::uint32_t phase_end = static_cast<std::uint32_t>(
    integer(args, "--phase-end", seeded_phase_count));
  if (phase_begin >= phase_end || phase_end > seeded_phase_count) {
    throw std::invalid_argument("phase range must satisfy 0 <= begin < end <= 150000");
  }
  const std::uint32_t phase_count = phase_end - phase_begin;
  const std::uint32_t phase_stride = static_cast<std::uint32_t>(
    integer(args, "--phase-stride", 1));
  if (phase_stride == 0 || std::gcd(phase_stride, phase_count) != 1U) {
    throw std::invalid_argument(
      "--phase-stride must be positive and coprime with the phase-range size");
  }
  const std::string illuminati_variants = value(args, "--illuminati-variants", "all");
  if (illuminati_variants != "all" && illuminati_variants != "first") {
    throw std::invalid_argument("--illuminati-variants must be all or first");
  }
  std::vector<std::uint32_t> phase_order;
  const std::string phase_list_path = value(args, "--phase-list", "");
  if (!phase_list_path.empty()) {
    std::ifstream phase_input(phase_list_path);
    if (!phase_input) throw std::runtime_error("cannot read --phase-list " + phase_list_path);
    std::unordered_set<std::uint32_t> seen;
    std::uint64_t phase = 0;
    while (phase_input >> phase) {
      if (phase >= seeded_phase_count || phase < phase_begin || phase >= phase_end) {
        throw std::invalid_argument("--phase-list contains an out-of-range phase");
      }
      if (!seen.insert(static_cast<std::uint32_t>(phase)).second) {
        throw std::invalid_argument("--phase-list contains a duplicate phase");
      }
      phase_order.push_back(static_cast<std::uint32_t>(phase));
    }
    if (phase_order.empty()) throw std::invalid_argument("--phase-list is empty");
  } else {
    phase_order.reserve(phase_count);
    for (std::uint32_t ordinal = 0; ordinal < phase_count; ++ordinal) {
      phase_order.push_back(phase_begin + static_cast<std::uint32_t>(
        (static_cast<std::uint64_t>(ordinal) * phase_stride) % phase_count));
    }
  }
  std::map<std::uint32_t, std::set<std::string>> board_filter;
  const std::string board_list_path = value(args, "--board-list", "");
  if (!board_list_path.empty()) {
    if (!phase_list_path.empty()) {
      throw std::invalid_argument("--board-list and --phase-list are mutually exclusive");
    }
    std::ifstream board_input(board_list_path);
    if (!board_input) throw std::runtime_error("cannot read --board-list " + board_list_path);
    phase_order.clear();
    std::uint64_t phase = 0;
    std::string board;
    while (board_input >> phase >> board) {
      if (phase >= seeded_phase_count || phase < phase_begin || phase >= phase_end) {
        throw std::invalid_argument("--board-list contains an out-of-range phase");
      }
      if (board.size() != 25 || board.find_first_not_of(".XO#") != std::string::npos) {
        throw std::invalid_argument("--board-list contains an invalid 5x5 board hash");
      }
      auto& boards = board_filter[static_cast<std::uint32_t>(phase)];
      if (!boards.insert(board).second) {
        throw std::invalid_argument("--board-list contains a duplicate phase/board root");
      }
    }
    for (const auto& [phase, boards] : board_filter) {
      static_cast<void>(boards);
      phase_order.push_back(phase);
    }
    if (phase_order.empty()) throw std::invalid_argument("--board-list is empty");
  }
  const std::uint32_t phase_modulus = static_cast<std::uint32_t>(
    integer(args, "--phase-modulus", 1));
  const std::uint32_t phase_remainder = static_cast<std::uint32_t>(
    integer(args, "--phase-remainder", 0));
  if (phase_modulus == 0 || phase_remainder >= phase_modulus) {
    throw std::invalid_argument("phase modulus must be positive and remainder smaller than it");
  }
  std::erase_if(phase_order, [&](std::uint32_t phase) {
    return phase % phase_modulus != phase_remainder;
  });
  if (phase_order.empty()) throw std::invalid_argument("phase modulus removed every requested phase");
  const unsigned threads = static_cast<unsigned>(integer(args, "--threads", default_threads()));
  if (threads == 0) throw std::invalid_argument("--threads must be positive");
  const double ram_limit = number(args, "--ram-percent", 90.0);
  const SeededTimingModel timing{
    .runtime_uncertainty_ticks = static_cast<std::uint32_t>(
      integer(args, "--runtime-ticks", 1)),
    .ai_seed_slip_ticks = static_cast<std::uint32_t>(
      integer(args, "--ai-seed-slip-ticks", 0)),
    .playtime_epoch = static_cast<std::uint32_t>(integer(args, "--playtime-epoch", 0)),
    .include_fractional_wait_rounding = !flag(args, "--no-fractional-rounding"),
    .alignment_boards = static_cast<std::uint8_t>(integer(args, "--alignment-boards", 9)),
  };
  const SeededGraphLimits limits{
    .max_states = integer(args, "--max-states", 8'000'000),
    .max_expansions = integer(args, "--max-expansions", 8'000'000),
    .progress_every = integer(args, "--progress-every", 1'000),
    .checkpoint_every = integer(args, "--checkpoint-every", 50'000),
    .max_rounds = static_cast<std::uint32_t>(integer(args, "--max-rounds", 40)),
  };
  const std::string action_hints_path = value(args, "--action-hints", "");
  const std::shared_ptr<const MoveHints> action_hints = action_hints_path.empty()
    ? nullptr : load_move_hints(action_hints_path);
  const SeededMoveHint move_hint = action_hints
    ? SeededMoveHint([action_hints](const Position& position, std::uint32_t phase) {
        return action_hints->lookup(position, phase);
      })
    : SeededMoveHint{};
  const bool compact_incomplete = flag(args, "--compact-incomplete");
  if (compact_incomplete && !flag(args, "--discard-incomplete")) {
    throw std::invalid_argument("--compact-incomplete requires --discard-incomplete");
  }

  const OutputLock output_lock(output_root);
  std::filesystem::create_directories(output_root / "snapshots");
  std::filesystem::create_directories(output_root / "policies");
  std::filesystem::create_directories(output_root / "results");
  const std::filesystem::path progress_path = output_root / "batch.progress.tsv";
  const bool new_progress = !std::filesystem::exists(progress_path)
    || std::filesystem::file_size(progress_path) == 0;
  std::ofstream progress_output(progress_path, std::ios::app);
  if (!progress_output) throw std::runtime_error("cannot append " + progress_path.string());
  if (new_progress) {
    progress_output << "phase\tstatus\tcomplete\telapsed_seconds\tstates\texpanded"
      << "\tfrontier\tmax_round\talignments\tties\tboard\n";
    progress_output.flush();
  }

  std::unordered_set<std::string> compact_attempted;
  if (compact_incomplete) {
    std::ostringstream expected;
    expected << result_schema << '\t' << opponent_name(opponent) << '\t' << komi
      << '\t' << timing.runtime_uncertainty_ticks << '\t' << timing.ai_seed_slip_ticks
      << '\t' << timing.playtime_epoch
      << '\t' << timing.include_fractional_wait_rounding << '\t'
      << static_cast<unsigned>(timing.alignment_boards) << '\t' << limits.max_rounds
      << '\t' << limits.max_expansions
      << '\t' << illuminati_variants << '\n';
    const std::filesystem::path model_path = output_root / "batch.compact-model.tsv";
    if (std::filesystem::exists(model_path)) {
      std::ifstream model_input(model_path);
      std::ostringstream stored;
      stored << model_input.rdbuf();
      if (stored.str() != expected.str()) {
        throw std::runtime_error("compact attempt ledger model mismatch; use a new output directory");
      }
    } else {
      const std::filesystem::path temporary = model_path.string() + ".tmp";
      std::ofstream model_output(temporary, std::ios::trunc);
      model_output << expected.str();
      model_output.close();
      std::filesystem::rename(temporary, model_path);
    }
  }
  if (compact_incomplete && !new_progress) {
    std::ifstream existing(progress_path);
    std::string line;
    std::getline(existing, line);
    while (std::getline(existing, line)) {
      const std::vector<std::string> fields = [&] {
        std::vector<std::string> values;
        std::size_t begin = 0;
        for (;;) {
          const std::size_t end = line.find('\t', begin);
          values.emplace_back(line.substr(begin, end == std::string::npos
            ? line.size() - begin : end - begin));
          if (end == std::string::npos) return values;
          begin = end + 1U;
        }
      }();
      if (fields.size() >= 11) {
        const std::string key = fields[0] + '\t' + fields[10];
        if (fields[1] == "UNKNOWN") compact_attempted.insert(key);
        else compact_attempted.erase(key);
      }
    }
  }

  const auto selected_start_boards = [&](std::uint32_t phase) {
    std::vector<StartBoard> starts = start_boards(
      phase, opponent, illuminati_variants == "all", timing.playtime_epoch);
    const auto filter = board_filter.find(phase);
    if (filter == board_filter.end()) return starts;
    std::erase_if(starts, [&](const StartBoard& start) {
      return !filter->second.contains(board_hash(start.board));
    });
    if (starts.size() != filter->second.size()) {
      throw std::invalid_argument(
        "--board-list contains a board outside the phase's opening support");
    }
    return starts;
  };
  std::uint64_t total_tasks = 0;
  for (const std::uint32_t phase : phase_order) {
    total_tasks += selected_start_boards(phase).size();
  }

  std::cout << "seeded phase batch: opponent=" << opponent_name(opponent)
    << " komi=" << komi << " range=" << phase_begin << ".." << phase_end - 1U
    << " count=" << phase_count << " stride=" << phase_stride
    << " tasks=" << total_tasks << " threads=" << threads << '\n'
    << "output=" << output_root << '\n'
    << "model: runtime=0.." << timing.runtime_uncertainty_ticks
    << " alignment_boards=" << static_cast<unsigned>(timing.alignment_boards)
    << " max_rounds=" << limits.max_rounds << " no-cross-phase-merging=1\n";

  const auto started = Clock::now();
  Totals totals;
  std::atomic_uint32_t next_ordinal{0};
  std::atomic_bool oom_stop{false};
  std::mutex output_mutex;

  auto report = [&] {
    const double elapsed = std::chrono::duration<double>(Clock::now() - started).count();
    const std::optional<double> memory = system_memory_percent();
    std::lock_guard lock(output_mutex);
    std::cout << "batch progress t=" << std::fixed << std::setprecision(1) << elapsed
      << "s scheduled=" << totals.scheduled.load() << '/' << total_tasks
      << " skipped=" << totals.skipped.load() << " finished=" << totals.finished.load()
      << " win=" << totals.wins.load() << " unknown=" << totals.unknown.load()
      << " loss=" << totals.losses.load() << " failures=" << totals.failures.load()
      << " states=" << totals.states.load() << " expanded=" << totals.expanded.load();
    if (memory) std::cout << " ram=" << std::setprecision(1) << *memory << '%';
    if (action_hints) {
      std::cout << " hints=" << action_hints->exact_hits.load() << " exact/"
        << action_hints->fallback_hits.load() << " fallback/"
        << action_hints->misses.load() << " miss";
    }
    std::cout << '\n';
  };

  std::jthread reporter([&](std::stop_token token) {
    auto next = Clock::now() + std::chrono::minutes(1);
    while (!token.stop_requested() && !stop_requested.load()) {
      std::this_thread::sleep_for(std::chrono::seconds(1));
      if (Clock::now() >= next) {
        report();
        next += std::chrono::minutes(1);
      }
    }
  });

  auto worker = [&] {
    auto next_worker_memory_check = Clock::now();
    while (!stop_requested.load()) {
      const std::uint32_t ordinal = next_ordinal.fetch_add(1);
      if (ordinal >= phase_order.size()) return;
      const std::uint32_t phase = phase_order[ordinal];
      for (StartBoard start_board : selected_start_boards(phase)) {
        if (stop_requested.load()) return;
        totals.scheduled.fetch_add(1);
        const std::string board = board_hash(start_board.board);
        if (compact_incomplete
            && compact_attempted.contains(std::to_string(phase) + '\t' + board)) {
          totals.skipped.fetch_add(1);
          continue;
        }
        const PhasePaths paths = phase_paths(
          output_root, phase, start_board.handicap_coordinate);
        try {
          if (std::filesystem::exists(paths.result)) {
            if (!compatible_result(paths.result, phase, opponent, komi,
                start_board.handicap_coordinate, timing, limits)) {
              throw std::runtime_error(
                "incompatible existing result; use a different output directory");
            }
            const auto record = read_record(paths.result);
            if (required(record, "complete") == "1") {
              totals.skipped.fetch_add(1);
              continue;
            }
          }

          Position start{.board = std::move(start_board.board)};
          const bool ephemeral = flag(args, "--discard-incomplete");
          const bool resume = !ephemeral && std::filesystem::exists(paths.snapshot);
          const std::filesystem::path search_snapshot = ephemeral
            ? std::filesystem::path{} : paths.snapshot;
          const auto phase_started = Clock::now();
          const auto keep_running = [&] {
            if (stop_requested.load()) return false;
            const auto now = Clock::now();
            if (now >= next_worker_memory_check) {
              next_worker_memory_check = now + std::chrono::seconds(1);
              const std::optional<double> memory = system_memory_percent();
              if (memory && *memory >= ram_limit) {
                oom_stop.store(true);
                stop_requested.store(true);
                return false;
              }
            }
            return true;
          };
          const SeededGraphResult result = search_seeded_graph(
            start, phase, opponent, komi, timing, limits, search_snapshot,
            resume, paths.policy, {}, keep_running, move_hint);
          const double elapsed = std::chrono::duration<double>(
            Clock::now() - phase_started).count();
          if (!compact_incomplete || result.start_status != GraphStatus::unknown) {
            write_result(paths.result, phase, opponent, komi,
              start_board.handicap_coordinate, board, timing, limits, result, elapsed);
          }
        // The replay-validated certificate is the durable proof artifact. A
        // solved search graph cannot contribute more work on resume and is
        // often hundreds of times larger, so discard only this batch-owned
        // winning snapshot unless explicitly retained. UNKNOWN snapshots are
        // always kept for continuation or a larger future horizon.
          if (result.start_status == GraphStatus::win
              && !flag(args, "--keep-winning-snapshots")) {
            std::error_code ignored;
            std::filesystem::remove(paths.snapshot, ignored);
          } else if (result.start_status == GraphStatus::unknown
              && flag(args, "--discard-incomplete")) {
            std::error_code ignored;
            std::filesystem::remove(paths.snapshot, ignored);
          }

          totals.finished.fetch_add(1);
          totals.states.fetch_add(result.stats.states);
          totals.expanded.fetch_add(result.stats.expanded_states);
          if (result.start_status == GraphStatus::win) totals.wins.fetch_add(1);
          else if (result.start_status == GraphStatus::loss) totals.losses.fetch_add(1);
          else totals.unknown.fetch_add(1);
          if (result.start_status == GraphStatus::unknown && !result.interrupted
              && result.stats.states >= limits.max_states) {
            // Re-running with identical limits reloads this snapshot and
            // immediately stops again, so the stall must be visible.
            std::lock_guard lock(output_mutex);
            std::cerr << "phase " << phase << " reached --max-states ("
              << limits.max_states << ") before finishing its proof; it cannot"
              << " make progress until the cap is raised\n";
          }

          const bool complete = result.start_status != GraphStatus::unknown;
          {
            std::lock_guard lock(output_mutex);
            progress_output << phase << '\t' << status_name(result.start_status) << '\t'
              << complete << '\t' << std::fixed << std::setprecision(6) << elapsed << '\t'
              << result.stats.states << '\t' << result.stats.expanded_states << '\t'
              << result.stats.frontier << '\t' << result.stats.maximum_round_depth << '\t'
              << result.stats.voluntary_wait_actions << '\t'
              << result.stats.unseeded_defense_tie_actions << '\t' << board << '\n';
            progress_output.flush();
          }
        } catch (const std::exception& error) {
          totals.failures.fetch_add(1);
          std::lock_guard lock(output_mutex);
          std::cerr << "phase " << phase;
          if (start_board.handicap_coordinate) {
            std::cerr << " handicap "
              << static_cast<unsigned>(*start_board.handicap_coordinate);
          }
          std::cerr << " failed: " << error.what() << '\n';
        }
      }
    }
  };

  std::vector<std::jthread> workers;
  workers.reserve(threads);
  for (unsigned index = 0; index < threads; ++index) workers.emplace_back(worker);
  for (auto& thread : workers) thread.join();
  reporter.request_stop();
  reporter.join();
  report();

  if (oom_stop.load()) {
    std::cerr << "RAM guard reached; active phase snapshots were checkpointed\n";
    return 75;
  }
  if (stop_requested.load()) {
    std::cerr << (compact_incomplete
      ? "batch interrupted; completed artifacts and compact attempt ledger were flushed\n"
      : "batch interrupted; active phase snapshots were checkpointed\n");
    return 130;
  }
  return totals.failures.load() == 0 ? 0 : 1;
} catch (const std::exception& error) {
  std::cerr << "error: " << error.what() << '\n';
  return 1;
}
