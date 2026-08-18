#include "ipvgobruteforce/packed_board.hpp"
#include "ipvgobruteforce/seeded_search.hpp"

#include "go/rules.hpp"

#include <algorithm>
#include <array>
#include <bit>
#include <cctype>
#include <cstdint>
#include <filesystem>
#include <fstream>
#include <iomanip>
#include <iostream>
#include <limits>
#include <map>
#include <optional>
#include <sstream>
#include <stdexcept>
#include <string>
#include <string_view>
#include <tuple>
#include <unordered_map>
#include <utility>
#include <vector>

namespace {

using namespace bitburner::go;
using namespace ipvgobruteforce;

constexpr std::uint32_t missing_root = 0xffffffffU;
constexpr std::uint32_t next_board_root = 0xfffffffeU;
constexpr std::uint8_t action_pass = 25;
constexpr std::uint8_t action_align = 26;
constexpr std::uint8_t action_sleep_one = 27;
constexpr std::uint8_t action_terminal = 28;
constexpr std::uint8_t action_slot_one = 0x20;

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

bool flag(const Arguments& args, const std::string& name) {
  return args.flags.contains(name);
}

std::vector<std::string> split(std::string_view text, char delimiter) {
  std::vector<std::string> parts;
  std::size_t begin = 0;
  for (;;) {
    const std::size_t end = text.find(delimiter, begin);
    parts.emplace_back(text.substr(begin, end == std::string_view::npos
      ? text.size() - begin : end - begin));
    if (end == std::string_view::npos) return parts;
    begin = end + 1;
  }
}

struct ExactKey {
  PackedBoard board{};
  std::uint32_t phase{};
  std::uint32_t history_id{};
  std::uint8_t passes{};
  std::uint8_t alignment_credit{};

  friend bool operator==(const ExactKey&, const ExactKey&) = default;
};

std::uint64_t mix(std::uint64_t value) {
  value ^= value >> 30U;
  value *= 0xbf58476d1ce4e5b9ULL;
  value ^= value >> 27U;
  value *= 0x94d049bb133111ebULL;
  return value ^ (value >> 31U);
}

struct ExactKeyHash {
  std::size_t operator()(const ExactKey& key) const {
    std::uint64_t hash = mix(key.board ^ (static_cast<std::uint64_t>(key.phase) << 32U)
      ^ (static_cast<std::uint64_t>(key.history_id) << 16U)
      ^ (static_cast<std::uint64_t>(key.passes) << 8U) ^ key.alignment_credit);
    return static_cast<std::size_t>(hash);
  }
};

struct NeuralMatchKey {
  PackedBoard board{};
  std::uint32_t phase{};
  std::uint32_t history_hash{};
  std::uint32_t history_hash2{};
  std::uint8_t passes{};
  std::uint8_t alignment_credit{};

  friend bool operator==(const NeuralMatchKey&, const NeuralMatchKey&) = default;
};

struct NeuralMatchKeyHash {
  std::size_t operator()(const NeuralMatchKey& key) const {
    return static_cast<std::size_t>(mix(key.board
      ^ (static_cast<std::uint64_t>(key.phase) << 32U)
      ^ (static_cast<std::uint64_t>(key.history_hash) << 1U)
      ^ (static_cast<std::uint64_t>(key.history_hash2) << 17U)
      ^ (static_cast<std::uint64_t>(key.passes) << 8U)
      ^ key.alignment_credit));
  }
};

std::unordered_map<NeuralMatchKey, std::uint8_t, NeuralMatchKeyHash>
read_neural_matches(const std::filesystem::path& path) {
  std::ifstream input(path);
  if (!input) throw std::runtime_error("cannot open neural matches " + path.string());
  std::unordered_map<NeuralMatchKey, std::uint8_t, NeuralMatchKeyHash> result;
  std::string line;
  if (!std::getline(input, line)
      || line != "phase\tboard\tpasses\talignment_credit\thistory_hash\thistory_hash2\taction") {
    throw std::runtime_error("invalid neural matches header");
  }
  while (std::getline(input, line)) {
    if (line.empty()) continue;
    const auto fields = split(line, '\t');
    if (fields.size() != 7) throw std::runtime_error("invalid neural match row");
    NeuralMatchKey key{
      .board = std::stoull(fields[1], nullptr, 0),
      .phase = static_cast<std::uint32_t>(std::stoul(fields[0])),
      .history_hash = static_cast<std::uint32_t>(std::stoul(fields[4])),
      .history_hash2 = static_cast<std::uint32_t>(std::stoul(fields[5])),
      .passes = static_cast<std::uint8_t>(std::stoul(fields[2])),
      .alignment_credit = static_cast<std::uint8_t>(std::stoul(fields[3])),
    };
    const std::uint8_t action = static_cast<std::uint8_t>(std::stoul(fields[6]));
    const auto [found, inserted] = result.emplace(key, action);
    if (!inserted && found->second != action) {
      throw std::runtime_error("neural match identity has conflicting actions");
    }
  }
  return result;
}

struct HistoryLink {
  std::uint32_t parent{};
  PackedBoard board{};

  friend bool operator==(const HistoryLink&, const HistoryLink&) = default;
};

struct HistoryLinkHash {
  std::size_t operator()(const HistoryLink& link) const {
    return static_cast<std::size_t>(mix(link.board
      ^ (static_cast<std::uint64_t>(link.parent) << 32U)));
  }
};

class HistoryInterner {
 public:
  std::uint32_t intern(const std::vector<PackedBoard>& oldest_first) {
    std::uint32_t parent = 0;
    // The transition model appends prior boards, so certificates store the
    // superko sequence oldest first. Intern in that order to share real game
    // prefixes while preserving exact sequence identity.
    for (const PackedBoard board : oldest_first) {
      const HistoryLink link{parent, board};
      const auto found = index_.find(link);
      if (found != index_.end()) {
        parent = found->second;
        continue;
      }
      if (links_.size() >= std::numeric_limits<std::uint32_t>::max() - 1ULL) {
        throw std::runtime_error("history interner exceeds 32-bit capacity");
      }
      parent = static_cast<std::uint32_t>(links_.size() + 1U);
      links_.push_back(link);
      index_.emplace(link, parent);
    }
    return parent;
  }

  std::size_t size() const { return links_.size(); }

 private:
  std::unordered_map<HistoryLink, std::uint32_t, HistoryLinkHash> index_;
  std::vector<HistoryLink> links_;
};

struct ParsedState {
  std::uint32_t local_id{};
  std::uint32_t round{};
  ExactKey key;
  std::vector<PackedBoard> history;
  std::uint32_t history_hash{};
  std::uint32_t history_hash2{};
  std::uint8_t action{action_terminal};
  std::vector<std::uint32_t> successors;
};

std::uint32_t history_hash32(const std::vector<PackedBoard>& history,
  std::uint32_t seed = 0) {
  // A small 32-bit word-at-a-time mixer using XXH32's tail and avalanche
  // constants. This is not used as proof identity: the packer compares exact
  // interned histories first and rejects a hash collision whenever a visible
  // state would need different actions.
  constexpr std::uint32_t prime2 = 0x85ebca77U;
  constexpr std::uint32_t prime3 = 0xc2b2ae3dU;
  constexpr std::uint32_t prime4 = 0x27d4eb2fU;
  constexpr std::uint32_t prime5 = 0x165667b1U;
  std::uint32_t hash = (prime5 + static_cast<std::uint32_t>(history.size() * 8U)) ^ seed;
  for (const PackedBoard board : history) {
    for (const std::uint32_t word : {static_cast<std::uint32_t>(board),
      static_cast<std::uint32_t>(board >> 32U)}) {
      hash += word * prime3;
      hash = std::rotl(hash, 17) * prime4;
    }
  }
  hash ^= hash >> 15U;
  hash *= prime2;
  hash ^= hash >> 13U;
  hash *= prime3;
  return hash ^ (hash >> 16U);
}

struct ParsedPolicy {
  std::uint32_t phase{};
  std::uint32_t runtime_ticks{};
  std::uint32_t ai_seed_slip{};
  std::uint32_t playtime_epoch{};
  std::uint32_t alignment_boards{};
  std::uint32_t max_rounds{};
  std::vector<ParsedState> states;
};

std::uint8_t parse_action(std::string text) {
  bool slot_one = false;
  const std::size_t slot = text.find("@slot");
  if (slot != std::string::npos) {
    const std::string number = text.substr(slot + 5);
    if (number != "0" && number != "1") throw std::runtime_error("invalid timing slot " + text);
    slot_one = number == "1";
    text.resize(slot);
  }
  std::uint8_t result = action_terminal;
  if (text == "terminal") result = action_terminal;
  else if (text == "pass") result = action_pass;
  else if (text == "align") result = action_align;
  else {
    const auto coordinates = split(text, ',');
    if (coordinates.size() != 2) throw std::runtime_error("invalid certificate action " + text);
    const int x = std::stoi(coordinates[0]);
    const int y = std::stoi(coordinates[1]);
    if (x < 0 || x >= 5 || y < 0 || y >= 5) {
      throw std::runtime_error("certificate coordinate out of range " + text);
    }
    result = static_cast<std::uint8_t>(x * 5 + y);
  }
  if (slot_one) result = static_cast<std::uint8_t>(result | action_slot_one);
  return result;
}

std::uint32_t header_integer(std::string_view line, std::string_view expected) {
  const auto fields = split(line, '\t');
  if (fields.size() != 2 || fields[0] != std::string("# ") + std::string(expected)) {
    throw std::runtime_error("unexpected certificate header: " + std::string(line));
  }
  return static_cast<std::uint32_t>(std::stoul(fields[1]));
}

ParsedPolicy read_policy(const std::filesystem::path& path) {
  std::ifstream input(path);
  if (!input) throw std::runtime_error("cannot read policy " + path.string());
  std::string line;
  if (!std::getline(input, line) || line != "# ipvgo-seeded-certificate-v6") {
    throw std::runtime_error("unsupported certificate schema " + path.string());
  }
  ParsedPolicy result;
  if (!std::getline(input, line)) throw std::runtime_error("truncated policy header");
  result.phase = header_integer(line, "start_phase");
  if (!std::getline(input, line)) throw std::runtime_error("truncated policy header");
  result.runtime_ticks = header_integer(line, "runtime_uncertainty_ticks");
  if (!std::getline(input, line)) throw std::runtime_error("truncated policy header");
  result.ai_seed_slip = header_integer(line, "ai_seed_slip_ticks");
  if (!std::getline(input, line)) throw std::runtime_error("truncated policy header");
  result.playtime_epoch = header_integer(line, "playtime_epoch");
  if (!std::getline(input, line)) throw std::runtime_error("truncated policy header");
  result.alignment_boards = header_integer(line, "alignment_boards");
  if (!std::getline(input, line)) throw std::runtime_error("truncated policy header");
  result.max_rounds = header_integer(line, "max_rounds");
  do {
    if (!std::getline(input, line)) throw std::runtime_error("truncated policy header");
  } while (line.starts_with('#'));
  if (!line.starts_with("state_id\t")) {
    throw std::runtime_error("missing certificate column header");
  }
  while (std::getline(input, line)) {
    if (line.empty()) continue;
    const auto fields = split(line, '\t');
    if (fields.size() != 10) {
      throw std::runtime_error("certificate row has " + std::to_string(fields.size())
        + " fields in " + path.string());
    }
    ParsedState state;
    state.local_id = static_cast<std::uint32_t>(std::stoul(fields[0]));
    state.key.phase = static_cast<std::uint32_t>(std::stoul(fields[1]));
    state.round = static_cast<std::uint32_t>(std::stoul(fields[2]));
    state.key.alignment_credit = static_cast<std::uint8_t>(std::stoul(fields[3]));
    state.key.board = pack_board(board_from_hash(5, fields[4]));
    state.key.passes = static_cast<std::uint8_t>(std::stoul(fields[5]));
    if (!fields[6].empty()) {
      for (const std::string& board : split(fields[6], ',')) {
        state.history.push_back(std::stoull(board, nullptr, 0));
      }
    }
    state.history_hash = history_hash32(state.history);
    state.history_hash2 = history_hash32(state.history, 0x7f4a7c15U);
    state.action = parse_action(fields[7]);
    if (!fields[9].empty()) {
      for (const std::string& successor : split(fields[9], ',')) {
        state.successors.push_back(static_cast<std::uint32_t>(std::stoul(successor)));
      }
      std::sort(state.successors.begin(), state.successors.end());
      state.successors.erase(std::unique(state.successors.begin(), state.successors.end()),
        state.successors.end());
    }
    result.states.push_back(std::move(state));
  }
  if (result.states.empty()) throw std::runtime_error("empty policy " + path.string());
  return result;
}

struct SharedNode {
  PackedBoard board{};
  std::uint32_t phase{};
  std::uint8_t passes{};
  std::uint8_t alignment_credit{};
  std::uint8_t action{action_terminal};
  std::uint32_t history_id{};
  std::uint32_t history_hash{};
  std::uint32_t history_hash2{};
  bool initialized{};
  bool emit_override{true};
  std::vector<std::uint32_t> successors;
};

struct VisibleKey {
  PackedBoard board{};
  std::uint32_t phase{};
  std::uint8_t passes{};
  std::uint8_t alignment_credit{};

  friend bool operator==(const VisibleKey&, const VisibleKey&) = default;
};

struct VisibleKeyLess {
  bool operator()(const VisibleKey& left, const VisibleKey& right) const {
    if (left.phase != right.phase) return left.phase < right.phase;
    const std::uint32_t left_high = static_cast<std::uint32_t>(left.board >> 32U)
      | (static_cast<std::uint32_t>(left.passes) << 18U)
      | (static_cast<std::uint32_t>(left.alignment_credit) << 20U);
    const std::uint32_t right_high = static_cast<std::uint32_t>(right.board >> 32U)
      | (static_cast<std::uint32_t>(right.passes) << 18U)
      | (static_cast<std::uint32_t>(right.alignment_credit) << 20U);
    if (left_high != right_high) return left_high < right_high;
    return static_cast<std::uint32_t>(left.board) < static_cast<std::uint32_t>(right.board);
  }
};

struct SimpleRule {
  VisibleKey key;
  std::uint8_t action{};
  bool ambiguous{};
  std::vector<std::pair<std::uint32_t, std::uint8_t>> variants;
};

class Bytes {
 public:
  void byte(std::uint8_t value) { bytes_.push_back(value); }
  void u16(std::uint16_t value) {
    for (unsigned shift = 0; shift < 16; shift += 8) byte(static_cast<std::uint8_t>(value >> shift));
  }
  void u32(std::uint32_t value) {
    for (unsigned shift = 0; shift < 32; shift += 8) byte(static_cast<std::uint8_t>(value >> shift));
  }
  void u64(std::uint64_t value) {
    for (unsigned shift = 0; shift < 64; shift += 8) byte(static_cast<std::uint8_t>(value >> shift));
  }
  void text(std::string_view value) {
    bytes_.insert(bytes_.end(), value.begin(), value.end());
  }
  const std::vector<std::uint8_t>& data() const { return bytes_; }
 private:
  std::vector<std::uint8_t> bytes_;
};

std::string base64(const std::vector<std::uint8_t>& bytes) {
  constexpr std::string_view alphabet =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  std::string result;
  result.reserve((bytes.size() + 2U) / 3U * 4U);
  for (std::size_t index = 0; index < bytes.size(); index += 3) {
    const std::uint32_t a = bytes[index];
    const std::uint32_t b = index + 1 < bytes.size() ? bytes[index + 1] : 0;
    const std::uint32_t c = index + 2 < bytes.size() ? bytes[index + 2] : 0;
    const std::uint32_t value = (a << 16U) | (b << 8U) | c;
    result.push_back(alphabet[(value >> 18U) & 63U]);
    result.push_back(alphabet[(value >> 12U) & 63U]);
    result.push_back(index + 1 < bytes.size() ? alphabet[(value >> 6U) & 63U] : '=');
    result.push_back(index + 2 < bytes.size() ? alphabet[value & 63U] : '=');
  }
  return result;
}

void atomic_binary_write(const std::filesystem::path& path,
  const std::vector<std::uint8_t>& bytes) {
  if (path.has_parent_path()) std::filesystem::create_directories(path.parent_path());
  const std::filesystem::path temporary = path.string() + ".tmp";
  std::ofstream output(temporary, std::ios::binary | std::ios::trunc);
  output.write(reinterpret_cast<const char*>(bytes.data()), static_cast<std::streamsize>(bytes.size()));
  output.flush();
  if (!output) throw std::runtime_error("failed writing " + temporary.string());
  output.close();
  std::filesystem::rename(temporary, path);
}

struct PolicyQuality {
  std::uint32_t phase{};
  std::map<unsigned, std::uint32_t> worst_round_by_power;
  double worst_power_per_round{};
  long double route_power_sum{};
  long double route_turn_sum{};
  long double route_count{};
};

PolicyQuality policy_quality(const ParsedPolicy& policy, double komi) {
  PolicyQuality quality{.phase = policy.phase};
  struct RouteAggregate {
    long double power{};
    long double turns{};
    long double count{};
  };
  std::unordered_map<std::uint32_t, std::size_t> by_id;
  by_id.reserve(policy.states.size());
  for (std::size_t index = 0; index < policy.states.size(); ++index) {
    by_id.emplace(policy.states[index].local_id, index);
  }
  std::vector<std::size_t> order(policy.states.size());
  for (std::size_t index = 0; index < order.size(); ++index) order[index] = index;
  std::sort(order.begin(), order.end(), [&](std::size_t left, std::size_t right) {
    return policy.states[left].round > policy.states[right].round;
  });
  std::vector<RouteAggregate> aggregates(policy.states.size());
  for (const ParsedState& state : policy.states) {
    if ((state.action & 31U) != action_terminal) continue;
    const Score score = score_board(unpack_board(state.key.board), komi);
    if (score.black <= score.white) {
      throw std::runtime_error("certificate terminal does not win at the opponent komi; "
        "check --enemy/--komi against the input corpus");
    }
    const unsigned power = static_cast<unsigned>(score.black);
    auto [entry, inserted] = quality.worst_round_by_power.emplace(power, state.round);
    if (!inserted) entry->second = std::max(entry->second, state.round);
  }
  for (const std::size_t index : order) {
    const ParsedState& state = policy.states[index];
    RouteAggregate& aggregate = aggregates[index];
    if ((state.action & 31U) == action_terminal) {
      const Score score = score_board(unpack_board(state.key.board), komi);
      aggregate = {score.black, static_cast<long double>(std::max(1U, state.round)), 1};
      continue;
    }
    for (const std::uint32_t successor : state.successors) {
      const auto found = by_id.find(successor);
      if (found == by_id.end()) throw std::runtime_error("policy quality lacks successor");
      const RouteAggregate& child = aggregates[found->second];
      aggregate.power += child.power;
      aggregate.turns += child.turns;
      aggregate.count += child.count;
    }
    if (aggregate.count == 0) throw std::runtime_error("policy quality reaches no terminal route");
    // Mirror the generator's later-edge charge: a slot-1 action waits from a
    // base-phase arrival to base+1 for about half of the sub-tick offsets, so
    // its routes cost half an extra turn each in expectation.
    if ((state.action & action_slot_one) != 0) aggregate.turns += 0.5L * aggregate.count;
  }
  const auto root = by_id.find(0);
  if (root == by_id.end()) throw std::runtime_error("policy quality lacks root state");
  quality.route_power_sum = aggregates[root->second].power;
  quality.route_turn_sum = aggregates[root->second].turns;
  quality.route_count = aggregates[root->second].count;
  if (quality.worst_round_by_power.empty()) {
    throw std::runtime_error("winning policy contains no terminal outcome");
  }
  quality.worst_power_per_round = std::numeric_limits<double>::infinity();
  for (const auto& [power, round] : quality.worst_round_by_power) {
    quality.worst_power_per_round = std::min(quality.worst_power_per_round,
      static_cast<double>(power) / static_cast<double>(std::max(1U, round)));
  }
  return quality;
}

void atomic_quality_write(const std::filesystem::path& path,
  const std::vector<PolicyQuality>& qualities) {
  if (path.has_parent_path()) std::filesystem::create_directories(path.parent_path());
  const std::filesystem::path temporary = path.string() + ".tmp";
  std::ofstream output(temporary, std::ios::trunc);
  if (!output) throw std::runtime_error("cannot write " + temporary.string());
  output << "phase\tworst_power_per_round\tworst_power_per_second"
    << "\troute_aggregate_power_per_round\troute_count\toutcomes_power:max_round\n";
  for (const PolicyQuality& quality : qualities) {
    // The per-second column is an upper bound: it assumes one 200 ms engine
    // tick per round, while adversarial timing allows two ticks per round.
    output << quality.phase << '\t' << std::fixed << std::setprecision(9)
      << quality.worst_power_per_round << '\t' << quality.worst_power_per_round * 5.0 << '\t'
      << static_cast<double>(quality.route_power_sum / quality.route_turn_sum) << '\t'
      << static_cast<double>(quality.route_count) << '\t';
    bool first = true;
    for (const auto& [power, round] : quality.worst_round_by_power) {
      if (!first) output << ',';
      first = false;
      output << power << ':' << round;
    }
    output << '\n';
  }
  output.flush();
  if (!output) throw std::runtime_error("failed writing " + temporary.string());
  output.close();
  std::filesystem::rename(temporary, path);
}

void atomic_typescript_write(const std::filesystem::path& path, std::string_view encoded,
  std::uint32_t policies, std::uint32_t shared_nodes, std::uint32_t shared_edges) {
  if (path.has_parent_path()) std::filesystem::create_directories(path.parent_path());
  const std::filesystem::path temporary = path.string() + ".tmp";
  std::ofstream output(temporary, std::ios::trunc);
  if (!output) throw std::runtime_error("cannot write " + temporary.string());
  output << "// Generated by ipvgo_seeded_pack. Do not edit.\n"
    << "export const SEEDED_PHASE_COUNT = 150000;\n"
    << "export const NEXT_BOARD_ROOT = 0xfffffffe;\n"
    << "export const MISSING_ROOT = 0xffffffff;\n"
    << "export const POLICY_COUNT = " << policies << ";\n"
    << "export const SHARED_NODE_COUNT = " << shared_nodes << ";\n"
    << "export const SHARED_EDGE_COUNT = " << shared_edges << ";\n"
    << "const BASE64 =\n";
  constexpr std::size_t chunk = 16'384;
  for (std::size_t offset = 0; offset < encoded.size(); offset += chunk) {
    output << "  \"" << encoded.substr(offset, std::min(chunk, encoded.size() - offset)) << "\""
      << (offset + chunk < encoded.size() ? " +\n" : ";\n");
  }
  output << R"TS(
const raw = atob(BASE64);
const bytes = new Uint8Array(raw.length);
for (let i = 0; i < raw.length; ++i) bytes[i] = raw.charCodeAt(i);
const view = new DataView(bytes.buffer);
const text = (offset: number, length: number): string =>
  String.fromCharCode(...bytes.subarray(offset, offset + length));
if (text(0, 8) !== "IPVGPLY1" || view.getUint32(8, true) !== 1) {
  throw new Error("unsupported IPvGO seeded playbook");
}
const phaseCount = view.getUint32(12, true);
const nodeCount = view.getUint32(16, true);
const edgeCount = view.getUint32(20, true);
if (phaseCount !== SEEDED_PHASE_COUNT || nodeCount !== SHARED_NODE_COUNT ||
    edgeCount !== SHARED_EDGE_COUNT) throw new Error("playbook metadata mismatch");
const rootsOffset = 28;
const nodesOffset = rootsOffset + phaseCount * 4;
const edgesOffset = nodesOffset + nodeCount * 20;

export type PlaybookAction =
  | { kind: "move"; x: number; y: number; timingSlot: 0 | 1 }
  | { kind: "pass" | "align" | "sleep" | "terminal"; timingSlot: 0 | 1 };
export interface PlaybookNode {
  id: number;
  board: bigint;
  phase: number;
  passes: number;
  alignmentCredit: number;
  action: PlaybookAction;
  successors: readonly number[];
}

export function phaseRoot(phase: number): number {
  const normalized = ((phase % phaseCount) + phaseCount) % phaseCount;
  return view.getUint32(rootsOffset + normalized * 4, true);
}

function decodeAction(encoded: number): PlaybookAction {
  const timingSlot = ((encoded >>> 5) & 1) as 0 | 1;
  const operation = encoded & 31;
  if (operation < 25) return {kind: "move", x: Math.floor(operation / 5),
    y: operation % 5, timingSlot};
  if (operation === 25) return {kind: "pass", timingSlot};
  if (operation === 26) return {kind: "align", timingSlot};
  // 27 is the synthesized one-phase controlled sleep. The binary graph never
  // stores it today (only the flat JS tables do), but decode it consistently.
  if (operation === 27) return {kind: "sleep", timingSlot};
  return {kind: "terminal", timingSlot};
}

export function playbookNode(id: number): PlaybookNode {
  if (!Number.isInteger(id) || id < 0 || id >= nodeCount) throw new Error(`invalid node ${id}`);
  const offset = nodesOffset + id * 20;
  const edgeBegin = view.getUint32(offset + 12, true);
  const edgeLength = view.getUint16(offset + 16, true);
  const metadata = view.getUint8(offset + 19);
  const successors: number[] = [];
  for (let index = 0; index < edgeLength; ++index) {
    successors.push(view.getUint32(edgesOffset + (edgeBegin + index) * 4, true));
  }
  return {id, board: view.getBigUint64(offset, true), phase: view.getUint32(offset + 8, true),
    passes: metadata & 3, alignmentCredit: metadata >>> 2,
    action: decodeAction(view.getUint8(offset + 18)), successors};
}

export function observedSuccessor(parentId: number, board: bigint, phase: number,
  passes: number, alignmentCredit: number): number | undefined {
  for (const id of playbookNode(parentId).successors) {
    const candidate = playbookNode(id);
    if (candidate.board === board && candidate.phase === phase && candidate.passes === passes
        && candidate.alignmentCredit === alignmentCredit) return id;
  }
  return undefined;
}

export function printFirstBranch(startPhase: number, maximumSteps = 150001): void {
  let phase = ((startPhase % phaseCount) + phaseCount) % phaseCount;
  let id = phaseRoot(phase);
  for (let step = 0; step < maximumSteps; ++step) {
    if (id === NEXT_BOARD_ROOT) {
      console.log(`${step}: phase=${phase} action=next-board`);
      phase = (phase + 1) % phaseCount;
      id = phaseRoot(phase);
      continue;
    }
    if (id === MISSING_ROOT) throw new Error(`no policy reachable from phase ${phase}`);
    const node = playbookNode(id);
    console.log(`${step}: node=${id} phase=${node.phase} board=0x${node.board.toString(16)} ` +
      `passes=${node.passes} credit=${node.alignmentCredit} action=${JSON.stringify(node.action)}`);
    if (node.action.kind === "terminal") return;
    if (node.successors.length === 0) throw new Error(`node ${id} has no successor`);
    id = node.successors[0]!;
  }
  throw new Error(`first-branch print exceeded ${maximumSteps} steps`);
}

if (import.meta.main) printFirstBranch(Number(Bun.argv[2] ?? 0));
)TS";
  output.flush();
  if (!output) throw std::runtime_error("failed writing " + temporary.string());
  output.close();
  std::filesystem::rename(temporary, path);
}

struct SimpleTable {
  std::vector<std::uint8_t> skip_bits;
  /** Empty means phase_offsets is the dense 150001-entry directory. */
  std::vector<std::uint32_t> phase_values;
  std::vector<std::uint32_t> phase_offsets;
  std::vector<std::uint32_t> rule_words;
  std::vector<std::uint32_t> variant_rule_ids;
  std::vector<std::uint32_t> variant_offsets;
  std::vector<std::uint32_t> variant_hashes;
  std::vector<std::uint8_t> variant_actions;
  std::uint64_t history_free_rules{};
  std::uint64_t ambiguous_rules{};
  std::uint64_t exact_states_collapsed{};
};

SimpleTable make_simple_table(const std::vector<SharedNode>& nodes,
  const std::array<std::uint32_t, seeded_phase_count>& roots) {
  struct VisibleAction {
    std::uint32_t history_id{};
    std::uint32_t history_hash{};
    std::uint8_t action{};
  };
  std::map<VisibleKey, std::vector<VisibleAction>, VisibleKeyLess> groups;
  for (const SharedNode& node : nodes) {
    const std::uint8_t operation = node.action & 31U;
    if (operation == action_terminal) continue;
    groups[{node.board, node.phase, node.passes, node.alignment_credit}].push_back(
      {node.history_id, node.history_hash, operation});
    if ((node.action & action_slot_one) != 0) {
      // The certified compound action is "move, then choose timing slot 1
      // after White". Runtime normalization stores the move in this state and
      // inserts an explicit one-phase sleep at each observed post-White state.
      for (const std::uint32_t successor : node.successors) {
        const SharedNode& child = nodes.at(successor);
        if (child.passes >= 2) continue;
        const std::uint32_t before_sleep = child.phase == 0
          ? seeded_phase_count - 1U : child.phase - 1U;
        groups[{child.board, before_sleep, child.passes, child.alignment_credit}].push_back(
          {child.history_id, child.history_hash, action_sleep_one});
      }
    }
  }

  std::vector<SimpleRule> rules;
  rules.reserve(groups.size());
  SimpleTable table;
  table.skip_bits.assign((seeded_phase_count + 7U) / 8U, 0);
  for (std::uint32_t phase = 0; phase < seeded_phase_count; ++phase) {
    if (roots[phase] == next_board_root) {
      table.skip_bits[phase >> 3U] = static_cast<std::uint8_t>(
        table.skip_bits[phase >> 3U] | (1U << (phase & 7U)));
    }
  }

  for (const auto& [key, entries] : groups) {
    // Multiple certificates can offer distinct winning actions for the same
    // exact state. Keep the numerically smallest deterministic action first;
    // every offered continuation was independently replay-validated.
    std::map<std::uint32_t, VisibleAction> exact;
    for (const VisibleAction& entry : entries) {
      const auto [found, inserted] = exact.emplace(entry.history_id, entry);
      if (!inserted) found->second.action = std::min(found->second.action, entry.action);
    }
    SimpleRule rule{.key = key, .action = exact.begin()->second.action};
    const bool uniform = std::all_of(exact.begin(), exact.end(), [&](const auto& state) {
      return state.second.action == rule.action;
    });
    if (uniform) {
      ++table.history_free_rules;
    } else {
      rule.ambiguous = true;
      std::map<std::uint32_t, std::uint8_t> variants;
      for (const auto& [history_id, state] : exact) {
        static_cast<void>(history_id);
        const auto [found, inserted] = variants.emplace(state.history_hash, state.action);
        if (!inserted && found->second != state.action) {
          throw std::runtime_error(
            "32-bit history hash collision selects different certified actions");
        }
      }
      rule.variants.assign(variants.begin(), variants.end());
      ++table.ambiguous_rules;
    }
    table.exact_states_collapsed += exact.size() - 1U;
    rules.push_back(std::move(rule));
  }

  std::vector<std::uint32_t> sparse_values;
  std::vector<std::uint32_t> sparse_offsets;
  sparse_offsets.push_back(0);
  for (std::size_t cursor = 0; cursor < rules.size();) {
    const std::uint32_t phase = rules[cursor].key.phase;
    sparse_values.push_back(phase);
    while (cursor < rules.size() && rules[cursor].key.phase == phase) ++cursor;
    sparse_offsets.push_back(static_cast<std::uint32_t>(cursor));
  }
  const std::size_t sparse_bytes = sparse_values.size() * sizeof(std::uint32_t)
    + sparse_offsets.size() * sizeof(std::uint32_t);
  const std::size_t dense_bytes = (seeded_phase_count + 1U) * sizeof(std::uint32_t);
  if (sparse_bytes < dense_bytes) {
    table.phase_values = std::move(sparse_values);
    table.phase_offsets = std::move(sparse_offsets);
  } else {
    table.phase_offsets.resize(seeded_phase_count + 1U);
    std::size_t cursor = 0;
    for (std::uint32_t phase = 0; phase < seeded_phase_count; ++phase) {
      table.phase_offsets[phase] = static_cast<std::uint32_t>(cursor);
      while (cursor < rules.size() && rules[cursor].key.phase == phase) ++cursor;
    }
    table.phase_offsets[seeded_phase_count] = static_cast<std::uint32_t>(rules.size());
  }

  table.rule_words.reserve(rules.size() * 2U);
  table.variant_offsets.push_back(0);
  for (std::uint32_t rule_id = 0; rule_id < rules.size(); ++rule_id) {
    const SimpleRule& rule = rules[rule_id];
    const std::uint32_t low = static_cast<std::uint32_t>(rule.key.board);
    const std::uint32_t high = static_cast<std::uint32_t>(rule.key.board >> 32U)
      | (static_cast<std::uint32_t>(rule.key.passes) << 18U)
      | (static_cast<std::uint32_t>(rule.key.alignment_credit) << 20U);
    if (high >= (1U << 24U) || rule.action >= 32U) {
      throw std::runtime_error("simple rule does not fit its packed words");
    }
    table.rule_words.push_back(low);
    table.rule_words.push_back(high | (static_cast<std::uint32_t>(rule.action) << 24U)
      | (static_cast<std::uint32_t>(rule.ambiguous) << 29U));
    if (rule.ambiguous) {
      table.variant_rule_ids.push_back(rule_id);
      for (const auto& [hash, action] : rule.variants) {
        table.variant_hashes.push_back(hash);
        table.variant_actions.push_back(action);
      }
      table.variant_offsets.push_back(static_cast<std::uint32_t>(table.variant_hashes.size()));
    }
  }
  return table;
}

std::vector<std::uint8_t> u32_bytes(const std::vector<std::uint32_t>& values) {
  Bytes bytes;
  for (const std::uint32_t value : values) bytes.u32(value);
  return bytes.data();
}

void write_base64_expression(std::ofstream& output, const std::vector<std::uint8_t>& bytes) {
  const std::string encoded = base64(bytes);
  if (encoded.empty()) {
    output << "\"\"";
    return;
  }
  constexpr std::size_t chunk = 16'384;
  for (std::size_t offset = 0; offset < encoded.size(); offset += chunk) {
    if (offset != 0) output << "+\n";
    output << '"' << encoded.substr(offset, std::min(chunk, encoded.size() - offset)) << '"';
  }
}

void atomic_simple_js_write(const std::filesystem::path& path, const SimpleTable& table) {
  if (path.has_parent_path()) std::filesystem::create_directories(path.parent_path());
  const std::filesystem::path temporary = path.string() + ".tmp";
  std::ofstream output(temporary, std::ios::trunc);
  if (!output) throw std::runtime_error("cannot write " + temporary.string());
  output << R"JS(// Generated by ipvgo_seeded_pack. Next-action table only.
var PackedBytes=s=>{var x=atob(s),a=new Uint8Array(x.length);for(var i=0;i<x.length;i++)a[i]=x.charCodeAt(i);return a}
var PackedBits=PackedBytes
var PackedU32=s=>new Uint32Array(PackedBytes(s).buffer)
var PHASES=150000,MISS=-1
var MOVE_PASS=25,MOVE_ALIGN=26,MOVE_SLEEP1=27
var skipBits=PackedBits(
)JS";
  write_base64_expression(output, table.skip_bits);
  output << ")\nvar phaseValues=PackedU32(\n";
  write_base64_expression(output, u32_bytes(table.phase_values));
  output << ")\nvar phaseOffsets=PackedU32(\n";
  write_base64_expression(output, u32_bytes(table.phase_offsets));
  output << ")\nvar netburnerRules=PackedU32(\n";
  write_base64_expression(output, u32_bytes(table.rule_words));
  output << ")\nvar variantRuleIds=PackedU32(\n";
  write_base64_expression(output, u32_bytes(table.variant_rule_ids));
  output << ")\nvar variantOffsets=PackedU32(\n";
  write_base64_expression(output, u32_bytes(table.variant_offsets));
  output << ")\nvar variantHashes=PackedU32(\n";
  write_base64_expression(output, u32_bytes(table.variant_hashes));
  output << ")\nvar variantMoves=PackedBytes(\n";
  write_base64_expression(output, table.variant_actions);
  output << R"JS()

var phaseNow=ms=>Math.floor((((ms%30000000)+30000000)%30000000)/200)
var skipPhase=p=>(skipBits[p>>3]>>(p&7))&1
var packBoard=columns=>{var b=0n;for(var x=0;x<5;x++)for(var y=0;y<5;y++){
  var c=columns[x][y],v=c==="X"?1n:c==="O"?2n:c==="#"?3n:0n
  b|=v<<BigInt(2*(x*5+y))
}return b}

// Rules are phase-bucketed, so their 18 phase bits are stored once in
// phaseOffsets instead of once per state. Each rule is exactly two u32 words:
// board-low32, then board-high18|passes2|alignment4|action5|ambiguous1.
var bSearchBoard=(phase,board,passes=0,credit=0)=>{
  phase=((phase%PHASES)+PHASES)%PHASES
  var lo=Number(board&0xffffffffn)>>>0
  var hi=(Number((board>>32n)&0x3ffffn)|(passes<<18)|(credit<<20))>>>0
  var p=phase
  if(phaseValues.length){
    var a=0,z=phaseValues.length-1;p=MISS
    while(a<=z){var n=(a+z)>>>1,v=phaseValues[n];if(v<phase)a=n+1;else if(v>phase)z=n-1;else{p=n;break}}
    if(p===MISS)return MISS
  }
  var l=phaseOffsets[p],r=phaseOffsets[p+1]-1
  while(l<=r){
    var m=(l+r)>>>1,w=netburnerRules[m*2+1]&0xffffff,q=netburnerRules[m*2]
    if(w<hi||(w===hi&&q<lo))l=m+1
    else if(w>hi||(w===hi&&q>lo))r=m-1
    else return m
  }
  return MISS
}

// Oldest board first, matching the solver's positional-superko sequence.
// Exact histories were compared before packing. This 32-bit discriminator is
// used only for visible states that need different certified actions; the
// offline compiler rejects every action-changing collision.
var historyHash=history=>{
  var h=(0x165667b1+history.length*8)>>>0
  for(var b of history)for(var w of [Number(b&0xffffffffn)>>>0,Number((b>>32n)&0xffffffffn)>>>0]){
    h=(h+Math.imul(w,0xc2b2ae3d))>>>0
    h=(Math.imul(((h<<17)|(h>>>15))>>>0,0x27d4eb2f))>>>0
  }
  h^=h>>>15;h=Math.imul(h,0x85ebca77)>>>0;h^=h>>>13
  h=Math.imul(h,0xc2b2ae3d)>>>0;return (h^(h>>>16))>>>0
}

var historyMove=(rule,history)=>{
  var l=0,r=variantRuleIds.length-1,group=MISS
  while(l<=r){var m=(l+r)>>>1,v=variantRuleIds[m];if(v<rule)l=m+1;else if(v>rule)r=m-1;else{group=m;break}}
  if(group===MISS)return MISS
  var hash=historyHash(history);l=variantOffsets[group];r=variantOffsets[group+1]-1
  while(l<=r){var m=(l+r)>>>1,v=variantHashes[m];if(v<hash)l=m+1;else if(v>hash)r=m-1;else return variantMoves[m]}
  return MISS
}

var lookupMove=(phase,board,passes=0,credit=0,history=[])=>{
  var rule=bSearchBoard(phase,board,passes,credit)
  if(rule===MISS)return MISS
  var word=netburnerRules[rule*2+1],move=(word>>>24)&31
  return ((word>>>29)&1)?historyMove(rule,history):move
}

var describeMove=move=>{
  if(move<25)return {kind:"move",x:(move/5)|0,y:move%5}
  if(move===MOVE_PASS)return {kind:"pass"}
  if(move===MOVE_ALIGN)return {kind:"align"}
  return {kind:"sleep",variant:move-MOVE_SLEEP1+1}
}

export {skipBits,netburnerRules,phaseNow,skipPhase,packBoard,bSearchBoard,historyHash,lookupMove,describeMove}

// Proof-of-concept driver: print the reset decision chain. The production
// driver will maintain passes/alignment/history, verify the intended phase
// immediately before dispatch, and leave the board on any lookup miss.
export async function main(ns){
  var phase=phaseNow(ns.getPlayer().totalPlaytime)
  for(var waits=0;waits<PHASES;waits++,phase=(phase+1)%PHASES){
    ns.tprint("phase "+phase+": "+(skipPhase(phase)?"next-board":"enter-board"))
    if(!skipPhase(phase))return
  }
  ns.tprint("ERROR: no playable Netburners phase")
}
)JS";
  output.flush();
  if (!output) throw std::runtime_error("failed writing " + temporary.string());
  output.close();
  std::filesystem::rename(temporary, path);
}

struct PhaseEntry {
  PackedBoard board{};
  std::uint32_t phase{};
  std::uint32_t history_id{};
  std::uint32_t history_hash{};
  std::uint32_t history_hash2{};
  std::uint8_t passes{};
  std::uint8_t alignment_credit{};
  std::uint8_t action{};
};

struct RatePair {
  std::uint32_t power{};
  std::uint32_t turns{1};
};

bool better_rate(const RatePair& left, const RatePair& right) {
  return static_cast<std::uint64_t>(left.power) * right.turns
    > static_cast<std::uint64_t>(right.power) * left.turns;
}

// Unit note: certificate rounds span several 200 ms ticks (branch-dependent AI
// waits, typically two to six) while waits are
// single ticks; treating both as one turn biases the DODGE/ENTER trade-off.
// See policy_routes.cpp for the shared rationale.
RatePair policy_rate_after_wait(const PolicyQuality& quality, std::uint32_t waits,
  std::uint32_t elapsed_turns = 0) {
  std::optional<RatePair> worst;
  for (const auto& [power, rounds] : quality.worst_round_by_power) {
    const RatePair outcome{power, rounds + waits + elapsed_turns};
    if (!worst || better_rate(*worst, outcome)) worst = outcome;
  }
  if (!worst) throw std::logic_error("policy quality has no terminal outcomes");
  return *worst;
}

struct RootRoute {
  std::uint32_t entry_phase{};
  std::uint32_t waits{};
  RatePair worst;
  double entered_route_power_per_turn{};
};

struct RootRoutes {
  std::array<RootRoute, seeded_phase_count> routes;
  std::uint32_t maximum_wait{};
  std::uint64_t total_waits{};
  std::uint32_t enter_phases{};
  long double sum_rates{};
  std::uint64_t sum_worst_power{};
  std::uint64_t sum_worst_turns{};
};

using QualityIndex = std::array<const PolicyQuality*, seeded_phase_count>;

QualityIndex index_qualities(const std::vector<PolicyQuality>& qualities) {
  QualityIndex result{};
  for (const PolicyQuality& quality : qualities) {
    if (result[quality.phase] != nullptr) {
      throw std::runtime_error("duplicate policy quality phase");
    }
    result[quality.phase] = &quality;
  }
  return result;
}

RootRoute best_root_route(const QualityIndex& by_phase, std::uint32_t start,
  std::uint32_t elapsed_turns) {
  std::optional<RootRoute> best;
  constexpr std::uint32_t maximum_black_power = 25;
  for (std::uint32_t waits = 0; waits < seeded_phase_count; ++waits) {
    const std::uint32_t phase = static_cast<std::uint32_t>(
      (static_cast<std::uint64_t>(start) + waits) % seeded_phase_count);
    if (const PolicyQuality* quality = by_phase[phase]) {
      const RootRoute candidate{
        phase, waits, policy_rate_after_wait(*quality, waits, elapsed_turns),
        static_cast<double>(quality->route_power_sum / quality->route_turn_sum)};
      if (!best || better_rate(candidate.worst, best->worst)
          || (!better_rate(best->worst, candidate.worst)
            && std::tie(candidate.waits, candidate.entry_phase)
              < std::tie(best->waits, best->entry_phase))) {
        best = candidate;
      }
    }
    const std::uint64_t optimistic_turns = static_cast<std::uint64_t>(elapsed_turns)
      + waits + 2ULL;
    if (best && static_cast<std::uint64_t>(maximum_black_power) * best->worst.turns
        <= static_cast<std::uint64_t>(best->worst.power) * optimistic_turns) {
      break;
    }
  }
  if (!best) throw std::logic_error("root route scan failed to reach a policy");
  return *best;
}

RootRoutes optimize_root_routes(const std::vector<PolicyQuality>& qualities) {
  if (qualities.empty()) throw std::runtime_error("cannot route without a winning policy");
  const QualityIndex by_phase = index_qualities(qualities);

  RootRoutes result;
  for (std::uint32_t start = 0; start < seeded_phase_count; ++start) {
    const RootRoute best = best_root_route(by_phase, start, 0);
    result.routes[start] = best;
    result.maximum_wait = std::max(result.maximum_wait, best.waits);
    result.total_waits += best.waits;
    result.enter_phases += best.waits == 0;
    result.sum_rates += static_cast<long double>(best.worst.power) / best.worst.turns;
    result.sum_worst_power += best.worst.power;
    result.sum_worst_turns += best.worst.turns;
  }
  return result;
}

struct PhaseEntryLess {
  bool operator()(const PhaseEntry& left, const PhaseEntry& right) const {
    if (left.phase != right.phase) return left.phase < right.phase;
    if (left.board != right.board) return left.board < right.board;
    if (left.passes != right.passes) return left.passes < right.passes;
    if (left.alignment_credit != right.alignment_credit) {
      return left.alignment_credit < right.alignment_credit;
    }
    return left.history_id < right.history_id;
  }
};

std::vector<PhaseEntry> normalized_phase_entries(const std::vector<SharedNode>& nodes) {
  std::map<PhaseEntry, std::uint8_t, PhaseEntryLess> exact;
  auto offer = [&](const SharedNode& node, std::uint32_t phase, std::uint8_t action) {
    PhaseEntry entry{node.board, phase, node.history_id, node.history_hash,
      node.history_hash2,
      node.passes, node.alignment_credit, action};
    const auto [found, inserted] = exact.emplace(entry, action);
    if (!inserted) found->second = std::min(found->second, action);
  };
  for (const SharedNode& node : nodes) {
    const std::uint8_t operation = node.action & 31U;
    if (operation == action_terminal) continue;
    if (node.emit_override) offer(node, node.phase, operation);
    if ((node.action & action_slot_one) != 0) {
      for (const std::uint32_t successor : node.successors) {
        const SharedNode& child = nodes.at(successor);
        if (child.passes >= 2) continue;
        offer(child, child.phase == 0 ? seeded_phase_count - 1U : child.phase - 1U,
          action_sleep_one);
      }
    }
  }
  std::vector<PhaseEntry> result;
  result.reserve(exact.size());
  for (const auto& [entry, action] : exact) {
    PhaseEntry copy = entry;
    copy.action = action;
    result.push_back(copy);
  }
  return result;
}

std::uint32_t phase_state_hash(const PhaseEntry& entry, std::uint32_t seed) {
  constexpr std::uint32_t prime2 = 0x85ebca77U;
  constexpr std::uint32_t prime3 = 0xc2b2ae3dU;
  constexpr std::uint32_t prime4 = 0x27d4eb2fU;
  std::uint32_t hash = seed ^ 0x9e3779b1U;
  const std::array words{
    entry.history_hash,
    entry.history_hash2,
    static_cast<std::uint32_t>(entry.board),
    static_cast<std::uint32_t>(entry.board >> 32U),
    static_cast<std::uint32_t>(entry.passes)
      | (static_cast<std::uint32_t>(entry.alignment_credit) << 8U),
  };
  for (const std::uint32_t word : words) {
    hash += word * prime3;
    hash = std::rotl(hash, 17) * prime4;
  }
  hash ^= hash >> 15U;
  hash *= prime2;
  hash ^= hash >> 13U;
  hash *= prime3;
  return hash ^ (hash >> 16U);
}

struct PhaseCheck {
  std::uint32_t phase{};
  std::vector<PhaseEntry> entries;
  std::uint32_t distinct_actions{};
  std::uint32_t visible_keys{};
  std::uint32_t history_sensitive_keys{};
  std::uint32_t seed_zero_collisions{};
};

struct PhaseDispatch {
  std::vector<std::uint8_t> skip_bits;
  std::vector<std::uint32_t> root_entry_phases;
  std::vector<std::uint32_t> phase_programs;
  std::vector<std::uint32_t> check_offsets;
  std::vector<std::uint32_t> check_hashes;
  std::vector<std::uint8_t> check_actions;
  std::vector<PhaseCheck> checks;
  std::uint32_t hash_seed{};
  std::uint64_t direct_phases{};
  std::uint32_t max_check_states{};
  std::uint32_t max_check_probes{};
  unsigned program_width{};
  std::uint32_t missing_program{};
};

std::uint32_t distinct_hash_collisions(const std::vector<PhaseEntry>& entries,
  std::uint32_t seed) {
  std::map<std::uint32_t, PhaseEntry> hashes;
  std::uint32_t collisions = 0;
  for (const PhaseEntry& entry : entries) {
    const std::uint32_t hash = phase_state_hash(entry, seed);
    const auto [found, inserted] = hashes.emplace(hash, entry);
    if (!inserted && (found->second.board != entry.board
        || found->second.passes != entry.passes
        || found->second.alignment_credit != entry.alignment_credit
        || found->second.history_id != entry.history_id)) {
      ++collisions;
    }
  }
  return collisions;
}

PhaseDispatch make_phase_dispatch(const std::vector<SharedNode>& nodes,
  const RootRoutes& root_routes) {
  const std::vector<PhaseEntry> entries = normalized_phase_entries(nodes);
  std::map<std::uint32_t, std::vector<PhaseEntry>> by_phase;
  for (const PhaseEntry& entry : entries) by_phase[entry.phase].push_back(entry);

  PhaseDispatch result;
  result.skip_bits.assign((seeded_phase_count + 7U) / 8U, 0);
  result.root_entry_phases.reserve(seeded_phase_count);
  result.phase_programs.assign(seeded_phase_count, std::numeric_limits<std::uint32_t>::max());
  for (std::uint32_t phase = 0; phase < seeded_phase_count; ++phase) {
    const RootRoute& route = root_routes.routes[phase];
    result.root_entry_phases.push_back(route.entry_phase);
    if (route.waits != 0) {
      result.skip_bits[phase >> 3U] = static_cast<std::uint8_t>(
        result.skip_bits[phase >> 3U] | (1U << (phase & 7U)));
    }
  }

  for (const auto& [phase, states] : by_phase) {
    std::array<bool, 32> actions{};
    for (const PhaseEntry& state : states) actions[state.action] = true;
    const std::uint32_t action_count = static_cast<std::uint32_t>(
      std::count(actions.begin(), actions.end(), true));
    std::map<VisibleKey, std::array<bool, 32>, VisibleKeyLess> visible;
    for (const PhaseEntry& state : states) {
      visible[{state.board, state.phase, state.passes, state.alignment_credit}][state.action] = true;
    }
    std::uint32_t history_sensitive = 0;
    for (const auto& [key, choices] : visible) {
      static_cast<void>(key);
      if (std::count(choices.begin(), choices.end(), true) > 1) ++history_sensitive;
    }
    result.checks.push_back({phase, states, action_count,
      static_cast<std::uint32_t>(visible.size()), history_sensitive,
      distinct_hash_collisions(states, 0)});
  }

  bool found_seed = false;
  for (std::uint32_t seed = 0; seed < 1'000'000U; ++seed) {
    const bool collision = std::any_of(result.checks.begin(), result.checks.end(),
      [&](const PhaseCheck& check) { return distinct_hash_collisions(check.entries, seed) != 0; });
    if (!collision) {
      result.hash_seed = seed;
      found_seed = true;
      break;
    }
  }
  if (!found_seed) throw std::runtime_error("could not find collision-free 32-bit phase hash seed");

  result.check_offsets.push_back(0);
  for (std::uint32_t check_id = 0; check_id < result.checks.size(); ++check_id) {
    PhaseCheck& check = result.checks[check_id];
    result.max_check_states = std::max(result.max_check_states,
      static_cast<std::uint32_t>(check.entries.size()));
    result.phase_programs[check.phase] = 32U + check_id;
    std::vector<std::pair<std::uint32_t, std::uint8_t>> hashed;
    hashed.reserve(check.entries.size());
    for (const PhaseEntry& entry : check.entries) {
      hashed.emplace_back(phase_state_hash(entry, result.hash_seed), entry.action);
    }
    std::sort(hashed.begin(), hashed.end());
    for (const auto& [hash, action] : hashed) {
      result.check_hashes.push_back(hash);
      result.check_actions.push_back(action);
    }
    result.check_offsets.push_back(static_cast<std::uint32_t>(result.check_hashes.size()));
  }
  const std::uint64_t first_unused_program = 32ULL + result.checks.size();
  result.program_width = std::max(6U,
    static_cast<unsigned>(std::bit_width(first_unused_program)));
  if (result.program_width >= 32U) {
    throw std::runtime_error("phase CHECK programs exceed packed ID capacity");
  }
  result.missing_program = (1U << result.program_width) - 1U;
  if (first_unused_program > result.missing_program) {
    throw std::runtime_error("phase CHECK programs collide with the missing sentinel");
  }
  for (std::uint32_t& program : result.phase_programs) {
    if (program == std::numeric_limits<std::uint32_t>::max()) {
      program = result.missing_program;
    }
  }
  result.max_check_probes = std::bit_width(result.max_check_states);
  return result;
}

std::vector<std::uint8_t> packed_values(const std::vector<std::uint32_t>& values,
  unsigned width) {
  const std::size_t bits = values.size() * width;
  std::vector<std::uint8_t> result((bits + 7U) / 8U, 0);
  const std::uint32_t limit = 1U << width;
  std::size_t bit = 0;
  for (const std::uint32_t value : values) {
    if (value >= limit) throw std::runtime_error("value exceeds packed bit width");
    for (unsigned offset = 0; offset < width; ++offset) {
      if ((value & (1U << offset)) != 0) {
        result[(bit + offset) >> 3U] = static_cast<std::uint8_t>(
          result[(bit + offset) >> 3U] | (1U << ((bit + offset) & 7U)));
      }
    }
    bit += width;
  }
  return result;
}

class BitWriter {
public:
  void append_bit(bool value) {
    if ((bits_ & 7U) == 0) bytes_.push_back(0);
    if (value) bytes_.back() |= static_cast<std::uint8_t>(1U << (bits_ & 7U));
    ++bits_;
  }

  void append_bits(std::uint32_t value, unsigned width) {
    for (unsigned bit = 0; bit < width; ++bit) append_bit((value & (1U << bit)) != 0);
  }

  void append_rice(std::uint32_t value, unsigned remainder_bits) {
    const std::uint32_t quotient = value >> remainder_bits;
    for (std::uint32_t unary = 0; unary < quotient; ++unary) append_bit(false);
    append_bit(true);
    append_bits(value, remainder_bits);
  }

  const std::vector<std::uint8_t>& bytes() const { return bytes_; }

private:
  std::vector<std::uint8_t> bytes_;
  std::size_t bits_ = 0;
};

unsigned best_rice_width(const std::vector<std::uint32_t>& values) {
  unsigned best_width = 0;
  std::uint64_t best_bits = std::numeric_limits<std::uint64_t>::max();
  for (unsigned width = 0; width < 32; ++width) {
    std::uint64_t bits = 0;
    for (const std::uint32_t value : values) {
      bits += (static_cast<std::uint64_t>(value) >> width) + 1U + width;
    }
    if (bits < best_bits) {
      best_bits = bits;
      best_width = width;
    }
  }
  return best_width;
}

void atomic_collision_report_write(const std::filesystem::path& path,
  const PhaseDispatch& dispatch) {
  if (path.has_parent_path()) std::filesystem::create_directories(path.parent_path());
  const std::filesystem::path temporary = path.string() + ".tmp";
  std::ofstream output(temporary, std::ios::trunc);
  if (!output) throw std::runtime_error("cannot write " + temporary.string());
  output << "phase\texact_states\tdistinct_actions\tvisible_keys"
    << "\thistory_sensitive_keys\tseed0_hash_collisions\tselected_seed"
    << "\tentry\tselected_hash\tselected_hash2\tboard\tpasses\talignment_credit"
    << "\thistory_id\thistory_hash\thistory_hash2\taction\n";
  for (const PhaseCheck& check : dispatch.checks) {
    std::vector<std::pair<std::uint32_t, const PhaseEntry*>> hashed;
    hashed.reserve(check.entries.size());
    for (const PhaseEntry& entry : check.entries) {
      hashed.emplace_back(phase_state_hash(entry, dispatch.hash_seed), &entry);
    }
    std::sort(hashed.begin(), hashed.end(), [](const auto& left, const auto& right) {
      return left.first < right.first;
    });
    for (std::size_t entry_index = 0; entry_index < hashed.size(); ++entry_index) {
      const auto [hash, entry] = hashed[entry_index];
      const std::uint32_t hash_low = hash;
      const std::uint32_t hash_high = 0;
      output << check.phase << '\t' << check.entries.size() << '\t'
        << check.distinct_actions << '\t' << check.visible_keys << '\t'
        << check.history_sensitive_keys << '\t' << check.seed_zero_collisions << '\t'
        << dispatch.hash_seed << '\t' << entry_index << '\t' << hash_low << '\t'
        << hash_high << '\t'
        << "0x" << std::hex << std::setw(13) << std::setfill('0') << entry->board
        << std::dec << std::setfill(' ') << '\t' << static_cast<unsigned>(entry->passes)
        << '\t' << static_cast<unsigned>(entry->alignment_credit) << '\t'
        << entry->history_id << '\t' << entry->history_hash << '\t'
        << entry->history_hash2 << '\t'
        << static_cast<unsigned>(entry->action) << '\n';
    }
  }
  output.flush();
  if (!output) throw std::runtime_error("failed writing " + temporary.string());
  output.close();
  std::filesystem::rename(temporary, path);
}

void atomic_root_routes_write(const std::filesystem::path& path,
  const RootRoutes& routes) {
  if (path.has_parent_path()) std::filesystem::create_directories(path.parent_path());
  const std::filesystem::path temporary = path.string() + ".tmp";
  std::ofstream output(temporary, std::ios::trunc);
  if (!output) throw std::runtime_error("cannot write " + temporary.string());
  output << "phase\taction\tentry_phase\twaits\tworst_power\tworst_turns"
    << "\tworst_power_per_turn\tentered_route_power_per_turn\n";
  for (std::uint32_t phase = 0; phase < seeded_phase_count; ++phase) {
    const RootRoute& route = routes.routes[phase];
    output << phase << '\t' << (route.waits == 0 ? "ENTER" : "DODGE") << '\t'
      << route.entry_phase << '\t' << route.waits << '\t' << route.worst.power << '\t'
      << route.worst.turns << '\t' << std::fixed << std::setprecision(9)
      << static_cast<double>(route.worst.power) / route.worst.turns << '\t'
      << route.entered_route_power_per_turn << '\n';
  }
  output.flush();
  if (!output) throw std::runtime_error("failed writing " + temporary.string());
  output.close();
  std::filesystem::rename(temporary, path);
}

void atomic_phase_js_write(const std::filesystem::path& path, const PhaseDispatch& dispatch,
  const std::array<std::uint32_t, 5>& model, const std::string& enemy) {
  std::vector<std::uint32_t> route_run_ends;
  std::vector<std::uint32_t> route_run_targets;
  for (std::uint32_t begin = 0; begin < seeded_phase_count;) {
    const std::uint32_t target = dispatch.root_entry_phases.at(begin);
    std::uint32_t end = begin + 1U;
    while (end < seeded_phase_count && dispatch.root_entry_phases[end] == target) ++end;
    route_run_ends.push_back(end);
    route_run_targets.push_back(target);
    begin = end;
  }

  std::vector<std::uint32_t> direct_phases;
  std::vector<std::uint32_t> direct_actions;
  std::vector<std::uint8_t> check_phase_bits((seeded_phase_count + 7U) / 8U, 0);
  std::vector<std::uint32_t> check_counts;
  for (std::uint32_t phase = 0; phase < seeded_phase_count; ++phase) {
    const std::uint32_t program = dispatch.phase_programs.at(phase);
    if (program == dispatch.missing_program) {
      continue;
    } else if (program < 32U) {
      direct_phases.push_back(phase);
      direct_actions.push_back(program);
    } else {
      const std::uint32_t check = program - 32U;
      if (check != check_counts.size()) {
        throw std::logic_error("phase CHECK programs are not ordered by phase");
      }
      check_phase_bits[phase >> 3U] = static_cast<std::uint8_t>(
        check_phase_bits[phase >> 3U] | (1U << (phase & 7U)));
      check_counts.push_back(dispatch.check_offsets.at(check + 1U)
        - dispatch.check_offsets.at(check));
    }
  }

  std::vector<std::uint32_t> unique_hashes = dispatch.check_hashes;
  std::sort(unique_hashes.begin(), unique_hashes.end());
  unique_hashes.erase(std::unique(unique_hashes.begin(), unique_hashes.end()), unique_hashes.end());
  std::unordered_map<std::uint32_t, std::uint32_t> hash_ids;
  hash_ids.reserve(unique_hashes.size());
  for (std::uint32_t id = 0; id < unique_hashes.size(); ++id) {
    const std::uint32_t hash = unique_hashes[id];
    hash_ids.emplace(hash, id);
  }

  std::vector<std::uint32_t> global_hash_deltas;
  global_hash_deltas.reserve(unique_hashes.size());
  std::uint32_t previous_hash = 0;
  for (const std::uint32_t hash : unique_hashes) {
    global_hash_deltas.push_back(hash - previous_hash);
    previous_hash = hash;
  }
  const unsigned global_hash_rice_width = best_rice_width(global_hash_deltas);
  BitWriter global_hash_rice;
  for (const std::uint32_t delta : global_hash_deltas) {
    global_hash_rice.append_rice(delta, global_hash_rice_width);
  }

  BitWriter check_id_rice;
  std::vector<std::uint32_t> check_rice_widths;
  check_rice_widths.reserve(dispatch.checks.size());
  for (std::uint32_t check = 0; check < dispatch.checks.size(); ++check) {
    std::vector<std::uint32_t> deltas;
    std::uint32_t previous_id = 0;
    for (std::uint32_t index = dispatch.check_offsets.at(check);
         index < dispatch.check_offsets.at(check + 1U); ++index) {
      const auto found = hash_ids.find(dispatch.check_hashes.at(index));
      if (found == hash_ids.end()) throw std::logic_error("CHECK hash is absent from dictionary");
      const std::uint32_t id = found->second;
      deltas.push_back(id - previous_id);
      previous_id = id;
    }
    const unsigned width = best_rice_width(deltas);
    if (width >= 32U) throw std::logic_error("CHECK Rice width exceeds five-bit storage");
    check_rice_widths.push_back(width);
    for (const std::uint32_t delta : deltas) check_id_rice.append_rice(delta, width);
  }

  std::vector<std::uint32_t> check_move_values;
  check_move_values.reserve(dispatch.check_actions.size());
  for (const std::uint8_t action : dispatch.check_actions) {
    if (action >= 32U) throw std::logic_error("CHECK action exceeds five-bit storage");
    check_move_values.push_back(action);
  }
  const std::vector<std::uint8_t> check_move_codes = packed_values(check_move_values, 5U);

  if (path.has_parent_path()) std::filesystem::create_directories(path.parent_path());
  const std::filesystem::path temporary = path.string() + ".tmp";
  std::ofstream output(temporary, std::ios::trunc);
  if (!output) throw std::runtime_error("cannot write " + temporary.string());
  output << R"JS(// Generated by ipvgo_seeded_pack. Lossless phase-first next-action table.
// The runtime is deliberately formatted and readable; only the packed data is opaque.
function decodeBytes(encoded) {
  const binary = atob(encoded);
  const result = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) result[index] = binary.charCodeAt(index);
  return result;
}

function decodeCheckPrograms(bits) {
  const result = new Int32Array(PHASES);
  result.fill(-1);
  let check = 0;
  for (let phase = 0; phase < PHASES; phase++) {
    if ((bits[phase >> 3] >>> (phase & 7)) & 1) result[phase] = check++;
  }
  return result;
}

function decodeCheckOffsets(counts, count) {
  const result = new Uint32Array(count + 1);
  for (let check = 0; check < count; check++) {
    result[check + 1] = result[check] + packedValue(counts, check, CHECK_COUNT_BITS);
  }
  return result;
}

function packedValue(array, index, width) {
  const bit = index * width;
  const byte = bit >> 3;
  const shift = bit & 7;
  const word = array[byte]
    | ((array[byte + 1] || 0) << 8)
    | ((array[byte + 2] || 0) << 16)
    | ((array[byte + 3] || 0) << 24);
  return (word >>> shift) & ((1 << width) - 1);
}

function readBit(bytes, cursor) {
  if (cursor.bit >= bytes.length * 8) throw new Error("truncated playbook bitstream");
  return (bytes[cursor.bit >> 3] >>> (cursor.bit++ & 7)) & 1;
}

function readBits(bytes, cursor, width) {
  let value = 0;
  for (let bit = 0; bit < width; bit++) value |= readBit(bytes, cursor) << bit;
  return value >>> 0;
}

function readRice(bytes, cursor, remainderBits) {
  let quotient = 0;
  while (readBit(bytes, cursor) === 0) quotient++;
  return quotient * 2 ** remainderBits + readBits(bytes, cursor, remainderBits);
}

function decodeRiceDeltas(bytes, count, remainderBits) {
  const result = new Uint32Array(count);
  const cursor = { bit: 0 };
  let value = 0;
  for (let index = 0; index < count; index++) {
    value = (value + readRice(bytes, cursor, remainderBits)) >>> 0;
    result[index] = value;
  }
  return result;
}

function decodeCheckIds(bytes, offsets, widths) {
  const result = new Uint32Array(offsets[offsets.length - 1]);
  const cursor = { bit: 0 };
  for (let check = 0; check + 1 < offsets.length; check++) {
    let value = 0;
    const width = packedValue(widths, check, 5);
    for (let index = offsets[check]; index < offsets[check + 1]; index++) {
      value = (value + readRice(bytes, cursor, width)) >>> 0;
      result[index] = value;
    }
  }
  return result;
}

function decodeMoves(bytes, count) {
  const result = new Uint8Array(count);
  for (let index = 0; index < count; index++) result[index] = packedValue(bytes, index, 5);
  return result;
}

const PLAYBOOK_SCHEMA = 4;
)JS"
    << "const ENEMY = " << std::quoted(enemy) << ";\n"
    << R"JS(
const BOARD_SIZE = 5;
const PHASES = 150000;
const MISS = -1;
)JS"
    << "const MODEL_RUNTIME_TICKS = " << model[0] << ";\n"
    << "const MODEL_AI_SEED_SLIP = " << model[1] << ";\n"
    << "const MODEL_PLAYTIME_EPOCH = " << model[2] << ";\n"
    << "const MODEL_ALIGNMENT_BOARDS = " << model[3] << ";\n"
    << "const MODEL_MAX_ROUNDS = " << model[4] << ";\n"
    << "const HASH_SEED = " << dispatch.hash_seed << ";\n"
    << "const ROUTE_RUNS = " << route_run_ends.size() << ";\n"
    << "const DIRECT_PROGRAMS = " << direct_phases.size() << ";\n"
    << "const CHECK_PROGRAMS = " << dispatch.checks.size() << ";\n"
    << "const CHECK_COUNT_BITS = " << std::bit_width(dispatch.max_check_states) << ";\n"
    << "const UNIQUE_HASHES = " << unique_hashes.size() << ";\n"
    << "const GLOBAL_HASH_RICE_BITS = " << global_hash_rice_width << ";\n"
    << "const MAX_CHECK_STATES = " << dispatch.max_check_states << ";\n"
    << "const MAX_CHECK_PROBES = " << dispatch.max_check_probes << ";\n\n"
    << "const routeRunEnds = decodeBytes(\n";
  write_base64_expression(output, packed_values(route_run_ends, 18));
  output << ");\nconst routeRunTargets = decodeBytes(\n";
  write_base64_expression(output, packed_values(route_run_targets, 18));
  output << ");\nconst directPhases = decodeBytes(\n";
  write_base64_expression(output, packed_values(direct_phases, 18));
  output << ");\nconst directActions = decodeBytes(\n";
  write_base64_expression(output, packed_values(direct_actions, 5));
  output << ");\nconst checkPhaseBits = decodeBytes(\n";
  write_base64_expression(output, check_phase_bits);
  output << ");\nconst checkCounts = decodeBytes(\n";
  write_base64_expression(output,
    packed_values(check_counts, std::bit_width(dispatch.max_check_states)));
  output << ");\nconst globalHashRice = decodeBytes(\n";
  write_base64_expression(output, global_hash_rice.bytes());
  output << ");\nconst checkRiceWidths = decodeBytes(\n";
  write_base64_expression(output, packed_values(check_rice_widths, 5));
  output << ");\nconst checkIdRice = decodeBytes(\n";
  write_base64_expression(output, check_id_rice.bytes());
  output << ");\nconst checkMoveCodes = decodeBytes(\n";
  write_base64_expression(output, check_move_codes);
  output << R"JS();

const checkPrograms = decodeCheckPrograms(checkPhaseBits);
const checkOffsets = decodeCheckOffsets(checkCounts, CHECK_PROGRAMS);
const globalHashLows = decodeRiceDeltas(globalHashRice, UNIQUE_HASHES, GLOBAL_HASH_RICE_BITS);
const checkIds = decodeCheckIds(checkIdRice, checkOffsets, checkRiceWidths);
const checkMoves = decodeMoves(checkMoveCodes, checkIds.length);

function normalizePhase(phase) {
  return ((phase % PHASES) + PHASES) % PHASES;
}

function phaseNow(milliseconds) {
  return Math.floor((((milliseconds % 30000000) + 30000000) % 30000000) / 200);
}

function rootEntryPhase(phase) {
  phase = normalizePhase(phase);
  let low = 0;
  let high = ROUTE_RUNS - 1;
  while (low <= high) {
    const middle = (low + high) >>> 1;
    if (phase >= packedValue(routeRunEnds, middle, 18)) low = middle + 1;
    else high = middle - 1;
  }
  return low < ROUTE_RUNS
    ? packedValue(routeRunTargets, low, 18)
    : MISS;
}

function rootWaits(phase) {
  phase = normalizePhase(phase);
  return (rootEntryPhase(phase) - phase + PHASES) % PHASES;
}

function skipPhase(phase) {
  phase = normalizePhase(phase);
  return rootEntryPhase(phase) === phase ? 0 : 1;
}

function avalanche(value) {
  value ^= value >>> 15;
  value = Math.imul(value, 0x85ebca77) >>> 0;
  value ^= value >>> 13;
  value = Math.imul(value, 0xc2b2ae3d) >>> 0;
  return (value ^ (value >>> 16)) >>> 0;
}

function historyHashes(history) {
  let first = (0x165667b1 + history.length * 8) >>> 0;
  let second = (first ^ 0x7f4a7c15) >>> 0;
  for (const board of history) {
    const words = [
      Number(board & 0xffffffffn) >>> 0,
      Number((board >> 32n) & 0xffffffffn) >>> 0,
    ];
    for (const word of words) {
      first = (first + Math.imul(word, 0xc2b2ae3d)) >>> 0;
      first = Math.imul(((first << 17) | (first >>> 15)) >>> 0, 0x27d4eb2f) >>> 0;
      second = (second + Math.imul(word, 0xc2b2ae3d)) >>> 0;
      second = Math.imul(((second << 17) | (second >>> 15)) >>> 0, 0x27d4eb2f) >>> 0;
    }
  }
  return [avalanche(first), avalanche(second)];
}

function historyHash(history) {
  return historyHashes(history)[0];
}

function stateHash(board, passes, credit, history) {
  const histories = historyHashes(history);
  const words = [
    histories[0],
    histories[1],
    Number(board & 0xffffffffn) >>> 0,
    Number((board >> 32n) & 0xffffffffn) >>> 0,
    (passes | (credit << 8)) >>> 0,
  ];
  let hash = (HASH_SEED ^ 0x9e3779b1) >>> 0;
  for (const word of words) {
    hash = (hash + Math.imul(word, 0xc2b2ae3d)) >>> 0;
    hash = Math.imul(((hash << 17) | (hash >>> 15)) >>> 0, 0x27d4eb2f) >>> 0;
  }
  return avalanche(hash);
}

function binarySearchPacked(array, count, width, wanted) {
  let low = 0;
  let high = count - 1;
  while (low <= high) {
    const middle = (low + high) >>> 1;
    const value = packedValue(array, middle, width);
    if (value < wanted) low = middle + 1;
    else if (value > wanted) high = middle - 1;
    else return middle;
  }
  return MISS;
}

function binarySearchU32(array, low, high, wanted) {
  while (low <= high) {
    const middle = (low + high) >>> 1;
    const value = array[middle];
    if (value < wanted) low = middle + 1;
    else if (value > wanted) high = middle - 1;
    else return middle;
  }
  return MISS;
}

function binarySearchHash(hash) {
  let low = 0;
  let high = UNIQUE_HASHES - 1;
  while (low <= high) {
    const middle = (low + high) >>> 1;
    const candidate = globalHashLows[middle];
    if (candidate < hash) low = middle + 1;
    else if (candidate > hash) high = middle - 1;
    else return middle;
  }
  return MISS;
}

// Certified states are matched by one 32-bit seeded state hash (board, passes,
// alignment credit, and both independent history hashes folded in). The
// offline compiler proves this hash is collision-free across every packed
// entry of a phase, so on-certificate lookups are exact. A state outside the
// certificate can still collide with roughly 2^-32 probability per packed
// entry of the phase; the driver's occupancy/legality checks and the next
// turn's lookup miss bound that residual risk to one forfeited game.
function lookupHashed(phase, hash) {
  phase = normalizePhase(phase);
  const check = checkPrograms[phase];
  if (check === MISS) {
    const direct = binarySearchPacked(directPhases, DIRECT_PROGRAMS, 18, phase);
    return direct === MISS ? MISS : packedValue(directActions, direct, 5);
  }

  const hashId = binarySearchHash(hash >>> 0);
  if (hashId === MISS) return MISS;
  const low = checkOffsets[check];
  const high = checkOffsets[check + 1] - 1;
  if (high < low || high - low + 1 > MAX_CHECK_STATES) return MISS;
  const entry = binarySearchU32(checkIds, low, high, hashId);
  return entry === MISS ? MISS : checkMoves[entry];
}

function lookupMove(phase, board, passes = 0, credit = 0, history = []) {
  try {
    if (!Number.isInteger(phase)
        || typeof board !== "bigint"
        || !Number.isInteger(passes) || passes < 0 || passes > 2
        || !Number.isInteger(credit) || credit < 0 || credit > 15
        || !Array.isArray(history)) return MISS;
    return lookupHashed(phase, stateHash(board, passes, credit, history));
  } catch (error) {
    return MISS;
  }
}

function describeMove(move) {
  if (move < 0) return { kind: "miss" };
  if (move < 25) return { kind: "move", x: Math.floor(move / 5), y: move % 5 };
  if (move === 25) return { kind: "pass" };
  if (move === 26) return { kind: "align" };
  return { kind: "sleep", variant: move - 26 };
}

async function dodgeEnemy(ns, reason, fallback = "Slum Snakes") {
  const message = `IPVGO PLAYBOOK MISS: ${reason}`;
  try { ns.print(message); ns.tprint(message); } catch (error) {}
  try {
    await ns.go.resetBoardState(fallback, 5);
    return true;
  } catch (error) {
    try { ns.tprint(`${message}; recovery failed: ${String(error)}`); } catch (ignored) {}
    return false;
  }
}

async function nextMoveOrDodge(ns, state, fallback) {
  let move = MISS;
  let phase = "invalid";
  try {
    phase = state.phase;
    move = lookupMove(state.phase, state.board, state.passes, state.credit, state.history);
  } catch (error) {}
  if (move !== MISS) return move;
  await dodgeEnemy(ns, `phase=${String(phase)}`, fallback);
  return MISS;
}

export {
  PLAYBOOK_SCHEMA,
  ENEMY,
  BOARD_SIZE,
  PHASES,
  MISS,
  CHECK_PROGRAMS,
  MAX_CHECK_STATES,
  MAX_CHECK_PROBES,
  MODEL_RUNTIME_TICKS,
  MODEL_AI_SEED_SLIP,
  MODEL_PLAYTIME_EPOCH,
  MODEL_ALIGNMENT_BOARDS,
  MODEL_MAX_ROUNDS,
  phaseNow,
  skipPhase,
  rootEntryPhase,
  rootWaits,
  historyHash,
  historyHashes,
  stateHash,
  lookupHashed,
  lookupMove,
  describeMove,
  dodgeEnemy,
  nextMoveOrDodge,
};

export async function main(ns) {
  try {
    const phase = phaseNow(ns.getPlayer().totalPlaytime);
    const hashProgram = checkPrograms[phase];
    const directProgram = binarySearchPacked(directPhases, DIRECT_PROGRAMS, 18, phase);
    ns.tprint(JSON.stringify({
      schema: PLAYBOOK_SCHEMA,
      phase,
      entryPhase: rootEntryPhase(phase),
      waits: rootWaits(phase),
      skip: Boolean(skipPhase(phase)),
      program: hashProgram !== MISS ? "CHECK" : directProgram !== MISS ? "DIRECT" : "MISS",
      move: hashProgram !== MISS
        ? "CHECK"
        : directProgram !== MISS ? describeMove(packedValue(directActions, directProgram, 5)) : "MISS",
      maxCheckStates: MAX_CHECK_STATES,
      maxCheckProbes: MAX_CHECK_PROBES,
    }));
  } catch (error) {
    await dodgeEnemy(ns, `driver exception: ${String(error)}`);
  }
}
)JS";
  output.flush();
  if (!output) throw std::runtime_error("failed writing " + temporary.string());
  output.close();
  std::filesystem::rename(temporary, path);
}

void usage() {
  std::cout
    << "ipvgo_seeded_pack [options]\n\n"
    << "Merges replay-validated per-phase policies by exact board/history/phase/pass/credit.\n"
    << "Search graphs remain separate and are never read or modified.\n\n"
    << "  --input-dir PATH       batch artifact root\n"
    << "  --binary PATH          compact runtime graph output\n"
    << "  --typescript PATH      self-contained TypeScript/base64 output\n"
    << "  --javascript PATH      simple phase/board next-action table\n"
    << "  --phase-javascript PATH phase-first direct/CHECK JavaScript table\n"
    << "  --collision-report PATH phase/action ambiguity and hash audit TSV\n"
    << "  --root-routes PATH     all-phase ENTER/DODGE power-per-turn audit TSV\n"
    << "  --quality PATH         exact terminal power/round profiles\n"
    << "  --enemy NAME           opponent label embedded in standalone output\n"
    << "  --komi VALUE           override the komi derived from --enemy\n"
    << "  --no-next-board-fill   leave phases without a proved policy unavailable\n";
}

}  // namespace

int main(int argc, char** argv) try {
  const Arguments args = parse_arguments(argc, argv);
  if (flag(args, "--help")) {
    usage();
    return 0;
  }
  const std::filesystem::path input_root = value(args, "--input-dir",
    "ipvgobruteforce/data/seeded-phases/netburners-5x5-h40-v4");
  const std::filesystem::path binary_path = value(args, "--binary",
    (input_root / "merged" / "playbook.bin").string());
  const std::filesystem::path typescript_path = value(args, "--typescript",
    (input_root / "merged" / "playbook.generated.ts").string());
  const std::filesystem::path javascript_path = value(args, "--javascript",
    (input_root / "merged" / "playbook.js").string());
  const std::filesystem::path phase_javascript_path = value(args, "--phase-javascript",
    (input_root / "merged" / "playbook.phase.js").string());
  const std::filesystem::path collision_report_path = value(args, "--collision-report",
    (input_root / "merged" / "phase-collisions.tsv").string());
  const std::filesystem::path root_routes_path = value(args, "--root-routes",
    (input_root / "merged" / "root-routes.tsv").string());
  const std::filesystem::path quality_path = value(args, "--quality",
    (input_root / "merged" / "policy-quality.tsv").string());
  const std::string neural_matches_path = value(args, "--neural-matches", "");
  const std::string enemy = value(args, "--enemy", "Netburners");
  const std::string komi_text = value(args, "--komi", "");
  const double komi = !komi_text.empty() ? std::stod(komi_text)
    : enemy == "Netburners" ? 1.5
    : enemy == "Slum Snakes" || enemy == "The Black Hand" ? 3.5
    : enemy == "Tetrads" || enemy == "Daedalus" ? 5.5
    : enemy == "Illuminati" ? 7.5
    : throw std::invalid_argument("unknown --enemy " + enemy + "; pass --komi explicitly");
  const bool fill_next_board = !flag(args, "--no-next-board-fill");
  const std::filesystem::path policy_directory = input_root / "policies";
  if (!std::filesystem::exists(policy_directory)) {
    throw std::runtime_error("policy directory does not exist: " + policy_directory.string());
  }

  std::vector<std::pair<std::uint32_t, std::filesystem::path>> files;
  for (const auto& entry : std::filesystem::directory_iterator(policy_directory)) {
    if (!entry.is_regular_file() || entry.path().extension() != ".tsv") continue;
    const std::string stem = entry.path().stem().string();
    const std::size_t variant = stem.find("-h");
    const std::string phase_text = stem.substr(0, variant);
    if (phase_text.empty() || !std::all_of(phase_text.begin(), phase_text.end(),
      [](unsigned char value) { return std::isdigit(value) != 0; })) continue;
    if (variant != std::string::npos) {
      const std::string handicap = stem.substr(variant + 2U);
      if (handicap.empty() || !std::all_of(handicap.begin(), handicap.end(),
        [](unsigned char value) { return std::isdigit(value) != 0; })) continue;
    }
    const std::uint32_t phase = static_cast<std::uint32_t>(std::stoul(phase_text));
    if (phase >= seeded_phase_count) throw std::runtime_error("policy phase out of range");
    files.emplace_back(phase, entry.path());
  }
  std::sort(files.begin(), files.end());
  if (files.empty()) throw std::runtime_error("no phase policies found");

  std::array<std::uint32_t, seeded_phase_count> roots;
  roots.fill(fill_next_board ? next_board_root : missing_root);
  std::unordered_map<ExactKey, std::uint32_t, ExactKeyHash> index;
  HistoryInterner histories;
  std::vector<SharedNode> nodes;
  std::uint64_t exact_duplicates = 0;
  std::uint64_t alternate_winning_actions = 0;
  std::optional<std::array<std::uint32_t, 5>> model;
  std::vector<PolicyQuality> qualities;
  qualities.reserve(files.size());

  for (const auto& [phase, path] : files) {
    ParsedPolicy policy = read_policy(path);
    if (policy.phase != phase) throw std::runtime_error("policy filename/header phase mismatch");
    const std::array current_model{policy.runtime_ticks, policy.ai_seed_slip,
      policy.playtime_epoch, policy.alignment_boards, policy.max_rounds};
    if (!model) model = current_model;
    else if (*model != current_model) throw std::runtime_error("mixed policy models in input folder");
    qualities.push_back(policy_quality(policy, komi));

    std::unordered_map<std::uint32_t, std::uint32_t> local_to_global;
    local_to_global.reserve(policy.states.size());
    for (ParsedState& state : policy.states) {
      state.key.history_id = histories.intern(state.history);
      const auto found = index.find(state.key);
      std::uint32_t id = 0;
      if (found != index.end()) {
        id = found->second;
        if (nodes.at(id).history_hash != state.history_hash
            || nodes.at(id).history_hash2 != state.history_hash2) {
          throw std::runtime_error("identical interned history produced inconsistent hash");
        }
        ++exact_duplicates;
      } else {
        id = static_cast<std::uint32_t>(nodes.size());
        SharedNode node{.board = state.key.board, .phase = state.key.phase,
          .passes = state.key.passes, .alignment_credit = state.key.alignment_credit,
          .history_id = state.key.history_id,
          .history_hash = state.history_hash,
          .history_hash2 = state.history_hash2};
        nodes.push_back(std::move(node));
        index.emplace(std::move(state.key), id);
      }
      state.history.clear();
      state.history.shrink_to_fit();
      if (!local_to_global.emplace(state.local_id, id).second) {
        throw std::runtime_error("duplicate local state ID in " + path.string());
      }
    }
    const auto root = local_to_global.find(0);
    if (root == local_to_global.end()) throw std::runtime_error("policy lacks root state 0");
    roots[phase] = root->second;

    for (const ParsedState& state : policy.states) {
      const std::uint32_t id = local_to_global.at(state.local_id);
      std::vector<std::uint32_t> successors;
      successors.reserve(state.successors.size());
      for (const std::uint32_t local : state.successors) {
        const auto found = local_to_global.find(local);
        if (found == local_to_global.end()) throw std::runtime_error("missing local successor");
        successors.push_back(found->second);
      }
      std::sort(successors.begin(), successors.end());
      successors.erase(std::unique(successors.begin(), successors.end()), successors.end());
      SharedNode& node = nodes[id];
      if (!node.initialized) {
        node.action = state.action;
        node.successors = std::move(successors);
        node.initialized = true;
      } else if (node.action == state.action) {
        if (node.successors != successors) {
          throw std::runtime_error("identical exact state/action has different outcomes");
        }
      } else {
        // Both source certificates were independently replay-validated. Keep
        // the first deterministic phase-order policy and its complete edge set.
        ++alternate_winning_actions;
      }
    }
  }

  std::uint64_t edge_count_64 = 0;
  for (const SharedNode& node : nodes) {
    if (!node.initialized) throw std::runtime_error("uninitialized shared node");
    if (node.successors.size() > std::numeric_limits<std::uint16_t>::max()) {
      throw std::runtime_error("shared node has too many outcomes");
    }
    edge_count_64 += node.successors.size();
    using RuntimeIdentity = std::tuple<PackedBoard, std::uint32_t, std::uint8_t, std::uint8_t>;
    std::vector<RuntimeIdentity> observations;
    observations.reserve(node.successors.size());
    for (const std::uint32_t successor : node.successors) {
      const SharedNode& child = nodes.at(successor);
      const RuntimeIdentity identity{child.board, child.phase, child.passes,
        child.alignment_credit};
      if (std::find(observations.begin(), observations.end(), identity) != observations.end()) {
        throw std::runtime_error(
          "runtime-visible successor identity cannot distinguish exact histories");
      }
      observations.push_back(identity);
    }
  }
  if (nodes.size() >= next_board_root || edge_count_64 > std::numeric_limits<std::uint32_t>::max()) {
    throw std::runtime_error("playbook exceeds 32-bit runtime index capacity");
  }
  std::uint64_t neural_matches = 0;
  if (!neural_matches_path.empty()) {
    const auto matches = read_neural_matches(neural_matches_path);
    for (SharedNode& node : nodes) {
      const std::uint8_t operation = node.action & 31U;
      if (operation == action_terminal || operation == action_align) continue;
      const NeuralMatchKey key{node.board, node.phase, node.history_hash, node.history_hash2,
        node.passes, node.alignment_credit};
      const auto found = matches.find(key);
      if (found != matches.end() && found->second == operation) {
        node.emit_override = false;
        ++neural_matches;
      }
    }
  }
  const std::uint32_t edge_count = static_cast<std::uint32_t>(edge_count_64);

  Bytes bytes;
  bytes.text("IPVGPLY1");
  bytes.u32(1);
  bytes.u32(seeded_phase_count);
  bytes.u32(static_cast<std::uint32_t>(nodes.size()));
  bytes.u32(edge_count);
  bytes.u32(fill_next_board ? 1U : 0U);
  for (const std::uint32_t root : roots) bytes.u32(root);
  std::uint32_t edge_offset = 0;
  for (const SharedNode& node : nodes) {
    bytes.u64(node.board);
    bytes.u32(node.phase);
    bytes.u32(edge_offset);
    bytes.u16(static_cast<std::uint16_t>(node.successors.size()));
    bytes.byte(node.action);
    bytes.byte(static_cast<std::uint8_t>(node.passes | (node.alignment_credit << 2U)));
    edge_offset += static_cast<std::uint32_t>(node.successors.size());
  }
  for (const SharedNode& node : nodes) {
    for (const std::uint32_t successor : node.successors) bytes.u32(successor);
  }

  std::map<std::uint32_t, PolicyQuality> merged_qualities;
  for (const PolicyQuality& quality : qualities) {
    PolicyQuality& merged = merged_qualities[quality.phase];
    merged.phase = quality.phase;
    for (const auto& [power, round] : quality.worst_round_by_power) {
      auto [entry, inserted] = merged.worst_round_by_power.emplace(power, round);
      if (!inserted) entry->second = std::max(entry->second, round);
    }
    merged.route_power_sum += quality.route_power_sum;
    merged.route_turn_sum += quality.route_turn_sum;
    merged.route_count += quality.route_count;
  }
  qualities.clear();
  qualities.reserve(merged_qualities.size());
  for (auto& [phase, quality] : merged_qualities) {
    static_cast<void>(phase);
    quality.worst_power_per_round = std::numeric_limits<double>::infinity();
    for (const auto& [power, round] : quality.worst_round_by_power) {
      quality.worst_power_per_round = std::min(quality.worst_power_per_round,
        static_cast<double>(power) / std::max(1U, round));
    }
    qualities.push_back(std::move(quality));
  }

  atomic_binary_write(binary_path, bytes.data());
  atomic_quality_write(quality_path, qualities);
  const SimpleTable simple = make_simple_table(nodes, roots);
  atomic_simple_js_write(javascript_path, simple);
  const RootRoutes root_routes = optimize_root_routes(qualities);
  const PhaseDispatch phase_dispatch = make_phase_dispatch(nodes, root_routes);
  atomic_phase_js_write(phase_javascript_path, phase_dispatch, *model, enemy);
  atomic_collision_report_write(collision_report_path, phase_dispatch);
  atomic_root_routes_write(root_routes_path, root_routes);
  const std::string encoded = base64(bytes.data());
  atomic_typescript_write(typescript_path, encoded, static_cast<std::uint32_t>(files.size()),
    static_cast<std::uint32_t>(nodes.size()), edge_count);
  std::cout << "packed policies=" << files.size() << " source_states="
    << nodes.size() + exact_duplicates << " shared_states=" << nodes.size()
    << " exact_duplicates=" << exact_duplicates
    << " neural_matches=" << neural_matches
    << " residual_overrides=" << nodes.size() - neural_matches
    << " history_links=" << histories.size()
    << " alternate_winning_actions=" << alternate_winning_actions
    << " edges=" << edge_count << " binary_bytes=" << bytes.data().size() << '\n'
    << "binary=" << binary_path << '\n'
    << "typescript=" << typescript_path << '\n'
    << "javascript=" << javascript_path << '\n'
    << "phase_javascript=" << phase_javascript_path << '\n'
    << "phase_javascript_bytes=" << std::filesystem::file_size(phase_javascript_path) << '\n'
    << "collision_report=" << collision_report_path << '\n'
    << "root_routes=" << root_routes_path << '\n'
    << "quality=" << quality_path << '\n'
    << "simple_rules=" << simple.rule_words.size() / 2U
    << " history_free_rules=" << simple.history_free_rules
    << " ambiguous_rules=" << simple.ambiguous_rules
    << " visible_collapses=" << simple.exact_states_collapsed
    << " history_variants=" << simple.variant_actions.size() << '\n'
    << "phase_direct=" << phase_dispatch.direct_phases
    << " phase_checks=" << phase_dispatch.checks.size()
    << " checked_states=" << phase_dispatch.check_actions.size()
    << " hash_seed=" << phase_dispatch.hash_seed
    << " program_bits=" << phase_dispatch.program_width
    << " max_check_states=" << phase_dispatch.max_check_states
    << " max_check_probes=" << phase_dispatch.max_check_probes << '\n'
    << "root_enter_phases=" << root_routes.enter_phases
    << " root_dodge_phases=" << seeded_phase_count - root_routes.enter_phases
    << " root_max_wait=" << root_routes.maximum_wait
    << " root_average_wait=" << std::fixed << std::setprecision(3)
    << static_cast<double>(root_routes.total_waits) / seeded_phase_count
    << " global_average_power_per_turn=" << std::setprecision(9)
    << static_cast<double>(root_routes.sum_rates / seeded_phase_count)
    << " global_aggregate_power_per_turn="
    << static_cast<double>(root_routes.sum_worst_power)
      / static_cast<double>(root_routes.sum_worst_turns) << '\n'
    << "missing_phase_entries=" << seeded_phase_count - files.size()
    << " next_board_fill=" << fill_next_board << '\n';
  return 0;
} catch (const std::exception& error) {
  std::cerr << "error: " << error.what() << '\n';
  return 1;
}
