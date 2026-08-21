# Goals

A goal is a predicate over records using the shared telemetry schema.
`shared/goals/evaluate.ts` is the single goal-specific reducer for compatible
live and simulator records, producing a `GoalContext` (player, servers, hack
totals, time). The browser keeps a separate UI projection because it retains
raw server fields and an event feed. "Time to goal" is the `t` of the record
that first satisfies the predicate.

Detailed `hack.done` records are simulator-only: live farming deliberately
avoids per-operation events. Live `earn:`/hack-count totals come from the 1 Hz
`farm` rollup instead (`shared/telemetry/state-map.ts`; see `spec/telemetry.md`).

## Forms (`shared/goals/goal.ts`)

- **Declarative** (preferred): `goalFrom(id, constraints)` — a minimum-state
  object compiled to a predicate, e.g.
  `{ player: { money: { gte: 1e9 } } }` or
  `{ servers: { home: { maxRam: { gte: 65536 } } } }`.
- **Raw predicate**: implement `Goal.done(ctx)` directly for anything the
  declarative form can't express.
- **Restriction**: `Goal.allows(action)` narrows the strategy space ("do ONLY
  hacking"). The sim driver filters planner output through it and emits
  `action.blocked` events, so an over-eager planner stays visible.
- **Setup**: `Goal.setup` declares sim-only initial conditions (home RAM,
  starting money).
- **Composition**: `allOf(...goals)` — done = every, allows = intersection,
  setup = merge. This is how sub-goals build toward "complete a BitNode":
  compose the milestones, measure each.

## CLI presets (`shared/goals/presets.ts`)

`earn:1e9` (hacking income), `money:1e9` (cash on hand), `skill:100`,
`ram:home:512` (or `ram:512`), `only:hack,grow,weaken`. Repeatable `--goal`
flags compose with `allOf`:

```
bun run sim -- --goal earn:1e6 --goal only:hack,grow,weaken,nuke --seeds 1..10 --horizon 12h
bun run sim:compare runs/a.jsonl runs/b.jsonl
```

A/B across code changes: run on branch A, keep the JSONL, switch branches,
rerun with the same goal/seed, compare. Each run's JSONL carries `sim.meta`
(label = git rev by default) and `sim.result` events.
