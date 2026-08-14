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

## Two performance experiment classes

- `bitnode-route` runs are the only promotable speedrun evidence. Each is one
  BitNode leg with a stable route/leg id and an entrance of either fresh BN1 or
  a registered save checkpoint. Session manifests carry the save's exact-byte
  SHA-256, scenario fingerprint and terminal validity/result. The entrance's
  BitNode must equal the leg's declared BitNode. A route session is promotable
  only when it reached the goal with `valid` fidelity.
- `feature-scenario` runs are synthetic ideal, stress, recovery or mixed-feature
  pressure experiments. They may use arbitrary focused worlds, but comparison
  policy refuses to compare them with route legs and promotion rejects them.

`--save <id>` replaces the profile fixture with that complete checkpoint;
profile world fields never overwrite decoded save state. `--fresh` explicitly
ignores a profile's default save. `--route <id>` forks lineage for a different
BitNode completion order without changing the checkpoint registry.

Pressure tests (`sim/tests/scenario-*.test.ts`) are disabled in the default
correctness process and run with `bun run test:sim:scenarios`. That runner
starts one Bun process per test case: long virtual-time soaks retain their assertions
without a timeout leaving patched global clocks behind for unrelated tests.

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
`Date.now`, callable `Date()`, `new Date()`, `performance.now()` and
`Math.random()` for the whole process, and
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
  into the whole game. Its upstream source hash is pinned alongside every
  other handwritten simulator surface; a tag bump fails until the table is
  re-audited and its accepted hash is updated. These numbers decide which probes the runner can afford, so
  getting them wrong makes the probe schedule fiction.
- **Randomness**: the realm and every gameplay subsystem share one deterministic
  stream keyed by the declared run seed, preserving cross-feature
  `Math.random` ordering. The fixed vanilla fixture uses a second, dedicated
  world-generation stream: it consumes the authoritative initial population
  before play and continues across later prestiges. This keeps the experimental
  world fixed while seeds 1/2/3 still produce genuinely different gameplay. A
  `(seed, profile, save)` triple remains fully reproducible.

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

`sim.meta` includes the driver, scenario class, static per-feature coverage,
the handwritten model version, the pinned upstream commit and a fingerprint of
the complete experimental input. Controller runs additionally name their Go
fidelity: `action-exact` for correctness harnesses or the versioned promoted-
arena aggregate model used by the full-route CLI. `sim:compare`
refuses different fingerprints, drivers, scenarios, goals or gap sets, and
refuses invalid runs unless `--allow-invalid` is supplied for diagnostics.

Long controller benchmarks can use `--compact`. Goal reduction and validity
still consume every record, but the JSONL retains only experimental identity,
route changes, install milestones, fidelity events and the terminal result.
Full-game runs also stream records instead of retaining a duplicate in-memory
history. Neither changes controller behaviour; they only bound host-side I/O
and heap use for multi-install BitNode runs.

Every simulator seed is a fresh lineage, even when two runs start from the same
registered snapshot. `sim.prestige` closes the current install JSONL; the next
record opens its successor. A `.session.json` manifest lists those artifacts in
order, and `sim:compare` accepts either a manifest or a legacy single JSONL.
The snapshot id is retained as `seededFrom` metadata, not reused as identity.

`--perf` additionally exercises the game's telemetry-free build path. The
controller still acquires and stores exactly the same state (pinned by
`tests/build-perf.test.ts`); simulator-owned player, server, install and
progression records keep goals and validity observable without paying for the
game's WebSocket payload construction. Use `--compact --perf` for BN-time
benchmarks, and the normal telemetry path when inspecting detailed decisions.

## Known gaps

- `bn1-full` is the first promotable route leg and its save fixture is genuinely
  fresh BN1. The controller harness explicitly grants active and owned SF4.3
  to every run so an unattended speedrun can cross interactions that would
  otherwise require manual Singularity input. This declared allowance is
  included in `sim.meta`, scenario fingerprints and the simulator model
  version. It grants no SF14 reward/policy advantage, and low-level `SimWorld`
  tests remain able to exercise the real no-SF4 rules.

- **One run per process.** `currentNodeMults` is module state in the vendored
  core, `game/` keeps its hacking ledger in module state, and the dodge/worker
  rendezvous lives on `globalThis`. `sim/run.ts` fans multi-seed runs out to one
  child process per seed.
- A full-BitNode goal stops at the real `destroyW0r1dD43m0n` call and records
  its `bitnode.reset` transition. It does not fabricate the next node's world
  inside the completed scenario; that node starts as a separate run.
- Controller-facing models currently cover hacking, factions, crimes,
  grafting, Hacknet and the stock lifecycle used by the shipped controller.
  Career and progression are partial; user-created stock order mutation/fills,
  gang, corporation, Bladeburner, sleeves and Darknet remain unmodeled.
  Stanek's placement, charging, effects, battery and multiplier lifecycle are
  modeled for fresh/controller worlds; gift acceptance, sleeves and
  save-seeded gift state remain explicit gaps. Go has a controller-facing
  lifecycle for fresh worlds. Full-route runs collapse a whole game to one
  seeded arena-calibrated endpoint result (measured win probability, black
  score and upstream-AI virtual duration); exact per-move mechanics remain in
  `sim/go-arena.ts`, `sim/features/go-system.ts`'s exact mode, and their parity
  suites. Coding
  contracts remain oracle-only. A save-seeded Go probe fails loudly because the
  decoder cannot reconstruct the live board and history from the current seed.
- Unprofiled runs use the small deterministic early-game fixture. `bn1-full`
  instead generates the complete vanilla v3.0.1 foreign-server population and
  topology from a fixed dedicated seed; `jit-lategame` is an explicitly
  synthetic high-RAM lifecycle fixture.
  Save-seeded runs use the real saved topology and live state. Scenario classes
  prevent accidental comparison of these inputs.
- Save seeding accepts only the pinned save schema, preserves individual port
  flags and total playtime, and restores supported current work plus stock
  prices, forecasts, positions and cycle state. Unsupported work kinds,
  nonempty stock order books, active gang/corporation/Bladeburner state, or any
  sleeves invalidate the run rather than being silently advanced or discarded.
- Cold-module compile latency is not modelled, so the simulator will not
  reproduce the desynced first batch a real cold start produces.
- Stock's update gate reads real `Date.now()` in the game; under the virtual
  realm that becomes virtual, so its ~1.5x catch-up cap does not apply.
- `bitburner-src/src/Exploits/loops.ts` uses `performance.now()` to *detect*
  time compression; a real game under this clock would grant the
  TimeCompression exploit. Exploits are not modelled.
- Port opener purchase/use and real port requirements are modelled. The small
  fixture only includes the early faction gates; `bn1-full` carries the vanilla
  requirement of every generated server, while saves retain live open ports.
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
