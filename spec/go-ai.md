# IPvGO policy and arena

Move selection uses the V9 shared-board network: a learned proposal and
candidate-response branch head on the original board, followed by the value
head on exact post-response boards for only the finalists. Exact rules and the
clean-room faction-reply model stay in TypeScript. Training lives in `go-ai/`;
`go-ai/README.md` documents the pipeline end to end.

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

Per turn the engine enumerates every legal move plus pass and runs V9 once on
the original board for each reachable dispatch seed. It normally retains 8
finalists for either profile, expands a flat boundary, and reserves some
moves from each seed before averaging. Only finalists run exact seeded faction
prediction and post-response value inference. Candidates are ranked by win
probability, with loss-penalized raw Black score per total round breaking exact
ties—the same normalized metric the trainer promotes on.

The model receives no raw enemy category. A rules-derived behavior signature
contains the exact smart/reckless result, the three remaining WHRNG values,
enabled semantic priority/fallback branches, and their precedence. It does not
pretend that the final branch is globally known: the auxiliary 13-way branch
head predicts it separately for every candidate. Small5 also receives komi
because it varies; daemon19 komi and all difficulty/Go Power multipliers are
fixed noise and are omitted.

Two cases bypass the network because the rules answer them exactly: a second
consecutive pass is scored by area and komi rather than estimated, and a white
pass that leaves black ahead is accepted immediately.

Training and recall evaluation are exhaustive even on 19x19. The old ordered
96-move set is used only to label bait moves that it would have hidden. A learned
shortlist cannot generate its own training corpus until unseen top-K, pass, and
bait recall gates pass. `candidateLimit: Infinity` forces exhaustive runtime
shadow evaluation for audits.

Weights are versioned artifacts, not code. `shared/strategy/go/neural/models/`
holds generated storage modules exported from promoted checkpoints. V9 uses
row-wise int8 matrices plus float16 biases and decodes once into one contiguous
shader upload allocation. V9 is the only runtime topology, so the runtime
carries exactly one decoder.

Export omits the auxiliary response-branch head. Its loss shapes the shared
trunk during training, but production uses exact rules for finalist branches
and consumes only the move proposal and three-value heads.

`bun run go:export` selects those encodings automatically by profile and reports
the decision, compression ratio, generated size, and provenance hashes. Use
`bun run go:export <checkpoint.model> <small5|daemon19> --inspect` to inspect a
candidate without writing. Encoding comparisons are research experiments and
stay outside the maintained exporter; promotion still requires the decoded
artifact to retain complete-game wins on the storage corpus.

## Execution

| Backend | Where | Role |
|---|---|---|
| WGSL compute shader in a persistent WebWorker | Electron and headless Chromium | sole TypeScript inference path; weights resident in worker-owned VRAM |
| Native C++ V9 network | `go-ai/` tools | independent full-precision correctness oracle only |

The browser gate verifies the q8 GPU backend against the exact promoted C++
checkpoint across every deployed move-policy output and all three value outputs. At least
99.9% of proposal elements must remain within the quantization tolerance and
top-8 agreement must remain at least 99%. Creation, device loss, or a runtime
evaluation failure aborts the Go turn; production never imports or runs neural
inference on the CPU.

Production embeds one classic-worker bundle into `start.js` and opens it from a
Blob URL. The page-realm global retains the worker across same-build controller
restarts and replaces it on a new build, whose V9 artifact or protocol may have
changed. Adapter/device creation, weight upload, and prepared positions are not
paid per turn. A position is transferred once. Steady-state messages contain
compact turn and position ids, our selected move, White's observed response,
and playtime reduced modulo WHRNG's 30,000-second period. No
`SharedArrayBuffer` is required.

Immediately after the verified `makeMove`/`passTurn` call starts, the game
commits the selected prediction id and move. The worker checks that choice,
materializes plausible White-response boards internally, and uses an anchored
200 ms modulo clock to schedule only ticks at or after White can finish. It
starts each V9 evaluation early enough to push the result about 75 ms before
the corresponding tick. Five viable slots cover +0..+4-cycle timer lateness.
When White returns, the game sends only the observed response, successor id and
modulo clock confirmation. The worker selects that branch and cancels siblings;
a board mismatch triggers the full-view resync path. A commit receives one
bounded prediction generation and expires without a response life sign.

## Seed alignment

`Player.totalPlaytime` advances in 200 ms engine cycles and the AI seeds its
WHRNG from the tick it is dispatched in, so a rollover between reading the clock
and calling `go.makeMove` invalidates the forecast. Reading the tick cannot by
itself locate the phase within a cycle, so one observed transition anchors it
and the wall clock extrapolates from there.

Only the final 2 ms before a rollover targets the *next* cycle, protecting the
synchronous public read-to-Go-call gap. Inference is already complete and is
not part of the guard. A verification read catches an unexpected advance and
repeats the worker-cache request
for the new seed set until the intended tick is observed. A bounded failure aborts the
turn instead of knowingly dispatching with the wrong forecast.

Anchoring runs in its own dodge because it may wait most of a cycle: it costs
`getPlayer` only, rather than holding the 4 GB `go.makeMove` grant while
waiting. It runs only when the phase is unknown, with a cooldown so a paused
game cannot re-poll every turn.

## Larger boards

Only 5x5 has dedicated weights. Every larger board is rated by the 19x19 World
Daemon profile on a padded board, which is out of distribution for those
weights: they never saw a 7x7-13x13 position in training. V9 routes an active
intermediate-size game this way so it can be finished, and the plan digest
flags it (`modelProfile`, `paddedToExtent`) so its out-of-distribution play is
attributable.

## Reward priors

`GO_REWARD_RULES` in `shared/strategy/go/rewards.ts` prices opponent and board
choice from measured arena results, and `sim/tests/go-selection.test.ts` holds
those constants to the deployed champion. **Every promotion must be followed by
a refit**: the BitNode route is planned from these numbers, and stale priors
divert games into the wrong opponents. Live win/loss records never feed back
into the policy or the priors.

The promoted V9 priors were refitted on 2026-08-14 through Chromium/WebGPU at
tie roll 0.5 and seed start 123456: 128 games for each ordinary opponent and
512 for Illuminati. `GO_REWARD_RULES` stores the resulting win rate, mean black
score per 23 playable intersections, and virtual upstream-AI seconds per 23.
The simulator's full-route aggregate endpoint consumes exactly that table;
`goFidelity` keeps those route results distinct from action-exact arena runs.

## Acceptance

- Every game completes or reports its explicit turn cap.
- Every observed immediate white response is contained in the clean-room
  predicted set (`go_cpp_opponent_parity` enforces this across full games,
  against both the C++ and TypeScript forecasts).
- The deployed shader stays within the declared quantization bounds of the
  full-precision promoted checkpoint and completes upstream-backed
  arena games through WebGPU.
- V9 promotion and continuation require a hash-matched unseen exhaustive
  summary with top-K, pass, and daemon bait recall gates satisfied; held-out
  episodes contribute neither proposal nor shared-trunk value gradients.
- Generated artifacts pin source and payload SHA-256 digests, stay below their
  encoded-size budget, and reproduce exactly under `go:export --check`.
- Main-thread V9 work is bounded to worker messages and result handling; WebGPU
  submission, exact opponent prediction, packing, and readback remain in the
  persistent worker. Plan telemetry reports position, pushed-prediction, and
  dispatch-seed cache hits plus ready-to-dispatch latency so live timing is attributable.
- Win rates and reward priors come from the upstream arena's stratified corpus.
- A reported 100% means zero losses on the named finite corpus, accompanied by
  its Wilson lower bound. It is not presented as a proof over all games.
