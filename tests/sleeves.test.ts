import { describe, expect, test } from "bun:test";
import type { DriverContext } from "../game/lib/features/index.ts";
import { sleeveView, sleevesModule } from "../game/lib/features/sleeves.ts";
import {
  armSleeveCompletion,
  disarmSleeveCompletion,
  pendingSleeveCompletions,
  resetSleeveCompletions,
  sleeveTaskDigest,
} from "../game/lib/sleeve-completion.ts";
import type { GameState } from "../game/lib/state.ts";
import { postNeeds } from "../shared/strategy/needs.ts";
import { stepSleeves, type SleeveTask } from "../shared/strategy/sleeves/decide.ts";
import type { SleeveDigest } from "../shared/telemetry/topics/sleeves.ts";

const tasks: SleeveTask[] = [
  { type: "recovery", outcomes: [{ rates: {} }] },
  { type: "synchro", outcomes: [{ rates: {} }] },
  { type: "crime", detail: "Mug", outcomes: [{ rates: { karma: 1 }, shockExemptRates: { money: 100 } }] },
  { type: "crime", detail: "Heist", outcomes: [{ rates: {}, shockExemptRates: { money: 10_000 } }] },
];

const sleeve = (index: number, shock = 0, sync = 100) => ({ index, shock, sync });

function freshState(): GameState {
  return {
    topics: {},
    dirty: new Set(),
    mirrors: {},
    mirrorDirty: new Set(),
    probeFailures: {},
    featureLastRun: {},
  };
}

function digest(index: number, hacking: number, task?: SleeveDigest["task"]): SleeveDigest {
  return {
    index,
    shock: 0,
    sync: 50,
    memory: 1,
    storedCycles: 0,
    city: "Sector-12",
    hp: { current: 10, max: 10 },
    skills: { hacking, strength: 1, defense: 1, dexterity: 1, agility: 1, charisma: 1, intelligence: 0 },
    mults: {},
    ...(task ? { task } : {}),
  };
}

describe("sleeve strategy source mechanics", () => {
  test("the 50/50 recovery policy is an explicit gate, not a beatable magic score", () => {
    const board = postNeeds([{ by: "gang", kind: "karma", target: -1, have: -0.999999999, weight: 1e9, urgency: "blocking" }]);
    const decision = stepSleeves({ sleeves: [sleeve(0, 51)], tasks, shockCeiling: 50, syncFloor: 50 }, board);
    expect(decision.assignments[0]?.task.type).toBe("recovery");
  });

  test("crime money remains valuable at full shock", () => {
    const decision = stepSleeves({ sleeves: [sleeve(0, 100)], tasks, shockCeiling: 101, syncFloor: 50 }, postNeeds([]));
    expect(decision.assignment.choices[0]?.task.detail).toBe("Heist");
    expect(decision.assignment.total).toBeGreaterThan(0);
  });

  test("duplicate needs retain their own remaining-distance weights", () => {
    const productive: SleeveTask[] = [{
      type: "crime",
      detail: "Test",
      outcomes: [{ rates: { karma: 10 } }],
    }];
    const board = postNeeds([
      { by: "gang", kind: "karma", target: -10, have: 0, weight: 1, urgency: "blocking" },
      { by: "factions", kind: "karma", target: -100, have: 0, weight: 2, urgency: "wanted" },
    ]);
    const decision = stepSleeves({ sleeves: [sleeve(0)], tasks: productive, shockCeiling: 50, syncFloor: 50 }, board);
    expect(decision.assignment.total).toBeCloseTo(10 * (1 / 10 + 2 / 100), 12);
  });

  test("a completion-locked crime does not reserve a faction target", () => {
    const capacityTasks: SleeveTask[] = [
      {
        type: "faction",
        detail: "CyberSec",
        workType: "hacking",
        exclusiveKey: "faction:CyberSec",
        outcomes: [
          { sleeve: 0, rates: {}, contributions: [{ kind: "factionRep", subject: "CyberSec", perSec: 10 }] },
          { sleeve: 1, rates: {}, contributions: [{ kind: "factionRep", subject: "CyberSec", perSec: 1 }] },
        ],
      },
      { type: "crime", detail: "Mug", outcomes: [{ rates: {}, shockExemptRates: { money: 1 } }] },
    ];
    const locked = { ...sleeve(0), task: { type: "CRIME", detail: "Mug" } };
    const board = postNeeds([{ by: "factions", kind: "factionRep", subject: "CyberSec", target: 10, have: 0, weight: 1, urgency: "blocking" }]);
    const decision = stepSleeves({ sleeves: [locked, sleeve(1)], tasks: capacityTasks, shockCeiling: 50, syncFloor: 50 }, board);
    expect(decision.assignment.choices.find((choice) => choice.agent.index === 1)?.task.type).toBe("faction");
    expect(decision.assignments).toEqual([{ index: 1, task: capacityTasks[0]! }]);
  });
});

describe("sleeve task observation", () => {
  test("detail-less tasks stay detail-less and Bladeburner actions retain their name", () => {
    expect(sleeveTaskDigest({ type: "RECOVERY" })).toEqual({ type: "RECOVERY" });
    expect(sleeveTaskDigest({ type: "SYNCHRO" })).toEqual({ type: "SYNCHRO" });
    expect(sleeveTaskDigest({ type: "BLADEBURNER", actionName: "Field Analysis" })).toEqual({
      type: "BLADEBURNER",
      detail: "Field Analysis",
    });
  });

  test("deliberate cancellation cannot become a completion notice", async () => {
    resetSleeveCompletions();
    let resolve!: () => void;
    const promise = new Promise<void>((done) => { resolve = done; });
    armSleeveCompletion(0, { type: "CRIME", nextCompletion: promise });
    disarmSleeveCompletion(0);
    resolve();
    await Promise.resolve();
    expect(pendingSleeveCompletions().has(0)).toBe(false);
  });
});

describe("sleeve view and execution", () => {
  test("faction work publishes sync-scaled player experience before shock", () => {
    resetSleeveCompletions();
    const state = freshState();
    state.topics.progression = { bitNode: 1, sourceFiles: {}, multipliers: { FactionWorkRepGain: 1, FactionWorkExpGain: 2 } } as never;
    state.topics.factions = {
      joined: ["CyberSec"],
      standings: [{ name: "CyberSec", favor: 0 }],
      workTypes: { CyberSec: ["hacking"] },
      plan: { until: { kind: "rep", faction: "CyberSec" } },
    } as never;
    state.topics.sleeves = { count: 1, sleeves: [{
      ...digest(0, 100),
      mults: { hacking_exp: 3 },
    }] };
    const task = sleeveView(state)!.tasks.find((candidate) => candidate.type === "faction")!;
    const hacking = task.outcomes[0]!.contributions?.find((entry) => entry.kind === "skill" && entry.subject === "hacking");
    // Base 2 exp/s * node 2 * sleeve mult 3 * sync 0.5. Shock is applied by stepSleeves.
    expect(hacking?.perSec).toBe(6);
  });

  test("a faction owner is released before a lower-index sleeve claims its target", async () => {
    resetSleeveCompletions();
    const state = freshState();
    state.topics.progression = { bitNode: 1, sourceFiles: {}, multipliers: {} } as never;
    state.topics.factions = {
      joined: ["CyberSec"],
      standings: [{ name: "CyberSec", favor: 0 }],
      workTypes: { CyberSec: ["hacking"] },
      plan: { until: { kind: "rep", faction: "CyberSec" } },
    } as never;
    state.topics.career = { crimes: [{
      name: "Mug", timeMs: 1_000, money: 100, karma: -0.25, kills: 0,
      difficulty: 1, weights: { hacking: 1 }, exp: {}, gainsAreEffective: false,
    }] } as never;
    state.topics.sleeves = { count: 2, sleeves: [
      digest(0, 10_000),
      digest(1, 1, { type: "FACTION", detail: "CyberSec", workType: "hacking" }),
    ] };
    const live = new Map<number, Record<string, unknown> | null>([
      [0, null],
      [1, { type: "FACTION", factionName: "CyberSec", factionWorkType: "hacking" }],
    ]);
    const calls: { path: string; index: number }[] = [];
    const nsp = async (path: string, ...args: unknown[]) => {
      const index = Number(args[0]);
      calls.push({ path, index });
      if (path === "sleeve.setToIdle") {
        live.set(index, null);
        return undefined;
      }
      if (path === "sleeve.setToFactionWork") {
        live.set(index, { type: "FACTION", factionName: args[1], factionWorkType: args[2] });
        return true;
      }
      if (path === "sleeve.setToCommitCrime") {
        live.set(index, { type: "CRIME", crimeType: args[1] });
        return true;
      }
      if (path === "sleeve.getTask") return live.get(index) ?? null;
      throw new Error(`unexpected ${path}`);
    };
    const board = postNeeds([{ by: "factions", kind: "factionRep", subject: "CyberSec", target: 100, have: 0, weight: 10, urgency: "blocking" }]);
    await sleevesModule.driver.tick({ state, board, nsp } as unknown as DriverContext);

    const writes = calls.filter((call) => call.path !== "sleeve.getTask");
    expect(writes[0]).toEqual({ path: "sleeve.setToIdle", index: 1 });
    expect(writes).toContainEqual({ path: "sleeve.setToFactionWork", index: 0 });
    expect(state.topics.sleeves?.plan?.lastResult).toMatchObject({ action: "batch", ok: true });
  });
});
