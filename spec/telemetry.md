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
    `<getter>:<argKey>` (e.g. `getServer:home`). Explicit mirror producers
    write through `setMirror`; the sink republishes `player` under the
    `getPlayer` mirror key as well, so
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

Feature probes add `probe.failed {id, error}` when a body throws; silence would
read as "this feature has no data". A probe that cannot be PLACED is no longer a
probe-level event at all — it stays queued in the broker, and
`ram.starvation {by, id, gb, waitMs, lane}` reports it once it has genuinely
waited, from the one component that knows whether the RAM is coming.

Coding contracts split repeated state from forensic detail. The `side` topic
carries totals, solver coverage, the front 20 rows of a private 100-contract
work queue, compact quarantine summaries, scan freshness and the last batch
outcome. A full rejected input/answer is emitted once as
`contract.quarantined`; the UI retains the latest replay outside its bounded
event feed. This keeps a failure actionable without copying up to eight large
replays into every 30-second state record.

Two records carry the endgame decision loop (`spec/strategy/endgame.md`).
`endgame.route` fires only when the chosen route CHANGES — decisions, not
heartbeats — with `{from?, to, etaSec, expectedEndAt, why, routes[]}`, where
`routes[]` is every route's per-part estimate breakdown at decision time.
`bitnode.reset` carries the outcome half: `{to, from?, elapsedMs?, route?,
guessedEndAt?, decidedAt?}` — the actual elapsed time next to the last guess,
which is what makes the ETA heuristic tunable from these files at all.
`augmentation.reset` records the other prestige boundary with
`{elapsedMs?, fromAugCount, toAugCount}`. Both are detected from
`getResetInfo()` epochs in the successor controller, after Bitburner has killed
the predecessor and every worker.

`progression.plan.forecasts` carries the live planning half as two typed,
independently anchored forecasts: `install` and `node`. Estimated records retain
`estimatedAt`, `expectedAt`, the ten-minute recalibration deadline, confidence,
and every parallel/sequential component with critical-path and measured flags.
Unknown and stale are explicit states, so replay never mistakes absence for a
one-hour guess. The progression tab renders the same fields.

Go decisions retain the exact public board/history input, bounded search
ranking, sampled playtime and WHRNG seed window, observed-response support, and
the full opponent/board reward comparison. `readyToDispatchMs` measures from
the opponent promise making Black actionable to the irreversible Go call, so
cold-start cost and rare prediction misses remain visible. Each candidate records simulator-
fitted win/score priors, heuristic duration, exact expected node power and
multiplier change, transient install-ETA savings, expected nonlinear faction-
favor gain, persistent faction-work savings and saved-seconds-per-game-second. This is enough to
recompute why an opponent was chosen and to detect live-prior drift without
shipping or importing the game implementation.

Investment decisions use the same snapshot-plus-transition pattern. The
`fleet.infrastructurePlan` and `hacknet.plan` topics capture the horizon,
available and granted cash, valuation inputs, the selected candidate, the top
ranked alternatives, the uncapped candidate count and rejection evidence. The
full observed quote menus remain in the surrounding topic for offline
recomputation. Hash rankings additionally
carry capacity/affordability, the forgone cash-sale value and estimated net
value. `investment.decision`, `hash.decision`, `investment.result` and
`hash.result` form a compact index over those snapshots: they fire when the
winner, hold/funding state, or outcome changes, not once per sample. The raw
topic stream remains the authoritative high-frequency history; the events make
transitions easy to find in replay and fit in the UI's bounded event ring.

Faction planning follows that pattern too. `factions.plan.context` records the
planning horizon and route, augmentation-count goal, income, available/granted
cash, work-slot grant, donation threshold, and augmentation price-queue state.
The objective records both the chosen and runner-up reputation breakpoints with
value rates, unlock/rep/money ETA components, favor after install, and purchase
versus donation cost. Standings, invitations, gates, offers, and ownership stay
in the surrounding faction topic. `faction.decision` indexes changes to the
chosen package or action, while `faction.result` preserves each executed
outcome without repeating unchanged plans every sample.

The progression topic's arbitration digest carries both winners and losers.
Grant rows retain the original amount, priority, reason and comparable
return-per-dollar bid; denial rows retain the same scoring evidence plus the
denial reason and available pool. That is the cross-feature join needed to
explain why Hacknet, home RAM, a purchased server, or a progression reserve won
the shared dollar at a particular pass.

## Wire

WebSocket to the ui/ hub at `ws://127.0.0.1:12526/ingest`; the in-game side is
a bare `new WebSocket()` — a browser global, 0 GB ns RAM. JSON text frames:
one `hello` on connect, then batched `{v, records: LogRecord[]}` flushed every
500 ms or at 100 buffered records. On disk: one JSONL file per install artifact
under `runs/`, one LogRecord per line.

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

## Run identity and artifacts

Emitter `run` ids still identify one process and its monotonic `seq` space, but
JSONL persistence is keyed by the install identity in the hello message. A
deployment handoff therefore starts a new emitter without fragmenting the
install replay.

The hierarchy is `lineage -> BitNode visit -> install`. A real lineage UUID is
stored in `data/run-lineage.txt` on `home`, whose text files survive both kinds
of prestige. `getResetInfo().lastNodeReset` distinguishes BitNode visits,
including revisiting the same numbered node; `lastAugReset` distinguishes the
installs within one visit. The identity read is unconditional acquisition, so a
`--perf` build plays identically while still sending nothing.

Each JSONL has a `.meta.json` sidecar containing the hierarchy, emitter ids,
record count, first/last record timestamps, real creation/update dates, and pin
state. Duration is `lastT - firstT`, which works for live wall time and simulator
virtual time alike. Files without sidecars remain loadable under
`Legacy / ungrouped`; they are never guessed into a real save lineage.

## Hub

`ui/server.ts` (Bun.serve, port 12526): ws `/ingest` for emitters, ws `/live`
for browser viewers (snapshot then fan-out), HTTP `/` viewer shell, `/app.js`
(the viewer bundle, built on demand from `ui/app/`), `/runs` +
`/runs/:file` for stored JSONL replays. `ui/store.ts` handles persistence,
metadata, the tail ring, and state reduction per install artifact. The picker
groups artifacts by lineage and labels leaves with the in-game BitNode name,
install ordinal, short date, and duration.
