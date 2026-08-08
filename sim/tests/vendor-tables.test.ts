import { describe, expect, test } from "bun:test";
import { AUGMENTATION_TABLE } from "../vendor/bitburner/src/Augmentation/AugmentationTable.ts";
import { FACTION_TABLE } from "../vendor/bitburner/src/Faction/FactionTable.ts";

/** Ground truth extracted from the pinned v3.0.1 source by
 * `tools/vendor.ts --force` (extractDataTable: transpile + evaluate, never
 * regex — the faction table is JSX prose full of apostrophes and braces).
 *
 * These are not tests of the game. They are tests that the EXTRACTION is
 * faithful, so a bad re-vendor fails here rather than silently handing the
 * planner wrong prices and unreachable factions. Every assertion below is a
 * fact an incorrect extraction would get wrong in a plausible-looking way. */

describe("faction table", () => {
  test("has all 34 factions", () => {
    // 34, not 33: ShadowsOfAnarchy is easy to miss because it is special-cased
    // everywhere and offers no ordinary work.
    expect(Object.keys(FACTION_TABLE)).toHaveLength(34);
  });

  test("requirements are the structured tree, not a stringified blob", () => {
    // The strategy has to INTERPRET these, so a display string would be
    // useless. CyberSec is the simplest case: one backdoor.
    expect(FACTION_TABLE["CyberSec"]!.inviteReqs).toEqual([{ type: "backdoorInstalled", server: "CSEC" }]);
  });

  test("nested OR structure survives extraction", () => {
    // Upstream's `everyCondition` iterator flattens nested ANDs but NOT ANDs
    // inside an OR. A strategy that only saw a flattened list could not tell
    // "hacking 2500 OR combat 1500" from "hacking 2500 AND combat 1500" — and
    // would report Daedalus as unreachable for most characters.
    const daedalus = FACTION_TABLE["Daedalus"]!.inviteReqs;
    const or = daedalus.find((r) => r.type === "someCondition");
    expect(or).toBeDefined();
    expect((or as { conditions: unknown[] }).conditions).toHaveLength(2);
  });

  test("delayed conditions are resolved to their real values", () => {
    // Daedalus's augmentation requirement is `delayedCondition(() =>
    // haveAugmentations(currentNodeMults.DaedalusAugsRequirement))`. If the
    // extractor had failed to call it, this would be missing entirely.
    expect(FACTION_TABLE["Daedalus"]!.inviteReqs).toContainEqual({ type: "numAugmentations", numAugmentations: 30 });
  });

  test("the city ban graph is intact and symmetric where the game says so", () => {
    // Sector-12/Aevum are mutually compatible, as are Chongqing/New Tokyo/
    // Ishima; Volhaven excludes all five. Losing these edges would let the
    // planner commit to a faction set it can never actually join.
    expect(FACTION_TABLE["Sector-12"]!.enemies.sort()).toEqual(["Chongqing", "Ishima", "New Tokyo", "Volhaven"]);
    expect(FACTION_TABLE["Volhaven"]!.enemies.sort()).toEqual([
      "Aevum",
      "Chongqing",
      "Ishima",
      "New Tokyo",
      "Sector-12",
    ]);
    expect(FACTION_TABLE["Aevum"]!.enemies).not.toContain("Sector-12");
    for (const [name, info] of Object.entries(FACTION_TABLE)) {
      for (const enemy of info.enemies) {
        expect(FACTION_TABLE[enemy], `${name} bans unknown faction ${enemy}`).toBeDefined();
      }
    }
  });

  test("boolean flags read the field the class actually stores", () => {
    // `keepOnInstall` is the CONSTRUCTOR PARAM name; the class stores it as
    // `keep`. Reading the param name yields undefined for every faction, which
    // coerces to a uniform `false` that looks entirely plausible.
    const kept = Object.values(FACTION_TABLE).filter((f) => f.keepOnInstall);
    expect(kept.length).toBeGreaterThan(0);
    expect(kept.length).toBeLessThan(Object.keys(FACTION_TABLE).length);
  });

  test("work types are per faction, and the criminal ladder is field work", () => {
    expect(FACTION_TABLE["CyberSec"]!.offerHackingWork).toBe(true);
    expect(FACTION_TABLE["CyberSec"]!.offerFieldWork).toBe(false);
    expect(FACTION_TABLE["Slum Snakes"]!.offerFieldWork).toBe(true);
    // Shadows of Anarchy can ONLY gain reputation by infiltrating.
    const soa = FACTION_TABLE["Shadows of Anarchy"]!;
    expect(soa.offerHackingWork || soa.offerFieldWork || soa.offerSecurityWork).toBe(false);
  });

  test("karma requirements are negative, so the direction rule matters", () => {
    const karma = FACTION_TABLE["Slum Snakes"]!.inviteReqs.find((r) => r.type === "karma");
    expect(karma).toEqual({ type: "karma", karma: -9 });
  });
});

describe("augmentation table", () => {
  test("extracts every augmentation with its price and rep cost", () => {
    expect(Object.keys(AUGMENTATION_TABLE).length).toBeGreaterThan(130);
    const nfg = AUGMENTATION_TABLE["NeuroFlux Governor"]!;
    expect(nfg.baseRepRequirement).toBe(500);
    expect(nfg.baseCost).toBe(750_000);
  });

  test("non-multiplier metadata is NOT folded into mults", () => {
    // `startingMoney` and `programs` are one-off grants. Folding either into
    // `mults` would add a 1,000,000 "multiplier" to a log-sum score and
    // dominate every real bonus in the game.
    const cashRoot = AUGMENTATION_TABLE["CashRoot Starter Kit"]!;
    expect(cashRoot.startingMoney).toBe(1_000_000);
    expect(cashRoot.programs).toEqual(["BruteSSH.exe"]);
    expect(cashRoot.mults).toEqual({});
    for (const [name, aug] of Object.entries(AUGMENTATION_TABLE)) {
      for (const [field, value] of Object.entries(aug.mults)) {
        expect(Number.isFinite(value), `${name}.${field} is not a finite multiplier`).toBe(true);
      }
    }
  });

  test("an unpurchasable augmentation costs Infinity, not null and not 0", () => {
    // JSON cannot represent Infinity, so a naive emitter writes `null` — which
    // reads as "no price" and would make the planner treat an unobtainable
    // augmentation as free.
    const bigD = AUGMENTATION_TABLE["BigD's Big ... Brain"]!;
    expect(bigD.baseCost).toBe(Infinity);
    expect(bigD.baseRepRequirement).toBe(Infinity);
    // ...while The Red Pill really IS free, and must stay distinguishable.
    expect(AUGMENTATION_TABLE["The Red Pill"]!.baseCost).toBe(0);
    expect(AUGMENTATION_TABLE["The Red Pill"]!.factions).toEqual(["Daedalus"]);
  });

  test("the one randomised augmentation is marked, not fabricated", () => {
    // UnstableCircadianModulator picks its multipliers from a random set at
    // load time. Freezing one arbitrary roll into the table would be a
    // fabricated value the planner would then score as if it were the truth.
    const ucm = AUGMENTATION_TABLE["Unstable Circadian Modulator"]!;
    expect(ucm.multsUnknown).toBe(true);
    expect(ucm.mults).toEqual({});
    // Its price and faction ARE fixed, so those are kept.
    expect(ucm.baseCost).toBe(5e9);
    expect(ucm.factions).toEqual(["Speakers for the Dead"]);
    const marked = Object.values(AUGMENTATION_TABLE).filter((a) => a.multsUnknown);
    expect(marked).toHaveLength(1);
  });

  test("prerequisite chains resolve, so the closure is computable", () => {
    const withPrereqs = Object.values(AUGMENTATION_TABLE).filter((a) => a.prereqs.length > 0);
    expect(withPrereqs.length).toBeGreaterThan(20);
    for (const aug of withPrereqs) {
      for (const prereq of aug.prereqs) {
        expect(AUGMENTATION_TABLE[prereq], `${aug.name} requires unknown ${prereq}`).toBeDefined();
      }
    }
  });

  test("every offering faction is a real faction", () => {
    for (const aug of Object.values(AUGMENTATION_TABLE)) {
      for (const faction of aug.factions) {
        expect(FACTION_TABLE[faction], `${aug.name} is offered by unknown faction ${faction}`).toBeDefined();
      }
    }
  });
});
