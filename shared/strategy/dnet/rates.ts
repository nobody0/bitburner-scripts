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
  /** The maze upstream ASKS for, which is not the maze it gets — see
   *  `labMazeSize`. Source: src/DarkNet/effects/labyrinth.ts:36-108 (labData) */
  mazeWidth: number;
  mazeHeight: number;
  /** Whether the START and the EXIT are jittered. `getRandomOffset` returns
   *  `[0,0]` unless this is set, and 0, 2 or 4 on each axis when it is — so on
   *  the first four labs the exit is exactly `[cols - 2, rows - 2]` and the
   *  walk begins at `[1,1]`, while on the last four both are unknown within
   *  four cells. Source: labyrinth.ts:376-382 */
  offsetStartAndEnd: boolean;
  /** Whether the UI will ALSO walk this maze by hand. Every lab is scriptable —
   *  the engine's movement handler gates on charisma alone and no ns call reads
   *  this flag — so `false` means "script-only", not "unreachable".
   *  Source: src/DarkNet/effects/labyrinth.ts:234-332 (no manual check),
   *    src/DarkNet/ui/PasswordPrompt.tsx:29-45,
   *    src/DarkNet/ui/LabyrinthSummary.tsx:60,73,83,147 */
  manual: boolean;
}

export const LAB_LADDER: readonly LabStage[] = [
  { hostname: "th3_l4byr1nth", depth: 7, cha: 300, mazeWidth: 20, mazeHeight: 14, offsetStartAndEnd: false, manual: true },
  { hostname: "cru3l_l4byr1nth", depth: 12, cha: 600, mazeWidth: 30, mazeHeight: 20, offsetStartAndEnd: false, manual: true },
  { hostname: "m3rc1l3ss_l4byr1nth", depth: 19, cha: 1_500, mazeWidth: 40, mazeHeight: 26, offsetStartAndEnd: false, manual: false },
  { hostname: "ub3r_l4byr1nth", depth: 23, cha: 2_500, mazeWidth: 60, mazeHeight: 40, offsetStartAndEnd: true, manual: false },
  { hostname: "et3rn4l_l4byr1nth", depth: 29, cha: 3_000, mazeWidth: 60, mazeHeight: 40, offsetStartAndEnd: true, manual: false },
  { hostname: "end13ss_l4byr1nth", depth: 31, cha: 3_500, mazeWidth: 60, mazeHeight: 40, offsetStartAndEnd: true, manual: false },
  { hostname: "f1n4l_l4byr1nth", depth: 36, cha: 4_000, mazeWidth: 60, mazeHeight: 40, offsetStartAndEnd: true, manual: false },
  { hostname: "b0nus_l4byr1nth", depth: 36, cha: 4_000, mazeWidth: 60, mazeHeight: 40, offsetStartAndEnd: true, manual: false },
];

/** The maze a lab ACTUALLY has, which is never the size `labData` asks for.
 *
 * `generateMaze` stitches four sub-mazes together above a width of five, and
 * `mazeMaker` rounds each sub-maze's dimensions UP to an odd number first. The
 * halves then overlap by one column and one row, so the result is
 * `2 * odd(ceil(w / 2)) - 1` wide and the same in height — 21x13 for the 20x14
 * the first lab declares, and 61x41 for the 60x40 the deep ones do.
 *
 * It matters because the exit is `[cols - 2, rows - 2]` (less the jitter), and
 * a walker aiming at `[18, 12]` instead of `[19, 11]` searches the wrong corner
 * of the last block — which on a 61x41 maze is hundreds of moves.
 * Source: src/DarkNet/effects/labyrinth.ts:120-186 */
export function labMazeSize(stage: Pick<LabStage, "mazeWidth" | "mazeHeight">): { width: number; height: number } {
  const odd = (value: number): number => (value % 2 === 0 ? value + 1 : value);
  return {
    width: 2 * odd(Math.ceil(stage.mazeWidth / 2)) - 1,
    height: 2 * odd(Math.ceil(stage.mazeHeight / 2)) - 1,
  };
}

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
export const DEFAULT_NET_DEPTH = 5;

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

// --- the two farm calls, transcribed ---------------------------------------
//
// `memoryReallocation` and `phishingAttack` are the only darknet actions whose
// PAYOFF a strategy has to price before it decides to spend wall-clock on them,
// so their formulas live here beside the mutation clock rather than being
// guessed at the call site. `sim/features/dnet.ts` imports these rather than
// keeping a second copy: one definition means there is no parity suite to drift.
// Source: src/DarkNet/effects/ramblock.ts:22-83,
//         src/NetscriptFunctions/Darknet.ts:536,
//         src/DarkNet/effects/phishing.ts:12-73

/** `roundToTwo`. Both RAM-block figures pass through it upstream, and it is what
 * makes a low-charisma grind quantise to 0.01 GB steps rather than trickling.
 * Source: src/utils/helpers/roundToTwo.ts */
export function roundToTwo(decimal: number): number {
  return Math.round(decimal * 100) / 100;
}

/** `getRamBlockRemoved` — how much blocked RAM ONE `memoryReallocation` frees.
 *
 * Note whose difficulty: the exponent is the SERVER's `difficulty + 1`, while
 * the charisma xp below uses `1.1 ** (difficulty + 1)` for the same reason. The
 * clamp is against the block that is left, so the last call of a grind frees
 * exactly the remainder.
 * Source: src/DarkNet/effects/ramblock.ts:69-83 */
export function ramBlockRemoved(
  difficulty: number,
  blockedRam: number,
  threads: number,
  charisma: number,
): number {
  const raw = rawRamBlockRemoved(difficulty, threads, charisma);
  return roundToTwo(Math.max(Math.min(raw, blockedRam), 0));
}

/** The same figure BEFORE the clamp and the rounding.
 *
 * Split out because a planner has to answer a question the rounded number can
 * no longer answer: `roundToTwo` takes anything under 0.005 to exactly zero, so
 * `ramBlockRemoved` is only ever 0 or at least 0.01 and cannot say how far
 * short a stalled grind actually falls. `farm.ts` quotes this in its refusal,
 * which is the difference between "0.000GB a call" and a number that tells you
 * how much charisma is missing. */
export function rawRamBlockRemoved(difficulty: number, threads: number, charisma: number): number {
  const charismaFactor = 1 + charisma / 100;
  const difficultyFactor = 2 * 0.92 ** (difficulty + 1);
  return 0.02 * difficultyFactor * threads * charismaFactor;
}

/** Charisma experience one `memoryReallocation` grants, before `charisma_exp`.
 * Source: src/DarkNet/effects/ramblock.ts:34 */
export function reclaimCharismaExp(difficulty: number, threads: number): number {
  return threads * 10 * 1.1 ** (difficulty + 1);
}

/** `memoryReallocation`'s netscriptDelay. Floored at 200 ms.
 * Source: src/NetscriptFunctions/Darknet.ts:536 */
export function reclaimWaitMs(charisma: number): number {
  return Math.max(8000 * (500 / (500 + charisma)), 200);
}

/** `getPhishingAttackSpeed`. Floored at 200 ms.
 * Source: src/DarkNet/effects/phishing.ts:12 */
export function phishWaitMs(charisma: number): number {
  return Math.max(10000 * (400 / (400 + charisma)), 200);
}

/** `promoteStock`'s wait, floored at 200 ms however high charisma is. Propaganda
 * is the cheapest call in the feature in time as well as RAM.
 * Source: src/NetscriptFunctions/Darknet.ts:590 */
export function promoteWaitMs(charisma: number): number {
  return Math.max(8000 * (600 / (600 + charisma)), 200);
}

/** `induceServerMigration`'s wait, and it is a CONSTANT: upstream hardcodes six
 * seconds and no skill shortens it (`NetscriptFunctions/Darknet.ts:443`). That
 * is what makes a migration a project rather than a call — a shallow host needs
 * hundreds of them. */
export const INDUCE_WAIT_MS = 6_000;

/** `getSetStasisLinkDuration`: `(1000 / (cha + 1000)) * 30_000`, so thirty
 * seconds at charisma 0 and three at 9000. Not floored upstream.
 * Source: src/DarkNet/effects/effects.ts:218-220 */
export function stasisWaitMs(charisma: number): number {
  return (1000 / (charisma + 1000)) * 30_000;
}

/** Charisma experience one `phishingAttack` grants, before `charisma_exp`. A
 * QUARTER of this on the failure path — every call pays, which is what makes
 * phishing the reliable charisma source rather than the cache lottery it looks
 * like. Source: src/DarkNet/effects/phishing.ts:15,72 */
export function phishCharismaExp(threads: number): number {
  return threads * 50;
}

/** The phishing cache cooldown, and it is GLOBAL: `lastPhishingCacheTime` lives
 * on `DarknetState`, not on a server, so the whole net yields at most twenty
 * `.d.cache` files an hour however many hosts are phishing.
 * Source: src/DarkNet/effects/phishing.ts:70-73 */
export const PHISH_CACHE_COOLDOWN_MS = 3 * 60 * 1000;

/** Chance one call claims the open cache window. Threads move the ROLL, never
 * the ceiling. Source: src/DarkNet/effects/phishing.ts:17 */
export function phishCacheChance(threads: number, charisma: number, crimeSuccessMult = 1): number {
  return 0.005 * crimeSuccessMult * threads * ((400 + charisma) / 400);
}

/** Chance one call pays money instead. The cache branch is an `if` and this is
 * its `else if`, so claiming a cache forecloses that call's money roll.
 * Source: src/DarkNet/effects/phishing.ts:18 */
export function phishMoneyChance(charisma: number, crimeSuccessMult = 1): number {
  return 0.05 * crimeSuccessMult * ((200 + charisma) / 200);
}

/** Money one paying call yields, at the mean of upstream's U(0.9, 1.2) factor.
 * DEPTH is the term that matters to a planner: `0.1 + depth * 0.05` is why the
 * deepest resident is the one worth phishing from.
 * Source: src/DarkNet/effects/phishing.ts:33-45 */
export function phishMoney(
  depth: number,
  threads: number,
  charisma: number,
  mults: { crimeMoney?: number; dnetMoney?: number; nodeMult?: number; bonusTime?: boolean } = {},
): number {
  const depthFactor = 0.1 + depth * 0.05;
  return 500
    * (mults.crimeMoney ?? 1)
    * (mults.dnetMoney ?? 1)
    * depthFactor
    * threads
    * ((400 + charisma) / 400)
    * (mults.bonusTime === true ? 1.3 : 1)
    * 1.05
    * (mults.nodeMult ?? 1);
}
