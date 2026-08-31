import type { MoneySource, Person, Player } from "@ns";
import type { LogRecord } from "../shared/telemetry/schema.ts";
import { stateKey } from "../shared/telemetry/schema.ts";
import type { Action, CompletionEvent, HgwAction, PlayerView, ServerView, WorldView } from "../shared/world.ts";
import { WORKER_RAM } from "../shared/world.ts";
import { powerOfTwoRungs } from "../shared/strategy/ram-supply.ts";
import { Clock } from "./clock.ts";
import {
  applyGrow,
  applyHack,
  applyWeaken,
  getCloudServerCost,
  getCloudServerLimit,
  getCloudServerMaxRam,
  getCloudServerUpgradeCost,
  getUpgradeHomeCoresCost,
  getUpgradeHomeRamCost,
  serverFromSpec,
  type ServerSpec,
  type SimServer,
} from "./core/effects.ts";
import { mockPerson, mockServer } from "./core/mocks.ts";
import { NEW_GAME_MONEY, playerRecord, SimPlayer, type SimPlayerOptions } from "./core/player.ts";
import { mulberry32 } from "./core/rng.ts";
import { unmodeled } from "./realm/unmodeled.ts";
import { getRandomBonus as getCircadianBonus } from "./vendor/bitburner/src/Augmentation/CircadianBonus.ts";
import { AUGMENTATION_TABLE } from "./vendor/bitburner/src/Augmentation/AugmentationTable.ts";
import { getBitNodeMultipliers } from "./vendor/bitburner/src/BitNode/BitNodeMults.ts";
import { currentNodeMults, replaceCurrentNodeMults } from "./vendor/bitburner/src/BitNode/BitNodeMultipliers.ts";
import { CONSTANTS } from "./vendor/bitburner/src/Constants.ts";
import { sanitizeExploits, type Exploit } from "./vendor/bitburner/src/Exploits/Exploit.ts";
import {
  calculateGrowTime,
  calculateHackingTime,
  calculateWeakenTime,
} from "./vendor/bitburner/src/Hacking.ts";
import { calculateExp, calculateSkill } from "./vendor/bitburner/src/PersonObjects/formulas/skill.ts";
import { defaultMultipliers } from "./vendor/bitburner/src/PersonObjects/Multipliers.ts";
import { applySourceFile } from "./vendor/bitburner/src/SourceFile/applySourceFile.ts";
import { setSourceFileMultipliers } from "./vendor/bitburner/src/SourceFile/SourceFileAdapter.ts";
import { ServerConstants } from "./vendor/bitburner/src/Server/data/Constants.ts";

type MoneySourceKey = Exclude<keyof MoneySource, "total">;

/** calculateEntropy's four inverse fields. Every other field in the upstream
 * Multipliers object is a benefit and is multiplied by the entropy nerf. */
const ENTROPY_COST_FIELDS = new Set([
  "hacknet_node_purchase_cost",
  "hacknet_node_ram_cost",
  "hacknet_node_core_cost",
  "hacknet_node_level_cost",
]);

const EXPLOIT_BENEFIT_FIELDS = [
  "hacking_chance", "hacking_speed", "hacking_money", "hacking_grow", "hacking",
  "strength", "defense", "dexterity", "agility", "charisma",
  "hacking_exp", "strength_exp", "defense_exp", "dexterity_exp", "agility_exp", "charisma_exp",
  "company_rep", "faction_rep", "crime_money", "crime_success", "hacknet_node_money", "work_money",
] as const;

function emptyMoneySource(): MoneySource {
  return {
    bladeburner: 0, casino: 0, class: 0, codingcontract: 0,
    corporation: 0, crime: 0, gang: 0, gang_expenses: 0,
    hacking: 0, hacknet: 0, hacknet_expenses: 0, hospitalization: 0,
    infiltration: 0, sleeves: 0, stock: 0, total: 0, work: 0,
    servers: 0, other: 0, augmentations: 0,
  };
}

export interface SimOptions {
  seed: number;
  /** The game's single Math.random stream. Full runs supply the same function
   * to every subsystem and the patched realm; small harnesses derive it from
   * seed here. */
  random?: () => number;
  /** Shared with the virtual realm when running the real game controller. */
  clock?: Clock;
  bitnode?: number;
  sourceFileLevel?: number;
  intelligenceOverride?: number;
  homeRam?: number;
  homeCores?: number;
  homeIp?: string;
  /** Advanced BitNode option: cores cannot be upgraded and home RAM caps at
   * 128GB. Price getters remain unchanged, matching Player's methods. */
  restrictHomePCUpgrade?: boolean;
  startingMoney?: number;
  network?: ServerSpec[];
  runId?: string;
  /** Installed before construction emits the initial world snapshot. */
  onRecord?: (record: LogRecord) => void;
  /** Keep an in-memory copy of every emitted record. Direct unit harnesses use
   * this for assertions; streamed full-game runs disable it to avoid retaining
   * the same multi-gigabyte history that their JSONL sink already owns. */
  retainRecords?: boolean;
  /** Emit per-op events + per-completion mirrors (debugging). Default off:
   * completions mark servers dirty and a 1Hz virtual rollup flushes dirty
   * mirrors + the cumulative "farm" state topic — keeps JSONLs sane. */
  verbose?: boolean;
  /** What the capability gate batch will see. Everything defaults to locked,
   * which is a fresh BN1 save. */
  gates?: Partial<GateFlags>;
  /** Fully-specified servers, injected as-is instead of being derived from
   * base metadata through serverFromSpec. This is the path a real save takes:
   * its servers carry live money, security and RAM, and re-deriving them from
   * metadata would rewind the save to a fresh game. Overrides `network`. */
  liveServers?: Partial<SimServer>[];
  /** Skills, exp and multipliers from a save. Merged over mockPerson(). */
  person?: {
    skills?: Record<string, number>;
    exp?: Record<string, number>;
    mults?: Record<string, number>;
    hp?: { current: number; max: number };
  };
  /** Karma, kills, joined factions, owned augmentations, jobs — the non-Person
   *  half, from a save or a profile. */
  playerState?: SimPlayerOptions;
  /** Concrete rolls for augmentations whose multiplier object is randomized
   * at world creation (currently UCM). */
  augmentationStats?: Readonly<Record<string, Readonly<Record<string, number>>>>;
  /** Save's lifetime counter at virtual t=0. */
  totalPlaytime?: number;
}

/** The unlock readings ns exposes for free — what game/lib/probes/gates.ts
 * reads to decide which feature drivers may tick. */
export interface GateFlags {
  inGang: boolean;
  inBladeburner: boolean;
  hasCorporation: boolean;
  hasWseAccount: boolean;
  hasTixApiAccess: boolean;
  /** The $1b ticker data. Deliberately separate from the API flag below: the
   *  two are bought independently and only the API is readable from a script. */
  has4SData: boolean;
  has4SDataTixApi: boolean;
}

/** The simulated world. Durations come from the vendored game formulas at
 * action START; effects apply atomically at completion (sim/core/effects.ts),
 * exactly matching the game's setTimeout model. Emits the shared LogRecord
 * schema with src:"sim" and virtual t; detailed sim-only events are allowed.
 *
 * currentNodeMults is module-level state in the vendored core: one BitNode
 * config per process. */
export class SimWorld {
  readonly clock: Clock;
  readonly person: Person;
  /** The non-Person half: karma, kills, factions, augmentations, the work
   *  slot. Kept separate so the vendored formulas keep taking exactly an
   *  `IPerson` — a sleeve is a Person too. */
  readonly player: SimPlayer;
  readonly servers = new Map<string, SimServer>();
  readonly bitnode: number;
  moneyEarned = 0;
  scriptExpEarned = 0;
  readonly moneySources = { sinceInstall: emptyMoneySource(), sinceStart: emptyMoneySource() };
  /** The stock half of `Player.scriptProdSinceLastAug`: the SIGNED cash flow of
   * script-initiated TRADES only (BuyingAndSelling.tsx). Deliberately not the
   * `stock` money-source bucket, which also carries the WSE/TIX/4S access
   * purchases — upstream never counts those as script production, so folding
   * the bucket into getTotalScriptIncome would report a ~$31b hole after every
   * market unlock. */
  scriptStockFlowSinceInstall = 0;

  /** Single source of truth, delegated so the many `this.money += x` sites
   *  keep working while the value itself lives on the player. */
  get money(): number {
    return this.player.money;
  }
  set money(value: number) {
    this.player.money = value;
  }
  hacks = 0;
  readonly landed = { hack: 0, grow: 0, weaken: 0 };
  readonly records: LogRecord[] = [];
  readonly gates: GateFlags;
  onRecord?: (record: LogRecord) => void;
  /** Fires after any scheduled action completes — the driver replans on it. */
  onSettled?: (event: CompletionEvent) => void;
  /** Effects that upstream reapplies after multiplier rebuilds, in upstream
   * order. A list is required because both Stanek and IPvGO own factors. */
  readonly onMultipliersReset: (() => void)[] = [];
  /** The market, when a run wires one. Assigned AFTER construction because the
   *  system needs the world (and its clock) to exist first, exactly like
   *  `onPrestige` in sim/ns/api.ts. Absent in harnesses with no market, where a
   *  `{stock: true}` op is simply an ordinary op — which is also true in the game
   *  before a WSE account is bought. */
  stockSystem?: {
    influenceHack(server: { organizationName: string; moneyMax: number }, moneyDrained: number): void;
    influenceGrow(server: { organizationName: string; moneyMax: number }, moneyGrown: number): void;
  };
  #rng: () => number;
  #seq = 0;
  #run: string;
  #inFlight = 0;
  #verbose: boolean;
  #retainRecords: boolean;
  #dirty = new Set<SimServer>();
  #lastRollup = -1;
  #prestigeServers = new Map<string, SimServer>();
  #prestigeSupported: boolean;
  #augmentationStats: Record<string, Record<string, number>>;
  #intelligenceOverride: number | undefined;
  #nextIp!: () => string;
  #restrictHomePCUpgrade: boolean;
  #totalPlaytime: number;

  constructor(opts: SimOptions) {
    this.clock = opts.clock ?? new Clock();
    replaceCurrentNodeMults(getBitNodeMultipliers(opts.bitnode ?? 1, (opts.sourceFileLevel ?? 0) + 1));
    this.#rng = opts.random ?? mulberry32(opts.seed);
    this.crimeRng = this.#rng;
    this.#run = opts.runId ?? `seed${opts.seed}`;
    this.onRecord = opts.onRecord;
    this.#retainRecords = opts.retainRecords ?? true;
    this.bitnode = opts.bitnode ?? 1;
    this.#intelligenceOverride = opts.intelligenceOverride;
    this.#restrictHomePCUpgrade = opts.restrictHomePCUpgrade ?? false;
    this.#totalPlaytime = opts.totalPlaytime ?? 0;
    this.#prestigeSupported = !opts.liveServers || opts.liveServers.length === 0;
    this.#augmentationStats = Object.fromEntries(
      Object.entries(opts.augmentationStats ?? {}).map(([name, mults]) => [name, { ...mults }]),
    );
    this.#augmentationStats["Unstable Circadian Modulator"] ??= { ...getCircadianBonus().bonuses };
    this.person = mockPerson();
    this.player = new SimPlayer({
      money: opts.startingMoney ?? NEW_GAME_MONEY,
      ...(opts.playerState ?? {}),
    });
    if (opts.person) {
      // Merged, not replaced: a save stores a sparse mults bag, and the
      // missing entries must stay at their 1.0 defaults rather than vanish.
      if (opts.person.skills) Object.assign(this.person.skills, opts.person.skills);
      if (opts.person.exp) Object.assign(this.person.exp, opts.person.exp);
      if (opts.person.mults) Object.assign(this.person.mults, opts.person.mults);
      if (opts.person.hp) Object.assign(this.person.hp, opts.person.hp);
    }
    if (opts.playerState?.persistentIntelligenceExp === undefined) {
      this.player.persistentIntelligenceExp = this.person.exp.intelligence;
    }
    // Synthetic worlds may describe durable ownership without redundantly
    // spelling out the derived multiplier bag. Real saves provide their live
    // bag and must be accepted verbatim until the next prestige.
    //
    // An EMPTY bag counts as absent, not as "every multiplier is 1": a minted
    // route-leg checkpoint has no captured bag to write, and taking `{}`
    // literally would drop the Source-File multipliers the leg's entrance
    // earned until its first install rebuilt them.
    if (!opts.person?.mults || Object.keys(opts.person.mults).length === 0) this.rebuildMultipliers();
    this.#verbose = opts.verbose ?? false;
    this.gates = {
      inGang: false,
      inBladeburner: false,
      hasCorporation: false,
      hasWseAccount: false,
      hasTixApiAccess: false,
      has4SData: false,
      has4SDataTixApi: false,
      ...opts.gates,
    };

    // Server construction consumes the same global random stream upstream.
    // Keeping that ordering matters: an omitted synthetic IP changes the next
    // gameplay roll exactly as constructing that server in the game would.
    const ips = new Set<string>();
    const nextIp = (): string => {
      let ip: string;
      do {
        const encoded = this.#rng().toString(16) + "000000000";
        ip = (encoded.match(/..?/g) ?? []).slice(1, 5).map((part) => parseInt(part, 16)).join(".");
      } while (ips.has(ip));
      ips.add(ip);
      return ip;
    };
    const homeIp = opts.homeIp ?? nextIp();
    ips.add(homeIp);
    this.#nextIp = nextIp;

    const home = mockServer({
      hostname: "home",
      ip: homeIp,
      isConnectedTo: true,
      hasAdminRights: true,
      purchasedByPlayer: true,
      cpuCores: opts.homeCores ?? 1,
      maxRam: opts.homeRam ?? 8,
      baseDifficulty: 1,
      hackDifficulty: 1,
      minDifficulty: 1,
      numOpenPortsRequired: 5,
      requiredHackingSkill: 1,
      serverGrowth: 1,
    }) as SimServer;
    this.servers.set("home", home);
    if (opts.liveServers && opts.liveServers.length > 0) {
      // A save's servers replace the derived set outright, home included.
      for (const live of opts.liveServers) {
        const server = { ...mockServer(), ...live } as SimServer;
        if (server.ip) ips.add(server.ip);
        this.servers.set(server.hostname, server);
      }
    } else {
      for (const spec of opts.network ?? []) {
        const serverIp = spec.ip ?? nextIp();
        ips.add(serverIp);
        const server = serverFromSpec(
          spec.ip === undefined ? { ...spec, ip: serverIp } : spec,
          mockServer() as SimServer,
        );
        this.servers.set(server.hostname, server);
      }
    }
    for (const [hostname, server] of this.servers) {
      if (!server.purchasedByPlayer || hostname === "home") {
        this.#prestigeServers.set(hostname, structuredClone(server));
      }
    }

    this.emit({ kind: "event", name: "sim.started", data: { seed: opts.seed, bitnode: opts.bitnode ?? 1 } });
    this.mirrorPlayer();
    this.mirrorProgression();
    for (const server of this.servers.values()) this.mirrorServer(server);
    this.#rollup();
  }

  /** A save snapshot contains live rolled servers, not their generation rolls.
   * Reusing those values after an install would fabricate a reset world. */
  assertPrestigeSupported(): void {
    if (!this.#prestigeSupported) {
      unmodeled("subsystem", "augmentation prestige", "live-save server regeneration is not modelled");
    }
  }

  /** Mirror Player.gainMoney/loseMoney attribution. Callers still own the
   * actual balance mutation; this records the same signed delta exactly once. */
  recordMoney(source: MoneySourceKey, amount: number): void {
    if (!Number.isFinite(amount) || amount === 0) return;
    for (const ledger of [this.moneySources.sinceInstall, this.moneySources.sinceStart]) {
      ledger[source] += amount;
      ledger.total += amount;
    }
  }

  /** Script-initiated stock cash flow, for the `scriptProdSinceLastAug` half of
   * `ns.getTotalScriptIncome`. Callers still own the balance mutation and the
   * `stock` money-source record; this is the trade-only subset of them. */
  recordScriptStockFlow(amount: number): void {
    if (!Number.isFinite(amount) || amount === 0) return;
    this.scriptStockFlowSinceInstall += amount;
  }

  resetInstallMoneySources(): void {
    Object.assign(this.moneySources.sinceInstall, emptyMoneySource());
    this.scriptStockFlowSinceInstall = 0;
  }

  /** Player/server half of prestigeAugmentation. Factions, stock, Hacknet and
   * process lifecycle are owned by their systems and the host orchestrator. */
  prestigeAugmentation(
    newlyInstalled: ReadonlyMap<string, number>,
    plan?: unknown,
    regeneratedNetwork?: readonly ServerSpec[],
  ): void {
    this.assertPrestigeSupported();
    this.resetInstallMoneySources();

    // initCircadianModulator runs on every augmentation prestige before the
    // final augmentation reapplication. Its WHRNG is hourly Date-based, which
    // resolves against the virtual Date installed below the real controller.
    this.#augmentationStats["Unstable Circadian Modulator"] = { ...getCircadianBonus().bonuses };
    this.rebuildMultipliers();

    const intelligenceUnlocked = this.bitnode === 5 || (this.player.ownedSourceFiles["5"] ?? 0) > 0;
    for (const [skill, nodeField] of [
      ["hacking", "HackingLevelMultiplier"],
      ["strength", "StrengthLevelMultiplier"],
      ["defense", "DefenseLevelMultiplier"],
      ["dexterity", "DexterityLevelMultiplier"],
      ["agility", "AgilityLevelMultiplier"],
      ["charisma", "CharismaLevelMultiplier"],
    ] as const) {
      this.person.exp[skill] = calculateExp(
        1,
        this.person.mults[skill] * currentNodeMults[nodeField],
      );
      this.person.skills[skill] = 1;
    }
    if (!intelligenceUnlocked) {
      this.person.exp.intelligence = 0;
      this.person.skills.intelligence = 0;
      this.player.persistentIntelligenceExp = 0;
    } else {
      const persistentSkill = calculateSkill(this.player.persistentIntelligenceExp, 1);
      if (this.#intelligenceOverride === undefined || this.#intelligenceOverride >= persistentSkill) {
        this.person.exp.intelligence = this.player.persistentIntelligenceExp;
        this.person.skills.intelligence = persistentSkill;
      } else {
        this.person.exp.intelligence = calculateExp(this.#intelligenceOverride, 1);
        this.person.skills.intelligence = this.#intelligenceOverride;
      }
    }
    this.person.hp.current = this.person.hp.max;

    this.player.numPeopleKilled = 0;
    this.player.city = "Sector-12";
    this.player.location = "Travel Agency";
    this.player.jobs = {};
    this.player.factionRumors = [];
    this.player.focus = true;

    // PlayerObjectGeneralMethods.ts:102 — `1000 + CONSTANTS.Donations`, not a
    // bare 1000. The same base is what NeuroFlux's 1.01000262 encodes.
    let startingMoney = NEW_GAME_MONEY;
    for (const name of this.player.augmentations.keys()) startingMoney += AUGMENTATION_TABLE[name]?.startingMoney ?? 0;
    this.player.money = this.bitnode === 8 ? 250e6 : startingMoney;
    // BN8 overwrites the final balance only after these gainMoney calls; their
    // money-source attribution still exists even though that cash is replaced.
    if (startingMoney > NEW_GAME_MONEY) this.recordMoney("other", startingMoney - NEW_GAME_MONEY);

    const currentHome = this.servers.get("home");
    const homeRam = currentHome?.maxRam ?? this.#prestigeServers.get("home")?.maxRam ?? 8;
    const homeCores = currentHome?.cpuCores ?? this.#prestigeServers.get("home")?.cpuCores ?? 1;
    this.servers.clear();
    const resetServers = regeneratedNetwork
      ? new Map<string, SimServer>([
          ["home", structuredClone(this.#prestigeServers.get("home")!)],
          ...regeneratedNetwork.map((spec) => [
            spec.hostname,
            serverFromSpec(spec, mockServer() as SimServer),
          ] as const),
        ])
      : this.#prestigeServers;
    for (const [hostname, baseline] of resetServers) {
      const server = structuredClone(baseline);
      server.ramUsed = 0;
      if (hostname === "home") {
        server.maxRam = homeRam;
        server.cpuCores = homeCores;
      }
      this.servers.set(hostname, server);
      this.mirrorServer(server);
    }
    this.#dirty.clear();
    this.recalculateSkills();
    this.person.hp.current = this.person.hp.max;
    this.emit({
      kind: "event",
      name: "sim.prestige",
      data: { newlyInstalled: [...newlyInstalled], ...(plan !== undefined ? { plan } : {}) },
    });
    // Simulator-owned authoritative state for goal evaluation. A --perf run
    // deliberately receives no game telemetry, but install/BN goals must not
    // become blind merely because serialization is disabled.
    this.mirrorProgression();
    this.mirrorPlayer();
  }

  emit(partial: { kind: "state"; key: string; data: unknown } | { kind: "event"; name: string; data?: unknown } | { kind: "debug"; msg: string; data?: unknown }): void {
    const record = {
      ...partial,
      seq: this.#seq++,
      t: this.clock.now(),
      run: this.#run,
      src: "sim",
    } as LogRecord;
    if (this.#retainRecords) this.records.push(record);
    this.onRecord?.(record);
  }

  /** Same shape the in-game watched getters produce. */
  mirrorServer(server: SimServer): void {
    this.emit({ kind: "state", key: stateKey("getServer", server.hostname), data: structuredClone(server) });
  }

  mirrorPlayer(): void {
    this.emit({
      kind: "state",
      key: stateKey("getPlayer"),
      data: {
        money: this.money,
        skills: { ...this.person.skills },
        exp: { ...this.person.exp },
        mults: this.person.mults,
        // Karma and kills ride the player mirror because goals are evaluated
        // from the record stream, and a `karma:` goal has no other source.
        karma: this.player.karma,
        numPeopleKilled: this.player.numPeopleKilled,
      },
    });
  }

  /** Simulator-owned progression snapshot. Unlike game telemetry, this is
   * always emitted so goal evaluation is identical in normal and --perf runs. */
  mirrorProgression(): void {
    this.emit({
      kind: "state",
      key: "progression",
      data: { ownedAugs: Object.fromEntries(this.player.augmentations) },
    });
  }

  /** Measured hacking exp/sec for the evaluator's prep discount — the same
   * signal the game driver's EMA provides. Sampled on each view build.
   * Virtual clock, like every other timestamp in this class: Date.now() is
   * only virtual inside an installed realm (game-run.ts), and un-realmed
   * callers (run.ts, unit tests) were mixing real wall-clock dt with
   * virtual-speed exp deltas — the rate either never sampled or came out
   * inflated by the compression factor, machine-dependent either way.
   * Sentinel is -1 because clock.now() legitimately starts at 0. */
  private expRateEma = 0;
  private expRateLastAt = -1;
  private expRateLastExp = 0;

  playerView(): PlayerView {
    const now = this.clock.now();
    const dtSec = (now - this.expRateLastAt) / 1_000;
    if (this.expRateLastAt < 0) {
      this.expRateLastAt = now;
      this.expRateLastExp = this.person.exp.hacking;
    } else if (dtSec >= 1) {
      const sample = Math.max(0, (this.person.exp.hacking - this.expRateLastExp) / dtSec);
      this.expRateEma = this.expRateEma === 0 ? sample : this.expRateEma * 0.9 + sample * 0.1;
      this.expRateLastAt = now;
      this.expRateLastExp = this.person.exp.hacking;
    }
    return {
      money: this.money,
      hackingSkill: this.person.skills.hacking,
      hackingExp: this.person.exp.hacking,
      ...(this.expRateEma > 0 ? { hackingExpRate: this.expRateEma } : {}),
      intelligence: this.person.skills.intelligence,
      mults: {
        hacking: this.person.mults.hacking,
        hacking_exp: this.person.mults.hacking_exp,
        hacking_money: this.person.mults.hacking_money,
        hacking_grow: this.person.mults.hacking_grow,
        hacking_speed: this.person.mults.hacking_speed,
        hacking_chance: this.person.mults.hacking_chance,
      },
    };
  }

  /** `Person.updateSkillLevels` @ v3.0.1, transcribed.
   *
   * Every skill from its experience, floored and clamped to at least 1, each
   * with its own BitNode multiplier — and the HP recalculation, which is not
   * cosmetic: max HP is derived from defense, and the ratio is preserved so
   * training defense does not silently heal the player. */
  /** Alias of the game's one global random stream. */
  readonly crimeRng: () => number;

  recalculateSkills(): void {
    const person = this.person;
    for (const [skill, bnMult] of [
      ["hacking", "HackingLevelMultiplier"],
      ["strength", "StrengthLevelMultiplier"],
      ["defense", "DefenseLevelMultiplier"],
      ["dexterity", "DexterityLevelMultiplier"],
      ["agility", "AgilityLevelMultiplier"],
      ["charisma", "CharismaLevelMultiplier"],
    ] as const) {
      person.skills[skill] = Math.max(
        1,
        Math.floor(calculateSkill(person.exp[skill], person.mults[skill] * currentNodeMults[bnMult])),
      );
    }
    const ratio = Math.min(person.hp.current / person.hp.max, 1);
    person.hp.max = Math.floor(10 + person.skills.defense / 10);
    person.hp.current = Math.round(person.hp.max * ratio);
  }

  /** Player.gainIntelligenceExp @ v3.0.1. Intelligence is a permanent skill
   * once unlocked and ignores ordinary experience/level multipliers. */
  gainIntelligenceExp(amount: number): void {
    if (Number.isNaN(amount)) return;
    if (this.bitnode !== 5 && (this.player.ownedSourceFiles["5"] ?? 0) <= 0) return;
    this.person.exp.intelligence += amount;
    this.player.persistentIntelligenceExp += amount;
    this.person.skills.intelligence = calculateSkill(this.person.exp.intelligence, 1);
  }

  /** Reapply the same multiplier stack as prestige/applyEntropy: defaults,
   * every installed augmentation, active Source Files, then graft entropy. */
  rebuildMultipliers(): void {
    const target = this.person.mults as unknown as Record<string, number>;
    for (const key of Object.keys(target)) delete target[key];
    Object.assign(target, defaultMultipliers());

    for (const [name, storedLevel] of this.player.augmentations) {
      const augmentation = AUGMENTATION_TABLE[name]
        ?? unmodeled("subsystem", "augmentation multipliers", `unknown augmentation ${name}`);
      const values = augmentation.multsUnknown
        ? this.#augmentationStats[name]
          ?? unmodeled("subsystem", "augmentation multipliers", `${name} requires its world-generation roll`)
        : augmentation.mults;
      const repeats = name === "NeuroFlux Governor" ? storedLevel : 1;
      for (let level = 0; level < repeats; level++) {
        for (const [field, value] of Object.entries(values)) target[field] = (target[field] ?? 1) * value;
      }
    }

    setSourceFileMultipliers(this.person.mults);
    for (const [node, level] of Object.entries(this.player.sourceFiles)) applySourceFile(Number(node), level);

    this.player.exploits = sanitizeExploits(this.player.exploits as Exploit[]);
    const exploitBenefit = Math.pow(1.001, this.player.exploits.length);
    const exploitCost = Math.pow(0.999, this.player.exploits.length);
    for (const field of EXPLOIT_BENEFIT_FIELDS) target[field] = (target[field] ?? 1) * exploitBenefit;
    for (const field of ENTROPY_COST_FIELDS) target[field] = (target[field] ?? 1) * exploitCost;

    const nerf = Math.pow(CONSTANTS.EntropyEffect, this.player.entropy);
    for (const field of Object.keys(target)) {
      target[field] = ENTROPY_COST_FIELDS.has(field) ? target[field]! / nerf : target[field]! * nerf;
    }
    for (const listener of this.onMultipliersReset) listener();
  }

  augmentationStats(name: string): Readonly<Record<string, number>> | undefined {
    return this.#augmentationStats[name];
  }

  /** What ns.getPlayer() reports. Deep-copied — see sim/core/player.ts. */
  playerRecord(): Player {
    return playerRecord(this.person, this.player, this.#totalPlaytime);
  }

  /** engine.tsx updates this in discrete 200 ms cycles. Keeping it separate
   * from Clock.now() preserves exact getPlayer() reads between engine ticks. */
  addPlaytime(milliseconds: number): void {
    this.#totalPlaytime += milliseconds;
  }

  /** Duration of one op, in ms, from the state as it is RIGHT NOW. The game
   * snapshots this before the delay starts, so a weaken landing mid-flight
   * never speeds up an op already in the air. */
  hgwDurationMs(kind: HgwAction["type"], server: SimServer): number {
    if (server.simKind === "DarknetServer") {
      return unmodeled("subsystem", "Darknet HGW", "normal Netscript HGW rejects Darknet; its own mechanics are not modeled");
    }
    const seconds =
      kind === "hack"
        ? calculateHackingTime(server, this.person)
        : kind === "grow"
          ? calculateGrowTime(server, this.person)
          : calculateWeakenTime(server, this.person);
    return seconds * 1000;
  }

  /** Apply one completed op. Shared by both drivers: the planner path calls it
   * from its clock callback, the synthetic ns calls it from the `.then` on
   * netscriptDelay. Returns the value the ns function resolves to, alongside
   * the planner's CompletionEvent payload. */
  land(
    kind: HgwAction["type"],
    targetName: string,
    threads: number,
    cores = 1,
    /** `{stock: true}` was passed: this op also moves the target
     *  organization's share price. Hack pushes the second-order forecast DOWN,
     *  grow pushes it UP, and weaken does nothing at all — the game has no
     *  weaken-side influence, so there is deliberately no branch for it. */
    stock = false,
  ): { nsValue: number; result: CompletionEvent["result"] } {
    const target = this.servers.get(targetName);
    if (!target) throw new Error(`land: unknown server ${targetName}`);

    let nsValue = 0;
    let result: CompletionEvent["result"];
    if (kind === "hack") {
      const outcome = applyHack(target, this.person, threads, this.#rng());
      this.money += outcome.moneyGained;
      this.moneyEarned += outcome.moneyGained;
      this.recordMoney("hacking", outcome.moneyGained);
      this.scriptExpEarned += outcome.expGained;
      if (outcome.success) this.hacks++;
      this.landed.hack++;
      result = outcome;
      nsValue = outcome.moneyGained;
      if (stock) this.stockSystem?.influenceHack(target, outcome.moneyDrained);
      if (this.#verbose) this.emit({ kind: "event", name: "hack.done", data: { target: targetName, threads, ...outcome } });
    } else if (kind === "grow") {
      const outcome = applyGrow(target, this.person, threads, cores);
      this.scriptExpEarned += outcome.expGained;
      this.landed.grow++;
      result = { growth: outcome.growth, expGained: outcome.expGained };
      nsValue = target.moneyMax === 0 ? 0 : outcome.growth;
      if (stock) this.stockSystem?.influenceGrow(target, outcome.moneyGrown);
      if (this.#verbose) this.emit({ kind: "event", name: "grow.done", data: { target: targetName, threads, growth: outcome.growth } });
    } else {
      const outcome = applyWeaken(target, this.person, threads, cores);
      this.scriptExpEarned += outcome.expGained;
      this.landed.weaken++;
      result = outcome;
      nsValue = outcome.securityReduced;
      if (this.#verbose) this.emit({ kind: "event", name: "weaken.done", data: { target: targetName, threads, ...outcome } });
    }

    if (this.#verbose) {
      this.mirrorServer(target);
      this.mirrorPlayer();
    } else {
      this.#dirty.add(target);
      this.#maybeRollup();
    }
    return { nsValue, result };
  }

  view(): WorldView {
    const servers: ServerView[] = [...this.servers.values()].map((s) => ({
      hostname: s.hostname,
      hasAdminRights: s.hasAdminRights,
      purchasedByPlayer: s.purchasedByPlayer,
      moneyAvailable: s.moneyAvailable,
      moneyMax: s.moneyMax,
      hackDifficulty: s.hackDifficulty,
      minDifficulty: s.minDifficulty,
      baseDifficulty: s.baseDifficulty,
      requiredHackingSkill: s.requiredHackingSkill,
      serverGrowth: s.serverGrowth,
      numOpenPortsRequired: s.numOpenPortsRequired,
      maxRam: s.maxRam,
      usedRam: s.ramUsed,
      cpuCores: s.cpuCores,
    }));
    const home = this.servers.get("home")!;
    return {
      time: this.clock.now(),
      player: this.playerView(),
      servers,
      prices: {
        upgradeHomeRam:
          home.maxRam >= ServerConstants.HomeComputerMaxRam
          || (this.#restrictHomePCUpgrade && home.maxRam >= 128)
            ? Infinity
            : getUpgradeHomeRamCost(home.maxRam),
        cloudServer: Object.fromEntries(
          powerOfTwoRungs(getCloudServerMaxRam()).map((ram) => [ram, getCloudServerCost(ram)]),
        ),
        cloudServerLimit: getCloudServerLimit(),
      },
      nodeMults: {
        HackingSpeedMultiplier: currentNodeMults.HackingSpeedMultiplier,
        // Scales SKILL derived from experience, so it belongs to every forward
        // projection of the hacking level (prep-time discount, exp valuation,
        // landing-time hack percentage). It is 0.35 in BN4 and 0.25 in BN9.
        HackingLevelMultiplier: currentNodeMults.HackingLevelMultiplier,
        HackExpGain: currentNodeMults.HackExpGain,
        ScriptHackMoney: currentNodeMults.ScriptHackMoney,
        // The player's CUT of what was drained, distinct from the drain rate
        // above and applied at a different point. BN8 sets it to 0: the farm
        // still empties servers, still gains experience and still moves share
        // prices, and earns nothing. Omitting it made every BN8 target score as
        // though hacking paid full price.
        ScriptHackMoneyGain: currentNodeMults.ScriptHackMoneyGain,
        ServerGrowthRate: currentNodeMults.ServerGrowthRate,
        ServerWeakenRate: currentNodeMults.ServerWeakenRate,
      },
    };
  }

  inFlight(): number {
    return this.#inFlight;
  }

  /** Returns false (with an action.failed event) when preconditions fail. */
  execute(action: Action): boolean {
    switch (action.type) {
      case "hack":
      case "grow":
      case "weaken":
        return this.#executeHgw(action);
      case "share":
      case "stopShare":
        // The controller simulator exercises these through real worker.ts.
        return this.#fail(action, "share workers require the game driver");
      case "charge":
        // Stanek state is owned by the synthetic Netscript controller path;
        // the standalone planner cannot execute this subsystem.
        return this.#fail(action, "charge workers require the game driver");
      case "nuke": {
        const target = this.servers.get(action.target);
        if (!target || target.hasAdminRights) return this.#fail(action, "missing or already rooted");
        if (target.numOpenPortsRequired > 0) return this.#fail(action, "port openers not modeled yet");
        target.hasAdminRights = true;
        this.emit({ kind: "event", name: "nuke", data: { target: action.target } });
        this.mirrorServer(target);
        return true;
      }
      case "buyServer": {
        const cost = getCloudServerCost(action.ram);
        const owned = [...this.servers.values()].filter((s) =>
          s.purchasedByPlayer && s.hostname !== "home" && !s.hostname.startsWith("hacknet-server-"),
        ).length;
        if (owned >= getCloudServerLimit()) return this.#fail(action, "server limit reached");
        if (this.servers.has(action.name)) return this.#fail(action, "name taken");
        if (this.money < cost) return this.#fail(action, "insufficient money");
        this.money -= cost;
        this.recordMoney("servers", -cost);
        const server = mockServer({
          hostname: action.name,
          ip: this.#nextIp(),
          hasAdminRights: true,
          purchasedByPlayer: true,
          cpuCores: 1,
          maxRam: action.ram,
          baseDifficulty: 1,
          hackDifficulty: 1,
          minDifficulty: 1,
          numOpenPortsRequired: 5,
          requiredHackingSkill: 1,
          serverGrowth: 1,
        }) as SimServer;
        this.servers.set(action.name, server);
        this.emit({ kind: "event", name: "buyServer", data: { name: action.name, ram: action.ram, cost } });
        this.mirrorServer(server);
        this.mirrorPlayer();
        return true;
      }
      case "upgradeServer": {
        const server = this.servers.get(action.host);
        if (!server || !server.purchasedByPlayer || server.hostname.startsWith("hacknet-server-")) {
          return this.#fail(action, "not a cloud server");
        }
        const cost = getCloudServerUpgradeCost(server.maxRam, action.ram);
        if (cost < 0) return this.#fail(action, "invalid target RAM");
        if (this.money < cost) return this.#fail(action, "insufficient money");
        this.money -= cost;
        this.recordMoney("servers", -cost);
        server.maxRam = action.ram;
        this.emit({ kind: "event", name: "upgradeServer", data: { host: action.host, ram: action.ram, cost } });
        this.mirrorServer(server);
        this.mirrorPlayer();
        return true;
      }
      case "upgradeHomeRam": {
        const home = this.servers.get("home")!;
        const cost = getUpgradeHomeRamCost(home.maxRam);
        if (
          home.maxRam >= ServerConstants.HomeComputerMaxRam
          || (this.#restrictHomePCUpgrade && home.maxRam >= 128)
        ) return this.#fail(action, "home RAM maxed");
        if (this.money < cost) return this.#fail(action, "insufficient money");
        this.money -= cost;
        this.recordMoney("servers", -cost);
        home.maxRam *= 2;
        this.gainIntelligenceExp(CONSTANTS.IntelligenceSingFnBaseExpGain * 2);
        this.emit({ kind: "event", name: "upgradeHomeRam", data: { maxRam: home.maxRam, cost } });
        this.mirrorServer(home);
        this.mirrorPlayer();
        return true;
      }
      case "upgradeHomeCore": {
        const home = this.servers.get("home")!;
        if (this.#restrictHomePCUpgrade || home.cpuCores >= 8) return this.#fail(action, "home cores maxed");
        const cost = getUpgradeHomeCoresCost(home.cpuCores);
        if (this.money < cost) return this.#fail(action, "insufficient money");
        this.money -= cost;
        this.recordMoney("servers", -cost);
        home.cpuCores += 1;
        this.gainIntelligenceExp(CONSTANTS.IntelligenceSingFnBaseExpGain * 2);
        this.emit({ kind: "event", name: "upgradeHomeCore", data: { cores: home.cpuCores, cost } });
        this.mirrorServer(home);
        this.mirrorPlayer();
        return true;
      }
      case "sleep": {
        this.#inFlight++;
        this.clock.in(action.ms, () => {
          this.#inFlight--;
          this.onSettled?.({ kind: "sleep" });
        });
        return true;
      }
    }
  }

  #fail(action: Action, reason: string): boolean {
    this.emit({ kind: "event", name: "action.failed", data: { action, reason } });
    return false;
  }

  #executeHgw(action: HgwAction): boolean {
    const { type, target: targetName, source: sourceName, threads } = action;
    const target = this.servers.get(targetName);
    const source = this.servers.get(sourceName);
    if (!target || !source) return this.#fail(action, "unknown server");
    if (!target.hasAdminRights) return this.#fail(action, "no admin rights on target");
    if (threads < 1) return this.#fail(action, "threads < 1");
    if (type === "hack" && this.person.skills.hacking < target.requiredHackingSkill) {
      return this.#fail(action, "hacking skill too low");
    }
    const ram = WORKER_RAM[type] * threads;
    if (source.ramUsed + ram > source.maxRam) return this.#fail(action, "not enough RAM on source");
    // Effects land on the requested STRENGTH; RAM, the `threads < 1` guard and
    // the reservation above all stay on the spawned count. The engine rejects a
    // strength above the process's thread count, and the planner path reaches
    // this without passing through the driver's clamp, so enforce it here too.
    // Source: https://github.com/bitburner-official/bitburner-src/blob/3162fd2590e221eadd0c0fbd46151913f7c4c41c/src/Netscript/NetscriptHelpers.tsx#L434-L474
    const strength = action.strengthThreads === undefined
      ? threads
      : Math.min(action.strengthThreads, threads);
    if (strength <= 0) return this.#fail(action, "strengthThreads <= 0");

    // Duration computed at action start with CURRENT state (game: NetscriptFunctions
    // hack/grow/weaken compute *Time before netscriptDelay); seconds -> ms.
    // additionalMsec extends the landing exactly like the game's HGWOptions.
    const durationMs = this.hgwDurationMs(type, target) + (action.additionalMsec ?? 0);

    source.ramUsed += ram;
    this.#inFlight++;
    if (this.#verbose) this.emit({ kind: "event", name: `${type}.start`, data: { ...action, durationMs } });

    this.clock.in(durationMs, () => {
      source.ramUsed -= ram;
      this.#inFlight--;
      const { result } = this.land(type, targetName, strength, source.cpuCores, action.stock === true);
      this.onSettled?.({
        kind: type,
        opId: action.opId,
        target: targetName,
        threads: strength,
        at: this.clock.now(),
        result,
      });
    });
    return true;
  }

  /** Advance the 1 Hz rollup from a timebase other than an HGW landing.
   * The engine calls this so every subsystem on the 200 ms timebase is
   * covered, not just the ones that happen to land ops. */
  pulse(): void {
    this.#maybeRollup();
  }

  #maybeRollup(): void {
    if (this.clock.now() - this.#lastRollup < 1_000) return;
    this.#rollup();
  }

  #rollup(): void {
    this.#lastRollup = this.clock.now();
    for (const server of this.#dirty) this.mirrorServer(server);
    this.#dirty.clear();
    this.mirrorPlayer();
    this.emit({
      kind: "state",
      key: "farm",
      data: {
        landed: { ...this.landed },
        totals: { moneyEarned: this.moneyEarned, hacks: this.hacks },
      },
    });
  }
}
