# Matching game source

The canonical upstream is
[`bitburner-official/bitburner-src`](https://github.com/bitburner-official/bitburner-src).

- Local checkout: `/Users/bob/git/bitburner-src`
- Steam app ID: `1812820`
- Steam target build ID observed during installation: `23272653`
- Installed game version: `3.0.1` (Steam build `23272653`)
- Pinned upstream ref: `v3.0.1`

Do not follow the moving `dev` branch for compatibility decisions. The Steam
manifest's target build maps to the 3.0.1 release, and the upstream worktree is
checked out directly at its matching release tag.

For type safety, prefer the definition file returned by the running game's
Remote File API. The source checkout remains the authoritative place to inspect
implementation details and version-specific behavior.
