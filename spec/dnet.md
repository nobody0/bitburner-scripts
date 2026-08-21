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
| `ns.exec` on a darknet host | a session **and** a direct connection, backdoor, or stasis link — including `darkweb`, whose only direct connection is from `home` (see below) |

So getting *data* around is nearly free, and getting a *running process* to
depth *n* is the hard problem. Everything upstream of that is a credential
problem — **except the first hop, which is free.**

`darkweb` is a deliberate special case (`DarkNet/controllers/NetworkGenerator.ts`
`initDarkwebServer`): `modelId: NoPassword`, `password: ""`, `blockedRam = 0`,
`maxRam = 16`, `hasAdminRights = true`, `isStationary = true`, and `depth: -1`.
`isAuthenticated` short-circuits true for it, and so does the `exec`/`scp` gate —
*"We always are authed to ourselves and DarkWeb. Early-out past the last
checks."* (`DarkNet/effects/offlineServerHandling.ts:98-101`). So an agent can be
deployed to `darkweb` and run there with no credential, no session and no
cracking, on a full 16 GB, forever — it never moves.

**But read the check ORDER, because the early-out is narrower than it looks.**
`checkDarknetServer` evaluates `requireDirectConnection` *before* reaching that
early-out (`offlineServerHandling.ts:82-100`), and `ns.exec` passes
`requireDirectConnection: true` (`NetscriptFunctions.ts:641-646`). The early-out
skips the admin-rights and session checks; it does **not** skip the connection
check. Only `home` holds the TOR edge to `darkweb`, so:

> **`ns.exec` onto `darkweb` works from `home` and from nowhere else.**

`ns.scp` passes no connection requirement at all (`NetscriptFunctions.ts:769-773`),
so *copying* to `darkweb` works from any host — which is why the seeding dodge may
be placed anywhere to `scp`, but must be pinned to `home` to `exec`. A dodge stub
landing on an arbitrary leased fleet host would `scp` successfully and then get a
silent `0` from `exec`, which is indistinguishable from "the host is full".

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

## The rule: expiry

> **No darknet fact may be treated as current without checking its age against
> the mutation clock.**

An unstamped topology map or credential table is a map of a world that may no
longer exist. Expiry is per fact CLASS, and derived rather than chosen
(`shared/strategy/dnet/knowledge.ts`):

| Class | Examples | Invalidated by |
|---|---|---|
| `identity` | `modelId`, `passwordFormat`, `passwordLength`, `difficulty` | **never by age** — only by the host disappearing, since a host that returns is cleaned and given a new password |
| `position` | `depth` | a move |
| `topology` | `neighbours` | a move, a disconnect, *or* a new connection — three compounding rates, so edges are the shortest-lived thing we hold |
| `resource` | `blockedRam`, `maxRam`, `hasSession` | a restart |

**Unless the host is outside the clock altogether.** Every branch of
`mutateDarknet` picks its victim from `getAllMovableDarknetServers`
(`DarkNet/utils/darknetNetworkUtils.ts:69-78`), which skips any server that
`isStationary` or `hasStasisLink` — so move, delete, disconnect and restart all
miss it alike. (`isImmutable`, `NetworkMovement.ts:227`, is a second and narrower
guard: it covers stasis links but *not* `isStationary`, so the pool exclusion is
what does the work for both.)

Immunity is therefore a property of the HOST, not of a fact class: nothing about
such a server ages, and since it cannot be deleted it is never forgotten either.
Upstream marks `darkweb` and the labyrinth stationary. `darkweb` is the case you
meet first, and showing its depth expiring in a minute was the bug that made this
worth writing down.

Rates add, times do not: a fact invalidated by any of several events dies sooner
than the fastest of them alone. The one number not derived is `TRUST_FRACTION`,
the fraction of the expected time at which we stop believing a fact; it is a
judgement call and is named rather than buried. This repository already names that bug class for prestige — *"a topic that
survives the reset is live data from a dead node"* (`spec/features.md`) — and the
darknet has the same hazard, just far more often.

In practice:

- Knowledge lives as `HostFact<T> = { value, at }`, not as a bare value, and a
  `ReportHost` is stamped by the job that *looked* rather than by the drain that
  collected it. Facts merge last-writer-wins on that observation time, never on
  arrival order — a drain is a batch, and two residents adjacent to the same host
  will both describe it.
- A fact older than its expiry is *shown* but excluded from decisions, and the
  decision says which fact it is waiting on.
- A host unseen for long enough is **forgotten**, not remembered. Darknet hosts
  go offline permanently; keeping one forever is fabricating a map.
- **There is one host representation.** Home's own one-hop probe reports in the
  same `ReportHost` shape an agent does and folds into the same knowledge; the
  panel reads that fold and nothing else.

There is no per-fact record of *which* agent saw it. That was carried for a
while, and it was worth deleting rather than fixing: no decision ever read it,
and what the panel actually displayed was a hardcoded `darkweb` standing in for
residents scattered across the net — worse than no attribution at all. The
generation is likewise checked once, on the whole rendezvous (`overseerIsLive`),
because agents outlive controllers and what has to be refused is the channel
rather than the record.

`tests/dnet-staleness.test.ts` pins these as behaviour.

### A note on transport

**One convention, as engineering rather than fair play: the realm carries the
conversation, and every entry in it is expired rather than trusted.**

An earlier version of this feature pushed observations, credentials and orders
over three netscript ports, on the reasoning that a serialized queue forces a
design to say what it knows and when. The ports are gone. Every script the game
runs shares one JS realm, so the controller's own object is reachable from home
directly, and three encoders, three decoders, three version markers and three
rejection paths were removed with them.

That is not a shortcut past a game rule. Ports are themselves documented as
*"shared across all hosts"*, cost 0 GB and need no session, so the realm is a
faster version of a sanctioned mechanic rather than a new capability. What
preserves the challenge is enforced by the engine, not by the transport:
sessions are per-PID, `probe()` is host-local, `setStasisLink` and
`phishingAttack` only work from the target, and the network kills your scripts.
None of that is helped by a slower message.

There is also something a port cannot do. The controller describes work it
cannot afford to perform — a closure calling `authenticate`, `scp` and `exec`
through bracket notation on an ns it does not own — and hands it to a process
that can. That is a live function reference, and it is the mechanism that keeps
the controller at 1.65 GB while the work it plans costs several times that.

The hazard the port convention was protecting against is real: a realm map holds
live references that outlive the servers they describe, and out there servers are
deleted mid-sentence. So the realm is allowed only under four rules, each
enforced in code rather than remembered:

1. **Entries are expired by the controller, never trusted.** A resident that
   stops beating is swept and its queue retired; a job that stops settling is
   timed out and its promise rejected. A promise that never settles is a process
   that was killed, and out there that is the common case.
2. **The rendezvous holds work, never knowledge.** `drain()` hands each
   observation to home ONCE, and home folds it into knowledge it owns — so a
   controller dying loses scheduling, not the map.
3. **A foreign generation is refused**, by the controller's election and by every
   agent at boot. Agents outlive controllers, so a live script from a dead run
   really can be talking to us.
4. **A credential lives only in the realm and in home's vault.** It is never
   published to a topic and never written to a log; what the panel gets is a
   boolean. `stripCredentials` enforces that recursively at the one place
   anything is recorded.

`tests/dnet-staleness.test.ts` pins the fourth, and `sim/tests/dnet-session.test.ts`
pins the engine rules the first three are compensating for.

## The shape that follows: a controller, residents, and a spawn chain

Three constraints above decide the whole architecture, and it is worth writing
the chain of reasoning down once.

**Home cannot play the feature.** `probe()` is host-local, so from `home` the
darknet is one host wide, and a session belongs to the PID that won it, so a
dodge stub cannot win one on the controller's behalf.

**So something long-lived has to live out there** and hold the accumulated map.
It must not die, which means it can never `spawn` — `spawn` kills its caller.

**And it should not `exec` either.** `exec` leaves the caller alive, so a
controller that launched its own work would need both allocations at once. On a
darknet host, whose owner may have blocked almost all of its RAM, that is
usually RAM we do not have.

So the controller does not launch anything. It keeps a QUEUE per host, and each
host keeps exactly one **resident** — the only thing that can start work there.
When the resident takes a job it `spawn`s into it with `spawnDelay: 0`, which
kills the resident and starts the job immediately on the same host; the job runs
and spawns back. A host therefore holds one AGENT process at a time, and its peak
RAM is the largest single job rather than the sum of the work. (`darkweb` holds
the controller as well, since that is where it lives.)

`spawn` costs 2.0 GB against `exec`'s 1.3, and every job pays that tax on the way
back. It is still the cheap option, because the alternative is holding two
allocations at once — and because a host left with no resident cannot be repaired
from outside: planting one needs a session AND adjacency.

**The rule that nearly makes this impossible.** A session belongs to the PID, and
`spawn` ends the PID, so a job that authenticates cannot hand its session to the
next process. `connectToSession(host, password)` re-opens one at any distance,
with no delay and no connection requirement, for **0.05 GB**. That single cheap
call is what makes the whole chain affordable.

It has one precondition that is easy to miss and expensive to assume away:
`connectToSession` passes `requireAdminRights`, and only a successful
`authenticate` ever sets that. So it re-opens a session on a host we have already
opened once — it cannot open a NEW one. That matters because the logs hand us
passwords for hosts we have never touched, and the first use of one of those has
to be the 0.4 GB call. `plantJob` tries the cheap path and falls back.

The controller costs 1.65 GB static — the base plus `getHostname`. It describes
jobs it cannot afford to run by writing them as closures over an ns it does not
own, so the analyser charges the agent's declared `ramOverride` instead. That is
the same trick `game/lib/dodge.ts` uses, and `tests/ram-budget.test.ts` checks
the declared method lists against the calls those closures actually make —
because the simulator does not model the dynamic-RAM check, so an under-declared
job passes every sim run and dies in the game.

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
