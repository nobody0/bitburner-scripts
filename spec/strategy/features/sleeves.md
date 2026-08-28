# `sleeves` — parallelism

Sleeves are cloned bodies that run tasks concurrently with the player. Each is its own `Person`
with its own skills, augmentations and multipliers, plus two stats. Shock throttles experience
and faction reputation but not money; sync scales experience shared to the player and other
sleeves, plus sleeve-crime karma, but not money, reputation or kills. They are the one feature
that *supplies* the resource all the others fight over.

> "Assign N sleeves across recovery, synchronisation, crime and faction work,
> accounting for source-accurate shock, sync and target exclusivity."
> (`shared/features/registry.ts:141`)

**Theme** BN10 Digital Carbon (`shared/features/registry.ts:138`) · **Status** done, no
simulator model (`spec/progress.md:36`, `sim/fidelity.ts:43`)

**Sourcing.** Bare `src/…` paths are the pinned `v3.0.1` tag — source 3 in
[`README`](../README.md) — because the vendor extract carries no sleeve source at all.
`tools/vendor.ts` hash-pins the Sleeve API and work implementations used by this model without
emitting them; `sim/transcription-sources.ts` records the accepted v3.0.1 hashes.

## Unlock

BN10 or SF10: "If you are not in BitNode-10, then you must have Source-File 10 in order to use
this API" (`types/NetscriptDefinitions.d.ts:5720`; `shared/features/unlock.ts:135`). SF10 grants
**no multipliers** — `sim/vendor/…/applySourceFile.ts:148-152` reads "No effects, just grants
sleeves". Every method is documented "RAM cost: 4 GB", reads included (`:5723-6014`;
`sim/ns/ram-costs.ts:439`).

Two gates disagree: the **count** reads `sourceFileLvl(10)`
(`SleeveCovenantPurchases.tsx:62-63`, deliberately, per `:59-61`), the **API** reads
`activeSourceFileLvl(10)` (`NetscriptFunctions/Sleeve.ts:51-58` → `BitNodeUtils.ts:18`), so
`sourceFileOverrides` setting SF10 to 0 outside BN10 removes the API while the sleeves remain.
`BitNodeBooleanOptions.disableSleeveExpAndAugmentation` zeroes every sleeve exp field
(`Work/Formulas.ts:26-35`) and blocks aug purchases (`Sleeve.ts:349-354`) but leaves money,
rep, karma and kills — a `restrictions` flag, never a "no" (`shared/features/unlock.ts:156-159`).

## Rules

**Count** (`SleeveCovenantPurchases.tsx:62-63`):

```
Math.min(3, Player.sourceFileLvl(10) + (Player.bitNodeN === 10 ? 1 : 0)) + Player.sleevesFromCovenant
```

`MaxSleevesFromCovenant = 5` (`:13`), so the ceiling is **8**. The SF term caps at 3, so BN10's
`+1` changes the count only below SF10.3; a first entry at SF10.0 gives **one** sleeve.
`getSleeveCost` is `Math.pow(10, sleevesFromCovenant) * BaseCostPerSleeve` with
`BaseCostPerSleeve = 10e12` (`:14,26`) — $10t, $100t, $1q, $10q, $100q, ~$111q for all five.
Buying needs BN10 *and* Covenant membership (`:30-47`); memory upgrades need both (`:87-98`),
capped at memory 100 (`:99`). **Neither is possible outside BN10.**

**Shock and sync.** Per the ns surface, shock is 0-100 and "Experience earned and shared is
multiplied with shock% before sync%"; sync is 1-100; memory is the "initial Value of sync on BN
start" (`types/NetscriptDefinitions.d.ts:74-78`). In code `shockBonus() = (100 - shock) / 100`,
`syncBonus() = sync / 100` (`Sleeve.ts:173-179`). Each task scales its `WorkStats` by `shockBonus()`
with `scaleMoney = false` (`WorkStats.ts:49-50`), so shock throttles exp **and reputation**
(`SleeveFactionWork.ts:36`) but **not money**. `applySleeveGains` (`Work/Work.ts:17-25`) splits it:
the working sleeve takes the shocked exp, the player the money (`:19`) and `exp × sync` (`:22`),
every other sleeve its own `exp × sync × shockBonus()` (`:24`).

Rates per 200 ms cycle (`sim/vendor/…/Constants.ts:20`), at intelligence 0 where `intBonus` is 1 (`sim/vendor/…/intelligence.ts:3`):

| Stat | Per cycle | Int used | At intelligence 0 |
|---|---|---|---|
| Shock, any task | `-0.0001 × intBonus(int, 0.75)` (`Sleeve.ts:269-272`) | sleeve's | 100 → 0 in ~55.6 h |
| Shock, on Recovery | that, plus `-0.0002 × intBonus(int, 0.75)` (`SleeveRecoveryWork.ts:13-16`) | sleeve's | 100 → 0 in ~18.5 h |
| Sync, on Synchronize | `+0.0002 × intBonus(int, 0.5)` (`SleeveSynchroWork.ts:14-17`) | **player's** | 1 → 100 in ~27.5 h |

`process` returns early when `currentWork` is null (`Sleeve.ts:267`) and `setToIdle` calls
`stopWork` (`NetscriptFunctions/Sleeve.ts:73-78`), so an **idle sleeve does not recover**;
`travel` also cancels the task (`Sleeve.ts:542-548`). Shock rises only from Bladeburner damage:
`takeDamage` (+0.5, `Sleeve.ts:559-573`) is called from `Bladeburner.ts:987,1065`, `kill()` from
`:790`; no crime path touches it.

**One per target.** Each setter loops `Player.sleeves`, skips itself, and **throws**: no two sleeves
at the same **company** (`NetscriptFunctions/Sleeve.ts:125-137`, matched on `currentWork.companyName`
at `:131`), the same **faction** (`:152-164`, matched at `:158`), or on the **same Bladeburner
contract** (`:283-294`, matched on `actionId.name` at `:288`, and only inside the `TakeOnContracts`
branch at `:281` — different contracts and all General actions are unrestricted). A sleeve may never
work your **gang's** faction (`:166-171`, plus a runtime stop at `SleeveFactionWork.ts:46`). The
**player appears in no loop**, so player and sleeve may share a company or faction. Sleeves widen the
board across *different* targets and never stack on one: three on the best faction throws.

**Company work needs the player's job.** `workForCompany` returns false unless
`Player.jobs[companyName]` is set (`Sleeve.ts:411-412`), and `SleeveCompanyWork.process` stops
the sleeve the moment that job goes away (`:43`). `Player.jobs` is a record, so the pattern is
**the player collects jobs, the sleeves grind their reputations** — one sleeve per employer; it
also moves the stock price (`SleeveCompanyWork.ts:47`).

**Augmentations.** A standard sleeve aug must not be `isSpecial`, must come from a joined faction
(Bladeburners and Netburners excluded; a gang faction offers all its own), must clear
`getAugCost(aug).repCost`, and must move one of 17 multipliers — six skills, six exps,
`company_rep`, `faction_rep`, `crime_money`, `crime_success`, `work_money` (`Sleeve.ts:100-171`).
The explicit exception is **Z.O.Ë.**: membership in the Church of the Machine God adds it after
the ordinary special/multiplier filter (`Sleeve.ts:165-168`).
Purchase requires **shock exactly 0** (`:356-361`) and costs `aug.baseCost` (`:372,397`), the raw
table price: it escapes both `AugmentationMoneyCost` and the queued-aug escalation
`MultipleAugMultiplier` 1.9, SF11-discounted, that player augs pay
(`AugmentationHelpers.ts:29-36,156-158`; `sim/vendor/…/Constants.ts:42`). Installing one **zeroes
that sleeve's exp** (`:215-225`). Grafting needs SF10 too but belongs to [`factions`](factions.md).

## Implemented controller surface

| Edge | Detail |
|---|---|
| **Consumes** | no arbiter money or player-work claim; the current driver does not buy sleeves, memory or augmentations |
| **Assigns** | recovery, synchronization, crime and faction work through the Netscript proxy |
| **Gives** | crime money/karma/kills/experience and faction reputation/experience in parallel with `Player.currentWork` |
| **Defers** | covenant purchases, memory, sleeve augmentations, company/class/Bladeburner/infiltration/support task planning |

## Challenges

- **Karma scales with sync, kills do not** (`SleeveCrimeWork.ts:46-47`): a sleeve at sync 1
  delivers 1% of a crime's karma and 100% of its kills.
- **Exclusivity is combinatorial.** Capacity-one faction, company and contract targets make this
  an assignment problem, not N argmaxes; `assignSleeves` solves it in
  `O(sleeves × tasks × 2^exclusiveKeys)` (`shared/strategy/sleeves/decide.ts:80-121`).
- **Our task menu is four wide.** `sleeveView` builds only recovery, synchro, crime and faction
  tasks. Company, class, Bladeburner, infiltration and support tasks are observed but never assigned;
  travel is an action that stops work, not a sleeve task.

## Rewards

Money, karma, kills, reputation and skill exp; memory and `sleevesFromCovenant` are permanent.

| Reset | Sleeve state |
|---|---|
| Augmentation install | `prestigeAugmentation` touches sleeves only to re-task them — Synchronize if shock ≤ 0, else Recovery (`PlayerObjectGeneralMethods.ts:120`); it does not reset augs, exp, shock or sync |
| BitNode reset | `sleeve.prestige()` clears augs and exp, resets shock to 100, sets `sync = max(memory, 1)` (`Sleeve.ts:228-256`, called at `PlayerObjectGeneralMethods.ts:148`) |
| Entering BN10 | `Player.bitNodeN = newBitNode` precedes `prestigeSourceFile` (`RedPill.tsx:66,78`), so the BN10 branch clamps every sleeve to shock ≤ 25 and sync ≥ 25 (`PlayerObjectGeneralMethods.ts:150-155`) |

## BitNode modifiers

Sleeves run the player's own `Work/Formulas`, so the work multipliers hit them identically.
Values from `sim/vendor/bitburner/src/BitNode/BitNodeMults.ts`:

| Field | Nodes |
|---|---|
| `CrimeMoney` | BN2 3 · BN3 0.25 · BN4 0.2 · BN5 0.5 · BN6 0.75 · BN7 0.75 · [BN8](../bitnodes/bn08.md) **0** · BN9 0.5 · BN10 0.5 · BN11 3 · BN13 0.4 · BN14 0.75 |
| `CompanyWorkMoney` | BN3 0.25 · BN4 0.1 · BN6 0.5 · BN7 0.5 · BN8 **0** · BN10 0.5 · BN11 0.5 · BN13 0.4 |
| `FactionWorkRepGain` · `CompanyWorkRepGain` | BN2 0.5 / — · BN4 0.75 / — · BN13 0.6 / — · BN14 0.2 / 0.2 |
| `CrimeExpGain`, `ClassGymExpGain` | BN4 0.5 · BN13 0.5 |
| `AugmentationRepCost` — the sleeve-aug rep gate, standard branch | BN3 3 · [BN10](../bitnodes/bn10.md) 2 |

## Source map

| Concern | File |
|---|---|
| strategy | `shared/strategy/sleeves/decide.ts`, `shared/strategy/assignment.ts` |
| driver, task menu | `game/lib/features/sleeves.ts` (`sleeveView`, `sleevesModule`) |
| probe, completion arming | `game/lib/probes/priced.ts` (`sleeves.core`), `game/lib/sleeve-completion.ts` |
| telemetry topic, tab | `shared/telemetry/topics/sleeves.ts`, `ui/app/tabs/sleeves.ts` |
| sim | none — `sim/fidelity.ts:43` says `unmodeled`; `sim/engine.ts:243` drains stored cycles (min 5, max 15) |
