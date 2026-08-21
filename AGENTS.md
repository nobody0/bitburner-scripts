# Working in bitburner-scripts

This is a clean-sheet Bitburner automation project. The predecessor scripts
(`nobody01/bitburnerscript`) are inspiration only: do not copy their history,
and explicitly do not copy their architecture — a 1621-line `main()`
coordinating every subsystem through a mutable `globalThis.globalState` is the
shape this repository exists to replace.

**Two branches of that repository are checked out and they are not
interchangeable.** Cite the branch explicitly; never write "the predecessor
scripts on disk".

- `@master` (`dc0720b`) — **the batcher reference**. Any HWGW/JIT scheduling,
  timing, pooling or batch-economics claim cites
  `servers/home/imports/batchPlanner.ts` or `batchRunner.ts`. See
  `spec/jit-reference.md`.
- `@2023` (`43e8585`) — everything else: factions, augmentations, progression,
  stock, the `stubCall` dodger. Its `src/_lib/batchers/jit.ts` is **unwired
  work-in-progress**; do not cite it as proven for anything.

Designs credited to "an earlier rewrite" (`nobody0/bitburner`) refer to a
third, abandoned repository that is no longer checked out; see the citation
note in `README.md`.

- Author game scripts in `game/` as TypeScript; only `game/` is ever synced to
  the game. Cross-cutting pure code (log schema, planner, goals) lives in
  `shared/`; the simulator in `sim/`; the external UI process in `ui/`; save
  snapshots in `saves/`; design docs in `spec/`.
- Add deployable entrypoints explicitly to `bitburner.config.json` (sources must
  live under `game/`).
- `bun run build` emits only those entrypoints as bundled JavaScript under
  `build/`.
- The Remote File API pipeline is repository-to-game by default and never
  deletes in-game files.
- Keep pure decision logic separate from Netscript side effects and cover it
  with `bun test`.
- Run `bun run typecheck` and `bun test` before committing. `bun test` is the
  correctness suite only; simulations live in lanes (`bun run long --list`)
  and are worth running when the feature they measure changed.
- Use the pinned upstream checkout documented in `spec/game-source.md` when game
  behavior or API details are unclear.
- Strategy belongs in `shared/strategy/` as pure functions; `game/` drivers
  only move data (build a WorldView, execute Actions). Anything decided in the
  game must be A/B-testable in the simulator.
- Telemetry rule: telemetry may only **send** state the script already holds.
  Every getter, dodge and probe runs unconditionally and writes to the
  game-state store (`game/lib/state.ts`); `TELEMETRY: if (__TELEMETRY__)` wraps
  the send and nothing else. A `--perf` build must be behaviourally identical
  to a telemetry build — only quieter. Concretely: every reference to `tel`,
  `initTelemetry` or the sink sits inside the label, and nothing the controller
  *decides on* (capabilities, BitNode, progression, any probe result) may.
  `tests/build-perf.test.ts` pins both halves.
- Darknet rule: every fact about the darknet carries WHEN it was observed, and is
  checked against the mutation clock before it is acted on. A mutation tick lands
  every ~6 s at the default net depth of 5 in BN15 (30 000/depth ms, twice as
  slow elsewhere), so unstamped topology or credentials are a map of a dead
  world. Expiry is per fact CLASS and derived from the transcribed mutation rates
  (`shared/strategy/dnet/rates.ts`), never guessed. A fact carries no record of
  WHICH agent saw it: that was carried once, read by nothing, and deleted — the
  generation is checked once per rendezvous instead. Agents run on darknet hosts
  because sessions are per-PID and the controller's static RAM is pinned; see
  `spec/dnet.md`.
- The simulator runs the real `game/` controller, so `sim/` may import `game/`
  but never the reverse, and `game/` must stay unaware it is being simulated —
  no clock injection, no sim-only branches. Virtual time is installed under it
  (`sim/realm/timers.ts`); see `spec/simulator.md`.
- Never let the simulator fabricate a value it does not model. An unimplemented
  ns path or subsystem calls `unmodeled()`, which reports and throws. A run that
  blends measured and invented behaviour is worse than one that fails loudly.
- `saves/` holds real exported saves and is destructive to restore. Only
  `game/restore.ts` may touch the game's IndexedDB, and it stays a separate
  entrypoint so the controller can never reach it — `tests/ram-budget.test.ts`
  pins that.
