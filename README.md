# bitburner-scripts

A clean-sheet Bitburner automation codebase. The old
[`nobody0/bitburner`](https://github.com/nobody0/bitburner) repository is
inspiration only; this repository starts with new history and a deliberately
small architecture.

## Local references

- Game source: `/Users/bob/git/bitburner-src`, pinned to the release documented
  in [GAME_SOURCE.md](GAME_SOURCE.md).
- Legacy scripts: `/Users/bob/git/bitburner-legacy`, tracking the repository's
  newest branch, `patch-1`, at commit `29d8bd2`; cloned from
  [`nobody0/bitburner`](https://github.com/nobody0/bitburner). That branch is one
  test-cleanup commit ahead of `main` and contains no additional feature work.

Both checkouts are reference material. New scripts and history belong only in
this repository.

## Development loop

1. Install dependencies with `bun install`.
2. Run `bun run dev` and leave it running.
3. In Bitburner, open **Options → Remote API** and configure the game to connect
   to `127.0.0.1:12525` without TLS.
4. Edit TypeScript under `src/`. Successful builds are pushed to `home` whenever
   the game is connected.

Bitburner is the WebSocket client. This repository runs the WebSocket server and
sends JSON-RPC requests such as `pushFile` over the connection initiated by the
game.

## What reaches the game

`bitburner.config.json` is the deployment allowlist. Each entry maps one
TypeScript entrypoint to one in-game JavaScript filename:

```json
{
  "source": "src/main.ts",
  "target": "main.js"
}
```

esbuild bundles the entrypoint and its imports into that single `.js` file.
Files that are not listed as entries are never pushed independently. The first
version of the pipeline is intentionally one-way and never calls the Remote File
API's `deleteFile` method, so it cannot remove unrelated in-game scripts.

## Type safety

Run `bun run types` while Bitburner is connected. The pipeline requests the
game's own `NetscriptDefinitions.d.ts` through `getDefinitionFile` and writes it
to `types/NetscriptDefinitions.d.ts`. Commit changes to that file alongside an
intentional game-version update.

Use the definitions through type-only imports:

```ts
import type { NS } from "@ns";
```

`bun run typecheck` performs strict TypeScript checking without emitting files.
`bun run build` is the only production compiler.

## Tests

`bun test` runs fast unit tests with Bun's built-in test framework. Keep strategy
and scheduling logic pure where possible; wrap Netscript calls at the edges so
most behavior can be tested without a running game.

## Commands

- `bun run build` — compile the configured subset to `build/`.
- `bun run typecheck` — strict type checking against the game definitions.
- `bun test` — run unit tests.
- `bun run dev` — listen for Bitburner, then build and push on changes.
- `bun run sync` — wait for one connection, build and push once, then exit.
- `bun run types` — refresh only the exact type definitions from the game.

See [GAME_SOURCE.md](GAME_SOURCE.md) for the matching upstream source checkout
and [docs/architecture.md](docs/architecture.md) for the pipeline design.
