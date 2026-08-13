# One-time Windows CUDA worker setup

Read this when creating or repairing the worker. For ordinary source syncs and
runs, use [`MAC_TO_WINDOWS_HANDOFF.md`](MAC_TO_WINDOWS_HANDOFF.md).

The worker is WSL2 Ubuntu reached from the Mac with `ssh windows-desktop` and
is confined to `D:\BitburnerCuda` (`/mnt/d/BitburnerCuda`). Do not modify
Windows services, drivers, SSH, another checkout, or anything outside that
scratch root. The Mac worktree is authoritative; Git is never transport.

Install the WSL prerequisites once:

```sh
ssh -t windows-desktop wsl.exe -d Ubuntu -- sudo apt-get update
ssh -t windows-desktop wsl.exe -d Ubuntu -- \
  sudo apt-get install -y build-essential cmake ninja-build python3-venv
```

Then, from the Mac repository root, create the first immutable source snapshot,
install the isolated Python environment, and build/test its C++ sidecar:

```sh
SNAPSHOT_DIR=$(go-ai/remote/worker.sh snapshot /tmp/bitburner-v9-snapshots)
SNAPSHOT_ID=$(basename "$SNAPSHOT_DIR")
go-ai/remote/worker.sh transfer-snapshot "$SNAPSHOT_DIR"
go-ai/remote/worker.sh setup "$SNAPSHOT_ID"
go-ai/remote/worker.sh build "$SNAPSHOT_ID"
```

`setup` creates `/mnt/d/BitburnerCuda/venv` from `gpu/requirements.txt` and
records versions under `setup/`. Confirm that its JSON reports CUDA available
and an RTX 4090. `build` creates a snapshot-specific build, runs all CTests, and
hashes the sidecar/oracle binaries. Stop if credentials become interactive
beyond WSL sudo, CUDA is unavailable, or any required path leaves the scratch
root.

The worker was last validated with Python 3.12.3, PyTorch 2.13.0+cu130, CMake
3.28.3, Ninja 1.11.1, and an RTX 4090. FP32 is maintained; TF32 is disabled and
AMP/`torch.compile` are not defaults.
