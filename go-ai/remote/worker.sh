#!/usr/bin/env bash
set -euo pipefail

ROOT=$(cd "$(dirname "$0")/../.." && pwd)
HOST=${BITBURNER_CUDA_HOST:-windows-desktop}
DISTRO=${BITBURNER_CUDA_DISTRO:-Ubuntu}
SCRATCH=${BITBURNER_CUDA_ROOT:-/mnt/d/BitburnerCuda}

usage() {
  echo "usage: $0 snapshot LOCAL_DIR | transfer-snapshot SNAPSHOT_DIR | put FILE | setup SNAPSHOT_ID | build SNAPSHOT_ID | launch SNAPSHOT_ID RUN_NAME -- COMMAND... | status RUN_NAME | collect RUN_NAME LOCAL_DIR" >&2
  exit 2
}

wsl() {
  ssh "$HOST" wsl.exe -d "$DISTRO" -- "$@"
}

local_sha256() {
  shasum -a 256 "$1" | awk '{print $1}'
}

snapshot() {
  local destination=$1 stamp stage source list digest snapshot_id archive
  stamp=$(date -u +%Y%m%dT%H%M%SZ)
  stage=$(mktemp -d "${TMPDIR:-/tmp}/bitburner-v9-snapshot.XXXXXX")
  trap 'rm -rf "$stage"' RETURN
  source="$stage/source"
  mkdir -p "$source"
  list="$stage/files.txt"
  (
    cd "$ROOT"
    find go-ai shared/strategy/go tools tests sim -type f -print
    printf '%s\n' package.json bun.lock tsconfig.json shared/strategy/factions/rep.ts
  ) | LC_ALL=C sort -u | while IFS= read -r path; do
    case "$path" in
      go-ai/build/*|go-ai/corpora/*|go-ai/runs/*|go-ai/remote-results/*|go-ai/.venv*/*|go-ai/.deps/*|go-ai/katago/models/*|go-ai/katago/results/*|*/.git/*|*/__pycache__/*|*.pyc|*.model|build/*|node_modules/*)
        continue
        ;;
      tools/*)
        case "$path" in
          tools/go-*|tools/webgpu/*) ;;
          *) continue ;;
        esac
        ;;
      tests/*)
        case "$path" in
          tests/go-*|tests/fixtures/go-value.json|tests/support/go-*) ;;
          *) continue ;;
        esac
        ;;
      sim/*)
        case "$path" in
          sim/go-arena.ts|sim/features/go.ts|sim/features/go-oracle.ts|sim/vendor/bitburner/src/Go/*|sim/vendor/bitburner/src/Go/**/*|sim/vendor/bitburner/src/Casino/RNG.ts) ;;
          *) continue ;;
        esac
        ;;
    esac
    test -f "$ROOT/$path" || continue
    printf '%s\n' "$path" >> "$list"
    mkdir -p "$source/$(dirname "$path")"
    cp -p "$ROOT/$path" "$source/$path"
  done
  (
    cd "$source"
    while IFS= read -r path; do shasum -a 256 "$path"; done < "$list"
  ) > "$stage/MANIFEST.sha256"
  digest=$(local_sha256 "$stage/MANIFEST.sha256")
  snapshot_id="${stamp}-${digest:0:12}"
  printf '{"schema":"bitburner-go-source-snapshot-v1","id":"%s","manifestSha256":"%s"}\n' \
    "$snapshot_id" "$digest" > "$stage/SNAPSHOT.json"
  mkdir -p "$destination/$snapshot_id"
  mv "$stage/source" "$stage/MANIFEST.sha256" "$stage/SNAPSHOT.json" \
    "$destination/$snapshot_id/"
  archive="$destination/$snapshot_id.tar"
  test ! -e "$archive"
  COPYFILE_DISABLE=1 tar --no-xattrs -C "$destination" -cf "$archive" "$snapshot_id"
  local_sha256 "$archive" > "$archive.sha256"
  echo "$destination/$snapshot_id"
}

transfer_snapshot() {
  local directory=$1 snapshot_id archive expected remote_archive actual
  snapshot_id=$(basename "$directory")
  archive="$(dirname "$directory")/$snapshot_id.tar"
  test -f "$archive"
  expected=$(local_sha256 "$archive")
  wsl mkdir -p "$SCRATCH/incoming" "$SCRATCH/work"
  remote_archive="$SCRATCH/incoming/$snapshot_id.tar.partial"
  scp "$archive" "$HOST:D:/BitburnerCuda/incoming/$snapshot_id.tar.partial"
  actual=$(wsl sha256sum "$remote_archive" | awk '{print $1}')
  test "$actual" = "$expected"
  if wsl test -e "$SCRATCH/work/$snapshot_id"; then
    echo "remote snapshot already exists: $SCRATCH/work/$snapshot_id" >&2
    exit 1
  fi
  wsl tar -xf "$remote_archive" -C "$SCRATCH/work"
  wsl bash "$SCRATCH/work/$snapshot_id/source/go-ai/remote/wsl-verify-snapshot.sh" \
    "$SCRATCH/work/$snapshot_id"
  wsl chmod -R a-w "$SCRATCH/work/$snapshot_id"
  wsl rm "$remote_archive"
  echo "$SCRATCH/work/$snapshot_id"
}

put_blob() {
  local file=$1 digest target partial actual
  digest=$(local_sha256 "$file")
  target="$SCRATCH/cache/sha256/$digest"
  wsl mkdir -p "$SCRATCH/cache/sha256" "$SCRATCH/incoming"
  if wsl test -f "$target"; then
    actual=$(wsl sha256sum "$target" | awk '{print $1}')
    test "$actual" = "$digest"
    echo "$target"
    return
  fi
  partial="$SCRATCH/incoming/$digest.$$.partial"
  scp "$file" "$HOST:D:/BitburnerCuda/incoming/$(basename "$partial")"
  actual=$(wsl sha256sum "$partial" | awk '{print $1}')
  test "$actual" = "$digest"
  wsl ln "$partial" "$target"
  wsl chmod a-w "$target"
  wsl rm "$partial"
  echo "$target"
}

command=${1:-}
shift || true
case "$command" in
  snapshot) test $# -eq 1 || usage; snapshot "$1" ;;
  transfer-snapshot) test $# -eq 1 || usage; transfer_snapshot "$1" ;;
  put) test $# -eq 1 || usage; put_blob "$1" ;;
  setup) test $# -eq 1 || usage; wsl bash "$SCRATCH/work/$1/source/go-ai/remote/wsl-setup.sh" "$SCRATCH" "$1" ;;
  build) test $# -eq 1 || usage; wsl bash "$SCRATCH/work/$1/source/go-ai/remote/wsl-build.sh" "$SCRATCH" "$1" ;;
  launch)
    test $# -ge 4 || usage
    snapshot_id=$1
    run_name=$2
    shift 2
    test "$1" = -- || usage
    shift
    wsl bash "$SCRATCH/work/$snapshot_id/source/go-ai/remote/wsl-launch.sh" \
      "$SCRATCH" "$snapshot_id" "$run_name" "$@"
    ;;
  status) test $# -eq 1 || usage; wsl bash "$SCRATCH/work/$(wsl cat "$SCRATCH/runs/$1/SNAPSHOT_ID")/source/go-ai/remote/wsl-status.sh" "$SCRATCH" "$1" ;;
  collect)
    test $# -eq 2 || usage
    run_name=$1
    destination=$2
    snapshot_id=$(wsl cat "$SCRATCH/runs/$run_name/SNAPSHOT_ID")
    remote_archive=$(wsl bash "$SCRATCH/work/$snapshot_id/source/go-ai/remote/wsl-package-results.sh" "$SCRATCH" "$run_name")
    mkdir -p "$destination"
    test -z "$(find "$destination" -mindepth 1 -maxdepth 1 -print -quit)"
    archive="$destination/$run_name.results.tar"
    scp "$HOST:D:/BitburnerCuda/incoming/$run_name.results.tar" "$archive"
    expected=$(wsl sha256sum "$remote_archive" | awk '{print $1}')
    test "$(local_sha256 "$archive")" = "$expected"
    tar -C "$destination" -xf "$archive"
    (cd "$destination/$run_name" && shasum -a 256 -c RESULTS.sha256)
    echo "$destination/$run_name"
    ;;
  *) usage ;;
esac
