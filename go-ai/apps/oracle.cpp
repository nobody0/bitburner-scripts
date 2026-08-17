#include "go/arena.hpp"
#include "go/board_generator.hpp"
#include "go/candidates.hpp"
#include "go/network_v9.hpp"
#include "go/opponent.hpp"
#include "go/policy_v9.hpp"
#include "go/reward.hpp"
#include "go/rng.hpp"
#include "go/rules.hpp"
#include "go/transition.hpp"

#include <cmath>
#include <cstdlib>
#include <cstdint>
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

void hash_byte(std::uint64_t& hash, std::uint8_t value) {
  hash ^= value;
  hash *= 1099511628211ULL;
}

void hash_i64(std::uint64_t& hash, std::int64_t value) {
  const auto bits = static_cast<std::uint64_t>(value);
  for (int shift = 0; shift < 64; shift += 8) {
    hash_byte(hash, static_cast<std::uint8_t>((bits >> shift) & 0xff));
  }
}

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

std::string comma_values(const std::vector<float>& values) {
  std::ostringstream output;
  output << std::setprecision(9);
  for (std::size_t index = 0; index < values.size(); ++index) {
    if (index) output << ',';
    output << values[index];
  }
  return output.str();
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

Position position_argument(int size, const std::string& board, int passes,
  const std::string& history) {
  Position result{
    .board = board_from_hash(size, board),
    .consecutive_passes = passes,
  };
  if (history != "-") result.previous_hashes = split(history, ',');
  return result;
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

void rng_digest(int argc, char**) {
  if (argc != 2) throw std::invalid_argument("rng-digest");
  std::uint64_t hash = 14695981039346656037ULL;
  for (int tick = 0; tick < 150'000; ++tick) {
    for (const double value : whrng(static_cast<double>(tick * 200), 4)) {
      hash_i64(hash, static_cast<std::int64_t>(std::llround(value * 1e15)));
    }
  }
  std::cout << std::hex << std::setfill('0') << std::setw(16) << hash << '\n';
}

void behavior_digest(int argc, char**) {
  if (argc != 2) throw std::invalid_argument("behavior-digest");
  std::uint64_t hash = 14695981039346656037ULL;
  constexpr std::array opponents{
    Opponent::netburners, Opponent::slum_snakes, Opponent::black_hand,
    Opponent::tetrads, Opponent::daedalus, Opponent::illuminati,
    Opponent::world_daemon,
  };
  for (int tick = 0; tick < 150'000; ++tick) {
    for (const Opponent opponent : opponents) {
      const auto behavior = opponent_turn_behavior(opponent, static_cast<double>(tick * 200));
      hash_byte(hash, behavior.smart ? 1 : 0);
      for (const int rank : behavior.priority_ranks) {
        hash_byte(hash, static_cast<std::uint8_t>(rank));
      }
    }
  }
  std::cout << std::hex << std::setfill('0') << std::setw(16) << hash << '\n';
}

void timing(int argc, char** argv) {
  if (argc != 5) throw std::invalid_argument("timing DISPATCH CYCLE_WAITS FIXED_SLEEP_MS");
  const double dispatch = std::stod(argv[2]);
  std::cout << std::setprecision(17)
    << aligned_opponent_seed(dispatch) << '\t'
    << next_go_dispatch_playtime(dispatch, std::stoi(argv[3]), std::stoi(argv[4])) << '\n';
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
      << '\t' << candidate.wait.fixed_sleep_ms_after_seed
      << '\t' << (candidate.move.no_op ? "no-op" : "move") << '\n';
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

void future_behavior(int argc, char** argv) {
  if (argc != 4) throw std::invalid_argument("future-behavior OPPONENT [KOMI|-]");
  const auto encoded = encode_opponent_future_behavior(
    parse_opponent(argv[2]),
    std::string(argv[3]) == "-" ? -1.0 : std::stod(argv[3]));
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

void value_v9_batch(int argc, char** argv) {
  if (argc != 3) throw std::invalid_argument("value-v9-batch MODEL");
  std::ifstream checkpoint(argv[2]);
  if (!checkpoint) throw std::runtime_error("cannot open V9 model");
  const auto network = GoNetworkV9::load(checkpoint);
  std::string line;
  while (std::getline(std::cin, line)) {
    const auto fields = split(line, '\t');
    if (fields.size() != 8) throw std::invalid_argument(
      "value-v9-batch row needs SIZE BOARD LEGAL PASS ELAPSED RESPONSE_PASS RESPONSE_NO_OP BEHAVIOR_CSV");
    const int size = std::stoi(fields[0]);
    std::vector<float> legal(static_cast<std::size_t>(network.extent() * network.extent()));
    if (fields[2].size() != legal.size()) {
      throw std::invalid_argument("batch LEGAL must hold one flag per point of the model extent");
    }
    for (std::size_t index = 0; index < legal.size(); ++index) legal[index] = fields[2][index] == '1';
    std::vector<float> behavior_values;
    for (const auto& value : split(fields[7], ',')) behavior_values.push_back(std::stof(value));
    const auto prediction = network.predict({
      .board = board_from_hash(size, fields[1]),
      .legal_black = std::move(legal),
      .consecutive_passes = std::stof(fields[3]),
      .elapsed_fraction = std::stof(fields[4]),
      .response_pass = std::stof(fields[5]),
      .response_no_op = std::stof(fields[6]),
      .behavior = std::move(behavior_values),
    });
    std::cout << std::setprecision(17) << prediction.value.win_probability << '\t'
      << prediction.value.terminal_power << '\t' << prediction.value.remaining_turns << '\t';
    for (std::size_t index = 0; index < prediction.move_logits.size(); ++index) {
      if (index) std::cout << ',';
      std::cout << prediction.move_logits[index];
    }
    std::cout << '\n';
  }
}

void select_v9(int argc, char** argv) {
  if (argc != 11) throw std::invalid_argument(
    "select-v9 MODEL SIZE OPPONENT SEEDS_CSV ELAPSED PASS_COUNT BOARD HISTORY LIMIT");
  std::ifstream checkpoint(argv[2]);
  if (!checkpoint) throw std::runtime_error("cannot open V9 model");
  const auto network = GoNetworkV9::load(checkpoint);
  std::vector<double> seeds;
  for (const auto& value : split(argv[5], ',')) seeds.push_back(std::stod(value));
  const int size = std::stoi(argv[3]);
  const auto decision = choose_with_v9(
    position_argument(size, argv[8], std::stoi(argv[7]), argv[9]),
    parse_opponent(argv[4]), seeds, std::stoi(argv[6]), network, std::stoi(argv[10]));
  const auto index_of = [size](const Move& move) {
    return move.pass ? size * size : move.point.x * size + move.point.y;
  };
  std::cout << std::setprecision(17) << "{\"move\":" << index_of(decision.move)
    << ",\"finalists\":[";
  for (std::size_t index = 0; index < decision.finalists.size(); ++index) {
    if (index) std::cout << ',';
    std::cout << index_of(decision.finalists[index]);
  }
  std::cout << "],\"winProbability\":" << decision.win_probability
    << ",\"powerPerRound\":" << decision.power_per_round << "}\n";
}

void state_v9(int argc, char** argv) {
  if (argc != 9) throw std::invalid_argument(
    "state-v9 SIZE OPPONENT SEED ELAPSED PASS_COUNT BOARD HISTORY");
  const int size = std::stoi(argv[2]);
  const Opponent opponent = parse_opponent(argv[3]);
  const double seed = std::stod(argv[4]);
  const int elapsed = std::stoi(argv[5]);
  const Position position = position_argument(size, argv[7], std::stoi(argv[6]), argv[8]);
  const double komi = size == 5 ? opponent_komi(opponent) : -1.0;
  std::vector<Move> moves = ordered_legal_moves(position);
  moves.push_back(Move::pass_turn());
  std::cout << "S9\t0\t0\t" << static_cast<int>(opponent) << '\t' << elapsed << '\t'
    << comma_values(encode_opponent_turn_behavior(
      opponent_turn_behavior(opponent, seed), komi)) << '\t'
    << comma_values(encode_opponent_future_behavior(opponent, komi)) << '\t'
    << encoded_input(position, Move{}) << '\t' << moves.size();
  for (const Move move : moves) {
    Position after_black = position;
    apply_to_position(after_black, move, Stone::black);
    const ReplyForecast forecast = after_black.consecutive_passes >= 2
      ? ReplyForecast{.replies = {{
          .move = Move::pass_turn(), .probability = 1,
          .branch = ReplyBranch::pass,
        }}, .exact = true}
      : predict_opponent_replies(after_black, opponent, seed);
    const int move_index = move.pass ? size * size : move.point.x * size + move.point.y;
    std::cout << '\t' << move_index << "~1~";
    for (std::size_t reply_index = 0; reply_index < forecast.replies.size(); ++reply_index) {
      if (reply_index) std::cout << '^';
      const auto& weighted = forecast.replies[reply_index];
      Position outcome = after_black;
      if (outcome.consecutive_passes < 2) {
        apply_to_position(outcome, weighted.move, Stone::white);
      }
      std::cout << std::setprecision(17) << weighted.probability << ','
        << static_cast<int>(weighted.branch) << ',' << encoded_input(outcome, weighted.move);
      if (outcome.consecutive_passes >= 2) {
        const auto terminal = terminal_reward(
          score_board(outcome.board, opponent_komi(opponent)), opponent_name(opponent), size);
        std::cout << ',' << (terminal.won ? 1 : 0) << ',' << terminal.training_power;
      } else {
        std::cout << ",-,-";
      }
    }
  }
  std::cout << '\n';
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
    else if (command == "rng-digest") rng_digest(argc, argv);
    else if (command == "behavior-digest") behavior_digest(argc, argv);
    else if (command == "timing") timing(argc, argv);
    else if (command == "reward") reward(argc, argv);
    else if (command == "reply") reply(argc, argv);
    else if (command == "behavior") behavior(argc, argv);
    else if (command == "future-behavior") future_behavior(argc, argv);
    else if (command == "value-v9") value_v9(argc, argv);
    else if (command == "value-v9-batch") value_v9_batch(argc, argv);
    else if (command == "select-v9") select_v9(argc, argv);
    else if (command == "state-v9") state_v9(argc, argv);
    else if (command == "board") board(argc, argv);
    else throw std::invalid_argument("unknown command");
    return EXIT_SUCCESS;
  } catch (const std::exception& error) {
    std::cerr << error.what() << '\n';
    return EXIT_FAILURE;
  }
}
