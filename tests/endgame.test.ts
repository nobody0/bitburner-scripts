import { describe, expect, test } from "bun:test";
import { bitNodeMultipliers, effectiveBitNodeMultipliers } from "../shared/features/bitnode.ts";
import {
  BLACK_OP_COUNT,
  LABYRINTH_AUGMENTATIONS,
  RED_PILL,
  daedalusAugsRequired,
  labyrinthOffersRedPill,
  stepEndgame,
} from "../shared/strategy/progression/endgame.ts";
import { parseGoal } from "../shared/goals/presets.ts";
import { freshEndgameView as view } from "./fixtures/endgame-view.ts";

describe("per-node multipliers without the 4 GB getter", () => {
  test("the optional SF5 reading overrides rather than replaces the static baseline", () => {
    const mults = effectiveBitNodeMultipliers(8, 0, { ScriptHackMoney: 0.123 })!;
    expect(mults.ScriptHackMoney).toBe(0.123);
    expect(mults.ScriptHackMoneyGain).toBe(0);
    expect(mults.FourSigmaMarketDataCost).toBe(1);
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

  test("a banked Red Pill makes its end-loaded transaction route-mandatory", () => {
    const daedalus = stepEndgame(view({
      augCount: 30,
      money: 100e9,
      hackingSkill: 3000,
      daedalusRep: 2_500_000,
      queuedAugs: [RED_PILL],
      ownsRedPill: false,
    })).routes.find((route) => route.id === "daedalus")!;

    expect(daedalus).toMatchObject({
      stage: "red-pill-install",
      mandatoryInstall: { augmentation: RED_PILL, ready: true },
    });
    expect(daedalus.complete).toBe(false);
  });

  test("the BN2 gang route also treats its banked Red Pill as mandatory", () => {
    const gang = stepEndgame(view({
      bitNode: 2,
      gangAvailable: true,
      inGang: true,
      gangFaction: "Slum Snakes",
      gangFactionRep: 2_500_000,
      queuedAugs: [RED_PILL],
      ownsRedPill: false,
    })).routes.find((route) => route.id === "gang")!;

    expect(gang).toMatchObject({
      stage: "red-pill-install",
      mandatoryInstall: { augmentation: RED_PILL, ready: true },
    });
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

  test("the Red Pill route also waits for admin rights on the world daemon", () => {
    const d = stepEndgame(view({
      ownsRedPill: true,
      redPillInstalled: true,
      hackingSkill: 3_000,
      worldDaemonRooted: false,
    }));
    const daedalus = d.routes.find((route) => route.id === "daedalus")!;
    expect(daedalus).toMatchObject({ complete: false, stage: "world-daemon-root" });
    expect(daedalus.blocker).toContain("root");
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

  test("all four mechanical routes are represented, with impossible routes exited early", () => {
    const bn1 = stepEndgame(view({ bitNode: 1 }));
    expect(bn1.routes.map((route) => route.id)).toEqual(["daedalus", "gang", "labyrinth", "bladeburner"]);
    expect(bn1.routes.find((route) => route.id === "gang")!.available).toBe(false);

    const bn2 = stepEndgame(view({ bitNode: 2, gangAvailable: true, inGang: true, gangFaction: "Slum Snakes" }));
    expect(bn2.routes.find((route) => route.id === "gang")).toMatchObject({
      available: true,
      stage: "gang-reputation",
      optionalInstall: { allowed: true },
    });

    const bn15 = stepEndgame(view({ bitNode: 15, darknetAvailable: true }));
    expect(bn15.routes.find((route) => route.id === "daedalus")!.available).toBe(false);
    expect(bn15.routes.find((route) => route.id === "labyrinth")!.available).toBe(true);
  });

  test("DarkscapeNavigator access makes the labyrinth real without SF15", () => {
    const labyrinth = stepEndgame(view({ bitNode: 1, darknetAvailable: true })).routes.find(
      (route) => route.id === "labyrinth",
    )!;
    expect(labyrinth.available).toBe(true);
  });

  test("labyrinth rewards must be installed in sequence before The Red Pill", () => {
    const first = stepEndgame(view({ darknetAvailable: true })).routes.find((route) => route.id === "labyrinth")!;
    expect(first.blocker).toContain(LABYRINTH_AUGMENTATIONS[0]);
    expect(first.optionalInstall.allowed).toBe(false);

    const queued = stepEndgame(view({
      darknetAvailable: true,
      queuedAugs: [LABYRINTH_AUGMENTATIONS[0]],
    })).routes.find((route) => route.id === "labyrinth")!;
    expect(queued.mandatoryInstall).toMatchObject({ augmentation: LABYRINTH_AUGMENTATIONS[0], ready: true });

    const allRewards = Object.fromEntries(LABYRINTH_AUGMENTATIONS.map((name) => [name, 1]));
    const pill = stepEndgame(view({ darknetAvailable: true, installedAugs: allRewards })).routes.find(
      (route) => route.id === "labyrinth",
    )!;
    expect(pill.blocker).toContain(RED_PILL);
  });

  test("Daedalus's final batch is node-relative and suppresses another partial install", () => {
    const route = stepEndgame(view({ bitNode: 6, augCount: 24 })).routes.find((candidate) => candidate.id === "daedalus")!;
    expect(daedalusAugsRequired(6)).toBe(35);
    expect(route.optionalInstall.allowed).toBe(false);
    expect(route.optionalInstall.why).toContain("at least 6 of the remaining 11");

    const before = stepEndgame(view({ bitNode: 1, augCount: 9 })).routes.find(
      (candidate) => candidate.id === "daedalus",
    )!;
    expect(before.optionalInstall.allowed).toBe(true);
    const weakMiddleBatch = stepEndgame(view({
      bitNode: 1,
      augCount: 14,
      queuedAugs: ["banked-a", "banked-b"],
    })).routes.find((candidate) => candidate.id === "daedalus")!;
    expect(weakMiddleBatch.optionalInstall.allowed).toBe(false);
    expect(weakMiddleBatch.optionalInstall.why).toContain("at least 8 of the remaining 16");

    const substantialMiddleBatch = stepEndgame(view({
      bitNode: 1,
      augCount: 14,
      queuedAugs: Array.from({ length: 8 }, (_, index) => `middle-${index}`),
    })).routes.find((candidate) => candidate.id === "daedalus")!;
    expect(substantialMiddleBatch.optionalInstall.allowed).toBe(true);

    const weakLateBatch = stepEndgame(view({
      bitNode: 1,
      augCount: 20,
      queuedAugs: ["late-a", "late-b", "late-c"],
    })).routes.find((candidate) => candidate.id === "daedalus")!;
    expect(weakLateBatch.optionalInstall.allowed).toBe(false);
    expect(weakLateBatch.optionalInstall.why).toContain("at least 5 of the remaining 10");

    const substantialLateBatch = stepEndgame(view({
      bitNode: 1,
      augCount: 16,
      queuedAugs: Array.from({ length: 9 }, (_, index) => `substantial-${index}`),
    })).routes.find((candidate) => candidate.id === "daedalus")!;
    // A substantial middle batch remains valid even when it lands inside the
    // closing quarter. The NEXT cycle starts there and must close completely;
    // this distinguishes 16 -> 25 from the bad 20 -> 23 tiny reset.
    expect(substantialLateBatch.optionalInstall.allowed).toBe(true);

    const gateClosingBatch = stepEndgame(view({
      bitNode: 1,
      augCount: 16,
      queuedAugs: Array.from({ length: 14 }, (_, index) => `closing-${index}`),
    })).routes.find((candidate) => candidate.id === "daedalus")!;
    expect(gateClosingBatch.optionalInstall.allowed).toBe(true);

    const incompleteClosingBatch = stepEndgame(view({
      bitNode: 1,
      augCount: 26,
      queuedAugs: ["closing-a", "closing-b"],
    })).routes.find((candidate) => candidate.id === "daedalus")!;
    expect(incompleteClosingBatch.optionalInstall.allowed).toBe(false);
    expect(incompleteClosingBatch.optionalInstall.why).toContain("at least 4 of the remaining 4");

    const completeClosingBatch = stepEndgame(view({
      bitNode: 1,
      augCount: 26,
      queuedAugs: ["closing-a", "closing-b", "closing-c", "closing-d"],
    })).routes.find((candidate) => candidate.id === "daedalus")!;
    expect(completeClosingBatch.optionalInstall.allowed).toBe(true);
  });

  test("faction-reputation routes let the cadence trade current rep for favor", () => {
    const daedalus = stepEndgame(view({
      augCount: 30,
      money: 100e9,
      hackingSkill: 2_500,
      daedalusRep: 1_000_000,
    })).routes.find((route) => route.id === "daedalus")!;
    expect(daedalus).toMatchObject({ stage: "red-pill-reputation", optionalInstall: { allowed: true } });
    expect(daedalus.optionalInstall.why).toContain("favor");
  });

  test("a finished labyrinth run is not credited to Daedalus", () => {
    // All Red Pill routes share a tail, so `complete` is true once
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
  test("bn: requires the observed terminal transition, not Red Pill readiness", () => {
    const goal = parseGoal("bn:1");
    const ctx = {
      time: 0,
      player: { money: 100e9, hackingSkill: 3000, hackingExp: 0, karma: 0, numPeopleKilled: 0 },
      servers: new Map(),
      totals: { moneyEarned: 0, hacks: 0 },
      stockPortfolioValue: 0,
      factions: new Map(),
      augmentations: new Set(Array.from({ length: 30 }, (_, i) => `aug${i}`)),
      installedAugmentations: new Set<string>(),
      installs: 0,
      completedBitNodes: new Set<number>(),
    };
    expect(goal.done(ctx)).toBe(false);
    ctx.augmentations.add("The Red Pill");
    expect(goal.done(ctx)).toBe(false);
    ctx.installedAugmentations.add("The Red Pill");
    expect(goal.done(ctx)).toBe(false);
    ctx.completedBitNodes.add(1);
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
