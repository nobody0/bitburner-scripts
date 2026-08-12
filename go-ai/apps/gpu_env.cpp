#include "go/arena.hpp"
#include "go/board_generator.hpp"
#include "go/opponent.hpp"
#include "go/reward.hpp"
#include "go/rules.hpp"
#include "go/search.hpp"

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

double sampled_seed(std::mt19937_64& random) {
  // Live decisions are aligned to 200 ms ticks. Across WHRNG's 30,000-second
  // period this gives 150,000 distinct reachable phases.
  std::uniform_int_distribution<int> tick(0, 149'999);
  return static_cast<double>(tick(random) * 200);
}

Move sample_reply(const ReplyForecast& forecast, std::mt19937_64& random) {
  std::uniform_real_distribution<double> unit(0.0, 1.0);
  const double roll = unit(random);
  double cumulative = 0;
  for (const auto& reply : forecast.replies) {
    cumulative += reply.probability;
    if (roll <= cumulative) return reply.move;
  }
  return forecast.replies.empty() ? Move::pass_turn() : forecast.replies.back().move;
}

struct Slot {
  int id{};
  int episode{};
  Opponent opponent{Opponent::netburners};
  Position position;
  std::mt19937_64 environment;
  std::mt19937_64 counterfactual;
  int rounds{};
  std::vector<Move> candidates;
  std::vector<Position> candidate_positions;
  std::vector<std::string> candidate_boards;
};

struct TransitionEvent {
  int slot{};
  int episode{};
  int turn{};
  int opponent{};
  std::string after_reply;
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
  const std::string& profile
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
  };
  const int size = profile == "small5" ? 5 : 19;
  slot.position.board = initial_board(
    size, slot.opponent, sampled_seed(slot.environment),
    static_cast<std::uint32_t>(slot.environment()));
  return slot;
}

void prepare_candidates(Slot& slot) {
  slot.candidates.clear();
  slot.candidate_positions.clear();
  slot.candidate_boards.clear();
  for (const Point point : legal_moves(slot.position, Stone::black)) {
    slot.candidates.push_back(Move::at(point.x, point.y));
  }
  slot.candidates.push_back(Move::pass_turn());
  const double reply_seed = sampled_seed(slot.environment);
  slot.candidate_positions.reserve(slot.candidates.size());
  slot.candidate_boards.reserve(slot.candidates.size());
  for (const Move move : slot.candidates) {
    Position after = slot.position;
    apply_to_position(after, move, Stone::black);
    if (after.consecutive_passes < 2) {
      const auto forecast = predict_opponent_replies(after, slot.opponent, reply_seed);
      apply_to_position(after, sample_reply(forecast, slot.counterfactual), Stone::white);
    }
    slot.candidate_boards.push_back(board_hash(after.board));
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
    if (argc < 5 || argc > 6) {
      throw std::invalid_argument(
        "usage: go_cpp_gpu_env GAMES SEED ENVIRONMENTS small5|daemon19 [THREADS]");
    }
    const int games = std::stoi(argv[1]);
    const std::uint64_t seed = std::stoull(argv[2]);
    const int environments = std::stoi(argv[3]);
    const std::string profile = argv[4];
    const int thread_count = argc >= 6 ? std::stoi(argv[5])
      : static_cast<int>(std::max(1U, std::thread::hardware_concurrency()));
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
        opponent_offset, profile));
      ++next_episode;
    }

    std::vector<TransitionEvent> transitions;
    std::vector<ResultEvent> results;
    std::cout << std::setprecision(17);
    while (!slots.empty()) {
      for (const auto& transition : transitions) {
        std::cout << "T\t" << transition.slot << '\t' << transition.episode << '\t'
          << transition.turn << '\t' << transition.opponent << '\t'
          << transition.after_reply << '\n';
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
        std::cout << "S\t" << slot.id << '\t' << slot.episode << '\t'
          << static_cast<int>(slot.opponent) << '\t' << slot.rounds << '\t'
          << slot.candidate_boards.size();
        for (const auto& board : slot.candidate_boards) std::cout << '\t' << board;
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
            opponent_offset, profile);
          ++next_episode;
        } else {
          slots.erase(slots.begin() + static_cast<std::ptrdiff_t>(index));
        }
      }
    }

    for (const auto& transition : transitions) {
      std::cout << "T\t" << transition.slot << '\t' << transition.episode << '\t'
        << transition.turn << '\t' << transition.opponent << '\t'
        << transition.after_reply << '\n';
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
