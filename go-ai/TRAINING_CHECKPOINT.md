# V9 training checkpoint

This is the authoritative restart point. Read [`README.md`](README.md), then
[`gpu/README.md`](gpu/README.md) and
[`MAC_TO_WINDOWS_HANDOFF.md`](MAC_TO_WINDOWS_HANDOFF.md) before launching work.

## 2026-08-17 daemon19 promotion: data and capacity were jointly binding

`219f83c701fd...` replaced `aaaefd114d9f...` after **453/512 (88.48%)** versus
**408/512 (79.69%)** on fresh corpus `81555501`: 93/48 favorable/unfavorable
flips (`p=0.000094`), +0.045229 Power/turn with a positive 95% lower bound
(+0.026403), 1.60 fewer mean turns, +5,451 points, latency 3.2/4.6 ms against
the 15/18 ms strict-K=1 budget. Golden fixture regenerated and the WGSL gate
passed before install.

The causal story is that **neither change worked alone**:

| Arm | held-out exact KataGo | good-set |
|---|---:|---:|
| champion `aaaefd11` (16x4 r16, 35,835 params) | 34.70% | 62.32% |
| 16x4 r16 + 2.7x DAgger data | 34.97% | 62.55% |
| **32x6 r32 + same data (promoted)** | **36.19%** | **64.82%** |
| 48x8 r48 + same data | 36.74% | 65.61% |

All four measured on the identical 3,960-position held-out split. More data at
the old capacity bought +0.27 points and no champion; adding capacity converted
the same corpus into +8.8 arena points. "Capacity does not help daemon19" was an
artifact of only ever testing capacity at the old data volume. Always vary data
and capacity together before concluding either is saturated.

The new DAgger shard is
`corpora/v9-daemon19-katago-dagger-scaled-v1-aaaefd-20260823-g256-p28.jsonl.gz`
(4,075 labels from 256 fresh champion routes, 2,865 genuine corrections, student
won 204/256); the composed training corpus is
`corpora/v9-daemon19-component-split-tactical-dagger-scaled-v1-20260823-g256-c32-d128-d256.jsonl.gz`
(SHA-256 `2d11b4cf364dd0ce1854e6e26f1df53b869faf07605e161b235224a0c301cfe8`,
71,152 records, 39,907 KataGo actors, zero findings).

**Imitation is now saturating.** 48x8 is ~13x the original parameters for
+0.15 points over 32x6, so distillation alone will not close the remaining gap
to KataGo's 255/256. The structural difference left is search: KataGo uses 8
visits per move, daemon19 plays strict K=1 with a neutral value head.

## daemon19 deploys at strict K=1: search is ruled out on latency

`GO_PROFILE_CANDIDATE_LIMITS.daemon19 = 1` and `GO_PROFILE_DEEP_SEARCH` has no
daemon19 entry. This is a **hard deployment constraint, not an open research
gate**: a 19x19 K>1 turn needs the TypeScript oracle to apply an exact reply per
candidate plus a multi-board value dispatch (measured 29.3 ms p50 for 104
boards) against a 15/18 ms budget. No value head makes that fit.

A value head was trained on 22,118 KataGo leaf evaluations before this was
checked (`corpora/v9-daemon19-lookahead-leafvalues-v2-219f83c7-20260904.jsonl.gz`,
checkpoint `38ff58de1694`, parity 7.2e-06). It is sound work with no consumer
unless the latency budget changes; screen corpus `61000001` was burned finding
this out. **Check the deployment table before building anything that assumes
search.**

`validate_corpus.py` gained a `STATIC_VALUE_AUTHORS` allow-list so an external
evaluator's score of an independent post-reply board can be stored without
route-shaped checks, while forcing `score`/`remaining` to stay 0. That keeps a
static estimate from ever being recorded as rollout evidence. It is reusable if
a K>1 profile ever exists.

## The K=1-compatible use of the lookahead playbook

`teacher/export-lookahead-playbook.ts` searches Black candidate -> exact White
reply -> Black follow-up -> both successor-seed White replies -> KataGo leaf,
and emits roots where the backed-up best action beats KataGo's own root choice.
White never branches, so the tree is effectively single-player, and
`goSuccessorDispatchCandidates` already narrows the second reply to two exact
seeds, so no phase marginalisation is needed.

Three independent runs replicated closely:

| Run | Routes | Roots searched | Entries | Exploit rate | Median win margin |
|---|---:|---:|---:|---:|---:|
| v1 | 48 | 88 | 34 | 38.6% | +0.112 |
| v2 | 160 | 345 | 120 | 34.8% | +0.116 |
| v3 | 240 | 539 | 185 | 34.3% | +0.097 |

Roughly a third of *live* roots (about 19% of all roots survive the
non-saturated filter) have a better answer than KataGo's, worth a median +10 to
+12 points of win probability.

Because search cannot run at inference, the only usable consumer is **policy
distillation**: `teacher/export-lookahead-actors.ts` converts entries into
`source: "self"` actor labels, so the search cost is paid once during generation
and the deployed player still does one argmax. `--exact-actor-source self` was
added to `train_v9.py` for this. Do not relabel these as `katago`: they are by
construction the moves KataGo does not choose.

**Status: tested at scale and rejected.** A 1,200-route run produced 942
entries and 747 policy labels (672 train / 75 held out, zero validation
findings). Two seeds trained the full trunk with `--exact-actor-source self`
against 75% KataGo *authority* retention from the R1+R2 corpus:

| | exploit top-1 (n=75) | KataGo retention |
|---|---:|---:|
| champion `219f83c7` | **21.33%** | **35.89%** |
| trained, seed 05 | 16.00% | 32.15% |
| trained, seed 06 | 18.67% | 30.77% |

Both seeds ended **below the champion on the exploit metric itself** and 3--5
points down on KataGo agreement, with no learning trend across twelve
checkpoints (oscillation between 14.67% and 22.67%). No arena was spent; the
reserved gate seeds `73000007/08/09` remain unburned.

The reason is arithmetic, and it matches the Small5 failure from the other
direction. The champion already holds the exploit action **inside its shortlist
on about 79% of these roots**, so the deficit is argmax *ranking*, not coverage.
672 exploit labels cannot outvote 39,959 KataGo actors for the top slot, and
raising their weight damages general Go (already visible at 75% retention).
Moving the argmax would need exploit labels at KataGo-corpus scale -- tens of
thousands, roughly 40x this run -- which is a generation-throughput problem, not
a training one.

The generator itself is sound and its signal replicated five times (34--39%
exploit rate, median win margin +0.10 to +0.12). Two defects were fixed along
the way and matter for any future run:

- entries originally omitted `rootElapsed`, so the converter defaulted it and
  stamped `elapsed=1` on midgame boards, silently fabricating an input plane.
  The converter now **rejects** entries without it and reports `missingElapsed`.
  An earlier 280-label pilot ran on those bad inputs and is void;
- leaf serialisation materialises every row before writing and OOMs at roughly
  120k+ leaves, destroying the leaf file after multi-hour runs. Entries are
  written first and always survive. Leaves have no K=1 consumer, so this was
  left unfixed; add incremental streaming or a `--skip-leaves` flag before
  relying on that output.

## Current champions

| Profile | Full-f32 SHA-256 | Production selector | Status |
|---|---|---|---|
| `small5` | `4ff250e3cfd9e55bf5219c08eab8d02fc9dee7aafc385aad7cb521fa5b5e89bf` | K=4 plus exact replies and round-two finalization | Installed; no qualified replacement |
| `daemon19` | `219f83c701fdc21faed575d1f0da22221b45385231744994af9f0f1c5b7e24ea` | strict K=1 policy-only | Installed 2026-08-17 at 88.48%; still the priority |

The champion files are `small5-champion.model` and
`daemon19-champion.model`. There is no pending model candidate: the daemon19
32x6 candidate was promoted and installed, and every Small5 certified-transfer
candidate was rejected on a full gate. The next work item is the KataGo-
evaluated exact-reply lookahead generator described above.

## Retained training inputs

Only these composed inputs are current:

| Purpose | Artifact | SHA-256 |
|---|---|---|
| Small5 certified actor transfer | `corpora/v9-small5-certified-v16-absolute-seed-component-split-20260821-c48379.jsonl.gz` | `8c5c56eb299b727401c1aec7eeefca9b17ee54621f3d50a6e1de5c50e9d850d3` |
| daemon19 first independent regret wave | `corpora/v9-daemon19-student-root-future-marginalized-ranked-v6-timing-v16-k1-aaaefd-20260821-g128-p8.jsonl.gz` | `92ededabe47b881b69bdf08229176f6eb797e915f04756d850d42deba45f0297` |
| daemon19 second-wave manifest | `corpora/v9-daemon19-student-root-manifest-v6b-20260822-g128.json.gz` | `b1aab3fc72af6913901c4f7de4b59f973d24d48341338b49f394591013726d19` |

The six source playbook exports under `ipvgobruteforce/data/training/` are the
`*-v16-absolute-seed-20260821` files. Their component-safe combined Small5
snapshot above is the training input; the per-opponent files remain immutable
source authority.

## Why the current data contract exists

The corrected v16 exporter uses absolute `playtimeEpoch`. The WHRNG's later
draws are not periodic in the old modulo timing phase, so a modulo-only export
produces self-consistent-looking but wrong behavior tensors. Training and
arenas must use the stochastic future-timing implementation and fresh paired
streams.

Certified actions are often opponent exploits. They remain conditional on the
semantic behavior input; KataGo agreement is evidence that an action is also
generally sound. KataGo supplies actor preferences, not value targets. Numeric
or terminal targets retain their actual rollout author.

Every composition groups complete route families and shared f32 inputs before
splitting. Fresh seeds alone do not prevent identical neural states from
crossing train/held-out.

## Small5 is closed: certified data cannot enter the weights

Champion `4ff250e3...` is final for the near future. Two independent fresh
12,288-game gates measured it at 11,478/12,288 (93.41%) and 11,432/12,288
(93.03%). Per opponent (2,048 games each): Netburners 2,045, Slum Snakes 2,045,
The Black Hand 2,013, Daedalus 1,973, Tetrads 1,966, **Illuminati 1,436
(70.1%)** — Illuminati carries roughly 72% of all remaining losses.

Six independent training routes were tested against the full gate and all
regressed. Ordered by how much they lost:

| Route | Result |
|---|---|
| agree-only (KataGo-approved rows, no bait at all) | **-1,282 wins** |
| interleaved full-trunk rehearsal, 20k updates | -1,178 wins |
| whole certified corpus, frozen trunk | -82 wins |
| Illuminati-targeted, conditioning retention | target metric never moved |
| conditioning-only (exploit rows) | 76.4% recall ceiling, 0.00% both-correct |
| frozen-trunk retention curve, 3 rates x 4 levels | frontier step-size invariant |

The mechanism is **shortlist collapse, not bait**. Certified training sharpens
the policy onto a single action: mean finalists fall 5.32 -> 4.38 while mean
turns rise 20.29 -> 22.91. Production Small5 is K=4 *plus* deep search, which
reinvests a diverse shortlist into round-two depth, so starving that shortlist
costs more than better root moves gain. Removing bait does not help because
bait was never the cause — the agree-only arm lost the most.

A second measured fact constrains any retry: the champion is *completely*
behaviour-blind, changing its action on 0.00% of 1,180 held-out pairs where only
the enemy-behaviour vector differs. Training makes this worse, not better —
either-correct climbs 86.9% -> 96.5% while both-correct falls to 0 — because
~88% of certified rows are behaviour-invariant, so the loss is minimised by
memorising boards. V9 also consumes behaviour only through per-block
conditioning that is broadcast over every board point, so it can express
"against this opponent prefer this kind of move" but never "play bait here".

Do not retry certified-to-weights transfer without first changing one of those
two structural facts. The playbook's proven home is the runtime
(`go:playbook:residual` -> `go:playbook:pack` -> `go:combined:arena`), where v16
wins 120/120 committed entries.
## Active daemon19 work

The student-root regret waves (v6/v6b, 256 groups, 4,335 continuations) are
**closed and their corpora deleted**: held-out correction sat at exactly 1/25 at
every checkpoint and both retention levels while general-Go retention decayed to
79.7--86.3%. Doubling independent regret evidence produced no learnable signal.

Retained daemon19 inputs:

| Purpose | Artifact |
|---|---|
| current training corpus (R1+R2) | `corpora/v9-daemon19-component-split-dagger-r1r2-20260901-g256-c32-d128-d256-d256b.jsonl.gz` |
| champion provenance corpus | `corpora/v9-daemon19-component-split-tactical-dagger-scaled-v1-20260823-g256-c32-d128-d256.jsonl.gz` |
| DAgger shards (round 1, round 2) | `...-katago-dagger-scaled-v1-aaaefd-...`, `...-katago-dagger-round2-219f83c7-...` |
| lookahead playbook entries (usable, has `rootElapsed`) | `corpora/v9-daemon19-lookahead-playbook-v5-219f83c7-20260908-g1200.jsonl.gz` (942 entries) |
| lookahead K=1 policy labels | `corpora/v9-daemon19-lookahead-actors-v3-c73teacher-20260908.jsonl.gz` (747 actors, 672/75) |
| lookahead leaf values (no consumer at K=1) | `...-lookahead-leafvalues-v2-219f83c7-20260904.jsonl.gz` |

Generate DAgger rounds with `teacher/export-katago-dagger.ts` and playbook
evidence with `teacher/export-lookahead-playbook.ts`. Both must run detached
(`nohup`) and must not share the Mac with a WebGPU arena: the inference backend
is killed under that memory pressure (`EPIPE`).

## Arena defect fixed: upstream no-op aborted a promotion gate

The first 12,288-game Small5 apply gate did not return a verdict. It crashed
with `upstream oracle returned illegal 2,2` after roughly a full arm, burning
corpus `61888801` for nothing.

This was a real gap in promotion-authority code, not a model problem. Upstream
validates fallback moves but **not** faction-priority moves, so positional
superko can very rarely reject the AI's own chosen coordinate. Bitburner logs it
and advances to black without changing the board and without counting a pass.
`opponent.cpp` marks that exact `no_op`, and both `transition.cpp` and the
native `arena.cpp` apply it as "return without touching board, history, or the
pass counter". Only the TypeScript arena threw instead.

`sim/go-arena.ts` now models the same no-op and reports `whiteNoOps` per game
rather than swallowing it. The change is safe for comparability: it only affects
the path that previously raised, so every previously completed game is
bit-identical and no past result moves. Black-side illegal moves still throw,
because those would be a genuine policy or rules defect.

Two sibling sites still throw on the same condition and should be reviewed by
their owners: `sim/features/go-system.ts` (live play) and
`go-ai/teacher/export.ts`. A rare live crash there would surface as a failed Go
turn rather than an aborted gate.

## Promotion process

The Mac owns all screens and promotion decisions. Use `go:promote` with the
profile selector (`--candidate-limit 4` for Small5, `1` for daemon19), explicit
fresh seed streams, and the full minimum arena. The tool records burned streams
and restores the installed artifact transactionally on rejection.

Promotion requires the paired win-flip gate. On an exact win tie, require a
positive paired 95% lower bound for Power/turn, then for fewer turns. Never
replace a `.model` manually and never promote from native, held-out, or CPU-only
evidence.

## Work boundaries

- Train and promote both profiles; prioritize daemon19 until its win rate
  catches Small5.
- Keep full-f32 training authority separate from quantization, pruning, and
  derivative installation.
- Do not tune arbitrary coefficients or launch an unbounded campaign.
- Keep only immutable source snapshots, current composed corpora, champions,
  and a qualified active candidate.
- Record verified facts separately from hypotheses and state the smallest
  falsifiable next experiment.
