#!/usr/bin/env bash
set -uo pipefail

run=$1
started=$(date -u +%Y-%m-%dT%H:%M:%SZ)
set +e
/usr/bin/time -v "$run/command.sh" > "$run/stdout.log" 2> "$run/stderr.log"
status=$?
set -e
finished=$(date -u +%Y-%m-%dT%H:%M:%SZ)
printf '%s\n' "$status" > "$run/EXIT_CODE"
printf '{"schema":"bitburner-go-remote-run-v1","started":"%s","finished":"%s","exitCode":%d}\n' \
  "$started" "$finished" "$status" > "$run/JOB.json"
(
  cd "$run"
  find . -type f \( -name '*.model' -o -name '*.json' -o -name '*.jsonl.gz' -o -name '*.log' \
    -o -name '*.txt' -o -name 'EXIT_CODE' -o -name 'SNAPSHOT_ID' -o -name 'COMMAND.txt' \) \
    ! -name 'RESULTS.sha256' -print | LC_ALL=C sort | while IFS= read -r path; do
      sha256sum "${path#./}"
    done > RESULTS.sha256.tmp
  mv RESULTS.sha256.tmp RESULTS.sha256
)
exit "$status"
