# Current promotion baselines

Promotion uses complete games on identical unseen seeds. More wins always win
the gate; only an exact win tie is broken by higher loss-penalized terminal
Power per total round.

## Promoted artifacts

| Profile | Artifact | Neural input | SHA-256 |
|---|---|---|---|
| six ordinary enemies on 5x5 | `small5-champion.model` | resulting board plus enemy identity | `f7ba0ae8733d2634e330fb381664b952aaf5ba949b7690b4220d0758fcc0b9fa` |
| World Daemon on 19x19 | `daemon19-champion.model` | resulting board; no enemy input | `cccab618a6c8c04acf869f92daf40ba7f120975bbe91251c97b17565ee4f628e` |

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
its SHA-256 is the preceding generation's hash. The final gate win rate
is 83.15%; training remains win-focused rather than shifting to Power/round.

### 2026-08-12 low-rate 16k continuation promotion

The same locked pipeline continued for 16,384 games from seed `1208203060`,
using 12 CPU cores, Metal/MPS, uniform replay, one update per game, and rates
`0.0000005,0.000001,0.0000025,0.000005`. It completed in 429.67 seconds
(38.13 games/second). The conservative `0.000001` path passed all full gates:

| Corpus seed | Candidate wins | Incoming wins | Candidate Power/round | Incoming Power/round |
|---:|---:|---:|---:|---:|
| 1208203062 | 4,003/4,800 | 4,000/4,800 | 1.76381 | 1.76295 |
| 1208203063 (independent confirmation) | 4,040/4,800 | 4,017/4,800 | 1.76546 | 1.76039 |
| 1208203064 (`go:promote --apply`) | 3,998/4,800 | 3,992/4,800 | 1.76376 | 1.76257 |

The promoted checkpoint is `locked-small5-1208203060/gpu-lr-1e-06.model`;
its SHA-256 is the preceding generation's hash. The gain is small but
strictly lexicographic and independently repeated; the profile is still only
83.29% on the final corpus, so win-first training remains active.

### 2026-08-13 32k locked-pipeline promotion

The locked equal-head pipeline continued for 32,768 balanced games from seed
`1208203100`, using 12 CPU workers, Metal/MPS, uniform replay, one update per
game, 256 environments, and rates
`0.0000005,0.000001,0.0000025,0.000005`. It completed in 810.87 seconds
(40.41 games/second). A win-only ablation immediately before this run failed
its full proof, so all three value targets remained equally weighted. The
`0.0000025` candidate passed both independent proofs and the apply gate:

| Corpus seed | Candidate wins | Incoming wins | Candidate Power/round | Incoming Power/round |
|---:|---:|---:|---:|---:|
| 1208203102 | 4,065/4,800 | 3,997/4,800 | 1.77287 | 1.74614 |
| 1208203103 (independent confirmation) | 4,019/4,800 | 4,000/4,800 | 1.73991 | 1.77015 |
| 1208203104 (`go:promote --apply`) | 4,062/4,800 | 4,013/4,800 | 1.74349 | 1.74702 |

The promoted checkpoint is
`locked-small5-equal-1208203100/gpu-lr-2_5e-06.model`; its SHA-256 is the
preceding generation's hash. The final gate reached 84.63%, so the
profile remains win-first rather than shifting to Power/round optimization.

### 2026-08-13 low-rate 32k continuation promotion

The same locked pipeline continued for 32,768 balanced games from seed
`1208203112`, using all 12 CPU workers and Metal/MPS. The rate range moved down
to `0.00000025,0.0000005,0.000001,0.0000025`; uniform replay, equal weighting
of all three value targets, one update per game, 256 environments, and frozen
champion retention were unchanged. It completed in 811.81 seconds (40.36
games/second). The `0.0000025` path passed every full gate and increased both
win count and Power/round on all three corpora:

| Corpus seed | Candidate wins | Incoming wins | Candidate Power/round | Incoming Power/round |
|---:|---:|---:|---:|---:|
| 1208203114 | 4,092/4,800 | 4,024/4,800 | 1.76223 | 1.72935 |
| 1208203115 (independent confirmation) | 4,075/4,800 | 3,997/4,800 | 1.76970 | 1.73879 |
| 1208203116 (`go:promote --apply`) | 4,060/4,800 | 4,032/4,800 | 1.76444 | 1.72447 |

The promoted checkpoint is
`locked-small5-equal-1208203112/gpu-lr-2_5e-06.model`; its SHA-256 is the
preceding generation's hash. The final-gate win rate is 84.58%, so the
profile remains win-first.

### 2026-08-13 conservative-rate 32k promotion

The locked pipeline continued for another 32,768 balanced games from seed
`1208203126`, narrowing rates to
`0.0000001,0.00000025,0.0000005,0.000001`. It used 12 CPU workers, Metal/MPS,
uniform replay, equal three-head loss, one update per game, 256 environments,
and frozen champion retention. It completed in 811.55 seconds (40.38
games/second). The `0.0000005` candidate passed both full proofs and the apply
gate; the second proof's two-win margin still outranks its lower Power/round
under the fixed lexicographic rule:

| Corpus seed | Candidate wins | Incoming wins | Candidate Power/round | Incoming Power/round |
|---:|---:|---:|---:|---:|
| 1208203128 | 4,123/4,800 | 4,107/4,800 | 1.78758 | 1.77341 |
| 1208203129 (independent confirmation) | 4,053/4,800 | 4,051/4,800 | 1.73972 | 1.75026 |
| 1208203130 (`go:promote --apply`) | 4,091/4,800 | 4,070/4,800 | 1.77928 | 1.76104 |

The promoted checkpoint is
`locked-small5-equal-1208203126/gpu-lr-5e-07.model`; its SHA-256 is the current
preceding generation's hash. The final-gate win rate is 85.23%, so win-first
training remains active.

### 2026-08-13 repeated conservative-rate promotion

A fresh 32,768-game continuation from seed `1208203136` repeated the locked
12-worker Metal/MPS pipeline and conservative rates
`0.0000001,0.00000025,0.0000005,0.000001`. Uniform replay, equal three-head
loss, one update per game, 256 environments, and frozen champion retention
were unchanged. It completed in 814.10 seconds (40.25 games/second). The
`0.0000005` path improved both lexicographic metrics on all three full gates:

| Corpus seed | Candidate wins | Incoming wins | Candidate Power/round | Incoming Power/round |
|---:|---:|---:|---:|---:|
| 1208203138 | 4,148/4,800 | 4,141/4,800 | 1.80995 | 1.80289 |
| 1208203139 (independent confirmation) | 4,105/4,800 | 4,080/4,800 | 1.79277 | 1.77855 |
| 1208203140 (`go:promote --apply`) | 4,107/4,800 | 4,070/4,800 | 1.78898 | 1.75472 |

The promoted checkpoint is
`locked-small5-equal-1208203136/gpu-lr-5e-07.model`; its SHA-256 is the current
small5 artifact hash above. The final-gate win rate is 85.56%, so win-first
training remains active.

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

### 2026-08-13 wide-shortlist KataGo promotion

A 384-game `trio` population on seed `1208203106` used all 12 CPU workers and
two Metal/OpenCL KataGo adviser processes. Increasing the plain KataGo
shortlist from 4 to 32 supplied ranking supervision over a substantially
larger fraction of the roughly 400 legal deployment choices without reducing
measured trajectory throughput. The frozen incoming champion remained the
retention adviser. Outcome rates were `0,0.0000001`; policy rates were
`0.000001,0.0000025,0.000005,0.00001`. The selected checkpoint used outcome
rate `0` and policy rate `0.000005`.

| Corpus seed | Candidate wins | Incoming wins | Candidate Power/round | Incoming Power/round |
|---:|---:|---:|---:|---:|
| 1208203108 | 17/128 | 6/128 | 1.05594 | 0.96374 |
| 1208203109 (independent confirmation) | 16/128 | 11/128 | 1.08389 | 1.00640 |
| 1208203110 (`go:promote --apply`) | 23/128 | 15/128 | 1.14074 | 1.04310 |

The promoted checkpoint is
`locked-daemon19-kata32-1208203106/o0-p5e-06.model`; its SHA-256 is the current
daemon19 artifact hash above. The 17.97% final-gate win rate remains far from
saturation, so daemon19 training remains win-first.

### 2026-08-13 Kata-focused pretraining result

The later 32-candidate `trio` populations showed that KataGo supplied the
selected route in nearly every World Daemon opening, while the trainer still
paid for complete handcrafted and frozen-champion trajectories. A new `kata`
research mode retains the exact native board, Bitburner opponent, seed phases,
superko, terminal labels, and Kata rankings, but generates only the advised
trajectory. A 24-game benchmark on seed `1208203146` reached 0.37955 games/s,
versus about 0.204 games/s for the corresponding full `trio` regime. The
384-game pretraining block on seed `1208203148` reached 0.43296 games/s and
selected `o0-p2.5e-06.model` on unseen seed `1208203149`: 5/24 wins and
1.15824 Power/round, versus 3/24 and 1.08021 for the champion.

The candidate then entered the required exact CPU `trio` handoff: 120 games
from seed `1208203150`, retaining the official champion and testing the raw
candidate plus seven low-rate refinements. Kata supplied 119/120 selected
routes, and throughput was 0.23711 games/s. On unseen screen seed `1208203151`
the champion scored 3/24 and 1.05358 Power/round; the unchanged candidate scored
1/24 and 0.95665, and no refinement exceeded 2/24. All were rejected, so the
promoted daemon19 artifact remains unchanged. The result locks `kata` mode in
as the faster research pretraining stage, never as a substitute for the CPU
handoff or independent promotion gates.

## Runtime storage gate

The deployment experiment was isolated under `go-ai/experiments/` and removed
after selecting the formats. Randomized board-value sweeps found no top-choice
changes in 160 candidate groups per profile for either float16 or row-wise
int8, but complete-game evaluation exposed a profile-specific sensitivity that
pointwise error did not:

| Profile and corpus | Float32 wins | Candidate storage wins | Decision |
|---|---:|---:|---|
| small5, seed 10992001, 2,400 mixed games | 2,055 | 2,057 int8 | row-wise int8 + float16 biases |
| daemon19, seed 7193001, 16 games | 4 | 0 int8 | reject int8 |
| daemon19, seed 7193001, 16 games | 4 | 4 float16 | float16 |

The accepted daemon float16 artifact also improved the exact-win-tie
Power/round from 1.20804 to 1.21537 on that corpus. The generated payloads are
29,812 raw bytes for small5 and 52,678 for daemon19, or 109,992 base64
characters together. They expand once to the existing float32 WebGPU layout;
the measured warm 400-board shader p95 remained below 1 ms. With
whitespace-only bundle minification, `start.js` fell from 1,151,718 to 773,692
bytes. The experiment left no retained checkpoints or scripts.

`go:promote --apply` now repeats the complete-game comparison between a newly
promoted checkpoint and its decoded runtime artifact. A storage representation
that loses games cannot be installed, even when its pointwise golden-vector
errors look small.

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
