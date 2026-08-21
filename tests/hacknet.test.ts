import { describe, expect, test } from "bun:test";
import {
  netOverHorizon,
  paybackSec,
  stepHacknet,
  type HacknetView,
  type UpgradeOption,
} from "../shared/strategy/hacknet/decide.ts";
import { HASH_UPGRADE, stepHashes } from "../shared/strategy/hacknet/hashes.ts";

function view(over: Partial<HacknetView> = {}): HacknetView {
  return {
    nodes: [],
    nodeCost: Infinity,
    maxNodes: 0,
    newNodeProduction: 0,
    upgrades: [],
    moneyGranted: 1e12,
    horizonSec: 3_600,
    hashMode: false,
    ...over,
  };
}

const upgrade = (over: Partial<UpgradeOption> = {}): UpgradeOption => ({
  kind: "level",
  node: 0,
  cost: 1_000,
  deltaProduction: 1,
  ...over,
});

describe("payback and horizon", () => {
  test("payback is cost over the production it adds", () => {
    expect(paybackSec(upgrade({ cost: 500, deltaProduction: 2 }))).toBe(250);
  });

  test("an upgrade that produces nothing NEVER pays back — not 'cheap'", () => {
    // Returning 0 here would make a useless upgrade look like the best buy.
    expect(paybackSec(upgrade({ deltaProduction: 0 }))).toBe(Infinity);
    expect(paybackSec(upgrade({ deltaProduction: -1 }))).toBe(Infinity);
  });

  test("net over horizon is what the objective actually is", () => {
    // $1/s for an hour = $3600, minus $1000 = $2600.
    expect(netOverHorizon(upgrade(), 3_600)).toBe(2_600);
    // The same upgrade with ten minutes left LOSES money.
    expect(netOverHorizon(upgrade(), 600)).toBe(-400);
  });
});

describe("the horizon is a decision input, not a tuning constant", () => {
  const slow = upgrade({ kind: "core", cost: 100_000, deltaProduction: 50 }); // 2000s payback
  const fast = upgrade({ kind: "level", cost: 1_000, deltaProduction: 1 }); // 1000s payback

  test("with a long horizon the fastest ROI wins", () => {
    // Both repay in time; level pays back in 1000s versus core's 2000s.
    const decision = stepHacknet(view({ upgrades: [slow, fast], horizonSec: 28_800 }));
    expect(decision.buy?.kind).toBe("level");
  });

  test("with a short horizon the SAME upgrade is refused", () => {
    // 30 minutes: slow nets 50*1800-100000 = -10000; fast nets 800.
    const decision = stepHacknet(view({ upgrades: [slow, fast], horizonSec: 1_800 }));
    expect(decision.buy?.kind).toBe("level");
  });

  test("with no horizon left it holds", () => {
    // Every upgrade loses money before the horizon: nothing is bought, but the
    // ranking still reports the candidates and their negative net.
    const decision = stepHacknet(view({ upgrades: [slow, fast], horizonSec: 60 }));
    expect(decision.buy).toBeUndefined();
    expect(decision.ranked.length).toBeGreaterThan(0);
    expect(decision.ranked[0]!.netOverHorizon).toBeLessThanOrEqual(0);
  });
});

describe("purchase selection", () => {
  test("a new node competes with upgrades on the same terms", () => {
    const decision = stepHacknet(
      view({
        nodes: [],
        maxNodes: 10,
        nodeCost: 1_000,
        newNodeProduction: 5,
        upgrades: [upgrade({ cost: 1_000, deltaProduction: 1 })],
      }),
    );
    expect(decision.buy?.kind).toBe("node");
  });

  test("the node limit is respected", () => {
    const decision = stepHacknet(
      view({ nodes: [{ index: 0, level: 1, ram: 1, cores: 1, production: 1 }], maxNodes: 1, nodeCost: 1, newNodeProduction: 1e9 }),
    );
    expect(decision.buy).toBeUndefined();
  });

  test("it will not spend money it was not granted", () => {
    // The arbiter's grant is a hard ceiling — hacknet must never outbid the
    // augmentation fund by simply ignoring it.
    const decision = stepHacknet(view({ upgrades: [upgrade({ cost: 1e9, deltaProduction: 1e6 })], moneyGranted: 100 }));
    expect(decision.buy).toBeUndefined();
    // The upgrade is profitable (so the economics guard passed) — only the
    // grant ceiling can be what held the purchase.
    expect(decision.ranked[0]!.netOverHorizon).toBeGreaterThan(0);
    expect(decision.ranked[0]!.cost).toBeGreaterThan(100);
  });

  test("an unaffordable leader falls through to the best affordable rung", () => {
    // Idling a grant that already covers a profitable upgrade earns nothing,
    // and taking it does not cost us the leader: the income reaches the same
    // fund. So the leader is noted and the affordable rung is bought.
    const leader = upgrade({ kind: "ram", node: 0, cost: 1e9, deltaProduction: 1e6 });
    const affordable = upgrade({ kind: "level", node: 1, cost: 1_000, deltaProduction: 1 });
    const decision = stepHacknet(view({ upgrades: [leader, affordable], moneyGranted: 5_000 }));
    expect(decision.ranked[0]!.kind).toBe("ram");
    expect(decision.buy?.kind).toBe("level");
  });

  test("but a MILESTONE leader is saved for, not skipped", () => {
    // A goal is not an optimization: spending the grant elsewhere delays it.
    const leader = upgrade({ kind: "core", node: 0, cost: 1e9, deltaProduction: 0, progress: { hacknetCores: 1 } });
    const affordable = upgrade({ kind: "level", node: 1, cost: 1_000, deltaProduction: 1 });
    const decision = stepHacknet(view({
      upgrades: [leader, affordable],
      milestones: [{ kind: "hacknetCores", target: 4, have: 3, priority: 75, urgency: "blocking" }],
      moneyGranted: 5_000,
    }));
    expect(decision.ranked[0]!.kind).toBe("core");
    expect(decision.buy).toBeUndefined();
  });

  test("the fall-through still refuses anything that loses money", () => {
    const leader = upgrade({ kind: "ram", node: 0, cost: 1e9, deltaProduction: 1e6 });
    const losing = upgrade({ kind: "level", node: 1, cost: 1_000, deltaProduction: 0.01 });
    const decision = stepHacknet(view({ upgrades: [leader, losing], horizonSec: 3_600, moneyGranted: 5_000 }));
    expect(netOverHorizon(losing, 3_600)).toBeLessThan(0);
    expect(decision.buy).toBeUndefined();
  });

  test("ranking is deterministic under ties", () => {
    const a = upgrade({ kind: "level", node: 0 });
    const b = upgrade({ kind: "ram", node: 1 });
    const forward = stepHacknet(view({ upgrades: [a, b] }));
    const backward = stepHacknet(view({ upgrades: [b, a] }));
    expect(forward.buy?.kind).toBe(backward.buy!.kind);
  });
});

describe("dynamic-programming oracle", () => {
  /** True optimal spend over a bounded state space.
   *
   * The strongest oracle available for this feature: with a fixed budget, a
   * fixed horizon and a discrete upgrade menu, the optimal PURCHASE SEQUENCE
   * is computable exactly by DP over (remaining budget, upgrades taken). The
   * greedy strategy is then measured against a true optimum rather than
   * against another heuristic. */
  function optimal(options: UpgradeOption[], budget: number, horizonSec: number): number {
    // Each option may be taken at most once; maximise Σ net over horizon
    // subject to Σ cost <= budget. That is 0/1 knapsack — exact by DP over an
    // integer-scaled budget.
    const scale = 100;
    const cap = Math.floor(budget / scale);
    const best = new Float64Array(cap + 1);
    for (const option of options) {
      const cost = Math.floor(option.cost / scale);
      const value = option.deltaProduction * horizonSec - option.cost;
      if (value <= 0 || cost > cap) continue;
      for (let b = cap; b >= cost; b--) {
        const candidate = best[b - cost]! + value;
        if (candidate > best[b]!) best[b] = candidate;
      }
    }
    return best[cap]!;
  }

  test("the first pick is the viable item with the fastest payback", () => {
    const options: UpgradeOption[] = [
      upgrade({ kind: "level", node: 0, cost: 1_000, deltaProduction: 1 }),
      upgrade({ kind: "ram", node: 0, cost: 30_000, deltaProduction: 20 }),
      upgrade({ kind: "core", node: 0, cost: 500_000, deltaProduction: 200 }),
      upgrade({ kind: "level", node: 1, cost: 2_000, deltaProduction: 1.5 }),
    ];
    const horizonSec = 28_800;
    const decision = stepHacknet(view({ upgrades: options, horizonSec, moneyGranted: 1e9 }));

    const byPayback = [...options]
      .filter((option) => netOverHorizon(option, horizonSec) > 0)
      .sort((a, b) => paybackSec(a) - paybackSec(b));
    expect(decision.buy!.kind).toBe(byPayback[0]!.kind);
    expect(decision.buy!.node).toBe(byPayback[0]!.node!);
  });

  test("under a BINDING budget the greedy is honestly suboptimal, and bounded", () => {
    // The case the arbiter actually creates, and the one the unbounded test
    // below cannot see: when the budget cannot buy everything, ordering by
    // payback is a heuristic, not an optimum. Pin how far off it is so a
    // regression that makes it worse is visible.
    const options: UpgradeOption[] = [
      // Fastest payback (100s), but it crowds out the two below.
      upgrade({ kind: "ram", node: 0, cost: 6_000, deltaProduction: 60 }),
      upgrade({ kind: "level", node: 1, cost: 5_000, deltaProduction: 40 }),
      upgrade({ kind: "level", node: 2, cost: 5_000, deltaProduction: 40 }),
    ];
    const horizonSec = 10_000;
    const budget = 10_000;

    let remaining = [...options];
    let spent = 0;
    let greedyValue = 0;
    for (let step = 0; step < options.length; step++) {
      const decision = stepHacknet(view({ upgrades: remaining, horizonSec, moneyGranted: budget - spent }));
      if (!decision.buy) break;
      spent += decision.buy.cost;
      greedyValue += netOverHorizon(decision.buy, horizonSec);
      remaining = remaining.filter((option) => !(option.kind === decision.buy!.kind && option.node === decision.buy!.node));
    }

    const best = optimal(options, budget, horizonSec);
    // Greedy takes the 60/s rung and can no longer afford either 40/s rung;
    // the optimum takes both 40/s rungs instead.
    expect(spent).toBeLessThanOrEqual(budget);
    expect(greedyValue).toBeLessThan(best);
    expect(greedyValue / best).toBeGreaterThan(0.65);
  });

  test("greedy reaches the DP optimum when the budget does NOT bind", () => {
    // The driver buys ONE upgrade per tick and re-plans, so the sequence it
    // produces is greedy-by-value repeated. With no budget constraint that
    // sequence takes every positive item — which IS the knapsack optimum.
    const options: UpgradeOption[] = Array.from({ length: 8 }, (_, i) =>
      upgrade({ kind: "level", node: i, cost: 1_000 * (i + 1), deltaProduction: (i % 3) + 0.5 }),
    );
    const horizonSec = 10_000;
    const budget = 1e9;

    let taken: UpgradeOption[] = [];
    let remaining = [...options];
    for (let step = 0; step < options.length; step++) {
      const decision = stepHacknet(view({ upgrades: remaining, horizonSec, moneyGranted: budget }));
      if (!decision.buy) break;
      taken.push(decision.buy);
      remaining = remaining.filter((option) => !(option.kind === decision.buy!.kind && option.node === decision.buy!.node));
    }
    const greedyValue = taken.reduce((sum, option) => sum + netOverHorizon(option, horizonSec), 0);
    expect(greedyValue).toBeCloseTo(optimal(options, budget, horizonSec), 4);
  });

  test("chooses RAM as soon as RAM has the faster ROI", () => {
    const level = upgrade({ kind: "level", node: 0, cost: 1_000, deltaProduction: 1 });
    const ram = upgrade({ kind: "ram", node: 0, cost: 30_000, deltaProduction: 40 });
    const decision = stepHacknet(view({ upgrades: [level, ram], horizonSec: 28_800 }));
    expect(decision.buy?.kind).toBe("ram");
    expect(paybackSec(ram)).toBeLessThan(paybackSec(level));
  });

  test("a blocking faction milestone can justify a non-economic upgrade", () => {
    const decision = stepHacknet(view({
      upgrades: [upgrade({ kind: "core", cost: 5_000, deltaProduction: 0, progress: { hacknetCores: 1 } })],
      milestones: [{ kind: "hacknetCores", target: 4, have: 3, priority: 75 }],
      horizonSec: 1,
    }));
    expect(decision.buy?.kind).toBe("core");
    expect(decision.buy?.milestone?.kind).toBe("hacknetCores");
  });

  test("cache is bought only when it advances a selected capacity milestone", () => {
    const cache = upgrade({ kind: "cache", cost: 1_000, deltaProduction: 0, progress: { hashCapacity: 64 } });
    expect(stepHacknet(view({ upgrades: [cache], hashMode: true })).buy).toBeUndefined();
    const wanted = stepHacknet(view({
      upgrades: [cache],
      hashMode: true,
      milestones: [{ kind: "hashCapacity", target: 100, have: 64, priority: 45 }],
    }));
    expect(wanted.buy?.kind).toBe("cache");
  });

  test("a nice-to-have milestone orders purchases but never justifies a loss", () => {
    // Same upgrade, same milestone, only the urgency differs. A blocking need
    // overrides the economics; a merely nice one falls back to ROI and holds.
    const losing = upgrade({ kind: "core", cost: 5_000, deltaProduction: 0, progress: { hacknetCores: 1 } });
    const blocking = stepHacknet(view({
      upgrades: [losing],
      milestones: [{ kind: "hacknetCores", target: 4, have: 3, priority: 75, urgency: "blocking" }],
      horizonSec: 1,
    }));
    expect(blocking.buy?.kind).toBe("core");

    const nice = stepHacknet(view({
      upgrades: [losing],
      milestones: [{ kind: "hacknetCores", target: 4, have: 3, priority: 35, urgency: "nice" }],
      horizonSec: 1,
    }));
    expect(nice.buy).toBeUndefined();
    expect(nice.ranked[0]!.milestone).toBeUndefined();
  });

  test("a nice-to-have milestone still outranks a better-paying upgrade that pays", () => {
    const fast = upgrade({ kind: "level", node: 1, cost: 100, deltaProduction: 1 });
    const wanted = upgrade({ kind: "core", node: 0, cost: 1_000, deltaProduction: 1, progress: { hacknetCores: 1 } });
    const decision = stepHacknet(view({
      upgrades: [fast, wanted],
      milestones: [{ kind: "hacknetCores", target: 4, have: 3, priority: 35, urgency: "nice" }],
      horizonSec: 28_800,
    }));
    expect(decision.buy?.kind).toBe("core");
  });

  test("the first server can establish capacity for a hash goal", () => {
    const decision = stepHacknet(view({
      nodes: [],
      upgrades: [],
      nodeCost: 1_000_000,
      maxNodes: 20,
      newNodeProduction: 0,
      newNodeHashCapacity: 64,
      horizonSec: 1,
      hashMode: true,
      milestones: [{ kind: "hashCapacity", target: 50, have: 0, priority: 45 }],
    }));
    expect(decision.buy?.kind).toBe("node");
    expect(decision.buy?.milestone?.kind).toBe("hashCapacity");
  });
});

describe("goal-aware hash spending", () => {
  const quotes = [
    { name: HASH_UPGRADE.money, level: 0, cost: 4 },
    { name: HASH_UPGRADE.maxMoney, level: 0, cost: 50 },
    { name: HASH_UPGRADE.bladeRank, level: 0, cost: 250 },
  ];

  test("an economic target mutation must beat selling the same hashes", () => {
    const weak = stepHashes({
      current: 100,
      capacity: 1_000,
      productionPerSec: 1,
      upgrades: quotes,
      goals: [{ name: HASH_UPGRADE.maxMoney, target: "omega-net", priority: 30, valueDollars: 1_000 }],
    });
    expect(weak.spend?.name).toBe(HASH_UPGRADE.money);
    expect(weak.ranked[0]).toMatchObject({ name: HASH_UPGRADE.maxMoney, eligible: false, netDollars: -12_499_000 });

    const strong = stepHashes({
      current: 100,
      capacity: 1_000,
      productionPerSec: 1,
      upgrades: quotes,
      goals: [{ name: HASH_UPGRADE.maxMoney, target: "omega-net", priority: 30, valueDollars: 20_000_000 }],
    });
    expect(strong.spend?.name).toBe(HASH_UPGRADE.maxMoney);
  });

  test("reserves for an active goal instead of cashing out", () => {
    const decision = stepHashes({
      current: 100,
      capacity: 1_000,
      productionPerSec: 1,
      upgrades: quotes,
      goals: [{ name: HASH_UPGRADE.bladeRank, priority: 90 }],
    });
    expect(decision.spend).toBeUndefined();
    expect(decision.reserve?.name).toBe(HASH_UPGRADE.bladeRank);
  });

  test("requests cache capacity when a goal can never fit", () => {
    const decision = stepHashes({
      current: 64,
      capacity: 64,
      productionPerSec: 1,
      upgrades: quotes,
      goals: [{ name: HASH_UPGRADE.bladeRank, priority: 90 }],
    });
    expect(decision.capacityTarget).toBe(250);
  });

  test("observed availability is authoritative", () => {
    const decision = stepHashes({
      current: 100,
      capacity: 100,
      productionPerSec: 1,
      upgrades: [{ name: HASH_UPGRADE.money, level: 0, cost: 4 }],
      goals: [{ name: HASH_UPGRADE.bladeRank, priority: 99 }],
    });
    expect(decision.spend?.name).toBe(HASH_UPGRADE.money);
  });
});
