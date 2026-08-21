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

/** The subset of ResetInfo.bitNodeOptions that changes what we may play.
 *
 * These are per-run toggles chosen when entering the node, so holding a source
 * file is NO LONGER sufficient for "this feature is available" — a run can
 * carry SF2 and still forbid gangs. Undefined means the option was not read. */
export interface BitNodeDisables {
  disableGang?: boolean;
  disableCorporation?: boolean;
  disableBladeburner?: boolean;
  disable4SData?: boolean;
  disableHacknetServer?: boolean;
  disableSleeveExpAndAugmentation?: boolean;
  restrictHomePCUpgrade?: boolean;
}

/** Everything the 0 GB-ish gate batch can see. All optional: a gate that was
 * skipped or threw leaves its field undefined and yields "unknown". */
export interface GateReadings {
  bitNode?: number;
  /** ResetInfo.ownedSF flattened (Map does not survive JSON). SF n -> level.
   *  Already ACTIVE levels — the game folds `sourceFileOverrides` in before
   *  handing this over, so callers must not apply the overrides again.
   *  Source: https://github.com/bitburner-official/bitburner-src/blob/3162fd2590e221eadd0c0fbd46151913f7c4c41c/src/NetscriptFunctions.ts#L716-L733 */
  sourceFiles?: Record<string, number>;
  /** ResetInfo.bitNodeOptions, the per-run feature switches. */
  bitNodeOptions?: BitNodeDisables;
  inGang?: boolean;
  inBladeburner?: boolean;
  hasCorporation?: boolean;
  hasWseAccount?: boolean;
  hasTixApiAccess?: boolean;
  /** ns.go.getGameState() succeeded — IPvGO is reachable. */
  goPlayable?: boolean;
  /** ResetInfo confirms that Stanek's Gift - Genesis is installed. */
  hasStaneksGift?: boolean;
  /** DarkscapeNavigator.exe exists on home, the alternative to BN15/SF15. */
  hasDarknetProgram?: boolean;
}

export interface Capabilities {
  bitNode: number | undefined;
  sourceFiles: Record<string, number>;
  unlocked: Record<FeatureId, UnlockState>;
  /** Why a feature is not "yes". Present for every non-"yes" entry. */
  reason: Partial<Record<FeatureId, string>>;
  /** Options that degrade a feature we can still play, so a driver can lower
   *  its ambition instead of discovering the restriction by failing. Distinct
   *  from `unlocked`, which is about whether we may play it at all. */
  restrictions: BitNodeDisables;
  /** Upstream has TWO darknet gates and they are not the same test:
   *
   *    hasDarknetAccess()     = BN15 || SF15 || DarkscapeNavigator.exe
   *    hasFullDarknetAccess() = BN15 || SF15
   *
   *  `unlocked.dnet` is the first — whether the `ns.dnet` API answers at all.
   *  This is the second, and it is what gates the LABYRINTH: without it
   *  `getLabyrinthDetails()` returns `lab: null` and the net stays at depth 5,
   *  so there are no labyrinth augmentations and no Red Pill route. Buying the
   *  program grants access without granting this.
   *  Source: https://github.com/bitburner-official/bitburner-src/blob/3162fd2590e221eadd0c0fbd46151913f7c4c41c/src/DarkNet/effects/effects.ts#L280
   *  Source: https://github.com/bitburner-official/bitburner-src/blob/3162fd2590e221eadd0c0fbd46151913f7c4c41c/src/DarkNet/effects/labyrinth.ts#L486-L496 */
  darknetFullAccess: UnlockState;
}

/** Source file level for SF n, or 0. */
export function sfLevel(sourceFiles: Record<string, number> | undefined, n: number): number {
  return sourceFiles?.[String(n)] ?? 0;
}

/** In BitNode n, or holding its active source file. This is the game's standard
 * node-feature access rule.
 * Source: https://github.com/bitburner-official/bitburner-src/blob/3162fd2590e221eadd0c0fbd46151913f7c4c41c/src/BitNode/BitNodeUtils.ts#L19-L21 */
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
  const set = (id: FeatureId, state: UnlockState, because: string) => {
    unlocked[id] = state;
    if (state !== "yes") reason[id] = state === "unknown" ? "not probed yet" : because;
  };

  // Always playable.
  set("progression", "yes", "");
  set("hacking", "yes", "");
  set("career", "yes", "");
  set("hacknet", "yes", "");
  set("side", "yes", "");
  // The market is MONEY-gated, not capability-gated, which is why it belongs
  // here rather than behind `hasWseAccount`. A WSE account costs $200m and the
  // TIX API $5b; BN8/SF8 also grants both on prestige, but neither flag is a
  // prerequisite for the driver to begin climbing the ladder. Gating the
  // feature on the account instead made the
  // purchase unreachable: a driver never runs while its own feature reads "no",
  // so nothing could ever buy the thing that would unlock it. The account flags
  // travel as ordinary state on the topic and the driver climbs the ladder
  // itself; `restrictions.disable4SData` still tells it when the forecast cannot
  // be bought at all.
  // Source: https://github.com/bitburner-official/bitburner-src/blob/3162fd2590e221eadd0c0fbd46151913f7c4c41c/src/StockMarket/data/Constants.ts#L3-L12
  // Source: https://github.com/bitburner-official/bitburner-src/blob/3162fd2590e221eadd0c0fbd46151913f7c4c41c/src/Prestige.ts#L163-L168
  set("stock", "yes", "");

  // Singularity gates the *automation*, not the game systems: without SF4 the
  // faction/augmentation getters cost 16x and are usually unaffordable, so we
  // treat SF4 as the unlock for the panel's data.
  set("factions", hasNode(r, 4), "requires BN4 or SF4 (Singularity) for the faction/augmentation API");

  set("gang", fromFlag(r.inGang), "requires a gang — BN2, or SF2 plus karma <= -54,000");
  set("corp", fromFlag(r.hasCorporation), "requires a corporation — BN3, or SF3 plus the seed money");
  // Both the division and its ns API are gated on BN6/SF6 OR BN7/SF7.
  // Source: https://github.com/bitburner-official/bitburner-src/blob/3162fd2590e221eadd0c0fbd46151913f7c4c41c/src/NetscriptFunctions/Bladeburner.ts#L43-L57
  set("bladeburner", fromFlag(r.inBladeburner), "requires the Bladeburner division — BN6/BN7, or SF6/SF7");
  // Source: https://github.com/bitburner-official/bitburner-src/blob/3162fd2590e221eadd0c0fbd46151913f7c4c41c/src/NetscriptFunctions/Sleeve.ts
  set("sleeves", hasNode(r, 10), "requires BN10 or SF10 (Digital Carbon)");
  // Source: https://github.com/bitburner-official/bitburner-src/blob/3162fd2590e221eadd0c0fbd46151913f7c4c41c/src/NetscriptFunctions/Go.ts
  set("go", fromFlag(r.goPlayable), "IPvGO is unreachable");
  // Every Stanek getter/action except acceptGift checks the installed Genesis
  // augmentation, not BN13/SF13. A node/source file only makes accepting the
  // gift possible; it does not make the rest of the API callable.
  // Source: https://github.com/bitburner-official/bitburner-src/blob/3162fd2590e221eadd0c0fbd46151913f7c4c41c/src/NetscriptFunctions/Stanek.ts#L17-L22
  set("stanek", fromFlag(r.hasStaneksGift), "requires the installed Stanek's Gift - Genesis augmentation");

  // Darknet access is granted by BN15/SF15 OR DarkscapeNavigator.exe.
  // Source: https://github.com/bitburner-official/bitburner-src/blob/3162fd2590e221eadd0c0fbd46151913f7c4c41c/src/DarkNet/utils/darknetAuthUtils.ts#L5-L8
  const dnetNode = hasNode(r, 15);
  const dnetAccess: UnlockState = dnetNode === "yes" || r.hasDarknetProgram === true
    ? "yes"
    : dnetNode === "unknown" || r.hasDarknetProgram === undefined ? "unknown" : "no";
  set("dnet", dnetAccess, "requires BN15, active SF15, or DarkscapeNavigator.exe");

  // BitNode options veto LAST, and only where the option removes the feature
  // outright. A run may hold SF2 and still forbid gangs, so a source file is
  // not sufficient evidence any more.
  //
  // The other four options degrade rather than remove — hacknet is still
  // playable without hacknet servers, stock without 4S, sleeves without exp
  // and augmentations — so they travel in `restrictions` for the drivers to
  // read, and are deliberately NOT allowed to flip a feature to "no".
  // Source: https://github.com/bitburner-official/bitburner-src/blob/3162fd2590e221eadd0c0fbd46151913f7c4c41c/src/BitNode/BitNode.tsx
  const options = r.bitNodeOptions ?? {};
  const veto = (id: FeatureId, disabled: boolean | undefined, because: string) => {
    if (disabled === true) set(id, "no", because);
  };
  veto("gang", options.disableGang, "gangs are disabled by this BitNode's options");
  veto("corp", options.disableCorporation, "corporations are disabled by this BitNode's options");
  veto("bladeburner", options.disableBladeburner, "Bladeburner is disabled by this BitNode's options");

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
    restrictions: { ...options },
    darknetFullAccess: dnetNode,
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
}

/** What changed between two capability readings. Pure, so the controller and
 * the simulator agree on what counts as an unlock.
 *
 * Only `no | unknown -> yes` is an unlock: `unknown -> no` is the gate finally
 * reporting, not a feature being taken away. Prestige classification is
 * deliberately separate: node number alone misses augmentation installs and
 * same-node Source-File resets; shared/reset.ts compares the reset epochs. */
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
  return { unlocked, locked };
}
