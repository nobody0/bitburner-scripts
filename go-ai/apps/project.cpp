#include "go/network.hpp"

#include <cstdlib>
#include <fstream>
#include <iostream>
#include <stdexcept>
#include <string>

using namespace bitburner::go;

int main(int argc, char** argv) {
  try {
    if (argc != 4) {
      throw std::invalid_argument("usage: go_cpp_project INPUT_MODEL OUTPUT_MODEL small5|daemon19");
    }
    std::ifstream input(argv[1]);
    if (!input) throw std::runtime_error("cannot open input model");
    const auto source = CandidateValueNetwork::load(input);
    const std::string profile = argv[3];
    const auto projected = profile == "small5"
      ? CandidateValueNetwork::project_profile(source, 5, 6)
      : profile == "daemon19"
        ? CandidateValueNetwork::project_profile(source, 19, 0, 6)
        : throw std::invalid_argument("profile must be small5 or daemon19");
    std::ofstream output(argv[2]);
    if (!output) throw std::runtime_error("cannot create output model");
    projected.save(output);
    std::cout << "projected extent=" << projected.extent()
      << " opponent_features=" << projected.opponent_features()
      << " input_size=" << projected.input_size() << '\n';
    return EXIT_SUCCESS;
  } catch (const std::exception& error) {
    std::cerr << error.what() << '\n';
    return EXIT_FAILURE;
  }
}
