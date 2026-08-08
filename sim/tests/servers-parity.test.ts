import { describe, expect, test } from "bun:test";
import { SERVER_METADATA } from "../vendor/bitburner/src/Server/data/ServerMetadata.ts";
import { SERVER_RANGES, rollPercentile, rolledMoney, rolledSecurity } from "../../shared/features/servers.ts";

/** `shared/features/servers.ts` is a hand-transcribed copy of the vendored
 * server metadata: `ui/` needs it and may not import `sim/`
 * (tests/boundaries.test.ts). This is the parity suite that keeps the copy
 * honest — `sim/` is the one place allowed to read both sides.
 *
 * After `bun run vendor` bumps the tag, a failure here is the EXPECTED signal:
 * update the transcription to match. Without it the roll column would keep
 * measuring this save's servers against a previous release's ranges and report
 * confident nonsense. */

describe("server range transcription parity", () => {
  test("the same hosts exist on both sides", () => {
    expect(Object.keys(SERVER_RANGES).sort()).toEqual(Object.keys(SERVER_METADATA).sort());
  });

  test("every range matches field for field", () => {
    for (const [host, vendored] of Object.entries(SERVER_METADATA)) {
      const mine = SERVER_RANGES[host];
      expect(mine, `${host} missing from the transcription`).toBeDefined();
      expect(mine!.money, `${host} money`).toEqual(vendored.money as never);
      expect(mine!.skill, `${host} skill`).toEqual(vendored.skill as never);
      expect(mine!.sec, `${host} sec`).toEqual(vendored.sec as never);
      expect(mine!.growth, `${host} growth`).toEqual(vendored.growth as never);
      expect(mine!.ramExp, `${host} ramExp`).toEqual(vendored.ramExp as never);
      expect(mine!.ports, `${host} ports`).toBe(vendored.ports);
    }
  });
});

describe("inverting a roll", () => {
  test("moneyMax undoes both the 25x and the BitNode multiplier", () => {
    // A BN12 megacorp reading $720.65b: 25 * roll * 0.7.
    const rolled = rolledMoney(720.65e9, 0.7)!;
    expect(rolled).toBeCloseTo(41.18e9, -8);
    // ...which lands inside the documented $40-60b range, low-ish.
    const p = rollPercentile(rolled, SERVER_RANGES["megacorp"]!.money)!;
    expect(p).toBeGreaterThan(0);
    expect(p).toBeLessThan(0.1);
  });

  test("a fixed field has no percentile rather than a fabricated one", () => {
    // n00dles is $70,000 in every save; there is no luck to report.
    expect(rollPercentile(70_000, SERVER_RANGES["n00dles"]!.money)).toBeUndefined();
  });

  test("security sitting at the cap cannot be inverted", () => {
    // ecorp's base security is a fixed 99; under a >1.01x ServerStartingSecurity
    // it clips at 100, and every roll above the cap looks identical afterwards.
    expect(rolledSecurity(100, 1.5)).toBeUndefined();
    expect(rolledSecurity(75, 1.5)).toBeCloseTo(50, 6);
  });

  test("percentiles are clamped, never negative or above one", () => {
    const range = SERVER_RANGES["ecorp"]!.money!;
    expect(rollPercentile(1, range)).toBe(0);
    expect(rollPercentile(1e30, range)).toBe(1);
  });
});
