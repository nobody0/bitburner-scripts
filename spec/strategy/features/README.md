# Features

One file per feature in `shared/features/registry.ts`. Each answers the same
questions: what the mechanic is, how it unlocks, the rules we must be correct
about, what it needs and gives, what makes it hard, what it pays back, which
BitNode multipliers hit it, and where its code lives.

These are **fact files**. Every claim is cited to the pinned game source
(`spec/game-source.md`) or to our own code, and anything unproven sits in an
`## Open` section as a question rather than as prose.

| Feature | Theme BitNode | Status |
|---|---|---|
| [`progression`](progression.md) | [BN12](../bitnodes/bn12.md) The Recursion | done |
| [`hacking`](hacking.md) | [BN1](../bitnodes/bn01.md) Source Genesis · [BN5](../bitnodes/bn05.md) Artificial Intelligence | done |
| [`factions`](factions.md) | [BN4](../bitnodes/bn04.md) The Singularity | done |
| [`career`](career.md) | [BN11](../bitnodes/bn11.md) The Big Crash | done |
| [`hacknet`](hacknet.md) | [BN9](../bitnodes/bn09.md) Hacktocracy | done |
| [`stock`](stock.md) | [BN8](../bitnodes/bn08.md) Ghost of Wall Street | done |
| [`gang`](gang.md) | [BN2](../bitnodes/bn02.md) Rise of the Underworld | done |
| [`corp`](corp.md) | [BN3](../bitnodes/bn03.md) Corporatocracy | **strategy only** |
| [`bladeburner`](bladeburner.md) | [BN6](../bitnodes/bn06.md) · [BN7](../bitnodes/bn07.md) Bladeburners | done |
| [`sleeves`](sleeves.md) | [BN10](../bitnodes/bn10.md) Digital Carbon | done |
| [`go`](go.md) | [BN14](../bitnodes/bn14.md) IPvGO Subnet Takeover | done |
| [`stanek`](stanek.md) | [BN13](../bitnodes/bn13.md) They're lunatics | done |
| [`dnet`](dnet.md) | [BN15](../bitnodes/bn15.md) The Secrets of the Dark Net | done |
| [`side`](side.md) | — | done |

Status is `spec/progress.md`'s roster; that file, not this table, is the record.

## Boundaries

Where a feature does not own something it plausibly could:

- **Grafting** is in [`factions`](factions.md) — another way to acquire the same
  augmentations. It unlocks with BN10/SF10, so [`sleeves`](sleeves.md) links to it.
- **Karma** is in [`career`](career.md), because it is a precondition other
  features wait on rather than an objective of its own.
- **Coding contracts** are in [`side`](side.md): universal income with no theme node.
- **Infiltration and the casino** are deliberately outside the roster — DOM-driven
  gameplay with no action API.

## Related

| Document | Answers |
|---|---|
| [`../../features.md`](../../features.md) | The machinery: registry, probes, drivers, capabilities |
| [`../graph.md`](../graph.md) | What depends on what, and which resources are contended |
| [`../../progress.md`](../../progress.md) | What is built, what is deferred, and the evidence |
| [`../bitnodes/`](../bitnodes/) | Per-node rules: multipliers and Source-File effects |
