#include "go/network.hpp"

#include <cstdlib>
#include <fstream>
#include <iostream>
#include <stdexcept>

using namespace bitburner::go;

int main(int argc, char** argv) {
  try {
    if (argc != 3) throw std::invalid_argument("usage: go_cpp_localize INPUT OUTPUT");
    std::ifstream input(argv[1]);
    if (!input) throw std::runtime_error("cannot open input model");
    const auto localized = CandidateValueNetwork::with_local_context(
      CandidateValueNetwork::load(input));
    std::ofstream output(argv[2]);
    if (!output) throw std::runtime_error("cannot create output model");
    localized.save(output);
    std::cout << "localized input_size=" << localized.input_size() << '\n';
    return EXIT_SUCCESS;
  } catch (const std::exception& error) {
    std::cerr << error.what() << '\n';
    return EXIT_FAILURE;
  }
}
