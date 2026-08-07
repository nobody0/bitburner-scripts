# RAM dodging

Port of the proven legacy `stubCall` design
(`/Users/bob/git/bitburner-legacy/lib/stubcall.js`). Bitburner charges a
script's RAM by the ns functions its source visibly references. A *dodge*
spawns a temporary stub script that has bought a dynamic RAM budget, runs one
closure with the stub's own ns, hands the raw result back, and dies — the
caller pays only `ns.exec` (1.3 GB).

## Mechanics (`game/lib/dodge.ts`, `game/lib/dodge-stub.ts`)

- All scripts share one JS realm; the rendezvous is four slots on
  `globalThis` (`dodge_func/cb/reject/running`) — live references, no
  serialization, class instances survive.
- The stub (`lib/dodge-stub.js`, a synced entry) references no ns members;
  its RAM budget is declared at launch via `ns.exec(..., { ramOverride })` —
  `dodge(ns, fn, budgetGb)` sizes each call (default 2.5 GB dynamic, the
  legacy stub's budget; pass more for e.g. contract batches). One stub file
  serves every budget.
- Single-flight global mutex; 10 s watchdog; game-restart guard in the stub;
  promise results are forwarded (not awaited) so synchronous closures resolve
  before other scripts get a scheduling slot; a trailing microtask tick lets
  the game reap the stub.
- Inside a dodged closure, call ns members with **bracket notation on the
  closure's ns argument** (`stubNs["getServer"](host)`) or the static parser
  charges the calling bundle anyway.

## Dodged gets are state sync

`makeDodger(ns, state).call("getServer", host)` is the typed form: result
typed as `ReturnType<NS["getServer"]>`, mirrored into the game-state store
(`game/lib/state.ts`) under `getServer:home`. It mirrors into the *store*, not
into telemetry — reading state is storing state, and sending it is a separate,
optional step (`spec/telemetry.md`). Two getter paths, one store:

| path       | RAM                     | when                              |
|------------|-------------------------|-----------------------------------|
| direct     | static cost per getter  | hot-loop reads you always need    |
| `dodger`   | 1.3 GB exec, per call   | occasional/expensive reads        |

The controller takes the direct path for exactly three reads — `ns.getPlayer`
every 2 s, and `getServerMoneyAvailable` / `getServerSecurityLevel` on the hot
targets in `buildView` — because the dispatcher's 200 ms pass cannot afford a
stub launch. Everything else dodges.

`Dodger.batch(fn)` is the escape hatch: many calls in one stub launch (the
legacy stocker pattern), mirroring left to the caller.

## Constraints

- One dodge in flight at a time; each spends one stub launch (~2 game ticks).
- Keep home RAM headroom so `ns.exec` of the stub never fails (legacy reserved
  12 GB; revisit when the orchestrator manages RAM).
- Dodging trades wall-clock latency for RAM — never dodge inside
  timing-critical hack/grow/weaken windows.
