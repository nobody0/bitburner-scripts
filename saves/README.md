# saves/

Snapshots of real Bitburner saves, and the registry that names them.

A snapshot is what a simulation run starts from: "the beginning of BN5", "just
before the first augmentation install". Runs seeded from the same snapshot are
comparable; runs seeded from a fresh BN1 fixture are not comparable to them.

## Adding one

Saves come from the game, by hand — Options → Export Game writes
`bitburnerSave_<epoch>_BN<n>x<lvl>.json.gz`. Drop it in here and register it:

    bun run save:add bn5-start bitburnerSave_1754500000_BN5x1.json.gz "start of BN5"
    bun run saves            # list what is registered

`index.json` is the registry: id, label, BitNode, and how far into the node the
save is. The blobs are committed alongside it, so a snapshot is reproducible on
any machine — at the cost of a few megabytes of undeltifiable gzip per capture.

Note that exporting gives the export bonus and updates `LastExportBonus`, so it
is a (small) mutation of the live game, not a pure read.

## Using one

    bun run sim -- --profile hacking-only --save bn5-start --seeds 1..3

## Restoring one into the game

    bun run save:restore bn5-start     # pushes the payload, prints the command
    run restore.js bn5-start           # in the game's terminal

This OVERWRITES the live save and there is no automatic backup. The in-game
prompt shows the running game's BitNode and playtime beside the snapshot's, so
a mismatch is visible before you confirm — but if the current progress matters,
export it first.
