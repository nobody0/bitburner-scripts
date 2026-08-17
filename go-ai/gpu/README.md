# V9 GPU training

Python owns replay construction, optimization, checkpointing, diagnostics, and
C++ numerical parity. Read [`../TRAINING_CHECKPOINT.md`](../TRAINING_CHECKPOINT.md)
before running this directory; it names the only current corpora and candidate.

## Maintained entry points

- `train_v9.py`: full-f32 V9 training and bounded head/trunk updates.
- `validate_corpus.py`: semantic, provenance, duplicate, and split-leakage gate.
- `compose_corpus.py`: route/component-safe composition and stratified split.
- `evaluate_v9.py`: checkpoint diagnostics and parity evidence.
- `benchmark_v9_pipeline.py` / `benchmark_v9_sidecar.py`: zero-update profiling.
- `compress_v9.py`: post-promotion Small5 derivative work; not training
  authority.
- `serve_v9_backend.py`: TypeScript teacher/export bridge.

Use `--help` for the exact current CLI. Commands copied from an old result are
valid only after checking their corpus, teacher, snapshot, and timing hashes.

## Data path

The trainer consumes immutable V9.5 JSONL gzip snapshots. Each record carries
profile, split, neural input, authority, and route/environment provenance.
Sources have different authority:

- KataGo: actor actions or good-move sets;
- certified/handcrafted: opponent-conditioned actor and completed exploit
  continuations;
- champion: retention and reachable student states.

KataGo actions never imply KataGo value targets. Actor rankings are relative
post-reply comparisons and never become fabricated absolute outcomes. Terminal
values require a completed continuation with its true rollout author.

Before training any set, compose all contributing shards together and validate
the resulting snapshot:

```sh
bun run go:compose:corpus -- --output OUTPUT.jsonl.gz INPUT.jsonl.gz [...]
bun run go:validate:corpus -- OUTPUT.jsonl.gz
```

Acceptance requires zero proposal/value split overlap, semantic duplicates,
errors, and warnings. Composition connects complete routes through shared f32
proposal/value inputs, paired environment IDs, and continuation families. Do
not split independent files separately or repair an incompatible encoding.

## Optimization contract

The student proposes Black actions on the original board. Any value/ranking
supervision is computed from the state after Black's candidate and the exact
White response. The greedy post-Black board is never a value target.

The value outputs represent win probability, terminal loss-penalized Black
Power, and remaining turns. Candidate order is wins first, then expected Power
per total turn, then fewer turns. A zero value head must be explicitly and
deterministically initialized before value/ranking training; `train_v9.py`
refuses an inert all-zero multilayer head.

Teacher recall, exact top-K, ranking agreement, and value errors diagnose a
specific treatment. Falling training loss is not selection authority. Preserve
immutable periodic checkpoints and screen the first diagnostic-qualified point
rather than assuming the endpoint is best.

## Profile contracts

### daemon19

Production is strict K=1. Train policy corrections against independent
student-root evidence, while retaining KataGo/general states. Do not spend
capacity on a finalizer unless a separate paired experiment first proves that
K>1 beats the frozen K=1 champion.

### Small5

Production is K=4 with exact White replies and round-two finalization. Certified
playbook actor labels are behavior-conditioned exploit authority, not general
Go. Preserve KataGo/champion retention and judge the resulting checkpoint under
the full K=4 deep selector.

## Windows CUDA workflow

Use [`../remote/worker.sh`](../remote/worker.sh) and the procedure in
[`../MAC_TO_WINDOWS_HANDOFF.md`](../MAC_TO_WINDOWS_HANDOFF.md). The RTX 4090
worker runs immutable snapshots and content-addressed inputs. Keep
`PYTORCH_CUDA_ALLOC_CONF=expandable_segments:True`; heterogeneous V9 batches
otherwise retain excessive fixed CUDA segments.

The Mac remains authoritative for corpus assembly, exact TypeScript/KataGo
work, WebGPU arenas, and promotion. Collected checkpoints use the portable text
format and must pass local C++ parity before screening.

## Candidate ladder

1. State a falsifiable mechanism and matched control.
2. Validate immutable treatment/control corpora together.
3. Train a bounded update with periodic checkpoints.
4. Require the treatment-specific held-out diagnostic to improve without
   destroying retention.
5. Run a fresh production WebGPU screen.
6. Spend the full promotion gate only on a qualified candidate.

Apply promotion only through `bun run go:promote --apply`. Native play, training
loss, held-out ranking, or CPU inference cannot replace the production arena.

## Tests

```sh
go-ai/.venv-gpu/bin/python -m pytest go-ai/gpu
bun run typecheck
bun test
```

For a candidate, also run the recorded C++ parity command, full-f32 golden
fixture, production WGSL gate, and profile-correct arena.
