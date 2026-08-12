cmake_minimum_required(VERSION 3.22)

project(bitburner_go_ai LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)

add_library(bitburner_go
  src/analysis.cpp
  src/arena.cpp
  src/board_generator.cpp
  src/features.cpp
  src/kata_advisor.cpp
  src/network.cpp
  src/opponent.cpp
  src/patterns.cpp
  src/policy.cpp
  src/reward.cpp
  src/rng.cpp
  src/rules.cpp
  src/search.cpp
)
target_include_directories(bitburner_go PUBLIC include)
target_compile_options(bitburner_go PRIVATE
  $<$<CXX_COMPILER_ID:AppleClang,Clang,GNU>:-Wall;-Wextra;-Wpedantic;-Werror>
)

add_executable(go_cpp_oracle apps/oracle.cpp)
target_link_libraries(go_cpp_oracle PRIVATE bitburner_go)

add_executable(go_cpp_arena apps/arena.cpp)
target_link_libraries(go_cpp_arena PRIVATE bitburner_go)

add_executable(go_cpp_starting_states apps/starting_states.cpp)
target_link_libraries(go_cpp_starting_states PRIVATE bitburner_go)

add_executable(go_cpp_selfplay apps/selfplay.cpp)
target_link_libraries(go_cpp_selfplay PRIVATE bitburner_go)

add_executable(go_cpp_population apps/population.cpp)
target_link_libraries(go_cpp_population PRIVATE bitburner_go)
target_compile_definitions(go_cpp_population PRIVATE GO_AI_SOURCE_DIR="${CMAKE_CURRENT_SOURCE_DIR}")

add_executable(go_cpp_gpu_env apps/gpu_env.cpp)
target_link_libraries(go_cpp_gpu_env PRIVATE bitburner_go)

add_executable(go_cpp_evaluate apps/evaluate.cpp)
target_link_libraries(go_cpp_evaluate PRIVATE bitburner_go)

add_executable(go_cpp_evaluate_mixed apps/evaluate_mixed.cpp)
target_link_libraries(go_cpp_evaluate_mixed PRIVATE bitburner_go)

add_executable(go_cpp_teacher_train apps/teacher_train.cpp)
target_link_libraries(go_cpp_teacher_train PRIVATE bitburner_go)

add_executable(go_cpp_project apps/project.cpp)
target_link_libraries(go_cpp_project PRIVATE bitburner_go)

add_executable(go_cpp_widen apps/widen.cpp)
target_link_libraries(go_cpp_widen PRIVATE bitburner_go)

add_executable(go_cpp_localize apps/localize.cpp)
target_link_libraries(go_cpp_localize PRIVATE bitburner_go)

add_executable(go_cpp_boardify apps/boardify.cpp)
target_link_libraries(go_cpp_boardify PRIVATE bitburner_go)

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
  add_test(
    NAME go_teacher_future_seed
    COMMAND ${BUN_EXECUTABLE} run ${CMAKE_CURRENT_SOURCE_DIR}/tests/future-seed.ts
  )
endif()
