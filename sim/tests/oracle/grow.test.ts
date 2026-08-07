import { expect, test } from "bun:test";
import { mockPerson, mockServer } from "../../core/mocks.ts";
import { numCycleForGrowthCorrected } from "../../vendor/bitburner/src/Server/GrowthCycles.ts";
import { calculateServerGrowth } from "../../vendor/bitburner/src/Server/formulas/grow.ts";

// Ported from bitburner-src v3.0.1 test/jest/Grow.test.ts ("Grow is accurate").
// The upstream test builds Server/PlayerObject instances; the vendored formulas
// only read @nsdefs shapes, so plain literals must reproduce the same exact
// floating-point results. Passing proves the vendor+patch pipeline preserved
// the game's growth math bit-for-bit.
test("Grow is accurate (game oracle values)", () => {
  const server = mockServer({ hostname: "foo", hackDifficulty: 5, serverGrowth: 100 });
  const player = mockPerson();
  expect(calculateServerGrowth(server, 1, player)).toBe(1.0035);
  expect(calculateServerGrowth(server, 2, player)).toBe(1.00701225);
  server.hackDifficulty = 10;
  expect(calculateServerGrowth(server, 1, player)).toBe(1.003);
  expect(calculateServerGrowth(server, 2, player)).toBe(1.006009);
  expect(calculateServerGrowth(server, 3, player)).toBe(1.009027027);
  expect(calculateServerGrowth(server, 4, player)).toBe(1.012054108081);
});

// Ported from the same file: "numCycleForGrowthCorrected reverses
// calculateServerGrowth". Exercises the vendored Newton-Raphson solver across
// the full float range upstream covers.
test("numCycleForGrowthCorrected reverses calculateServerGrowth", () => {
  const multiplier = Math.exp(1.4);
  const server = mockServer({
    hostname: "foo",
    hackDifficulty: 10 * multiplier,
    serverGrowth: 100,
    moneyMax: 1e308,
    moneyAvailable: 0,
  });
  const player = mockPerson();

  const starts: number[] = [];
  let money = 0;
  while (money < 5e49) {
    starts.push(money);
    money = (money + 59) * calculateServerGrowth(server, 59, player);
  }

  for (const start of starts) {
    for (let threads = 0; threads < 30; threads++) {
      const newMoney = (start + threads) * calculateServerGrowth(server, threads, player);
      const eps = newMoney ? 2 ** (Math.floor(Math.log2(newMoney)) - 52) : Number.MIN_VALUE;
      expect(numCycleForGrowthCorrected(server, newMoney, start, 1, player)).toBe(threads);
      expect(numCycleForGrowthCorrected(server, newMoney + eps, start, 1, player)).toBe(threads + 1);
    }
  }
});
