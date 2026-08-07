# Targeting & dispatch (next phase — PLAN, not yet built)

Replaces the placeholder starter worker with a real farming engine. The hard
constraint shaping everything: **steady-state decisions must run in well under
10 ms** (first decision may take ~200 ms). The design splits work by cadence
so the hot path never evaluates a formula.

## Three loops, three budgets

| Loop | Trigger | Budget | Work |
|---|---|---|---|
| **Dispatch** | every op completion | < 1 ms | pop next batch from the current plan, allocate RAM from the heap, exec puppet workers. Table lookups only. |
| **Plan refresh** | ~1 s, or skill/fleet delta | < 10 ms | recompute thread ratios + timings for current & prepped targets from formulas (~20 numbers per server; the vendored formulas cost microseconds). |
| **Strategy review** | ~30 s, or new root / prep done / big money event | < 200 ms | full target ranking, switch decision, prep scheduling. |

## 4.1 Farming the current target

Steady-state proportional model first (HWGW batch alignment is a later
optimization): hold security at min and money at max by keeping thread ratios
weaken : grow : hack derived from the formulas at (minDifficulty, moneyMax) —
hack steals fraction `h` per cycle, grow must restore it, weaken must offset
both fortify amounts. Ratios are recomputed at plan refresh (they move with
skill), cached in planner memory, and consumed by dispatch as constants.

### 4.1.1 RAM segmentation

Port the legacy design (`lib/heap.js` + `worker/worker.js`):

- **Puppet worker**: one ~0-cost worker script, exec'd with
  `{ ramOverride: opCost, temporary: true }`; it reads its op from
  `global.workerInfo` and reports completion via `ns.atExit` → the dispatcher
  knows RAM is free at the exact moment it frees. The sim already accounts RAM
  this way (`WORKER_RAM`), so fidelity is 1:1.
- **Heap allocator** over the fleet: slabs bucketed by free RAM; hack wants a
  single block, weaken spreads anywhere, grow prefers high-core hosts (home).
  Free-RAM tracking is incremental (adjust on start/finish) — never rescan.
- **Segments** (the RAM budget pie): `reserve(home)` for start.js + dodge,
  `farm` for the current target, `prep` for the next target, `share`
  (optional). Segment sizes are strategy-review decisions.

## 4.2 Target selection & switching

Score each candidate at current skill: effective **$/sec/GB** at steady state
= chance × %-per-thread × moneyMax / cycleTime, amortized over the full
h+g+w thread cost of one sustainable cycle. Income is RAM-bound, so
fleet income = score × farm-segment GB.

Switch policy over a horizon `T` (from the active goal):

```
stay    = rate_current × T
switch  = rate_next × (T − prepTime_next)     // prep runs on spare RAM, so
                                              // little income is lost during prep
switch if: next is PREPPED and rate_next > rate_current × (1 + hysteresis 10%)
```

### 4.2.1 Background prep

The strategy review picks the best not-current candidate whose score beats
the current target's and assigns the `prep` segment (idle/spare RAM first) to
weaken+grow it. When prep completes, the switch is nearly free — retarget the
farm segment. Hysteresis + the prepped-precondition prevent flapping while
skill rises quickly.

## 4.3 Real-time budget & the simulator

- The planner stays pure and allocation-light; per-event dispatch touches only
  cached tables. Instrument with `performance.now()` and emit a
  `plan.slow` event when any refresh exceeds 5 ms — perf regressions become
  visible in the dashboard.
- The sim runs the same planner on the virtual clock, so switching policies
  are A/B-tested with `bun run sim -- --goal earn:1e9 --seeds 1..10` before
  touching the game. This is where "which policy wins over 12h" gets computed
  — never at runtime.
- **Formula access**: the planner needs hack chance/percent/time formulas.
  In-game `ns.formulas` requires Formulas.exe (not fresh-game). Decision:
  re-export the needed vendored pure functions through `shared/formulas.ts`
  (they are dependency-free math; ~10 KB bundle weight, zero ns RAM) so the
  identical code runs in game and sim. This carves a deliberate, narrow
  exception into the "game never imports sim/vendor" rule — only via
  `shared/formulas.ts`, never directly.

## 4.3.1 Telemetry volume

Per-op events would be ~3 events / 16 ms at scale — never emit them.

- **Rollup topic**: dispatcher accumulates counters (ops by kind, money, exp,
  in-flight, per-op rates) and flushes ONE `StateMap["farm"]` record per
  second. The UI charts rates, not events.
- **Transition events only**: target switch, prep start/done, allocation
  failure, plan.slow. These are rare and meaningful.
- **Sampled traces** as `debug` records (1-in-N batches) for debugging — the
  client ring drops debug first under pressure, so they can never crowd out
  state.
- Sim runs write full detail only under a future `--verbose`; default sim
  output uses the same rollup, keeping JSONL sizes sane (the ram:home:64 run
  was 83 MB — rollups fix that too).

## Build order

1. Puppet worker + heap allocator + farm rollup telemetry (replaces starter).
2. `shared/strategy/targeting.ts`: score, ratios, switch policy (pure).
3. Wire into start.js dispatch; sim drives the identical planner.
4. Sim A/B: switching policy vs fixed-target baseline; tune hysteresis/prep
   segment size by measured time-to-goal.
5. UI farm panel (rates, current/next target, prep progress).
