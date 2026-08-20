# The darknet

`dnet` is the only feature whose work happens somewhere other than `home`. This
document is about that: what the darknet makes impossible, what it makes free,
and the one rule that follows.

The node's own rules are in
[`spec/strategy/bitnodes/bn15.md`](strategy/bitnodes/bn15.md); the feature
machinery is in [`spec/features.md`](features.md). Neither is repeated here.

## What the mechanic actually is

Four constraints, all from `types/NetscriptDefinitions.d.ts`, and every design
decision below is downstream of one of them.

**There is no global view.** `ns.dnet.probe()` returns only the darknet servers
directly connected to *the calling script's own host*. From `home` that is
`darkweb` and nothing else, and `ns.scan` does not enumerate the darknet at all.
A map of the darknet can only be assembled from reports by scripts standing in
different places.

**Sessions belong to a PID.** `authenticate(host, password)` grants a session to
the calling script instance only; the docs are explicit that "other running
scripts will need to use `connectToSession` with the correct password to also get
a session". No channel — file, port or page realm — can transfer one. This is
why a dodge stub cannot win a session on the controller's behalf: the stub dies,
and the session dies with it.

**Transfer is distance-free; execution is not.**

| Operation | Requires |
|---|---|
| `scp` *from* a darknet host | nothing at all |
| `scp` *to* a darknet host | a session — but **no** direct connection, at any distance |
| `writePort` / `readPort` | nothing; ports are shared across all hosts, 0 GB |
| `ns.exec` on a darknet host | a session **and** a direct connection, backdoor, or stasis link |

So getting *data* around is nearly free, and getting a *running process* to
depth *n* is the hard problem. Everything upstream of that is a credential
problem — **except the first hop, which is free.**

`darkweb` is a deliberate special case (`DarkNet/controllers/NetworkGenerator.ts`
`initDarkwebServer`): `modelId: NoPassword`, `password: ""`, `blockedRam = 0`,
`maxRam = 16`, `hasAdminRights = true`, `isStationary = true`, and `depth: -1`.
Both the session check and the `exec`/`scp` gate short-circuit for it —
*"We always are authed to ourselves and DarkWeb. Early-out past the last
checks."* (`DarkNet/effects/offlineServerHandling.ts`). So an agent can be
deployed to `darkweb` and run there with no credential, no session and no
cracking, on a full 16 GB, forever — it never moves.

That is the beachhead the whole feature stands on: from `darkweb`, `probe()`
finally returns the depth-0 servers that `home` cannot see, and cracking starts
from there.

**The map moves, and faster than it sounds.** `getDarknetCyclesPerMutation()` is
`(rateMultiplier × 150) / depth` cycles at 200 ms each, with `rateMultiplier` 1
in BN15 and 2 elsewhere — so at the default labyrinth depth of 10 a mutation tick
lands **every three seconds**, and it gets faster as the labyrinth deepens. Each
tick rolls independently to move servers, sever every connection a host has, add
connections, restart hosts (killing their scripts, keeping their files), delete
hosts permanently, or do nothing.

The two clocks must not be confused. The *net* churns in seconds; any *named
host* is far more stable, because each tick touches only a handful out of
`depth × 8 × 0.6` servers. Those rates are transcribed in
`shared/strategy/dnet/rates.ts` and are what the expiry below is derived from.

**Backdoors buy remote execution, and are priced for it.** A backdoor is the only
unlimited way to `exec` on a host we are not directly connected to. The price is
a global authentication slowdown past a free allowance of only two to four, plus
a 9%-per-tick chance that one backdoored host is restarted — which clears its
sessions and removes the backdoor — and 4% that one is deleted. A stasis link
grants the same remote access *and* total immunity to delete, move and restart,
but there are at most four. So backdoors are the expendable frontier and stasis
links pin what we cannot afford to lose; see `bn15.md` for the full trade.
Instability and mutation remain unrelated mechanics — instability never moves a
server.

Some calls only work from the target itself: `setStasisLink()` takes no host and
pins the calling script's own server, and `phishingAttack()` runs only from a
script on a darknet server. There is no way to reach either from `home`.

The password mechanic — `modelId`, `passwordHint`, `data`, `passwordLength`,
`passwordFormat`, the `2G_cellular` timing oracle, and the eleven `.lit` hint
files that name the model taxonomy — is documented in `bn15.md`.

## The rule: provenance and expiry

> **Every fact about the darknet carries where it came from and when.** No
> darknet knowledge may be treated as current without checking its age against
> the mutation clock.

An unstamped topology map or credential table is a map of a world that may no
longer exist. Expiry is per fact CLASS, and derived rather than chosen
(`shared/strategy/dnet/knowledge.ts`):

| Class | Examples | Invalidated by |
|---|---|---|
| `identity` | `modelId`, `passwordFormat`, `passwordLength`, `difficulty` | **never by age** — only by the host disappearing, since a host that returns is cleaned and given a new password |
| `position` | `depth` | a move |
| `topology` | `neighbours` | a move, a disconnect, *or* a new connection — three compounding rates, so edges are the shortest-lived thing we hold |
| `resource` | `blockedRam`, `maxRam` | a restart |

Rates add, times do not: a fact invalidated by any of several events dies sooner
than the fastest of them alone. The one number not derived is `TRUST_FRACTION`,
the fraction of the expected time at which we stop believing a fact; it is a
judgement call and is named rather than buried. This repository already names that bug class for prestige — *"a topic that
survives the reset is live data from a dead node"* (`spec/features.md`) — and the
darknet has the same hazard, just far more often.

In practice:

- Knowledge lives as `HostFact<T> = { value, at, from, via? }`, not as a bare
  value. Facts merge by last-writer-wins on the observation time, never on
  arrival order.
- A fact older than its expiry is *shown* but excluded from decisions, and the
  decision says which fact it is waiting on.
- A host unseen for long enough is **forgotten**, not remembered. Darknet hosts
  go offline permanently; keeping one forever is fabricating a map.
- Reports carry a generation stamp. Agents outlive controllers (see below), so a
  report from a dead run must be discarded rather than merged.

`tests/dnet-staleness.test.ts` pins all four as behaviour.

### A note on transport, and a rule we did not make

It is tempting to forbid `dnet` from using the `globalThis` rendezvous that the
dispatcher, the dodger and the controller cache all use — on the grounds that
Bitburner runs every script in one page realm, so the realm is a free and
perfectly reliable channel between `home` and a depth-6 host, which is exactly
what BN15's fiction denies.

**We did not make that rule, because the game already grants the same thing.**
`ns.writePort` / `readPort` / `getPortHandle` are documented as *"shared across
all hosts and contents are reset on game restart"*, cost 0 GB, need no session,
and come with `nextPortWrite()` as a free wake signal. The realm is only a faster
version of a sanctioned mechanic. Banning it would have cost us the repository's
existing idioms — including the dodged `dnet.core` probe — and preserved nothing.

What preserves the challenge is enforced by the engine, not by us: sessions are
per-PID, `probe()` is host-local, `setStasisLink` and `phishingAttack` only work
from the target, and the network kills your scripts. None of that is helped by a
faster message.

**One convention, as engineering rather than fair play:** inside `dnet`, prefer a
port to the realm. A port is a serialized queue that the engine resets on
restart; a realm `Map` holds live object references — resolvers, timers — which
silently outlive the servers they describe. A port forces the design to say what
it knows and when, which is the same discipline as the rule above.

## Why the controller cannot play this feature itself

Two independent constraints, both already test-enforced, and together they are
why `dnet` has agent scripts at all:

1. **A session belongs to the PID that won it.** A dodge stub can legally call
   `authenticate("darkweb", …)` — `game/lib/dodge.ts` supports pinning a stub to
   a host — but it dies immediately after returning, taking the session with it.
   Whoever authenticates must be the same process that then `scp`s and `exec`s.
2. **The controller's static RAM is pinned at 3.6 GB.**
   `tests/ram-budget.test.ts` asserts `start.js` costs exactly `START_BUDGET_GB`
   and that `ns.scp`, `ns.getServer` and `ns.scan` are *not* in its billable
   surface. Putting `ns.dnet.*` or `ns.scp` in the controller would break that
   pin, which is the whole reason the dodger exists.

So agents hold sessions and do the work; the home-side driver launches them and
drains what they report.

## Agents outlive controllers

`reclaimFleet` (`game/lib/net.ts`) walks only servers from the ordinary `ns.scan`
snapshot, and darknet hosts are never in it. So a dnet agent survives a
controller cold boot, a build handoff and a page reload — which is precisely the
durability BN15's flavour text asks for, and it comes for free.

The cost is the generation stamp above: a stale agent can keep reporting from a
run that no longer exists.

## Observability

Agents emit their own telemetry, directly, over their own `new WebSocket()` — a
browser global, 0 GB. It is **send-only**, so it cannot become a back-channel,
and a `--perf` build removes it entirely. That removal is the mechanical proof
that no decision depends on it.

The consequence worth keeping is a real metric. Agent telemetry leaves the game
the instant an agent sees something; the controller's `known` state only advances
when a report is drained. A host that appears as `observed` and never becomes
`known` is an agent that died before reporting. The gap between the two panels is
therefore a direct read on **agent mortality**, which — since the transport does
not lose data — is the loss that actually matters out there.

Agents pass their install identity in `ns.args` rather than reading it from the
realm, so `ui/store.ts` groups them into the same run artifact as the controller
while keeping their own `run` id and sequence space. That is the same shape as a
build handoff, which the store already handles.
