import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { changedMultipliers, BITNODES, DEFAULT_BITNODE_MULTIPLIERS } from "../shared/features/bitnode.ts";
import { FEATURE_IDS, type FeatureId } from "../shared/features/ids.ts";
import { FEATURES, featureById, featureForBitNode } from "../shared/features/registry.ts";
import { deriveCapabilities, sfLevel, unknownCapabilities } from "../shared/features/unlock.ts";
import { DODGED_PROBES, LOCAL_PROBES, GATE_PROBE } from "../game/lib/probes/index.ts";
import { TABS } from "../ui/app/tabs/index.ts";

const root = resolve(import.meta.dir, "..");
const nsDefs = readFileSync(resolve(root, "types/NetscriptDefinitions.d.ts"), "utf8");

describe("feature registry", () => {
  test("every feature id has exactly one registry entry", () => {
    expect(FEATURES.map((f) => f.id).sort()).toEqual([...FEATURE_IDS].sort());
    expect(new Set(FEATURES.map((f) => f.id)).size).toBe(FEATURES.length);
  });

  test("every feature has a tab, and every tab a feature", () => {
    for (const feature of FEATURES) {
      const tab = TABS[feature.id];
      expect(tab, `no tab for feature ${feature.id}`).toBeDefined();
      expect(tab.id).toBe(feature.id);
    }
    // Overview is the only tab without a feature.
    const extra = Object.keys(TABS).filter((id) => id !== "overview" && !FEATURE_IDS.includes(id as FeatureId));
    expect(extra).toEqual([]);
  });

  test("every feature owns at least one topic and describes its problem", () => {
    for (const feature of FEATURES) {
      expect(feature.topics.length, `${feature.id} owns no topic`).toBeGreaterThan(0);
      expect(feature.problem.length, `${feature.id} has no problem statement`).toBeGreaterThan(20);
    }
  });

  test("no BitNode is themed by two features", () => {
    const seen = new Map<number, FeatureId>();
    for (const feature of FEATURES) {
      for (const n of feature.bitnodes) {
        expect(seen.has(n), `BN${n} claimed by ${seen.get(n)} and ${feature.id}`).toBe(false);
        seen.set(n, feature.id);
      }
    }
    for (const n of seen.keys()) expect(featureForBitNode(n)).toBeDefined();
  });

  test("featureById throws for an unknown id", () => {
    expect(() => featureById("nope" as FeatureId)).toThrow();
  });
});

describe("bitnode reference data", () => {
  test("all 15 BitNodes are present and uniquely numbered", () => {
    expect(BITNODES.length).toBe(15);
    expect(BITNODES.map((b) => b.n)).toEqual(Array.from({ length: 15 }, (_, i) => i + 1));
  });

  test("the two non-1 defaults are transcribed correctly", () => {
    // Getting these wrong would render BN1 as if it modified them.
    expect(DEFAULT_BITNODE_MULTIPLIERS.DaedalusAugsRequirement).toBe(30);
    expect(DEFAULT_BITNODE_MULTIPLIERS.StaneksGiftExtraSize).toBe(0);
  });

  test("changedMultipliers reports only true deviations", () => {
    expect(changedMultipliers(undefined)).toEqual([]);
    const active = { ...DEFAULT_BITNODE_MULTIPLIERS, ScriptHackMoney: 0.2 };
    expect(changedMultipliers(active)).toEqual([{ field: "ScriptHackMoney", value: 0.2, base: 1 }]);
    // A BitNode that leaves DaedalusAugsRequirement at 30 has not changed it.
    expect(changedMultipliers({ ...DEFAULT_BITNODE_MULTIPLIERS })).toEqual([]);
  });
});

describe("capability derivation", () => {
  test("nothing probed yields unknown everywhere, never a false lock", () => {
    const caps = unknownCapabilities();
    for (const id of FEATURE_IDS) {
      // The always-on features are known without any reading.
      if (["progression", "hacking", "career", "hacknet", "side"].includes(id)) {
        expect(caps.unlocked[id]).toBe("yes");
      } else {
        expect(caps.unlocked[id], `${id} should be unknown, not locked`).toBe("unknown");
      }
    }
  });

  test("fresh BN1 locks the node-gated features with a reason", () => {
    const caps = deriveCapabilities({
      bitNode: 1,
      sourceFiles: {},
      inGang: false,
      inBladeburner: false,
      hasCorporation: false,
      hasWseAccount: false,
      hasTixApiAccess: false,
      goPlayable: true,
    });
    expect(caps.unlocked.gang).toBe("no");
    expect(caps.unlocked.corp).toBe("no");
    expect(caps.unlocked.sleeves).toBe("no");
    expect(caps.unlocked.factions).toBe("no");
    expect(caps.unlocked.go).toBe("yes");
    for (const id of FEATURE_IDS) {
      if (caps.unlocked[id] !== "yes") expect(caps.reason[id], `${id} locked without a reason`).toBeTruthy();
    }
  });

  test("being in the BitNode unlocks it just like holding the source file", () => {
    expect(deriveCapabilities({ bitNode: 10, sourceFiles: {} }).unlocked.sleeves).toBe("yes");
    expect(deriveCapabilities({ bitNode: 1, sourceFiles: { "10": 1 } }).unlocked.sleeves).toBe("yes");
    expect(deriveCapabilities({ bitNode: 1, sourceFiles: { "4": 3 } }).unlocked.factions).toBe("yes");
    expect(deriveCapabilities({ bitNode: 1, sourceFiles: {} }).unlocked.factions).toBe("no");
  });

  test("an in-gang reading beats the BitNode test", () => {
    // SF2 plus karma grants a gang outside BN2, which is why gang uses the
    // live inGang() flag rather than a node check.
    expect(deriveCapabilities({ bitNode: 1, sourceFiles: { "2": 1 }, inGang: true }).unlocked.gang).toBe("yes");
  });

  test("sfLevel tolerates a missing map", () => {
    expect(sfLevel(undefined, 4)).toBe(0);
    expect(sfLevel({ "4": 3 }, 4)).toBe(3);
  });
});

/** A value that satisfies whatever a probe body does to it: callable, any
 * property, iterable, array-like, number-coercible. Probe bodies are only
 * exercised for the SHAPE of what they emit, never for correct values, so a
 * self-similar stand-in beats hand-writing an ns mock per feature.
 *
 * The target must be an arrow function: a normal function has a
 * non-configurable `prototype`, which trips the proxy invariant as soon as a
 * body calls Object.keys/entries on a result. */
function universal(): never {
  const target = (() => {}) as never;
  return new Proxy(target, {
    apply: () => universal(),
    ownKeys: () => [],
    getOwnPropertyDescriptor: () => undefined,
    get(_target, prop) {
      if (prop === Symbol.iterator) {
        return function* () {
          yield universal();
          yield universal();
        };
      }
      if (prop === Symbol.toPrimitive) return () => 1;
      // Must not look like a promise, or `await` would hang on it.
      if (prop === "then" || prop === "constructor") return undefined;
      if (prop === "length") return 2;
      if (prop === "map") return (fn: (v: unknown, i: number) => unknown) => [fn(universal(), 0), fn(universal(), 1)];
      if (prop === "slice" || prop === "filter" || prop === "sort" || prop === "concat") return () => [universal()];
      if (prop === "toFixed") return () => "1";
      return universal();
    },
  }) as never;
}

const probeContext = {
  player: {
    factions: ["CyberSec"],
    jobs: { ECorp: "Software" },
    karma: -1,
    numPeopleKilled: 0,
    skills: {},
    exp: {},
    city: "Sector-12",
    location: "home",
    entropy: 0,
    totalPlaytime: 1,
  },
  servers: {
    home: { hostname: "home", maxRam: 64, ramUsed: 8, cpuCores: 1, hasAdminRights: true, purchasedByPlayer: false },
  },
  caps: deriveCapabilities({ bitNode: 1 }),
} as never;

async function runAllProbes(): Promise<{
  emissions: Map<string, { key: string; data: unknown }[]>;
  threw: string[];
}> {
  const emissions = new Map<string, { key: string; data: unknown }[]>();
  const threw: string[] = [];
  for (const probe of [...LOCAL_PROBES, ...DODGED_PROBES]) {
    try {
      const emitted = probe.kind === "local" ? probe.run(probeContext) : await probe.run(universal(), probeContext);
      emissions.set(probe.id, emitted);
    } catch (error) {
      threw.push(`${probe.id}: ${String(error).slice(0, 120)}`);
    }
  }
  return { emissions, threw };
}

describe("probe table", () => {
  const allProbes = [...LOCAL_PROBES, ...DODGED_PROBES];

  test("probe ids are unique and attach to real features", () => {
    expect(new Set(allProbes.map((p) => p.id)).size).toBe(allProbes.length);
    for (const probe of allProbes) {
      expect(FEATURE_IDS, `${probe.id} has feature ${probe.feature}`).toContain(probe.feature);
      if (probe.requires) expect(FEATURE_IDS).toContain(probe.requires);
    }
  });

  test("every ns method a probe declares exists in the type definitions", () => {
    // A typo here is silent at runtime: getFunctionRamCost throws, the runner
    // falls back to a guessed price, and the probe may never run. Both halves
    // of a dotted name are checked — the namespace must be a real property of
    // the NS interface, and the leaf must be a declared method somewhere.
    const names = [...DODGED_PROBES.flatMap((p) => p.methods), ...GATE_PROBE.methods];
    const missing: string[] = [];
    for (const name of names) {
      const segments = name.split(".");
      const leaf = segments[segments.length - 1]!;
      // Namespaces are declared `readonly gang: Gang;` on the NS interface.
      if (segments.length > 1 && !new RegExp(`^\\s*(readonly\\s+)?${segments[0]}:\\s*\\w`, "m").test(nsDefs)) {
        missing.push(`${name} (no ns.${segments[0]} namespace)`);
        continue;
      }
      if (!new RegExp(`(^|\\s)${leaf}\\s*[(<]`, "m").test(nsDefs)) missing.push(`${name} (no such method)`);
    }
    expect(missing).toEqual([]);
  });

  test("every feature with a topic is reachable by some probe", () => {
    const probed = new Set(allProbes.map((p) => p.feature));
    // Every feature except those with no ns surface must have a probe.
    for (const feature of FEATURES) {
      expect(probed.has(feature.id), `${feature.id} has no probe`).toBe(true);
    }
  });

  test("every probe body runs and emits at least one topic", async () => {
    const { emissions, threw } = await runAllProbes();
    expect(threw).toEqual([]);
    for (const probe of allProbes) {
      expect(emissions.get(probe.id)?.length, `${probe.id} emitted nothing`).toBeGreaterThan(0);
    }
  });

  test("no two probes on one topic write the same field", async () => {
    // Topic merges are SHALLOW (`{...prev, ...next}`), so when a fast `core`
    // probe and a slow detail probe both write a field, the faster one wins
    // and silently replaces real data with whatever it could afford — a panel
    // that blanks on a cadence rather than an error. Asserted by actually
    // running the bodies: reading the source cannot see shorthand emits.
    //
    // Exception: a probe MAY rewrite a field if it republishes the complete
    // value. hacking.cloud rebuilds the whole FleetRollup through fleetFrom,
    // and `joined` is the same Player-derived list wherever it appears.
    const SHARED_OK = new Set(["fleet:*", "factions:joined"]);
    const { emissions } = await runAllProbes();
    const owners = new Map<string, Set<string>>();
    for (const [id, emitted] of emissions) {
      for (const { key, data } of emitted) {
        if (SHARED_OK.has(`${key}:*`)) continue;
        for (const field of Object.keys(data as object)) {
          const owned = `${key}:${field}`;
          if (SHARED_OK.has(owned)) continue;
          owners.set(owned, (owners.get(owned) ?? new Set()).add(id));
        }
      }
    }
    const contested = [...owners.entries()]
      .filter(([, ids]) => ids.size > 1)
      .map(([field, ids]) => `${field} written by ${[...ids].join(" and ")}`);
    expect(contested).toEqual([]);
  });

  test("cadences are plain literals so --perf can tree-shake the table", () => {
    // Guards the esbuild purity trap: `2 * MINUTE` in an initializer pins the
    // whole probe object into performance bundles.
    const source = readFileSync(resolve(root, "game/lib/probes/dodged.ts"), "utf8");
    expect(source).not.toMatch(/everyMs:\s*\d+\s*\*/);
  });
});

describe("telemetry payloads survive JSON", () => {
  test("a Map in a payload would serialize to nothing", () => {
    // The trap this guards: ResetInfo hands back Maps, and JSON.stringify
    // turns them into {}. Probes must flatten with Object.fromEntries.
    expect(JSON.stringify({ ownedSF: new Map([[4, 3]]) })).toBe('{"ownedSF":{}}');
    const flattened = Object.fromEntries(new Map([[4, 3]]));
    expect(JSON.parse(JSON.stringify({ sourceFiles: flattened })).sourceFiles).toEqual({ "4": 3 });
  });

  test("capabilities round-trip intact", () => {
    const caps = deriveCapabilities({ bitNode: 12, sourceFiles: { "4": 3 }, inGang: false });
    const back = JSON.parse(JSON.stringify(caps)) as typeof caps;
    expect(back.sourceFiles).toEqual({ "4": 3 });
    expect(back.unlocked.factions).toBe("yes");
    expect(back.unlocked.gang).toBe("no");
  });
});
