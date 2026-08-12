# KataGo IPvGO adviser proof

Run on 2026-08-12 with the independent upstream-backed arena:

```sh
bun run go-ai/katago/arena.ts --games 32 --visits 8 \
  --out go-ai/katago/results/final-v8-g32.json
```

The corpus used 32 engine-time seeds beginning at `31,337,000`, spread across
the WHRNG period by `goArenaSeeds`, and fixed the independently unseeded
opponent tie roll at `0.5`. KataGo and the handcrafted control received the
same initial board and opponent randomness. Every terminal result was scored
by the native IPvGO rules implementation, not KataGo.

| Opponent | Board | KataGo | Handcrafted | Win-rate delta | KataGo / control cumulative margin |
| --- | ---: | ---: | ---: | ---: | ---: |
| Netburners | 5×5 | 32–0 (100.0%) | 32–0 (100.0%) | 0.0 pp | +561 / +450 |
| Slum Snakes | 5×5 | 30–2 (93.8%) | 32–0 (100.0%) | -6.2 pp | +488 / +402 |
| The Black Hand | 5×5 | 30–2 (93.8%) | 28–4 (87.5%) | +6.2 pp | +450 / +284 |
| Tetrads | 5×5 | 30–2 (93.8%) | 25–7 (78.1%) | +15.6 pp | +400 / +167 |
| Daedalus | 5×5 | 30–2 (93.8%) | 29–3 (90.6%) | +3.1 pp | +366 / +139 |
| Illuminati | 5×5 | 21–11 (65.6%) | 21–11 (65.6%) | 0.0 pp | +171 / +107 |
| `????????????` | 19×19 | 32–0 (100.0%) | 16–16 (50.0%) | +50.0 pp | +4004 / +38 |

Across the 224 games, KataGo won 205 and the handcrafted policy won 183.
KataGo matched or beat the control on six of seven opponent lanes; its only
deficit was two games against Slum Snakes. All 224 KataGo games ended normally
on two passes, with no illegal proposal accepted by the arena.

The 32–0 lanes have a 95% Wilson lower bound of 89.3%; the Illuminati result's
lower bound is 48.3%. This is evidence that the adviser meets the requested
baseline, not a claim that eight-visit search is optimal. KataGo retains its
normal internal search seed, so reruns should reproduce the corpus and
aggregate behavior rather than every move bit-for-bit.

## Pinned inputs

- KataGo `v1.16.3`, commit `802946dbb15ab7b52f6fa18e777ec8f8f65bfaff`
- 5×5 Rect15 `b20c256`, SHA-256
  `32376ad0f23e4f893bc4b99e4a9ad77dc1963832d31cabf0b165f9c4d888ab83`
- 19×19 kata1 `b10c128`, SHA-256
  `af94ec4a0551a3d11236c33c22667edac1deada29d448e43d824329e8db89394`

Median adviser latency was 66–75 ms on 5×5 and 38 ms on 19×19. The 19×19
model is deliberately smaller. These timings are informational: both existing
population trainers were running concurrently, and neither their harness nor
their model files were touched.

## Predictive forced-reply adviser

The follow-up proof uses KataGo's policy to shortlist four Black moves,
predicts the exact Bitburner response to each, then evaluates each candidate
with that White reply forced. It used two visits for the shortlist and two per
candidate (ten nominal visits per decision), versus eight visits for the plain
KataGo proof.

Selection matches the bespoke trainer: wins are lexicographically primary;
Power per round is consulted only after win probability ties. The full 5×5
command was:

```sh
bun run go-ai/katago/arena.ts --predictive --profile small5 \
  --games 32 --policy-visits 2 --candidates 4 --visits 2 --no-control
```

| Opponent | Predictive | Plain KataGo | Handcrafted | Predictive / plain game Power per round |
| --- | ---: | ---: | ---: | ---: |
| Netburners | 32–0 | 32–0 | 32–0 | 0.952 / 0.816 |
| Slum Snakes | 32–0 | 30–2 | 32–0 | 1.944 / 1.657 |
| The Black Hand | 32–0 | 30–2 | 28–4 | 1.549 / 1.475 |
| Tetrads | 32–0 | 30–2 | 25–7 | 2.508 / 2.206 |
| Daedalus | 32–0 | 30–2 | 29–3 | 2.576 / 2.113 |
| Illuminati | 23–9 | 21–11 | 21–11 | 7.981 / 10.985 |

Predictive KataGo won 183/192, versus 173/192 for plain KataGo and 167/192
for the handcrafted policy. Under the required lexicographic objective it beat
plain KataGo on every faction lane: Netburners tied on wins and improved the
Power-rate tie-break; all other factions gained wins. Illuminati's raw Power
rate fell, but the two extra wins take precedence and protect the streak.

The daemon result was deliberately reversed. On the same eight seeds both
policies went 8–0, but predictive KataGo earned 3.459 Power/round at 225 ms
median adviser latency, versus plain KataGo's 3.661 Power/round at 31 ms. The
retained recommendation is therefore predictive KataGo on 5×5 and plain
KataGo on the 19×19 daemon. Machine-readable aggregates are in
`proof/predictive-v2-c4.json`.

## Integrated trainer smoke

The production `trio` path was built separately from the active training
binary and exercised end to end on a six-opening balanced 5×5 corpus and one
19×19 daemon opening. Both runs started the persistent sidecar, completed all
three native trajectories, and selected the Kata route through the shared
admission function:

| Profile/opponent | Result | Selected Power/round | Adviser selected |
| --- | ---: | ---: | ---: |
| `small5` / balanced six, corpus seed `8675320` | 6/6 wins | 4.2966 | 6/6 |
| `daemon19` / `????????????`, corpus seed `8675310` | 1/1 win | 3.9370 | 1/1 |

These are integration checks, not new win-rate estimates. The larger arena
proof above remains the evidence for adviser quality.
