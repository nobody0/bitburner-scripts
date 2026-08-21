# RAM dodging

Port of the proven `stubCall` design from the predecessor scripts
([`src/_lib/stub-call.ts`](https://gitlab.com/nobody01/bitburnerscript/-/blob/43e8585/src/_lib/stub-call.ts),
`nobody01/bitburnerscript@2023`, commit `43e8585`; itself credited there to a
Discord thread).
Bitburner charges a
script's RAM by the ns functions its source visibly references. A *dodge*
spawns a temporary stub script that has bought a dynamic RAM budget, runs one
closure with the stub's own ns, hands the raw result back, and dies — the
caller pays only `ns.exec` (1.3 GB).

## Mechanics (`game/lib/dodge.ts`)

- All scripts share one JS realm. One dodger implementation selects a lane
  descriptor containing its four rendezvous slots, stub script, busy policy,
  and watchdog policy. Live references cross the slots without serialization,
  so class instances survive.
- The **default** lane uses `dodge_func/cb/reject/running`, waits for a busy
  owner, has a 10 s watchdog, and cleans its slots unconditionally. The
  **long** lane uses `go_dodge_func/cb/reject/running`, rejects overlap with
  `a Go turn is already running`, has no watchdog, and only clears slots it
  still owns. Go's `makeMove`, `passTurn`, and recovery
  `opponentNextTurn` calls await the opponent; they must not hold up ordinary
  probes or be timed out while their worker remains alive.
- **One** tiny stub serves both lanes: `lib/dodge-stub.<build-id>.js`, which
  reads its lane from `ns.args[0]` and selects the matching slot set. `ns.args`
  is a property rather than an API call, so the lane argument is free and the
  base stays 1.6 GB; a second file differing only in four slot names was pure
  duplication scp'd to every rooted host. It references no ns members;
  its RAM budget is declared at launch via `ns.exec(..., { ramOverride })` —
  `dodge(ns, fn, budgetGb)` sizes each call (default 2.5 GB dynamic; pass more
  for e.g. contract batches). Each stub file serves every budget. The reference
  scripts default to 6.6 GB (5 + 1.6) and document their exceptions inline:
  graft 7.5, `codingcontract.attempt` 10,
  `destroyW0r1dD43m0n` 32, and a BN1 target of 3.5 to fit an 8 GB home.
- Both lanes share the same ten-attempt exec retry loop, with `ns.asleep(0)`
  between failures (ported from the predecessor's `src/_lib/stub-call.ts:11-39`;
  ours is `game/lib/dodge.ts`). Promise results are forwarded (not awaited) so
  synchronous
  closures resolve before another script gets a scheduling slot; two trailing
  microtask ticks let the engine reap the stub.
- Inside a dodged closure, call ns members with **bracket notation on the
  closure's ns argument** (`stubNs["getServer"](host)`) or the static parser
  charges the calling bundle anyway.

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

- One dodge per lane may be in flight. A long Go turn does not hold the default
  lane; each call still spends one stub launch (~2 game ticks).
- Keep home RAM headroom so `ns.exec` of the stub never fails. The reference
  scripts sidestep this by passing a `hostname` to `stubCall` and running the
  stub on a rooted client (they run a 32 GB `destroyW0r1dD43m0n` stub that way);
  the `globalThis` rendezvous is realm-wide, so a remote stub returns its result
  identically. See `shared/ram/reserve.ts` for the home-reserve fallback.
- Dodging trades wall-clock latency for RAM — never dodge inside
  timing-critical hack/grow/weaken windows.
