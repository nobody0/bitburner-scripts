# KataGo IPvGO adviser

This subtree patches a pinned KataGo checkout, provides the adviser used by
`go_cpp_population trio`, and retains the independent arena that proved the
policy before integration. KataGo does not load or overwrite either promoted
bespoke model.

## What is adapted

- `blockedPoints` maps every IPvGO `#` to KataGo's real internal `C_WALL`.
  Walls are removed from liberties, territory, legal moves, playable area,
  neural spatial masks, and persistent neural-cache identity.
- Queries use area scoring, positional superko, illegal suicide, no tax, no
  button, no handicap score bonus, the faction's exact komi, and Black to move.
- Every root is restricted to moves accepted by the native IPvGO positional-
  superko implementation. KataGo never receives the WHRNG phase, the predicted
  response, the faction identity, or the bespoke terminal Power target.
- The current public board is supplied as an initial position on every turn.
  This sacrifices KataGo's recent-move features, but prevents a mismatch in
  historical game termination and leaves exact history-dependent legality to
  IPvGO.

Two deliberate mismatches remain inside KataGo's hypothetical continuations.
Its search assumes a strong normal-Go opponent rather than one of Bitburner's
seven fixed policies, and it uses normal area territory instead of IPvGO's
large-empty-region guard that refuses to award an empty region larger than
`size² - 3`. Root legality and the arena's terminal result are still decided by
the native IPvGO implementation. These mismatches are why KataGo remains a
move adviser rather than a value teacher.

## Reproduce

```sh
# Pins KataGo v1.16.3 at 802946d, applies ipvgo-walls.patch, verifies model
# checksums, and builds OpenCL on macOS (Eigen elsewhere).
bun run go-ai/katago/bootstrap.ts

# Optional when a full Xcode SDK is installed (Ninja is also required):
bun run go-ai/katago/bootstrap.ts --backend METAL

bun test go-ai/katago/advisor.test.ts

# Same seed corpus for KataGo and the handcrafted control, all seven enemies.
bun run go-ai/katago/arena.ts --games 16 --visits 32 \
  --out go-ai/katago/results/arena-v32.json

# Focused variants (the board/opponent corpus is seeded; KataGo search retains
# its normal internal random seed).
bun run go-ai/katago/arena.ts --opponent Illuminati --games 64 --visits 64
bun run go-ai/katago/arena.ts --profile small5 --games 32 --visits 8
bun run go-ai/katago/arena.ts --opponent secret --games 8 --visits 64 --trace
```

The checked-in aggregate from the completed 32-game-per-opponent run is in
[`RESULTS.md`](RESULTS.md), with the same figures in machine-readable form at
[`proof/arena-v8-g32.json`](proof/arena-v8-g32.json).

The 5x5 model is Rect15's final `b20c256`, trained on boards as small as 3x3.
The 19x19 lane uses the much faster final `b10c128` kata1 checkpoint so a
complete seven-opponent proof remains practical. Both downloads and SHA-256
digests are pinned in `advisor.ts`; model files, patched checkout, build output,
logs, and raw arena results are ignored.

## Predictive adviser

The optional 5×5 lane composes KataGo with IPvGO's exact one-move opponent
forecast without teaching KataGo the WHRNG or faction identity:

```sh
bun run go-ai/katago/arena.ts --predictive --profile small5 \
  --games 32 --policy-visits 2 --candidates 4 --visits 2
```

For each turn it asks KataGo for a policy shortlist, independently predicts
White's response to each Black candidate, and submits one candidate-specific
query that forces that White move. Selection is lexicographic, matching the
bespoke trainer: maximize Black win probability first; only an exact tie uses
expected terminal Black Power per total round. Native double-pass wins are
scored exactly and always beat estimates.

The retained recommendation is predictive KataGo for 5×5 and plain KataGo for
the 19×19 daemon. Conditional search improved every 5×5 faction lane in the
full proof, but its daemon sample was slower and earned less Power per round,
so it is not the recommended daemon route. See `RESULTS.md`.

## Population integration

`go_cpp_population ... trio` plays three complete routes from every scheduled
opening: handcrafted search, frozen champion, and Kata advice. It admits the
route with the best terminal result using the existing strict ordering:
complete-game win first, then loss-penalized terminal Power per round. The
checkpoint log reports `challenger_selected` and `adviser_selected` counts.

The C++ environment owns board generation, legality, positional superko,
opponent forecasts, response sampling, terminal scoring and training features.
A persistent Bun sidecar owns only KataGo queries. On 5×5 it receives the
native modal immediate response for every legal Black candidate and runs the
proved predictive shortlist; the genuinely unseeded defense tie remains a
probability in the native environment and the played episode records the
sampled result. On 19×19 it uses plain Kata advice, matching the benchmark
reversal. The sidecar is serialized because one Kata process owns one analysis
stream; native teacher and champion generation remain threaded.

Defaults require no extra arguments after `trio` once `bootstrap.ts` has run:

| Profile | Mode | Reply visits | Policy visits | Candidates |
| --- | --- | ---: | ---: | ---: |
| `small5` | predictive | 2 | 2 | 4 |
| `daemon19` | plain | 8 | 2 (unused) | 4 |

Override order is:
`trio [KATAGO_BINARY] [KATAGO_MODEL] [KATAGO_CONFIG] [KATAGO_VISITS]
[KATAGO_POLICY_VISITS] [KATAGO_CANDIDATES] [RETENTION_MODEL] [full|heads]
[KATAGO_PROCESSES]`.

`RETENTION_MODEL` defaults to `INIT_MODEL`. Supplying it separately lets a
research lineage continue from a promising, not-yet-promoted checkpoint while
the official champion remains frozen as the retention adviser. This does not
change promotion: only independently confirmed fixed-corpus gates may replace
either champion artifact.

The final scope defaults to `full`. `heads` freezes the convolution and dense
trunk while updating only the applicable three-value output head. It is useful
for measuring and limiting cross-opponent interference on the balanced 5×5
profile; it does not alter the model format.

`KATAGO_PROCESSES` defaults to one. Values above one start independent adviser
sidecars and assign population workers round-robin between them. This can
increase low-visit throughput when one serialized command stream underfills the
GPU, at the cost of another model/context allocation per process. Benchmark it
on the target accelerator before making it the local default.

KataGo rankings train the policy head, but KataGo value and score estimates
never become bespoke outcome-head targets. The native environment replays all
three routes and backs up only their real terminal win, Power and remaining-
round labels; the best route alone supplies policy rankings. Missing
dependencies fail before generation; a worker/query error
fails the checkpoint rather than silently changing the requested adviser set.
Existing `teacher` and `duel` modes do not start or depend on KataGo.
