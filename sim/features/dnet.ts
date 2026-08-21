import type { SimServer } from "../core/effects.ts";
import type { SimPlayer } from "../core/player.ts";
import type { SimWorld } from "../world.ts";
import { mockServer } from "../core/mocks.ts";
import { randomIp } from "../network.ts";
import {
  COMMON_PASSWORDS,
  DEFAULT_SETTINGS,
  DOG_NAMES,
  EU_COUNTRIES,
} from "../../shared/strategy/dnet/dictionaries.ts";
import type { ProcessTable } from "../ns/process.ts";
import { isOnAirGap, LAB_LADDER, NET_WIDTH, type LabStage } from "../../shared/strategy/dnet/rates.ts";

/** The darknet, modelled far enough that buying DarkscapeNavigator.exe is a real
 * event with real consequences.
 *
 * Scope is deliberate. What the controller does with the darknet today is
 * observe it — `dnet.core` probes five `ns.dnet` getters, the driver refuses
 * every action — so this models the population, the getters, the access gate and
 * the mutation clock, and nothing else. Every unmodelled member still reports
 * itself rather than answering with a fabrication — an ns member this does not
 * model is simply absent from the namespace, so the root proxy reports it.
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
  // Every knowledge expiry in shared/strategy/dnet/knowledge.ts is derived from
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
  "dnet.probeOrder: upstream shuffles probe() results to hide the network structure; this returns a stable order, because "
  + "lodash shuffle consumes a variable number of draws and taking them from the shared stream would let topology perturb stock prices",
  "dnet.logNoise: the noise mix is narrowed to the branches that leak password material plus the heartbeat everything else "
  + "falls through to; the packet-sniffer blob, location and generated-name branches are not reproduced. Every line emitted is "
  + "faithful — what is narrower is the mix between them",
  "dnet.models: passwords are exact for the five transcribed dictionary models and correctly-formatted-but-unguessable for the "
  + "other nineteen, which matches the fact that those solvers are not written. Per-model failure feedback is transcribed for "
  + "the cheap pure-function models and falls through to the static hint otherwise, as upstream's own default branch does",
  "dnet.backdoors: no backdoor path exists, so getDarknetInstability and the timeout chance are exactly neutral rather than "
  + "approximated, and exec's backdoorBypasses is always false",
  "dnet.stasis: setStasisLink is unmodelled, so getStasisLinkedServers() is [] by truth rather than by stub, and isImmutable "
  + "reduces to isStationary",
  "dnet.labyrinth: the ladder, depth, reward order and the lab server are modelled; the MAZE itself is not, so a lab is never completed from a script",
  "dnet.cacheRewards: the draw is narrowed to money and the program/market unlocks, both exact; upstream also draws stock shares, clue files and (from phishing caches) coding contracts, so the MIX is narrower than upstream even though every reward given is faithful",
  "dnet.cacheSources: caches are only created on request — memoryReallocation clearing a block, and phishingAttack, are not modelled",
  "dnet.promoteStock: the charge curve, the 0.4x per-cycle decay, the wait time, the charisma XP and the prestige reset are transcribed exactly; the propaganda has no other modelled effect",
  "dnet.prestige: an install clears the stock promotions, as upstream does; unlike upstream's prestigeDarknetState it does NOT regenerate the network or the labyrinth, so the map a run maps stays mapped across installs",
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
  return Math.max(8000 * (600 / (600 + charisma)), 200);
}

/** Charges bought by one call. Source: src/NetscriptFunctions/Darknet.ts:597 */
export function promoteStockCharges(threads: number, charisma: number): number {
  return threads * ((500 + charisma) / 500);
}

/** Charisma experience the call grants. Source: src/NetscriptFunctions/Darknet.ts:600 */
export function promoteStockCharismaExp(threads: number, charisma: number, charismaExpMult: number): number {
  return charismaExpMult * threads * 10 * ((200 + charisma) / 200);
}

const SERVER_DENSITY = 0.6;
/** Per-pair connection odds. Source: src/DarkNet/Enums.ts:4-5 */
const HORIZONTAL_CONNECTION_CHANCE = 0.5;
const VERTICAL_CONNECTION_CHANCE = 0.3;
/** getNetDepth()'s fallback without full darknet access. */
const NO_SF15_NET_DEPTH = 5;
/** packetSniffing.ts:14. The ring is generous, which is why a wide heartbleed
 * read is free information rather than a cost. */
const MAX_LOG_LINES = 200;
const LOW_LEVEL_SERVER_DENSITY = 0.7;
/** Draws taken from the shared gameplay stream per mutation, whatever the tick
 * does. Fixed so two strategy variants advance that stream identically. */
export const MUTATION_DRAWS = 28;

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

/** The dictionaries whose contents we know, keyed by the model that draws from
 * them. Shared with the game agents rather than duplicated: a sim that used a
 * different list would let a strategy pass here and fail in the game. */
const DICTIONARIES: Record<string, readonly string[]> = {
  ZeroLogon: [""],
  "FreshInstall_1.0": DEFAULT_SETTINGS,
  Laika4: DOG_NAMES,
  "EuroZone Free": EU_COUNTRIES,
  TopPass: COMMON_PASSWORDS,
};

/** Password hints, per model, in upstream's own words where we have them.
 * `DeskMemo_3.1` is the notable one: its hint literally contains the password,
 * which is why `models.ts` marks it readable from getServerDetails alone. */
function passwordFor(modelId: string, difficulty: number, generate: () => number): {
  password: string;
  hint: string;
  data: string;
} {
  const words = DICTIONARIES[modelId];
  if (words) {
    const password = words[Math.floor(generate() * words.length)]!;
    return {
      password,
      hint: modelId === "ZeroLogon" ? "There is no password" : "I never changed the password",
      data: "",
    };
  }
  // Everything else gets a correctly-formatted password of the right shape. The
  // FORMAT is faithful; the value is not guessable, which matches the fact that
  // we have not written those solvers.
  const length = Math.max(2, Math.min(2 + Math.floor(difficulty / 4), 8));
  let password = "";
  for (let i = 0; i < length; i++) password += String(Math.floor(generate() * 10));
  if (modelId === "DeskMemo_3.1") {
    // The echo vulnerability: upstream really does put the password in the hint.
    return { password, hint: `The password is ${password}`, data: "" };
  }
  if (modelId === "PHP 5.4") {
    const sorted = password.split("").sort().join("");
    return { password, hint: `I accidentally sorted the password: ${sorted}`, data: sorted };
  }
  return { password, hint: "You should remember this one", data: "" };
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

export interface DarknetHost {
  hostname: string;
  modelId: string;
  /** The real password. Generated at populate() from the WORLD stream, never
   *  the gameplay one, so a strategy A/B faces the same net.
   *
   *  Faithful for the five dictionary models, whose lists are transcribed. For
   *  the other nineteen it is a correctly-formatted string the sim will not let
   *  a script guess — which is honest rather than convenient: those models are
   *  unsolved in `shared/strategy/dnet/models.ts` too, so a sim that let them
   *  fall would measure a strategy we do not have. */
  password: string;
  passwordHint: string;
  data: string;
  passwordLength: number;
  passwordFormat: "numeric" | "alphabetic" | "alphanumeric" | "ASCII" | "unicode";
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
  /** Drop a deleted host's files. The file map belongs to the sim host, not to
   *  this system, so removal is a callback rather than a reach-in. */
  forgetFiles?: (hostname: string) => void;
  /** DarknetMoneyMultiplier for this node — 0 in BN8, which removes the money
   *  reward from the draw entirely rather than scaling it to nothing. */
  darknetMoneyMultiplier: () => number;
}

/** The programs a cache hands over, in the order upstream walks them. The first
 * one not owned is the reward — so a cache is worth up to Formulas.exe, which
 * the dark web sells for $5b.
 * Source: src/DarkNet/effects/cacheFiles.ts:130-149 */
export const CACHE_PROGRAMS = [
  "ServerProfiler.exe", "BruteSSH.exe", "DeepscanV1.exe", "FTPCrack.exe", "AutoLink.exe",
  "relaySMTP.exe", "DeepscanV2.exe", "HTTPWorm.exe", "SQLInject.exe", "Formulas.exe",
] as const;

export class DarknetSystem {
  readonly hosts = new Map<string, DarknetHost>();
  #populated = false;
  #darkweb: DarknetHost | undefined;
  /** Serial for hosts added after populate(), so a re-added name never collides
   *  with one the net still remembers. */
  #added = 0;
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

  constructor(options: DarknetSystemOptions) {
    this.#opts = options;
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
  prestige(): void {
    this.#stockPromotions.clear();
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
    const count = Math.max(1, Math.round(depth * NET_WIDTH * SERVER_DENSITY) - 10);
    this.#placeLab();
    let placed = 0;
    for (let row = 0; row < depth && placed < count; row++) {
      // An air-gap row holds nothing at all, which is what makes depth 7 and
      // depth 9 non-adjacent: the vertical wiring only looks at depth ± 1.
      if (isOnAirGap(row)) continue;
      // Rows 0 and 1 are topped up to five upstream; deeper rows take what is
      // left of the population. Never more than the row has cells.
      const target = Math.min(NET_WIDTH, row < 2 ? 5 : count - placed);
      for (let i = 0; i < target; i++) {
        // One draw per host: it picks the CELL and seeds the wiring.
        const draw = generate();
        const free = this.#openPositions(row, row);
        const cell = free[Math.floor(draw * free.length)];
        if (!cell) break;
        this.#buildHost(`dnet-${row}-${i}`, row, row, cell[1]);
        this.#wire(`dnet-${row}-${i}`, row, cell[1], draw);
        placed++;
      }
    }
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
    const secret = passwordFor(model, difficulty, generate);
    this.hosts.set(hostname, {
      hostname,
      modelId: model,
      password: secret.password,
      passwordHint: secret.hint,
      data: secret.data,
      // DERIVED from the password rather than invented, which is what makes a
      // dictionary attack's length check agree with the answer.
      passwordLength: secret.password.length,
      passwordFormat: "numeric",
      // DarknetServerOptions.ts:87.
      logTrafficInterval: 1 + 30 * 0.9 ** difficulty,
      blockedRam,
      difficulty,
      depth,
      // Assigned by #seat below, which is the only writer — see the grid index.
      leftOffset: -1,
      // depthScaling for depth < 2, per DarknetServerOptions.ts:70.
      requiredCharismaSkill: Math.max(1, depth * 10),
      isStationary: false,
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
      // Number.MAX_SAFE_INTEGER upstream: a lab never adds log traffic.
      logTrafficInterval: Number.MAX_SAFE_INTEGER,
      blockedRam: 0,
      difficulty: 10,
      depth: -1,
      leftOffset: -1,
      requiredCharismaSkill: lab.cha,
      isStationary: true,
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
        logTrafficInterval: 1 + 30,
        blockedRam: 0,
        difficulty: 0,
        depth: -1,
        leftOffset: -1,
        requiredCharismaSkill: 1,
        isStationary: true,
        online: true,
        sessions: new Set<number>(),
        logs: [],
      };
    }
    return this.#darkweb;
  }

  /** getStasisLinkLimit(): 1 + the three labyrinth augmentations, none of which
   * is reachable without full access, so it is 1 here. */
  stasisLinkLimit(): number {
    return 1;
  }

  /** Exactly neutral rather than fabricated: instability is 1.07^surplus over
   * backdoored darknet servers, and a darknet backdoor is not modelled, so the
   * surplus is genuinely zero. It reports itself the moment that stops being
   * true. */
  instability(): { authenticationDurationMultiplier: number; authenticationTimeoutChance: number } {
    return { authenticationDurationMultiplier: 1, authenticationTimeoutChance: 0 };
  }

  /** Likewise: [] is the true answer while setStasisLink is unmodelled. */
  stasisLinkedServers(): string[] {
    return [];
  }

  // --- cache files --------------------------------------------------------

  /** `.cache` filenames per host. Upstream keeps them on the server object; the
   * sim keeps them here because SimServer is the shared Server shape. */
  readonly caches = new Map<string, string[]>();

  /** `addCacheToServer`. A phishing cache is `.d.cache`, and only those can
   * award coding contracts. Duplicate names are refused, as upstream does. */
  addCache(hostname: string, fromPhishing: boolean): string | undefined {
    const suffix = fromPhishing ? ".d.cache" : ".cache";
    const name = `cache_${Math.floor(this.#opts.generate() * 900 + 100)}${suffix}`;
    const held = this.caches.get(hostname) ?? [];
    if (held.includes(name)) return undefined;
    held.push(name);
    this.caches.set(hostname, held);
    return name;
  }

  cachesOn(hostname: string): readonly string[] {
    return this.caches.get(hostname) ?? [];
  }

  /** `getRewardFromCache`. Karma is spent whatever the reward turns out to be,
   * and the reward is drawn uniformly from the applicable kinds.
   *
   * Three of upstream's five kinds report rather than resolve — stock shares,
   * coding contracts and data files each need a subsystem this does not model,
   * and drawing money in their place would quietly inflate cache income and
   * make the purchase look better than it is. Nothing opens a cache today, so
   * this costs nothing now and fails loudly the day something does.
   * Source: src/DarkNet/effects/cacheFiles.ts:35-74 */
  openCache(hostname: string, filename: string): { success: boolean; message: string; karmaLoss: number } {
    const record = this.record(hostname);
    const held = this.caches.get(hostname) ?? [];
    if (!record || !held.includes(filename)) {
      return { success: false, message: `${filename} does not exist on ${hostname}`, karmaLoss: 0 };
    }
    this.caches.set(hostname, held.filter((name) => name !== filename));
    const karmaLoss = record.difficulty + 1;
    this.#opts.player.karma -= karmaLoss;

    // Upstream draws uniformly from five kinds (six on a phishing cache). Three
    // of them need a subsystem this does not model — stock shares, clue files,
    // and coding contracts — so the draw is NARROWED to the two that resolve
    // exactly rather than substituted for or faked. Every reward handed out is
    // therefore a faithful one; what is unfaithful is the mix, and that is
    // declared in DNET_ASSUMPTIONS. Throwing on the missing kinds was the other
    // option and a worse one: a function that fails on a random draw is not a
    // model anything can use, and the failure would land unpredictably.
    const kinds: (() => string)[] = [() => this.#programOrMarketReward(record.difficulty)];
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
    for (const program of CACHE_PROGRAMS) {
      if (!files.has(program)) {
        files.add(program);
        return `You have discovered the program ${program}.`;
      }
    }
    const gates = this.#opts.world.gates;
    if (!gates.hasWseAccount) {
      gates.hasWseAccount = true;
      return "You have discovered a stolen WSE Account!";
    }
    if (!gates.hasTixApiAccess) {
      gates.hasTixApiAccess = true;
      return "You have discovered a stolen TIX API access point!";
    }
    if (!gates.has4SData && this.#opts.bitNode !== 8) {
      gates.has4SData = true;
      return "You have discovered a cache of stolen 4S Data!";
    }
    return this.#moneyReward(difficulty);
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
    // "We always are authed to ourselves and DarkWeb."
    if (hostname === "darkweb") return true;
    if (processHost !== undefined && processHost === hostname) return true;
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
    if (server) server.hasAdminRights = true;
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
   * The mix is narrower than upstream's: the branches transcribed are the ones
   * that LEAK, plus the heartbeat everything else falls through to. That is
   * declared in DNET_ASSUMPTIONS. Every line emitted is faithful; what is
   * missing is some of the noise between them.
   * Source: src/DarkNet/models/packetSniffing.ts:128-192 */
  populateLogs(hostname: string, nowMs: number): void {
    const host = this.record(hostname);
    if (!host || host.logTrafficInterval === Number.MAX_SAFE_INTEGER) return;
    const intervalMs = host.logTrafficInterval * 1000;
    if (host.lastLogMs === undefined) {
      host.logs = [this.#logNoise(host), this.#logNoise(host)];
      host.lastLogMs = nowMs;
      return;
    }
    const missing = Math.floor((nowMs - host.lastLogMs) / intervalMs);
    if (missing <= 0) return;
    // Bounded: a run that ignores a host for an hour must not build a thousand
    // lines to throw away, and the ring only holds MAX_LOG_LINES anyway.
    const lines = Math.min(missing, MAX_LOG_LINES);
    for (let i = 0; i < lines; i++) host.logs.unshift(this.#logNoise(host));
    host.logs = host.logs.slice(0, MAX_LOG_LINES);
    host.lastLogMs = host.lastLogMs + missing * intervalMs;
  }

  /** One line of noise.
   *
   * Drawn from a DEDICATED stream, not the shared gameplay one. The number of
   * draws here depends on how long a script waited before bleeding, so using
   * `random` would let log volume perturb stock prices across an A/B — the same
   * fixed-width-draw hazard `#mutate` already guards against. */
  #logNoise(host: DarknetHost): string {
    const draw = this.#opts.logNoise ?? this.#opts.generate;
    const neighbours = (this.#opts.network.get(host.hostname) ?? [])
      .filter((name) => this.hosts.has(name) || name === "darkweb");

    // The leak that matters most: a NEIGHBOUR's password, in cleartext. The
    // chance falls with difficulty, exactly as upstream's does.
    if (draw() < 0.05 * (1 / (host.difficulty + 1)) && neighbours.length > 0) {
      const pick = neighbours[Math.floor(draw() * neighbours.length)]!;
      const other = this.record(pick);
      if (other) return `Connecting to ${pick}:${other.password} ...`;
    }
    // The packet sniffer leaks its OWN password, and often.
    if (host.modelId === "OpenWebAccessPoint" && draw() < 0.7 - host.difficulty * 0.01) {
      return `Logging in with passcode: ${host.password} ...`;
    }
    // A stranger's password, unattributed.
    if (draw() < 0.05) {
      const movable = [...this.hosts.values()].filter((entry) => entry.online && !entry.isStationary);
      if (movable.length > 0) {
        return `--${movable[Math.floor(draw() * movable.length)]!.password}--`;
      }
    }
    // Two characters of this host's own password.
    if (draw() < 0.1 && host.password.length > 0) {
      const a = host.password[Math.floor(draw() * host.password.length)]!;
      const b = host.password[Math.floor(draw() * host.password.length)]!;
      return `There's definitely a ${a} and a ${b}...`;
    }
    // A topology edge, free.
    if (draw() < 0.05 && neighbours.length > 0) {
      return `[sending transaction details to ${neighbours[Math.floor(draw() * neighbours.length)]!}.]`;
    }
    return `00:00:00: ${host.hostname} - heartbeat check (alive)`;
  }

  /** heartbleed's read. `peek` leaves the lines in place. */
  captureLogs(hostname: string, count: number, peek: boolean, nowMs: number): string[] {
    const host = this.record(hostname);
    if (!host) return [];
    this.populateLogs(hostname, nowMs);
    const taken = host.logs.slice(0, count);
    if (!peek) host.logs = host.logs.slice(count);
    return taken;
  }

  /** Write an authentication attempt into the ring, as `logPasswordAttempt`
   * does. This is the ONLY way a model's response reaches a script: upstream's
   * `authenticate()` returns a generic failure for everything but the labyrinth.
   * Source: src/DarkNet/models/packetSniffing.ts:90-125 */
  logAttempt(
    hostname: string,
    attempted: string,
    code: number,
    message: string,
    data: string | undefined,
    nowMs: number,
  ): void {
    const host = this.record(hostname);
    if (!host) return;
    // Seed the ring FIRST, exactly as upstream's logPasswordAttempt does. Its
    // first-touch branch REPLACES the log array, so writing the attempt before
    // the seed would have the seed throw it away — and the oracle would vanish
    // on the very first attempt against every host, which is the only one that
    // matters for a model we have never seen.
    this.populateLogs(hostname, nowMs);
    const entry: Record<string, unknown> = { code, message, passwordAttempted: attempted };
    if (data !== undefined) entry["data"] = data;
    host.logs = [JSON.stringify(entry), ...host.logs].slice(0, MAX_LOG_LINES);
  }

  /** Check a password, and say what the model says back.
   *
   * The feedback switch is narrower than upstream's twenty-four arms: the ones
   * transcribed are the cheap pure-function ones, and the rest fall through to
   * the static hint — which is exactly what upstream's own `default` branch
   * does, so those are faithful rather than approximated. What is narrowed is
   * which models get MORE than the default. Declared in DNET_ASSUMPTIONS.
   * Source: src/DarkNet/effects/authentication.ts:33-147 */
  checkPassword(hostname: string, attempted: string): { ok: boolean; message: string; data?: string } {
    const host = this.record(hostname);
    if (!host) return { ok: false, message: "Unauthorized" };
    if (attempted === host.password) return { ok: true, message: "Success" };
    switch (host.modelId) {
      case "AccountsManager_4.2":
        return {
          ok: false,
          message: host.passwordHint,
          data: Number(attempted) > Number(host.password) ? "Lower" : "Higher",
        };
      case "BellaCuore":
        return {
          ok: false,
          message: host.passwordHint,
          data: Number(attempted) > Number(host.password) ? "ALTUS NIMIS" : "PARUM BREVIS",
        };
      case "NIL":
        return {
          ok: false,
          message: "that wasn't right",
          data: attempted.split("").map((char, i) => (char === host.password[i] ? "yes" : "yesn't")).join(","),
        };
      case "DeepGreen": {
        let exact = 0;
        for (let i = 0; i < attempted.length; i++) if (attempted[i] === host.password[i]) exact++;
        const misplaced = attempted
          .split("")
          .filter((char, i) => char !== host.password[i] && host.password.includes(char)).length;
        return { ok: false, message: `Hint: ${exact} exact, ${misplaced} misplaced.`, data: `${exact},${misplaced}` };
      }
      case "2G_cellular": {
        const at = host.password.split("").findIndex((char, i) => char !== attempted[i]);
        return { ok: false, message: `Found a mismatch while checking each character (${at})`, data: "Response time" };
      }
      default:
        return { ok: false, message: "Unauthorized", data: host.data.length > 0 ? host.data : undefined };
    }
  }

  /** How many leading characters of `attempted` are right.
   *
   * `getSharedChars`, and the input to the `2G_cellular` timing oracle: each
   * correct leading character makes authentication take 50 ms LONGER, so slower
   * means closer and the attack climbs. */
  sharedChars(hostname: string, attempted: string): number {
    const host = this.record(hostname);
    if (!host) return 0;
    for (let i = 0; i < host.password.length; i++) {
      if (host.password[i] !== attempted[i]) return i;
    }
    return host.password.length;
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

  /** The mutation clock, on the engine's 200 ms cycle.
   * `getDarknetCyclesPerMutation` is `(rateMultiplier * 150) / depth` cycles,
   * rateMultiplier being 1 in BN15 and 2 elsewhere. Only deletions and restarts
   * are applied; moves would need upstream's placement logic, which this does
   * not reproduce. */
  darknetProcess(cycles: number): void {
    if (!this.hasAccess() || this.hosts.size === 0) return;
    const perMutation = ((this.#opts.bitNode === 15 ? 1 : 2) * 150) / this.netDepth();
    this.#cyclesSinceMutation += cycles;
    while (this.#cyclesSinceMutation > perMutation) {
      this.#cyclesSinceMutation -= perMutation;
      // Resolved for EVERY tick, including one that changes nothing: upstream
      // triggers it before the throttle roll, so an agent looping on it wakes
      // on the net's clock rather than on the net's activity.
      this.#triggerNextMutation();
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
      const count = Math.floor(roll[7]! * 3 + 1);
      for (let i = 0; i < count; i++) this.#deleteOne(roll[8]!);
    }

    if (roll[9]! < 0.1) {
      const count = Math.floor(roll[10]! * 3 + 1);
      for (let i = 0; i < count; i++) this.#addHost(Math.floor(roll[11]! * this.netDepth()), roll[12]!, roll[13]!);
      return;
    }

    // Two backdoor branches upstream, both no-ops here: a darknet backdoor is
    // not modelled, so the set they draw from is always empty. The draws are
    // still spent, because the stream's width must not depend on that.
    if (roll[14]! < 0.2) this.#restartOne(roll[15]!);

    if (roll[16]! < 0.3) {
      for (let i = 0; i < 3; i++) this.#moveHost(this.#pick(this.#movable(), roll[17 + i]!), roll[20]!, roll[21]!);
    }

    if (roll[22]! < 0.5) {
      this.#addConnections(roll[23]!, roll[24]!);
      return;
    }

    // Severing every connection on one host is what makes an adjacency list the
    // shortest-lived thing we hold, and it is why `topology` expires fastest.
    if (roll[25]! < 0.5) {
      const victim = this.#pick(this.#movable(), roll[26]!);
      if (victim) this.#disconnect(victim);
    }

    if (roll[27]! < 0.1) this.#balance(roll);
  }

  #movable(): string[] {
    return [...this.hosts.keys()]
      .filter((name) => {
        const host = this.hosts.get(name)!;
        return host.online && !host.isStationary;
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
  #addHost(difficulty: number, drawA: number, drawB: number): void {
    const wanted = Math.max(0, Math.min(Math.floor(difficulty), this.netDepth() - 1));
    const free = this.#openPositions(wanted, wanted);
    const cell = free[Math.floor(drawB * free.length)];
    if (!cell) return;
    const [depth, column] = cell;
    const hostname = `dnet-${depth}-x${this.#added++}`;
    if (this.hosts.has(hostname)) return;
    this.#buildHost(hostname, depth, depth, column);
    this.#wire(hostname, depth, column, drawA);
  }

  /** `addLowLevelServersIfNeeded`: keep the shallow rows populated.
   *
   * This is the branch that makes the net self-sustaining. Upstream tops row 0
   * up to more than three servers and keeps depth <= 3 above its density floor,
   * which is what stops deletion from emptying the approaches to the net. */
  #restockLowLevel(roll: readonly number[]): void {
    const online = [...this.hosts.values()].filter((entry) => entry.online);
    const atDarkweb = online.filter((entry) => entry.depth === 0).length;
    if (atDarkweb <= 3) {
      this.#addHost(0, roll[2]!, roll[3]!);
      this.#addHost(0, roll[4]!, roll[5]!);
    }
    const shallow = online.filter((entry) => entry.depth <= 3).length;
    if (shallow / (4 * NET_WIDTH) < LOW_LEVEL_SERVER_DENSITY) {
      this.#addHost(Math.floor(roll[6]! * 4), roll[7]!, roll[8]!);
      this.#addHost(Math.floor(roll[9]! * 4), roll[10]!, roll[11]!);
    }
  }

  /** `moveDarknetServer`: a new depth near the old one, and a full re-wire.
   *
   * A move invalidates a host's depth AND every edge it had, which is exactly
   * why `position` and `topology` expire on different clocks. */
  #moveHost(hostname: string | undefined, drawA: number, drawB: number): void {
    if (hostname === undefined) return;
    const host = this.hosts.get(hostname);
    if (!host || !host.online || host.isStationary) return;
    const span = 3;
    const shift = Math.floor(drawA * (span * 2 + 1)) - span;
    const wanted = Math.max(0, Math.min(host.depth + shift, this.netDepth() - 1));
    // Vacate FIRST, exactly as upstream does — `moveDarknetServer` clears the
    // old cell and drops every edge before re-seating. That is why the cell it
    // came from is a candidate for the cell it goes to, and why a move
    // invalidates adjacency as thoroughly as it invalidates depth.
    const from: [number, number] = [host.depth, host.leftOffset];
    this.#unwire(hostname);
    this.#vacate(host);
    const free = this.#openPositions(wanted, wanted);
    const cell = free[Math.floor(drawB * free.length)] ?? from;
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
    const host = this.hosts.get(victim)!;
    // Gone, permanently, with its files, sessions and logs — and its cell, which
    // is what lets the restocking branch put something back there.
    host.online = false;
    this.#vacate(host);
    host.sessions.clear();
    host.logs = [];
    this.#opts.forgetFiles?.(victim);
    this.#opts.processes.killall(victim);
    this.#opts.servers.delete(victim);
    this.#unwire(victim);
    this.#opts.network.delete(victim);
  }

  #restartOne(draw: number): void {
    const victim = this.#pick(this.#movable(), draw);
    if (victim === undefined) return;
    const host = this.hosts.get(victim)!;
    // Scripts die and SESSIONS are cleared, but the host, its files and its
    // admin rights survive. All four halves are separately wrong-able.
    host.sessions.clear();
    host.logs = [`{"code":200,"message":"Server restarting, terminating scripts..."}`];
    const server = this.#opts.servers.get(victim);
    if (server) server.backdoorInstalled = false;
    this.#opts.processes.killall(victim);
  }

  /** `balanceDarknetServers`: hold the population at the generator's density. */
  #balance(roll: readonly number[]): void {
    const target = Math.round(this.netDepth() * NET_WIDTH * SERVER_DENSITY);
    const movable = this.#movable();
    if (movable.length > target) {
      for (let i = 0; i < movable.length - target; i++) this.#deleteOne(roll[26]!);
      return;
    }
    for (let i = 0; i < target - movable.length; i++) {
      this.#addHost(Math.floor(roll[11]! * this.netDepth()), roll[23]!, roll[24]!);
    }
  }

}
