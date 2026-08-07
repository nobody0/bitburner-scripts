import type { Person, Player } from "@ns";
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
  getUpgradeHomeRamCost,
  serverFromSpec,
  type ServerSpec,
  type SimServer,
} from "./core/effects.ts";
import { mockPerson, mockServer } from "./core/mocks.ts";
import { mulberry32 } from "./core/rng.ts";
import { getBitNodeMultipliers } from "./vendor/bitburner/src/BitNode/BitNodeMults.ts";
import { currentNodeMults, replaceCurrentNodeMults } from "./vendor/bitburner/src/BitNode/BitNodeMultipliers.ts";
import {
  calculateGrowTime,
  calculateHackingTime,
  calculateWeakenTime,
} from "./vendor/bitburner/src/Hacking.ts";
import { ServerConstants } from "./vendor/bitburner/src/Server/data/Constants.ts";

export interface SimOptions {
  seed: number;
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
}

/** The unlock readings ns exposes for free — what game/lib/probes/gates.ts
 * reads to decide which feature drivers may tick. */
export interface GateFlags {
  inGang: boolean;
  inBladeburner: boolean;
  hasCorporation: boolean;
  hasWseAccount: boolean;
  hasTixApiAccess: boolean;
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
  readonly clock = new Clock();
  readonly person: Person;
  readonly servers = new Map<string, SimServer>();
  money: number;
  moneyEarned = 0;
  hacks = 0;
  readonly landed = { hack: 0, grow: 0, weaken: 0 };
  readonly records: LogRecord[] = [];
  readonly gates: GateFlags;
  onRecord?: (record: LogRecord) => void;
  /** Fires after any scheduled action completes — the driver replans on it. */
  onSettled?: (event: CompletionEvent) => void;
  #rng: () => number;
  #seq = 0;
  #run: string;
  #inFlight = 0;
  #verbose: boolean;
  #dirty = new Set<SimServer>();
  #lastRollup = -1;

  constructor(opts: SimOptions) {
    replaceCurrentNodeMults(getBitNodeMultipliers(opts.bitnode ?? 1, (opts.sourceFileLevel ?? 0) + 1));
    this.#rng = mulberry32(opts.seed);
    this.#run = opts.runId ?? `seed${opts.seed}`;
    this.onRecord = opts.onRecord;
    this.money = opts.startingMoney ?? 1_000;
    this.person = mockPerson();
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

    this.emit({ kind: "event", name: "sim.started", data: { seed: opts.seed, bitnode: opts.bitnode ?? 1 } });
    this.mirrorPlayer();
    for (const server of this.servers.values()) this.mirrorServer(server);
    this.#rollup();
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
      },
    });
  }

  playerView(): PlayerView {
    return {
      money: this.money,
      hackingSkill: this.person.skills.hacking,
      hackingExp: this.person.exp.hacking,
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

  /** What ns.getPlayer() reports. */
  playerRecord(): Player {
    return {
      ...this.person,
      money: this.money,
      numPeopleKilled: 0,
      entropy: 0,
      jobs: {},
      factions: [],
      karma: 0,
      totalPlaytime: this.clock.now(),
      location: "Sector-12" as Player["location"],
    } as unknown as Player;
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
  ): { nsValue: number; result: CompletionEvent["result"] } {
    const target = this.servers.get(targetName);
    if (!target) throw new Error(`land: unknown server ${targetName}`);

    let nsValue = 0;
    let result: CompletionEvent["result"];
    if (kind === "hack") {
      const outcome = applyHack(target, this.person, threads, this.#rng());
      this.money += outcome.moneyGained;
      this.moneyEarned += outcome.moneyGained;
      if (outcome.success) this.hacks++;
      this.landed.hack++;
      result = outcome;
      nsValue = outcome.moneyGained;
      if (this.#verbose) this.emit({ kind: "event", name: "hack.done", data: { target: targetName, threads, ...outcome } });
    } else if (kind === "grow") {
      const outcome = applyGrow(target, this.person, threads, cores);
      this.landed.grow++;
      result = { growth: outcome.growth, expGained: outcome.expGained };
      nsValue = target.moneyMax === 0 ? 0 : outcome.growth;
      if (this.#verbose) this.emit({ kind: "event", name: "grow.done", data: { target: targetName, threads, growth: outcome.growth } });
    } else {
      const outcome = applyWeaken(target, this.person, threads, cores);
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
        const owned = [...this.servers.values()].filter((s) => s.purchasedByPlayer && s.hostname !== "home").length;
        if (owned >= getCloudServerLimit()) return this.#fail(action, "server limit reached");
        if (this.servers.has(action.name)) return this.#fail(action, "name taken");
        if (this.money < cost) return this.#fail(action, "insufficient money");
        this.money -= cost;
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
      case "upgradeHomeRam": {
        const home = this.servers.get("home")!;
        const cost = getUpgradeHomeRamCost(home.maxRam);
        if (home.maxRam >= ServerConstants.HomeComputerMaxRam) return this.#fail(action, "home RAM maxed");
        if (this.money < cost) return this.#fail(action, "insufficient money");
        this.money -= cost;
        home.maxRam *= 2;
        this.emit({ kind: "event", name: "upgradeHomeRam", data: { maxRam: home.maxRam, cost } });
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
      const { result } = this.land(type, targetName, threads, source.cpuCores);
      this.onSettled?.({ kind: type, opId: action.opId, target: targetName, threads, result });
    });
    return true;
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
