import type { SimServer } from "../core/effects.ts";
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
 * itself through `unmodeled()` rather than answering with a fabrication.
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
  "dnet.labyrinth: not modelled — hasFullDarknetAccess is SF15/BN15 only, and no lab server is placed",
  "dnet.caches: no .cache files are generated, so the purchase's real payoff is not represented",
  "dnet.netDepth: fixed at the no-SF15 fallback of 5; upstream grows it 7 -> 36 as the labyrinth is walked",
];

const NET_WIDTH = 8;
const SERVER_DENSITY = 0.6;
/** getNetDepth()'s fallback without full darknet access. */
const NO_SF15_NET_DEPTH = 5;

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
}

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

  get mutations(): number {
    return this.#mutations;
  }

  /** populateDarknet(). Idempotent, as upstream's guard makes it. */
  populate(): void {
    if (this.#populated) return;
    this.#populated = true;
    const { generate, servers, network } = this.#opts;
    // getNetDepth() is the current labyrinth's depth, which grows 7 -> 36 as the
    // labyrinth is walked. The labyrinth is not modelled, so the net stays at
    // the no-access fallback of 5 even under BN15/SF15. Declared in
    // DNET_ASSUMPTIONS rather than branched on.
    const depth = NO_SF15_NET_DEPTH;
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

  /** The mutation clock, on the engine's 200 ms cycle.
   * `getDarknetCyclesPerMutation` is `(rateMultiplier * 150) / depth` cycles,
   * rateMultiplier being 1 in BN15 and 2 elsewhere. Only deletions and restarts
   * are applied; moves would need upstream's placement logic, which this does
   * not reproduce. */
  darknetProcess(cycles: number): void {
    if (!this.hasAccess() || this.hosts.size === 0) return;
    const perMutation = ((this.#opts.bitNode === 15 ? 1 : 2) * 150) / NO_SF15_NET_DEPTH;
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
    const names = [...this.hosts.keys()].filter((name) => this.hosts.get(name)!.online).sort();
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
