# Mac + WSL CUDA worker

The Mac worktree is the sole source of truth. The Windows worker is disposable
compute rooted entirely at `D:\BitburnerCuda` (`/mnt/d/BitburnerCuda` in WSL).
No Git command is used for transport, and a remote workspace is never copied
back wholesale.

## Authoritative V9 phases

The current accelerator path is `gpu/train_v9.py`: exhaustive C++ environment
generation and opponent replies, frozen-teacher evaluation, packed replay,
PyTorch pretraining/online updates, portable text checkpoints, and C++ parity.
`gpu/compress_v9.py` is optional small5 distillation/compression. Read-only
`tools/go-screen-v9.ts` is the strict candidate screen, followed by production
Chrome/WebGPU correctness and arena gates on the Mac. The final promotion
decision also stays on the Mac and this workflow never invokes promotion.

Stable parallel boundaries are whole replay/pretraining jobs, compression
jobs, candidate evaluations, seed shards, or independent checkpoint branches.
Never average checkpoints and never run networked distributed SGD. CUDA owns
large tensor work and its local C++ sidecar; the Mac owns exact CPU shards,
strict screens, Chrome/WebGPU gates, orchestration, and final promotion.

On a concurrently used Windows host, exhaustive sidecar generation should use
only 6--8 CPU threads. It is inherently bursty on the GPU; overlap at most one
packed-replay training job to fill CUDA rather than increasing sidecar threads
until Windows becomes unresponsive. Measure sustained utilization after the
replay cache is built—the corpus parse/cache-build phase is CPU-heavy.

## Setup and commands

Inside Ubuntu, install one-time prerequisites if absent:

```sh
sudo apt-get update
sudo apt-get install -y build-essential cmake ninja-build python3-venv
```

All remaining commands run on the Mac at the repository root. Environment
variables can override `windows-desktop`, `Ubuntu`, and
`/mnt/d/BitburnerCuda`.

```sh
SNAPSHOT_DIR=$(go-ai/remote/worker.sh snapshot /tmp/bitburner-v9-snapshots)
SNAPSHOT_ID=$(basename "$SNAPSHOT_DIR")
go-ai/remote/worker.sh transfer-snapshot "$SNAPSHOT_DIR"
go-ai/remote/worker.sh setup "$SNAPSHOT_ID"
go-ai/remote/worker.sh build "$SNAPSHOT_ID"

# Immutable, content-addressed inputs; each hash is transferred once.
CORPUS=$(go-ai/remote/worker.sh put go-ai/corpora/v9.4-daemon19-example.jsonl.gz)
TEACHER=$(go-ai/remote/worker.sh put go-ai/daemon19-champion.model)
INIT=$(go-ai/remote/worker.sh put go-ai/runs/example/v9.model)

RUN=daemon19-cuda-$(date -u +%Y%m%dT%H%M%SZ)
go-ai/remote/worker.sh launch "$SNAPSHOT_ID" "$RUN" -- \
  /mnt/d/BitburnerCuda/venv/bin/python gpu/train_v9.py \
  --profile daemon19 --teacher "$TEACHER" --init "$INIT" \
  --out-dir "/mnt/d/BitburnerCuda/runs/$RUN/output" \
  --environment "/mnt/d/BitburnerCuda/build/$SNAPSHOT_ID/go_cpp_gpu_env" \
  --oracle "/mnt/d/BitburnerCuda/build/$SNAPSHOT_ID/go_cpp_oracle" \
  --device cuda --games 4096 --seed 8519002 --environments 128 \
  --cpu-threads 12 --batch-size 512 --teacher-batch 16384 --top-k 16 \
  --corpus-in "$CORPUS" --pretrain-updates 2000 \
  --replay-cache-dir /mnt/d/BitburnerCuda/cache/replay-v9

# Read-only status; it checks the PID, GPU counters, and log tails.
go-ai/remote/worker.sh status "$RUN"

# Run only after completion. Destination must be a new empty Mac directory.
go-ai/remote/worker.sh collect "$RUN" "go-ai/remote-results/$RUN"
```

The snapshot includes current tracked and untracked source but excludes Git
data, corpora, models, runs, collected remote results, builds, venvs, and bytecode. It is verified file by
file and made read-only. Collection returns only models, JSON, logs, timing
text, generated gzip JSONL corpora, and manifests, then verifies every
downloaded hash. Put `--corpus-out` beneath the run's output directory; files
written elsewhere are intentionally outside collection scope.

`--device` accepts only `auto`, `cpu`, `mps`, or `cuda`. FP32 is maintained.
AMP and `torch.compile` are intentionally not exposed: FP16 autocast was slower
in the preliminary RTX 4090 test, and either option needs an independent
training plus C++/WebGPU parity campaign before it is safe. CUDA TF32 is also
disabled because its convolution error fails the maintained C++ oracle.

Training is V9-only. `--teacher` must be the matching promoted V9 champion;
legacy frozen V7 teachers and V7/V8 sidecar streams are rejected.

Every training summary records full startup-to-finish time, phase timings,
corpus/teacher hashes, replay-cache identity, batch sizes, versions,
accelerator memory, CPU consumption, and throughput. A cache is accepted only
when corpus hashes/schema, profile, teacher hash, opponent oracle, topology,
encoding version, replay limits, and reservoir seed all match.

Portable-checkpoint acceptance is stricter than benchmark repeatability. Every
checkpoint must load and resume on both MPS and CUDA and remain below the
maintained C++ oracle's `2e-4` maximum relative-error limit. Deterministic
sidecar benchmark work counts may differ slightly between standard libraries;
record the exact count and binary hash, normalize throughput by candidates,
and reject a comparison if the work-count drift reaches `0.1%`.
