# `factions` — reputation and augmentations

Factions invite the player on flat requirement lists and sell augmentations for reputation plus money. Reputation
converts to permanent favor at every install; grafting, which buys an augmentation with money and time and needs no
reputation, lives here too.

> "Reach a target augmentation set in the least wall-clock, trading faction work against donations against grafting."
> (`shared/features/registry.ts:70`)

**Theme** BN4 The Singularity (`registry.ts:66`) · **Status** done, with a simulator model (`spec/progress.md:29`)

## Unlock

BN4 or SF4 (`shared/features/unlock.ts:127`). Every Singularity function needs SF4 outside BN4, and outside BN4 its
RAM cost is multiplied by 16/4/1 by SF4 level (`types/NetscriptDefinitions.d.ts:1910`) — `workForFaction` is 3 GB base
and `purchaseAugmentation` 5 GB, so 48–80 GB per call at SF4.1. Installing is itself a Singularity call, so without
SF4 factions are joinable by hand but the reset loop cannot be automated. None of the seven `BitNodeBooleanOptions`
fields touch factions (`NetscriptDefinitions.d.ts:1897`). Grafting is a **separate** gate: `ns.grafting` needs BN10 or
SF10 (`NetscriptDefinitions.d.ts:6020`) and **throws** rather than returning empty, so its probe step is split out
(`game/lib/probes/dodged.ts:455`).

## Rules

**Invite requirements** are a flat `PlayerRequirement[]` — exactly what `ns.singularity.getFactionInviteRequirements`
returns, so one interpreter reads live and vendored data (`sim/vendor/bitburner/src/Faction/FactionTable.ts`,
`shared/strategy/factions/requirements.ts`). All 34 factions; the top-level list is an implicit AND
(`requirements.ts:555`) unless nested in `someCondition`.

| Requirement | Thresholds |
|---|---|
| `backdoorInstalled` | CyberSec `CSEC` · NiteSec `avmnite-02h` · The Black Hand `I.I.I.I` · BitRunners `run4theh111z` · Fulcrum Secret Technologies `fulcrumassets` |
| `karma` (at most) | Slum Snakes −9 · Tetrads −18 · Silhouette −22 · Speakers for the Dead −45 · The Dark Army −45 · The Syndicate −90 |
| `numPeopleKilled`, `numInfiltrations` | The Dark Army 5 kills · Speakers for the Dead 30 kills · Shadows of Anarchy 1 infiltration |
| `skills` combat (all four equal) | Slum Snakes 30 · Tetrads 75 · Syndicate 200 · Dark Army 300 · Speakers 300 · Covenant 850 · Illuminati 1200 · Daedalus 1500 |
| `skills.hacking` | Tian Di Hui 50 · Netburners 80 · Speakers 100 · Syndicate 200 · Dark Army 300 · Covenant 850 · Illuminati 1500 · Daedalus 2500 |
| `employedBy` + `companyReputation`, `jobTitle` | Ten megacorp factions: employed there **and** 400 000 company rep (`CorpFactionRepRequirement`, `Constants.ts:26`); Fulcrum's company is `Fulcrum Technologies` and also needs the backdoor. Silhouette: CTO, CFO **or** CEO |
| `not employedBy` | Speakers, Dark Army and Syndicate each require **not** working for the CIA **and** not for the NSA |
| `city` | Six city factions require being in that city · Tetrads / Tian Di Hui: Chongqing, New Tokyo or Ishima · The Dark Army: **Chongqing only** · The Syndicate: Aevum or Sector-12 |
| `money` | Slum Snakes and Tian Di Hui $1m · Syndicate $10m · Silhouette and Sector-12 $15m · Chongqing and New Tokyo $20m · Ishima $30m · Aevum $40m · Volhaven $50m · Covenant $75b · Daedalus $100b · Illuminati $150b |
| `hacknetRAM`/`Cores`/`Levels`, `bladeburnerRank` | Netburners 8 / 4 / 100 · Bladeburners rank 25, plus BN6/SF6 or BN7/SF7 |
| `numAugmentations` | Covenant 20 · Illuminati 30 · Daedalus 30 (`DaedalusAugsRequirement`) · Church of the Machine God **exactly 0**, plus BN13/SF13 and the location |

Daedalus's is the one OR: hacking 2500 **or** all four combat at 1500. City factions carry mutual `enemies` bans, so
joining one forecloses others for the cycle (`packages.ts:55`).

**Reputation, favor, donations** (`Faction/formulas/favor.ts`, `.../Donation.ts`; transcribed in
`shared/strategy/factions/rep.ts`):

```
favorToRep(f) = 25000 * expm1(0.019802627296179712 * f)
repToFavor(r) = log1p(r / 25000) / 0.019802627296179712      // capped at 35331
addRepToFavor(favor, rep) = repToFavor(favorToRep(favor) + rep)
repFromDonation(amt, p) = (amt / 1e6) * p.mults.faction_rep * FactionWorkRepGain
favorNeededToDonate()   = floor(150 * FavorToDonateToFaction)
```

Favor multiplies every work type's rate by `1 + favor/100` (`rep.ts:82`) and gates donations at 150 base favor
(`Constants.ts:32`), where $1m buys one base reputation (`Constants.ts:34`). Donation reputation carries no favor term
(`Donation.ts:7`), so favor only gates eligibility.

**Pricing** — 137 augmentations (`Augmentation/AugmentationTable.ts`), priced by `augs.ts:158`; SF11 discount `[1,
0.96, 0.94, 0.93]` by level (`augs.ts:38`):

```
generic      = (1.9 * SF11discount) ^ queuedNonSoA   // MultipleAugMultiplier, Constants.ts:42
ordinary aug = baseCost * generic * AugmentationMoneyCost ; rep = baseRep * AugmentationRepCost
NeuroFlux    = baseCost * 1.14^level * AugmentationMoneyCost * generic ; rep also * 1.14^level
SoA aug      = baseCost * 7^ownedSoA ; rep = baseRep * 1.3^ownedSoA ; NOT in queuedNonSoA
```

**Choose by value, buy in `orderPurchases` order.** Reputation cost carries no `generic` term, so only money scales
with the queue, and an augmentation's multipliers apply only once installed. The dearest item therefore belongs in the
cheapest slot: sets are chosen on value and ordered most-expensive-first subject to prerequisites, and every cost
estimate is taken from that ordered sequence rather than from today's queue depth. `orderPurchases` is pinned against
the exhaustive optimum over all permutations, and against the constrained optimum when prerequisites force order
(`tests/factions.test.ts:378`); the frontier itself estimates with greedy `estimatedCost` (`packages.ts:138`).

**The budget is `settlingMoney`** — cash plus pending market proceeds, counted only while a liquidation is actually
under way (`state.ts:175`). A money shortfall on the dearest item makes the walk **wait**, because falling through to
a cheaper one is permanent: the skipped item costs 1.9x more forever. Reputation shortfalls and money with no
settlement date fall through instead, and the run's **first** purchase is never held, because the book is only
liquidated once the install queue is non-empty (`decide.ts:1159`).

**Grafting** costs `baseCost * 3` (`Constants.ts:97`) and can only start in New Tokyo (`sim/features/grafting.ts:48`);
money is taken at start and never refunded, and cancelling loses all progress (`grafting.ts:9`). Completing one graft
adds one entropy stack, unless the violet Congruity Implant is owned — grafting that implant sets entropy to 0
(`grafting.ts:82-86`). `EntropyEffect` is 0.98, "raised to the number of entropy stacks, then multiplied to player
multipliers" (`Constants.ts:104-105`), so the *n*-th graft costs `1 - 0.98^n` of the multipliers it touches — global,
not a faction-local cost.

## Needs · Gives · Contends

**Needs** every `NeedKind` the invite table produces, each routed to an owning feature by `requirements.ts:144`:
`hacking` for backdoors, hacking skill and money; `career` for karma, kills, combat skills, charisma, company rep, job
titles, quitting and travel; `hacknet`, `bladeburner` and `side` for the rest. Edges are in [`graph.md`](../graph.md).

**Gives** augmentations and favor, and publishes `liquidationNeeded` on its telemetry topic plus an install-check
signal (`decide.ts:348`, `game/lib/features/factions.ts:977`). **Contends** money (`factions:aug-fund` 90,
`factions:donate` 70) and the single work slot (`factions:work` 60, `factions:route-work` 91, `factions:install-work`
121 — `shared/strategy/arbiter.ts:265`).

## Challenges

- `ns.singularity.workForFaction` **cancels** whatever working action is in progress
  (`NetscriptDefinitions.d.ts:2385`), and a cancelled graft loses all its progress (`grafting.ts:9`). So the arbiter
  needs pre-emption rules, not fairness rules — `PREEMPT_MARGIN` 10 for hard bands, `SLOT_HYSTERESIS` 0.05 for priced
  ones (`arbiter.ts:244`, `:255`).
- Reputation is continuous but decisions are not, so planning runs over `(faction, breakpoint, package)` triples with
  at most `MAX_FAVOR_BREAKPOINTS` 8 favor samples (`packages.ts:49`).
- `not(A and B)` must be pushed down to `(not A) or (not B)`, and an empty blocker array is truthy in JS: getting that
  wrong evaluates every negated leaf positively (`requirements.ts:194-197`).

## Rewards

At install, every faction's `favor` becomes `addRepToFavor(favor, rep)` and its reputation, membership and ban all
reset; `keepOnInstall` factions keep an **invitation**, not membership (`sim/features/factions.ts:300-315`). The same
reset zeroes kills, jobs, city and money and returns skills to 1 (`sim/world.ts:340`). Owned augmentations, their
multipliers, favor and karma persist, and the augmentation count is the Daedalus gate ([`endgame.md`](../endgame.md)).

## BitNode modifiers

Values from `shared/features/bitnode.ts`; BN12 is `inc = 1.02^level`, `dec = 1/inc` (`:306`).

| Field | Nodes |
|---|---|
| `FactionWorkRepGain` | BN2 0.5 · [BN4](../bitnodes/bn04.md) 0.75 · BN12 `dec` · BN13 0.6 · BN14 0.2 |
| `FactionPassiveRepGain` | BN2 **0** · BN12 `dec` |
| `FavorToDonateToFaction` | BN3 0.5 (donate at 75) · [BN8](../bitnodes/bn08.md) **0** (donate from 0 favor) · BN12 `inc` |
| `AugmentationMoneyCost` | BN3 3 · BN5 2 · BN7 3 · BN10 5 · BN11 2 · BN12 `inc` · BN14 1.5 · BN15 3 |
| `AugmentationRepCost` | BN3 3 · BN10 2 · BN12 `inc` |
| `DaedalusAugsRequirement` | BN6 35 · BN7 35 · BN12 `floor(min(30 + inc, 40))` · [BN15](../bitnodes/bn15.md) **20** |

An IPvGO win against a joined faction grants `maxRep / 200` reputation, converted through `addRepToFavor`
(`shared/strategy/go/rewards.ts:405-411`) — the substitute for [BN14](../bitnodes/bn14.md)'s 0.2 rep rate. Holding
SF11 makes company favor multiply salary by `1 + favor/100` as well as reputation gain
(`sim/features/companies.ts:131`), feeding the megacorp invites.

## Source map

| Concern | File |
|---|---|
| requirement interpreter | `shared/strategy/factions/requirements.ts` |
| rep / favor / donation math | `shared/strategy/factions/rep.ts` |
| valuation, pricing, ordering | `shared/strategy/factions/augs.ts` |
| package frontier · decision | `shared/strategy/factions/packages.ts` · `decide.ts` |
| static augmentation table | `shared/features/augmentations.ts` |
| driver · probes | `game/lib/features/factions.ts` · `game/lib/probes/dodged.ts`, `local.ts` |
| telemetry topic · tab | `shared/telemetry/topics/factions.ts` · `ui/app/tabs/factions.ts` |
| sim model | `sim/features/factions.ts`, `requirements.ts`, `grafting.ts` |
| vendored rules | `sim/vendor/bitburner/src/Faction/`, `Augmentation/AugmentationTable.ts`, `Constants.ts` |

## Open

- Which multiplier fields does entropy actually touch? `augs.ts:266` names 27, attributed to upstream
  `calculateEntropy`; `sim/world.ts:591-592` applies the nerf to **every** field in the multiplier object. Neither
  `calculateEntropy` nor `Player.applyEntropy` is in the vendored extract, so the two cannot be reconciled here.
- Where does upstream v3.0.1 apply the SF11 augmentation-price discount? It is not in the vendored extract; `[1, 0.96,
  0.94, 0.93]` is pinned only by `sim/ns/singularity.ts:230`.
- Shadows of Anarchy needs one infiltration. Is the resulting invitation observable well enough to plan toward, or
  does it stay a reported manual-only blocker (`requirements.ts:39-41`)?
