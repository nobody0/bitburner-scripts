# `stanek` — Stanek's Gift

The Church of the Machine God installs **Stanek's Gift**: a grid of placed
fragments, charged by running scripts against them. A charged fragment multiplies
one player statistic; Boosters multiply their neighbours instead of acting.

> "Pack the chosen fragments into the gift grid (2D bin packing with rotation),
> then schedule charging so the fragments that matter reach high charge first."
> (`shared/features/registry.ts:160-161`)

**Theme** BN13 (`registry.ts:158`) · **Status** done (`spec/progress.md:38`) — packing is published, while charge execution is owned by the fleet scheduler.

## Unlock

Three `inviteReqs` (`sim/vendor/bitburner/src/Faction/FactionTable.ts:1510-1531`):
`bitNodeN` 13 **or** `sourceFile` 13; `numAugmentations` **0**; and being at the
`Church of the Machine God` location. `keepOnInstall` is `true` (`:1509`), so
membership survives an install.

`numAugmentations: 0` means installed **and queued**, excluding NeuroFlux Governor
(`shared/strategy/factions/requirements.ts:259-266`, `sim/features/requirements.ts:52-64`);
`ns.stanek.acceptGift()` costs 2 GB and documents the same rule
(`types/NetscriptDefinitions.d.ts:6716-6727`). It carries **no BN13 exemption**, so in
every node the Gift must be taken on a clean install. Every other Stanek call is gated
on the augmentation, not the node (`shared/features/unlock.ts:138-142`).

## Rules

**Effect**, verbatim (`sim/vendor/bitburner/src/CotMG/formulas/effect.ts:6-11`):

```
    1 +
    (Math.log(highestCharge + 1) / 60) *
      Math.pow((numCharge + 1) / 5, 0.07) *
      power *
      boost *
      currentNodeMults.StaneksGiftPowerMultiplier
```

**Charge** (`sim/features/stanek.ts:66-71`), where `threads` is the calling
script's threads times `getCoreBonus` = `1 + (cores - 1) / 16`
(`sim/ns/stanek.ts:58`, `sim/vendor/bitburner/src/NetworkShare/Share.ts:7`):

```
    if (threads > fragment.highestCharge) {
      fragment.numCharge = (fragment.highestCharge * fragment.numCharge) / threads + 1;
      fragment.highestCharge = threads;
    } else {
      fragment.numCharge += threads / fragment.highestCharge;
    }
```

**The scheduling rule follows from the exponents.** `highestCharge` is the largest
single charge call's thread count and enters logarithmically; `numCharge` enters at
the power 0.07, nearly flat. A few enormous-thread charges beat many small ones and
grinding charge count is near worthless. Save RAM for one big call.

**Church reputation** is paid per charge (`sim/features/stanek.ts:75-78`):

```
reputation += player faction_rep mult * threads^0.95 * (Church favor + 100) / 1000
```

That reputation is load-bearing, because Genesis is a penalty: **0.9 on 22 multiplier
fields and 1.1 on the four hacknet costs** (`shared/features/augmentations.ts:158`,
`AugmentationTable.ts:1920`). `Awakening` at 1e6 Church rep multiplies by 19/18
(0.9 → 0.95) and `Serenity` at 1e8 by 20/19 (0.95 → 1.0), both for $0
(`augmentations.ts:157`, `:159`). Both are augmentations, so both need an install.

**Grid** (`sim/features/stanek.ts:50-62`; `BaseSize` 9, `MaxSize` 25 at
`CotMG/data/Constants.ts:2-5`). BN13 alone and BN1 with SF13.1 both give 6×5:

```
baseSize = 9 + StaneksGiftExtraSize + sourceFileLvl(13)
width    = max(2, min(floor(baseSize / 2 + 1),   25))
height   = max(3, min(floor(baseSize / 2 + 0.6), 25))
```

**Fragments** — 24 (`CotMG/Fragment.ts:94-376`). Sixteen effect fragments, `limit`
1 each, four cells, from the seven shapes in `Shapes.ts`, as `type (id) power`:

| Group | Fragments |
|---|---|
| hacking | Hacking (0) 1 · Hacking (1) 1 · HackingSpeed (5) 1.3 · HackingMoney (6) 2 · HackingGrow (7) 0.5 |
| other | Strength (10) 2 · Defense (12) 2 · Dexterity (14) 2 · Agility (16) 2 · Charisma (18) 3 · HacknetMoney (20) 1 · HacknetCost (21) 2 · Rep (25) 0.5 · WorkMoney (27) 10 · Crime (28) 2 · Bladeburner (30) 0.4 |

Eight **Booster** fragments, ids 100–107, `power` 1.1, `limit` 99, five cells each.
A Booster cannot be charged (`sim/ns/stanek.ts:53-57`); instead `boost` is the product
of the `power` of every distinct Booster orthogonally adjacent to the charged fragment
(`sim/features/stanek.ts:102-110`), so placement and charging are one joint
optimization. A charge blocks 1000 ms, 200 ms while `storedCycles >= 5` (`ns/stanek.ts:62`).

## Needs · Gives · Contends

- **Needs** nothing from the needs board — no `NeedKind` is published
  (`needs.ts:20`); only the augmentation and fleet RAM.
- **Gives** multipliers to everything that reads them: `hacking`
  (`hacking_speed`, `hacking_money`, `hacking_grow`), `career`, `hacknet`,
  `bladeburner`, `factions` (`sim/features/stanek.ts:148-216`).
- **Contends** fleet RAM through the same farm/prep/charge/share segment plan as
  hacking. A charge is a 2 GB/thread one-shot worker; it is not a dodge claim.

## Challenges

- The optimal packing may **leave a large fragment out** to fit two smaller ones, so
  no greedy heuristic is correct; our solver enumerates every (subset × rotation ×
  position), optimal below a 2e6-node cap (`pack.ts:74`). Its objective is the summed
  `weight` of fitted fragments and ignores Booster adjacency (`remaining.ts:2289`).
- `shared/strategy/stanek/charge.ts` prices the exact accumulator step against
  the fleet's measured share of one second of lost production. The scheduler fills the largest
  residual host blocks first and uses every whole 2 GB thread on each selected
  host. Calls in progress finish; only share is freely evictable.
- A successful charge invalidates the held player multiplier context. Target
  wakes remain latched until the next heartbeat refreshes Player and bumps the
  evaluator generation, so a changed `hacking_speed` cannot mix landing grids.
- Acceptance forecloses every other early augmentation, and nothing in our model
  expresses it: no driver calls `acceptGift` (`sim/ns/stanek.ts:14-16`).

## Rewards

Charge-scaled multipliers on the fields above, plus Church reputation. **Charge does
not survive an install**: `prestigeAugmentation` zeroes `highestCharge` and `numCharge`
but leaves the placements, which a node reset then clears
(`sim/features/stanek.ts:229-239`, called at `sim/game-run.ts:791` and `:658`).

## BitNode modifiers

| Field | Nodes |
|---|---|
| `StaneksGiftPowerMultiplier` | [BN2](../bitnodes/bn02.md) **2** · BN3 0.75 · BN4 1.5 · BN5 1.3 · BN6 0.5 · BN7 0.9 · BN9 0.5 · BN10 0.75 · BN12 `1.02^level` · [BN13](../bitnodes/bn13.md) **2** · BN14 0.5 · BN15 0.7 |
| `StaneksGiftExtraSize` (additive, base 0) | BN2 −6 · BN3 −2 · BN6 +2 · BN7 −1 · [BN8](../bitnodes/bn08.md) **−99** · BN9 +2 · BN10 −3 · BN12 `+1.02^level` · BN13 +1 · BN14 −1 · BN15 −2 |

Both from `BitNode/BitNodeMults.ts`; BN1 and BN11 change neither, and BN12 alone
improves both with depth (`:362-429`). The multiplier scales the term added to 1.

**Ordering, SF7.3.** `ns.bladeburner.joinBladeburnerDivision` documents it: "If you
have SF 7.3, you will immediately receive 'The Blade's Simulacrum' augmentation and
won't be able to accept Stanek's Gift after joining. If you want to accept Stanek's
Gift, you must do that before calling this API."
(`types/NetscriptDefinitions.d.ts:3966-3967`; [`bladeburner.md`](bladeburner.md))

## Source map

| Concern | File |
|---|---|
| strategy | `shared/strategy/stanek/pack.ts`, `shared/strategy/stanek/charge.ts` |
| driver | `game/lib/features/remaining.ts` (packing), `game/lib/features/hacking.ts` and `game/worker/worker.ts` (charging) |
| probe | `game/lib/probes/dodged.ts` (`stanek.core`, line 1685) |
| telemetry topic | `shared/telemetry/topics/stanek.ts` |
| tab | `ui/app/tabs/stanek.ts` |
| sim model | `sim/features/stanek.ts`, `sim/ns/stanek.ts`, `sim/tests/stanek-parity.test.ts` |
| vendored rules | `sim/vendor/bitburner/src/CotMG/` |

## Open

- Does owning a non-NeuroFlux augmentation *ban* the Church outright, beyond
  failing `numAugmentations: 0`? `Faction.isBanned` and the prestige hook that
  would set it are absent from the vendored extract, so `bn13.md`'s
  `bitNodeN !== 13` guard is unverifiable here.
- `StanekConstants.RAMBonus` (0.1) is defined at `CotMG/data/Constants.ts:3` and
  read nowhere else in the vendored extract. What consumes it?
- What weight should a Booster carry in the packing objective, given its value is a
  product over whichever fragments it touches?
