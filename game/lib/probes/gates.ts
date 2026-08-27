import type { NsProxy } from "../ns-proxy.ts";
import { deriveCapabilities, type Capabilities, type GateReadings } from "../../../shared/features/unlock.ts";
import type { Progression } from "../../../shared/telemetry/topics/progression.ts";

/** The capability gate batch — the cheapest and most valuable probe we have.
 *
 * Every unlock test the game offers is free or nearly so: gang.inGang,
 * bladeburner.inBladeburner, corporation.hasCorporation and go.getGameState
 * are 0 GB. Adding ns.getResetInfo plus the 0.1 GB Darkscape program check
 * keeps the batch affordable on a fresh 8 GB home while filling in the entire
 * tab bar and the BitNode tab.
 * Source: https://github.com/bitburner-official/bitburner-src/blob/3162fd2590e221eadd0c0fbd46151913f7c4c41c/src/Netscript/RamCostGenerator.ts#L123-L130 and https://github.com/bitburner-official/bitburner-src/blob/3162fd2590e221eadd0c0fbd46151913f7c4c41c/src/Netscript/RamCostGenerator.ts#L269-L307 and https://github.com/bitburner-official/bitburner-src/blob/3162fd2590e221eadd0c0fbd46151913f7c4c41c/src/Netscript/RamCostGenerator.ts#L333-L335 and https://github.com/bitburner-official/bitburner-src/blob/3162fd2590e221eadd0c0fbd46151913f7c4c41c/src/Netscript/RamCostGenerator.ts#L466-L468
 *
 * Every call is individually guarded so a future API/access failure cannot
 * cost us the rest of the batch. In v3.0.1 these particular predicates are
 * total and return false when the player has not joined/created the subsystem.
 * Source: https://github.com/bitburner-official/bitburner-src/blob/3162fd2590e221eadd0c0fbd46151913f7c4c41c/src/NetscriptFunctions/Gang.ts#L53-L55 and https://github.com/bitburner-official/bitburner-src/blob/3162fd2590e221eadd0c0fbd46151913f7c4c41c/src/NetscriptFunctions/Bladeburner.ts#L73-L76 and https://github.com/bitburner-official/bitburner-src/blob/3162fd2590e221eadd0c0fbd46151913f7c4c41c/src/NetscriptFunctions/Corporation.ts#L617-L623
 * A field left undefined becomes "unknown", which the UI renders differently
 * from "locked". */

export interface GateResult {
  caps: Capabilities;
  progression?: Progression;
  /** Probe ids that threw, for a single aggregated probe.failed event. */
  failures: string[];
}

/** Each reading is guarded on its own, so one unavailable subsystem costs
 * this batch a single field rather than every field after it. */
async function attempt<T>(failures: string[], id: string, fn: () => Promise<T>): Promise<T | undefined> {
  try {
    return await fn();
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

/** Reads every gate through the ns resident. Nothing to budget: the resident
 * prices each member as it first calls it, and these are all free or nearly so
 * — ns.getResetInfo at 1 GB is the batch's only real cost. */
export async function runGates(nsp: NsProxy): Promise<GateResult> {
  const failures: string[] = [];
  const readings: GateReadings = {};

  const reset = await attempt(failures, "getResetInfo", () => nsp("getResetInfo"));
  let progression: Progression | undefined;
  if (reset) {
    // ownedSF is already the active-level map with per-run overrides folded
    // in. Source: https://github.com/bitburner-official/bitburner-src/blob/3162fd2590e221eadd0c0fbd46151913f7c4c41c/src/PersonObjects/Player/PlayerObject.ts#L93-L95 and https://github.com/bitburner-official/bitburner-src/blob/3162fd2590e221eadd0c0fbd46151913f7c4c41c/src/NetscriptFunctions.ts#L1486-L1500
    const sourceFiles = fromMap(reset.ownedSF);
    const ownedAugs = fromMap(reset.ownedAugs);
    readings.bitNode = reset.currentNode;
    readings.sourceFiles = sourceFiles;
    readings.hasStaneksGift = (ownedAugs["Stanek's Gift - Genesis"] ?? 0) > 0;
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
        disable4SData: reset.bitNodeOptions?.disable4SData,
        disableHacknetServer: reset.bitNodeOptions?.disableHacknetServer,
        disableSleeveExpAndAugmentation: reset.bitNodeOptions?.disableSleeveExpAndAugmentation,
      },
    };
  }

  readings.inGang = await attempt(failures, "gang.inGang", () => nsp("gang.inGang"));
  readings.inBladeburner = await attempt(failures, "bladeburner.inBladeburner", () =>
    nsp("bladeburner.inBladeburner"),
  );
  readings.hasCorporation = await attempt(failures, "corporation.hasCorporation", () =>
    nsp("corporation.hasCorporation"),
  );
  // No boolean form exists: reaching a game state at all means IPvGO is there.
  // v3.0.1 exposes this getter without a BN/SF access check.
  // Source: https://github.com/bitburner-official/bitburner-src/blob/3162fd2590e221eadd0c0fbd46151913f7c4c41c/src/NetscriptFunctions/Go.ts#L69-L77
  readings.goPlayable = await attempt(failures, "go.getGameState", async () => {
    await nsp("go.getGameState");
    return true;
  });
  // Player.hasProgram checks home's program list; fileExists(home) observes
  // the same thing through Netscript.
  // Source: https://github.com/bitburner-official/bitburner-src/blob/3162fd2590e221eadd0c0fbd46151913f7c4c41c/src/PersonObjects/Player/PlayerObjectGeneralMethods.ts#L203-L206
  readings.hasDarknetProgram = await attempt(failures, "fileExists:DarkscapeNavigator.exe", () =>
    nsp("fileExists", "DarkscapeNavigator.exe", "home"));

  return { caps: deriveCapabilities(readings), progression, failures };
}

export const GATE_PROBE = {
  id: "gates",
  run: runGates,
};
