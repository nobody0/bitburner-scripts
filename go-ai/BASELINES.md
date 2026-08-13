# Current V9 deployment baselines

These are the deployed champions as of 2026-08-13. They are bootstrap
selections: they establish the artifact and WebGPU pipeline, and they set the
bar that `go:promote` measures the next candidate against.

## Promoted checkpoints

| Profile | Champion SHA-256 | q8 payload | Generated module |
|---|---|---:|---:|
| `small5` | `437f1cfecabcec061c2b85eb578667f6a89272b7e854ff758956bde84c47c942` | 306,654 B | 409,565 B |
| `daemon19` | `c73cb5811a441e466c4a6112da313c53f37219d68ef499b69c5e8a39ac71703e` | 680,926 B | 908,604 B |

Both champion files and both generated artifacts are V9. Export accepts no
other topology and has one encoding: row-wise int8 matrices with float16
biases. The generated modules record the full-precision source hash and the
encoded-payload hash.

Export strips the auxiliary 13-way response-branch head (10,842 small5 and
16,250 daemon19 parameters). It is useful for training representation but not
for play: exact TypeScript rules resolve response branches for retained moves.

## Bootstrap selection evidence

The selections were evaluated after q8 export through the production WGSL
backend in Chrome. No CPU gameplay evaluator contributed to the decision.

- The checkpoint now installed as `small5-champion.model` won 65/72 games
  (90.28%) on corpus
  seed `9918273`, scoring +215 points with 5.0 ms p95 decision latency. The two
  other finalists won 63/72 and 61/72.
- The checkpoint now installed as `daemon19-champion.model` was the best of the completed fixed-seed daemon
  screens before the runtime-focused cut: 0/4 wins and -1,098 points on seed
  `8827119`. This is deliberately a weak bootstrap; establishing V9 deployment
  correctness does not turn a poor checkpoint into a good model.

Future promotion uses `go:promote`, which exports champion and candidate in
turn and plays the same unseen corpus through WebGPU. Wins are compared first;
point difference breaks an exact win tie.

## Full-precision champion to q8 WebGPU gate

`go:golden` obtains every deployed value and move output directly from the
exact full-precision V9 champions. The browser evaluates the exported q8 artifacts.
The current gate reports:

| Metric | Result | Required |
|---|---:|---:|
| Deployed proposal elements within q8 tolerance | 100% | at least 99.9% |
| Top-8 shortlist agreement | 100% | at least 99% |
| Maximum win-probability absolute error | 0.245 percentage points | at most 0.3 points |
| Maximum terminal-power relative error | 1.77% | at most 2% |
| Maximum remaining-rounds relative error | 1.09% | at most 2% |

The q8 payloads are 74.7% smaller than the corresponding deployed float32 tensors. Brotli was measured
on the already-quantized payloads and retained 91.9% of their binary size, so
the modest extra reduction does not justify asynchronous decompression and a
larger runtime surface.

## WebGPU runtime baseline

Continuation evaluation has a dedicated value-only shader path. It skips move
and branch heads and copies three floats per board instead of the full proposal
tensor. The retained kernel uses workgroup-local convolution reuse, vec4
channel accumulation, and float16 activation/scratch storage with float32
accumulation. Each optimization has an independent `on|off` harness flag. On
the bootstrap machine:

| Workload | Request-to-result p50 | p95 | Main-thread p95 |
|---|---:|---:|---:|
| small5, 28 continuation boards | 0.7 ms | 0.9 ms | 0.1 ms |
| daemon19, 104 continuation boards | 29.3 ms | 29.7 ms | 0.1 ms |

The paired scalar float32 baseline was 40.2 ms p50 for the daemon batch. Direct q8
shader reads were removed after regressing that median to 95.9 ms. Mixed q4
export was also removed: compressing either the residual trunk or first value
matrix independently exceeded the correctness bounds, despite reducing the
daemon payload to 515,038 B or 527,326 B respectively.

The complete WebGPU smoke arena finished every game. Results were 12/12 against
Netburners, Slum Snakes, and The Black Hand; 11/12 against Tetrads and
Daedalus; 8/12 against Illuminati; and 0/2 against the World Daemon. Ordinary
opponent p95 decision latency was 4.5–6.0 ms. World Daemon latency was 23.3 ms
p50 and 54.1 ms p95.

The synchronized worker smoke measured a 49.1 ms cold 5x5 decision, a 0.2 ms
repeated RPC cache hit, and a 0.2 ms consumed pushed prediction. The unsolicited
next decision arrived 79 ms before its modeled Black-turn deadline. The same
test confirms compact clock/response synchronization, deliberate desync
detection, and reset/reinstall recovery.

A short fixed-seed shortlist frontier selected a base limit of 8. Limits 8 and
16 both won 29/36 ordinary games, while their single-game daemon p95 latencies
were 39.5 ms and 55.6 ms. Limit 4 was faster (21.5 ms) but fell to 28/36
ordinary wins. The adaptive flat-boundary expansion remains enabled, so base 8
retained 14.94 finalists on average in that daemon game rather than imposing a
hard cap.

These finite corpora are regression baselines, not population win-rate proofs.

## Paused training trajectory

The deployed champions above remain unchanged. The pruned research checkpoint,
failed experiments, and next two-machine training procedure are recorded in
[`TRAINING_CHECKPOINT.md`](TRAINING_CHECKPOINT.md). In particular, the retained
daemon research model has one fixed K=16 win in 128 games and approximately
80% unseen safe-move recall, but it does not satisfy the 99.5% exhaustive
shortlist gate and is not a promotion candidate.

## 5x5 post-training structured-distillation proof

The optional `go:compress:v9` stage was proven against the promoted 5x5 V9
champion on 2026-08-13. It uses dense structured students, post-response value
distillation, exporter-exact q8/f16 quantization-aware recovery, and explicit
flags; it neither installs nor promotes a checkpoint.

The retained proof student keeps the full 32-channel, four-block spatial trunk
and reduces only the value head from 256/64 to 192/48:

- q8 payload: 306,654 -> 247,758 bytes, a 19.2% reduction;
- deployed parameters: 302,949 -> 244,453, a 19.3% reduction;
- held-out champion top-8 element agreement: 99.83%;
- held-out value p95 error: 1.53 percentage points win probability, 9.14%
  terminal power, and 9.46% remaining turns;
- candidate-specific C++ checkpoint -> q8/f16 WebGPU gate: 0.245 percentage
  points maximum win deviation, 0.352% power, 0.522% remaining turns, 100%
  proposal-element and top-8 agreement;
- paired 72-game Chrome/WebGPU proof: 64 wins and +201 points versus the
  champion's 61 wins and +84 points. This is encouraging, not a promotion-size
  strength sample;
- paired decision latency: 1.6/3.8 ms p50/p95 versus 1.6/3.7 ms. Head-only
  compression therefore reduces size but does not establish a speed win; the
  unchanged convolutional trunk dominates.

A 28-channel student reduced the payload to 236,070 bytes (23.0%) but was
rejected before WebGPU games: held-out top-8 recall 97.30%, target-set recall
90.09%, and champion top-8 agreement 98.13%. Channel/block compression remains
an explicitly enabled experiment, not the maintained default. A non-QAT
224/56 head student was also rejected by the export gate (0.566 percentage
points win and 2.85% power drift); quantization-aware recovery is consequently
enabled by default.

### Optional low-rank value export

A q8-aware rank-128 factorization of the retained 192/48 student's first value
matrix passed the static and browser gates. It is retained behind
`--value-rank 128`; zero remains the default because speed was neutral rather
than conclusively better:

- q8 payload: 306,654 -> 221,646 bytes, a 27.7% reduction from the champion
  and 26,112 bytes below the same student's dense export;
- deployed parameters: 302,949 -> 217,829, a 28.1% champion reduction;
- held-out value p95 error: 1.76 percentage points win probability, 8.61%
  terminal power, and 9.26% remaining turns;
- full-checkpoint C++ parity relative error: `4.45e-7`;
- factor-q8 WebGPU versus the reconstructed full checkpoint: 0.245 percentage
  points maximum win deviation, 0.352% power, 0.522% remaining turns, and 100%
  proposal-element/top-8 agreement;
- matched-seed 144-game WebGPU A/B: dense and factorized exports both won
  124 games; decision latency was 2.6/5.2 ms versus 2.6/5.1 ms p50/p95.

Ranks 64 and 96 failed the held-out value gates. The initial rank-128 recovery
also missed the remaining-turn gate; only the recovered rank-128 bundle was
kept. A separate direct-read 5x5 pooling kernel was benchmarked and deleted:
its isolated median regressed from 0.6--0.7 ms to 0.8 ms because it discarded
the existing workgroup-local reuse.
