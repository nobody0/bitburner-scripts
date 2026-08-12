#include "go/network.hpp"

#include <cstdlib>
#include <fstream>
#include <iostream>
#include <stdexcept>

using namespace bitburner::go;

int main(int argc, char** argv) {
  try {
    if (argc != 3) throw std::invalid_argument("usage: go_cpp_boardify INPUT OUTPUT");
    std::ifstream input(argv[1]);
    if (!input) throw std::runtime_error("cannot open input model");
    const auto converted = CandidateValueNetwork::with_result_board_only(
      CandidateValueNetwork::load(input));
    std::ofstream output(argv[2]);
    if (!output) throw std::runtime_error("cannot create output model");
    converted.save(output);
    std::cout << "result_board_only input_size=" << converted.input_size() << '\n';
    return EXIT_SUCCESS;
  } catch (const std::exception& error) {
    std::cerr << error.what() << '\n';
    return EXIT_FAILURE;
  }
}
