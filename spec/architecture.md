# Architecture

## Source, build, deployment

`game/` contains authored TypeScript and is the only deployable source tree.
`tools/build.ts` bundles the explicit `bitburner.config.json` entrypoints into
standalone JavaScript; imported `shared/` code disappears into those bundles.

Startup has two root artifacts:

- `start.js` is the autoexec and sync wrapper. Its honest static cost is 4.1 GB
  (base + `killall` + `spawn`). Normal startup immediately spawns `main.js`.
- `main.js` is the controller. The wrapper launches it temporary with a 3.2 GB
  RAM override, zero delay, and duplicate prevention.

Every build embeds one `__BUILD_ID__` in all artifacts. Controllers use the
staged activation record to adopt it. Activation clears page-realm operational
caches before the replacement launch. Game prestige retains the
prior identity long enough for `shared/reset.ts` to classify the reset, then
clears world state through the registered feature reset hooks.

## Staged sync and activation

Bitburner's v3.0.1 Remote File API can push, list and delete files, but cannot
kill or launch processes. Sync therefore never depends on a running script:
it stages everything the file API can do, records activation, and returns.

1. The external process builds and pushes every artifact, with `start.js` last.
2. It attempts to delete stale project-owned `.js` files. Files held by running
   scripts are reported and left for a later sync rather than invalidating the
   already-staged build.
3. It writes a `staged` record naming the request and hosts, then exits
   successfully.
4. A live controller launches the staged wrapper immediately. If none is live,
   the next autoexec or manual `start.js` consumes the same record. The wrapper
   kills the named fleet, home last with its own safety guard, clears the
   activation record, and spawns the already-staged `main.js`.

Both transports use `tools/sync.ts`: the UI hub invokes it in-process through
POST `/sync`, while `bun run sync` forwards to the hub or falls back to a
one-shot Remote File API listener. `--perf` and `--readable` modify the build;
`--types-only` retrieves definitions without restarting scripts. Sweep bypasses
do not exist.

## Ownership and deletion

The sweep derives owned directories from configured targets. Only stale `.js`
files directly inside those directories are deletable. Root files, game files,
player text files, and `data/` remain protected. A refused deletion is logged
and deferred; artifact staging and activation still complete.

The destructive `restore.js` maintenance entrypoint remains outside normal
builds and is pushed only by `save:restore`.

## Testing boundary

Pure decisions and protocol parsing are unit-tested with Bun. RAM analysis pins
the shipped wrapper at 4.1 GB and the controller within its 3.2 GB allocation.
The simulator registers both real entrypoints and boots through `start.js`, so
the same zero-delay spawn path runs in simulation and in game.
