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
compose into a payout is unvendored but readable from the checkout — see
[The payout formula](#the-payout-formula-and-why-money-still-has-to-be-read-as-text).

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

- **A retry is not free.** The first rejection is quarantined with its replay
  inputs and never retried. Only fresh absence, darknet host retirement, or
  prestige releases it; a dirty listing or solver rebuild does not. Unknown
  types are quarantined rather than guessed (`contracts.ts:584-585`,
  `side.ts:168`).
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

### The payout formula, and why money still has to be read as text

`gainCodingContractReward` composes the three base constants the same way for all of
them: `base * difficulty * (rewardScaling / 3)`, with `CodingContractMoney` applied on
the money branch alone — the "new standard is smaller, more frequent rewards", hence
the third. That answers one of the Open questions below, but does **not** make the
payout computable: `rewardScaling` is per-contract and is not exposed to scripts, and
neither is the reward type. `attempt` returns a display string and nothing else, so a
gain can only be read back out of a sentence written for a human.

`attempt` returns exactly one of six shapes:

| Returned string | Read as |
|---|---|
| `""` | wrong answer — quarantined as `answer rejected`, never a reward |
| `No reward for this contract` | consumed and paid nothing (`reward` was null) |
| `Gained ${repGain} faction reputation for ${faction}` | faction rep, **exact** |
| `Gained ${perFaction} reputation for each of the following factions: ${names}` | faction rep, **exact**; total is `perFaction * count` |
| `Gained ${repGain} company reputation for ${company}` | company rep, **exact** |
| `Gained ${formatMoney(n)}` | money, **approximate** |

Reputation is interpolated as a raw `${number}`, so it is lossless. Money goes through
`formatMoney`, which carries about four significant figures and depends on five player
display settings (`CurrencySymbol`, `CurrencySymbolAfterValue`, `Locale`,
`fractionalDigits`, `disableSuffixes`). So money is reported as a **magnitude**, named
`moneyApprox` on the wire so the caveat cannot be renamed away by a UI, and cross-checked
against the exact `progression.moneySources.sinceInstall.codingcontract` — which is
authoritative for the combined figure but carries no origin split.

**A parse failure is its own outcome.** `parseContractReward`
(`shared/strategy/side/rewards.ts`) returns an `unparsed` variant rather than folding an
unrecognised string into a zero, and the count reaches the wire and the tab. The reason is
concrete: a canonical `formatNumber` output can never contain a thousands separator (below
the suffix threshold the value is under 1000, and above it the mantissa is always within
[1, 1000)), so a separator proves the player's locale is not the one the parser reads.
de-DE's `"$1,235m"` means 1.235e6 and reads as 1235e6 if the comma is stripped — a silent
1000x error, which is exactly what `unparsed` exists to prevent. Upstream's own
`parseBigNumber` strips commas and is deliberately not reused.

`"Gained $0"` is a **real** zero, not a parse failure. Where a node zeroes
`CodingContractMoney`, a money reward pays exactly nothing — and conflating that with "we
could not read the number" would destroy the one signal that says so. It is reached by
the fallback rather than by generation: `getRandomReward` omits `Money` from the valid
types entirely while the multiplier is 0 (`src/CodingContract/ContractGenerator.ts:179-190`
at the pinned commit), which also answers the old "is BN8 reputation-only?" question —
generated contracts there are. A reputation reward with no eligible faction still falls
back to money, so a `$0` remains reachable in exactly that case.

**A parsed currency says what was PAID, not what the contract was worth.** Upstream falls
back between currencies — a faction-reputation reward with no hacking faction joined pays
money instead, and a company-reputation reward with no job pays faction reputation. The
split is income attribution, never reward-type generation statistics.

The parser is **total**: it never throws, for any input. That is not defensiveness. It runs
in the driver's post-attempt block, where the controller swallows a driver throw and the
pipeline resume vars would still be set — so the next tick would skip inspect/getData and
re-attempt contracts the game has already answered, burning a try on a one-try contract.
The driver releases the pipeline the moment the attempts are submitted for the same reason.

### Attribution by origin

Outcomes are since-install and split `network` / `darknet`; an absent row means
no attempt, not zero reward. The separate observed/solvable census cannot be
derived from the bounded queue. Dirty darknet listings revoke actionability but
retain terminal attribution until fresh absence or host retirement. Only the
origin tag crosses telemetry.

The counters can undercount, but not double-count, if a dodge dies after the
game accepts an attempt and before its result returns. The exact game ledger is
the cross-check.

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
| reward-string parser | `shared/strategy/side/rewards.ts` |
| driver | `game/lib/features/side.ts` |
| probe | `game/lib/probes/dodged.ts` (`side.contracts`, line 1858) |
| telemetry topic | `shared/telemetry/topics/side.ts` |
| tab | `ui/app/tabs/side.ts` |
| sim ns surface, tests | `sim/ns/api.ts:872`, `sim/ns/ram-costs.ts:429`, `sim/tests/contracts-parity.test.ts`, `sim/tests/ns-contracts.test.ts` |
| vendored rules | `sim/vendor/bitburner/src/CodingContract/` |

## Open

The vendored extract carries the contract *types* only — not reward payout, generation
or the ns implementation — so these stay questions, not prose:

- Does a **malformed** answer consume a try, or is it rejected before the attempt is
  counted? The driver distinguishes a throw from an empty return
  (`side.ts:241-249`), but the game-side semantics are unconfirmed.
- What governs spawn rate and placement, and does the count saturate? Our only
  evidence is one BN12 save at 8 557 files.
- Contracts pay company reputation, but [`graph.md`](../graph.md) lists that
  resource as produced by company work alone. Should the row name `side` too?
  The `companyRep` counter is the evidence path: once a run records a non-zero
  value, name `side` in the row and strike this question. Answer it on observed
  evidence, not on the strength of the upstream read.
