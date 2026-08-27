# `hacknet` — nodes, servers, hashes

A Hacknet Node is a machine bought with cash that mints cash forever after. In BN9, or with SF9.1 held anywhere, nodes
become **Hacknet Servers**: they mint **hashes** instead of money *and* join the script fleet as ordinary RAM hosts.
Two problems, not one — nodes are an income annuity, servers a currency exchange whose stock is the farm's own RAM.

> "Buy the node or level/RAM/core upgrade with the fastest ROI that still repays before the run horizon, competing
> with other income investments in the same unit."

**Theme** BN9 Hacktocracy (`shared/features/registry.ts:86-94`) · **Status** done (`spec/progress.md:31`)

## Unlock

**Nodes are playable in every BitNode with no Source-File** (`shared/features/unlock.ts:108`), and every
`ns.hacknet.*` call costs a flat **0.5 GB** (pinned v3.0.1 `src/Netscript/RamCostGenerator.ts:38,99-121`), so the
feature never fights for RAM — only for money. **Servers need `canAccessBitNodeFeature(9) &&
!bitNodeOptions.disableHacknetServer`** (`src/Hacknet/HacknetHelpers.tsx:34-36`): BN9, or SF9 level ≥ 1 elsewhere.
That option degrades rather than vetoes, so it travels in `Capabilities.restrictions` (`unlock.ts:156-159`) and the
driver reads it before choosing hash mode (`game/lib/features/hacknet.ts:193-196`); without servers the hash API is
inert rather than throwing (`src/NetscriptFunctions/Hacknet.ts:177-223`).

## Rules

### Production

`sim/vendor/bitburner/src/Hacknet/formulas/HacknetNodes.ts:5-12` and `.../HacknetServers.ts:5-18`:

```
moneyPerSec = level * 1.5 * 1.035^(ram-1) * (cores+5)/6 * mult * HacknetNodeMoney
hashPerSec  = 0.001 * level * 1.07^log2(maxRam) * (1 + (cores-1)/5)
              * (1 - ramUsed/maxRam) * mult * HacknetNodeMoney
```

Nodes cap at level 200, 64 GB, 16 cores, **unlimited count**; servers at level 300, 8192 GB, 128 cores, cache 15,
**20 servers**, every cost curve geometric (`data/Constants.ts:15-17,47-52`). A fresh server is level 1, **1 GB**, 1
core, cache 1 (`src/Hacknet/HacknetServer.ts:33-63`); hash capacity is `32 * 2^cache` (`:121-123`) — 64 fresh,
1,048,576 at cache 15 — summed over servers to form the bank (`HacknetHelpers.tsx:434-464`).

`1 - ramUsed/maxRam` is the whole tension. A server hangs off home's network with admin rights
(`src/PersonObjects/Player/PlayerObjectServerMethods.ts:46-63`), so it is an ordinary fleet host counted in
`fleet.maxRam` and excluded only from the *purchased-server* aggregate (`game/lib/probes/local.ts:48-51`), and
`updateRamUsed` re-derives its hash rate on every allocation (`HacknetServer.ts:116-119`). **Overflow is not lost**:
hashes above capacity auto-sell at the Sell-for-Money rate (`HacknetHelpers.tsx:414-425`), so capacity limits only
*saving toward* an expensive upgrade, never income.

One-step marginal production (`formulas.ts:24-42`); cache is valued at **zero**, since crediting capacity with income would corrupt every payback (`hacknet.ts:225`).

| Step | Δ node | Δ server |
|---|---|---|
| level +1 | `p / level` | `p / level` |
| core +1 | `p / (cores + 5)` | `p / (cores + 4)` |
| ram ×2 | `p * (1.035^ram - 1)` | `p * (1.07 * freeRatio' / freeRatio - 1)` |

### The hash menu

`Sell for Money` costs a **flat** 4 hashes; every other row costs `costPerLevel * (level + 1)` next, so its price rises
by its own base each purchase and resets only at an install (`HashUpgrade.ts:72-82`, `data/HashUpgradesMetadata.tsx:8-121`).

| Upgrade | Hashes | Effect | Feeds |
|---|---|---|---|
| Sell for Money | 4 flat | +$1e6 | the money arbiter |
| Sell for Corporation Funds | 100·n | +$1e9 corp funds | `corp` |
| Reduce Minimum Security | 50·n | target `minDifficulty` ×0.98, floor 1 | `hacking` |
| Increase Maximum Money | 50·n | target `moneyMax` ×1.02, softcap $10e12 | `hacking` |
| Improve Studying / Gym Training | 50·n | +20% class or gym exp, additive per level | `career` |
| Exchange for Corporation Research | 200·n | +1000 research, every division | `corp` |
| Exchange for Bladeburner Rank / SP | 250·n | +100 rank, or +10 skill points | `bladeburner` |
| Generate Coding Contract | 25·n | one random contract on the network | `side` |
| Company Favor | 200·n | +5 favor at one company | `factions`, `career` |

Note what is *not* there: **no upgrade buys RAM, cores or levels** — that hardware costs cash. Both target mutations
refuse a server the player owns (`HacknetHelpers.tsx:481-518`); study/gym reaches only class and gym exp
(`src/Work/Formulas.ts:108-114`). `getHashUpgrades()` lists all eleven names and filters nothing by subsystem
(`Hacknet.ts:218-223`), so suppressing a row whose feature is absent is ours (`hacknet.ts:88-157`).

### The `hacknet` → `hacking` loop

The two target mutations change exactly the statics the cycle solver used to pick the farm target, so hash spend feeds
back into `hacking`'s target score. `targetHashValues` (`shared/strategy/hacknet/hashes.ts:87-108`) re-solves that
same cycle with `minDifficulty * 0.98` and `moneyMaxAfterHash(moneyMax)` (`:75-83`, reproducing the softcap of
`src/Server/Server.ts:126-134` exactly), prices the score delta over the fleet and the remaining horizon, then
subtracts what selling the same hashes would have paid. So this is a closed loop, not a one-way income line: a spender
that only sold hashes would never raise the ceiling on the farm funding it. Otherwise it reserves for the best goal,
asks for cache when it exceeds capacity, sells the rest (`:114-166`).

### Ranking, the horizon, and the off state

Candidates are scored in `marginal $/sec / cost`, hashes converted through the observed Sell-for-Money quote
($250,000 per hash at cost 4). Anything that cannot repay before the remaining horizon is ineligible; among those that
can, **fastest payback wins**, net value only breaking ties (`shared/strategy/hacknet/decide.ts:160-179`); a leader
above the grant does not idle it, the driver taking the best affordable profitable rung instead (`:193-201`). Ordinary
upgrades post at `income:investment` **25**, the shared band where `hacking` infrastructure (home RAM, home cores,
purchased servers) and stock unlocks also sit, so `returnPerDollarSec` decides between them
(`shared/strategy/arbiter.ts:344-351`); only milestones escalate, at `hacknet:blocking-need` 75, `wanted` 45, `nice`
35 (`:319-321`). Server RAM is valued as the **better of two mutually exclusive uses**, never their sum — idle GB
raise the free-RAM hash multiplier, occupied GB earn farm income but produce fewer hashes (`hacknet.ts:237-244`).

`HacknetNodeMoney` at **0** (BN8) zeroes every production term, so every candidate's `netOverHorizon` is `-cost` and
the feature holds forever: the ROI gate *is* the off switch, exactly rather than by cadence (`decide.ts:183-184`,
`formulas.ts:18-21`). At **0.05** (BN4) production is non-zero, so nothing is vetoed outright — payback becomes 20×
longer and the horizon cut removes all but the cheapest rungs. Answering either with a slower cadence keeps buying.

## Needs · Gives · Contends

**Needs** `money`, continuously and without end.
**Gives** money (nodes, and hash sales); `hacknetRam` / `hacknetCores` / `hacknetLevels` toward Netburners — hacking 80,
8 GB, 4 cores, 100 levels, summed across nodes *and* servers (`sim/vendor/.../FactionTable.ts:1318-1344`); fleet RAM;
every hash-menu row.
**Contends** money, in `income:investment` against `hacking` infrastructure and `stock`; and fleet RAM with itself,
since a busy server produces fewer hashes.

## Challenges

- **The hash bank is not a leak.** Overflow auto-sells, so buying cache "to stop spilling" is a loss — only a goal priced above capacity justifies it.
- **Server RAM is double-countable**, and which use happens is the scheduler's call — hence the max of the two, not a threshold that jumps as the fleet crosses it.
- **Every hash quote is stale after a spend**, since all non-sale prices escalate; the driver invalidates both menus after each success (`:380,407`).

## Rewards

**Nothing survives an install.** `prestigeAugmentation` clears `hacknetNodes` and calls `hashManager.prestige()`,
zeroing the nodes, the bank and every hash upgrade *level*, so the escalating prices reset to base too
(`src/PersonObjects/Player/PlayerObjectGeneralMethods.ts:130-131`, `src/Hacknet/HashManager.ts:80-88`); the
min-security and max-money mutations die with the server reset. `Company Favor` survives an install but is zeroed at
BitNode entry (`src/Company/Company.ts:77-85`). Across a BitNode only SF9 persists, cost factor `1 - mult/100`
(`sim/vendor/bitburner/src/SourceFile/applySourceFile.ts:134-148`). Both grants fire in `prestigeSourceFile`, so
neither returns on an install, and BN9 grants the level-3 server regardless of SF9 level (`src/Prestige.ts:338`):

| SF9 | Production | Costs | Grant |
|---|---|---|---|
| 1 | ×1.12 | ×0.88 | unlocks Hacknet Servers in other BitNodes |
| 2 | ×1.18 | ×0.82 | 128 GB home RAM on BitNode entry (`src/Prestige.ts:246-247`) |
| 3 | ×1.21 | ×0.79 | one server at level 100, 10 cores, cache 5 on entry (`:338-347`) |

## BitNode modifiers

| Field | Nodes |
|---|---|
| `HacknetNodeMoney` | BN3 0.25 · [BN4](../bitnodes/bn04.md) **0.05** · BN5 0.2 · BN6 0.2 · BN7 0.2 · [BN8](../bitnodes/bn08.md) **0** · BN10 0.5 · BN11 0.1 · BN12 `1/1.02^lvl` · BN13 0.4 · BN14 0.25 |
| `HomeComputerRamCost` | BN3 1.5 · [BN9](../bitnodes/bn09.md) **5** · BN10 1.5 · BN12 `1.02^lvl` |
| `CloudServerLimit` | [BN9](../bitnodes/bn09.md) **0** · BN10 0.6 · BN12 `1/1.02^lvl` |

Values from `sim/vendor/bitburner/src/BitNode/BitNodeMults.ts`. **BN9 leaves `HacknetNodeMoney` at 1.0**; its attack is
structural — `CloudServerLimit: 0` with `HomeComputerRamCost: 5` (`:239-256`) makes Hacknet Servers the only
purchasable RAM there, capped at 20 × 8192 GB, every GB the farm occupies costing hashes.

## Source map

| Concern | File |
|---|---|
| strategy | `shared/strategy/hacknet/decide.ts`, `formulas.ts`, `hashes.ts` |
| driver · probe | `game/lib/features/hacknet.ts` · `game/lib/probes/priced.ts:706-814` |
| topic · tab | `shared/telemetry/topics/hacknet.ts` · `ui/app/tabs/hacknet.ts` |
| sim | `sim/features/hacknet.ts` · `sim/tests/hacknet-strategy-parity.test.ts` |
| vendored rules | `sim/vendor/bitburner/src/Hacknet/` |

## Open

- At what fleet utilization does filling hacknet-server RAM with farm workers beat leaving it idle in BN9, where
  `ServerMaxMoney` is 0.01 and `ScriptHackMoney` 0.1? No crossover has been measured, and `sim/profiles.ts` carries
  end-to-end runs for BN1 and BN8 only (`:406,442`).
