import { describe, expect, test } from "bun:test";
import { DEFAULT_NETWORK } from "../network.ts";
import { SimWorld } from "../world.ts";

function makeWorld(seed = 1): SimWorld {
  return new SimWorld({ seed, network: DEFAULT_NETWORK, homeRam: 8, startingMoney: 1_000, verbose: true });
}

describe("SimWorld", () => {
  test("hgw reserves RAM, applies at completion, frees RAM", () => {
    const world = makeWorld();
    expect(world.execute({ type: "nuke", target: "n00dles" })).toBe(true);
    const okay = world.execute({ type: "hack", target: "n00dles", source: "home", threads: 1 });
    expect(okay).toBe(true);
    expect(world.servers.get("home")!.ramUsed).toBeCloseTo(1.7, 10);
    expect(world.inFlight()).toBe(1);
    world.clock.run();
    expect(world.servers.get("home")!.ramUsed).toBe(0);
    expect(world.inFlight()).toBe(0);
    expect(world.records.some((r) => r.kind === "event" && r.name === "hack.done")).toBe(true);
  });

  test("rejects over-RAM and unrooted targets with action.failed", () => {
    const world = makeWorld();
    expect(world.execute({ type: "hack", target: "n00dles", source: "home", threads: 1 })).toBe(false);
    expect(world.execute({ type: "grow", target: "n00dles", source: "home", threads: 1000 })).toBe(false);
    const failures = world.records.filter((r) => r.kind === "event" && r.name === "action.failed");
    expect(failures.length).toBe(2);
  });

  test("buyServer and upgradeHomeRam move money and mirror state", () => {
    const world = makeWorld();
    world.money = 1e9;
    expect(world.execute({ type: "buyServer", ram: 64, name: "pserv-0" })).toBe(true);
    expect(world.servers.get("pserv-0")!.maxRam).toBe(64);
    const homeBefore = world.servers.get("home")!.maxRam;
    expect(world.execute({ type: "upgradeHomeRam" })).toBe(true);
    expect(world.servers.get("home")!.maxRam).toBe(homeBefore * 2);
  });

  test("same seed produces identical record streams", () => {
    const run = (seed: number) => {
      const world = new SimWorld({ seed, network: DEFAULT_NETWORK, homeRam: 32, runId: "det" });
      world.execute({ type: "nuke", target: "n00dles" });
      const loop = () => {
        if (world.clock.now() > 300_000) return;
        world.execute({ type: "hack", target: "n00dles", source: "home", threads: 4 });
      };
      world.onSettled = loop;
      loop();
      world.clock.run(() => false, 600_000);
      return JSON.stringify(world.records);
    };
    expect(run(7)).toBe(run(7));
    expect(run(7)).not.toBe(run(8));
  });

  test("skill gates hack actions", () => {
    const world = makeWorld();
    world.execute({ type: "nuke", target: "joesguns" }); // requires skill 10, player has 1
    expect(world.execute({ type: "hack", target: "joesguns", source: "home", threads: 1 })).toBe(false);
  });
});

describe("HWGW seam support", () => {
  test("additionalMsec delays landing; completions carry opId + result", () => {
    const world = new SimWorld({ seed: 3, network: DEFAULT_NETWORK, homeRam: 32 });
    world.execute({ type: "nuke", target: "n00dles" });
    const events: { kind: string; opId?: number; t: number }[] = [];
    world.onSettled = (e) => events.push({ kind: e.kind, opId: e.opId, t: world.clock.now() });

    const okPlain = world.execute({ type: "weaken", target: "n00dles", source: "home", threads: 1, opId: 1 });
    const okPadded = world.execute({ type: "weaken", target: "n00dles", source: "home", threads: 1, opId: 2, additionalMsec: 5_000 });
    expect(okPlain).toBe(true);
    expect(okPadded).toBe(true);
    world.clock.run();

    expect(events.map((e) => e.opId)).toEqual([1, 2]);
    expect(events[1]!.t - events[0]!.t).toBe(5_000);
  });

  test("non-verbose runs emit farm rollups instead of per-op events", () => {
    const world = new SimWorld({ seed: 4, network: DEFAULT_NETWORK, homeRam: 32 });
    world.execute({ type: "nuke", target: "n00dles" });
    world.execute({ type: "hack", target: "n00dles", source: "home", threads: 4, opId: 7 });
    world.clock.run();
    expect(world.records.some((r) => r.kind === "event" && r.name === "hack.done")).toBe(false);
    const farm = world.records.filter((r) => r.kind === "state" && r.key === "farm");
    expect(farm.length).toBeGreaterThanOrEqual(2); // initial + post-completion
  });
});
