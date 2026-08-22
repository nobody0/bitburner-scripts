import { describe, expect, test } from "bun:test";
import {
  advanceInfrastructureFrontier,
  capInfrastructureByObservedFleet,
  deferPrerequisitePurchase,
  infrastructureBeforeMoneyNeeds,
  scoreHomeRam,
  stepInfrastructure,
} from "../shared/strategy/infrastructure.ts";
import {
  grantFor,
  grantedAmount,
  holdsSlot,
  PREEMPT_MARGIN,
  PRIORITY,
  priorityOf,
  resolveClaims,
  STEP_LOOP_CAP,
  waterFill,
  type ArbiterInput,
  type Claim,
  type StepClaim,
} from "../shared/strategy/arbiter.ts";
import { shareCutover, type ShareValueCurve } from "../shared/strategy/share.ts";

function claim(partial: Partial<Claim> & Pick<Claim, "id" | "resource" | "amount" | "priority">): Claim {
  return { by: "factions", mode: "spend", shape: "step",
    pricing: "hard", value: { state: "measured", value: Infinity }, ...partial } as Claim;
}

function stepClaim(partial: Parameters<typeof claim>[0]): StepClaim {
  return claim(partial) as StepClaim;
}
type TestArbiterInput = Omit<Partial<ArbiterInput>, "pools"> & Pick<ArbiterInput, "claims"> & {
  pools?: { money: number; ram?: number };
};

function input(partial: TestArbiterInput): ArbiterInput {
  const { pools, ...rest } = partial;
  return { now: 1_000, pools: { money: pools?.money ?? 0 }, ...rest };
}

describe("money arbitration", () => {
  test("grants in priority order against a shrinking pool", () => {
    const result = resolveClaims(
      input({
        pools: { money: 100, ram: 0 },
        claims: [
          claim({ id: "hacknet", by: "hacknet", resource: "money", amount: 80, priority: PRIORITY["hacknet:upgrade"] }),
          claim({ id: "augs", by: "factions", resource: "money", amount: 60, priority: PRIORITY["factions:aug-fund"] }),
        ],
      }),
    );
    // The aug fund is higher priority, so it eats first even though the
    // hacknet claim was listed first and is cheaper.
    expect(grantedAmount(result, "factions", "money")).toBe(60);
    expect(result.remaining.money).toBe(40);
    expect(result.denied.map((d) => [d.claimId, d.reason])).toEqual([["hacknet", "partial"]]);
  });

  test("an indivisible claim that cannot be met does NOT consume the pool", () => {
    // Load-bearing: half an augmentation is nothing, so a short indivisible
    // claim must leave its money for a cheaper claim behind it rather than
    // burning the pool and starving everyone.
    const result = resolveClaims(
      input({
        pools: { money: 50, ram: 0 },
        claims: [
          claim({ id: "augs", by: "factions", resource: "money", amount: 1_000, priority: 90 }),
          claim({ id: "node", by: "hacknet", resource: "money", amount: 40, priority: 25 }),
        ],
      }),
    );
    expect(grantedAmount(result, "factions", "money")).toBe(0);
    expect(grantedAmount(result, "hacknet", "money")).toBe(40);
    expect(result.remaining.money).toBe(10);
  });

  test("a divisible claim takes what is left and is flagged partial", () => {
    const result = resolveClaims(
      input({
        pools: { money: 30, ram: 0 },
        claims: [claim({ id: "levels", by: "hacknet", resource: "money", amount: 100, priority: 25, shape: "continuous" })],
      }),
    );
    const grant = grantFor(result, "hacknet", "levels")!;
    expect(grant.amount).toBe(30);
    expect(grant.partial).toBe(true);
    expect(result.remaining.money).toBe(0);
  });

  test("a reserve consumes the pool exactly like a spend — that IS the reservation", () => {
    const result = resolveClaims(
      input({
        pools: { money: 100, ram: 0 },
        claims: [
          claim({ id: "fund", by: "factions", resource: "money", amount: 70, priority: 90, mode: "reserve" }),
          claim({ id: "node", by: "hacknet", resource: "money", amount: 70, priority: 25 }),
        ],
      }),
    );
    expect(result.reserved.map((g) => g.claimId)).toEqual(["fund"]);
    expect(result.remaining.money).toBe(30);
    expect(grantedAmount(result, "hacknet", "money")).toBe(0);
  });

  test("an empty pool denies with `outbid`, a zero claim with `empty`", () => {
    const result = resolveClaims(
      input({
        pools: { money: 0, ram: 0 },
        claims: [
          claim({ id: "a", resource: "money", amount: 5, priority: 10 }),
          claim({ id: "b", resource: "money", amount: 0, priority: 10 }),
        ],
      }),
    );
    expect(new Map(result.denied.map((d) => [d.claimId, d.reason]))).toEqual(
      new Map([
        ["a", "outbid"],
        ["b", "empty"],
      ]),
    );
  });

  test("equal priority breaks on rate, then feature, then claim id — never input order", () => {
    const claims = [
      claim({ id: "z", by: "stock", resource: "money", amount: 10, priority: 50, ratePerSec: 1 }),
      claim({ id: "a", by: "gang", resource: "money", amount: 10, priority: 50, ratePerSec: 9 }),
      claim({ id: "m", by: "corp", resource: "money", amount: 10, priority: 50, ratePerSec: 1 }),
    ];
    const forward = resolveClaims(input({ pools: { money: 20, ram: 0 }, claims }));
    const backward = resolveClaims(input({ pools: { money: 20, ram: 0 }, claims: [...claims].reverse() }));
    const winners = (r: typeof forward) => r.grants.map((g) => g.claimId);
    expect(winners(forward)).toEqual(["a", "m"]);
    expect(winners(backward)).toEqual(winners(forward));
  });

});

describe("marginal-value water-filling", () => {
  test("lambda converges and exhausts the pool for mixed linear and log curves", () => {
    const logNumerator = 8;
    const logSlope = 0.05;
    const result = waterFill(80, [
      {
        id: "linear",
        amount: 100,
        curve: { marginalValueAt: (granted) => Math.max(0, 10 - 0.1 * granted) },
      },
      {
        id: "log",
        amount: 100,
        curve: {
          demandAt: (lambda) => lambda <= 0
            ? 100
            : Math.max(0, Math.min(100, (logNumerator / lambda - 1) / logSlope)),
        },
      },
    ]);
    expect(result.grants.reduce((sum, grant) => sum + grant.amount, 0)).toBeCloseTo(80, 8);
    expect(result.remaining).toBeCloseTo(0, 8);
    expect(result.grants[0]!.marginalValue).toBeCloseTo(result.lambda, 7);
    expect(result.grants[1]!.marginalValue).toBeCloseTo(result.lambda, 7);
  });

  test("the general solver reproduces shareCutover's two-claimant crossing", () => {
    const fleetGb = 100;
    const curve: ShareValueCurve = {
      hackMarginal: { state: "measured", value: 0.5 },
      reputationSecondsPerBonus: 250,
      effectiveThreadsPerGb: 1,
    };
    const analytic = shareCutover(curve, fleetGb, Infinity, 1e-9);
    const result = waterFill(fleetGb, [
      {
        id: "share",
        amount: fleetGb,
        curve: {
          // shareMarginal = k*c/(1+c*g), so g = k/lambda - 1/c.
          demandAt: (lambda) => lambda <= 0
            ? fleetGb
            : Math.max(0, Math.min(fleetGb, 10 / lambda - 1)),
        },
      },
      {
        id: "hacking",
        amount: fleetGb,
        curve: {
          // Re-express hackMarginalAt in hacking allocation h=fleet-share.
          demandAt: (lambda) => lambda <= 0.5
            ? fleetGb
            : Math.min(fleetGb, fleetGb * Math.sqrt(0.5 / lambda)),
        },
      },
    ]);
    expect(result.grants.find((grant) => grant.id === "share")!.amount).toBeCloseTo(analytic.cutoverGb, 6);
    expect(result.grants.reduce((sum, grant) => sum + grant.amount, 0)).toBeCloseTo(fleetGb, 8);
  });

  test("a huge divisible demand is fully resolved once, not in tiny grant increments", () => {
    let samples = 0;
    const result = waterFill(10_000_000_000, [{
      id: "tiny-increments",
      amount: 10_000_000_000,
      curve: {
        marginalValueAt: () => {
          samples += 1;
          return 1;
        },
      },
    }]);
    expect(result.grants[0]!.amount).toBe(10_000_000_000);
    expect(result.remaining).toBe(0);
    expect(samples).toBeLessThan(100);
  });

  test("hard bands resolve before curves, while peers share one waterline", () => {
    const result = resolveClaims(input({
      pools: { money: 100, ram: 0 },
      claims: [
        claim({ id: "hard", resource: "money", amount: 20, priority: 90 }),
        claim({
          id: "a",
          by: "stock",
          resource: "money",
          amount: 100,
          priority: 25,
          shape: "continuous",
          valueCurve: { marginalValueAt: (granted) => 10 - granted / 10 },
        }),
        claim({
          id: "b",
          by: "hacknet",
          resource: "money",
          amount: 100,
          priority: 25,
          shape: "continuous",
          valueCurve: { marginalValueAt: (granted) => 8 - granted / 10 },
        }),
      ],
    }));
    expect(grantFor(result, "factions", "hard")?.amount).toBe(20);
    expect(grantFor(result, "stock", "a")!.amount).toBeGreaterThan(0);
    expect(grantFor(result, "hacknet", "b")!.amount).toBeGreaterThan(0);
    expect(grantedAmount(result, "stock", "money") + grantedAmount(result, "hacknet", "money")).toBeCloseTo(80, 8);
    expect(result.waterlines).toHaveLength(1);
    expect(result.waterlines[0]).toMatchObject({ claimCount: 2, pricedClaimCount: 2 });
  });
});

describe("lumpy step pricing", () => {
  const continuous = (marginal: number, amount = 10_000_000_000): Claim => claim({
    by: "stock",
    id: "continuous",
    resource: "money",
    amount,
    priority: PRIORITY["income:investment"],
    shape: "continuous",
    valueCurve: { demandAt: (lambda) => lambda <= marginal ? amount : 0 },
  });

  test("an exact rung is bought and surplus returns to continuous claimants", () => {
    const billion = 1_000_000_000;
    const first = claim({
      by: "hacking",
      id: "home:8->16",
      resource: "money",
      amount: billion,
      priority: PRIORITY["income:investment"],
      mode: "reserve",
      shape: "step",
      pricing: "economic",
      value: { state: "measured", value: 2 * billion },
    });
    const result = resolveClaims(input({
      pools: { money: 2 * billion, ram: 0 },
      claims: [first, continuous(0.5)],
      nextStep: () => stepClaim({
        by: "hacking",
        id: "home:16->32",
        resource: "money",
        amount: 4 * billion,
        priority: PRIORITY["income:investment"],
        mode: "reserve",
        shape: "step",
        pricing: "economic",
        value: { state: "measured", value: 0 },
      }),
    }));

    expect(grantFor(result, "hacking", "home:8->16")?.amount).toBe(billion);
    expect(grantedAmount(result, "stock", "money")).toBeCloseTo(billion, 2);
    expect(result.remaining.money).toBeCloseTo(0, 2);
  });

  test("two economic features choose by value, independent of collection order", () => {
    // This belongs at the pure boundary: the production registry has one fixed
    // collection order, while resolveClaims is the contract that must ignore it.
    const claims = [
      claim({
        by: "hacking", id: "ram", resource: "money", amount: 80,
        priority: PRIORITY["income:investment"], shape: "step", pricing: "economic",
        value: { state: "measured", value: 800 },
      }),
      claim({
        by: "hacknet", id: "node", resource: "money", amount: 80,
        priority: PRIORITY["income:investment"], shape: "step", pricing: "economic",
        value: { state: "measured", value: 400 },
      }),
    ];
    const winner = (ordered: Claim[]) => resolveClaims(input({ pools: { money: 80 }, claims: ordered })).grants[0]?.by;
    expect(winner(claims)).toBe("hacking");
    expect(winner([...claims].reverse())).toBe("hacking");
  });

  test("an install-freeze hard reserve dominates an arbitrarily valuable investment", () => {
    // Hard safety policy is intentionally outside the economic objective. A
    // larger modeled payoff must never spend cash frozen for an imminent reset.
    const result = resolveClaims(input({
      pools: { money: 100 },
      claims: [
        claim({
          by: "hacknet", id: "fantastic-investment", resource: "money", amount: 100,
          priority: PRIORITY["income:investment"], shape: "step", pricing: "economic",
          value: { state: "measured", value: Number.MAX_VALUE },
        }),
        claim({
          by: "progression", id: "install-freeze", resource: "money", amount: 100,
          priority: PRIORITY["progression:install-freeze"], mode: "reserve",
        }),
      ],
    }));
    expect(grantFor(result, "progression", "install-freeze")?.amount).toBe(100);
    expect(grantFor(result, "hacknet", "fantastic-investment")).toBeUndefined();
  });

  test("a tiny continuous request is fully resolved in one pass against a huge pool", () => {
    // Pins the small-increment defect at the pure resolve boundary: observable
    // output is one complete grant, irrespective of the solver implementation.
    const result = resolveClaims(input({
      pools: { money: 1_000_000_000 },
      claims: [claim({
        by: "hacknet", id: "tiny", resource: "money", amount: 0.001,
        priority: PRIORITY["income:investment"], shape: "continuous",
        valueCurve: { demandAt: () => 0.001 },
      })],
    }));
    expect(grantFor(result, "hacknet", "tiny")).toMatchObject({ amount: 0.001, partial: false });
    expect(result.remaining.money).toBeCloseTo(999_999_999.999, 6);
  });

  test("a long wait loses at the going lambda, then wins when income rises or lambda falls", () => {
    const step = claim({
      by: "hacking",
      id: "rung",
      resource: "money",
      amount: 1_000,
      priority: PRIORITY["income:investment"],
      mode: "reserve",
      shape: "step",
      pricing: "economic",
      value: { state: "measured", value: 600 },
    });
    const slow = resolveClaims(input({
      pools: { money: 500, ram: 0 },
      claims: [step, continuous(0.5, 1_000)],
      expectedIncomePerSec: { state: "measured", value: 1 },
      reinvestmentReturnPerDollarSec: 0.01,
    }));
    expect(grantFor(slow, "hacking", "rung")).toBeUndefined();
    expect(grantedAmount(slow, "stock", "money")).toBeCloseTo(500, 8);

    const fasterIncome = resolveClaims(input({
      pools: { money: 500, ram: 0 },
      claims: [step, continuous(0.5, 1_000)],
      expectedIncomePerSec: { state: "measured", value: 1_000 },
      reinvestmentReturnPerDollarSec: 0.01,
    }));
    expect(grantFor(fasterIncome, "hacking", "rung")).toMatchObject({
      amount: 500,
      mode: "reserve",
      partial: true,
    });

    const lowerLambda = resolveClaims(input({
      pools: { money: 500, ram: 0 },
      claims: [step, continuous(0.001, 1_000)],
      expectedIncomePerSec: { state: "measured", value: 1 },
      reinvestmentReturnPerDollarSec: 0.01,
    }));
    expect(grantFor(lowerLambda, "hacking", "rung")?.mode).toBe("reserve");
  });

  test("the callback's next rung is priced against the updated pool", () => {
    // The first rung's value clears its DISPLACEMENT price: granting its $40
    // pushes the curve's fill from 100 down to 60, whose clearing lambda is 4,
    // and 200/40 = 5 beats that. (It used to be 40 — value-per-dollar 1 —
    // granted only because a fully-covered band quoted lambda 0; that
    // allocation destroyed value, 460 against the curve-only 500, and steps
    // are now priced against what they displace.)
    const first = claim({
      by: "hacking",
      id: "first",
      resource: "money",
      amount: 40,
      priority: PRIORITY["income:investment"],
      mode: "reserve",
      shape: "step",
      pricing: "economic",
      value: { state: "measured", value: 200 },
    });
    const result = resolveClaims(input({
      pools: { money: 100, ram: 0 },
      claims: [
        first,
        claim({
          by: "stock",
          id: "curve",
          resource: "money",
          amount: 100,
          priority: PRIORITY["income:investment"],
          shape: "continuous",
          valueCurve: { marginalValueAt: (granted) => 10 - granted / 10 },
        }),
      ],
      nextStep: () => stepClaim({
        by: "hacking",
        id: "second",
        resource: "money",
        amount: 40,
        priority: PRIORITY["income:investment"],
        mode: "reserve",
        shape: "step",
        pricing: "economic",
        value: { state: "measured", value: 80 },
      }),
    }));

    expect(grantFor(result, "hacking", "first")?.amount).toBe(40);
    expect(grantFor(result, "hacking", "second")).toBeUndefined();
    expect(grantedAmount(result, "stock", "money")).toBeCloseTo(60, 8);
    expect(result.waterlines[0]?.lambda).toBeCloseTo(4, 7);
  });

  test("the callback loop is bounded and reports a cap hit", () => {
    let rung = 0;
    const result = resolveClaims(input({
      pools: { money: 100, ram: 0 },
      claims: [claim({
        by: "hacking",
        id: "rung:0",
        resource: "money",
        amount: 1,
        priority: PRIORITY["income:investment"],
        shape: "step",
        pricing: "economic",
        value: { state: "measured", value: 100 },
      })],
      nextStep: () => stepClaim({
        by: "hacking",
        id: "rung:" + (++rung),
        resource: "money",
        amount: 1,
        priority: PRIORITY["income:investment"],
        shape: "step",
        pricing: "economic",
        value: { state: "measured", value: 100 },
      }),
    }));

    expect(result.stepLoop).toEqual({ iterations: STEP_LOOP_CAP, cap: STEP_LOOP_CAP, capHit: true });
    expect(result.grants).toHaveLength(STEP_LOOP_CAP);
    expect(result.warnings[0]).toContain("step loop hit cap");
  });

  test("unknown income cannot masquerade as zero wait", () => {
    const result = resolveClaims(input({
      pools: { money: 500, ram: 0 },
      claims: [
        claim({
          by: "hacking",
          id: "unknown-wait",
          resource: "money",
          amount: 1_000,
          priority: PRIORITY["income:investment"],
          mode: "reserve",
          shape: "step",
          pricing: "economic",
          value: { state: "measured", value: 10_000 },
        }),
        continuous(0.01, 1_000),
      ],
      expectedIncomePerSec: { state: "unknown", reason: "no measured income" },
      reinvestmentReturnPerDollarSec: 0.01,
    }));
    expect(grantFor(result, "hacking", "unknown-wait")).toBeUndefined();
    expect(grantedAmount(result, "stock", "money")).toBeCloseTo(500, 8);
  });
});
describe("the player-time slot", () => {
  const work = (id: string, by: Claim["by"], priority: number, extra: Partial<Claim> = {}) =>
    claim({ id, by, resource: "time", amount: 1, priority, ...extra });

  test("the highest bidder takes an empty slot, everyone else is slot-held", () => {
    const result = resolveClaims(
      input({ claims: [work("crime", "career", 30), work("faction", "factions", 60)] }),
    );
    expect(result.slot).toMatchObject({ claimId: "faction", by: "factions", since: 1_000 });
    expect(holdsSlot(result, "factions")).toBe(true);
    expect(result.denied.map((d) => [d.claimId, d.reason])).toEqual([["crime", "slot-held"]]);
  });

  test("an incumbent keeps the slot against a marginally better challenger", () => {
    const result = resolveClaims(
      input({
        slot: { claimId: "faction", by: "factions", priority: 60, since: 0 },
        claims: [work("faction", "factions", 60), work("crime", "career", 60 + PREEMPT_MARGIN)],
      }),
    );
    // Exactly at the margin is NOT enough — the challenger must exceed it.
    expect(holdsSlot(result, "factions")).toBe(true);
    expect(result.preempted).toBeUndefined();
    // and it keeps its original `since`, so hold time keeps accumulating.
    expect(result.slot!.since).toBe(0);
  });

  test("a decisively better challenger preempts, and the loss is reported", () => {
    const result = resolveClaims(
      input({
        slot: { claimId: "faction", by: "factions", priority: 60, since: 250 },
        claims: [work("faction", "factions", 60), work("crime", "career", 60 + PREEMPT_MARGIN + 1)],
      }),
    );
    expect(holdsSlot(result, "career")).toBe(true);
    expect(result.preempted).toEqual({ claimId: "faction", by: "factions", heldMs: 750 });
    expect(result.slot!.since).toBe(1_000);
  });

  test("holdUntil refuses pre-emption even by a decisive challenger", () => {
    const base = {
      slot: { claimId: "faction", by: "factions" as const, priority: 60, since: 0 },
      claims: [work("faction", "factions", 60, { holdUntil: 5_000 }), work("crime", "career", 99)],
    };
    expect(holdsSlot(resolveClaims(input({ ...base, now: 4_999 })), "factions")).toBe(true);
    // ...and yields the moment the hold expires.
    expect(holdsSlot(resolveClaims(input({ ...base, now: 5_000 })), "career")).toBe(true);
  });

  const RATES = {
    best: new Map([
      ["money", { state: "measured" as const, value: 4_000 }],
      ["reputation", { state: "measured" as const, value: 40 }],
    ]),
    worth: new Map([["money", 100], ["reputation", 4_000]]),
  };

  test("priced bids are ranked by BN-seconds saved, not by their band", () => {
    // Crime at a quarter of the best money rate, on a channel worth 100s, is
    // worth 25s. Reputation work is the only source of reputation and takes the
    // whole 4,000s. The bands say the opposite — career:income is a claim's
    // `priority` here, and it is simply not consulted.
    const result = resolveClaims(input({
      rates: RATES,
      claims: [
        work("crime", "career", PRIORITY["career:progress-lock"], { produces: { money: 1_000 } }),
        work("faction", "factions", PRIORITY["career:income"], { produces: { reputation: 40 } }),
      ],
    }));
    expect(holdsSlot(result, "factions")).toBe(true);
    expect(result.slotValues.map((bid) => [bid.by, bid.value?.valueSec]))
      .toEqual([["factions", 4_000], ["career", 25]]);
  });

  test("a bidder alone on a channel is the best rate for it, not a fraction of nothing", () => {
    const result = resolveClaims(input({
      rates: { best: new Map(), worth: new Map([["karma", 300]]) },
      claims: [work("crime", "career", 0, { produces: { karma: 0.25 } })],
    }));
    expect(result.slotValues[0]!.value).toMatchObject({ state: "priced", valueSec: 300 });
  });

  test("a bid that must occupy the slot before delivering is priced at the fraction that lands", () => {
    // Career ranks its own options and then bids the winner here. A write
    // discounted only inside that ranking would be re-inflated the moment its
    // bid met another feature's, so an eight-hour program would still outbid
    // faction reputation at the file's full worth.
    const result = resolveClaims(input({
      rates: { best: new Map(), worth: new Map([["file:SQLInject.exe", 2_400], ["reputation", 1_000]]) },
      claims: [
        work("write", "career", PRIORITY["career:income"], {
          produces: { "file:SQLInject.exe": 1 },
          deliveryFraction: 0.25,
        }),
        work("faction", "factions", PRIORITY["factions:work"], { produces: { reputation: 40 } }),
      ],
    }));
    expect(result.slotValues.find((bid) => bid.claimId === "write")!.value!.valueSec).toBe(600);
    expect(holdsSlot(result, "factions")).toBe(true);
  });

  test("a claim without a delivery fraction is priced exactly as before", () => {
    const bid = (extra: Partial<Claim>) => resolveClaims(input({
      rates: { best: new Map(), worth: new Map([["karma", 300]]) },
      claims: [work("crime", "career", 0, { produces: { karma: 0.25 }, ...extra })],
    })).slotValues[0]!.value;
    expect(bid({})).toEqual(bid({ deliveryFraction: 1 })!);
  });

  test("a lock outranks every priced bid, however valuable", () => {
    const result = resolveClaims(input({
      rates: RATES,
      claims: [
        work("crime", "career", PRIORITY["career:progress-lock"], { holdUntil: 9_999 }),
        work("faction", "factions", PRIORITY["factions:work"], { produces: { reputation: 40 } }),
      ],
    }));
    expect(holdsSlot(result, "career")).toBe(true);
    expect(result.slotValues.map((bid) => bid.pricing)).toEqual(["hard", "economic"]);
  });

  test("a priced incumbent yields only to a decisively better bid", () => {
    const contest = (challengerRep: number) => resolveClaims(input({
      rates: RATES,
      slot: { claimId: "faction", by: "factions", priority: PRIORITY["factions:work"], since: 0 },
      claims: [
        work("faction", "factions", PRIORITY["factions:work"], { produces: { reputation: 10 } }),
        work("crime", "career", PRIORITY["career:income"], { by: "career", produces: { reputation: challengerRep } }),
      ],
    }));
    // Within the hysteresis the incumbent keeps it: two estimates crossing back
    // and forth must not trade the slot every pass and finish neither.
    expect(holdsSlot(contest(10.4), "factions")).toBe(true);
    expect(holdsSlot(contest(12), "career")).toBe(true);
  });

  test("an incumbent that stops re-issuing has released the slot", () => {
    // This is the release protocol: no separate message, just silence.
    const result = resolveClaims(
      input({
        slot: { claimId: "faction", by: "factions", priority: 60, since: 0 },
        claims: [work("crime", "career", 30)],
      }),
    );
    expect(result.slot).toMatchObject({ claimId: "crime", by: "career", since: 1_000 });
    expect(result.preempted).toBeUndefined();
  });

  test("no time claims leaves the slot unassigned rather than reasserting the old holder", () => {
    const result = resolveClaims(input({ slot: { claimId: "faction", by: "factions", priority: 60, since: 0 }, claims: [] }));
    expect(result.slot).toBeUndefined();
  });

  test("re-issuing the same id across ticks preserves the hold, a new id does not", () => {
    const first = resolveClaims(input({ claims: [work("faction:CyberSec", "factions", 60)] }));
    const second = resolveClaims(
      input({ now: 2_000, slot: first.slot!, claims: [work("faction:CyberSec", "factions", 60)] }),
    );
    expect(second.slot!.since).toBe(1_000);
    const renamed = resolveClaims(
      input({ now: 2_000, slot: first.slot!, claims: [work("faction:NiteSec", "factions", 60)] }),
    );
    expect(renamed.slot!.since).toBe(2_000);
  });
});

describe("arbiter shape", () => {
  test("resolveClaims does not mutate its input", () => {
    const claims = [claim({ id: "a", resource: "money", amount: 10, priority: 5 })];
    const args = input({ pools: { money: 10, ram: 0 }, claims });
    resolveClaims(args);
    expect(args.pools).toEqual({ money: 10 });
    expect(args.claims).toEqual(claims);
  });

  test("negative pools are clamped rather than granting phantom resources", () => {
    const result = resolveClaims(
      input({ pools: { money: -500, ram: 0 }, claims: [claim({ id: "a", resource: "money", amount: 1, priority: 1 })] }),
    );
    expect(result.grants).toEqual([]);
    expect(result.remaining.money).toBe(0);
  });

  test("every named priority is distinct enough to order and resolvable", () => {
    expect(priorityOf("factions:aug-fund")).toBe(PRIORITY["factions:aug-fund"]);
    // Acquisition outranks spending: a decision on stale state is worse than
    // a decision deferred.
    expect(PRIORITY["probe:core"]).toBeGreaterThan(PRIORITY["hacknet:upgrade"]);
    // The aug fund outranks the upgrades that would otherwise always win by
    // being cheaper and always ready.
    expect(PRIORITY["factions:aug-fund"]).toBeGreaterThan(PRIORITY["hacknet:upgrade"]);
    expect(PRIORITY["factions:aug-fund"]).toBeGreaterThan(PRIORITY["income:investment"]);
  });

  test("the money lattice keeps its ordering around the augmentation fund", () => {
    // These are MONEY bands now — tuition and fares against the aug fund. The
    // work slot left the lattice entirely: it is priced in BN-seconds, so a
    // band could not express "a ten-thousandth of a need nobody is short of".
    expect(PRIORITY["career:blocking-need"]).toBeGreaterThan(PRIORITY["career:wanted-request"]);
    expect(PRIORITY["career:wanted-request"]).toBeGreaterThan(PRIORITY["career:nice-request"]);
    expect(PRIORITY["career:nice-request"]).toBeGreaterThan(PRIORITY["career:income"]);
    // Strictly below the post-sweep freeze, or career's funds come out of the
    // very bankroll the freeze exists to protect.
    expect(PRIORITY["career:blocking-need"]).toBeLessThan(PRIORITY["progression:install-freeze"]);
    // Progress protection is a transaction lock, independent of objective
    // value, and must beat every ordinary time bid until completion fires —
    // including a route package that merely wants the slot back.
    expect(PRIORITY["career:progress-lock"]).toBeGreaterThan(PRIORITY["factions:route-work"] + PREEMPT_MARGIN);
    // A route-MANDATORY install may still interrupt unbanked work: the run
    // cannot end without it.
    expect(PRIORITY["factions:install-work"]).toBeGreaterThan(PRIORITY["career:progress-lock"]);
  });
});

describe("reinvestment preference — the return tolerance band", () => {
  const band = (over: Partial<Claim> & Pick<Claim, "id">): Claim =>
    claim({ resource: "money", amount: 100, priority: PRIORITY["income:investment"], ...over });

  test("a clearly faster payback wins regardless of absolute rate", () => {
    // The canonical example: a 5-minute payback at $5/s beats a 60-minute
    // payback at $6/s — the early money reinvests. returnPerDollarSec is
    // 1/paybackSec, so 12x apart is far outside the tolerance band.
    const result = resolveClaims(input({
      pools: { money: 100, ram: 0 },
      claims: [
        band({ id: "slow-big", ratePerSec: 6, returnPerDollarSec: 1 / 3600 }),
        band({ id: "fast-small", ratePerSec: 5, returnPerDollarSec: 1 / 300 }),
      ],
    }));
    expect(result.grants[0]!.claimId).toBe("fast-small");
  });

  test("within the band, the bigger absolute earner wins", () => {
    // Near-equal growth rates: prefer the larger stream. This tiebreak was
    // unreachable before the band — float-exact returnPerDollarSec equality
    // never happens.
    const result = resolveClaims(input({
      pools: { money: 100, ram: 0 },
      claims: [
        band({ id: "small", ratePerSec: 5, returnPerDollarSec: 1 / 300 }),
        band({ id: "big", ratePerSec: 50, returnPerDollarSec: 1 / 330 }),
      ],
    }));
    expect(result.grants[0]!.claimId).toBe("big");
  });

  test("return tiers are transitive and independent of input permutation", () => {
    const claims = [
      band({ id: "A", ratePerSec: 1, returnPerDollarSec: 1 }),
      band({ id: "B", ratePerSec: 2, returnPerDollarSec: 0.86 }),
      band({ id: "C", ratePerSec: 3, returnPerDollarSec: 0.74 }),
    ];
    const permutations = [
      [0, 1, 2], [0, 2, 1], [1, 0, 2],
      [1, 2, 0], [2, 0, 1], [2, 1, 0],
    ];
    const winners = permutations.map((order) =>
      resolveClaims(input({
        pools: { money: 100, ram: 0 },
        claims: order.map((index) => claims[index]!),
      })).grants[0]!.claimId
    );
    expect(winners).toEqual(["B", "B", "B", "B", "B", "B"]);
  });
});

describe("the imminent-install band sits where the endgame needs it", () => {
  test("brakes investments but not a prerequisite needed before the install", () => {
    expect(PRIORITY["progression:imminent-install"]).toBeGreaterThan(PRIORITY["income:investment"]);
    expect(PRIORITY["hacking:blocking-prerequisite"]).toBeGreaterThan(PRIORITY["progression:imminent-install"]);
    expect(PRIORITY["progression:imminent-install"]).toBeLessThan(PRIORITY["factions:donate"]);
    expect(PRIORITY["progression:imminent-install"]).toBeLessThan(PRIORITY["factions:aug-fund"]);
    expect(PRIORITY["progression:imminent-install"]).toBeLessThan(PRIORITY["career:blocking-need"]);

    const result = resolveClaims(input({
      pools: { money: 100, ram: 0 },
      claims: [
        claim({
          id: "ordinary-investment",
          by: "hacknet",
          resource: "money",
          amount: 10,
          priority: PRIORITY["income:investment"],
        }),
        claim({
          id: "imminent-install",
          by: "progression",
          resource: "money",
          amount: 100,
          priority: PRIORITY["progression:imminent-install"],
          mode: "reserve",
          shape: "continuous",
        }),
        claim({
          id: "port-opener",
          by: "hacking",
          resource: "money",
          amount: 40,
          priority: PRIORITY["hacking:blocking-prerequisite"],
        }),
      ],
    }));
    expect(grantedAmount(result, "hacking", "money")).toBe(40);
    expect(grantedAmount(result, "progression", "money")).toBe(60);
    expect(grantedAmount(result, "hacknet", "money")).toBe(0);
  });
});

describe("cross-feature investments", () => {
  test("cash-goal crossover caps ideal marginal RAM by whole-fleet throughput", () => {
    const [capped] = capInfrastructureByObservedFleet([{
      kind: "buyServer",
      cost: 440_000,
      addedRam: 8,
      incomePerSec: 6_300,
    }], 5_400);
    expect(capped?.incomePerSec).toBe(5_400);
  });

  test("observed throughput preserves a modelled core gain", () => {
    const [capped] = capInfrastructureByObservedFleet([
      { kind: "homeCore", cost: 500_000, addedRam: 0, incomePerSec: 250 },
    ], 5_400);
    expect(capped?.incomePerSec).toBe(250);
  });

  test("a wanted paid prerequisite waits behind a blocking cash milestone", () => {
    const cash = {
      by: "factions" as const,
      kind: "money" as const,
      target: 15_000_000,
      have: 4_000_000,
      weight: 1,
      urgency: "blocking" as const,
    };
    expect(deferPrerequisitePurchase("wanted", [cash])).toBe(true);
    expect(deferPrerequisitePurchase("nice", [cash])).toBe(true);
    expect(deferPrerequisitePurchase("blocking", [cash])).toBe(false);
    expect(deferPrerequisitePurchase("wanted", [{ ...cash, urgency: "wanted" }])).toBe(false);
  });

  test("infrastructure must shorten a blocking money threshold and preserve it at the crossing", () => {
    const sector12 = {
      by: "factions" as const,
      kind: "money" as const,
      target: 15_000_000,
      have: 15_000_000,
      weight: 1,
      urgency: "blocking" as const,
    };
    const fast = { kind: "buyServer" as const, cost: 1_000_000, addedRam: 8, incomePerSec: 2_000 };
    const slow = { kind: "homeRam" as const, cost: 1_000_000, addedRam: 8, incomePerSec: 1 };
    expect(infrastructureBeforeMoneyNeeds([fast, slow], 5_000_000, 1_000, [sector12])).toEqual([fast]);
    expect(infrastructureBeforeMoneyNeeds([fast], 15_000_000, 1_000, [sector12])).toEqual([]);
    expect(infrastructureBeforeMoneyNeeds([fast], 20_000_000, 1_000, [{ ...sector12, urgency: "wanted" }])).toEqual([fast]);
    expect(infrastructureBeforeMoneyNeeds([fast], 20_000_000, 1_000, [])).toEqual([fast]);
  });

  test("cash crossover preserves the modelled quote used for ROI ranking", () => {
    const modelled = { kind: "buyServer" as const, cost: 440_000, addedRam: 8, incomePerSec: 3_840 };
    const need = {
      by: "factions" as const,
      kind: "money" as const,
      target: 15_000_000,
      have: 5_000_000,
      weight: 1,
      urgency: "blocking" as const,
    };
    const [eligible] = infrastructureBeforeMoneyNeeds([modelled], 5_000_000, 100, [need], true);
    expect(eligible).toEqual(modelled);
  });

  test("home RAM is rejected when its payoff is beyond the run horizon", () => {
    const short = scoreHomeRam({ currentRam: 64, upgradeCost: 1_000_000, incomePerSecPerGb: 1, horizonSec: 1_000 });
    expect(short.worthBuying).toBe(false);
    const long = scoreHomeRam({ currentRam: 64, upgradeCost: 1_000_000, incomePerSecPerGb: 1_000, horizonSec: 1_000 });
    expect(long.worthBuying).toBe(true);
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

  test("equal-return cloud RAM is concentrated into the larger host", () => {
    const decision = stepInfrastructure([
      { kind: "buyServer", cost: 440_000, addedRam: 8, targetRam: 8, incomePerSec: 80 },
      { kind: "upgradeServer", host: "pserv", cost: 440_000, addedRam: 8, targetRam: 16, incomePerSec: 80 },
    ], 10_000);
    expect(decision.buy).toMatchObject({ kind: "upgradeServer", host: "pserv", targetRam: 16 });
  });

  test("an unaffordable large upgrade cannot hide a profitable affordable step", () => {
    const decision = stepInfrastructure([
      { kind: "upgradeServer", host: "large", cost: 3_520_000, addedRam: 64, targetRam: 128, incomePerSec: 1_280 },
      { kind: "upgradeServer", host: "small", cost: 440_000, addedRam: 8, targetRam: 16, incomePerSec: 80 },
    ], 10_000, 500_000);
    expect(decision.buy).toMatchObject({ host: "small", cost: 440_000 });
    expect(decision.ranked).toHaveLength(1);
    // The executable purchase and the value of money are separate facts: an
    // unaffordable high-return quote still tells preparation what early cash
    // could buy as soon as enough of it has accumulated.
    expect(decision.reinvestmentReturnPerDollarSec).toBeCloseTo(1_280 / 3_520_000, 12);
  });

  test("a confirmed upgrade invalidates only that host's quote", () => {
    const buy = { kind: "buyServer" as const, cost: 440_000, addedRam: 8, targetRam: 8 };
    const a = { kind: "upgradeServer" as const, host: "a", cost: 440_000, addedRam: 8, targetRam: 16 };
    const b = { kind: "upgradeServer" as const, host: "b", cost: 440_000, addedRam: 8, targetRam: 16 };
    const advanced = advanceInfrastructureFrontier([buy, a, b], { count: 2, totalRam: 16, limit: 3 }, a);
    expect(advanced.options).toEqual([buy, b]);
    expect(advanced.purchased).toMatchObject({ count: 2, totalRam: 24 });
  });

  test("a confirmed buy waits for observation before buying another new host", () => {
    const buy = { kind: "buyServer" as const, cost: 440_000, addedRam: 8, targetRam: 8 };
    const upgrade = { kind: "upgradeServer" as const, host: "a", cost: 440_000, addedRam: 8, targetRam: 16 };
    const room = advanceInfrastructureFrontier([buy, upgrade], { count: 1, totalRam: 8, limit: 3 }, buy);
    expect(room.options).toEqual([upgrade]);
    expect(room.purchased).toMatchObject({ count: 2, totalRam: 16 });
  });
});
