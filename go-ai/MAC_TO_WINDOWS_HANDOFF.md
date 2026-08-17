# Mac to Windows CUDA handoff

The Mac worktree is authoritative. Windows/WSL is disposable CUDA compute; it
never promotes a champion and its workspace is never synchronized back.

Read [`TRAINING_CHECKPOINT.md`](TRAINING_CHECKPOINT.md) for the current inputs
and active run, [`MAC_TO_WINDOWS_SETUP.md`](MAC_TO_WINDOWS_SETUP.md) for
one-time setup, and [`remote/README.md`](remote/README.md) for commands.

## Responsibilities

Use Windows for sustained tensor-heavy training, large batched evaluation, and
independent rollout shards. Keep corpus composition, KataGo/certified exports,
C++/TypeScript/WebGPU correctness gates, production arenas, and promotion on
the Mac.

Do not send short CPU-heavy work merely because CUDA is idle. Exact sidecar
enumeration is CPU-bound and naturally produces bursty GPU use. On an
interactive PC, keep generation at 6–8 CPU threads and overlap at most one
packed-replay training job.

## Snapshot and build

Create a new snapshot whenever source, tests, launchers, or native code changes:

```sh
SNAPSHOT_DIR=$(go-ai/remote/worker.sh snapshot /tmp/bitburner-v9-snapshots)
SNAPSHOT_ID=$(basename "$SNAPSHOT_DIR")
go-ai/remote/worker.sh transfer-snapshot "$SNAPSHOT_DIR"
go-ai/remote/worker.sh build "$SNAPSHOT_ID"
```

Snapshots contain tracked and untracked source, are hash-verified, and become
read-only. Models and corpora are transferred separately into the remote
content-addressed cache with `worker.sh put`.

## Launch discipline

- Use a unique run name and explicit hashes for corpus, teacher, and init.
- Use `--device cuda` and a replay cache under the remote cache root.
- Keep `PYTORCH_CUDA_ALLOC_CONF=expandable_segments:True`.
- Use periodic checkpoints for any run long enough to cross a likely optimum.
- Inspect `initialHeldout` before judging utilization; parsing and cache builds
  are CPU-heavy startup phases.
- Never average checkpoints or run networked distributed SGD.

Batch 3072 is the measured safe upper envelope for homogeneous daemon19 replay
on the 24 GB RTX 4090. Mixed proposal/ranking/value work should begin lower and
be sized from checkpoint-evaluation peak memory, not steady-state steps.

## Monitor and collect

```sh
go-ai/remote/worker.sh status "$RUN"
go-ai/remote/worker.sh collect "$RUN" "go-ai/remote-results/$RUN"
```

`status` is read-only. Collect only after completion, into a new empty local
directory. Collection verifies returned hashes and includes models, summaries,
logs, manifests, and gzip JSONL files written under the run output directory.

After collection, verify checkpoint SHA, load it locally, and run C++ parity
before any screen. CUDA and MPS share the portable full-f32 text format. TF32,
AMP, and `torch.compile` are outside the maintained parity contract.

## Boundaries

- Never use Git for transport.
- Never edit an immutable remote snapshot.
- Never overwrite a run or collection directory.
- Never launch `go:promote --apply` on Windows.
- Never reuse stale replay tensors after a corpus/schema/teacher/encoding
  mismatch; create a new cache entry through the normal keying path.
