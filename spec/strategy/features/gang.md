# `gang` — territory and respect

A gang is up to twelve members, each on one of 23 assignable tasks, run by the
engine loop rather than by the player. Tasks pay money and **respect**; respect
buys recruits and converts to the gang faction's reputation. Every task also
raises a single gang-wide **wanted level** that divides everyone's output.

> "Assign each member to a task and schedule ascensions and equipment so
> respect, money and territory grow without the wanted-level penalty eating the
> gains."

**Theme** BN2 Rise of the Underworld (`shared/features/registry.ts:105-114`) ·
**Status** done (`spec/progress.md:33`)

`src/Gang/` and `src/Faction/FactionHelpers.tsx` are outside the vendor extract
(`tools/vendor.ts:40,72` hash-pins them), so bare `src/…` paths are the pinned
`v3.0.1` tag `3162fd2` — source 3 in `spec/strategy/README.md`.

## Unlock

| Step | Rule |
|---|---|
| gate | `gang.inGang()` **0 GB** (`src/Netscript/RamCostGenerator.ts:273`) is the whole test (`game/lib/probes/gates.ts:25,105`, `shared/features/unlock.ts:129`); free but not uniquely so (`go.getGameState` `:307`, `corporation.hasCorporation` `:467`) |
| API RAM | `GangApiBase` 4 GB (`:59`); the rest 1, 2 or 4 GB off it, `getTaskNames`/`getEquipmentNames`/`getBonusTime` free (`:271-298`) |
| access | `canAccessGang()` returns `true` **unconditionally when `bitNodeN === 2`**, else needs active SF2 **and** `karma <= -54000` (`src/PersonObjects/Player/PlayerObjectGangMethods.ts:12-30`, `src/Gang/data/Constants.ts:27`). `disableGang` refuses before either check (`:13-15`) and vetoes the feature outright in our code, unlike the options that merely degrade (`shared/features/unlock.ts:156-165`) |
| create | needs no existing gang plus membership in one of the seven (`src/Gang/helpers.ts:6-26`). `isHacking` is set only for NiteSec and The Black Hand (`src/NetscriptFunctions/Gang.ts:49`); founding **zeroes your reputation with that faction** and cancels faction work for it (`PlayerObjectGangMethods.ts:57-67`) |

## Rules

### The seven factions

| Faction | Karma | Other invite requirements | Base augs | Type |
|---|---|---|---|---|
| The Syndicate | −90 | Aevum or Sector-12 · $10m · hacking and all combat 200 · not CIA/NSA | 18 | combat |
| The Dark Army | −45 | Chongqing · hacking and all combat 300 · 5 kills · not CIA/NSA | 15 | combat |
| Speakers for the Dead | −45 | hacking 100 · all combat 300 · 30 kills · not CIA/NSA | 13 | combat |
| **NiteSec** | **none** | backdoor `avmnite-02h` | 11 | **hacking** |
| **The Black Hand** | **none** | backdoor `I.I.I.I` | 11 | **hacking** |
| Slum Snakes | −9 | all combat 30 · $1m | 8 | combat |
| Tetrads | −18 | Chongqing, New Tokyo or Ishima · all combat 75 | 7 | combat |

`src/Gang/data/Constants.ts:18-26` · `sim/vendor/bitburner/src/Faction/FactionTable.ts`
· `Augmentation/AugmentationTable.ts`. All start at power 1, territory 1/7
(`AllGangs.ts:11-42`); each `PowerMultiplier` applies only while that gang is an
NPC rival (`data/power.ts:2-10`, `Gang.ts:186-207`). **Base augs** is the faction's
own list, from each augmentation's `factions` field (`src/Faction/Factions.ts:16-21`),
includes NeuroFlux Governor, and is replaced wholesale by the pool rule below.

### Tasks and the wanted penalty

`src/Gang/data/tasks.ts` defines 24 tasks; excluding `Unassigned` leaves 9
hacking-only, 9 combat-only and 5 shared, so `getAllTaskNames()` gives either gang
type exactly 14 (`src/Gang/Gang.ts:419-427`). Peak `baseMoney` is 360 and peak
`baseRespect` 0.01 in both pools; **Ethical Hacking** (`baseWanted -0.001`,
`baseMoney 3`) is hacking-only, and the only shared reducer is Vigilante Justice
at zero money. `src/Gang/formulas/formulas.ts:11-73`:

```
statWeight   = Σ (task.<stat>Weight / 100) * member.<stat>
penalty      = respect / (respect + wantedLevel)
terrMult     = max(0.005, (territory*100) ^ task.territory.<field> / 100)
territoryPen = (0.2 * territory + 0.8) * GangSoftcap
respect = (11 * baseRespect * (statWeight - 4.0*difficulty) * terrMult * penalty) ^ territoryPen
money   = ( 5 * baseMoney   * (statWeight - 3.2*difficulty) * terrMult * penalty) ^ territoryPen
wanted  = min(100, 7 * baseWanted / (3 * (statWeight - 3.5*difficulty) * terrMult) ^ 0.8)
```

`territoryPen` exponentiates respect and money. Negative `baseWanted` takes the
linear branch `0.4 * baseWanted * statWeight * terrMult` (`:46-48`), and total
wanted is then scaled by `1 - 0.001 * justice`, `justice` being the count of
members on a task with negative `baseWanted` (`Gang.ts:130-136,161`).

### Members, equipment, territory

| Mechanic | Rule |
|---|---|
| recruit | 3 free; with `m` recruited the next needs `5^(m-2)` respect and `m >= 12` returns `Infinity`, so the dearest is the 12th at `5^9` = 1 953 125 (`Gang.ts:305-323`, `Constants.ts:6-11`) |
| ascension | banks `max(exp - 1000, 0)` points paying `max((points/2000)^0.5, 1)` (`formulas.ts:75-81`); clears exp, drops every non-augmentation upgrade owned, keeps the augmentations, deducts that member's `earnedRespect` from the gang (`GangMember.ts:298-340`, `Gang.ts:390-404`) |
| equipment | 32 pieces — 8 weapons, 4 armour, 4 vehicles, 5 rootkits, 11 augmentations (`data/upgrades.ts`) — cost ÷ `max(1, respect^0.01 + respect/5e6 + power^0.01 + power/1e6 - 1)` (`Gang.ts:407-416`) |
| tick | territory and power update every 100 cycles = 20 s (`Constants.ts:12`; MilliPerCycle 200, `sim/vendor/bitburner/src/Constants.ts:20`) |
| power | only Territory Warfare members add `0.015 * max(0.002, territory) * Σ member power`, member power being the six skills over 95 (`Gang.ts:362-369`) |
| clashes | win chance `ownPower / (ownPower + otherPower)` (`AllGangs.ts:73-77`); engaging sets clash chance to 1, disengaging decays it 0.01 per update (`Gang.ts:210-216`) |
| deaths | rolled in 35% of clashes, base 0.01 (halved on a win) over `def^0.6`, **only** for Territory Warfare members; one costs 5% of total respect plus that member's earned respect (`Gang.ts:281-303,371-388`) |

### Reputation and the augmentation pool

| Rule | Fact |
|---|---|
| rep from respect | `mults.faction_rep * respectGain * (1 + favor/100) / 75` (`Gang.ts:152-155`, `GangRespectToReputationRatio` `Constants.ts:10`) |
| unnerfed | it does **not** pass through `FactionWorkRepGain` or `FactionPassiveRepGain`, which apply only to work, donations and the passive tick (`src/PersonObjects/formulas/reputation.ts:13`, `src/Faction/FactionHelpers.tsx:134,168`), so BN2's 0.5 and 0 leave it untouched |
| pool | holding a gang rebuilds that faction's catalogue from **every augmentation in the game** (`FactionHelpers.tsx:172-204`). From `AugmentationTable.ts`: 137 total, minus 39 `isSpecial`, minus `violet Congruity Implant` (`src/Augmentation/Enums.ts:93`) = **97** |
| filter | **56** of the 97 list more than one faction and are always kept; the 41 single-faction ones are kept only if they are the gang faction's own (1–4 each) or a deterministic RNG seeded `BN{n}.{sfLvl}` clears `1 - GangUniqueAugs` (`:185,197`). So the pool runs from **57–60** at `GangUniqueAugs 0` to all **97** at 1, against a largest-elsewhere faction list of 18 |
| BN2 | `GangUniqueAugs` is 1, so all 97 **plus The Red Pill, pushed in only when `bitNodeN === 2`** (`:180-183`) — 98 offered. TRP costs $0 and 2 500 000 reputation, which at `faction_rep` 1 and favor 0 is 1.875e8 respect by the ratio above (`shared/strategy/progression/endgame.ts:33`) |
| NFG | because `isSpecial` is filtered, **NeuroFlux Governor cannot be bought from the gang faction** despite being on all seven base lists (`:68-73` rejects it) |

## Needs · Gives · Contends

| Edge | Detail |
|---|---|
| **Needs** `karma` | −54 000 outside BN2 (`shared/strategy/progression/endgame.ts:41,443`) — 600× the deepest faction karma gate, which is −90 (`FactionTable.ts`, all gates: −1, −9, −18, −22, −45, −90) |
| **Gives** money · `factionRep` · augmentations | `moneySources: ["gang","gang_expenses"]` (`Gang.ts:168`); rep = respect/75 before `faction_rep` and favor; the largest aug pool of any faction (57–97 against a maximum of 18 elsewhere) |
| **Contends** money | equipment and ascension recovery, against every other buyer (`shared/strategy/arbiter.ts`) |
| **Does not contend** the work slot | `Player.gang.process()` runs from the engine loop unconditionally, online and offline (`src/engine.tsx:106,326`), so the gang produces while `Player.currentWork` does something else. Founding costs one slot-cancel: `startGang` ends faction work for that same faction (`PlayerObjectGangMethods.ts:57-59`). |

## Challenges

- The wanted penalty is one gang-wide number every member feeds and that
  multiplies everyone's output, so per-member argmax optimises the wrong function;
  `shared/strategy/gang/decide.ts:107-131` scores the penalised total.
- Nothing prices a task a member is *not* doing — `getMemberInformation` reports
  only the current task's rates (`game/lib/probes/priced.ts:1035-1044`), leaving
  one matrix column per member. `ns.formulas.gang.*`
  (`types/NetscriptDefinitions.d.ts:6444-6460`) prices any triple but throws
  without Formulas.exe (`src/NetscriptFunctions/Formulas.ts:61-63,368-392`), $5e9
  at `src/DarkWeb/DarkWebItems.ts:20`.
- `ASCEND_THRESHOLD = 1.15` (`decide.ts:74`) and `CLASH_CONFIDENCE = 0.6` (`:80`)
  are policy, not upstream formulas: ascending spends respect needed for recruits
  and TRP, and warfare is the only way to lose a member.
- Our route gates `createGang` on `karma <= -54000` (`remaining.ts:3352`) although
  `gangAvailable` is set only for `bitNode === 2` (`:2559`), the one node where
  karma is ignored; the driver (`:219-320`) never buys equipment either, so
  `gang_expenses` stays unused.

## Rewards

Money, gang-faction reputation, territory, the augmentation pool above. An
augmentation **install** keeps the gang: the faction is re-joined, ascension points
are multiplied by `InstallAscensionPenalty` 0.95 (`src/Prestige.ts:133-146`,
`Constants.ts:16`), and members, equipment, respect, wanted level and territory
survive. A **BitNode reset** destroys it — `prestigeSourceFile()` nulls
`Player.gang` and returns all seven gangs to power 1, territory 1/7 (`src/PersonObjects/Player/PlayerObjectGeneralMethods.ts:143,157-158`).

## BitNode modifiers

| Field | Nodes |
|---|---|
| `GangSoftcap` | BN3 0.9 · BN6 0.7 · BN7 0.7 · **BN8 0** · BN9 0.8 · BN10 0.9 · BN12 0.8 · BN13 **0.3** · BN14 0.7 |
| `GangUniqueAugs` | BN3 0.5 · BN4 0.5 · BN5 0.5 · BN6 0.2 · BN7 0.2 · **BN8 0** · BN9 0.25 · BN10 0.25 · BN11 0.75 · BN12 `1/1.02^lvl` · BN13 0.1 · BN14 0.4 · BN15 0.3 |

`sim/vendor/bitburner/src/BitNode/BitNodeMults.ts`. Both default to 1, so
[BN2](../bitnodes/bn02.md) applies neither: full territory scaling, the whole 98-aug
pool. [BN8](../bitnodes/bn08.md) sets both to 0, driving respect and money to
`x^0 = 1` per cycle and stripping every single-faction aug that is not the gang
faction's own; [BN13](../bitnodes/bn13.md)'s 0.3 is the harshest non-zero softcap.

## Source map

| Concern | File |
|---|---|
| strategy · route | `shared/strategy/gang/decide.ts` · `shared/strategy/progression/endgame.ts:33,41,425-450` |
| driver · unlock | `game/lib/features/remaining.ts:219-320` (module `:3612`) · `game/lib/probes/gates.ts:25,105` · `shared/features/unlock.ts:129,165` |
| probes | `game/lib/probes/priced.ts` — `gang.core` (`:987`), `gang.detail` (`:1078`) |
| topic · tab | `shared/telemetry/topics/gang.ts` · `ui/app/tabs/gang.ts` |
| upstream rules | `src/Gang/` at `3162fd2` (not vendored) |

## Open

- `GangConstants.AscensionMultiplierRatio` (0.15, `Constants.ts:14`) is referenced
  nowhere in the 3.0.1 source, and `ascend()` resets every `*_mult` to 1 before
  reapplying augmentations. Dead, or consumed outside `src/`?
- No `sim/` gang model exists. `Gang.ts` draws randomness in six places (NPC power
  walk `:191-204`, territory gain `:176`, opponent pick `:225`, clash roll
  `:233,236`, death rolls `:289,299`) — which need sampling, not expectation?
