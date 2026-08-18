#include "ipvgobruteforce/policy_routes.hpp"

#include "go/board_generator.hpp"
#include "go/opponent.hpp"
#include "go/rng.hpp"
#include "go/rules.hpp"

#include <algorithm>
#include <array>
#include <cstdint>
#include <filesystem>
#include <fstream>
#include <iomanip>
#include <iostream>
#include <iterator>
#include <limits>
#include <map>
#include <optional>
#include <queue>
#include <set>
#include <stdexcept>
#include <string>
#include <string_view>
#include <tuple>
#include <vector>

namespace {

using namespace bitburner::go;
using namespace ipvgobruteforce;

std::vector<std::string> split(std::string_view value, char delimiter) {
  std::vector<std::string> result;
  std::size_t begin = 0;
  for (;;) {
    const std::size_t end = value.find(delimiter, begin);
    result.emplace_back(value.substr(begin, end == std::string_view::npos
      ? value.size() - begin : end - begin));
    if (end == std::string_view::npos) return result;
    begin = end + 1U;
  }
}

Opponent parse_opponent_cli(std::string_view value) {
  if (value == "netburners" || value == "Netburners") return Opponent::netburners;
  if (value == "slum-snakes" || value == "Slum Snakes") return Opponent::slum_snakes;
  if (value == "black-hand" || value == "The Black Hand") return Opponent::black_hand;
  if (value == "tetrads" || value == "Tetrads") return Opponent::tetrads;
  if (value == "daedalus" || value == "Daedalus") return Opponent::daedalus;
  if (value == "illuminati" || value == "Illuminati") return Opponent::illuminati;
  throw std::invalid_argument("unknown 5x5 opponent " + std::string(value));
}

double komi_for(Opponent opponent) {
  switch (opponent) {
    case Opponent::netburners: return 1.5;
    case Opponent::slum_snakes:
    case Opponent::black_hand: return 3.5;
    case Opponent::tetrads:
    case Opponent::daedalus: return 5.5;
    case Opponent::illuminati: return 7.5;
    case Opponent::world_daemon: break;
  }
  throw std::invalid_argument("World Daemon is not a 5x5 manifest");
}

struct Certificate {
  std::filesystem::path path;
  std::uint32_t phase{};
  std::uint32_t playtime_epoch{};
  std::string start_board;
  std::map<std::uint32_t, std::uint32_t> worst_turn_by_power;
  PowerTurn worst;
  bool power_optimal_within_horizon{};
};

Certificate read_certificate(const std::filesystem::path& path, double komi) {
  std::ifstream input(path);
  if (!input) throw std::runtime_error("cannot read " + path.string());
  Certificate result{.path = path};
  bool saw_phase = false;
  bool saw_epoch = false;
  bool saw_header = false;
  std::string line;
  while (std::getline(input, line)) {
    if (line.starts_with("# start_phase\t")) {
      result.phase = static_cast<std::uint32_t>(std::stoul(line.substr(14)));
      saw_phase = true;
      continue;
    }
    if (line.starts_with("# playtime_epoch\t")) {
      result.playtime_epoch = static_cast<std::uint32_t>(std::stoul(line.substr(17)));
      saw_epoch = true;
      continue;
    }
    if (line == "# objective_scope\tall_legal_actions_within_max_rounds") {
      result.power_optimal_within_horizon = true;
      continue;
    }
    if (line.starts_with('#')) continue;
    const std::vector<std::string> fields = split(line, '\t');
    if (!saw_header) {
      if (fields.empty() || fields.front() != "state_id") {
        throw std::runtime_error("unsupported certificate schema " + path.string());
      }
      saw_header = true;
      continue;
    }
    if (fields.size() < 8) throw std::runtime_error("malformed certificate row " + path.string());
    if (fields[0] == "0") result.start_board = fields[4];
    if (fields[7] != "terminal") continue;
    const std::uint32_t round = static_cast<std::uint32_t>(std::stoul(fields[2]));
    const Score score = score_board(board_from_hash(5, fields[4]), komi);
    if (score.black <= score.white) {
      throw std::runtime_error("certificate contains a non-winning terminal " + path.string());
    }
    const auto power = static_cast<std::uint32_t>(score.black);
    auto [found, inserted] = result.worst_turn_by_power.emplace(power, round);
    if (!inserted) found->second = std::max(found->second, round);
  }
  if (!saw_phase || !saw_epoch || result.start_board.empty()
      || result.worst_turn_by_power.empty()) {
    throw std::runtime_error("incomplete certificate " + path.string());
  }
  std::optional<PowerTurn> worst;
  for (const auto& [power, turns] : result.worst_turn_by_power) {
    const PowerTurn candidate{power, std::max(1U, turns)};
    if (!worst || better_power_turn(*worst, candidate)) worst = candidate;
  }
  result.worst = *worst;
  return result;
}

bool better_certificate(const Certificate& left, const Certificate& right) {
  if (left.power_optimal_within_horizon != right.power_optimal_within_horizon) {
    return left.power_optimal_within_horizon;
  }
  if (better_power_turn(left.worst, right.worst)) return true;
  if (better_power_turn(right.worst, left.worst)) return false;
  return std::tie(left.start_board, left.path) < std::tie(right.start_board, right.path);
}

bool supported_start(const Certificate& certificate, Opponent opponent) {
  const double seed = static_cast<double>(certificate.playtime_epoch) * go_whrng_period_ms
    + static_cast<double>(certificate.phase) * 200.0;
  if (opponent != Opponent::illuminati) {
    return board_hash(initial_board(5, opponent, seed, 0)) == certificate.start_board;
  }
  // starting_board_variants includes the no-stone outcome whenever upstream
  // applyHandicap can place nothing, keeping "fully certified" honest.
  const StartingBoardFamily family = starting_board_family(5, opponent, seed);
  for (const StartingBoardVariant& variant : starting_board_variants(family)) {
    if (board_hash(variant.board) == certificate.start_board) return true;
  }
  return false;
}

std::vector<std::string> illuminati_start_boards(std::uint32_t phase,
  std::uint32_t playtime_epoch) {
  const StartingBoardFamily family = starting_board_family(
    5, Opponent::illuminati, static_cast<double>(playtime_epoch) * go_whrng_period_ms
      + static_cast<double>(phase) * 200.0);
  std::vector<std::string> supported;
  for (const StartingBoardVariant& variant : starting_board_variants(family)) {
    supported.push_back(board_hash(variant.board));
  }
  std::sort(supported.begin(), supported.end());
  supported.erase(std::unique(supported.begin(), supported.end()), supported.end());
  return supported;
}

std::string outcomes(const Certificate& certificate) {
  std::string result;
  for (const auto& [power, turns] : certificate.worst_turn_by_power) {
    if (!result.empty()) result += ',';
    result += std::to_string(power) + ':' + std::to_string(turns);
  }
  return result;
}

double median(std::vector<double> values) {
  if (values.empty()) return 0.0;
  const std::size_t middle = values.size() / 2U;
  std::nth_element(values.begin(), values.begin() + static_cast<std::ptrdiff_t>(middle),
    values.end());
  const double upper = values[middle];
  if (values.size() % 2U != 0) return upper;
  const double lower = *std::max_element(values.begin(),
    values.begin() + static_cast<std::ptrdiff_t>(middle));
  return (lower + upper) / 2.0;
}

void atomic_replace(const std::filesystem::path& temporary,
  const std::filesystem::path& target) {
  std::filesystem::rename(temporary, target);
}

}  // namespace

int main(int argc, char** argv) try {
  if (argc < 3 || argc > 4) {
    std::cerr << "usage: ipvgo_playbook_manifest OPPONENT INPUT_DIR [OUTPUT_DIR]\n";
    return 2;
  }
  const Opponent opponent = parse_opponent_cli(argv[1]);
  const double komi = komi_for(opponent);
  const std::filesystem::path input_root = argv[2];
  const std::filesystem::path output_root = argc == 4
    ? std::filesystem::path(argv[3]) : input_root / "generated";
  std::filesystem::create_directories(output_root);

  std::vector<std::filesystem::path> files;
  const std::filesystem::path policies = input_root / "policies";
  if (std::filesystem::exists(policies)) {
    for (const auto& entry : std::filesystem::directory_iterator(policies)) {
      if (entry.is_regular_file() && entry.path().extension() == ".tsv") {
        files.push_back(entry.path());
      }
    }
  }
  std::sort(files.begin(), files.end());
  if (files.empty()) throw std::runtime_error("no certificates in " + policies.string());

  std::vector<Certificate> certificates;
  certificates.reserve(files.size());
  for (const auto& file : files) {
    Certificate certificate = read_certificate(file, komi);
    if (!supported_start(certificate, opponent)) {
      throw std::runtime_error("certificate start board is not in the opponent/phase support: "
        + file.string());
    }
    certificates.push_back(std::move(certificate));
  }
  const std::uint32_t playtime_epoch = certificates.front().playtime_epoch;
  if (std::any_of(certificates.begin(), certificates.end(), [&](const Certificate& certificate) {
    return certificate.playtime_epoch != playtime_epoch;
  })) {
    throw std::runtime_error("manifest input mixes Player.totalPlaytime epochs");
  }
  std::array<std::optional<std::size_t>, seeded_phase_count> best_by_phase{};
  std::set<std::pair<std::uint32_t, std::string>> certified_starts;
  std::map<std::pair<std::uint32_t, std::string>, std::size_t> best_by_start;
  for (std::size_t index = 0; index < certificates.size(); ++index) {
    const std::uint32_t phase = certificates[index].phase;
    const auto start_key = std::pair{phase, certificates[index].start_board};
    certified_starts.emplace(start_key);
    const auto found = best_by_start.find(start_key);
    if (found == best_by_start.end()
        || better_certificate(certificates[index], certificates[found->second])) {
      best_by_start[start_key] = index;
    }
    if (!best_by_phase[phase]
        || better_certificate(certificates[index], certificates[*best_by_phase[phase]])) {
      best_by_phase[phase] = index;
    }
  }

  std::uint64_t expected_start_roots = seeded_phase_count;
  std::uint64_t fully_certified_phases = certified_starts.size();
  std::uint64_t partial_certified_phases = 0;
  std::vector<PolicyProfile> guaranteed_profiles;
  if (opponent == Opponent::illuminati) {
    expected_start_roots = 0;
    fully_certified_phases = 0;
    for (std::uint32_t phase = 0; phase < seeded_phase_count; ++phase) {
      const std::vector<std::string> supported = illuminati_start_boards(
        phase, playtime_epoch);
      expected_start_roots += supported.size();
      const std::size_t covered = static_cast<std::size_t>(std::count_if(
        supported.begin(), supported.end(), [&](const std::string& board) {
          return certified_starts.contains({phase, board});
        }));
      fully_certified_phases += covered == supported.size();
      partial_certified_phases += covered > 0 && covered < supported.size();
      if (covered == supported.size()) {
        std::map<std::uint32_t, std::uint32_t> worst_turn_by_power;
        for (const std::string& board : supported) {
          const Certificate& certificate = certificates.at(
            best_by_start.at({phase, board}));
          for (const auto& [power, turns] : certificate.worst_turn_by_power) {
            auto [found, inserted] = worst_turn_by_power.emplace(power, turns);
            if (!inserted) found->second = std::max(found->second, turns);
          }
        }
        PolicyProfile profile{.phase = phase};
        for (const auto& [power, turns] : worst_turn_by_power) {
          profile.outcomes.push_back({power, turns});
        }
        guaranteed_profiles.push_back(std::move(profile));
      }
    }
  }
  std::uint64_t power_optimal_roots = 0;
  std::uint64_t fully_power_optimal_phases = 0;
  for (const auto& [start, index] : best_by_start) {
    static_cast<void>(start);
    power_optimal_roots += certificates[index].power_optimal_within_horizon;
  }
  if (opponent == Opponent::illuminati) {
    for (std::uint32_t phase = 0; phase < seeded_phase_count; ++phase) {
      const std::vector<std::string> supported = illuminati_start_boards(
        phase, playtime_epoch);
      fully_power_optimal_phases += std::all_of(
        supported.begin(), supported.end(), [&](const std::string& board) {
          const auto found = best_by_start.find({phase, board});
          return found != best_by_start.end()
            && certificates[found->second].power_optimal_within_horizon;
        });
    }
  } else {
    fully_power_optimal_phases = power_optimal_roots;
  }

  const std::filesystem::path index_path = output_root / "policy-index.tsv";
  const std::filesystem::path index_tmp = index_path.string() + ".tmp";
  std::ofstream index_output(index_tmp, std::ios::trunc);
  index_output << "opponent\tphase\tstart_board\tpolicy\tworst_power\tworst_turns"
    << "\tpower_per_turn\toutcomes_power:max_turn\n";
  for (const Certificate& certificate : certificates) {
    index_output << opponent_name(opponent) << '\t' << certificate.phase << '\t'
      << certificate.start_board << '\t' << certificate.path.filename().string() << '\t'
      << certificate.worst.power << '\t' << certificate.worst.turns << '\t'
      << std::fixed << std::setprecision(9) << power_per_turn(certificate.worst) << '\t'
      << outcomes(certificate) << '\n';
  }
  index_output.close();
  atomic_replace(index_tmp, index_path);

  std::vector<PolicyProfile> profiles;
  std::vector<double> selected_local_rates;
  const std::filesystem::path quality_path = output_root / "policy-quality.tsv";
  const std::filesystem::path quality_tmp = quality_path.string() + ".tmp";
  std::ofstream quality_output(quality_tmp, std::ios::trunc);
  quality_output << "phase\tworst_power_per_round\tworst_power_per_second"
    << "\toutcomes_power:max_round\n";
  for (std::uint32_t phase = 0; phase < seeded_phase_count; ++phase) {
    if (!best_by_phase[phase]) continue;
    const Certificate& certificate = certificates[*best_by_phase[phase]];
    PolicyProfile profile{.phase = phase};
    for (const auto& [power, turns] : certificate.worst_turn_by_power) {
      profile.outcomes.push_back({power, turns});
    }
    profiles.push_back(std::move(profile));
    const double rate = power_per_turn(certificate.worst);
    selected_local_rates.push_back(rate);
    // The per-second column is an upper bound: it assumes every round
    // completes in one 200 ms engine tick, while the adversarial timing model
    // allows two ticks per round (x2.5 lower bound).
    quality_output << phase << '\t' << std::fixed << std::setprecision(9) << rate
      << '\t' << rate * 5.0 << '\t' << outcomes(certificate) << '\n';
  }
  quality_output.close();
  atomic_replace(quality_tmp, quality_path);

  struct ConditionalBoardRoute {
    std::uint32_t reset_phase{};
    std::string board;
    RouteProfileChoice choice;
  };
  std::vector<PolicyProfile> conditional_profiles;
  std::vector<ConditionalBoardRoute> conditional_board_routes;
  if (opponent == Opponent::illuminati) {
    std::map<std::string, std::vector<PolicyProfile>> profiles_by_board;
    for (const auto& [start, index] : best_by_start) {
      const Certificate& certificate = certificates.at(index);
      PolicyProfile profile{.phase = start.first};
      for (const auto& [power, turns] : certificate.worst_turn_by_power) {
        profile.outcomes.push_back({power, turns});
      }
      profiles_by_board[start.second].push_back(std::move(profile));
    }
    std::map<std::string, PolicyRouteOracle> oracles;
    for (auto& [board, board_profiles] : profiles_by_board) {
      oracles.emplace(board, PolicyRouteOracle(std::move(board_profiles)));
    }
    for (std::uint32_t phase = 0; phase < seeded_phase_count; ++phase) {
      PolicyProfile combined{.phase = phase};
      std::vector<ConditionalBoardRoute> phase_routes;
      bool complete = true;
      for (const std::string& board : illuminati_start_boards(phase, playtime_epoch)) {
        const auto found = oracles.find(board);
        if (found == oracles.end()) {
          complete = false;
          break;
        }
        RouteProfileChoice choice = found->second.best_profile(phase, 0, 0);
        combined.outcomes.insert(combined.outcomes.end(),
          choice.outcomes.begin(), choice.outcomes.end());
        phase_routes.push_back({phase, board, std::move(choice)});
      }
      if (complete) {
        conditional_profiles.push_back(std::move(combined));
        conditional_board_routes.insert(conditional_board_routes.end(),
          std::make_move_iterator(phase_routes.begin()),
          std::make_move_iterator(phase_routes.end()));
      }
    }

    const std::filesystem::path board_routes_path = output_root
      / "conditional-board-routes.tsv";
    const std::filesystem::path board_routes_tmp = board_routes_path.string() + ".tmp";
    std::ofstream board_routes_output(board_routes_tmp, std::ios::trunc);
    board_routes_output << "reset_phase\tstart_board\tentry_phase\twaits"
      << "\tworst_power\tworst_turns\tpower_per_turn\n";
    for (const ConditionalBoardRoute& route : conditional_board_routes) {
      board_routes_output << route.reset_phase << '\t' << route.board << '\t'
        << route.choice.route.entry_phase << '\t' << route.choice.route.waits << '\t'
        << route.choice.route.worst.power << '\t' << route.choice.route.worst.turns << '\t'
        << std::fixed << std::setprecision(9)
        << power_per_turn(route.choice.route.worst) << '\n';
    }
    board_routes_output.close();
    atomic_replace(board_routes_tmp, board_routes_path);
  }

  struct Gap {
    std::uint32_t begin{};
    std::uint32_t length{};
  };
  struct GapLess {
    bool operator()(const Gap& left, const Gap& right) const {
      if (left.length != right.length) return left.length < right.length;
      return left.begin > right.begin;
    }
  };
  std::priority_queue<Gap, std::vector<Gap>, GapLess> gaps;
  std::vector<std::uint32_t> certified_phases;
  certified_phases.reserve(profiles.size());
  for (const PolicyProfile& profile : profiles) certified_phases.push_back(profile.phase);
  for (std::size_t index = 0; index < certified_phases.size(); ++index) {
    const std::uint32_t previous = certified_phases[index];
    const std::uint32_t next = certified_phases[(index + 1U) % certified_phases.size()];
    const std::uint32_t distance = next > previous
      ? next - previous : seeded_phase_count - previous + next;
    if (distance > 1U) gaps.push({static_cast<std::uint32_t>(
      (previous + 1U) % seeded_phase_count), distance - 1U});
  }
  const std::filesystem::path priority_path = output_root / "gap-priority.txt";
  const std::filesystem::path priority_tmp = priority_path.string() + ".tmp";
  std::ofstream priority_output(priority_tmp, std::ios::trunc);
  while (!gaps.empty()) {
    const Gap gap = gaps.top();
    gaps.pop();
    const std::uint32_t left_length = gap.length / 2U;
    const std::uint32_t selected = static_cast<std::uint32_t>(
      (static_cast<std::uint64_t>(gap.begin) + left_length) % seeded_phase_count);
    priority_output << selected << '\n';
    if (left_length > 0) gaps.push({gap.begin, left_length});
    const std::uint32_t right_length = gap.length - left_length - 1U;
    if (right_length > 0) gaps.push({static_cast<std::uint32_t>(
      (selected + 1U) % seeded_phase_count), right_length});
  }
  priority_output.close();
  atomic_replace(priority_tmp, priority_path);

  const PolicyRouteOracle oracle(std::move(profiles));
  std::vector<double> root_rates;
  root_rates.reserve(seeded_phase_count);
  std::uint64_t total_power = 0;
  std::uint64_t total_turns = 0;
  std::uint64_t enter = 0;
  std::uint32_t maximum_wait = 0;
  const std::filesystem::path routes_path = output_root / "root-routes.tsv";
  const std::filesystem::path routes_tmp = routes_path.string() + ".tmp";
  std::ofstream routes_output(routes_tmp, std::ios::trunc);
  routes_output << "phase\taction\tentry_phase\twaits\tworst_power\tworst_turns"
    << "\tpower_per_turn\n";
  for (std::uint32_t phase = 0; phase < seeded_phase_count; ++phase) {
    const RouteChoice route = oracle.best(phase, 0, 0);
    const double rate = power_per_turn(route.worst);
    root_rates.push_back(rate);
    total_power += route.worst.power;
    total_turns += route.worst.turns;
    enter += route.waits == 0;
    maximum_wait = std::max(maximum_wait, route.waits);
    routes_output << phase << '\t' << (route.waits == 0 ? "ENTER" : "DODGE") << '\t'
      << route.entry_phase << '\t' << route.waits << '\t' << route.worst.power << '\t'
      << route.worst.turns << '\t' << std::fixed << std::setprecision(9) << rate << '\n';
  }
  routes_output.close();
  atomic_replace(routes_tmp, routes_path);

  std::vector<double> conditional_root_rates;
  const std::size_t conditional_supported_phases = conditional_profiles.size();
  std::uint64_t conditional_total_power = 0;
  std::uint64_t conditional_total_turns = 0;
  std::uint64_t conditional_enter = 0;
  std::uint32_t conditional_maximum_wait = 0;
  if (!conditional_profiles.empty()) {
    const PolicyRouteOracle conditional_oracle(std::move(conditional_profiles));
    conditional_root_rates.reserve(seeded_phase_count);
    const std::filesystem::path conditional_path = output_root
      / "conditional-root-routes.tsv";
    const std::filesystem::path conditional_tmp = conditional_path.string() + ".tmp";
    std::ofstream conditional_output(conditional_tmp, std::ios::trunc);
    conditional_output << "phase\taction\tentry_phase\twaits\tworst_power\tworst_turns"
      << "\tpower_per_turn\n";
    for (std::uint32_t phase = 0; phase < seeded_phase_count; ++phase) {
      const RouteChoice route = conditional_oracle.best(phase, 0, 0);
      const double rate = power_per_turn(route.worst);
      conditional_root_rates.push_back(rate);
      conditional_total_power += route.worst.power;
      conditional_total_turns += route.worst.turns;
      conditional_enter += route.waits == 0;
      conditional_maximum_wait = std::max(conditional_maximum_wait, route.waits);
      conditional_output << phase << '\t' << (route.waits == 0 ? "ENTER" : "DODGE")
        << '\t' << route.entry_phase << '\t' << route.waits << '\t'
        << route.worst.power << '\t' << route.worst.turns << '\t'
        << std::fixed << std::setprecision(9) << rate << '\n';
    }
    conditional_output.close();
    atomic_replace(conditional_tmp, conditional_path);
  }

  std::vector<double> guaranteed_root_rates;
  std::uint64_t guaranteed_total_power = 0;
  std::uint64_t guaranteed_total_turns = 0;
  std::uint64_t guaranteed_enter = 0;
  std::uint32_t guaranteed_maximum_wait = 0;
  if (!guaranteed_profiles.empty()) {
    const PolicyRouteOracle guaranteed_oracle(std::move(guaranteed_profiles));
    guaranteed_root_rates.reserve(seeded_phase_count);
    const std::filesystem::path guaranteed_path = output_root / "guaranteed-root-routes.tsv";
    const std::filesystem::path guaranteed_tmp = guaranteed_path.string() + ".tmp";
    std::ofstream guaranteed_output(guaranteed_tmp, std::ios::trunc);
    guaranteed_output << "phase\taction\tentry_phase\twaits\tworst_power\tworst_turns"
      << "\tpower_per_turn\n";
    for (std::uint32_t phase = 0; phase < seeded_phase_count; ++phase) {
      const RouteChoice route = guaranteed_oracle.best(phase, 0, 0);
      const double rate = power_per_turn(route.worst);
      guaranteed_root_rates.push_back(rate);
      guaranteed_total_power += route.worst.power;
      guaranteed_total_turns += route.worst.turns;
      guaranteed_enter += route.waits == 0;
      guaranteed_maximum_wait = std::max(guaranteed_maximum_wait, route.waits);
      guaranteed_output << phase << '\t' << (route.waits == 0 ? "ENTER" : "DODGE")
        << '\t' << route.entry_phase << '\t' << route.waits << '\t'
        << route.worst.power << '\t' << route.worst.turns << '\t'
        << std::fixed << std::setprecision(9) << rate << '\n';
    }
    guaranteed_output.close();
    atomic_replace(guaranteed_tmp, guaranteed_path);
  }

  double root_sum = 0.0;
  for (const double value : root_rates) root_sum += value;
  double local_sum = 0.0;
  for (const double value : selected_local_rates) local_sum += value;
  double guaranteed_root_sum = 0.0;
  for (const double value : guaranteed_root_rates) guaranteed_root_sum += value;
  double conditional_root_sum = 0.0;
  for (const double value : conditional_root_rates) conditional_root_sum += value;
  const std::filesystem::path summary_path = output_root / "summary.tsv";
  const std::filesystem::path summary_tmp = summary_path.string() + ".tmp";
  std::ofstream summary(summary_tmp, std::ios::trunc);
  summary << "metric\tvalue\n"
    << "opponent\t" << opponent_name(opponent) << '\n'
    << "komi\t" << komi << '\n'
    << "certificates\t" << certificates.size() << '\n'
    << "expected_phase_board_roots\t" << expected_start_roots << '\n'
    << "certified_phase_board_roots\t" << certified_starts.size() << '\n'
    << "power_optimal_phase_board_roots\t" << power_optimal_roots << '\n'
    << "phases_with_certificate\t" << selected_local_rates.size() << '\n'
    << "fully_certified_phases\t" << fully_certified_phases << '\n'
    << "fully_power_optimal_phases\t" << fully_power_optimal_phases << '\n'
    << "partially_certified_phases\t" << partial_certified_phases << '\n'
    << "local_mean_power_per_turn\t" << std::setprecision(12)
      << local_sum / selected_local_rates.size() << '\n'
    << "local_median_power_per_turn\t" << median(selected_local_rates) << '\n'
    << "root_enter_phases\t" << enter << '\n'
    << "root_dodge_phases\t" << seeded_phase_count - enter << '\n'
    << "root_mean_power_per_turn\t" << root_sum / seeded_phase_count << '\n'
    << "root_median_power_per_turn\t" << median(root_rates) << '\n'
    << "root_aggregate_power_per_turn\t"
      << static_cast<double>(total_power) / std::max<std::uint64_t>(1, total_turns) << '\n'
    << "maximum_dodge_waits\t" << maximum_wait << '\n'
    << "guaranteed_finite-support_phases\t" << fully_certified_phases << '\n'
    << "guaranteed_root_enter_phases\t" << guaranteed_enter << '\n'
    << "guaranteed_root_dodge_phases\t"
      << (guaranteed_root_rates.empty() ? 0 : seeded_phase_count - guaranteed_enter) << '\n'
    << "guaranteed_root_mean_power_per_turn\t"
      << (guaranteed_root_rates.empty() ? 0.0
        : guaranteed_root_sum / seeded_phase_count) << '\n'
    << "guaranteed_root_median_power_per_turn\t" << median(guaranteed_root_rates) << '\n'
    << "guaranteed_root_aggregate_power_per_turn\t"
      << static_cast<double>(guaranteed_total_power)
        / std::max<std::uint64_t>(1, guaranteed_total_turns) << '\n'
    << "guaranteed_maximum_dodge_waits\t" << guaranteed_maximum_wait << '\n'
    << "conditional_supported_reset_phases\t"
      << (opponent == Opponent::illuminati ? conditional_supported_phases : 0) << '\n'
    << "conditional_root_mean_power_per_turn\t"
      << (conditional_root_rates.empty() ? 0.0
        : conditional_root_sum / seeded_phase_count) << '\n'
    << "conditional_root_median_power_per_turn\t" << median(conditional_root_rates) << '\n'
    << "conditional_root_aggregate_power_per_turn\t"
      << static_cast<double>(conditional_total_power)
        / std::max<std::uint64_t>(1, conditional_total_turns) << '\n'
    << "conditional_maximum_preboard_dodge_waits\t" << conditional_maximum_wait << '\n'
    << "root_metric_semantics\t"
      << (opponent == Opponent::illuminati
        ? "single-observed-board-certificate; use conditional-root metrics"
        : "deterministic-start-board") << '\n'
    << "illuminati_entry_semantics\t"
      << (opponent == Opponent::illuminati
        ? "preboard-dodge-then-observed-board-alignment; no active-board-dodge"
        : "deterministic-start-board") << '\n';
  summary.close();
  atomic_replace(summary_tmp, summary_path);

  std::cout << "manifest opponent=" << opponent_name(opponent)
    << " certificates=" << certificates.size()
    << " phases=" << selected_local_rates.size()
    << " local_median=" << median(selected_local_rates)
    << " root_mean=" << root_sum / seeded_phase_count
    << " root_median=" << median(root_rates)
    << " max_dodge=" << maximum_wait << '\n';
  return 0;
} catch (const std::exception& error) {
  std::cerr << "error: " << error.what() << '\n';
  return 1;
}
