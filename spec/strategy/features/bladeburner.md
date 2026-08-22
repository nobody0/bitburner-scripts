# `bladeburner` — the NSA division

Bladeburner is a second progression track with its own currency. Timed actions against a hidden Synthoid
population in one of six cities earn **rank**, which buys skill points, the Bladeburners faction, and the
ordered **black operations** whose completion ends the BitNode with no Red Pill and no hacking requirement.

> "Pick the action sequence that climbs rank fastest without dying, spending skill points and managing
> stamina and city chaos."

**Theme** BN6, BN7 Bladeburners (`shared/features/registry.ts:126-134`) · **Status** done
(`spec/progress.md:35`)

**Sourcing.** `tools/vendor.ts` extracts only `Bladeburner/data/Constants.ts` (`:400`) and pins
`Bladeburner.ts` as a hash-checked transcription source without extracting it (`:73`). Claims resting on the
unextracted files are cited to our own code or `types/NetscriptDefinitions.d.ts` where they appear there, else
to the pinned checkout's `src/`, marked **[src]** — the arrangement `spec/game-source.md` sets for the
darknet. An unqualified `:line` continues the previous file.

## Unlock

**BN6 or SF6 alone is sufficient for scripting; SF7 only adds multipliers.** Older notes claiming SF7 is
required for the API are wrong.

| Fact | Source |
|---|---|
| `bladeburner.inBladeburner()` costs **0 GB**, "Does not require API access" | `types/NetscriptDefinitions.d.ts:4017-4023` |
| API remark "be in BitNode 6/7 or have Source-File 6/7"; in code, `canAccessBitNodeFeature(7)` or `(6)` | `:3433-3434`; `NetscriptFunctions/Bladeburner.ts:35`, `PersonObjects/Player/PlayerObjectBladeburnerMethods.ts:6-8` **[src]** |
| Faction invite: `(BN6 or SF6) or (BN7 or SF7)`, plus `bladeburnerRank` 25 | `sim/vendor/bitburner/src/Faction/FactionTable.ts:1418-1459` |
| `joinBladeburnerDivision()` refuses without SF6/SF7, on the `disableBladeburner` option, at `BladeburnerRank === 0` (BN8), or with any of strength/defense/dexterity/agility below **100** | `NetscriptFunctions/Bladeburner.ts:332-361` **[src]**; `NetscriptDefinitions.d.ts:1901`; `sim/vendor/bitburner/src/BitNode/BitNodeMults.ts:228` |
| Our veto and enable path | `shared/features/unlock.ts:133,167` |
| Starting an action calls `Player.finishWork(true)`, and `process` cancels a running action whenever `Player.currentWork` exists — both unless **The Blade's Simulacrum** is installed | `Bladeburner/Bladeburner.ts:178-179,1356` **[src]** |
| Simulacrum is one of the 18 augmentations the Bladeburners sell — `isSpecial`, rep 1 250, $150b — and SF7.3 grants it free on joining | `sim/vendor/bitburner/src/Augmentation/AugmentationTable.ts:337-347`; `PlayerObjectBladeburnerMethods.ts:13-18` **[src]** |

## Rules

`Bladeburner/Actions/Action.ts:169-197` **[src]**:

```
competence = Σ weights[stat] * effectiveLevel(stat) ^ decays[stat]
           * intelligenceBonus(int, 0.75) * staminaPenalty * teamBonus
           * populationFactor * skillMults * bladeburner_success_chance
chance = min(1, competence / (difficulty * chaosFactor))
```

| Term | Value | Source |
|---|---|---|
| `populationFactor` | `(pop / 1e9) ^ 0.7`; `PopulationThreshold` 1e9, `PopulationExponent` 0.7 | `Action.ts:88-92`; `Constants.ts:30-31` |
| `chaosFactor` | `sqrt(1 + chaos - 50)` above `ChaosThreshold` 50, else 1 | `:94-102`; `Constants.ts:32` |
| `teamBonus` | `(teamCount + 1) ^ 0.05`, operations and black ops only; one per supporting sleeve | `Operation.ts:96-98`; `Bladeburner.ts:747` |
| action time | `difficulty / DifficultyToTimeFactor`, reduced by Overclock and a dexterity/agility factor, floored at 1 s | `Action.ts:105-121`; `Constants.ts:9,23-26` |
| reported chance | an **interval**: "value[0] - MIN Chance, value[1] - MAX Chance", because `popEst` differs from `pop` | `NetscriptDefinitions.d.ts:3576,3583-3587`; `Action.ts:144-167` |
| levelling | 3 contracts, 6 operations, 6 general actions, 21 black ops; contracts and operations run `difficulty *= 1.01^(level-1)`, `reward *= 1.02^(level-1)` over a finite `count` regrowing on the 480 s `ActionCountGrowthPeriod` | `LevelableAction.ts:19-20,58-64`; `Constants.ts:40` |
| stamina penalty | `min(1, stamina / (0.5 * maxStamina))` — below **half** max stamina every success chance scales down linearly | `Bladeburner.ts:167-169` |
| max stamina | `(agility^0.8 + staminaBonus)` × the Stamina skill mult × `bladeburner_max_stamina` | `:1329-1345` |
| regen | `(0.0085 + maxStamina/70000) * agility^0.17`, × those same multipliers | `:1319-1327`; `Constants.ts:5-7` |
| cost per action | `BaseStaminaLoss 0.285 * difficultyMultiplier` stamina, `hpLoss * difficultyMultiplier` HP, which can hospitalise | `:1021-1023,1061-1069` |
| city state | `pop`, `popEst`, `comms` (5–150 at init), `chaos`, per city, six cities | `Bladeburner/City.ts:18-27` |
| population loop | retiring Synthoids lowers `pop`, lowering `populationFactor` — the feature erodes its own success chance | `Bladeburner.ts:824-888` |
| Raid | decrements `comms`; returns chance **0** at `comms <= 0` | `Operation.ts:63-68` |
| chaos | contracts, operations and random riots raise it; Diplomacy and Stealth Retirement lower it; Incite Violence adds **+10 to every city** for action counts | `Bladeburner.ts:680-683,824-888,1220-1236` |
| rank gain | `rankGain * rewardFac^(level-1) * BladeburnerRank`, offset ±10% | `Bladeburner/Formulas.ts:9-28`; `Bladeburner.ts:1033`; `utils/helpers/addOffset.ts` **[src]** |
| skill points | off **maxRank**, one per `RanksPerSkillPoint` 3 | `Bladeburner.ts:1284-1293`; `Constants.ts:48` |
| skills | twelve, `baseCost` 1–3, `costInc` 1–3; a level applies `1 + baseMult * level / 100`, so Overclock — the only capped skill, `maxLvl` 90 with `ActionTime` −1 — reaches 0.10× action time at level 90 | `Bladeburner/data/Skills.ts:44-53`; `Bladeburner.ts:776-786` |

Skill cost, per `Bladeburner/Skill.ts:76-82` **[src]**:

```
cost = round(count * BladeburnerSkillCost
             * (baseCost + costInc * (currentLevel + (count-1)/2)))
```

### Black operations end the BitNode

There are **21**, not 20: `numberOfBlackOperations = Object.keys(BladeburnerBlackOpName).length`
(`Bladeburner/data/BlackOperations.ts:735` **[src]**) over a 21-member enum (`Bladeburner/Enums.ts:38-60`).
`shared/strategy/progression/endgame.ts:40` hardcodes `BLACK_OP_COUNT = 20`, so our route model calls the node
finished one operation early.

| Rule | Source |
|---|---|
| Sequential and one-shot, gated on `reqdRank` | `Bladeburner/Actions/BlackOperation.ts:44-48` **[src]** |
| **1.5× time penalty**; population and chaos ignored entirely | `:51-61` |
| With a team assigned, at least one member dies win or lose; at `teamCount` 0, no casualties | `:63-65`; `Actions/TeamCasualties.ts:29-62` |
| Last op is **Operation Daedalus: `n: 20`, `reqdRank: 400e3`, `baseDifficulty: 80e3`** — `n` is the prior ops required, so the 21st slot | `BlackOperations.ts:705-708` |
| Failure loses rank and HP, leaving `numBlackOpsComplete` untouched | `Bladeburner.ts:1053-1071` |
| In-UI "Destroy w0r1d_d43m0n" button calls `finishBitNode()` | `Bladeburner/ui/BlackOpPage.tsx:39-50` |
| `destroyW0r1dD43m0n` accepts `hackingRequirements()` or `bladeburnerRequirements()`, the latter reading only `numBlackOpsComplete >= numberOfBlackOperations` — no hacking level, no `WorldDaemonDifficulty`, no Red Pill, and **scriptable** | `NetscriptFunctions/Singularity.ts:1170-1186` |
| Route choice and ETA live in [`endgame.md`](../endgame.md) | `shared/strategy/progression/endgame.ts:514-541` |

### SF7.3 forces Stanek first

Joining with SF7.3 installs an augmentation. Accepting Stanek's Gift requires owning and queueing **no**
augmentation other than NeuroFlux Governor (`CotMG/Helper.tsx:59-74`, `Locations/ui/SpecialLocation.tsx:302-316`
**[src]**), and SF13's own text says so (`BitNode/BitNode.tsx:474`). That filter runs unconditionally after
`canAccessCotMG()`, so it has **no BN13 exemption** — a sequencing rule, not a capability gate:
[`stanek.md`](stanek.md).

## Needs · Gives · Contends

| Edge | What |
|---|---|
| Needs | `combatSkills` — 100 in all four to join, then unbounded for success chance (`shared/strategy/needs.ts:25`) |
| Needs | `bladeburnerRank` 400 000 when this is the endgame route (`needs.ts:38`) |
| Needs | The work slot, unless Simulacrum is installed |
| Gives | The Bladeburners faction at rank 25 and its 18 augmentations (`FactionTable.ts:1418-1459`; `AugmentationTable.ts`); rep at `RankToFactionRepFactor 2 × Δrank × faction_rep × (1 + favor/100)` (`Formulas.ts:43-46`; `Constants.ts:42`) |
| Gives | Combat and intelligence exp on the action's `weights` table (`Bladeburner.ts:706-733`); the node-destroy route |
| Gives | Money from **contracts only** — `ContractBaseMoneyGain 250e3 × rewardFac^(level-1) × MoneySkillMult`; operations, black ops and general actions pay none (`Bladeburner.ts:936-943`; `Constants.ts:50`) |
| Contends | The work slot, against `career`, `factions`, grafting and class/gym (`shared/strategy/arbiter.ts`) |

## Challenges

- **The chance is an interval and the optimistic end is a trap.** An op reading 60–100% may really be 60%.
  `shared/strategy/bladeburner/decide.ts` uses `chance[0]` and refuses black ops below `BLACKOP_CONFIDENCE` 0.95.
- **Stamina is a multiplier, not a bar.** Below 0.5 × max, acting is slower than resting, because the penalty
  scales every attempt.
- **The population loop is self-defeating**, and city selection and population estimation are unmodelled.
- **Skill allocation is a knapsack whose prices the node changes.** The driver buys the cheapest affordable
  level first (`decide.ts:113-124`) — a policy, not an optimum. At `BladeburnerSkillCost` 2 (BN7, BN13, BN14)
  or 3 (BN15) that order misallocates: `costInc` differs per skill (Cyber's Edge 1/+3 versus Hyperdrive
  1/+2.5) and the multiplier scales the whole curve.
- **No dedicated driver module or sim model** — the driver lives in `game/lib/features/remaining.ts:374-454`,
  so no rank-per-hour projection is testable offline.

## Rewards

| Reward | Survives install | Survives node reset |
|---|---|---|
| Rank, skill and action levels, combat exp | no | no |
| Bladeburners membership — `keepOnInstall: false` (`FactionTable.ts:1424`) | no | no |
| Faction favor earned from Bladeburner rep | yes | no |
| Installed Bladeburners augmentations, contract money | yes | no |
| Node completion → SF6/SF7 | — | yes |

## BitNode modifiers

| Field | Nodes |
|---|---|
| `BladeburnerRank` | BN7 0.6 · **BN8 0** (feature off) · BN9 0.9 · BN10 0.8 · BN12 `1/1.02^lvl` · BN13 0.45 · BN14 0.6 · BN15 0.2 |
| `BladeburnerSkillCost` | BN7 2 · BN9 1.2 · BN12 `1.02^lvl` · BN13 2 · BN14 2 · BN15 3 |
| **BN6 changes neither** | its `case 6` block carries no `Bladeburner*` entry, so both stay at the default 1 (`BitNodeMultipliers.ts:20,23`) |

`sim/vendor/bitburner/src/BitNode/BitNodeMults.ts:194,228,268,314,422,469,514,550`, BN12's `dec`/`inc` at
`:363-364`. Source-File effects are `1 + Σ(8 / 2^i) / 100` — **+8% / 12% / 14%**
(`sim/vendor/bitburner/src/SourceFile/applySourceFile.ts:94-122`): SF6 raises all four combat stat *levels and
exp gains*, SF7 raises `bladeburner_max_stamina`, `_stamina_gain`, `_analysis` and `_success_chance`. Nodes:
[BN6](../bitnodes/bn06.md), [BN7](../bitnodes/bn07.md), [BN8](../bitnodes/bn08.md), [BN15](../bitnodes/bn15.md).

## Source map

| Concern | File |
|---|---|
| strategy | `shared/strategy/bladeburner/decide.ts` |
| driver | `game/lib/features/remaining.ts:374` |
| probe | `game/lib/probes/dodged.ts:1327` |
| telemetry topic | `shared/telemetry/topics/bladeburner.ts` |
| tab | `ui/app/tabs/bladeburner.ts` |
| tests | `tests/features-remaining.test.ts` |
| vendored constants | `sim/vendor/bitburner/src/Bladeburner/data/Constants.ts` |

## Open

- What is the rank-per-second optimum across city, chaos and action level?
- Is cheapest-first skill order ever optimal, and what allocation is right at `BladeburnerSkillCost` 2 and 3?
- Does changing city to reset population and chaos beat Diplomacy in place?
- How many sleeves should support Bladeburner rather than earn elsewhere?
