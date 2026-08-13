#!/usr/bin/env bash
set -euo pipefail

scratch=$1
run_name=$2
run="$scratch/runs/$run_name"
test -f "$run/RESULTS.sha256"
archive="$scratch/incoming/$run_name.results.tar"
test ! -e "$archive"
list=$(mktemp)
trap 'rm -f "$list"' EXIT
awk '{print $2}' "$run/RESULTS.sha256" > "$list"
printf '%s\n' RESULTS.sha256 >> "$list"
tar -C "$run" -cf "$archive" --transform "s,^,$run_name/," \
  -T "$list"
chmod a-w "$archive"
echo "$archive"
