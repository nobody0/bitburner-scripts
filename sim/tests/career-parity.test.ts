import { describe, expect, test } from "bun:test";
import { PORT_OPENER_PROGRAMS, programCreateTimeMs } from "../../shared/strategy/career/programs.ts";
import { CrimeSystem } from "../features/crime.ts";
import { GraftingSystem } from "../features/grafting.ts";
import { PROGRAM_TABLE } from "../vendor/bitburner/src/Programs/ProgramTable.ts";
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
});
