# V9 training checkpoint — 2026-08-13

This is the restart point for the next training agent. Read
[`README.md`](README.md) and [`gpu/README.md`](gpu/README.md) for the model and
loss contracts, then [`MAC_TO_WINDOWS_HANDOFF.md`](MAC_TO_WINDOWS_HANDOFF.md)
for the two-machine workflow. Windows setup details are in
[`MAC_TO_WINDOWS_SETUP.md`](MAC_TO_WINDOWS_SETUP.md) and exact worker commands
are in [`remote/README.md`](remote/README.md).

## Priorities and objective

Optimize win rate first. Win utility is quadratic because the game rewards win
streaks increasingly; Power per **total** turn is the linear tie-break, so fewer
turns are better. Train both `small5` and `daemon19`, concentrating most compute
on daemon19 because it is much further behind, but always keep a small5 lane
active and screen it regularly. Never promote from training-game wins or a
tiny ad-hoc sample. Promotion remains Mac-owned and requires the exhaustive
shortlist gate plus the production WebGPU arena.

## Deployed champions

The authoritative deployed files and hashes are recorded in
[`BASELINES.md`](BASELINES.md):

- `small5-champion.model`: `437f1cfecabcec061c2b85eb578667f6a89272b7e854ff758956bde84c47c942`
- `daemon19-champion.model`: `c73cb5811a441e466c4a6112da313c53f37219d68ef499b69c5e8a39ac71703e`

Every new training stage must use the matching installed V9 champion as
`--teacher`. The current trainer rejects legacy V7 teachers and old V7/V8
streams. Old research models below are useful only as optional `--init`
warm-starts; their historical summaries cannot authorize continuation actors
or promotion.

## Retained research evidence

The pruned historical campaign keeps only these non-deployed candidates:

- `runs/v9-campaign-20260813/small5-value-head-384/v9.64.model`: best fixed
  accelerated screen, `1776/2048 = 86.71875%`. Later value-head checkpoints
  regressed. SHA-256: `f1dc7240224c28a89061e9e2983e5f206062be6f19b482aa0a8df994f0a847fa`.
  Its historical corpus/summary does not satisfy the current V9 teacher and
  recall contract.
- `runs/v9-campaign-20260813/daemon19-joint-anchor-3072/v9.model`: strongest
  fixed-screened daemon reference, `1/128 = 0.78125%` at production `K=16`,
  averaging `234.80` rounds. Historical held-out metrics were 78.97% safe
  top-K recall, 73.97% target-set recall, 98.87% pass recall, and 47.64% bait
  recall. SHA-256: `056d8be6a30d40fe4f94a6c0ea65c79449bec523ae0b243cd3188dd33d8063ac`.
- `runs/v9-campaign-20260813/daemon19-cache-joint-1024/v9.model`: later,
  unscreened continuation with better historical recall: 80.26% safe, 75.18%
  set, 98.95% pass, and 49.14% bait. Treat it as an optional initialization,
  not as a winner. SHA-256:
  `11d83080b760d8d4a212c1e1b6d05851356563e157cb4c226be45cced7860aa0`.

Fresh current-champion labels subsequently rejected that daemon warm start: on
4,946 unseen positions it retained only 49.27% safe, 48.40% set, 63.87% pass,
and 19.52% bait recall (49.36/48.42/64.73/19.90 after one no-update evaluation
game). Its historical ~80% result was stale-teacher/corpus-specific. Do not use
it as the default initialization for the resumed campaign.

The daemon trajectory moved from 44.06% safe recall and 9.33% bait recall to
roughly 80% and 49%. Removing consumed current-turn RNG conditioning from the
single-opponent daemon value head was the main correctness fix. Direct value
ranking reduced weighted reply-win MAE from about 0.093 to 0.012. A dedicated
safe-anchor loss plus the four-move safe/upside set loss required shared-trunk
training; head-only proposal runs plateaued near 65% recall. The first fixed
daemon win is promising, but one win is not statistical evidence of beating
the historical V7 rate.

## How to continue

### 2026-08-13 resumed campaign update

A fresh 12,288-game small5 corpus established the installed champion at 98.15%
safe top-8 recall, 92.32% four-move-set recall, and 95.21% pass recall over
15,331 unseen positions. Joint replay produced research leader
`a178f1d1a4bb59891a794bfb7251efd9ad6fe54375939eb4ff447f93bfbef573`:
99.37% safe recall, 95.54% set recall, 97.97% pass recall, and 0.00269 mean
regret. On a paired 432-game production WebGPU screen it won 373 games with
+901 points versus the installed champion's 368 and +757. It remains
unpromotable because the exhaustive set/pass gates have not passed; continue
from it with top-K-aware set-margin pressure and value retention. Do not use
the earlier strict maximum-outsider margin: it optimizes a stronger ordering
than shortlist retention requires and regressed safe/pass recall immediately.
The first all-positive margin continuation reached 99.59% safe recall and
98.86% pass recall but left whole-set recall at 96.10%. The next targeted branch
should reduce `--proposal-anchor-weight` from its normal `0.5` while increasing
`--proposal-margin-weight`; reject it if safe recall or the paired arena falls.

Fresh daemon data confirmed the installed bootstrap is much further behind: at
256 games it had 44.66% safe top-16 recall, 44.15% set recall, 19.75% bait
recall, and 0 wins. The daemon remains the primary compute target as soon as
the fresh corpus closes.

Start by generating fresh exhaustive corpora with the installed V9 champions,
using new seeds and immutable run directories. Use the old research leader only
as an A/B initialization against a clean/current-champion initialization. Do
not reuse old V7-teacher corpora for ordinary training. Keep proposal, value
distillation, and candidate-ranking supervision together when adapting the
shared trunk; periodically use a short value-head-only ranking calibration,
and reject it as soon as unseen ranking/MAE regresses. Do not enable
`--self-actor-fraction` until the hash-matched unseen summary reports
`shortlistDataAllowed: true`.

Generate labels with `--updates-per-game 0` when an unchanged-champion baseline
and reusable corpus are wanted, then train independent replay branches from
that corpus. The gate counts unseen positions rather than games: short small5
games need roughly 12,288 games or several compatible corpora to clear the
10,000-position minimum. `--pretrain-updates` runs every enabled loss, and
candidate ranking defaults off, so record all loss weights explicitly.
Use `--pretrain-checkpoint-updates 500` or `1000` for long replay stages; the
intermediate unseen metrics are the trajectory, and the final update is not
automatically the best candidate.

Send long replay-pretraining jobs to the RTX 4090 using the immutable snapshot
and content-addressed input workflow. Keep Mac CPU corpus/evaluation shards,
strict screening, C++/TypeScript/WebGPU gates, and all promotion decisions on
the Mac. Pipeline the profiles: while CUDA trains daemon19, screen or generate
small5 data on the Mac; then train small5 on CUDA while the Mac screens daemon.
Use `--replay-cache-dir` on both machines. Measured packed-replay daemon
training reached about 4.8 updates/s at batch 256 on MPS, roughly 70% faster
than unpacked replay; batch 1024 did not improve Mac wall time. CUDA is the
preferred sustained training device.

For each candidate, first check C++ parity and held-out shortlist metrics, then
run `tools/go-screen-v9.ts` on the Mac. Only candidates with a matching summary
and passed exhaustive gate may enter the production `go:promote` arena. Compare
wins first and Power/total-turn only as the tie-break; record average rounds so
a model that merely prolongs games cannot look better. Never average
checkpoints, never let a learned shortlist generate its own labels before the
gate, and never promote directly from Windows.
