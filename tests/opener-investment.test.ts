import type { Server } from "@ns";
import { describe, expect, test } from "bun:test";
import { makeHackContext } from "../shared/formulas.ts";
import { planNextOpener } from "../shared/strategy/access/openers.ts";
import { TOR_COST } from "../shared/strategy/dnet/rates.ts";
import { solveCycle } from "../shared/strategy/targeting.ts";

const PLAYER = {
  skill: 200,
  intelligence: 0,
  mults: { hacking_chance: 1, hacking_money: 1, hacking_speed: 1, hacking_exp: 1, hacking_grow: 1 },
};
const hackContext = makeHackContext(PLAYER);

function server(hostname: string, over: Partial<Server> = {}): Server {
  return {
    hostname,
    hasAdminRights: false,
    purchasedByPlayer: false,
    requiredHackingSkill: 100,
    numOpenPortsRequired: 1,
    maxRam: 32,
    moneyMax: 100e6,
    serverGrowth: 50,
    minDifficulty: 10,
    baseDifficulty: 10,
    ...over,
  } as Server;
}

function plan(servers: Server[], over: Partial<Parameters<typeof planNextOpener>[0]> = {}) {
  return planNextOpener({
    servers,
    hackingSkill: PLAYER.skill,
    hackContext,
    fleetGb: 32,
    ownedOpeners: 0,
    hasTor: false,
    ...over,
  });
}

describe("port-opener investment", () => {
  test("buys the next tier when it unlocks a more productive farm", () => {
    const result = plan([server("richer")]);
    expect(result?.targetOpeners).toBe(1);
    expect(result?.addedMoneyPerSec).toBeGreaterThan(0);
  });

  test("does not anticipate through a missing earlier opener", () => {
    const tierTwo = server("tier-two", { numOpenPortsRequired: 2 });
    expect(plan([tierTwo])).toBeUndefined();
    expect(plan([tierTwo], { ownedOpeners: 1, hasTor: true })).toBeDefined();
  });

  test("values worker RAM even when the unlocked host itself has no money", () => {
    const currentServer = server("current", { hasAdminRights: true, numOpenPortsRequired: 0 });
    const currentSolution = solveCycle(hackContext, {
      hostname: currentServer.hostname,
      minDifficulty: currentServer.minDifficulty!,
      moneyMax: currentServer.moneyMax!,
      requiredHackingSkill: currentServer.requiredHackingSkill!,
      serverGrowth: currentServer.serverGrowth!,
      baseDifficulty: currentServer.baseDifficulty!,
    })!;
    const worker = server("worker", { moneyMax: 0, serverGrowth: 0, maxRam: 128 });
    const result = plan([currentServer, worker], {
      fleetGb: 8,
      currentFarm: { solution: currentSolution },
    });
    expect(result?.addedMoneyPerSec).toBeGreaterThan(0);
  });

  test("TOR bought for darknet access is not charged a second time", () => {
    const withoutTor = plan([server("target")], { hasTor: false })!;
    const withTor = plan([server("target")], { hasTor: true })!;
    expect(withoutTor.cost - withTor.cost).toBe(TOR_COST);
  });

  test("waits when today's skill cannot use the newly priced tier", () => {
    expect(plan([server("future", { requiredHackingSkill: PLAYER.skill + 1 })])).toBeUndefined();
  });
});
