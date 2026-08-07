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
| Evaluator slice | ≥2 s, `clamp(ceil(N/10),1,8)` targets | ≤2 ms | 0.03 ms / 8 targets |
| Decision gate | ≥5 s, or invalidation | ≤200 ms | ~0.6 ms / 100 targets |
| Sweep | 30 s, dodged | — | scan + root + deploy + heap resync |

Enforced by `tests/heap.test.ts`, `sim/tests/targeting.test.ts` (bench),
`sim/tests/dispatch.test.ts` (bench), and `dispatch.slow` telemetry at runtime.

## Per-target solve (`shared/strategy/targeting.ts`)

At the prepped state (minSec, moneyMax M), for steal fraction s:
`H = round(s/hackPercent)`, `G = growThreads(k, M, M(1−s), M)`,
`W1 = ceil(0.002·H/weakenEffect)`, `W2 = ceil(0.004·G/weakenEffect)`.
Income `E = c·s·M`; RAM-seconds `R = t_h·(1.7H + 1.75·3.2·G + 1.75·4·W)`.
**Score = E/R in $/GB/sec** — the RAM-bound unit (legacy analyze-profit's
insight, with exact Newton grow threads instead of its log approximation).

Search: 16-point grid uniform in −log(1−s) → 8 golden-section refines →
integer snap. **Feasibility is part of the search**: `RamCaps.batchGb` bounds
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

`rate = score × fleetGb`; horizon `T = clamp(goalRemaining/rate, 60 s, 30 min)`.
Prep pick maximizes `rate·(T − prepTime)` and must beat the farm target by 5 %.
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

Legacy design — 21 clz32 slabs, home pinned last, three policies (contiguous
best-fit for hack, home-first for grow's core bonus, ascending-slab spread for
weaken/prep so fragments get eaten first), two-phase-commit spread, O(1)
rebucket through one `#update` choke point — with its defects fixed:

- reservations release per block and are **idempotent**; ops the driver could
  not start are rolled back via `reportFailed` (legacy leaked them);
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
- Port openers are still start.js's job; the sim network is 0-port only.
- The game driver quotes purchases as unavailable (start.js owns them); the
  sim dispatcher buys servers and upgrades home so the A/B includes economy.
