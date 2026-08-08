import type { NS, ResetInfo } from "@ns";
import { versionedScript } from "../shared/deployment.ts";
import { initialContext, reduceRecord } from "../shared/goals/evaluate.ts";
import type { Goal } from "../shared/goals/goal.ts";
import { describeOverrides, type FeatureOverrides } from "../shared/features/profile.ts";
import type { SaveSeed } from "../shared/save/to-sim.ts";
import type { LogRecord } from "../shared/telemetry/schema.ts";
import type { StateKey, StateMap } from "../shared/telemetry/state-map.ts";
import { Clock } from "./clock.ts";
import type { ServerSpec } from "./core/effects.ts";
import { Engine } from "./engine.ts";
import { CrimeSystem } from "./features/crime.ts";
import { FactionSystem } from "./features/factions.ts";
import { HacknetSystem } from "./features/hacknet.ts";
import { satisfiesAll, type SatisfyContext } from "./features/requirements.ts";
import { DEFAULT_NETWORK } from "./network.ts";
import { makeSingularity } from "./ns/singularity.ts";
import { launch, makeSimNs, type ScriptMain, type SimNsHost } from "./ns/api.ts";
import { ProcessTable } from "./ns/process.ts";
import { installVirtualTime } from "./realm/timers.ts";
import { resetUnmodeled, setUnmodeledReporter, unmodeledCounts } from "./realm/unmodeled.ts";
import { SimWorld, type GateFlags } from "./world.ts";

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
}

/** Realm slots game/ owns. Cleared before and after a run so a process that
 * hosts more than one (tests) cannot leak a controller epoch or a live worker
 * registry into the next. */
const REALM_SLOTS = [
  "controllerEpoch",
  "state",
  "farmTarget",
  "worker_info",
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

function buildResetInfo(bitnode: number, sourceFileLevel: number): ResetInfo {
  const ownedSF = new Map<number, number>();
  if (sourceFileLevel > 0) ownedSF.set(bitnode, sourceFileLevel);
  return {
    lastAugReset: 0,
    lastNodeReset: 0,
    currentNode: bitnode,
    ownedAugs: new Map<string, number>(),
    ownedSF,
    bitNodeOptions: {
      sourceFileOverrides: new Map<number, number>(),
      intelligenceOverride: undefined,
      restrictHomePCUpgrade: false,
      disableGang: false,
      disableCorporation: false,
      disableBladeburner: false,
      disable4SData: false,
      disableHacknetServer: false,
      disableSleeveExpAndAugmentation: false,
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

  const world = new SimWorld({
    seed,
    bitnode,
    sourceFileLevel,
    homeRam: goal.setup?.homeRam ?? options.homeRam ?? save?.homeRam ?? 8,
    homeCores: options.homeCores ?? save?.homeCores ?? 1,
    startingMoney: goal.setup?.startingMoney ?? options.startingMoney ?? save?.startingMoney ?? 1_000,
    network: options.network ?? DEFAULT_NETWORK,
    ...(save ? { liveServers: save.servers, person: save.person, playerState: save.playerState } : {}),
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
  const factions = new FactionSystem(world, world.player, save?.factions);
  const terminal = { host: "home" };
  const hasTor = { value: false };
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
    companyRep: () => 0,
    bitNode: bitnode,
    // Not modelled yet; these feed requirements only, and reporting 0 is the
    // truth for a run with no hacknet rather than a fabricated value.
    hacknet: {
      ram: hacknetTotals().ram,
      cores: hacknetTotals().cores,
      levels: hacknetTotals().levels,
    },
    bladeburnerRank: 0,
    numInfiltrations: 0,
    files: new Set<string>(),
  });

  const crimes = new CrimeSystem(world, world.player, world.crimeRng);
  const hacknet = new HacknetSystem(world, world.player);

  const engine: Engine = new Engine(clock, {
    // One work slot, so exactly one of these can be active — each returns
    // immediately unless it owns `currentWork`.
    processWork: (cycles) => {
      factions.processWork(cycles);
      crimes.processWork(cycles);
    },
    checkFactionInvitations: () => factions.checkInvitations((reqs) => satisfiesAll(reqs, satisfyContext())),
    // The one counter that compensates for a fat catch-up tick, and the one
    // that SKIPS the faction currently being worked.
    processPassiveFactionRepGain: (cycles) =>
      factions.passiveGain(cycles, world.player.currentWork?.kind === "faction" ? world.player.currentWork.subject : undefined),
    // LINEAR in cycles, with no bonus-time cap — the one subsystem that needs
    // no CycleBuffer.
    processHacknetEarnings: (cycles) => hacknet.processEarnings(cycles),
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

  const host: SimNsHost = {
    world,
    clock,
    processes: new ProcessTable(world.servers, clock),
    files: new Map([["home", new Set([START_SCRIPT, DODGE_STUB, WORKER_SCRIPT, "build-id.txt"])]]),
    // Empty build id: the controller's self-update branch compares against its
    // own __BUILD_ID__ and skips when the pushed value is blank.
    contents: new Map([["home\0build-id.txt", ""]]),
    scripts: new Map<string, ScriptMain>(),
    network,
    ramCtx: { bitNode: bitnode, sf4Level: bitnode === 4 ? 0 : sourceFileLevel },
    reset: buildResetInfo(bitnode, sourceFileLevel),
    output: [],
    crashes: [],
    engine,
    hacknet,
    singularity: makeSingularity({
      world,
      player: world.player,
      factions,
      clock,
      bitNode: bitnode,
      terminal,
      crimes,
      satisfyContext,
      // The real call resets the counter to force an immediate re-check
      // rather than waiting out the 2 s cycle.
      pokeInvitationCounter: () => void (engine.counters["checkFactionInvitations"] = 0),
      homeFiles: () => host.files.get("home")!,
      hasTor: () => hasTor.value,
      setTor: (value) => void (hasTor.value = value),
    }),
    // An augmentation install kills every process, so game/'s module-level
    // dispatcher ledger and the realm rendezvous slots describe a world that
    // no longer exists. game/ stays unaware it is simulated, so the cleanup
    // lives here. Wired below, once the modules are imported.
  };

  // Imported AFTER the flags are on globalThis, and dynamically so module
  // evaluation cannot outrun them.
  const [{ runController }, { makeSink }, { resetHackingState }, dodgeStub, worker] = await Promise.all([
    import("../game/lib/controller.ts"),
    import("../game/lib/telemetry-sink.ts"),
    import("../game/lib/features/hacking.ts"),
    import("../game/lib/dodge-stub.ts"),
    import("../game/worker/worker.ts"),
  ]);

  // game/ keeps its hacking ledger in MODULE state, not realm state, so that a
  // build handoff gives the new controller a clean one. Bun caches modules for
  // the life of the process, so a second run in the same process would inherit
  // the first one's heap and dispatcher stats. Clearing it here is what makes
  // this call equivalent to a fresh realm.
  resetHackingState();

  // A prestige is the same problem as a second run in one process: module
  // state outlives the world it describes. The realm slots go too — every
  // worker was killed, so every op id in the registry is unreportable.
  host.onPrestige = (): void => {
    resetHackingState();
    for (const slot of REALM_SLOTS) {
      if (slot !== "controllerEpoch") delete (globalThis as Record<string, unknown>)[slot];
    }
  };

  // The sink is the real one; only the Telemetry underneath it is swapped for
  // the world's record stream instead of a WebSocket.
  const telemetry = {
    state: <K extends StateKey>(key: K, data: StateMap[K]) => world.emit({ kind: "state", key, data }),
    mirror: (key: string, data: unknown) => world.emit({ kind: "state", key, data }),
    event: (name: string, data?: unknown) => world.emit({ kind: "event", name, data }),
    debug: (msg: string, data?: unknown) => world.emit({ kind: "debug", msg, data }),
    flush: () => {},
    dispose: () => {},
  };
  const sink = makeSink(telemetry);

  host.scripts.set(DODGE_STUB, dodgeStub.main as ScriptMain);
  host.scripts.set(WORKER_SCRIPT, worker.main as ScriptMain);
  host.scripts.set(START_SCRIPT, ((ns: NS) => {
    const epoch = ((realm["controllerEpoch"] as number | undefined) ?? 0) + 1;
    realm["controllerEpoch"] = epoch;
    return runController(ns, telemetry, sink, "cold", epoch, options.features);
  }) as ScriptMain);

  world.emit({
    kind: "event",
    name: "sim.meta",
    data: {
      goal: goal.id,
      label: options.label,
      seed,
      driver: "game",
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
    // start.js's real static cost, so home RAM accounting matches the game.
    ramPerThreadGb: 3.6,
    temporary: false,
  });
  if (!controller) throw new Error("home has too little RAM to start the controller");

  let stoppedBecause: GameRunResult["stoppedBecause"];
  try {
    launch(host, controller);
    stoppedBecause = await clock.runAsync(() => goal.done(ctx), horizonMs);
  } finally {
    engine.stop();
    virtualTime.restore();
    setUnmodeledReporter(undefined);
  }

  const reached = stoppedBecause === "goal";
  const result: GameRunResult = {
    seed,
    reached,
    timeToGoalMs: reached ? clock.now() : Infinity,
    records: recordCount,
    stoppedBecause,
    engineCycles: engine.cyclesProcessed,
    unmodeled: unmodeledCounts(),
    crashes: host.crashes,
    output: host.output,
  };
  world.emit({ kind: "event", name: "sim.result", data: { goal: goal.id, ...result } });
  clearRealm();
  return result;
}

/** Exported for tests that want to drive the harness by hand. */
export { makeSimNs };
