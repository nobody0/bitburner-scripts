# Telemetry

The game script contains only a logger; everything visual lives in the external
`ui/` process. The simulator and game share the wire schema and core state keys,
so the same hub and viewer accept both. Their event sets deliberately differ:
the sim currently emits detailed `hack.done` records, while live farming will
publish one-per-second aggregate `farm` state instead of per-operation events.

## Records

Defined in `shared/telemetry/schema.ts`. Three kinds, all carrying
`{seq, t, run, src}`:

- **state** — two families, both last-write-wins per key:
  - *Getter mirrors* (`Telemetry.mirror`), keyed `<getter>` or
    `<getter>:<argKey>` (e.g. `getServer:home`). Fed by dodged getters
    (`makeDodger(...).call`), which write into the store's mirror space; the
    sink republishes `player` under the `getPlayer` mirror key as well, so
    `shared/goals/evaluate.ts` and the UI money chart keep working off one
    acquisition.
  - *Typed topics* (`Telemetry.state`), keyed by
    `shared/telemetry/state-map.ts` (`player`, `servers`, …). The payload
    type is checked against StateMap at compile time, and the same StateMap
    types the game-state store (`game/lib/state.ts`) — so a dodge batch like
    `collectServers` feeds the store, the UI and the log from one inferred
    type. New app-level state = one new StateMap entry.

    Beyond the core three there is one topic per feature, declared in
    `shared/telemetry/topics/` (see `spec/features.md`). Two rules hold for
    all of them:
    - **Digests, not dumps.** Records are last-write-wins and rare, but a raw
      `getDivision()` or bladeburner action table would still dominate the
      JSONL. Emit what the panel shows, and cap list lengths with the true
      count alongside.
    - **No `Map` in a payload.** The wire is JSON and
      `JSON.stringify(new Map())` is `{}`. `ResetInfo.ownedSF`, `ownedAugs`
      and `bitNodeOptions.sourceFileOverrides` are all Maps upstream; probes
      flatten them with `Object.fromEntries`. This one silently ships empty
      panels, so `tests/features.test.ts` pins it.
- **event** — discrete happenings (`start.boot`, `action.blocked`,
  `telemetry.dropped`).
- **debug** — free-form diagnostics; first to be dropped under buffer pressure.

`start.boot` includes the baked build ID, mode, and controller epoch. Exceptions
escaping the `start.js` controller emit `start.crash` with the same identity and
a structured error before being rethrown; Bitburner's normal `ScriptDeath`
cancellation marker is deliberately excluded.

`shared/goals/evaluate.ts` reduces compatible records into goal state. The
browser has a separate UI projection (`ui/app/project.ts`) because it retains
raw server fields, the event feed and every feature topic. Earned/hack totals
come from the `farm` rollup when present, fall back to `hack.done` events, and
are shown as unavailable when neither exists — the test for "do we have
totals" is the presence of a source, never the `src` of the run.

Feature probes add two events: `probe.skipped {id, cost, budget}` when a probe
cannot afford its dodge budget (reported once per price, not per sweep) and
`probe.failed {id, error}` when a body throws. Silence would read as "this
feature has no data".

Two records carry the endgame decision loop (`spec/strategy/endgame.md`).
`endgame.route` fires only when the chosen route CHANGES — decisions, not
heartbeats — with `{from?, to, etaSec, expectedEndAt, why, routes[]}`, where
`routes[]` is every route's per-part estimate breakdown at decision time.
`bitnode.reset` carries the outcome half: `{to, from?, elapsedMs?, route?,
guessedEndAt?, decidedAt?}` — the actual elapsed time next to the last guess,
which is what makes the ETA heuristic tunable from these files at all.

## Wire

WebSocket to the ui/ hub at `ws://127.0.0.1:12526/ingest`; the in-game side is
a bare `new WebSocket()` — a browser global, 0 GB ns RAM. JSON text frames:
one `hello` on connect, then batched `{v, records: LogRecord[]}` flushed every
500 ms or at 100 buffered records. On disk: one JSONL file per run under
`runs/`, one LogRecord per line.

Client behavior (`game/lib/telemetry.ts`): bounded ring buffer (5000; drops
oldest debug first, reports `telemetry.dropped`), reconnect with 1s→30s
backoff (same run id, seq continues — gaps are visible), final flush in
`ns.atExit`.

## Acquisition is not telemetry

The script reads the game and stores the result in its own game-state copy
(`game/lib/state.ts`), keyed by StateMap. That happens in every build. The
controller decides from that store — the capability gates it reads are what
gate the feature drivers — and telemetry is the optional extra step that also
sends the store over the wire.

The store is the single write target for every acquisition path: the sweep
scan, `ns.getPlayer`, the gate batch, all local and dodged probes, the
dispatcher rollup. `set` / `merge` mark keys dirty; `game/lib/telemetry-sink.ts`
publishes the dirty set once per tick and is the only module that touches
`Telemetry` at all. Probe failures and skips are recorded as store fields, not
emitted as events at the call site; the sink diffs them so an unaffordable
probe reports once per *price* and a failing one once per *message*.

## Compile-time elimination

`tools/build.ts` defines `__TELEMETRY__` per build (`true` default, `false`
with `--perf`) and drops `TELEMETRY`-labelled statements in performance
builds. The hard rule, enforced by `tests/build-perf.test.ts`:

> Telemetry may only **send** state the script already holds. Every getter,
> dodge and probe runs unconditionally and writes to the game-state store;
> `TELEMETRY: if (__TELEMETRY__)` wraps the send and nothing else. A `--perf`
> build must be behaviourally identical to a telemetry build — only quieter.

esbuild drops the labelled branch — including payload construction — then
tree-shakes the sink and the telemetry client out of the bundle. This avoids
syntax minification, which would rewrite the dodger's bracket-notation ns calls
and change RAM accounting. `shared/` code never references `__TELEMETRY__`;
the flag only exists in esbuild-processed game bundles.

Compiling acquisition into perf builds is free because Bitburner charges for
*dotted* ns references, not bundle size: every probe body calls through
bracket notation on its own stub ns, so the whole probe table costs 0 GB.
`tests/build-perf.test.ts` asserts both bundles contain the same set of
`stubNs[...]` call sites — the mechanical statement of "same behaviour" — and
`tests/ram-budget.test.ts` asserts they cost the same static RAM. So `--perf`
buys no socket, no serialization, no ring buffer and a smaller bundle, and
changes nothing about what the script does.

## Hub

`ui/server.ts` (Bun.serve, port 12526): ws `/ingest` for emitters, ws `/live`
for browser viewers (snapshot then fan-out), HTTP `/` viewer shell, `/app.js`
(the viewer bundle, built on demand from `ui/app/`), `/runs` +
`/runs/:file` for stored JSONL replays. `ui/store.ts` handles persistence,
tail ring, and state reduction per run.
