# `gang` — BN2 respect automation

The current gang controller deliberately implements a small foundation: create
the BN2 gang, recruit and train members, ascend on an explicit policy threshold,
then grow respect while controlling wanted level. Equipment, money optimization,
territory warfare, and clash management are not implemented yet.

## Source contract

The behavior is pinned to Bitburner v3.0.1 commit
`3162fd2590e221eadd0c0fbd46151913f7c4c41c`.

- BN2 bypasses both Source-File 2 and the `-54,000` karma requirement. Outside
  BN2, an active SF2 and sufficient negative karma are required. Advanced
  options can disable gangs before either path (`PlayerObjectGangMethods.ts`).
- Creation additionally requires membership in one of the seven gang factions.
  NiteSec and The Black Hand create hacking gangs; founding cancels matching
  faction work and resets that faction's reputation to zero (`helpers.ts`,
  `NetscriptFunctions/Gang.ts`, `PlayerObjectGangMethods.ts`).
- New gangs start with respect 1, wanted 1, no members, and warfare disabled.
  New members start at skill 1 on `Unassigned` (`Gang.ts`, `GangMember.ts`).
- The first three recruits are free. Later thresholds are powers of five and
  the roster caps at twelve (`Gang.ts`, `data/Constants.ts`).
- Respect and wanted pricing is transcribed exactly in
  `shared/strategy/gang/formulas.ts`, including task weights, difficulty,
  territory, wanted penalty, `GangSoftcap`, negative vigilante wanted, and the
  positive-wanted cap (`formulas/formulas.ts`). Rates are per game cycle; UI
  values multiply them by five to display per-second rates.
- Ascension results are post/pre multiplier ratios. Ascending clears experience
  and ordinary upgrades, preserves augmentations, and deducts the member's
  earned respect. The controller's `1.15x` threshold is a heuristic policy, not
  an upstream crossover formula (`GangMember.ts`).
- Only members assigned to `Territory Warfare` contribute power or risk death.
  This controller never assigns that task and always disengages warfare.

All relied-upon source files are hashed in `sim/transcription-sources.ts`; a
vendor refresh fails until changes are re-audited.

## Controller policy

Each 10-second pass observes a fresh gang snapshot, complete allowed task
catalog, member information, ascension results, recruit count, and effective
`GangSoftcap`. It then performs one readable phase:

1. Recruit every available member with deterministic collision-free names and
   immediately assign combat or hacking training.
2. Otherwise ascend at most one eligible member, highest gain first with a name
   tie-break, and immediately return it to training.
3. Price every productive task for every member with the pinned formulas.
4. Start from maximum respect per member, then replace the least expensive
   producers with `Vigilante Justice` until raw wanted gain is non-positive.
   At least one respect producer remains; any unavoidable positive wanted is
   reported as best effort.
5. Members unable to produce positive respect keep training.

All assignments selected in a pass execute immediately. Individual failures are
recorded and the next fresh probe reconciles actual state, so no stale action
queue is replayed.

## Boundaries and testing

`shared/strategy/gang/` owns pure formulas and policy;
`game/lib/features/gang.ts` owns side effects; `gang.core` in
`game/lib/probes/priced.ts` owns observation; the Gang topic and tab expose the
phase, desired assignments, predicted rates, and action outcomes.

There is no gang simulator model. Formula, policy, probe, driver, creation, UI,
startup, and upstream-hash tests provide coverage without fabricating unmodeled
game behavior.
