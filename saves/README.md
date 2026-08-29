# saves/

Snapshots of Bitburner saves, and the registry that names them. Two kinds:
**captured** saves exported from a real game by hand, and **minted** ones the
simulator writes from a derived route-leg entrance (see *Minted checkpoints*
below).

A snapshot is what a simulation run starts from: "the beginning of BN5", "just
before the first augmentation install". Runs seeded from the same snapshot are
comparable; runs seeded from a fresh BN1 fixture are not comparable to them.

## Adding one

Saves come from the game, by hand — Options → Export Game writes
`bitburnerSave_<epoch>_BN<n>x<lvl>.json.gz`. Drop it in here and register it:

    bun run save:add bn5-start bitburnerSave_1754500000_BN5x1.json.gz "start of BN5"
    bun run saves            # list what is registered

`index.json` is the registry: id, label, BitNode, exact-byte SHA-256, and how far into the node the
save is. The blobs are committed alongside it, so a snapshot is reproducible on
any machine — at the cost of a few megabytes of undeltifiable gzip per capture.

Note that exporting gives the export bonus and updates `LastExportBonus`, so it
is a (small) mutation of the live game, not a pure read.

## Using one

    bun run sim -- --profile hacking-early --goal earn:5e6 --save bn5-start --seeds 1..3

The content hash, not only the friendly id, is embedded in route lineage. Do
not overwrite a registered blob in place; register a new checkpoint id so
downstream route results remain explainable.

## Minted checkpoints

A speedrun leg's entrance is derived from the route order, so the checkpoint
that starts it is written rather than captured:

    bun run tools/mint-leg-save.ts bn4.1     # the route's first entrance
    bun run saves                            # minted entries look like any other

A leg run that reaches its goal mints the next leg's checkpoint by itself
(`spec/strategy/route-legs.md`). Minted entries carry `"minted": true`, and
**`save:restore` refuses them**: they satisfy the simulator's decoder, but
this repository cannot verify the complete key set the real game requires —
upstream `SaveObject.ts` is not vendored — and restoring overwrites a live
save with no backup. Use them with `--save` in the simulator instead.

Note that seeding any run from a save is a reduced surface: prestige, Go and
Stanek are switched off and the run is labelled `save-snapshot`. Checkpoints
are for custody and lineage; the leg benchmarks run from their synthetic
entrances.

## Restoring one into the game

    bun run save:restore bn5-start     # pushes the payload, prints the command
    run restore.js bn5-start           # in the game's terminal

This OVERWRITES the live save and there is no automatic backup. The in-game
prompt shows the running game's BitNode and playtime beside the snapshot's, so
a mismatch is visible before you confirm — but if the current progress matters,
export it first.
