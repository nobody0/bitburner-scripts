# bitburner-scripts

A clean-sheet Bitburner automation codebase. The predecessor scripts
([`nobody01/bitburnerscript`](https://gitlab.com/nobody01/bitburnerscript),
branches `master` and `2023`) are inspiration only; this repository starts with
new history and a deliberately small architecture.

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
  [`nobody01/bitburnerscript`](https://gitlab.com/nobody01/bitburnerscript).
  **Two points in this repository's history are checked out, and they are not
  interchangeable** — see the citation note below. Local checkout names are
  deliberately not part of this repository's configuration.

Both checkouts are reference material. New scripts and history belong only in
this repository.

### A note on citations

Comments across this repository credit three different predecessors. The
distinction matters, because two of them are on disk and one is not, and
because the two on disk are strong in different areas.

- **`nobody01/bitburnerscript@master`** (`dc0720b`, 42 commits) — the later
  line, and **the reference for the batcher**:
  `servers/home/imports/batchPlanner.ts` and `batchRunner.ts`. Pooled resident
  workers, `additionalMsec` landing control, fractional thread strength, and
  batch handoff. This is the version that actually ran well; cite it for any
  HWGW/JIT scheduling claim. See [spec/jit-reference.md](spec/jit-reference.md).
- **`nobody01/bitburnerscript@2023`** (`43e8585`, 54 commits) — the earlier
  branch, and the reference for everything *except* the batcher: the
  faction/augmentation planner (`src/_lib/factions.ts`, `augmentations.ts`),
  progression, stock, and the `stubCall` RAM-dodger design
  (`src/_lib/stub-call.ts`) ported with credit into `game/lib/dodge.ts` — see
  [spec/dodging.md](spec/dodging.md). Its production hacking path was
  `shotgun`+`prepare`+`filler`; **`src/_lib/batchers/jit.ts` on this branch is
  unwired work-in-progress and must not be cited as proven.**
- **an earlier rewrite** — `nobody0/bitburner`, which this project briefly
  treated as the predecessor and which is **no longer checked out**. It was an
  abandoned rewrite carrying none of the faction, augmentation or progression
  logic. Several designs here (the RAM heap's slab allocator, the `$/GB/sec`
  target score, the single-binary worker) came from it, and are attributed to
  it by name rather than repointed at a file that does not contain them.

Because two checkouts are live, "the predecessor scripts on disk" is no longer
an unambiguous phrase; cite the branch (`@master` or `@2023`) explicitly.

## Development loop

1. Install dependencies with `bun install`.
2. Run `bun run ui` and open <http://127.0.0.1:12526> for the live dashboard.
3. In Bitburner, open **Options → Remote API** and configure the game to connect
   to `127.0.0.1:12525` — hostname `localhost`, port `12525`, **Use wss OFF**,
   reconnection delay `5`.
4. In **Options → System**, set the autoexec script to `start.js` so it
   starts whenever the game loads (cold boot: scan, root, redeploy).
5. Edit TypeScript under `game/` (and `shared/`), then click **sync** in
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
Files that are not listed as entries are never pushed independently.

`sync` also sweeps its own leavings. Ownership is derived from the config, not
listed by hand: the build's targets name the directories it writes into
(`worker/`, `lib/`), and a `.js` file inside one of them that the current or
previous build did not push is stale and gets deleted. Nothing at the server
root is ever touched — that is where every game-generated file lives (`.msg`,
`.lit`, `.exe`, `.cct`) and where `start.js` and `build-id.txt` are simply
overwritten — and neither is `data/`, which the running controller writes to.
`--no-sweep` disables it; `--sweep-dry-run` prints the delete set instead.

The worker and RAM-dodge helper are immutable per build: their filenames carry
the same build id baked into `start.js`. Helpers are pushed first, then the
stable controller, with `build-id.txt` last as the commit point. The ids use a
timestamp plus a random suffix rather than a mutable counter, so concurrent
builds and branches cannot claim the same version. The previous generation is
kept for one sync — the outgoing controller's in-flight workers still reference
it — and collected by the one after.

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
bun run sim -- --profile bn1-full --horizon 72h --compact --perf      # full fixed-seed BN1, bounded benchmark
bun run sim -- --profile bn1-full --save <checkpoint> --route <order> # alternate checkpoint/order
bun run sim -- --profile bn1-full --fresh                             # explicitly use fresh BN1
bun run sim:compare runs/<baseline>.session.json runs/<candidate>.session.json
```

Profiles are explicitly either `bitnode-route` or `feature-scenario`. Route
sessions carry their entrance identity in the manifest: fresh BN1, or a
registered save id plus the SHA-256 of its exact bytes. Replacing bytes behind
an existing save id is rejected, so downstream route evidence becomes stale
instead of silently inheriting a different checkpoint. `--save` switches the
entrance checkpoint; `--route` gives an alternate completion order its own
lineage. The selected checkpoint must still be in the BitNode declared by that
route leg. Synthetic pressure/calibration profiles cannot be promoted into the
speedrun route.

Controller simulations apply one declared speedrun allowance: active and owned
SF4.3 is added to every entrance so the otherwise-manual Singularity boundary
can be automated. The save/checkpoint bytes remain unchanged, and the allowance
is recorded in `sim.meta`, scenario fingerprints, and the simulator model
version. It does not grant SF14 or any Go reward advantage.

Full-route CLI runs also use a declared aggregate Go lane: opponent choice,
RAM admission, virtual duration, seeded W/L, streak/favor rewards and Node
Power remain in the real controller lifecycle, while the per-move V9 interior
is collapsed to the promoted WebGPU arena's measured win/score/time profile.
`sim.meta.goFidelity` and the scenario fingerprint identify that lane. Exact
move selection, opponent replies and WGSL execution stay in the Go arena and
parity suites; aggregate evidence is never presented as action-by-action parity.

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
- `bun run sim -- --goal …` — run the simulator; per-install JSONLs and a versioned session manifest land in `runs/`.
- `bun test` — the correctness suite: parity against the pinned game source plus our own logic, ~30 s, everything in it cheap and deterministic.
- `bun run long <token>` — the simulations: virtual-time soaks, full BitNode runs, and arenas that measure how the scripts GROW rather than whether a function is right. Tokens are features (`go`, `hacking`, `progression`, `stock`, `world`) and BitNodes (`bn1`, `bn8`); `--all` runs every lane, `--list` shows what exists, `--file <substring>` narrows to matching files. Every case gets its own Bun process, so a soak that times out cannot leave process-wide virtual time installed for the next one. A lane whose fixture is transferred out of band declares it with `requires` and is reported as unavailable rather than failed — the Go arenas need `ipvgobruteforce/data/`, whose sources are committed but whose 28 GB seeded-phase search is not.
- `bun run test:sim:correctness` / `test:sim:scenarios` — the simulator's own correctness files, and the pressure scenarios (`bun run long hacking --file scenario-`).
- `bun run bench:sim:jit-lategame` — run the intentionally long, high-RAM JIT lifecycle benchmark outside the correctness suite.
- `bun run bench:sim:install-cadence` — run the synthetic two-install reset/favor-cadence benchmark.
- `bun run sim:compare a.jsonl b.jsonl` — A/B time-to-goal; either input may also be a `.session.json` manifest for all chained installs.
- `bun run go:arena` — upstream-oracle IPvGO WebGPU smoke tournament and latency report (12 games per ordinary opponent, 2 World Daemon games).
- `bun run go:bruteforce:pack` — merge all completed 5x5 certificate corpora into one globally selected, route-pruned JavaScript playbook.
- `bun run go:bruteforce:arena` — execute the merged playbook against its selected upstream opponents; add `-- --timing maximum --games 46220` for every retained policy.
- `bun run go:gpu` — run the deployed WGSL shader in headless Chrome against native golden vectors and the production latency budgets.
- `bun run go:promote <small5|daemon19> <candidate.model>` — fixed-corpus WebGPU promotion gate; `--apply` installs and verifies the champion through export and full-precision-champion-to-WGSL correctness gates.
- `bun run go:export` — automatically choose each profile's validated storage encoding and regenerate its runtime artifact; add `--inspect` for a non-writing decision/size report or `--check` for staleness.
- `bun run go:golden` — regenerate the native golden fixture from the decoded runtime artifacts.
- `bun run vendor` — re-extract the game formula core from the pinned tag.
- `bun run typecheck` / `typecheck:vendor` / `bun test` — checks; run before commit.
- `bun run types` — refresh type definitions from the running game.
