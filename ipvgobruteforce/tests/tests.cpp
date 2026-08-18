#include "ipvgobruteforce/move_order.hpp"
#include "ipvgobruteforce/packed_board.hpp"
#include "ipvgobruteforce/policy_routes.hpp"
#include "ipvgobruteforce/seeded_search.hpp"
#include "ipvgobruteforce/symmetry.hpp"
#include "ipvgobruteforce/symmetry_rule_cache.hpp"

#include "go/board_generator.hpp"
#include "go/opponent.hpp"
#include "go/rng.hpp"
#include "go/rules.hpp"

#include <algorithm>
#include <array>
#include <atomic>
#include <cstdlib>
#include <filesystem>
#include <fstream>
#include <iostream>
#include <iterator>
#include <optional>
#include <string>
#include <thread>
#include <tuple>
#include <unordered_set>
#include <vector>

namespace {

void require(bool condition, const std::string& message) {
  if (!condition) {
    std::cerr << "FAIL: " << message << '\n';
    std::exit(EXIT_FAILURE);
  }
}

std::vector<unsigned char> file_bytes(const std::filesystem::path& path) {
  std::ifstream input(path, std::ios::binary);
  return {std::istreambuf_iterator<char>(input), std::istreambuf_iterator<char>()};
}

std::uint64_t next_random(std::uint64_t& state) {
  state ^= state >> 12U;
  state ^= state << 25U;
  state ^= state >> 27U;
  return state * 0x2545f4914f6cdd1dULL;
}

std::vector<bitburner::go::Position> reachable_positions(std::size_t count) {
  using namespace bitburner::go;
  std::vector<Position> result;
  std::uint64_t random = 0x72d13f49ac5e681bULL;
  for (std::size_t game = 0; result.size() < count; ++game) {
    Position position{.board = board_from_hash(5,
      game % 2 == 0 ? "#........................" : "......#..................")};
    for (int ply = 0; ply < 30 && result.size() < count; ++ply) {
      result.push_back(position);
      const Stone mover = ply % 2 == 0 ? Stone::black : Stone::white;
      std::vector<Point> legal;
      for (int coordinate = 0; coordinate < 25; ++coordinate) {
        const Point point{coordinate / 5, coordinate % 5};
        if (play_move(position.board, point, mover, {})) legal.push_back(point);
      }
      if (legal.empty()) break;
      const Point selected = legal[next_random(random) % legal.size()];
      position.board = play_move(position.board, selected, mover, {})->board;
    }
  }
  return result;
}

}  // namespace

int main() {
  using namespace bitburner::go;
  using namespace ipvgobruteforce;

  const PolicyRouteOracle route_oracle({
    {.phase = 2, .outcomes = {{10, 4}, {20, 10}}},
    {.phase = 5, .outcomes = {{18, 6}}},
  });
  require(route_oracle.best(2, 0, 0) == RouteChoice{2, 0, {20, 10}},
    "fresh route enters a validated policy");
  require(route_oracle.best(2, 0, 1) == RouteChoice{5, 3, {18, 9}},
    "abandoning a board charges a dodge");
  const auto slow_route = [&](std::uint32_t phase, std::uint32_t elapsed,
    std::uint32_t minimum_waits) {
    std::optional<RouteChoice> best;
    for (const PolicyProfile& profile : route_oracle.profiles()) {
      std::uint32_t waits = profile.phase >= phase
        ? profile.phase - phase : seeded_phase_count - phase + profile.phase;
      if (waits < minimum_waits) waits += seeded_phase_count;
      std::optional<PowerTurn> worst;
      for (PowerTurn outcome : profile.outcomes) {
        outcome.turns += elapsed + waits;
        if (!worst || better_power_turn(*worst, outcome)) worst = outcome;
      }
      const RouteChoice candidate{profile.phase, waits, *worst};
      if (!best || better_power_turn(candidate.worst, best->worst)
          || (!better_power_turn(best->worst, candidate.worst)
            && std::tie(candidate.waits, candidate.entry_phase)
              < std::tie(best->waits, best->entry_phase))) best = candidate;
    }
    return *best;
  };
  for (std::uint32_t phase = 0; phase < 12; ++phase) {
    for (std::uint32_t elapsed = 0; elapsed < 20; ++elapsed) {
      require(route_oracle.best(phase, elapsed, 0) == slow_route(phase, elapsed, 0),
        "indexed route selection equals exhaustive comparison");
    }
  }

  const Board board = board_from_hash(5, "#........................");
  const PackedBoard packed = pack_board(board);
  require(board_hash(unpack_board(packed)) == board_hash(board),
    "50-bit board encoding round-trips");
  Position history_position{.board = board,
    .previous_hashes = {"#X.......................", "#........................"},
    .consecutive_passes = 1};
  require(unpack_position(pack_position(history_position)).previous_hashes
      == history_position.previous_hashes
    && unpack_position(pack_position(history_position)).consecutive_passes == 1,
    "packed position preserves passes and ordered superko history");

  configure_symmetry_rule_cache({.enabled = true, .max_entries = 10'000,
    .max_bytes = 16ULL * 1024ULL * 1024ULL});
  const PackedBoard replay_board = pack_board(board_from_hash(5, "#X.O....................."));
  const Point replay_point{1, 1};
  const PackedMoveReplay replay_reference = replay_packed_move_uncached(
    replay_board, replay_point, Stone::black);
  for (const BoardSymmetry symmetry : all_board_symmetries) {
    const PackedMoveReplay transformed = replay_packed_move(
      transform_board(replay_board, symmetry), transform_point(replay_point, symmetry), Stone::black);
    require(transformed.legal == replay_reference.legal
        && transformed.captures == replay_reference.captures
        && transformed.board == transform_board(replay_reference.board, symmetry),
      "symmetry cache returns local replay in the caller orientation");
    const Score transformed_score = symmetry_cached_score(
      transform_board(replay_board, symmetry), 1.5);
    const Score reference_score = score_board(unpack_board(replay_board), 1.5);
    require(transformed_score.black == reference_score.black
        && transformed_score.white == reference_score.white,
      "cached score is orientation invariant");
  }
  clear_symmetry_rule_cache();
  std::atomic_bool cache_ok{true};
  std::vector<std::thread> workers;
  for (int worker = 0; worker < 8; ++worker) {
    workers.emplace_back([&, worker] {
      const BoardSymmetry symmetry = all_board_symmetries[static_cast<std::size_t>(worker)];
      for (int repeat = 0; repeat < 100; ++repeat) {
        const auto actual = replay_packed_move(
          transform_board(replay_board, symmetry), transform_point(replay_point, symmetry), Stone::black);
        if (actual.legal != replay_reference.legal
            || actual.board != transform_board(replay_reference.board, symmetry)) {
          cache_ok.store(false, std::memory_order_relaxed);
        }
      }
    });
  }
  for (std::thread& worker : workers) worker.join();
  require(cache_ok.load(std::memory_order_relaxed)
      && symmetry_rule_cache_stats().hits >= 790,
    "process-wide rule cache shares transformed work across threads");

  const auto replay_corpus = reachable_positions(48);
  std::size_t replay_cases = 0;
  for (const Position& item : replay_corpus) {
    for (const Stone mover : {Stone::black, Stone::white}) {
      for (int coordinate = 0; coordinate < 25; ++coordinate) {
        const Point point{coordinate / 5, coordinate % 5};
        const auto oracle = play_move(item.board, point, mover, {});
        const auto actual = replay_packed_move(pack_board(item.board), point, mover);
        require(actual.legal == oracle.has_value(), "packed replay legality matches Go rules");
        if (oracle) require(actual.board == pack_board(oracle->board)
            && actual.captures == static_cast<std::uint32_t>(oracle->captures),
          "packed replay result matches Go rules");
        ++replay_cases;
      }
    }
  }
  require(replay_cases == 2'400, "packed replay parity covers a deterministic corpus");

  Position move_order_fixture{.board = board_from_hash(5, "XOX.O.X.XXXXXXXXX........")};
  const auto ordered = ordered_black_moves(move_order_fixture, 1.5);
  require(!ordered.empty() && ordered == ordered_black_moves(move_order_fixture, 1.5),
    "Black move ordering is deterministic");

  require(seeded_phase_count == 150'000,
    "the WHRNG period has 150,000 distinct 200ms phases");
  require(whrng(0.0, 1) != whrng(200.0, 1)
      && whrng(0.0, 4) == whrng(go_whrng_period_ms, 4),
    "WHRNG distinguishes adjacent ticks and wraps at its exact period");
  require(pack_board(initial_board(5, Opponent::netburners,
      2'697.0 * go_whrng_period_ms + 86'901.0 * go_engine_cycle_ms, 0))
      == 0x30300f0300c33ULL,
    "absolute playtime epoch reproduces a pinned live board");

  const StartingBoardFamily illuminati_family = starting_board_family(
    5, Opponent::illuminati, 89'380.0 * go_engine_cycle_ms);
  const auto illuminati_variants = starting_board_variants(illuminati_family);
  require(!illuminati_family.handicap_may_be_absent
      && !illuminati_variants.empty()
      && illuminati_variants.size() == illuminati_family.possible_handicap_points.size()
      && std::all_of(illuminati_variants.begin(), illuminati_variants.end(),
        [](const StartingBoardVariant& variant) { return variant.handicap_point.has_value(); }),
    "an ordinary Illuminati family enumerates exactly its placement variants");
  StartingBoardFamily center_only = illuminati_family;
  // Upstream applyHandicap draws from the expansion list; with that list empty
  // the 20% center shortcut is the only stone source, so the untouched board
  // is a possible opening and must be enumerated as a proof root.
  center_only.possible_handicap_points = {{2, 2}};
  center_only.handicap_may_be_absent = true;
  const auto center_only_variants = starting_board_variants(center_only);
  require(center_only_variants.size() == 2
      && center_only_variants.front().handicap_point.has_value()
      && !center_only_variants.back().handicap_point.has_value()
      && board_hash(center_only_variants.back().board)
        == board_hash(center_only.board_before_handicap),
    "an empty expansion list adds the no-handicap-stone opening");

  const Position seeded_start{.board = initial_board(
    5, Opponent::netburners, 89'380.0 * go_engine_cycle_ms, 0)};
  const auto moves = ordered_black_moves(seeded_start, 1.5);
  require(!moves.empty(), "seeded fixture has a legal Black action");
  const SeededTransition transition = seeded_action_transition(
    seeded_start, 89'380, moves.front(), Opponent::netburners,
    {.runtime_uncertainty_ticks = 1});
  std::unordered_set<std::uint32_t> phases;
  for (const SeededStateKey& successor : transition.successors) phases.insert(successor.phase);
  Position after_black = seeded_start;
  if (moves.front().pass) {
    ++after_black.consecutive_passes;
  } else {
    const auto played = play_move(after_black.board, moves.front().point, Stone::black,
      std::unordered_set<std::string>(
        after_black.previous_hashes.begin(), after_black.previous_hashes.end()));
    require(played.has_value(), "seeded fixture Black action replays");
    after_black.previous_hashes.push_back(board_hash(after_black.board));
    after_black.board = played->board;
    after_black.consecutive_passes = 0;
  }
  const ReplyForecast forecast = predict_opponent_replies(
    after_black, Opponent::netburners, 89'381.0 * go_engine_cycle_ms);
  std::unordered_set<std::uint32_t> expected_phases;
  for (const WeightedReply& reply : forecast.replies) {
    const std::uint32_t earliest = 89'381
      + static_cast<std::uint32_t>(std::max(0, reply.wait.cycle_waits_after_seed))
      + static_cast<std::uint32_t>(std::max(0, reply.wait.fixed_sleep_ms_after_seed))
        / static_cast<std::uint32_t>(go_engine_cycle_ms);
    expected_phases.insert(earliest);
    expected_phases.insert(earliest + 1);
  }
  require(phases == expected_phases && *std::min_element(phases.begin(), phases.end()) > 89'381,
    "ordinary timing retains branch-exact AI waits and adjacent completion phases");

  const SeededGraphResult fair_alignment = search_seeded_graph(
    seeded_start, 89'380, Opponent::netburners, 1.5, {},
    {.max_states = 1'000, .max_expansions = 2, .progress_every = 0,
      .checkpoint_every = 0, .max_rounds = 1},
    {}, false, {});
  require(fair_alignment.stats.actions > 2
      && fair_alignment.stats.voluntary_wait_actions == 1,
    "proof-directed discovery includes ALIGN while exhausting immediate losses");

  const std::filesystem::path snapshot = std::filesystem::temp_directory_path()
    / "ipvgo-seeded-cleanup-test.snapshot";
  const std::filesystem::path certificate = std::filesystem::temp_directory_path()
    / "ipvgo-seeded-cleanup-test.certificate.tsv";
  std::error_code ignored;
  std::filesystem::remove(snapshot, ignored);
  std::filesystem::remove(certificate, ignored);
  Position offered_pass{.board = board_from_hash(5, "XXXXXXXXXX..............."),
    .consecutive_passes = 1};
  const SeededGraphResult cold = search_seeded_graph(
    offered_pass, 17, Opponent::netburners, 1.5, {},
    {.max_states = 1'000, .max_expansions = 0, .progress_every = 0,
      .checkpoint_every = 1, .max_rounds = 1}, snapshot, false, certificate);
  require(cold.start_status == GraphStatus::unknown && std::filesystem::exists(snapshot),
    "zero-work run creates a resumable seeded snapshot");
  const auto cold_bytes = file_bytes(snapshot);
  const SeededGraphResult stable = search_seeded_graph(
    offered_pass, 17, Opponent::netburners, 1.5, {},
    {.max_states = 1'000, .max_expansions = 0, .progress_every = 0,
      .checkpoint_every = 1, .max_rounds = 1}, snapshot, true, certificate);
  require(stable.stats.expanded_states == 0 && file_bytes(snapshot) == cold_bytes,
    "seeded snapshot load-save is deterministic");
  const SeededGraphResult won = search_seeded_graph(
    offered_pass, 17, Opponent::netburners, 1.5, {},
    {.max_states = 1'000, .max_expansions = 1, .progress_every = 0,
      .checkpoint_every = 1, .max_rounds = 1}, snapshot, true, certificate);
  require(won.start_status == GraphStatus::win && won.certificate_terminal_wins > 0
      && won.certificate_materialized_optimal
      && won.certificate_expected_power_per_turn > 0.0
      && std::filesystem::exists(certificate),
    "resumed seeded graph emits a route-rate-selected replay-validated certificate");

  const SeededGraphResult unfinished_optimal = search_seeded_graph(
    offered_pass, 17, Opponent::netburners, 1.5, {},
    {.max_states = 1'000, .max_expansions = 1, .progress_every = 0,
      .checkpoint_every = 0, .max_rounds = 40}, {}, false, certificate);
  require(unfinished_optimal.start_status == GraphStatus::win
      && unfinished_optimal.power_optimal_within_horizon
      && unfinished_optimal.certificate_expected_power_per_turn == 25.0,
    "a 25-power one-turn route closes against the mathematical upper bound");
  std::filesystem::remove(snapshot, ignored);
  std::filesystem::remove(certificate, ignored);

  for (const auto [opponent, komi] : std::array<std::pair<Opponent, double>, 6>{{
      {Opponent::netburners, 1.5}, {Opponent::slum_snakes, 3.5},
      {Opponent::black_hand, 3.5}, {Opponent::tetrads, 5.5},
      {Opponent::daedalus, 5.5}, {Opponent::illuminati, 7.5}}}) {
    const SeededGraphResult result = search_seeded_graph(
      offered_pass, 17, opponent, komi, {},
      {.max_states = 1'000, .max_expansions = 1, .progress_every = 0,
        .checkpoint_every = 0, .max_rounds = 1},
      {}, false, {});
    require(result.start_status == GraphStatus::win && result.stats.actions > 2
        && result.stats.voluntary_wait_actions == 1,
      "all legal root actions and ALIGN are resolved for every 5x5 faction");
  }

  std::cout << "ok\n";
  return EXIT_SUCCESS;
}
