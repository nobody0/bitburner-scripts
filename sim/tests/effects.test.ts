import { beforeAll, describe, expect, test } from "bun:test";
import {
  applyGrow,
  applyHack,
  applyWeaken,
  getUpgradeHomeRamCost,
  getCloudServerCost,
  getWeakenEffect,
  serverFromSpec,
  type SimServer,
} from "../core/effects.ts";
import { mockPerson, mockServer } from "../core/mocks.ts";
import { getBitNodeMultipliers } from "../vendor/bitburner/src/BitNode/BitNodeMults.ts";
import { replaceCurrentNodeMults } from "../vendor/bitburner/src/BitNode/BitNodeMultipliers.ts";
import {
  calculateHackingChance,
  calculateHackingExpGain,
  calculatePercentMoneyHacked,
} from "../vendor/bitburner/src/Hacking.ts";
import { calculateGrowMoney } from "../vendor/bitburner/src/Server/formulas/grow.ts";
import { calculateSkill } from "../vendor/bitburner/src/PersonObjects/formulas/skill.ts";

beforeAll(() => replaceCurrentNodeMults(getBitNodeMultipliers(1, 1)));

function noodles(): SimServer {
  const server = serverFromSpec(
    { hostname: "n00dles", hackDifficulty: 1, moneyAvailable: 70_000, requiredHackingSkill: 1, serverGrowth: 3000, numOpenPortsRequired: 0, maxRam: 4 },
    mockServer() as SimServer,
  );
  server.hasAdminRights = true;
  return server;
}

describe("serverFromSpec (BN1 derivations)", () => {
  test("derives live fields like the game Server constructor", () => {
    const server = noodles();
    expect(server.moneyAvailable).toBe(70_000);
    expect(server.moneyMax).toBe(25 * 70_000);
    expect(server.baseDifficulty).toBe(1);
    expect(server.minDifficulty).toBe(1); // round(1/3)=0 -> clamped to 1
  });
});

describe("applyHack", () => {
  test("successful hack drains money, fortifies, gains exp", () => {
    const server = noodles();
    const person = mockPerson();
    person.skills.hacking = 50;
    const chance = calculateHackingChance(server, person);
    expect(chance).toBeGreaterThan(0.5);

    const percent = calculatePercentMoneyHacked(server, person);
    const expectedDrain = server.moneyAvailable * percent * 10;
    const expectedExp = calculateHackingExpGain(server, person) * 10;
    const before = { money: server.moneyAvailable, sec: server.hackDifficulty };

    const outcome = applyHack(server, person, 10, 0); // rand=0 < chance => success
    expect(outcome.success).toBe(true);
    expect(outcome.moneyGained).toBeCloseTo(expectedDrain, 8); // BN1 ScriptHackMoneyGain = 1
    expect(server.moneyAvailable).toBeCloseTo(before.money - expectedDrain, 8);
    expect(server.hackDifficulty).toBeCloseTo(before.sec + 0.002 * 10, 12);
    expect(outcome.expGained).toBeCloseTo(expectedExp, 12);
    expect(person.skills.hacking).toBe(calculateSkill(person.exp.hacking, 1));
  });

  test("failed hack gains quarter exp, drains nothing", () => {
    const server = noodles();
    const person = mockPerson();
    person.skills.hacking = 50;
    const money = server.moneyAvailable;
    const outcome = applyHack(server, person, 10, 0.999999999); // rand ~1 => fail
    expect(outcome.success).toBe(false);
    expect(server.moneyAvailable).toBe(money);
    expect(outcome.expGained).toBeCloseTo((calculateHackingExpGain(server, person) * 10) / 4, 12);
  });
});

describe("applyGrow", () => {
  test("matches calculateGrowMoney and fortifies by used cycles", () => {
    const server = noodles();
    const person = mockPerson();
    server.moneyAvailable = 10_000;
    const expected = calculateGrowMoney(server, 5, person, 1);
    const secBefore = server.hackDifficulty;
    const outcome = applyGrow(server, person, 5, 1);
    expect(server.moneyAvailable).toBe(expected);
    expect(outcome.growth).toBeCloseTo(expected / 10_000, 12);
    // 5 threads all used (money far below max) -> fortify 2*0.002*5
    expect(server.hackDifficulty).toBeCloseTo(secBefore + 2 * 0.002 * 5, 12);
  });

  test("caps at moneyMax", () => {
    const server = noodles();
    const person = mockPerson();
    server.moneyAvailable = server.moneyMax * 0.999999;
    applyGrow(server, person, 10_000, 1);
    expect(server.moneyAvailable).toBe(server.moneyMax);
  });
});

describe("applyWeaken", () => {
  test("reduces security by ServerWeakenAmount per thread, clamped at min", () => {
    const server = noodles();
    const person = mockPerson();
    server.hackDifficulty = 10;
    expect(getWeakenEffect(20, 1)).toBeCloseTo(0.05 * 20, 12);
    const outcome = applyWeaken(server, person, 20, 1);
    expect(server.hackDifficulty).toBeCloseTo(9, 12);
    expect(outcome.securityReduced).toBeCloseTo(1, 12);

    server.hackDifficulty = 1.01;
    applyWeaken(server, person, 100, 1);
    expect(server.hackDifficulty).toBe(server.minDifficulty);
  });
});

describe("costs", () => {
  test("cloud server cost matches formula", () => {
    // 64 GB is below the softcap threshold (2^6): plain 64 * 55000
    expect(getCloudServerCost(64)).toBe(64 * 55_000);
    expect(getCloudServerCost(63)).toBe(Infinity); // not a power of two
  });

  test("home ram upgrade cost matches formula", () => {
    // 8 GB home: 8 * 32000 * 1.58^3
    expect(getUpgradeHomeRamCost(8)).toBeCloseTo(8 * 32_000 * 1.58 ** 3, 6);
  });
});
