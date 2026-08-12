#include "go/kata_advisor.hpp"

#include "go/rules.hpp"

#include <cerrno>
#include <csignal>
#include <cstdlib>
#include <cstdio>
#include <cstring>
#include <mutex>
#include <sstream>
#include <stdexcept>
#include <string_view>
#include <sys/types.h>
#include <sys/wait.h>
#include <unistd.h>

namespace bitburner::go {
namespace {

std::string move_key(Move move) {
  if (move.pass) return "pass";
  return std::to_string(move.point.x) + "," + std::to_string(move.point.y);
}

Move parse_move(std::string_view text) {
  if (text == "pass") return Move::pass_turn();
  const auto comma = text.find(',');
  if (comma == std::string_view::npos) throw std::runtime_error("invalid KataGo move " + std::string(text));
  return Move::at(
    std::stoi(std::string(text.substr(0, comma))),
    std::stoi(std::string(text.substr(comma + 1)))
  );
}

std::string json_string(std::string_view value) {
  std::string result{"\""};
  for (const char character : value) {
    if (character == '\\' || character == '"') result.push_back('\\');
    result.push_back(character);
  }
  result.push_back('"');
  return result;
}

[[noreturn]] void system_error(std::string_view operation) {
  throw std::runtime_error(std::string(operation) + ": " + std::strerror(errno));
}

}  // namespace

struct KataAdvisorClient::Implementation {
  explicit Implementation(const KataAdvisorConfig& config) {
    std::signal(SIGPIPE, SIG_IGN);
    int request_pipe[2];
    int response_pipe[2];
    if (pipe(request_pipe) != 0) system_error("create KataGo request pipe");
    if (pipe(response_pipe) != 0) {
      close(request_pipe[0]);
      close(request_pipe[1]);
      system_error("create KataGo response pipe");
    }
    child = fork();
    if (child < 0) system_error("start KataGo adviser worker");
    if (child == 0) {
      std::signal(SIGPIPE, SIG_DFL);
      (void)dup2(request_pipe[0], STDIN_FILENO);
      (void)dup2(response_pipe[1], STDOUT_FILENO);
      close(request_pipe[0]);
      close(request_pipe[1]);
      close(response_pipe[0]);
      close(response_pipe[1]);
      const std::string visits = std::to_string(config.visits);
      const std::string policy_visits = std::to_string(config.policy_visits);
      const std::string candidates = std::to_string(config.candidates);
      execlp(
        "bun", "bun", "run", config.worker.c_str(),
        "--binary", config.binary.c_str(),
        "--model", config.model.c_str(),
        "--config", config.analysis_config.c_str(),
        "--mode", config.mode.c_str(),
        "--visits", visits.c_str(),
        "--policy-visits", policy_visits.c_str(),
        "--candidates", candidates.c_str(),
        static_cast<char*>(nullptr)
      );
      _exit(127);
    }
    close(request_pipe[0]);
    close(response_pipe[1]);
    input = fdopen(request_pipe[1], "w");
    output = fdopen(response_pipe[0], "r");
    if (!input || !output) system_error("open KataGo adviser stream");
  }

  ~Implementation() {
    if (input) fclose(input);
    if (output) fclose(output);
    if (child > 0) {
      int status = 0;
      while (waitpid(child, &status, 0) < 0 && errno == EINTR) {}
    }
  }

  pid_t child{-1};
  FILE* input{};
  FILE* output{};
  std::mutex mutex;
};

KataAdvisorClient::KataAdvisorClient(KataAdvisorConfig config)
  : implementation_(std::make_unique<Implementation>(config)) {}

KataAdvisorClient::~KataAdvisorClient() = default;

KataAdvice KataAdvisorClient::advise(
  const Position& position,
  double komi,
  int elapsed_rounds,
  const std::vector<KataCandidate>& candidates
) {
  if (candidates.empty()) throw std::invalid_argument("KataGo adviser candidate list is empty");
  std::ostringstream request;
  request << "{\"size\":" << position.board.size
    << ",\"board\":" << json_string(board_hash(position.board))
    << ",\"history\":[";
  for (std::size_t index = 0; index < position.previous_hashes.size(); ++index) {
    if (index) request << ',';
    request << json_string(position.previous_hashes[index]);
  }
  request << "],\"consecutivePasses\":" << position.consecutive_passes
    << ",\"elapsedRounds\":" << elapsed_rounds
    << ",\"komi\":" << komi
    << ",\"candidates\":[";
  for (std::size_t index = 0; index < candidates.size(); ++index) {
    if (index) request << ',';
    const auto& candidate = candidates[index];
    request << "{\"move\":" << json_string(move_key(candidate.move))
      << ",\"predictedWhite\":" << json_string(move_key(candidate.predicted_white))
      << ",\"after\":" << json_string(board_hash(candidate.after));
    if (candidate.exact_score) request << ",\"exactScore\":{\"X\":"
      << candidate.exact_score->black << ",\"O\":" << candidate.exact_score->white << '}';
    if (candidate.exact_remaining_rounds) request << ",\"exactRemainingRounds\":"
      << *candidate.exact_remaining_rounds;
    request << '}';
  }
  request << "]}\n";

  std::lock_guard lock(implementation_->mutex);
  const std::string payload = request.str();
  if (fwrite(payload.data(), 1, payload.size(), implementation_->input) != payload.size()
    || fflush(implementation_->input) != 0) {
    throw std::runtime_error("write to KataGo adviser worker failed");
  }
  char* raw = nullptr;
  std::size_t capacity = 0;
  const ssize_t length = getline(&raw, &capacity, implementation_->output);
  if (length < 0) {
    free(raw);
    throw std::runtime_error("KataGo adviser worker exited without a response");
  }
  std::string response(raw, static_cast<std::size_t>(length));
  free(raw);
  while (!response.empty() && (response.back() == '\n' || response.back() == '\r')) response.pop_back();
  if (response.rfind("ERR\t", 0) == 0) throw std::runtime_error(response.substr(4));
  if (response.rfind("OK\t", 0) != 0) throw std::runtime_error("invalid KataGo adviser response: " + response);
  const auto second_tab = response.find('\t', 3);
  if (second_tab == std::string::npos) throw std::runtime_error("incomplete KataGo adviser response");
  KataAdvice advice{.selected = parse_move(std::string_view(response).substr(3, second_tab - 3))};
  std::string_view ranked(response.data() + second_tab + 1, response.size() - second_tab - 1);
  while (!ranked.empty()) {
    const auto separator = ranked.find(';');
    advice.ranked.push_back(parse_move(ranked.substr(0, separator)));
    if (separator == std::string_view::npos) break;
    ranked.remove_prefix(separator + 1);
  }
  return advice;
}

}  // namespace bitburner::go
