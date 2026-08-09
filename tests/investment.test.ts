import { describe, expect, test } from "bun:test";
import { resolveClaims, type Claim } from "../shared/strategy/arbiter.ts";
import { scoreHomeRam, stepInfrastructure } from "../shared/strategy/infrastructure.ts";
import { scoreInvestment } from "../shared/strategy/investment.ts";

describe("cross-feature investments", () => {
  test("home RAM is rejected when its payoff is beyond the run horizon", () => {
    const short = scoreHomeRam({ currentRam: 64, upgradeCost: 1_000_000, incomePerSecPerGb: 1, horizonSec: 1_000 });
    expect(short.worthBuying).toBe(false);
    const long = scoreHomeRam({ currentRam: 64, upgradeCost: 1_000_000, incomePerSecPerGb: 1_000, horizonSec: 1_000 });
    expect(long.worthBuying).toBe(true);
  });

  test("the arbiter funds the faster ROI, regardless of feature", () => {
    const claim = (by: "hacking" | "hacknet", id: string, cost: number, incomePerSec: number): Claim => ({
      by, id, resource: "money", amount: cost, priority: 25, mode: "spend", divisible: false,
      ratePerSec: incomePerSec,
      returnPerDollarSec: scoreInvestment({ cost, incomePerSec }, 3_600).returnPerDollarSec,
      why: "test",
    });
    const result = resolveClaims({
      now: 0,
      pools: { money: 1_000, ram: 0 },
      claims: [claim("hacking", "home", 1_000, 10), claim("hacknet", "node", 1_000, 20)],
    });
    expect(result.grants.map((grant) => grant.claimId)).toEqual(["node"]);
  });

  test("cloud purchases, cloud upgrades and home cores share one ROI ranking", () => {
    const decision = stepInfrastructure([
      { kind: "buyServer", cost: 800, addedRam: 8, targetRam: 8, incomePerSec: 8 },
      { kind: "upgradeServer", host: "pserv-0", cost: 400, addedRam: 8, targetRam: 16, incomePerSec: 8 },
      { kind: "homeCore", cost: 1_000, addedRam: 0, incomePerSec: 30 },
    ], 10_000);
    expect(decision.buy?.kind).toBe("homeCore");
    expect(decision.ranked.map((entry) => entry.kind)).toEqual(["homeCore", "upgradeServer", "buyServer"]);
  });
});
