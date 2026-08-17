# V9 profiling

Profiling measures the maintained pipeline without creating a training
candidate. Use the current champion and a retained corpus from
[`TRAINING_CHECKPOINT.md`](TRAINING_CHECKPOINT.md), zero learning rate, bounded
replay caps, and a disposable output directory.

## Sidecar attribution

```sh
go-ai/.venv-gpu/bin/python go-ai/gpu/benchmark_v9_sidecar.py \
  --profile small5 --seed 2026081401 --blocks 8 \
  --environments 32 --cpu-threads 12

go-ai/.venv-gpu/bin/python go-ai/gpu/benchmark_v9_sidecar.py \
  --profile daemon19 --seed 2026081401 --blocks 2 \
  --environments 4 --cpu-threads 12
```

Record binary SHA, positions, candidates, replies, protocol bytes, candidate
generation, opponent analysis, serialization, pipe wait, and parse time.
Normalize throughput by actual work count before comparing machines.

## Pipeline attribution

```sh
bun run go:profile:v9 -- \
  --profile PROFILE --teacher go-ai/PROFILE-champion.model \
  --corpus-in CURRENT_CORPUS --seed PROFILE_SEED --device DEVICE \
  --batch-size BATCH --updates 10 --profile-detail
```

The benchmark executes the real replay, losses, backward pass, clipping, and
optimizer path with zero learning rate and retains no candidate. Detailed
profiling synchronizes accelerator boundaries and is not a training-throughput
mode.

## Comparison rules

- Build a fresh immutable WSL snapshot after native, Python, or launcher
  changes.
- Transfer the same champion and corpus hashes; do not copy packed caches
  between operating systems.
- Keep `PYTORCH_CUDA_ALLOC_CONF=expandable_segments:True` on CUDA.
- Compare cold parse/cache construction separately from warm replay steps.
- Measure checkpoint-evaluation peak memory, not only steady training steps.
- Require sampled losses within established FP32 cross-platform tolerance and
  C++ parity below `2e-4`.

On the 24 GB RTX 4090, batch 3072 is the upper measured envelope for homogeneous
daemon replay. Mixed proposal/ranking/value work should begin lower. Prefer the
largest batch that improves updates/second, keeps reserved memory below 20 GB,
and leaves enough host CPU for an interactive Windows session.

Profiling results may choose scheduling and batch size. They do not authorize a
loss change, checkpoint retention, arena, or promotion.
