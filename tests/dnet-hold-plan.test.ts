import { describe, expect, test } from "bun:test";
import { admitPins, planHold, planWalk, type HoldHost } from "../shared/strategy/dnet/hold.ts";
import { LAB_LADDER } from "../shared/strategy/dnet/rates.ts";

/** The maze-vantage and pin decisions, tested without a game — the whole point
 * of extracting them from the controller's closure. The refusal ladder is the
 * preparation checklist in order; each rung names the one thing to fix next. */

const LAB = LAB_LADDER[0]!;
const PIN_GB = 13.8;
const WALK_GB = 5.8;

const labHost = (over: Partial<HoldHost> = {}): HoldHost => ({
  hostname: LAB.hostname,
  modelId: "(The Labyrinth)",
  agentAlive: false,
  hasCredential: false,
  isStationary: true,
  ...over,
});

const vantage = (over: Partial<HoldHost> = {}): HoldHost => ({
  hostname: "dnet-6-x1",
  depth: 6,
  maxRam: 64,
  freeGb: 60,
  blockedRam: 0,
  agentAlive: true,
  hasCredential: true,
  neighbours: [LAB.hostname],
  stasisLinked: true,
  ...over,
});

const refusals = (): { list: { host: string; why: string }[]; refuse: (host: string, why: string, detail: string) => void } => {
  const list: { host: string; why: string }[] = [];
  return { list, refuse: (host, why) => list.push({ host, why }) };
};

describe("planWalk's preparation checklist", () => {
  test("a ready vantage admits the walk at full threads", () => {
    const { refuse } = refusals();
    const plan = planWalk({ hosts: [labHost(), vantage()], charisma: LAB.cha, walkGb: WALK_GB }, refuse);
    expect(plan.tasks).toEqual([{
      kind: "walk",
      host: LAB.hostname,
      from: "dnet-6-x1",
      threads: Math.floor(64 / WALK_GB),
      reason: "walk the maze from dnet-6-x1",
    }]);
    expect(plan.candidate).toBe("dnet-6-x1");
  });

  test("each missing precondition refuses by its own name, in order", () => {
    const cases: [Partial<HoldHost>, string][] = [
      [{ stasisLinked: false }, "walker-unpinned"],
      [{ blockedRam: undefined }, "ram-unknown"],
      [{ blockedRam: 4 }, "ram-blocked"],
      [{ agentAlive: false }, "walker-unstaffed"],
      [{ maxRam: 4 }, "no-room"],
    ];
    for (const [over, why] of cases) {
      const { list, refuse } = refusals();
      const plan = planWalk({ hosts: [labHost(), vantage(over)], charisma: LAB.cha, walkGb: WALK_GB }, refuse);
      expect(plan.tasks, why).toEqual([]);
      expect(list.map((r) => r.why), why).toEqual([why]);
    }
  });

  test("below the maze's charisma gate the walk refuses and reports the gate", () => {
    const { list, refuse } = refusals();
    const plan = planWalk({ hosts: [labHost(), vantage()], charisma: LAB.cha - 1, walkGb: WALK_GB }, refuse);
    expect(plan.charismaNeeded).toBe(LAB.cha);
    expect(list[0]!.why).toBe("charisma");
  });

  test("a walk already in flight admits nothing and names its vantage", () => {
    const { refuse } = refusals();
    const plan = planWalk({
      hosts: [labHost(), vantage()],
      charisma: LAB.cha,
      walkGb: WALK_GB,
      walkerAt: "dnet-6-x1",
    }, refuse);
    expect(plan.tasks).toEqual([]);
    expect(plan.candidate).toBe("dnet-6-x1");
  });

  test("a walked lab refuses lab-walked and admits nothing", () => {
    const { list, refuse } = refusals();
    const plan = planWalk({
      hosts: [labHost({ hasCredential: true }), vantage()],
      charisma: LAB.cha,
      walkGb: WALK_GB,
    }, refuse);
    expect(plan.tasks).toEqual([]);
    expect(list[0]!.why).toBe("lab-walked");
  });
});

describe("the mortal scout", () => {
  const scoutHost = (over: Partial<HoldHost> = {}): HoldHost => vantage({
    hostname: "dnet-6-x2",
    maxRam: 32,
    freeGb: 28,
    stasisLinked: false,
    ...over,
  });

  test("a finisher in flight plus a second staffed vantage admits one scout", () => {
    const { refuse } = refusals();
    const plan = planWalk({
      hosts: [labHost(), vantage(), scoutHost()],
      charisma: LAB.cha,
      walkGb: WALK_GB,
      walkerAt: "dnet-6-x1",
      scoutWalker: true,
    }, refuse);
    expect(plan.tasks).toEqual([{
      kind: "walk",
      host: LAB.hostname,
      from: "dnet-6-x2",
      threads: Math.floor(28 / WALK_GB),
      route: "southern",
      scout: true,
      reason: "mortal scout from dnet-6-x2",
    }]);
  });

  test("no extra scout past the cap, and none without the flag", () => {
    const { refuse } = refusals();
    const withScout = planWalk({
      hosts: [labHost(), vantage(), scoutHost()],
      charisma: LAB.cha,
      walkGb: WALK_GB,
      walkerAt: "dnet-6-x1",
      scoutsAt: new Set(["dnet-6-x2"]),
      scoutWalker: true,
    }, refuse);
    expect(withScout.tasks).toEqual([]);
    const withoutFlag = planWalk({
      hosts: [labHost(), vantage(), scoutHost()],
      charisma: LAB.cha,
      walkGb: WALK_GB,
      walkerAt: "dnet-6-x1",
    }, refuse);
    expect(withoutFlag.tasks).toEqual([]);
  });

  test("maxScouts 2 fields a second scout on the EASTERN route", () => {
    const { refuse } = refusals();
    const third = scoutHost({ hostname: "dnet-6-x3", maxRam: 24, freeGb: 20 });
    const plan = planWalk({
      hosts: [labHost(), vantage(), scoutHost(), third],
      charisma: LAB.cha,
      walkGb: WALK_GB,
      walkerAt: "dnet-6-x1",
      scoutsAt: new Set(["dnet-6-x2"]),
      scoutWalker: true,
      maxScouts: 2,
    }, refuse);
    expect(plan.tasks).toEqual([{
      kind: "walk",
      host: LAB.hostname,
      from: "dnet-6-x3",
      threads: Math.floor(20 / WALK_GB),
      route: "eastern",
      scout: true,
      reason: "mortal scout from dnet-6-x3",
    }]);
  });

  test("the scout's absence refuses nothing — it is opportunistic", () => {
    const { list, refuse } = refusals();
    const plan = planWalk({
      hosts: [labHost(), vantage()],
      charisma: LAB.cha,
      walkGb: WALK_GB,
      walkerAt: "dnet-6-x1",
      scoutWalker: true,
    }, refuse);
    expect(plan.tasks).toEqual([]);
    expect(list).toEqual([]);
  });

  test("planHold never stamps the scout irreplaceable", () => {
    const hosts = [labHost(), vantage(), scoutHost()];
    const plan = planHold({
      hosts,
      netDepth: LAB.depth,
      stasisLimit: 1,
      stasisLinkedCount: 1,
      labExpected: true,
      charisma: LAB.cha,
      walkerAt: "dnet-6-x1",
      scoutWalker: true,
      walkGb: WALK_GB,
      pinGb: PIN_GB,
    });
    expect(plan.tasks.some((t) => t.kind === "walk" && t.scout === true)).toBe(true);
    expect(hosts.find((h) => h.hostname === "dnet-6-x2")!.irreplaceable).toBeUndefined();
  });
});

describe("admitPins", () => {
  test("a staffed host without room for the 12 GB link refuses no-room", () => {
    const { list, refuse } = refusals();
    const tasks = admitPins([vantage({ stasisLinked: false, freeGb: 5 })], ["dnet-6-x1"], PIN_GB, refuse);
    expect(tasks).toEqual([]);
    expect(list[0]!.why).toBe("no-room");
  });

  test("a credentialed host with room is admitted, carrying its lab edge", () => {
    const { refuse } = refusals();
    const tasks = admitPins([vantage({ stasisLinked: false })], ["dnet-6-x1"], PIN_GB, refuse, LAB.hostname);
    expect(tasks).toEqual([{
      kind: "pin",
      host: "dnet-6-x1",
      from: "dnet-6-x1",
      reason: "pin the host nothing can replace",
      edge: LAB.hostname,
    }]);
  });

  test("a release with no neighbour to re-plant the host refuses no-replanter", () => {
    const { list, refuse } = refusals();
    const tasks = admitPins([vantage()], ["dnet-6-x1"], PIN_GB, refuse, undefined, false);
    expect(tasks).toEqual([]);
    expect(list[0]!.why).toBe("no-replanter");
  });
});

describe("planHold end to end", () => {
  test("a ready world admits the walk and stamps its vantage irreplaceable", () => {
    const hosts = [labHost(), vantage()];
    const plan = planHold({
      hosts,
      netDepth: LAB.depth,
      stasisLimit: 1,
      stasisLinkedCount: 1,
      labExpected: true,
      charisma: LAB.cha,
      walkGb: WALK_GB,
      pinGb: PIN_GB,
    });
    expect(plan.tasks.some((t) => t.kind === "walk")).toBe(true);
    expect(plan.labCandidate).toBe("dnet-6-x1");
    expect(plan.labWalked).toBe(false);
    expect(hosts[1]!.irreplaceable).toBe(true);
  });

  test("a walked lab reports labWalked and files no walk", () => {
    const plan = planHold({
      hosts: [labHost({ hasCredential: true }), vantage()],
      netDepth: LAB.depth,
      stasisLimit: 1,
      stasisLinkedCount: 1,
      labExpected: true,
      charisma: LAB.cha,
      walkGb: WALK_GB,
      pinGb: PIN_GB,
    });
    expect(plan.labWalked).toBe(true);
    expect(plan.tasks.some((t) => t.kind === "walk")).toBe(false);
  });
});
