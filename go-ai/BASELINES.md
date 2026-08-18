# Current V9 baselines

These are the only champion and runtime baselines used for new comparisons.
All new arenas use the corrected stochastic future-timing environment and
fresh paired playtime, handicap, and defense streams.

## Installed champions

| Profile | Full-f32 SHA-256 | Full checkpoint | Production payload | Selector |
|---|---|---:|---:|---|
| `small5` | `4ff250e3cfd9e55bf5219c08eab8d02fc9dee7aafc385aad7cb521fa5b5e89bf` | current V9 maximum | 306,654 B before optional derivative | K=4 deep |
| `daemon19` | `219f83c701fdc21faed575d1f0da22221b45385231744994af9f0f1c5b7e24ea` | 32x6 trunk, rank-32 global, tactical-v1 | see `go:export --check` | strict K=1 |

There is currently no qualified replacement candidate. Active data generation
is listed in [`TRAINING_CHECKPOINT.md`](TRAINING_CHECKPOINT.md).

## Champion evidence

The daemon19 champion was replaced on 2026-08-17. Candidate
`219f83c701fd...` won **453/512 (88.48%)** against the former incumbent
`aaaefd114d9f...` at **408/512 (79.69%)** on fresh corpus `81555501`, with 93
favorable and 48 unfavorable paired win flips (one-sided sign
`p=0.000094`), +0.045229 Power/turn (95% lower bound +0.026403), 1.60 fewer
mean turns and +5,451 points. Decision latency was 3.2/4.6 ms p50/p95, well
inside the 15/18 ms strict-K=1 budget. The golden fixture was regenerated and
the WGSL shader gate passed before install.

It was produced by two joint changes over the previous champion: a 2.7x larger
KataGo DAgger corpus (4,075 new labels on the incumbent's own states, 2,865 of
them genuine corrections) **and** more capacity (32x6 trunk with a rank-32
global correction). Neither alone was sufficient: the same enlarged corpus at
the old 16x4/rank-16 capacity reached only 34.97% held-out exact KataGo
agreement versus the incumbent's 34.70%, while 32x6 reached 36.19%. Its value
head is neutral and does not participate in production selection.

The previous K=1 model had itself been promoted after 421/512 wins against a
0/512 incumbent.

The installed Small5 champion remains the full-f32 authority. On the corrected
production selector, two independent 768-game comparisons established K=4
deep search over flat K=8:

| Selector | Screen 1 | Screen 2 | Decision p50/p95 |
|---|---:|---:|---:|
| flat K=8 | 671/768 | 667/768 | 2.7/4.6 ms |
| K=4, follow-up K=3, ±1 timing tick | 723/768 | 718/768 | 5.2/9.0 ms |

Both screens had approximately 75/22 favorable/unfavorable flips, positive
Power/turn lower bounds, and fewer turns. Small5 comparisons therefore use the
K=4 deep selector, never flat K=4.

The latest corrected certified-data candidate scored 11,433/12,288 versus the
champion's 11,425/12,288, but its 161/153 paired flips gave `p=0.346442`.
It was not promoted and is not retained as a candidate.

<<<<<<< HEAD
### V9 route-prior refit (2026-08-14)

The simulator economics table was refitted through the promoted Chromium/WGSL
runtime with tie roll 0.5 and seed start 123456. Ordinary opponents use 128
games each; Illuminati uses 512. Scores and durations below are corpus means:

| Opponent | Wins | Mean black score | Mean AI duration |
|---|---:|---:|---:|
| Netburners | 128/128 | 15.4922 | 4.6188 s |
| Slum Snakes | 127/128 | 15.8281 | 6.8266 s |
| The Black Hand | 125/128 | 14.9453 | 9.0625 s |
| Tetrads | 106/128 | 13.3906 | 11.6703 s |
| Daedalus | 112/128 | 13.7578 | 9.3625 s |
| Illuminati | 261/512 | 8.9688 | 13.5250 s |

`GO_REWARD_RULES` normalizes the latter two columns by the 5x5 arena's 23
expected playable intersections. The World Daemon retains its prior pooled
128-game promotion gates because this refit did not rerun that expensive lane.

The synchronized worker smoke measured a 49.1 ms cold 5x5 decision, a 0.2 ms
repeated RPC cache hit, and a 0.2 ms consumed pushed prediction. The unsolicited
next decision arrived 79 ms before its modeled Black-turn deadline. The same
test confirms compact clock/response synchronization, deliberate desync
detection, and reset/reinstall recovery.
=======
## Measured and not adopted

A one-cycle **seed wait** — when the lookahead says every continuation loses,
dispatch a tick later at a different White seed instead — is implemented behind
`GO_PROFILE_SEED_WAIT` and left disabled. Two detectors were measured:

| Detector | Corpus | Control | With wait | Waits | Decision p50/p95 |
|---|---|---:|---:|---:|---:|
| value head, below 0.5 win | Small5 field, 2,304 games | 2,151 | 2,153 | 22 | 5.1/10 ms |
| value head, below 0.9 win | Illuminati, 384 games | 294 | 291 | 109 | 8.5/24.9 ms |
| rollout, 40 ply | Illuminati, 384 games | 283 | 294 | 151 | 20.6/55.8 ms |
| rollout, 40 ply (replication) | Illuminati, 384 games | 292 | 296 | 148 | 20.6/55.5 ms |
| value head, below 0.5 win | daemon19, 128 games | 111 | 111 | 0 | 3.1/4.7 ms |
| rollout, 30 ply | daemon19, 48 games | 40 | 42 | 194 | 218.5/292.6 ms |

The value head is not a usable loss signal: on Small5 it fires almost never at
0.5, and at 0.9 it fires often and loses games, because "unsure" does not
identify which seed is better. On the policy-only profile it reports nothing at
all — its value head is neutral by construction, so the wait never triggers and
the games are identical.

Playing the line out does work: pooled over two disjoint Illuminati corpora the
rollout detector wins 590/768 against 575/768, +20/-5 paired flips. The
daemon19 rollout arm points the same way at 42/48 against 40/48, but +4/-2 on
48 games decides nothing.

It stays disabled because of where the cost lands, not whether it helps: a
rollout costs one policy pass per ply, which is 55 ms p95 on Small5 against a
50 ms budget and 292 ms on daemon19 against 18 ms. The work belongs in the
worker's push-ahead window, computed for likely successor positions while the
opponent is thinking, so a turn spends only the remainder of its own cycle.

## Promotion gate
>>>>>>> e2a40c1b (Finalize the 5x5 Go pipeline and embed the certified playbook)

`bun run go:promote` is the sole champion installer. Apply gates require:

- Small5: at least 2,048 games per opponent, 12,288 per model;
- daemon19: at least 512 games;
- unused explicit playtime, handicap, and defense streams;
- successful full-f32 export, golden, parity, and production WebGPU checks;
- a one-sided paired win-flip test at `p <= 0.05` when wins improve.

On an exact win tie, Power/turn advances only when its paired 95% lower bound is
positive; fewer turns is the final tie-break under the same rule. Every screen
and gate burns its streams in `promotion-seeds.json`, including failed or
interrupted runs.

## Numerical/runtime gates

- C++ maximum relative error: `2e-4`.
- Proposal element agreement after export: at least 99.9% within tolerance.
- Top-shortlist agreement: at least 99%.
- daemon19 K=1 must remain a single policy dispatch with no value evaluation.
- Small5 must evaluate only post-White-response states and remain below the
  production 50 ms p95 decision budget.

Post-promotion derivatives and their independent gates are documented in
[`DEPLOYMENT.md`](DEPLOYMENT.md). They never change champion identity.
