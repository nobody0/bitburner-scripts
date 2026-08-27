import { makeOrder } from './support/dnet-order.ts';
import { describe, expect, test } from "bun:test";
import {
  DNET_REFUSAL_WAIT_MS,
  INDUCE_WAIT_MS,
  authenticateWaitMs,
  heartbleedWaitMs,
  knownDnetRefusalWaitMs,
  phishWaitMs,
  promoteWaitMs,
  reclaimWaitMs,
  stasisWaitMs,
  type DnetTimingProfile,
} from "../shared/strategy/dnet/rates.ts";
import { awaitDnetOperation } from "../game/dnet/timing.ts";
import { JOB_WATCHDOG_GRACE_MS, jobWatchdogExpired, type AgentHandle, type AgentIo, type Order } from "../game/dnet/shared.ts";
import { calculateDnetAuthenticateTime } from "../sim/ns/dnet.ts";

const target = { modelId: "ZeroLogon", difficulty: 3, depth: 4, requiredCharismaSkill: 500 };
const profile = (over: Partial<DnetTimingProfile> = {}): DnetTimingProfile => ({
  charisma: 700,
  intelligence: 0,
  hasBoots: false,
  sf15Level: 0,
  authenticationDurationMultiplier: 1,
  ...over,
});

describe("the shared pinned Darknet timing transcription", () => {
  test("authentication covers threads, underleveling, instability, B00ts, SF15, and intelligence multiplication", () => {
    const neutral = authenticateWaitMs(target, profile());
    expect(authenticateWaitMs(target, profile(), 2) / neutral).toBeCloseTo(1 / 1.2, 12);
    expect(authenticateWaitMs(target, profile({ authenticationDurationMultiplier: 1.7 })) / neutral).toBeCloseTo(1.7, 12);
    expect(authenticateWaitMs(target, profile({ hasBoots: true })) / neutral).toBeCloseTo(0.8, 12);
    expect(authenticateWaitMs(target, profile({ sf15Level: 2 })) / neutral).toBeCloseTo(1, 12);
    expect(authenticateWaitMs(target, profile({ sf15Level: 3 })) / neutral).toBeCloseTo(0.8, 12);

    const intelligenceBonus = 1 + (0.25 * Math.pow(600, 0.8)) / 600;
    expect(authenticateWaitMs(target, profile({ intelligence: 600 })) / neutral).toBeCloseTo(intelligenceBonus, 12);

    const under = profile({ charisma: 500 });
    const shallow = authenticateWaitMs({ ...target, depth: 1 }, under);
    const deep = authenticateWaitMs(target, under);
    expect(deep / shallow).toBeCloseTo(1.5 + 550 / 550, 12);
  });

  test("2G shared-character increments and every fixed/farm delay match upstream", () => {
    const twoG = { ...target, modelId: "2G_cellular" };
    const base = authenticateWaitMs(twoG, profile(), 3, 0);
    expect(authenticateWaitMs(twoG, profile(), 3, 2) - base).toBeCloseTo(100 / 1.4, 12);
    expect(heartbleedWaitMs(target, profile(), 2)).toBeCloseTo(authenticateWaitMs(target, profile(), 2) * 1.5, 12);
    expect(reclaimWaitMs(0)).toBe(8_000);
    expect(phishWaitMs(0)).toBe(10_000);
    expect(promoteWaitMs(0)).toBe(8_000);
    expect(INDUCE_WAIT_MS).toBe(6_000);
    expect(stasisWaitMs(0)).toBe(30_000);
    expect(DNET_REFUSAL_WAIT_MS).toBe(100);
  });

  test("cached facts select every known 100 ms early-refusal path without guessing unknowns", () => {
    expect(knownDnetRefusalWaitMs("authenticate", { direct: false })).toBe(100);
    expect(knownDnetRefusalWaitMs("heartbleed", { heartbleedUnderleveled: true })).toBe(100);
    expect(knownDnetRefusalWaitMs("memoryReallocation", { blockedRam: 0 })).toBe(100);
    expect(knownDnetRefusalWaitMs("induceServerMigration", { selfTarget: true })).toBe(100);
    expect(knownDnetRefusalWaitMs("induceServerMigration", { stationary: true })).toBe(100);
    expect(knownDnetRefusalWaitMs("setStasisLink", { stasisLimitReached: true })).toBe(100);
    expect(knownDnetRefusalWaitMs("promoteStock", { targetGone: true })).toBe(100);
    expect(knownDnetRefusalWaitMs("authenticate", {})).toBeUndefined();
  });

  test("the simulator delegates to the same authoritative implementation", () => {
    const options = {
      skills: () => ({ charisma: 700, intelligence: 600 }),
      hasBoots: () => true,
      sf15Level: () => 3,
      system: { instability: () => ({ authenticationDurationMultiplier: 1.4 }) },
    } as never;
    const expected = authenticateWaitMs(target, profile({
      intelligence: 600, hasBoots: true, sf15Level: 3, authenticationDurationMultiplier: 1.4,
    }), 4, 2);
    expect(calculateDnetAuthenticateTime(options, target, 4, 2)).toBe(expected);
  });
});

describe("operation-boundary estimates", () => {
  test("a deferred call publishes, clears on early completion, and the next call restamps", async () => {
    const stamps: (number | undefined)[] = [];
    const delays = [10_000, 20_000];
    const io = {
      beat: () => {},
      setExpectedDoneAt: (at: number | undefined) => stamps.push(at),
      cancelled: () => undefined,
      hold: () => {},
      deps: { expectedDelayMs: () => delays.shift() },
    } as unknown as AgentIo;
    let release!: () => void;
    const first = awaitDnetOperation(io, { operation: "phishingAttack", host: "dn-1", from: "dn-1", threads: 1 },
      () => new Promise<void>((resolve) => { release = resolve; }));
    await Promise.resolve();
    expect(stamps[0]).toBeGreaterThan(Date.now());
    release();
    await first;
    expect(stamps.at(-1)).toBeUndefined();

    await awaitDnetOperation(io, { operation: "promoteStock", host: "dn-1", from: "dn-1", threads: 1 }, async () => {});
    expect(stamps[2]).toBeGreaterThan(stamps[0]!);
    expect(stamps.at(-1)).toBeUndefined();
  });

  test("estimated work can remain healthy past sixty seconds while a truly stalled unknown call expires", () => {
    const order = makeOrder("attempt", { host: "dn-1", from: "darkweb", expectedDoneAt: 120_000 }, {});
    const handle = { order, beatAt: 0 } as AgentHandle;
    expect(jobWatchdogExpired(handle, 90_000)).toBe(false);
    expect(jobWatchdogExpired(handle, 120_000 + JOB_WATCHDOG_GRACE_MS + 1)).toBe(true);
    delete order.expectedDoneAt;
    expect(jobWatchdogExpired(handle, JOB_WATCHDOG_GRACE_MS)).toBe(false);
    expect(jobWatchdogExpired(handle, JOB_WATCHDOG_GRACE_MS + 1)).toBe(true);
  });
});
