# Simulator

Answers "does this change reach the goal faster?" by running the actual
planner (`shared/strategy/planner.ts`) against a simulated world built from
the game's own math.

## Fidelity model

- **Formulas are vendored, not reimplemented**: `sim/vendor/bitburner/` is
  extracted from the pinned tag by `tools/vendor.ts` (`bun run vendor`),
  patched minimally (see the manifest in that script), and proven equivalent
  by `sim/tests/oracle/*` — tests ported from the game's own suite, including the
  full Newton-Raphson grow-inverse sweep.
- **Effects are transcribed** (`sim/core/effects.ts`, each function cites its
  v3.0.1 source): hack payout/fortify/exp at completion time with post-delay
  state, `processSingleServerGrowth`, weaken, security clamps, `gainHackingExp`,
  cloud-server and home-RAM costs, and the Server-constructor derivations
  (`serverFromSpec`). Vendor drift detection does not cover these — re-read
  the tag when bumping.
- **Time**: the game has no tick system for h/g/w — durations are computed at
  start, effects applied atomically at completion via setTimeout. `sim/clock.ts`
  reproduces that as a synchronous min-heap event queue (FIFO tie-break).
- **Randomness**: only hack success rolls; seeded mulberry32, so a (seed,
  planner, goal) triple is fully reproducible.

## World (`sim/world.ts`)

`SimWorld` holds plain `@nsdefs`-shaped literals (`sim/core/mocks.ts`), a
person, money, and the clock. `execute(Action)` enforces preconditions
(admin, RAM on source, hack skill), reserves `WORKER_RAM[type] * threads` on
the source until completion, and emits the shared LogRecord schema
(`src:"sim"`, `t` = virtual ms). State mirrors use the same
`getServer:<host>` / `getPlayer` keys as the game, while simulator-only detail
such as `hack.done` remains source-specific. The driver replans on `onSettled`
(event-driven; no polling tick).

`sim/network.ts` defines the v1 target set: the six 0-port early servers with
base values copied from the game's server metadata, derived through
`serverFromSpec`.

## Known fidelity gaps (v1)

- One BitNode per process (`currentNodeMults` is module state in the vendored
  core; `SimWorld` sets it once in the constructor).
- Port openers not modeled — network is 0-port servers only.
- Worker RAM constants (1.70/1.75 GB/thread) are hardcoded in
  `shared/world.ts`; verify against `ns.getScriptRam` if workers change.
- Dodge-stub RAM spikes (transient 2.5 GB on home) are not modeled.
- No hacknet/factions/augs yet; hacknet formulas are already vendored for the
  fast-follow.
- Intelligence is 0 (mock person), matching a fresh character.
