#include "go/board_generator.hpp"
#include "go/network_v9.hpp"
#include "go/opponent.hpp"
#include "go/reward.hpp"
#include "go/rng.hpp"
#include "go/rules.hpp"

#include <cstdlib>
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

void behavior(int argc, char** argv) {
  if (argc != 5) throw std::invalid_argument("behavior OPPONENT SEED [KOMI|-]");
  const auto encoded = encode_opponent_turn_behavior(
    opponent_turn_behavior(parse_opponent(argv[2]), std::stod(argv[3])),
    std::string(argv[4]) == "-" ? -1.0 : std::stod(argv[4]));
  std::cout << std::setprecision(17);
  for (std::size_t index = 0; index < encoded.size(); ++index) {
    if (index) std::cout << ',';
    std::cout << encoded[index];
  }
  std::cout << '\n';
}

void value_v9(int argc, char** argv) {
  if (argc != 11) throw std::invalid_argument(
    "value-v9 MODEL SIZE BOARD LEGAL PASS ELAPSED RESPONSE_PASS RESPONSE_NO_OP BEHAVIOR_CSV");
  std::ifstream checkpoint(argv[2]);
  if (!checkpoint) throw std::runtime_error("cannot open V9 model");
  const auto network = GoNetworkV9::load(checkpoint);
  const int size = std::stoi(argv[3]);
  const std::string legal_text = argv[5];
  std::vector<float> legal(static_cast<std::size_t>(network.extent() * network.extent()));
  if (legal_text.size() != legal.size()) {
    throw std::invalid_argument("LEGAL must hold one flag per point of the model extent");
  }
  for (std::size_t index = 0; index < legal_text.size(); ++index) legal[index] = legal_text[index] == '1';
  std::vector<float> encoded_behavior;
  for (const auto& value : split(argv[10], ',')) encoded_behavior.push_back(std::stof(value));
  const auto prediction = network.predict({
    .board = board_from_hash(size, argv[4]),
    .legal_black = std::move(legal),
    .consecutive_passes = std::stof(argv[6]),
    .elapsed_fraction = std::stof(argv[7]),
    .response_pass = std::stof(argv[8]),
    .response_no_op = std::stof(argv[9]),
    .behavior = std::move(encoded_behavior),
  });
  std::cout << std::setprecision(17) << prediction.value.win_probability << '\t'
    << prediction.value.terminal_power << '\t' << prediction.value.remaining_turns << '\n';
  for (std::size_t candidate = 0; candidate < prediction.move_logits.size(); ++candidate) {
    std::cout << candidate << '\t' << prediction.move_logits[candidate];
    for (const double branch : prediction.branch_logits[candidate]) std::cout << '\t' << branch;
    std::cout << '\n';
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
    else if (command == "reward") reward(argc, argv);
    else if (command == "reply") reply(argc, argv);
    else if (command == "behavior") behavior(argc, argv);
    else if (command == "value-v9") value_v9(argc, argv);
    else if (command == "board") board(argc, argv);
    else throw std::invalid_argument("unknown command");
    return EXIT_SUCCESS;
  } catch (const std::exception& error) {
    std::cerr << error.what() << '\n';
    return EXIT_FAILURE;
  }
}
