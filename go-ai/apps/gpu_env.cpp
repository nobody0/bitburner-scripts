#include "go/arena.hpp"
#include "go/board_generator.hpp"
#include "go/candidates.hpp"
#include "go/opponent.hpp"
#include "go/reward.hpp"
#include "go/rules.hpp"
#include "go/transition.hpp"

#include <algorithm>
#include <array>
#include <atomic>
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
  int rounds{};
  bool portable_benchmark{};
  std::vector<Move> candidates;
  std::vector<Position> candidate_positions;
  std::vector<std::string> candidate_boards;
  // Index of the sampled reply within each candidate's forecast, in the same
  // order the V9 record lists them.
  std::vector<std::size_t> candidate_reply_indices;
  std::string v9_original_input;
  std::string v9_behavior;
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
  slot.position.board = initial_board(
    size, slot.opponent, sampled_seed(slot.environment, portable_benchmark),
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

void prepare_candidates(Slot& slot) {
  slot.candidates.clear();
  slot.candidate_positions.clear();
  slot.candidate_boards.clear();
  slot.candidate_reply_indices.clear();
  slot.v9_original_input.clear();
  slot.v9_behavior.clear();
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
  const double reply_seed = sampled_seed(slot.environment, slot.portable_benchmark);
  slot.v9_original_input = encoded_input(slot.position, Move{});
  const double komi = slot.position.board.size == 5 ? opponent_komi(slot.opponent) : -1.0;
  slot.v9_behavior = comma_values(encode_opponent_turn_behavior(
    opponent_turn_behavior(slot.opponent, reply_seed), komi));
  slot.v9_candidates.reserve(slot.candidates.size());
  slot.candidate_positions.reserve(slot.candidates.size());
  slot.candidate_boards.reserve(slot.candidates.size());
  slot.candidate_reply_indices.reserve(slot.candidates.size());
  for (const Move move : slot.candidates) {
    Position after_black = slot.position;
    apply_to_position(after_black, move, Stone::black);
    ReplyForecast forecast;
    if (after_black.consecutive_passes >= 2) {
      forecast = {.replies = {{
        .move = Move::pass_turn(), .probability = 1.0,
        .branch = ReplyBranch::pass,
      }}, .exact = true};
    } else {
      forecast = predict_opponent_replies(after_black, slot.opponent, reply_seed);
    }
    const std::size_t reply_index = sample_reply_index(
      forecast, slot.counterfactual, slot.portable_benchmark);
    const Move reply = forecast.replies[reply_index].move;
    slot.candidate_reply_indices.push_back(reply_index);
    Position after = after_black;
    if (after.consecutive_passes < 2) apply_to_position(after, reply, Stone::white);
    slot.candidate_boards.push_back(board_hash(after.board));
    {
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
    }
    slot.candidate_positions.push_back(std::move(after));
  }
}

void prepare_all(std::vector<Slot>& slots, int thread_count) {
  const std::size_t workers = std::min(
    slots.size(), static_cast<std::size_t>(std::max(thread_count, 1)));
  std::atomic<std::size_t> next{};
  std::exception_ptr failure;
  std::mutex failure_mutex;
  const auto work = [&] {
    try {
      while (true) {
        const std::size_t index = next.fetch_add(1);
        if (index >= slots.size()) break;
        prepare_candidates(slots[index]);
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
    std::cout << std::setprecision(17);
    while (!slots.empty()) {
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
      prepare_all(slots, thread_count);
      for (auto& slot : slots) {
        std::cout << "S9\t" << slot.id << '\t' << slot.episode << '\t'
          << static_cast<int>(slot.opponent) << '\t' << slot.rounds << '\t'
          << slot.v9_behavior << '\t' << slot.v9_original_input << '\t'
          << slot.v9_candidates.size();
        for (const auto& candidate : slot.v9_candidates) std::cout << '\t' << candidate;
        std::cout << '\n';
      }
      std::cout << "READY\n" << std::flush;

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
        const int cap = 4 * slot.position.board.size * slot.position.board.size;
        if (slot.position.consecutive_passes < 2 && slot.rounds * 2 < cap) continue;
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
