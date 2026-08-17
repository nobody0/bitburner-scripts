#!/usr/bin/env bash
set -euo pipefail

scratch=$1
run_name=$2
run="$scratch/runs/$run_name"
test -d "$run"
pid=$(cat "$run/PID")
if test -f "$run/RESULTS.sha256"; then
  exit_code=$(cat "$run/EXIT_CODE")
  if test "$exit_code" -eq 0; then
    state=finished
  else
    state=failed
  fi
elif kill -0 "$pid" 2>/dev/null; then
  state=running
else
  state=incomplete
fi
printf '{"run":"%s","pid":%s,"state":"%s"' "$run_name" "$pid" "$state"
if test -n "${exit_code:-}"; then
  printf ',"exitCode":%s' "$exit_code"
fi
printf '}\n'
nvidia-smi --query-gpu=name,utilization.gpu,memory.used,memory.total \
  --format=csv,noheader || true
tail -n 20 "$run/stdout.log" 2>/dev/null || true
tail -n 20 "$run/stderr.log" 2>/dev/null || true
