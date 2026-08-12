# IPvGO policy and arena

Move selection is a trained neural value network. The exact rules and the
clean-room faction-reply model stay in TypeScript; the network only ever rates
result boards. Training lives in `go-ai/` (C++); `go-ai/README.md` documents the
trainer and the deployment pipeline end to end.

The policy is tested against the independently vendored Bitburner v3.0.1 AI,
never against its own clean-room opponent transcription.

```sh
bun run go:gpu                   # run the deployed WGSL shader against golden vectors
bun run go:gpu -- --arena        # plus complete upstream-backed WebGPU games
```

The browser gate uses a fixed smoke corpus: 12 games for each ordinary opponent
and two World Daemon games. Its JSON summary reports wins and full-decision
latency percentiles. The underlying `sim/go-arena.ts` research runner supports
larger configurable corpora: its default seeds walk engine ticks with a stride
coprime to the Wichmann-Hill RNG's 150,000-tick period. Do not replace that with
a small constant millisecond step, which samples only a narrow set of RNG
phases. `--seed` selects a disjoint starting phase; `--seed-step` exists only for
reproducing older linear corpora.

The research runner additionally reports score difference, mean black score and
game duration, a Wilson 95% lower bound, and replayable losing seeds. `--trace`
adds every input board, history, dispatch playtime, chosen move, predicted
response and actual upstream response. `--all-ties` repeats games across the
full set of representative values for the one intentionally unseeded defense
tie.

## Decision

Per turn the engine enumerates legal moves plus pass, predicts each retained
candidate's seeded faction reply, applies both moves, and batches the distinct
resulting boards through the value network. The 5x5 set is exhaustive; 19x19 is
capped as described below. Candidates are ranked by predicted win probability,
with loss-penalized terminal Power per total round breaking exact ties — the
same rule the trainer promotes on.

Two cases bypass the network because the rules answer them exactly: a second
consecutive pass is scored by area and komi rather than estimated, and a white
pass that leaves black ahead is accepted immediately.

The 19x19 board is the only size that caps its candidate set (96 by default,
`--candidate-limit`). Reply modeling, not inference, is the cost there: the
shader rates 400 boards in well under a millisecond.

Weights are versioned artifacts, not code. `shared/strategy/go/neural/models/`
holds generated float32 modules exported from promoted checkpoints; changing
them never touches engine or shader source.

## Execution

| Backend | Where | Role |
|---|---|---|
| WGSL compute shader over WebGPU | Electron and headless Chromium | sole TypeScript inference path; weights resident in VRAM |
| Native C++ network | `go-ai/` tools | training, evaluation, and golden-vector generation only |

The browser gate verifies the GPU backend against C++ golden vectors across
every output head and all three outputs. Creation, device loss, or a runtime
evaluation failure aborts the Go turn; production never imports or runs neural
inference on the CPU.

## Seed alignment

`Player.totalPlaytime` advances in 200 ms engine cycles and the AI seeds its
WHRNG from the tick it is dispatched in, so a rollover between reading the clock
and calling `go.makeMove` invalidates the forecast. Reading the tick cannot by
itself locate the phase within a cycle, so one observed transition anchors it
and the wall clock extrapolates from there.

Within 20 ms of a rollover the turn targets the *next* cycle: it forecasts for
that tick, computes the move while the current cycle drains, sleeps the
remainder plus one millisecond, and dispatches with a full cycle of headroom.
Otherwise it dispatches in the current cycle. A verification read after
computing catches an unexpected advance and replans once against the tick
actually in force.

Anchoring runs in its own dodge because it may wait most of a cycle: it costs
`getPlayer` only, rather than holding the 4 GB `go.makeMove` grant while
waiting. It runs only when the phase is unknown, with a cooldown so a paused
game cannot re-poll every turn.

## Larger boards

Only 5x5 has dedicated weights. Every larger board is rated by the 19x19 World
Daemon profile on a padded board, which is out of distribution for those
weights: they never saw a 7x7-13x13 position in training. This is deliberate
handling for inherited or manually started games rather than a supported
configuration, and the plan digest flags it (`modelProfile`, `paddedToExtent`)
so such a game's play is attributable.

## Reward priors

`GO_REWARD_RULES` in `shared/strategy/go/rewards.ts` prices opponent and board
choice from measured arena results, and `sim/tests/go-selection.test.ts` holds
those constants to the deployed champion. **Every promotion must be followed by
a refit**: the BitNode route is planned from these numbers, and stale priors
divert games into the wrong opponents. Live win/loss records never feed back
into the policy or the priors.

## Acceptance

- Every game completes or reports its explicit turn cap.
- Every observed immediate white response is contained in the clean-room
  predicted set (`go_cpp_opponent_parity` enforces this across full games,
  against both the C++ and TypeScript forecasts).
- The deployed shader reproduces the trainer's own predictions on the committed
  golden vectors and completes upstream-backed arena games through WebGPU.
- Main-thread blocking stays within the ~2 ms budget; planning is sliced
  cooperatively and only the warm dispatch-time finalize is seed-critical.
- Win rates and reward priors come from the upstream arena's stratified corpus.
- A reported 100% means zero losses on the named finite corpus, accompanied by
  its Wilson lower bound. It is not presented as a proof over all games.
