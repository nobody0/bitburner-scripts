# Current promotion baselines

Promotion uses complete games on identical unseen seeds. More wins always win
the gate; only an exact win tie is broken by higher loss-penalized terminal
Power per total round.

## Promoted artifacts

| Profile | Artifact | Neural input | SHA-256 |
|---|---|---|---|
| six ordinary enemies on 5x5 | `small5-champion.model` | resulting board plus enemy identity | `314149e442998b2c7e098e4a3366b9a371c13a235c6651e74ec5f8a4b3457010` |
| World Daemon on 19x19 | `daemon19-champion.model` | resulting board; no enemy input | `a3dc8836e2a5720c341bbbb6518343cddef08fb33db39b406b70713ef3033d4c` |

Both are v7 spatial board-value networks with three outputs per applicable
enemy: win probability, expected loss-penalized terminal Power, and expected
remaining rounds. See `README.md` for the exact topology.

## Balanced 5x5

Search distillation has already produced progressive gains under the final v7
contract:

| Stage | Candidate wins | Incoming champion wins | Candidate Power/round |
|---|---:|---:|---:|
| first 50-game population | 1,521/2,400 | 1,514/2,400 | 1.48449 |
| narrowed second generation | 1,591/2,400 | 1,556/2,400 | 1.59934 |
| low-rate continuation, promoted | 3,151/4,800 | 3,138/4,800 | 1.55219 |

The promoted checkpoint was 65.65% on corpus `1951082026`. The native offline
teacher remains substantially stronger: 117/120 (97.5%) on a fresh balanced
audit, and 119/120 (99.17%) on an Illuminati-focused audit. Distillation,
especially without harming already-strong faction heads, remains the 5x5
bottleneck.

The first paired teacher/champion population admitted champion routes in
12/100 openings. Its best low-rate snapshot improved by two games on one
4,800-game corpus (3,174 versus 3,172), but lost by one game on an independent
confirmation (3,123 versus 3,124). It was correctly rejected.

### 2026-08-12 batched-replay promotion

The first accelerator-assisted corpus used the exact native opponent/rules
sidecar and Metal/MPS batched v7 inference. It played 4,096 balanced games from
seed `1208202770`, with 256 concurrent environments, learning rate `0.00001`,
one replay update per completed game, batch size 2,048, and randomized valid
WHRNG phases. The selected wall-clock checkpoint was `gpu.2050.model`; later
epochs were not assumed better. Its SHA-256 is the promoted hash above.

The checkpoint then completed a 240-game CPU `trio` handoff on seed
`1208202780`, with native teacher, frozen incoming champion, and predictive
KataGo routes. None of the head-only fine-tunes beat the incoming GPU
checkpoint, so the unchanged checkpoint advanced to proof. It passed three
fresh balanced gates (800 games per ordinary enemy in each corpus):

| Corpus seed | Candidate wins | Incoming wins | Candidate Power/round | Incoming Power/round |
|---:|---:|---:|---:|---:|
| 1208202782 | 3,204/4,800 | 3,146/4,800 | 1.56484 | 1.54778 |
| 1208202783 (independent confirmation) | 3,194/4,800 | 3,101/4,800 | 1.55190 | 1.50313 |
| 1208202784 (`go:promote --apply`) | 3,179/4,800 | 3,124/4,800 | 1.56330 | 1.52461 |

This is the first promoted checkpoint trained directly on complete on-policy
value replay rather than only native population SGD. The accelerator never
received a pre-response board: every target and inference input was the board
after both the candidate move and a valid immediate Bitburner reply.

### 2026-08-12 multirate replay promotion

The next generation started from that promoted checkpoint and generated 8,192
balanced games on seed `1208202810` in 250.68 seconds (32.68 games/second).
MPS trained four rates (`0.0000025,0.000005,0.00001,0.000025`) from identical
replay minibatches; the first rate supplied the common behavior trajectory.
The `0.000025` finalist was selected on unseen balanced screens. A subsequent
120-game, six-thread native predictive `duel` handoff on seed `1208202830`
kept the official champion frozen; its head-only updates did not improve the
GPU checkpoint, so the unchanged checkpoint advanced.

During screening, a rare upstream priority-move behavior was exposed and
fixed in the native environment: when positional superko rejects the AI's
chosen priority coordinate, Bitburner advances without changing the board and
without recording a pass. The parity suite passed after representing this as
a distinct no-op, and all final gates below used the corrected semantics.

| Corpus seed | Candidate wins | Incoming wins | Candidate Power/round | Incoming Power/round |
|---:|---:|---:|---:|---:|
| 1208202813 | 3,440/4,800 | 3,246/4,800 | 1.62254 | 1.58812 |
| 1208202814 (independent confirmation) | 3,432/4,800 | 3,239/4,800 | 1.60897 | 1.58092 |
| 1208202815 (`go:promote --apply`) | 3,481/4,800 | 3,230/4,800 | 1.59225 | 1.57971 |

The promoted checkpoint is
`gpu-small5-multirate-1208202810/gpu-lr-2_5e-05.model`; its SHA-256 is the
intermediate generation's hash.

### 2026-08-12 population-retention plus trio promotion

A controlled full-core experiment compared single-actor GPU replay with a
round-robin population actor schedule on the same 4,096-game corpus seed
`1208202840`. Four rate paths plus an immutable incoming champion each supplied
complete trajectories to the shared replay. Population retention ran at 42.50
games/second versus 44.56 for single actor, but its best unseen balanced screen
was 953/1,200 versus 903/1,200 for single actor and 890/1,200 for the incoming
champion. Equal-per-head replay sampling was separately tested and rejected:
it was slower and produced only 923/1,200 at best.

The GPU finalist (`0.000025`) then entered a 120-game, 12-core CPU `trio`
population on seed `1208202850`. Full-trunk ranking rates
`0.0000025,0.000005,0.00001,0.000025` were paired with outcome rates
`0,0.00000025,0.000001`; native teacher, frozen champion, and predictive KataGo
all supplied terminal trajectories. The best CPU refinement used outcome `0`
and ranking `0.000025`.

| Corpus seed | Candidate wins | Incoming wins | Candidate Power/round | Incoming Power/round |
|---:|---:|---:|---:|---:|
| 1208202852 | 3,696/4,800 | 3,481/4,800 | 1.76891 | 1.61095 |
| 1208202853 (independent confirmation) | 3,730/4,800 | 3,448/4,800 | 1.76722 | 1.60820 |
| 1208202854 (`go:promote --apply`) | 3,649/4,800 | 3,458/4,800 | 1.73574 | 1.61374 |

The promoted checkpoint is
`experiment-small5-popret-trio-1208202850/o0-p2.5e-05.120.model`; its SHA-256
is the preceding generation's hash.

### 2026-08-12 two-update replay promotion

The next full-core experiment doubled replay learning to two shared minibatch
updates per completed game while retaining uniform replay and the round-robin
four-learner plus frozen-champion actor population. It generated 4,096 balanced
games from seed `1208202910` in 180.96 seconds (22.64 games/second), compared
with about 42.50 games/second for one update. The `0.000005` learner won the
unseen screen. A 120-game CPU `trio` handoff on seed `1208202930`, initialized
from that model while retaining the official champion, did not improve the raw
GPU checkpoint.

| Corpus seed | Candidate wins | Incoming wins | Candidate Power/round | Incoming Power/round |
|---:|---:|---:|---:|---:|
| 1208202932 | 3,749/4,800 | 3,693/4,800 | 1.78036 | 1.79595 |
| 1208202933 (independent confirmation) | 3,739/4,800 | 3,718/4,800 | 1.75255 | 1.74934 |
| 1208202934 (`go:promote --apply`) | 3,784/4,800 | 3,733/4,800 | 1.77267 | 1.77112 |

The promoted checkpoint is
`experiment-small5-updates2-1208202910/gpu-lr-5e-06.model`; its SHA-256 is the
preceding generation's hash. The result keeps two updates as a viable
quality-oriented setting, but its roughly 1.88x throughput cost means it is not
assumed superior for equal wall-clock training until longer controlled runs
confirm the trajectory advantage.

### 2026-08-12 equal-wall-time replay promotion

The direct wall-time follow-up used one replay update over 8,192 balanced games
from seed `1208202940`, starting from the two-update champion. It completed in
299.53 seconds (27.35 games/second including a late host slowdown), with four
low-rate learners and the same round-robin frozen-champion retention schedule.
The `0.000005` path won the unseen screen and all three full gates:

| Corpus seed | Candidate wins | Incoming wins | Candidate Power/round | Incoming Power/round |
|---:|---:|---:|---:|---:|
| 1208202942 | 3,833/4,800 | 3,784/4,800 | 1.79805 | 1.77476 |
| 1208202943 (independent confirmation) | 3,774/4,800 | 3,724/4,800 | 1.76038 | 1.74682 |
| 1208202944 (`go:promote --apply`) | 3,808/4,800 | 3,735/4,800 | 1.78265 | 1.74512 |

The promoted checkpoint is
`experiment-small5-equalwall-1208202940/gpu-lr-5e-06.model`; its SHA-256 is the
preceding generation's hash. This favors one update and more complete
trajectories as the locked throughput setting; two updates remain useful only
for short quality probes.

### 2026-08-12 locked-pipeline continuation promotion

The locked one-update, uniform-replay, population-retention pipeline continued
for 8,192 balanced games from seed `1208202990`. The run used all 12 CPU cores,
four rates (`0.000001,0.0000025,0.000005,0.00001`), 256 environments, and
completed in 210.83 seconds (38.86 games/second). The lexicographically selected
`0.00001` path traded some Power/round for a consistent win-count increase and
passed every full gate:

| Corpus seed | Candidate wins | Incoming wins | Candidate Power/round | Incoming Power/round |
|---:|---:|---:|---:|---:|
| 1208202993 | 3,885/4,800 | 3,783/4,800 | 1.72654 | 1.77230 |
| 1208202994 (independent confirmation) | 3,844/4,800 | 3,806/4,800 | 1.73090 | 1.76146 |
| 1208202995 (`go:promote --apply`) | 3,908/4,800 | 3,836/4,800 | 1.78424 | 1.80994 |

The promoted checkpoint is `locked-small5-1208202990/gpu-lr-1e-05.model`;
its SHA-256 is the preceding generation's hash. Lower Power/round does
not override the win gain: Power/round is a tie-breaker only when wins are
exactly tied.

### 2026-08-12 16k locked-pipeline promotion

A longer locked continuation generated 16,384 balanced games from seed
`1208203030` using 12 CPU cores and Metal/MPS. Uniform replay, one update per
game, four lower rate paths (`0.0000005,0.000001,0.0000025,0.000005`), and the
frozen-champion population actor were unchanged. It completed in 415.54 seconds
(39.43 games/second). The `0.000005` candidate passed all full gates:

| Corpus seed | Candidate wins | Incoming wins | Candidate Power/round | Incoming Power/round |
|---:|---:|---:|---:|---:|
| 1208203033 | 3,980/4,800 | 3,871/4,800 | 1.73423 | 1.76491 |
| 1208203034 (independent confirmation) | 3,947/4,800 | 3,905/4,800 | 1.75822 | 1.78512 |
| 1208203035 (`go:promote --apply`) | 3,991/4,800 | 3,882/4,800 | 1.73430 | 1.76339 |

The promoted checkpoint is `locked-small5-1208203030/gpu-lr-5e-06.model`;
its SHA-256 is the current small5 artifact hash above. The final gate win rate
is 83.15%; training remains win-focused rather than shifting to Power/round.

## World Daemon

Shared-experience population training produced progressive and repeatable
improvement on fresh corpus `3451082026`:

| Model | Wins | Win rate | Training Power/round |
|---|---:|---:|---:|
| initial v7 champion | 0/48 | 0% | 0.48842 |
| strongest earlier continuation | 0/48 | 0% | 0.73321 |
| **200-game population snapshot, promoted** | **3/48** | **6.25%** | **0.99492** |

The promoted rate path used terminal-outcome rate `0.0000025` and ranking rate
`0.0015`. Later snapshots were not assumed better merely because they trained
longer. The native heuristic teacher won 38/48 (79.17%) on corpus family
`1851082026`, leaving a large but now measurable distillation target.

The paired generator also works on this profile: a 12-opening smoke audit
selected the frozen champion over the teacher once, and the selected routes won
9/12 overall. Thus continuation is not restricted to handcrafted actions.

### 2026-08-12 continuation promotion

A 600-game `duel` population on fresh corpus seed `2026081203` kept the
incoming champion frozen and used outcome rates `0,0.000001,0.0000025`, policy
rates `0.0001,0.00025,0.0005,0.00075`, root width 64, branch width 8, and tree
depth 2. Its 12-game unseen screen (seed `2026081211`) selected
`o1e-06-p0.0001.model`: 3/12 wins and 1.25264 loss-penalized Power/round,
versus the incoming champion's 0/12 and 0.93301.

The finalist passed both 128-game fixed-corpus gates and was promoted:

| Corpus seed | Candidate wins | Incoming wins | Candidate Power/round | Incoming Power/round |
|---:|---:|---:|---:|---:|
| 2026081221 | 12/128 | 10/128 | 1.04486 | 1.00160 |
| 2026081222 (independent confirmation) | 21/128 | 6/128 | 1.10590 | 0.97047 |

The promoted artifact is the rate pair outcome `0.000001`, policy `0.0001`.

## Clean handoff

Only the two promoted models are retained as generated artifacts. Training
runs, screens, superseded checkpoints, and bootstrap TSVs are reproducible and
excluded. The frozen TypeScript teacher remains under `teacher/` as source and
parity reference.

KataGo is now available as the third `trio` adviser without changing either
promoted artifact. Its independent proof is recorded in `katago/RESULTS.md`:
predictive advice won 183/192 ordinary 5×5 games versus 167/192 for the
handcrafted control, while plain KataGo was retained for World Daemon because
both variants went 8/8 there and plain advice had the better Power/round
tie-break. Promotion still depends only on the fixed native gates above.
