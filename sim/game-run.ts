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
import { Engine } from "./engine.ts";
import { CrimeSystem } from "./features/crime.ts";
import { EducationSystem } from "./features/education.ts";
import { CompanySystem } from "./features/companies.ts";
import { ProgramSystem } from "./features/programs.ts";
import { FactionSystem } from "./features/factions.ts";
import { GraftingSystem } from "./features/grafting.ts";
import { HacknetSystem } from "./features/hacknet.ts";
import { DarknetSystem } from "./features/dnet.ts";
import { setDarknetContext } from "./vendor/bitburner/src/StockMarket/MarketAdapter.ts";
import { currentNodeMults } from "./vendor/bitburner/src/BitNode/BitNodeMultipliers.ts";
import { GoSystem } from "./features/go-system.ts";
import { AggregateGoNeuralRuntime } from "./features/go-aggregate-runtime.ts";
import { ShareSystem } from "./features/share.ts";
import { StanekSystem } from "./features/stanek.ts";
import { StockMarketSystem } from "./features/stock.ts";
import { satisfiesAll, type SatisfyContext } from "./features/requirements.ts";
import {
  DEFAULT_NETWORK,
  generateInitialVanillaNetworkFromRng,
  generateVanillaNetworkFromRng,
  isSeededVanillaNetwork,
  DARKNET_NETWORK_SEED,
  VANILLA_NETWORK_SEED,
  withDarkwebServer,
} from "./network.ts";
import { makeSingularity } from "./ns/singularity.ts";
import { launch, makeSimNs, type ScriptMain, type SimNsHost } from "./ns/api.ts";
import { ProcessTable } from "./ns/process.ts";
import { installVirtualTime, type VirtualTime } from "./realm/timers.ts";
import { noteUnmodeled, resetUnmodeled, setUnmodeledReporter, unmodeled, unmodeledCounts } from "./realm/unmodeled.ts";
import { SimWorld, type GateFlags, type SimOptions } from "./world.ts";
import { scenarioFingerprint } from "./scenario.ts";
import {
  AGGREGATE_GO_MODEL,
  CONTROLLER_AUTOMATION_SOURCE_FILES,
  SIM_FEATURE_COVERAGE,
  SIMULATOR_MODEL_VERSION,
  SIMULATOR_VENDOR_COMMIT,
  scenarioClass,
  type RunValidity,
  type ScenarioClass,
  type GoSimulationFidelity,
} from "./fidelity.ts";
import type { ExperimentIdentity } from "../shared/experiment.ts";
import { AUGMENTATION_TABLE } from "./vendor/bitburner/src/Augmentation/AugmentationTable.ts";
import type { GameState } from "../game/lib/state.ts";
import { gameGlobal } from "../game/lib/globals.ts";
import { setGoNeuralRuntimeForTest } from "../game/lib/features/remaining.ts";

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
/** The darknet payloads. Registered like any other artifact so the controller's
 * seed really places a process and the agents really run — without them the
 * seed would `exec` a filename the sim has no main() for, the process would
 * finish immediately, and a BN15 run would report a darknet that never advances
 * while looking like the deploy worked. */
const DNET_OVERSEER = versionedScript("dnet/overseer.js", "sim");
const DNET_AGENT = versionedScript("dnet/agent.js", "sim");
const START_SCRIPT = "start.js";

export interface GameRunOptions {
  goal: Goal;
  seed: number;
  horizonMs: number;
  bitnode?: number;
  sourceFileLevel?: number;
  homeRam?: number;
  homeCores?: number;
  homeIp?: string;
  startingMoney?: number;
  network?: ServerSpec[];
  /** Explicit foreign-server graph. When absent, small synthetic fixtures use
   * the historical home-centred star. Saves always carry their own topology. */
  topology?: Record<string, readonly string[]>;
  augmentationStats?: Record<string, Record<string, number>>;
  person?: SimOptions["person"];
  playerState?: SimPlayerOptions;
  factions?: Record<string, { rep: number; favor: number }>;
  /** Synthetic equivalents of save-only invitation state. A genuinely fresh
   * world has exact zero/empty defaults. */
  companies?: Record<string, number | { rep?: number; favor?: number }>;
  bladeburnerRank?: number;
  homeFiles?: string[];
  gates?: Partial<GateFlags>;
  /** `BitNodeOptions.disable4SData` for synthetic worlds: the forecast cannot
   * be bought at all. Reaches the controller via `ns.getResetInfo()` and makes
   * the market refuse both 4S purchases, exactly like the upstream option. A
   * decoded save's own option still applies when this is absent. */
  disable4SData?: boolean;
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
  /** Performance experiment identity. It affects comparability and artifact
   * lineage only; it is never exposed to game/ decision code. */
  experiment?: ExperimentIdentity;
  runId?: string;
  label?: string;
  verbose?: boolean;
  /** Exercise the telemetry-free build path. Acquisition and decisions remain
   * identical; SimWorld's authoritative records still drive goals/validity. */
  telemetry?: boolean;
  /** Exact is the correctness lane. Full-route CLI runs use the calibrated
   * aggregate endpoint so Bun never pretends to provide WebGPU inference. */
  goFidelity?: GoSimulationFidelity;
  onRecord?: (line: string) => void;
  /** Optional artifact filter. Every record still reaches the goal reducer;
   * this only controls which already-observed records are serialized. */
  recordFilter?: (record: LogRecord) => boolean;
}

/** Singularity RAM is governed only by active SF4 (or BN4 inside getRamCost),
 * never by the Source File associated with the current BitNode. */
export function ramCostContext(bitNode: number, sourceFiles: Readonly<Record<string, number>>) {
  return { bitNode, sf4Level: sourceFiles["4"] ?? 0 };
}

/** Merge the simulator's declared automation allowance into both the active
 * and durable Source File views. Taking the maximum preserves stronger save
 * state and makes checkpoint replacement independent of this policy. */
function controllerPlayerState(playerState: SimPlayerOptions | undefined): SimPlayerOptions {
  const active = { ...(playerState?.sourceFiles ?? {}) };
  const owned = { ...(playerState?.ownedSourceFiles ?? playerState?.sourceFiles ?? {}) };
  for (const [sourceFile, level] of Object.entries(CONTROLLER_AUTOMATION_SOURCE_FILES)) {
    active[sourceFile] = Math.max(active[sourceFile] ?? 0, level);
    owned[sourceFile] = Math.max(owned[sourceFile] ?? 0, level);
  }
  return { ...(playerState ?? {}), sourceFiles: active, ownedSourceFiles: owned };
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
  /** Terminal stock economics. Wealth includes cash plus what closing every
   * position at the current quotes would return after commission. */
  stock: {
    cash: number;
    liquidationValue: number;
    wealth: number;
    realizedProfit: number;
    commissionPaid: number;
    tradesMade: number;
  };
  /** Small terminal strategy digest retained by --compact/--perf benchmarks.
   * It is read from the real controller's store after the run; no extra game
   * getter or simulation-only decision input is introduced. */
  strategy: {
    route?: string;
    nodeRemainingSec?: number;
    installRemainingSec?: number;
    augCount?: number;
    queuedAugmentations: number;
    installs: number;
    goGames: number;
    goPreferredUtilityPerSec?: number;
    goPreferredOpponent?: string;
    installVerdict?: string;
    installResetValueMult?: number;
    installThreshold?: number;
    pushMarginalRate?: number;
    factionObjective?: string;
    factionObjectiveAugs: string[];
    factionObjectiveEtaSec?: number;
    factionObjectiveActivationValue?: number;
    factionObjectiveMarginalActivationRate?: number;
    factionObjectiveRepTarget?: number;
    factionObjectivePurpose?: string;
    factionAction?: string;
    factionRecommendInstall?: boolean;
    factionNextBuy?: string;
    factionNextBuyPrice?: number;
    factionLastResult?: string;
    factionJoined: string[];
    factionBankedAugmentations: string[];
    factionDrainCeiling?: number;
    progressionInstallWanted?: boolean;
    progressionInstallReady?: boolean;
    progressionInstallBlockers: string[];
    coordinationNeeds: { by: string; kind: string; subject?: string; have: number; target: number }[];
    factionArbitration: string[];
    routeParts: { what: string; sec: number; measured: boolean }[];
    factionObjectiveRep?: number;
    factionObjectiveFavor?: number;
    factionContextRoute?: string;
    /** Simulator truth beside the controller's last observed probe, retained
     * to diagnose stale-currentWork planning without feeding either value
     * back into the game controller. */
    actualCurrentWork?: string;
    observedCurrentWork?: string;
    /** Simulator truth for terminal diagnosis only; never enters WorldView. */
    actualSkills: Record<string, number>;
    actualMoney: number;
  };
}

/** Realm slots game/ owns. Cleared before and after a run so a process that
 * hosts more than one (tests) cannot leak a controller epoch or a live worker
 * registry into the next. */
const REALM_SLOTS = [
  "controllerEpoch",
  "artifactIdentity",
  "state",
  "farmTarget",
  "worker_info",
  "worker_jobs",
  "worker_wake",
  "worker_stop",
  "worker_stop_requested",
  "dispatch_done",
  "dispatch_wake",
  "dispatch_wake_pending",
  "dispatch_weaken_timer",
  "dispatch_jit_timer",
  "dispatch_jit_at",
  "dodge_func",
  "dodge_cb",
  "dodge_reject",
  "dodge_running",
  "go_dodge_func",
  "go_dodge_cb",
  "go_dodge_reject",
  "go_dodge_running",
] as const;

function clearRealm(): void {
  for (const slot of REALM_SLOTS) delete (globalThis as Record<string, unknown>)[slot];
}

function buildResetInfo(
  bitnode: number,
  sourceFileLevel: number,
  sourceFiles: Readonly<Record<string, number>>,
  installedAugs: ReadonlyMap<string, number>,
  nowMs: number,
  save?: SaveSeed,
  disable4SData?: boolean,
): ResetInfo {
  // ResetInfo is what the real controller trusts for capability gates. Read
  // the constructed player, not only an imported save: synthetic profiles can
  // legitimately model a player revisiting BN1 with SF4/SF14 already earned.
  const ownedSF = new Map<number, number>(
    Object.entries(sourceFiles).map(([sf, level]) => [Number(sf), level]),
  );
  if (ownedSF.size === 0 && sourceFileLevel > 0) ownedSF.set(bitnode, sourceFileLevel);
  const savedOptions = save?.bitNodeOptions;
  return {
    lastAugReset: nowMs - (save?.playtimeSinceLastAug ?? 0),
    lastNodeReset: nowMs - (save?.playtimeSinceLastBitnode ?? 0),
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
      disable4SData: disable4SData ?? savedOptions?.disable4SData ?? false,
      disableHacknetServer: savedOptions?.disableHacknetServer ?? false,
      disableSleeveExpAndAugmentation: savedOptions?.disableSleeveExpAndAugmentation ?? false,
    },
  };
}

async function runGameInstalled(
  options: GameRunOptions,
  clock: Clock,
  virtualTime: VirtualTime,
  random: () => number,
  vanillaPrestigeRng?: () => number,
): Promise<GameRunResult> {
  const { goal, seed, horizonMs, save } = options;
  const bitnode = options.bitnode ?? save?.bitnode ?? 1;
  const sourceFileLevel = options.sourceFileLevel ?? save?.sourceFileLevel ?? 0;
  const scenario = scenarioClass(
    save !== undefined,
    isSeededVanillaNetwork(options.network, options.topology),
  );
  const goFidelity = options.goFidelity ?? "action-exact";
  // Consume the initial world's rolls. The supplied profile is that exact
  // first world; the next call must therefore produce the first post-install
  // regeneration rather than replaying it.
  if (vanillaPrestigeRng) generateInitialVanillaNetworkFromRng(vanillaPrestigeRng);

  // Compile-time flags become runtime globals. Normal runs exercise the real
  // publish path; --perf exercises the pinned telemetry-free behavior while
  // simulator-owned records still feed goals and fidelity checks.
  const realm = globalThis as Record<string, unknown>;
  realm["__TELEMETRY__"] = options.telemetry ?? true;
  realm["__BUILD_ID__"] = "sim";

  const ctx = initialContext();
  let recordCount = 0;
  const person = options.person ?? save?.person;
  const playerState = controllerPlayerState(options.playerState ?? save?.playerState);

  const world = new SimWorld({
    seed,
    random,
    clock,
    bitnode,
    sourceFileLevel,
    intelligenceOverride: save?.bitNodeOptions.intelligenceOverride,
    homeRam: goal.setup?.homeRam ?? options.homeRam ?? save?.homeRam ?? 8,
    homeCores: options.homeCores ?? save?.homeCores ?? 1,
    homeIp: options.homeIp ?? save?.servers.find((server) => server.hostname === "home")?.ip,
    restrictHomePCUpgrade: save?.bitNodeOptions.restrictHomePCUpgrade ?? false,
    startingMoney: goal.setup?.startingMoney ?? options.startingMoney ?? save?.startingMoney ?? 1_000,
    network: save ? options.network ?? DEFAULT_NETWORK : withDarkwebServer(options.network ?? DEFAULT_NETWORK),
    ...(save ? { liveServers: save.servers } : {}),
    ...(person ? { person } : {}),
    playerState,
    ...(options.augmentationStats ? { augmentationStats: options.augmentationStats } : {}),
    runId: options.runId ?? `${options.label ?? "game"}-seed${seed}`,
    verbose: options.verbose ?? false,
    retainRecords: false,
    totalPlaytime: save?.totalPlaytime ?? 0,
    ...(save || options.gates ? { gates: { ...save?.gates, ...options.gates } } : {}),
    onRecord: (record: LogRecord) => {
      recordCount++;
      reduceRecord(ctx, record);
      if (options.recordFilter?.(record) !== false) options.onRecord?.(JSON.stringify(record));
    },
  });

  setUnmodeledReporter((report) => world.emit({ kind: "event", name: "sim.unmodeled", data: report }));
  if (world.gates.inGang) noteUnmodeled("initial-state", "gang", "an active gang advances autonomously but is not modeled");
  if (world.gates.hasCorporation) {
    noteUnmodeled("initial-state", "corporation", "an active corporation advances autonomously but is not modeled");
  }
  if (world.gates.inBladeburner) {
    noteUnmodeled("initial-state", "bladeburner", "an active Bladeburner division advances autonomously but is not modeled");
  }
  if ((save?.sleeveCount ?? 0) > 0) {
    noteUnmodeled("initial-state", "sleeves", `${save!.sleeveCount} sleeves advance autonomously but are not modeled`);
  }
  if (save?.playerState.augmentations.some((augmentation) => augmentation.name === "Stanek's Gift - Genesis")) {
    noteUnmodeled(
      "initial-state",
      "Stanek's Gift",
      "the save decoder does not retain placed fragments, charge, or stored cycles",
    );
  }

  // The game's SECOND timebase, constructed AFTER the world so each feature
  // slice can hand it a subsystem that closes over real state. Order matters:
  // a subsystem cannot be wired to a world that does not exist yet, and
  // retrofitting a second timebase under models written against the first
  // would mean redoing all of them.
  const share = new ShareSystem(world);
  const factions = new FactionSystem(world, world.player, options.factions ?? save?.factions, share);
  const companies = new CompanySystem(world, world.player, options.companies ?? save?.companies);
  const stanek = save ? undefined : new StanekSystem(world, world.player, factions);
  const go = save ? undefined : new GoSystem(
    world,
    factions,
    random,
    goFidelity === AGGREGATE_GO_MODEL ? "aggregate" : "exact",
  );
  const terminal = { host: save?.currentServer ?? "home" };
  const initialHomeFiles = new Set(
    save
      ? [START_SCRIPT, DODGE_STUB, WORKER_SCRIPT, DNET_OVERSEER, DNET_AGENT, "build-id.txt", ...save.homeFiles, ...(options.homeFiles ?? [])]
      : [START_SCRIPT, DODGE_STUB, WORKER_SCRIPT, DNET_OVERSEER, DNET_AGENT, "build-id.txt", "NUKE.exe", "hackers-starting-handbook.lit", ...(options.homeFiles ?? [])],
  );
  const permanentDarknetAccess = (): boolean => bitnode === 15 || (world.player.sourceFiles["15"] ?? 0) > 0;
  if (permanentDarknetAccess()) initialHomeFiles.add("DarkscapeNavigator.exe");
  const hasTor = {
    value: save?.hasTor === true || permanentDarknetAccess() || initialHomeFiles.has("DarkscapeNavigator.exe"),
  };
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
    companyRep: (name) => companies.rep(name),
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
  const grafting = new GraftingSystem(world, world.player);
  // Invoked only after `host` is constructed, when program work starts or
  // finishes, so it observes the same home file set as ns.ls.
  const programs = new ProgramSystem(world, world.player, () => host.files.get("home")!);
  const savedWork = save?.currentWork;
  if (savedWork) {
    const focused = save?.playerState.focus ?? true;
    if (
      savedWork.kind === "faction"
      || savedWork.kind === "company"
      || savedWork.kind === "crime"
      || savedWork.kind === "graft"
      || savedWork.kind === "class"
    ) {
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
    } else if (savedWork.kind === "createProgram") {
      if (!programs.restore(savedWork.subject, savedWork.cyclesWorked, savedWork.unitCompleted ?? 0, focused)) {
        noteUnmodeled("initial-state", "currentWork.createProgram", `unknown program ${savedWork.subject}`);
      }
    } else {
      noteUnmodeled(
        "initial-state",
        `currentWork.${savedWork.kind}`,
        `serialized ${savedWork.ctor} cannot be advanced by the simulator`,
      );
    }
  }
  // BN8 and SF8.1 grant WSE + TIX permanently (Prestige.ts:149, gated on
  // `canAccessBitNodeFeature(8)` — the current node being 8 OR an OWNED SF8 at
  // any level, in any node). Synthetic player state counts as owned exactly
  // like a save's: `world.player.sourceFiles` already merged both, and
  // `sourceFileLevel` (the current node's file) only implies access when that
  // node IS 8.
  const sf8 = world.player.sourceFiles["8"] ?? (bitnode === 8 ? sourceFileLevel : 0);
  const freeAccess = bitnode === 8 || sf8 > 0;
  const stock = new StockMarketSystem(world, world.player, random, {
    hasWseAccount: freeAccess || world.gates.hasWseAccount,
    hasTixApiAccess: freeAccess || world.gates.hasTixApiAccess,
    has4SData: world.gates.has4SData,
    has4SDataTixApi: world.gates.has4SDataTixApi,
    disable4SData: options.disable4SData ?? save?.bitNodeOptions.disable4SData === true,
    ...(save?.stockMarket ? { seed: save.stockMarket } : {}),
  });
  if (save?.stockMarket?.hasOrders) {
    noteUnmodeled("initial-state", "stock.orders", "the save contains limit/stop orders, whose fill engine is not modeled");
  }
  world.stockSystem = stock;
  const hashMode = (bitnode === 9 || (save?.sourceFiles["9"] ?? 0) > 0) && save?.bitNodeOptions.disableHacknetServer !== true;
  const hacknet = new HacknetSystem(world, world.player, hashMode, save?.hacknet);
  const education = new EducationSystem(world, world.player, (name) => hacknet.hashLevels[name] ?? 0);
  // Declared before the engine so its 200 ms hook can close over it, assigned
  // after the host exists because it needs the process table and file map.
  let dnet: DarknetSystem | undefined;

  const engine: Engine = new Engine(clock, {
    addPlaytime: (milliseconds) => world.addPlaytime(milliseconds),
    updateOnlineScriptTimes: (cycles) => host.processes.updateOnlineTimes(cycles),
    // One work slot, so exactly one of these can be active — each returns
    // immediately unless it owns `currentWork`.
    processWork: (cycles) => {
      factions.processWork(cycles);
      companies.processWork(cycles);
      crimes.processWork(cycles);
      education.processWork(cycles);
      grafting.processWork(cycles);
      programs.processWork(cycles);
    },
    staneksGiftProcess: (cycles) => stanek?.process(cycles),
    checkFactionInvitations: () => factions.checkInvitations((reqs) => satisfiesAll(reqs, satisfyContext())),
    // The one counter that compensates for a fat catch-up tick, and the one
    // that SKIPS the faction currently being worked.
    processPassiveFactionRepGain: (cycles) =>
      factions.passiveGain(cycles, world.player.currentWork?.kind === "faction" ? world.player.currentWork.subject : undefined),
    // LINEAR in cycles, with no bonus-time cap — the one subsystem that needs
    // no CycleBuffer.
    processHacknetEarnings: (cycles) => hacknet.processEarnings(cycles),
    darknetProcess: (cycles) => dnet?.darknetProcess(cycles),
    // The real engine makes three coding-contract generation attempts every
    // ten minutes. Until the generated contract/reward lifecycle is modelled,
    // reaching that boundary with side automation enabled must be visible in
    // validity instead of silently deleting a progression source.
    generateContracts: () => {
      if (options.features?.side !== "off") {
        noteUnmodeled(
          "subsystem",
          "coding contract generation",
          "the v3.0.1 generation interval fired, but generated contracts and rewards are not modelled",
        );
      }
    },
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

  // A save carries its own topology; a full vanilla fixture supplies its
  // generated graph. Small focused fixtures default to a home-centred star.
  const network = new Map<string, string[]>();
  if (save) {
    for (const [hostname, neighbours] of Object.entries(save.topology)) network.set(hostname, neighbours);
  } else if (options.topology) {
    for (const [hostname, neighbours] of Object.entries(options.topology)) network.set(hostname, [...neighbours]);
    network.set("darkweb", network.get("darkweb") ?? []);
  } else {
    const others = [...world.servers.values()]
      .filter((server) => server.hostname !== "home" && server.simKind !== "DarknetServer")
      .map((server) => server.hostname);
    network.set("home", others);
    for (const host of others) network.set(host, ["home"]);
    if (world.servers.has("darkweb")) network.set("darkweb", []);
  }
  const prestigeNetwork = new Map(
    [...network].map(([hostname, neighbours]) => [hostname, [...neighbours]] as const),
  );
  const connectTor = (): void => {
    if (!world.servers.has("darkweb")) {
      return unmodeled("subsystem", "darkweb root", "the TOR edge cannot exist without the v3.0.1 darkweb server");
    }
    const home = network.get("home") ?? [];
    const darkweb = network.get("darkweb") ?? [];
    if (!home.includes("darkweb")) home.push("darkweb");
    if (!darkweb.includes("home")) darkweb.push("home");
    network.set("home", home);
    network.set("darkweb", darkweb);
  };
  if (hasTor.value) connectTor();

  const host: SimNsHost = {
    world,
    clock,
    nowMs: virtualTime.nowMs,
    goState: save ? null : undefined,
    ...(go ? { go } : {}),
    processes: new ProcessTable(world.servers, clock),
    files: new Map(
      save
        ? save.servers.map((server) => [
            server.hostname,
            new Set(server.hostname === "home" ? initialHomeFiles : server.contractFiles),
          ] as const)
        : [["home", initialHomeFiles]],
    ),
    // Empty build id: the controller's self-update branch compares against its
    // own __BUILD_ID__ and skips when the pushed value is blank.
    contents: new Map([["home\0build-id.txt", ""]]),
    scripts: new Map<string, ScriptMain>(),
    network,
    ramCtx: ramCostContext(bitnode, world.player.sourceFiles),
    reset: buildResetInfo(
      bitnode,
      sourceFileLevel,
      world.player.sourceFiles,
      world.player.augmentations,
      virtualTime.nowMs(),
      save,
      options.disable4SData,
    ),
    output: [],
    crashes: [],
    ...(save ? { goState: null } : {}),
    bladeburnerDisabled: save?.bitNodeOptions.disableBladeburner ?? false,
    engine,
    hacknet,
    share,
    ...(stanek ? { stanek } : {}),
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
      education,
      programs,
      companies,
      grafting,
      satisfyContext,
      // The real call resets the counter to force an immediate re-check
      // rather than waiting out the 2 s cycle.
      pokeInvitationCounter: () => void (engine.counters["checkFactionInvitations"] = 0),
      homeFiles: () => host.files.get("home")!,
      onDarknetUnlocked: () => dnet?.populate(),
      hasTor: () => hasTor.value,
      setTor: (value) => void (hasTor.value = value),
      augmentationStats: new Proxy({}, {
        get: (_target, name) => typeof name === "string" ? world.augmentationStats(name) : undefined,
      }),
      assertPrestigeSupported: () => world.assertPrestigeSupported(),
      onPrestige: (cbScript, newlyInstalled) => host.onPrestige?.(cbScript, newlyInstalled),
      onBitNodeComplete: (nextBitNode, cbScript, bitNodeOptions) => {
        share.reset();
        stanek?.prestigeSourceFile();
        world.emit({
          kind: "event",
          name: "bitnode.reset",
          data: {
            from: bitnode,
            to: nextBitNode,
            callback: cbScript,
            bitNodeOptions: {
              ...bitNodeOptions,
              sourceFileOverrides: [...bitNodeOptions.sourceFileOverrides],
            },
          },
        });
      },
    }),
    // An augmentation install kills every process but preserves the browser
    // realm. The successor controller must detect and invalidate the stale
    // module/global state itself, exactly as it does in the game.
  };

  // The darknet exists as soon as anything can reach it: BN15, an active SF15,
  // or DarkscapeNavigator.exe on home. `populate()` is idempotent, so the
  // seeded start and a later purchase both route through it.
  dnet = new DarknetSystem({
    servers: world.servers,
    network,
    processes: host.processes,
    generate: mulberry32(DARKNET_NETWORK_SEED),
    random,
    bitNode: bitnode,
    fullAccess: permanentDarknetAccess,
    hasProgram: () => host.files.get("home")?.has("DarkscapeNavigator.exe") === true,
    // INSTALLED, not queued: a reward waiting in the queue does not open the
    // next lab, which is what makes the labyrinth a multi-install walk.
    installedAugmentations: () => new Set(world.player.augmentations.keys()),
    allowRedPill: () => currentNodeMults.DarknetLabyrinthRewardsTheRedPill !== 0,
    world,
    player: world.player,
    homeFiles: () => host.files.get("home")!,
    darknetMoneyMultiplier: () => currentNodeMults.DarknetMoneyMultiplier ?? 1,
    // A THIRD stream. Log-noise draws vary in number with how long a script
    // waited before bleeding, so taking them from the gameplay stream would let
    // log volume perturb stock prices across an A/B — the same hazard the
    // fixed-width mutation draw already guards against.
    logNoise: mulberry32(DARKNET_NETWORK_SEED ^ 1),
    // A deleted darknet host takes its files with it. Without this the file map
    // keeps them, and an agent that scps itself onto a host would leave its
    // payload "present" on a server that no longer exists.
    forgetFiles: (hostname: string) => {
      host.files.delete(hostname);
      // The content map is keyed with a NUL separator, not a colon; the wrong
      // one would match nothing and leak every file on the deleted host.
      const prefix = `${hostname}\u0000`;
      for (const key of [...host.contents.keys()]) {
        if (key.startsWith(prefix)) host.contents.delete(key);
      }
    },
  });
  const darknet = dnet;
  host.dnet = darknet;
  // The vendored price engine calls these on every tick and every cycle. Wiring
  // them to the darknet here is what makes `promoteStock` move the real market
  // instead of a parallel estimate of it.
  setDarknetContext({
    volatilityMult: (symbol) => darknet.stockVolatilityMult(symbol),
    scaleIncreases: (scalar) => darknet.scaleStockPromotions(scalar),
  });
  if (dnet.hasAccess()) dnet.populate();

  if (save?.servers.some((server) => server.ramUsed > 0)) {
    noteUnmodeled(
      "initial-state",
      "running scripts",
      "saved RAM occupancy is preserved, but those processes and their future effects are not advanced",
    );
  }
  if (save?.servers.some((server) => server.contractFiles.length > 0)) {
    noteUnmodeled(
      "initial-state",
      "coding contracts",
      "saved filenames are discoverable, but contract data, tries, and rewards are not modelled",
    );
  }

  // Imported AFTER the flags are on globalThis, and dynamically so module
  // evaluation cannot outrun them.
  const [
    { main: startMain },
    { resetAllFeatures },
    { initState },
    dodgeStub,
    worker,
    dnetOverseer,
    dnetAgent,
  ] = await Promise.all([
    import("../game/start.ts"),
    import("../game/lib/features/index.ts"),
    import("../game/lib/state.ts"),
    import("../game/lib/dodge-stub.ts"),
    import("../game/worker/worker.ts"),
    import("../game/dnet/overseer.ts"),
    import("../game/dnet/agent.ts"),
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
    host.processes.resetPidCounter();
    share.reset();
    // The install destroys the cycle state immediately. Preserve the real
    // controller's final, already-held decision beside the simulated prestige
    // so cadence tuning can explain each batch instead of inferring it from
    // the terminal state of the following cycle. This is observation only:
    // no getter or simulator value is fed back into game/ strategy.
    const topics = gameGlobal.state?.topics;
    const progressionPlan = topics?.progression?.plan;
    const factionPlan = topics?.factions?.plan;
    const regenerated = vanillaPrestigeRng
      ? generateVanillaNetworkFromRng(vanillaPrestigeRng, world.servers.get("home")?.ip)
      : undefined;
    // Stanek and Go clear their install-reset state before applyEntropy
    // rebuilds and reapplies both multiplier systems in that upstream order.
    stanek?.prestigeAugmentation();
    go?.prestigeAugmentation();
    world.prestigeAugmentation(newlyInstalled, {
      money: world.player.money,
      progression: progressionPlan
        ? {
            phase: progressionPlan.phase,
            installWanted: progressionPlan.installWanted,
            routeInstallRequired: progressionPlan.routeInstallRequired === true,
            favorCrossings: progressionPlan.favorCrossings,
            decision: progressionPlan.installDecision,
          }
        : undefined,
      factions: factionPlan
        ? {
            objective: factionPlan.objective?.intent,
            runnerUp: factionPlan.objective?.runnerUp,
            action: factionPlan.action,
            recommendInstall: factionPlan.recommendInstall,
            drainCeiling: factionPlan.drainCeiling,
          }
        : undefined,
    }, regenerated?.network);
    hacknet.prestige();
    stock.prestige();
    // Before the market re-rolls, not after: propaganda and the portfolio are
    // cleared on the same boundary upstream (DarknetState.ts:97).
    dnet?.prestige(virtualTime.nowMs());
    grafting.prestige();
    programs.prestige();
    hasTor.value = permanentDarknetAccess();
    terminal.host = "home";

    const oldHomeFiles = host.files.get("home") ?? new Set<string>();
    const hadBitflume = oldHomeFiles.has("b1t_flum3.exe");
    const homeFiles = new Set(
      [...oldHomeFiles].filter((file) =>
        !/\.exe(?:-.*%-INC)?$/i.test(file)
        && !/\.(?:lit|msg)$/i.test(file),
      ),
    );
    homeFiles.add("NUKE.exe");
    homeFiles.add("hackers-starting-handbook.lit");
    if (hadBitflume) homeFiles.add("b1t_flum3.exe");
    if (bitnode === 5 || (world.player.sourceFiles["5"] ?? 0) > 0) homeFiles.add("Formulas.exe");
    if (permanentDarknetAccess()) homeFiles.add("DarkscapeNavigator.exe");
    for (const name of world.player.augmentations.keys()) {
      for (const program of AUGMENTATION_TABLE[name]?.programs ?? []) homeFiles.add(program);
    }
    host.files.clear();
    host.files.set("home", homeFiles);
    for (const key of [...host.contents.keys()]) {
      const separator = key.indexOf("\0");
      const hostname = key.slice(0, separator);
      const filename = key.slice(separator + 1);
      if (hostname !== "home" || !homeFiles.has(filename)) host.contents.delete(key);
    }

    host.network.clear();
    const resetTopology = regenerated
      ? new Map(Object.entries(regenerated.topology).map(([hostname, neighbours]) => [hostname, [...neighbours]]))
      : prestigeNetwork;
    for (const [hostname, neighbours] of resetTopology) {
      if (!world.servers.has(hostname)) continue;
      host.network.set(hostname, neighbours.filter((neighbour) => world.servers.has(neighbour)));
    }
    if (world.player.hasAugmentation("The Red Pill")) {
      const cave = host.network.get("The-Cave");
      const daemon = host.network.get("w0r1d_d43m0n");
      if (cave && daemon) {
        if (!cave.includes("w0r1d_d43m0n")) cave.push("w0r1d_d43m0n");
        if (!daemon.includes("The-Cave")) daemon.push("The-Cave");
      }
    }
    if (permanentDarknetAccess()) connectTor();
    host.reset = {
      ...host.reset,
      lastAugReset: virtualTime.nowMs(),
      ownedAugs: new Map(world.player.augmentations),
    };
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
  host.scripts.set(DNET_OVERSEER, dnetOverseer.main as ScriptMain);
  host.scripts.set(DNET_AGENT, dnetAgent.main as ScriptMain);
  host.scripts.set(START_SCRIPT, ((ns: NS) => startMain(ns, options.features)) as ScriptMain);

  const scenarioId = scenarioFingerprint({
    simulatorModel: SIMULATOR_MODEL_VERSION,
    vendorCommit: SIMULATOR_VENDOR_COMMIT,
    driver: "game",
    experiment: options.experiment ?? null,
    goal: goal.id,
    horizonMs,
    seed,
    scenario,
    goFidelity,
    controllerAutomationSourceFiles: CONTROLLER_AUTOMATION_SOURCE_FILES,
    bitnode,
    sourceFileLevel,
    features: options.features ?? {},
    // Preserve every explicit scenario input as well as the normalized world
    // below. Some modeled state lives outside SimWorld (faction reputation,
    // the stock market, Hacknet, current work), so hashing only its visible
    // player/server projection could incorrectly bless different save seeds
    // as the same A/B experiment.
    inputs: {
      goalSetup: goal.setup ?? null,
      save: save ?? null,
      overrides: {
        bitnode: options.bitnode,
        sourceFileLevel: options.sourceFileLevel,
        homeRam: options.homeRam,
        homeCores: options.homeCores,
        homeIp: options.homeIp,
        startingMoney: options.startingMoney,
        network: options.network,
        topology: options.topology,
        augmentationStats: options.augmentationStats,
        person: options.person,
        playerState: options.playerState,
        factions: options.factions,
        companies: options.companies,
        bladeburnerRank: options.bladeburnerRank,
        homeFiles: options.homeFiles,
        gates: options.gates,
      },
    },
    resetAgeMs: {
      augmentation: virtualTime.nowMs() - host.reset.lastAugReset,
      bitnode: virtualTime.nowMs() - host.reset.lastNodeReset,
    },
    person: { skills: world.person.skills, exp: world.person.exp, mults: world.person.mults },
    player: {
      money: world.player.money,
      karma: world.player.karma,
      factions: [...world.player.factions].sort(),
      augmentations: [...world.player.augmentations].sort(([a], [b]) => a.localeCompare(b)),
      sourceFiles: world.player.sourceFiles,
    },
    gates: world.gates,
    servers: [...world.servers.values()]
      .map((server) => ({
        hostname: server.hostname,
        organizationName: server.organizationName,
        hasAdminRights: server.hasAdminRights,
        purchasedByPlayer: server.purchasedByPlayer,
        backdoorInstalled: server.backdoorInstalled,
        maxRam: server.maxRam,
        ramUsed: server.ramUsed,
        cpuCores: server.cpuCores,
        moneyAvailable: server.moneyAvailable,
        moneyMax: server.moneyMax,
        hackDifficulty: server.hackDifficulty,
        minDifficulty: server.minDifficulty,
        requiredHackingSkill: server.requiredHackingSkill,
        serverGrowth: server.serverGrowth,
        numOpenPortsRequired: server.numOpenPortsRequired,
      }))
      .sort((a, b) => a.hostname.localeCompare(b.hostname)),
    topology: [...host.network]
      .map(([hostname, neighbours]) => [hostname, [...neighbours].sort()] as const)
      .sort(([a], [b]) => a.localeCompare(b)),
    files: [...host.files]
      .map(([hostname, files]) => [hostname, [...files].sort()] as const)
      .sort(([a], [b]) => a.localeCompare(b)),
  });

  world.emit({
    kind: "event",
    name: "sim.meta",
    data: {
      goal: goal.id,
      label: options.label,
      seed,
      driver: "game",
      ...(options.experiment !== undefined ? { experiment: options.experiment } : {}),
      scenario,
      scenarioFingerprint: scenarioId,
      coverage: SIM_FEATURE_COVERAGE,
      simulatorModel: SIMULATOR_MODEL_VERSION,
      vendorCommit: SIMULATOR_VENDOR_COMMIT,
      goFidelity,
      controllerAutomationSourceFiles: CONTROLLER_AUTOMATION_SOURCE_FILES,
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
    // Terminal harness teardown is not an in-world kill: no continuation is
    // observable after the virtual realm is dismantled. Do not reject pending
    // Netscript delays and let Bun mistake normal teardown for an unhandled
    // ScriptDeath after a valid result has already been emitted.
    host.processes.killAll(false);
    engine.stop();
    globalThis.WebSocket = originalWebSocket;
  }

  const reached = stoppedBecause === "goal";
  const gaps = unmodeledCounts();
  const validity: RunValidity = Object.keys(gaps).length > 0 || host.crashes.length > 0 ? "invalid-for-goal" : "valid";
  const liquidationValue = stock.liquidationValue();
  const terminalState = (realm["state"] as GameState | undefined)?.topics;
  const progressionPlan = terminalState?.progression?.plan;
  const preferredGo = terminalState?.go?.plan?.selection.preferred;
  const factionIntent = terminalState?.factions?.plan?.objective?.intent;
  const factionStanding = terminalState?.factions?.standings?.find(
    (standing) => standing.name === factionIntent?.faction,
  );
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
    scenario,
    stock: {
      cash: world.player.money,
      liquidationValue,
      wealth: world.player.money + liquidationValue,
      realizedProfit: stock.realizedProfit,
      commissionPaid: stock.commissionPaid,
      tradesMade: stock.tradesMade,
    },
    strategy: {
      ...(progressionPlan?.route ? { route: progressionPlan.route } : {}),
      ...(progressionPlan?.forecasts.node.state === "estimated"
        ? { nodeRemainingSec: progressionPlan.forecasts.node.remainingSec }
        : {}),
      ...(progressionPlan?.forecasts.install.state === "estimated"
        ? { installRemainingSec: progressionPlan.forecasts.install.remainingSec }
        : {}),
      ...(terminalState?.progression?.augCount !== undefined
        ? { augCount: terminalState.progression.augCount }
        : {}),
      queuedAugmentations: world.player.queuedAugmentations.size,
      installs: ctx.installs,
      goGames: go ? [...go.stats.values()].reduce((sum, entry) => sum + entry.wins + entry.losses, 0) : 0,
      ...(preferredGo?.utilityPerSec !== undefined
        ? { goPreferredUtilityPerSec: preferredGo.utilityPerSec, goPreferredOpponent: preferredGo.opponent }
        : {}),
      ...(progressionPlan?.installDecision?.effective
        ? { installVerdict: progressionPlan.installDecision.effective }
        : {}),
      ...(progressionPlan?.installDecision?.resetValueMult !== undefined
        ? { installResetValueMult: progressionPlan.installDecision.resetValueMult }
        : {}),
      ...(progressionPlan?.installDecision?.threshold !== undefined
        ? { installThreshold: progressionPlan.installDecision.threshold }
        : {}),
      ...(progressionPlan?.installDecision?.pushRate !== undefined
        ? { pushMarginalRate: progressionPlan.installDecision.pushRate }
        : {}),
      ...(factionIntent?.faction
        ? { factionObjective: factionIntent.faction }
        : {}),
      factionObjectiveAugs: terminalState?.factions?.plan?.objective?.augmentations ?? [],
      ...(factionIntent?.etaSec !== undefined ? { factionObjectiveEtaSec: factionIntent.etaSec } : {}),
      ...(factionIntent?.activationValue !== undefined
        ? { factionObjectiveActivationValue: factionIntent.activationValue }
        : {}),
      ...(factionIntent?.marginalActivationRate !== undefined
        ? { factionObjectiveMarginalActivationRate: factionIntent.marginalActivationRate }
        : {}),
      ...(factionIntent?.repTarget !== undefined ? { factionObjectiveRepTarget: factionIntent.repTarget } : {}),
      ...(factionIntent?.purpose !== undefined ? { factionObjectivePurpose: factionIntent.purpose } : {}),
      ...(terminalState?.factions?.plan?.action.type
        ? { factionAction: terminalState.factions.plan.action.type }
        : {}),
      ...(terminalState?.factions?.plan
        ? { factionRecommendInstall: terminalState.factions.plan.recommendInstall !== undefined }
        : {}),
      ...(terminalState?.factions?.plan?.nextBuy?.name
        ? {
            factionNextBuy: terminalState.factions.plan.nextBuy.name,
            factionNextBuyPrice: terminalState.factions.plan.nextBuy.price,
          }
        : {}),
      ...(terminalState?.factions?.plan?.lastResult
        ? { factionLastResult: `${terminalState.factions.plan.lastResult.action}:${terminalState.factions.plan.lastResult.ok}:${terminalState.factions.plan.lastResult.detail}` }
        : {}),
      factionJoined: terminalState?.factions?.joined ?? [],
      factionBankedAugmentations: terminalState?.factions?.plan?.bankedAugmentations ?? [],
      ...(terminalState?.factions?.plan?.drainCeiling !== undefined
        ? { factionDrainCeiling: terminalState.factions.plan.drainCeiling }
        : {}),
      ...(progressionPlan
        ? {
            progressionInstallWanted: progressionPlan.installWanted,
            progressionInstallReady: progressionPlan.installReady,
          }
        : {}),
      progressionInstallBlockers: progressionPlan?.installBlockers ?? [],
      coordinationNeeds: (terminalState?.progression?.needs ?? []).map((need) => ({
        by: need.by,
        kind: need.kind,
        ...(need.subject !== undefined ? { subject: need.subject } : {}),
        have: need.have,
        target: need.target,
      })),
      factionArbitration: [
        ...(terminalState?.arbitration?.grants ?? [])
          .filter((grant) => grant.by === "factions")
          .map((grant) => `grant:${grant.id}:${grant.amount}:p${grant.priority ?? "?"}`),
        ...(terminalState?.arbitration?.denied ?? [])
          .filter((denial) => denial.by === "factions")
          .map((denial) => `deny:${denial.id}:${denial.reason}:${denial.available}/${denial.wanted}:p${denial.priority ?? "?"}`),
      ],
      routeParts: progressionPlan?.routes?.find((route) => route.id === progressionPlan.route)?.parts.map(
        (part) => ({ what: part.what, sec: part.sec, measured: part.measured }),
      ) ?? [],
      ...(factionStanding?.rep !== undefined ? { factionObjectiveRep: factionStanding.rep } : {}),
      ...(factionStanding?.favor !== undefined ? { factionObjectiveFavor: factionStanding.favor } : {}),
      ...(terminalState?.factions?.plan?.context.route !== undefined
        ? { factionContextRoute: terminalState.factions.plan.context.route }
        : {}),
      ...(world.player.currentWork
        ? { actualCurrentWork: `${world.player.currentWork.kind}:${world.player.currentWork.subject}:${world.player.currentWork.workType ?? ""}` }
        : {}),
      ...(terminalState?.career?.currentWork
        ? { observedCurrentWork: `${terminalState.career.currentWork.type}:${terminalState.career.currentWork.detail ?? ""}:${terminalState.career.currentWork.workType ?? ""}` }
        : {}),
      actualSkills: { ...world.person.skills },
      actualMoney: world.player.money,
    },
  };
  world.emit({ kind: "event", name: "sim.result", data: { goal: goal.id, ...result } });
  clearRealm();
  return result;
}

/** Install process-wide browser primitives around the entire construction and
 * execution path. Setup failures are just as important as normal teardown:
 * neither virtual Date/timers/random nor game realm slots may leak into the
 * next test or simulation. */
export async function runGame(options: GameRunOptions): Promise<GameRunResult> {
  clearRealm();
  resetUnmodeled();
  const scenario = scenarioClass(
    options.save !== undefined,
    isSeededVanillaNetwork(options.network, options.topology),
  );
  // Experimental gameplay variance is keyed by the declared run seed. The
  // fixed vanilla fixture has its own world-generation stream so successive
  // prestige worlds remain exact without collapsing seeds 1/2/3 into the
  // same stock/crime/Go/HGW random sequence.
  const random = mulberry32(options.seed);
  const vanillaPrestigeRng = scenario === "seeded-vanilla" ? mulberry32(VANILLA_NETWORK_SEED) : undefined;
  const clock = new Clock();
  const virtualTime = installVirtualTime(clock, { random });
  const aggregateRuntime = options.goFidelity === AGGREGATE_GO_MODEL
    ? new AggregateGoNeuralRuntime()
    : undefined;
  if (aggregateRuntime) setGoNeuralRuntimeForTest(aggregateRuntime);
  try {
    return await runGameInstalled(options, clock, virtualTime, random, vanillaPrestigeRng);
  } finally {
    if (aggregateRuntime) setGoNeuralRuntimeForTest();
    setUnmodeledReporter(undefined);
    virtualTime.restore();
    clearRealm();
  }
}

/** Exported for tests that want to drive the harness by hand. */
export { makeSimNs };
