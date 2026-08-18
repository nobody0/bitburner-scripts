cmake_minimum_required(VERSION 3.22)

project(ipvgo_playbook LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)

# The playbook generator links the repository's parity-tested rules and
# opponent implementation as its oracle.
set(GO_AI_ROOT "${CMAKE_CURRENT_SOURCE_DIR}/../go-ai")

add_library(ipvgo_playbook_core
  src/move_order.cpp
  src/packed_board.cpp
  src/policy_routes.cpp
  src/seeded_search.cpp
  src/symmetry.cpp
  src/symmetry_rule_cache.cpp
  ${GO_AI_ROOT}/src/analysis.cpp
  ${GO_AI_ROOT}/src/board_generator.cpp
  ${GO_AI_ROOT}/src/opponent.cpp
  ${GO_AI_ROOT}/src/patterns.cpp
  ${GO_AI_ROOT}/src/rng.cpp
  ${GO_AI_ROOT}/src/rules.cpp
  ${GO_AI_ROOT}/src/transition.cpp
)
target_include_directories(ipvgo_playbook_core PUBLIC
  include
  ${GO_AI_ROOT}/include
)
target_compile_options(ipvgo_playbook_core PRIVATE
  $<$<CXX_COMPILER_ID:AppleClang,Clang,GNU>:-Wall;-Wextra;-Wpedantic;-Werror>
  $<$<CXX_COMPILER_ID:GNU>:-Wno-missing-field-initializers;-Wno-range-loop-construct>
)

# Generate independent exact-history certificates over a phase range.
add_executable(ipvgo_seeded_batch src/seeded_batch_main.cpp)
target_link_libraries(ipvgo_seeded_batch PRIVATE ipvgo_playbook_core)

# Post-proof compiler: exact histories are used for safe state deduplication,
# then omitted from the compact runtime graph because traversal preserves the
# already-validated path provenance.
add_executable(ipvgo_seeded_pack src/seeded_pack_main.cpp)
target_link_libraries(ipvgo_seeded_pack PRIVATE ipvgo_playbook_core)

# Generator-side inventory and phase-route manifest. This intentionally does
# not emit or modify the runtime packer/JavaScript artifacts.
add_executable(ipvgo_playbook_manifest src/playbook_manifest_main.cpp)
target_link_libraries(ipvgo_playbook_manifest PRIVATE ipvgo_playbook_core)

enable_testing()
add_executable(ipvgo_playbook_tests tests/tests.cpp)
target_link_libraries(ipvgo_playbook_tests PRIVATE ipvgo_playbook_core)
add_test(NAME ipvgo_playbook_tests COMMAND ipvgo_playbook_tests)
