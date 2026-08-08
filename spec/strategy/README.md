# Strategy

The *play* half of the spec. `spec/features.md` describes the feature
**machinery** — registry, probes, drivers, the needs board, the arbiter. This
folder describes what those features are for.

| Document | Answers |
|---|---|
| [`bitnodes/bn01.md` … `bn15.md`](bitnodes/) | "What are the rules in this node, and what does that do to our plan?" |
| [`feature-catalog.md`](feature-catalog.md) | "When does this feature unlock, what does it need, what does it give back?" |
| [`graph.md`](graph.md) | "What depends on what, and which resources are contended?" |

The immediate target is **BN1 near-perfect** — [`bitnodes/bn01.md`](bitnodes/bn01.md)
is the only note written as a playbook. The other fourteen exist so the BN1
plan is written knowing which of its assumptions are BN1-only.

## Sourcing

**Every fact in these documents is verified against bitburner-src `v3.0.1`**,
the pinned release (`spec/game-source.md`), and cited by `file:line` so it can
be re-checked. Three sources, in order of authority:

1. `sim/vendor/bitburner/src/` — the `bun run vendor` extract. Machine-readable
   game data: multipliers, faction requirements, crime and augmentation tables.
2. `types/NetscriptDefinitions.d.ts` — from the running game. The ns surface.
3. The `v3.0.1` tag itself, for logic the extract does not carry (prestige
   semantics, access gates, Source-File effects).

Anything that could not be proven is stated as a question in an **Open** section
rather than hedged inline. There are no version caveats in the notes: if it is
written as fact, it was read at `v3.0.1`.

Two consequences of the 3.0.1 rewrite worth stating once, because both
invalidate older notes and wikis:

- **BitNodes no longer have a `difficulty` field.** The constructor is
  `BitNode(n, name, tagline, description, sfDescription)` — the 0/1/2 rating
  was removed. These notes do not rate difficulty.
- **BitNode options** (`BitNodeBooleanOptions`) let a run disable gang, corp,
  bladeburner, 4S data, hacknet servers, sleeve exp/augs, and home-PC upgrades,
  plus override Source-File levels and Intelligence. So "SF held" no longer
  implies "feature available" — see [`graph.md`](graph.md).

## Multiplier glossary

The BN notes list only fields a node *changes*, grouped, using upstream field
names so they diff directly against `ns.getBitNodeMultipliers()` and
`DEFAULT_BITNODE_MULTIPLIERS` in `shared/features/bitnode.ts`.

| Field | Applies to |
|---|---|
| `*LevelMultiplier` | Skill *level* from exp. 0.35 is brutal — exp→level is already logarithmic |
| `*ExpGain` (`Hack`, `Crime`, `FactionWork`, `CompanyWork`, `ClassGym`) | Exp *earned*. Stacks multiplicatively with the level multiplier |
| `HackingSpeedMultiplier` | Wall-clock of hack/grow/weaken — retimes every batch |
| `Server*` (`MaxMoney`, `StartingMoney`, `GrowthRate`, `StartingSecurity`, `WeakenRate`) | The farm's raw material |
| `ScriptHackMoney` | Money per `ns.hack()` |
| `ScriptHackMoneyGain` | Whether hacked money reaches the player *at all*. `0` in BN8 |
| `ManualHackMoney` | Terminal `hack`, not scripts |
| `HomeComputerRamCost`, `CloudServer*` | Fleet cost. `CloudServer*` is 3.0.1's name for purchased servers |
| `CompanyWorkMoney`, `CrimeMoney`, `CrimeSuccessRate`, `HacknetNodeMoney`, `CodingContractMoney`, `InfiltrationMoney`, `DarknetMoneyMultiplier` | Per-feature income |
| `FactionWorkRepGain`, `FactionPassiveRepGain`, `CompanyWorkRepGain`, `InfiltrationRep` | Reputation income |
| `FavorToDonateToFaction` | Multiplies the 150-favor donation threshold |
| `AugmentationMoneyCost`, `AugmentationRepCost` | The reset loop's tax |
| `DaedalusAugsRequirement` | Augs owned before Daedalus invites. A count, base 30 |
| `WorldDaemonDifficulty` | Multiplies `w0r1d_d43m0n`'s required hacking level (base 3000) |
| `GangSoftcap`, `GangUniqueAugs`, `Corporation*`, `Bladeburner*`, `StaneksGift*`, `GoPower`, `FourSigmaMarketData*` | Per-feature nerfs — the main lever nodes use to force a new strategy |

`StaneksGiftExtraSize` is **additive** (BN1 default `0`);
`DaedalusAugsRequirement` is a **count** (base `30`). Everything else defaults
to `1`.

## Encoded elsewhere

These docs are not a second source of truth. Where a fact is already in code,
the note points at it:

| Fact | Encoding |
|---|---|
| Feature roster, BitNode themes | `shared/features/registry.ts` |
| Per-node multipliers | `sim/vendor/.../BitNode/BitNodeMults.ts` |
| Faction invite requirements | `sim/vendor/.../Faction/FactionTable.ts` |
| Augmentation cost / rep / factions | `sim/vendor/.../Augmentation/AugmentationTable.ts` |
| Crime karma / kills / money / time | `sim/vendor/.../Crime/CrimeTable.ts` |
| Cross-feature requests | `shared/strategy/needs.ts` — `NeedKind` is the edge vocabulary [`graph.md`](graph.md) uses |
| Contended resources | `shared/strategy/arbiter.ts` |

When a doc and the code disagree, the code and the vendored tables win.
