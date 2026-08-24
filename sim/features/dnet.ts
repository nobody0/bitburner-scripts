import type { SimServer } from "../core/effects.ts";
import type { SimPlayer } from "../core/player.ts";
import type { SimWorld } from "../world.ts";
import { mockServer } from "../core/mocks.ts";
import { randomIp } from "../network.ts";
import type { ProcessTable } from "../ns/process.ts";
import type { ContractSystem } from "./contracts.ts";
import type { StockMarketSystem } from "./stock.ts";
import { MAZE_PATH, directionFromInput, generateMaze, surroundingsVisualized } from "./dnet-maze.ts";
import {
  isLabyrinth,
  isOnAirGap,
  LAB_LADDER,
  NET_WIDTH,
  PHISH_CACHE_COOLDOWN_MS,
  phishCacheChance,
  phishCharismaExp,
  phishMoneyChance,
  promoteWaitMs,
  ramBlockRemoved,
  reclaimCharismaExp,
  roundToTwo,
  STORM_COOLDOWN_MS,
  STORM_SEED_CHANCE,
  type LabStage,
} from "../../shared/strategy/dnet/rates.ts";
import { generateSecret, passwordRng, type PasswordFormat } from "./dnet-generators.ts";
import {
  capturePackets,
  checkPassword as checkPasswordAgainst,
  getExactCorrectChars,
  getRandomCharsInPassword,
  getSharedChars,
  logEntryFor,
  type PacketWorld,
} from "./dnet-feedback.ts";
import { PACKET_SNIFF_PHRASES } from "../../shared/strategy/dnet/phrases.ts";

/** Controller-facing darknet model for fresh and multi-install worlds.
 *
 * It covers population and mutation, all 23 ns.dnet members, the 24 password
 * models, sessions, cache/clue/contract rewards, storms and the labyrinth.
 * Save/offline/UI state stays outside this boundary; unknown ns members remain
 * absent so the root proxy reports them instead of inventing an answer.
 *
 * The formulas are transcribed, and so is the GRID. A host holds a
 * `(depth, leftOffset)` cell on an 8-wide board with air-gap rows, exactly as
 * `DarknetState.Network[x][y]` does, because the geometry is not decoration: a
 * same-depth edge can only ever join two cells at |Δcolumn| = 1, while a
 * vertical edge is rolled against the whole adjacent row and so says nothing
 * about the column. That asymmetry is the only evidence a script has for
 * reconstructing a column it is never told, and a sim that wired same-depth
 * pairs freely would mint edges the game cannot produce and quietly invalidate
 * any map built on them.
 * Source: ../bitburner-src @ 3162fd2590e221eadd0c0fbd46151913f7c4c41c
 *   src/DarkNet/controllers/NetworkGenerator.ts, src/DarkNet/Enums.ts,
 *   src/DarkNet/models/DarknetServerOptions.ts, src/DarkNet/effects/ramblock.ts */

export const DNET_ASSUMPTIONS: readonly string[] = [
  "dnet.topology: population, the 8-wide grid, air-gap rows and the connection passes are reproduced — a host holds a "
  + "(depth, leftOffset) cell, lateral edges reach only the cells beside it, and vertical edges are rolled against the whole "
  + "adjacent row. What is not transcribed is the ORDER upstream's balancing pass visits candidates in",
  // Every knowledge expiry in shared/strategy/dnet/host.ts is derived from
  // the move, connect and disconnect rates, and the tick produces ALL of them —
  // every kind upstream rolls, at upstream's probabilities, seated on the real
  // grid — so a sim run does exercise the staleness policy. What is left is the
  // ENTROPY: upstream rolls a fresh Math.random() per candidate pair, which
  // would make the draw block variable-width.
  "dnet.mutationPlacement: the tick applies every mutation kind upstream rolls — island moves, low-level restocking, "
  + "deletes, adds, restarts, moves, added connections, severed connections and the density balance — at upstream's own "
  + "probabilities and in its order, and a moved or added host takes a free (depth, leftOffset) cell from "
  + "getAllOpenPositions with its band-widening. What differs is the ENTROPY SOURCE for the per-pair connection rolls: "
  + "upstream draws a fresh random() per candidate, which would make the mutation's draw block variable-width and let "
  + "topology perturb the stock stream, so the pairs are decided by hashing one draw instead. Same probabilities, same "
  + "independence, fixed cost",
  "dnet.probeOrder: probe results use upstream's lodash shuffle law on a dedicated response stream, preserving its distribution without letting probe frequency perturb stock prices",
  "dnet.logNoise: every branch of getLogNoise is now reproduced in upstream's order and at its probabilities — the spam "
  + "phrases, a neighbour's plaintext password, the transaction edge, the exact-characters hint off the last attempt, two "
  + "characters of this host's own password, a stranger's password, and addPacketSnifferNoise's own-or-neighbour leak — as is "
  + "the back-fill's oldest-first prepend order. Two renderings differ: the heartbeat's clock is a UTC HH:MM:SS over virtual "
  + "time rather than toLocaleTimeString(), which is locale-dependent and would make a run irreproducible across machines; and "
  + "the noise draws come from a DEDICATED stream, because their number depends on how long a script waited before bleeding and "
  + "billing them to the gameplay stream would let log volume perturb stock prices across an A/B",
  "dnet.authXp: every authenticate now pays calculatePasswordAttemptChaGain — (3 + 1.1^difficulty) * threads, a fifth on "
  + "an already-rooted host and ten times on a first success — on FAILURE as well as success, which is what makes "
  + "iterative solving free in charisma terms rather than pure cost. hasDarknetBonusTime()'s 1.5x is false by truth: the "
  + "sim has no offline accrual",
  "dnet.models: all twenty-four models mint their password, hint and hint data through upstream's own per-model config "
  + "builder, getPassword and getPasswordType — so passwordFormat is derived rather than declared, a numeric password of "
  + "length >= 2 never starts with 0, and passwordLength is the length of the GENERATED string rather than the length its "
  + "builder asked for. All fifteen arms of the failure switch are transcribed, including the isCloseToCorrectPassword "
  + "tolerance that OctantVoxel and MathML need, capturePackets, the WHRNG-seeded KingOfTheHill landscape and "
  + "logPasswordAttempt's Pr0verFl0 branch, which rewrites passwordAttempted to the received buffer. What differs is the "
  + "ENTROPY SOURCE: getXorMaskEncryptedPasswordConfig, getPasswordMadeUpOfPrimesProduct and "
  + "generateSimpleArithmeticExpression are unbounded rejection loops, so a host takes exactly ONE draw off the world stream "
  + "and derives a mulberry32 from it (mixed with the hostname) that every generator then runs on. Same distributions, fixed "
  + "cost per host, and a host's secret is reproducible from (secretDraw, hostname) alone. One substitution inside capturePackets emits an existing darknet hostname instead of generating a noise-only name",
  "dnet.playerDraws: three player-initiated darknet rolls take their entropy from the DEDICATED noise stream rather than "
  + "the shared gameplay one — the authentication timeout coin, the placement of an induced migration, and the maze's "
  + "start/endpoint offsets. Upstream draws all three from Math.random(). The probabilities and distributions are "
  + "upstream's exactly; what differs is the source, and it differs because how often a run authenticates, pushes or walks "
  + "is a property of the STRATEGY — billing those draws to the gameplay stream would let a darknet policy perturb stock "
  + "prices across an A/B, which is the same reason log noise already has its own stream",
  "dnet.stasis: setStasisLink is modelled whole — it pins the CALLING host (it takes no hostname), respects "
  + "getStasisLinkLimit() = 1 + TheBrokenWings + TheHammer + TheStaff read from INSTALLED augmentations with 453 when "
  + "spent, excludes the host from every mutation branch's victim pool, and sets server.backdoorInstalled alongside the "
  + "link exactly as effects.ts:233-234 does — so a pinned host IS remotely reachable, not because a link is a "
  + "reachability primitive but because upstream installs a backdoor at the same moment, and releasing the link takes it "
  + "away again. A pinned host is still filtered out of getBackdooredDarknetServers, so that backdoor costs no instability "
  + "and cannot be drawn by the restart or delete branches. What is NOT modelled: the packet-noise leak pool still draws on "
  + "isStationary rather than isImmutable, because upstream's own predicate there is unverified",
  "dnet.backdoors: modelled end to end. singularity.installBackdoor on a darknet server is a flat 4 s with no hacking-skill "
  + "and no root gate (calculateHackingTime returns 16 for a DarknetServer outright); getBackdoorAuthTimeDebuff's real "
  + "1.07 ^ surplus over an allowance of max(rootedMovable / (NET_WIDTH * 3), 2) multiplies EVERY authentication through "
  + "authTimeMs; getTimeoutChance's max(min((backdoored - 2) * 0.03, 0.5), 0) is rolled where upstream rolls it, after the "
  + "delay and before the model is consulted, so a 408 is now reachable; and the two mutation branches that draw from the "
  + "backdoored pool — a 10% restart and a 5% delete, both of which RETURN — are applied in upstream's order, with the "
  + "restart clearing the backdoor as it clears the sessions. The terminal's own position pins a host against moves, as "
  + "isImmutable's isConnectedTo term does",
  "dnet.migration: induceServerMigration is modelled — the 6 s hardcoded wait, the refusal of the script's own host, the "
  + "stationary throw, chargeServerMigration's ((cha + 500) / (difficulty * 200 + 1000)) * 0.01 * threads per call with its "
  + "5 * threads * difficulty charisma xp, and the move at charge 1 into a band anchored on DIFFICULTY rather than depth "
  + "([difficulty - 2, difficulty + 4]) — including the branch where getAllOpenPositions comes back empty and the host is "
  + "DELETED rather than left floating. The accumulated charge is engine state no ns member exposes, so a script can only "
  + "infer its progress from the depth changing, exactly as in the game",
  "dnet.labyrinth: the maze is modelled. generateMaze's four stitched sub-mazes with their odd-rounding and their four "
  + "punched gaps, the endpoint at [cols - 2, rows - 2] less a 0/2/4 offset on the last five labs, labLocations keyed by "
  + "PID with the same offset at the start, getDirectionFromInput's word parsing, the radius-1 render with the player "
  + "overlay and without the exit, and all four response branches — the 451 below the lab's charisma, the deliberate "
  + "refusal of the lab's own password, the wall that leaves the position UNCHANGED, and the exit, which pays charisma at a "
  + "fixed 32-thread equivalent, sets admin rights, drops the_great_work cache (three on BonusLab) and opens a session. "
  + "labradar is modelled too, because the deployed walker pays for one whenever a single render decides the exit: its "
  + "radius-3 view WITH the exit overlay, its full authentication delay, its riddle-worded refusals when there is no lab "
  + "or no direct connection, and the fact that it grants NO charisma — upstream delays and renders without ever reaching "
  + "getAuthResult. labreport returns the same PID location as directional booleans after the same authentication delay. "
  + "Opening that cache queues the labyrinth augmentation rather than drawing from the reward table. The net DEEPENS at the "
  + "install that follows rather than at the exit, because getNetDepth reads the current lab and the current lab is chosen "
  + "by installed augmentations — which is upstream's behaviour, not a simplification. What differs: the maze carve takes "
  + "an unbounded number of draws, so it runs on a generator derived from ONE world draw (same treatment as a host's "
  + "password), and the start/endpoint offsets come off the dedicated stream (see dnet.playerDraws)",
  "dnet.cacheRewards: the complete upstream draw is modeled: programs/market unlocks, live stock shares, clue files with fallback, phishing-only coding contracts, and money; generated contracts use the vendored problems and controller-facing reward lifecycle",
  "dnet.cacheSources: first-root, RAM-clear and phishing caches are modeled in upstream order; first root and RAM clear also run addClue, RAM clear performs the 30% clue and storm-seed rolls, and phishing/storm cooldowns start closed at construction and prestige. hasDarknetBonusTime is false because offline accrual is outside the controller-run boundary",
  "dnet.webstorm: seed gating, consumption-before-lock, phase timing, delete/move/restart/add waves and density balance are modeled; its variable-width burst draws use the dedicated dnet action stream, the construction/prestige clock starts closed as upstream does, and success/refusal messages are paraphrased",
  "dnet.promoteStock: the charge curve, the 0.4x per-cycle decay, the wait time, the charisma XP and the prestige reset are transcribed exactly; the propaganda has no other modelled effect",
  "dnet.prestige: an install removes every generated host, file, cache, session, link, promotion and maze, then regenerates the current-depth network when access survives; save/offline restoration is outside this coverage boundary",
];

/** `getDarknetVolatilityMult` — the propaganda curve `ns.dnet.promoteStock`
 * feeds. Two saturating exponentials, so the boost approaches 4x and no
 * quantity of threads can pass it. Charges decay 0.4x at every market cycle
 * (`scaleDarknetVolatilityIncreases(0.4)` from `stockMarketCycle`), which is
 * what makes a promotion something to be maintained rather than bought once.
 * Source: src/DarkNet/effects/effects.ts:197-208 @ 3162fd2 */
export const STOCK_PROMOTION_GROWTH_RATE = 0.001;
export const STOCK_PROMOTION_CYCLE_DECAY = 0.4;

export function stockPromotionMult(charges: number): number {
  const g = STOCK_PROMOTION_GROWTH_RATE;
  return 1 + (1 - Math.exp(-g * charges) + 2 * (1 - Math.exp(-g * 0.15 * charges)));
}

/** `promoteStock`'s netscriptDelay, floored at 200 ms however high charisma is.
 *  Source: src/NetscriptFunctions/Darknet.ts:590 */
export function promoteStockWaitMs(charisma: number): number {
  // The one formula, from the one place a strategy also reads it: a second copy
  // here is a place for the sim and the controller to disagree about how long a
  // call takes, which is the divergence a simulator exists to prevent.
  return promoteWaitMs(charisma);
}

/** Charges bought by one call. Source: src/NetscriptFunctions/Darknet.ts:597 */
export function promoteStockCharges(threads: number, charisma: number): number {
  return threads * ((500 + charisma) / 500);
}

/** Charisma experience the call grants. Source: src/NetscriptFunctions/Darknet.ts:600 */
export function promoteStockCharismaExp(threads: number, charisma: number, charismaExpMult: number): number {
  return charismaExpMult * threads * 10 * ((200 + charisma) / 200);
}

/** `calculatePasswordAttemptChaGain`, as a free function so the labyrinth's
 * fixed 32-thread grant and the ordinary per-attempt one cannot drift apart.
 * `hasDarknetBonusTime()` is false by truth here: the sim has no offline
 * accrual. */
export function attemptCharismaExp(
  difficulty: number,
  rooted: boolean,
  threads: number,
  success: boolean,
): number {
  const base = 3 + 1.1 ** difficulty;
  return base * (rooted ? 0.2 : 1) * (success && !rooted ? 10 : 1) * threads;
}

const SERVER_DENSITY = 0.6;
/** Per-pair connection odds. Source: src/DarkNet/Enums.ts:4-5 */
const HORIZONTAL_CONNECTION_CHANCE = 0.5;
const VERTICAL_CONNECTION_CHANCE = 0.3;
/** getNetDepth()'s fallback without full darknet access. */
const NO_SF15_NET_DEPTH = 5;

/** DarknetServerOptions.ts:72-76. `difficulty` is the server's rolled
 * difficulty, not the row where the network generator managed to seat it. */
export function requiredCharismaSkill(
  difficulty: number,
  labyrinthDepth: number,
  labyrinthCharisma: number,
  varianceDraw: number,
): number {
  const scaling = difficulty < 2
    ? difficulty * 10
    : (difficulty / labyrinthDepth) ** 1.5 * labyrinthCharisma * 0.85;
  const variance = (varianceDraw * 3 - 1) * difficulty;
  return Math.max(Math.floor(scaling + variance), 1);
}
/** packetSniffing.ts:14. The ring is generous, which is why a wide heartbleed
 * read is free information rather than a cost. */
const MAX_LOG_LINES = 200;
const LOW_LEVEL_SERVER_DENSITY = 0.7;
/** Draws taken from the shared gameplay stream per mutation, whatever the tick
 * does. Fixed so two strategy variants advance that stream identically. */
export const MUTATION_DRAWS = 32;

/** The webstorm's phase gaps in engine cycles (200 ms each): the 5 s warning,
 * then 4 s to the deletes' aftermath, 4 s, 4 s, 8 s between the add waves, and
 * a 5 s tail — ~30 s in all, during which `mutationLock` freezes the ordinary
 * clock. Each phase's ACTION is applied when its gap elapses.
 * Source: src/DarkNet/effects/webstorm.ts:41-70 */
export const STORM_PHASE_CYCLES = [25, 20, 20, 20, 40, 25] as const;

/** `labData`, in the order `getCurrentLabName` walks it.
 *
 * Held in `shared/strategy/dnet/rates.ts` rather than transcribed a second time
 * here: `ui/` needs the same ladder to pin the labyrinth to the bottom of the
 * map and to know how deep the net goes at all, and two copies of a table like
 * this drift the moment one of them is corrected. Re-exported so the sim's own
 * importers do not have to know where it moved to. */
export { LAB_LADDER as LAB_STAGES, type LabStage } from "../../shared/strategy/dnet/rates.ts";

/** The six labyrinth rewards, in prereq order. The Red Pill is spliced in by
 * `labReward` rather than listed, because where it lands depends on the node.
 * Source: src/DarkNet/effects/labyrinth.ts:403-430 */
export const LAB_AUGMENTATIONS = [
  "The W1ngs of Icarus",
  "The B00ts of Perseus",
  "The H4mmer of Daedalus",
  "The St4ff of Asclepius",
  "The L4w of Bayes",
  "The B1ade of Solomonoff",
] as const;
export const RED_PILL = "The Red Pill";
export const NEUROFLUX = "NeuroFlux Governor";

/** `getCurrentLabName`: which lab is open depends on which rewards are
 * INSTALLED, not queued. In BN15 the Red Pill is checked before The L4w, which
 * is what makes it the fifth reward there and the seventh elsewhere. */
export function currentLab(installed: ReadonlySet<string>, bitNode: number, allowRedPill: boolean): LabStage {
  const has = (name: string): boolean => installed.has(name);
  if (!has(LAB_AUGMENTATIONS[0])) return LAB_LADDER[0]!;
  if (!has(LAB_AUGMENTATIONS[1])) return LAB_LADDER[1]!;
  if (!has(LAB_AUGMENTATIONS[2])) return LAB_LADDER[2]!;
  if (!has(LAB_AUGMENTATIONS[3])) return LAB_LADDER[3]!;
  if (bitNode === 15) {
    if (!has(RED_PILL)) return LAB_LADDER[4]!;
    if (!has(LAB_AUGMENTATIONS[4])) return LAB_LADDER[5]!;
    if (!has(LAB_AUGMENTATIONS[5])) return LAB_LADDER[6]!;
    return LAB_LADDER[7]!;
  }
  if (!has(LAB_AUGMENTATIONS[4])) return LAB_LADDER[4]!;
  if (!has(LAB_AUGMENTATIONS[5])) return LAB_LADDER[5]!;
  if (allowRedPill && !has(RED_PILL)) return LAB_LADDER[6]!;
  return LAB_LADDER[7]!;
}

/** `getLabAugReward`: what completing the current lab awards. */
export function labReward(installed: ReadonlySet<string>, bitNode: number, allowRedPill: boolean): string {
  const next = LAB_AUGMENTATIONS.find((name) => !installed.has(name));
  if (next === undefined && (installed.has(RED_PILL) || !allowRedPill)) return NEUROFLUX;
  // BN15 hands the Red Pill over at the fourth lab, in place of The L4w.
  if (bitNode === 15 && next === LAB_AUGMENTATIONS[4] && !installed.has(RED_PILL)) return RED_PILL;
  if (next === undefined && allowRedPill) return RED_PILL;
  return next ?? NEUROFLUX;
}

/** `getRandomServerConfigBuilder`'s tiers, transcribed.
 *
 * The tiering is not a detail. Upstream does NOT draw uniformly: at difficulty
 * <= 2 the pool is four models, two of which are four-entry dictionaries. That
 * is why the shallow net is traversable at all, and a uniform draw here would
 * make the beachhead look far harder in the simulator than it is in the game —
 * which is the exact class of error that makes a sim run worse than no run.
 * KingOfTheHill and SpiceLevel are SF15-gated (ServerGenerator.ts:22).
 * Source: src/DarkNet/controllers/ServerGenerator.ts:18-62 */
const TIER_0 = ["ZeroLogon"] as const;
const TIER_1 = ["DeskMemo_3.1", "FreshInstall_1.0", "CloudBlare(tm)"] as const;
const TIER_2 = ["Laika4", "NIL", "Pr0verFl0"] as const;
const TIER_3_BASE = [
  "PHP 5.4", "DeepGreen", "BellaCuore", "AccountsManager_4.2", "OctantVoxel",
  "Factori-Os", "OpenWebAccessPoint",
] as const;
const TIER_3_SF15 = ["KingOfTheHill", "RateMyPix.Auth"] as const;
const TIER_4 = [
  "PrimeTime 2", "TopPass", "EuroZone Free", "2G_cellular", "110100100",
  "MathML", "OrdoXenos", "BigMo%od",
] as const;

function modelPool(difficulty: number, fullAccess: boolean): readonly string[] {
  const tier3 = fullAccess ? [...TIER_3_BASE, ...TIER_3_SF15] : [...TIER_3_BASE];
  if (difficulty <= 2) return [...TIER_0, ...TIER_1];
  // Tier 1 really is listed twice upstream at this band, which doubles its
  // weight. Transcribed rather than "corrected".
  if (difficulty <= 4) return [...TIER_0, ...TIER_1, ...TIER_1, ...TIER_2, ...tier3];
  if (difficulty <= 8) return [...TIER_1, ...TIER_2, ...tier3];
  if (difficulty <= 18) return [...TIER_2, ...tier3, ...TIER_4];
  return [...tier3, ...TIER_4];
}

/** DarknetServerOptions.ts:206-211. */
function rollMaxRam(difficulty: number, random: () => number): number {
  const baseRam = 16 * 2 ** Math.floor(difficulty / 6);
  const mutations = [0.5, 1, 1, 1.15, 1.4];
  return Math.max(baseRam * mutations[Math.floor(random() * mutations.length)]!, 16);
}

/** ramblock.ts:97-110. Note the two small-RAM cases index a 3-element array with
 * `floor(random * 2)`, so their third value is unreachable upstream — kept
 * faithfully rather than "corrected". */
function rollBlockedRam(maxRam: number, random: () => number): number {
  if (maxRam === 16) return [0, 1, 2][Math.floor(random() * 2)]!;
  if (maxRam <= 32) return [0, 2, 4][Math.floor(random() * 2)]!;
  if (maxRam <= 64) return [16, 32, maxRam - 8][Math.floor(random() * 3)]!;
  return [maxRam, maxRam - 8, maxRam - 64, maxRam / 2][Math.floor(random() * 4)]!;
}

/** Independent sub-draws derived from one draw already taken from the stream.
 *
 * Upstream rolls a fresh `Math.random()` per candidate pair, and there is no
 * bound on how many pairs a wiring pass considers. Doing that here would make
 * the mutation's draw block variable-width, and `MUTATION_DRAWS` is fixed
 * precisely so that topology cannot perturb the stock stream — a strategy A/B
 * would stop being comparable. Hashing one draw gives the same per-pair
 * independence at a fixed cost. */
function subDraw(draw: number, salt: number): number {
  let x = (Math.imul(Math.floor(draw * 0x7fffffff) >>> 0, 0x9e3779b1) ^ Math.imul(salt + 1, 0x85ebca6b)) >>> 0;
  x = Math.imul(x ^ (x >>> 15), 0xc2b2ae35) >>> 0;
  x ^= x >>> 13;
  return (x >>> 0) / 0x1_0000_0000;
}

/** A log line, parsed back out of the ring. The ring holds strings because
 * that is what `heartbleed` hands a script; noise lines are prose and are not
 * JSON, so a parse failure is expected and means "not an auth entry". */
function parseLogLine(line: string): Record<string, unknown> | undefined {
  if (!line.startsWith("{")) return undefined;
  try {
    const parsed: unknown = JSON.parse(line);
    return typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

/** The heartbeat line's clock. Upstream renders it with `toLocaleTimeString()`,
 * which depends on the host machine's locale and would make a run
 * irreproducible across developers; this is the same shape over virtual time,
 * in UTC. Declared in DNET_ASSUMPTIONS. */
function utcClock(atMs: number): string {
  const total = Math.max(0, Math.floor(atMs / 1000));
  const pad = (value: number): string => String(value).padStart(2, "0");
  return `${pad(Math.floor(total / 3600) % 24)}:${pad(Math.floor(total / 60) % 60)}:${pad(total % 60)}`;
}

export interface DarknetHost {
  hostname: string;
  modelId: string;
  /** The real password, minted by upstream's own generator for this model.
   *
   *  Generated from the WORLD stream, never the gameplay one, so a strategy A/B
   *  faces the same net — and from exactly ONE draw off it, because three of
   *  upstream's generators are unbounded rejection loops. That draw is kept in
   *  `secretDraw`, so a test holding `(draw, hostname)` can re-derive the whole
   *  secret without replaying the net. */
  password: string;
  passwordHint: string;
  data: string;
  /** The length of the GENERATED password, not the length its builder asked
   *  for: `getPassword` runs numeric passwords through `Number().toString()`,
   *  which can hand back a shorter string than the loop produced. */
  passwordLength: number;
  /** `getPasswordType(password)` — derived, never assumed. Several models draw
   *  letters above difficulty 8, and a hardcoded "numeric" is a lie a solver
   *  would act on. */
  passwordFormat: PasswordFormat;
  /** The single world-stream draw this host's secret was derived from. */
  secretDraw: number;
  logTrafficInterval: number;
  blockedRam: number;
  difficulty: number;
  depth: number;
  /** The COLUMN, 0..NET_WIDTH-1. Upstream's `DarknetServer.leftOffset`, and the
   *  second half of the coordinate `DarknetState.Network[depth][leftOffset]` is
   *  indexed by. `-1` for `darkweb` and the labyrinth, which are pinned.
   *
   *  Not exposed to scripts — `DarknetServerDetails` carries `depth` and nothing
   *  about the column. It is modelled here anyway because it is what decides
   *  which same-depth pairs may be wired at all, and a sim that skipped it would
   *  generate lateral edges the game cannot produce. */
  leftOffset: number;
  requiredCharismaSkill: number;
  isStationary: boolean;
  /** A stasis link pins this host: it cannot move, go offline or be deleted.
   *
   *  Upstream keeps the set on `DarknetState`; here it is a per-host flag
   *  because every read is "is this one pinned" and the list is derived. It is
   *  the second half of `isImmutable`, whose first half is `isStationary`. */
  stasisLinked: boolean;
  online: boolean;
  /** PIDs holding a session, mirroring upstream's `authenticatedPIDs`.
   *
   *  Per HOST rather than per process, exactly as upstream stores it — and
   *  pruned lazily on read, because `ProcessTable.resetPidCounter()` restarts
   *  pids at 1 on prestige and a stale entry would hand a new process someone
   *  else's session. */
  sessions: Set<number>;
  /** The log ring heartbleed reads. Newest first, capped at MAX_LOG_LINES. */
  logs: string[];
  /** Virtual time of the last noise line, for the lazy back-fill. */
  lastLogMs?: number;
}

export interface DarknetSystemOptions {
  servers: Map<string, SimServer>;
  network: Map<string, string[]>;
  processes: ProcessTable;
  /** Seeded world generation, kept separate from the gameplay stream so a
   *  strategy A/B does not face a different net. */
  generate: () => number;
  /** Shared gameplay stream, for mutation. */
  random: () => number;
  /** A THIRD stream, for log noise.
   *
   *  Noise draws are variable in number and depend on how long a script waited
   *  before bleeding, so taking them from `random` would let log volume perturb
   *  stock prices across an A/B. Optional: without it the world stream is used,
   *  which is still not the gameplay one. */
  logNoise?: () => number;
  bitNode: number;
  /** BN15 or an active SF15: upstream's hasFullDarknetAccess. */
  fullAccess: () => boolean;
  /** DarkscapeNavigator.exe on home. */
  hasProgram: () => boolean;
  /** Installed augmentation names. The labyrinth ladder reads INSTALLED, not
   *  queued, so a reward sitting in the queue does not open the next lab. */
  installedAugmentations: () => ReadonlySet<string>;
  /** DarknetLabyrinthRewardsTheRedPill for this node — 0 only in BN8. */
  allowRedPill: () => boolean;
  world: SimWorld;
  player: SimPlayer;
  /** Files on home, for the programs a cache can hand over. */
  homeFiles: () => Set<string>;
  filesOn?: (hostname: string) => Set<string>;
  writeTextFile?: (hostname: string, filename: string, contents: string) => void;
  /** Drop a deleted host's files. The file map belongs to the sim host, not to
   *  this system, so removal is a callback rather than a reach-in. */
  forgetFiles?: (hostname: string) => void;
  /** DarknetMoneyMultiplier for this node — 0 in BN8, which removes the money
   *  reward from the draw entirely rather than scaling it to nothing. */
  darknetMoneyMultiplier: () => number;
  /** Live reward targets. Cache branches must update the same systems the
   * corresponding Netscript namespaces read. */
  contracts?: ContractSystem;
  stock?: StockMarketSystem;
}

/** The programs a cache hands over, in the order upstream walks them. The first
 * one not owned is the reward — so a cache is worth up to Formulas.exe, which
 * the dark web sells for $5b.
 * Source: src/DarkNet/effects/cacheFiles.ts:130-149 */
export const CACHE_PROGRAMS = [
  "ServerProfiler.exe", "BruteSSH.exe", "DeepscanV1.exe", "FTPCrack.exe", "AutoLink.exe",
  "relaySMTP.exe", "DeepscanV2.exe", "HTTPWorm.exe", "SQLInject.exe", "Formulas.exe",
] as const;

const CACHE_PREFIXES = ["wallet", "secrets", "ledger", "stash", "vault", "bankdata", "do_not_open"] as const;
const PASSWORD_FILE_NAMES = ["secrets", "password", "key", "credentials", "login", "admin", "root", "access"] as const;
const NOTEBOOK_FILE_NAMES = ["thoughts", "notes", "journal", "search_history", "dreams", "THE_TRUTH"] as const;
const COMMON_PASSWORDS = [
  "123456", "password", "12345678", "qwerty", "123456789", "12345", "1234", "111111", "1234567",
  "dragon", "123123", "baseball", "abc123", "football", "monkey", "letmein", "696969", "shadow", "master",
  "666666", "qwertyuiop", "123321", "mustang", "1234567890", "michael", "654321", "superman", "1qaz2wsx",
  "7777777", "121212", "0", "qazwsx", "123qwe", "trustno1", "jordan", "jennifer", "zxcvbnm", "asdfgh",
  "hunter", "buster", "soccer", "harley", "batman", "andrew", "tigger", "sunshine", "iloveyou", "2000",
  "charlie", "robert", "thomas", "hockey", "ranger", "daniel", "starwars", "112233", "george", "computer",
  "michelle", "jessica", "pepper", "1111", "zxcvbn", "555555", "11111111", "131313", "freedom", "777777",
  "pass", "maggie", "159753", "aaaaaa", "ginger", "princess", "joshua", "cheese", "amanda", "summer",
  "love", "ashley", "6969", "nicole", "chelsea", "biteme", "matthew", "access", "yankees", "987654321",
  "dallas", "austin", "thunder", "taylor", "matrix",
] as const;

export class DarknetSystem {
  readonly hosts = new Map<string, DarknetHost>();
  #populated = false;
  #darkweb: DarknetHost | undefined;
  /** Serial for hosts added after populate(), so a re-added name never collides
   *  with one the net still remembers. */
  #added = 0;
  /** Deleted IPs and hostnames, in insertion order, for the 3% name-reuse path. */
  readonly #offlineServers = new Set<string>();
  // Declared before the promise that assigns it: a field initialiser running
  // before its own target field exists is a TDZ error on private fields, so the
  // promise is built in the constructor instead.
  #nextMutationResolve: (() => void) | undefined;
  #nextMutation: Promise<void> = Promise.resolve();
  #cyclesSinceMutation = 0;
  #mutations = 0;
  /** `DarknetState.stockPromotions`: accumulated propaganda per symbol. The
   *  price engine reads this through the market adapter, so a promotion moves
   *  the real vendored tick rather than a parallel estimate of it. */
  readonly #stockPromotions = new Map<string, number>();
  readonly #opts: DarknetSystemOptions;
  readonly #standaloneTextFiles = new Map<string, Set<string>>();
  readonly #createdAtMs: number;

  constructor(options: DarknetSystemOptions) {
    this.#opts = options;
    this.#createdAtMs = options.world.clock.now();
    this.#lastPhishingCacheMs = this.#createdAtMs;
    this.#lastStormMs = this.#createdAtMs;
    this.#triggerNextMutation();
  }

  /** hasDarknetAccess(): BN15 || SF15 || the program. */
  hasAccess(): boolean {
    return this.#opts.fullAccess() || this.#opts.hasProgram();
  }

  /** The lab currently open, or undefined without full access — the program
   * alone does not reach the labyrinth. */
  currentLab(): LabStage | undefined {
    if (!this.#opts.fullAccess()) return undefined;
    return currentLab(this.#opts.installedAugmentations(), this.#opts.bitNode, this.#opts.allowRedPill());
  }

  /** `getNetDepth()`: the current lab's depth, or the 5 fallback without full
   * access. This is what makes the net grow as the labyrinth is walked. */
  netDepth(): number {
    return this.currentLab()?.depth ?? NO_SF15_NET_DEPTH;
  }

  /** What completing the current lab would award. Undefined when there is no
   * lab to complete. */
  labReward(): string | undefined {
    if (!this.#opts.fullAccess()) return undefined;
    return labReward(this.#opts.installedAugmentations(), this.#opts.bitNode, this.#opts.allowRedPill());
  }

  get mutations(): number {
    return this.#mutations;
  }

  // --- stock propaganda -----------------------------------------------------

  /** `getDarknetVolatilityMult(symbol)`. Injected into the vendored market
   *  adapter, so `processStockPrices` and `ns.stock.getVolatility` cannot
   *  disagree about how volatile a promoted symbol is. */
  stockVolatilityMult(symbol: string): number {
    const charges = this.#stockPromotions.get(symbol) ?? 0;
    return charges > 0 ? stockPromotionMult(charges) : 1;
  }

  /** `scaleDarknetVolatilityIncreases(scalar)`, called with 0.4 once per
   *  75-tick market cycle. Upstream only touches positive entries. */
  scaleStockPromotions(scalar: number): void {
    for (const [symbol, charges] of this.#stockPromotions) {
      if (charges > 0) this.#stockPromotions.set(symbol, charges * scalar);
    }
  }

  /** The charges `promoteStock` deposits once its wait has elapsed. */
  addStockPromotion(symbol: string, charges: number): void {
    if (!Number.isFinite(charges) || charges <= 0) return;
    this.#stockPromotions.set(symbol, (this.#stockPromotions.get(symbol) ?? 0) + charges);
  }

  stockPromotionCharges(symbol: string): number {
    return this.#stockPromotions.get(symbol) ?? 0;
  }

  /** An install clears `DarknetState.stockPromotions`, on the same boundary at
   *  which `initStockMarket` destroys the portfolio. Propaganda does not
   *  survive a prestige any more than a position does.
   *
   *  Upstream's `prestigeDarknetState` also drops the network, the labyrinth and
   *  the per-server state. This does not, and that predates the promotions —
   *  see the `dnet.prestige` entry in `DNET_ASSUMPTIONS`. */
  prestige(nowMs?: number): void {
    for (const hostname of [...this.hosts.keys()]) {
      this.#opts.forgetFiles?.(hostname);
      this.#opts.processes.killall(hostname);
      this.#opts.servers.delete(hostname);
      this.#unwire(hostname);
      this.#opts.network.delete(hostname);
    }
    this.hosts.clear();
    this.caches.clear();
    this.#standaloneTextFiles.clear();
    this.#darkweb = undefined;
    this.#populated = false;
    this.#added = 0;
    this.#cyclesSinceMutation = 0;
    this.#mutations = 0;
    this.#stockPromotions.clear();
    // `prestigeDarknetState` drops `labyrinth`, `labEndpoint` and
    // `labLocations` outright, so a walk that did not finish inside an install
    // is not merely interrupted — the maze it was walking no longer exists.
    this.#labMaze = undefined;
    this.#labEndpoint = undefined;
    this.#labLocations.clear();
    this.#migrationCharge.clear();
    // Stasis links are engine state on `DarknetState` and go with it. They are
    // also worth nothing across an install: the link pins a host against a
    // mutation clock that a prestige resets anyway.
    for (const host of this.hosts.values()) host.stasisLinked = false;
    // `prestigeDarknetState` restamps `lastPhishingCacheTime`, so an install
    // starts with the phishing cache window SHUT. Modelled because it is a real
    // three-minute hole at exactly the moment a run has the most residents.
    if (nowMs !== undefined) this.#lastPhishingCacheMs = nowMs;
    // The storm clock too: `lastStormTime` is module scope and restamped when
    // the engine reloads, so no seed can be minted in an install's first
    // thirty minutes. The seeds themselves go with the per-server state.
    if (nowMs !== undefined) this.#lastStormMs = nowMs;
    this.#stormSeeds.clear();
    this.#offlineServers.clear();
    this.#storm = undefined;
    this.record("darkweb");
    if (this.hasAccess()) this.populate();
  }

  /** populateDarknet(). Idempotent, as upstream's guard makes it.
   *
   * The labyrinth goes down FIRST, exactly as upstream orders it —
   * `addLabyrinth()` then `addRandomDarknetServers()` — because
   * `addServerToNetwork` links a host to the lab when it lands on the deepest
   * row. Placing it last, as this used to, meant only one host ever reached it. */
  populate(): void {
    if (this.#populated) return;
    this.#populated = true;
    const { generate } = this.#opts;
    const depth = this.netDepth();
    this.#placeLab();
    // The loop bound is fractional upstream, so the loop adds ceil(count).
    // Row top-ups use ordinary random difficulty; only the count comes from
    // the shallow row's current population.
    const count = Math.max(0, depth * NET_WIDTH * SERVER_DENSITY - 10);
    for (let i = 0; i < count; i++) {
      this.#addHost(Math.floor(generate() * depth), generate(), generate());
    }
    const rowZeroTopUp = 5 - this.#onRow(0).length;
    for (let i = 0; i < rowZeroTopUp; i++) {
      this.#addHost(Math.floor(generate() * depth), generate(), generate());
    }
    const rowOneTopUp = 5 - this.#onRow(1).length;
    for (let i = 0; i < rowOneTopUp; i++) {
      this.#addHost(Math.floor(generate() * depth), generate(), generate());
    }
    const roll: number[] = [];
    for (let i = 0; i < MUTATION_DRAWS; i++) roll.push(generate());
    this.#balance(roll);
    for (let i = 0; i < depth; i++) this.#addConnections(generate(), generate());
  }

  /** One darknet host, exactly as `populate` and a later `addRandomDarknetServers`
   * both need it. Shared so a host added by a mutation is indistinguishable from
   * one the generator placed — otherwise a net that had churned would drift into
   * a different shape from a fresh one. */
  #buildHost(hostname: string, difficulty: number, depth: number, leftOffset: number): void {
    const { generate, servers } = this.#opts;
    const maxRam = rollMaxRam(difficulty, generate);
    const blockedRam = rollBlockedRam(maxRam, generate);
    const pool = modelPool(difficulty, this.#opts.fullAccess());
    const model = pool[Math.floor(generate() * pool.length)]!;
    // EXACTLY ONE draw for the whole secret. `getXorMaskEncryptedPasswordConfig`,
    // `getPasswordMadeUpOfPrimesProduct` and `generateSimpleArithmeticExpression`
    // are unbounded rejection loops upstream, so generating from the shared
    // stream would make a host's cost depend on how unlucky its password was.
    const secretDraw = generate();
    const secret = generateSecret(model, difficulty, passwordRng(secretDraw, hostname));
    const lab = this.currentLab();
    const labDepth = lab?.depth ?? NO_SF15_NET_DEPTH;
    const labCharisma = lab?.cha ?? 300;
    const charisma = requiredCharismaSkill(difficulty, labDepth, labCharisma, generate());
    this.hosts.set(hostname, {
      hostname,
      modelId: model,
      password: secret.password,
      passwordHint: secret.hint,
      data: secret.data,
      passwordLength: secret.passwordLength,
      passwordFormat: secret.passwordFormat,
      secretDraw,
      // DarknetServerOptions.ts:87.
      logTrafficInterval: 1 + 30 * 0.9 ** difficulty,
      blockedRam,
      difficulty,
      depth,
      // Assigned by #seat below, which is the only writer — see the grid index.
      leftOffset: -1,
      requiredCharismaSkill: charisma,
      isStationary: false,
      stasisLinked: false,
      online: true,
      sessions: new Set<number>(),
      logs: [],
    });
    // Into the grid index too, so `Network[depth][leftOffset]` and `hosts` agree
    // from the moment the host exists rather than from its first wiring.
    this.#seat(this.hosts.get(hostname)!, depth, leftOffset);
    const server = mockServer({
      hostname,
      ip: randomIp(generate),
      maxRam,
      // Blocked RAM presents as USED RAM, which is what makes it unallocatable
      // (NetscriptWorker.ts:243).
      ramUsed: blockedRam,
      hasAdminRights: false,
    }) as SimServer;
    server.simKind = "DarknetServer";
    servers.set(hostname, server);
  }

  /** `addLabyrinth` builds every lab server unconditionally, but only the
   * current one is reachable — `getLabyrinthDetails` resolves exactly one and
   * the rest are never consulted. So one host is placed, with the labyrinth
   * model id and the 128 GB / difficulty 10 / stationary values upstream gives
   * it.
   * Source: src/DarkNet/controllers/NetworkGenerator.ts:235-261 */
  #placeLab(): void {
    const lab = this.currentLab();
    if (!lab) return;
    const { servers, network, generate } = this.#opts;
    this.hosts.set(lab.hostname, {
      hostname: lab.hostname,
      modelId: "(The Labyrinth)",
      // The labyrinth is a maze, not a password, and it is handled before the
      // model switch upstream. An unguessable value is the faithful answer.
      password: "(the labyrinth is not a password)",
      passwordHint: "You have discovered a dark, mysterious maze. Your footsteps echo eerily in the silence.",
      data: "",
      passwordLength: 0,
      passwordFormat: "ASCII",
      secretDraw: 0,
      // Number.MAX_SAFE_INTEGER upstream: a lab never adds log traffic.
      logTrafficInterval: Number.MAX_SAFE_INTEGER,
      blockedRam: 0,
      difficulty: 10,
      depth: -1,
      leftOffset: -1,
      requiredCharismaSkill: lab.cha,
      isStationary: true,
      stasisLinked: false,
      online: true,
      sessions: new Set<number>(),
      logs: [],
    });
    const server = mockServer({ hostname: lab.hostname, ip: randomIp(generate), maxRam: 128 }) as SimServer;
    server.simKind = "DarknetServer";
    servers.set(lab.hostname, server);
    // No edges of its own: every host that lands on the deepest row wires itself
    // to the lab, which is `addServerToNetwork`'s own maxDepth-1 branch.
    network.set(lab.hostname, []);
  }

  /** probe(): darknet neighbours of the CALLING host only. Not access-gated
   * upstream, but it can only ever see what populate() created. */
  probeFrom(hostname: string): string[] {
    return (this.#opts.network.get(hostname) ?? [])
      .filter((name) => this.#opts.servers.get(name)?.simKind === "DarknetServer");
  }

  record(hostname: string): DarknetHost | undefined {
    const generated = this.hosts.get(hostname);
    if (generated) return generated;
    // darkweb is not generated — initDarkwebServer builds it unconditionally,
    // before and independently of populateDarknet — but it IS a DarknetServer
    // and getServerDetails answers for it from any distance. Its values are the
    // special case upstream hands it.
    // Source: https://github.com/bitburner-official/bitburner-src/blob/3162fd2590e221eadd0c0fbd46151913f7c4c41c/src/DarkNet/controllers/NetworkGenerator.ts#L52-L89
    if (hostname !== "darkweb") return undefined;
    if (this.#opts.servers.get("darkweb")?.simKind !== "DarknetServer") return undefined;
    // Cached rather than rebuilt per call: its log ring and its session set have
    // to persist, and a fresh object every read would silently discard both —
    // which would make the one host every run starts on the one host that can
    // never remember anything.
    if (!this.#darkweb) {
      this.#darkweb = {
        hostname: "darkweb",
        modelId: "ZeroLogon",
        password: "",
        passwordHint: "There is no password",
        data: "",
        passwordLength: 0,
        passwordFormat: "numeric",
        secretDraw: 0,
        logTrafficInterval: 1 + 30,
        blockedRam: 0,
        difficulty: 0,
        depth: -1,
        leftOffset: -1,
        requiredCharismaSkill: 1,
        isStationary: true,
        stasisLinked: false,
        online: true,
        sessions: new Set<number>(),
        logs: [],
      };
    }
    return this.#darkweb;
  }

  /** `getStasisLinkLimit()`: `1 + TheBrokenWings + TheHammer + TheStaff`.
   *
   * Read from INSTALLED augmentations, exactly as upstream's `hasAugmentation`
   * does, so a labyrinth reward sitting in the queue does not widen the limit
   * before the install that grants it. This is the loop the whole deep half of
   * the feature turns on: walking a lab buys stasis capacity, and stasis
   * capacity is what protects the next walker. */
  stasisLinkLimit(): number {
    const installed = this.#opts.installedAugmentations();
    return 1
      + (installed.has(LAB_AUGMENTATIONS[0]) ? 1 : 0)
      + (installed.has(LAB_AUGMENTATIONS[2]) ? 1 : 0)
      + (installed.has(LAB_AUGMENTATIONS[3]) ? 1 : 0);
  }

  /** `getBackdooredDarknetServers()`: movable, unpinned, and backdoored.
   *
   * The double exclusion is what makes stasis-plus-backdoor free. A pinned host
   * is outside `getAllMovableDarknetServers` already, and this filters
   * `!hasStasisLink` again on top — so its backdoor contributes to neither the
   * instability surplus nor the timeout chance, and it cannot be drawn by the
   * two mutation branches that pick their victim from this pool. */
  #backdoored(): DarknetHost[] {
    return this.#movable()
      .map((name) => this.hosts.get(name)!)
      .filter((host) => !host.stasisLinked && this.#opts.servers.get(host.hostname)?.backdoorInstalled === true);
  }

  /** `getBackdoorAuthTimeDebuff` and `getTimeoutChance`, both measured rather
   * than assumed.
   *
   * The allowance is `max(rootedMovable / (NET_WIDTH * 3), 2)`, so TWO backdoors
   * are always free and the allowance grows as the net is rooted. Past it every
   * authentication in the run — not just one against the backdoored host —
   * costs `1.07 ^ surplus`, which is what makes a backdoor a decision rather
   * than a freebie.
   *
   * The timeout chance is a different curve off the same count and starts at
   * the SECOND backdoor: `max(min((backdoored - 2) * 0.03, 0.5), 0)`. It is the
   * only way a 408 can ever be produced, which is why the `dnet.authTimeout`
   * assumption said the sim could not produce one until this existed.
   * Source: src/DarkNet/effects/effects.ts:91-97,
   *   src/DarkNet/effects/offlineServerHandling.ts:151-154 */
  instability(): { authenticationDurationMultiplier: number; authenticationTimeoutChance: number } {
    const backdoored = this.#backdoored().length;
    const rooted = this.#movable()
      .filter((name) => this.#opts.servers.get(name)?.hasAdminRights === true).length;
    const safe = Math.max(rooted / (NET_WIDTH * 3), 2);
    const surplus = Math.max(0, backdoored - safe);
    return {
      authenticationDurationMultiplier: 1.07 ** surplus,
      authenticationTimeoutChance: Math.max(Math.min((backdoored - 2) * 0.03, 0.5), 0),
    };
  }

  stasisLinkedServers(): string[] {
    return [...this.hosts.values()]
      .filter((host) => host.stasisLinked)
      .map((host) => host.hostname)
      .sort();
  }

  /** `setStasisLink(shouldLink)`, which takes NO host: it pins the calling
   * script's own server. That is the whole reason spending a link needs a job
   * standing on the host being pinned, and why home can never spend one itself.
   *
   * Returns the response code rather than a result object; the ns wrapper above
   * shapes it. Source: src/NetscriptFunctions/Darknet.ts:337-374 */
  setStasisLink(hostname: string, shouldLink: boolean): number {
    const host = this.hosts.get(hostname);
    // Not a darknet server at all: the caller is standing somewhere ordinary.
    if (!host) return 503;
    // THE SIDE EFFECT NOBODY EXPECTS, and it is in the engine rather than in a
    // doc comment: `setStasisLink` writes `server.backdoorInstalled = shouldLink`
    // alongside the link (`effects.ts:233-234`). So pinning a host DOES give it
    // remote `exec` — not because a link is a reachability primitive, but
    // because upstream installs a backdoor at the same moment — and RELEASING a
    // link takes the backdoor away with it. The pinned host is still excluded
    // from `getBackdooredDarknetServers`, so the backdoor is free of both the
    // instability surplus and the two mutation branches.
    const server = this.#opts.servers.get(hostname);
    if (!shouldLink) {
      host.stasisLinked = false;
      if (server) server.backdoorInstalled = false;
      return 200;
    }
    if (host.stasisLinked) return 200;
    // The limit is GLOBAL, which is what makes a link scarce enough to rank
    // candidates for at all.
    if (this.stasisLinkedServers().length >= this.stasisLinkLimit()) return 453;
    host.stasisLinked = true;
    if (server) server.backdoorInstalled = true;
    return 200;
  }

  // --- induced migration ----------------------------------------------------

  /** `DarknetState.migrationInductionServers`: accumulated charge per host.
   *
   *  Engine state that NO ns member reads back, which is the fact that shapes
   *  the strategy: a script can only ever infer its progress from the host's
   *  depth changing. */
  readonly #migrationCharge = new Map<string, number>();

  /** Whether THIS authentication times out, from the instability curve.
   *
   * Drawn off the NOISE stream rather than the gameplay one. The number of
   * authentications a run makes is a property of the strategy, so billing these
   * draws to the shared stream would let a cracking policy perturb stock prices
   * across an A/B — the same reason log noise has its own stream. The
   * probability is upstream's exactly; only the source of the coin differs, and
   * it is declared in `DNET_ASSUMPTIONS`. */
  timesOut(): boolean {
    const chance = this.instability().authenticationTimeoutChance;
    if (chance <= 0) return false;
    return (this.#opts.logNoise ?? this.#opts.generate)() < chance;
  }

  migrationCharge(hostname: string): number {
    return this.#migrationCharge.get(hostname) ?? 0;
  }

  /** `chargeServerMigration`, and the move it fires at 1.
   *
   * Two things here are easy to get wrong and both change the strategy:
   *
   * - The charge is `((cha + 500) / (difficulty * 200 + 1000)) * 0.01 * threads`,
   *   so it is anchored on DIFFICULTY rather than depth and a deep-difficulty
   *   host charges far more slowly than a shallow one.
   * - The move is `moveDarknetServer(server, 2, 4)` whose `startingDepth`
   *   defaults to `server.difficulty` — NOT its current depth. So a host is
   *   re-rolled inside `[difficulty - 2, difficulty + 4]` however many times it
   *   has already been pushed, and no quantity of charge walks a shallow host
   *   to the bottom row.
   * Source: src/DarkNet/effects/effects.ts:245-262,
   *   src/DarkNet/controllers/NetworkMovement.ts:230-260 */
  chargeMigration(
    hostname: string,
    threads: number,
    charisma: number,
  ): { chargeIncrease: number; newCharge: number; charismaExp: number; moved: boolean; deleted: boolean } {
    // The placement draws come off the DEDICATED stream, not the gameplay one.
    // How often a migration is charged is a property of the strategy, so taking
    // these from the shared stream would let a darknet policy perturb stock
    // prices across an A/B — the same reason log noise has its own. Declared in
    // DNET_ASSUMPTIONS.
    const draw = this.#opts.logNoise ?? this.#opts.generate;
    const host = this.hosts.get(hostname);
    if (!host) return { chargeIncrease: 0, newCharge: 0, charismaExp: 0, moved: false, deleted: false };
    const chargeIncrease = ((charisma + 500) / (host.difficulty * 200 + 1000)) * 0.01 * threads;
    const charismaExp = 5 * threads * host.difficulty;
    const newCharge = Math.min(this.migrationCharge(hostname) + chargeIncrease, 1);
    this.#migrationCharge.set(hostname, newCharge);
    if (newCharge < 1) return { chargeIncrease, newCharge, charismaExp, moved: false, deleted: false };
    const before = host.depth;
    const deleted = !this.#moveWithin(hostname, host.difficulty - 2, host.difficulty + 4, draw(), draw());
    this.#migrationCharge.set(hostname, 0);
    return {
      chargeIncrease,
      newCharge,
      charismaExp,
      moved: !deleted && this.hosts.get(hostname)!.depth !== before,
      deleted,
    };
  }

  // --- cache files --------------------------------------------------------

  /** `.cache` filenames per host. Upstream keeps them on the server object; the
   * sim keeps them here because SimServer is the shared Server shape. */
  readonly caches = new Map<string, string[]>();

  /** `addCacheToServer`. A phishing cache is `.d.cache`, and only those can
   * award coding contracts. Duplicate names are refused, as upstream does. */
  addCache(hostname: string, fromPhishing: boolean, prefix?: string): string | undefined {
    const suffix = fromPhishing ? ".d.cache" : ".cache";
    // The PREFIX is load-bearing for exactly one cache: `openCache` routes a
    // labyrinth cache to `getLabReward` by testing that the filename contains
    // `the_great_work` (`cacheFiles.ts:39`), and a lab cache named anything else
    // would silently pay out money instead of an augmentation.
    const chosenPrefix = prefix ?? CACHE_PREFIXES[Math.floor(this.#opts.random() * CACHE_PREFIXES.length)]!;
    const name = `${chosenPrefix}_${this.#opts.random().toString().substring(2, 5)}${suffix}`;
    const held = this.caches.get(hostname) ?? [];
    if (held.includes(name)) return undefined;
    held.push(name);
    this.caches.set(hostname, held);
    return name;
  }

  cachesOn(hostname: string): readonly string[] {
    return this.caches.get(hostname) ?? [];
  }

  /** lodash `shuffle` with an isolated response stream: exact ordering law,
   * without allowing a controller's probe frequency to perturb stock prices. */
  shuffleProbe(names: readonly string[]): string[] {
    const out = [...names];
    const random = this.#opts.logNoise ?? this.#opts.random;
    for (let index = 0; index < out.length; index++) {
      const picked = index + Math.floor(random() * (out.length - index));
      [out[index], out[picked]] = [out[picked]!, out[index]!];
    }
    return out;
  }

  /** `addClue`, including its independent fall-through rolls. A failed branch
   * keeps going; a written data file returns immediately. */
  addClue(hostname: string): void {
    const source = this.record(hostname);
    if (!source) return;
    const random = this.#opts.random;
    const writeText = (filename: string, contents: string): void => {
      if (this.#opts.writeTextFile) return this.#opts.writeTextFile(hostname, filename, contents);
      let files = this.#standaloneTextFiles.get(hostname);
      if (!files) this.#standaloneTextFiles.set(hostname, files = new Set());
      files.add(filename);
    };
    // The literature hint is not controller-visible, but its draws precede
    // every data-file roll and therefore remain part of the exact sequence.
    if ((random() < 0.7 && source.difficulty <= 3) || random() < 0.1) random();

    if (random() < 0.1) {
      const length = 15;
      const filename = `${PASSWORD_FILE_NAMES[Math.floor(random() * PASSWORD_FILE_NAMES.length)]}.data.txt`;
      const start = Math.floor(random() * (COMMON_PASSWORDS.length - length));
      writeText(filename, `Some common passwords include ${COMMON_PASSWORDS.slice(start, start + length).join(", ")}`);
      return;
    }
    if (random() < 0.1) {
      const neighbour = (this.#opts.network.get(hostname) ?? [])
        .map((name) => this.record(name))
        .find((entry) => entry && !this.#opts.servers.get(entry.hostname)?.hasAdminRights && entry.password);
      // Filename is rolled even if no qualifying neighbour exists upstream.
      const filename = `${PASSWORD_FILE_NAMES[Math.floor(random() * PASSWORD_FILE_NAMES.length)]}.data.txt`;
      if (neighbour) {
        writeText(filename, `Remember this password: ${neighbour.password}`);
        return;
      }
    }
    const adjacent = (disconnected: boolean): DarknetHost | undefined =>
      this.#adjacent(source.depth, source.leftOffset).find((entry) =>
        entry.password
        && !this.#opts.servers.get(entry.hostname)?.hasAdminRights
        && (!disconnected || !(this.#opts.network.get(hostname) ?? []).includes(entry.hostname)));
    if (random() < 0.1) {
      const filename = `${PASSWORD_FILE_NAMES[Math.floor(random() * PASSWORD_FILE_NAMES.length)]}.data.txt`;
      const target = adjacent(true);
      if (target) {
        writeText(filename, `Server: ${target.hostname} Password: "${target.password}"`);
        return;
      }
    }
    if (random() < 0.4) {
      const filename = `${NOTEBOOK_FILE_NAMES[Math.floor(random() * NOTEBOOK_FILE_NAMES.length)]}.data.txt`;
      const contents = PACKET_SNIFF_PHRASES[Math.floor(random() * PACKET_SNIFF_PHRASES.length)]!;
      writeText(filename, contents);
      return;
    }
    if (random() < 0.7) {
      const filename = `${PASSWORD_FILE_NAMES[Math.floor(random() * PASSWORD_FILE_NAMES.length)]}.data.txt`;
      const target = adjacent(false);
      if (target) {
        const firstIndex = Math.floor(random() * target.password.length);
        let secondIndex = Math.floor(random() * target.password.length);
        if (secondIndex === firstIndex) secondIndex = (secondIndex + 1) % target.password.length;
        writeText(
          filename,
          `The password for ${target.hostname} contains ${target.password[firstIndex]} and ${target.password[secondIndex]}`,
        );
      }
    }
  }

  // --- the storm ------------------------------------------------------------

  /** Hosts holding `STORM_SEED.exe`. Upstream keeps the file in
   * `server.programs`; the sim keeps it here for the same reason the caches
   * are here — SimServer is the shared Server shape. A set rather than a
   * single slot because the engine's seed-exists gate scans MOVABLES only, so
   * a seed parked on a stasis-pinned host does not stop another spawning. */
  readonly #stormSeeds = new Set<string>();
  /** `lastStormTime`, stamped at construction and every prestige. */
  #lastStormMs: number | undefined;
  /** The webstorm in progress — the `mutationLock` analog. While set, the
   * ordinary mutation clock is frozen and `nextMutation()` resolves on storm
   * phases instead. */
  #storm: { phase: number; cyclesLeft: number; serversToDelete?: number } | undefined;

  /** Whether `STORM_SEED.exe` sits on this host — what `ls` appends. */
  stormSeedOn(hostname: string): boolean {
    return this.#stormSeeds.has(hostname);
  }

  /** Test hook: place a seed directly, the way a scenario arranges its board. */
  plantStormSeed(hostname: string): void {
    this.#stormSeeds.add(hostname);
  }

  stormActive(): boolean {
    return this.#storm !== undefined;
  }

  /** `handleRamBlockClearedRewards`' seed roll, taken once per block cleared
   * to zero. Player-initiated, so the entropy comes off the dedicated noise
   * stream (see `dnet.playerDraws`). Order matters and is upstream's: the
   * cooldown gate, the movables-only seed-exists scan, then the 15% roll.
   * Source: src/DarkNet/effects/ramblock.ts:50-66 */
  #maybeDropSeed(hostname: string, nowMs: number | undefined): void {
    if (this.#lastStormMs !== undefined && nowMs !== undefined
      && nowMs - this.#lastStormMs <= STORM_COOLDOWN_MS) return;
    for (const name of this.#stormSeeds) {
      const held = this.hosts.get(name);
      if (held?.online === true && !this.#immutable(held)) return;
    }
    const draw = this.#opts.logNoise ?? this.#opts.generate;
    if (draw() >= STORM_SEED_CHANCE) return;
    this.#stormSeeds.add(hostname);
  }

  /** `unleashStormSeed`, from the calling host.
   *
   * The consume-then-check order is upstream's own hazard, reproduced
   * deliberately: `handleStormSeed` deletes the file and stamps
   * `lastStormTime` BEFORE `launchWebstorm` checks the lock, so firing into a
   * storm already running burns the seed for nothing.
   * Source: src/DarkNet/effects/webstorm.ts:25-40, ramblock.ts:50-66 */
  unleashStormSeed(hostname: string, nowMs: number): { success: boolean; code: number; message: string } {
    if (!this.#stormSeeds.has(hostname)) {
      return { success: false, code: 404, message: "STORM_SEED.exe not found on this server." };
    }
    this.#stormSeeds.delete(hostname);
    this.#lastStormMs = nowMs;
    if (this.#storm !== undefined) {
      return { success: false, code: 503, message: "Service Unavailable" };
    }
    this.#storm = { phase: 0, cyclesLeft: STORM_PHASE_CYCLES[0]! };
    return { success: true, code: 200, message: "The webstorm approaches. There is no escape." };
  }

  /** The burst, one phase gap at a time on the same 200 ms cycles the ordinary
   * clock runs on. Each elapsed gap applies its phase's action and resolves
   * `nextMutation()` — upstream's waiters wake on storm phases while the lock
   * is held. */
  #stormProcess(cycles: number): void {
    let storm: { phase: number; cyclesLeft: number; serversToDelete?: number } | undefined = this.#storm;
    if (!storm) return;
    storm.cyclesLeft -= cycles;
    while (storm.cyclesLeft <= 0) {
      // Annotated to break TS7022: narrowing the reassigned `let` above makes
      // these two circular through the assignment below without them.
      const leftover: number = storm.cyclesLeft;
      this.#applyStormPhase(storm);
      this.#triggerNextMutation();
      const next: number = storm.phase + 1;
      if (next >= STORM_PHASE_CYCLES.length) {
        this.#storm = undefined;
        // The ordinary clock resumes from zero: the lock held it, it did not
        // accumulate under it.
        this.#cyclesSinceMutation = 0;
        return;
      }
      storm = { phase: next, cyclesLeft: STORM_PHASE_CYCLES[next]! + leftover, serversToDelete: storm.serversToDelete };
      this.#storm = storm;
    }
  }

  /** One phase's action, per `launchWebstorm`'s sequence: warning, then
   * deletion target `0.6 * movables + random(0, netDepth) - 6`, then movement count
   * `(postDeleteMovables - requestedDeletes) * 0.6`, and every movable restarted;
   * three add waves then add
   * NET_WIDTH * 5 fresh hosts, then the density balance. Every pool the
   * phases draw from excludes stationary and stasis-linked hosts, which is
   * the entire reason a link is worth a slot. Player-initiated draws, so the
   * dedicated stream (see `dnet.playerDraws`). */
  #applyStormPhase(storm: { phase: number; serversToDelete?: number }): void {
    const draw = this.#opts.logNoise ?? this.#opts.generate;
    const { phase } = storm;
    switch (phase) {
      case 0: {
        const movable = this.#movable();
        const count = Math.max(0, movable.length * 0.6 + draw() * this.netDepth() - 6);
        storm.serversToDelete = count;
        for (let i = 0; i < count; i++) this.#deleteOne(draw());
        break;
      }
      case 1: {
        const count = Math.max(0, (this.#movable().length - (storm.serversToDelete ?? 0)) * 0.6);
        for (let i = 0; i < count; i++) {
          const name = this.#pick(this.#movable(), draw());
          this.#moveHost(name, draw(), draw());
        }
        for (const name of this.#movable()) this.#restartHost(name);
        break;
      }
      case 2:
      case 3:
      case 4: {
        const count = phase === 2 ? NET_WIDTH : 2 * NET_WIDTH;
        for (let i = 0; i < count; i++) {
          this.#addHost(Math.floor(draw() * this.netDepth()), draw(), draw());
        }
        break;
      }
      case 5: {
        // balanceDarknetServers, off a synthesized draw block: `#balance`
        // indexes into a mutation-shaped roll array, and the storm's draws
        // come off the dedicated stream rather than the gameplay one.
        const roll: number[] = [];
        for (let i = 0; i < MUTATION_DRAWS; i++) roll.push(draw());
        this.#balance(roll);
        break;
      }
    }
  }

  // --- memoryReallocation ---------------------------------------------------

  /** `handleRamBlockRemoved`, and the two writes are separate ON PURPOSE.
   *
   * Upstream does `server.blockedRam = roundToTwo(blockedRam - removed)` and
   * then `server.updateRamUsed(server.ramUsed - removed)` — two fields, one
   * figure. Collapsing them would hide the invariant the whole feature leans on:
   * blocked RAM presents AS used RAM, so a script only ever sees the block
   * through `getServerUsedRam`, and a model that moved one without the other
   * would make reported availability disagree with what `exec` accepts.
   *
   * Clearing the block to zero drops a `.cache` on a non-labyrinth host, with no
   * roll at all. The two side rolls upstream also makes here — a 30% clue file
   * and the storm seed — are declared in DNET_ASSUMPTIONS rather than invented.
   * Source: src/DarkNet/effects/ramblock.ts:22-66 */
  reallocateRam(
    hostname: string,
    threads: number,
    charisma: number,
    nowMs?: number,
  ): { freed: number; blockedRam: number; cleared: boolean; charismaExp: number } | undefined {
    const host = this.record(hostname);
    if (!host) return undefined;
    const freed = ramBlockRemoved(host.difficulty, host.blockedRam, threads, charisma);
    host.blockedRam = roundToTwo(host.blockedRam - freed);
    const server = this.#opts.servers.get(hostname);
    if (server) server.ramUsed = Math.max(0, roundToTwo(server.ramUsed - freed));
    let cleared = false;
    if (host.blockedRam <= 0) {
      cleared = true;
      if (!isLabyrinth(hostname, host.modelId)) {
        this.addCache(hostname, false);
        if (this.#opts.random() < 0.3) this.addClue(hostname);
        this.#maybeDropSeed(hostname, nowMs);
      }
    }
    return {
      freed,
      blockedRam: host.blockedRam,
      cleared,
      charismaExp: reclaimCharismaExp(host.difficulty, threads),
    };
  }

  // --- phishingAttack -------------------------------------------------------

  /** When a `.d.cache` last landed. NET-WIDE, on `DarknetState` and not on any
   *  server, which is the whole reason phishing is a trickle: twenty caches an
   *  hour however many hosts are phishing. */
  #lastPhishingCacheMs: number | undefined;

  /** `phishingCacheCooldownReached`. Source: src/DarkNet/effects/phishing.ts:70 */
  phishCooldownReached(nowMs: number): boolean {
    if (this.#lastPhishingCacheMs === undefined) return true;
    return nowMs - this.#lastPhishingCacheMs > PHISH_CACHE_COOLDOWN_MS;
  }

  /** `handlePhishingAttack`, in upstream's branch order and with its
   * short-circuits intact.
   *
   * The order is load-bearing twice over. The cache branch is an `if` and the
   * money branch its `else if`, so claiming a cache FORECLOSES that call's money
   * roll — and while the cooldown is unexpired every call falls straight through
   * to money. And `cooldownReached() && random() < chance` short-circuits, so a
   * call made inside the cooldown takes ONE draw rather than two.
   *
   * The charisma experience is returned rather than applied, because
   * `Player.mults.charisma_exp` and `gainCharismaExp` live on the ns side.
   * Source: src/DarkNet/effects/phishing.ts:14-73 */
  phish(
    hostname: string,
    threads: number,
    charisma: number,
    nowMs: number,
  ): { success: boolean; code: number; message: string; charismaExp: number } {
    const host = this.record(hostname);
    const person = this.#opts.world.person;
    const mults = person.mults as unknown as Record<string, number>;
    const crimeSuccess = mults["crime_success"] ?? 1;
    const xpReward = phishCharismaExp(threads);
    const cacheChance = phishCacheChance(threads, charisma, crimeSuccess);
    const moneyChance = phishMoneyChance(charisma, crimeSuccess);
    const isLab = host !== undefined && isLabyrinth(hostname, host.modelId);
    const random = this.#opts.random;

    if (this.phishCooldownReached(nowMs) && random() < cacheChance && !isLab) {
      this.addCache(hostname, true);
      this.#lastPhishingCacheMs = nowMs;
      return {
        success: true,
        code: 200,
        message: "Phishing attack succeeded! Found a cache file. (Gained cha xp)",
        charismaExp: xpReward,
      };
    }
    if (random() < moneyChance) {
      // U(0.9, 1.2) — drawn here rather than folded into a mean, because the
      // spread is what a strategy measuring phishing income actually sees.
      const randomFactor = random() * 0.3 + 0.9;
      // `hasDarknetBonusTime()` is offline accrual, which this world does not
      // have. False by truth rather than by stub.
      const depthFactor = 0.1 + (host?.depth ?? 0) * 0.05;
      const reward = 500
        * (mults["crime_money"] ?? 1)
        // The second of the two places dnet_money is read at all, and the
        // reason five of the six labyrinth augmentations raise it.
        * (mults["dnet_money"] ?? 1)
        * depthFactor
        * threads
        * ((400 + charisma) / 400)
        * randomFactor
        * this.#opts.darknetMoneyMultiplier();
      this.#opts.player.money += reward;
      // Upstream attributes this to a `darknet` source the ns MoneySource
      // interface does not expose, so "other" is the closest key there is.
      this.#opts.world.recordMoney("other", reward);
      return {
        success: true,
        code: 200,
        message: `Phishing attack succeeded! $${reward} retrieved. (Gained cha xp)`,
        charismaExp: xpReward,
      };
    }
    // Every call pays, and this is the quarter rate that makes phishing the
    // reliable charisma source rather than the lottery it looks like.
    return {
      success: false,
      code: 455,
      message: "There were no takers on that phishing attempt. (Gained cha xp)",
      charismaExp: xpReward / 4,
    };
  }

  /** `getRewardFromCache`. Karma is spent whatever the reward turns out to be,
   * and the reward is drawn uniformly from the applicable kinds.
   *
   * All branches resolve into their live subsystem: stock holdings, host text
   * files, generated contracts, home programs/market access, or player money.
   * Source: src/DarkNet/effects/cacheFiles.ts:35-74 */
  openCache(hostname: string, filename: string): { success: boolean; message: string; karmaLoss: number } {
    const record = this.record(hostname);
    const held = this.caches.get(hostname) ?? [];
    if (!record || !held.includes(filename)) {
      // Upstream THROWS here rather than refusing — `helpers.errorMessage` on
      // both the bad-path and the not-found branches
      // (`NetscriptFunctions/Darknet.ts:292-303`). That is a materially
      // different failure from a refusal, because a throw kills the calling
      // script: a job that opened a cache off a stale listing would cost its
      // host the resident standing on it. Refusing quietly would have hidden
      // exactly the bug the guard in `game/dnet/orders.ts` exists to prevent.
      throw new Error(`Cache file not found: ${filename} on server ${hostname}`);
    }
    this.caches.set(hostname, held.filter((name) => name !== filename));
    const karmaLoss = record.difficulty + 1;
    this.#opts.player.karma -= karmaLoss;

    // THE LABYRINTH CACHE, which is a different thing wearing the same suffix.
    // It queues an augmentation directly rather than drawing from the reward
    // table — and the generic augmentation price multiplier is
    // `1.9 ^ (queued non-SoA)`, charged against every purchase made after it,
    // which is why home defers opening one until its shopping is done.
    if (isLabyrinth(hostname, record.modelId) && filename.includes("the_great_work")) {
      const reward = this.labReward() ?? NEUROFLUX;
      const named = this.#opts.installedAugmentations().has(reward) ? NEUROFLUX : reward;
      this.#opts.player.queuedAugmentations.set(
        named,
        (this.#opts.player.queuedAugmentations.get(named) ?? 0) + 1,
      );
      return {
        success: true,
        message: `You have discovered a cache with the augmentation ${named}!`,
        karmaLoss: -karmaLoss,
      };
    }

    // Three base kinds, phishing-only contracts, and optional money: the exact
    // upstream array and therefore the exact uniform branch probabilities.
    const kinds: (() => string)[] = [
      () => this.#programOrMarketReward(record.difficulty),
      () => this.#stockReward(record.difficulty),
      () => this.#dataFileReward(record.difficulty, hostname),
    ];
    if (filename.endsWith(".d.cache")) kinds.push(() => this.#contractReward(record.difficulty, hostname));
    if (this.#opts.darknetMoneyMultiplier() !== 0) {
      kinds.push(() => this.#moneyReward(record.difficulty));
    }
    const message = kinds[Math.floor(this.#opts.random() * kinds.length)]!();
    return { success: true, message, karmaLoss: -karmaLoss };
  }

  /** `getMoneyReward`. SF15.3 is the 1.5x, and both crime_money and dnet_money
   * apply — the only place dnet_money is read at all. */
  #moneyReward(difficulty: number): string {
    const player = this.#opts.player;
    const person = this.#opts.world.person;
    const sf15 = player.sourceFiles["15"] ?? 0;
    const reward = 1.2 ** difficulty
      * 1e7
      * ((200 + person.skills.charisma) / 200)
      * (sf15 >= 3 ? 1.5 : 1)
      * (person.mults.crime_money ?? 1)
      // The one place dnet_money is read. Five of the six labyrinth
      // augmentations raise it, which is how the labyrinth pays for itself.
      * ((person.mults as unknown as Record<string, number>)["dnet_money"] ?? 1)
      * this.#opts.darknetMoneyMultiplier();
    player.money += reward;
    // Upstream attributes this to a `darknet` source that MoneySourceTracker
    // has and the ns MoneySource interface does not expose, so a script cannot
    // see darknet income as its own line. "other" is the closest key we have.
    this.#opts.world.recordMoney("other", reward);
    return `You have discovered a cache with ${reward}.`;
  }

  /** `getProgramAndStockMarketRelatedRewards`: the first unowned program in
   * upstream's order, then the WSE account, then TIX API access, then 4S data.
   *
   * Note which 4S it grants — `has4SData`, the in-game ticker, NOT
   * `has4SDataTixApi`. `shared/strategy/stock/decide.ts` documents that the
   * former buys an automated player nothing, since getForecast checks the
   * latter. So the free 4S from a cache is worth exactly as little as the $1b
   * purchase we deliberately never make. */
  #programOrMarketReward(difficulty: number): string {
    const files = this.#opts.homeFiles();
    const creating = this.#opts.player.currentWork?.kind === "createProgram"
      ? this.#opts.player.currentWork.subject
      : undefined;
    for (const program of CACHE_PROGRAMS) {
      if (!files.has(program) && creating !== program) {
        files.add(program);
        return `You have discovered the program ${program}.`;
      }
    }
    const gates = this.#opts.world.gates;
    if (!(this.#opts.stock?.hasWseAccount ?? gates.hasWseAccount)) {
      this.#opts.stock?.grantWseAccount();
      gates.hasWseAccount = true;
      return "You have discovered a stolen WSE Account!";
    }
    if (!(this.#opts.stock?.hasTixApiAccess ?? gates.hasTixApiAccess)) {
      this.#opts.stock?.grantTixApiAccess();
      gates.hasTixApiAccess = true;
      return "You have discovered a stolen TIX API access point!";
    }
    if (!(this.#opts.stock?.has4SData ?? gates.has4SData) && this.#opts.bitNode !== 8
      && (this.#opts.stock?.grant4SData() ?? true)) {
      gates.has4SData = true;
      return "You have discovered a cache of stolen 4S Data!";
    }
    return this.#moneyReward(difficulty);
  }

  #stockReward(difficulty: number): string {
    if (!this.#opts.stock) throw new Error("Darknet stock reward requires the stock market model");
    const reward = this.#opts.stock.grantRandomShares(difficulty, this.#opts.random);
    if (!reward) return this.#moneyReward(difficulty);
    return `You have discovered a stock option cache containing ${reward.shares} shares of ${reward.symbol}!`;
  }

  #dataFileReward(difficulty: number, hostname: string): string {
    const count = (): number => [...(this.#opts.filesOn?.(hostname) ?? this.#standaloneTextFiles.get(hostname) ?? [])]
      .filter((name) => name.endsWith(".data.txt")).length;
    const before = count();
    this.addClue(hostname);
    this.addClue(hostname);
    return count() === before ? this.#moneyReward(difficulty) : "You have discovered a data file cache!";
  }

  #contractReward(difficulty: number, hostname: string): string {
    if (this.#opts.world.clock.now() - this.#createdAtMs <= 10 * 60 * 1_000) return this.#moneyReward(difficulty);
    const count = Math.min(Math.floor(Math.min(20, difficulty) * 0.1 - 1.5 + this.#opts.random() * 3), 3);
    if (count < 1) return this.#moneyReward(difficulty);
    if (!this.#opts.contracts) throw new Error("Darknet coding-contract reward requires the contract model");
    for (let i = 0; i < count; i++) this.#opts.contracts.generate(hostname, 1 / 2);
    return "New coding contracts are now available on the network!";
  }

  // --- sessions -------------------------------------------------------------

  /** Does this PID hold a session on `hostname`?
   *
   * Upstream stores `authenticatedPIDs` per SERVER and prunes it lazily with
   * `findRunningScriptByPid` rather than clearing it when a script dies. This
   * reproduces that, and checks liveness on READ as well as on write — which is
   * a deliberate strengthening, not a copy: `ProcessTable.resetPidCounter()`
   * restarts pids at 1 on prestige, so a stale entry would silently hand a new
   * process someone else's session.
   *
   * Source: src/DarkNet/effects/authentication.ts:199-205 (the darkweb
   *   short-circuit), src/DarkNet/models/DarknetState.ts:135-147 (the prune). */
  isAuthenticated(hostname: string, pid: number, processHost?: string): boolean {
    // The action gate grants a process its own host before consulting stored
    // sessions. This method models only hasSession: darkweb plus explicit PIDs.
    void processHost;
    if (hostname === "darkweb") return true;
    const host = this.record(hostname);
    if (!host || !host.online) return false;
    if (!host.sessions.has(pid)) return false;
    if (this.#opts.processes.get(pid) === undefined) {
      host.sessions.delete(pid);
      return false;
    }
    return true;
  }

  addSession(hostname: string, pid: number): void {
    const host = this.record(hostname);
    if (!host) return;
    for (const held of [...host.sessions]) {
      if (this.#opts.processes.get(held) === undefined) host.sessions.delete(held);
    }
    host.sessions.add(pid);
    const server = this.#opts.servers.get(hostname);
    // Upstream sets hasAdminRights on a successful authentication, and it is
    // what the in-game map draws a green border from. It survives a restart;
    // only the session set does not.
    const firstRoot = server?.hasAdminRights !== true;
    if (server) server.hasAdminRights = true;
    if (firstRoot) {
      this.addClue(hostname);
      if (this.#opts.random() < 0.1 * 1.05 ** host.difficulty && !isLabyrinth(hostname, host.modelId)) {
        this.addCache(hostname, false);
      }
    }
  }

  /** Direct connection, which most darknet calls require and `scp` does not. */
  isDirectConnected(from: string, to: string): boolean {
    if (from === to) return true;
    return (this.#opts.network.get(from) ?? []).includes(to);
  }

  // --- the log ring ---------------------------------------------------------

  /** Back-fill noise for the time that has passed.
   *
   * Upstream's `populateServerLogsWithNoise` is LAZY, not timed: on first touch
   * it seeds two entries dated one and two intervals ago, and thereafter adds
   * `floor(elapsed / interval)` of them. Under the virtual clock that transcribes
   * exactly, with no timer — the whole model is a function of "how long since
   * anyone looked".
   *
   * The back-fill's ORDER is upstream's and looks wrong: the ring is
   * newest-first, but the catch-up array is built oldest-first and prepended
   * whole, so a burst of back-filled lines reads backwards relative to the
   * lines around it. Kept, because a script that timestamps by position would
   * be misled in the game in exactly the same way.
   * Source: src/DarkNet/models/packetSniffing.ts:128-158 */
  populateLogs(hostname: string, nowMs: number): void {
    const host = this.record(hostname);
    if (!host || host.logTrafficInterval === Number.MAX_SAFE_INTEGER) return;
    const intervalMs = host.logTrafficInterval * 1000;
    if (host.lastLogMs === undefined) {
      host.logs = [this.#logNoise(host, nowMs - intervalMs), this.#logNoise(host, nowMs - intervalMs * 2)];
      host.lastLogMs = nowMs;
      return;
    }
    const missing = Math.floor((nowMs - host.lastLogMs) / intervalMs);
    if (missing <= 0) return;
    // Bounded: a run that ignores a host for an hour must not build a thousand
    // lines to throw away, and the ring only holds MAX_LOG_LINES anyway.
    const lines = Math.min(missing, MAX_LOG_LINES);
    const noise: string[] = [];
    for (let i = 0; i < lines; i++) noise.push(this.#logNoise(host, host.lastLogMs + intervalMs * (i + 1)));
    host.logs = [...noise, ...host.logs].slice(0, MAX_LOG_LINES);
    host.lastLogMs = host.lastLogMs + missing * intervalMs;
  }

  /** Everything `capturePackets` and the noise generator need to reach outside
   * one host: the movable pool, the net's hostnames and this host's own most
   * recent authentication attempt.
   *
   * The stream is the DEDICATED noise one, not the shared gameplay stream.
   * `getRandomData` loops until it has 124-144 characters and each iteration
   * takes an unbounded number of draws, so billing it to `random` would let how
   * often a script bleeds — or fails an authenticate against a packet sniffer —
   * perturb stock prices across an A/B. */
  #packetWorld(host: DarknetHost): PacketWorld {
    return {
      rand: this.#opts.logNoise ?? this.#opts.generate,
      movablePasswords: () => [...this.hosts.values()]
        .filter((entry) => entry.online && !entry.isStationary)
        .map((entry) => entry.password),
      serverNames: () => [...this.hosts.keys()],
      lastAttempted: () => {
        for (const line of host.logs) {
          const parsed = parseLogLine(line);
          if (parsed && typeof parsed["passwordAttempted"] === "string") return parsed["passwordAttempted"];
        }
        return null;
      },
    };
  }

  /** `getLogNoise`, every branch.
   *
   * Each `if` is an INDEPENDENT roll upstream rather than a weighted choice, so
   * the later branches only fire when the earlier ones miss — which is why the
   * heartbeat dominates on a high-difficulty host and the password leaks
   * dominate on a shallow one. That shape is the whole reason bleeding a
   * shallow neighbour is worth doing.
   *
   * Drawn from a DEDICATED stream, not the shared gameplay one: the number of
   * draws depends on how long a script waited before bleeding, so using
   * `random` would let log volume perturb stock prices across an A/B — the same
   * fixed-width-draw hazard `#mutate` guards against.
   * Source: src/DarkNet/models/packetSniffing.ts:160-215 */
  #logNoise(host: DarknetHost, atMs: number): string {
    const draw = this.#opts.logNoise ?? this.#opts.generate;
    const neighbours = (this.#opts.network.get(host.hostname) ?? [])
      .filter((name) => this.hosts.has(name) || name === "darkweb");
    const pickNeighbour = (): string | undefined => neighbours[Math.floor(draw() * neighbours.length)];

    if (draw() < 0.2) {
      return PACKET_SNIFF_PHRASES[Math.floor(draw() * PACKET_SNIFF_PHRASES.length)]!;
    }
    // The leak that matters most: a NEIGHBOUR's password, in cleartext. The
    // chance falls with difficulty, exactly as upstream's does.
    if (draw() < 0.05 * (1 / (host.difficulty + 1))) {
      const pick = pickNeighbour();
      const other = pick === undefined ? undefined : this.record(pick);
      if (other) return `Connecting to ${pick}:${other.password} ...`;
    }
    // A topology edge, free.
    if (draw() < 0.05) {
      const pick = pickNeighbour();
      if (pick !== undefined) return `[sending transaction details to ${pick}.]`;
    }
    // Which characters of the last attempt were in the right place.
    if (draw() < 0.1) {
      const last = this.#packetWorld(host).lastAttempted();
      if (last !== null) {
        const placement = getExactCorrectChars(host.password, last);
        const rightChars = host.password.split("").filter((c, i) => placement[i]).slice(0, 2);
        return rightChars.length === 0
          ? "No characters are in the right place."
          : `The characters ${rightChars.join(", ")} are in the right place. `;
      }
    }
    // Two characters of this host's own password.
    if (draw() < 0.1) return getRandomCharsInPassword(host.password, draw);
    // A stranger's password, unattributed.
    if (draw() < 0.05) {
      const movable = [...this.hosts.values()].filter((entry) => entry.online && !entry.isStationary);
      if (movable.length > 0) {
        return `--${movable[Math.floor(draw() * movable.length)]!.password}--`;
      }
    }
    // `addPacketSnifferNoise`: the model that leaks its own password, and often.
    if (host.modelId === "OpenWebAccessPoint" && draw() < 0.7 - host.difficulty * 0.01) {
      if (draw() < 0.3 || neighbours.length === 0) {
        return `Logging in with passcode: ${host.password} ...`;
      }
      const pick = pickNeighbour();
      const other = pick === undefined ? undefined : this.record(pick);
      if (other) return `Connecting to ${other.hostname}:${other.password} ...`;
      return `Logging in with passcode: ${host.password} ...`;
    }
    // Upstream renders the log's date with `toLocaleTimeString()`, which is
    // locale-dependent and therefore not reproducible across machines. A UTC
    // wall clock over the virtual time is the same SHAPE and is deterministic;
    // declared in DNET_ASSUMPTIONS.
    return `${utcClock(atMs)}: ${host.hostname} - heartbeat check (alive)`;
  }

  /** heartbleed's read. `peek` leaves the lines in place. */
  captureLogs(hostname: string, count: number, peek: boolean, nowMs: number): string[] {
    const host = this.record(hostname);
    if (!host) return [];
    const taken = host.logs.slice(0, count);
    if (!peek) host.logs = host.logs.slice(count);
    return taken;
  }

  /** Write an authentication attempt into the ring, as `logPasswordAttempt`
   * does. This is the ONLY way a model's response reaches a script: upstream's
   * `authenticate()` returns a generic failure for everything but the labyrinth.
   *
   * `Pr0verFl0` is the exception that has to be modelled, not glossed: its entry
   * REWRITES `passwordAttempted` to the received half of the overflowed buffer,
   * so a solver that matches captures against the string it sent loses that
   * model's oracle entirely. `logEntryFor` carries that branch.
   * Source: src/DarkNet/models/packetSniffing.ts:90-125 */
  logAttempt(
    hostname: string,
    attempted: string,
    code: number,
    response: { ok: boolean; message: string; data: string },
    nowMs: number,
  ): void {
    const host = this.record(hostname);
    if (!host) return;
    // Upstream snapshots the old ring, advances the traffic clock/RNG through
    // populateLogs, then discards that generated noise when it installs the
    // authentication record in front of the snapshot.
    const serverLogs = host.logs;
    this.populateLogs(hostname, nowMs);
    const entry = logEntryFor(host.modelId, attempted, code, response);
    host.logs = [JSON.stringify(entry), ...serverLogs].slice(0, MAX_LOG_LINES);
  }

  // --- the labyrinth --------------------------------------------------------

  /** The maze itself, `DarknetState.labyrinth`. Built once, lazily, exactly as
   *  `getLabMaze` does — and destroyed by a prestige, which is what makes a
   *  walk something that has to finish inside one install. */
  #labMaze: string[] | undefined;
  #labEndpoint: [number, number] | undefined;
  /** `DarknetState.labLocations`, keyed by PID.
   *
   *  THE fact that shapes the walker. A position belongs to a process, not to
   *  the player: when the process dies the entry is orphaned and the next one
   *  starts from the beginning. Nothing in the engine lets a second process
   *  adopt the first one's progress. */
  readonly #labLocations = new Map<number, [number, number]>();

  /** `getRandomOffset`: 0, 2 or 4 on each axis, and only on the last five labs.
   *
   * It is drawn ONCE per call upstream and used for both the start and the
   * endpoint — the same function, called twice, so the two offsets are
   * independent draws rather than one shared pair. */
  #labOffset(stage: LabStage): [number, number] {
    if (!stage.offsetStartAndEnd) return [0, 0];
    const draw = this.#opts.logNoise ?? this.#opts.generate;
    return [Math.floor(draw() * 3) * 2, Math.floor(draw() * 3) * 2];
  }

  /** `getLabMaze`, including the endpoint it stamps on first touch.
   *
   * ONE draw off the world stream, turned into a dedicated generator. The carve
   * is a random DFS and takes an unbounded number of draws, so billing them to
   * the shared stream would make the net's whole future depend on how twisty
   * this maze happened to be. Same trick, same reason, as a host's password. */
  labMaze(): { maze: string[]; endpoint: [number, number] } | undefined {
    const stage = this.currentLab();
    if (!stage) return undefined;
    if (!this.#labMaze) {
      const random = passwordRng(this.#opts.generate(), stage.hostname);
      this.#labMaze = generateMaze(stage.mazeWidth, stage.mazeHeight, random);
      const [offsetX, offsetY] = this.#labOffset(stage);
      this.#labEndpoint = [
        this.#labMaze[0]!.length - 2 - offsetX,
        this.#labMaze.length - 2 - offsetY,
      ];
    }
    return { maze: this.#labMaze, endpoint: this.#labEndpoint! };
  }

  /** `getPositionInLab`: this PID's cell, seeded on first look. */
  labPosition(pid: number): [number, number] {
    const held = this.#labLocations.get(pid);
    if (held) return held;
    const stage = this.currentLab();
    const [offsetX, offsetY] = stage ? this.#labOffset(stage) : [0, 0];
    const seeded: [number, number] = [1 + offsetX, 1 + offsetY];
    this.#labLocations.set(pid, seeded);
    return seeded;
  }

  /** `handleLabyrinthPassword`: one move, and everything that hangs off it.
   *
   * The response shape is the ordinary password one, which is the whole reason
   * the walker needs no `heartbleed`: the labyrinth is the only model whose
   * `message` and `data` are forwarded through `authenticate`'s own return
   * value (`NetscriptFunctions/Darknet.ts:161-170`).
   *
   * Four branches, in upstream's order, and the order matters:
   *
   * 1. Below the lab's charisma, EVERY move is a 451 and nothing is learned.
   * 2. With admin rights already, any move answers success and hands back the
   *    lab's password — the maze is over and stays over.
   * 3. The lab's real password is refused ON PURPOSE, with a message saying so.
   * 4. A wall answers failure and DOES NOT MOVE the player.
   *
   * Reaching the exit grants charisma at a fixed 32-thread equivalent, sets
   * admin rights, drops the lab cache (three on BonusLab) and opens a session.
   * The net's DEPTH does not change here: `getNetDepth` reads the current lab,
   * and the current lab is chosen by INSTALLED augmentations — so the net
   * deepens at the install that follows, not at the exit. */
  labAttempt(hostname: string, attempted: string, pid: number): {
    ok: boolean;
    code: number;
    message: string;
    data: string;
    /** Charisma the EXIT pays, before `charisma_exp`. Granted by the ns layer,
     *  like every other experience figure in this file, so there is one place
     *  the multiplier is applied. Zero on every move but the last. */
    charismaExp?: number;
  } {
    const stage = this.currentLab();
    const host = this.record(hostname);
    if (!stage || !host) return { ok: false, code: 401, message: "Unauthorized", data: "" };
    if (this.#opts.world.person.skills.charisma < stage.cha) {
      return {
        ok: false,
        code: 451,
        message: "You find yourself lost and confused."
          + " You need to be more charismatic to navigate the labyrinth.",
        data: "",
      };
    }
    const built = this.labMaze();
    if (!built) return { ok: false, code: 401, message: "Unauthorized", data: "" };
    const { maze, endpoint } = built;
    const server = this.#opts.servers.get(hostname);
    if (server?.hasAdminRights === true) {
      this.addSession(hostname, pid);
      return {
        ok: true,
        code: 200,
        message: "You have discovered the end of the labyrinth.",
        data: host.password,
      };
    }
    if (attempted === host.password) {
      return {
        ok: false,
        code: 401,
        message: "You have decided, after some deliberation, that the best way to beat a maze is to find the end,"
          + " and not to try and skip it.",
        data: "",
      };
    }
    const [x, y] = this.labPosition(pid);
    const [dx, dy] = directionFromInput(attempted);
    const here = surroundingsVisualized(maze, x, y, 1, true, false, endpoint);
    if (maze[y + dy]?.[x + dx] !== MAZE_PATH) {
      // A WALL, and the position is unchanged. The engine says so in the
      // message rather than by omission, which is what lets a walker parse its
      // way out of a desync it can never otherwise detect.
      return { ok: false, code: 401, message: `You cannot go that way. You are still at ${x},${y}.`, data: here };
    }
    if (dx === 0 && dy === 0) {
      return {
        ok: false,
        code: 401,
        message: 'You don\'t know how to do that. Try a command such as "go north"',
        data: here,
      };
    }
    const to: [number, number] = [x + dx * 2, y + dy * 2];
    this.#labLocations.set(pid, to);
    if (to[0] === endpoint[0] && to[1] === endpoint[1]) {
      // THE EXIT. Charisma at a fixed 32-thread equivalent, admin rights, the
      // cache — three of them on BonusLab — and a session.
      if (server) server.hasAdminRights = true;
      const count = stage.hostname === LAB_LADDER[7]!.hostname ? 3 : 1;
      for (let i = 0; i < count; i++) this.addCache(hostname, false, "the_great_work");
      this.addSession(hostname, pid);
      return {
        ok: true,
        code: 200,
        message: "You have successfully navigated the labyrinth! Congratulations",
        data: host.password,
        // `calculatePasswordAttemptChaGain(server, 32, true)`, and the 32 is a
        // literal rather than the caller's threads: finishing a maze pays the
        // same whatever it was walked with.
        charismaExp: attemptCharismaExp(host.difficulty, false, 32, true),
      };
    }
    return {
      ok: false,
      code: 401,
      message: `You have moved to ${to[0]},${to[1]}.`,
      data: surroundingsVisualized(maze, to[0], to[1], 1, true, false, endpoint),
    };
  }

  /** `labradar`: the paid radius-3 look at the CALLING PID's position, with the
   * exit overlay ON — the one call that can show the exit before it is stood
   * on. The ns layer charges the full authentication delay; no experience is
   * granted by anyone. Source: src/NetscriptFunctions/Darknet.ts:671-704 */
  labRadar(pid: number): { success: boolean; message: string } {
    const built = this.labMaze();
    if (!built) return { success: false, message: "You feel blind..." };
    const [x, y] = this.labPosition(pid);
    return { success: true, message: surroundingsVisualized(built.maze, x, y, 3, true, true, built.endpoint) };
  }

  labReport(pid: number): {
    success: true;
    coords: [number, number];
    north: boolean;
    east: boolean;
    south: boolean;
    west: boolean;
  } | { success: false; message: string } {
    const built = this.labMaze();
    if (!built) return { success: false, message: "You feel lost..." };
    const [x, y] = this.labPosition(pid);
    const open = (dx: number, dy: number): boolean => built.maze[y + dy]?.[x + dx] === MAZE_PATH;
    return {
      success: true,
      coords: [x, y],
      north: open(0, -1),
      east: open(1, 0),
      south: open(0, 1),
      west: open(-1, 0),
    };
  }

  /** Check a password, and say what the model says back.
   *
   * All fifteen of upstream's arms, transcribed in `dnet-feedback.ts` — see the
   * `dnet.models` entry in DNET_ASSUMPTIONS for what is left. The labyrinth is
   * intercepted here rather than there, exactly as upstream branches on
   * `isLabyrinthServer` above the equality test: it routes into the modeled
   * maze movement rather than ordinary password equality.
   *
   * `responseTime` is the authenticate delay the caller already waited, which
   * is what the `2G_cellular` arm reports back — upstream passes the same
   * `networkDelay` it delayed by.
   * Source: src/DarkNet/effects/authentication.ts:19-149 */
  checkPassword(hostname: string, attempted: string, responseTime = 0, pid = -1): {
    ok: boolean;
    message: string;
    data: string;
    /** Set only by the labyrinth, which is the one model that can answer
     *  something other than 200 or 401 — a 451 below the lab's charisma. */
    code?: number;
    /** Set only by the labyrinth's exit. See `labAttempt`. */
    charismaExp?: number;
  } {
    const host = this.record(hostname);
    if (!host) return { ok: false, message: "Unauthorized", data: "" };
    if (host.modelId === "(The Labyrinth)") {
      const move = this.labAttempt(hostname, attempted, pid);
      return {
        ok: move.ok,
        message: move.message,
        data: move.data,
        code: move.code,
        ...(move.charismaExp !== undefined ? { charismaExp: move.charismaExp } : {}),
      };
    }
    return checkPasswordAgainst(host, attempted, responseTime, this.#packetWorld(host));
  }

  /** Whether this host is a labyrinth. Exported through the system because the
   * ns layer forwards a lab's message and data and NOTHING else's, and it
   * should not have to know how a lab is recognised.
   *
   * By MODEL ID rather than by hostname: it is what an agent sees first and it
   * survives a rename. */
  isLab(hostname: string): boolean {
    const host = this.record(hostname);
    return host !== undefined && isLabyrinth(hostname, host.modelId);
  }

  /** `calculatePasswordAttemptChaGain`, before `Player.mults.charisma_exp`.
   *
   * EVERY attempt pays this, successful or not — which is the fact that makes
   * iterative solving free: a forty-call solve at difficulty 20 earns hundreds
   * of charisma experience on the way, and charisma is what gates `heartbleed`
   * and shortens every future authentication. A model that granted only on
   * success would make the whole feature look like a treadmill.
   *
   * The two multipliers are asymmetric on purpose: a host we have already
   * rooted pays a fifth, and a FIRST success pays ten times.
   * Source: src/DarkNet/effects/effects.ts:113-121 */
  attemptCharismaExp(hostname: string, threads: number, success: boolean): number {
    const host = this.record(hostname);
    if (!host) return 0;
    const rooted = this.#opts.servers.get(hostname)?.hasAdminRights === true;
    return attemptCharismaExp(host.difficulty, rooted, threads, success);
  }

  /** How many leading characters of `attempted` are right.
   *
   * `getSharedChars`, and the input to the `2G_cellular` timing oracle: each
   * correct leading character makes authentication take 50 ms LONGER, so slower
   * means closer and the attack climbs. */
  sharedChars(hostname: string, attempted: string): number {
    const host = this.record(hostname);
    if (!host) return 0;
    return getSharedChars(host.password, attempted);
  }

  // --- the mutation clock, as a promise -------------------------------------

  /** `nextMutation()`: resolves on the next tick, INCLUDING one that changes
   * nothing.
   *
   * Upstream resolves it before the `16 / depth` throttle roll, so an agent
   * looping on it wakes every tick whatever the tick did. It is a bare promise
   * rather than a per-process timer, so it is not cancellable and two waiters
   * both wake — both of which matter to an agent that parks on it. */
  nextMutation(): Promise<void> {
    return this.#nextMutation;
  }

  #triggerNextMutation(): void {
    this.#nextMutationResolve?.();
    this.#nextMutation = new Promise<void>((resolve) => {
      this.#nextMutationResolve = resolve;
    });
  }

  /** The mutation clock follows processDarknet: accumulate cycles, perform at most
   * one mutation per call after the threshold, then reset the accumulator. */
  darknetProcess(cycles: number): void {
    if (!this.hasAccess() || this.hosts.size === 0) return;
    // THE MUTATION LOCK. While a webstorm runs, `mutateDarknet` early-returns
    // and `nextMutation()` resolves on storm phases instead — the ordinary
    // clock is frozen, not queued.
    if (this.#storm !== undefined) {
      this.#stormProcess(cycles);
      return;
    }
    const perMutation = ((this.#opts.bitNode === 15 ? 1 : 2) * 150) / this.netDepth();
    this.#cyclesSinceMutation += cycles;
    if (this.#cyclesSinceMutation > perMutation) {
      // Upstream performs at most one mutation per processDarknet call and
      // resets the accumulator instead of retaining mutation debt.
      this.#cyclesSinceMutation = 0;
      this.#mutate();
    }
  }

  /** One mutation tick, with every branch upstream rolls.
   *
   * Transcribed from `mutateDarknet`, in its order and with its probabilities.
   * The branches that RETURN early matter as much as the ones that act: adding
   * servers, restarting a backdoored one and adding connections each end the
   * tick, so a tick that adds never also disconnects.
   *
   * Draws a FIXED number from the shared gameplay stream regardless of what it
   * does, so two strategy variants advance that stream identically and cannot
   * face different stock prices for reasons unrelated to either strategy.
   * Source: src/DarkNet/controllers/NetworkMovement.ts:45-134 */
  #mutate(): void {
    this.#mutations++;
    const { random } = this.#opts;
    // One fixed-width draw block, taken up front. Every branch below indexes
    // into it rather than calling random() itself.
    const roll: number[] = [];
    for (let i = 0; i < MUTATION_DRAWS; i++) roll.push(random());

    const movable = this.#movable();
    if (movable.length === 0) return;
    this.#triggerNextMutation();

    // Deeper nets mutate more often per tick but throttle themselves here, so
    // past depth 16 a growing share of ticks do nothing at all.
    if (roll[0]! > Math.min(1, 16 / Math.max(1, this.netDepth()))) return;

    // Islands first: a host cut off from everything is re-placed rather than
    // left stranded, which is why the net does not fragment over time.
    if (roll[1]! < 0.3) {
      const islands = movable.filter((name) => (this.#opts.network.get(name) ?? []).length === 0);
      const island = islands[Math.floor(roll[2]! * islands.length)];
      if (island) this.#moveHost(island, roll[3]!, roll[4]!);
    }

    // THE BRANCH THAT KEEPS THE NET ALIVE. Without it the tick only ever
    // deletes, and a long run ends with an empty darknet — which reads as a
    // crawler that stopped working rather than as a net that was destroyed.
    if (roll[5]! < 0.3) this.#restockLowLevel(roll);

    if (roll[6]! < 0.1) {
      const count = roll[7]! * 3 + 1;
      for (let i = 0; i < count; i++) this.#deleteOne(roll[8]!);
    }

    if (roll[9]! < 0.1) {
      const count = roll[10]! * 3 + 1;
      for (let i = 0; i < count; i++) this.#addHost(Math.floor(roll[11]! * this.netDepth()), roll[12]!, roll[13]!);
      return;
    }

    // THE PRICE OF A BACKDOOR, and it is paid by the backdoored host rather
    // than by the net. Both branches draw from `getBackdooredDarknetServers`
    // and both RETURN, so a tick that restarts or deletes a backdoored server
    // does nothing else — which is why the effective rates are about 9% and 4%
    // rather than the 10% and 5% the literals suggest.
    //
    // A restart clears the backdoor (`#restartOne` drops `backdoorInstalled`),
    // so a backdoor is expendable by construction: it is re-installed rather
    // than defended.
    if (roll[14]! < 0.1) {
      const victim = this.#pick(this.#backdoored().map((host) => host.hostname).sort(), roll[15]!);
      if (victim !== undefined) {
        this.#restartHost(victim);
        return;
      }
    }
    if (roll[16]! < 0.05) {
      const victim = this.#pick(this.#backdoored().map((host) => host.hostname).sort(), roll[17]!);
      if (victim !== undefined) {
        this.#removeHost(victim);
        return;
      }
    }

    if (roll[18]! < 0.2) this.#restartOne(roll[19]!);

    if (roll[20]! < 0.3) {
      for (let i = 0; i < 3; i++) this.#moveHost(this.#pick(this.#movable(), roll[21 + i]!), roll[24]!, roll[25]!);
    }

    if (roll[26]! < 0.5) {
      this.#addConnections(roll[27]!, roll[28]!);
      return;
    }

    // Severing every connection on one host is what makes an adjacency list the
    // shortest-lived thing we hold, and it is why `topology` expires fastest.
    if (roll[29]! < 0.5) {
      const victim = this.#pick(this.#movable(), roll[30]!);
      if (victim) this.#disconnect(victim);
    }

    if (roll[31]! < 0.1) this.#balance(roll);
  }

  /** `isImmutable`: nothing the mutation clock does can touch this host.
   *
   * Two independent reasons, and they are NOT the same thing. `isStationary` is
   * a property of the host — darkweb and the labyrinth are built that way.
   * A stasis link is a property of our RUN: we spent one of at most four global
   * slots to pin it. Upstream's mutation branches all draw from the pool this
   * excludes, which is exactly what makes a link worth a slot. */
  #immutable(host: DarknetHost): boolean {
    return host.isStationary || host.stasisLinked;
  }

  #movable(): string[] {
    return [...this.hosts.keys()]
      .filter((name) => {
        const host = this.hosts.get(name)!;
        return host.online && !this.#immutable(host);
      })
      .sort();
  }

  #pick(names: readonly string[], draw: number): string | undefined {
    if (names.length === 0) return undefined;
    return names[Math.floor(draw * names.length)];
  }

  /** `DarknetState.Network`: depth -> column -> hostname.
   *
   * A real index rather than a scan over `hosts`. Wiring asks "who is beside
   * this cell" and "which cells in this row are free" several times per
   * mutation, and at a few hundred hosts the scan version turned a twelve-minute
   * BN15 run into minutes of grid arithmetic. Upstream keeps the same second
   * copy for the same reason; the drift it risks is why every seat and vacate
   * goes through the two methods below and nothing else touches `leftOffset`. */
  readonly #grid = new Map<number, (string | undefined)[]>();

  #row(depth: number): (string | undefined)[] {
    let row = this.#grid.get(depth);
    if (!row) {
      row = new Array<string | undefined>(NET_WIDTH).fill(undefined);
      this.#grid.set(depth, row);
    }
    return row;
  }

  #seat(host: DarknetHost, depth: number, column: number): void {
    host.depth = depth;
    host.leftOffset = column;
    // darkweb and the labyrinth are pinned rather than seated, and carry -1.
    if (column < 0 || column >= NET_WIDTH) return;
    this.#row(depth)[column] = host.hostname;
  }

  /** Free the cell a host holds. Idempotent, and it checks the occupant's name
   * before clearing: a host that has already been re-seated must not have its
   * NEW cell cleared by a late vacate of its old one. */
  #vacate(host: DarknetHost): void {
    const { depth, leftOffset } = host;
    if (leftOffset < 0) return;
    const row = this.#grid.get(depth);
    if (row && row[leftOffset] === host.hostname) row[leftOffset] = undefined;
    host.leftOffset = -1;
  }

  /** The host occupying one grid cell, if any. `DarknetState.Network[x][y]`. */
  #at(depth: number, column: number): DarknetHost | undefined {
    if (column < 0 || column >= NET_WIDTH) return undefined;
    const name = this.#grid.get(depth)?.[column];
    if (name === undefined) return undefined;
    const host = this.hosts.get(name);
    return host?.online === true ? host : undefined;
  }

  /** Every host on one depth, left to right. The row above and the row below
   * are what vertical wiring rolls against, in full. */
  #onRow(depth: number): DarknetHost[] {
    const row = this.#grid.get(depth);
    if (!row) return [];
    const out: DarknetHost[] = [];
    for (let column = 0; column < NET_WIDTH; column++) {
      const host = this.#at(depth, column);
      if (host) out.push(host);
    }
    return out;
  }

  /** `getAllOpenPositions`: free cells in a depth band, widening the band when
   * the band itself is full, and never landing on an air gap. */
  #openPositions(minDepth: number, maxDepth: number): [number, number][] {
    const min = Math.max(0, minDepth);
    const max = Math.min(maxDepth, this.netDepth() - 1);
    const positions: [number, number][] = [];
    for (let depth = min; depth <= max; depth++) {
      if (isOnAirGap(depth)) continue;
      for (let column = 0; column < NET_WIDTH; column++) {
        if (!this.#at(depth, column)) positions.push([depth, column]);
      }
    }
    if (positions.length > 0 || (min === 0 && max === this.netDepth() - 1)) return positions;
    return this.#openPositions(min - 1, max + 1);
  }

  /** `getAllAdjacentNeighbors`: the rows above and below, plus the two cells
   * beside this one.
   *
   * The vertical halves pass `close = true`, and that argument does something
   * surprising. It reads
   *
   *     rowAbove.filter((server) => Math.abs(server.leftOffset ?? 0 - x) <= 1)
   *
   * and `??` binds looser than `-`, so it parses as `leftOffset ?? (0 - x)`.
   * `leftOffset` is a number and never nullish, so the whole test collapses to
   * `Math.abs(leftOffset) <= 1` — it keeps only COLUMNS 0 AND 1, whatever `x`
   * is, rather than the cells near the host as the name promises. Transcribed
   * with the bug, because it is what the live game does: it biases guaranteed
   * connections towards the left of the board.
   *
   * The lateral half is NOT filtered, which is why a same-depth edge still
   * implies |Δcolumn| = 1 and a map can infer a column it is never told.
   * Source: src/DarkNet/utils/darknetNetworkUtils.ts:48-62, :80-85 */
  #adjacent(depth: number, column: number): DarknetHost[] {
    const near = (host: DarknetHost) => Math.abs(host.leftOffset) <= 1;
    // Upstream's own order: "rowAbove" is depth + 1, "rowBelow" is depth - 1.
    const rows = [...this.#onRow(depth + 1).filter(near), ...this.#onRow(depth - 1).filter(near)];
    const beside = [this.#at(depth, column - 1), this.#at(depth, column + 1)]
      .filter((entry): entry is DarknetHost => entry !== undefined);
    return [...rows, ...beside];
  }

  /** `addRandomConnections` then `addGuaranteedConnection`, at upstream's own
   * probabilities.
   *
   * Lateral pairs are rolled at `HORIZONTAL_CONNECTION_CHANCE` and can only ever
   * be the two cells beside this one — that is the invariant `ui/`'s map infers
   * columns from.
   *
   * Vertical pairs are rolled against the ENTIRE adjacent row: this path calls
   * `getServersOnRowAbove/Below` WITHOUT `close`, so no column filter applies
   * and a vertical edge carries no column information at all. (The `close`
   * filter is a different story — see `#adjacent`.)
   *
   * `distance` is upstream's and is mis-parenthesised: `Math.abs(neighbor.depth
   * ?? x - x) + 1` parses as `Math.abs(neighbor.depth ?? (x - x)) + 1`, and
   * `depth` is never nullish, so it is `depth + 1` rather than the intended
   * gap of 1. Deep rows therefore get far fewer vertical links than shallow
   * ones. Kept.
   * Source: src/DarkNet/controllers/NetworkGenerator.ts:178-232 */
  #wire(hostname: string, depth: number, column: number, draw: number): void {
    const { network } = this.#opts;
    const links = new Set<string>();
    const lateralChance = HORIZONTAL_CONNECTION_CHANCE * (1.1 - depth * 0.01);
    const verticalChance = VERTICAL_CONNECTION_CHANCE * (1.1 - depth * 0.01);
    let salt = 0;

    for (const beside of [this.#at(depth, column - 1), this.#at(depth, column + 1)]) {
      if (beside && subDraw(draw, salt++) < lateralChance) links.add(beside.hostname);
    }
    const vertical = [...this.#onRow(depth - 1), ...this.#onRow(depth + 1)]
      .sort((a, b) => (a.hostname < b.hostname ? -1 : 1));
    for (const other of vertical) {
      const distance = Math.abs(other.depth) + 1;
      if (subDraw(draw, salt++) < verticalChance / distance) links.add(other.hostname);
    }

    // The guaranteed connection is what stops a host being born an island.
    const adjacent = this.#adjacent(depth, column);
    const guaranteed = adjacent[Math.floor(subDraw(draw, salt++) * adjacent.length)];
    if (guaranteed) links.add(guaranteed.hostname);

    // darkweb holds every depth-0 host, and the labyrinth every host on the
    // deepest row. Both are pinned at the centre column and adjacent to their
    // whole row, which is why neither can anchor a column inference.
    if (depth === 0) links.add("darkweb");
    const lab = this.currentLab();
    if (lab && depth === this.netDepth() - 1 && this.hosts.has(lab.hostname)) links.add(lab.hostname);

    network.set(hostname, [...links].sort());
    for (const other of links) {
      const existing = network.get(other) ?? [];
      if (!existing.includes(hostname)) network.set(other, [...existing, hostname]);
    }
  }

  #unwire(hostname: string): void {
    const { network } = this.#opts;
    network.set(hostname, []);
    for (const [name, links] of network) {
      const kept = links.filter((entry) => entry !== hostname);
      if (kept.length !== links.length) network.set(name, kept);
    }
  }

  /** `addRandomDarknetServers`: a new host at a random difficulty, seated in a
   * free cell and wired in.
   *
   * The requested depth is a PREFERENCE, not a guarantee: `getAllOpenPositions`
   * widens its band when the band is full, so a host asked for a saturated row
   * lands near it instead. When the whole net is full nothing is added, which is
   * the behaviour that holds the population at NET_WIDTH per row. */
  #addHost(difficulty: number, drawA: number, drawB: number, fixedDepth = false): void {
    const rolledDifficulty = Math.floor(difficulty);
    const wanted = Math.max(0, Math.min(rolledDifficulty, this.netDepth() - 1));
    const range = fixedDepth ? 0 : 3;
    const free = this.#openPositions(wanted - range, wanted + range);
    const cell = free[Math.floor(drawB * free.length)];
    if (!cell) return;
    const [depth, column] = cell;
    let hostname = "dnet-" + depth + "-x" + this.#added++;
    if (this.#opts.fullAccess() && subDraw(drawA, 1000) < 0.03 && this.#offlineServers.size > 0) {
      const offline = [...this.#offlineServers];
      let offset = Math.floor(subDraw(drawA, 1001) * offline.length);
      while (offset < offline.length && offline[offset]!.includes(".")) offset++;
      if (offline[offset] !== undefined) hostname = offline[offset]!;
    }
    if (this.hosts.get(hostname)?.online === true) return;
    this.#buildHost(hostname, rolledDifficulty, depth, column);
    this.#wire(hostname, depth, column, drawA);
    this.#offlineServers.delete(hostname);
    const server = this.#opts.servers.get(hostname);
    if (server) this.#offlineServers.delete(server.ip);
  }

  /** `addLowLevelServersIfNeeded`: keep the shallow rows populated.
   *
   * This is the branch that makes the net self-sustaining. Upstream tops row 0
   * up to more than three servers and keeps depth <= 3 above its density floor,
   * which is what stops deletion from emptying the approaches to the net. */
  #restockLowLevel(roll: readonly number[]): void {
    const online = [...this.hosts.values()].filter((entry) => entry.online);
    if (online.filter((entry) => entry.depth === 0).length <= 3) {
      const before = this.#movable().length;
      this.#addHost(0, roll[2]!, roll[3]!, true);
      this.#addHost(0, roll[4]!, roll[5]!, true);
      if (this.#movable().length > before) this.#restockLowLevel(roll);
      return;
    }
    if (online.filter((entry) => entry.depth <= 3).length / (4 * NET_WIDTH) < LOW_LEVEL_SERVER_DENSITY) {
      const before = this.#movable().length;
      this.#addHost(Math.floor(roll[6]! * 4), roll[7]!, roll[8]!);
      this.#addHost(Math.floor(roll[9]! * 4), roll[10]!, roll[11]!);
      if (this.#movable().length > before) this.#restockLowLevel(roll);
    }
  }

  /** `moveDarknetServer`: a new cell near immutable difficulty, and a full re-wire.
   *
   * A move invalidates a host's depth AND every edge it had, which is exactly
   * why `position` and `topology` expire on different clocks. */
  #moveHost(hostname: string | undefined, drawA: number, drawB: number): void {
    if (hostname === undefined) return;
    const host = this.hosts.get(hostname);
    if (!host || !host.online || this.#immutable(host)) return;
    // The terminal pins whatever it is standing on: `isImmutable` counts
    // `isConnectedTo` alongside the stasis link. It matters for exactly one
    // thing here, and it is not a nicety — home walks the terminal out to a
    // darknet host to install a backdoor, and a move landing mid-walk would
    // strand it.
    if (this.#opts.servers.get(hostname)?.isConnectedTo === true) return;
    // Position options are computed BEFORE the old cell is vacated and are
    // centered on immutable difficulty, not the host's current depth.
    const free = this.#openPositions(host.difficulty - 3, host.difficulty + 3);
    if (free.length === 0) {
      this.#removeHost(hostname);
      return;
    }
    const cell = free[Math.floor(drawA * free.length)]!;
    this.#unwire(hostname);
    this.#vacate(host);
    this.#seat(host, cell[0], cell[1]);
    this.#wire(hostname, cell[0], cell[1], drawB);
  }

  /** `addConnectionsToRandomServer` -> `addGuaranteedConnection`. Edges appear as
   * well as vanish, which is the third rate the topology expiry is derived from.
   *
   * The candidate set is `getAllAdjacentNeighbors`, NOT "anything within one
   * depth": a new same-depth edge can still only reach the cell beside this one.
   * Getting this wrong is what let the sim mint lateral edges the game cannot
   * produce, and any map that infers columns from them would infer nonsense. */
  #addConnections(drawA: number, drawB: number): void {
    const { network } = this.#opts;
    const names = this.#movable();
    const from = this.#pick(names, drawA);
    if (from === undefined) return;
    const host = this.hosts.get(from)!;
    const candidates = this.#adjacent(host.depth, host.leftOffset)
      .filter((entry) => entry.hostname !== from)
      .map((entry) => entry.hostname)
      .sort();
    const to = this.#pick(candidates, drawB);
    if (to === undefined) return;
    for (const [a, b] of [[from, to], [to, from]] as const) {
      const links = network.get(a) ?? [];
      if (!links.includes(b)) network.set(a, [...links, b]);
    }
  }

  #disconnect(hostname: string): void {
    this.#unwire(hostname);
  }

  #deleteOne(draw: number): void {
    const victim = this.#pick(this.#movable(), draw);
    if (victim === undefined) return;
    this.#removeHost(victim);
  }

  /** Take one server identity off the net.
   *
   * Split out of `#deleteOne` because a FAILED migration ends here too:
   * `moveDarknetServer` deletes rather than leaving a host floating when
   * `getAllOpenPositions` comes back empty (`NetworkMovement.ts:246-250`). That
   * is the whole risk of an induced migration, so the two paths have to be the
   * same path. */
  #removeHost(victim: string): void {
    const host = this.hosts.get(victim);
    if (!host) return;
    // Gone as this identity, with its files, sessions and logs — and its cell, which
    // is what lets the restocking branch put something back there.
    host.online = false;
    this.#vacate(host);
    host.sessions.clear();
    host.logs = [];
    this.#opts.forgetFiles?.(victim);
    this.#opts.processes.killall(victim);
    const server = this.#opts.servers.get(victim);
    if (server) {
      this.#offlineServers.add(server.ip);
      this.#offlineServers.add(victim);
    }
    this.#opts.servers.delete(victim);
    this.#unwire(victim);
    this.#opts.network.delete(victim);
    this.#migrationCharge.delete(victim);
    // A delete takes the host's files with it — the seed included. Restarts
    // and moves do NOT reach in here, which is what makes the seed survive
    // them: `restartServer` clears scripts, sessions and the backdoor, never
    // `programs`.
    this.#stormSeeds.delete(victim);
  }

  /** `moveDarknetServer(server, maxDecrease, maxIncrease)` with the real band.
   *
   * Unlike the mutation clock's own move — which rolls a depth and then a cell
   * in it — this takes every free cell in the whole band at once, which is what
   * upstream does and what makes the bottom row a real target rather than a
   * lucky roll.
   *
   * Returns false when the host was DELETED for want of anywhere to go. The band
   * widens recursively until it finds a slot, so this only fires when the net is
   * completely full — but the loss is total, which is why nothing irreplaceable
   * is ever pushed. */
  #moveWithin(hostname: string, minDepth: number, maxDepth: number, drawA: number, drawB: number): boolean {
    const host = this.hosts.get(hostname);
    if (!host || !host.online) return true;
    // `isImmutable` is `openServer || isConnectedTo || hasStasisLink` — note it
    // does NOT include isStationary, which is filtered at the pool instead.
    if (this.#immutable(host) || this.#opts.servers.get(hostname)?.isConnectedTo === true) return true;
    // Taken BEFORE the vacate, exactly as upstream orders it, so the host's own
    // cell is not one of its own options.
    const free = this.#openPositions(minDepth, maxDepth);
    if (free.length === 0) {
      this.#removeHost(hostname);
      return false;
    }
    const cell = free[Math.floor(drawA * free.length)]!;
    this.#unwire(hostname);
    this.#vacate(host);
    this.#seat(host, cell[0], cell[1]);
    this.#wire(hostname, cell[0], cell[1], drawB);
    return true;
  }

  #restartOne(draw: number): void {
    const victim = this.#pick(this.#movable(), draw);
    if (victim === undefined) return;
    this.#restartHost(victim);
  }

  #restartHost(victim: string): void {
    const host = this.hosts.get(victim);
    if (!host) return;
    // Scripts die and SESSIONS are cleared, but the host, its files and its
    // admin rights survive. All four halves are separately wrong-able.
    host.sessions.clear();
    host.logs = [`{"code":200,"message":"Server restarting, terminating scripts..."}`];
    const server = this.#opts.servers.get(victim);
    if (server) server.backdoorInstalled = false;
    this.#opts.processes.killall(victim);
    // Preserve the stabilising darkweb edge, remove every other edge, then add
    // one guaranteed adjacent connection exactly as restartServer does.
    for (const neighbour of [...(this.#opts.network.get(victim) ?? [])]) {
      if (neighbour === "darkweb") continue;
      this.#opts.network.set(neighbour, (this.#opts.network.get(neighbour) ?? []).filter((name) => name !== victim));
    }
    const darkweb = (this.#opts.network.get(victim) ?? []).filter((name) => name === "darkweb");
    this.#opts.network.set(victim, darkweb);
    const candidates = this.#adjacent(host.depth, host.leftOffset).filter((entry) => entry.hostname !== victim);
    if (candidates.length > 0) {
      const random = this.#opts.logNoise ?? this.#opts.random;
      const neighbour = candidates[Math.floor(random() * candidates.length)]!.hostname;
      for (const [a, b] of [[victim, neighbour], [neighbour, victim]] as const) {
        const links = this.#opts.network.get(a) ?? [];
        if (!links.includes(b)) this.#opts.network.set(a, [...links, b]);
      }
    }
  }

  /** `balanceDarknetServers`: hold the population at the generator's density. */
  #balance(roll: readonly number[]): void {
    const target = this.netDepth() * NET_WIDTH * SERVER_DENSITY;
    const movable = this.#movable();
    if (movable.length > target) {
      for (let i = 0; i < movable.length - target; i++) this.#deleteOne(roll[26]!);
    } else {
      for (let i = 0; i < target - movable.length; i++) {
        this.#addHost(Math.floor(roll[11]! * this.netDepth()), roll[23]!, roll[24]!);
      }
    }
    this.#restockLowLevel(roll);
  }

}
