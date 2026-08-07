# Working in bitburner-scripts

This is a clean-sheet Bitburner automation project. The legacy
`nobody0/bitburner` repository is inspiration only: do not copy its history or
treat its architecture as authoritative.

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
- Run `bun run typecheck` and `bun test` before committing.
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
