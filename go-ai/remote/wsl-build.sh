#!/usr/bin/env bash
set -euo pipefail

scratch=$1
snapshot_id=$2
source_root="$scratch/work/$snapshot_id/source/go-ai"
build="$scratch/build/$snapshot_id"
if test -x /home/peter/.bun/bin/bun; then
  export PATH="/home/peter/.bun/bin:$PATH"
fi
test ! -e "$build"
cmake -S "$source_root" -B "$build" -G Ninja -DCMAKE_BUILD_TYPE=Release
cmake --build "$build" -j "$(nproc)"
ctest --test-dir "$build" --output-on-failure
sha256sum "$build/go_cpp_gpu_env" "$build/go_cpp_oracle" "$build/go_cpp_tests" \
  > "$build/BINARIES.sha256"
