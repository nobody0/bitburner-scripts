# Source-File speedrun benchmark

The historical target to beat is the predecessor script's **17d 21:17** run
from a fresh BN1.1 start through every Source-File that existed at the time.
It predates BN14, BN15, and the Darknet victory route.

This is a reference measurement, not the live allowlist. The complete current
order is `BITNODE_SPEEDRUN_PLAN` in
`shared/strategy/progression/bitnode-order.ts`. Nodes whose controllers are not
ready remain in that list at their intended positions and are suppressed by
`DISABLED_BITNODES`; remove a node from that set to enable all its milestones.

It is also **not claimed to be the optimal route**. It is a coherent measured
starting point that the new planner must first reproduce and then beat. Order
changes should carry evidence from comparable checkpoint attempts or a full
run, rather than turning an unmeasured hunch into a new baseline.

## Rules for the new run

- Start from an otherwise fresh save in **BN1.1**.
- Bootstrap exception: inject only **Source-File 4 / Singularity access** needed
  to make a hands-off run technically possible. BN4 is therefore the first
  destination and must be completed first, replacing that bootstrap exception
  with legitimately earned SF4. Before an official attempt, pin the exact
  injected SF4 level and mechanism in the run record.
- No exploits.
- No casino.
- No infiltration.
- No DOM tricks.
- Corporations are allowed.
- Record the victory route for every node. The historical screenshot uses
  green for hacking and red for combat. A future run may additionally record a
  Darknet victory; the historical run had no such route.

The uninterrupted full run is the final evidence. Restored checkpoints are a
development tool for optimizing sections and do not themselves constitute a
full-run record.

## Historical ordering rationale

The route has two phases: hacking victories, then combat victories. Its core
premise is directional: hacking progress helps the later combat nodes, while
combat progress contributes little to the earlier hacking nodes. That makes
"hacking first" a sensible baseline, not a proof that every boundary is in the
optimal place.

### Hacking victories

1. **BN4 Singularity first** — obtain the automation surface needed to run the
   remaining route hands-off.
2. **BN1 Genesis** — take the strongest general hacking Source-File early.
3. **SF5.1 Intelligence** — start Intelligence growth and do a small
   Intelligence farm. The original rationale already marked this split as
   possibly non-optimal.
4. **BN2 Gangs** — Intelligence plus SF2 improves early crime income and speeds
   up subsequent node starts.
5. **Finish SF5** — collect its hacking modifier.
6. **BN12 Recursion** — add more general power before the specialized nodes.
7. **BN8 Stocks** — add hacking power and prepare for BN9.
8. **BN10 Sleeves** — strong hacking makes the node easier; the resulting
   overclocked sleeve then helps in Hacktocracy.
9. **BN9 Hacktocracy** — historically the hardest hacking node, so delay it
   until the preceding hacking power has accumulated.
10. **BN13 Stanek** — Hacktocracy's rewards make it easy to destroy. There is
    plausible merit in moving Stanek earlier, so this boundary is a candidate
    for checkpoint A/B testing.

### Combat victories

1. **BN7 Blade-2079 first** — historically used to obtain the combat API. That
   particular reason is obsolete under the pinned v3.0.1 rules: being in BN6
   or BN7, or holding SF6 or SF7, provides scripted Bladeburner access; SF7's
   distinctive reward is its Bladeburner multipliers. The measured position
   remains part of the benchmark until a replacement order beats it.
2. **BN6 and the remaining BN7 levels** — build the combat/Bladeburner score.
3. **BN11 Big-Crash** — take the smaller augmentation discount before the last
   node.
4. **BN3 Corporatocracy last** — corporations are allowed and can be used to
   complete BN3. SF3 contributes no value after the final node, so nothing is
   lost by postponing it until the end.

## Configured route with BN14 and BN15

The complete intended order for the current game is:

`1.1, 4.3, 1.3, 15.3, 14.1, 5.1, 2.3, 14.3, 5.3, 12.3, 8.3, 10.3, 9.3, 13.3, 6.3, 7.3, 11.3, 3.3`.

The initial `1.1` is explicit because the selector projects the Source-File
awarded by the node currently being destroyed. A fresh run completing BN1.1
therefore recognizes that milestone as satisfied and enters BN4 next.

BN2, BN3, BN6, BN7, BN8, BN9, BN10, BN11, and BN13 remain in the complete route
but are currently disabled while their automation is being prepared. Runtime
selection skips every milestone for those nodes. Once every enabled finite
milestone is complete, the selector falls back to repeatable BN12.

## Historical order and times

Source screenshot:
[17day-run.png](https://cdn.discordapp.com/attachments/979480447341969458/1342569357925941370/17day-run.png?ex=6a7cc0a6&is=6a7b6f26&hm=5eac15c73c4f076e4cfe0587b64e4869d08cd63da1ba65c0c55ae480b7d99a15).
The transcription below is durable even if that signed CDN URL expires.

The screenshot omits the duration beside the initial `1.1 Genesis` row. The
other rows sum to **17d 20:56**, while the displayed total is **17d 21:17**;
therefore the initial segment's **0d 00:21** is derived from the difference and
is marked accordingly.

| # | Run | Name | Time | Victory |
|---:|---:|---|---:|---|
| 1 | 1.1 | Genesis | 0d 00:21* | hack |
| 2 | 4.1 | Singularity | 0d 14:15 | hack |
| 3 | 4.2 | Singularity | 0d 14:14 | hack |
| 4 | 4.3 | Singularity | 0d 12:50 | hack |
| 5 | 1.2 | Genesis | 0d 06:16 | hack |
| 6 | 1.3 | Genesis | 0d 05:36 | hack |
| 7 | 5.1 | Intelligence | 0d 07:01 | hack |
| 8 | 2.1 | Gangs | 0d 04:00 | hack |
| 9 | 2.2 | Gangs | 0d 04:10 | hack |
| 10 | 2.3 | Gangs | 0d 04:21 | hack |
| 11 | 5.2 | Intelligence | 0d 05:38 | hack |
| 12 | 5.3 | Intelligence | 0d 05:21 | hack |
| 13 | 12.1 | Recursion | 0d 04:38 | hack |
| 14 | 12.2 | Recursion | 0d 04:34 | hack |
| 15 | 12.3 | Recursion | 0d 05:21 | hack |
| 16 | 8.1 | Stocks | 0d 10:28 | hack |
| 17 | 8.2 | Stocks | 0d 16:07 | hack |
| 18 | 8.3 | Stocks | 0d 14:08 | hack |
| 19 | 10.1 | Sleeves | 0d 10:51 | hack |
| 20 | 10.2 | Sleeves | 0d 10:54 | hack |
| 21 | 10.3 | Sleeves | 0d 12:13 | hack |
| 22 | 9.1 | Hacktocracy | 1d 01:03 | hack |
| 23 | 9.2 | Hacktocracy | 0d 23:30 | hack |
| 24 | 9.3 | Hacktocracy | 0d 21:59 | hack |
| 25 | 13.1 | Stanek | 0d 14:31 | hack |
| 26 | 13.2 | Stanek | 0d 13:33 | hack |
| 27 | 13.3 | Stanek | 0d 12:49 | hack |
| 28 | 7.1 | Blade-2079 | 0d 14:23 | combat |
| 29 | 6.1 | Bladeburner | 0d 10:34 | combat |
| 30 | 6.2 | Bladeburner | 0d 10:05 | combat |
| 31 | 6.3 | Bladeburner | 0d 10:14 | combat |
| 32 | 7.2 | Blade-2079 | 0d 13:15 | combat |
| 33 | 7.3 | Blade-2079 | 0d 14:18 | combat |
| 34 | 11.1 | Big-Crash | 0d 12:17 | combat |
| 35 | 11.2 | Big-Crash | 0d 12:40 | combat |
| 36 | 11.3 | Big-Crash | 0d 11:52 | combat |
| 37 | 3.1 | Corporations | 0d 11:20 | combat |
| 38 | 3.2 | Corporations | 0d 12:39 | combat |
| 39 | 3.3 | Corporations | 0d 10:58 | combat |

`*` derived as described above.

Summary checks:

- Hacking victories: 27 segments, **11d 20:42**.
- Combat victories: 12 segments, **6d 00:35**.
- Total: 39 segments, **17d 21:17**.
- Milestone order:
  `4.3, 1.3, 5.1, 2.3, 5.3, 12.3, 8.3, 10.3, 9.3, 13.3, 7.1, 6.3, 7.3, 11.3, 3.3`.

BN14 and BN15 did not exist in this measurement. The provisional route above
inserts them according to their expected downstream value; new checkpoint and
full-run timings must be kept separate from this historical 39-segment total.

## Two parallel tracks

Do not mix these records:

1. **Main save / idle farming.** The controller may exhaust only the currently
   enabled milestones and then repeat BN12 indefinitely. These runs are useful
   operational data, but they are not a fresh-save speedrun attempt.
2. **Speedrun laboratory.** Restore a named checkpoint, optimize exactly one
   section from an identical starting state, and retain its best result. Later,
   validate the assembled strategy with one uninterrupted fresh-save run.

Every run and checkpoint needs an explicit track/campaign id so the UI cannot
accidentally compare an idle BN12 farm against the historical speedrun.

## Checkpoint and timing roadmap

The repository already has most primitives:

- `saves/index.json` registers named exported saves with BitNode, capture time,
  and in-node playtime.
- `bun run save:restore` plus the isolated `restore.js` entrypoint restores a
  checkpoint with an in-game confirmation.
- The simulator and UI already list registered saves as starting fixtures.
- `bitnode.reset` already records `from`, `to`, `elapsedMs`, route, and forecast
  evidence.

The missing layer should be added later, outside the current controller patch:

1. **Campaign manifest.** Record ruleset version, track, controller build,
   ordered milestone, injected bootstrap state, parent checkpoint, starting
   Source-Files, and whether the run is isolated or uninterrupted.
2. **Segment result ledger.** Record start/end checkpoint ids, victory route,
   both the game-reported clock and wall-clock elapsed time, completion status,
   and notes. Preserve every attempt; designate a personal best rather than
   overwriting history.
3. **Checkpoint lineage.** Keep a start-of-segment save for every milestone so
   the next section can be repeated from identical state. A winning result may
   nominate its end save as the next milestone's parent.
4. **UI workflow.** Extend the BitNode tab with benchmark/PB/current/delta and
   cumulative columns, route coloring, campaign selection, checkpoint lineage,
   and explicit capture/restore actions. Restore remains destructive and must
   retain the existing confirmation boundary.
5. **Official-run boundary.** An official full attempt has no restores. Because
   Bitburner's normal Export Game grants an export bonus and mutates live state,
   checkpoint capture during a timed run must either use a proven non-mutating
   mechanism or be excluded from official timing. Isolated comparisons always
   start from the exact same blob, so any snapshot state is held constant.

Until clock semantics are pinned, retain both clocks. The screenshot establishes
the displayed durations and total, but not enough evidence to infer precisely
how offline time or reloads were counted.
