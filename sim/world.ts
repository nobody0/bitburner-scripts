import type { MoneySource, Person, Player } from "@ns";
import type { LogRecord } from "../shared/telemetry/schema.ts";
import { stateKey } from "../shared/telemetry/schema.ts";
import type { Action, CompletionEvent, HgwAction, PlayerView, ServerView, WorldView } from "../shared/world.ts";
import { WORKER_RAM } from "../shared/world.ts";
import { Clock } from "./clock.ts";
import {
  applyGrow,
  applyHack,
  applyWeaken,
  getCloudServerCost,
  getCloudServerLimit,
  getCloudServerUpgradeCost,
  getUpgradeHomeCoresCost,
  getUpgradeHomeRamCost,
  serverFromSpec,
  type ServerSpec,
  type SimServer,
} from "./core/effects.ts";
import { mockPerson, mockServer } from "./core/mocks.ts";
import { playerRecord, SimPlayer, type SimPlayerOptions } from "./core/player.ts";
import { mulberry32 } from "./core/rng.ts";
import { unmodeled } from "./realm/unmodeled.ts";
import { AUGMENTATION_TABLE } from "./vendor/bitburner/src/Augmentation/AugmentationTable.ts";
import { getBitNodeMultipliers } from "./vendor/bitburner/src/BitNode/BitNodeMults.ts";
import { currentNodeMults, replaceCurrentNodeMults } from "./vendor/bitburner/src/BitNode/BitNodeMultipliers.ts";
import {
  calculateGrowTime,
  calculateHackingTime,
  calculateWeakenTime,
} from "./vendor/bitburner/src/Hacking.ts";
import { calculateSkill } from "./vendor/bitburner/src/PersonObjects/formulas/skill.ts";
import { ServerConstants } from "./vendor/bitburner/src/Server/data/Constants.ts";

type MoneySourceKey = Exclude<keyof MoneySource, "total">;

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
  /** Shared with the virtual realm when running the real game controller. */
  clock?: Clock;
  bitnode?: number;
  sourceFileLevel?: number;
  homeRam?: number;
  homeCores?: number;
  startingMoney?: number;
  network?: ServerSpec[];
  runId?: string;
  /** Installed before construction emits the initial world snapshot. */
  onRecord?: (record: LogRecord) => void;
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
  person?: { skills?: Record<string, number>; exp?: Record<string, number>; mults?: Record<string, number> };
  /** Karma, kills, joined factions, owned augmentations, jobs — the non-Person
   *  half, from a save or a profile. */
  playerState?: SimPlayerOptions;
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
  goPlayable: boolean;
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
  #dirty = new Set<SimServer>();
  #lastRollup = -1;
  #prestigeServers = new Map<string, SimServer>();
  #prestigeSupported: boolean;

  constructor(opts: SimOptions) {
    this.clock = opts.clock ?? new Clock();
    replaceCurrentNodeMults(getBitNodeMultipliers(opts.bitnode ?? 1, (opts.sourceFileLevel ?? 0) + 1));
    this.#rng = mulberry32(opts.seed);
    // Offset so the two streams never coincide.
    this.crimeRng = mulberry32(opts.seed + 0x9e3779b9);
    this.#run = opts.runId ?? `seed${opts.seed}`;
    this.onRecord = opts.onRecord;
    this.bitnode = opts.bitnode ?? 1;
    this.#prestigeSupported = !opts.liveServers || opts.liveServers.length === 0;
    this.person = mockPerson();
    this.player = new SimPlayer({
      money: opts.startingMoney ?? 1_000,
      ...(opts.playerState ?? {}),
    });
    if (opts.person) {
      // Merged, not replaced: a save stores a sparse mults bag, and the
      // missing entries must stay at their 1.0 defaults rather than vanish.
      if (opts.person.skills) Object.assign(this.person.skills, opts.person.skills);
      if (opts.person.exp) Object.assign(this.person.exp, opts.person.exp);
      if (opts.person.mults) Object.assign(this.person.mults, opts.person.mults);
    }
    this.#verbose = opts.verbose ?? false;
    this.gates = {
      inGang: false,
      inBladeburner: false,
      hasCorporation: false,
      hasWseAccount: false,
      hasTixApiAccess: false,
      has4SData: false,
      has4SDataTixApi: false,
      goPlayable: false,
      ...opts.gates,
    };

    const home = mockServer({
      hostname: "home",
      hasAdminRights: true,
      purchasedByPlayer: true,
      cpuCores: opts.homeCores ?? 1,
      maxRam: opts.homeRam ?? 8,
    }) as SimServer;
    this.servers.set("home", home);
    if (opts.liveServers && opts.liveServers.length > 0) {
      // A save's servers replace the derived set outright, home included.
      for (const live of opts.liveServers) {
        const server = { ...mockServer(), ...live } as SimServer;
        this.servers.set(server.hostname, server);
      }
    } else {
      for (const spec of opts.network ?? []) {
        const server = serverFromSpec(spec, mockServer() as SimServer);
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

  resetInstallMoneySources(): void {
    Object.assign(this.moneySources.sinceInstall, emptyMoneySource());
  }

  /** Player/server half of prestigeAugmentation. Factions, stock, Hacknet and
   * process lifecycle are owned by their systems and the host orchestrator. */
  prestigeAugmentation(newlyInstalled: ReadonlyMap<string, number>): void {
    this.assertPrestigeSupported();
    this.resetInstallMoneySources();

    const mults = this.person.mults as unknown as Record<string, number>;
    for (const [name, levels] of newlyInstalled) {
      const aug = AUGMENTATION_TABLE[name];
      if (!aug) unmodeled("subsystem", "augmentation prestige", `unknown augmentation ${name}`);
      if (aug!.multsUnknown) {
        unmodeled("subsystem", "augmentation prestige", `${name} has randomized multipliers`);
      }
      for (let level = 0; level < levels; level++) {
        for (const [field, value] of Object.entries(aug!.mults)) {
          mults[field] = (mults[field] ?? 1) * value;
        }
      }
    }

    const intelligenceUnlocked = this.bitnode === 5 || (this.player.sourceFiles["5"] ?? 0) > 0;
    for (const skill of ["hacking", "strength", "defense", "dexterity", "agility", "charisma"] as const) {
      this.person.exp[skill] = 0;
      this.person.skills[skill] = 1;
    }
    if (!intelligenceUnlocked) {
      this.person.exp.intelligence = 0;
      this.person.skills.intelligence = 0;
    }
    this.person.hp.current = this.person.hp.max;

    this.player.numPeopleKilled = 0;
    this.player.city = "Sector-12";
    this.player.location = "Travel Agency";
    this.player.jobs = {};
    this.player.factionRumors = [];
    this.player.focus = true;

    let startingMoney = 1_000;
    for (const name of this.player.augmentations.keys()) startingMoney += AUGMENTATION_TABLE[name]?.startingMoney ?? 0;
    this.player.money = this.bitnode === 8 ? 250e6 : startingMoney;

    const currentHome = this.servers.get("home");
    const homeRam = currentHome?.maxRam ?? this.#prestigeServers.get("home")?.maxRam ?? 8;
    const homeCores = currentHome?.cpuCores ?? this.#prestigeServers.get("home")?.cpuCores ?? 1;
    this.servers.clear();
    for (const [hostname, baseline] of this.#prestigeServers) {
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
    this.emit({ kind: "event", name: "sim.prestige", data: { newlyInstalled: [...newlyInstalled] } });
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
    this.records.push(record);
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
  /** A SEPARATE seeded stream for subsystems that roll independently of the
   * HGW path. Sharing `#rng` would make a crime outcome shift every subsequent
   * hack roll, so two runs differing only in career activity would diverge in
   * their farm results and the comparison would be meaningless. */
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

  /** What ns.getPlayer() reports. Deep-copied — see sim/core/player.ts. */
  playerRecord(): Player {
    return playerRecord(this.person, this.player, this.clock.now());
  }

  /** Duration of one op, in ms, from the state as it is RIGHT NOW. The game
   * snapshots this before the delay starts, so a weaken landing mid-flight
   * never speeds up an op already in the air. */
  hgwDurationMs(kind: HgwAction["type"], server: SimServer): number {
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
          home.maxRam >= ServerConstants.HomeComputerMaxRam ? Infinity : getUpgradeHomeRamCost(home.maxRam),
        cloudServer: { 64: getCloudServerCost(64), 256: getCloudServerCost(256), 1024: getCloudServerCost(1024) },
        cloudServerLimit: getCloudServerLimit(),
      },
      nodeMults: {
        HackingSpeedMultiplier: currentNodeMults.HackingSpeedMultiplier,
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
          hasAdminRights: true,
          purchasedByPlayer: true,
          cpuCores: 1,
          maxRam: action.ram,
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
        if (home.maxRam >= ServerConstants.HomeComputerMaxRam) return this.#fail(action, "home RAM maxed");
        if (this.money < cost) return this.#fail(action, "insufficient money");
        this.money -= cost;
        this.recordMoney("servers", -cost);
        home.maxRam *= 2;
        this.emit({ kind: "event", name: "upgradeHomeRam", data: { maxRam: home.maxRam, cost } });
        this.mirrorServer(home);
        this.mirrorPlayer();
        return true;
      }
      case "upgradeHomeCore": {
        const home = this.servers.get("home")!;
        if (home.cpuCores >= 8) return this.#fail(action, "home cores maxed");
        const cost = getUpgradeHomeCoresCost(home.cpuCores);
        if (this.money < cost) return this.#fail(action, "insufficient money");
        this.money -= cost;
        this.recordMoney("servers", -cost);
        home.cpuCores += 1;
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
      const { result } = this.land(type, targetName, threads, source.cpuCores, action.stock === true);
      this.onSettled?.({ kind: type, opId: action.opId, target: targetName, threads, result });
    });
    return true;
  }

  /** Advance the 1 Hz rollup from a timebase OTHER than an HGW landing.
   *
   * `land()` is the only other caller, which used to be the only one — and that
   * silently made the earnings ledger invisible to any run without a farm. A
   * hacknet-only or market-only run credited `moneyEarned` correctly and never
   * published it, so an `earn:` goal could not be reached however much the run
   * made. The engine calls this so every subsystem on the 200 ms timebase is
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
