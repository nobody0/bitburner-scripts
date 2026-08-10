# bitburner-scripts

A clean-sheet Bitburner automation codebase. The predecessor scripts
([`nobody01/bitburnerscript`](https://gitlab.com/nobody01/bitburnerscript),
branch `2023`) are inspiration only; this repository starts with new history and
a deliberately small architecture.

Four parts (see [spec/repo-layout.md](spec/repo-layout.md)):

- **game/** — the only code synced into the game: `start.js` (startup script,
  the core loop, the game-state store, feature probes and drivers), the
  telemetry logger, the RAM-dodge stub, and the puppet worker the HWGW
  dispatcher drives. 3.6 GB static, budget-tested.
- **shared/** — the pure engine: HWGW targeting/dispatch
  ([spec/targeting.md](spec/targeting.md)), the RAM heap, goals, telemetry
  schema, and the feature registry
  ([spec/features.md](spec/features.md)). Runs unchanged in the sim and the game.
- **sim/** — the simulator: vendored game formulas + virtual clock; measures
  "time to goal" so strategy changes can be A/B compared before touching the
  game. See [spec/simulator.md](spec/simulator.md), [spec/goals.md](spec/goals.md).
- **ui/** — the external UI process (never in-game): telemetry hub + browser
  viewer for live play and sim replays, one tab per feature. See
  [spec/telemetry.md](spec/telemetry.md).

The game is split into **features** — separable optimization problems, one per
BitNode theme (hacking, factions, stocks, gang, corp, bladeburner, sleeves,
Go, Stanek, darknet, …). Each owns a telemetry topic, a probe, and a UI tab,
and will eventually own a simulator model; the composed "beat this BitNode"
problem is what they add up to. See [spec/features.md](spec/features.md) for
the machinery and [spec/strategy/](spec/strategy/README.md) for the play: a
note per BitNode, a feature catalog (unlock / needs / yields), and the
dependency graph of shared resources.

## Reference repositories

- Game source: [`bitburner-official/bitburner-src`](https://github.com/bitburner-official/bitburner-src),
  pinned to the release documented in [spec/game-source.md](spec/game-source.md).
  `bun run vendor` uses `BITBURNER_SRC` when set and otherwise looks for a
  sibling checkout at `../bitburner-src`, which is portable across machines.
- Predecessor scripts:
  [`nobody01/bitburnerscript`](https://gitlab.com/nobody01/bitburnerscript),
  branch `2023` at commit `43e8585` (54 commits). This is the real predecessor:
  it has the faction/augmentation planner (`src/_lib/factions.ts`,
  `augmentations.ts`), four batchers, a batch optimizer, a predictive target
  simulation, and the full reset/BitNode loop. Its `stubCall` RAM-dodger design
  (`src/_lib/stub-call.ts`) is ported with credit into `game/lib/dodge.ts` —
  see [spec/dodging.md](spec/dodging.md). Its local checkout name is deliberately
  not part of this repository's configuration.

Both checkouts are reference material. New scripts and history belong only in
this repository.

### A note on citations

Comments across this repository credit two different predecessors, and the
distinction matters because only one is still on disk:

- **the reference scripts** — `nobody01/bitburnerscript@2023`, the checkout
  above. Cited by file (`src/_lib/optimizer.ts`), and verifiable.
- **an earlier rewrite** — `nobody0/bitburner`, which this project briefly
  treated as the predecessor and which is **no longer checked out**. It was an
  abandoned rewrite carrying none of the faction, augmentation or progression
  logic. Several designs here (the RAM heap's slab allocator, the `$/GB/sec`
  target score, the single-binary worker) came from it, and are attributed to
  it by name rather than repointed at a file that does not contain them.

## Development loop

1. Install dependencies with `bun install`.
2. Run `bun run ui` and open <http://127.0.0.1:12526> for the live dashboard.
3. In Bitburner, open **Options → Remote API** and configure the game to connect
   to `127.0.0.1:12525` — hostname `localhost`, port `12525`, **Use wss OFF**,
   reconnection delay `5`.
4. In **Options → System**, set the autoexec script to `start.js` so it
   starts whenever the game loads (cold boot: scan, root, redeploy).
5. Edit TypeScript under `game/` (and `shared/`), then click **sync to game** in
   the dashboard. You can instead run `bun run sync` from a terminal.
   There is deliberately no file watcher: only an explicit action can push a
   build. A disconnected game makes the attempt fail after 30 seconds instead
   of leaving a stale listener. The running `start.js` detects the new build
   stamp (`build-id.txt`)
   and hands off to a fresh instance of itself — no manual restart required.

Bitburner is the WebSocket client for file sync (port 12525, this repo is the
server); the in-game telemetry logger is a WebSocket client of the UI hub
(port 12526). Neither costs ns RAM.

## What reaches the game

`bitburner.config.json` is the deployment allowlist. Each entry maps one
TypeScript entrypoint under `game/` (enforced) to one in-game JavaScript
filename:

```json
{
  "source": "game/start.ts",
  "target": "start.js"
}
```

esbuild bundles the entrypoint and its imports into that single `.js` file.
Files that are not listed as entries are never pushed independently. The
pipeline is intentionally one-way and never calls the Remote File API's
`deleteFile` method, so it cannot remove unrelated in-game scripts.

The worker and RAM-dodge helper are immutable per build: their filenames carry
the same build id baked into `start.js`. Helpers are pushed first, then the
stable controller, with `build-id.txt` last as the commit point. The ids use a
timestamp plus a random suffix rather than a mutable counter, so concurrent
builds and branches cannot claim the same version. Old helper files remain in
the game under the no-delete policy.

`game/restore.ts` is a maintenance entrypoint, not part of that normal allowlist.
Only `bun run save:restore` builds and pushes `restore.js`.

Telemetry is compiled **in** by default and compiled **out** entirely by
`--perf` builds (esbuild `define` + dead-code elimination; verified by
`tests/build-perf.test.ts`).

`--perf` changes what the script *reports*, never what it *does*. The script
reads the game into its own state store in every build — that store is what
the controller decides from — and telemetry is the optional step that also
sends it over the wire. So `--perf` buys no WebSocket, no serialization, no
ring buffer and a smaller bundle, at identical game behaviour and identical
static RAM. The tests pin this: both bundles must contain the same set of
dodged ns call sites and cost the same 3.6 GB.

## Simulation / A-B testing

```
bun run sim -- --goal earn:1e9 --seeds 1..10 --horizon 48h            # HWGW engine (default)
bun run sim -- --goal earn:1e9 --seeds 1..10 --horizon 48h --baseline # naive planner
bun run sim:compare runs/<baseline>.jsonl runs/<candidate>.jsonl
```

The sim and live game emit the same telemetry schema and state keys, so the UI
replays either source and goals evaluate identically. Both default to the 1 Hz
`farm` rollup; `--verbose` adds per-op events for debugging (and much larger
run files).

## Type safety

Run `bun run types` while Bitburner is connected. The pipeline requests the
game's own `NetscriptDefinitions.d.ts` through `getDefinitionFile` and writes it
to `types/NetscriptDefinitions.d.ts`. Commit changes to that file alongside an
intentional game-version update. (The committed copy matches the pinned v3.0.1
source checkout.) Ordinary `sync` never reads or rewrites the definitions.

Use the definitions through type-only imports:

```ts
import type { NS } from "@ns";
```

## Commands

- `bun run sync` — one-shot build and push, then exit.
- `bun run build` / `build:perf` — compile the allowlist to `build/`.
- `bun run ui` — telemetry hub + viewer on port 12526, including manual sync.
- `bun run sim -- --goal …` — run the simulator; JSONL lands in `runs/`.
- `bun run sim:compare a.jsonl b.jsonl` — A/B time-to-goal.
- `bun run vendor` — re-extract the game formula core from the pinned tag.
- `bun run typecheck` / `typecheck:vendor` / `bun test` — checks; run before commit.
- `bun run types` — refresh type definitions from the running game.
