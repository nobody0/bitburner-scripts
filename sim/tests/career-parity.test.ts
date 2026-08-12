import { describe, expect, test } from "bun:test";
import { PORT_OPENER_PROGRAMS, programCreateTimeMs } from "../../shared/strategy/career/programs.ts";
import { CrimeSystem } from "../features/crime.ts";
import { EducationSystem } from "../features/education.ts";
import { GraftingSystem } from "../features/grafting.ts";
import { ProgramSystem } from "../features/programs.ts";
import { CompanySystem } from "../features/companies.ts";
import { COMPANY_TABLE } from "../vendor/bitburner/src/Company/CompanyTable.ts";
import { CONSTANTS } from "../vendor/bitburner/src/Constants.ts";
import { addRepToFavor } from "../vendor/bitburner/src/Faction/formulas/favor.ts";
import { PROGRAM_TABLE } from "../vendor/bitburner/src/Programs/ProgramTable.ts";
import { currentNodeMults } from "../vendor/bitburner/src/BitNode/BitNodeMultipliers.ts";
import { calculateIntelligenceBonus } from "../vendor/bitburner/src/PersonObjects/formulas/intelligence.ts";
import { SimWorld } from "../world.ts";

describe("career parity with Bitburner v3.0.1", () => {
  test("the handwritten port-opener table exactly matches the extracted upstream tables", () => {
    expect(PORT_OPENER_PROGRAMS).toEqual(Object.values(PROGRAM_TABLE));
  });

  test("program duration uses the upstream effective requirement and work-rate equation", () => {
    for (const program of PORT_OPENER_PROGRAMS) {
      for (const intelligence of [0, 50, 500]) {
        const minimum = Math.max(1, program.level - intelligence / 2);
        expect(programCreateTimeMs(program, minimum - 0.001, intelligence)).toBe(Infinity);
        const skillMult = 1 + ((minimum / program.level) * calculateIntelligenceBonus(intelligence, 3) - 1) / 5;
        expect(programCreateTimeMs(program, minimum, intelligence)).toBe(program.baseTimeMs / skillMult);
      }
    }
  });

  test("program work creates its file only on the exact completion cycle", async () => {
    const world = new SimWorld({ seed: 1, person: { skills: { hacking: 50, intelligence: 0 } } });
    const files = new Set<string>();
    const programs = new ProgramSystem(world, world.player, () => files);
    const program = PORT_OPENER_PROGRAMS[0]!;
    const duration = programCreateTimeMs(program, 50, 0);

    expect(programs.start(program.name, true)).toBe(true);
    const completion = world.player.currentWork!.nextCompletion;
    programs.processWork(duration / 200 - 1);
    expect(files.has(program.name)).toBe(false);
    programs.processWork(1);
    await completion;

    expect(files.has(program.name)).toBe(true);
    expect(world.player.currentWork).toBeUndefined();
    expect(programs.start(program.name, true)).toBe(false);
  });

  test("a failed player crime banks quarter experience and karma on the exact completion cycle", async () => {
    const world = new SimWorld({ seed: 1 });
    const crimes = new CrimeSystem(world, world.player, () => 1); // always fail
    const crime = crimes.get("Shoplift")!;
    const beforeKarma = world.player.karma;
    const beforeDex = world.person.exp.dexterity;
    crimes.start(crime.type, true);
    const completion = world.player.currentWork!.nextCompletion;

    crimes.processWork(crime.timeMs / 200 - 1);
    expect(world.player.karma).toBe(beforeKarma);
    crimes.processWork(1);
    await completion;

    expect(world.player.karma).toBe(beforeKarma - crime.karma / 4);
    expect(world.person.exp.dexterity).toBe(beforeDex + crime.exp.dexterity / 4);
    expect(world.records.find((record) => record.kind === "event" && record.name === "crime.done")).toMatchObject({
      data: { success: false, karma: -crime.karma / 4 },
    });
  });

  test("Powerhouse training spends and earns on engine cycles", () => {
    const world = new SimWorld({ seed: 1, startingMoney: 10_000 });
    const education = new EducationSystem(world, world.player);
    const beforeMoney = world.player.money;
    const beforeExp = world.person.exp.strength;

    expect(education.gymWorkout("Powerhouse Gym", "strength", true)).toBe(true);
    education.processWork(5);

    expect(world.player.money).toBe(beforeMoney - 2_400);
    expect(world.person.exp.strength).toBe(beforeExp + 10 * currentNodeMults.ClassGymExpGain);
    expect(world.player.currentWork).toMatchObject({ kind: "class", subject: "strength" });
  });

  test("training stops at the last affordable cycle", () => {
    const world = new SimWorld({ seed: 1, startingMoney: 1_000 });
    const education = new EducationSystem(world, world.player);
    expect(education.gymWorkout("Powerhouse Gym", "str", true)).toBe(true);

    education.processWork(5);

    expect(world.player.money).toBe(40);
    expect(world.player.currentWork).toBeUndefined();
  });

  test("company applications use the exact company skill offset and promote to the highest qualified job", () => {
    const world = new SimWorld({ seed: 1, person: { skills: { hacking: 249, charisma: 1 } } });
    const companies = new CompanySystem(world, world.player);

    expect(companies.apply("ECorp", "Software")).toBeNull();
    world.person.skills.hacking = 250;
    expect(companies.apply("ECorp", "Software")).toBe("Software Engineering Intern");

    const junior = COMPANY_TABLE.positions["Junior Software Engineer"]!;
    companies.standings.get("ECorp")!.rep = junior.requiredReputation;
    world.person.skills.hacking = junior.requiredSkills.hacking + COMPANY_TABLE.companies.ECorp!.jobStatReqOffset;
    world.person.skills.charisma = junior.requiredSkills.charisma > 0
      ? junior.requiredSkills.charisma + COMPANY_TABLE.companies.ECorp!.jobStatReqOffset
      : 1;
    expect(companies.apply("ECorp", "Software")).toBe("Junior Software Engineer");
  });

  test("company work applies salary, experience and performance per engine cycle", () => {
    const world = new SimWorld({ seed: 1, person: { skills: { hacking: 250, charisma: 10, intelligence: 5 } } });
    const companies = new CompanySystem(world, world.player);
    const company = COMPANY_TABLE.companies.ECorp!;
    const position = COMPANY_TABLE.positions["Software Engineering Intern"]!;
    expect(companies.apply(company.name, "Software")).toBe(position.name);
    expect(companies.startWork(company.name, true)).toBe(true);
    const moneyBefore = world.player.money;
    const hackingExpBefore = world.person.exp.hacking;
    companies.processWork(5);

    const weightedSkill = (85 * 250 + 15 * 10) / 100;
    const performance = position.repMultiplier * weightedSkill / CONSTANTS.MaxSkillLevel + 5 / CONSTANTS.MaxSkillLevel;
    expect(world.player.money - moneyBefore).toBeCloseTo(position.baseSalary * company.salaryMultiplier * 5, 12);
    expect(world.person.exp.hacking - hackingExpBefore).toBeCloseTo(position.expGain.hacking! * company.expMultiplier * 5, 12);
    expect(companies.rep(company.name)).toBeCloseTo(performance * 5, 12);
    expect(world.player.currentWork).toMatchObject({ kind: "company", subject: company.name, cyclesWorked: 5 });
  });

  test("company prestige banks reputation into favor and clears jobs", () => {
    const world = new SimWorld({ seed: 1, person: { skills: { hacking: 250 } } });
    const companies = new CompanySystem(world, world.player, { ECorp: 50_000 });
    companies.apply("ECorp", "Software");
    companies.prestigeAugmentation();

    expect(companies.rep("ECorp")).toBe(0);
    expect(companies.favor("ECorp")).toBeCloseTo(addRepToFavor(0, 50_000), 12);
    expect(world.player.jobs).toEqual({});
  });

  test("grafting pays up front, survives travel, and applies entropy only on completion", async () => {
    const world = new SimWorld({ seed: 1, startingMoney: 100_000_000, playerState: { city: "New Tokyo" } });
    const grafting = new GraftingSystem(world, world.player);
    const price = grafting.price("BitWire");
    const duration = grafting.timeMs("BitWire");
    const before = world.player.money;
    expect(grafting.start("BitWire", true)).toBe(true);
    const completion = world.player.currentWork!.nextCompletion;
    expect(world.player.money).toBe(before - price);
    expect(world.player.entropy).toBe(0);

    grafting.processWork(duration / 400);
    world.player.city = "Aevum"; // travel does not stop Player.currentWork
    grafting.processWork(duration / 400 + 1);
    await completion;

    expect(world.player.augmentations.has("BitWire")).toBe(true);
    expect(world.player.entropy).toBe(1);
    expect(world.person.mults.hacking).toBeCloseTo(1.05 * 0.98, 12);
  });

  test("cancelling a graft refunds nothing and loses all partial progress", () => {
    const world = new SimWorld({ seed: 1, startingMoney: 100_000_000, playerState: { city: "New Tokyo" } });
    const grafting = new GraftingSystem(world, world.player);
    const duration = grafting.timeMs("BitWire");
    expect(grafting.start("BitWire", true)).toBe(true);
    grafting.processWork(duration / 400);
    const afterPurchase = world.player.money;
    world.player.stopWork();
    expect(world.player.money).toBe(afterPurchase);

    expect(grafting.start("BitWire", true)).toBe(true);
    grafting.processWork(duration / 400);
    expect(world.player.augmentations.has("BitWire")).toBe(false);
  });

  test("an augmentation already queued for installation is not graftable", () => {
    const world = new SimWorld({
      seed: 1,
      startingMoney: 100_000_000,
      playerState: { city: "New Tokyo", queuedAugmentations: [{ name: "BitWire", level: 1 }] },
    });
    const grafting = new GraftingSystem(world, world.player);
    expect(grafting.available()).not.toContain("BitWire");
    expect(grafting.start("BitWire", true)).toBe(false);
  });
});
