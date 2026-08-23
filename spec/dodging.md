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

- There is exactly one generic FIFO. A dodge waits for the preceding stub to
  hand off its result, invokes its closure once, and releases the FIFO. Go has
  no lane, host ban, watchdog, or execution mode of its own.
- `lib/dodge-stub.js` references no ns members. Its RAM is declared with
  `ns.exec(..., { ramOverride })`, priced from the exact methods the closure can
  invoke. Every launch receives one monotonically increasing integer argument;
  that is only a distinct process key because Bitburner identifies a process by
  filename plus args. Semantic launch data stays in the realm handoff.
- The stub invokes the closure synchronously and envelopes the raw return value.
  If the ns method returns a Promise, the controller receives that same Promise;
  the stub exits and its heap lease is released before the controller awaits it.
  The Promise's duration therefore never owns the dodge FIFO or RAM.
- A dodge closure may synchronously invoke ns and return its raw value or
  Promise. It must not await and then use `stubNs` again. Multi-step asynchronous
  Netscript orchestration is a worker, not a dodge.
- Launch has a ten-attempt exec retry loop with a realm-timer yield between
  failures. Two trailing microtasks let the engine reap the completed stub.
- Inside a dodged closure, call ns members with **bracket notation on the
  closure's ns argument** (`stubNs["getServer"](host)`) or the static parser
  charges the calling bundle anyway.

## Placement (`shared/ram/broker.ts`, `game/lib/ram.ts`)

A dodge may run on any rooted, deployed host with the stub. The broker first
uses its arena, then the smallest remaining free block that fits; home is an
ordinary eligible host. Before a stable arena is affordable, a request queues
and may reclaim share or an idle pooled farm worker. After five seconds of
proven starvation it carves only that request's transient reserve, selecting a
host large enough for the recurring 13.6 GB dodge ceiling so a 6.6 GB Go call
uses foodnstuff rather than promoting CSEC. The stable arena ladder is bootstrap
home, n00dles, then full foodnstuff.

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

- Only one stub handoff is in flight. Promise settlement is unrelated and may
  overlap later dodges.
- Keep home RAM headroom so `ns.exec` of the stub never fails. The reference
  scripts sidestep this by passing a `hostname` to `stubCall` and running the
  stub on a rooted client (they run a 32 GB `destroyW0r1dD43m0n` stub that way);
  the `globalThis` rendezvous is realm-wide, so a remote stub returns its result
  identically. See `shared/ram/reserve.ts` for the home-reserve fallback.
- Dodging trades wall-clock latency for RAM — never dodge inside
  timing-critical hack/grow/weaken windows.
