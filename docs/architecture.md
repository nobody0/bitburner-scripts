# Architecture

## Source, build, deployment

The repository has three deliberately separate layers:

1. `src/` contains authored TypeScript and no generated JavaScript.
2. `tools/build.ts` reads the explicit entrypoint allowlist and bundles each
   entry to `build/` with esbuild.
3. `tools/rfa-server.ts` pushes only those built artifacts to the configured
   Bitburner server through the Remote File API.

Library modules are imported by entrypoints and disappear into their bundles;
they are not separate in-game files unless promoted to explicit entries.

## Remote File API direction

Bitburner opens a WebSocket connection to the server in this repository. After
that connection exists, the tool sends JSON-RPC 2.0 requests to the game. The
initial pipeline uses:

- `pushFile` to create or replace an allowlisted script;
- `getDefinitionFile` to retrieve the exact Netscript TypeScript definitions.

It does not call `deleteFile`. Adding deletion later requires an explicit
managed-file manifest and tests proving that only files previously owned by this
repository can be removed.

## Testing boundary

Pure strategy functions belong outside `main(ns)`. Unit-test those functions
with Bun's test runner. The RFA request/session layer is tested with an in-memory
socket; live-game verification remains a small smoke test after installation.

