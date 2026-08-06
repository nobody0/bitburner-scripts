# Working in bitburner-scripts

This is a clean-sheet Bitburner automation project. The legacy
`nobody0/bitburner` repository is inspiration only: do not copy its history or
treat its architecture as authoritative.

- Author scripts in `src/` as TypeScript.
- Add deployable entrypoints explicitly to `bitburner.config.json`.
- `bun run build` emits only those entrypoints as bundled JavaScript under
  `build/`.
- The Remote File API pipeline is repository-to-game by default and never
  deletes in-game files.
- Keep pure decision logic separate from Netscript side effects and cover it
  with `bun test`.
- Run `bun run typecheck` and `bun test` before committing.
- Use the pinned upstream checkout documented in `GAME_SOURCE.md` when game
  behavior or API details are unclear.

