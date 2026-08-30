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
  BitNode completion with a stable route/leg id and an entrance of either a
  declared fresh save of the leg's own BitNode (`leg-bn4.1`, the route's first
  leg, is the only one), a chained entrance — a fresh save of
  the leg's node plus the Source-Files and intelligence the route's earlier
  completions earned, derived by `sim/route-legs.ts`
  and never hand-written (`spec/strategy/route-legs.md`) — or a registered
  save checkpoint, which for a leg is minted from that same derivation.
  Session manifests carry the save's exact-byte
  SHA-256, scenario fingerprint and terminal validity/result. The entrance's
  BitNode must equal the leg's declared BitNode. A route session is promotable
  only when it reached the goal with `valid` fidelity — and a promotable one
  mints the next leg's checkpoint.
- `feature-scenario` runs are synthetic ideal, stress, recovery or mixed-feature
  pressure experiments. They may use arbitrary focused worlds, but comparison
  policy refuses to compare them with route legs and promotion rejects them.
  Their feature selection filters probes and controller modules only; it never
  rewrites the capabilities observed from the world or reaches pure strategy.

`--save <id>` replaces the profile fixture with that complete checkpoint;
profile world fields never overwrite decoded save state. `--fresh` explicitly
ignores a profile's default save. `--route <id>` forks lineage for a different
BitNode completion order without changing the checkpoint registry.

Simulations — pressure scenarios (`sim/tests/scenario-*.test.ts`), the
synthetic-world controller runs, the BN progression profiles, the dispatcher's
minutes-long band soaks — are disabled in the default correctness process.
They declare a lane in `tests/support/lanes.ts` and run with
`bun run long <feature|bnN>`; `bun run long --list` enumerates them. That
runner starts one Bun process per test case: long virtual-time soaks retain
their assertions without a timeout leaving patched global clocks behind for
unrelated tests.

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

**Any full-route run must select the aggregate model.** `runGame` defaults to
`action-exact`, which drives the real trained policy through a browser Worker
performing WebGPU inference. That worker does not exist under Bun: the request
never answers, `neuralRuntime.install` never settles, and the Go feature simply
retries every five seconds for the entire run without ever making a move. It
fails silently — Go reports as unlocked, the board reads as live, admission and
scheduling both succeed, and only `moveCount` staying at zero reveals it. A
fixture whose premise is a Go reward then fails on a premise that never fired,
and every other fixture pays the stalled turns as wall-clock. `sim/run.ts`
passes `goFidelity: AGGREGATE_GO_MODEL` for every profile run and
`sim/tests/jit-scenario.ts` does the same for the scenario ladder; a new
full-route harness must too. Exact action parity and WebGPU strength belong to
the arena lane, which is the division of labour `sim/fidelity.ts` states.

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

- `leg-bn4.1` is the route's first promotable leg and its fixture is genuinely
  fresh BN4, where Singularity is node-native. The controller harness still
  grants active and owned SF4.3
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
  gang, corporation, Bladeburner and sleeves remain unmodeled. The Darknet is
  full for fresh and multi-install controller runs: all 23 APIs, passwords and
  sessions, mutation/restart, labyrinth/storms, clue/cache rewards, live stock
  grants, and coding-contract generation/solve/reward are modeled.
  `DNET_ASSUMPTIONS` records the remaining entropy-stream and save/offline/UI
  boundary choices.
  Stanek's placement, charging, effects, battery and multiplier lifecycle are
  modeled for fresh/controller worlds; gift acceptance, sleeves and
  save-seeded gift state remain explicit gaps. Go has a controller-facing
  lifecycle for fresh worlds. Full-route runs collapse a whole game to one
  seeded arena-calibrated endpoint result (measured win probability, black
  score and upstream-AI virtual duration); exact per-move mechanics remain in
  `sim/go-arena.ts`, `sim/features/go-system.ts`'s exact mode, and their parity
  suites. Coding contracts have a controller-facing runtime backed by the
  vendored problem definitions. A save-seeded Go probe fails loudly because the
  decoder cannot reconstruct the live board and history from the current seed.
- Unprofiled runs use the small deterministic early-game fixture. The route
  legs instead generate the complete vanilla v3.0.1 foreign-server population and
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
  fixture only includes the early faction gates; the route legs carry the vanilla
  requirement of every generated server, while saves retain live open ports.
- Intelligence is 0 in the default fixture, matching a fresh character.

## Measuring host cost

Everything else the harness reports is virtual. `timeToGoalMs`, `engineCycles`
and `noteTickLateness` all answer "how fast did the player get there", never
"how long did I sit here waiting". Two flags answer the second question:

- `--wall-budget <duration>` stops the pump after that much REAL time and
  reports `stoppedBecause: "budget"`. `--horizon` bounds virtual time; this
  bounds the wait. It exists because a sampling profiler only writes its output
  when the process exits normally, so bounding a run is what makes a window of
  an hours-long simulation profilable at all. A budgeted run never reaches its
  goal, so `assertPromotableSession` refuses it and no truncated run can enter
  route lineage.
- `--cost` reports throughput in **virtual hours per wall minute** — the number a
  performance change has to move — plus per-event cost, queue shape, and
  Netscript calls bucketed by name. It samples every 10s of real time, because
  the whole-run average hides the shape.

Both are in `sim/cost.ts`. The one rule: `sim/realm/timers.ts` has replaced
`performance.now` and `Date.now` with virtual time by the time a run is pumping,
so every wall-clock measurement goes through `realNowMs()` (`sim/clock.ts`),
captured at module load like the pump's own timers. A bare `performance.now()`
inside a run silently reports the game's clock as the host's.

The driver is `bun run sim:profile` (`tools/sim-profile.ts`):

```
bun run sim:profile --cpu-prof --wall-budget 2m   # one bounded run under Bun's sampler
bun run sim:profile --matrix                      # throughput across configurations
```

`--cpu-prof` writes a `.cpuprofile` and a markdown digest under `runs/profiles/`.
`--matrix` bounds every case to the same budget and varies one thing at a time —
`--perf`, `--compact`, and the `--only` feature ladder. It is a screen, not an
attribution: turning a feature off runs a *different* simulation, not the same
one minus a cost, so a build that cannot buy servers has fewer hosts to dispatch
to and looks fast for unrelated reasons. The ladder is not monotonic and is not
supposed to be. Use it to rule a suspect out and to spot an order-of-magnitude
outlier; take real attribution from `--cpu-prof`. Both run a single seed on
purpose: `sim/run.ts` fans multi-seed runs out to child processes, and a
profiler attached to the parent would watch it wait.

Read `--cost`'s throughput curve before the profile's hot list. A flat CPU
profile cannot distinguish "this function is expensive" from "this function is
called more often the longer the run goes", and as the next section records,
this simulator's worst performance bugs have all been the second kind.

## Hot paths the first CPU profile found (FIXED)

A 1.45x on identical work — one virtual hour of `bn1-full` seed 1 went from
17.3s to 11.9s — with every record of the run byte-identical to the tree before
it, across `bn1-full` seeds 1/2/3, `bn1-speedrun` and `bn1-progression`. Nothing
here changed a decision; each is the same computation arranged differently.

- **Sorting a list to read its head.** `marginalCostPerGb`
  (`shared/strategy/ram-supply.ts`) ordered every cloud quote under a comparator
  doing two `Math.log2` and two `localeCompare`, then took element zero — on
  every hacking tick. Now a linear scan. `roundedRamPurchase` did the same and
  also generated the quote list twice. Same pattern, same fix, in
  `greedyOrder` (`factions/augs.ts`, which additionally copied a Map per
  placement) and the NeuroFlux seller pick (`factions/favorValue.ts`). Together
  these took `ram-supply` off the profile entirely.
- **Re-running an identical scan.** `solveCycle`'s joint-packing test
  (`shared/strategy/targeting.ts`) reads its period argument ONLY through the
  two integer slot counts it implies, and the bisection above it probes up to 26
  periods that increasingly round to the same pair. Memoising on the pair is
  exact rather than approximate; it is worth 1.10x by itself. The memo is one
  module-level Map cleared per candidate — bounded by the probe count, never
  pruned, because RAM is a cost this module also pays in-game.
- **Allocating inside the innermost loop.** The packing scan declared its
  placement closure per host, inside that same 26-probe bisection.
- **Calling through the remaining placement closure.** A fixed-horizon profile
  showed that joint packing was still the only cohesive block large enough to
  clear the noise floor. The scan now selects grow-first or hack-first once and
  inlines both placements in that loop. It performs the same `floor`, `min`,
  subtraction and early-return sequence over the same hosts, but pays neither
  two calls nor a role-order branch per host per probe. On the same machine the
  one-hour `bn1-full` median moved 11.6 s / 5.16 vh/min to 11.0 s / 5.46 vh/min
  (1.06x throughput, spread under 1%). Full telemetry remained byte-identical
  to `fed225bc` for both `bn1-full` seeds and the `bn1-speedrun` and
  `bn1-progression` checks in the performance protocol.

What is left is flat. In the post-change two-minute CPU profile `solveCycle`
fell from 17.1% total to 8.4% and the separate `place` frames disappeared. The
largest self-time entries are now `latestJitStart` 3.7%, native `Map` 3.6%,
native `filter` 2.6%, `packsScan` 2.5%, and `buildView` 2.2%; remaining mass is
spread across dispatcher view construction, containers and object spreads.

The cancelled-timer lead was tested before the packing change. An amortised,
in-place heap compaction preserved `(time, seq)` ordering and bounded the dead
backlog, but it did not move the fixed 1 h or 2 h horizons and produced the same
2.84 vh/min / -78% two-minute diagnostic. It was reverted. The backlog is a
visible consequence of late cancellation bursts, not the cause of the decay.
The packing pass improves identical early work, but a fresh non-profiled window
still decays 5.03 -> 0.91 vh/min (-82%) while reaching 5.95 virtual hours. That
run-length pathology remains open.

The measurement that matters is a FIXED HORIZON, not a wall budget. Under
`--wall-budget` a faster simulator reaches the expensive late state sooner, so
this 1.45x moved the two-minute window's virtual hours by -2%. See
`sim/tests/baselines/sim-throughput.json`, which records both and says why.

## Hot paths the third profile found: the factions portfolio (FIXED)

A 1.27x on identical work — one virtual hour of `bn1-full` seed 1 went from
10.8s to 8.5s — with the full-telemetry record streams byte-identical to
`a76d187b` for all four runs in the performance protocol. Nothing here changed
a decision; each is the same computation arranged differently.

The "flat" profile the packing pass left behind was flat only in SELF time. By
total time one block still owned a third of the run: `stepFactions` 34.6%,
almost all of it the portfolio budget sweep (`chooseBudget` 29.9%), whose
inner loop `evaluateUncached` runs ~335k times per virtual hour (measured by
instrumentation, mean union size ~12, max 40). At that call volume the cost
was not any algorithm but per-call constants — closures, spreads, one-use
containers — and the first fix attempted here proves it: rewriting the
`greedyOrder` rescan as a heap-based priority Kahn moved the bench by nothing,
because its per-call apparatus cost as much as the rescans it replaced. What
worked:

- **A fast path for the shape the search actually sends.** Most union sets are
  unique-named with no in-set prerequisite, where most-expensive-ready-first
  is exactly one static sort (`estimatedCost`); most unions need no
  prerequisite closure at all, and `unionAugs` now detects that in the same
  walk that builds the list. Sets that do carry chains (the Cranial Signal
  Processor generations) go through a rewind-scan placement that keeps the
  sort but drops the dedupe/heap bookkeeping.
- **No allocation per priced item.** `totalCost` spread a fresh `PriceContext`
  and an `augCost` result object per item; `augMoneyCost` is the same money
  formula as a bare number with the NeuroFlux level as a parameter (shared by
  `augCost`, so the formulas cannot drift). `unionCost` also built a
  `PurchaseCandidate` wrapper per augmentation and ran a `choices.find` per
  augmentation for a seller field the estimate never reads; it now prices bare
  `AugInfo`s (`estimatedAugSetCost`).
- **Cache keys without string building.** The evaluation cache keyed ordered
  selections as a joined `faction:index` string — native `join` alone was
  1.3% of the run; it is now a trie over package object identities. Per-view
  invariants (`bestWorkType`, per-faction offered-name sets) are cached beside
  the existing standing/offered caches, and `favorValue`'s future-work count
  iterates the (small) acquired union against those sets instead of
  materialising a filtered copy of each faction's catalogue.
- **Outside factions**: `cloudQuotes` regenerated ~500 quote objects at least
  twice per hacking tick from inputs that change only when a purchase lands —
  now a single-slot fingerprint memo; `solveCycle` hoisted the per-candidate-
  constant `hackExpGain` out of its thread-evaluation closure.

Two of these were measured slower first and fixed: the heap Kahn (above), and
an acquired-Set iteration in `portfolioValue` whose per-choice iterator
allocation cost more than the array filter it replaced. At 335k calls/hour,
intuition about constant factors loses to the profiler — re-measure every
step.

After the pass `stepFactions` is ~27% total and no single self-time entry in
it clears 3%; the largest remaining blocks are dispatch view/topology
construction, the publish-digest JSON signatures, and needs/coordination
containers. The two-minute diagnostic still decays 5.29 -> 0.72 vh/min (-86%)
while reaching 6.03 virtual hours: the run-length pathology remains the open
lead, and it is not a factions problem.

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

1. **The probe runner starved on a fresh 8 GB home** (FIXED, twice). The
   home-only arithmetic still reads `8 - 3.6 (controller) - 4.1 (stub) -
   1.6 - 0.5 < 0`, so every probe — including the capability gate — would be
   skipped on every sweep, forever, with the farm running normally and nothing
   looking wrong from the outside. Fleet placement funds it instead: the stub
   ships to every rooted host, so the gate batch lands on a client rather than
   competing for a home reserve that can never hold it. `sim/tests/ns.test.ts`
   pins both halves — the arithmetic, and the inverse assertion that
   `capabilities` is now emitted. What remained after that was head-of-line
   blocking in the runner's one-probe-per-pass slot: earliest-deadline-first
   re-selected the same unplaceable probe every pass, so every affordable
   probe behind it waited minutes for the farm to free RAM (measured on
   bn8-full: the market's first price sample at t=212 s, after the node grant
   had already been spent by then-priceable claims). The runner now falls
   through to the next due probe that can actually place.
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
