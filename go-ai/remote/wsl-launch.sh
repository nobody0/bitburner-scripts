#!/usr/bin/env bash
set -euo pipefail

scratch=$1
snapshot_id=$2
run_name=$3
shift 3
case "$run_name" in
  ""|*[!A-Za-z0-9._-]*) echo "unsafe run name" >&2; exit 2 ;;
esac
run="$scratch/runs/$run_name"
mkdir -p "$scratch/runs"
mkdir "$run"
printf '%s\n' "$snapshot_id" > "$run/SNAPSHOT_ID"
{
  echo '#!/usr/bin/env bash'
  echo 'set -euo pipefail'
  printf 'cd %q\n' "$scratch/work/$snapshot_id/source/go-ai"
  printf 'export PYTHONDONTWRITEBYTECODE=1\nexec '
  printf '%q ' "$@"
  echo
} > "$run/command.sh"
chmod +x "$run/command.sh"
printf '%q ' "$@" > "$run/COMMAND.txt"
printf '\n' >> "$run/COMMAND.txt"
setsid nohup bash "$scratch/work/$snapshot_id/source/go-ai/remote/wsl-job.sh" \
  "$run" </dev/null >/dev/null 2>&1 &
printf '%s\n' "$!" > "$run/PID"
echo "$run"
