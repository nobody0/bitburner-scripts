# V9 training checkpoint

The restart point for training work. Read [`README.md`](README.md) for the model
and loss contracts, [`gpu/README.md`](gpu/README.md) for the corpus schema, and
[`MAC_TO_WINDOWS_HANDOFF.md`](MAC_TO_WINDOWS_HANDOFF.md) for the two-machine
workflow. [`DEPLOYMENT.md`](DEPLOYMENT.md) owns everything after a champion
exists.

## Installed champions

| Profile | Full-f32 SHA-256 | Production selector | Measured |
|---|---|---|---|
| `small5` | `4ff250e3cfd9e55bf5219c08eab8d02fc9dee7aafc385aad7cb521fa5b5e89bf` | K=4 shortlist, exact replies, deep-search round two | 93.0--93.4% over two fresh 12,288-game gates |
| `daemon19` | `219f83c701fdc21faed575d1f0da22221b45385231744994af9f0f1c5b7e24ea` | strict K=1, policy only | 453/512 (88.48%) |

Both are LFS blobs at `small5-champion.model` and `daemon19-champion.model` and
are the checkpoints to continue training from. There is no pending candidate.

Small5 per opponent, 2,048 games each: Netburners 2,045, Slum Snakes 2,045,
The Black Hand 2,013, Daedalus 1,973, Tetrads 1,966, **Illuminati 1,436
(70.1%)**. Illuminati is roughly 72% of all remaining losses; the other five are
saturated, so a global update trades saturated wins for Illuminati wins about
one for one.

## Two hard deployment constraints

**daemon19 is strict K=1 and cannot search.** `GO_PROFILE_CANDIDATE_LIMITS`
pins it to 1 and `GO_PROFILE_DEEP_SEARCH` has no daemon19 entry. A K>1 turn
needs an exact oracle reply per candidate plus a multi-board value dispatch
(29.3 ms p50 for 104 boards) against a 15/18 ms budget. This is arithmetic, not
an open research gate: no value head makes it fit. daemon19's value head is
never consulted, which is why its trunk can be retrained freely.

**Small5 is K=4 plus deep search**, so shortlist *diversity* is load bearing:
the finalizer reinvests it into round-two depth. Any change that sharpens the
policy onto one move degrades play even when that move is better.

## How the daemon19 champion was produced

Data and capacity were **jointly** binding, and this is the transferable result:

| Arm (identical 3,960-position held-out split) | Exact KataGo | Good-set |
|---|---:|---:|
| previous champion, 16x4 rank-16 | 34.70% | 62.32% |
| 16x4 rank-16 with 2.7x more DAgger data | 34.97% | 62.55% |
| **32x6 rank-32, same data (promoted)** | **36.19%** | **64.82%** |

More data at the old capacity bought 0.27 points and no champion; the same
corpus at higher capacity converted into +8.8 arena points (453/512 versus
408/512, one-sided sign `p=0.000094`, +0.045229 Power/turn, 1.60 fewer turns,
latency 3.2/4.6 ms). Vary data and capacity together before concluding either is
saturated.

## Retained training inputs

| Purpose | Artifact |
|---|---|
| daemon19 policy training | `corpora/v9-daemon19-component-split-dagger-r1r2-20260901-...jsonl.gz` (75,204 records, 43,959 KataGo actors) |
| champion provenance corpus | `corpora/v9-daemon19-component-split-tactical-dagger-scaled-v1-20260823-...jsonl.gz` |
| DAgger shards (rounds 1 and 2) | `...-katago-dagger-scaled-v1-aaaefd-...`, `...-katago-dagger-round2-219f83c7-...` |
| lookahead playbook entries | `corpora/v9-daemon19-lookahead-playbook-v5-219f83c7-20260908-g1200.jsonl.gz` (942 entries) |
| lookahead K=1 policy labels | `corpora/v9-daemon19-lookahead-actors-v3-c73teacher-20260908.jsonl.gz` (747 actors) |

Small5 playbook authority stays in `ipvgobruteforce/data/training/` as the six
`*-v16-absolute-seed-20260821` exports. Derived Small5 training shards were
discarded; see the closed directions below.

## Data contract essentials

The v16 exporter uses absolute `playtimeEpoch`. Later WHRNG draws are not
periodic in the old modulo phase, so modulo-only exports produce
self-consistent-looking but wrong behaviour tensors.

Compose before training: whole route families and shared f32 inputs must land on
one side of the split. Fresh seeds alone do not stop identical neural states
crossing train/held-out. A value's `author` records real provenance; static
evaluations from an external evaluator use the `STATIC_VALUE_AUTHORS` allow-list
in `validate_corpus.py`, which forces `score`/`remaining` to 0 so an estimate can
never be stored as rollout evidence.

Certified and lookahead actions are opponent exploits, valid only jointly with
the exact behaviour input. KataGo agreement is evidence that an action is also
generally sound; disagreement is not authority by itself.

## Closed directions

Do not retry these without changing the stated cause.

| Direction | Result | Cause |
|---|---|---|
| Certified playbook into Small5 weights (six routes: whole corpus, opponent subset, frozen trunk, conditioning-only, interleaved rehearsal at 3x budget, agree-only) | -82 to -1,282 wins on full gates | Shortlist collapse: finalists fall 5.32 -> 4.38 and turns rise, starving the deep-search finalizer. Bait is not the cause; agree-only lost the most. |
| Lookahead exploits into daemon19 weights | Below the champion on its own metric (21.33% -> 16--22.67%), -5 points KataGo retention | Labels do not generalise: tripling the exploit gradient bought one root in 75. Each entry is a board plus a seeded reply chain, closer to a lookup entry than a pattern. |
| daemon19 capacity beyond 32x6 | Seven architectures 24x8--48x8 all 36.2--36.8% | Saturated; seed spread (0.78--1.14) exceeds every between-arm difference. |
| Second DAgger round | -11 wins at the 512-game gate | Within seed noise across four seeds. |
| K>1 or value-head search on daemon19 | Not gated | Ruled out by the latency budget above. |
| Student-root regret waves (v6/v6b, 256 groups) | 1/25 held-out at every checkpoint | No learnable signal; retention decayed to 79.7--86.3%. |

The generated lookahead signal itself is real and replicated across five runs
(34--39% of live roots have a better answer than KataGo's, median win margin
+0.10 to +0.12). Its value is as runtime evidence, not as weights.

## Tooling notes

- `teacher/export-lookahead-playbook.ts` searches Black candidate -> exact White
  reply -> follow-up -> both successor-seed replies -> KataGo leaf. White never
  branches, and `goSuccessorDispatchCandidates` narrows the second reply to two
  exact seeds, so no phase marginalisation is needed. Its leaf writer
  materialises every row and OOMs past roughly 120k leaves; entries are written
  first and always survive. Add streaming or `--skip-leaves` before relying on
  leaf output.
- `teacher/export-lookahead-actors.ts` rejects entries without `rootElapsed`
  rather than defaulting it. Defaulting once stamped `elapsed=1` on midgame
  boards and silently fabricated an input plane.
- Long Mac jobs must run detached (`nohup`) and must not share the machine with a
  WebGPU arena; the inference backend is killed under that pressure (`EPIPE`).
- `sim/go-arena.ts` models the documented upstream no-op: a faction-priority move
  rejected by positional superko advances without changing the board or counting
  a pass, reported as `whiteNoOps`. Raising there previously aborted a
  12,288-game gate.

## Promotion

The Mac owns all screens and promotion. Use `go:promote` with the profile
selector, explicit fresh seed streams, and the full minimum arena (2,048 games
per opponent for small5, 512 for daemon19). Source seeds from the ledger's own
conflict checker in `tools/go-arena-seed-ledger.ts`; hand-picked values collide
after 200 ms quantisation and the WHRNG wrap.

More wins promote only on an exact one-sided paired sign test at `p <= 0.05`; an
exact win tie needs a positive paired 95% lower bound for Power/turn, then fewer
turns. Corpora are burned before evaluation and stay burned after rejection.

**Screens below the promotion minimum are not evidence.** A 384-game screen put
a Small5 candidate at +3 wins with Illuminati apparently up; the 12,288-game gate
showed -82 overall and -52 on Illuminati itself. Small held-out sets behave the
same way. Trust the gate.

## Work boundaries

- Train and promote both profiles; daemon19 has the larger headroom.
- Keep full-f32 training authority separate from quantisation, pruning and
  derivative installation.
- Prefer replication over single readings. Every wrong conclusion recorded here
  came from one seed, one checkpoint, or one undersized arena.
- Keep only champions, current composed corpora and a qualified candidate.
