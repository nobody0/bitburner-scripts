#include "go/features.hpp"
#include "go/board_generator.hpp"
#include "go/network.hpp"
#include "go/opponent.hpp"
#include "go/reward.hpp"
#include "go/rng.hpp"
#include "go/rules.hpp"

#include <cstdlib>
#include <chrono>
#include <fstream>
#include <iomanip>
#include <iostream>
#include <sstream>
#include <stdexcept>
#include <string>
#include <unordered_set>
#include <vector>

namespace {

using namespace bitburner::go;

std::vector<std::string> split(const std::string& value, char separator) {
  std::vector<std::string> result;
  std::istringstream stream(value);
  std::string part;
  while (std::getline(stream, part, separator)) result.push_back(part);
  return result;
}

Stone stone(const std::string& value) {
  if (value == "X") return Stone::black;
  if (value == "O") return Stone::white;
  throw std::invalid_argument("stone must be X or O");
}

void analyze(int argc, char** argv) {
  if (argc != 7) throw std::invalid_argument("analyze SIZE STONE KOMI BOARD HISTORY");
  const int size = std::stoi(argv[2]);
  const Stone colour = stone(argv[3]);
  const double komi = std::stod(argv[4]);
  const Board board = board_from_hash(size, argv[5]);
  std::vector<std::string> history;
  if (std::string(argv[6]) != "-") history = split(argv[6], ',');
  const Position position{.board = board, .previous_hashes = history};
  const Score score = score_board(board, komi);
  std::cout << std::setprecision(17) << "score\t" << score.black << '\t' << score.white << '\n';
  const std::unordered_set<std::string> hashes(history.begin(), history.end());
  for (const Point move : legal_moves(position, colour)) {
    const auto played = play_move(board, move, colour, hashes);
    if (!played) throw std::logic_error("legal move did not replay");
    std::cout << "move\t" << move.x << '\t' << move.y << '\t'
      << played->captures << '\t' << board_hash(played->board) << '\n';
  }
}

void random_values(int argc, char** argv) {
  if (argc != 4) throw std::invalid_argument("whrng SEED COUNT");
  std::cout << std::setprecision(17);
  for (const double value : whrng(std::stod(argv[2]), std::stoi(argv[3]))) std::cout << value << '\n';
}

void reward(int argc, char** argv) {
  if (argc != 6) throw std::invalid_argument("reward OPPONENT SIZE BLACK WHITE");
  const auto value = terminal_reward(
    {.black = std::stod(argv[4]), .white = std::stod(argv[5])},
    argv[2],
    std::stoi(argv[3])
  );
  std::cout << std::setprecision(17) << (value.won ? 1 : 0) << '\t'
    << value.game_power << '\t' << value.training_power << '\n';
}

void reply(int argc, char** argv) {
  if (argc < 7) throw std::invalid_argument("reply SIZE OPPONENT SEED PASS_COUNT BOARD [HISTORY ...]");
  const int size = std::stoi(argv[2]);
  Position position{
    .board = board_from_hash(size, argv[6]),
    .consecutive_passes = std::stoi(argv[5]),
  };
  for (int index = 7; index < argc; ++index) position.previous_hashes.emplace_back(argv[index]);
  const auto forecast = predict_opponent_replies(position, parse_opponent(argv[3]), std::stod(argv[4]));
  std::cout << (forecast.exact ? "exact" : "unseeded-defense-tie") << '\n' << std::setprecision(17);
  for (const auto& candidate : forecast.replies) {
    std::cout << candidate.probability << '\t';
    if (candidate.move.pass) std::cout << "pass";
    else std::cout << candidate.move.point.x << ',' << candidate.move.point.y;
    std::cout << '\t' << branch_name(candidate.branch)
      << '\t' << candidate.wait.cycle_waits_after_seed
      << '\t' << candidate.wait.fixed_sleep_ms_after_seed << '\n';
  }
}

void reply_bench(int argc, char** argv) {
  if (argc != 8) throw std::invalid_argument("reply-bench SIZE OPPONENT SEED PASS_COUNT ITERATIONS BOARD");
  const int size = std::stoi(argv[2]);
  const int iterations = std::stoi(argv[6]);
  const Position position{
    .board = board_from_hash(size, argv[7]),
    .consecutive_passes = std::stoi(argv[5]),
  };
  std::size_t checksum = 0;
  const auto started = std::chrono::steady_clock::now();
  for (int iteration = 0; iteration < iterations; ++iteration) {
    const auto forecast = predict_opponent_replies(
      position,
      parse_opponent(argv[3]),
      std::stod(argv[4]) + iteration * 200.0);
    checksum += forecast.replies.size();
    for (const auto& reply : forecast.replies) {
      checksum += static_cast<std::size_t>(reply.move.pass ? 1 : 2 + reply.move.point.x * size + reply.move.point.y);
    }
  }
  const double elapsed_ms = std::chrono::duration<double, std::milli>(
    std::chrono::steady_clock::now() - started).count();
  std::cout << std::setprecision(10) << "iterations\t" << iterations
    << "\ttotal_ms\t" << elapsed_ms
    << "\tper_prediction_ms\t" << elapsed_ms / iterations
    << "\tchecksum\t" << checksum << '\n';
}

// Golden vectors for the deployed TypeScript/WebGPU inference ports: raw
// decoded predictions for result boards, bypassing reply prediction entirely.
void value(int argc, char** argv) {
  if (argc < 6) throw std::invalid_argument("value MODEL SIZE OPPONENT_INDEX BOARD [BOARD ...]");
  std::ifstream input(argv[2]);
  if (!input) throw std::runtime_error("cannot open model " + std::string(argv[2]));
  const auto network = CandidateValueNetwork::load(input);
  const int size = std::stoi(argv[3]);
  const int opponent = std::stoi(argv[4]);
  std::cout << std::setprecision(17);
  for (int index = 5; index < argc; ++index) {
    const Board board = board_from_hash(size, argv[index]);
    const auto prediction = network.predict(encode_candidate(
      board, Move::pass_turn(), Move::pass_turn(), board, network.extent(), opponent));
    std::cout << prediction.win_probability << '\t' << prediction.terminal_power
      << '\t' << prediction.remaining_turns << '\n';
  }
}

void board(int argc, char** argv) {
  if (argc != 6) throw std::invalid_argument("board SIZE OPPONENT OBSTACLE_SEED HANDICAP_SEED");
  const auto generated = initial_board(
    std::stoi(argv[2]),
    parse_opponent(argv[3]),
    std::stod(argv[4]),
    static_cast<std::uint32_t>(std::stoul(argv[5]))
  );
  std::cout << generated.size << '\t' << board_hash(generated) << '\n';
}

}  // namespace

int main(int argc, char** argv) {
  try {
    if (argc < 2) throw std::invalid_argument("missing command");
    const std::string command = argv[1];
    if (command == "analyze") analyze(argc, argv);
    else if (command == "whrng") random_values(argc, argv);
    else if (command == "reply-bench") reply_bench(argc, argv);
    else if (command == "reward") reward(argc, argv);
    else if (command == "reply") reply(argc, argv);
    else if (command == "value") value(argc, argv);
    else if (command == "board") board(argc, argv);
    else throw std::invalid_argument("unknown command");
    return EXIT_SUCCESS;
  } catch (const std::exception& error) {
    std::cerr << error.what() << '\n';
    return EXIT_FAILURE;
  }
}
