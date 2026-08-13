# Bitburner IPvGO neural trainer

This isolated subtree trains neural policies for complete Bitburner IPvGO
games. Everything outside `go-ai/` is read-only reference material.

## Goals

1. Beat Bitburner's real, static faction AIs, not a generic or random Go
   player.
2. Rate the board resulting from each retained legal candidate plus that
   candidate's predicted immediate enemy response, then choose the best rating.
3. Optimize complete-game wins first. Break equal-win ties with
   loss-penalized terminal Power per total round.
4. Train on real generated starting boards and complete games, including
   captures, passes, offline nodes, and positional superko.
5. Let the learner eventually exceed the handcrafted teacher through
   learner-policy continuations and controlled state exploration.
6. Promote only checkpoints that improve on fixed, unseen complete-game
   corpora.

## Hard constraints

- The WHRNG seed is never a neural input. The outer engine derives the known
  response to each candidate and applies both moves before neural inference.
- Only the current response is predictable. Every later simulated decision
  samples a fresh WHRNG phase.
- The exact outer rules engine handles legality and positional superko. The
  network is called only for legal candidates, so it receives neither a legal
  mask nor board history.
- Offline cells and spatial padding use the same unplayable plane.
- Training and inference concern one game; streak state is deliberately absent.
- A loss multiplies terminal Power by `0.5`. This distinguishes losing lines
  without allowing their Power to outrank a higher chance of winning.
- Promotion is lexicographic: observed wins, then penalized Power/round on an
  exact win tie.

## Target topology and current artifacts

A shared max-19 model is not used. Both replacement profiles implement the same
v7 board-value contract, with separate weights and promotion ladders:

| Profile | Raw v7 input | Spatial value trunk | Output heads | v7 parameters | Promoted artifact |
|---|---|---|---|---:|---|
| `small5-spatial` | resulting 5x5 X/O/offline planes + 6-way enemy identity (81 values) | 8 shared 3x3 filters -> 8x5x5 pooled map -> 128 tanh units | one 3-value head per enemy | 29,042 | `small5-champion.model`, v7 |
| `daemon19-spatial` | resulting 19x19 X/O/offline planes (1,083 values) | 8 shared 3x3 filters -> 8x5x5 pooled map -> 128 tanh units | one 3-value head | 26,339 | `daemon19-champion.model`, v7 |

The outer rules engine enumerates every legal move on 5x5 and a bounded ordered
set on 19x19, predicts the immediate static-AI response from the current WHRNG
phase, applies the pair, and passes only that resulting board to the value
network. Candidate coordinates, response coordinates, the pre-move board,
seeds, history, and streak state are not neural inputs. The three outputs are
exactly:

- win probability;
- expected loss-penalized terminal Power;
- expected remaining rounds.

Only the head for the supplied 5x5 enemy is evaluated, so each board still has
exactly three outputs. The outer loop selects candidates
by predicted win probability first, then by
`terminal Power / (elapsed + remaining rounds)`.

The v7 spatial topology uses eight shared 3x3 filters, average-pools their
maps into a 5x5 spatial grid, and feeds a 128-unit tanh value layer. This keeps
local Go patterns translation-shared while retaining coarse absolute location,
which matters for edges and the fixed World Daemon topology. Prepared inference
caches the current board's convolution map; each candidate recomputes only the
3x3 neighborhoods changed by its move, captures, and the predicted reply.
Both promoted artifacts now use this v7 contract. The 5x5 ladder was reset to
v7 intentionally, and all current gates compare this contract against itself.

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

`teacher/` is the frozen TypeScript strategy used to bootstrap the first v7
models and remains a parity/reference fixture. Active continuation training is
fully native C++:

1. start every population member from the promoted v7 model;
2. from each opening, play complete trajectories with the stronger native
   search teacher and frozen incoming champion; `trio` also plays a KataGo
   adviser trajectory against the same fixed faction policy and reply stream;
3. select the route lexicographically by terminal win, then loss-penalized
   Power/round, admitting champion- or Kata-discovered choices only when their
   complete route beats the current winner;
4. share the selected episode across all learning-rate candidates and train
   its position-local rankings; all played adviser routes contribute their
   native terminal outcomes, so losing alternatives provide negative value
   labels without allowing a weaker route to override the policy target;
5. screen snapshots on unseen complete games, then promote only through a
   larger fixed-corpus gate. The incoming champion stays frozen for the whole
   population, preventing moving-target self-imitation.

The search is exhaustive at the 5x5 root. On 19x19 it cheaply orders the much
larger legal set, then spends exact known-response search on a configurable
root shortlist. Deployment rates every legal 5x5 post-response board and the
retained 19x19 set. Hypothetical later turns sample fresh WHRNG phases, use
bounded tactical branching, and never pretend a later seed is known.
Outcome-head targets for a played trajectory are backed up from its real
terminal win, penalized Power, and remaining-round count; shallow search values
train ranking only.

The two profiles have separate checkpoints, seed corpora, and promotion
ladders. `small5` balances all six enemy identities. `daemon19` samples only
the real prefilled World Daemon topology. Once the learner approaches its
teacher, subsequent populations should use `duel`, lower rates, and fresh
corpus seeds; complete-game gates, rather than imitation loss, decide whether
its exploration found a genuine improvement. The native teacher/champion
continuation is deliberately a two-trajectory tournament rather than a
recursively branched tree at every node: it leaves the teacher ceiling open
while keeping cost linear in game length. `trio` adds one separately played
Kata route without changing that search structure.

## Build and run

```sh
cmake --preset release -S go-ai
cmake --build go-ai/build/release -j 12
ctest --test-dir go-ai/build/release --output-on-failure

# Shared-experience population training. Each expensive teacher game is made
# once, then all learning-rate candidates train from that same episode. `-`
# means a stratified rotation through all six ordinary 5x5 opponents.
go-ai/build/release/go_cpp_population 600 4097001 256 \
  go-ai/runs/small5-next - 5 25 12 small5 \
  go-ai/small5-champion.model '0,0.000001' \
  '0.00001,0.000025,0.00005,0.000075,0.0001,0.00015' \
  32 32 12 0 duel

go-ai/build/release/go_cpp_population 600 4193001 0 \
  go-ai/runs/daemon19-next '????????????' 19 25 12 daemon19 \
  go-ai/daemon19-champion.model '0,0.000001,0.0000025' \
  '0.0001,0.00025,0.0005,0.00075' 8 64 2 0 duel

# Three-adviser continuation. Run the bootstrap once first; `trio` resolves
# the pinned binary, profile-specific model and config from go-ai/katago/.
# Defaults are the benchmark winners: predictive v2/c4 on small5 and plain v8
# on daemon19. Optional path/budget overrides are documented in katago/README.
bun run go-ai/katago/bootstrap.ts
go-ai/build/release/go_cpp_population 600 4297001 256 \
  go-ai/runs/small5-kata - 5 25 12 small5 \
  go-ai/small5-champion.model '0,0.000001' \
  '0.00001,0.000025,0.00005,0.000075,0.0001,0.00015' \
  32 32 12 0 trio

# Fixed held-out complete-game promotion gates.
go-ai/build/release/go_cpp_evaluate_mixed 2400 10992001 \
  go-ai/small5-champion.model go-ai/small5-candidate.model \
  --small5 --threads 12
go-ai/build/release/go_cpp_evaluate 128 7193001 '????????????' 19 \
  go-ai/daemon19-champion.model go-ai/daemon19-candidate.model
```

Training runs outside Bitburner. The C++ gradient trainer and evaluator use 12
CPU worker shards; increasing batches from 64 to 512 and parallelizing held-out
metrics reduced a representative evaluation pass from 15.70 s to 3.46 s on
this 12-core M2 Max. The population trainer also uses a dynamic game queue, so
variable-length World Daemon games do not strand cores at fixed wave barriers.
A measured 12-game World Daemon smoke corpus updated 12 candidate networks in
32.02 seconds; twelve separate trainers would have had to generate that corpus
twelve times. Checkpoints are written at `CHECKPOINT_EVERY` games. To continue
after an interruption, use the selected checkpoint as `INIT_MODEL`, choose a
fresh corpus seed and output directory, and run another population. Snapshot
writes use a temporary file plus atomic rename, and the trainer refuses a
non-empty output directory, so an accidental restart cannot overwrite an
existing run.

The trajectory argument selects generation. `teacher` is pure search
distillation. `duel` plays the frozen champion alongside the teacher from the
same opening and paired environment stream. `trio` adds a KataGo episode and
uses the best of all three complete routes for ranking while retaining all
three native terminal outcomes. `kata` is a research-only high-throughput
pretraining mode that generates just the exact native Kata-advised trajectory;
its finalists still require a fresh `trio` handoff and the unchanged promotion
gates. All routes use the same native opening, reply phases, rules, terminal
reward, and win-first then Power/round comparison. Smoke audits selected champion routes in 12/100
balanced 5x5 openings and 1/12 World Daemon openings; the integrated Kata
smokes selected its route on six balanced 5x5 openings and one 19x19 daemon
opening.

KataGo runs behind one persistent serialized sidecar while native episode
generation remains threaded. It supplies policy rankings only. Its estimates
never become outcome-head labels: the selected route is replayed by the native
environment, and only that real terminal result is backed up. A sidecar error
fails the current checkpoint instead of silently reverting to `duel`; snapshot
writes remain atomic, so an adviser failure cannot install a partial model.
See [katago/README.md](katago/README.md) for the patched rules, remaining model
mismatches, pinned dependencies and full benchmark proof.

Native search has a separate adjustable per-turn budget and is not constrained
by the original in-game 10 ms target. The two profile ladders are independent.
On one host, alternate them at completed corpus boundaries and give each block
all available CPU cores; this produced faster feedback than two simultaneous
half-host populations. Never run two default `12`-thread commands together.
Keep corpus/output directories and the frozen incoming champion separate; do
not start a second population against a champion that is being promoted.

### Batched accelerator pretraining

`gpu/train.py` is a portable PyTorch pretrainer for Metal/MPS, CUDA, and CPU.
The native `go_cpp_gpu_env` sidecar deliberately retains every fidelity-
sensitive operation: board generation, legality, positional superko, the
Bitburner opponent, WHRNG phases, and scoring. At each turn it enumerates the
legal black moves and applies a separately sampled valid immediate opponent
reply to each. PyTorch receives one large batch containing only those
**post-response** boards. It evaluates the exact v7 three-output contract and
returns the selected index to the sidecar, which continues that trajectory.
Thus accelerator and deployed inference rate the same side-to-move state; an
after-black/pre-response board is never used as a v7 value input or label.

When a complete game ends, every selected post-response board receives the
observed terminal win, loss-penalized Power, and remaining-round target. The
alternatives were useful for selection but do not receive invented labels.
Exploration supplies alternative complete trajectories. Checkpoints preserve
the text v7 artifact format and are checked against `go_cpp_oracle` after every
write (measured maximum relative discrepancies were below `2e-6` on both
profiles). Logs and summaries include elapsed seconds and games/second so
candidate quality can be compared against wall-clock cost, not just epochs.

```sh
python3.12 -m venv go-ai/.venv-gpu
go-ai/.venv-gpu/bin/pip install -r go-ai/gpu/requirements.txt

go-ai/.venv-gpu/bin/python go-ai/gpu/train.py \
  --profile small5 --games 4096 --seed 4397001 \
  --environments 256 --cpu-threads 12 --device auto \
  --learning-rates 0.0000025,0.000005,0.00001,0.000025 \
  --init go-ai/small5-champion.model \
  --out-dir go-ai/runs/small5-gpu-4397001
```

With `--learning-rates`, all candidates train on identical replay batches.
The default `population-retention` actor schedule assigns complete games
round-robin to each rate path and an immutable incoming-champion actor. This
amortizes the expensive environment corpus in the same way as the native
population trainer, preserves retention trajectories, and still emits
independently screenable checkpoints for every rate.
When `--init` is a research checkpoint, pass the official champion separately
with `--retention-model`; otherwise retention intentionally defaults to the
initial checkpoint.

Replay is uniform by default. `--replay-sampling opponent` equalizes the six
5x5 heads, while `outcome` equalizes winning and losing examples. Controlled
runs found both slower and worse than uniform replay, so they are retained only
for experiments. Loss-head weights are separately controlled by
`--win-loss-weight`, `--power-loss-weight`, and `--remaining-loss-weight`.

The network is intentionally tiny. On the M2 Max, Metal dispatch overhead can
exceed CPU inference time for 5x5; the measured benefit comes primarily from
batching many environments, and 19x19 is still dominated by the branch-heavy
opponent/rules engine. A future tensor port of that engine must pass the same
upstream differential corpus before replacing the native sidecar. The current
hybrid is therefore the exact reference pipeline, not a relaxed opponent.

GPU checkpoints are research inputs, never promotions. Feed a screened GPU
checkpoint to `go_cpp_population` as `INIT_MODEL`, retain the official champion
as the final `RETENTION_MODEL` argument, and use `duel` or `trio` for the CPU
predictive/adviser stage. This lets GPU replay and CPU adviser training run at
the same time with explicit CPU budgets. Swap their profiles only at completed
corpus boundaries so every handoff is an immutable checkpoint. The ordinary
held-out and independent confirmation gates remain unchanged. See
[`gpu/README.md`](gpu/README.md) for the replay labels, exactness boundary, and
the parity requirements for an eventual fully accelerator-resident opponent.

## Deployment

The game consumes promoted checkpoints through a derived artifact, never the
`.model` text directly. Each stage below has its own executable gate, so no
step in the chain is verified only by inspection.

**1. Promotion — is the candidate actually better?**
`bun run go:promote <small5|daemon19> <candidate.model> [--games N] [--seed N]`
replays a fixed unseen corpus with `go_cpp_evaluate_mixed`/`go_cpp_evaluate`
and applies this project's rule as code: more complete-game wins always wins,
and only an exact win tie is broken by higher loss-penalized Power per round.
A candidate that does not strictly improve exits nonzero. `--apply` installs
the champion and immediately re-runs steps 2 and 3, so weights, artifact, and
test oracle cannot drift apart. Always gate on a fresh corpus seed.

**2. Export — narrow to a deployable artifact.**
`bun run go:export` reorders the promoted checkpoints for inference and writes
generated modules under `shared/strategy/go/neural/models/`. The 5x5 profile
uses row-wise symmetric int8 weights with float16 biases; the more
quantization-sensitive World Daemon profile uses float16 throughout. Together
they occupy about 111 KB of TypeScript source instead of 296 KB as base64
float32 or roughly 1.2 MB as training checkpoints. Both formats expand once to
the shader's float32 layout when their profile is first used, so compression
adds no arithmetic to a turn. `bun run go:export --check` fails when a generated
artifact, its source digest, or its payload digest is stale.

**3. Golden vectors — pin the ports to this trainer.**
`bun run go:golden` (needs `go_cpp_oracle`) regenerates
`tests/fixtures/go-value.json` from `go_cpp_oracle value` after materializing
the decoded runtime weights as a temporary native checkpoint: exact predictions
for 14 boards spanning every 5x5 enemy head, offline-heavy positions, and
sub-extent padding. Thus the shader stays pinned to native inference without
pretending intentional storage quantization is a port error.

**4. Inference — one TypeScript backend.**
`shared/strategy/go/neural/` keeps the exact rules and the clean-room reply
model in TypeScript and batch-evaluates the retained candidates' result boards
through the WGSL compute shader over WebGPU, with weights resident in VRAM.
There is no TypeScript CPU implementation or fallback: missing or lost WebGPU
fails the Go turn explicitly. C++ retains native inference solely for training,
evaluation, and generation of the committed golden vectors.

**5. Shader gate — the deployed path, executed.**
`bun run go:gpu` runs the real WGSL in headless Chrome (Dawn, the same WebGPU
family as Bitburner's Electron) against the step-3 vectors: every case, every
head, and all three outputs, plus batch-versus-single equality, buffer
capacity growth past 512 boards, cold decode time, and dispatch latency. `tests/go-webgpu.test.ts`
runs the same gate inside `bun test`; missing Chrome or WebGPU is a failure,
not a skip. `bun run go:gpu -- --arena` additionally plays complete oracle games
through the same WebGPU backend.

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
