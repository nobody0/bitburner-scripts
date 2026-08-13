# V9 exhaustive proposal and value training

`train_v9.py` is the clean current trainer. The native sidecar emits the
original state, the semantic known-turn behavior vector, every legal Black move
plus pass, and every exact weighted White reply/branch. A frozen promoted value
teacher rates all reply boards. Those labels create a four-move coverage set:
one highest-expected-value safe anchor and three high-upside candidates,
preferentially spanning distinct enemy-response branches. The proposal never
shortlists its own supervision.

The known behavior signature conditions proposal and response-branch heads
only. Daemon19 post-reply value inference uses neutral behavior: by then the
predicted White reply has already consumed that seed, and its single fixed
opponent means value must average over future turn seeds rather than learn a
contradictory dependency on stale information. Small5 temporarily retains the
signature as opponent context because it spans several distinct future enemy
policies; replacing that proxy requires a separate stable policy descriptor.
Soft win utility is quadratic, matching the value of longer win streaks;
normalized Power per total turn remains linear and therefore prefers fewer
turns among equally winning lines.

Pointwise value imitation is supplemented by an optional exhaustive candidate
ranking loss (`--ranking-loss-weight`). It reconstructs each move's complete
reply distribution, applies quadratic win ordering first, and only applies a
linear Power/total-turn ordering inside teacher-equal win groups. This trains
the post-reply value head for the ordering it performs at deployment without
letting a quick loss outrank a slower win.

Candidate ranking is deliberately opt-in (`0` by default), so campaign commands
that intend joint training must set `--ranking-loss-weight` explicitly. Likewise,
`--pretrain-updates` is not inherently proposal-only: every loss with a nonzero
weight trains during replay pretraining. Spell out the proposal, MC value,
distillation, and ranking weights in durable experiment commands.
Long replay stages should also set `--pretrain-checkpoint-updates` (typically
500--1,000) so intermediate checkpoints and unseen recall are observable and a
regressing endpoint does not hide the useful part of its trajectory.

The shortlist objective has two simultaneous jobs: a four-move multilabel set
loss keeps one safe move plus diverse speculative/bait moves above outsiders,
while a separate exhaustive best-move cross-entropy term guarantees pressure
for the safe anchor itself to survive top K. The set margin uses the actual K
boundary: with four desired moves at K=8, the worst desired move competes with
the fifth-highest outsider, not the highest outsider. The stricter comparison
needlessly fought the safe anchor while optimizing an ordering deployment does
not require. Every desired move receives this boundary gradient; updating only
the current worst positive rotated slowly among four targets and plateaued far
below the whole-set gate. Proposal loss is vectorized across
the complete batch, and immutable corpus replay can be packed once and reused;
these avoid the per-position MPS reductions, parsing, and target reconstruction
that previously throttled daemon19 training.

`--proposal-anchor-weight` controls the separate safe-best cross-entropy
(default `0.5`). Keep it for ordinary joint training. A shortlist whose safe
recall already passes but whole-set recall plateaus may use a measured lower
anchor weight together with stronger set-margin pressure; this is an experiment,
not a reason to weaken the exhaustive promotion gates.

Replay stratification buckets are also constructed once per immutable update
group. Rebuilding pass/bait/ordinary buckets by scanning 100,000 Python objects
on every update starved both MPS and CUDA; caching the identical buckets raised
a measured small5 proposal-only Mac run from 16.8 to 118.4 updates/s without
changing sampled examples.

On the RTX 4090, daemon19 batch 512 used only about 1.36 GB peak allocation.
Batch 4096 sustained roughly 80--100% CUDA SM use with about 18--19.3 GB total
board memory in use and only about 1.3 host CPU cores after startup. This is the
preferred interactive-PC envelope; do not overlap it with exhaustive corpus
generation. A cold 256-game daemon corpus creates a roughly 2.5 GB packed cache
and can spend 1--2 minutes parsing and writing it with negligible GPU use.
Measure utilization only after `initialHeldout` is logged. Task Manager must
show a CUDA/compute engine rather than its default 3D graph; `nvidia-smi dmon`
is the authoritative spot check.

```sh
cmake --build go-ai/build/release -j 12

bun run go:train:v9 -- \
  --profile small5 \
  --teacher go-ai/small5-champion.model \
  --out-dir go-ai/runs/v9-small5-1 \
  --games 12288 --seed 2026081301 \
  --proposal-loss-weight 1 --mc-value-weight 1 --distill-weight 1 \
  --ranking-loss-weight 0.1 \
  --corpus-out go-ai/corpora/v9-small5-1.jsonl.gz

# Reuse the expensive exhaustive labels for another optimizer run.
bun run go:train:v9 -- \
  --profile small5 \
  --teacher go-ai/small5-champion.model \
  --out-dir go-ai/runs/v9-small5-rate-2 \
  --games 4096 --seed 2026081302 \
  --corpus-in go-ai/corpora/v9-small5-1.jsonl.gz \
  --pretrain-updates 2000 \
  --proposal-loss-weight 1 --mc-value-weight 1 --distill-weight 1 \
  --ranking-loss-weight 0.1
```

The shortlist gate requires at least 10,000 unseen positions. Complete-game
splitting and short 5x5 games mean 4,096 games are not enough (the 2026-08-13
champion refresh produced 5,251 unseen positions); use about 12,288 small5
games or combine multiple immutable fresh corpora. Check the actual count rather
than treating a game count as proof. A clean corpus-generation pass may use
`--updates-per-game 0`; its unchanged final model gives an unbiased champion
baseline before replay branches begin.

Corpus records pin schema, profile, frozen-teacher SHA-256, opponent oracle,
episode split, exhaustive set targets, regrets, and all branch targets.
Mismatches fail rather than mixing contradictory labels. Proposal minibatches
stratify pass-best and bait positions, the ones whose best move falls outside
the heuristic shortlist; branch loss inverse-weights the observed branch
frequency. Value replay is uniform by default; optional outcome/failure
balancing is diagnostic, because measured runs found it harmful. Proposal loss separates the complete desired set from outsiders,
but deliberately does not order the safe and upside positives against each
other. `summary.json` reports unseen safe-best, whole-set, upside, pass, and bait
recall, regret, C++ parity, and `shortlistDataAllowed`. `go:promote` refuses a V9
checkpoint unless that summary identifies the checkpoint hash and all recall
gates passed.

Only after that gate may V9 generate continuation trajectories:

```sh
bun run go:train:v9 -- \
  --profile daemon19 --teacher go-ai/daemon19-champion.model \
  --init go-ai/runs/v9-daemon-stage1/v9.model \
  --self-actor-summary go-ai/runs/v9-daemon-stage1/summary.json \
  --self-actor-fraction 0.5 --top-k 16 \
  --out-dir go-ai/runs/v9-daemon-stage2 \
  --games 4096 --seed 2026081303
```

The hash-checked actor is frozen for the whole stage and follows the deployed
proposal -> exact replies -> value sequence. A changed learner must pass a new
gate before it can drive a later stage. Remaining games stay on the frozen teacher for retention, and the
sidecar still emits exhaustive proposal/branch labels on every turn. Thus
continuation can improve the value policy without letting the shortlist erase
counterexamples or relabel its own misses.

`--replay-cache-dir` enables a content-addressed packed CPU tensor cache. It
precomputes compact board/legal planes plus proposal masks/targets/branches and
value targets, then performs bulk transfers for sampled batches. Its key pins
the ordered corpus SHA-256 list, accepted schemas, profile, teacher SHA-256,
opponent oracle, exact topology, encoding version, replay limits, and reservoir
seed. A present but incompatible payload is rejected. Corpus objects remain the
sampling authority, so stratification, reservoir selection, losses, optimizer
steps, and checkpoint text are unchanged. Reporting losses now synchronize
once per update group instead of four times per optimizer update.

Training summaries time corpus read/decompression, JSON/object construction,
corpus hashing, packed replay preparation, initial held-out evaluation,
pretraining, C++ environment generation, online updates, checkpoint
serialization, and neural/oracle evaluation separately. `endToEndSeconds`
(also reported as `elapsedSeconds`) starts before device/model/corpus setup;
`onlineTrainingSeconds` measures the online loop alone.

The maintained execution mode is FP32. Device selection is explicit:
`auto|cpu|mps|cuda`. AMP and `torch.compile` are not exposed because an initial
RTX 4090 FP16-autocast measurement was slower for this small topology; either
would require an independent checkpoint and C++/WebGPU parity campaign. CUDA
TF32 convolution/matmul is disabled because it exceeds the maintained C++
checkpoint-oracle tolerance; this keeps CUDA and MPS training numerically on
the same FP32 contract.

For read-only candidate evaluation, `evaluate_v9.py` uses MPS/CUDA for the
frozen V9 actor while the native sidecar retains exact rules, opponent replies,
and terminal rewards. This avoids using the deliberately scalar C++ reference
convolutions as a training-iteration benchmark.

After V9 itself becomes the promoted checkpoint it may also be supplied as the
next run's frozen `--teacher`. Its value head then reranks **every** exact reply
board; the policy head is not consulted for labels. This keeps later proposal
targets aligned with an improved value function without reintroducing shortlist
selection bias.

## 5x5 export-preparation distillation

`compress_v9.py` is the post-training structured-compression proof. It reads
the exhaustive V9 corpus only for states, exact shortlist targets, split, and
opponent-oracle provenance; all soft targets are recomputed from the exact
promoted V9 champion named by `--teacher`. Policy and auxiliary branch heads
are distilled on original positions. The value head is distilled separately
on the post-response positions used by production reranking, so selective-head
execution avoids training irrelevant heads on either batch.

Only complete dense structures are removed: a common residual channel set,
whole residual blocks, value-hidden neurons, and value-tower neurons. The
optional `--value-rank N` additionally replaces the first value matrix with two
dense factors; zero disables the feature. Both factors receive exporter-exact
row-q8 fake quantization during recovery. The saved `.model` contains their
reconstructed product for the independent C++ oracle, while the adjacent
`.factor` is the explicit WebGPU export input. Unstructured pruning is
intentionally absent because the shipped q8 format and WGSL kernels are dense.
Channels must remain divisible by four for the vectorized WebGPU path. The
stage has no installation side effect and currently rejects daemon19.

`--freeze-trunk=on` freezes the spatial trunk plus proposal/branch heads and
trains only the compressed value head. Combined with unchanged channels and
blocks, this makes proposal outputs bit-identical before q8 export and isolates
the lower-risk value-head reduction from spatial-capacity experiments.
Because the exact installed teacher has already passed promotion, exact top-K
retention inherits that qualification; absolute recall against the selected
corpus remains separately visible and cannot masquerade as a newly passed
candidate-generation gate.

Quantization-aware recovery is enabled by default and emulates the maintained
export format exactly: symmetric int8 per matrix row with a float32 scale and
float16 biases. Straight-through gradients update the underlying dense student;
the saved checkpoint contains the quantized forward values, so the subsequent
C++-checkpoint-to-q8-WebGPU gate measures shader/activation error rather than
an avoidable second quantization surprise.

Terminal value targets use raw Black score, halved on a loss. The immutable
opponent difficulty/Go Power multiplier is not an input or a learned target.
Small5 includes komi because it differs by opponent; daemon19 omits fixed komi.
Every exhaustive reply board also distills the frozen V9 teacher's value
outputs into the learner. Held-out episodes supply neither proposal nor
distillation/value gradients.

## Exactness and deployment handoff

V9 is the only trainable and deployable topology in this directory. The
trainer, the C++ sidecar, the exporter, and the runtime all read and write the
same checkpoint format.

The native sidecar remains authoritative for branch-heavy rules and opponent
behavior and is covered by `go_cpp_opponent_parity`. Every saved V9 checkpoint
is checked against `go_cpp_oracle value-v9`. These are training and correctness
boundaries, not runtime inference paths.

Training output is never installed directly. A candidate must pass its static
summary gate, exact-checkpoint-to-q8 WebGPU correctness, and the independent
complete-game Chrome/WebGPU promotion arena. Only `go:promote --apply` may
replace a champion; it also refreshes the runtime export and golden vectors.
