import type { NS } from "@ns";
import { deriveCapabilities, type Capabilities, type GateReadings } from "../../../shared/features/unlock.ts";
import type { Progression } from "../../../shared/telemetry/topics/progression.ts";

/** The capability gate batch — the cheapest and most valuable probe we have.
 *
 * Every unlock test the game offers is free or nearly so: gang.inGang,
 * bladeburner.inBladeburner, corporation.hasCorporation and go.getGameState
 * are 0 GB; the two stock account checks are 0.05 GB each. Add
 * ns.getResetInfo at 1 GB and the whole batch costs ~1.1 GB — affordable on a
 * fresh 8 GB home — while filling in the entire tab bar AND the BitNode tab.
 *
 * Every call is individually guarded: these getters throw rather than return
 * false in several BitNodes, and one throw must not cost us the rest of the
 * batch. A field left undefined becomes "unknown", which the UI renders
 * differently from "locked". */

export const GATE_COST_GB = 1.5;

export const GATE_METHODS = [
  "getResetInfo",
  "gang.inGang",
  "bladeburner.inBladeburner",
  "corporation.hasCorporation",
  "stock.hasWseAccount",
  "stock.hasTixApiAccess",
  "go.getGameState",
] as const;

export interface GateResult {
  caps: Capabilities;
  progression?: Progression;
  /** Probe ids that threw, for a single aggregated probe.failed event. */
  failures: string[];
}

function attempt<T>(failures: string[], id: string, fn: () => T): T | undefined {
  try {
    return fn();
  } catch {
    failures.push(id);
    return undefined;
  }
}

/** Maps do not survive JSON.stringify — `{}` is what the UI would receive.
 * Every Map that crosses the wire goes through here. */
function fromMap<K extends string | number>(map: Map<K, number> | undefined): Record<string, number> {
  if (!map || typeof map.entries !== "function") return {};
  const out: Record<string, number> = {};
  for (const [key, value] of map) out[String(key)] = value;
  return out;
}

/** Runs inside a dodge stub. Budget: GATE_COST_GB. */
export function runGates(stubNs: NS): GateResult {
  const failures: string[] = [];
  const readings: GateReadings = {};

  const reset = attempt(failures, "getResetInfo", () => stubNs["getResetInfo"]());
  let progression: Progression | undefined;
  if (reset) {
    const sourceFiles = fromMap(reset.ownedSF);
    const ownedAugs = fromMap(reset.ownedAugs);
    readings.bitNode = reset.currentNode;
    readings.sourceFiles = sourceFiles;
    // The same options the telemetry topic carries, but ALSO fed to the
    // capability derivation: a run can hold SF2 and still forbid gangs, so
    // deriving unlocks from source files alone reports features we cannot play.
    readings.bitNodeOptions = {
      disableGang: reset.bitNodeOptions?.disableGang,
      disableCorporation: reset.bitNodeOptions?.disableCorporation,
      disableBladeburner: reset.bitNodeOptions?.disableBladeburner,
      disable4SData: reset.bitNodeOptions?.disable4SData,
      disableHacknetServer: reset.bitNodeOptions?.disableHacknetServer,
      disableSleeveExpAndAugmentation: reset.bitNodeOptions?.disableSleeveExpAndAugmentation,
      restrictHomePCUpgrade: reset.bitNodeOptions?.restrictHomePCUpgrade,
    };
    progression = {
      bitNode: reset.currentNode,
      sourceFiles,
      ownedAugs,
      augCount: Object.keys(ownedAugs).length,
      lastAugReset: reset.lastAugReset,
      lastNodeReset: reset.lastNodeReset,
      bitNodeOptions: {
        sourceFileOverrides: fromMap(reset.bitNodeOptions?.sourceFileOverrides),
        intelligenceOverride: reset.bitNodeOptions?.intelligenceOverride,
        restrictHomePCUpgrade: reset.bitNodeOptions?.restrictHomePCUpgrade,
        disableGang: reset.bitNodeOptions?.disableGang,
        disableCorporation: reset.bitNodeOptions?.disableCorporation,
        disableBladeburner: reset.bitNodeOptions?.disableBladeburner,
        disableHacknetServer: reset.bitNodeOptions?.disableHacknetServer,
        disableSleeveExpAndAugmentation: reset.bitNodeOptions?.disableSleeveExpAndAugmentation,
      },
    };
  }

  readings.inGang = attempt(failures, "gang.inGang", () => stubNs["gang"]["inGang"]());
  readings.inBladeburner = attempt(failures, "bladeburner.inBladeburner", () =>
    stubNs["bladeburner"]["inBladeburner"](),
  );
  readings.hasCorporation = attempt(failures, "corporation.hasCorporation", () =>
    stubNs["corporation"]["hasCorporation"](),
  );
  readings.hasWseAccount = attempt(failures, "stock.hasWseAccount", () => stubNs["stock"]["hasWseAccount"]());
  readings.hasTixApiAccess = attempt(failures, "stock.hasTixApiAccess", () => stubNs["stock"]["hasTixApiAccess"]());
  // No boolean form exists: reaching a game state at all means IPvGO is there.
  readings.goPlayable = attempt(failures, "go.getGameState", () => {
    stubNs["go"]["getGameState"]();
    return true;
  });

  return { caps: deriveCapabilities(readings), progression, failures };
}

export const GATE_PROBE = {
  id: "gates",
  methods: GATE_METHODS as readonly string[],
  cost: GATE_COST_GB,
  run: runGates,
};
