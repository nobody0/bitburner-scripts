# The ns proxy

How every home-side ns call in this project is made, and why it costs the
bundle nothing. Replaces the RAM dodger (`stubCall`, ported from
`nobody01/bitburnerscript@2023`), which this supersedes wholesale; the shape is
ported from `bitburner-2024`, `servers/home/scripts/nsProxy.ts`.

## The two facts everything follows from

**1. Bitburner bills by member NAME, across the whole bundle, whatever the
receiver.** The static analyser walks the source for member accesses whose
property name matches an ns function and charges for each one it finds. It does
not care what object the member sits on: a local variable called `run`, a
property called `exec`, `RegExp.prototype.exec` — each bills the full price of
the ns member of that name (`game/dnet/attempt.ts` records this at length; it
is how a `.exec` on a regex costs 1.3 GB).

And `main.js` is not one source file. The controller, every feature driver, every
probe and the fleet sweep compile into a single bundle, so **one dotted ns
member anywhere under `game/lib/**` is charged to home**, whatever module it
was written in.

> So the call surface is a **string path**. The string is the only mention of
> the member anywhere in the bundle, and the analyser never sees a member
> access at all.
>
> ```ts
> const server = await nsp("getServer", "n00dles");
> await nsp("singularity.joinFaction", faction);
> const t = await nsp("formulas.hacking.hackTime", server, player);
> ```

The path is fully typed. `AutoPath` autocompletes it against `NS` and infers
the argument list and return type, so a wrong path is a compile error rather
than a process the game kills at runtime — which is the whole improvement over
the dodger, where the price list and the call were two hand-maintained
statements of the same fact with nothing tying them together.

**2. One Netscript call per script at a time.** While a script's `ns` is inside
an awaiting call, `env.runningFn` is set and every other call on that same
object throws CONCURRENCY ERROR. This is the single line the darknet prober's
whole design rests on (`game/dnet/prober.ts`), and it is why a resident parks
on a bare unresolved Promise and **never** `ns.asleep` — sleeping is a call,
and it would make the lent `ns` useless while looking perfectly idle.

## The mechanism

A **resident** (`game/lib/ns-resident.ts`, synced as `lib/ns-resident.js`) is
one process exec'd with a flat `ramOverride` that publishes its own `ns`
through the launch rendezvous (`game/lib/launch-shared.ts`) and then parks. The
proxy (`game/lib/ns-proxy.ts`) holds that object and calls through it, so every
call is billed to the resident's allocation instead of to `main.js`.

Nothing is serialized through ports or files. Every script is an ES module in one browser realm, so the
`ns` crosses as a live reference and a proxied call is an ordinary in-realm
function call — results, thrown errors and pending promises all pass through
unchanged, and `await` is native. Calls on one resident are still serialized by
its promise tail, because Netscript permits only one active call per PID.

Per call:

1. **`exec` routes to `nsMain`** and returns. See below.
2. **Memo hit** — the resident has already paid for this member, so call it.
   A function's cost is charged ONCE per running script, so the twentieth
   `getServer` is free.
3. **Price it** with `getFunctionRamCost` (itself 0 GB, and it already folds in
   the singularity 16/4/1 multiplier, so this is right at every SF4 level and
   inside BN4 without the caller knowing which). An unpriceable name — a
   renamed API — costs the conservative 80 GB ceiling rather than pricing as
   free, because under-allocation kills the resident while over-allocation only
   makes it respawn larger.
4. **Respawn if it does not fit**, then resolve the path, memoise it, call it.

### Recycle, grow and the boot ladder are one branch

The resident does not have a fixed size. The placer is asked for a **range** —
the floor this call needs, and the budget the proxy would like — and answers
with what it granted. Everything follows from that one signature:

| situation | what happens |
|---|---|
| budget full | respawn at the same size; the memo resets |
| one call priced above the whole budget | the floor rises; the placer finds a host that fits |
| a bigger host has since rooted | the next respawn is simply granted more |
| nothing can meet the floor | refuse the grant and wait — see below |

So there is no separate "sized proxy" API for the expensive calls, and no
ladder logic for the early game. At cold boot the only host is home's reserve
and the resident takes that; as `n00dles` and then `foodnstuff` root, it grows.
The pre-SF4-level-3 singularity reads (48–80 GB) and
`singularity.destroyW0r1dD43m0n` (32× the BitNode multiplier) arrive at exactly
one code path — the floor rising — and nowhere else.

A grant **below** the floor is refused rather than accepted: a resident placed
on a block too small for its pending call is killed mid-call for overrunning,
which is strictly worse than waiting.

### `nsMain`, and why `exec` is special

`game/main.ts` publishes its own `ns` as `globalThis.nsMain` before anything
else. That process never returns, so it is the one long-lived `ns` in the realm
— and the one that has statically paid for `exec`'s 1.3 GB.

Every resident is launched through `nsMain.exec`, and every proxied `exec`
routes straight back to it. Two consequences:

- **The bundle pays for ordinary proxied `exec` exactly once**, and residents
  normally never pay for it. `nsMain.exec` in `game/lib/ns-proxy.ts` is the ONE deliberately
  dotted ns member in the whole home-side bundle.
- **Every proxied `exec` is issued from home**, which holds the TOR edge to
  `darkweb`. The dodger needed a `pinHost` escape hatch for exactly that case
  (a stub the broker placed elsewhere would `scp` fine and then get a silent
  `0` from `exec`). That hatch is gone, because the property now holds by
  construction. `ns.scp` was always distance-free and never needed it.

### Atomic resident leases for PID-bound authority

Some APIs grant authority to the calling PID. BN15's
`dnet.connectToSession(host, password)` is the important case: routing the next
`exec` through `nsMain`, or recycling the proxy between the two calls, loses the
session even though both calls succeeded independently.

`nsp.guaranteeFit(paths, callback)` is the explicit exception to ordinary exec
routing. It prices the declared union before the callback begins, respawns at a
large enough allocation when necessary, and occupies the resident's serial tail
for the entire callback. The callback receives a lease-local call surface which:

- runs every declared call, including `exec`, on that exact resident PID;
- rejects undeclared paths instead of risking a dynamic-RAM overrun; and
- cannot be interrupted by another proxy call, recycle, or `free()`.

The dnet controller declares `dnet.connectToSession + exec` as one lease when it
starts a job on a stasis-linked host. If the engine refuses the exec, the
controller retries the whole pair, so the retry obtains a fresh session on the
resident that performs that retry's exec.

### Two residents

`game/lib/proxies.ts` publishes them on `globalThis`, so the darknet
controller — a separate bundle — shares them rather than paying for a second
set.

- **`nsp`** — everything. Reads, feature actions, the fleet sweep.
- **`nspLong`** — calls that AWAIT for a long time: a backdoor walk, a Go turn,
  grafting, `workForFaction`. Fact 2 means a minutes-long await holds its
  resident completely, so putting those on `nsp` would stall every read in the
  automation behind them.

Calls on one resident are serialised through a promise chain for the same
reason. A synchronous call settles in its own turn, so for those the chain
costs a microtask; a long await deliberately holds its resident for the whole
flight, which is what `nspLong` exists to contain.

Both are **lazy** — no process is exec'd until the first call.

## The bootstrap

`main.js` owns `ns.exec` and nothing else. That is the point of the whole
design, and it means the entry script cannot scan, cannot root and cannot copy
— each of those is a billable member. So the fleet the residents want to stand
on has to be brought up *through a resident*, and the first one has to be
placed knowing nothing.

It is placed **blind, by arithmetic**. A fresh game has 8 GB of home RAM and
`start.js` costs 4.1 GB while it replaces itself with the 3.2 GB `main.js`, so the
controller begins within the fresh 8 GB home budget. Once running, `main.js`
owns `exec`; the wrapper is gone. The initial resident is placed
without measuring — measuring would itself need a resident. That temporary home
resident gets a 3.5 GB budget and one job:

1. `nuke` and `scp` the payload to **`foodnstuff`**, else **`n00dles`**. Both
   are hardcoded on purpose: they exist in every BitNode, need hacking level 1
   and **zero open ports**, so `nuke` alone roots them on the first tick of a
   fresh game with no fleet knowledge at all. Discovering that by scanning
   would need the resident we are trying to place. Both are also near-worthless
   to the batcher, so parking a resident there costs the farm almost nothing.
2. Read the host's `getServerMaxRam` (0.05 GB — measured, not hardcoded).
3. Point the placer at it, then **recycle**: the residents respawn on the new
   host and the temporary home resident dies, handing its 5.1 GB back.

`foodnstuff` is tried first because its 16 GB is what the main resident wants.
Everything after this line is proxied, and the controller later swaps in the
fleet-wide placer, which can grow the resident onto something bigger still.

Failing both candidates is not fatal — the residents simply stay on home and
the ordinary fleet sweep picks the problem up.

`game/lib/bootstrap.ts`.

## Placement

`placeResident` in `game/lib/controller.ts` picks the largest block the fleet
can offer within the requested range, preferring the arena hosts the farm
planner already keeps clear over a batcher host whose RAM the dispatcher wants
back, and takes a real `Heap.reserveOn` lease for the resident's life.

The arena (`shared/ram/broker.ts`) survives the dodger because its job was
never only to admit stubs: its published reserves are what make the farm
planner keep that RAM farm-free and cooperatively stop share workers
(`shared/strategy/dispatch.ts`). What is gone is everything that existed to
serialise transient stubs — the realm-wide dodge FIFO, the per-dodge lease
handshake, the ten-second handoff watchdog and `DodgeExecError` — and with the
FIFO went the starvation carve that grew the arena for a queue entry that had
waited five seconds.

`ramArena` is now a pure function of the fleet and of what the residents are
asking for. It reserves home unconditionally, the bootstrap host whole (as a
floor, before any resident stands on it — `game/lib/bootstrap.ts` is why that
timing matters), and for each resident `max(held, wanted)` on the host it
stands on, falling back to the SMALLEST host that can hold `wanted` when its
own cannot. That last clause is the carve, and it is what keeps the
pre-SF4-level-3 singularity reads placeable: a resident whose floor has risen
above every packed host would otherwise spin on `proxy.slow` for ever, because
under the proxy there is no queue entry left to starve on its behalf. The ask
is a standing fact, so it needs no evidence and collapses on its own the moment
the resident stops wanting the room.

## Failure

- **A refused `exec` never throws.** `exec` returns 0 for a transient condition
  as readily as a permanent one, so the retry is unbounded: fast yield-only
  passes to win the reap race, then escalating sleeps capped at one second.
  What surfaces instead of a crash is telemetry — `proxy.slow` at one second
  (re-emitted at 10 s and 60 s, then every minute), one tprint per incident at
  30 s, `proxy.recovered` when it lands. A resident that cannot exec means its
  reservation is violated; throwing would trade a visible stall for a dead
  controller.
- **A resident killed mid-call HANGS its caller.** This is the one failure mode
  that is worse than the dodger's, and it is worth stating plainly: a dodge
  stub had a ten-second watchdog, whereas a killed resident simply never
  settles the promise being awaited. So a fleet-wide kill sweep must spare
  every resident — `reclaimFleet` handles their hosts per-process, using
  `proxyResidents()` for the ones it is not itself calling through, and the
  acting resident's own identity (`self`) for the one it is.
- **A throw from the ns member propagates to the caller** unchanged, and the
  resident keeps working. Guards that exist because an API THROWS when
  unavailable — `gang.*`, `bladeburner.*`, `grafting.*`, `stock.getPosition`,
  `getBitNodeMultipliers` — are unchanged by any of this; they were never about
  RAM.

## Rules for writing calls

- **Never write a dotted ns member name** in anything that compiles into
  `main.js` or another game script. Not `ns.getServer(...)`, and not a local
  or property named `exec`, `scan`, `read` or `run` either. `String.match`, not
  `RegExp.exec`. `tests/ram-budget.test.ts` is the backstop.
- **Batching is no longer a discipline.** The dodger demanded loops be hoisted
  inside one closure, because a stub priced its whole method list on every
  launch. A resident prices each member once and repeats are free, so plain
  sequential `await` lines are now both clearer and cheaper. `SteppedProbe`
  existed only to keep a stub's PEAK allocation placeable and is retired
  (`spec/features.md`).
- **Long awaits go on `nspLong`.**
- **From `game/dnet/**`, import ONLY `nsp`/`nspLong` from
  `game/lib/proxies.ts`** — never `initProxies` or `createNsProxy`. Measured on
  the built artifact: reading the handle off `globalThis` tree-shakes the
  resident machinery away and the darknet controller stays at 2.05 GB, while
  referencing `initProxies` retains it and the bundle gains `exec`, costing
  1.3 GB.
- Sequential awaits are NOT atomic where a single stub closure was. Feature
  drivers tick one at a time, so features cannot interleave with each other;
  the darknet controller is genuinely concurrent, but touches nothing the
  work-slot path does. Where ordering matters (`career`'s disarm → start →
  re-read → arm), the ordering is documented at the call site.

## What the darknet keeps, and why it is not an exception

`game/dnet/prober.ts`, `agent.ts` and `orders.ts` keep raw `ns.exec` and the
lender model. None of this is about RAM:

- a darknet session belongs to the calling PID and cannot be transferred, so a
  resident elsewhere cannot win one on the controller's behalf;
- `ns.dnet.probe()` returns adjacency for the CALLING host only;
- `ns.exec` onto a darknet host reaches only self-and-connected, or a
  backdoored/stasis-linked target.

Those are questions of **location and identity**, which no proxy can answer.
See `spec/dnet.md`.

`hands.ts` was the last holdout and is now retired. Its borrow sites in the
darknet controller were the global, host-independent reads — `dnet.getServerDetails`,
`dnsLookup`, `getServerMaxRam`, `kill`, `isRunning` — and those now go through
`nsp` like everything else, awaited at the call site.

What kept it alive was the worry that awaiting inside a derive pass would let
probers and agents interleave, which is the bug class the `foldedProbes` WeakSet
and the first-probe barrier exist to prevent. That worry was about the
*rendezvous* methods, not the ns reads: `claimPlanted` and `snapshot` consume no
ns at all, so they stayed synchronous and the interleaving window never opened.
