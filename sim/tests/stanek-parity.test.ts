import { describe, expect, test } from "bun:test";
import { SimWorld } from "../world.ts";
import { FactionSystem } from "../features/factions.ts";
import { StanekSystem } from "../features/stanek.ts";
import { Fragments } from "../vendor/bitburner/src/CotMG/Fragment.ts";
import { FragmentTypeEnum } from "../vendor/bitburner/src/CotMG/FragmentType.ts";
import { CalculateEffect } from "../vendor/bitburner/src/CotMG/formulas/effect.ts";
import { currentNodeMults } from "../vendor/bitburner/src/BitNode/BitNodeMultipliers.ts";
import { distinctRotations, rotate } from "../../shared/strategy/stanek/pack.ts";

function harness(favor = 0): { world: SimWorld; factions: FactionSystem; stanek: StanekSystem } {
  const world = new SimWorld({
    seed: 13,
    bitnode: 13,
    playerState: {
      augmentations: [{ name: "Stanek's Gift - Genesis", level: 1 }],
    },
  });
  const factions = new FactionSystem(world, world.player, {
    "Church of the Machine God": { rep: 0, favor },
  });
  return { world, factions, stanek: new StanekSystem(world, world.player, factions) };
}

function place(stanek: StanekSystem, id: number, x: number, y: number, rotation = 0) {
  const fragment = stanek.fragmentById(id);
  if (!fragment) throw new Error("missing vendored fragment " + id);
  expect(stanek.place(x, y, rotation, fragment)).toBe(true);
  return stanek.findFragment(x, y)!;
}

function occupied(fragment: (typeof Fragments)[number], rotation: number): { x: number; y: number }[] {
  const cells: { x: number; y: number }[] = [];
  for (let y = 0; y < fragment.height(rotation); y++) {
    for (let x = 0; x < fragment.width(rotation); x++) {
      if (fragment.fullAt(x, y, rotation)) cells.push({ x, y });
    }
  }
  return cells;
}

describe("Stanek parity", () => {
  test("system effect delegates exactly to the vendored CalculateEffect", () => {
    const { stanek } = harness();
    const active = place(stanek, 6, 0, 0);
    active.highestCharge = 32;
    active.numCharge = 7.25;
    expect(stanek.effect(active)).toBe(
      CalculateEffect(active.highestCharge, active.numCharge, active.fragment().power, 1),
    );
  });

  test("charge accumulator includes the larger-charge rescale branch", () => {
    const { stanek } = harness();
    const active = place(stanek, 6, 0, 0);
    stanek.charge(active, 4);
    expect({ highest: active.highestCharge, count: active.numCharge }).toEqual({ highest: 4, count: 1 });
    stanek.charge(active, 2);
    expect(active.numCharge).toBe(1.5);
    stanek.charge(active, 10);
    expect(active.highestCharge).toBe(10);
    expect(active.numCharge).toBe(1 + (4 * 1.5) / 10);
  });

  test("one adjacent booster is deduplicated across all touching cells", () => {
    const { stanek } = harness();
    const stat = place(stanek, 6, 0, 0);
    // Booster 101's four-cell top edge touches all four cells of fragment 6.
    place(stanek, 101, 0, 1);
    stat.highestCharge = 20;
    stat.numCharge = 3;
    expect(stanek.effect(stat)).toBe(
      CalculateEffect(stat.highestCharge, stat.numCharge, stat.fragment().power, 1.1),
    );
    expect(stanek.effect(stat)).not.toBe(
      CalculateEffect(stat.highestCharge, stat.numCharge, stat.fragment().power, Math.pow(1.1, 4)),
    );
  });

  test("charge credits CotMG reputation using live favor and faction multiplier", () => {
    const { world, factions, stanek } = harness(37);
    const active = place(stanek, 6, 0, 0);
    const faction = factions.get("Church of the Machine God")!;
    const before = faction.rep;
    const threads = 17.5;
    const expected =
      (world.person.mults.faction_rep * (Math.pow(threads, 0.95) * (faction.favor + 100))) / 1000;
    stanek.charge(active, threads);
    expect(faction.rep - before).toBeCloseTo(expected, 14);
  });

  test("charge multipliers apply on the following process tick", () => {
    const { world, stanek } = harness();
    const active = place(stanek, 6, 0, 0);
    const before = world.person.mults.hacking_money;
    stanek.charge(active, 8);
    expect(world.person.mults.hacking_money).toBe(before);
    const effect = stanek.effect(active);
    stanek.process(1);
    expect(world.person.mults.hacking_money).toBeCloseTo(before * effect, 14);
  });

  test("augmentation prestige clears charge only; Source-File prestige clears the gift", () => {
    const { stanek } = harness();
    const active = place(stanek, 6, 0, 0);
    stanek.charge(active, 8);
    stanek.storedCycles = 9;

    stanek.prestigeAugmentation();
    expect(stanek.fragments).toHaveLength(1);
    expect(active.highestCharge).toBe(0);
    expect(active.numCharge).toBe(0);
    expect(stanek.storedCycles).toBe(9);

    stanek.prestigeSourceFile();
    expect(stanek.fragments).toHaveLength(0);
    expect(stanek.storedCycles).toBe(0);
  });

  test("grid size uses node extra size and active Source-File 13 level", () => {
    const { world, factions } = harness();
    world.player.sourceFiles["13"] = 3;
    const stanek = new StanekSystem(world, world.player, factions);
    expect(stanek.baseSize()).toBe(9 + currentNodeMults.StaneksGiftExtraSize + 3);
    expect(stanek.width()).toBe(7);
    expect(stanek.height()).toBe(7);
  });

  test("shared rotate/distinctRotations match every vendored Fragment geometry", () => {
    for (const fragment of Fragments) {
      const source = occupied(fragment, 0);
      for (let rotation = 0; rotation < 4; rotation++) {
        expect(rotate(source, rotation)).toEqual(occupied(fragment, rotation));
      }
      const seen = new Set<string>();
      const expected: number[] = [];
      for (let rotation = 0; rotation < 4; rotation++) {
        const key = occupied(fragment, rotation).map(({ x, y }) => x + "," + y).join("|");
        if (seen.has(key)) continue;
        seen.add(key);
        expected.push(rotation);
      }
      expect(distinctRotations(source)).toEqual(expected);
    }
  });

  test("vendored fragment table contains chargeable stats and unchargeable boosters", () => {
    expect(Fragments.length).toBeGreaterThan(0);
    expect(Fragments.some((fragment) => fragment.type === FragmentTypeEnum.Booster)).toBe(true);
    expect(Fragments.some((fragment) => fragment.type !== FragmentTypeEnum.Booster)).toBe(true);
    expect(new Set(Fragments.map((fragment) => fragment.id)).size).toBe(Fragments.length);
  });
});
