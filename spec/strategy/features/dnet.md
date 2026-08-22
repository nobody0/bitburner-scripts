# `dnet` — the darknet

The darknet is a grid of servers `ns.scan` never returns, cracked one hop at a
time by scripts standing next door to their targets. Access is a program
purchase, not a Source-File; what BN15 and SF15 add is the depth of the net and
the augmentations at the bottom of it. The mechanic — `ns.dnet`, network shape,
mutation clock, the 24 server models, passwords, caches, darknet RAM, our
remote-execution model — is [`spec/dnet.md`](../../dnet.md), and the solvers
[`spec/dnet-solvers.md`](../../dnet-solvers.md).

> "Traverse the darknet graph by depth, spending stasis links and charisma to keep servers authenticated while instability rises."

**Theme** BN15 The Secrets of the Dark Net (`shared/features/registry.ts`) ·
**Status** done — overseer/agent pipeline, 24 solvers, sim model (`spec/progress.md`)

**Sourcing.** `src/DarkNet/` cannot be vendored and is absent from the extract
(`sim/vendor/bitburner/src/StockMarket/MarketAdapter.ts:104-108`), so darknet rules
below cite our transcription; only BitNode, SF, aug and Constants facts are vendored.

## Unlock

There are **two** darknet gates and they are not the same test
(`shared/features/unlock.ts:63-75`, `sim/features/dnet.ts:425,480`).

| Gate | Test | Grants |
|---|---|---|
| plain access | `BN15 \|\| activeSF15 > 0 \|\| DarkscapeNavigator.exe on home` | whether the `ns.dnet` API answers at all — `unlocked.dnet` (`shared/features/unlock.ts:144-150`) |
| full access | `BN15 \|\| activeSF15 > 0` | the labyrinth, and with it the net's depth: without it the net is a flat **5** (`shared/strategy/dnet/rates.ts:152-165`, `sim/features/dnet.ts:199,495`). Also the two deepest-tier models, `KingOfTheHill` and `RateMyPix.Auth` (`sim/features/dnet.ts:269,278-285`). This is `Capabilities.darknetFullAccess` |

`DarkscapeNavigator.exe` on home is a real unlock and is **not** source-file
gated, but it buys the API and a depth-5 net, not a Red Pill route: pricing a
labyrinth route off plain access promises one the game does not provide
(`shared/strategy/progression/endgame.ts:474-480`). Detecting it costs
**0.1 GB** beyond the shared `ns.getResetInfo`:
`ns.fileExists("DarkscapeNavigator.exe", "home")`
(`game/lib/probes/gates.ts:119-123`), standing in for `Player.hasProgram`, which
has no ns equivalent. Buying it is `singularity.purchaseTor()` then
`purchaseProgram`, $200 000 (`sim/vendor/bitburner/src/Constants.ts:45`) plus
$50 000 000 (`shared/strategy/dnet/rates.ts:146`), bid on affordability because the
`.cache` reward table is unmodelled (`shared/strategy/dnet/unlock.ts`).

`BitNodeBooleanOptions` has **no** darknet switch
(`types/NetscriptDefinitions.d.ts:1899-1904`); `sourceFileOverrides` lowering SF15
to 0 drops full access outside BN15 and leaves `.exe` access intact.

## Rules

**Charisma is the feature's currency — a hard gate in two places, a scalar
everywhere else.**

| Call | How charisma enters |
|---|---|
| `authenticate` | **duration only.** No charisma requirement is checked; it enters through `skillFactor` and `underleveledFactor` of the auth-time formula (`sim/ns/dnet.ts:81-100`) |
| `heartbleed` | **hard gate.** Below the host's `requiredCharismaSkill` it returns code 451 after a 100 ms delay (`sim/ns/dnet.ts:314-317`) |
| labyrinth move | **hard gate**, on the rung's `cha` and not the host's (`sim/features/dnet.ts:1487`, in `labAttempt`) |
| `memoryReallocation`, `induceServerMigration`, `promoteStock`, `phishingAttack` | wait time and payout scalars only |

The ladder that matters is the labyrinth's, not `getServerRequiredCharismaLevel`:
**300, 600, 1500, 2500, 3000, 3500, 4000**, the last repeated for BonusLab
(`LAB_LADDER`, `shared/strategy/dnet/rates.ts:71-80`; also
`shared/strategy/progression/endgame.ts:97`). Both names are **ours**: neither
`LABYRINTH_CHARISMA` nor `labData` exists in the vendored extract or the d.ts.

**The charisma bill is partly self-paying**, so `career` ↔ `dnet` is a cycle:

| Source | Gain |
|---|---|
| `authenticate`, success or failure | `(3 + 1.1^difficulty) * threads`, ×10 on a *first* success, ×0.2 once rooted (`sim/features/dnet.ts:184-192`) |
| `phishingAttack` | `charisma_exp * threads * 50`, a quarter on failure — every call pays (`sim/features/dnet.ts:1009-1057,142`) |
| `promoteStock` | `charisma_exp * threads * 10 * ((200 + cha) / 200)` (`sim/features/dnet.ts:176-177`) |
| labyrinth exit | a fixed 32-thread equivalent (`sim/features/dnet.ts:1469`) |

**The Red Pill is a labyrinth reward in fourteen of the fifteen nodes.**
`DarknetLabyrinthRewardsTheRedPill` defaults to `1`
(`sim/vendor/bitburner/src/BitNode/BitNodeMultipliers.ts:65`) and the table's only
override is `0` inside `case 8` (`.../BitNodeMults.ts:230`, case opens at `:208`);
`labyrinthOffersRedPill` reads exactly that
(`shared/strategy/progression/endgame.ts:260-265`). Reward order is the six
labyrinth augs then The Red Pill (`:86-96`); where the Pill sits is node-dependent
(`:244-251`, [`bn15.md`](../bitnodes/bn15.md)). The ordinary route charges 2 500 000
Daedalus reputation (`sim/vendor/.../Augmentation/AugmentationTable.ts:2292-2302`);
the labyrinth charges none.

**Darknet RAM is a separate pool.** `ns.scan` omits darknet hosts, so they never
enter the server snapshot or the heap; part of each host's RAM arrives
owner-blocked, drawn against `maxRam` (`sim/features/dnet.ts:305-308`); a host can
move, restart or vanish; only `memoryReallocation` grows it (`:952-969`).

## Needs · Gives · Contends

| Edge | Detail |
|---|---|
| **Needs** `charisma` | Two independent needs. `dnet` posts the lowest blocked host's `requiredCharisma` (`shared/strategy/dnet/decide.ts:96-98`; `dnetNeeds`, `game/lib/features/dnet.ts:974-987`, weight 3, urgency `blocking`); `progression` posts the labyrinth rung's requirement, gated on **full** access (`shared/strategy/progression/endgame.ts:472-490`) |
| **Gives** money | `openCache` and `phishingAttack`, both scaled by `DarknetMoneyMultiplier` (`sim/features/dnet.ts:1123-1132,1030-1046`) |
| **Gives** augmentations | the labyrinth augs plus The Red Pill, queued by the cache, counting toward `DaedalusAugsRequirement` |
| **Gives** karma | `openCache` lowers karma by `difficulty + 1` (`sim/features/dnet.ts:1085`), which `career` and `gang` consume |
| **Gives** a `stock` input | `promoteStock` raises volatility, not forecast; it earns nothing itself (`sim/features/dnet.ts:143,171-172`) |
| **Contends** dodge RAM on home | The seed is the only darknet action home performs, so it is the only claim the feature files (`game/lib/features/dnet.ts:1018-1029`). Everything else runs on darknet RAM, which the arbiter does not allocate |
| **Contends** money | The ordinary arbiter band, for the `.exe` only (`ResourceId` is `"money" \| "time"`, `shared/strategy/arbiter.ts:42`). [`graph.md`](../graph.md) draws every edge here |

## Challenges

- **The four structural constraints** — no global view, PID-owned sessions,
  distance-gated `exec`, a moving map — are cited in [`spec/dnet.md`](../../dnet.md).
- **The labyrinth walker cannot spawn.** Position is keyed by PID
  (`sim/features/dnet.ts:1403-1409`), so one process walks a whole maze — at odds
  with the resident model. No manual fallback exists past the second rung: `manual`
  is true for the first two labs only, and is a UI permission rather than a solver
  requirement (`shared/strategy/dnet/rates.ts:60-80`).

## Rewards

| Reward | Install | BitNode reset |
|---|---|---|
| Money from caches and phishing; karma from `openCache` | survives | money survives, karma does not |
| Programs, WSE / TIX / 4S access, coding contracts from caches | no | no |
| The labyrinth augs, their multipliers, and the ladder position they encode (`shared/strategy/progression/endgame.ts:244-251`) | survives once installed | no |
| The map, sessions, backdoors, stasis links, held passwords | no — a prestige drops the net and every derived fact (`sim/features/dnet.ts:547-551`, `dnetModule.reset`) | no |
| SF15 | survives | survives |
| The Red Pill | not a reward the feature keeps — it *is* the reset | — |

## BitNode modifiers

| Field | Nodes |
|---|---|
| `DarknetMoneyMultiplier` | BN3 0.4 · BN4 0.4 · BN5 0.7 · **[BN8](../bitnodes/bn08.md) 0** · BN9 0.05 · BN10 0.4 · BN12 `1 / 1.02^SF12` · BN13 0.1 · all others **1**, [BN15](../bitnodes/bn15.md) included |
| `DarknetLabyrinthRewardsTheRedPill` | **[BN8](../bitnodes/bn08.md) 0**; `1` everywhere else |
| `CharismaLevelMultiplier` | BN8 0.45 · BN9 0.4 · BN12 `1 / 1.02^SF12` · **[BN15](../bitnodes/bn15.md) 1.1** — the only node that raises it |

From `sim/vendor/bitburner/src/BitNode/BitNodeMults.ts` (money at
`:66,96,127,231,277,322,397,477`; charisma at `:246,289,374,536`), transcribed in
`shared/features/bitnode.ts`, pinned by `sim/tests/bitnode-parity.test.ts`. BN8
removes both headline payouts at once.

SF15's three levels live in [`bn15.md`](../bitnodes/bn15.md). One is a rule of
this feature: the authentication-time discount is gated on active SF15 level
**> 2**, so level 3 (`sim/ns/dnet.ts:99`), and the vendored level list attributes
no speed effect to level 2 (`sim/vendor/.../SourceFile/applySourceFile.ts:173-177`).
Level 3 also gates the faction-rep charisma bonus
(`sim/vendor/.../PersonObjects/formulas/Reputation.ts:66-71`).

## Source map

| Concern | File |
|---|---|
| strategy | `shared/strategy/dnet/decide.ts` and the modules beside it (`queue`, `spread`, `farm`, `hold`, `listen`, `knowledge`, `oracle`, `rates`, `unlock`, `models`, `solvers/`) |
| driver, agents | `game/lib/features/dnet.ts`; `game/dnet/overseer.ts`, `agent.ts`, `jobs.ts`, `realm.ts` |
| unlock gate | `shared/features/unlock.ts`, `game/lib/probes/gates.ts` |
| telemetry, tabs | `shared/telemetry/topics/dnet.ts`; `ui/app/tabs/dnet.ts`, `dnet-map.ts` |
| sim model | `sim/features/dnet.ts`, `sim/ns/dnet.ts` |
| vendored rules | none for the mechanic — see **Sourcing** above |

## Open

- What is one `openCache` actually worth? The reward table is unmodelled, so the
  `.exe` purchase carries no priced value.
- Does `heartbleed` pay charisma experience? Our sim grants none
  (`sim/ns/dnet.ts:310-328`) and no allowed source settles it.
- Does full access change which offline darknet servers come back? Nothing in
  `shared/`, `game/`, `sim/` or the vendored extract models it.
