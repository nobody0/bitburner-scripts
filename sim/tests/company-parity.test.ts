import { describe, expect, test } from "bun:test";
import { COMPANY_TABLE } from "../vendor/bitburner/src/Company/CompanyTable.ts";
import { COMPANIES, COMPANY_POSITIONS, JOB_TRACKS } from "../../shared/features/companies.ts";
import {
  applyOutcomes,
  bestPositionAt,
  bestTitlePath,
  companyRepPerSec,
  companySalaryPerSec,
  promotionAwareEtaSec,
  type CompanyWorkContext,
} from "../../shared/strategy/career/company.ts";
import { CompanySystem } from "../features/companies.ts";
import { SimWorld } from "../world.ts";

/** `shared/features/companies.ts` is a scripted transcription of the vendored
 * company table (zero-valued skill entries omitted): the live strategy needs
 * position ladders and rate coefficients for jobs the player does NOT hold,
 * which telemetry can never provide, and `shared/` may not import `sim/`
 * (tests/boundaries.test.ts).
 *
 * After `bun run vendor` bumps the tag, a failure here is the EXPECTED signal
 * to regenerate the transcription. */

const restoreZeros = (rec: Record<string, number> | undefined, template: Record<string, number>): Record<string, number> =>
  Object.fromEntries(Object.keys(template).map((k) => [k, rec?.[k] ?? 0]));

describe("company transcription parity", () => {
  test("job tracks match", () => {
    expect(JOB_TRACKS).toEqual(COMPANY_TABLE.jobTracks);
  });

  test("every position matches", () => {
    expect(Object.keys(COMPANY_POSITIONS).sort()).toEqual(Object.keys(COMPANY_TABLE.positions).sort());
    for (const [name, vendored] of Object.entries(COMPANY_TABLE.positions)) {
      const mine = COMPANY_POSITIONS[name]!;
      expect(mine.field, `${name} field`).toBe(vendored.field);
      expect(mine.next, `${name} next`).toBe(vendored.nextPosition);
      expect(mine.partTime ?? false, `${name} partTime`).toBe(vendored.isPartTime);
      expect(mine.salary, `${name} salary`).toBe(vendored.baseSalary);
      expect(mine.repMult, `${name} repMult`).toBe(vendored.repMultiplier);
      expect(mine.reqRep, `${name} reqRep`).toBe(vendored.requiredReputation);
      expect(restoreZeros(mine.reqSkills, vendored.requiredSkills), `${name} reqSkills`).toEqual(vendored.requiredSkills);
      expect(restoreZeros(mine.effectiveness, vendored.effectiveness), `${name} effectiveness`).toEqual(vendored.effectiveness);
      expect(restoreZeros(mine.expGain, vendored.expGain), `${name} expGain`).toEqual(vendored.expGain);
    }
  });

  test("every company matches", () => {
    expect(Object.keys(COMPANIES).sort()).toEqual(Object.keys(COMPANY_TABLE.companies).sort());
    for (const [name, vendored] of Object.entries(COMPANY_TABLE.companies)) {
      const mine = COMPANIES[name]!;
      expect([...mine.positions], `${name} positions`).toEqual(vendored.positions);
      expect(mine.expMult, `${name} expMult`).toBe(vendored.expMultiplier);
      expect(mine.salaryMult, `${name} salaryMult`).toBe(vendored.salaryMultiplier);
      expect(mine.statReqOffset, `${name} statReqOffset`).toBe(vendored.jobStatReqOffset);
      expect(mine.faction, `${name} faction`).toBe(vendored.relatedFaction);
    }
  });
});

const CTX: CompanyWorkContext = { companyWorkRepGain: 1, companyWorkMoney: 1, focusMult: 1 };

describe("company rate model parity with the simulator", () => {
  test("reputation and salary rates match processWork across positions and favor", () => {
    const cases: { skills: Record<string, number>; field: string; favor: number }[] = [
      { skills: { hacking: 250, charisma: 10, intelligence: 5 }, field: "Software", favor: 0 },
      { skills: { hacking: 600, charisma: 300, intelligence: 50 }, field: "Business", favor: 37 },
      { skills: { hacking: 60, strength: 400, defense: 400, dexterity: 400, agility: 400, charisma: 300, intelligence: 0 }, field: "Security", favor: 12 },
    ];
    for (const { skills, field, favor } of cases) {
      const world = new SimWorld({ seed: 1, person: { skills } });
      const companies = new CompanySystem(world, world.player, { ECorp: { rep: 0, favor } });
      const hired = companies.apply("ECorp", field);
      expect(hired, `${field} hire`).not.toBeNull();
      companies.startWork("ECorp", true);
      const moneyBefore = world.player.money;
      companies.processWork(5); // one second of cycles
      // processWork ends by recalculating skills from (near-zero) experience,
      // so the seeded case skills — the ones the work actually used — are the
      // comparison input, not the post-work person.
      const person = { skills: skills as Record<string, number>, mults: {} };
      const position = COMPANY_POSITIONS[hired!]!;
      expect(companies.rep("ECorp"), `${field} rep/sec`).toBeCloseTo(companyRepPerSec(person, position, favor, CTX), 10);
      expect(world.player.money - moneyBefore, `${field} salary/sec`).toBeCloseTo(
        companySalaryPerSec(person, COMPANIES["ECorp"]!, position, favor, CTX),
        8,
      );
    }
  });

  test("applyOutcomes agrees with the game's apply for every field ECorp offers", () => {
    const skills = { hacking: 260, strength: 300, defense: 300, dexterity: 300, agility: 300, charisma: 260, intelligence: 0 };
    const world = new SimWorld({ seed: 1, person: { skills } });
    const rep = 40_000;
    const companies = new CompanySystem(world, world.player, { ECorp: rep });
    const person = { skills: skills as Record<string, number>, mults: {} };
    const outcomes = applyOutcomes("ECorp", person, rep, 0, CTX);
    const byField = new Map(outcomes.map((o) => [o.field, o.position]));
    for (const field of Object.keys(COMPANY_TABLE.jobTracks)) {
      const hired = companies.apply("ECorp", field);
      expect(byField.get(field), `field ${field}`).toBe(hired ?? undefined);
      if (hired) companies.quit("ECorp");
    }
  });
});

describe("promotion-aware planning", () => {
  test("physical-stats profile picks the Security line over Software where offered", () => {
    const person = {
      skills: { hacking: 60, strength: 800, defense: 800, dexterity: 800, agility: 800, charisma: 300, intelligence: 0 },
      mults: {},
    };
    const best = bestPositionAt("ECorp", person, 10_000, 0, CTX);
    expect(best?.field).toBe("Security");
  });

  test("rep-target walk promotes through rep gates and beats staying on the entry rung", () => {
    const person = { skills: { hacking: 900, charisma: 800, intelligence: 100 }, mults: {} };
    const eta = promotionAwareEtaSec("NWO", person, 0, 0, CTX, { repTarget: 400_000 });
    expect(eta).toBeDefined();
    expect(eta!.path.length).toBeGreaterThan(1);
    expect(Number.isFinite(eta!.seconds)).toBe(true);
    const entry = COMPANY_POSITIONS[eta!.path[0]!]!;
    const flat = 400_000 / companyRepPerSec(person, entry, 0, CTX);
    expect(eta!.seconds).toBeLessThan(flat);
  });

  test("a disjunctive title requirement resolves to the cheapest reachable option", () => {
    // Executive charisma, moderate hacking: CFO (hacking 76+249, charisma
    // 501+249) is reachable, CEO (charisma 751+249) and CTO (deep hacking
    // ladder) are stat-gated. The selector must consider every (title,
    // company) pair and settle on the reachable one.
    const person = { skills: { hacking: 400, charisma: 900, intelligence: 0 }, mults: {} };
    const option = bestTitlePath(
      ["Chief Technology Officer", "Chief Financial Officer", "Chief Executive Officer"],
      [{ name: "ECorp", rep: 0, favor: 0 }, { name: "Joe's Guns", rep: 0, favor: 0 }],
      person,
      CTX,
    );
    expect(option).toBeDefined();
    expect(option!.company).toBe("ECorp"); // Joe's Guns offers no executive track
    expect(Number.isFinite(option!.etaSec)).toBe(true);
  });

  test("a title behind a stat gate is unreachable, a rep target is not", () => {
    const person = { skills: { hacking: 300, charisma: 10, intelligence: 0 }, mults: {} };
    // CEO needs charisma 751 (+offset): stat-gated for this profile.
    const title = promotionAwareEtaSec("ECorp", person, 0, 0, CTX, { titleTarget: "Chief Executive Officer" });
    expect(title).toBeUndefined();
    const rep = promotionAwareEtaSec("ECorp", person, 0, 0, CTX, { repTarget: 400_000 });
    expect(rep).toBeDefined();
    expect(Number.isFinite(rep!.seconds)).toBe(true);
  });
});
