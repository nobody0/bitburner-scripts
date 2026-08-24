# `hacking` — the farm

Scan the world, root every reachable server, deploy a worker payload onto the rooted fleet, and run HWGW
batches against whichever target pays best per gigabyte-second. Money is one output; the other is hacking
experience, which raises skill, which is what makes backdoors — and four factions — reachable.

> "Maximise $/sec/GB across the rooted fleet: pick a target, hold it at min security and max money,
> and spend every free gigabyte on it."

**Theme** BN1 · BN5 (`shared/features/registry.ts:53-64`) · **Status** built (`spec/progress.md`)

## Unlock

Always playable: `deriveCapabilities` sets `hacking` to `yes` unconditionally
(`shared/features/unlock.ts:106`). No Source-File, `BitNodeBooleanOptions` field or `sourceFileOverrides`
entry removes it; a node can only attack the substrate (BN9's `CloudServerLimit` 0 and `HomeComputerRamCost`
5 leave Hacknet Servers as the only purchasable RAM). The loop is the 30 s fleet sweep — scan into the store
(`collectServers`, breadth-first from `home`), root everything newly rootable, deploy, reap strays, resync
the heap (`game/lib/fleet.ts:32`). Rooting is a **ports-only** test: hacking level is irrelevant to
`ns.nuke` (`game/lib/net.ts:25-31`). Skill gates yield, not access. Dispatch is
[`spec/targeting.md`](../../targeting.md); the window model is
[`spec/jit-reference.md`](../../jit-reference.md).

## Rules

Per thread, at difficulty `d` and `requiredHackingSkill` `r` (`sim/vendor/.../Hacking.ts`, mirrored in
`shared/formulas.ts:116-160`):

```
chance   = ((1.75·skill − r)/(1.75·skill)) · ((100−d)/100) · hacking_chance · intBonus
percent  = ((100−d)/100) · ((skill − (r−1))/skill) · hacking_money · ScriptHackMoney / 240
exp      = (3 + baseDifficulty·0.3) · hacking_exp · HackExpGain
hackTime = 5·(2.5·r·d + 500) / ((skill+50) · hacking_speed · HackingSpeedMultiplier · intBonus)
growTime = 3.2 · hackTime        weakenTime = 4 · hackTime
```

`chance` is 0 without admin rights or at `d ≥ 100` (`Hacking.ts:13`). Grow adds `threads` dollars, then
multiplies by `exp(k·threads)`, where `k` is
`log1p(0.03/d)·(serverGrowth/100)·ServerGrowthRate·hacking_grow·coreBonus` capped at
`ServerMaxGrowthLog = 0.00349388925425578` (`Server/formulas/grow.ts:16-29`); threads for a money target
come from the exact Newton–Raphson `numCycleForGrowthCorrected` (`Server/GrowthCycles.ts`). A hack fortifies
by `0.002·min(threads, ceil(1/percent))`, a grow by `2·0.002` per used cycle, a weaken removes
`0.05·threads·coreBonus·ServerWeakenRate` (`Server/data/Constants.ts:10-11`, `shared/formulas.ts:173-183`).
Difficulty clamps to `[max(minDifficulty, 1), 100]`, `minDifficulty = round(baseSecurity/3)` after
`ServerStartingSecurity` (`sim/core/effects.ts:37-41`, `ServerMetadata.ts:17-18`). Skill is
`floor(mult·(32·ln(exp + 534.6) − 200))` with `mult = hacking · HackingLevelMultiplier` (`skill.ts:14`,
`sim/core/effects.ts:63-71`), so the two exp-side multipliers compound against a logarithmic curve.

### Yield versus timing

| Kind | Fields |
|---|---|
| YIELD | `ScriptHackMoney` — inside `percent`, so it also shrinks the refill grow · `ScriptHackMoneyGain` — the player's cut only, applied at the call site and in no vendored formula (`shared/formulas.ts:81-84`) · `ServerMaxMoney`, `ServerStartingMoney` — the pool `percent` is a fraction of · `HackExpGain`, `HackingLevelMultiplier` — experience, and everything downstream of `skill` |
| TIMING | `HackingSpeedMultiplier` — divides the time denominator; income per batch untouched · `ServerGrowthRate`, `ServerWeakenRate` — prep length and weaken cover, so thread cost |

`HackingSpeedMultiplier` is 0.3 in [BN14](../bitnodes/bn14.md), 0.6 in [BN15](../bitnodes/bn15.md), 1
everywhere else (`BitNodeMults.ts:487,530`). At 0.3 every op takes 3.33× as long: the same batch earns the
same dollars over triple the wall clock, and the depth cap
`max(1, floor(weakenTimeS/BATCH_INTERVAL_S))·ramPerBatch` (`shared/strategy/economics.ts:37-40`) scales with
it. It retimes every batch; it does not scale income.

### Access: openers and backdoors

TOR costs $200 000 and is added to every opener purchase until owned (`shared/strategy/career/programs.ts:73`,
`game/lib/features/hacking.ts:1511`). Openers, in ascending level order (`game/lib/net.ts:10-16`,
`Programs/ProgramTable.ts`):

| Program | Write skill | Write base | Buy |
|---|---:|---:|---:|
| `BruteSSH.exe` | 50 | 10 min | $500k |
| `FTPCrack.exe` | 100 | 30 min | $1.5m |
| `relaySMTP.exe` | 250 | 2 h | $5m |
| `HTTPWorm.exe` | 500 | 4 h | $30m |
| `SQLInject.exe` | 750 | 8 h | $250m |

The driver buys the ladder up to the blocked server's `numOpenPortsRequired` in one atomic grant, and only to
unblock a posted root or backdoor need; writing one instead is a work-slot decision priced against every bid
in the auction, not just career's menu (`game/lib/features/hacking.ts:1511,1545`).

`ns.singularity.installBackdoor()` (`types/NetscriptDefinitions.d.ts:2799`) is the whole invite requirement
for four factions — CyberSec `CSEC`, NiteSec `avmnite-02h`, The Black Hand `I.I.I.I`, BitRunners
`run4theh111z` — and one of three for Fulcrum Secret Technologies, which also needs employment and 400 000
company reputation there (`Faction/FactionTable.ts:428-527`). So hacking is upstream of `factions` even where
the farm earns nothing; NiteSec and The Black Hand are also in `GANG_FACTIONS`
(`shared/strategy/progression/endgame.ts:42-50`), and BN2 grants gang access on the node alone
(`game/lib/features/remaining.ts:2559`).

### BN8: the farm that earns nothing

`ScriptHackMoneyGain` is 0 in [BN8](../bitnodes/bn08.md) alone (`BitNodeMults.ts:217`), alongside
`ScriptHackMoney` 0.3: the server loses the money, the player receives none. Experience survives — all three
ops award the same per-thread exp, and a failed hack, or a successful hack that drained $0, awards a quarter
(`sim/core/effects.ts:91-106`) — so with every dollar score at zero the evaluator breaks the tie on exp per
GB-second and preps a cold target to batch. Price movement survives too: the influence roll is against
`moneyDrained / moneyMax`, taken *before* the player's cut, and moves the second-order forecast by
`forecastForecastChangeFromHack = 0.1`, hack down and grow up (`StockMarket/PlayerInfluence.ts:13-47`). So
`ScriptHackMoneyGain` scales the income term, **not** the manipulation term
(`shared/strategy/targeting.ts:281-286`); market side [`stock.md`](../features/stock.md).

## Needs · Gives · Contends

**Needs** `file` — port openers, bought or written · `skill` — hacking skill, for `chance`, `percent`, time ·
money, for fleet RAM. **Gives** money · `root` and `backdoor`, the access and four faction invites `factions`
waits on · hacking exp, read as skill by `factions` and `progression` · the rooted fleet every feature's
dodges run on. **Contends** fleet RAM, against dodges and probes, `share` and `stanek` · money, in
`income:investment` against `hacknet` and `stock` · target choice, against `stock` in BN8.

**Port-opener policy** TOR and crackers have two independent payoffs. Darkscape buys TOR as part of
darknet access; the farm separately prices each next cracker from the steady-state income and hacking
experience of newly available targets plus the worker RAM of every newly rootable host
(`shared/strategy/access/openers.ts`). That economic claim competes with other income investments in
`income:investment`. A posted root/backdoor need keeps the existing higher-priority blocking path.

`shared/strategy/arbiter.ts:42` contends exactly `money` and `time`; RAM is brokered separately. The broker
carves a dodge *arena* out of the rooted fleet — ladder `home` → `n00dles` → `foodnstuff`, growing further only
for a request starved past `STARVATION_MS = 5 s` (`shared/ram/broker.ts:327-395`) — and the rest is the
dispatcher’s. Reclamation may stop share or an idle pooled worker, but never an active HGW/prep/charge call;
elapsed worker time is sunk and killing it loses the investment. The fleet’s residual tenants are one-shot
`charge` and freely evictable `share` (`shared/strategy/stanek/charge.ts`, `shared/strategy/share.ts`).

## Challenges

- **Timing is the product.** The HWGW shape lands H, W1, G, W2 at 0, 1, 2 and 3 × `SPACER_MS = 5` (`shared/strategy/timing.ts:10`, `shared/strategy/dispatch.ts:3111-3121`); the HGW shape lands H, G, W2 at 0, 1, 2.
- **Score is RAM-bound, not thread-bound.** `WORKER_RAM` is hack 1.7 GB, grow 1.75, weaken 1.75 (`shared/world.ts:202`), so money-per-thread and $/GB/sec differ by more than a constant.
- **Switching is an opportunity cost.** `evaluatePrep` scores a candidate as the income gained after the switch minus the income the current farm loses while prep borrows its RAM, both over one horizon (`shared/strategy/economics.ts:104-165`).
- **Zero income is not zero value.** With `bestIncomeRate` at 0 the ranking key collapses to the experience term (`shared/strategy/evaluator.ts:583-586,654-661`), and the farm pick then takes a cold target (`:736-745`).

## Rewards

Money and hacking experience, both spent inside the node. An install resets all six skills to level 1, clears
jobs and kills, returns money to $1 000 plus each owned augmentation's `startingMoney` ($250m in BN8), and
reverts the server map to its pre-purchase baseline; only home's `maxRam` and `cpuCores` carry over
(`sim/world.ts:355-416`), and faction reputation converts to persistent favor (`sim/features/factions.ts:300-312`).

## BitNode modifiers

| Field | Nodes |
|---|---|
| `ScriptHackMoney` | BN3 0.2 · BN4 0.2 · BN5 0.15 · BN6 0.75 · BN7 0.5 · BN8 0.3 · BN9 0.1 · BN10 0.5 · BN12 `dec` · BN13 0.2 · BN14 0.3 |
| `ScriptHackMoneyGain` | BN8 **0** |
| `HackingSpeedMultiplier` | BN14 **0.3** · BN15 0.6 |
| `HackingLevelMultiplier` | BN2 0.8 · BN3 0.8 · BN6 0.35 · BN7 0.35 · BN9 0.5 · BN10 0.35 · BN11 0.6 · BN12 `dec` · BN13 **0.25** · BN14 0.4 · BN15 0.6 |
| `HackExpGain` | BN4 0.4 · BN5 0.5 · BN6 0.25 · BN7 0.25 · BN9 **0.05** · BN11 0.5 · BN12 `dec` · BN13 0.1 |
| `ServerMaxMoney` | BN2 0.08 · BN3 0.04 · BN4 0.1125 · BN6 0.2 · BN7 0.2 · BN9 0.01 · BN11 0.01 · BN12 `dec²` · BN13 0.3375 · BN14 0.7 · BN15 0.8 |
| `ServerGrowthRate` · `ServerWeakenRate` | growth: BN2 0.8 · BN3 0.2 · BN11 0.2 · BN12 `dec` — weaken: BN11 **2** · BN12 `dec` |
| `ServerStartingSecurity` | BN5 2 · BN6 1.5 · BN7 1.5 · BN9 2.5 · BN12 1.5 · BN13 **3** · BN14 1.5 · BN15 1.5 |
| Fleet cost | BN3 `HomeComputerRamCost` 1.5, `CloudServerCost` 2 · BN9 `CloudServerLimit` **0**, `HomeComputerRamCost` 5 · BN10 `CloudServerCost` 5 |

- BN5 sets no `ServerMaxMoney`, so only per-hack yield falls there; BN15 sets neither `ScriptHackMoney` nor `HackExpGain` and takes `ServerMaxMoney` only to 0.8, so its hacking cost is the 0.6 retiming (`BitNodeMults.ts:101-112,527-542`).
- BN11 is the only node that raises `ServerWeakenRate` above 1 (`BitNodeMults.ts:334`), which doubles every weaken's effect against a `ServerMaxMoney` of 0.01.
- BN12 derives every field from `inc = 1.02^lvl`, `dec = 1/inc` (`BitNodeMults.ts:363-364`), so at level 0 the only fixed hacking change is `ServerStartingSecurity` 1.5 ([BN12](../bitnodes/bn12.md)).
- Two IPvGO opponents carry hacking bonuses, in every node: Illuminati's `bonusDescription` is "faster hack(), grow(), and weaken()" at `bonusPower` 0.7, The Black Hand's is "hacking money" at 0.9 (`Go/Constants.ts:51-62`). [BN14](../bitnodes/bn14.md) sets `GoPower` 4.

## Source map

| Concern | File |
|---|---|
| solve, evaluator, switching, dispatcher, formulas | `shared/strategy/targeting.ts`, `evaluator.ts`, `economics.ts`, `dispatch.ts`, `farm-planner.ts`, `shared/formulas.ts` |
| RAM heap, dodge arena | `shared/ram/heap.ts`, `shared/ram/broker.ts` |
| driver, fleet substrate, probes | `game/lib/features/hacking.ts`, `game/lib/fleet.ts`, `net.ts`, `scan.ts`, `game/lib/probes/local.ts` (`hacking.fleet`) |
| worker, telemetry, tabs, sim | `game/worker/worker.ts`, `shared/telemetry/topics/hacking.ts`, `ui/app/tabs/hacking.ts`, `hacking-server.ts`, `sim/core/effects.ts`, `sim/network.ts`, `sim/world.ts`, `shared/features/servers.ts` |
| vendored rules | `sim/vendor/.../Hacking.ts`, `.../Server/formulas/grow.ts`, `.../Server/GrowthCycles.ts`, `.../Server/data/Constants.ts`, `.../Server/data/ServerMetadata.ts`, `.../Programs/ProgramTable.ts` |

## Open

- What does one dispatcher pass cost on a loaded fleet? `sim/realm/timers.ts` virtualises `performance.now`, so a scenario measures virtual time and cannot answer it.
- At what fleet size does a flagged grow move a forecast enough to pay for itself, given the roll is `stockRandom() < moneyGrown/moneyMax` (`StockMarket/PlayerInfluence.ts:43-46`)?
