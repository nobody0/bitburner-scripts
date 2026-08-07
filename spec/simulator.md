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
- **Randomness**: only hack success rolls; seeded mulberry32. `Date.now()` is
  virtual and starts from a fixed epoch, so a `(seed, profile, save)` triple is
  fully reproducible.

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

## Known gaps

- **One run per process.** `currentNodeMults` is module state in the vendored
  core, `game/` keeps its hacking ledger in module state, and the dodge/worker
  rendezvous lives on `globalThis`. `sim/run.ts` fans multi-seed runs out to one
  child process per seed.
- No subsystem is wired to the engine cycle yet — only `hacking` exists in
  `game/`. The machinery and the bonus-time contract are in place
  (`sim/engine.ts`), so each feature lands against the right clock.
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

## Two findings this harness surfaced

Both are `game/`-side, reproduce outside the simulator, and are **not fixed**:

1. **The probe runner starves on a fresh 8 GB home.** The sweep snapshots the
   network from inside a 4.1 GB dodge stub, so `home.ramUsed` carries the stub's
   own footprint. `dodgeBudget()` then reads
   `8 - 3.6 (controller) - 4.1 (stub) - 1.6 - 0.5 < 0` and every probe —
   including the capability gate — is skipped on every sweep, forever. The farm
   runs normally, so nothing looks wrong from the outside. Pinned by
   `sim/tests/ns.test.ts`.
2. **A 32 GB home stalls the dispatcher.** `earn:1e6` is reached at 8, 16 and
   64 GB but not at 32, with `allocFails` climbing while `inFlight` stays at
   zero. It reproduces under `--driver planner`, so it is in
   `shared/strategy/`, not in the game driver or the synthetic ns.
