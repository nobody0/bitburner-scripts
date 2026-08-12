#include "go/network.hpp"

#include <cstdlib>
#include <fstream>
#include <iostream>
#include <stdexcept>

using namespace bitburner::go;

int main(int argc, char** argv) {
  try {
    if (argc < 5 || argc > 6) {
      throw std::invalid_argument("usage: go_cpp_widen INPUT OUTPUT HIDDEN SEED [SYMMETRY_BREAK]");
    }
    std::ifstream input(argv[1]);
    if (!input) throw std::runtime_error("cannot open input model");
    const auto source = CandidateValueNetwork::load(input);
    const auto widened = CandidateValueNetwork::widen(
      source, std::stoull(argv[3]), std::stoull(argv[4]),
      argc == 6 ? std::stod(argv[5]) : 1e-4);
    std::ofstream output(argv[2]);
    if (!output) throw std::runtime_error("cannot create output model");
    widened.save(output);
    std::cout << "widened hidden=" << widened.hidden()
      << " input_size=" << widened.input_size() << '\n';
    return EXIT_SUCCESS;
  } catch (const std::exception& error) {
    std::cerr << error.what() << '\n';
    return EXIT_FAILURE;
  }
}
