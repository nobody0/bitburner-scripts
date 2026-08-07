import { FEATURE_IDS, type FeatureId } from "./ids.ts";

/** Which features this save can actually play, derived from readings the game
 * probe collects almost for free. Pure so the simulator can synthesize the
 * same shape for a hypothetical BitNode without an ns call.
 *
 * "unknown" is meaningful: it means the gate itself failed (an ns call threw,
 * or the probe was skipped for RAM), NOT that the feature is locked. The UI
 * distinguishes the two — a locked tab explains itself, an unknown one says
 * we have not looked yet. */

export type UnlockState = "yes" | "no" | "unknown";

/** Everything the 0 GB-ish gate batch can see. All optional: a gate that was
 * skipped or threw leaves its field undefined and yields "unknown". */
export interface GateReadings {
  bitNode?: number;
  /** ResetInfo.ownedSF flattened (Map does not survive JSON). SF n -> level. */
  sourceFiles?: Record<string, number>;
  inGang?: boolean;
  inBladeburner?: boolean;
  hasCorporation?: boolean;
  hasWseAccount?: boolean;
  hasTixApiAccess?: boolean;
  /** ns.go.getGameState() succeeded — IPvGO is reachable. */
  goPlayable?: boolean;
}

export interface Capabilities {
  bitNode: number | undefined;
  sourceFiles: Record<string, number>;
  unlocked: Record<FeatureId, UnlockState>;
  /** Why a feature is not "yes". Present for every non-"yes" entry. */
  reason: Partial<Record<FeatureId, string>>;
}

/** Source file level for SF n, or 0. */
export function sfLevel(sourceFiles: Record<string, number> | undefined, n: number): number {
  return sourceFiles?.[String(n)] ?? 0;
}

/** In BitNode n, or holding its source file. This is the standard "can I use
 * this API" test for the node-gated features. */
function hasNode(r: GateReadings, n: number): UnlockState {
  if (r.bitNode === undefined) return "unknown";
  if (r.bitNode === n || sfLevel(r.sourceFiles, n) > 0) return "yes";
  return "no";
}

function fromFlag(flag: boolean | undefined): UnlockState {
  return flag === undefined ? "unknown" : flag ? "yes" : "no";
}

export function deriveCapabilities(r: GateReadings): Capabilities {
  const unlocked = {} as Record<FeatureId, UnlockState>;
  const reason: Partial<Record<FeatureId, string>> = {};
  const set = (id: FeatureId, state: UnlockState, why: string) => {
    unlocked[id] = state;
    if (state !== "yes") reason[id] = state === "unknown" ? "not probed yet" : why;
  };

  // Always playable.
  set("progression", "yes", "");
  set("hacking", "yes", "");
  set("career", "yes", "");
  set("hacknet", "yes", "");
  set("side", "yes", "");

  // Singularity gates the *automation*, not the game systems: without SF4 the
  // faction/augmentation getters cost 16x and are usually unaffordable, so we
  // treat SF4 as the unlock for the panel's data.
  set("factions", hasNode(r, 4), "requires BN4 or SF4 (Singularity) for the faction/augmentation API");

  set("stock", fromFlag(r.hasWseAccount), "requires a WSE account (and TIX API access for positions)");
  set("gang", fromFlag(r.inGang), "requires a gang — BN2, or SF2 plus enough negative karma");
  set("corp", fromFlag(r.hasCorporation), "requires a corporation — BN3, or SF3 plus the seed money");
  set("bladeburner", fromFlag(r.inBladeburner), "requires the Bladeburner division — BN6/BN7, or SF6");
  set("sleeves", hasNode(r, 10), "requires BN10 or SF10 (Digital Carbon)");
  set("go", fromFlag(r.goPlayable), "IPvGO is unreachable");
  set("stanek", hasNode(r, 13), "requires BN13 or SF13 (Stanek's Gift)");
  set("dnet", hasNode(r, 15), "requires BN15 or SF15 (the Dark Net)");

  // Anything the table above forgot stays explicitly unknown rather than
  // silently absent — Record<FeatureId, ...> must be total for the UI.
  for (const id of FEATURE_IDS) {
    if (unlocked[id] === undefined) set(id, "unknown", "");
  }

  return {
    bitNode: r.bitNode,
    sourceFiles: r.sourceFiles ?? {},
    unlocked,
    reason,
  };
}

/** Capabilities with nothing probed yet — the UI's initial state. */
export function unknownCapabilities(): Capabilities {
  return deriveCapabilities({});
}

export interface CapsDelta {
  /** Features that became playable. */
  unlocked: FeatureId[];
  /** Features that stopped being playable (a reset dropped a gang, say). */
  locked: FeatureId[];
  /** The active BitNode changed under a live realm — everything the controller
   *  cached about the world is now about a game that no longer exists. */
  bitNodeChanged: boolean;
}

/** What changed between two capability readings. Pure, so the controller and
 * the simulator agree on what counts as an unlock.
 *
 * Only `no | unknown -> yes` is an unlock: `unknown -> no` is the gate finally
 * reporting, not a feature being taken away. `bitNodeChanged` needs BOTH
 * readings known — `undefined -> 1` is the first successful gate batch, not a
 * node reset, and treating it as one would wipe the fleet on every cold boot. */
export function capsDelta(before: Capabilities, after: Capabilities): CapsDelta {
  const unlocked: FeatureId[] = [];
  const locked: FeatureId[] = [];
  for (const id of FEATURE_IDS) {
    const was = before.unlocked[id];
    const now = after.unlocked[id];
    if (was === now) continue;
    if (now === "yes") unlocked.push(id);
    else if (was === "yes") locked.push(id);
  }
  const bitNodeChanged =
    before.bitNode !== undefined && after.bitNode !== undefined && before.bitNode !== after.bitNode;
  return { unlocked, locked, bitNodeChanged };
}
