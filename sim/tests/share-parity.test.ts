import { describe, expect, test } from "bun:test";
import type { NS, ResetInfo } from "@ns";
import { SimWorld } from "../world.ts";
import { ShareSystem } from "../features/share.ts";
import { FactionSystem } from "../features/factions.ts";
import { makeSimNs, type SimNsHost } from "../ns/api.ts";
import { ProcessTable } from "../ns/process.ts";
import {
  calculateEffectiveSharedThreads,
  calculateShareBonus,
  setShareContext,
} from "../vendor/bitburner/src/NetworkShare/Share.ts";

function nsHarness(threads = 8, cores = 4): { ns: NS; host: SimNsHost; share: ShareSystem } {
  const world = new SimWorld({ seed: 1, homeCores: cores });
  const share = new ShareSystem(world);
  const processes = new ProcessTable(world.servers, world.clock);
  const process = processes.start({
    filename: "share.js",
    host: "home",
    args: [],
    threads,
    ramPerThreadGb: 0.1,
    temporary: false,
  })!;
  const host: SimNsHost = {
    world,
    clock: world.clock,
    processes,
    share,
    files: new Map([["home", new Set(["share.js"])]]),
    contents: new Map(),
    scripts: new Map(),
    network: new Map([["home", ["home"]]]),
    ramCtx: { bitNode: 1 },
    reset: { currentNode: 1, ownedAugs: new Map(), ownedSF: new Map() } as ResetInfo,
    output: [],
    crashes: [],
  };
  return { ns: makeSimNs(host, process), host, share };
}

describe("NetworkShare parity", () => {
  test("effective threads include live intelligence weight 2 and host core bonus", () => {
    const world = new SimWorld({ seed: 1 });
    world.person.skills.intelligence = 81;
    const share = new ShareSystem(world);
    setShareContext({ intelligence: 81 });
    const expected = calculateEffectiveSharedThreads(12, 8);
    const release = share.startSharing(12, 8);
    expect(share.effectiveThreads).toBe(1 + expected);
    expect(share.currentBonus()).toBe(calculateShareBonus(1 + expected));
    release();
    expect(share.currentBonus()).toBe(1);
  });

  test("concurrent callers aggregate effective threads before one logarithm", () => {
    const world = new SimWorld({ seed: 2 });
    world.person.skills.intelligence = 37;
    const share = new ShareSystem(world);
    setShareContext({ intelligence: 37 });
    const calls = [[3, 1], [5, 4], [11, 8]] as const;
    const effective = calls.map(([threads, cores]) => calculateEffectiveSharedThreads(threads, cores));
    const releases = calls.map(([threads, cores]) => share.startSharing(threads, cores));
    const aggregate = 1 + effective.reduce((sum, value) => sum + value, 0);
    expect(share.effectiveThreads).toBeCloseTo(aggregate, 14);
    expect(share.currentBonus()).toBeCloseTo(calculateShareBonus(aggregate), 14);
    expect(share.currentBonus()).not.toBeCloseTo(
      effective.reduce((product, value) => product * calculateShareBonus(1 + value), 1),
      8,
    );

    releases[1]!();
    expect(share.effectiveThreads).toBeCloseTo(aggregate - effective[1]!, 14);
    releases[0]!();
    releases[2]!();
    expect(share.effectiveThreads).toBe(1);
    expect(share.currentBonus()).toBe(1);
  });

  test("share steps off as one contribution exactly at 10 seconds", async () => {
    const { ns, host, share } = nsHarness();
    let finished = false;
    const pending = ns.share().then(() => { finished = true; });
    const activeBonus = share.currentBonus();
    expect(activeBonus).toBeGreaterThan(1);

    expect(await host.clock.runAsync(() => finished, 9_999)).toBe("horizon");
    expect(share.currentBonus()).toBe(activeBonus);
    expect(await host.clock.runAsync(() => finished, 10_000)).toBe("goal");
    await pending;
    expect(share.currentBonus()).toBe(1);
  });

  test("production reputation wiring preserves work-type share leverage", () => {
    const world = new SimWorld({ seed: 3 });
    Object.assign(world.person.skills, {
      hacking: 500,
      intelligence: 50,
      strength: 500,
      defense: 500,
      dexterity: 500,
      agility: 500,
      charisma: 500,
    });
    const share = new ShareSystem(world);
    const factions = new FactionSystem(world, world.player, {}, share);
    const baseline = {
      hacking: factions.workRepGain("hacking", 0),
      security: factions.workRepGain("security", 0),
      field: factions.workRepGain("field", 0),
    };
    const release = share.startSharing(10_000, 8);
    const bonus = share.currentBonus();
    const shared = {
      hacking: factions.workRepGain("hacking", 0),
      security: factions.workRepGain("security", 0),
      field: factions.workRepGain("field", 0),
    };

    expect(shared.hacking / baseline.hacking).toBeCloseTo(bonus, 14);
    expect(shared.security / baseline.security).toBeGreaterThan(1);
    expect(shared.security / baseline.security).toBeLessThan(bonus);
    expect(shared.field / baseline.field).toBeGreaterThan(1);
    expect(shared.field / baseline.field).toBeLessThan(bonus);
    release();
  });
});
