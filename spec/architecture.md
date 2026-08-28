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

Every build embeds one `__BUILD_ID__` in all artifacts, but no build-stamp file
or runtime adoption protocol exists. A controller launch always clears the
page-realm operational caches and rebuilds from game state.

## Clean sync transaction

Bitburner's v3.0.1 Remote File API can push, list and delete files, but cannot
kill or launch processes. `sync-control.txt` bridges that gap with three
versioned phases: `prepare`, `ready`, and `commit`.

1. The external process completes the local build and writes `prepare`, naming
   a unique request id and every accessible host.
2. `main.js` launches `start.js --sync` and exits. The wrapper runs `killall`
   over every named host, home last and with its own safety guard, then writes
   `ready`.
3. The external process pushes every artifact and strictly deletes stale
   project-owned `.js` files.
4. Only after all writes and deletions succeed does it write `commit`. The
   wrapper spawns the new `main.js` and exits.

A failure before commit leaves the wrapper parked. A later prepare request with
a new id repeats the kill and resumes the transaction safely. There is no
legacy deployment detection or compatibility handoff.

Both transports use `tools/sync.ts`: the UI hub invokes it in-process through
POST `/sync`, while `bun run sync` forwards to the hub or falls back to a
one-shot Remote File API listener. `--perf` and `--readable` modify the build;
`--types-only` retrieves definitions without restarting scripts. Sweep bypasses
do not exist.

## Ownership and deletion

The sweep derives owned directories from configured targets. Only stale `.js`
files directly inside those directories are deletable. Root files, game files,
player text files, and `data/` remain protected. Because the fleet has already
been killed, an inaccessible host or refused deletion fails the transaction
instead of being skipped.

The destructive `restore.js` maintenance entrypoint remains outside normal
builds and is pushed only by `save:restore`.

## Testing boundary

Pure decisions and protocol parsing are unit-tested with Bun. RAM analysis pins
the shipped wrapper at 4.1 GB and the controller within its 3.2 GB allocation.
The simulator registers both real entrypoints and boots through `start.js`, so
the same zero-delay spawn path runs in simulation and in game.
