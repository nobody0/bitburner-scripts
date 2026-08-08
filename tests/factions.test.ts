import { describe, expect, test } from "bun:test";
import type { PlayerRequirement } from "@ns";
import {
  augCost,
  basePriceMultiplier,
  canAfford,
  closePrereqs,
  EXACT_ORDER_LIMIT,
  MULTIPLE_AUG_MULTIPLIER,
  NEUROFLUX,
  orderPurchases,
  scoreAug,
  totalCost,
  type AugInfo,
  type PriceContext,
  type PurchaseCandidate,
} from "../shared/strategy/factions/augs.ts";
import { EXACT_SEARCH_LIMIT, foreclosedBy, selectFactions, type FactionCandidate } from "../shared/strategy/factions/objective.ts";
import {
  combinedEtaSec,
  evaluate,
  evaluateAll,
  isReachable,
  negate,
  type Blocker,
  type RequirementView,
} from "../shared/strategy/factions/requirements.ts";
import { mulberry32 } from "../sim/core/rng.ts";

function view(overrides: Partial<RequirementView> = {}): RequirementView {
  return {
    money: 0,
    skills: { hacking: 1, strength: 1, defense: 1, dexterity: 1, agility: 1, charisma: 1, intelligence: 0 },
    karma: 0,
    numPeopleKilled: 0,
    augCount: 0,
    jobs: {},
    companyRep: {},
    jobTitles: [],
    city: "Sector-12",
    location: "home",
    backdoored: new Set(),
    files: new Set(),
    hacknetRam: 0,
    hacknetCores: 0,
    hacknetLevels: 0,
    bitNode: 1,
    sourceFiles: {},
    bladeburnerRank: 0,
    numInfiltrations: 0,
    ...overrides,
  };
}

describe("requirement interpreter — regressions from the predecessor scripts", () => {
  test("an empty blocker list means SATISFIED (theirs returned false, because [] is truthy)", () => {
    // src/_lib/factions.ts:182-186 — the `not` case returns false whether the
    // inner call succeeded or not, because an empty array is truthy in JS. The
    // consequence was that every `notEmployedBy` faction — the entire criminal
    // ladder — was permanently unreachable.
    const requirement: PlayerRequirement = { type: "not", condition: { type: "employedBy", company: "ECorp" as never } };
    expect(evaluate(requirement, view())).toEqual([]);
    expect(evaluate(requirement, view({ jobs: { ECorp: "Software" } }))).toHaveLength(1);
    expect(evaluate(requirement, view({ jobs: { ECorp: "Software" } }))[0]!.kind).toBe("quitCompany");
  });

  test("a satisfiable OR is satisfiable (theirs returned false unconditionally)", () => {
    // src/_lib/factions.ts:187-197 — `someCondition` falls through to
    // `return false` after its success loop.
    const requirement: PlayerRequirement = {
      type: "someCondition",
      conditions: [
        { type: "skills", skills: { hacking: 2500 } },
        { type: "money", money: 100 },
      ],
    };
    expect(evaluate(requirement, view({ money: 1_000 }))).toEqual([]);
  });

  test("numAugmentations emits a GOAL, not 'unachievable' (theirs made Daedalus unplannable)", () => {
    // src/_lib/factions.ts:102-112.
    const requirement: PlayerRequirement = { type: "numAugmentations", numAugmentations: 30 };
    const blockers = evaluate(requirement, view({ augCount: 12 }));
    expect(blockers).toHaveLength(1);
    expect(blockers[0]).toMatchObject({ kind: "augCount", target: 30, have: 12, reachable: true });
    expect(blockers[0]!.progress).toBeCloseTo(0.4, 10);
  });

  test("hacknet, bladeburner and infiltration requirements are real (theirs were `return false` TODOs)", () => {
    // Netburners, Bladeburners and Shadows of Anarchy were unreachable.
    const cases: [PlayerRequirement, string][] = [
      [{ type: "hacknetRAM", hacknetRAM: 8 }, "hacknetRam"],
      [{ type: "hacknetCores", hacknetCores: 4 }, "hacknetCores"],
      [{ type: "hacknetLevels", hacknetLevels: 100 }, "hacknetLevels"],
      [{ type: "bladeburnerRank", bladeburnerRank: 25 }, "bladeburnerRank"],
      [{ type: "numInfiltrations", numInfiltrations: 30 }, "infiltrations"],
    ];
    for (const [requirement, kind] of cases) {
      const blockers = evaluate(requirement, view());
      expect(blockers, `${kind} produced no blocker`).toHaveLength(1);
      expect(blockers[0]!.kind).toBe(kind as Blocker["kind"]);
      expect(blockers[0]!.reachable, `${kind} reported unreachable`).toBe(true);
    }
  });
});

describe("requirement interpreter — semantics", () => {
  test("karma is an UPPER bound on a negative number", () => {
    const requirement: PlayerRequirement = { type: "karma", karma: -45 };
    expect(evaluate(requirement, view({ karma: -50 }))).toEqual([]);
    expect(evaluate(requirement, view({ karma: -45 }))).toEqual([]);
    expect(evaluate(requirement, view({ karma: -10 }))).toHaveLength(1);
    expect(evaluate(requirement, view({ karma: -10 }))[0]!.progress).toBeCloseTo(10 / 45, 10);
  });

  test("the four combat skills collapse into ONE goal", () => {
    // `haveCombatSkills(n)` emits all four at once; treating them as four
    // competing goals is not how the game presents it, and would make career
    // rank one stat above the others for no reason.
    const requirement: PlayerRequirement = {
      type: "skills",
      skills: { strength: 30, defense: 30, dexterity: 30, agility: 30 },
    };
    const blockers = evaluate(requirement, view());
    expect(blockers).toHaveLength(1);
    expect(blockers[0]!.kind).toBe("combatSkills");
    // ...but a MIXED skill requirement stays separate.
    const mixed = evaluate({ type: "skills", skills: { strength: 30, hacking: 100 } }, view());
    expect(mixed.map((b) => b.kind).sort()).toEqual(["skill", "skill"]);
  });

  test("AND unions blockers; OR picks the cheapest REACHABLE branch", () => {
    const and: PlayerRequirement = {
      type: "everyCondition",
      conditions: [
        { type: "money", money: 100 },
        { type: "karma", karma: -10 },
      ],
    };
    expect(evaluateAll([and], view())).toHaveLength(2);

    // One branch needs the wrong BitNode (unreachable), the other is money.
    const or: PlayerRequirement = {
      type: "someCondition",
      conditions: [
        { type: "bitNodeN", bitNodeN: 9 },
        { type: "money", money: 100 },
      ],
    };
    const picked = evaluate(or, view());
    expect(picked).toHaveLength(1);
    expect(picked[0]!.kind).toBe("money");
  });

  test("an OR with every branch impossible is impossible", () => {
    const or: PlayerRequirement = {
      type: "someCondition",
      conditions: [
        { type: "bitNodeN", bitNodeN: 9 },
        { type: "sourceFile", sourceFile: 12 },
      ],
    };
    expect(isReachable(evaluate(or, view()))).toBe(false);
  });

  test("De Morgan pushes `not` inward before deciding revocability", () => {
    const requirement: PlayerRequirement = {
      type: "not",
      condition: {
        type: "everyCondition",
        conditions: [
          { type: "employedBy", company: "ECorp" as never },
          { type: "employedBy", company: "MegaCorp" as never },
        ],
      },
    };
    // not(A and B) = (not A) or (not B); employed at neither satisfies both.
    expect(evaluate(requirement, view())).toEqual([]);
    // Employed at both: quitting EITHER suffices, so the OR picks one.
    const blocked = evaluate(requirement, view({ jobs: { ECorp: "Software", MegaCorp: "Software" } }));
    expect(blocked).toHaveLength(1);
    expect(blocked[0]!.kind).toBe("quitCompany");

    expect(negate({ type: "someCondition", conditions: [] }).type).toBe("everyCondition");
    expect(negate({ type: "not", condition: { type: "money", money: 1 } })).toEqual({ type: "money", money: 1 });
  });

  test("a negated non-revocable requirement is honestly unreachable", () => {
    // Karma only ever decreases, so "must NOT have karma <= -9" cannot be
    // restored once crossed.
    const requirement: PlayerRequirement = { type: "not", condition: { type: "karma", karma: -9 } };
    expect(evaluate(requirement, view({ karma: 0 }))).toEqual([]);
    const blocked = evaluate(requirement, view({ karma: -50 }));
    expect(blocked).toHaveLength(1);
    expect(blocked[0]!.reachable).toBe(false);
  });

  test("blockers carry the feature that can deliver them", () => {
    const owners = evaluateAll(
      [
        { type: "karma", karma: -45 },
        { type: "skills", skills: { hacking: 100 } },
        { type: "hacknetRAM", hacknetRAM: 8 },
        { type: "backdoorInstalled", server: "CSEC" },
      ],
      view(),
    ).map((blocker) => [blocker.kind, blocker.owner]);
    expect(new Map(owners as [string, string][])).toEqual(
      new Map([
        ["karma", "career"],
        ["skill", "hacking"],
        ["hacknetRam", "hacknet"],
        ["backdoor", "hacking"],
      ]),
    );
  });

  test("ETA sums within one owner and maxes across owners", () => {
    // One feature has one time slot, so its blockers are sequential; different
    // features genuinely run in parallel.
    const blockers = evaluateAll(
      [
        { type: "karma", karma: -45 },
        { type: "numPeopleKilled", numPeopleKilled: 30 },
        { type: "hacknetRAM", hacknetRAM: 8 },
      ],
      view(),
    );
    // career: 10 + 10 = 20; hacknet: 5. Max is 20, not the 25 sum.
    expect(combinedEtaSec(blockers, (b) => (b.owner === "career" ? 10 : 5))).toBe(20);
  });
});

// --- augmentation pricing ---------------------------------------------------

function aug(name: string, overrides: Partial<AugInfo> = {}): AugInfo {
  return { name, baseCost: 1e6, baseRepRequirement: 1000, factions: ["CyberSec"], prereqs: [], mults: {}, ...overrides };
}

function priceCtx(overrides: Partial<PriceContext> = {}): PriceContext {
  return { queuedNonSoA: 0, ownedSoA: 0, neurofluxLevel: 0, sf11Level: 0, augMoneyCost: 1, augRepCost: 1, ...overrides };
}

describe("augmentation pricing", () => {
  test("money scales with the queue but REPUTATION DOES NOT", () => {
    // The single fact the whole purchase plan rests on: rep targets are
    // order-independent, money is not.
    const a = aug("A");
    const first = augCost(a, priceCtx({ queuedNonSoA: 0 }));
    const fourth = augCost(a, priceCtx({ queuedNonSoA: 3 }));
    expect(fourth.moneyCost / first.moneyCost).toBeCloseTo(Math.pow(1.9, 3), 10);
    expect(fourth.repCost).toBe(first.repCost);
  });

  test("SF11 discounts the escalation", () => {
    expect(basePriceMultiplier(0)).toBe(MULTIPLE_AUG_MULTIPLIER);
    expect(basePriceMultiplier(1)).toBeCloseTo(1.9 * 0.96, 12);
    expect(basePriceMultiplier(3)).toBeCloseTo(1.9 * 0.93, 12);
    // Clamped, not indexed off the end.
    expect(basePriceMultiplier(9)).toBe(basePriceMultiplier(3));
  });

  test("NeuroFlux scales 1.14^level on BOTH rep and money", () => {
    const nfg = aug(NEUROFLUX, { baseCost: 750_000, baseRepRequirement: 500 });
    const level0 = augCost(nfg, priceCtx({ neurofluxLevel: 0 }));
    const level5 = augCost(nfg, priceCtx({ neurofluxLevel: 5 }));
    expect(level5.repCost / level0.repCost).toBeCloseTo(Math.pow(1.14, 5), 10);
    expect(level5.moneyCost / level0.moneyCost).toBeCloseTo(Math.pow(1.14, 5), 10);
    // NOT 1.9 — the predecessor scripts use 1.9 here and overprice it wildly.
    expect(level5.repCost / level0.repCost).not.toBeCloseTo(Math.pow(1.9, 5), 2);
  });

  test("SoA augmentations price on their own curve and are OUTSIDE the queue count", () => {
    const soa = aug("Wisdom of Athena", { baseCost: 1e6, baseRepRequirement: 1000 });
    const owned2 = augCost(soa, priceCtx({ ownedSoA: 2, queuedNonSoA: 5 }));
    // 7^2 on money, 1.3^2 on rep, and the 1.9^5 queue multiplier does NOT apply.
    expect(owned2.moneyCost).toBeCloseTo(1e6 * 49, 6);
    expect(owned2.repCost).toBeCloseTo(1000 * 1.69, 10);
  });
});

describe("purchase ordering — brute-force oracle", () => {
  function permutations<T>(items: T[]): T[][] {
    if (items.length <= 1) return [items];
    const out: T[][] = [];
    for (let i = 0; i < items.length; i++) {
      const rest = [...items.slice(0, i), ...items.slice(i + 1)];
      for (const tail of permutations(rest)) out.push([items[i]!, ...tail]);
    }
    return out;
  }

  function candidate(name: string, baseCost: number, prereqs: string[] = []): PurchaseCandidate {
    return { name, aug: aug(name, { baseCost, prereqs }), faction: "CyberSec" };
  }

  test("matches the exhaustive optimum over all permutations (no prerequisites)", () => {
    const rng = mulberry32(7);
    const ctx = priceCtx();
    for (let trial = 0; trial < 40; trial++) {
      const size = 2 + Math.floor(rng() * 6); // up to 7
      const set = Array.from({ length: size }, (_, i) => candidate(`A${i}`, Math.round(rng() * 1e9) + 1));
      const ours = totalCost(orderPurchases(set, ctx), ctx);
      let best = Infinity;
      for (const permutation of permutations(set)) best = Math.min(best, totalCost(permutation, ctx));
      expect(ours).toBeCloseTo(best, 6);
    }
  });

  test("matches the constrained optimum when prerequisites force order", () => {
    const ctx = priceCtx();
    // B needs A, and A is CHEAPER — so expensive-first must yield to the
    // constraint, which is exactly where a naive sort would be wrong.
    const set = [candidate("A", 1e6), candidate("B", 5e8, ["A"]), candidate("C", 2e8)];
    const order = orderPurchases(set, ctx);
    expect(order.findIndex((c) => c.name === "A")).toBeLessThan(order.findIndex((c) => c.name === "B"));

    let best = Infinity;
    for (const permutation of permutations(set)) {
      if (permutation.findIndex((c) => c.name === "A") > permutation.findIndex((c) => c.name === "B")) continue;
      best = Math.min(best, totalCost(permutation, ctx));
    }
    expect(totalCost(order, ctx)).toBeCloseTo(best, 6);
  });

  test("matches brute force on random PREREQUISITE GRAPHS, not just chains", () => {
    // Bitburner's prerequisite graph branches — up to four prerequisites, depth
    // five — so no chain rule is exact and the DP has to earn its keep here.
    const rng = mulberry32(23);
    const ctx = priceCtx();
    for (let trial = 0; trial < 30; trial++) {
      const size = 3 + Math.floor(rng() * 4); // up to 6
      const names = Array.from({ length: size }, (_, i) => `A${i}`);
      const prereqs = new Map<string, string[]>();
      for (let i = 0; i < size; i++) {
        // Only earlier-indexed items may be prerequisites: keeps it acyclic
        // while still allowing branching and shared parents.
        const picks = names.slice(0, i).filter(() => rng() < 0.4);
        prereqs.set(names[i]!, picks);
      }
      const set = names.map((name) =>
        candidate(name, Math.round(rng() * 1e9) + 1, prereqs.get(name) ?? []),
      );

      const legal = (permutation: PurchaseCandidate[]): boolean =>
        permutation.every((entry, at) =>
          entry.aug.prereqs.every((prereq) => permutation.findIndex((c) => c.name === prereq) < at),
        );
      let best = Infinity;
      for (const permutation of permutations(set)) {
        if (legal(permutation)) best = Math.min(best, totalCost(permutation, ctx));
      }

      const order = orderPurchases(set, ctx);
      expect(legal(order), `order violates precedence: ${order.map((c) => c.name).join(",")}`).toBe(true);
      expect(totalCost(order, ctx)).toBeCloseTo(best, 6);
    }
  });

  test("the exact limit is high enough for real prerequisite-constrained sets", () => {
    // 34 augmentations have prerequisites at all; a single objective's
    // constrained portion is far below this.
    expect(EXACT_ORDER_LIMIT).toBeGreaterThanOrEqual(12);
  });

  test("most-expensive-first is what minimises the total", () => {
    const ctx = priceCtx();
    const set = [candidate("cheap", 1e6), candidate("dear", 1e9)];
    expect(orderPurchases(set, ctx).map((c) => c.name)).toEqual(["dear", "cheap"]);
    expect(totalCost(orderPurchases(set, ctx), ctx)).toBeLessThan(totalCost([set[0]!, set[1]!], ctx));
  });
});

describe("prerequisite closure", () => {
  test("pulls in transitive prerequisites, in dependency order", () => {
    const catalog = new Map<string, AugInfo>([
      ["C", aug("C", { prereqs: ["B"] })],
      ["B", aug("B", { prereqs: ["A"] })],
      ["A", aug("A")],
    ]);
    expect(closePrereqs(["C"], catalog, new Set())).toEqual(["A", "B", "C"]);
  });

  test("skips what is already owned", () => {
    const catalog = new Map<string, AugInfo>([
      ["B", aug("B", { prereqs: ["A"] })],
      ["A", aug("A")],
    ]);
    expect(closePrereqs(["B"], catalog, new Set(["A"]))).toEqual(["B"]);
  });

  test("a cycle cannot hang the controller's 200ms tick", () => {
    const catalog = new Map<string, AugInfo>([
      ["A", aug("A", { prereqs: ["B"] })],
      ["B", aug("B", { prereqs: ["A"] })],
    ]);
    expect(closePrereqs(["A"], catalog, new Set()).sort()).toEqual(["A", "B"]);
  });
});

describe("affordability", () => {
  const base = { moneyCost: 1e6, repCost: 50_000, money: 5e6 };

  test("reputation suffices", () => {
    expect(canAfford({ ...base, factionRep: 60_000 }).ok).toBe(true);
  });

  test("donation can close the gap with the money left AFTER the purchase", () => {
    // Materially better than a plain `rep >= repReq` test — the difference
    // between "wait for reputation" and "pay for it".
    const short = canAfford({ ...base, factionRep: 0, donationRate: { factionRepMult: 1, factionWorkRepGain: 1 } });
    // 50,000 rep at 1e6 per rep-unit needs $50bn — far more than the $4m spare.
    expect(short.ok).toBe(false);
    const cheap = canAfford({
      ...base,
      repCost: 2,
      factionRep: 0,
      donationRate: { factionRepMult: 1, factionWorkRepGain: 1 },
    });
    expect(cheap.ok).toBe(true);
    expect(cheap.needDonation).toBeCloseTo(2e6, 6);
  });

  test("locked donations are reported as locked, not as insufficient reputation", () => {
    const verdict = canAfford({ ...base, factionRep: 0 });
    expect(verdict.ok).toBe(false);
    expect(verdict.reason).toContain("donations locked");
  });

  test("no money is the first check", () => {
    expect(canAfford({ ...base, money: 1, factionRep: 1e9 }).reason).toBe("not enough money");
  });
});

describe("augmentation scoring", () => {
  test("multiplicative bonuses become an additive set problem in log space", () => {
    const weights = { hacking: 1 };
    const a = aug("A", { mults: { hacking: 1.2 } });
    const b = aug("B", { mults: { hacking: 1.5 } });
    expect(scoreAug(a, weights) + scoreAug(b, weights)).toBeCloseTo(Math.log(1.2 * 1.5), 12);
  });

  test("experience multipliers contribute sub-linearly", () => {
    const weights = { hacking: 1, hacking_exp: 1 };
    const stat = aug("S", { mults: { hacking: 1.5 } });
    const exp = aug("E", { mults: { hacking_exp: 1.5 } });
    expect(scoreAug(exp, weights)).toBeLessThan(scoreAug(stat, weights));
  });

  test("a randomised augmentation scores only its bonus, never its placeholder mults", () => {
    const ucm = aug("Unstable Circadian Modulator", { multsUnknown: true, mults: { hacking: 99 } });
    expect(scoreAug(ucm, { hacking: 1 })).toBe(0);
  });

  test("The Red Pill is valued for ending the BitNode, which no multiplier expresses", () => {
    expect(scoreAug(aug("The Red Pill"), {})).toBeGreaterThan(5);
  });
});

// --- objective selection ----------------------------------------------------

describe("faction selection — brute-force oracle", () => {
  function bruteForce(candidates: FactionCandidate[]): number {
    const usable = candidates.filter((c) => c.reachable && c.value > 0);
    const banned = new Map(usable.map((c) => [c.name, new Set(c.enemies)]));
    let best = 0;
    for (let mask = 0; mask < 1 << usable.length; mask++) {
      const picked: FactionCandidate[] = [];
      let ok = true;
      for (let i = 0; i < usable.length && ok; i++) {
        if ((mask & (1 << i)) === 0) continue;
        const entry = usable[i]!;
        for (const other of picked) {
          if (banned.get(entry.name)!.has(other.name) || banned.get(other.name)!.has(entry.name)) {
            ok = false;
            break;
          }
        }
        if (ok) picked.push(entry);
      }
      if (!ok) continue;
      best = Math.max(best, picked.reduce((sum, c) => sum + c.value, 0));
    }
    return best;
  }

  test("is EXACT against all 2^n subsets on seeded random graphs", () => {
    const rng = mulberry32(11);
    for (let trial = 0; trial < 60; trial++) {
      const size = 2 + Math.floor(rng() * 9); // up to 10
      const names = Array.from({ length: size }, (_, i) => `F${i}`);
      const candidates: FactionCandidate[] = names.map((name) => ({
        name,
        value: Math.round(rng() * 100) / 10,
        enemies: [],
        reachable: rng() > 0.15,
      }));
      for (let i = 0; i < size; i++) {
        for (let j = i + 1; j < size; j++) {
          if (rng() < 0.3) {
            (candidates[i]!.enemies as string[]).push(names[j]!);
          }
        }
      }
      expect(selectFactions(candidates).value).toBeCloseTo(bruteForce(candidates), 9);
    }
  });

  test("models the real city ban graph correctly", () => {
    // Sector-12/Aevum are compatible; Chongqing/New Tokyo/Ishima are
    // compatible; Volhaven excludes all five. The optimum is therefore one of
    // those three groups, never a mix.
    const city = (name: string, value: number, enemies: string[]): FactionCandidate => ({
      name,
      value,
      enemies,
      reachable: true,
    });
    const WEST = ["Sector-12", "Aevum"];
    const EAST = ["Chongqing", "New Tokyo", "Ishima"];
    const candidates: FactionCandidate[] = [
      city("Sector-12", 6, [...EAST, "Volhaven"]),
      city("Aevum", 5, [...EAST, "Volhaven"]),
      city("Chongqing", 3, [...WEST, "Volhaven"]),
      city("New Tokyo", 3, [...WEST, "Volhaven"]),
      city("Ishima", 3, [...WEST, "Volhaven"]),
      city("Volhaven", 8, [...WEST, ...EAST]),
    ];
    const result = selectFactions(candidates);
    // West = 11, East = 9, Volhaven alone = 8. The west pair wins outright,
    // and — the point of the test — a MIX is never chosen.
    expect(result.value).toBe(11);
    expect(result.chosen.sort()).toEqual(["Aevum", "Sector-12"]);
    expect(result.foreclosed.map((f) => f.name).sort()).toEqual(["Chongqing", "Ishima", "New Tokyo", "Volhaven"]);
    expect(result.approximated).toBe(false);
  });

  test("a tie is resolved deterministically, not by input order", () => {
    // Sector-12 + Aevum = 9 exactly ties the eastern trio at 3+3+3. Either is
    // optimal; what must not happen is the answer depending on iteration
    // order, because the objective would then thrash between them every tick.
    const build = (): FactionCandidate[] => [
      { name: "Sector-12", value: 5, enemies: ["Chongqing"], reachable: true },
      { name: "Aevum", value: 4, enemies: ["New Tokyo"], reachable: true },
      { name: "Chongqing", value: 5, enemies: ["Sector-12"], reachable: true },
      { name: "New Tokyo", value: 4, enemies: ["Aevum"], reachable: true },
    ];
    const forward = selectFactions(build());
    const backward = selectFactions([...build()].reverse());
    expect(forward.value).toBe(backward.value);
    expect(forward.chosen).toEqual(backward.chosen);
  });

  test("unreachable factions foreclose nothing — you never joined them", () => {
    const candidates: FactionCandidate[] = [
      { name: "A", value: 10, enemies: ["B"], reachable: false },
      { name: "B", value: 3, enemies: ["A"], reachable: true },
    ];
    const result = selectFactions(candidates);
    expect(result.chosen).toEqual(["B"]);
    expect(result.value).toBe(3);
  });

  test("isolated nodes are all taken", () => {
    const candidates: FactionCandidate[] = ["A", "B", "C"].map((name) => ({
      name,
      value: 1,
      enemies: [],
      reachable: true,
    }));
    expect(selectFactions(candidates).chosen.sort()).toEqual(["A", "B", "C"]);
  });

  test("foreclosedBy explains a join before it happens", () => {
    const candidates: FactionCandidate[] = [
      { name: "Sector-12", value: 5, enemies: ["Volhaven"], reachable: true },
      { name: "Volhaven", value: 8, enemies: ["Sector-12"], reachable: true },
    ];
    expect(foreclosedBy("Sector-12", candidates).map((c) => c.name)).toEqual(["Volhaven"]);
  });

  test("the exact search limit is above the real graph's largest component", () => {
    // The real ban graph's largest component is the six city factions.
    expect(EXACT_SEARCH_LIMIT).toBeGreaterThanOrEqual(6);
  });
});

// --- never attempt work a faction does not offer ------------------------------

import { stepFactions } from "../shared/strategy/factions/decide.ts";
import { initFactionMemory } from "../shared/strategy/factions/plan.ts";
import type { FactionsView } from "../shared/strategy/factions/state.ts";

function factionsView(over: Partial<FactionsView> = {}): FactionsView {
  return {
    time: 0,
    person: {
      skills: { hacking: 500, strength: 500, defense: 500, dexterity: 500, agility: 500, charisma: 500, intelligence: 0 },
      mults: { faction_rep: 1 },
    } as FactionsView["person"],
    requirementView: view(),
    repContext: { factionWorkRepGain: 1, shareBonus: 1, sf15Level: 0, hasFocusAug: false },
    priceContext: priceCtx(),
    factions: [],
    catalog: new Map(),
    owned: new Set(),
    weights: { hacking: 1 },
    favorToDonate: 150,
    moneyGranted: 0,
    holdsWorkSlot: true,
    incomePerSec: 1000,
    horizonSec: 3600,
    sf4Level: 3,
    bitNode: 4,
    ...over,
  };
}

function standing(name: string, offers: { hacking: boolean; field: boolean; security: boolean }) {
  return {
    name,
    joined: true,
    invited: false,
    rep: 0,
    favor: 0,
    requirements: [],
    enemies: [],
    offers,
    special: false,
  };
}

describe("work type selection — found in the real game", () => {
  // THE BUG: `workTypes` was never populated by any probe, and the view
  // defaulted missing data to "offers all three". The driver then issued
  // `workForFaction(Tetrads, "hacking")` — Tetrads offers field and security
  // only — so the call failed every 30s forever and reputation never accrued,
  // while the panel cheerfully reported "next work Tetrads (hacking)".
  const wanted = aug("PCMatrix", { factions: ["Tetrads"], baseRepRequirement: 1e5, mults: { hacking: 1.5 } });
  const catalog = new Map([["PCMatrix", wanted]]);

  test("never picks a work type the faction does not offer", () => {
    const { decision } = stepFactions(
      factionsView({
        factions: [standing("Tetrads", { hacking: false, field: true, security: true })],
        catalog,
      }),
      initFactionMemory(),
    );
    if (decision.action.type === "workForFaction") {
      expect(decision.action.workType).not.toBe("hacking");
      expect(["field", "security"]).toContain(decision.action.workType);
    }
  });

  test("a faction offering NO work is never selected for work at all", () => {
    // Shadows of Anarchy gains reputation only by infiltrating.
    const { decision } = stepFactions(
      factionsView({
        factions: [standing("Shadows of Anarchy", { hacking: false, field: false, security: false })],
        catalog: new Map([["PCMatrix", aug("PCMatrix", { factions: ["Shadows of Anarchy"], mults: { hacking: 1.5 } })]]),
      }),
      initFactionMemory(),
    );
    expect(decision.action.type).not.toBe("workForFaction");
  });

  test("unknown work types mean DO NOT WORK, not 'try everything'", () => {
    // The view maps a missing `workTypes` probe reading to all-false. Not
    // working for one probe cycle is cheap; working the wrong type forever is
    // not — and the failure is silent, which is worse.
    const { decision } = stepFactions(
      factionsView({
        factions: [standing("Tetrads", { hacking: false, field: false, security: false })],
        catalog,
      }),
      initFactionMemory(),
    );
    expect(decision.action.type).not.toBe("workForFaction");
  });

  test("without the work slot it says only one activity can run", () => {
    // The panel previously showed the intended work as if it were running,
    // which read as a contradiction against the game's own display.
    const { decision } = stepFactions(
      factionsView({
        factions: [standing("Tetrads", { hacking: false, field: true, security: true })],
        catalog,
        holdsWorkSlot: false,
      }),
      initFactionMemory(),
    );
    expect(decision.action.type).toBe("idle");
    expect(decision.action.why).toContain("only one activity can run");
  });
});
