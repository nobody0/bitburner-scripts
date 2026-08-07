import type { Person } from "@ns";
import type { LogRecord } from "../shared/telemetry/schema.ts";
import { stateKey } from "../shared/telemetry/schema.ts";
import type { Action, PlayerView, ServerView, WorldView } from "../shared/world.ts";
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
import { replaceCurrentNodeMults } from "./vendor/bitburner/src/BitNode/BitNodeMultipliers.ts";
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
  startingMoney?: number;
  network?: ServerSpec[];
  runId?: string;
  /** Installed before construction emits the initial world snapshot. */
  onRecord?: (record: LogRecord) => void;
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
  readonly records: LogRecord[] = [];
  onRecord?: (record: LogRecord) => void;
  /** Fires after any scheduled action completes — the driver replans on it. */
  onSettled?: () => void;
  #rng: () => number;
  #seq = 0;
  #run: string;
  #inFlight = 0;

  constructor(opts: SimOptions) {
    replaceCurrentNodeMults(getBitNodeMultipliers(opts.bitnode ?? 1, (opts.sourceFileLevel ?? 0) + 1));
    this.#rng = mulberry32(opts.seed);
    this.#run = opts.runId ?? `seed${opts.seed}`;
    this.onRecord = opts.onRecord;
    this.money = opts.startingMoney ?? 1_000;
    this.person = mockPerson();

    const home = mockServer({
      hostname: "home",
      hasAdminRights: true,
      purchasedByPlayer: true,
      cpuCores: 1,
      maxRam: opts.homeRam ?? 8,
    }) as SimServer;
    this.servers.set("home", home);
    for (const spec of opts.network ?? []) {
      const server = serverFromSpec(spec, mockServer() as SimServer);
      this.servers.set(server.hostname, server);
    }

    this.emit({ kind: "event", name: "sim.started", data: { seed: opts.seed, bitnode: opts.bitnode ?? 1 } });
    this.mirrorPlayer();
    for (const server of this.servers.values()) this.mirrorServer(server);
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
        return this.#executeHgw(action.type, action.target, action.source, action.threads);
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
          this.onSettled?.();
        });
        return true;
      }
    }
  }

  #fail(action: Action, reason: string): boolean {
    this.emit({ kind: "event", name: "action.failed", data: { action, reason } });
    return false;
  }

  #executeHgw(type: "hack" | "grow" | "weaken", targetName: string, sourceName: string, threads: number): boolean {
    const action = { type, target: targetName, source: sourceName, threads };
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
    const seconds =
      type === "hack"
        ? calculateHackingTime(target, this.person)
        : type === "grow"
          ? calculateGrowTime(target, this.person)
          : calculateWeakenTime(target, this.person);

    source.ramUsed += ram;
    this.#inFlight++;
    this.emit({ kind: "event", name: `${type}.start`, data: { ...action, durationMs: seconds * 1000 } });

    this.clock.in(seconds * 1000, () => {
      source.ramUsed -= ram;
      this.#inFlight--;
      const cores = source.cpuCores;
      if (type === "hack") {
        const outcome = applyHack(target, this.person, threads, this.#rng());
        this.money += outcome.moneyGained;
        this.moneyEarned += outcome.moneyGained;
        this.hacks++;
        this.emit({ kind: "event", name: "hack.done", data: { ...action, ...outcome } });
      } else if (type === "grow") {
        const outcome = applyGrow(target, this.person, threads, cores);
        this.emit({ kind: "event", name: "grow.done", data: { ...action, growth: outcome.growth } });
      } else {
        const outcome = applyWeaken(target, this.person, threads, cores);
        this.emit({ kind: "event", name: "weaken.done", data: { ...action, ...outcome } });
      }
      this.mirrorServer(target);
      this.mirrorPlayer();
      this.onSettled?.();
    });
    return true;
  }
}
