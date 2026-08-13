# Bitburner IPvGO neural trainer

The current paused model-training trajectory and retained restart artifacts are
recorded in [`TRAINING_CHECKPOINT.md`](TRAINING_CHECKPOINT.md). Read it before
starting a new campaign.

This isolated subtree trains neural policies for complete Bitburner IPvGO
games. Everything outside `go-ai/` is read-only reference material.

## Goals

1. Beat Bitburner's real, static faction AIs, not a generic or random Go
   player.
2. Learn an exhaustive move proposal on the original board, then rate the
   exact post-move/post-response boards only for its finalists.
3. Optimize complete-game wins first. Break equal-win ties with
   loss-penalized, unscaled Black score per total round.
4. Train on real generated starting boards and complete games, including
   captures, passes, offline nodes, and positional superko.
5. Let the learner eventually exceed the handcrafted teacher through
   learner-policy continuations and controlled state exploration.
6. Promote only checkpoints that improve on fixed, unseen complete-game
   corpora.

## Hard constraints

- The four values from the known WHRNG seed become semantic current-turn
  behavior features. The model does not receive an arbitrary seed integer or
  raw opponent identity.
- Only the current response is predictable. Every later simulated decision
  samples a fresh WHRNG phase.
- The exact outer rules engine handles legality and positional superko. V9
  receives the Black legal-placement plane, but never board
  history itself; the rules engine remains the sole legality authority.
- Offline cells and spatial padding use the same unplayable plane.
- Training and inference concern one game; streak state is deliberately absent.
- A loss multiplies raw Black score by `0.5`. The opponent difficulty/Go Power
  multiplier is retained only for reporting the actual game reward; it is
  absent from inputs, targets, move ranking, and promotion tie-breaks.
- Promotion is lexicographic: observed wins, then penalized normalized Black
  score/round on an exact win tie.

## V9 topology

V9 is the topology. Each profile has a full-resolution residual trunk and its
own promotion ladder; there is no shared max-19 compromise and no reduced
variant. The C++ tree, the trainer, the exporter, and the runtime all speak V9
and nothing else, so a checkpoint that loads anywhere loads everywhere.

| Profile | Shared trunk before late 5x5 pooling | Behavior features | Independent heads | Parameters | q8 artifact |
|---|---|---:|---|---:|---:|
| `small5` | 8 planes -> 32 channels -> 4 two-convolution residual blocks | 31 | value + 26 policy (training also has 26x13 branches) | 313,791 trained / 302,949 deployed | 306,654 B payload / ~410 KB module |
| `daemon19` | 8 planes -> 48 channels -> 8 two-convolution residual blocks | 30 | value + 362 policy (training also has 362x13 branches) | 689,551 trained / 673,301 deployed | 680,926 B payload / ~909 KB module |

The spatial trunk is shared because board understanding helps all tasks, but
the final heads are parallel. The trained outputs are:

- win probability, expected loss-penalized raw Black score, and remaining rounds;
- one proposal logit for every point plus pass;
- thirteen response-branch logits for every point plus pass.

The branch head is an auxiliary training target. Production already resolves
reachable branches exactly with the TypeScript rules engine, so export strips
its weights and WGSL never computes or copies its logits.

The conditioning vector describes the known selector behavior for this turn:
the exact smart/reckless bit, option/faction/fallback rolls, enabled priority
branches with their first semantic precedence, and the shared fallback mask.
Several branches may be enabled because the final executed branch still
depends on the board after Black's hypothetical move. The auxiliary 13-way
head is supervised with that exact candidate-dependent branch. Raw faction
identity is absent. Komi is included only for `small5`, where it varies across
opponents; World Daemon komi is fixed and therefore omitted.

Training always enumerates every legal placement plus pass, including all
roughly 300 legal 19x19 openings. A frozen exhaustive value teacher supplies a
listwise ordering and regret; exact opponent prediction supplies the weighted
branch target for every candidate. Proposal logits cannot prune their own
labels. Exhaustive corpora are versioned by profile, teacher SHA-256, and
opponent-oracle version and may be replayed across learning-rate runs.

Deployment evaluates the original board once per reachable seed, retains 8
finalists for either profile by default, expands the set when the boundary
is flat, and reserves candidates from each seed before averaging. Only those
finalists pay exact opponent prediction and post-response value evaluation.
`candidateLimit: Infinity` remains an exhaustive shadow mode. Promotion
requires 99.5% unseen top-K, pass, and (on daemon19) bait recall -- positions
whose best move falls outside the heuristic shortlist -- before a V9 checkpoint
may replace the champion.

## Rules and teacher parity

The C++ environment reproduces the pinned game implementation's board
generation, all seven faction move policies, WHRNG, captures, suicide, passes,
positional superko, scoring, and the World Daemon board. Differential tests
compare native moves and games with the copied TypeScript/upstream harness.
This includes the upstream priority-move edge case: if positional superko
invalidates the AI's chosen priority coordinate, Bitburner advances to Black
without changing the board and without counting a pass. Native trajectories
represent that as a distinct no-op rather than crashing or silently turning it
into a pass.

Every training stage teaches from a promoted V9 champion: `--teacher` accepts
a V9 checkpoint and rejects anything else, and `go_cpp_gpu_env` emits only the
`v9` record stream.

## Build and train

```sh
cmake --preset release -S go-ai
cmake --build go-ai/build/release -j 12
ctest --test-dir go-ai/build/release --output-on-failure

# Optional deterministic clean initial checkpoints (the trainer can also
# initialize internally).
go-ai/build/release/go_cpp_v9_init small5 8405001 \
  go-ai/runs/small5-v9-init.model
go-ai/build/release/go_cpp_v9_init daemon19 8419001 \
  go-ai/runs/daemon19-v9-init.model

# Exhaustive small5 labels and training.
bun run go:train:v9 -- \
  --profile small5 --teacher go-ai/small5-champion.model \
  --out-dir go-ai/runs/small5-v9-8505001 \
  --games 12288 --seed 8505001 --environments 256 --cpu-threads 12 \
  --proposal-loss-weight 1 --mc-value-weight 1 --distill-weight 1 \
  --ranking-loss-weight 0.1 \
  --corpus-out go-ai/corpora/small5-v9-8505001.jsonl.gz

# Exhaustive daemon19 labels. No 96-move training cap is applied.
bun run go:train:v9 -- \
  --profile daemon19 --teacher go-ai/daemon19-champion.model \
  --out-dir go-ai/runs/daemon19-v9-8519001 \
  --games 4096 --seed 8519001 --environments 128 --cpu-threads 12 \
  --top-k 16 \
  --proposal-loss-weight 1 --mc-value-weight 1 --distill-weight 1 \
  --ranking-loss-weight 0.1 \
  --corpus-out go-ai/corpora/daemon19-v9-8519001.jsonl.gz

# Reuse exhaustive labels for another initialization/rate without regenerating
# them. Schema/profile/teacher/oracle mismatches are rejected.
bun run go:train:v9 -- \
  --profile daemon19 --teacher go-ai/daemon19-champion.model \
  --out-dir go-ai/runs/daemon19-v9-rate2 \
  --games 4096 --seed 8519002 \
  --corpus-in go-ai/corpora/daemon19-v9-8519001.jsonl.gz \
  --pretrain-updates 2000 --top-k 16 \
  --proposal-loss-weight 1 --mc-value-weight 1 --distill-weight 1 \
  --ranking-loss-weight 0.1
```

The default unseen gate needs 10,000 positions, not a fixed number of games.
Because small5 games are short, use roughly 12,288 fresh games (or multiple
compatible corpora) and verify the reported held-out count. `--pretrain-updates`
executes every enabled loss, not just proposal loss; durable commands should
therefore state all task weights explicitly.

The sidecar owns rules, WHRNG, opponent behavior, and exhaustive reply labels;
PyTorch owns forward/backpropagation. Every checkpoint is checked against the
dependency-free C++ V9 oracle over a battery of deliberately non-degenerate
probes: mixed board cells, a legal mask uncorrelated with the board, nonzero
pass counts, each response flag alone, and sub-extent boards under `#` padding.
A uniform empty board would leave six of the eight input channels identically
zero and every plane spatially constant, so it cannot detect a permuted plane,
a dropped pass scaling, or a transposed board. Output directories must be
empty, so reruns cannot overwrite an existing experiment. See [`gpu/README.md`](gpu/README.md)
for corpus schema, loss/gate details, and the hash-gated V9 continuation actor
used only after exhaustive recall is demonstrated.

## Optional post-training compression

`go:compress:v9` is a separate, opt-in export-preparation stage. It does not
generate candidates, promote models, or use unstructured sparsity. It distills
the promoted full-size 5x5 champion into V9 students with fewer complete
channels and value-head neurons. An optional low-rank first value matrix can
remove another dense parameter block. These reductions directly reduce q8
bytes and executed WebGPU arithmetic; isolated zero weights would do neither
without a second sparse runtime. The proof deliberately excludes daemon19
until 5x5 demonstrates that the complete-game strength/latency trade is
worthwhile.

```sh
bun run go:compress:v9 -- \
  --profile small5 --teacher go-ai/small5-champion.model \
  --corpus-in go-ai/corpora/v9.4-small5-quadratic-b-20260813.jsonl.gz \
  --out-dir go-ai/runs/small5-compression-20260813 \
  --seed 2026081317 --time-budget-minutes 120
```

The default proof gives equal time to `32x4x224x56` and
`32x4x192x48` (`channels x blocks x hidden x tower`). It preserves the full
spatial trunk and proposal heads, then distills champion value outputs on
post-response boards. More aggressive channel/block compression remains
available through repeatable `--shape` plus enabled policy/branch/shortlist
objectives, but is not the maintained default. Each component has an explicit
`on|off` flag: `--structured-init`, `--distill-value`, `--distill-policy`,
`--distill-branches`, `--supervised-shortlist`, and `--freeze-trunk`.
The latter trains only the value head and exactly preserves proposal outputs,
which is useful when testing head-only compression. `--shape` is repeatable;
`--updates` replaces the wall-clock budget for deterministic tests.
`--quantization-aware=on` is the default: forward passes use the exporter's
exact symmetric row-q8 matrices and f16 biases with straight-through gradients,
so recovery includes the deployed storage error instead of discovering it only
at the browser gate.

`--value-rank N` factors the first value matrix as `hidden x N` and
`N x pooled`; `--value-rank 0` is the default and cleanly disables it. The
factor is trained under the same q8-aware distillation and emitted beside the
full reconstructed `.model` as `.factor`. Keeping a normal full V9 checkpoint
means the C++ oracle remains independent of this export optimization. Export
accepts the factor only when it reconstructs that checkpoint within `2e-5` and
records both source hashes in the generated artifact.

Static recall, teacher-agreement, C++ parity, parameter count, and exact
estimated artifact bytes are written beside every student. The smallest
passing student is copied to `export-candidate.model`, but this name is not an
approval: it still requires exporter inspection, candidate-specific
full-precision-to-WebGPU correctness, and the independent complete-game
WebGPU arena/promotion gate. A failed student remains an experiment and is
never installed automatically.

When the teacher hash is the exact installed champion and the compressed model
retains its top-K proposal set, the stage inherits the champion's already-won
shortlist qualification. It still reports the current corpus's absolute labels
separately. This matters for head-only compression: freezing the trunk makes
proposal outputs identical, even if a later corpus disagrees with the older
promoted champion. `--student-init ... --evaluate-only=on` re-evaluates an
existing student without retraining it.

For a static-gate-passing student, the read-only deployment proof is:

```sh
bun run go:compress:verify \
  go-ai/runs/small5-compression-20260813/export-candidate.model \
  --games 800 --seed 2026081329
```

For a run trained with `--value-rank N`, repeat the same command with
`--value-factor .../export-candidate.factor`, then compare it with the command
above. This is the required matched-checkpoint A/B comparison; the standard
champion export stays dense unless the factor is passed explicitly.

It transactionally exports the student, regenerates C++ golden outputs from
that exact full-precision checkpoint, runs the q8 production WGSL correctness
and latency gate, and compares champion/student complete games on the same
Chrome/WebGPU corpus. It restores the installed champion, artifact, and fixture
even on failure; only the separate promotion owner can install a result.

## Deployment

The game consumes promoted checkpoints through a derived artifact, never the
`.model` text directly. Each stage below has its own executable gate, so no
step in the chain is verified only by inspection.

**1. Promotion — is the candidate actually better in deployment?**
`bun run go:promote <small5|daemon19> <candidate.model> [--games N] [--seed N]`
exports champion and candidate in turn and replays the same fixed corpus in
Chrome through the production WGSL backend. CPU gameplay inference is not a
supported approximation. The gate applies this project's rule as code: more complete-game wins always wins,
and only an exact win tie is broken by higher loss-penalized normalized Black
score per round. For V9 it first requires the adjacent `summary.json` (or
`--summary`) to identify the checkpoint SHA-256 and pass the unseen exhaustive
top-K/pass/bait recall gates. A candidate that does not strictly improve exits
nonzero. `--apply` installs
the champion and immediately re-runs export, champion-oracle generation, and
the WebGPU gate, so checkpoint, artifact, and shader cannot drift apart.
Always gate on a fresh corpus seed.

**2. Export — narrow to a deployable artifact.**
`bun run go:export` reorders the promoted checkpoints for inference and writes
generated modules under `shared/strategy/go/neural/models/`. V9 uses the sole
row-wise-int8-weight/float16-bias format. The exporter validates that the
checkpoint extent matches its profile and prints the topology, parameter count,
chosen encoding and rationale, payload/module sizes, float32 reduction, and
source/payload SHA-256 hashes. V9's generated modules are about 424 KB for
small5 and 931 KB for daemon19. The format expands once to
one contiguous shader upload allocation when their profile is first used, so
compression adds no arithmetic to a turn. Writes replace each module atomically.
`bun run go:export --check` fails when a generated
artifact, its source digest, or its payload digest is stale.

For a new candidate, inspect the automatic decision before changing the
worktree:

```sh
bun run go:export --inspect
bun run go:export path/to/checkpoint.model small5 --inspect
```

The first command reports both promoted champions; the second reports one
checkpoint using the automatic profile policy. Encoding overrides deliberately
do not belong in this maintained exporter: compare alternative formats in an
isolated experiment, record the complete-game evidence, and update the profile
policy only when that evidence changes. Only the exported-candidate WebGPU
arena in `go:promote` can establish that the compressed model retained strength.

The normal handoff for a trained candidate is therefore:

```sh
# 1. Non-writing topology, storage, size, and provenance report.
bun run go:export path/to/checkpoint.model small5 --inspect

# 2. Independent complete-game gate. Use a fresh seed; --apply copies the
#    winner to the champion path and runs export/oracle/WebGPU gates.
MODEL_GATE_SEED=1209000001 # replace for each real promotion
bun run go:promote small5 path/to/checkpoint.model --games 4800 \
  --seed "$MODEL_GATE_SEED" --summary path/to/summary.json --apply

# 3. Final repository checks.
bun run go:export --check
bun run typecheck && bun test
```

Calling `go:export <checkpoint> <profile>` without `--inspect` writes that
profile's maintained module and is intended for pipeline/debugging use. It is
not a substitute for promotion; ordinary model handoff should use
`go:promote --apply`, which first installs the accepted checkpoint at the
stable champion path and then exports from there.

**3. Champion oracle — measure export and shader error together.**
`bun run go:golden` (needs `go_cpp_oracle`) regenerates
`tests/fixtures/go-value.json` with `go_cpp_oracle value-v9` directly from the exact full-precision promoted
V9 checkpoints: value outputs plus every move and response-branch logit for 14
boards spanning behavior-conditioned small5 cases, offline-heavy positions,
and sub-extent padding. The fixture records both champion hashes. WebGPU then
runs the q8 artifacts, so the gate measures quantization and shader error
together. It requires at least 99.9% proposal-element agreement within the
declared q8 tolerance and 99% top-8 agreement; the current deployed heads
achieve 100% and 100% respectively.

**4. Inference — one TypeScript backend.**
`shared/strategy/go/neural/` keeps the exact rules and the clean-room reply
model in TypeScript and batch-evaluates the retained candidates' result boards
through the WGSL compute shader over WebGPU, with weights resident in VRAM.
The default shader reuses convolution kernels through workgroup memory,
accumulates channel groups as `vec4<f32>`, and stores trunk activations as f16
while retaining f32 accumulation and outputs. The three switches are exposed
independently for controlled comparisons:

```sh
bun run go:gpu -- --workgroupCache=off --vectorizedChannels=off --f16Activations=off
```

There is no TypeScript CPU implementation or fallback: missing or lost WebGPU
fails the Go turn explicitly. C++ inference is used only as the independent
full-precision correctness oracle outside the game.

**5. Shader gate — the deployed path, executed.**
`bun run go:gpu` runs the real WGSL in headless Chrome (Dawn, the same WebGPU
family as Bitburner's Electron) against the step-3 vectors: every case and
every deployed value and policy output, plus batch-versus-single equality, buffer
capacity growth past 512 boards, cold decode time, and dispatch latency. `tests/go-webgpu.test.ts`
runs the same gate inside `bun test`; missing Chrome or WebGPU is a failure,
not a skip. `bun run go:gpu -- --arena` additionally plays complete oracle games
through the same WebGPU backend. Continuation-board calls use a compact
value-only dispatch: the policy head is skipped and only three floats per
board are copied back.

**6. Winrate and latency — refit the priors.**
`bun run go:arena` runs the Chromium/WebGPU policy against the vendored upstream
AI. `sim/tests/go-selection.test.ts` holds `GO_REWARD_RULES` in
`shared/strategy/go/rewards.ts` to those measurements, so **every promotion
must be followed by a refit**: opponent selection, board-size choice, and the
whole BitNode route are priced from these numbers.

Reply prediction itself is gated separately and continuously: the ctest target
`go_cpp_opponent_parity` replays complete games and requires the C++ forecast,
the TypeScript clean-room forecast, and the actual vendored upstream AI move to
agree turn by turn, across every faction, board size, and the World Daemon.

See [BASELINES.md](BASELINES.md) for the current promotion results and
[STARTING_STATES.md](STARTING_STATES.md) for the opening census.
