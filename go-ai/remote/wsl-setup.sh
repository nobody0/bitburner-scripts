#!/usr/bin/env bash
set -euo pipefail

scratch=$1
snapshot_id=$2
source_root="$scratch/work/$snapshot_id/source"
venv="$scratch/venv"
mkdir -p "$scratch/setup"
if test ! -x "$venv/bin/python"; then
  python3 -m venv "$venv"
fi
"$venv/bin/python" -m pip install --upgrade pip
"$venv/bin/python" -m pip install -r "$source_root/go-ai/gpu/requirements.txt"
record="$scratch/setup/$(date -u +%Y%m%dT%H%M%SZ)-$snapshot_id"
mkdir "$record"
cmake --version > "$record/cmake.txt"
ninja --version > "$record/ninja.txt"
if test -x /home/peter/.bun/bin/bun; then
  /home/peter/.bun/bin/bun --version > "$record/bun.txt"
fi
"$venv/bin/python" -m pip freeze > "$record/pip-freeze.txt"
"$venv/bin/python" - <<'PY' > "$record/torch.json"
import json, torch
print(json.dumps({
    "torch": torch.__version__,
    "cudaAvailable": torch.cuda.is_available(),
    "cuda": torch.version.cuda,
    "device": torch.cuda.get_device_name(0) if torch.cuda.is_available() else None,
}))
PY
sha256sum "$record"/* > "$record/MANIFEST.sha256"
cat "$record/torch.json"
