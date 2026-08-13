#!/usr/bin/env bash
set -euo pipefail

scratch=$1
run_name=$2
run="$scratch/runs/$run_name"
test -d "$run"
pid=$(cat "$run/PID")
if test -f "$run/RESULTS.sha256"; then
  state=finished
elif kill -0 "$pid" 2>/dev/null; then
  state=running
else
  state=incomplete
fi
printf '{"run":"%s","pid":%s,"state":"%s"}\n' "$run_name" "$pid" "$state"
nvidia-smi --query-gpu=name,utilization.gpu,memory.used,memory.total \
  --format=csv,noheader || true
tail -n 20 "$run/stdout.log" 2>/dev/null || true
tail -n 20 "$run/stderr.log" 2>/dev/null || true
