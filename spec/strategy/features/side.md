# `side` — coding contracts

Coding contracts are `.cct` files scattered across the network. Each poses one
algorithmic problem and accepts a limited number of answers; `attempt` returns "a
reward string on success or empty string on failure"
(`types/NetscriptDefinitions.d.ts:4032`). All 30 problem types
(`sim/vendor/bitburner/src/CodingContract/Enums.ts:3-32`) ship a `getAnswer` and a
`solver` in the vendored table (`CodingContract/ContractTypes.ts:38-52`), so this is
the only feature whose correctness is *proven* against the game's own validators.

> "Solve every coding contract in low-RAM batches and quarantine the first
> rejected answer for diagnosis without risking another attempt."
> (`shared/features/registry.ts:180-181`)

**Theme** none — the one feature with an empty `bitnodes` list
(`shared/features/registry.ts:178`) · **Status** done (`spec/progress.md:40`,
`:399`)

## Unlock

Always, unconditionally (`shared/features/unlock.ts:109`) — no BitNode, Source-File
or `BitNodeBooleanOptions` field can remove it. RAM per call
(`types/NetscriptDefinitions.d.ts:4030-4158`, mirrored `sim/ns/ram-costs.ts:429-437`):
`attempt` 10 · `getContract` 15 · `getContractType`/`getData`/`getDescription` 5 ·
`getNumTriesRemaining`/`createDummyContract` 2 · `getContractTypes` 0 GB.

## Rules

**Attempts are limited, and running out destroys the contract.** `numTries` is "how
many tries you get. Defaults to 10." (`ContractTypes.ts:49-50`), and
`getNumTriesRemaining` returns "the number of tries remaining on the contract before
it **self-destructs**" (`types/NetscriptDefinitions.d.ts:4129`; also
`numTriesRemaining()` on the `getContract` object, `:9613`). The five overrides:

| Type | Tries |
|---|---|
| Array Jumping Game | **1** (`contracts/ArrayJumpingGame.ts:40`) |
| Array Jumping Game II | 3 (`contracts/ArrayJumpingGame.ts:91`) |
| Algorithmic Stock Trader I | 5 (`contracts/AlgorithmicStockTrader.ts:36`) |
| Proper 2-Coloring of a Graph | 5 (`contracts/Proper2ColoringOfAGraph.ts:8`) |
| Merge Overlapping Intervals | 15 (`contracts/MergeOverlappingIntervals.ts:34`) |

**Difficulty** is a per-type constant — "difficulty of the contract. Higher is
harder." (`ContractTypes.ts:33-35`) — spanning 1 to 10 across the vendored table,
exposed to scripts as `difficulty` (`types/NetscriptDefinitions.d.ts:9612`).

**Three reward currencies**, each with a base constant
(`sim/vendor/bitburner/src/Constants.ts:92-94`): faction reputation
`CodingContractBaseFactionRepGain` **2500**, company reputation
`CodingContractBaseCompanyRepGain` **4000**, money `CodingContractBaseMoneyGain`
**75e6**. Only money carries a BitNode multiplier — `CodingContractMoney` "influences
the amount of money gained from completing Coding Contracts"
(`types/NetscriptDefinitions.d.ts:703-704`) — and it is the multiplier table's only
contract field (`BitNode/BitNodeMultipliers.ts:31-32`). How difficulty and the bases
compose into a payout is unvendored, and stays an Open question below.

**Coverage is 30 of 30.** `SOLVERS` holds 30 entries
(`shared/strategy/side/contracts.ts:543-577`); `sim/tests/contracts-parity.test.ts:11-13`
asserts set equality between the *deployed* registry and `CodingContractTypes`, then
round-trips 20 generated instances per type through the official
`generate`/`validateAnswer`/`solver`. The probe rechecks coverage at runtime from the
live `getContractTypes()` (`game/lib/probes/dodged.ts:1885-1887`).

## Needs · Gives · Contends

**Needs** No `NeedKind` — nothing posted to the needs board; only the fleet server
list from the hacking scan, and dodge RAM.

**Gives** Money (`moneySources: ["codingcontract"]`, `registry.ts:182`), faction and
company reputation. The reputation kinds make `side` an **inbound edge to
`factions`** ([`graph.md`](../graph.md)) — rep that costs no work slot. `side` also
owns the `infiltrations` blocker, reported `reachable: false`
(`shared/strategy/factions/requirements.ts:165`, `:400`).

**Contends** Dodge/fleet RAM only. `claims` returns one `actionRamClaim` and no time
claim (`game/lib/features/side.ts:291-293`), so `side` never enters the arbiter's
player-time auction (`shared/strategy/arbiter.ts:24`).

## Challenges

- **A retry is not free.** With Array Jumping Game at one try, a second guess costs
  the whole reward. The driver quarantines on first rejection — type, data, answer and
  `triesBefore`, for offline replay — and never re-attempts (`side.ts:246`, `:78-98`);
  quarantine lifts only when `CONTRACT_SOLVER_VERSION` changes (`:110-113`,
  `contracts.ts:18`). An unregistered type is quarantined too — `solve` returns
  `undefined`, not a guess (`contracts.ts:584-585`, `side.ts:168`).
- **A thrown error is not a rejected answer.** `reward === ""` is quarantined as
  `answer rejected`, a caught throw carries its error text, and "Cannot find contract"
  means the file is already gone, not a failure (`side.ts:241-249`).
- **The file list is unbounded.** A real BN12 save reached 8 557 contracts, 3 730
  unsolvable; publishing it made one `side` state record 1.66 MB and stalled the
  viewer before first paint (`dodged.ts:1845-1850`). The queue caps at
  `CONTRACT_QUEUE_LIMIT` 100; only a 20-file front batch plus counts ships
  (`contracts.ts:23-24`).
- **Peak RAM, not total RAM, is the constraint.** Inspect (7 GB), `getData` (5 GB)
  and `attempt` (10 GB) run as three separate dodges, so the stub peak is 10 GB, not
  the 22 GB one closure would price (`side.ts:128`). Each stage is priced once per
  batch whatever the file count, and a queued lease resumes its own stage rather
  than restarting (`:41-45`).
- **Discovery must stay cheap.** The probe calls only `ls` (0.2 GB) and the free
  `getContractTypes`, never a per-file getter, and reaps dead quarantine entries in that same sweep (`dodged.ts:1864`, `:1883`).

## Rewards

Money, faction reputation, company reputation. Install and node-reset persistence is
owned by the resource table in [`graph.md`](../graph.md), which lists none of the three
as permanent — so `side`'s value is a rate, not a stock.

## BitNode modifiers

| Field | Nodes |
|---|---|
| `CodingContractMoney` | [BN8](../bitnodes/bn08.md) **0** · [BN10](../bitnodes/bn10.md) 0.5 · [BN11](../bitnodes/bn11.md) 0.25 · [BN12](../bitnodes/bn12.md) `1/1.02^lvl` · [BN13](../bitnodes/bn13.md) 0.4 |

`sim/vendor/bitburner/src/BitNode/BitNodeMults.ts:218`, `:303`, `:341`, `:396`, `:452`.
Every other node leaves it at 1. Being the table's only contract field, a node that
zeroes contract money does not touch the reputation rewards.

## Intentional boundary

Infiltration and the casino are manual UI gameplay: not probed, ranked, simulated or
presented as automation work. Nothing under `game/`, `shared/` or `ui/` calls
`ns.infiltration`, and the ns surface exposes the casino only as a `MoneySource`
field and a `LocationName`, with no action API
(`types/NetscriptDefinitions.d.ts:112`, `:9333`). Infiltration's one appearance is
Shadows of Anarchy's `numInfiltrations` requirement, "deliberately reported as a
manual-only blocker until the resulting Shadows of Anarchy invitation is observed"
(`shared/strategy/factions/requirements.ts:39-41`). The game exposes no completion
counter, so SoA invitation **or** membership is accepted as authoritative evidence
of the one required infiltration (`game/lib/features/factions.ts:244-248`).

## Source map

| Concern | File |
|---|---|
| solvers, limits, registry | `shared/strategy/side/contracts.ts` |
| driver | `game/lib/features/side.ts` |
| probe | `game/lib/probes/dodged.ts` (`side.contracts`, line 1858) |
| telemetry topic | `shared/telemetry/topics/side.ts` |
| tab | `ui/app/tabs/side.ts` |
| sim ns surface, tests | `sim/ns/api.ts:872`, `sim/ns/ram-costs.ts:429`, `sim/tests/contracts-parity.test.ts`, `sim/tests/ns-contracts.test.ts` |
| vendored rules | `sim/vendor/bitburner/src/CodingContract/` |

## Open

The vendored extract carries the contract *types* only — not reward payout, generation
or the ns implementation — so these stay questions, not prose:

- How do the three base constants compose into a payout? Difficulty and a
  `rewardScaling` factor are both involved; the arithmetic is unvendored.
- Does a **malformed** answer consume a try, or is it rejected before the attempt is
  counted? The driver distinguishes a throw from an empty return
  (`side.ts:241-249`), but the game-side semantics are unconfirmed.
- Is money excluded from a contract's *generated* reward type when
  `CodingContractMoney` is 0, making [BN8](../bitnodes/bn08.md) reputation-only?
  BN8's `0` is vendored; the generation rule is not.
- What governs spawn rate and placement, and does the count saturate? Our only
  evidence is one BN12 save at 8 557 files.
- Contracts pay company reputation, but [`graph.md`](../graph.md) lists that
  resource as produced by company work alone. Should the row name `side` too?
