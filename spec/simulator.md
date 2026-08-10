# Simulator

Answers "does this change reach the goal faster?" by running the real `game/`
controller against a simulated world built from the game's own math.

Two drivers, both driven from `sim/run.ts`:

- `--driver game` (default) — loads `game/lib/controller.ts` and runs it
  unmodified: its sweep, its dodge stub, its probe runner, its puppet workers.
  Nothing in `game/` knows it is being simulated.
- `--driver planner` — runs `shared/strategy/` planners directly against
  `SimWorld`. Narrower and older, kept because it isolates planner changes from
  driver changes.

## Time: two clocks, neither of them injected

This is the constraint the whole harness is built around. Bitburner has two
independent timebases and they never synchronise:

1. **Wall clock via `window.setTimeout`.** `netscriptDelay`
   (`bitburner-src/src/Netscript/NetscriptHelpers.tsx:419` @ v3.0.1) is a bare
   `setTimeout`. h/g/w, `sleep` and `spawn` all ride it.
2. **The 200 ms engine cycle** (`src/engine.tsx`, `CONSTANTS.MilliPerCycle`) —
   a self-rescheduling `setTimeout` that drives everything else: gang,
   corporation, bladeburner, sleeves, hacknet, stock, faction rep, and the
   thirteen `Engine.Counters`.

Both live *below* the script, so a clock injected into `game/` would control
neither. Instead `sim/realm/timers.ts` replaces `setTimeout`, `setInterval`,
`Date.now`, `new Date()` and `performance.now()` for the whole process, and
`sim/clock.ts` becomes the event loop. `game/` is untouched.

Ordering that is reproduced because code depends on it:

- Equal-deadline timers fire in **registration order**, with the microtask
  queue fully drained between them (`Clock.runAsync`). That is what makes HWGW
  batching correct: the game applies each op's effect in a `.then()` on the
  delay promise, so the effect lands before the next same-deadline timer.
- Durations are computed at **call** time; effects read **completion**-time
  state. A weaken landing mid-flight never speeds up an op already in the air.
- Kill `clearTimeout`s the pending delay, so a killed op's effect never applies.
- `ns.exec` does its bookkeeping synchronously (pid, RAM, `ps` visibility) and
  starts `main()` on a **microtask** — a child always begins before the parent
  resumes from its next timer-based await.
- Nested timers below 4 ms clamp past depth 5, as in a browser.
- `Engine` carries the sub-cycle remainder, and `checkCounters()` fires each
  counter **once** per `updateGame` however fat the tick — only
  `passiveFactionGrowth` compensates for the cycles it missed.

## Fidelity model

- **Formulas are vendored, not reimplemented**: `sim/vendor/bitburner/` is
  extracted from the pinned tag by `tools/vendor.ts` (`bun run vendor`),
  patched minimally, and proven equivalent by `sim/tests/oracle/*`.
- **Effects are transcribed** (`sim/core/effects.ts`, each function cites its
  v3.0.1 source). Both drivers share one implementation through `SimWorld.land`.
- **RAM costs are transcribed** (`sim/ns/ram-costs.ts`) rather than vendored:
  `RamCostGenerator.ts` imports `@player` and `NSFull`, and that graph detonates
  into the whole game. It is therefore **not** drift-detected — re-read it when
  bumping the tag. These numbers decide which probes the runner can afford, so
  getting them wrong makes the probe schedule fiction.
- **Randomness**: hacking, crime and stock each use deterministic, independent
  seeded streams. `Date.now()` is virtual, so a `(seed, profile, save)` triple
  is fully reproducible.

## Not modelling something is a first-class result

An unimplemented ns path or subsystem calls `unmodeled()`
(`sim/realm/unmodeled.ts`): it emits `sim.unmodeled` once per distinct name,
counts every hit, and **throws**. It never fabricates a return value, because a
run that blends measured and invented behaviour is exactly how a simulation
starts lying to you.

Throwing is survivable by construction — `probe-runner` isolates each probe and
the controller isolates each driver — so a run degrades to "that probe failed"
rather than dying. The gap list is reported by `sim/run.ts`, surfaced in the
viewer's Overview tab, and is the roadmap.

Every result is also classified:

- `valid` — controller driver, with no unmodeled calls or script crashes;
- `partial` — the planner-only driver, which intentionally does not exercise
  the shipped controller or Netscript lifecycle;
- `invalid-for-goal` — an unmodeled call, incomplete seeded state, or script
  crash could have changed the outcome. The CLI exits non-zero for this class.

`sim.meta` includes the driver, scenario class, static per-feature coverage and
a versioned fingerprint of the complete experimental input. `sim:compare`
refuses different fingerprints, drivers, scenarios, goals or gap sets, and
refuses invalid runs unless `--allow-invalid` is supplied for diagnostics.

## Known gaps

- **One run per process.** `currentNodeMults` is module state in the vendored
  core, `game/` keeps its hacking ledger in module state, and the dodge/worker
  rendezvous lives on `globalThis`. `sim/run.ts` fans multi-seed runs out to one
  child process per seed.
- Controller-facing models currently cover hacking, factions, crimes,
  grafting, Hacknet and stocks. Career, progression and stocks are partial;
  gang, corporation, Bladeburner, sleeves, Stanek and Darknet remain
  unmodeled. Go and coding-contract rules have oracle tests but their Netscript
  lifecycles are not wired, so they report a gap instead of returning synthetic
  gameplay state.
- The default network is an eight-server deterministic early-game fixture, not
  Bitburner's generated whole-node network. Save-seeded runs use the real saved
  topology and live server state. The scenario class prevents accidental
  comparisons between the two.
- Save seeding restores supported current work and the stock market's prices,
  forecasts, positions and cycle state. Unsupported work kinds and nonempty
  stock order books invalidate the run rather than being silently discarded.
- Cold-module compile latency is not modelled, so the simulator will not
  reproduce the desynced first batch a real cold start produces.
- Stock's update gate reads real `Date.now()` in the game; under the virtual
  realm that becomes virtual, so its ~1.5x catch-up cap does not apply.
- `bitburner-src/src/Exploits/loops.ts` uses `performance.now()` to *detect*
  time compression; a real game under this clock would grant the
  TimeCompression exploit. Exploits are not modelled.
- Port openers are not modelled in the default fixture network (all 0-port
  servers). A save-seeded run carries its real `openPortCount`.
- Intelligence is 0 in the default fixture, matching a fresh character.

## Run-length pathologies (found and FIXED by profiling factions-join)

The 2-hour factions-join profile was unfinishable — 40+ minutes real per seed,
~2 GB heap — while 10-minute profiles ran in a second. Three frame-rate churn
sources compounded; the 10-minute repro dropped 102.8s → 12.1s real once fixed:

- A career action whose execution THREW was re-decided and re-executed at
  frame rate forever (1,389 `applyToCompany` throws in 5 virtual minutes;
  26,643 `universityCourse` throws in one bn1-speedrun seed). Throws now latch
  a 30s per-action backoff — a throw is not a refusal the next frame can cure.
- The shared work-completion notice kept the factions wake hot for every pass
  of the notice's multi-pass lifetime, re-running the full faction planner at
  5 Hz. Factions now reacts once per notice.
- The coordination digest carried per-cent-precise amounts and a per-pass
  `heldMs`, so the change-filtered store wrote ~5 records per second for as
  long as anyone held the work slot. Amounts are now reported at 3 significant
  digits and hold time in 10s buckets.

Related: IPvGO is not capability-gated in Bitburner v3.0.1. The simulator now
returns the exact fresh 7x7 Netburners state from `go.getGameState`, so the
controller's universal capability probe succeeds without inventing a profile
flag. Save-seeded runs fail loudly when that getter is reached because the save
decoder does not yet retain the live board, history, scores, or stored cycles.

## Two findings this harness surfaced

1. **The probe runner starves on a fresh 8 GB home** (not fixed). The sweep
   snapshots the network from inside a 4.1 GB dodge stub, so `home.ramUsed`
   carries the stub's own footprint. `dodgeBudget()` then reads
   `8 - 3.6 (controller) - 4.1 (stub) - 1.6 - 0.5 < 0` and every probe —
   including the capability gate — is skipped on every sweep, forever. The farm
   runs normally, so nothing looks wrong from the outside. Pinned by
   `sim/tests/ns.test.ts`.
2. **A 32 GB home stalls the dispatcher** (FIXED). `earn:1e6` was reached at 8,
   16 and 64 GB but not at 32 (30.2 m vs 20.7 m at 8 GB, planner driver,
   seed 1), with `allocFails` climbing while `inFlight` stayed at zero. Two
   defects, both in `shared/strategy/`: `syncTopology` sized the hack-block cap
   from `maxRam − reserved`, ignoring standing foreign usage (the controller's
   own footprint), so the solved block could never be placed in the game; and
   `solveCycle` scored per RAM-second only, so a hack block that monopolised
   the largest host — one slot, one batch per weakenTime — still won the
   argmax. Fixed by free-RAM-based `largestBlockGb`/`hostBlocksGb` and the
   pipeline-aware launch-rate term in the score (`spec/targeting.md`); after
   the fix the same probe reads 16.0 m at 32 GB, monotonic in home RAM. Pinned
   by the pipeline-aware solve test in `sim/tests/targeting.test.ts`.
