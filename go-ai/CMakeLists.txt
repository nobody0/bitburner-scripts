cmake_minimum_required(VERSION 3.22)

project(bitburner_go_ai LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)

add_library(bitburner_go
  src/analysis.cpp
  src/arena.cpp
  src/board_generator.cpp
  src/candidates.cpp
  src/network_v9.cpp
  src/opponent.cpp
  src/patterns.cpp
  src/policy_v9.cpp
  src/reward.cpp
  src/rng.cpp
  src/rules.cpp
  src/transition.cpp
)
target_include_directories(bitburner_go PUBLIC include)
target_compile_options(bitburner_go PRIVATE
  $<$<CXX_COMPILER_ID:AppleClang,Clang,GNU>:-Wall;-Wextra;-Wpedantic;-Werror>
  $<$<CXX_COMPILER_ID:GNU>:-Wno-missing-field-initializers;-Wno-range-loop-construct>
)

add_executable(go_cpp_oracle apps/oracle.cpp)
target_link_libraries(go_cpp_oracle PRIVATE bitburner_go)

add_executable(go_cpp_starting_states apps/starting_states.cpp)
target_link_libraries(go_cpp_starting_states PRIVATE bitburner_go)

add_executable(go_cpp_gpu_env apps/gpu_env.cpp)
target_link_libraries(go_cpp_gpu_env PRIVATE bitburner_go)

add_executable(go_cpp_v9_init apps/v9_init.cpp)
target_link_libraries(go_cpp_v9_init PRIVATE bitburner_go)

enable_testing()
add_executable(go_cpp_tests tests/go_test.cpp)
target_link_libraries(go_cpp_tests PRIVATE bitburner_go)
add_test(NAME go_cpp_tests COMMAND go_cpp_tests)

find_program(BUN_EXECUTABLE bun)
if(BUN_EXECUTABLE)
  add_test(
    NAME go_cpp_opponent_parity
    COMMAND ${BUN_EXECUTABLE} run ${CMAKE_CURRENT_SOURCE_DIR}/tests/opponent-parity.ts
  )
  set_tests_properties(go_cpp_opponent_parity PROPERTIES
    ENVIRONMENT "GO_CPP_ORACLE=$<TARGET_FILE:go_cpp_oracle>"
  )
  add_test(
    NAME go_teacher_future_seed
    COMMAND ${BUN_EXECUTABLE} run ${CMAKE_CURRENT_SOURCE_DIR}/tests/future-seed.ts
  )
endif()
