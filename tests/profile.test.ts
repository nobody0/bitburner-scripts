import { describe, expect, test } from "bun:test";
import { selectDue, FEATURE_DRIVERS } from "../game/lib/features/index.ts";
import { applyOverrides, only } from "../shared/features/profile.ts";
import { deriveCapabilities } from "../shared/features/unlock.ts";
import { PROFILES, findProfile } from "../sim/profiles.ts";
import { intelligenceExp } from "../sim/save-mint.ts";
import { initialContext, reduceRecord } from "../shared/goals/evaluate.ts";
import { parseGoals } from "../shared/goals/presets.ts";
import type { LogRecord } from "../shared/telemetry/schema.ts";
import { deriveRouteLegs, routeLegProfileId, SPEEDRUN_ROUTE_ID } from "../shared/strategy/progression/route-legs.ts";

/** The feature-override seam. It exists so a simulation can ask a narrow
 * question ("hacking alone, for an hour"), and it is applied in exactly one
 * place — caps() — so nothing downstream can disagree. */

const fresh = deriveCapabilities({ bitNode: 1, sourceFiles: {}, inGang: false, hasWseAccount: false });

describe("feature overrides", () => {
  test("off beats a genuine unlock", () => {
    expect(fresh.unlocked["hacking"]).toBe("yes");
    const capped = applyOverrides(fresh, { hacking: "off" });
    expect(capped.unlocked["hacking"]).toBe("no");
    expect(capped.reason["hacking"]).toContain("simulation profile");
  });

  test("on beats a genuine lock", () => {
    expect(fresh.unlocked["gang"]).toBe("no");
    const capped = applyOverrides(fresh, { gang: "on" });
    expect(capped.unlocked["gang"]).toBe("yes");
    // Still explains itself: a forced-on feature the save cannot really play
    // is the kind of thing that makes a run's numbers unexplainable later.
    expect(capped.reason["gang"]).toContain("forced on");
  });

  test("leaves the underlying reading untouched", () => {
    const capped = applyOverrides(fresh, { hacking: "off" });
    expect(capped).not.toBe(fresh);
    expect(fresh.unlocked["hacking"]).toBe("yes");
    expect(capped.bitNode).toBe(1);
  });

  test("only() disables everything else without forcing anything on", () => {
    const overrides = only("hacking", "factions");
    expect(overrides["hacking"]).toBeUndefined();
    expect(overrides["factions"]).toBeUndefined();
    expect(overrides["gang"]).toBe("off");
    expect(overrides["hacknet"]).toBe("off");
    // Nothing is forced: a faction run needs factions genuinely unlocked by
    // the save, not pretended into existence.
    expect(Object.values(overrides).every((value) => value === "off")).toBe(true);
  });

  test("an isolated feature stops its driver ticking", () => {
    const capped = applyOverrides(fresh, only("hacking", "progression"));
    const due = selectDue(FEATURE_DRIVERS, {}, capped, 1_000_000);
    const ids = due.map((driver) => driver.id);
    expect(ids).toContain("hacking");
    expect(ids).toContain("progression");
    // career/hacknet/side are always-playable, so only an override can stop them.
    expect(ids).not.toContain("hacknet");
    expect(ids).not.toContain("career");
    expect(ids).not.toContain("side");
  });

});

describe("simulation profiles", () => {
  test("every profile has parseable goals and at least one seed", () => {
    for (const profile of PROFILES) {
      expect(() => parseGoals([...profile.goals])).not.toThrow();
      expect(profile.seeds.length).toBeGreaterThan(0);
    }
  });

  test("the route legs are the only promotable route evidence", () => {
    // Running an entire BitNode IS the speedrun, so there is no separate
    // "full-node benchmark" class: every bitnode-route profile is a generated
    // leg of the one route. Specialized fixtures stay feature-scenarios.
    const routeProfiles = PROFILES.filter((profile) => profile.experiment === "bitnode-route");
    expect(routeProfiles.map((profile) => profile.id)).toEqual([
      "leg-bn4.1", "leg-bn4.2", "leg-bn4.3",
      "leg-bn1.1", "leg-bn1.2", "leg-bn1.3",
      "leg-bn15.1", "leg-bn15.2", "leg-bn15.3",
      "leg-bn14.1", "leg-bn5.1",
      "leg-bn14.2", "leg-bn14.3", "leg-bn5.2", "leg-bn5.3",
      "leg-bn8.1", "leg-bn8.2", "leg-bn8.3",
    ]);
    for (const profile of routeProfiles) {
      // The declared entrance BitNode is enforced against the leg by
      // assertValidExperiment, and every leg belongs to the one route.
      expect(profile.route?.bitNode).toBe(profile.bitnode!);
      expect(profile.route?.route).toBe(SPEEDRUN_ROUTE_ID);
      if (!profile.chainedLeg) {
        // A fresh route entrance grants nothing: no earned Source Files means
        // the leg really is the cold start its route id claims.
        expect(profile.world?.playerState?.sourceFiles).toBeUndefined();
      }
    }
    expect(findProfile("jit-lategame").experiment).toBe("feature-scenario");
    expect(findProfile("bn1-full-sf12-30").experiment).toBe("feature-scenario");
  });

  test("chained legs carry exactly the entrance the route derivation implies", () => {
    const legsByName = new Map(deriveRouteLegs().map((leg) => [leg.leg, leg]));
    // The route's first leg is one completion of BN4 with an empty derived
    // entrance — the only genuine fresh cold start, so it must not claim a
    // chained identity. Every other covered leg is chained, including the
    // mid-milestone re-entries bn4.2 and bn4.3.
    expect(findProfile("leg-bn4.1").chainedLeg).toBeUndefined();
    expect(findProfile("leg-bn4.1").route).toEqual({
      route: SPEEDRUN_ROUTE_ID, leg: "bn4.1", index: 0, bitNode: 4,
    });
    expect(findProfile("leg-bn4.2").chainedLeg).toBeDefined();
    for (const profile of PROFILES.filter((entry) => entry.chainedLeg)) {
      const leg = profile.chainedLeg!;
      const derived = legsByName.get(leg.leg)!;
      // Grants and identity are written from one RouteLeg; the derivation-side
      // fields (everything except the ledger-fed intelligence chain) must
      // match a fresh derivation exactly.
      expect(leg.index).toBe(derived.index);
      expect(leg.node).toBe(derived.node);
      expect(leg.level).toBe(derived.level);
      expect(leg.entranceSourceFiles).toEqual(derived.entranceSourceFiles);
      expect(profile.route).toEqual({
        route: SPEEDRUN_ROUTE_ID, leg: leg.leg, index: leg.index, bitNode: leg.node,
      });
      expect(profile.id).toBe(routeLegProfileId(leg));
      expect(profile.world?.playerState?.sourceFiles).toEqual({ ...leg.entranceSourceFiles });
      // A mid-milestone re-entry must also raise its own node's multipliers:
      // sourceFileLevel is the node's earned partial level, or absent when
      // the leg is the node's first completion.
      const ownLevel = leg.entranceSourceFiles[String(leg.node)] ?? 0;
      expect(profile.world?.sourceFileLevel).toBe(ownLevel > 0 ? ownLevel : undefined);
      expect(leg.level).toBe(ownLevel + 1);
      if (leg.entranceIntelligence > 0) {
        expect(profile.world?.person?.skills?.intelligence).toBe(leg.entranceIntelligence);
        expect(profile.world?.person?.exp?.intelligence).toBe(intelligenceExp(leg.entranceIntelligence));
        // Installs keep intelligence only with owned SF5 (sim/world.ts) — a
        // derivation handing out intelligence without it would silently lose
        // the entrance state at the first install.
        expect(leg.entranceSourceFiles["5"] ?? 0).toBeGreaterThan(0);
      } else {
        expect(profile.world?.person).toBeUndefined();
      }
    }
  });

  test("profile ids are unique and unknown ids are rejected", () => {
    const ids = PROFILES.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(() => findProfile("nope")).toThrow(/unknown profile/);
  });

  test("full BN1 and cross-city cadence runs include the career gate owner", () => {
    const full = findProfile("leg-bn1.1");
    expect(full.features?.career).toBeUndefined();
    expect(full.features?.hacknet).toBeUndefined();
    expect(full.features?.stock).toBeUndefined();
    // `side` joined the full-node surface with the coding-contract runtime: it
    // is universal income and must compete with hacking and career here.
    expect(full.features?.side).toBeUndefined();
    expect(findProfile("install-cadence").features?.career).toBeUndefined();
  });

  test("SF12.30 calibration changes only persistent SF12 state", () => {
    const clean = findProfile("leg-bn1.1");
    const boosted = findProfile("bn1-full-sf12-30");
    expect(boosted.bitnode).toBe(clean.bitnode);
    expect(boosted.features).toEqual(clean.features);
    expect(boosted.goals).toEqual(clean.goals);
    expect(boosted.homeRam).toBe(clean.homeRam);
    expect(boosted.world?.network).toBe(clean.world?.network);
    expect(boosted.world?.playerState?.sourceFiles?.["12"]).toBe(30);
    expect(boosted.world?.playerState?.augmentations).toEqual([
      { name: "NeuroFlux Governor", level: 30 },
    ]);
    expect(boosted.world?.person?.mults?.hacking).toBeGreaterThan(1);
  });

  test("the BN5 stock treatment changes only the feature under test", () => {
    const control = findProfile("bn5-hacking");
    const treatment = findProfile("bn5-hacking-stock");

    expect(treatment.bitnode).toBe(control.bitnode);
    expect(treatment.goals).toEqual(control.goals);
    expect(treatment.horizon).toBe(control.horizon);
    expect(treatment.seeds).toEqual(control.seeds);
    expect(treatment.startingMoney).toBe(control.startingMoney);
    expect(treatment.homeRam).toBe(control.homeRam);
    expect(treatment.world).toBe(control.world);

    expect(control.features?.stock).toBe("off");
    expect(treatment.features?.stock).toBeUndefined();
    for (const feature of Object.keys(control.features ?? {})) {
      if (feature !== "stock") {
        expect(treatment.features?.[feature as keyof NonNullable<typeof treatment.features>])
          .toBe(control.features?.[feature as keyof NonNullable<typeof control.features>]);
      }
    }
  });

});

describe("faction goals", () => {
  test("faction: is reached by joining", () => {
    const goal = parseGoals(["faction:CyberSec"]);
    const ctx = initialContext();
    expect(goal.done(ctx)).toBe(false);
    ctx.factions.set("CyberSec", { name: "CyberSec", joined: true, rep: 0, favor: 0 });
    expect(goal.done(ctx)).toBe(true);
  });

  test("rep: needs the reputation, not just membership", () => {
    const goal = parseGoals(["rep:CyberSec:1e5"]);
    const ctx = initialContext();
    ctx.factions.set("CyberSec", { name: "CyberSec", joined: true, rep: 5_000, favor: 0 });
    expect(goal.done(ctx)).toBe(false);
    ctx.factions.get("CyberSec")!.rep = 200_000;
    expect(goal.done(ctx)).toBe(true);
  });

  test("the reducer feeds those goals from a real factions topic", () => {
    // The path a live run actually takes: state topic -> reducer -> goal.
    const ctx = initialContext();
    reduceRecord(ctx, {
      kind: "state",
      key: "factions",
      data: { joined: ["CyberSec"], standings: [{ name: "CyberSec", rep: 150_000, favor: 12 }] },
      seq: 0,
      t: 0,
      run: "test",
      src: "sim",
    } as LogRecord);
    expect(parseGoals(["faction:CyberSec"]).done(ctx)).toBe(true);
    expect(parseGoals(["rep:CyberSec:1e5"]).done(ctx)).toBe(true);
    expect(parseGoals(["rep:CyberSec:1e6"]).done(ctx)).toBe(false);
  });

  test("a new factions topic replaces cycle-scoped membership", () => {
    const ctx = initialContext();
    const record = (joined: string[], t: number): LogRecord => ({
      kind: "state",
      key: "factions",
      data: { joined },
      seq: t,
      t,
      run: "test",
      src: "sim",
    } as LogRecord);

    reduceRecord(ctx, record(["CyberSec"], 0));
    reduceRecord(ctx, record(["NiteSec"], 1));

    expect(ctx.factions.get("CyberSec")?.joined).toBe(false);
    expect(ctx.factions.get("NiteSec")?.joined).toBe(true);
  });

  test("rejects a malformed faction spec", () => {
    expect(() => parseGoals(["faction:"])).toThrow();
    expect(() => parseGoals(["rep:1e5"])).toThrow();
  });
});
