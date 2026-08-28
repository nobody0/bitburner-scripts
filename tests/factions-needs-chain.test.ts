import { describe, expect, test } from "bun:test";
import { factionsModule } from "../game/lib/features/factions.ts";
import type { NeedContext } from "../game/lib/features/index.ts";
import type { Blocker } from "../shared/strategy/factions/requirements.ts";

/** The megacorp unlock chain on the needs board: employment posts blocking
 * while unemployed, companyRep flips to blocking once hired, and multi-blocker
 * non-objective gates post their first actionable step at "wanted". */

function blocker(overrides: Partial<Blocker> & Pick<Blocker, "kind" | "target" | "have">): Blocker {
  return {
    progress: 0,
    owner: "career",
    reachable: true,
    subject: undefined,
    ...overrides,
  } as Blocker;
}

function ctx(options: {
  jobs?: Record<string, string>;
  blockers?: (Blocker & { faction: string })[];
  gates?: Record<string, { joined: boolean; invited: boolean; missing: Blocker[] }>;
}): NeedContext {
  return {
    state: {
      topics: {
        player: { jobs: options.jobs ?? {} },
        factions: {
          plan: {
            objective: undefined,
            action: { type: "idle", reason: "test" },
            alternatives: [],
            blockers: options.blockers ?? [],
            needOwners: [],
            invalidation: [],
          },
          gates: options.gates ?? {},
        },
      },
    } as never,
    caps: {} as never,
    now: 0,
    activeFeatures: new Set(),
  } as NeedContext;
}

const needs = factionsModule.needs!;

describe("objective megacorp chain", () => {
  const nwoChain = [
    { ...blocker({ kind: "employment", subject: "NWO", target: 1, have: 0 }), faction: "NWO" },
    { ...blocker({ kind: "companyRep", subject: "NWO", target: 400_000, have: 0 }), faction: "NWO" },
  ];

  test("while unemployed: employment blocks, companyRep stays wanted", () => {
    const posted = needs(ctx({ blockers: nwoChain }));
    const employment = posted.find((need) => need.kind === "employment");
    const rep = posted.find((need) => need.kind === "companyRep");
    expect(employment).toMatchObject({ urgency: "blocking", weight: 6, subject: "NWO" });
    expect(rep).toMatchObject({ urgency: "wanted" });
  });

  test("once hired: companyRep flips to blocking", () => {
    const posted = needs(ctx({
      jobs: { NWO: "Software Engineering Intern" },
      blockers: [nwoChain[1]!],
    }));
    const rep = posted.find((need) => need.kind === "companyRep");
    expect(rep).toMatchObject({ urgency: "blocking", weight: 6, subject: "NWO" });
  });

  test("a far skill gate keeps the historical last-blocker rule (no gym starvation)", () => {
    const posted = needs(ctx({
      blockers: [
        { ...blocker({ kind: "combatSkills", target: 1_500, have: 100 }), faction: "Daedalus" },
        { ...blocker({ kind: "skill", subject: "hacking", target: 2_500, have: 500, owner: "hacking" }), faction: "Daedalus" },
      ],
    }));
    expect(posted.every((need) => need.urgency === "wanted")).toBe(true);
  });
});

describe("non-objective gates", () => {
  test("a two-blocker megacorp gate posts its first actionable step at wanted, scaled by chain length", () => {
    const posted = needs(ctx({
      gates: {
        MegaCorp: {
          joined: false,
          invited: false,
          missing: [
            blocker({ kind: "employment", subject: "MegaCorp", target: 1, have: 0 }),
            blocker({ kind: "companyRep", subject: "MegaCorp", target: 400_000, have: 0 }),
          ],
        },
      },
    }));
    const employment = posted.find((need) => need.kind === "employment" && need.subject === "MegaCorp");
    expect(employment).toMatchObject({ urgency: "wanted" });
    expect(employment!.weight).toBeCloseTo(0.5, 5);
    // Only the first actionable step posts, not the whole chain.
    expect(posted.some((need) => need.kind === "companyRep" && need.subject === "MegaCorp")).toBe(false);
  });

  test("ending-by-destroy releases the install-shaped money reserves", () => {
    // A destroy erases augs, favor and the cash itself — the aug-fund and
    // donation reserves must release so speedup spending (infrastructure RAM)
    // can win the money instead.
    const fixture = (endingByDestroy: boolean) => ({
      state: {
        topics: {
          factions: {
            plan: {
              objective: undefined,
              // purchaseAugmentation keeps the endgame path active without
              // entering the anticipation RAM claim (which needs a fuller
              // driver context than this fixture builds).
              action: { type: "purchaseAugmentation", faction: "Ishima", augmentation: "NeuroFlux Governor" },
              alternatives: [],
              blockers: [],
              needOwners: [],
              invalidation: [],
              recommendInstall: { augmentations: [] },
              nextBuy: { name: "NeuroFlux Governor", price: 9e14 },
              drainCosts: { purchase: 75, donation: 25, residualDonation: 0, total: 100 },
            },
          },
          player: { money: 40 },
          progression: { plan: endingByDestroy ? { endingByDestroy: true } : {} },
        },
      },
      caps: { sourceFiles: {}, bitNode: 12 },
      now: 0,
      grants: { money: 0, slot: false, result: undefined },
    }) as never;
    const releasing = factionsModule.claims!(fixture(true));
    expect(releasing.some((claim) => claim.id === "aug-fund")).toBe(false);
    const holding = factionsModule.claims!(fixture(false));
    expect(holding.some((claim) => claim.id === "aug-fund")).toBe(true);
    expect(holding.find((claim) => claim.id === "aug-fund")?.amount).toBe(40);
  });

  test("a gate with an unreachable blocker posts nothing", () => {
    const posted = needs(ctx({
      gates: {
        Silhouette: {
          joined: false,
          invited: false,
          missing: [blocker({ kind: "karma", target: -22, have: 0, reachable: false })],
        },
      },
    }));
    expect(posted).toEqual([]);
  });
});
