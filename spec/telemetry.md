# Telemetry

The game script contains only a logger; everything visual lives in the external
`ui/` process. The simulator and game share the wire schema and core state keys,
so the same hub and viewer accept both. Their event sets deliberately differ:
the sim emits detailed `hack.done` records, while live farming publishes
one-per-second aggregate `farm` state instead of per-operation events.

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
    types the game-state store (`game/lib/state.ts`) — so a proxied read like
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

**Deduplication is the HUB's job, never the game's.** The emitter republishes
every dirty topic in full: `set`/`merge` cannot know whether a value moved, and
proving it has not would cost a second serialization of every topic on every
tick. Game-script clock time is the resource this whole design exists to
protect, so that trade is refused — bytes on a localhost socket are cheap and
the game's tick is not. The hub (`ui/store.ts`) collapses a run of identical
state to its FIRST and LAST record instead. Both ends, because the span is
itself an observation: a topic that held one value for four hours differs from
one sampled once, and keeping only the opening record makes the two
indistinguishable. Live viewers still receive every record — the collapse is a
storage decision, and a viewer's liveness reading comes off the stream. One
consequence for readers: the file is no longer strictly ordered by `t`, since a
span's closing record is written when the span ends, so a projection must SKIP
records past its cutoff rather than stop at the first one.

A topic is split when its parts move at different rates, because a state record
is whole-topic last-write-wins and so republishes everything the moving part
rides on. `arbitration` and `ramArena` were split out of `progression` for
exactly this reason: measured on a live 2.58 GB run, `progression` was 50% of
the file at one record per 200 ms, while the 13.8 KB of
plan/needs/multipliers/moneySources it dragged along changed on 12 of 1259
consecutive pairs. The split plus the span collapse cut a sampled 39.9 MB of
that run to 15.5 MB.

Counters are kept per BATCH, not globally. A batch — a HWGW cycle, an HGW
cycle, a shotgun cycle, a prep wave — is the unit the farm reasons in, and the
kinds are not interchangeable: a prep wave is a hundred grow threads that steal
nothing while a farm cycle is four ops that do, so a single op counter spanning
both describes neither. Every launch group opens a batch id
(`shared/strategy/dispatch.ts`), every op carries it on `Tracked`, and every
completion is attributed back through the `opId` it already echoes — so
**nothing was added to the worker protocol**: `opId` already resolves to the
batch. `farm.batches` publishes the sums per kind (ops, RAM, threads, span,
money, in-order and abandoned counts) plus a bounded ring of recently settled
batches as examples, because a record per batch is no more sendable than a
record per op.

Each ring entry carries `gbMs` — the RAM-time the batch actually occupied, in
GB·ms, summed per landed op as `gb × (landing − launch)`. It exists because the
naive denominator `gb × spanMs` charges every op for the whole batch span, and
for a HWGW cycle whose weaken outlives its hack ~4x that overstatement is both
large and shape-dependent: as skill rises between re-solves the span shrinks
under a frozen thread plan, and $/GB·s drawn against `gb × spanMs` ramps into a
sawtooth that reflects the metric, not the farm. `gbMs` is the honest
denominator; the viewer falls back to `gb × spanMs` only for runs recorded
before the field existed.

Where op LOSS is observable is worth stating precisely, because the obvious
answer is wrong and cost a display. A batch settles only when its last op
lands, so a settled batch has `landed === ops` by construction and the per-kind
sums of the two are equal in every run that can exist. `launched` against
`landed` per kind is therefore one curve drawn twice, and a "settled with fewer
landings" counter can never fire — the viewer plotted that pair as a band for a
long time, captioned as the ops that went missing, and the band was identically
zero. A batch that loses an op never settles at all: it is evicted from the
open-batch map, which is why that eviction is COUNTED (`abandoned`,
`abandonedOps`, `abandonedLanded`). The two places loss shows up are those
counters and the run-level residual `launched - landed - inFlight`; subtracting
the in-flight gauge is what makes the residual loss rather than pipeline depth.

The per-kind sums are also the wrong unit for judging an individual batch, and
the viewer leads with the settled-batch ring for that reason. Batches within one
kind differ by orders of magnitude in size, so a cumulative mean per kind
reports a figure no single batch resembles; the ring is a SAMPLE (it is bounded
and read once a second, so a farm settling faster than it is deep overflows it
between reads) and the per-kind sums are the census. Any panel showing the two
together has to say which is which.

The rollup is also where a question that *looks* per-op gets answered without
per-op records. Farm landings run at roughly one per 20 ms at scale, so "did
this batch's effects land in the planned H -> W1 -> G -> W2 order?" can never be
a record per landing. It survives aggregation because each batch reduces to ONE
signature: the order its roles actually landed in. `farm.landingOrder` counts
batches per observed signature, so a healthy run is a single key at ~100% and a
reorder is a second key — with a bounded ring of recent examples, which stays
cheap precisely because an anomaly rate high enough to fill it is itself the
finding. Batches that landed having never launched a hack are counted
separately (`incomplete`): support paid for with nothing stolen is a different
failure from support arriving out of order, and folding the two together would
hide the more expensive one. Two counters explain a batch that was never
launched rather than lost: `quotaSkips` (keyed `phase:role`) counts launches
deferred because the role's quota was full, and `launchLate` records per-role
lateness — together they name which role starved when a reorder or a missed
window traces back to the launch side rather than the landing side. The same
reasoning covers rates: the rollup
publishes CUMULATIVE `launched`/`landed`/`allocation` counters and the viewer
differentiates them (`ui/app/project.ts`), which costs no bytes and makes a
replay scrub recompute the identical curve.

`stock` is the second instance of that division, and the one where the levels
matter more than any rate. The topic publishes `portfolioValue`/`portfolioCost`
from the 3-second price probe and the driver's self-measured `tradeCashFlow` /
`unlockSpend` ledger; the viewer folds them into four curves and plots two
BANDS, because in both cases the gap is the finding — the book at market against
the book at cost is unrealised P/L, and realised net against cumulative unlock
spend is whether the market has yet earned back the $200m/$5b/$25b it cost to
get in. Realised net is taken at COST BASIS, matching `earnedSinceInstall`, so
the curve is unmoved by opening a position and by price wobble and moves only on
a genuinely realised gain or loss. No $/sec curve is derived from it: trades are
discrete and holds run minutes to regime cycles, so any window short enough to
respond reads zero with spikes, and the tab reports one measured scalar instead.
Two properties of the fold are not visible in the panel and are pinned by
`tests/ui-stock-series.test.ts`. The ledger is genuinely ABSENT until the
install's first trade, so it is never plotted as $0. And the curves survive a
CONTROLLER HANDOFF, because one run artifact is one install: JSONL persistence is
keyed by install identity, so a `market.tick` that goes backwards or a
`tradeCashFlow` that vanishes is a new emitter process attaching, not a reset —
and the page-realm market outlives that process. The viewer used to read either
signal as an install boundary and drop every curve, which threw the book away on
every deployment. An install ends the artifact instead, so there is nothing left
to detect.

One consequence has no fix in the viewer: the measured $/sec needs the moment
this install's ledger opened, and a viewer that attaches mid-ledger cannot know
it. `tradeCashFlow` is cumulative and survives a handoff, so a first observation
of it says nothing about when trading started. The rate's denominator therefore
arms only on an observed zero followed by a non-zero figure, and the panel
renders "attached after the first trade" as its own state rather than dividing by
the time since it happened to connect. Putting the open on the wire —
`tradeFlowSince` on the `stock` topic — is the real repair.

Feature probes add `probe.failed {id, error}` when a body throws; silence would
read as "this feature has no data". A probe that cannot be PLACED is not a
probe-level event at all: probes do not place anything any more, the resident
they call through does, and its stall is `proxy.slow` below.

An ns resident whose `exec` keeps returning 0 never throws — the retry is
unbounded (see spec/ns-proxy.md). What surfaces instead is
`proxy.slow {label, minGb, preferredGb, attempts, waitMs}` once the stall
passes one second (re-emitted at 10 s, 60 s, then every minute) and
`proxy.recovered {label, host, gb, attempts, waitMs}` when the exec finally
lands, so a stall's depth and its end are both on the wire without any crash in
between. A resident's own lifecycle is on the wire beside them:
`proxy.spawn {label, host, gb, reason, pid}` — `reason` being `cold`, `full`
(the budget filled and the memo reset) or `grow` (one call priced above the
budget raised the floor) — and `proxy.undersized {label, grantedGb, minGb}`
when the fleet could not meet a pending call's floor.

Coding contracts split repeated state from forensic detail. The `side` topic
carries totals, solver coverage, the front 20 rows of a private 100-contract
work queue, compact quarantine summaries, scan freshness, the last batch
outcome, and earnings split by contract ORIGIN (`network` / `darknet`) with a
20-deep ring of recent solves. A full rejected input/answer is emitted once as
`contract.quarantined`; the UI retains the latest replay outside its bounded
event feed. This keeps a failure actionable without copying up to eight large
replays into every 30-second state record.

The earnings half adds no event: the ring is bounded state, so
`contract.quarantined` remains the topic's only one. Two rules travel with the
numbers. Money is named `moneyApprox` because it is summed from the game's
formatted reward text and carries about four significant figures — a UI cannot
rename a wire field, so the caveat has to live in the name; reputation is exact
and is not hedged. And a reward string the parser cannot read increments
`unparsed` instead of contributing a zero, because a locale or currency-symbol
change would otherwise present as "earned nothing" rather than "stopped
measuring". The exact combined figure remains
`progression.moneySources.sinceInstall.codingcontract`, which has no origin
split; the two are published for the same window on purpose so they can be read
against each other.

`dnet.profit` is since-install and event-free. Cash retains response precision;
promotion stays an activity count because later trading P&L cannot be honestly
attributed to one batch. The cache funnel separates created and opened
`.d.cache` files, then records exact post-open CCT and data-file observations.

Side publishes a full observed/solvable origin census because its visible queue
is bounded. Farming refusals and expected cash/XP rates describe the current
plan, not cumulative outcomes; one host may contribute to several refusal rows.

Two records carry the endgame decision loop (`spec/strategy/endgame.md`).
`endgame.route` fires only when the chosen route CHANGES — decisions, not
heartbeats — with `{from?, to, etaSec, expectedEndAt, routes[]}`, where
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
the full opponent/board reward comparison. The dispatch digest rides
`lastTurn.prediction`, not the plan: Go re-enters planning on a microtask after
each turn, so a digest parked on `plan` is replaced by the next provisional plan
before a viewer sees it — it survived on 4% of live turns. Its presence is also
what marks a seed-assured turn, so alignment needs no separate record. Board,
territory, score and komi are published together from one position and by one
producer; the core probe deliberately does not read the score, because its
clock and the board's differ and a probe firing between our stone landing and
White's reply published a score one stone ahead of the position beside it.
`dispatchBreakdown` measures from the opponent promise making Black actionable
to the irreversible Go call, split into disjoint, ordered segments (`admit`,
`prepare`, `lease`, `finalize`, `align`, `dispatch`, `residual`) that sum to
`totalMs`. Only `align` is intended delay (`spec/go-ai.md` explains the engine
tick it waits for), so the total alone cannot distinguish it from a slow
worker. The whole breakdown is absent rather than approximated when no
boundary is held: a substituted one would publish a flattering few milliseconds
in exactly the cold-start case worth seeing. Values not measured this turn are
likewise omitted rather than zeroed: `preparationMs` is absent on a position
cache hit, and `finalizationMs` on a pushed prediction was measured during the
previous White response, which `pushedPredictionHit` records. `engineCycleMs`
and `aiWaitMs` are game constants, not observations.
Each candidate records the full input to the opponent choice — the
simulator-fitted priors and every valuation term `spec/go-ai.md` lists — which
is enough to recompute why an opponent was chosen and to detect live-prior
drift without shipping or importing the game implementation.

Investment decisions use the same snapshot-plus-transition pattern. The
`fleet.infrastructurePlan` and `hacknet.plan` topics capture the horizon,
available and granted cash, valuation inputs, the selected candidate, the top
ranked alternatives, the uncapped candidate count and rejection evidence. The
full observed quote menus remain in the surrounding topic for offline
recomputation. Hash rankings additionally
carry capacity/affordability, the forgone cash-sale value and estimated net
value. `stock` posts to the same arbiter (`position`,
`working-capital` and the unlock rungs) and indexes the same way, with the
coarsest signature of the three: its plan is rebuilt every 500 ms against a
market that re-prices every tick, so every money figure on it drifts
continuously and only the symbol, side, unlock rung, action set, liquidation and
funding outcome are signed. Its `investment.result` doubles as the trade log —
one event per executed batch, keyed on `lastResult.at`, because the topic
carries only the newest result and the trades are otherwise unrecoverable.
`investment.decision`, `hash.decision`, `investment.result` and
`hash.result` form a compact index over those snapshots: they fire when the
winner, hold/funding state, or outcome changes, not once per sample. The raw
topic stream remains the authoritative high-frequency history; the events make
transitions easy to find in replay and fit in the UI's bounded event ring. The
viewer additionally folds them into a retained, coalesced decision log
(`ui/app/project.ts`) rendered by the arbiter drawer, so a refusal repeated
every pass survives ring eviction as one episode with a count.

Faction planning follows that pattern too. `factions.plan.context` records the
planning horizon and route, augmentation-count goal, income, available/granted
cash, work-slot grant, donation threshold, and augmentation price-queue state.
The objective records the committed **portfolio** — the ordered set of faction
pushes with their reputation targets, value rates, unlock/rep/money ETA
components, favor after install, and purchase versus donation cost — plus the
budget sweep it was chosen from (`horizonCurve`, one row per candidate cycle
length). `intent` and `runnerUp` remain the head and second member, so consumers
that predate the set read them unchanged. Standings, invitations, gates, offers,
and ownership stay in the surrounding faction topic.

During the final sweep, `factions.plan.drainCosts` separates the remaining
augmentation purchases, reputation-unlock donations, and pure-favor donations.
The total is the current transaction reserve, while `drainCeiling` remains the
frozen starting budget.

`progression.plan.pace` carries the fitted cycle-progress exponents and the
measured reset overhead. It is a DIGEST for the same reason everything else here
is: the samples it is fitted from are up to 240 `CyclePoint`s that stay in
progression's memory, and `factions` needs only the exponents to price a
reputation gap at the rate it will actually be earned at. `faction.decision` indexes changes to the
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

Client behavior (`game/lib/telemetry.ts`): byte-bounded buffer of
pre-serialized records (4 MB; drops oldest debug first, then oldest of
anything, reports `telemetry.dropped`), reconnect with 1s→30s backoff (same run
id, seq continues — gaps are visible), final flush in `ns.atExit`. Bounded in
BYTES rather than records because state payloads vary by three orders of
magnitude, and amortized rather than per-push — at the old 5,000-record cap
every push was O(n) for as long as the hub stayed down.

## Acquisition is not telemetry

The script reads the game and stores the result in its own game-state copy
(`game/lib/state.ts`), keyed by StateMap. That happens in every build. The
controller decides from that store — the capability gates it reads are what
gate the feature drivers — and telemetry is the optional extra step that also
sends the store over the wire.

The store is the single write target for every acquisition path: the sweep
scan, `ns.getPlayer`, the gate batch, all local, direct and priced probes, the
dispatcher rollup. `set` / `merge` mark keys dirty; `game/lib/telemetry-sink.ts`
publishes the dirty set once per tick and is the only module that touches
`Telemetry` at all. Probe failures and skips are recorded as store fields, not
emitted as events at the call site; the sink diffs them so an unaffordable
probe reports once per *price* and a failing one once per *message*.

## Compile-time elimination

`tools/build.ts` defines `__TELEMETRY__` per build (`true` default, `false`
with `--perf`) and drops `TELEMETRY`-labelled statements in performance
builds. The hard rule, enforced by `tests/build-perf.test.ts`:

> Telemetry may only **send** state the script already holds. Every getter
> and probe runs unconditionally and writes to the game-state store;
> `TELEMETRY: if (__TELEMETRY__)` wraps the send and nothing else. A `--perf`
> build must be behaviourally identical to a telemetry build — only quieter.

esbuild drops the labelled branch — including payload construction — then
tree-shakes the sink and the telemetry client out of the bundle. This avoids
syntax minification, which would rewrite bracketed ns member access into dotted
calls and change RAM accounting. `shared/` code never references `__TELEMETRY__`;
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
`/runs/:file` for stored JSONL replays. The hub also permanently owns the
Remote File API port (12525 from `bitburner.config.json`) so the game stays
connected instead of failing auto-reconnects while no sync is listening;
POST `/sync` builds and pushes over that live connection (see
`spec/architecture.md`). `ui/store.ts` handles persistence,
metadata, the tail ring, and state reduction per install artifact. The picker
groups artifacts by lineage and labels leaves with the in-game BitNode name,
install ordinal, short date, and duration.
