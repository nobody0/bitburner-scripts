# WSL CUDA worker

`worker.sh` transports immutable Mac source snapshots and content-addressed
inputs to `/mnt/d/BitburnerCuda`, launches durable WSL jobs, reports status, and
collects verified result archives. The Mac remains the source of truth.

## Standard flow

```sh
SNAPSHOT_DIR=$(go-ai/remote/worker.sh snapshot /tmp/bitburner-v9-snapshots)
SNAPSHOT_ID=$(basename "$SNAPSHOT_DIR")
go-ai/remote/worker.sh transfer-snapshot "$SNAPSHOT_DIR"
go-ai/remote/worker.sh setup "$SNAPSHOT_ID"   # only when requirements changed
go-ai/remote/worker.sh build "$SNAPSHOT_ID"

CORPUS=$(go-ai/remote/worker.sh put go-ai/corpora/current.jsonl.gz)
TEACHER=$(go-ai/remote/worker.sh put go-ai/daemon19-champion.model)
INIT=$(go-ai/remote/worker.sh put go-ai/daemon19-champion.model)

RUN=daemon19-cuda-$(date -u +%Y%m%dT%H%M%SZ)
go-ai/remote/worker.sh launch "$SNAPSHOT_ID" "$RUN" -- \
  /mnt/d/BitburnerCuda/venv/bin/python gpu/train_v9.py \
  --profile daemon19 --teacher "$TEACHER" --init "$INIT" \
  --corpus-in "$CORPUS" --device cuda \
  --out-dir "/mnt/d/BitburnerCuda/runs/$RUN/output"

go-ai/remote/worker.sh status "$RUN"
go-ai/remote/worker.sh collect "$RUN" "go-ai/remote-results/$RUN"
```

Use `train_v9.py --help` and a current successful `COMMAND.txt` for the complete
experiment flags. Never copy hashes or paths from an unrelated run.

## Guarantees

- Snapshots include current tracked and untracked source, exclude generated
  corpora/models/results/caches, are verified file-by-file, and are read-only.
- Inputs are cached by SHA-256.
- Run names and collection destinations must be new.
- The launcher streams unbuffered logs and defaults PyTorch CUDA allocation to
  expandable segments.
- Collection returns only whitelisted result artifacts beneath the run output
  and verifies their hashes.

The worker does not run promotion, mutate Mac champions, synchronize a WSL
workspace back, or weaken full-f32/C++ parity requirements.
