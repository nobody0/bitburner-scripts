import { describe, expect, test } from "bun:test";
import type { NS } from "@ns";
import {
  FEATURE_MODULES,
  noGrants,
  type ClaimContext,
  type DriverContext,
  type NeedContext,
} from "../game/lib/features/index.ts";
import { PRICED_PROBES } from "../game/lib/probes/index.ts";
import { probeCtx } from "./support/probe-fixture.ts";
import { initState } from "../game/lib/state.ts";
import { deriveCapabilities } from "../shared/features/unlock.ts";
import { assignIndependent } from "../shared/strategy/assignment.ts";
import { BLACKOP_CONFIDENCE, STAMINA_FLOOR, stepBladeburner } from "../shared/strategy/bladeburner/decide.ts";
import { reachableFrom, stepDarknet, unlockValue } from "../shared/strategy/dnet/decide.ts";
import { darknetRoute } from "../game/lib/features/dnet.ts";
import { discoverReports, emptyKnowledge, foldKnowledgeReports } from "../shared/strategy/dnet/host.ts";
import { msPerHostEvent } from "../shared/strategy/dnet/rates.ts";
import { ASCEND_THRESHOLD, stepGang } from "../shared/strategy/gang/decide.ts";
import {
  decideGoNeural,
  finalizeNeuralGoDecision,
  GoNeuralEngine,
  prepareNeuralGoDecision,
} from "../shared/strategy/go/neural/engine.ts";
import { StubGoValueBackend } from "./support/go-value-backend.ts";
import { rankGoGames } from "../shared/strategy/go/rewards.ts";
import { postNeeds } from "../shared/strategy/needs.ts";
import {
  BASELINE_ORDER,
  bankedFavorActivationValue,
  earlyCountBatchAllowed,
  chooseNextBitNode,
  dwellInstallVerdict,
  INSTALL_VERDICT_OVERHEAD_SEC,
  PUSH_MARGIN,
  bestOrdering,
  favorCrossings,
  installCadencePushRate,
  installCadenceRemainingSec,
  installVerdict,
  LAB_CACHE_DEFER_MS,
  labCacheDeferral,
  routeCountInstallValue,
  orderingCost,
  phaseOf,
  stepProgression,
} from "../shared/strategy/progression/decide.ts";
import { scoreAugMults, weightsFromMarginals } from "../shared/strategy/factions/augs.ts";

/** Representative route-channel values used by the progression fixtures. */
const WORTH = new Map([["money", 1_000], ["hacking", 19_174], ["reputation", 49_505]]);
import { canSolve, solve } from "../shared/strategy/side/contracts.ts";
import { shockMultiplier, stepSleeves } from "../shared/strategy/sleeves/decide.ts";
import { distinctRotations, packFragments } from "../shared/strategy/stanek/pack.ts";
// stock has outgrown this file — see tests/stock.test.ts

// --- independent assignment --------------------------------------------------

describe("assignment", () => {
  test("independent assignment is the exact per-agent argmax", () => {
    const agents = ["a", "b"];
    const tasks = [1, 2, 3];
    const result = assignIndependent(agents, tasks, (agent, task) => (agent === "a" ? task : -task), String);
    expect(result.choices.map((c) => c.task)).toEqual([3, 1]);
    expect(result.approximated).toBe(false);
  });

});

describe("gang", () => {
  const task = (name: string, over: Record<string, unknown> = {}) => ({
    name, baseRespect: 0, baseWanted: 0,
    difficulty: 1, hackWeight: 0, strWeight: 25, defWeight: 25, dexWeight: 25, agiWeight: 0, chaWeight: 25,
    territory: { respect: 1, wanted: 1 }, ...over,
  });
  const member = (name: string, memberTask = "Unassigned", skill = 100) => ({
    name, task: memberTask,
    skills: { hack: skill, str: skill, def: skill, dex: skill, agi: skill, cha: skill },
    ascensionGain: 0,
  });
  const view = (over: Partial<Parameters<typeof stepGang>[0]> = {}): Parameters<typeof stepGang>[0] => ({
    isHacking: false, respect: 100, wantedLevel: 1, territory: 0.2,
    territoryWarfareEngaged: false, gangSoftcap: 1, recruitsAvailable: 0,
    members: [member("a")],
    tasks: [
      task("Mug People", { baseRespect: 0.001, baseWanted: 0.1 }),
      task("Vigilante Justice", { baseWanted: -0.001 }),
      task("Train Combat"), task("Train Hacking"), task("Territory Warfare"),
    ],
    ...over,
  });

  test("fresh gangs recruit every available member with deterministic names and training", () => {
    expect(stepGang(view({ members: [], recruitsAvailable: 3 })).actions).toEqual([
      { type: "recruit", name: "member-1", task: "Train Combat" },
      { type: "recruit", name: "member-2", task: "Train Combat" },
      { type: "recruit", name: "member-3", task: "Train Combat" },
    ]);
  });

  test("recruitment precedes ascension and hacking gangs train hacking", () => {
    expect(stepGang(view({ isHacking: true, recruitsAvailable: 1, members: [member("member-1")] })).actions)
      .toEqual([{ type: "recruit", name: "member-2", task: "Train Hacking" }]);
  });

  test("ascends one best member at the threshold with a deterministic tie", () => {
    const members = [member("b"), member("a")];
    members[0]!.ascensionGain = ASCEND_THRESHOLD;
    members[1]!.ascensionGain = ASCEND_THRESHOLD;
    expect(stepGang(view({ members })).actions).toContainEqual({ type: "ascend", member: "a", task: "Train Combat" });
  });

  test("balances wanted while retaining one respect producer", () => {
    const decision = stepGang(view({ members: [member("a"), member("b"), member("c")] }));
    expect(decision.assignments.filter((entry) => entry.respect > 0)).toHaveLength(1);
    expect(decision.assignments.some((entry) => entry.task === "Vigilante Justice")).toBe(true);
  });

  test("trains weak members and always disables warfare", () => {
    const weak = stepGang(view({ members: [member("a", "Unassigned", 1)] }));
    expect(weak.actions).toContainEqual({ type: "assign", member: "a", task: "Train Combat" });
    expect(stepGang(view({ territoryWarfareEngaged: true })).actions[0]).toEqual({ type: "warfare" });
  });

  test("the driver recruits and trains the whole fresh batch in one pass", async () => {
    const state = initState();
    state.topics.gang = {
      faction: "Slum Snakes", isHacking: false,
      respect: 1, respectGainRate: 0, wantedLevel: 1, wantedLevelGainRate: 0,
      wantedPenalty: 0.5, moneyGainRate: 0, territory: 0.1,
      territoryWarfareEngaged: false,
      respectForNextRecruit: 0, recruitsAvailable: 3,
      members: [], tasks: view().tasks, gangSoftcap: 1,
    };
    const calls: { path: string; args: unknown[] }[] = [];
    const ctx = {
      ns: {} as NS,
      nsp: async (path: string, ...args: unknown[]) => {
        calls.push({ path, args });
        return true;
      },
      state,
      caps: deriveCapabilities({ bitNode: 2, inGang: true }),
      grants: noGrants(),
    } as unknown as DriverContext;
    await FEATURE_MODULES.gang.driver.tick(ctx);
    expect(calls.map((call) => call.path)).toEqual([
      "gang.recruitMember", "gang.setMemberTask",
      "gang.recruitMember", "gang.setMemberTask",
      "gang.recruitMember", "gang.setMemberTask",
    ]);
    expect(state.topics.gang.plan?.lastResults).toHaveLength(3);
  });
});

// --- bladeburner --------------------------------------------------------------

describe("bladeburner", () => {
  const action = (over: Partial<Parameters<typeof stepBladeburner>[0]["actions"][number]> = {}) => ({
    type: "contract" as const,
    name: "Tracking",
    chance: [0.9, 0.95] as [number, number],
    timeMs: 30_000,
    countRemaining: 100,
    rankGain: 5,
    rankLoss: 1,
    ...over,
  });
  const view = (over: Partial<Parameters<typeof stepBladeburner>[0]> = {}) => ({
    rank: 100,
    skillPoints: 0,
    stamina: [100, 100] as [number, number],
    chaos: 0,
    actions: [action()],
    skills: {},
    ...over,
  });

  test("the conservative stamina policy stops below the penalty threshold", () => {
    expect(stepBladeburner(view({ stamina: [40, 100] })).action.type).toBe("stop");
    expect(stepBladeburner(view({ stamina: [STAMINA_FLOOR * 100 + 1, 100] })).action.type).toBe("act");
  });

  test("every decision uses the PESSIMISTIC end of the chance interval", () => {
    // The game reports [min, max] because the estimate is imprecise. Acting on
    // the optimistic end is exactly how a Black Op gets failed.
    const decision = stepBladeburner(view({ actions: [action({ chance: [0.1, 0.99] })] }));
    expect(decision.ranked[0]!.chanceLow).toBe(0.1);
  });

  test("failed-action rank loss is included in expected rank", () => {
    const decision = stepBladeburner(view({ actions: [action({ chance: [0.5, 0.9], rankGain: 10, rankLoss: 6, timeMs: 2_000 })] }));
    expect(decision.ranked[0]!.rankPerSec).toBe(1);
  });

  test("the live probe uses exact API action types and levels only levelable actions", async () => {
    const probe = PRICED_PROBES.find((entry) => entry.id === "bladeburner.actions")!;
    const apiTypes: string[] = [];
    const [emission] = await probe.run(probeCtx({
      "bladeburner.getContractNames": () => ["Tracking"],
      "bladeburner.getOperationNames": () => [],
      "bladeburner.getBlackOpNames": () => ["Operation Typhoon"],
      "bladeburner.getGeneralActionNames": () => ["Diplomacy"],
      "bladeburner.getActionEstimatedSuccessChance": (type: string) => {
        apiTypes.push(type);
        return [1, 1];
      },
      "bladeburner.getActionTime": () => 1_000,
      "bladeburner.getActionCountRemaining": () => 1,
      "bladeburner.getActionCurrentLevel": (type: string) => {
        expect(type).toBe("Contracts");
        return 1;
      },
      "bladeburner.getActionMaxLevel": (type: string) => {
        expect(type).toBe("Contracts");
        return 1;
      },
      "bladeburner.getActionRankGain": () => 50,
      "bladeburner.getActionRankLoss": () => 7,
      "bladeburner.getBlackOpRank": () => 100,
      "bladeburner.getSkillNames": () => [],
    }));
    const actions = (emission!.data as { actions: { rankGain: number; rankLoss: number; level?: number }[] }).actions;
    expect(actions[0]).toMatchObject({ rankGain: 50, rankLoss: 7, level: 1 });
    expect(actions[1]!.level).toBeUndefined();
    expect(actions[2]!.level).toBeUndefined();
    expect(apiTypes).toEqual(["Contracts", "Black Operations", "General"]);
  });

  test("the core probe observes current-city chaos instead of defaulting it", async () => {
    const probe = PRICED_PROBES.find((entry) => entry.id === "bladeburner.core")!;
    const [emission] = await probe.run(probeCtx({
      "bladeburner.getRank": () => 25,
      "bladeburner.getSkillPoints": () => 3,
      "bladeburner.getStamina": () => [50, 100],
      "bladeburner.getCity": () => "Sector-12",
      "bladeburner.getCityChaos": (city: string) => city === "Sector-12" ? 77 : 0,
      "bladeburner.getCurrentAction": () => null,
      "bladeburner.getNextBlackOp": () => ({ name: "Operation Typhoon", rank: 2.5 }),
      "bladeburner.getBlackOpNames": () => ["Operation Typhoon", "Operation Zero"],
    }));
    expect(emission!.data).toMatchObject({ city: "Sector-12", chaos: 77, blackOpsComplete: 0 });
  });

  test("continuing and stopping are distinct decisions", () => {
    expect(stepBladeburner(view({ current: { name: "Tracking" } })).action.type).toBe("continue");
    expect(stepBladeburner(view({ stamina: [40, 100], current: { name: "Tracking" } })).action.type).toBe("stop");
  });

  test("a Bladeburner action claims Player.currentWork only without the installed Simulacrum", () => {
    const module = FEATURE_MODULES.bladeburner;
    const state = initState();
    state.topics.bladeburner = {
      rank: 0,
      skillPoints: 0,
      stamina: [1, 1],
      city: "Sector-12",
      chaos: 0,
      plan: { action: { type: "act", actionType: "contract", name: "Tracking" }, ranked: [] },
    };
    const progression = { ownedAugs: {} as Record<string, number> };
    state.topics.progression = progression as never;
    const context = {
      state,
      caps: deriveCapabilities({ bitNode: 6 }),
      now: 0,
      budgetGb: 100,
      horizons: {},
      board: postNeeds([]),
    } as unknown as ClaimContext;
    expect(module.claims?.(context).some((claim) => claim.resource === "time")).toBe(true);
    state.topics.bladeburner!.current = { type: "Contracts", name: "Tracking", elapsedMs: 0 };
    state.topics.bladeburner!.plan!.action = { type: "upgrade", skill: "Overclock" };
    expect(module.claims?.(context).some((claim) => claim.resource === "time")).toBe(true);
    progression.ownedAugs["The Blade's Simulacrum"] = 1;
    expect(module.claims?.(context).some((claim) => claim.resource === "time")).toBe(false);
  });

  test("a Black Op below the confidence bar is REFUSED, not gambled on", () => {
    const risky = action({ type: "blackop", name: "Operation Typhoon", chance: [BLACKOP_CONFIDENCE - 0.01, 1], rankNeeded: 0, rankGain: 1000 });
    const safe = action({ name: "Tracking", rankGain: 1 });
    const decision = stepBladeburner(view({ actions: [risky, safe] }));
    expect(decision.action.type === "act" && decision.action.name).toBe("Tracking");
  });

  test("a confident Black Op is taken", () => {
    const ready = action({ type: "blackop", name: "Operation Typhoon", chance: [1, 1], rankNeeded: 0, rankGain: 1000 });
    const decision = stepBladeburner(view({ actions: [ready, action()] }));
    expect(decision.action.type === "act" && decision.action.name).toBe("Operation Typhoon");
  });

  test("later Black Ops stay unavailable until the ordered predecessor completes", () => {
    const next = action({ type: "blackop", name: "Operation Typhoon", rankNeeded: 1_000 });
    const later = action({ type: "blackop", name: "Operation Zero", rankNeeded: 0, rankGain: 10_000 });
    const decision = stepBladeburner(view({ rank: 100, actions: [next, later, action()] }));
    expect(decision.action.type === "act" && decision.action.name).toBe("Tracking");
    expect(decision.ranked.some((entry) => entry.actionType === "blackop")).toBe(false);
  });

  test("fractional action counts are not yet startable", () => {
    expect(stepBladeburner(view({ actions: [action({ countRemaining: 0.99 })] })).action.type).toBe("stop");
  });

  test("Diplomacy and Black Ops continue instead of resetting their progress", () => {
    const diplomacy = action({ type: "general", name: "Diplomacy", countRemaining: Infinity });
    expect(stepBladeburner(view({ chaos: 100, actions: [diplomacy], current: { name: "Diplomacy" } })).action.type).toBe("continue");

    const blackOp = action({ type: "blackop", name: "Operation Typhoon", chance: [1, 1], rankNeeded: 0 });
    expect(stepBladeburner(view({ actions: [blackOp], current: { name: blackOp.name } })).action.type).toBe("continue");
  });

  test("skill points are spent rather than hoarded", () => {
    const decision = stepBladeburner(view({ skillPoints: 10, skills: { "Blade's Intuition": { upgradeCost: 3 } } }));
    expect(decision.action.type).toBe("upgrade");
  });

  test("rank strategy does not buy money-only or experience-only skills", () => {
    const decision = stepBladeburner(view({
      skillPoints: 10,
      skills: {
        "Hands of Midas": { upgradeCost: 1 },
        Hyperdrive: { upgradeCost: 1 },
      },
    }));
    expect(decision.action.type).toBe("act");
  });

  test("a non-finite stale skill quote is never treated as affordable", () => {
    const decision = stepBladeburner(view({
      skillPoints: 10,
      skills: { Overclock: { upgradeCost: Infinity } },
    }));
    expect(decision.action.type).toBe("act");
  });

  test("high chaos is reduced by Diplomacy before anything else", () => {
    const decision = stepBladeburner(
      view({ chaos: 100, actions: [action(), action({ type: "general", name: "Diplomacy", countRemaining: Infinity })] }),
    );
    expect(decision.action.type === "act" && decision.action.name).toBe("Diplomacy");
  });

  test("the driver records a successful start immediately and does not restart before the next probe", async () => {
    const state = initState();
    state.topics = {
      bladeburner: {
        rank: 100,
        skillPoints: 0,
        stamina: [100, 100],
        city: "Sector-12",
        chaos: 0,
        actions: [{ ...action(), level: 1 }],
        skills: {},
      },
      progression: { ownedAugs: {} },
    } as never;
    const calls: { path: string; args: unknown[] }[] = [];
    const ctx = {
      ns: {} as NS,
      nsp: async (path: string, ...args: unknown[]) => {
        calls.push({ path, args });
        return true;
      },
      state,
      caps: deriveCapabilities({ bitNode: 6, inBladeburner: true }),
      grants: { ...noGrants(), slot: true },
    } as unknown as DriverContext;

    await FEATURE_MODULES.bladeburner.driver.tick(ctx);
    await FEATURE_MODULES.bladeburner.driver.tick(ctx);

    expect(calls).toEqual([{ path: "bladeburner.startAction", args: ["Contracts", "Tracking"] }]);
    expect(state.topics.bladeburner?.current).toMatchObject({ type: "Contracts", name: "Tracking" });
  });

  test("the driver does not repeat a skill purchase against a stale cost", async () => {
    const state = initState();
    state.topics = {
      bladeburner: {
        rank: 100,
        skillPoints: 10,
        stamina: [100, 100],
        city: "Sector-12",
        chaos: 0,
        actions: [{ ...action(), level: 1 }],
        skills: { Overclock: { level: 1, upgradeCost: 3 } },
      },
      progression: { ownedAugs: {} },
    } as never;
    const calls: string[] = [];
    const ctx = {
      ns: {} as NS,
      nsp: async (path: string) => {
        calls.push(path);
        return true;
      },
      state,
      caps: deriveCapabilities({ bitNode: 6, inBladeburner: true }),
      grants: { ...noGrants(), slot: true },
    } as unknown as DriverContext;

    await FEATURE_MODULES.bladeburner.driver.tick(ctx);
    await FEATURE_MODULES.bladeburner.driver.tick(ctx);

    expect(calls).toEqual(["bladeburner.upgradeSkill", "bladeburner.startAction"]);
    expect(state.topics.bladeburner?.skillPoints).toBe(7);
  });
});

// --- sleeves ------------------------------------------------------------------

describe("sleeves", () => {
  const sleeve = (index: number, shock = 0, sync = 100) => ({ index, shock, sync, city: "Sector-12", skills: {} });
  const tasks = [
    { type: "recovery" as const, outcomes: [{ rates: {} }] },
    { type: "synchro" as const, outcomes: [{ rates: {} }] },
    { type: "crime" as const, detail: "Homicide", outcomes: [{ rates: { karma: 1 }, shockExemptRates: { money: 100 } }] },
    { type: "crime" as const, detail: "Heist", outcomes: [{ rates: { karma: 0.01 }, shockExemptRates: { money: 10_000 } }] },
  ];

  test("shock scales output DOWN, so recovery dominates when it is high", () => {
    expect(shockMultiplier(90)).toBeCloseTo(0.1, 10);
    const decision = stepSleeves({ sleeves: [sleeve(0, 90)], tasks, shockCeiling: 50, syncFloor: 50 }, postNeeds([]));
    expect(decision.assignments[0]!.task.type).toBe("recovery");
  });

  test("sleeves serve the board in PARALLEL with the player", () => {
    const board = postNeeds([
      { by: "gang", kind: "karma", target: -54_000, have: 0, weight: 10, urgency: "blocking" },
    ]);
    const decision = stepSleeves({ sleeves: [sleeve(0), sleeve(1)], tasks, shockCeiling: 50, syncFloor: 50 }, board);
    // Both sleeves take the karma crime — they do not interfere, so the
    // per-sleeve argmax is exact.
    expect(decision.assignments).toHaveLength(2);
    for (const entry of decision.assignments) expect(entry.task.detail).toBe("Homicide");
  });

  test("with nothing posted it falls back to income", () => {
    const decision = stepSleeves({ sleeves: [sleeve(0)], tasks, shockCeiling: 50, syncFloor: 50 }, postNeeds([]));
    expect(decision.assignments[0]!.task.detail).toBe("Heist");
  });

  test("does not cancel a running crime until its completion promise fires", () => {
    const running = { ...sleeve(0), task: { type: "CRIME", detail: "Heist" } };
    const board = postNeeds([{ by: "gang", kind: "karma", target: -100, have: 0, weight: 10, urgency: "blocking" }]);
    expect(stepSleeves({ sleeves: [running], tasks, shockCeiling: 50, syncFloor: 50 }, board).assignments).toEqual([]);
    expect(stepSleeves({ sleeves: [{ ...running, allowCrimeSwitch: true }], tasks, shockCeiling: 50, syncFloor: 50 }, board).assignments[0]!.task.detail).toBe("Homicide");
  });

  test("crime karma bypasses shock but experience remains shock-scaled", () => {
    const special = [{
      type: "crime" as const,
      detail: "Test",
      outcomes: [{ rates: { combatSkills: 100 }, shockExemptRates: { karma: 1 } }],
    }];
    const shocked = sleeve(0, 100);
    const karma = stepSleeves(
      { sleeves: [shocked], tasks: special, shockCeiling: 101, syncFloor: 50 },
      postNeeds([{ by: "gang", kind: "karma", target: -1, have: 0, weight: 1, urgency: "blocking" }]),
    );
    expect(karma.assignment.total).toBeGreaterThan(0);
    const combat = stepSleeves(
      { sleeves: [shocked], tasks: special, shockCeiling: 101, syncFloor: 50 },
      postNeeds([{ by: "bladeburner", kind: "combatSkills", target: 100, have: 0, weight: 1, urgency: "blocking" }]),
    );
    expect(combat.assignment.total).toBe(0);
  });

  test("subject-aware sleeve experience serves a requested hacking skill", () => {
    const skillTasks = [{
      type: "crime" as const,
      detail: "Cybercrime",
      outcomes: [{
        rates: {},
        contributions: [{ kind: "skill" as const, subject: "hacking", perSec: 3 }],
      }],
    }];
    const decision = stepSleeves(
      { sleeves: [sleeve(0)], tasks: skillTasks, shockCeiling: 50, syncFloor: 50 },
      postNeeds([{ by: "factions", kind: "skill", subject: "hacking", target: 100, have: 1, weight: 1, urgency: "blocking" }]),
    );
    expect(decision.assignment.total).toBeGreaterThan(0);
    expect(decision.assignments[0]!.task.detail).toBe("Cybercrime");
  });

  test("only one sleeve is assigned to a faction while the others keep producing", () => {
    const capacityTasks = [
      {
        type: "faction" as const,
        detail: "CyberSec",
        workType: "hacking",
        exclusiveKey: "faction:CyberSec",
        outcomes: [{
          rates: {},
          contributions: [{ kind: "factionRep" as const, subject: "CyberSec", perSec: 1 }],
        }],
      },
      { type: "crime" as const, detail: "Heist", outcomes: [{ rates: {}, shockExemptRates: { money: 100 } }] },
    ];
    const decision = stepSleeves(
      { sleeves: [sleeve(0), sleeve(1)], tasks: capacityTasks, shockCeiling: 50, syncFloor: 50 },
      postNeeds([{ by: "factions", kind: "factionRep", subject: "CyberSec", target: 100, have: 0, weight: 1, urgency: "blocking" }]),
    );
    expect(decision.assignment.choices.filter((choice) => choice.task.type === "faction")).toHaveLength(1);
    expect(decision.assignment.choices.filter((choice) => choice.task.type === "crime")).toHaveLength(1);
    expect(decision.assignment.approximated).toBe(false);
  });
});

// --- stanek: exhaustive packing is PROVABLY optimal ---------------------------

describe("stanek packing", () => {
  const square = [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 0, y: 1 }, { x: 1, y: 1 }];
  const line = [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 2, y: 0 }];
  const el = [{ x: 0, y: 0 }, { x: 0, y: 1 }, { x: 1, y: 1 }];

  test("distinct rotations are deduplicated — a square has one, an L has four", () => {
    expect(distinctRotations(square)).toHaveLength(1);
    expect(distinctRotations(line)).toHaveLength(2);
    expect(distinctRotations(el)).toHaveLength(4);
  });

  test("the packing is PROVABLY optimal, not merely good", () => {
    // The grid is small enough to enumerate every placement, so this is the
    // strongest evidence available anywhere in the roster: no better packing
    // exists, rather than "ours beats first-fit".
    const fragments = [
      { id: 1, shape: square, power: 1, weight: 4 },
      { id: 2, shape: line, power: 1, weight: 3 },
    ];
    const result = packFragments(fragments, 3, 3);
    expect(result.approximated).toBe(false);
    // 4 + 3 = 7 cells in a 9-cell grid; both fit.
    expect(result.value).toBe(7);
    expect(result.placements).toHaveLength(2);
  });

  test("it will LEAVE OUT a large fragment to fit two smaller ones", () => {
    // The branch that skips a fragment is what makes the search correct — a
    // greedy largest-first packer gets this wrong.
    const fragments = [
      { id: 1, shape: [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 2, y: 0 }, { x: 3, y: 0 }], power: 1, weight: 4 },
      { id: 2, shape: [{ x: 0, y: 0 }], power: 1, weight: 3 },
      { id: 3, shape: [{ x: 0, y: 0 }], power: 1, weight: 3 },
    ];
    // A 1x2 grid fits only the two singles.
    const result = packFragments(fragments, 1, 2);
    expect(result.value).toBe(6);
    expect(result.placements.map((p) => p.id).sort()).toEqual([2, 3]);
  });

  test("beats first-fit packing", () => {
    const fragments = [
      { id: 1, shape: el, power: 1, weight: 1 },
      { id: 2, shape: square, power: 1, weight: 10 },
    ];
    // First-fit would place the L first and block the high-value square.
    const result = packFragments(fragments, 2, 2);
    expect(result.placements.map((p) => p.id)).toEqual([2]);
    expect(result.value).toBe(10);
  });

});

// --- go -----------------------------------------------------------------------

describe("go", () => {
  const board = (rows: string[]) => ({ rows, size: rows[0]!.length });
  const engine = new GoNeuralEngine((weights) => new StubGoValueBackend(weights));

  test("an aligned plan predicts the immediate reply from the exact dispatch seed", async () => {
    const view = {
      board: board([".....", ".....", ".....", ".....", "....."]),
      currentPlayer: "Black",
      opponent: "Daedalus",
      status: "inProgress",
      previousBoards: [],
      komi: 5.5,
    } as const;
    const decision = await decideGoNeural(view, [10_200], engine);
    const best = decision.ranked[0]!;
    expect(best.predictedReplies?.length).toBeGreaterThan(0);
    expect(best.forecastCertainty).toBe("exact");
    expect(best.score).toBeGreaterThan(0);
    expect(best.score).toBeLessThanOrEqual(1);
  });

  test("a full board passes rather than crashing", async () => {
    const decision = await decideGoNeural({
      board: board(["XX", "XX"]),
      currentPlayer: "Black",
      opponent: "Netburners",
      status: "inProgress",
      previousBoards: [],
    }, [10_200], engine);
    expect(decision.action.type).toBe("pass");
    expect(decision.forecast?.length).toBeGreaterThan(0);
  });

  test("a white turn resumes the public opponent promise after interruption", async () => {
    const decision = await decideGoNeural({
      board: board([".....", ".....", ".....", ".....", "....."]),
      currentPlayer: "White",
      opponent: "Netburners",
      status: "waitingOnAI",
      previousBoards: [],
    }, [0], engine);
    expect(decision.action.type).toBe("resume");
  });

  test("a completed game starts the most valuable 5x5 subnet", async () => {
    const decision = await decideGoNeural({
      board: board([".....", ".....", ".....", ".....", "....."]),
      currentPlayer: "None",
      status: "gameOver",
      opponent: "Netburners",
      previousBoards: [],
      nextGame: { opponent: "Daedalus", boardSize: 5 },
    }, [0], engine);
    expect(decision.action).toMatchObject({ type: "newGame", opponent: "Daedalus", boardSize: 5 });
  });

  test("an untouched default board is retargeted, but an invested game is finished", async () => {
    const view = {
      board: board(Array.from({ length: 7 }, () => ".......")),
      currentPlayer: "Black" as const,
      status: "inProgress" as const,
      opponent: "Netburners" as const,
      nextGame: { opponent: "Illuminati" as const, boardSize: 5 as const },
    };
    const retargeted = await decideGoNeural({ ...view, previousBoards: [] }, [10_200], engine);
    expect(retargeted.action).toMatchObject({
      type: "newGame",
      opponent: "Illuminati",
      boardSize: 5,
    });
    const invested = await decideGoNeural({ ...view, previousBoards: [view.board.rows] }, [10_200], engine);
    expect(invested.action.type).toBe("move");
  });

  test("a fresh daemon 19x19 board is not retargeted over its requested size", async () => {
    // The secret opponent ignores the requested board size and always produces
    // 19x19; a pristine daemon game must count as matching its own nextGame
    // preference rather than re-rolling forever.
    const decision = await decideGoNeural({
      board: board(Array.from({ length: 19 }, () => ".".repeat(19))),
      currentPlayer: "White",
      status: "waitingOnAI",
      opponent: "????????????",
      previousBoards: [],
      nextGame: { opponent: "????????????", boardSize: 13 },
    }, [0], engine);
    expect(decision.action.type).toBe("resume");
  });

  test("opponent choice follows feature needs and rewards a pending favor win", () => {
    const ranked = rankGoGames({
      opponents: ["Daedalus", "The Black Hand"],
      stats: [{ opponent: "Daedalus", wins: 1, losses: 0, winStreak: 1, rep: 0, bonusPercent: 0 }],
      joinedFactions: new Set(["Daedalus"]),
      factionFavor: { Daedalus: { favor: 10, remainingWorkSec: 3_600 } },
      demands: {
        Daedalus: { seconds: 3_600, share: 1 },
        "The Black Hand": { seconds: 600, share: 1 },
      },
      goPower: 1,
      hasSourceFile14: false,
      favorRepCap: 100_000,
      installRemainingSec: 3_600,
    });
    expect(ranked[0]?.opponent).toBe("Daedalus");
  });

});

// --- side: every v3.0.1 contract type has a solver -----------------------------

describe("coding contracts — known answers and exact release coverage", () => {
  test("solvers match known answers for all 30 types", () => {
    const cases: [string, unknown, unknown][] = [
      ["Subarray with Maximum Sum", [-2, 1, -3, 4, -1, 2, 1, -5, 4], 6],
      ["Array Jumping Game", [2, 3, 1, 1, 4], 1],
      ["Array Jumping Game", [3, 2, 1, 0, 4], 0],
      ["Array Jumping Game II", [2, 3, 1, 1, 4], 2],
      ["Array Jumping Game II", [3, 2, 1, 0, 4], 0],
      ["Merge Overlapping Intervals", [[1, 3], [8, 10], [2, 6], [15, 18]], [[1, 6], [8, 10], [15, 18]]],
      ["Generate IP Addresses", "25525511135", ["255.255.11.135", "255.255.111.35"]],
      ["Unique Paths in a Grid I", [3, 7], 28],
      ["Unique Paths in a Grid II", [[0, 0, 0], [0, 1, 0], [0, 0, 0]], 2],
      ["Shortest Path in a Grid", [[0, 1, 0, 0, 0], [0, 0, 0, 1, 0]], "DRRURRD"],
      ["Sanitize Parentheses in Expression", "()())()", ["(())()", "()()()"]],
      ["Find All Valid Math Expressions", ["123", 6], ["1+2+3", "1*2*3"]],
      ["Total Ways to Sum", 5, 6],
      ["Total Ways to Sum II", [10, [1, 2, 5]], 10],
      ["Algorithmic Stock Trader I", [7, 1, 5, 3, 6, 4], 5],
      ["Algorithmic Stock Trader II", [7, 1, 5, 3, 6, 4], 7],
      ["Algorithmic Stock Trader III", [3, 3, 5, 0, 0, 3, 1, 4], 6],
      ["Algorithmic Stock Trader IV", [2, [3, 2, 6, 5, 0, 3]], 7],
      ["Minimum Path Sum in a Triangle", [[2], [3, 4], [6, 5, 7], [4, 1, 8, 3]], 11],
      ["Find Largest Prime Factor", 13195, 29],
      ["Spiralize Matrix", [[1, 2, 3], [4, 5, 6], [7, 8, 9]], [1, 2, 3, 6, 9, 8, 7, 4, 5]],
      ["HammingCodes: Integer to Encoded Binary", 8, "11110000"],
      ["HammingCodes: Encoded Binary to Integer", "1001101010", 21],
      ["Proper 2-Coloring of a Graph", [4, [[0, 2], [0, 3], [1, 2], [1, 3]]], [0, 0, 1, 1]],
      ["Compression I: RLE Compression", "aaaaabccc", "5a1b3c"],
      ["Compression II: LZ Decompression", "5aaabb450723abb", "aaabbaaababababaabb"],
      ["Compression III: LZ Compression", "abracadabra", "7abracad47"],
      ["Encryption I: Caesar Cipher", ["MEDIUM", 1], "LDCHTL"],
      ["Encryption II: Vigenère Cipher", ["DASHBOARD", "LINUX"], "OIFBYZIEX"],
      ["Square Root", 15n, 4n],
      ["Total Number of Primes", [0, 20], 8],
      ["Largest Rectangle in a Matrix", [[1, 0, 0], [0, 0, 0]], [[0, 1], [1, 2]]],
    ];
    for (const [type, data, expected] of cases) {
      expect(solve(type, data), `${type} produced the wrong answer`).toEqual(expected);
    }
  });

  test("stock trader IV with k >= n/2 degenerates to the unlimited case", () => {
    expect(solve("Algorithmic Stock Trader IV", [100, [7, 1, 5, 3, 6, 4]])).toBe(7);
  });

  test("an unknown type returns undefined — never a guess", () => {
    // Some types have only one attempt, so refusing an unknown remains part
    // of the public solver contract even though v3.0.1 is fully covered.
    expect(solve("Not A Real Contract Type", [])).toBeUndefined();
    expect(canSolve("Not A Real Contract Type")).toBe(false);
    expect(solve("toString", [])).toBeUndefined();
    expect(canSolve("toString")).toBe(false);
  });

  test("a solver that throws on malformed data returns undefined, not a partial answer", () => {
    expect(solve("Merge Overlapping Intervals", null)).toBeUndefined();
  });

});


// --- dnet ----------------------------------------------------------------------

describe("darknet", () => {
  const servers = [
    { hostname: "root", depth: 0, isOnline: true, requiredCharisma: 0, stasisLinked: false, neighbours: ["mid"] },
    { hostname: "mid", depth: 1, isOnline: false, requiredCharisma: 0, stasisLinked: false, neighbours: ["leaf"] },
    { hostname: "leaf", depth: 2, isOnline: true, requiredCharisma: 0, stasisLinked: false, neighbours: [] },
  ];

  test("an offline server is only traversable while held in stasis", () => {
    expect(reachableFrom(servers, new Set())).toEqual(new Set(["root"]));
    expect(reachableFrom(servers, new Set(["mid"]))).toEqual(new Set(["root", "mid", "leaf"]));
  });

  test("stasis is RANKED by what dies with the host, and nothing is selected", () => {
    // The ranking survived the deletion of the actions and is still exact: a
    // stasis link is the only thing that makes a host immune to move, delete and
    // restart, so a link on `mid` really does keep `mid` and `leaf` alive. What
    // it does NOT buy is remote `exec` — that is a backdoor — and the traversal
    // actions that read like it did are gone.
    expect(unlockValue({ servers, stasisLinked: [] } as never, "mid")).toBe(2);
    const decision = stepDarknet({
      topologyComplete: true,
      servers,
      stasisLinked: [],
      charisma: 100,
    });
    expect(decision.ranked[0]!.hostname).toBe("mid");
    expect(decision.ranked[0]!.unlocks).toBe(2);
    // No action, because home can perform none of them: `setStasisLink` pins the
    // CALLING host, so spending a link means a 12 GB script standing on the
    // target, and `authenticate` needs a direct connection home only has to
    // `darkweb`.
    expect(decision).not.toHaveProperty("action");
  });

  test("charisma blocks become a NEED for career, not a grind here", () => {
    const decision = stepDarknet({
      topologyComplete: true,
      servers: [{ ...servers[0]!, requiredCharisma: 500 }],
      stasisLinked: [],
      charisma: 10,
    });
    expect(decision.charismaNeeded).toBe(500);
  });

  test("the backdoor route is built from the FOLD, because ns.scan cannot see the darknet", () => {
    // Home installs darknet backdoors itself — `singularity.installBackdoor`
    // acts on the terminal's current server, and only home has a terminal — but
    // the BFS the hacking backdoor uses cannot find the way: `ns.scan` omits
    // darknet servers outright, so from home it sees `darkweb` and stops. The
    // graph has to come from the controller's folded adjacency.
    const now = 10_000_000;
    // Seeded through `discoverReports`, because only the probe/details/dns path
    // may CREATE host entries — an ordinary fold updates what is already known.
    const knowledge = emptyKnowledge("15:0");
    discoverReports(
      knowledge.hosts,
      [
        { hostname: "darkweb", at: now, present: true, neighbours: ["dn-0"], depth: -1 },
        { hostname: "dn-0", at: now, present: true, identity: "dn-0:ip", neighbours: ["darkweb", "dn-1"], depth: 0 },
        { hostname: "dn-1", at: now, present: true, identity: "dn-1:ip", neighbours: ["dn-0"], depth: 1 },
      ],
      now,
    );
    expect(darknetRoute(knowledge, "dn-1", now, {})).toEqual(["darkweb", "dn-0", "dn-1"]);
    // Every route starts at darkweb, which is the one darknet host home is
    // adjacent to — it holds the TOR edge.
    expect(darknetRoute(knowledge, "darkweb", now, {})).toEqual(["darkweb"]);
  });

  test("...and it refuses outright when a mutation has dirtied a hop's adjacency", () => {
    // The failure this prevents is not a wasted call: a connect chain that
    // breaks halfway leaves the TERMINAL stranded deep in a net that is
    // rearranging around it.
    //
    // The trigger is a board mutation, not elapsed time: adjacency is unchanged
    // until a move changes the board.
    const now = 10_000_000;
    const edges = [
      { hostname: "darkweb", at: now, present: true, neighbours: ["dn-0"], depth: -1 },
      { hostname: "dn-0", at: now, present: true, identity: "dn-0:ip", neighbours: ["darkweb", "dn-1"], depth: 0 },
      { hostname: "dn-1", at: now, present: true, identity: "dn-1:ip", neighbours: ["dn-0"], depth: 1 },
    ];
    const knowledge = emptyKnowledge("15:0");
    discoverReports(knowledge.hosts, edges, now);
    // Age alone changes nothing: the last known route is still the best answer.
    const later = now + msPerHostEvent("disconnected") * 100;
    expect(darknetRoute(knowledge, "dn-1", later, {})).toEqual(["darkweb", "dn-0", "dn-1"]);

    // A mutation dirties the middle hop's edges, and the route refuses until a
    // probe replaces them.
    const dirtied = foldKnowledgeReports(
      knowledge,
      [{ hostname: "dn-0", at: later, present: true, invalidates: ["topology"] }],
      later,
    ).knowledge;
    expect(darknetRoute(dirtied, "dn-1", later, {})).toBeUndefined();
  });

  test("a partial map withholds the ranking but never the charisma need", () => {
    // `probe()` is host-local, so home's own view is one hop wide and the
    // topology is incomplete on nearly every run. The reachability number is
    // refused there, because a partial graph presented as an exact answer is
    // worse than no answer — but a charisma requirement is a per-host identity
    // fact, just as true on a partial map, and gating it behind the same check
    // kept the need off the board for exactly the runs that were short of it.
    const decision = stepDarknet({
      topologyComplete: false,
      servers: [{ ...servers[0]!, requiredCharisma: 500 }],
      stasisLinked: [],
      charisma: 10,
    });
    expect(decision.ranked).toEqual([]);
    expect(decision.charismaNeeded).toBe(500);
  });
});

// --- progression ----------------------------------------------------------------

describe("progression", () => {
  const view = (over: Partial<Parameters<typeof stepProgression>[0]> = {}) => ({
    queued: [],
    affordableValueProduct: 1,
    factionWorkInProgress: false,
    factionsReadyToInstall: true,
    factionsNeedLiquidation: false,
    stockReadyToInstall: true,
    graftInProgress: false,
    money: 0,
    earnedThisRun: 0,
    factions: {},
    favorToDonate: 150,
    homeRam: 8,
    homeRamUpgradeCost: Infinity,
    runSec: 0,
    routeRequiresInstall: false,
    ...over,
  });

  describe("the labyrinth-cache deferral can never stall an install", () => {
    // The rule: a labyrinth cache is opened only after the last augmentation
    // purchase of a cycle, because `getLabReward` queues an augmentation
    // directly and the generic price multiplier is `1.9 ^ (queued non-SoA)`
    // charged against everything bought after it.
    //
    // The rule has a hard limit, and it is the reason these tests exist rather
    // than only the happy path: MISSING the deferral costs one augmentation's
    // price scaling, once. BLOCKING an install costs the whole cycle. So the
    // deferral is allowed to be wrong in one direction only.
    const wanting = (over = {}) =>
      view({ queued: ["a"], routeRequiresInstall: true, ...over });

    test("no reachable lab cache means no blocker at all", () => {
      // The ordinary case, and it is every run before the maze has been walked.
      // The driver publishes `labCacheOpenable` only when the file is known to
      // exist AND the lab is online AND a live resident is standing on it, so
      // absent is what "we do not have one" looks like from here.
      const decision = stepProgression(wanting());
      expect(decision.installBlockers).not.toContain("dnet-lab-cache");
      expect(decision.installReady).toBe(true);
      // Explicitly false is the same answer, not a different one.
      expect(stepProgression(wanting({ labCacheOpenable: false })).installReady).toBe(true);
    });

    test("an openable one holds the install, but only after the last purchase", () => {
      // The ordering is free rather than arranged: the `augmentations` blocker
      // already holds the install open while anything remains to buy, so gating
      // on `purchasableAugmentation === undefined` puts this last in the
      // sequence without either blocker knowing about the other.
      const shopping = stepProgression(wanting({
        labCacheOpenable: true,
        purchasableAugmentation: "NeuroFlux Governor",
      }));
      expect(shopping.installBlockers).toContain("augmentations");
      expect(shopping.installBlockers).not.toContain("dnet-lab-cache");

      const done = stepProgression(wanting({ labCacheOpenable: true }));
      expect(done.installBlockers).toEqual(["dnet-lab-cache"]);
      expect(done.installReady).toBe(false);
    });

    test("the deferral EXPIRES rather than latching", () => {
      // The backstop for the case the openable check cannot see: the job was
      // filed, the host died under it, and nothing will ever come back. Without
      // this the install cycle waits for ever on a cache nobody is going to open.
      const start = 1_000_000;
      let held = labCacheDeferral({}, true, start);
      expect(held).toEqual({ since: start, defer: true });

      // The window runs from when it was FIRST raised, not from the last pass —
      // a deferral that restamped itself every tick would never expire.
      held = labCacheDeferral(held, true, start + LAB_CACHE_DEFER_MS - 1);
      expect(held.defer).toBe(true);
      expect(held.since).toBe(start);

      held = labCacheDeferral(held, true, start + LAB_CACHE_DEFER_MS);
      expect(held.defer).toBe(false);
      // ...and once it has given up it stays given up while the cache sits there.
      expect(labCacheDeferral(held, true, start + LAB_CACHE_DEFER_MS + 1).defer).toBe(false);
    });

    test("a cache that stops being openable releases the install immediately", () => {
      // Not merely on the deadline: a lab that went offline, or a resident that
      // died, is not something to keep waiting for.
      const start = 1_000_000;
      const held = labCacheDeferral({}, true, start);
      const released = labCacheDeferral(held, false, start + 1);
      expect(released.defer).toBe(false);
      expect(released.since).toBeUndefined();
      // And re-raising later starts a FRESH window rather than resuming a spent
      // one — otherwise a flapping resident could inherit an expired clock and
      // be refused a deferral it is entitled to.
      expect(labCacheDeferral(released, true, start + 2)).toEqual({ since: start + 2, defer: true });
    });
  });

  test("the run-phase machine promotes on value, then on cash", () => {
    expect(phaseOf(view())).toBe("start");
    expect(phaseOf(view({ affordableValueProduct: 2.0 }))).toBe("finishUp");
    // 1.5 promotes only with no faction work in progress.
    expect(phaseOf(view({ affordableValueProduct: 1.5, factionWorkInProgress: true }))).toBe("start");
    expect(phaseOf(view({ affordableValueProduct: 1.5, factionWorkInProgress: false }))).toBe("finishUp");
    expect(phaseOf(view({ earnedThisRun: 100, money: 60, queued: ["a"] }))).toBe("ending");
  });

  test("favor crossings are the exact install-timing crossover", () => {
    // Favor is banked ONLY at install, and crossing the donation threshold
    // converts every future rep requirement from hours of work into money.
    const crossings = favorCrossings(view({ factions: { CyberSec: { rep: 1e9, favor: 0 } }, favorToDonate: 150 }));
    expect(crossings).toHaveLength(1);
    expect(crossings[0]!.favorAfter).toBeGreaterThanOrEqual(150);
    // A faction nowhere near the threshold does not cross.
    expect(favorCrossings(view({ factions: { CyberSec: { rep: 10, favor: 0 } } }))).toHaveLength(0);
  });

  test("a favor crossing opens the end-loaded sweep before factions reports ready", () => {
    // factionsReadyToInstall can only become true after installWanted asks the
    // faction driver to run its final purchase sweep. Requiring readiness here
    // would deadlock an empty-queue cycle at the exact crossing.
    const decision = stepProgression(view({
      factions: { CyberSec: { rep: 1e9, favor: 0 } },
      resetRealizable: true,
      marginalInstall: false,
      factionsReadyToInstall: false,
    }));
    expect(decision.installWanted).toBe(true);
    expect(decision.installReady).toBe(false);
    expect(decision.installBlockers).toEqual(["factions", "augmentations"]);
  });

  test("installing is recommended only in `ending` with something queued", () => {
    expect(stepProgression(view({ earnedThisRun: 100, money: 60 })).installReady).toBe(false);
    expect(stepProgression(view({ earnedThisRun: 100, money: 60, queued: ["a"] })).installReady).toBe(true);
  });

  test("the cadence verdict is a renewal rule: no route ETA falls back to legacy", () => {
    expect(installVerdict({}).verdict).toBe("no-data");
    expect(installVerdict({ resetValueMult: 100, pushMarginalRate: 1e-9 }).verdict).toBe("no-data");
  });

  test("a missing push rate installs only when the frontier itself is idle", () => {
    // No rate + no frontier conclusion is a booting cycle, not an exhausted
    // one — concluding "install" there latches before any work begins.
    expect(installVerdict({ routeEtaKnown: true }).verdict).toBe("no-data");
    expect(installVerdict({ routeEtaKnown: true, frontierIdle: true }).verdict).toBe("install");
    expect(installVerdict({ routeEtaKnown: true, resetValueMult: 0.5, pushMarginalRate: 0, frontierIdle: true }).verdict).toBe("install");
    // Undefined means the frontier has not spoken; explicit zero means it has
    // measured no further reset-activated acceleration.
    expect(installVerdict({ routeEtaKnown: true, resetValueMult: 0.5, pushMarginalRate: 0 }).verdict).toBe("install");
  });

  test("accrued value must clear sqrt(2·O·p) with the margin", () => {
    const p = 1e-4;
    const threshold = Math.sqrt(2 * INSTALL_VERDICT_OVERHEAD_SEC * p) * PUSH_MARGIN;
    const below = installVerdict({ routeEtaKnown: true, resetValueMult: threshold * 0.9, pushMarginalRate: p });
    expect(below.verdict).toBe("push");
    const above = installVerdict({ routeEtaKnown: true, resetValueMult: threshold * 1.1, pushMarginalRate: p });
    expect(above.verdict).toBe("install");
    expect(above.threshold).toBeCloseTo(threshold, 10);
  });

  test("a long node does NOT suppress the cadence — it wants frequent installs", () => {
    // Renewal is independent of remaining node time. The separate
    // INSTALL_MIN_PAYBACK_SEC gate protects the neighbourhood of node end.
    const verdict = installVerdict({ routeEtaKnown: true, resetValueMult: 0.5, pushMarginalRate: 1e-4 });
    expect(verdict.verdict).toBe("install");
  });

  test("flat score bonuses do not leak into the accrued side", () => {
    // The Red Pill carries AUG_BONUS flats in scoreAug (route necessity) but
    // has NO multipliers — its mult-only score must be exactly zero, so a
    // queued Red Pill alone never manufactures cadence pressure.
    const redPill = {
      name: "The Red Pill",
      baseCost: 0,
      baseRepRequirement: 2_500_000,
      factions: ["Daedalus"],
      prereqs: [],
      mults: {},
    };
    expect(scoreAugMults(redPill, weightsFromMarginals(WORTH))).toBe(0);
  });

  test("augmentation weights come out in BN-seconds, from the route's own marginals", () => {
    // The hand-tuned table this replaces said `faction_rep: 2` in every node
    // forever. A weight is now what progression MEASURED a relative rate
    // increase in that channel to save, so a reputation multiplier is worth
    // reputation's seconds and nothing else has to be believed.
    const weights = weightsFromMarginals(WORTH);
    expect(weights.faction_rep).toBe(49_505);
    expect(weights.hacking).toBe(19_174);
    // hacking_speed shortens the whole batch, so it lifts money AND experience
    // — but the money half earns the FARM's dollars, not everyone's, so it is
    // priced at the hacking income share like any other single-source income
    // multiplier. Unmeasured means unpriceable, so with no shares only the
    // experience half survives.
    expect(weights.hacking_speed).toBe(19_174);
    const measured = weightsFromMarginals(WORTH, { incomeShares: { hacking: 0.8, hacknet: 0.2 } });
    expect(measured.hacking_speed).toBeCloseTo(19_174 + 1_000 * 0.8, 9);
    // The correction that matters: before it, a cycle-speed multiplier claimed
    // every dollar the run earned, including the Hacknet ones it cannot touch.
    expect(measured.hacking_speed!).toBeLessThan(19_174 + 1_000);
  });

  test("a channel the route does not depend on prices its augmentations at nothing", () => {
    // Measured zero, not absent: mid-BN12 the farm clears the Daedalus money
    // gate long before anything else binds, so a money multiplier genuinely
    // saves no seconds. No constant could say that, and no constant should.
    const noMoney = weightsFromMarginals(new Map([["money", 0], ["reputation", 49_505]]));
    expect(noMoney.hacking_money).toBeUndefined();
    expect(noMoney.faction_rep).toBe(49_505);
  });

  test("a single-source income multiplier is worth that source's share of income", () => {
    // Doubling crime money beside a live farm is a rounding error, and the
    // valuation now says so instead of carrying a flat 0.2.
    const weights = weightsFromMarginals(new Map([["money", 10_000]]), {
      incomeShares: { career: 0.0001, hacking: 0.9999 },
    });
    expect(weights.crime_money).toBeCloseTo(10_000 * 0.0001, 9);
    expect(weights.hacking_money).toBeCloseTo(10_000 * 0.9999, 9);
    // With nothing measured, an unmeasured source is worth nothing rather than
    // a guess.
    expect(weightsFromMarginals(new Map([["money", 10_000]])).crime_money).toBeUndefined();
  });

  test("direct skill multiplier value follows the nonlinear route target and SF12 base", () => {
    // skill = m·(32·ln(exp + 534.6) − 200), so near a high gate a direct
    // multiplier buys far more than an ordinary output multiplier — and the
    // effect decays by itself as the installed base grows. A derivation, kept.
    const baseline = weightsFromMarginals(WORTH);
    const weak = weightsFromMarginals(WORTH, { hackingTarget: 3_000, multipliers: { hacking: 1.5 } });
    const strong = weightsFromMarginals(WORTH, { hackingTarget: 3_000, multipliers: { hacking: 15 } });
    expect(weak.hacking).toBeGreaterThan(strong.hacking!);
    expect(strong.hacking).toBeGreaterThan(baseline.hacking!);
    // These values are seconds, so a more valuable package may increase the
    // total instead of being normalized back to the baseline.
    const total = (weights: Record<string, number>) => Object.values(weights).reduce((sum, w) => sum + w, 0);
    expect(total(weak)).toBeGreaterThan(total(baseline));
  });

  test("a realizable sweep set opens the install gate despite the empty queue", () => {
    // Purchases are end-loaded: mid-cycle the queue is empty BY DESIGN, and
    // the sweep that fills it is triggered by installWanted itself. The
    // realizable signal breaks that cycle; the purchasable-augmentation
    // blocker still holds the reset until the sweep converts it.
    const closed = stepProgression(view({ marginalInstall: true }));
    expect(closed.installWanted).toBe(false);
    const open = stepProgression(view({ marginalInstall: true, resetRealizable: true }));
    expect(open.installWanted).toBe(true);
    // ...and the dwelled push verdict keeps the gate shut either way.
    const pushing = stepProgression(view({ marginalInstall: false, resetRealizable: true, earnedThisRun: 100, money: 60, queued: ["a"] }));
    expect(pushing.installWanted).toBe(false);
  });

  test("a selected route's required install bypasses optional cadence and payback", () => {
    const optional = stepProgression(view({
      queued: ["The Red Pill"],
      nodeRemainingSec: 599,
    }));
    expect(optional.installWanted).toBe(false);

    const required = stepProgression(view({
      queued: ["The Red Pill"],
      nodeRemainingSec: 599,
      routeRequiresInstall: true,
      stockReadyToInstall: false,
    }));
    expect(required.installWanted).toBe(true);
    expect(required.installReady).toBe(false);
    expect(required.installBlockers).toEqual(["stock"]);
  });

  test("a banked route package opens its mandatory end-loaded sweep before purchase", () => {
    const required = stepProgression(view({
      queued: [],
      resetRealizable: true,
      routeRequiresInstall: true,
      nodeRemainingSec: 1,
      factionsReadyToInstall: false,
    }));

    expect(required.installWanted).toBe(true);
    expect(required.installReady).toBe(false);
    expect(required.installBlockers).toEqual([
      "factions",
      "augmentations",
    ]);
  });

  test("banked favor values a shared future augmentation only once", () => {
    const oneSeller = bankedFavorActivationValue({
      standings: [{ name: "CyberSec", rep: 100_000, favor: 0 }],
      offers: [{ name: "Shared", faction: "CyberSec", owned: false }],
      favorToDonate: 150,
    });
    const duplicatedOffer = bankedFavorActivationValue({
      standings: [
        { name: "CyberSec", rep: 100_000, favor: 0 },
        { name: "NiteSec", rep: 100_000, favor: 0 },
      ],
      offers: [
        { name: "Shared", faction: "CyberSec", owned: false },
        { name: "Shared", faction: "NiteSec", owned: false },
      ],
      favorToDonate: 150,
    });
    expect(duplicatedOffer).toBeCloseTo(oneSeller, 12);

    const distinctOffer = bankedFavorActivationValue({
      standings: [
        { name: "CyberSec", rep: 100_000, favor: 0 },
        { name: "NiteSec", rep: 100_000, favor: 0 },
      ],
      offers: [
        { name: "A", faction: "CyberSec", owned: false },
        { name: "B", faction: "NiteSec", owned: false },
      ],
      favorToDonate: 150,
    });
    expect(distinctOffer).toBeCloseTo(oneSeller * 2, 12);

    // A faction's improved favor rate accelerates EVERY residual augmentation
    // it still offers, which is how packageValues prices the push side
    // (`future * rateGain`). Crediting the accrued side once per faction
    // instead put the two sides of the install verdict on different scales.
    const nestedAtOneFaction = bankedFavorActivationValue({
      standings: [{ name: "CyberSec", rep: 100_000, favor: 0 }],
      offers: [
        { name: "Low breakpoint", faction: "CyberSec", owned: false },
        { name: "High breakpoint", faction: "CyberSec", owned: false },
      ],
      favorToDonate: 150,
    });
    expect(nestedAtOneFaction).toBeCloseTo(oneSeller * 2, 12);

    const reroutedSharedOffer = bankedFavorActivationValue({
      standings: [
        { name: "CyberSec", rep: 100_000, favor: 0 },
        { name: "NiteSec", rep: 100_000, favor: 0 },
      ],
      offers: [
        { name: "Shared", faction: "CyberSec", owned: false },
        { name: "CyberSec only", faction: "CyberSec", owned: false },
        { name: "Shared", faction: "NiteSec", owned: false },
      ],
      favorToDonate: 150,
    });
    expect(reroutedSharedOffer).toBeCloseTo(oneSeller * 2, 12);
  });

  test("install evidence must dwell, while contrary push evidence cancels immediately", () => {
    const first = dwellInstallVerdict("install", {}, 1_000, 90_000);
    expect(first.install).toBe(false);
    const held = dwellInstallVerdict("install", first.state, 91_000, 90_000);
    expect(held.install).toBe(true);
    const cancelled = dwellInstallVerdict("push", held.state, 91_001, 90_000);
    expect(cancelled.install).toBe(false);
    const restarted = dwellInstallVerdict("install", cancelled.state, 91_002, 90_000);
    expect(restarted.install).toBe(false);
  });

  test("a completed package's one-second ETA cannot explode cadence throughput", () => {
    const rate = installCadencePushRate({
      runSec: 3_600,
      resetValueMult: 1,
      intentActivationValue: 0.2,
      intentEtaSec: 1,
      intentMarginalActivationRate: 0.2,
    });
    expect(rate).toBeCloseTo(1 / 3_600, 12);
    expect(rate).toBeLessThan(0.001);
  });

  test("cadence ETA follows a bootstrap overhead that keeps growing", () => {
    const remaining = installCadenceRemainingSec({
      runSec: 1_000,
      resetValueMult: 0.5,
      pushMarginalRate: 0.001,
      bootstrapExponent: 2,
    });
    const fixedThreshold = Math.sqrt(2 * 500 * 0.001) * PUSH_MARGIN;
    const fixedThresholdSec = (fixedThreshold - 0.5) / 0.001;

    expect(remaining).toBeDefined();
    expect(remaining!).toBeGreaterThan(fixedThresholdSec);
    const futureRunSec = 1_000 + remaining!;
    const futureValue = 0.5 + 0.001 * remaining!;
    const futureThreshold = Math.sqrt(2 * (futureRunSec / 2) * 0.001) * PUSH_MARGIN;
    expect(futureValue).toBeCloseTo(futureThreshold, 9);
  });

  test("a zero speed slope keeps count-only route progress on the observed cadence", () => {
    const rate = installCadencePushRate({
      runSec: 5_400,
      resetValueMult: 0.7,
      intentActivationValue: 0.3,
      intentEtaSec: 1_500,
      intentMarginalActivationRate: 0,
    });
    expect(rate).toBeCloseTo(0.7 / 5_400, 12);
    expect(installVerdict({
      routeEtaKnown: true,
      resetValueMult: 0.7,
      resetOverheadSec: 5_400,
      pushMarginalRate: rate,
    }).verdict).toBe("push");
  });

  test("route progress that resets do not preserve vetoes only optional installs", () => {
    const held = stepProgression(view({
      queued: ["a"],
      marginalInstall: true,
      resetRealizable: true,
      optionalInstallAllowed: false,
    }));
    expect(held.installWanted).toBe(false);

    const mandatory = stepProgression(view({
      queued: ["The Red Pill"],
      routeRequiresInstall: true,
      optionalInstallAllowed: false,
    }));
    expect(mandatory.installWanted).toBe(true);
  });

  test("the early tranche stops a one-augmentation reset, not the first install", () => {
    // The early tranche rejects a one-augmentation reset. Consolidation guards
    // the expensive half of the gate separately.
    expect(earlyCountBatchAllowed(30, 0, 1)).toBe(false);
    expect(earlyCountBatchAllowed(30, 0, 2)).toBe(true);
    expect(earlyCountBatchAllowed(30, 6, 1)).toBe(false);
    expect(earlyCountBatchAllowed(30, 6, 2)).toBe(true);
    // Still a fraction of the live requirement rather than a flat two, so a
    // larger gate asks for a proportionally larger opening batch. It does not
    // encode BN1's 30-slot gate or a particular observed package.
    expect(earlyCountBatchAllowed(20, 0, 1)).toBe(false);
    expect(earlyCountBatchAllowed(20, 0, 2)).toBe(true);
    expect(earlyCountBatchAllowed(35, 0, 2)).toBe(false);
    expect(earlyCountBatchAllowed(35, 0, 3)).toBe(true);
    expect(routeCountInstallValue({
      required: 30,
      installed: 13,
      affordableDistinct: 8,
      batchAllowed: false,
    })).toBe(0);
    // In BN-seconds, from the route's measured acquisition rate: nine of the
    // seventeen remaining slots, each worth `worth / remaining`.
    const worth = new Map([["augmentations", 17_000]]);
    expect(routeCountInstallValue({
      required: 30,
      installed: 13,
      affordableDistinct: 9,
      batchAllowed: true,
      worth,
    })).toBeCloseTo(9 * (17_000 / 17), 9);
    // The last slot unblocks the whole gate, so it is worth the whole leg —
    // and an unmeasured route prices none of it rather than guessing.
    expect(routeCountInstallValue({
      required: 30,
      installed: 29,
      affordableDistinct: 20,
      batchAllowed: true,
      worth,
    })).toBeCloseTo(17_000, 9);
    expect(routeCountInstallValue({
      required: 30,
      installed: 13,
      affordableDistinct: 9,
      batchAllowed: true,
    })).toBe(0);
  });

  test("empty-queue liquidation is requested without making an install possible", () => {
    const decision = stepProgression(view({ factionsNeedLiquidation: true }));
    expect(decision.liquidationWanted).toBe(true);
    expect(decision.installWanted).toBe(false);
    expect(decision.installReady).toBe(false);
  });

  test("install waits for the factions final sweep", () => {
    const decision = stepProgression(
      view({ earnedThisRun: 100, money: 60, queued: ["a"], factionsReadyToInstall: false }),
    );
    expect(decision.installWanted).toBe(true);
    expect(decision.installReady).toBe(false);
    expect(decision.installBlockers).toEqual(["factions"]);
  });

  test("install waits for stock liquidation and an ongoing graft", () => {
    const decision = stepProgression(view({
      earnedThisRun: 100,
      money: 60,
      queued: ["a"],
      stockReadyToInstall: false,
      graftInProgress: true,
    }));
    expect(decision.installWanted).toBe(true);
    expect(decision.installReady).toBe(false);
    expect(decision.installBlockers).toEqual(["stock", "graft"]);
  });

  test("install waits while an augmentation is still purchasable", () => {
    // Cash does not survive an install, so resetting while something is still
    // affordable destroys money that could have become a permanent multiplier.
    // The reset always loses that race.
    const decision = stepProgression(view({
      earnedThisRun: 100,
      money: 60,
      queued: ["a"],
      purchasableAugmentation: "Cranial Signal Processors - Gen II",
    }));
    expect(decision.installWanted).toBe(true);
    expect(decision.installReady).toBe(false);
    expect(decision.installBlockers).toEqual(["augmentations"]);
  });

  test("the phase ANNOUNCES the burn; the barriers are what gate the reset", () => {
    // `ending` is the signal to stock and factions that it is time to convert
    // everything. It is not itself permission to reset — that needs every barrier
    // clear. And once they ARE clear there is nothing left to wait for, so the
    // decision is ready immediately rather than after some settling delay.
    const ending = view({ earnedThisRun: 100, money: 60, queued: ["a"] });
    expect(stepProgression(ending).phase).toBe("ending");

    const burning = stepProgression({ ...ending, stockReadyToInstall: false, purchasableAugmentation: "Rootkit" });
    expect(burning.phase).toBe("ending");
    expect(burning.installWanted).toBe(true);
    expect(burning.installReady).toBe(false);
    expect(burning.installBlockers).toEqual(["stock", "augmentations"]);

    // Everything burned: flat book, nothing left to buy. No further waiting.
    const done = stepProgression({
      ...ending,
      stockReadyToInstall: true,
      factionsReadyToInstall: true,
      graftInProgress: false,
    });
    expect(done.installBlockers).toEqual([]);
    expect(done.installReady).toBe(true);
  });

  test("BitNode ordering is exact for a small set", () => {
    const nodes: [number, number][] = [[4, 3], [1, 3], [5, 1], [2, 3]];
    const hours = { 1: 10, 2: 20, 4: 5, 5: 30 };
    const wants = { 2: [4], 5: [1], 1: [] as number[], 4: [] as number[] };
    const best = bestOrdering(nodes, hours, 0.5, wants);
    expect(best.exact).toBe(true);
    // The optimum is never worse than the baseline's ordering of the same set.
    const baselineSubset = BASELINE_ORDER.filter(([node]) => nodes.some(([n]) => n === node));
    expect(best.hours).toBeLessThanOrEqual(orderingCost(baselineSubset, hours, 0.5, wants) + 1e-9);
    expect(best.hours).toBe(40);
    expect(best.order.findIndex(([node]) => node === 4)).toBeLessThan(best.order.findIndex(([node]) => node === 2));
    expect(best.order.findIndex(([node]) => node === 1)).toBeLessThan(best.order.findIndex(([node]) => node === 5));
  });

  test("above the exact limit it falls back and says so", () => {
    const nodes: [number, number][] = Array.from({ length: 12 }, (_, i) => [i + 1, 3]);
    expect(bestOrdering(nodes, {}, 0.5, {}).exact).toBe(false);
  });

  test("next-BitNode selection credits completion and skips disabled nodes", () => {
    // A fresh BN4 start stays in BN4 until 4.3 is earned — the route begins
    // there because Singularity is node-native, nothing injected.
    expect(chooseNextBitNode(4, {})).toMatchObject({ bitNode: 4, targetLevel: 3 });
    expect(chooseNextBitNode(1, {})).toMatchObject({ bitNode: 4, targetLevel: 3 });
    expect(chooseNextBitNode(4, { "1": 1, "4": 2 })).toMatchObject({ bitNode: 1, targetLevel: 3 });
    expect(chooseNextBitNode(5, {
      "1": 3,
      "4": 3,
      "5": 1,
      "14": 1,
      "15": 3,
    })).toMatchObject({ bitNode: 14, targetLevel: 3 });
    expect(chooseNextBitNode(1, {
      "1": 3,
      "4": 3,
      "5": 3,
      "12": 3,
      "14": 3,
      "15": 3,
    })).toMatchObject({ bitNode: 12, targetLevel: 4 });
  });
});

describe("progression survives its own published plan", () => {
  // Published plans can outlive the bundle that created them. An incompatible
  // shape must be discarded before any nested field is read.
  function ctxWith(plan: unknown) {
    const state = initState();
    state.topics.player = {
      money: 1e9,
      skills: { hacking: 500, strength: 1, defense: 1, dexterity: 1, agility: 1, charisma: 1, intelligence: 0 },
      mults: {}, jobs: {}, city: "Sector-12", location: "home", karma: 0, numPeopleKilled: 0, factions: [],
    } as never;
    state.topics.progression = {
      bitNode: 1,
      augCount: 0,
      sourceFiles: {},
      ownedAugs: {},
      ...(plan !== undefined ? { plan } : {}),
    } as never;
    return { state, caps: deriveCapabilities({ bitNode: 1 }), now: 1_000 } as NeedContext;
  }

  const refresh = FEATURE_MODULES.progression.refresh!;

  /** Exactly the plan shape the wedged run had on disk. */
  const stalePlan = {
    phase: "ending",
    install: false,
    favorCrossings: [],
    route: "daedalus",
    routeWhy: "daedalus remains the fastest route",
    decidedAt: 500,
    routes: [],
    expectedEndAt: 9e12,
  };

  test("a plan from an OLDER BUNDLE does not throw, and is replaced", () => {
    const ctx = ctxWith(stalePlan);
    expect(() => refresh(ctx)).not.toThrow();
    const plan = ctx.state.topics.progression!.plan!;
    // Recovery is the point: the new fields are present afterwards, so the next pass
    // has a plan it can read and the feature is not wedged.
    expect(plan.forecasts).toBeDefined();
    expect(plan.forecasts.node).toBeDefined();
    expect(plan.forecasts.install).toBeDefined();
    expect(plan.queuedAugmentations).toBeDefined();
    expect(plan.installBlockers).toBeDefined();
  });

  test("a plan missing ONLY the newest field is still rejected", () => {
    // Partial compatibility is the trap: `forecasts` present but
    // `queuedAugmentations` absent would sail past a forecasts-only guard and then
    // throw in the install path instead.
    const ctx = ctxWith({
      ...stalePlan,
      forecasts: {
        node: { state: "unknown", basis: "x", reason: "y", nextRecalibrationAt: 0, estimatedAt: 0 },
        install: { state: "unknown", basis: "x", reason: "y", nextRecalibrationAt: 0, estimatedAt: 0 },
      },
    });
    expect(() => refresh(ctx)).not.toThrow();
    expect(ctx.state.topics.progression!.plan!.queuedAugmentations).toBeDefined();
  });

  test("a plan THIS bundle wrote is round-tripped, not discarded", () => {
    // The guard must not throw away a live plan: `previousChoice` depends on reading
    // it back to keep the route decision stable across a rebuild.
    const ctx = ctxWith(undefined);
    refresh(ctx);
    const first = ctx.state.topics.progression!.plan!;
    refresh(ctx);
    const second = ctx.state.topics.progression!.plan!;
    expect(second.route).toBe(first.route);
    expect(second.decidedAt).toBe(first.decidedAt);
  });

  test("the completion hold suppresses even a stale executable terminal claim", () => {
    const ctx = ctxWith(undefined);
    refresh(ctx);
    ctx.state.topics.progression!.plan!.completion = {
      ready: true,
      automatic: true,
      nextBitNode: 4,
      targetLevel: 3,
      armedAt: 500,
      execute: true,
    };
    const claims = FEATURE_MODULES.progression.claims!({
      ...ctx,
      horizons: ctx.state.topics.progression!.plan!.forecasts,
      board: postNeeds([]),
    } as ClaimContext);
    expect(claims.some((claim) => claim.id === "action:complete-bitnode")).toBe(false);
  });
});
