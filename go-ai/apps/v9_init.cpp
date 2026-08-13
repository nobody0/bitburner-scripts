#include "go/network_v9.hpp"

#include <cstdlib>
#include <fstream>
#include <iostream>
#include <stdexcept>
#include <string>

using namespace bitburner::go;

int main(int argc, char** argv) {
  try {
    if (argc != 4) throw std::invalid_argument(
      "usage: go_cpp_v9_init small5|daemon19 SEED OUTPUT.model");
    const std::string profile = argv[1];
    const auto seed = std::stoull(argv[2]);
    const auto model = profile == "small5"
      ? GoNetworkV9::create(5, 32, 4, 256, 64, behavior_base_features + 1, seed)
      : profile == "daemon19"
        ? GoNetworkV9::create(19, 48, 8, 256, 64, behavior_base_features, seed)
        : throw std::invalid_argument("profile must be small5 or daemon19");
    std::ofstream output(argv[3]);
    if (!output) throw std::runtime_error("cannot open V9 output checkpoint");
    model.save(output);
    return EXIT_SUCCESS;
  } catch (const std::exception& error) {
    std::cerr << error.what() << '\n';
    return EXIT_FAILURE;
  }
}
