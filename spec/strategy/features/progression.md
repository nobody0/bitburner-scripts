# `progression` — the reset loop

Two nested prestiges. **Installing** augmentations zeroes the run and applies the multipliers you bought;
**destroying** the BitNode zeroes what the install kept and grants a Source-File level. Every permanent
multiplier arrives through one of the two, so this feature sets the ceiling the others play under.

> Choose the BitNode destroy order and the augmentation/reset cadence that minimises total wall-clock to a
> target source-file set.

**Theme** BN12 The Recursion (`shared/features/registry.ts`) · **Status** done (`spec/progress.md` row 13).

**Sourcing.** `tools/vendor.ts` extracts none of `Prestige.ts`, `AugmentationHelpers.ts`, `FactionHelpers.tsx`,
`Singularity.ts`, `BlackOperations.ts`, `DarkNet/`. Claims resting on those are cited to our own code or to
`types/NetscriptDefinitions.d.ts` where they appear there, else to the pinned checkout's `src/`, marked **[src]**
— the arrangement `spec/game-source.md` sets for the darknet.

## Unlock

Always playable — `shared/features/unlock.ts:105` sets it `yes` unconditionally. The gate call is
`ns.getResetInfo`, **1 GB** (`types/NetscriptDefinitions.d.ts:8990-9002`, `game/restore.ts:20`), returning
`lastAugReset`, `lastNodeReset`, `currentNode`, `ownedAugs`, `ownedSF`, `bitNodeOptions` (`.d.ts:86-107`).

*Execution* is Singularity-gated, the RAM stated as a `×16/4/1` band on SF4 level: `installAugmentations`
**5 GB × 16/4/1** (`.d.ts:2705-2715`) and `destroyW0r1dD43m0n` **32 GB × 16/4/1** (`.d.ts:2882-2894`) — 80 GB
and 512 GB without SF4. `bitNodeOptions.sourceFileOverrides` sets the *active* level of any Source-File
(`.d.ts:1881-1884`, `shared/telemetry/topics/progression.ts:20-24`), reaching this feature through SF4
(automation), SF11 (queue discount) and SF12 (starting NeuroFlux); `restrictHomePCUpgrade` caps home at
128 GB / 1 core (`.d.ts:1889-1890`).

## Rules

### The two resets

A node reset does everything an install does and more. Our model of the install half is `sim/world.ts:340-433`;
the upstream pair is `Prestige.ts:55-200` / `:203-360`, with the program, karma, entropy and favor rows at
`Prestige.ts:86-95,131`, `Server/ServerHelpers.ts:224-237`, `PlayerObjectGeneralMethods.ts:80-175` **[src]**.

| State | Install | BitNode reset |
|---|---|---|
| Six skills, exp; city, jobs, purchased servers, hacknet nodes, queue, `numPeopleKilled` | 1 / 0 / cleared (`sim/world.ts:353-390`) | same |
| Money | $1,000 plus each installed aug's `startingMoney` (`sim/world.ts:393-395`; the field is in `.../Augmentation/AugmentationTable.ts:387`); $250m in BN8 (`sim/world.ts:395`) | same |
| Faction membership and invites | cleared, except the 12 factions flagged `keepOnInstall` (`.../Faction/FactionTable.ts`) | cleared |
| Home programs | wiped to NUKE.exe (+ BitFlume), then re-granted from installed augs' `programs` field, plus Formulas.exe under BN5. Other home files are untouched | same |
| Home RAM / cores | kept (`sim/world.ts:399-401,417-420`) | 8 GB, 32 with SF1, 128 with SF9.2; 1 core **[src** `Prestige.ts:246-253`**]** |
| Karma · grafting entropy | kept · kept | 0 · 0 |
| Faction rep · favor | folded into favor, then 0 · kept and increased (`shared/strategy/progression/decide.ts:356,486`) | 0 · 0 |
| Installed augmentations | kept | `[]` |
| Gang, corp, Bladeburner, sleeve levels, WSE flags | kept | destroyed |

### Augmentation pricing

```
moneyCost = baseCost × 1.9^queuedNonSoA × AugmentationMoneyCost
repCost   = baseRepRequirement × AugmentationRepCost
```

All four pricing cases are transcribed in `shared/strategy/factions/augs.ts:158-185` from
`AugmentationHelpers.ts:30,127-159` **[src]**.

- `1.9` is `CONSTANTS.MultipleAugMultiplier` (`sim/vendor/bitburner/src/Constants.ts:42`). SF11 multiplies it by `[1, 0.96, 0.94, 0.93][level]` → **1.824 / 1.786 / 1.767** (`augs.ts:37-38,151-153`).
- **Reputation never escalates; only money does.** So the rep target is fixed and order matters only for price: most-expensive-first, except where prerequisites invert that, which is why `augs.ts:468-495` runs a subset DP rather than a sort.
- SoA augs are excluded from the queue count and priced `7^ownedSoA` / `1.3^ownedSoA` (`Constants.ts:101-102`, `augs.ts:33-34,174-179`), so buying them inflates nothing else.
- NeuroFlux: 500 rep / $750k base (`.../Augmentation/AugmentationTable.ts:1381-1384`), both scaled `1.14^level` (`Constants.ts:37`, `augs.ts:32,166-171`), money then also taking the queue multiplier. Each level gives ×1.01000262 on most multipliers (`AugmentationTable.ts:1420-1446`).
- Augmentation count gates read **installed** augs only, and NeuroFlux is one entry at any level (`Faction/FactionJoinCondition.ts:123-131`, `AugmentationHelpers.ts:56-60` **[src]**).

### Favor and donations

```
favorToRep(f) = 25000 × (e^(0.019802627296179712 f) − 1)
repToFavor(r) = log1p(r / 25000) / 0.019802627296179712     (MaxFavor 35331)
addRepToFavor(favor, rep) = repToFavor(favorToRep(favor) + rep)
```

`sim/vendor/bitburner/src/Faction/formulas/favor.ts`. Rep is perishable, favor durable. Donations unlock at
`floor(150 × FavorToDonateToFaction)` favor (`.../formulas/Donation.ts`, `Constants.ts:32`) and pay
`amount / 1e6 × mults.faction_rep × FactionWorkRepGain` rep (`.../formulas/Donation.ts`, `Constants.ts:34`).

### Ending the node

`destroyW0r1dD43m0n` is documented as "the special augment installed and the required hacking level **OR**
completed the final black op" (`types/NetscriptDefinitions.d.ts:2886-2888`). The implementation checks hacking
level plus `hasAdminRights`, not the augmentation, and installs the backdoor itself (`Singularity.ts:1170-1188`
**[src]**; see Open). That level is `3000 × WorldDaemonDifficulty`, behind 5 ports
(`sim/vendor/.../Server/data/ServerMetadata.ts:2271-2292`; `worldDaemonSkill`, `shared/features/bitnode.ts:368-378`).
The four routes, all modelled in `shared/strategy/progression/endgame.ts:4-45`:

| Route | Red Pill from | Condition |
|---|---|---|
| `daedalus` | Daedalus | 30 augs (node-dependent), $100b, hacking 2500 or combat 1500, then 2 500 000 rep (`endgame.ts:14-16,32-36`) |
| `gang` | a gang faction you own | **BN2 only** (`endgame.ts:16-17`; `Faction/FactionHelpers.tsx:181-183` **[src]**) |
| `labyrinth` | darknet lab reward chain | `DarknetLabyrinthRewardsTheRedPill ≠ 0` — every node but BN8 (`.../BitNode/BitNodeMults.ts:230`); needs the dark web, so BN15 or SF15 (`endgame.ts:18-21`) |
| `bladeburner` | none — no pill, no hacking level | the final black op, rank 400 000 (`endgame.ts:21-24,37`). The count compared against is `Object.keys(BladeburnerBlackOpName).length` = **21** (`BlackOperations.ts:735`, `Bladeburner/Enums.ts:38-60` **[src]**) |

The Red Pill is 2 500 000 rep, $0, `isSpecial` (`.../Augmentation/AugmentationTable.ts:2292-2302`). All three
pill routes converge on one step: it must be **installed**, because the `The-Cave → w0r1d_d43m0n` link is
created during the install and an install resets hacking to 1, so the climb to the world-daemon level always
happens *after* it (`endgame.ts:26-30`). Route choice, ETA and cadence: [`endgame.md`](../endgame.md).

### Grafting entropy

One completed graft adds one entropy stack (`sim/features/grafting.ts:85`) and every player multiplier is then
scaled by `0.98^stacks` — `CONSTANTS.EntropyEffect` (`sim/vendor/bitburner/src/Constants.ts:105`) over the field
list transcribed at `shared/strategy/factions/augs.ts:263-277`. The `violet Congruity Implant` clears the stacks
(`sim/features/grafting.ts:83`, `shared/strategy/factions/decide.ts:1104`). The cost is global rather than
per-stat, so a graft is priced where the augmentation set is chosen, in `factions`, not here.

## Needs · Gives · Contends

**Needs** `money` (aug prices, Daedalus's $100b), `augCount`, `factionRep`, `skill` and `combatSkills` (destroy
gate, Daedalus), `bladeburnerRank`. **Gives** every permanent multiplier; the route decision and the install/node
forecasts on `progression.plan`, read by every driver as `DriverContext.route` and `horizons`. **Contends**
money, decisively — an install spends everything. Claims: `progression:terminal-action` 121,
`progression:install-freeze` 110, `progression:imminent-install` 50 (`shared/strategy/arbiter.ts:268-273`).

## Challenges

- The install destroys what paid for it: hacknet upgrades, pump RAM and stock positions must repay inside the install horizon.
- Batch size, not spend-everything — the marginal augmentation must beat the 1.9× it adds to every purchase after it, and the escalation is paid once per queue.
- The final batch and the post-install regrow are one problem: the install resets hacking to 1 and the regrow target is `worldDaemonSkill(n)`, 3000 in BN1 but 15 000 in BN2 and BN14.
- Favor value is nested, not additive: the augs at one faction are breakpoints on a single rep curve, so crediting the same favor-rate gain to each offer manufactures reset value (`shared/strategy/progression/decide.ts:486`).
- Stale state reads as live: a topic surviving a reset is data from a dead node, and an augmentation-cycle rate measured from a save that already held a queue observed only the button press (`shared/strategy/progression/regrowth.ts:20-25`).

## Rewards

Permanent multipliers, faction favor, karma and home RAM/cores survive an install; none survive a BitNode
reset, which returns the only reward that carries between nodes — a Source-File level (table above).

## BitNode modifiers

| Field | Nodes |
|---|---|
| `AugmentationMoneyCost` | BN3 3 · BN5 2 · BN7 3 · BN10 5 · BN11 2 · BN12 `inc` · BN14 1.5 · BN15 3 |
| `AugmentationRepCost` | BN3 3 · BN10 2 · BN12 `inc` |
| `FavorToDonateToFaction` | BN3 0.5 · BN8 **0** · BN12 `inc` |
| `DaedalusAugsRequirement` | BN6 35 · BN7 35 · BN12 `floor(min(30 + inc, 40))` · BN15 **20** |
| `WorldDaemonDifficulty` | BN2 5 · BN3 2 · BN4 3 · BN5 1.5 · BN6 2 · BN7 2 · BN9 2 · BN10 2 · BN11 1.5 · BN12 `inc` · BN13 3 · BN14 5 · BN15 2 |
| `DarknetLabyrinthRewardsTheRedPill` | BN8 0 |

`inc = 1.02^SF12level`; every value from `sim/vendor/bitburner/src/BitNode/BitNodeMults.ts`. Read
[BN12](../bitnodes/bn12.md) (every field is a function of the SF12 level), [BN8](../bitnodes/bn08.md)
(donate from 0 favor, no labyrinth pill) and [BN15](../bitnodes/bn15.md) (20 augs, no Daedalus pill).

## Source map

| Concern | File |
|---|---|
| install cadence, node order, route model | `shared/strategy/progression/decide.ts`, `endgame.ts`, `bitnode-order.ts` |
| ETA, forecasts, regrow curves | `shared/strategy/progression/eta.ts`, `forecast.ts`, `regrowth.ts` |
| favor activation, money marginals | `shared/strategy/progression/activation.ts`, `marginal.ts` |
| driver, install rendezvous | `game/lib/features/remaining.ts`, `game/lib/install-signal.ts` |
| probes · telemetry topic · tab | `game/lib/probes/gates.ts`, `dodged.ts` · `shared/telemetry/topics/progression.ts` · `ui/app/tabs/bitnode.ts` |
| aug pricing and order · node multipliers, `worldDaemonSkill` | `shared/strategy/factions/augs.ts` · `shared/features/bitnode.ts` |
| sim prestige · vendored rules | `sim/world.ts` · `sim/vendor/bitburner/src/Constants.ts`, `.../Faction/formulas/` |

## Open

- Does the hacking route really not require The Red Pill? `.d.ts:2886-2888` says the augment must be installed; `Singularity.ts:1170-1174` **[src]** checks only hacking level and `hasAdminRights`, and `nuke` checks only NUKE.exe and open ports (`NetscriptFunctions.ts:531-547` **[src]**). Untested, and the two sources disagree.
- Is `$1,000` the right install floor? `sim/world.ts:393` uses it; `PlayerObjectGeneralMethods.ts:102` **[src]** uses `1000 + CONSTANTS.Donations`, which is 262 (`sim/vendor/bitburner/src/Constants.ts:108`).
- Is `BLACK_OP_COUNT = 20` (`shared/strategy/progression/endgame.ts:40`) right? The enum it mirrors has 21 members **[src]**.
- What the BN2 gang Red Pill requires beyond a gang and 2 500 000 rep ([bn02](../bitnodes/bn02.md)), and whether the `w0r1d_d43m0n` finish is reachable normally in BN15, where Daedalus does not sell the pill ([bn15](../bitnodes/bn15.md)).
