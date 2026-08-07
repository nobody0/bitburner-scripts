# bitburner-scripts

A clean-sheet Bitburner automation codebase. The old
[`nobody0/bitburner`](https://github.com/nobody0/bitburner) repository is
inspiration only; this repository starts with new history and a deliberately
small architecture.

Four parts (see [spec/repo-layout.md](spec/repo-layout.md)):

- **game/** — the only code synced into the game: `start.js` (controller —
  scan, root, dispatch), the telemetry logger, the RAM-dodge stub, and the
  puppet worker the HWGW dispatcher drives. 3.6 GB static, budget-tested.
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
problem is what they add up to. See [spec/features.md](spec/features.md).

## Local references

- Game source: `/Users/bob/git/bitburner-src`, pinned to the release documented
  in [spec/game-source.md](spec/game-source.md).
- Legacy scripts: `/Users/bob/git/bitburner-legacy`, tracking the repository's
  newest branch, `patch-1`, at commit `29d8bd2`; cloned from
  [`nobody0/bitburner`](https://github.com/nobody0/bitburner). That branch is one
  test-cleanup commit ahead of `main` and contains no additional feature work.
  Its RAM dodger design is ported (with credit) into `game/lib/dodge.ts` — see
  [spec/dodging.md](spec/dodging.md).

Both checkouts are reference material. New scripts and history belong only in
this repository.

## Development loop

1. Install dependencies with `bun install`.
2. Run `bun run dev` and leave it running (add `--perf` to strip telemetry).
3. Run `bun run ui` and open <http://127.0.0.1:12526> for the live dashboard.
4. In Bitburner, open **Options → Remote API** and configure the game to connect
   to `127.0.0.1:12525` — hostname `localhost`, port `12525`, **Use wss OFF**,
   reconnection delay `5`.
5. In **Options → System**, set the autoexec script to `start.js main` so it
   starts whenever the game loads (cold boot: scan, root, redeploy).
6. Edit TypeScript under `game/` (and `shared/`). Successful builds are pushed
   to `home` whenever the game is connected, and the running `start.js`
   detects the new build stamp (`build-id.txt`) and hands off to a fresh
   instance of itself — no manual restarts. Game reload and code change share
   the same entry point; a controller-epoch guard keeps exactly one instance
   in charge.

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

Telemetry is compiled **in** by default and compiled **out** entirely by
`--perf` builds (esbuild `define` + dead-code elimination; verified by
`tests/build-perf.test.ts`).

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
source checkout.)

Use the definitions through type-only imports:

```ts
import type { NS } from "@ns";
```

## Commands

- `bun run dev` / `dev:perf` — listen for Bitburner, build and push on changes.
- `bun run sync` — one-shot build and push, then exit.
- `bun run build` / `build:perf` — compile the allowlist to `build/`.
- `bun run ui` — telemetry hub + viewer on port 12526.
- `bun run sim -- --goal …` — run the simulator; JSONL lands in `runs/`.
- `bun run sim:compare a.jsonl b.jsonl` — A/B time-to-goal.
- `bun run vendor` — re-extract the game formula core from the pinned tag.
- `bun run typecheck` / `typecheck:vendor` / `bun test` — checks; run before commit.
- `bun run types` — refresh type definitions from the running game.
