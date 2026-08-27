# `corp` — the corporation

A second economy the player owns: divisions in one of fourteen industries
(`src/Corporation/Enums.ts:3-18`), offices and warehouses across six cities
(`sim/vendor/bitburner/src/Locations/Enums.ts:71-78`), employees in seven
positions (`src/Corporation/Enums.ts:20-28`), research points, four funding
rounds, then a public listing. Every ten real seconds it runs a five-state cycle,
reprices its valuation, and pays the player a share of last cycle's profit as
dividends.

> "Sequence divisions, offices, warehouses, research and investment rounds to
> maximise valuation, then dividends, per real-time cycle."

**Theme** BN3 Corporatocracy (`shared/features/registry.ts:116-124`) ·
**Status** strategy only — the stage machine is complete, the calls are not
issued (`spec/progress.md:34`)

## Unlock

| Gate | Fact |
|---|---|
| `corporation.hasCorporation()` | **0 GB**, no API access needed; the whole gate (`types/NetscriptDefinitions.d.ts:10182-10189`, `game/lib/probes/gates.ts:27,109`, `shared/features/unlock.ts:130`) |
| `canCreateCorporation(selfFund)` | **0 GB** — free pre-flight check (`types/NetscriptDefinitions.d.ts:10191-10200`) |
| Access | `canAccessBitNodeFeature(3) && !bitNodeOptions.disableCorporation` — BN3 or any active SF3 level (`PlayerObjectCorporationMethods.ts:8-10`, `src/BitNode/BitNodeUtils.ts:17-19`) |
| `disableCorporation` | Vetoes the feature outright (`shared/features/unlock.ts:166`); `sourceFileOverrides` for SF3 moves the API tier |
| Creation checks | An existing corporation returns `CorporationExists`; `bitNodeN !== 3 && !selfFund` throws, so **seed money exists only in BN3**; `CorporationSoftcap < 0.15` throws, so creation is impossible at all (`src/Corporation/helpers.ts:30-43`) |
| Self-fund cost | **$150e9**, or $50e9 to restart one not seed-funded (`helpers.ts:46-51`) |
| Seed fund instead | Investors get 500e6 of the 1e9 initial shares — 50% dilution before cycle one (`PlayerObjectCorporationMethods.ts:26-29`, `data/Constants.ts:44`) |

**BN3 or SF3 at exactly level 3** adds `WarehouseAPI` + `OfficeAPI` at creation.
The test is an equality — `bitNodeN === 3 || activeSourceFileLvl(3) === 3` — so
SF3.1 and SF3.2 grant nothing (`PlayerObjectCorporationMethods.ts:21-24`). Below
that tier the corporation is only **partially** scriptable: corporation-scope
calls (`getCorporation`, `expandIndustry`, `acceptInvestmentOffer`, `goPublic`,
`bribe`, `purchaseUnlock`, `levelUpgrade`) pass `checkAccess` with no `api`
argument; every warehouse- and office-scoped call throws `"You do not have access
to this API."` (`src/NetscriptFunctions/Corporation.ts:157-163`). Both unlocks
cost **$50e9 each from corporation funds** (`data/CorporationUnlocks.ts:66-74`),
so the degraded path is found → expand → raise → buy the two unlocks → continue.
The driver must probe access and degrade, not throw.

## Rules

**Valuation** (`Corporation.ts:198-224`), `assetDelta = (totalAssets - previousTotalAssets) / 10`:

```
private: val = 10e9 + funds/3;  if (assetDelta > 0) val += assetDelta * 315e3
public:  val = funds + assetDelta * 85e3 * (dividendRate > 0 ? 1 - dividendRate : 1)
both:    val *= 1.0079741404289038 ** numberOfOfficesAndWarehouses
         val = max(val, 10e9) * CorporationValuation
```

**Dividends** (`Corporation.ts:189-196`, `:54`):

```
tributeModifier = 1 - CorporationSoftcap + 0.15
dividends = numShares * (dividendRate * (revenue - expenses) * 10) / totalShares
payout    = dividends ** (1 - tributeModifier)
```

| Mechanic | Fact |
|---|---|
| Cycle | `secondsPerMarketCycle = 50 * 200 / 1000 = 10` s; five states `START · PURCHASE · PRODUCTION · EXPORT · SALE` of 10 game cycles (2 s) each (`data/Constants.ts:25,52-54`, `src/Constants.ts:19`) |
| Cycle accounting | Revenue, dividends, valuation and share price recompute only at `START`; `process()` advances at most one state per call (`Corporation.ts:112-186`), which is why our sim caps the drain at 10× (`sim/engine.ts:241-247`) |
| Reported valuation | Mean of the last 10 cycle valuations (`Corporation.ts:226-232`) |
| `numberOfOfficesAndWarehouses` | +2 per new division, +1 per further office or warehouse (`Actions.ts:94,133,434`) |
| Softcap | An **exponent on the payout**, not a factor: softcap 1 (BN1, BN3) → exponent 0.85; softcap 0.4 (BN13, BN15) → 0.25 |
| Dividend asymmetry | The corporation loses the full untaxed amount, the player receives the taxed one (`Corporation.ts:167-169`) |
| `dividendMaxRate` | 1 (`data/Constants.ts:64`); while public, paying out suppresses valuation growth by `1 - dividendRate` |
| Tribute reducers | `ShadyAccounting` ($500e12) and `GovernmentPartnership` ($2e15) subtract 0.05 and 0.1 permanently (`Corporation.ts:392-398`, `data/CorporationUnlocks.ts:50-60`) |
| Funding rounds | Four. `fundingRoundShares = [0.1, 0.35, 0.25, 0.2]`, `fundingRoundMultiplier = [3, 2, 2, 1.5]` (`data/Constants.ts:71-72`) |
| Round price | `funding = valuation * share * mult` costs `1e9 * share` of the player's shares (`Actions.ts:190-208`), so funding per share sold is `valuation * mult / 1e9` — the multiplier alone, highest in round 1. Going public ends the sequence (`Corporation.ts:333-343`) |
| Division cost | Restaurant $10e9 · Tobacco $20e9 · Software $25e9 · Agriculture $40e9 · Robotics $1e12 (`data/IndustryData.ts:96,268,241,9,214`) |
| Office / warehouse | $4e9 at size 3 · $5e9 at size 100 (`data/Constants.ts:55-60`). A new division arrives with a Sector-12 office and warehouse built (`Division.ts:87-101`) |
| Employees | Offices start at **zero** (`OfficeSpace.ts:31`); only `HRBuddy-Recruitment` hires automatically (`OfficeSpace.ts:55-59`). `getOfficeProductivity` returns 0 when Operations, Engineer and Management production sum to 0 (`Division.ts:991-997`), so no employees means no production and no revenue |
| Research | `0.004 * employeeProductionByJob[R&D]^0.5 * corpMult * divisionMult` per office per cycle (`Division.ts:477-482`); each node has a prerequisite parent and spending is irreversible (`Actions.ts:501-540`) |
| Product slots | `uPgrade: Capacity.I`/`.II` are the only way past `maxProductsBase = 3` (`Division.ts:44-53`) |
| Division cap | `maxDivisions = 20 * CorporationDivisions` (`Corporation.ts:38`) — 10 in BN12, 8 in BN13 and BN15 |

## Needs · Gives · Contends

| Edge | Fact |
|---|---|
| **Needs** | Nothing. `corp` publishes and consumes no `NeedKind` (`shared/strategy/needs.ts` has no corp entry); it still uses a local value model rather than route weights (`spec/progress.md:1759`) |
| **Gives** money | Dividends arrive as spendable cash, counted as measured income (`game/lib/income.ts:91-94`) |
| **Gives** reputation | `bribe` converts corporation funds at **$1e9 per 1 rep**, needing valuation ≥ `bribeThreshold` $100e12, membership, and a faction that offers work (`Actions.ts:633-675`, `data/Constants.ts:61-62`). It checks no favor, so it is not the donation lever — see [`factions.md`](factions.md) |
| **Contends** money | Prospectively only. `corpModule.claims` returns `[]` while execution is unwired: the standing $150e9 `corp:seed` reserve starved every band below priority 85 and could never fund the founding it named, since the feature does not unlock until a corporation already exists (`game/lib/features/remaining.ts:3621-3632`). Bands `corp:seed` 85 and `corp:expand` 40 remain defined (`shared/strategy/arbiter.ts:340-342`) |

## Challenges

- **The gate cannot bootstrap itself.** With `hasCorporation` false the feature
  is unavailable and the driver never runs, so nothing calls `createCorporation`;
  the `found` stage is unreachable from a driver that hardcodes
  `hasCorporation: true` (`remaining.ts:327`).
- **The modelled stages omit every action that would earn.** None hires, upgrades
  an office, sets a sell price or buys an unlock, though `hire`, `upgradeOffice`
  and `sellMaterial` are declared `CorpAction`s (`stages.ts:38-49`) and
  `setSmartSupply` throws without the $25e9 SmartSupply unlock
  (`src/NetscriptFunctions/Corporation.ts:337`, `data/CorporationUnlocks.ts:23-24`).
  With zero employees productivity is 0, so `revenue` stays 0, and `investment-1`
  is `ready` only when `view.revenue > 0` (`stages.ts:147`) — a permanent stall.
- **Some actions fail silently.** `purchaseWarehouse`, `upgradeWarehouse` and
  `hireAdVert` return with no error when funds are short
  (`Actions.ts:426,446,454`), so "did it throw" is not a success test.
- **The `tobacco` gate is `funds > 20e9` (`stages.ts:162`)** — exactly the
  industry `startingCost`, leaving nothing for further offices, warehouses or the
  product design investment.
- **Probing is expensive.** `CorporationInfo` calls are 10 GB, actions 20 GB
  (`src/Netscript/RamCostGenerator.ts:13-14`). `corp.core` splits two independent
  10 GB reads to avoid a 21.6 GB contiguous block
  (`game/lib/probes/priced.ts:1100-1108`); `corp.divisions` runs at half cadence
  and owns `divisions` alone, since topic merges are shallow
  (`shared/telemetry/topics/corp.ts`). `sim/` has no corporation model at all, so
  its ns calls report `unmodeled()` (`sim/game-run.ts:373`,
  `spec/progress.md:1697`).

## Rewards

| Reward | Survives |
|---|---|
| Dividends, as player cash | No — wiped to $1000 by an install like all money ([`graph.md`](../graph.md)) |
| Faction reputation via `bribe` | An install, as favor does |
| The corporation itself | An augmentation install — `prestigeAugmentation` does not clear `Player.corporation` (`src/PersonObjects/Player/PlayerObjectGeneralMethods.ts:80-142`); `prestigeSourceFile` does (same file, `:159,169`) |
| Industry research trees | Reset on a BitNode reset only (`src/Prestige.ts:334`, inside `prestigeSourceFile`) and again at each corporation creation (`PlayerObjectCorporationMethods.ts:19`) |
| SF3's own effects | [BN3](../bitnodes/bn03.md) |

## BitNode modifiers

| Field | Nodes |
|---|---|
| `CorporationValuation` | BN5 0.75 · BN6 0.2 · BN7 0.2 · **BN8 0** · BN9 0.5 · BN10 0.5 · BN11 0.1 · BN12 `dec` · **BN13 0.001** · BN14 0.4 · BN15 0.2 |
| `CorporationSoftcap` | BN2 0.9 · BN6 0.9 · BN7 0.9 · **BN8 0** · BN9 0.75 · BN10 0.9 · BN11 0.9 · BN12 0.8 · BN13 0.4 · BN14 0.9 · BN15 0.4 |
| `CorporationDivisions` | BN2 0.9 · BN5 0.75 · BN6 0.8 · BN7 0.8 · **BN8 0** · BN9 0.8 · BN10 0.9 · BN11 0.9 · BN12 0.5 · BN13 0.4 · BN14 0.8 · BN15 0.4 |

Source: `sim/vendor/bitburner/src/BitNode/BitNodeMults.ts`, cases 2–15. BN1, BN3
and BN4 leave all three at 1. [BN8](../bitnodes/bn08.md) cannot found a
corporation at all — softcap 0 is below the 0.15 floor; [BN13](../bitnodes/bn13.md)
pairs valuation 0.001 with payout exponent 0.25. The driver must not-run
gracefully in both.

## Source map

| Concern | File |
|---|---|
| strategy | `shared/strategy/corp/stages.ts` |
| driver | `game/lib/features/remaining.ts:319-370`, `corpModule` at `:3621` |
| probes | `game/lib/probes/gates.ts` · `game/lib/probes/priced.ts:1100` (`corp.core`), `:1219` (`corp.divisions`) |
| telemetry topic | `shared/telemetry/topics/corp.ts` |
| tab | `ui/app/tabs/corp.ts` |
| arbiter bands | `shared/strategy/arbiter.ts:340-342` |
| income | `game/lib/income.ts:91-94` |
| sim (cadence only) | `sim/engine.ts:64-65,241-247`; unmodelled at `sim/game-run.ts:373` |
| upstream rules | **Bare `src/…` citations above are checkout paths at pinned commit `3162fd2`**: `Corporation/` is not vendored — `tools/vendor.ts:74` hash-pins it under `TRANSCRIPTION_SOURCE_PATHS` — the fallback `spec/game-source.md` sets for the darknet |

## Open

- Which industry pair maximises valuation per real second when
  `CorporationValuation < 1`? Agriculture → Tobacco is chosen in `stages.ts` on
  qualitative grounds, with no measured comparison.
- What is the optimal `dividendRate`, when dividends both pay the player and,
  while public, suppress valuation growth by `1 - dividendRate`?
- Should the driver ever `goPublic`? Nothing calls it; the trade of permanent
  `issueNewShares` access against the public valuation formula is unevaluated.
- Is bribery at $1e9/rep better than spending the same funds on upgrades that
  raise valuation and therefore dividends?
