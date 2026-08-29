import { describe, expect, test } from "bun:test";
import {
  budgetGrid,
  chooseBudget,
  evaluateSelection,
  solvePortfolio,
  MIN_BUDGET_SEC,
} from "../shared/strategy/factions/portfolio.ts";
import { buildFrontiers } from "../shared/strategy/factions/packages.ts";
import { selectFactionPlan } from "../shared/strategy/factions/portfolio.ts";
import { pacedSec, spotSecFromPaced, curveExponent } from "../shared/strategy/factions/pace.ts";
import { weightsFromMarginals, type AugInfo, type PriceContext } from "../shared/strategy/factions/augs.ts";
import type { FactionStanding, FactionsView } from "../shared/strategy/factions/state.ts";
import { INSTALL_OVERHEAD_SEC } from "../shared/strategy/progression/eta.ts";
import type { ChannelWorth } from "../shared/strategy/income.ts";
import { mulberry32 } from "../sim/core/rng.ts";

/** The set solver is a heuristic with a declared shape — greedy seed, local
 * search, relaxation bound. What has to be pinned is not its internals but the
 * three public guarantees: it matches the exhaustive optimum where exhaustive
 * is affordable, never scores below the best single package, and ensures that
 * a shared augmentation is paid for once. */

const WORTH: ChannelWorth = new Map<string, number>([
  ["money", 1_000],
  ["hacking", 5_000],
  ["combat", 1_000],
  ["reputation", 500],
  ["augmentations", 900],
]) as ChannelWorth;

function priceCtx(over: Partial<PriceContext> = {}): PriceContext {
  return {
    queuedNonSoA: 0,
    ownedSoA: 0,
    neurofluxLevel: 0,
    sf11Level: 0,
    augMoneyCost: 1,
    augRepCost: 1,
    ...over,
  };
}

function aug(name: string, over: Partial<AugInfo> = {}): AugInfo {
  return {
    name,
    baseCost: 1_000_000,
    baseRepRequirement: 1_000,
    factions: [],
    prereqs: [],
    mults: {},
    ...over,
  };
}

function standing(name: string, over: Partial<FactionStanding> = {}): FactionStanding {
  return {
    name,
    joined: true,
    invited: false,
    rep: 0,
    favor: 0,
    requirements: [],
    enemies: [],
    offers: { hacking: true, field: true, security: true },
    special: false,
    ...over,
  };
}

function view(over: Partial<FactionsView> = {}): FactionsView {
  return {
    time: 0,
    person: {
      skills: { hacking: 500, strength: 500, defense: 500, dexterity: 500, agility: 500, charisma: 500, intelligence: 0 },
      mults: { faction_rep: 1 },
    } as FactionsView["person"],
    requirementView: { augCount: 0 } as FactionsView["requirementView"],
    repContext: { factionWorkRepGain: 1, shareBonus: 1, sf15Level: 0, hasFocusAug: false },
    priceContext: priceCtx(),
    factions: [],
    catalog: new Map(),
    owned: new Set(),
    queued: new Set(),
    weights: weightsFromMarginals(WORTH),
    horizonSec: 100_000,
    rates: { best: new Map(), worth: WORTH },
    targetAugCount: Infinity,
    favorToDonate: 150,
    moneyGranted: 0,
    moneyAvailable: 1e15,
    pendingProceeds: 0,
    proceedsSettling: false,
    holdsWorkSlot: true,
    incomePerSec: 1e6,
    sf4Level: 3,
    bitNode: 4,
    ...over,
  };
}

function noBlockers(names: readonly string[]) {
  return new Map(names.map((name) => [name, []]));
}

/** Every selection of at most one breakpoint per faction. */
function everySelection(
  factions: readonly string[],
  frontiers: ReadonlyMap<string, readonly { repTarget: number }[]>,
): { faction: string; index: number }[][] {
  let out: { faction: string; index: number }[][] = [[]];
  for (const faction of factions) {
    const options = frontiers.get(faction) ?? [];
    const next: { faction: string; index: number }[][] = [];
    for (const partial of out) {
      next.push(partial);
      for (let index = 0; index < options.length; index++) {
        next.push([...partial, { faction, index }]);
      }
    }
    out = next;
  }
  return out;
}

describe("the set solver against exhaustive enumeration", () => {
  test("matches the best reachable set on small random instances", () => {
    const rng = mulberry32(11);
    for (let trial = 0; trial < 12; trial++) {
      const names = ["A", "B", "C", "D"];
      const catalog = new Map<string, AugInfo>();
      for (const name of names) {
        // Two or three augmentations each, some shared with the next faction so
        // the union term actually bites.
        const count = 2 + Math.floor(rng() * 2);
        for (let i = 0; i < count; i++) {
          const shared = rng() < 0.35;
          const augName = shared ? `shared-${name}` : `${name}-${i}`;
          const sellers = shared ? [name, names[(names.indexOf(name) + 1) % names.length]!] : [name];
          catalog.set(augName, aug(augName, {
            factions: sellers,
            baseCost: Math.round(rng() * 5e7) + 1e6,
            baseRepRequirement: Math.round(rng() * 4_000) + 100,
            mults: { hacking: 1 + rng() * 0.4 },
          }));
        }
      }
      const factions = names.map((name) => standing(name));
      const world = view({ factions, catalog });
      const { frontiers } = buildFrontiers(world, noBlockers(names));
      // Keep the enumeration affordable: this is a proof of the search, and a
      // frontier of eight breakpoints across four factions is already 6561 sets.
      const capped = new Map(
        [...frontiers].map(([name, list]) => [name, list.slice(0, 3)] as const),
      );
      if (capped.size === 0) continue;

      const budgetSec = 20_000;
      let bestValue = 0;
      for (const selection of everySelection(names, capped)) {
        const solution = evaluateSelection(selection, capped, world);
        if (!solution || solution.etaSec > budgetSec) continue;
        bestValue = Math.max(bestValue, solution.value);
      }
      const ours = solvePortfolio(capped, world, budgetSec);
      expect(ours.etaSec).toBeLessThanOrEqual(budgetSec);
      expect(ours.value).toBeCloseTo(bestValue, 6);
    }
  });

  test("never scores below the best SINGLE package", () => {
    // Every single package is a feasible one-element set, so the set solver
    // must score at least as well as the best of them.
    const names = ["A", "B", "C"];
    const catalog = new Map<string, AugInfo>([
      ["a1", aug("a1", { factions: ["A"], baseRepRequirement: 200, mults: { hacking: 1.2 } })],
      ["a2", aug("a2", { factions: ["A"], baseRepRequirement: 3_000, mults: { hacking: 1.5 } })],
      ["b1", aug("b1", { factions: ["B"], baseRepRequirement: 400, mults: { hacking_money: 1.4 } })],
      ["c1", aug("c1", { factions: ["C"], baseRepRequirement: 900, mults: { strength: 1.3 } })],
    ]);
    const world = view({ factions: names.map((name) => standing(name)), catalog });
    const { frontiers } = buildFrontiers(world, noBlockers(names));
    const budgetSec = 50_000;

    let bestSingle = 0;
    for (const [faction, frontier] of frontiers) {
      for (let index = 0; index < frontier.length; index++) {
        const single = evaluateSelection([{ faction, index }], frontiers, world);
        if (single && single.etaSec <= budgetSec) bestSingle = Math.max(bestSingle, single.value);
      }
    }
    expect(solvePortfolio(frontiers, world, budgetSec).value).toBeGreaterThanOrEqual(bestSingle - 1e-9);
  });
});

describe("a shared augmentation is acquired once", () => {
  test("two factions selling the same augmentation do not both bank its value", () => {
    const shared = aug("shared", { factions: ["A", "B"], baseRepRequirement: 100, mults: { hacking: 1.5 } });
    const catalog = new Map([["shared", shared]]);
    const world = view({ factions: [standing("A"), standing("B")], catalog });
    const { frontiers } = buildFrontiers(world, noBlockers(["A", "B"]));

    const alone = evaluateSelection([{ faction: "A", index: 0 }], frontiers, world)!;
    const both = evaluateSelection(
      [{ faction: "A", index: 0 }, { faction: "B", index: 0 }],
      frontiers,
      world,
    )!;
    expect(both.augmentations).toEqual(["shared"]);
    // Adding B buys nothing but its own favor, so it can never double the value.
    expect(both.value).toBeLessThan(alone.value * 2);
    // ...and it costs strictly more time, so the solver has every reason to
    // decline it.
    expect(both.workSec).toBeGreaterThan(alone.workSec);
  });

  test("the union pays ONE escalating price ladder, not one per faction", () => {
    // Reputation cost carries no queue term but money does, so a set of n
    // purchases pays n escalating prices ONCE. Pricing each faction's package
    // from a fresh queue depth understates a joint set.
    const catalog = new Map([
      ["a1", aug("a1", { factions: ["A"], baseCost: 1e8, baseRepRequirement: 100, mults: { hacking: 1.2 } })],
      ["b1", aug("b1", { factions: ["B"], baseCost: 1e8, baseRepRequirement: 100, mults: { hacking: 1.2 } })],
    ]);
    const world = view({
      factions: [standing("A"), standing("B")],
      catalog,
      moneyAvailable: 0,
      // Fast enough that both packages survive the frontier's horizon filter;
      // the ratio under test is unaffected by the rate.
      incomePerSec: 1e4,
    });
    const { frontiers } = buildFrontiers(world, noBlockers(["A", "B"]));
    const a = evaluateSelection([{ faction: "A", index: 0 }], frontiers, world)!;
    const both = evaluateSelection(
      [{ faction: "A", index: 0 }, { faction: "B", index: 0 }],
      frontiers,
      world,
    )!;
    // Money seconds are the set's dollars over the income rate, so the ratio is
    // the price ratio. Two items priced together cost MORE than twice one,
    // because the second pays the 1.9x escalation — summing two independently
    // priced packages would report exactly 2x and hide the joint set's cost.
    expect(both.moneySec).toBeGreaterThan(a.moneySec * 2);
  });
});

describe("choosing the cycle length", () => {
  test("the grid is geometric, starts at the floor, and reaches the horizon", () => {
    const grid = budgetGrid(10_000);
    expect(grid[0]).toBeCloseTo(MIN_BUDGET_SEC, 6);
    expect(grid.at(-1)).toBeCloseTo(10_000, 6);
    for (let i = 1; i < grid.length; i++) expect(grid[i]!).toBeGreaterThan(grid[i - 1]!);
  });

  test("a package longer than the horizon is still reachable by some budget", () => {
    // The frontier already discounts beyond-horizon packages and drops the ones
    // below half. Capping the budget at the horizon would discount that a second
    // time — and would make a route's terminal augmentation unplannable.
    expect(budgetGrid(1, 8_000).at(-1)!).toBeGreaterThanOrEqual(8_000);
  });

  test("reproduces the renewal optimum sqrt(2*O/p) on a linear value curve", () => {
    // `progression`'s install verdict solves the same problem for a LINEAR push
    // rate: loss p*T/2 + O/T is least at T = sqrt(2*O/p). Sweeping V*(T)/(T+O)
    // has to agree there, or this is a competing cadence rather than a
    // generalisation of that one.
    const overhead = INSTALL_OVERHEAD_SEC;
    const p = 0.01;
    const analytic = Math.sqrt((2 * overhead) / p);
    let best = { sec: 0, rate: -Infinity };
    for (const sec of budgetGrid(20_000)) {
      // Linear accrual that only activates at the install: the value carried
      // across the boundary is p*T*T/2 relative to a stream, so the renewal
      // objective is the same expression the verdict minimises.
      const rate = (p * sec) / (sec + overhead) / (1 + (p * sec) / 2);
      if (rate > best.rate) best = { sec, rate };
    }
    // The grid is 24 geometric samples over three decades, so agreement is to
    // within one grid step rather than exact.
    const step = Math.pow(20_000 / MIN_BUDGET_SEC, 1 / 23);
    expect(best.sec).toBeGreaterThan(analytic / step / step);
    expect(best.sec).toBeLessThan(analytic * step * step);
  });

  test("evaluates the WHOLE grid, so a set behind an expensive unlock is still found", () => {
    // V*(T) is not concave: rates rise within a cycle, so a faction that is
    // unreachable at a short budget can be affordable at a long one. A search
    // that walked outward and stopped when the rate fell would never see it.
    const catalog = new Map([
      ["near", aug("near", { factions: ["A"], baseRepRequirement: 100, mults: { hacking: 1.05 } })],
      ["far", aug("far", { factions: ["B"], baseRepRequirement: 40_000, mults: { hacking: 4 } })],
    ]);
    const world = view({ factions: [standing("A"), standing("B")], catalog, horizonSec: 1e6 });
    const { frontiers } = buildFrontiers(world, noBlockers(["A", "B"]));
    const { curve } = chooseBudget(frontiers, world, INSTALL_OVERHEAD_SEC);
    // Somewhere on the grid the expensive faction is worth taking, and the sweep
    // is published so that judgement can be argued with.
    expect(curve.some((sample) => sample.factions >= 1)).toBe(true);
    expect(curve.length).toBeGreaterThan(1);
    const richest = curve.reduce((best, sample) => (sample.value > best.value ? sample : best));
    expect(richest.value).toBeGreaterThan(curve[0]!.value);
  });
});

describe("the plan entry point", () => {
  test("publishes an ordered set, its budget and the sweep it was chosen from", () => {
    const catalog = new Map([
      ["a1", aug("a1", { factions: ["A"], baseRepRequirement: 200, mults: { hacking: 1.3 } })],
      ["b1", aug("b1", { factions: ["B"], baseRepRequirement: 300, mults: { hacking_money: 1.4 } })],
    ]);
    const world = view({ factions: [standing("A"), standing("B")], catalog });
    const plan = selectFactionPlan(world, noBlockers(["A", "B"]), { resetOverheadSec: INSTALL_OVERHEAD_SEC });

    expect(plan.portfolio.budgetSec).toBeGreaterThan(0);
    expect(plan.horizonCurve.length).toBeGreaterThan(1);
    // The head of the set is what every existing consumer reads as `intent`.
    expect(plan.intent?.faction).toBe(plan.portfolio.packages[0]?.faction);
    // The union is deduplicated and prerequisite-closed.
    expect(new Set(plan.portfolio.augmentations).size).toBe(plan.portfolio.augmentations.length);
    // The bound gap is a real number in [0, 1], so the heuristic is auditable.
    expect(plan.portfolio.boundGap).toBeGreaterThanOrEqual(0);
    expect(plan.portfolio.boundGap).toBeLessThanOrEqual(1);
  });
});

describe("pacing a gap against an accelerating rate", () => {
  test("a stationary rate is the spot answer exactly", () => {
    expect(pacedSec(500, 1_000, 1)).toBe(500);
    expect(pacedSec(500, 0, 2)).toBe(500);
    expect(curveExponent(undefined, "money")).toBe(1);
  });

  test("acceleration only ever shortens, and never below zero", () => {
    for (const exponent of [1.5, 2, 3, 4]) {
      const paced = pacedSec(1_000, 600, exponent);
      expect(paced).toBeGreaterThan(0);
      expect(paced).toBeLessThan(1_000);
    }
    // A DECELERATING fit is the estimator reading a stalled window as the
    // future regime; the spot rate is the honest answer there.
    expect(pacedSec(1_000, 600, 0.6)).toBe(1_000);
  });

  test("round-trips, so a package can be re-paced at its slot in the work order", () => {
    for (const exponent of [1, 1.7, 2.5, 4]) {
      const paced = pacedSec(900, 400, exponent);
      expect(spotSecFromPaced(paced, 400, exponent)).toBeCloseTo(900, 6);
    }
  });

  test("closed form matches the curve it claims to invert", () => {
    // y = a*t^p, so progress between e and e+T is a*((e+T)^p - e^p), while the
    // spot rate a*p*e^(p-1) would have made a*p*e^(p-1)*spot in the same budget.
    const rng = mulberry32(3);
    for (let trial = 0; trial < 50; trial++) {
      const e = 60 + rng() * 5_000;
      const p = 1 + rng() * 3;
      const spot = 10 + rng() * 10_000;
      const T = pacedSec(spot, e, p);
      const gained = Math.pow(e + T, p) - Math.pow(e, p);
      const wanted = p * Math.pow(e, p - 1) * spot;
      expect(gained / wanted).toBeCloseTo(1, 6);
    }
  });
});
