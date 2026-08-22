import { describe, expect, test } from "bun:test";
import type { Direction } from "../../shared/strategy/dnet/maze.ts";
import type { LabStage } from "../../shared/strategy/dnet/rates.ts";
import { expForSkill } from "../../shared/formulas.ts";
import { LAB_LADDER } from "../../shared/strategy/dnet/rates.ts";
import {
  biasedDfsRoute,
  compareLabRuns,
  generateLabCase,
  generateLabCorpus,
  labAuthenticationMs,
  plannerRoute,
  runLabCase,
  runLabParty,
  shortestLabPath,
  summarizeLabRuns,
  type LabCase,
  type LabDecision,
  type LabObservation,
  type LabRoute,
} from "../dnet-lab.ts";

const TINY_STAGE: LabStage = {
  hostname: "test_lab",
  depth: 1,
  cha: 300,
  mazeWidth: 3,
  mazeHeight: 3,
  offsetStartAndEnd: false,
  manual: false,
};

const scriptedRoute = (name: string, directions: readonly Direction[]): LabRoute => ({
  name,
  start: () => {
    let index = 0;
    return {
      next: () => index < directions.length
        ? { kind: "move", direction: directions[index++]! }
        : { kind: "stop", reason: "script ended" },
    };
  },
});

const actionRoute = (
  name: string,
  actions: readonly Exclude<LabDecision, { kind: "stop" }>[],
  seen: LabObservation[] = [],
): LabRoute => ({
  name,
  start: () => {
    let index = 0;
    return {
      next: (last) => {
        if (last) seen.push(last);
        return actions[index++] ?? { kind: "stop", reason: "script ended" };
      },
    };
  },
});

describe("focused labyrinth arena", () => {
  test("counts every in-game authentication delay, including a wall and the winning move", () => {
    const lab: LabCase = {
      id: "tiny",
      stage: TINY_STAGE,
      maze: ["#####", "#   #", "#####"],
      start: [1, 1],
      exit: [3, 1],
    };
    const fast = runLabCase(lab, scriptedRoute("fast", ["east"]), 2_500);
    const slow = runLabCase(lab, scriptedRoute("slow", ["west", "east"]), 2_500);

    expect(fast).toMatchObject({ solved: true, attempts: 1, moves: 1, blocked: 0, elapsedMs: 2_500 });
    expect(slow).toMatchObject({ solved: true, attempts: 2, moves: 1, blocked: 1, elapsedMs: 5_000 });
    expect(compareLabRuns([fast], [slow])).toMatchObject({
      candidateFaster: 0,
      candidateSlower: 1,
      attemptDelta: 1,
      elapsedDeltaMs: 2_500,
      elapsedRatio: 2,
      meanElapsedDeltaMs: 2_500,
      ci95LowMs: 2_500,
      ci95HighMs: 2_500,
    });
    expect(() => compareLabRuns([fast], [{ ...slow, solved: false, reason: "stuck" }]))
      .toThrow("cannot compare an unsolved lab run");
  });

  test("radar and report each cost one authentication but award no movement XP", () => {
    const lab: LabCase = {
      id: "vision",
      stage: TINY_STAGE,
      maze: ["#####", "#   #", "#####"],
      start: [1, 1],
      exit: [3, 1],
    };
    const seen: LabObservation[] = [];
    const run = runLabCase(lab, actionRoute("look-then-go", [
      { kind: "radar" },
      { kind: "report" },
      { kind: "move", direction: "east" },
    ], seen), 2_500);

    expect(run).toMatchObject({ solved: true, attempts: 3, moves: 1, radars: 1, reports: 1, elapsedMs: 7_500 });
    expect(seen[0]).toMatchObject({ kind: "radar" });
    expect(seen[0]!.kind === "radar" && seen[0].surroundings).toContain("X");
    expect(seen[1]).toEqual({
      kind: "report",
      at: [1, 1],
      open: { north: false, east: true, south: false, west: false },
    });
  });

  test("failed moves award charisma XP before timing the following action", () => {
    const lab: LabCase = {
      id: "xp",
      stage: TINY_STAGE,
      maze: ["#####", "#   #", "#####"],
      start: [1, 1],
      exit: [3, 1],
    };
    const run = runLabCase(lab, scriptedRoute("level-up", ["west", "east"]), {
      charismaExp: expForSkill(301) - 1,
    });
    const expected = labAuthenticationMs(TINY_STAGE, { charisma: 300 })
      + labAuthenticationMs(TINY_STAGE, { charisma: 301 });
    expect(run.elapsedMs).toBeCloseTo(expected);
  });

  test("generates the real stitched dimensions and deterministic offset positions", () => {
    const stage: LabStage = {
      ...TINY_STAGE,
      hostname: "offset_lab",
      mazeWidth: 60,
      mazeHeight: 40,
      offsetStartAndEnd: true,
    };
    const a = generateLabCase(stage, 17);
    const b = generateLabCase(stage, 17);
    expect(a).toEqual(b);
    expect({ width: a.maze[0]!.length, height: a.maze.length }).toEqual({ width: 61, height: 41 });
    expect([1, 3, 5]).toContain(a.start[0]);
    expect([1, 3, 5]).toContain(a.start[1]);
    expect([55, 57, 59]).toContain(a.exit[0]);
    expect([35, 37, 39]).toContain(a.exit[1]);
  });

  test("uses the labyrinth server's actual authentication formula", () => {
    // difficulty=10 contributes 1100; lab depth=-1 suppresses the generic
    // under-level penalty. At the charisma gate there are no other factors.
    expect(labAuthenticationMs(TINY_STAGE)).toBeCloseTo(850 * (5 * 300 + 1_100) / 450);
    expect(labAuthenticationMs(TINY_STAGE, { charisma: 600, threads: 6, hasBoots: true, sf15Level: 3 }))
      .toBeCloseTo(850 * (5 * 300 + 1_100) / 750 * 0.5 * 0.8 * 0.8);
    expect(() => labAuthenticationMs(TINY_STAGE, { charisma: 299 })).toThrow("requires charisma 300");
  });

  test("runs the deployed route against every rung without constructing a darknet world", () => {
    const cases = generateLabCorpus(Array.from({ length: 12 }, (_, index) => index + 1));
    const route = biasedDfsRoute("north");
    const runs = cases.map((lab) => runLabCase(lab, route));
    const summary = summarizeLabRuns(runs);

    expect(summary.cases).toBe(96);
    expect(summary.solved).toBe(summary.cases);
    for (let i = 0; i < runs.length; i++) {
      expect(runs[i]!.attempts).toBeGreaterThanOrEqual(runs[i]!.shortestMoves);
      expect(runs[i]!.elapsedMs)
        .toBeCloseTo(runs[i]!.attempts * labAuthenticationMs(cases[i]!.stage), 6);
    }
  });

  test("the planner beats the DFS on the whole ladder and never bumps a wall mid-walk", () => {
    const cases = generateLabCorpus(Array.from({ length: 8 }, (_, index) => index + 1));
    const dfs = cases.map((lab) => runLabCase(lab, biasedDfsRoute("north")));
    const planned = cases.map((lab) => runLabCase(lab, plannerRoute()));

    const summary = summarizeLabRuns(planned);
    expect(summary.solved).toBe(summary.cases);
    for (const run of planned) {
      // The prior pre-walls the border and every response's free render covers
      // all four adjacent slots before the next choice, so the only possible
      // refusal is the deliberate blind first probe.
      expect(run.blocked).toBeLessThanOrEqual(1);
      expect(run.attempts).toBeGreaterThanOrEqual(run.shortestMoves);
    }

    // The margin the tuning sweep left on the table is ~0.65; asserting 0.85
    // keeps the test stable against small tuning drift while still refusing a
    // planner that regressed to DFS territory.
    const compared = compareLabRuns(dfs, planned);
    expect(compared.elapsedRatio).toBeLessThan(0.85);
  });

  test("a decisive radar names the exit instead of criss-crossing nine candidates", () => {
    // Deep rungs only: the shallow ones have a known exit and must never radar.
    const deep = generateLabCorpus([3, 4, 5], LAB_LADDER.filter((stage) => stage.offsetStartAndEnd));
    const shallow = generateLabCorpus([3, 4, 5], LAB_LADDER.filter((stage) => !stage.offsetStartAndEnd));
    const deepRuns = deep.map((lab) => runLabCase(lab, plannerRoute()));
    const shallowRuns = shallow.map((lab) => runLabCase(lab, plannerRoute()));
    // A shallow rung's exit is known before the first move, so any radar there
    // is a door scout — never the decisive exit radar the deep rungs pay for.
    expect(shallowRuns.every((run) => run.solved)).toBe(true);
    expect(deepRuns.every((run) => run.solved)).toBe(true);
    // Radar pays one authentication for the whole exit question (and the door
    // scout a few more); it must stay an accent, not a habit.
    for (const run of [...shallowRuns, ...deepRuns]) expect(run.radars).toBeLessThanOrEqual(8);
  });

  test("a party of one is step-for-step the solo planner, so both arenas share a ruler", () => {
    const cases = generateLabCorpus([2, 7, 11]);
    for (const lab of cases) {
      const solo = runLabCase(lab, plannerRoute());
      const one = runLabParty(lab, [{ name: "finisher" }]);
      expect(one.solved).toBe(true);
      expect(one.attempts).toBe(solo.attempts);
      expect(one.wallClockMs).toBeCloseTo(solo.elapsedMs, 6);
    }
  });

  test("a second walker on the other macro-route beats a lone one on the deep rungs", () => {
    // The engine facts that make this legal: the maze is global while positions
    // are per PID, delays run in parallel, XP pools, and EITHER pid reaching
    // the endpoint roots the lab. The scout commits to the southern door pair
    // so the two do not shadow each other.
    // Three seeds across the five deep rungs. The margin is ~10% and the
    // per-case variance is far smaller than that, so fifteen paired cases carry
    // the claim — and a party run of a 61x41 maze is expensive enough that the
    // corpus size is what decides whether this suite fits a default timeout.
    const deep = generateLabCorpus(
      [1, 2, 3],
      LAB_LADDER.filter((stage) => stage.offsetStartAndEnd),
    );
    let soloMs = 0;
    let pairMs = 0;
    for (const lab of deep) {
      const solo = runLabCase(lab, plannerRoute());
      const pair = runLabParty(lab, [{ name: "finisher" }, { name: "scout", route: "southern" }]);
      expect(pair.solved).toBe(true);
      soloMs += solo.elapsedMs;
      pairMs += pair.wallClockMs;
    }
    expect(pairMs).toBeLessThan(soloMs);
  });

  test("a mortal, unpinned scout still helps — but not by enough to spend a stasis link on", () => {
    // The stasis question, answered with the arena: a scout that dies every
    // five minutes (a mutation ate its unpinned host; it respawns as a new PID
    // at a fresh offset start, keeping only the shared field) still finishes
    // the maze and still beats going alone in aggregate — but the margin it
    // loses against an immortal scout is the most a second link could buy.
    const deep = generateLabCorpus([1, 2, 3], LAB_LADDER.filter((stage) => stage.offsetStartAndEnd));
    let soloMs = 0;
    let mortalMs = 0;
    for (const lab of deep) {
      soloMs += runLabCase(lab, plannerRoute()).elapsedMs;
      const run = runLabParty(lab, [
        { name: "finisher" },
        { name: "scout", route: "southern", lifetimeMs: 300_000 },
      ]);
      expect(run.solved).toBe(true);
      mortalMs += run.wallClockMs;
    }
    expect(mortalMs).toBeLessThan(soloMs);
  });

  test("the party arena is deterministic, deaths and respawn offsets included", () => {
    const lab = generateLabCase(LAB_LADDER[4]!, 23);
    const party = [
      { name: "finisher" },
      { name: "scout", route: "southern" as const, lifetimeMs: 180_000 },
    ];
    expect(runLabParty(lab, party)).toEqual(runLabParty(lab, party));
  });

  test("the omniscient path is a real lower bound, including on a stitched cycle", () => {
    const lab = generateLabCase({ ...TINY_STAGE, mazeWidth: 20, mazeHeight: 14 }, 91);
    const shortest = shortestLabPath(lab.maze, lab.start, lab.exit);
    const actual = runLabCase(lab, biasedDfsRoute("north"), 1_000);
    expect(actual.solved).toBe(true);
    expect(shortest).toBeGreaterThan(0);
    expect(actual.attempts).toBeGreaterThanOrEqual(shortest);
  });
});
