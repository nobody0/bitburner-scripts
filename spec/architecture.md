# Architecture

## Source, build, deployment

The repository has three deliberately separate layers:

1. `game/` contains authored TypeScript and no generated JavaScript. It is the
   only directory containing deployable entrypoints (enforced by config
   validation). Those entrypoints may import self-contained pure code from
   `shared/`; esbuild folds that code into standalone artifacts, so no external
   module is required in the game. `shared/` cannot import any other project
   directory or a runtime package (`@ns` is permitted for erased types only).
2. `tools/build.ts` reads the explicit entrypoint allowlist and bundles each
   entry to `build/` with esbuild.
3. `tools/rfa-server.ts` pushes only those built artifacts to the configured
   Bitburner server through the Remote File API.

Runtime helpers are named with the build id already baked into the controller
(`worker/worker.<build>.js`, `lib/dodge-stub.<build>.js`). A sync pushes those
immutable files before replacing `start.js`, then pushes `build-id.txt` last.
The running controller therefore keeps using its own helpers until the complete
new set exists. Build ids are timestamp-plus-random identities, not counters:
they require no shared mutable state and remain unique across branches and
concurrent builds.

Library modules are imported by entrypoints and disappear into their bundles;
they are not separate in-game files unless promoted to explicit entries.

## Remote File API direction

Bitburner opens a WebSocket connection to the server in this repository. After
that connection exists, the tool sends JSON-RPC 2.0 requests to the game. The
tools use:

- `pushFile` to create or replace an allowlisted script;
- `getDefinitionFile` to retrieve the exact Netscript TypeScript definitions.

Those operations are intentionally separate: `sync` only builds and pushes,
while `types` only refreshes the tracked definition file. Both listeners time
out after 30 seconds without a game connection. The destructive `restore.js`
maintenance entrypoint is excluded from normal builds and is built and pushed
only by `save:restore`.

`sync` calls `deleteFile`, gated by a derived ownership rule rather than a
manifest: `ownedDirectories()` (`shared/deployment.ts`) reads the directories
the build's own targets write into, and `isSweepableFile()` admits only a `.js`
file inside one of them that this build and the previous one did not push. A
renamed or retired artifact is therefore collected the moment it leaves
`bitburner.config.json`, with nothing to keep up to date — a hand-maintained
list of former names is wrong the first time someone forgets it.

Three further layers stand behind that rule. `getFileNames` returns only
`server.scripts` and `server.textFiles`, so `.msg`/`.lit`/`.exe`/`.cct` are not
even enumerable; `BaseServer.removeFile` refuses to delete a running script,
which is what protects the outgoing worker generation during a handoff; and the
`.js` restriction spares a player's own text files inside our directories.
`tests/rfa-sweep.test.ts` drives the rule over a transcribed in-game listing
containing every one of those categories and asserts the delete set is exactly
this project's stale artifacts.

## Testing boundary

Pure strategy functions belong outside `main(ns)`. Unit-test those functions
with Bun's test runner. The RFA request/session layer is tested with an in-memory
socket; live-game verification remains a small smoke test after installation.

