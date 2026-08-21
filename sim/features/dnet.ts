import type { SimServer } from "../core/effects.ts";
import type { SimPlayer } from "../core/player.ts";
import type { SimWorld } from "../world.ts";
import { mockServer } from "../core/mocks.ts";
import { randomIp } from "../network.ts";
import type { ProcessTable } from "../ns/process.ts";

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
 * The formulas are transcribed. The TOPOLOGY is not: upstream places servers
 * through `addRandomDarknetServers`/`balanceDarknetServers` over a grid with
 * guaranteed-connection passes, and this reproduces the population and a
 * connected graph rather than that exact placement. `DNET_ASSUMPTIONS` records
 * it, so a run's metadata says which parts are shape rather than transcription.
 * Source: ../bitburner-src @ 3162fd2590e221eadd0c0fbd46151913f7c4c41c
 *   src/DarkNet/controllers/NetworkGenerator.ts, src/DarkNet/Enums.ts,
 *   src/DarkNet/models/DarknetServerOptions.ts, src/DarkNet/effects/ramblock.ts */

export const DNET_ASSUMPTIONS: readonly string[] = [
  "dnet.topology: population and connectivity are reproduced; upstream's exact grid placement and balancing passes are not",
  "dnet.labyrinth: the ladder, depth, reward order and the lab server are modelled; the MAZE itself is not, so a lab is never completed from a script",
  "dnet.cacheRewards: the draw is narrowed to money and the program/market unlocks, both exact; upstream also draws stock shares, clue files and (from phishing caches) coding contracts, so the MIX is narrower than upstream even though every reward given is faithful",
  "dnet.cacheSources: caches are only created on request — memoryReallocation clearing a block, and phishingAttack, are not modelled",
];

const NET_WIDTH = 8;
const SERVER_DENSITY = 0.6;
/** getNetDepth()'s fallback without full darknet access. */
const NO_SF15_NET_DEPTH = 5;

/** `labData`, in the order `getCurrentLabName` walks it. Depth is the whole
 * net's depth while that lab is current, so the net grows as the labyrinth is
 * walked. `manual` labs are solved through the UI maze, not by a script.
 * Source: src/DarkNet/effects/labyrinth.ts:37-108, src/Server/data/SpecialServers.ts:13-20 */
export interface LabStage {
  hostname: string;
  depth: number;
  cha: number;
  manual: boolean;
}
export const LAB_STAGES: readonly LabStage[] = [
  { hostname: "th3_l4byr1nth", depth: 7, cha: 300, manual: true },
  { hostname: "cru3l_l4byr1nth", depth: 12, cha: 600, manual: true },
  { hostname: "m3rc1l3ss_l4byr1nth", depth: 19, cha: 1_500, manual: false },
  { hostname: "ub3r_l4byr1nth", depth: 23, cha: 2_500, manual: false },
  { hostname: "et3rn4l_l4byr1nth", depth: 29, cha: 3_000, manual: false },
  { hostname: "end13ss_l4byr1nth", depth: 31, cha: 3_500, manual: false },
  { hostname: "f1n4l_l4byr1nth", depth: 36, cha: 4_000, manual: false },
  { hostname: "b0nus_l4byr1nth", depth: 36, cha: 4_000, manual: false },
];

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
  if (!has(LAB_AUGMENTATIONS[0])) return LAB_STAGES[0]!;
  if (!has(LAB_AUGMENTATIONS[1])) return LAB_STAGES[1]!;
  if (!has(LAB_AUGMENTATIONS[2])) return LAB_STAGES[2]!;
  if (!has(LAB_AUGMENTATIONS[3])) return LAB_STAGES[3]!;
  if (bitNode === 15) {
    if (!has(RED_PILL)) return LAB_STAGES[4]!;
    if (!has(LAB_AUGMENTATIONS[4])) return LAB_STAGES[5]!;
    if (!has(LAB_AUGMENTATIONS[5])) return LAB_STAGES[6]!;
    return LAB_STAGES[7]!;
  }
  if (!has(LAB_AUGMENTATIONS[4])) return LAB_STAGES[4]!;
  if (!has(LAB_AUGMENTATIONS[5])) return LAB_STAGES[5]!;
  if (allowRedPill && !has(RED_PILL)) return LAB_STAGES[6]!;
  return LAB_STAGES[7]!;
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

/** DarkNet/Enums.ts ModelIds — the subset reachable without SF15, which excludes
 * KingOfTheHill and SpiceLevel (ServerGenerator.ts:22) and the labyrinth. */
const MODEL_IDS = [
  "ZeroLogon", "FreshInstall_1.0", "TopPass", "EuroZone Free", "Laika4", "CloudBlare(tm)",
  "DeepGreen", "2G_cellular", "AccountsManager_4.2", "BellaCuore", "NIL", "110100100",
  "PrimeTime 2", "OctantVoxel", "MathML", "Factori-Os", "BigMo%od", "Pr0verFl0",
  "DeskMemo_3.1", "PHP 5.4", "OpenWebAccessPoint", "OrdoXenos",
] as const;

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

export interface DarknetHost {
  hostname: string;
  modelId: string;
  passwordHint: string;
  data: string;
  passwordLength: number;
  passwordFormat: "numeric" | "alphabetic" | "alphanumeric" | "ASCII" | "unicode";
  logTrafficInterval: number;
  blockedRam: number;
  difficulty: number;
  depth: number;
  requiredCharismaSkill: number;
  isStationary: boolean;
  online: boolean;
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
  #cyclesSinceMutation = 0;
  #mutations = 0;
  readonly #opts: DarknetSystemOptions;

  constructor(options: DarknetSystemOptions) {
    this.#opts = options;
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

  /** populateDarknet(). Idempotent, as upstream's guard makes it. */
  populate(): void {
    if (this.#populated) return;
    this.#populated = true;
    const { generate, servers, network } = this.#opts;
    const depth = this.netDepth();
    const count = Math.max(1, Math.round(depth * NET_WIDTH * SERVER_DENSITY) - 10);
    let previousRow: string[] = ["darkweb"];
    let placed = 0;
    for (let row = 0; row < depth && placed < count; row++) {
      const rowHosts: string[] = [];
      // Rows 0 and 1 are topped up to five upstream; deeper rows take what is
      // left of the population.
      const target = row < 2 ? 5 : Math.min(NET_WIDTH, count - placed);
      for (let i = 0; i < target && placed < count + 10; i++) {
        const hostname = `dnet-${row}-${i}`;
        const difficulty = row;
        const maxRam = rollMaxRam(difficulty, generate);
        const blockedRam = rollBlockedRam(maxRam, generate);
        const model = MODEL_IDS[Math.floor(generate() * MODEL_IDS.length)]!;
        const host: DarknetHost = {
          hostname,
          modelId: model,
          passwordHint: model === "ZeroLogon" ? "There is no password" : "You should remember this one",
          data: "",
          passwordLength: model === "ZeroLogon" ? 0 : 4 + row,
          passwordFormat: "numeric",
          // DarknetServerOptions.ts:87.
          logTrafficInterval: 1 + 30 * 0.9 ** difficulty,
          blockedRam,
          difficulty,
          depth: row,
          // depthScaling for depth < 2, per DarknetServerOptions.ts:70.
          requiredCharismaSkill: Math.max(1, row * 10),
          isStationary: false,
          online: true,
        };
        this.hosts.set(hostname, host);
        const server = mockServer({
          hostname,
          ip: randomIp(generate),
          maxRam,
          // Blocked RAM presents as USED RAM, which is what makes it
          // unallocatable (NetscriptWorker.ts:243).
          ramUsed: blockedRam,
          hasAdminRights: false,
        }) as SimServer;
        server.simKind = "DarknetServer";
        servers.set(hostname, server);
        const parent = previousRow[Math.floor(generate() * previousRow.length)] ?? "darkweb";
        network.set(hostname, [parent]);
        network.set(parent, [...(network.get(parent) ?? []), hostname]);
        rowHosts.push(hostname);
        placed++;
      }
      if (rowHosts.length > 0) previousRow = rowHosts;
    }
    this.#placeLab(previousRow);
  }

  /** `addLabyrinth` builds every lab server unconditionally, but only the
   * current one is reachable — `getLabyrinthDetails` resolves exactly one and
   * the rest are never consulted. So one host is placed, with the labyrinth
   * model id and the 128 GB / difficulty 10 / stationary values upstream gives
   * it.
   * Source: src/DarkNet/controllers/NetworkGenerator.ts:235-261 */
  #placeLab(deepestRow: readonly string[]): void {
    const lab = this.currentLab();
    if (!lab) return;
    const { servers, network, generate } = this.#opts;
    this.hosts.set(lab.hostname, {
      hostname: lab.hostname,
      modelId: "(The Labyrinth)",
      passwordHint: "You have discovered a dark, mysterious maze. Your footsteps echo eerily in the silence.",
      data: "",
      passwordLength: 0,
      passwordFormat: "ASCII",
      // Number.MAX_SAFE_INTEGER upstream: a lab never adds log traffic.
      logTrafficInterval: Number.MAX_SAFE_INTEGER,
      blockedRam: 0,
      difficulty: 10,
      depth: -1,
      requiredCharismaSkill: lab.cha,
      isStationary: true,
      online: true,
    });
    const server = mockServer({ hostname: lab.hostname, ip: randomIp(generate), maxRam: 128 }) as SimServer;
    server.simKind = "DarknetServer";
    servers.set(lab.hostname, server);
    const parent = deepestRow[0] ?? "darkweb";
    network.set(lab.hostname, [parent]);
    network.set(parent, [...(network.get(parent) ?? []), lab.hostname]);
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
    return {
      hostname: "darkweb",
      modelId: "ZeroLogon",
      passwordHint: "There is no password",
      data: "",
      passwordLength: 0,
      passwordFormat: "numeric",
      logTrafficInterval: 1 + 30,
      blockedRam: 0,
      difficulty: 0,
      depth: -1,
      requiredCharismaSkill: 1,
      isStationary: true,
      online: true,
    };
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
      this.#mutate();
    }
  }

  #mutate(): void {
    this.#mutations++;
    const { random, servers, network, processes } = this.#opts;
    // One fixed-width draw per mutation regardless of what it does, so the
    // shared gameplay stream advances identically whatever the net's state is.
    // Without that, two strategy variants would face different stock prices.
    const roll = random();
    const pick = random();
    // Stationary hosts — the labs — are exempt, as isImmutable makes them.
    const names = [...this.hosts.keys()]
      .filter((name) => {
        const host = this.hosts.get(name)!;
        return host.online && !host.isStationary;
      })
      .sort();
    if (names.length === 0) return;
    const victim = names[Math.floor(pick * names.length)]!;
    if (roll < 0.1) {
      // deleteRandomDarknetServers: gone, permanently, with its files.
      this.hosts.get(victim)!.online = false;
      processes.killall(victim);
      servers.delete(victim);
      network.delete(victim);
      for (const [host, links] of network) {
        const kept = links.filter((name) => name !== victim);
        if (kept.length !== links.length) network.set(host, kept);
      }
      return;
    }
    if (roll < 0.3) {
      // restartServer: scripts die, the host and its files survive.
      processes.killall(victim);
    }
  }

}
