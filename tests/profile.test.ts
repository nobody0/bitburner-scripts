import { describe, expect, test } from "bun:test";
import { selectDue, FEATURE_DRIVERS } from "../game/lib/features/index.ts";
import { FEATURE_IDS } from "../shared/features/ids.ts";
import { applyOverrides, describeOverrides, only } from "../shared/features/profile.ts";
import { deriveCapabilities } from "../shared/features/unlock.ts";
import { PROFILES, findProfile } from "../sim/profiles.ts";
import { initialContext, reduceRecord } from "../shared/goals/evaluate.ts";
import { parseGoals } from "../shared/goals/presets.ts";
import type { LogRecord } from "../shared/telemetry/schema.ts";

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

  test("no overrides is the identity", () => {
    expect(applyOverrides(fresh, undefined)).toBe(fresh);
    expect(applyOverrides(fresh, {})).toBe(fresh);
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

  test("unknown still never ticks, with or without overrides", () => {
    const unprobed = deriveCapabilities({});
    expect(unprobed.unlocked["gang"]).toBe("unknown");
    const due = selectDue(FEATURE_DRIVERS, {}, applyOverrides(unprobed, { hacknet: "off" }), 1_000_000);
    expect(due.map((d) => d.id)).not.toContain("gang");
  });

  test("describes itself for the run record", () => {
    expect(describeOverrides(undefined)).toBe("all features");
    expect(describeOverrides(only("hacking"))).toContain("only hacking");
    expect(describeOverrides({ gang: "on" })).toContain("forced");
  });
});

describe("simulation profiles", () => {
  test("every profile names real features and parseable goals", () => {
    for (const profile of PROFILES) {
      for (const id of Object.keys(profile.features ?? {})) {
        expect(FEATURE_IDS).toContain(id as (typeof FEATURE_IDS)[number]);
      }
      expect(() => parseGoals([...profile.goals])).not.toThrow();
      expect(profile.seeds.length).toBeGreaterThan(0);
      expect(profile.description.length).toBeGreaterThan(20);
    }
  });

  test("profile ids are unique and looked up by name", () => {
    const ids = PROFILES.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(findProfile("hacking-only").features).toBeDefined();
    expect(() => findProfile("nope")).toThrow(/unknown profile/);
  });

  test("an isolation profile leaves its feature under test enabled", () => {
    const profile = findProfile("hacking-only");
    const capped = applyOverrides(fresh, profile.features);
    expect(capped.unlocked["hacking"]).toBe("yes");
    expect(capped.unlocked["hacknet"]).toBe("no");
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

  test("rejects a malformed faction spec", () => {
    expect(() => parseGoals(["faction:"])).toThrow();
    expect(() => parseGoals(["rep:1e5"])).toThrow();
  });
});
