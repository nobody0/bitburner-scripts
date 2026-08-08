import { describe, expect, test } from "bun:test";
import { bitNodeMultipliers, worldDaemonSkill } from "../shared/features/bitnode.ts";
import {
  BLACK_OP_COUNT,
  daedalusAugsRequired,
  labyrinthOffersRedPill,
  stepEndgame,
  type EndgameView,
} from "../shared/strategy/progression/endgame.ts";
import { parseGoal } from "../shared/goals/presets.ts";

function view(over: Partial<EndgameView> = {}): EndgameView {
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

describe("per-node multipliers without the 4 GB getter", () => {
  test("BN14's hacking speed penalty is visible, not defaulted to 1", () => {
    // The bug this table exists to kill: assuming 1.0 here mis-times every
    // HWGW batch in BN14 by a factor of 3.3.
    expect(bitNodeMultipliers(14)!.HackingSpeedMultiplier).toBe(0.3);
    expect(bitNodeMultipliers(15)!.HackingSpeedMultiplier).toBe(0.6);
    expect(bitNodeMultipliers(1)!.HackingSpeedMultiplier).toBe(1);
  });

  test("w0r1d_d43m0n's requirement scales with the node", () => {
    expect(worldDaemonSkill(1)).toBe(3000);
    expect(worldDaemonSkill(2)).toBe(15000);
    expect(worldDaemonSkill(14)).toBe(15000);
    expect(worldDaemonSkill(8)).toBe(3000);
  });

  test("an unknown node is undefined, never BN1", () => {
    // BN1 is the all-ones baseline, so guessing it is the worst possible
    // default — every multiplier silently becomes "no effect".
    expect(bitNodeMultipliers(undefined)).toBeUndefined();
    expect(worldDaemonSkill(99)).toBeUndefined();
  });

  test("Daedalus's augmentation gate is node-dependent", () => {
    expect(daedalusAugsRequired(1)).toBe(30);
    expect(daedalusAugsRequired(15)).toBe(20);
    expect(daedalusAugsRequired(6)).toBe(35);
  });

  test("BN12 derives from the source-file level and caps Daedalus at 40", () => {
    expect(daedalusAugsRequired(12, 0)).toBe(31);
    expect(daedalusAugsRequired(12, 500)).toBe(40);
    expect(bitNodeMultipliers(12, 0)!.HackingLevelMultiplier).toBe(1);
    expect(bitNodeMultipliers(12, 10)!.HackingLevelMultiplier).toBeCloseTo(1 / 1.02 ** 10, 12);
  });
});

describe("endgame routes", () => {
  test("the labyrinth offers the Red Pill everywhere except BN8", () => {
    for (let n = 1; n <= 15; n++) {
      expect(labyrinthOffersRedPill(n), `BN${n}`).toBe(n !== 8);
    }
  });

  test("owning the Red Pill is not enough — it must be installed", () => {
    const d = stepEndgame(view({ augCount: 30, money: 100e9, hackingSkill: 3000, daedalusRep: 3e6, ownsRedPill: true }));
    expect(d.best!.complete).toBe(false);
    expect(d.best!.blocker).toContain("install");
  });

  test("the install resets the skill, so the regrow is a distinct phase", () => {
    // Exactly the trap: pill owned AND installed, but hacking is back at 1.
    const d = stepEndgame(
      view({ augCount: 30, money: 100e9, hackingSkill: 1, ownsRedPill: true, redPillInstalled: true }),
    );
    expect(d.awaitingRegrow).toBe(true);
    expect(d.best!.complete).toBe(false);
    expect(d.best!.blocker).toContain("3000");
  });

  test("Daedalus completes once the pill is installed and the skill regrown", () => {
    const d = stepEndgame(
      view({ augCount: 30, money: 100e9, hackingSkill: 3000, ownsRedPill: true, redPillInstalled: true }),
    );
    expect(d.awaitingRegrow).toBe(false);
    expect(d.routes.find((r) => r.id === "daedalus")!.complete).toBe(true);
  });

  test("Daedalus accepts the combat branch, not only hacking", () => {
    const blocked = stepEndgame(view({ augCount: 30, money: 100e9, hackingSkill: 100, lowestCombatSkill: 100 }));
    expect(blocked.routes[0]!.blocker).toContain("combat");
    const combat = stepEndgame(view({ augCount: 30, money: 100e9, hackingSkill: 100, lowestCombatSkill: 1500 }));
    expect(combat.routes[0]!.blocker).toContain("reputation");
  });

  test("the Bladeburner route needs no Red Pill and no hacking at all", () => {
    // All black ops satisfies destroyW0r1dD43m0n on its own — the route that
    // a Red-Pill-shaped planner would never find.
    const d = stepEndgame(view({ inBladeburner: true, blackOpsComplete: BLACK_OP_COUNT }));
    const bb = d.routes.find((r) => r.id === "bladeburner")!;
    expect(bb.complete).toBe(true);
    expect(d.best!.id).toBe("bladeburner");
    expect(d.why).toContain("complete");
  });

  test("the labyrinth route needs dark web access and is dead in BN8", () => {
    expect(stepEndgame(view({ bitNode: 1 })).routes.find((r) => r.id === "labyrinth")!.available).toBe(false);
    expect(
      stepEndgame(view({ bitNode: 1, sourceFiles: { "15": 1 } })).routes.find((r) => r.id === "labyrinth")!
        .available,
    ).toBe(true);
    expect(
      stepEndgame(view({ bitNode: 8, sourceFiles: { "15": 3 } })).routes.find((r) => r.id === "labyrinth")!
        .blocker,
    ).toContain("BN8");
  });

  test("a finished labyrinth run is not credited to Daedalus", () => {
    // Both Red Pill routes share a tail, so `complete` is true for both once
    // the pill is in. The explanation must not invent an acquisition history.
    const d = stepEndgame(
      view({
        sourceFiles: { "15": 1 },
        ownsRedPill: true,
        redPillInstalled: true,
        hackingSkill: 3000,
        daedalusRep: 0,
        augCount: 0,
      }),
    );
    expect(d.why).toContain("The Red Pill");
    expect(d.why).not.toContain("daedalus");
  });

  test("an unknown BitNode reports no route rather than assuming BN1", () => {
    const d = stepEndgame(view({ bitNode: undefined }));
    expect(d.best).toBeUndefined();
    expect(d.worldDaemonSkill).toBeUndefined();
  });
});

describe("BitNode goal presets", () => {
  test("bn: composes the Daedalus, Red Pill and world-daemon milestones", () => {
    const goal = parseGoal("bn:1");
    const ctx = {
      time: 0,
      player: { money: 100e9, hackingSkill: 3000, hackingExp: 0, karma: 0, numPeopleKilled: 0 },
      servers: new Map(),
      totals: { moneyEarned: 0, hacks: 0 },
      factions: new Map(),
      augmentations: new Set(Array.from({ length: 30 }, (_, i) => `aug${i}`)),
    };
    // 30 augs, the money and the skill, but no Red Pill: not done.
    expect(goal.done(ctx)).toBe(false);
    ctx.augmentations.add("The Red Pill");
    expect(goal.done(ctx)).toBe(true);
  });

  test("the milestones follow the node, not BN1's numbers", () => {
    expect(parseGoal("wd:14").describe()).toContain("15000");
    expect(parseGoal("daedalus:15").describe()).toContain("20 augs");
  });

  test("an unknown node is rejected rather than silently treated as BN1", () => {
    expect(() => parseGoal("wd:99")).toThrow();
    expect(() => parseGoal("daedalus:0")).toThrow();
  });
});
