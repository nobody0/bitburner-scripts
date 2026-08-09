# Targeting & dispatch (as built)

Picks the best hack target, farms it with HWGW batches, preps the next target
in the background, and switches when it pays. The pure engine
(`shared/strategy/*`, `shared/ram/heap.ts`) runs identically in the simulator
(virtual clock — the A/B oracle) and in the game (thin driver), so a policy
measured in sim transfers directly.

## Cadences and budgets

| Loop | Trigger | Budget | Measured |
|---|---|---|---|
| Dispatcher pass | every 200 ms tick (one spacer) | ≤10 ms | 0.01–0.03 ms |
| Evaluator slice | ≥2 s, `clamp(ceil(N/10),1,8)` targets | ≤2 ms | 0.1–0.9 ms / 8 targets |
| Decision gate | ≥5 s, or invalidation | ≤200 ms | 3–21 ms / 100 targets |
| Sweep | 30 s, dodged | — | scan + root + deploy + heap resync |

Enforced by `tests/heap.test.ts`, `sim/tests/targeting.test.ts` (bench),
`sim/tests/dispatch.test.ts` (bench), and `dispatch.slow` telemetry at runtime.

## Per-target solve (`shared/strategy/targeting.ts`)

At the prepped state (minSec, moneyMax M), for steal fraction s:
`H = round(s/hackPercent)`, `G = growThreads(k, M, M(1−s), M)`,
`W1 = ceil(0.002·H/weakenEffect)`, `W2 = ceil(0.004·G/weakenEffect)`.
Income `E = c·s·M`; RAM-seconds `R = t_h·(1.7H + 1.75·3.2·G + 1.75·4·W)`.
**Score = E/R in $/GB/sec** — the RAM-bound unit. The insight came from an
earlier rewrite's `analyze-profit.js` (`nobody0/bitburner`, no longer checked
out; see README's citation note), with exact Newton grow threads here instead
of its log approximation. The predecessor scripts on disk score by
duration-weighted money per thread instead (`src/_lib/optimizer.ts:123`). The
Q2 audit proved the two are not constant-factor conversions (hack is 1.70 GB,
grow/weaken 1.75 GB), but they are monotonic in the same duration-weighted
non-hack/hack ratio and therefore induce the same ordering.

Search first derives a finite hack-thread ceiling from the 95% steal cap, the
contiguous hack-block cap, and total batch RAM. Domains of at most **1,024**
threads evaluate every integer candidate and return `exact: true`. Larger
domains use a 16-point grid uniform in −log(1−s), 8 golden-section refines, and
bounded integer neighborhoods around every promising point; those results are
explicitly labelled `exact: false`. **Feasibility is part of the search**:
`RamCaps.batchGb` bounds
the batch, `hackBlockGb` bounds the hack op alone (hack must land as ONE call
— splitting compounds the steal and desyncs the grow sizing). If no grid point
fits, a bisection finds the largest feasible batch. Without this the solver
happily returns a 240 GB batch for an 84 GB fleet and nothing ever launches.

`solvePrep` returns W1→G→W2 from the *current* state plus a latency floor:
`prepTime = max(weakenTime, ramSec / prepGb)`.

## Evaluator (`shared/strategy/evaluator.ts`)

Steady-state scores depend only on static fields + HackContext, so the
round-robin works off the 30 s snapshot; dynamic security/money feed only prep
plans of the hot set. A context **generation** guards every cached solution —
a >2 % skill change, a fleet-RAM change >10 %, or a new root bumps it and
forces a re-score, so an argmax never mixes generations.

## Switching (in the gate)

`rate = score × fleetGb`; horizon
`T = clamp(min(goalRemaining/rate, runRemaining), 60 s, 30 min)`, where
`runRemaining` is the endgame route's expected remaining run time
(`spec/strategy/endgame.md`) — in the game the goal term is ∞, so the run
horizon is the only finite bound, and it binds once the expected end is
nearer than 30 min. Prep pick maximizes `rate·(T − prepTime)` and must beat
the farm target by 5 %.
A farm switch requires **all** of: candidate prepped (sec ≤ min+1, money ≥ 90 %
max), +10 % hysteresis on same-generation scores, 60 s dwell.
**Segment order** is `[farm, prep, share]`, flipping to `[prep, farm, share]`
when the candidate beats the current target by ≥25 % — spend now to switch
sooner.

## HWGW dispatcher (`shared/strategy/dispatch.ts`)

Four ops land H → W1 → G → W2, `SPACER = 200 ms` apart; each batch is anchored
at least `4·SPACER` after the previous one (collision guard, pure bookkeeping —
no ns reads). `additionalMsec = landing − now − duration`.

**Durations are computed at launch from live state**, never from the cached
solution: security drift or a level-up between solve and launch would otherwise
land ops off their slots. Our formulas are bit-identical to the game's
(`sim/tests/formulas-parity.test.ts`), so the recomputed duration matches the
engine exactly — verified by asserting observed landing times in
`sim/tests/dispatch.test.ts`.

Prep fires in **non-overlapping waves per host** (a new wave only when the host
has nothing in flight), so plans can never overshoot. Prep work always spreads;
only hack demands contiguity.

## RAM engine (`shared/ram/heap.ts`)

Inherited from an earlier rewrite (`nobody0/bitburner`, no longer checked out;
the predecessor scripts on disk have no heap at all) — 21 clz32 slabs, home
pinned last, three policies (contiguous best-fit for hack, home-first for
grow's core bonus, ascending-slab spread for weaken/prep so fragments get eaten
first), two-phase-commit spread, O(1) rebucket through one `#update` choke
point — with its defects fixed:

- reservations release per block and are **idempotent**; ops the driver could
  not start are rolled back via `reportFailed` (the rewrite leaked them);
- allocation failure is a typed value `{wanted, grantable, freeTotal}`, counted
  in telemetry — never silent ratio starvation;
- **one** home-reserve constant (`HOME_RESERVE_GB`, imported by `net.ts`);
- batch-atomic `allocateAll`: all four ops or none.

Double-entry: the sim tracks per-source RAM independently, and
`sim/tests/dispatch.test.ts` asserts the two ledgers agree — a disagreement is
a test failure, not a silent overcommit. In game, `resyncHeap` reconciles
against real `ramUsed` on each sweep and emits `heap.resync`.

## Worker protocol (`game/worker/worker.ts`)

One puppet script for all three ops, launched
`{ threads, temporary: true, ramOverride: WORKER_RAM[kind] }` with an integer
opId. It reads its descriptor from `worker_info` on globalThis (written
*before* exec, so the race to `undefined` cannot happen) and registers
`ns.atExit` *before* awaiting the op — every exit path pushes to the
`dispatch_done` mailbox and pokes `dispatch_wake`, so RAM frees on kills and
reloads too. A fresh realm (game reload) has no descriptor: the worker exits
silently and the controller rebuilds its ledger from the next sweep.

## Stock manipulation: the second income term

`hack(host, {stock: true})` lowers the corresponding stock's second-order
forecast and `grow(host, {stock: true})` raises it
(`StockMarket/PlayerInfluencing.ts`), so in a node where the market matters the
best farm target is not the richest server but the one whose price movement is
worth the most. `solveCycle` therefore scores TWO income terms into the same
`$/GB/sec`:

```
score = (income + stockIncome) / ramSec
income      = chance · steal · moneyMax · ScriptHackMoneyGain
stockIncome = chance · steal · valuePerOp
```

Five things make this work rather than merely look plausible:

- **Exactly one op per batch carries the flag.** A long is driven by the GROW, a
  short by the HACK. On a successful steady-state batch the grow restores what
  the hack took, so flagging both produces equal and opposite influence in
  expectation.
- **`moneyMax` cancels out of the manipulation rate.** The influence roll is
  against `moneyMoved / server.moneyMax`, a FRACTION, so two servers with the
  same steal fraction and batch time manipulate their symbols equally well
  however rich they are. That inverts ordinary target selection: `joesguns` (JGN)
  and `foodnstuff` (FNS) are among the cheapest manipulators in the game.
  Measured in `sim/tests/stock-market.test.ts`.
- **`ScriptHackMoneyGain` scales only the hacking term.** Influence is computed
  from `moneyDrained`, before the player's cut. BN8 sets the cut to **0** and the
  drain rate to 0.3, so hacking earns literally nothing while manipulating at
  near-full strength — the farm still has to run, for experience and for prices.
  Omitting this multiplier (as the solver did) reported every BN8 target as
  profitable.
- **Both steady-state sides are weighted by hack chance.** A failed hack leaves
  the server at `moneyMax`; the later grow then adds no money, so neither op has
  any influence probability. `solveCycle` currently omits this factor for longs
  and therefore overvalues long-side manipulation below 100% hack chance.
- **Prep grows are flagged too, for a long.** The op is launched either way, so
  the nudge is free. Prep never hacks, so a short gets nothing from that path.

`valuePerOp` comes from `stock` on its topic (`stock.manipulation`, keyed by
hostname) and reaches the solver through `WorldView.stockInfluence`. A change in
it bumps the evaluator's context generation exactly as a skill or fleet change
does — a position opening or closing changes what a target is WORTH, and a stale
cache would keep optimising for a position that no longer exists.

### The magnitudes, measured

Worth stating plainly, because it decides how much this term can ever matter. A
nudge moves the equilibrium forecast by 0.001, so a $10b position on a 0.002 mean
log step held for 100 ticks is worth a few **thousand** dollars per influencing
op — against **tens of millions** of hacked money per batch. So:

- **Outside a node that nerfs hacking, manipulation does not move target choice.**
  It is a rounding error on the score, and that is the correct outcome: handing
  the farm to a small server for a few thousand dollars would cost far more than
  it earns. `sim/tests/dispatch.test.ts` pins that BN1 declines it.
- **In BN8 the same intent wins the target outright**, because `income` is
  *exactly* zero and any positive `stockIncome` is the whole score. Same test,
  same intent, `bitnode: 8`.

That asymmetry is why the two multipliers had to be separated rather than folded
together, and why `stock` also biases its own choice toward symbols whose host the
farm can reach (`MANIPULATION_PREFERENCE`) — the loop only closes if both halves
choose each other.

## Telemetry

One 1 Hz `farm` rollup (`shared/telemetry/state-map.ts`): target, prep target,
segment order, in-flight and landed counts, alloc/exec failures, pump time,
cumulative totals. Transition events only: `farm.targetSwitch`,
`dispatch.slow` (>5 ms), `heap.resync`. **Per-op events are never emitted** —
at scale that would be ~3 events per 16 ms.

## Static RAM (`tests/ram-budget.test.ts`)

`start.js` = 3.60 GB: base 1.6 + `getPlayer` 0.5 + `exec` 1.3 +
`getServerSecurityLevel` 0.1 + `getServerMoneyAvailable` 0.1. The last two are
the hot-target live reads — **the hot path never dodges**. Everything else
(scan, scp, ls, nuke) lives inside dodge closures with bracket notation; the
test fails if any of them leaks into the controller's bill. Peak on a fresh
8 GB home: 3.6 + 4.1 (transient dodge stub) = 7.7 GB.

## Sim A/B results (baseline = the old naive planner)

| Goal | Fleet | Baseline | HWGW | Speedup |
|---|---|---|---|---|
| earn:1e6 | 8 GB home + early net | 2.17 h | 18.2 m | 7.1× |
| earn:1e9 | 8 GB home + early net | 13.1 h | 6.13 h | 2.1× |
| earn:1e9 | 1 TB home | — | 23.1 m | — |

10/10 seeds reached, zero `action.failed` (no RAM overcommit), security and
money bands held during farming.

## Known gaps

- Share/exp segment is declared but not yet dispatched (leftover RAM idles).
- Port openers are acquired on demand for posted backdoor needs; general
  infrastructure purchasing remains outside the target solver.
- The game driver quotes purchases as unavailable (start.js owns them); the
  sim dispatcher buys servers and upgrades home so the A/B includes economy.
