# RAM dodging

Port of the proven `stubCall` design from the predecessor scripts
(`/Users/bob/git/bitburner-legacy/src/_lib/stub-call.ts`,
`nobody01/bitburnerscript@2023`; itself credited there to a Discord thread).
Bitburner charges a
script's RAM by the ns functions its source visibly references. A *dodge*
spawns a temporary stub script that has bought a dynamic RAM budget, runs one
closure with the stub's own ns, hands the raw result back, and dies — the
caller pays only `ns.exec` (1.3 GB).

## Mechanics (`game/lib/dodge.ts`, `game/lib/dodge-stub.ts`)

- All scripts share one JS realm; the rendezvous is four slots on
  `globalThis` (`dodge_func/cb/reject/running`) — live references, no
  serialization, class instances survive.
- The stub (`lib/dodge-stub.<build-id>.js`, a versioned synced entry) references no ns members;
  its RAM budget is declared at launch via `ns.exec(..., { ramOverride })` —
  `dodge(ns, fn, budgetGb)` sizes each call (default 2.5 GB dynamic; pass more
  for e.g. contract batches). One stub file serves every budget. The reference
  scripts default to 6.6 GB (5 + 1.6) and document their exceptions inline:
  graft 7.5, `codingcontract.attempt` 10, `getInfiltration` 15,
  `destroyW0r1dD43m0n` 32, and a BN1 target of 3.5 to fit an 8 GB home.
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

`Dodger.batch(fn)` is the escape hatch: many calls in one stub launch,
mirroring left to the caller.

## Placement (`shared/ram/placement.ts`, `game/lib/ram.ts`)

A dodge is not confined to home. `dodge(ns, fn, gb, { host })` runs the stub
anywhere the stub file exists and the RAM is free; the sweep scp's it to every
rooted host alongside the worker. Policy, in one function:

- budgets at or below 4 GB prefer **home** — a remote hop buys nothing, and
  home is the one host guaranteed to hold the stub;
- larger budgets take the **smallest fleet host that fits**, so large
  contiguous blocks stay available for hack ops, which cannot be split;
- home is the fallback, not the preference, once the budget is big;
- a host without the stub is not a candidate at all: `ns.exec` of a missing
  file returns 0, which is indistinguishable from "full" and would burn every
  retry looking like a RAM shortage.

Placement **takes a heap lease** (`Heap.reserveOn`) for the life of the stub,
atomically with choosing the host. Choosing and reserving as two steps leaves a
window for the dispatcher to take the RAM in between, and the failure is
invisible — `exec` returns 0 and the probe reports unaffordable on a host that
had room a microsecond earlier. Without any lease at all the stub occupies RAM
the heap believes is free, and the two allocators fight indefinitely.

Two consequences that bite if forgotten:

- **`reclaimFleet` must handle the stub's own host per-process.** The cold-boot
  reclaim runs *inside* a dodge, which may now be on a client; a blanket
  `killall` there kills the stub doing the killing.
- **`reapStrayScripts` is already safe** — it only kills `RETIRED_SCRIPTS` and
  worker-script processes with an unregistered op id, so a remote stub is
  untouched.

## Constraints

- One dodge in flight at a time; each spends one stub launch (~2 game ticks).
- Keep home RAM headroom so `ns.exec` of the stub never fails. The reference
  scripts sidestep this by passing a `hostname` to `stubCall` and running the
  stub on a rooted client (they run a 32 GB `destroyW0r1dD43m0n` stub that way);
  the `globalThis` rendezvous is realm-wide, so a remote stub returns its result
  identically. See `shared/ram/reserve.ts` for the home-reserve fallback.
- Dodging trades wall-clock latency for RAM — never dodge inside
  timing-critical hack/grow/weaken windows.
