import type { NS, ResetInfo } from "@ns";
import { versionedScript } from "../shared/deployment.ts";
import { initialContext, reduceRecord } from "../shared/goals/evaluate.ts";
import type { Goal } from "../shared/goals/goal.ts";
import { describeOverrides, type FeatureOverrides } from "../shared/features/profile.ts";
import type { SaveSeed } from "../shared/save/to-sim.ts";
import type { LogRecord, WireMessage } from "../shared/telemetry/schema.ts";
import { Clock } from "./clock.ts";
import type { SimPlayerOptions } from "./core/player.ts";
import type { ServerSpec } from "./core/effects.ts";
import { mulberry32 } from "./core/rng.ts";
import { Engine, initialCounters } from "./engine.ts";
import { CrimeSystem } from "./features/crime.ts";
import { FactionSystem } from "./features/factions.ts";
import { GraftingSystem } from "./features/grafting.ts";
import { HacknetSystem } from "./features/hacknet.ts";
import { StockMarketSystem } from "./features/stock.ts";
import { satisfiesAll, type SatisfyContext } from "./features/requirements.ts";
import { DEFAULT_NETWORK } from "./network.ts";
import { makeSingularity } from "./ns/singularity.ts";
import { launch, makeSimNs, type ScriptMain, type SimNsHost } from "./ns/api.ts";
import { ProcessTable } from "./ns/process.ts";
import { installVirtualTime } from "./realm/timers.ts";
import { noteUnmodeled, resetUnmodeled, setUnmodeledReporter, unmodeled, unmodeledCounts } from "./realm/unmodeled.ts";
import { SimWorld, type GateFlags, type SimOptions } from "./world.ts";
import { SIM_FEATURE_COVERAGE, scenarioClass, type RunValidity, type ScenarioClass } from "./fidelity.ts";
import { AUGMENTATION_TABLE } from "./vendor/bitburner/src/Augmentation/AugmentationTable.ts";

/** Run the REAL game/ controller against the synthetic world.
 *
 * This is the difference between "the simulator tests the planner" and "the
 * simulator tests what actually ships": game/lib/controller.ts, its sweep, its
 * probe runner, its dodge stub and its puppet workers all execute unmodified.
 * Nothing in game/ knows it is being simulated.
 *
 * One run per process. Two pieces of module-level state force it — the
 * vendored core's currentNodeMults, and the globalThis realm slots that game/
 * uses for its dodge and worker rendezvous — so multi-seed fan-out is
 * process-level (sim/run.ts). */

const WORKER_SCRIPT = versionedScript("worker/worker.js", "sim");
const DODGE_STUB = versionedScript("lib/dodge-stub.js", "sim");
const START_SCRIPT = "start.js";

export interface GameRunOptions {
  goal: Goal;
  seed: number;
  horizonMs: number;
  bitnode?: number;
  sourceFileLevel?: number;
  homeRam?: number;
  homeCores?: number;
  startingMoney?: number;
  network?: ServerSpec[];
  person?: SimOptions["person"];
  playerState?: SimPlayerOptions;
  factions?: Record<string, { rep: number; favor: number }>;
  /** Synthetic equivalents of save-only invitation state. A genuinely fresh
   * world has exact zero/empty defaults. */
  companies?: Record<string, number>;
  bladeburnerRank?: number;
  homeFiles?: string[];
  gates?: Partial<GateFlags>;
  /** Initial conditions from a real save (shared/save/to-sim.ts). Supplies the
   *  BitNode, source files, fleet, topology, player stats and gate flags —
   *  every explicit option above it still wins, so a profile can override one
   *  field of a save without rebuilding it. */
  save?: SaveSeed;
  /** Feature switches for this run (sim/profiles.ts). */
  features?: FeatureOverrides;
  /** Run identity, echoed into sim.meta so a stored JSONL is self-describing. */
  profile?: string;
  saveId?: string;
  runId?: string;
  label?: string;
  verbose?: boolean;
  onRecord?: (line: string) => void;
}

/** Singularity RAM is governed only by active SF4 (or BN4 inside getRamCost),
 * never by the Source File associated with the current BitNode. */
export function ramCostContext(bitNode: number, sourceFiles: Readonly<Record<string, number>>) {
  return { bitNode, sf4Level: sourceFiles["4"] ?? 0 };
}

export interface GameRunResult {
  seed: number;
  reached: boolean;
  timeToGoalMs: number;
  records: number;
  stoppedBecause: "goal" | "empty" | "horizon";
  /** 200ms game cycles processed — the second timebase's progress. */
  engineCycles: number;
  /** Everything the simulator was asked for and does not model, with counts. */
  unmodeled: Record<string, number>;
  crashes: { pid: number; filename: string; error: string }[];
  output: string[];
  validity: RunValidity;
  scenario: ScenarioClass;
}

/** Realm slots game/ owns. Cleared before and after a run so a process that
 * hosts more than one (tests) cannot leak a controller epoch or a live worker
 * registry into the next. */
const REALM_SLOTS = [
  "controllerEpoch",
  "state",
  "farmTarget",
  "worker_info",
  "worker_jobs",
  "worker_wake",
  "dispatch_done",
  "dispatch_wake",
  "dodge_func",
  "dodge_cb",
  "dodge_reject",
  "dodge_running",
] as const;

function clearRealm(): void {
  for (const slot of REALM_SLOTS) delete (globalThis as Record<string, unknown>)[slot];
}

function buildResetInfo(
  bitnode: number,
  sourceFileLevel: number,
  installedAugs: ReadonlyMap<string, number>,
  save?: SaveSeed,
): ResetInfo {
  const ownedSF = new Map<number, number>(
    Object.entries(save?.sourceFiles ?? {}).map(([sf, level]) => [Number(sf), level]),
  );
  if (ownedSF.size === 0 && sourceFileLevel > 0) ownedSF.set(bitnode, sourceFileLevel);
  const savedOptions = save?.bitNodeOptions;
  return {
    lastAugReset: 0,
    lastNodeReset: 0,
    currentNode: bitnode,
    ownedAugs: new Map(installedAugs),
    ownedSF,
    bitNodeOptions: {
      sourceFileOverrides: new Map<number, number>(
        Object.entries(savedOptions?.sourceFileOverrides ?? {}).map(([sf, level]) => [Number(sf), level]),
      ),
      intelligenceOverride: savedOptions?.intelligenceOverride,
      restrictHomePCUpgrade: savedOptions?.restrictHomePCUpgrade ?? false,
      disableGang: savedOptions?.disableGang ?? false,
      disableCorporation: savedOptions?.disableCorporation ?? false,
      disableBladeburner: savedOptions?.disableBladeburner ?? false,
      disable4SData: savedOptions?.disable4SData ?? false,
      disableHacknetServer: savedOptions?.disableHacknetServer ?? false,
      disableSleeveExpAndAugmentation: savedOptions?.disableSleeveExpAndAugmentation ?? false,
    },
  };
}

export async function runGame(options: GameRunOptions): Promise<GameRunResult> {
  const { goal, seed, horizonMs, save } = options;
  const bitnode = options.bitnode ?? save?.bitnode ?? 1;
  const sourceFileLevel = options.sourceFileLevel ?? save?.sourceFileLevel ?? 0;

  clearRealm();
  resetUnmodeled();

  // Compile-time flags become runtime globals. Telemetry stays ON: the sink is
  // real, only its transport is swapped, so the run exercises the same publish
  // path the game does — and never opens a socket.
  const realm = globalThis as Record<string, unknown>;
  realm["__TELEMETRY__"] = true;
  realm["__BUILD_ID__"] = "sim";

  const clock = new Clock();
  const virtualTime = installVirtualTime(clock);

  const ctx = initialContext();
  let recordCount = 0;
  const person = options.person ?? save?.person;
  const playerState = options.playerState ?? save?.playerState;

  const world = new SimWorld({
    seed,
    clock,
    bitnode,
    sourceFileLevel,
    homeRam: goal.setup?.homeRam ?? options.homeRam ?? save?.homeRam ?? 8,
    homeCores: options.homeCores ?? save?.homeCores ?? 1,
    startingMoney: goal.setup?.startingMoney ?? options.startingMoney ?? save?.startingMoney ?? 1_000,
    network: options.network ?? DEFAULT_NETWORK,
    ...(save ? { liveServers: save.servers } : {}),
    ...(person ? { person } : {}),
    ...(playerState ? { playerState } : {}),
    runId: options.runId ?? `${options.label ?? "game"}-seed${seed}`,
    verbose: options.verbose ?? false,
    ...(save || options.gates ? { gates: { ...save?.gates, ...options.gates } } : {}),
    onRecord: (record: LogRecord) => {
      recordCount++;
      reduceRecord(ctx, record);
      options.onRecord?.(JSON.stringify(record));
    },
  });

  setUnmodeledReporter((report) => world.emit({ kind: "event", name: "sim.unmodeled", data: report }));

  // The game's SECOND timebase, constructed AFTER the world so each feature
  // slice can hand it a subsystem that closes over real state. Order matters:
  // a subsystem cannot be wired to a world that does not exist yet, and
  // retrofitting a second timebase under models written against the first
  // would mean redoing all of them.
  const factions = new FactionSystem(world, world.player, options.factions ?? save?.factions);
  const terminal = { host: "home" };
  const hasTor = { value: false };
  const initialHomeFiles = new Set(
    save
      ? [START_SCRIPT, DODGE_STUB, WORKER_SCRIPT, "build-id.txt", ...save.homeFiles, ...(options.homeFiles ?? [])]
      : [START_SCRIPT, DODGE_STUB, WORKER_SCRIPT, "build-id.txt", "NUKE.exe", "hackers-starting-handbook.lit", ...(options.homeFiles ?? [])],
  );
  // Netburners' requirements are hacknet totals, so they have to be real
  // rather than the zeros a stub would report.
  const hacknetTotals = (): { ram: number; cores: number; levels: number } =>
    hacknet.nodes.reduce(
      (sum, node) => ({ ram: sum.ram + node.ram, cores: sum.cores + node.cores, levels: sum.levels + node.level }),
      { ram: 0, cores: 0, levels: 0 },
    );

  const satisfyContext = (): SatisfyContext => ({
    player: world.player,
    person: world.person,
    servers: world.servers,
    factionRep: (name) => factions.get(name)?.rep ?? 0,
    companyRep: (name) => options.companies?.[name] ?? save?.companies[name] ?? 0,
    bitNode: bitnode,
    // Not modelled yet; these feed requirements only, and reporting 0 is the
    // truth for a run with no hacknet rather than a fabricated value.
    hacknet: {
      ram: hacknetTotals().ram,
      cores: hacknetTotals().cores,
      levels: hacknetTotals().levels,
    },
    bladeburnerRank: () => {
      if (!world.gates.inBladeburner) return 0;
      if (options.bladeburnerRank !== undefined) return options.bladeburnerRank;
      if (save?.bladeburnerRank !== undefined) return save.bladeburnerRank;
      return unmodeled("subsystem", "bladeburner.rank", "Bladeburner exists but its rank was not seeded");
    },
    files: initialHomeFiles,
  });

  const crimes = new CrimeSystem(world, world.player, world.crimeRng);
  // The closure is invoked only after `host` is constructed, when a graft
  // actually completes. This lets program-granting augmentations update the
  // same home file set observed by ns.ls.
  const grafting = new GraftingSystem(world, world.player, () => host.files.get("home")!);
  const savedWork = save?.currentWork;
  if (savedWork) {
    const focused = save?.playerState.focus ?? true;
    if (savedWork.kind === "faction" || savedWork.kind === "crime" || savedWork.kind === "graft") {
      world.player.startWork({
        kind: savedWork.kind,
        subject: savedWork.subject,
        ...(savedWork.workType ? { workType: savedWork.workType } : {}),
        startedAt: clock.now() - savedWork.cyclesWorked * 200,
        cyclesWorked: savedWork.cyclesWorked,
        ...(savedWork.kind === "crime" ? { unitCycles: (savedWork.unitCompleted ?? 0) / 200 } : {}),
        focused,
      });
      if (savedWork.kind === "graft") grafting.restoreProgress(savedWork.unitCompleted ?? 0);
    } else {
      noteUnmodeled(
        "initial-state",
        `currentWork.${savedWork.kind}`,
        `serialized ${savedWork.ctor} cannot be advanced by the simulator`,
      );
    }
  }
  // The market gets its OWN seeded stream, offset like crimeRng: sharing the HGW
  // stream would make a price tick shift every subsequent hack roll, so two runs
  // differing only in trading activity would diverge in their farm results and
  // the A/B comparison would be meaningless.
  const stockRng = mulberry32(seed + 0x517cc1b7);
  // BN8 and SF8.1 grant WSE + TIX permanently (Prestige.ts:149). SF8 specifically
  // — `sourceFileLevel` is the level of the CURRENT node's file, which only
  // implies stock access when that node IS 8.
  const sf8 = save?.sourceFiles["8"] ?? (bitnode === 8 ? sourceFileLevel : 0);
  const freeAccess = bitnode === 8 || sf8 > 0;
  const stock = new StockMarketSystem(world, world.player, stockRng, {
    hasWseAccount: freeAccess || world.gates.hasWseAccount,
    hasTixApiAccess: freeAccess || world.gates.hasTixApiAccess,
    has4SData: world.gates.has4SData,
    has4SDataTixApi: world.gates.has4SDataTixApi,
    disable4SData: save?.bitNodeOptions.disable4SData === true,
    ...(save?.stockMarket ? { seed: save.stockMarket } : {}),
  });
  if (save?.stockMarket?.hasOrders) {
    noteUnmodeled("initial-state", "stock.orders", "the save contains limit/stop orders, whose fill engine is not modeled");
  }
  world.stockSystem = stock;
  const hashMode = (bitnode === 9 || (save?.sourceFiles["9"] ?? 0) > 0) && save?.bitNodeOptions.disableHacknetServer !== true;
  const hacknet = new HacknetSystem(world, world.player, hashMode, save?.hacknet);

  const engine: Engine = new Engine(clock, {
    updateOnlineScriptTimes: (cycles) => host.processes.updateOnlineTimes(cycles),
    // One work slot, so exactly one of these can be active — each returns
    // immediately unless it owns `currentWork`.
    processWork: (cycles) => {
      factions.processWork(cycles);
      crimes.processWork(cycles);
      grafting.processWork(cycles);
    },
    checkFactionInvitations: () => factions.checkInvitations((reqs) => satisfiesAll(reqs, satisfyContext())),
    // The one counter that compensates for a fat catch-up tick, and the one
    // that SKIPS the faction currently being worked.
    processPassiveFactionRepGain: (cycles) =>
      factions.passiveGain(cycles, world.player.currentWork?.kind === "faction" ? world.player.currentWork.subject : undefined),
    // LINEAR in cycles, with no bonus-time cap — the one subsystem that needs
    // no CycleBuffer.
    processHacknetEarnings: (cycles) => hacknet.processEarnings(cycles),
    // SECOND in updateGame's real order, right after processWork. The 6 s tick,
    // the 4 s floor and the 75-tick cycle all live inside the vendored function.
    processStockPrices: (cycles) => {
      stock.processPrices(cycles);
      // The 1 Hz rollup, driven from the engine rather than only from an HGW
      // landing. Without it a run with no farm — market-only, hacknet-only —
      // credits `moneyEarned` and never publishes it, so an `earn:` goal is
      // unreachable however much the run actually makes.
      world.pulse();
    },
  });
  engine.start();

  // A save carries its own topology. Otherwise: a star, which is what the six
  // servers in DEFAULT_NETWORK really are — all one hop from home.
  const network = new Map<string, string[]>();
  if (save) {
    for (const [hostname, neighbours] of Object.entries(save.topology)) network.set(hostname, neighbours);
  } else {
    const others = [...world.servers.keys()].filter((h) => h !== "home");
    network.set("home", others);
    for (const host of others) network.set(host, ["home"]);
  }
  const prestigeNetwork = new Map(
    [...network].map(([hostname, neighbours]) => [hostname, [...neighbours]] as const),
  );

  const host: SimNsHost = {
    world,
    clock,
    processes: new ProcessTable(world.servers, clock),
    files: new Map([["home", initialHomeFiles]]),
    // Empty build id: the controller's self-update branch compares against its
    // own __BUILD_ID__ and skips when the pushed value is blank.
    contents: new Map([["home\0build-id.txt", ""]]),
    scripts: new Map<string, ScriptMain>(),
    network,
    ramCtx: ramCostContext(bitnode, world.player.sourceFiles),
    reset: buildResetInfo(bitnode, sourceFileLevel, world.player.augmentations, save),
    output: [],
    crashes: [],
    engine,
    hacknet,
    stock,
    singularity: makeSingularity({
      world,
      player: world.player,
      factions,
      clock,
      bitNode: bitnode,
      terminal,
      network,
      crimes,
      grafting,
      satisfyContext,
      // The real call resets the counter to force an immediate re-check
      // rather than waiting out the 2 s cycle.
      pokeInvitationCounter: () => void (engine.counters["checkFactionInvitations"] = 0),
      homeFiles: () => host.files.get("home")!,
      hasTor: () => hasTor.value,
      setTor: (value) => void (hasTor.value = value),
      assertPrestigeSupported: () => world.assertPrestigeSupported(),
      onPrestige: (cbScript, newlyInstalled) => host.onPrestige?.(cbScript, newlyInstalled),
    }),
    // An augmentation install kills every process but preserves the browser
    // realm. The successor controller must detect and invalidate the stale
    // module/global state itself, exactly as it does in the game.
  };

  // Imported AFTER the flags are on globalThis, and dynamically so module
  // evaluation cannot outrun them.
  const [{ main: startMain }, { resetAllFeatures }, { initState }, dodgeStub, worker] = await Promise.all([
    import("../game/start.ts"),
    import("../game/lib/features/index.ts"),
    import("../game/lib/state.ts"),
    import("../game/lib/dodge-stub.ts"),
    import("../game/worker/worker.ts"),
  ]);

  // Bun caches every feature module for the process lifetime, while each
  // runGame call represents a genuinely fresh browser realm. Reset all module
  // state at this boundary, then discard the temporary store used by the hooks.
  // This is deliberately NOT done in onPrestige below: installs preserve the
  // live realm and must be detected by the successor controller.
  resetAllFeatures(initState(), "bitnode");
  clearRealm();

  // Match the game: prestige kills scripts without creating a new browser
  // realm. Keeping the slots is load-bearing; otherwise the simulator masks
  // stale-state bugs in the install callback path.
  host.onPrestige = (cbScript, newlyInstalled): void => {
    host.processes.killAll();
    world.prestigeAugmentation(newlyInstalled);
    hacknet.prestige();
    stock.prestige();
    grafting.prestige();
    hasTor.value = false;

    const homeFiles = new Set(
      [...(host.files.get("home") ?? [])].filter((file) => !file.toLowerCase().endsWith(".exe")),
    );
    homeFiles.add("NUKE.exe");
    for (const name of world.player.augmentations.keys()) {
      for (const program of AUGMENTATION_TABLE[name]?.programs ?? []) homeFiles.add(program);
    }
    host.files.clear();
    host.files.set("home", homeFiles);
    for (const key of [...host.contents.keys()]) {
      const separator = key.indexOf("\0");
      const hostname = key.slice(0, separator);
      const filename = key.slice(separator + 1);
      if (hostname !== "home" || filename.toLowerCase().endsWith(".exe")) host.contents.delete(key);
    }

    host.network.clear();
    for (const [hostname, neighbours] of prestigeNetwork) {
      if (!world.servers.has(hostname)) continue;
      host.network.set(hostname, neighbours.filter((neighbour) => world.servers.has(neighbour)));
    }
    host.reset = {
      ...host.reset,
      lastAugReset: clock.now(),
      ownedAugs: new Map(world.player.augmentations),
    };
    Object.assign(engine.counters, initialCounters());

    const callback = cbScript?.replace(/^\/+/, "");
    if (!callback || !host.files.get("home")?.has(callback) || !host.scripts.has(callback)) return;
    clock.in(500, () => {
      const process = host.processes.start({
        filename: callback,
        host: "home",
        args: [],
        threads: 1,
        ramPerThreadGb: 3.6,
        temporary: false,
      });
      if (process) launch(host, process);
      else host.crashes.push({ pid: 0, filename: callback, error: "home has too little RAM for install callback" });
    });
  };

  // Exercise start.ts itself, including telemetry construction, argument
  // parsing, RAM declaration and epoch ownership. The transport is replaced
  // underneath it: every wire record is fed straight into the simulated world.
  class SimTelemetrySocket {
    static readonly OPEN = 1;
    readyState = SimTelemetrySocket.OPEN;
    onopen: (() => void) | null = null;
    onclose: (() => void) | null = null;
    onerror: (() => void) | null = null;

    constructor() {
      queueMicrotask(() => this.onopen?.());
    }

    send(raw: unknown): void {
      const message = JSON.parse(String(raw)) as WireMessage;
      if ("records" in message) for (const record of message.records) world.emit(record);
    }

    close(): void {
      if (this.readyState !== SimTelemetrySocket.OPEN) return;
      this.readyState = 3;
      this.onclose?.();
    }
  }

  host.scripts.set(DODGE_STUB, dodgeStub.main as ScriptMain);
  host.scripts.set(WORKER_SCRIPT, worker.main as ScriptMain);
  host.scripts.set(START_SCRIPT, ((ns: NS) => startMain(ns, options.features)) as ScriptMain);

  world.emit({
    kind: "event",
    name: "sim.meta",
    data: {
      goal: goal.id,
      label: options.label,
      seed,
      driver: "game",
      scenario: scenarioClass(save !== undefined),
      coverage: SIM_FEATURE_COVERAGE,
      bitnode,
      features: describeOverrides(options.features),
      ...(options.saveId !== undefined ? { save: options.saveId } : {}),
      ...(options.profile !== undefined ? { profile: options.profile } : {}),
    },
  });

  const controller = host.processes.start({
    filename: START_SCRIPT,
    host: "home",
    args: [],
    threads: 1,
    // start.js's declared allocation, matching its first-statement ramOverride.
    ramPerThreadGb: 3.6,
    temporary: false,
  });
  if (!controller) throw new Error("home has too little RAM to start the controller");

  let stoppedBecause: GameRunResult["stoppedBecause"];
  const originalWebSocket = globalThis.WebSocket;
  try {
    globalThis.WebSocket = SimTelemetrySocket as unknown as typeof WebSocket;
    launch(host, controller);
    stoppedBecause = await clock.runAsync(() => goal.done(ctx), horizonMs);
  } finally {
    host.processes.killAll();
    engine.stop();
    virtualTime.restore();
    globalThis.WebSocket = originalWebSocket;
    setUnmodeledReporter(undefined);
  }

  const reached = stoppedBecause === "goal";
  const gaps = unmodeledCounts();
  const validity: RunValidity = Object.keys(gaps).length > 0 || host.crashes.length > 0 ? "invalid-for-goal" : "valid";
  const result: GameRunResult = {
    seed,
    reached,
    timeToGoalMs: reached ? clock.now() : Infinity,
    records: recordCount,
    stoppedBecause,
    engineCycles: engine.cyclesProcessed,
    unmodeled: gaps,
    crashes: host.crashes,
    output: host.output,
    validity,
    scenario: scenarioClass(save !== undefined),
  };
  world.emit({ kind: "event", name: "sim.result", data: { goal: goal.id, ...result } });
  clearRealm();
  return result;
}

/** Exported for tests that want to drive the harness by hand. */
export { makeSimNs };
