import { describe, expect, test } from "bun:test";
import type { PlayerRequirement } from "@ns";
import { estimateBlockerSec, evaluate, type RequirementView } from "../shared/strategy/factions/requirements.ts";

/** The work-line model behind company blocker ETAs: a 400k companyRep gate
 * used to be priced at the nominal 0.1 s/rep = 40,000s, which pushed every
 * megacorp faction package past the planning horizon and starved career of
 * the apply->work->invite chain. */

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

const strongPerson = {
  skills: { hacking: 3_000, strength: 500, defense: 500, dexterity: 500, agility: 500, charisma: 2_000, intelligence: 200 },
  mults: { company_rep: 1 },
};

const companyWork: NonNullable<RequirementView["companyWork"]> = {
  person: strongPerson,
  ctx: { companyWorkRepGain: 1, companyWorkMoney: 1, focusMult: 1 },
  favor: {},
};

describe("companyReputation blockers", () => {
  const requirement: PlayerRequirement = {
    type: "companyReputation",
    company: "NWO" as never,
    reputation: 400_000,
  };

  test("without the work model the nominal estimate applies (40,000s)", () => {
    const [blocker] = evaluate(requirement, view());
    expect(blocker!.etaSec).toBeUndefined();
    expect(estimateBlockerSec(blocker!, 0)).toBeCloseTo(40_000, 0);
  });

  test("with the work model a strong player's 400k gate is priced by the real ladder — far below nominal", () => {
    const [blocker] = evaluate(requirement, view({ companyWork }));
    expect(blocker!.etaSec).toBeDefined();
    expect(blocker!.etaSec!).toBeGreaterThan(0);
    expect(blocker!.etaSec!).toBeLessThan(40_000);
    expect(estimateBlockerSec(blocker!, 0)).toBe(blocker!.etaSec!);
  });

  test("existing reputation shortens the walk", () => {
    const fresh = evaluate(requirement, view({ companyWork }))[0]!;
    const partway = evaluate(requirement, view({ companyWork, companyRep: { NWO: 300_000 } }))[0]!;
    expect(partway.etaSec!).toBeLessThan(fresh.etaSec!);
  });
});

describe("employment blockers", () => {
  test("hirable now is near-instant; stat-gated keeps the nominal estimate", () => {
    const requirement: PlayerRequirement = { type: "employedBy", company: "NWO" as never };
    const hirable = evaluate(requirement, view({ companyWork }))[0]!;
    expect(hirable.etaSec).toBe(60);
    const gated = evaluate(requirement, view({
      companyWork: { ...companyWork, person: { skills: { hacking: 1, charisma: 1, intelligence: 0 }, mults: {} } },
    }))[0]!;
    expect(gated.etaSec).toBeUndefined();
  });
});

describe("jobTitle blockers (Silhouette's disjunction)", () => {
  const disjunction: PlayerRequirement = {
    type: "someCondition",
    conditions: (["Chief Technology Officer", "Chief Financial Officer", "Chief Executive Officer"] as const)
      .map((jobTitle) => ({ type: "jobTitle", jobTitle } as PlayerRequirement)),
  };

  test("the OR resolves to the cheapest reachable title from the data, not a hardcoded track", () => {
    // For a profile qualifying on both ladders, CFO (800k rep on the
    // Business track) is genuinely cheaper than CTO (3.2M rep) — the choice
    // comes from the position data, not a preferred-track rule. The old
    // heuristic dead-ended CEO requests on the Software track entirely.
    const dual = evaluate(disjunction, view({ companyWork }));
    expect(dual).toHaveLength(1);
    expect(dual[0]!.subject).toBe("Chief Financial Officer");
    expect(Number.isFinite(dual[0]!.etaSec!)).toBe(true);
  });

  test("held title satisfies the OR outright", () => {
    expect(evaluate(disjunction, view({ jobTitles: ["Chief Financial Officer"] }))).toEqual([]);
  });
});
