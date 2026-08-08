import { describe, expect, test } from "bun:test";
import {
  netOverHorizon,
  paybackSec,
  stepHacknet,
  type HacknetView,
  type UpgradeOption,
} from "../shared/strategy/hacknet/decide.ts";

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

  test("with a long horizon the big upgrade wins", () => {
    // 8 hours: slow nets 50*28800-100000 = 1.34m; fast nets 27800.
    const decision = stepHacknet(view({ upgrades: [slow, fast], horizonSec: 28_800 }));
    expect(decision.buy?.kind).toBe("core");
  });

  test("with a short horizon the SAME upgrade is refused", () => {
    // 30 minutes: slow nets 50*1800-100000 = -10000; fast nets 800.
    const decision = stepHacknet(view({ upgrades: [slow, fast], horizonSec: 1_800 }));
    expect(decision.buy?.kind).toBe("level");
  });

  test("with no horizon left it holds and says why", () => {
    const decision = stepHacknet(view({ upgrades: [slow, fast], horizonSec: 60 }));
    expect(decision.buy).toBeUndefined();
    expect(decision.hold).toContain("pays back in");
    expect(decision.why).toContain("loses money before the horizon");
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
    expect(decision.hold).toContain("granted $100");
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

  test("the greedy first pick is the highest-value item the optimum would also take", () => {
    const options: UpgradeOption[] = [
      upgrade({ kind: "level", node: 0, cost: 1_000, deltaProduction: 1 }),
      upgrade({ kind: "ram", node: 0, cost: 30_000, deltaProduction: 20 }),
      upgrade({ kind: "core", node: 0, cost: 500_000, deltaProduction: 200 }),
      upgrade({ kind: "level", node: 1, cost: 2_000, deltaProduction: 1.5 }),
    ];
    const horizonSec = 28_800;
    const decision = stepHacknet(view({ upgrades: options, horizonSec, moneyGranted: 1e9 }));

    // With an unbounded budget the optimum takes every positive-value item, so
    // the greedy's first pick must be the single highest-value one.
    const byValue = [...options].sort(
      (a, b) => netOverHorizon(b, horizonSec) - netOverHorizon(a, horizonSec),
    );
    expect(decision.buy!.kind).toBe(byValue[0]!.kind);
    expect(decision.buy!.node).toBe(byValue[0]!.node!);
  });

  test("greedy reaches the DP optimum when purchases are made one per tick", () => {
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

  test("beats the common 'level to 80 then RAM' heuristic when RAM is better value", () => {
    // The baseline from the plan. A RAM upgrade that adds 20/s for $30k
    // dominates a level upgrade adding 1/s for $1k on any long horizon, and a
    // fixed level-first script would take 80 levels before touching it.
    const level = upgrade({ kind: "level", node: 0, cost: 1_000, deltaProduction: 1 });
    const ram = upgrade({ kind: "ram", node: 0, cost: 30_000, deltaProduction: 20 });
    const decision = stepHacknet(view({ upgrades: [level, ram], horizonSec: 28_800 }));
    expect(decision.buy?.kind).toBe("ram");
    expect(netOverHorizon(ram, 28_800)).toBeGreaterThan(netOverHorizon(level, 28_800));
  });
});
