import type { EndgameView } from "../../shared/strategy/progression/endgame.ts";

/** THE fresh-BN1 baseline EndgameView, shared by every endgame suite.
 *
 * One copy on purpose: two byte-identical builders once lived in
 * tests/endgame.test.ts and tests/endgame-eta.test.ts, and a new OPTIONAL
 * field added to one baseline but not the other would have made the suites
 * silently test different worlds (a required field fails tsc in both;
 * optionals drift without a sound). Not a .test file, so bun test does not
 * collect it. */
export function freshEndgameView(over: Partial<EndgameView> = {}): EndgameView {
  return {
    bitNode: 1,
    sourceFiles: {},
    augCount: 0,
    ownsRedPill: false,
    redPillInstalled: false,
    money: 0,
    hackingSkill: 1,
    lowestCombatSkill: 1,
    daedalusRep: 0,
    inBladeburner: false,
    blackOpsComplete: 0,
    ...over,
  };
}
