/** Darknet timing, transcribed from the pinned checkout.
 *
 * These are the numbers the staleness rule is derived from, so they are kept in
 * one place with their citations rather than inlined at the call sites.
 * Source: ../bitburner-src at 3162fd2590e221eadd0c0fbd46151913f7c4c41c
 *   src/DarkNet/Enums.ts
 *   src/DarkNet/utils/darknetNetworkUtils.ts  (getDarknetCyclesPerMutation)
 *   src/DarkNet/controllers/NetworkMovement.ts (mutateDarknet)
 *   src/DarkNet/effects/labyrinth.ts          (getNetDepth) */

/** Columns the net is built on. `DarknetState.Network[depth][leftOffset]` is
 * indexed by these two, and `leftOffset` is the half scripts are never told.
 * Source: src/DarkNet/Enums.ts:7 */
export const NET_WIDTH = 8;
/** The deepest row that can exist, whatever the labyrinth says.
 * Source: src/DarkNet/Enums.ts:8 */
export const MAX_NET_DEPTH = 40;
/** Depths that are structurally EMPTY: 8, 16, 24, 32.
 *
 * `isOnAirGap(x) = !!x && !(x % AIR_GAP_DEPTH)`, and `getAllOpenPositions` skips
 * them, so no host is ever seated there. Since vertical wiring only ever reaches
 * depth +- 1, an air gap means depth 7 and depth 9 are never adjacent — the net
 * is genuinely segmented, which is what the name says and what a map that
 * silently omits empty rows hides.
 * Source: src/DarkNet/Enums.ts:6, src/DarkNet/utils/darknetNetworkUtils.ts:103 */
export const AIR_GAP_DEPTH = 8;

export function isOnAirGap(depth: number): boolean {
  return depth > 0 && depth % AIR_GAP_DEPTH === 0;
}

/** The labyrinth ladder: the eight lab servers, the net depth each one implies,
 * and the charisma it gates on.
 *
 * `getNetDepth()` IS the current lab's depth, so a single sighting of any lab
 * host pins the size of the whole net exactly — the deepest row, and therefore
 * how much of the grid we have never seen. That is the one number a crawler can
 * learn for free and the map has been leaving on the floor.
 *
 * All eight are constructed at once by `addLabyrinth`, every one of them with
 * `depth: -1, leftOffset: -1`, and the renderer pins them to `getNetDepth() +
 * 0.5` instead. So the reported depth of a lab host is NOT its position, and
 * anything that sorts by depth will otherwise put the goal above the root.
 * Source: src/DarkNet/effects/labyrinth.ts (labData, getNetDepth),
 *   src/Server/data/SpecialServers.ts:13-20,
 *   src/DarkNet/controllers/NetworkGenerator.ts:235-261 */
export interface LabStage {
  hostname: string;
  /** The whole net's depth while this lab is the current one. */
  depth: number;
  cha: number;
  /** Solved through the UI maze rather than by a script. */
  manual: boolean;
}

export const LAB_LADDER: readonly LabStage[] = [
  { hostname: "th3_l4byr1nth", depth: 7, cha: 300, manual: true },
  { hostname: "cru3l_l4byr1nth", depth: 12, cha: 600, manual: true },
  { hostname: "m3rc1l3ss_l4byr1nth", depth: 19, cha: 1_500, manual: false },
  { hostname: "ub3r_l4byr1nth", depth: 23, cha: 2_500, manual: false },
  { hostname: "et3rn4l_l4byr1nth", depth: 29, cha: 3_000, manual: false },
  { hostname: "end13ss_l4byr1nth", depth: 31, cha: 3_500, manual: false },
  { hostname: "f1n4l_l4byr1nth", depth: 36, cha: 4_000, manual: false },
  { hostname: "b0nus_l4byr1nth", depth: 36, cha: 4_000, manual: false },
];

const LAB_BY_HOST = new Map(LAB_LADDER.map((stage) => [stage.hostname, stage]));

/** The model id every lab host reports. Source: src/DarkNet/Enums.ts (ModelIds.labyrinth) */
export const LABYRINTH_MODEL_ID = "(The Labyrinth)";

export function labStage(hostname: string): LabStage | undefined {
  return LAB_BY_HOST.get(hostname);
}

/** Whether this host is a labyrinth, by either of the two things that identify
 * one. The model id is the more robust of the two: it survives a rename, and it
 * is what an agent sees first. */
export function isLabyrinth(hostname: string, modelId?: string): boolean {
  return LAB_BY_HOST.has(hostname) || modelId === LABYRINTH_MODEL_ID;
}

/** The net's depth, inferred from the deepest labyrinth we have laid eyes on.
 *
 * Undefined when we have seen none — which is honest, and different from the
 * `DEFAULT_NET_DEPTH` fallback the timing functions use. A caller that
 * wants to DRAW the grid needs to know it is guessing. */
export function netDepthFromLabs(hostnames: Iterable<string>): number | undefined {
  let depth: number | undefined;
  for (const hostname of hostnames) {
    const stage = LAB_BY_HOST.get(hostname);
    if (stage && (depth === undefined || stage.depth > depth)) depth = stage.depth;
  }
  return depth;
}

/** The remaining network constants (the connection chances, MAX_PASSWORD_LENGTH)
 * are written up in spec/dnet.md rather than exported here; nothing computes
 * with them yet, and an unused constant is a claim nobody checks. */
/** What darknet access costs, and where it can be bought.
 *
 * `ns.singularity.purchaseProgram` is the only scriptable path and it needs the
 * TOR router first (`NetscriptFunctions/Singularity.ts:429-431`).
 *
 * Not a constant, because no code can use it: the Chongqing "Shadowed Walkway"
 * button sells the same program for **$30m AND grants TOR free** as part of
 * `getDarkscapeNavigator()`, so it strictly dominates — but it is a UI button
 * with no Singularity entry point (`Locations/ui/SpecialLocation.tsx:342-390`).
 * Noted so the cheaper figure is not mistaken for one a script can reach.
 * Source: src/DarkNet/Constants.ts, src/DarkWeb/DarkWebItems.ts:15-19 */
export const DARKSCAPE_COST = 50e6;
/** CONSTANTS.TorRouterCost. A precondition of the scriptable path, and lost at
 * every install alongside the program itself. */
export const TOR_COST = 200e3;

const MS_PER_MUTATION_PER_ROW = 30_000;

const SERVER_DENSITY = 0.6;
/** The depth of a net whose labyrinth we have not identified.
 *
 * `getNetDepth()` reads `getLabyrinthDetails().depth ?? 10`, and that `?? 10` is
 * DEAD: the no-access branch returns a literal `depth: 5` and every lab rung
 * carries a number, so the fallback can never fire. Five is what the game
 * actually runs before full darknet access, and it is the honest default here —
 * ten would be off by a factor of two in `mutationIntervalMs`, which is the
 * clock every staleness expiry is derived from.
 *
 * Source: src/DarkNet/effects/labyrinth.ts:393-396 (getNetDepth),
 *   :485-497 (the no-access branch) */
const DEFAULT_NET_DEPTH = 5;

/** How often the net gets a mutation TICK.
 *
 * `getDarknetCyclesPerMutation` is `(rateMultiplier * 150) / depth` cycles at
 * 200 ms a cycle, where rateMultiplier is 1 in BN15 and 2 everywhere else. So
 * the net churns FASTER the deeper the labyrinth goes, and twice as slowly
 * outside its own BitNode. At the pre-labyrinth depth of 5 in BN15 that is one
 * tick every six seconds; at the first labyrinth's depth of 7, every 4.3. */
export function mutationIntervalMs(netDepth = DEFAULT_NET_DEPTH, bitNode = 15): number {
  const depth = Math.max(1, netDepth);
  return ((bitNode === 15 ? 1 : 2) * MS_PER_MUTATION_PER_ROW) / depth;
}

/** `mutateDarknet` throttles itself on deep nets: it rolls against
 * `16 / depth` and returns early on a miss, so past depth 16 a growing share of
 * ticks do nothing at all. */
function mutationTickEffectiveness(netDepth = DEFAULT_NET_DEPTH): number {
  return Math.min(1, 16 / Math.max(1, netDepth));
}

/** Rough server population, from the generator's own density figures. Used to
 * turn a net-wide churn rate into a per-host one. */
function expectedServerCount(netDepth = DEFAULT_NET_DEPTH): number {
  return Math.max(1, Math.round(netDepth * NET_WIDTH * SERVER_DENSITY));
}

/** What a single mutation tick does to the net, transcribed from the roll list
 * in `mutateDarknet`. Several branches `return` early, so these are the
 * probabilities of REACHING each roll, not the raw literals.
 *
 * Deliberately expressed as hosts-touched-per-tick rather than as a half-life:
 * the aggregate is arithmetic over transcribed constants, but it has not been
 * MEASURED against a running game, and a half-life would read as though it had.
 * `sim/` is where it gets measured. */
export interface MutationBudget {
  /** Servers whose position (and therefore depth and neighbours) changes. */
  moved: number;
  /** Servers that lose every connection they had. */
  disconnected: number;
  /** Servers that gain connections. */
  connected: number;
  /** Servers killed outright. Their scripts and files go with them. */
  deleted: number;
  /** Servers restarted: scripts die, files survive. */
  restarted: number;
}

/** With no backdoored servers, the two backdoor branches cannot fire, so the
 * later rolls are reached more often. `backdoored` is therefore an input: it
 * makes the net measurably more violent, which is the cost the API docs
 * describe only as an authentication penalty. */
export function mutationBudget(backdoored = 0): MutationBudget {
  // P(reaching the rolls after the early-return branches).
  const survivesAdd = 0.9;
  const survivesBackdoorRestart = backdoored > 0 ? 0.9 : 1;
  const survivesBackdoorDelete = backdoored > 0 ? 0.95 : 1;
  const reachesLate = survivesAdd * survivesBackdoorRestart * survivesBackdoorDelete;
  const reachesDisconnect = reachesLate * 0.5;
  // deleteRandomDarknetServers(Math.random() * 3 + 1) averages 2.5 servers.
  const batch = 2.5;
  return {
    moved: 0.3 /* islands */ + reachesLate * 0.3 * 3 /* moveRandomDarknetServers(3) */,
    disconnected: reachesDisconnect * 0.5,
    connected: reachesLate * 0.5,
    deleted: 0.1 * batch + (backdoored > 0 ? survivesAdd * 0.9 * 0.05 : 0),
    restarted: reachesLate * 0.2 + (backdoored > 0 ? survivesAdd * 0.1 : 0),
  };
}

/** Expected milliseconds before a mutation touches one NAMED host in the given
 * way. This is what an expiry should be scaled against: the net churns every
 * few seconds, but any single host is stable for far longer.
 *
 * Note the scale invariance — ticks get faster with depth while the population
 * grows with it, so the per-host figure barely moves. That is why the expiry
 * below is a flat multiple rather than a function of depth. */
export function msPerHostEvent(
  kind: keyof MutationBudget,
  netDepth = DEFAULT_NET_DEPTH,
  bitNode = 15,
  backdoored = 0,
): number {
  return msPerHostEventAny([kind], netDepth, bitNode, backdoored);
}

/** Expected milliseconds before ANY of these events touches one named host.
 *
 * Rates add; times do not. A neighbour list is invalidated by a move, by a
 * disconnect and by a new connection alike, so the three processes compound into
 * a shorter life than the fastest of them — taking the minimum of the three
 * times would understate the churn and over-trust the edge. */
export function msPerHostEventAny(
  kinds: readonly (keyof MutationBudget)[],
  netDepth = DEFAULT_NET_DEPTH,
  bitNode = 15,
  backdoored = 0,
): number {
  const budget = mutationBudget(backdoored);
  const effectiveness = mutationTickEffectiveness(netDepth);
  const perTick = kinds.reduce((sum, kind) => sum + budget[kind], 0) * effectiveness;
  if (perTick <= 0) return Infinity;
  const perHostPerTick = perTick / expectedServerCount(netDepth);
  return mutationIntervalMs(netDepth, bitNode) / perHostPerTick;
}
