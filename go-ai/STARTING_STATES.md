# Starting-state census

`go_cpp_starting_states` exhausts all 150,000 WHRNG phases in the 30,000-second
period at Bitburner's 200 ms engine resolution. It unions board hashes, so
different seeds which generate the same board count once. For the unseeded
handicap choice it includes every choice with non-zero probability, rather than
sampling one `Math.random()` outcome.

Measured against the v3.0.1 transcription:

| Family | Unique starting boards |
|---|---:|
| Any non-handicap 5x5 faction | 8,164 |
| Illuminati 5x5, including its one white handicap stone | 46,258 |
| Union of all relevant 5x5 starts | 54,422 |
| World Daemon 19x19 | 407,340,975,756 |

The 2026-08-14 parity fix preserved these support counts but changed the 5x5
sampling weights. Upstream's raw `centerBreak` roll contributes numerically to
`obstacleTypeCount`; treating it as a boolean over-sampled edge obstacles for
rolls 2 and 3. A matching unique-board census therefore does **not** prove that
an old sampled playbook has the correct distribution. All pre-fix small5
playbooks are incompatible with current training. Daemon19 is unaffected.

The World Daemon's offline-node topology is fixed, but its seven initial white
stones are an unseeded selection from 157 expansion locations. The count is
therefore `C(157, 7)`, not one starting board. We cannot pre-populate that state
space exhaustively; training must sample it and exploit spatial/generalized
value estimates.

Reproduce the census with:

```sh
go-ai/build/release/go_cpp_starting_states
```

These are starting boards, not graph nodes. A reachable-state identity also
needs pass count, side to move, and the positional-superko history set. Two
visually identical boards with different histories can have different legal
edges, so merging them by board hash alone would silently re-allow repeats.
