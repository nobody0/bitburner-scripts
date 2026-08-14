import { describe, expect, test } from "bun:test";
import { DEFAULT_NETWORK } from "../network.ts";
import { SimWorld } from "../world.ts";

function makeWorld(seed = 1): SimWorld {
  return new SimWorld({ seed, network: DEFAULT_NETWORK, homeRam: 8, startingMoney: 1_000, verbose: true });
}

describe("SimWorld", () => {
  test("stream-only worlds do not retain duplicate record history", () => {
    let streamed = 0;
    const world = new SimWorld({
      seed: 1,
      network: DEFAULT_NETWORK,
      retainRecords: false,
      onRecord: () => streamed++,
    });
    expect(streamed).toBeGreaterThan(0);
    expect(world.records).toEqual([]);
    world.emit({ kind: "event", name: "proof" });
    expect(streamed).toBeGreaterThan(1);
    expect(world.records).toEqual([]);
  });

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

  test("infrastructure purchases move money and mirror state", () => {
    const world = makeWorld();
    world.money = 1e12;
    expect(world.execute({ type: "buyServer", ram: 64, name: "pserv-0" })).toBe(true);
    expect(world.servers.get("pserv-0")!.maxRam).toBe(64);
    expect(world.execute({ type: "upgradeServer", host: "pserv-0", ram: 128 })).toBe(true);
    expect(world.servers.get("pserv-0")!.maxRam).toBe(128);
    const homeBefore = world.servers.get("home")!.maxRam;
    expect(world.execute({ type: "upgradeHomeRam" })).toBe(true);
    expect(world.servers.get("home")!.maxRam).toBe(homeBefore * 2);
    const coresBefore = world.servers.get("home")!.cpuCores;
    expect(world.execute({ type: "upgradeHomeCore" })).toBe(true);
    expect(world.servers.get("home")!.cpuCores).toBe(coresBefore + 1);
  });

  test("advanced home restrictions cap RAM and cores while successful BN5 upgrades grant intelligence", () => {
    const restricted = new SimWorld({
      seed: 1,
      bitnode: 5,
      homeRam: 128,
      startingMoney: 1e15,
      restrictHomePCUpgrade: true,
    });
    expect(restricted.view().prices.upgradeHomeRam).toBe(Infinity);
    expect(restricted.execute({ type: "upgradeHomeRam" })).toBe(false);
    expect(restricted.execute({ type: "upgradeHomeCore" })).toBe(false);
    expect(restricted.person.exp.intelligence).toBe(0);

    const ordinary = new SimWorld({ seed: 1, bitnode: 5, startingMoney: 1e15 });
    expect(ordinary.execute({ type: "upgradeHomeRam" })).toBe(true);
    expect(ordinary.execute({ type: "upgradeHomeCore" })).toBe(true);
    expect(ordinary.person.exp.intelligence).toBe(6);
    expect(ordinary.player.persistentIntelligenceExp).toBe(6);
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

describe("playerRecord", () => {
  test("total playtime advances only when the engine accounts a complete cycle", () => {
    const world = new SimWorld({ seed: 1, totalPlaytime: 123 });
    world.clock.run(() => world.clock.now() >= 199, 199);
    expect(world.playerRecord().totalPlaytime).toBe(123);
    world.addPlaytime(200);
    expect(world.playerRecord().totalPlaytime).toBe(323);
  });

  test("is a SNAPSHOT — nested objects are copied, never aliased", () => {
    // The controller stores this in its game-state store and DECIDES from it.
    // The previous implementation spread `this.person`, so `skills`, `exp` and
    // `mults` all aliased the live objects: a "snapshot" taken ten minutes ago
    // would silently report the current skill vector, and any test comparing
    // the two would pass for entirely the wrong reason.
    const world = makeWorld();
    const before = world.playerRecord();
    const skillsBefore = before.skills.hacking;

    world.person.skills.hacking = 500;
    world.person.exp.hacking = 12_345;
    world.person.mults.hacking = 2;

    expect(before.skills.hacking, "skills aliased the live person").toBe(skillsBefore);
    expect(before.exp.hacking).toBe(0);
    expect(before.mults.hacking).toBe(1);
    // ...and a record taken AFTER the change does see it.
    expect(world.playerRecord().skills.hacking).toBe(500);
  });

  test("mutating a record cannot corrupt the world", () => {
    const world = makeWorld();
    const record = world.playerRecord();
    (record.factions as string[]).push("CyberSec");
    (record.jobs as Record<string, string>)["ECorp"] = "Software";
    record.skills.hacking = 9999;

    expect(world.player.factions).toEqual([]);
    expect(world.player.jobs).toEqual({});
    expect(world.person.skills.hacking).toBe(1);
  });

  test("carries the player-only fields the faction requirements are written against", () => {
    const world = new SimWorld({
      seed: 1,
      network: DEFAULT_NETWORK,
      bitnode: 4,
      playerState: { karma: -54_000, numPeopleKilled: 30, factions: ["Slum Snakes"], jobs: { ECorp: "Software" } },
    });
    const record = world.playerRecord();
    expect(record.karma).toBe(-54_000);
    expect(record.numPeopleKilled).toBe(30);
    expect(record.factions).toEqual(["Slum Snakes"]);
    expect(record.jobs as Record<string, string>).toEqual({ ECorp: "Software" });
    // Deliberately NOT asserted here: Player carries no BitNode field. The
    // active node comes from ns.getResetInfo().currentNode.
    expect("bitNodeN" in record).toBe(false);
  });

  test("money has exactly one home", () => {
    const world = makeWorld();
    world.money += 500;
    expect(world.player.money).toBe(1_500);
    expect(world.playerRecord().money).toBe(1_500);
  });
});

describe("SimPlayer augmentation accounting", () => {
  test("owned reports every queued level while installed count stays separate", () => {
    const world = makeWorld();
    world.player.augmentations.set("Cranial Signal Processors - Gen I", 1);
    world.player.queuedAugmentations.set("NeuroFlux Governor", 3);

    expect(world.player.augmentationCount(true)).toBe(4);
    expect(world.player.augmentationCount(false)).toBe(1);
    expect(world.player.hasAugmentation("NeuroFlux Governor", true)).toBe(true);
    expect(world.player.hasAugmentation("NeuroFlux Governor", false)).toBe(false);
  });

  test("an augmentation both installed and queued remains duplicated in the API", () => {
    const world = makeWorld();
    world.player.augmentations.set("NeuroFlux Governor", 2);
    world.player.queuedAugmentations.set("NeuroFlux Governor", 3);
    expect(world.player.ownedAugmentations(true)).toEqual([
      "NeuroFlux Governor",
      "NeuroFlux Governor",
      "NeuroFlux Governor",
      "NeuroFlux Governor",
    ]);
  });
});
