# Mac to Windows CUDA handoff

Read [`TRAINING_CHECKPOINT.md`](TRAINING_CHECKPOINT.md) first for the current
champions, retained research warm starts, priorities, and known trajectory.

Read this whenever assigning work to Windows. For one-time environment setup,
see [`MAC_TO_WINDOWS_SETUP.md`](MAC_TO_WINDOWS_SETUP.md); exact command details
live in [`remote/README.md`](remote/README.md).

Use Windows for long, tensor-heavy V9 jobs. Keep orchestration and mixed
CPU/GPU gates on the authoritative Mac. Daemon19 pretraining measured 3.77x
faster on the RTX 4090, but its C++ sidecar tied the M2 Max and a small cold
CUDA run was slower because WSL startup and corpus loading dominated.

Fresh exhaustive corpus generation is not a GPU-saturation workload. Exact
candidate/reply enumeration is CPU-bound and feeds frozen-teacher CUDA batches
in bursts, so Task Manager shows a sawtooth GPU graph even with substantial
VRAM allocated. When the PC is also in interactive use, cap generation at
6--8 CPU threads and avoid enough environments to saturate the host. Overlap it
with one replay-pretraining job: packed replay sustains the 4090 while adding
little steady CPU pressure after its one-time corpus parse/cache build.

## What to hand off first

- Large small5 or daemon19 replay-pretraining runs.
- Compression, distillation, and large batched candidate evaluation.
- Independent seed shards or candidate branches that start from an immutable
  checkpoint. Never average their checkpoints.

Keep these on the Mac:

- Exact CPU corpus/evaluation shards and short runs.
- Strict candidate screening, C++/TypeScript/WebGPU correctness checks, and
  production Chrome/WebGPU arenas.
- Promotion decisions and all use of `go:promote`.
- Work that repeatedly alternates small CPU and GPU phases.

## Preferred two-model cadence

Pipeline the two profiles instead of waiting on one end to end:

1. Pretrain daemon19 on CUDA while the Mac screens the latest small5 candidate.
2. Return only daemon19 models, summaries, logs, timings, and manifests.
3. Start small5 pretraining on CUDA while the Mac screens daemon19.
4. Repeat with new immutable snapshots and uniquely named runs.

This keeps the 4090 on sustained batches while the Mac advances exact gates. A
failed screen starts a new candidate branch; it never authorizes averaging.

## Sync current Mac source first

Never reuse an old snapshot after `.py`, `.cpp`, tests, or launchers change.
Snapshot the current tracked **and untracked** Mac source, transfer it, and
build it without Git:

```sh
SNAPSHOT_DIR=$(go-ai/remote/worker.sh snapshot /tmp/bitburner-v9-snapshots)
SNAPSHOT_ID=$(basename "$SNAPSHOT_DIR")
go-ai/remote/worker.sh transfer-snapshot "$SNAPSHOT_DIR"
go-ai/remote/worker.sh build "$SNAPSHOT_ID"
```

The manifest is verified before the snapshot becomes read-only under
`/mnt/d/BitburnerCuda/work/<snapshot-id>`. Never edit a remote snapshot; make a
new one. Run `setup "$SNAPSHOT_ID"` first only when Python requirements change
or the environment needs repair.

## Handoff procedure

1. Transfer each selected corpus, V9 teacher, and initial checkpoint with
   `remote/worker.sh put`. Inputs are stored once by SHA-256 under
   `/mnt/d/BitburnerCuda/cache/sha256/<hash>`.
2. Launch a unique run with `--device cuda`, durable logs, explicit input
   hashes, and a replay cache. Use enough updates to amortize startup: roughly
   2,000 measured 3x faster end to end; 20 cold updates were slower than Mac.
   Treat initial JSON parsing/cache construction and exact online generation as
   CPU phases, not evidence that CUDA batch sizing is too small. Confirm GPU
   utilization during the reported `pretraining` phase before tuning batches.
   Set `--pretrain-checkpoint-updates 500` or `1000` on long jobs so the Mac can
   screen useful trajectory points instead of receiving only the endpoint.
   A cold daemon19 packed cache can be several gigabytes: a measured 256-game
   corpus produced a 2.5 GB cache and delayed CUDA work by roughly 1--2 minutes.
   Wait for the `initialHeldout` log line before judging accelerator load.
   Daemon19 batch 4096 then sustained roughly 80--100% CUDA SM utilization on
   the RTX 4090 while the Python process used about 1.3 CPU cores. It occupied
   roughly 18--19.3 GB of total board memory, leaving enough headroom for light
   desktop use but not for a concurrent exhaustive generator.
3. Inspect with read-only `status`. After completion, `collect` into a new empty
   Mac directory; it returns only result artifacts (including a generated
   `*.jsonl.gz` beneath the run output) and verifies their hashes.
4. Load and parity-check the returned text checkpoint on the Mac before
   screening it. MPS and CUDA checkpoints use the same portable text format.

## Boundaries and expectations

- FP32 is the maintained mode. CUDA TF32 is disabled for parity; AMP and
  `torch.compile` are not defaults.
- Current training is V9-only: `--teacher` must be the matching promoted V9
  champion. Legacy frozen V7 teachers and V7/V8 sidecar streams are rejected.
- Every checkpoint must remain below the C++ oracle's `2e-4` maximum relative
  error. Small cross-platform training drift is expected; observed loss drift
  was below `4e-7` relative and checkpoint parity was about `1e-6`.
- Do not use Git for transport, synchronize the remote workspace back, touch
  another Windows checkout, overwrite a run, or run promotion with `--apply`.
- Do not send short CPU-heavy or screening tasks merely because CUDA is idle.
  A good handoff keeps CUDA on sustained batches while Mac screening proceeds.
