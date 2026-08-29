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

  test("cancelled program work writes and resumes the exact incomplete file", () => {
    const world = new SimWorld({ seed: 1, person: { skills: { hacking: 50 } } });
    const files = new Set<string>();
    const programs = new ProgramSystem(world, world.player, () => files);

    expect(programs.start("brutessh.exe", true)).toBe(true);
    programs.processWork(100);
    expect(world.player.stopWork()).toBe(true);
    expect(files).toEqual(new Set(["BruteSSH.exe-3.33%-INC"]));

    expect(programs.start("BruteSSH.exe", true)).toBe(true);
    expect(files.size).toBe(0);
    expect(world.player.currentWork?.unitCompleted).toBeCloseTo(19_980, 10);
  });

  test("program work recomputes its rate from live skills each engine pass", () => {
    const world = new SimWorld({ seed: 1, person: { skills: { hacking: 50 } } });
    const files = new Set<string>();
    const programs = new ProgramSystem(world, world.player, () => files);

    expect(programs.start("BruteSSH.exe", true)).toBe(true);
    programs.processWork(1_000); // 200,000 ms at hacking 50
    world.person.skills.hacking = 500;
    programs.processWork(714); // 399,840 ms at the new 560 ms/cycle rate
    expect(files.has("BruteSSH.exe")).toBe(false);
    programs.processWork(1);
    expect(files.has("BruteSSH.exe")).toBe(true);
  });

  test("unfocused crime keeps its full payout and gates intelligence on SF5", async () => {
    // Two upstream details the sim used to miss. CrimeWork.commit calls
    // `scaleWorkStats(this.earnings(), focusBonus, false)` — `scaleMoney` is
    // FALSE, so the unfocused 0.8 applies to exp and karma but never to money.
    // And intelligence goes through `Player.gainIntelligenceExp`, which drops
    // the gain entirely outside BN5/SF5 rather than writing the exp record.
    const run = (bitnode: number, sourceFiles: Record<string, number>) => {
      const world = new SimWorld({ seed: 1, bitnode, playerState: { sourceFiles } });
      const crimes = new CrimeSystem(world, world.player, () => 0); // always succeed
      const crime = crimes.get("Heist")!;
      const before = world.player.money;
      crimes.start(crime.type, false); // UNFOCUSED
      crimes.processWork(crime.timeMs / 200);
      return { world, crime, gained: world.player.money - before };
    };

    const bn1 = run(1, {});
    const crimeMoney = bn1.crime.money * currentNodeMults.CrimeMoney;
    expect(bn1.gained).toBeCloseTo(crimeMoney, 6);
    // No SF5: the exp record must not move at all, and neither must the skill.
    expect(bn1.world.person.exp.intelligence).toBe(0);
    expect(bn1.world.person.skills.intelligence).toBe(0);

    // With SF5 owned the gain lands, raises the skill, and banks persistently
    // so an install cannot silently discard it.
    const bn5 = run(1, { "5": 1 });
    expect(bn5.world.person.exp.intelligence).toBeGreaterThan(0);
    expect(bn5.world.person.skills.intelligence).toBeGreaterThan(0);
    expect(bn5.world.player.persistentIntelligenceExp).toBe(bn5.world.person.exp.intelligence);
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
    // No ClassGymExpGain: v3.0.1 declares the multiplier but never applies it
    // to class/gym earnings (src/Work/Formulas.ts:108-121 has no consumer).
    expect(world.person.exp.strength).toBe(beforeExp + 10);
    expect(world.player.currentWork).toMatchObject({ kind: "class", subject: "strength" });
  });

  test("training keeps processing after the balance crosses zero, as ClassWork does", () => {
    const world = new SimWorld({ seed: 1, startingMoney: 1_000 });
    const education = new EducationSystem(world, world.player);
    expect(education.gymWorkout("Powerhouse Gym", "str", true)).toBe(true);

    education.processWork(5);

    expect(world.player.money).toBe(-1_400);
    expect(world.player.currentWork).toMatchObject({ kind: "class", subject: "strength", cyclesWorked: 5 });
  });

  test("class work has no focus penalty and university work grants its independent intelligence rate", () => {
    const focused = new SimWorld({ seed: 1, bitnode: 5, startingMoney: 10_000 });
    const unfocused = new SimWorld({ seed: 1, bitnode: 5, startingMoney: 10_000 });
    const a = new EducationSystem(focused, focused.player);
    const b = new EducationSystem(unfocused, unfocused.player);
    expect(a.universityCourse("Rothman University", "Algorithms", true)).toBe(true);
    expect(b.universityCourse("Rothman University", "Algorithms", false)).toBe(true);

    a.processWork(5);
    b.processWork(5);

    expect(unfocused.person.exp.hacking).toBe(focused.person.exp.hacking);
    expect(unfocused.person.exp.intelligence).toBe(focused.person.exp.intelligence);
    expect(focused.person.exp.intelligence).toBe(0.02);
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

  test("SF15's charisma bonus affects company salary but not company experience", () => {
    const base = new SimWorld({ seed: 1, person: { skills: { hacking: 250, charisma: 5_000 } } });
    const sf15 = new SimWorld({
      seed: 1,
      person: { skills: { hacking: 250, charisma: 5_000 } },
      playerState: { sourceFiles: { "15": 2 } },
    });
    const baseCompanies = new CompanySystem(base, base.player);
    const sfCompanies = new CompanySystem(sf15, sf15.player);
    expect(baseCompanies.apply("ECorp", "Software")).not.toBeNull();
    expect(sfCompanies.apply("ECorp", "Software")).not.toBeNull();
    expect(baseCompanies.startWork("ECorp", true)).toBe(true);
    expect(sfCompanies.startWork("ECorp", true)).toBe(true);
    const baseMoney = base.player.money;
    const sfMoney = sf15.player.money;
    baseCompanies.processWork(1);
    sfCompanies.processWork(1);

    expect(sf15.person.exp.hacking).toBe(base.person.exp.hacking);
    expect(sf15.player.money - sfMoney).toBeGreaterThan(base.player.money - baseMoney);
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

  test("grafting applies only the augmentation body, not its prestige-time grants", () => {
    const world = new SimWorld({ seed: 1, startingMoney: 1e15, playerState: { city: "New Tokyo" } });
    const files = new Set<string>();
    const grafting = new GraftingSystem(world, world.player, () => files);
    const price = grafting.price("CashRoot Starter Kit");
    const before = world.player.money;
    expect(grafting.start("CashRoot Starter Kit", true)).toBe(true);
    grafting.processWork(grafting.timeMs("CashRoot Starter Kit") / 200 + 1);

    expect(world.player.money).toBe(before - price);
    expect(files.has("BruteSSH.exe")).toBe(false);
    expect(world.player.augmentations.has("CashRoot Starter Kit")).toBe(true);
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
