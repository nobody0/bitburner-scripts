# Saves

Keeping one main save with real progress, plus named snapshots that simulation
runs start from.

## Where snapshots come from

By hand, from the game: **Options → Export Game**. That writes raw gzip bytes of
the save JSON as `bitburnerSave_<epoch>_BN<n>x<lvl>.json.gz`. Drop it in
`saves/` and register it:

    bun run save:add bn5-start bitburnerSave_1754500000_BN5x1.json.gz "start of BN5"
    bun run saves

`saves/index.json` is the registry — id, label, BitNode, and how far into the
node the save is. Blobs are committed next to it, so a snapshot is reproducible
on any machine, at a few megabytes of undeltifiable gzip per capture.

Exporting calls `giveExportBonus()`, so it mutates the live game slightly. It is
not a pure read.

## The format

Confirmed against `bitburner-src` @ v3.0.1 (`src/SaveObject.ts`,
`src/utils/JSONReviver.ts`, `src/utils/SaveDataUtils.ts`):

    gzip( {"ctor":"BitburnerSaveObject","data":{"PlayerSave":"<json>", ...}} )

Every value inside `data` is itself a JSON **string**, so the whole thing is
double-encoded. Within those, class instances are `{ctor, data}` wrappers, and
Map/Set become `{"ctor":"JSONMap","data":[[k,v],...]}`.

Three encodings must be accepted, because the game's own import does: raw gzip
(what Export writes), base64 of the JSON (fallback when the browser lacks
`CompressionStream`), and base64 of the gzip bytes (Steam Cloud).

Split by layer, because `shared/` may not use Bun APIs:

- `tools/save-io.ts` — bytes: gunzip, base64, the registry, the CLI.
- `shared/save/decode.ts` — a JSON string to a normalised `SaveSnapshot`.
- `shared/save/to-sim.ts` — a snapshot to simulator initial conditions.

### Five things that silently corrupt a naive parser

Each has a test in `tests/save.test.ts`.

1. **`__proto__` is a legitimate hostname** in the game's own save corpus.
   Servers go into a `Map`, and no parsed object is ever spread or `assign`ed.
2. **Missing keys mean class defaults, not undefined.** `Generic_toJSON` prunes
   through `getKeyList`, so a real save legitimately omits most server fields.
   The defaults live in one table, `SERVER_DEFAULTS`.
3. **`ramUsed` is not saved at all** — it is recomputed from the running-script
   list. (A simulation starts every host at 0: scripts are not restored.)
4. **`activeSourceFiles` is not saved** — it is a getter merging `sourceFiles`
   with `bitNodeOptions.sourceFileOverrides`, where an override of **0** means
   "not active" rather than "present at zero".
5. **Faction and company reputation are not in `PlayerSave`** — they are their
   own sparse top-level saves.

A save also carries *live* server state — money grown, security weakened, RAM
bought — so it bypasses `serverFromSpec`, which derives live fields from base
metadata and would rewind the save to a fresh game.

## Restoring into the game

    bun run save:restore bn5-start     # pushes the payload, prints the command
    run restore.js bn5-start           # in the game's terminal

`tools/save-restore.ts` only **delivers**: it pushes a base64 payload and
`restore.js` over the existing Remote File API. It never writes to the save, so
a mistyped id here costs an unused file on `home` and nothing else. (It needs
port 12525, so wait for any in-progress sync to finish first.)

`game/restore.ts` does the destructive half. The save lives in IndexedDB under
database `bitburnerSave` v2, store `savestring`, key `save`, holding exactly the
bytes Export writes — so restoring is: write them back, then reload, which is
what the game's own `importGame` does. `indexedDB`, `atob` and `location` are
browser globals, so it costs 0 GB of ns RAM beyond the 1.6 GB base.

It is a **separate entrypoint on purpose**. `tests/ram-budget.test.ts` asserts
that `start.js` contains no reference to `indexedDB`, `location.reload` or the
payload file, so no code path the controller runs can reach the save.

**There is no automatic backup.** The prompt shows the running game's BitNode
and playtime beside the snapshot's, so a mismatch is visible before you confirm.
If your current progress matters, export it first.
