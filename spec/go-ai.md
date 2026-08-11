# IPvGO policy and arena

The production policy is tested against the independently vendored Bitburner
v3.0.1 AI, not against its own clean-room opponent transcription.

```sh
bun run go:arena -- --games 24
bun run go:arena -- --games 256 --opponent Illuminati
bun run go:arena -- --games 64 --opponent Illuminati --all-ties
bun run go:arena -- --games 256 --opponent Illuminati --disable-policy-book
bun run go:book:train -- --games 1024 --width 3 --phase-samples 3 --min-visits 3
bun run go:book:train -- --opponent Daedalus --games 1024
bun run go:teacher -- --games 8 --max-empty 6 --nodes 20000
bun run go:arena -- --games 64 --opponent Illuminati --board-size 7 --analysis-width 5
bun run go:arena -- --games 4 --opponent secret --trace
bun run go:arena -- --games 64 --opponent secret --forecast-width 0
bun run go:book:train -- --opponent secret --games 1024
```

The default seed corpus walks engine ticks with a stride coprime to the
Wichmann-Hill RNG's 150,000-tick period. Do not replace it with a small constant
millisecond step: that samples only a narrow set of RNG phases. `--seed` selects
a disjoint starting phase; `--seed-step` exists only for reproducing older
linear corpora.

Each JSON summary reports wins, score difference, mean black score and game
duration, a Wilson 95% lower bound, decision latency percentiles, and
replayable losing seeds. `--trace` adds every
input board, history, dispatch playtime, chosen move, predicted response and
actual upstream response. `--all-ties` repeats games across the full set of
representative values for the one intentionally unseeded defense tie.

## Live decision bound

On 5x5 boards every legal black move receives a cheap static evaluation. A
fixed four-move shortlist is retained for ordinary opponents; Daedalus and
Illuminati keep five. An opponent-specific width of three to five candidates
receives the exact immediate white response. Each exact leaf includes one cheap black initiative
ply; Illuminati checks the best 14 legal black continuations because quiet
connections were the main source of shallow-search losses. The evaluator uses
typed arrays and allocation-free flood fills so this wider search remains inside the hot
path budget. There is no wall-clock cutoff: the work bound is deterministic,
so simulator and live decisions cannot drift with machine load.

Illuminati fully trusts the exact modeled reply, uses a 0.4 chain-cohesion
prior, and adds a nonlinear bonus for a leaf that is already ahead after its
7.5 komi. This reflects the actual objective:
crossing the win threshold is more valuable than adding the same heuristic
liberties to a line that still loses. Before the policy book, uncertainty-
adaptive deepening wins 2,807/4,480 (62.7%) across seven independent 128-seed
phases and all five representative unseeded defense-tie values, up from
2,743/4,480 (61.2%) when both deep continuations always belonged to the top
static root. Across four 256-seed phases with the midpoint tie-break it wins
657/1,024 (64.2%), up from 652/1,024 (63.7%).

The selective five-ply line activates only after the board falls to 12 empty
intersections. Normally the best static root's two strongest black
continuations receive a second exact Illuminati forecast and one final cheap
black initiative ply. When the two leading root scores are within 0.05, one
continuation is assigned to each root instead. This spends the same fixed work
while covering the ambiguity that the evaluator itself exposes.

The compact policy book now covers both openings and recurring midgames. Its
trainer records real upstream trajectories, drops the final two black
decisions, and replays counterfactual actions from the exact public board,
superko history, pass count and dispatch phase. A correction survives only if
the public board recurs at least three times, regresses no sampled win, and
either converts a loss with at least a two-thirds continuation win rate or
preserves every sampled win while adding at least five terminal score points.
Illuminati uses two iterative 1,024-game discovery phases so the second pass
can learn from paths changed by the first.

The original 221 opening keys are separately checked against an independent
1,024-game activation corpus. Only the 72 which fire at least once survive;
149 dead keys are removed. Counterfactual replacements bring the final table
to 164 exact public-board keys: 87 openings and 77 midgames, reaching as deep
as the ninth black decision in training while never including either of the
last two. A stored action is applied only if it remains in the freshly legal,
exactly forecasted shortlist, so a superko/history disagreement falls back to
bounded search. No seed or hidden RNG state is stored. Rotation expansion was
tested and rejected because upstream scan order is materially asymmetric.
`--disable-policy-book` provides the direct arena control.

On five held-out 512-game midpoint-tie corpora the final policy wins
1,758/2,560 (68.7%), versus 1,613/2,560 (63.0%) with the book disabled and
1,697/2,560 (66.3%) for the old opening-only table. On three held-out 128-seed
corpora repeated across all five defense-tie values it wins 1,357/1,920
(70.7%), versus 1,267/1,920 (66.0%) without the book. In the first held-out
512-game corpus the table activates in 145 games: 137 opening hits and 35
additional midgame hits. Two isolated runs measured 0.98-1.03 ms p50 and
1.97-2.02 ms p95. Cold-start, scheduler, p99 and maximum tails remain visible
in every arena summary. These are measured finite-corpus improvements, not a
claim of solved Go.

The same distillation and acceptance rules apply to every ordinary faction.
Only storage capacity changes with measured difficulty; search width, search
depth, continuation width and exact-reply work do not. The lookup happens
after the complete bounded analysis, and a regression test compares every
analyzed move with the book enabled and disabled. Easier opponents therefore
keep only a few exceptional corrections while the harder factions can retain
more:

| Opponent | Entries | Held-out book wins | Control wins | Difference |
|---|---:|---:|---:|---:|
| Netburners | 4 | 1,016/1,024 | 1,016/1,024 | 0 wins, +81 score |
| Slum Snakes | 8 | 978/1,024 | 972/1,024 | +6 wins |
| The Black Hand | 12 | 933/1,024 | 915/1,024 | +18 wins |
| Tetrads | 24 | 784/1,024 | 753/1,024 | +31 wins |
| Daedalus | 64 | 875/1,024 | 836/1,024 | +39 wins |
| Illuminati | 164 | 1,758/2,560 | 1,613/2,560 | +145 wins |

These non-Illuminati controls combine two disjoint 512-game engine-phase
corpora. Netburners already wins essentially every game, so its four entries
are useful only if they preserve all wins while improving terminal score. For
the remaining factions, larger books correspond to larger measured held-out
win gains rather than being filled with lower-quality actions. A separate
640-game corpus spanning all five defense-tie values remained non-regressive:
Netburners tied its control, while Slum Snakes, Black Hand, Tetrads and
Daedalus gained 10, 5, 30 and 30 wins respectively.

`go:teacher` is deliberately not a live policy. It runs exact-to-terminal
search offline against the clean-room opponent model, including branch timing,
superko history, passes, and every unseeded defense tie. A node-cap exhaustion
produces no label. The tool reports the earliest exactly solved state in each
arena loss, whether it was still recoverable, and whether the terminal teacher
would change the deployed move. This supplies honest labels for future policy
book extensions without putting unbounded search in `game/`.
The relaxed larger-board budget does not by itself make Illuminati easier: the
reward planner therefore keeps the stronger 5x5 route. It does, however, make
inherited/manual boards much less fragile. The deterministic size table is:

| Board | p95 target | Static finalists | Exact reply finalists |
|---|---:|---:|---:|
| 5x5 | 2 ms | 4 (5 vs Illuminati) | opponent-specific 2-5 |
| 7x7 | 3.5 ms | 20 | 3 |
| 9x9 | 5 ms | 30 | 2 |
| 13x13 | 8 ms | 60 | 1 |
| 19x19 | 20 ms | 120 | 2 |

There is still no wall-clock cutoff. On 7x7 the scaled policy won 40/128 on the
primary corpus and 34/128 (26.6%) on a disjoint corpus, with 3.28 ms p95. A
32-game 9x9 sample won 9/32 (28.1%) at 4.72 ms p95. These rates remain below
5x5, but materially improve the old roughly 3-9% larger-board policy.

The 19x19 Secret lane is the one exception to the original 10 ms largest-board
target. Two static finalists receive the exact next daemon response, followed
by two bounded black continuations and a final board evaluation. It never
predicts a second daemon move: subsequent AI sleeps perturb the next seed, so
the next decision is replanned from the observed board and clock. A typed-array
component scan and bounded continuation prefilter keep this one-reply search at
19.69 ms p95 in an isolated 16-game run.

On a 64-game identical-seed A/B, this lane won 44/64 (68.8%) versus 28/64
(43.8%) with exact forecasting disabled: +25.0 percentage points, clearing the
20-point requirement for relaxing the 19x19 budget from 10 to 20 ms. The
concurrent A/B itself measured 20.14 ms p95, but only the isolated latency run
is used for budget acceptance.

The daemon teacher also has opponent-specific candidate generators for small
sacrifices and moves that force a defense. They are counterfactual candidates,
not unconditional production rules. On the corrected 16-game corpus, globally
reserving the second finalist for either bait family produced 6/16 and 12/16,
versus 11/16 for the ordinary two finalists; that is neither stable nor a
robust held-out gain. The first abstract-board correction admitted by the
training filter also regressed its disjoint control and was pruned. The daemon
book therefore remains empty until a concrete candidate improves held-out
wins; the generation and replay pipeline is retained for larger teacher
corpora.

The same bounded-root experiment was repeated per ordinary enemy. Wider roots
or continuations which helped only the 256-game training phase were rejected on
the disjoint 1,024-game corpus. Black Hand keeps one additional exact finalist
(+7 wins); Tetrads keeps that extra finalist and a 12-move cheap continuation
(+21 wins). Netburners, Slum Snakes, Daedalus, and Illuminati retain their
previous work bounds because their apparent training gains reversed held out.
The existing policy books remain enabled: disabling them was non-improving for
every faction after the corrected chain ordering.

Current upstream-arena results are below. Ordinary rows use the same 1,024-seed
corpus; the daemon win rate uses 64 games, while its latency is the isolated
16-game acceptance run rather than the concurrent win-rate A/B.

| Opponent | Wins | Win rate | Mean game | Planning p50 | Planning p95 | Change |
|---|---:|---:|---:|---:|---:|---:|
| Netburners | 1,020/1,024 | 99.6% | 4.42 s | 0.36 ms | 1.27 ms | unchanged |
| Slum Snakes | 977/1,024 | 95.4% | 6.54 s | 0.44 ms | 1.58 ms | unchanged |
| The Black Hand | 944/1,024 | 92.2% | 8.44 s | 0.56 ms | 1.95 ms | +7 wins |
| Tetrads | 789/1,024 | 77.1% | 9.54 s | 0.53 ms | 1.45 ms | +21 wins |
| Daedalus | 858/1,024 | 83.8% | 8.10 s | 0.61 ms | 1.58 ms | unchanged |
| Illuminati | 713/1,024 | 69.6% | 9.33 s | 0.70 ms | 1.56 ms | unchanged |
| w0r1d_d43m0n | 44/64 | 68.8% | 127.12 s | 6.74 ms | 19.69 ms | +16/64 vs no forecast |

The stronger predictor weights, chain priors, continuation widths and compact
books are deliberate per-opponent policy parameters tuned only through the
arena. When white passes, black uses exact area score and komi and immediately
accepts a current win instead of needlessly reopening the board.

Descriptive arena measurements and route-selection estimates are separate.
Using one corrected 128-seed phase as selection probabilities worsened the
fixed BN1 JIT profile from 3,964.0 s to 4,355.3 s by diverting games into Slum
Snakes and Tetrads. Using all final 1,024-game measurements directly improved
that to 3,993.3 s, but still lost to the independently validated 3,964.0 s
route. Production therefore publishes and stores the current arena rates while
retaining the validated route calibration. The final profile remains 3,964.0 s
versus 5,165.7 s without Go, preserving the 23.3% improvement. Neither table
reads or adapts to live game W/L records.

The secret opponent is a separate 19x19 lane. Its upstream constructor always
replaces a supplied position with the fresh BitVerse board, so the oracle must
reconstruct midgames under Illuminati and then restore the secret identity.
Its policy compares two exact one-reply lines but remains deliberately shallow;
arena results must not be combined with ordinary 5x5 win rates.

## Acceptance

- Every game completes or reports its explicit turn cap.
- Every observed immediate white response is contained in the clean-room
  predicted set.
- The hot-path target scales from approximately 2 ms p95 on 5x5 to 20 ms on
  the secret 19x19 board; the arena publishes p99/p99.9/max rather than hiding
  cold-start or scheduler outliers.
- Win rates and reward priors come from the upstream arena's stratified corpus.
- A reported 100% means zero losses on the named finite corpus, accompanied by
  its Wilson lower bound. It is not presented as a proof over all games.
