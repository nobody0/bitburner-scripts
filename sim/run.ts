import { execSync } from "node:child_process";
import { ScriptDeath } from "./ns/api.ts";

import { mkdirSync } from "node:fs";
import { FEATURE_IDS, type FeatureId } from "../shared/features/ids.ts";
import type { FeatureSelection } from "./feature-selection.ts";
import { initialContext, reduceRecord } from "../shared/goals/evaluate.ts";
import type { Goal } from "../shared/goals/goal.ts";
import { parseGoals } from "../shared/goals/presets.ts";
import { initFarm, planFarm, reportFailed } from "../shared/strategy/farm-planner.ts";
import { defaultPlanner } from "../shared/strategy/planner.ts";
import type { CompletionEvent, Planner } from "../shared/world.ts";
import { DEFAULT_NETWORK } from "./network.ts";
import { SimWorld, type SimOptions } from "./world.ts";
import {
  AGGREGATE_GO_MODEL,
  resolveFeatureCoverage,
  SIMULATOR_MODEL_VERSION,
  SIMULATOR_VENDOR_COMMIT,
  type RunValidity,
  type ScenarioClass,
} from "./fidelity.ts";
import { scenarioFingerprint } from "./scenario.ts";
import { assertPromotableSession, SimArtifactSession } from "./artifacts.ts";
import { deriveRouteLegs } from "./route-legs.ts";
import { formatBytes, formatReport } from "./cost.ts";
import { realEpochMs } from "./clock.ts";
import {

  assertValidExperiment,
  type EntranceIdentity,
  type ExperimentIdentity,
} from "../shared/experiment.ts";

// A prestige kill sweep rejects every killed script's pending delay with
// ScriptDeath. Some of those rejections land on promise chains whose awaiting
// script is itself mid-teardown and never observes them; bun then reports an
// unhandled rejection and takes the whole seed process down with no result
// written (measured twice on bn1-full: seeds died silently at 15.2h and
// ~17h). A ScriptDeath landing nowhere is cancellation noise by construction;
// anything else is a real bug and still crashes loudly.
process.on("unhandledRejection", (reason) => {
  if (reason instanceof ScriptDeath) return;
  throw reason;
});

export interface RunOptions {
  goal: Goal;
  seed: number;
  horizonMs: number;
  planner?: Planner<unknown>;
  /** Use the HWGW farm engine (evaluator + dispatcher) instead of `planner`. */
  farm?: boolean;
  world?: Partial<SimOptions>;
  label?: string;
  experiment?: ExperimentIdentity;
  onRecord?: (line: string) => void;
}

export interface RunResult {
  seed: number;
  reached: boolean;
  timeToGoalMs: number;
  records: number;
  stoppedBecause: "goal" | "empty" | "horizon";
  validity: RunValidity;
  scenario: ScenarioClass;
}

/** Drive one simulated run: planner replans whenever an action settles; the
 * goal is evaluated by the shared goal reducer, while the UI independently
 * projects the same records for display. Virtual time to goal is the metric. */
/** Parse `a,b,c` into feature ids, rejecting unknown names rather than
 * silently ignoring them — a typo'd `--only hackign` that quietly ran every
 * feature would invalidate the measurement without saying so. */
function parseFeatureList(value: string): FeatureId[] {
  const names = value
    .split(",")
    .map((name) => name.trim())
    .filter((name) => name.length > 0);
  const unknown = names.filter((name) => !FEATURE_IDS.includes(name as FeatureId));
  if (unknown.length > 0) {
    throw new Error(`unknown feature(s): ${unknown.join(", ")} (have: ${FEATURE_IDS.join(", ")})`);
  }
  return names as FeatureId[];
}

/** Combine a profile's isolation with the command line. */
function resolveFeatures(
  fromProfile: FeatureSelection | undefined,
  onlyList: FeatureId[] | undefined,
  addList: FeatureId[] | undefined,
): FeatureSelection | undefined {
  if (onlyList) {
    // Replaces outright, profile included.
    return [...new Set([...onlyList, ...(addList ?? [])])];
  }
  if (!addList) return fromProfile;
  // Widen a specialized profile. Selection schedules a controller module; it
  // does not pretend that the save has the capability required to run it.
  if (!fromProfile) return undefined;
  return [...new Set([...fromProfile, ...addList])];
}

/** Registered saves are complete entrance state. Profile worlds are synthetic
 * fixtures and may only supply state when no checkpoint was selected. */
export function profileWorldForEntrance<T>(world: T | undefined, hasSave: boolean): T | undefined {
  return hasSave ? undefined : world;
}

export function runSim(options: RunOptions): RunResult {
  const { goal, seed, horizonMs } = options;
  const planner = (options.planner ?? defaultPlanner) as Planner<unknown>;
  const ctx = initialContext();
  const worldRecordListener = options.world?.onRecord;

  const world = new SimWorld({
    ...options.world,
    seed,
    network: options.world?.network ?? DEFAULT_NETWORK,
    homeRam: goal.setup?.homeRam ?? options.world?.homeRam ?? 8,
    startingMoney: goal.setup?.startingMoney ?? options.world?.startingMoney ?? 1_000,
    runId: `${options.label ?? "sim"}-seed${seed}`,
    onRecord: (record) => {
      reduceRecord(ctx, record);
      worldRecordListener?.(record);
      options.onRecord?.(JSON.stringify(record));
    },
  });

  world.emit({
    kind: "event",
    name: "sim.meta",
    data: {
      goal: goal.id,
      label: options.label,
      seed,
      driver: "planner",
      ...(options.experiment !== undefined ? { experiment: options.experiment } : {}),
      scenario: "synthetic-early-game",
      scenarioFingerprint: scenarioFingerprint({
        simulatorModel: SIMULATOR_MODEL_VERSION,
        vendorCommit: SIMULATOR_VENDOR_COMMIT,
        driver: "planner",
        experiment: options.experiment ?? null,
        goal: goal.id,
        goalSetup: goal.setup ?? null,
        horizonMs,
        seed,
        farm: options.farm ?? false,
        // Keep the caller's full declarative world input in the identity. The
        // normalized projection below is useful evidence, but intentionally
        // does not expose every SimOptions field (for example topology and
        // capability gates).
        worldInput: options.world ?? {},
        bitnode: world.bitnode,
        gates: world.gates,
        person: { skills: world.person.skills, exp: world.person.exp, mults: world.person.mults },
        player: { money: world.player.money },
        servers: [...world.servers.values()]
          .map((server) => ({
            hostname: server.hostname,
            maxRam: server.maxRam,
            moneyAvailable: server.moneyAvailable,
            moneyMax: server.moneyMax,
            hackDifficulty: server.hackDifficulty,
            minDifficulty: server.minDifficulty,
            requiredHackingSkill: server.requiredHackingSkill,
            serverGrowth: server.serverGrowth,
            numOpenPortsRequired: server.numOpenPortsRequired,
          }))
          .sort((a, b) => a.hostname.localeCompare(b.hostname)),
      }),
      ...resolveFeatureCoverage({ scenario: "synthetic-early-game" }),
      simulatorModel: SIMULATOR_MODEL_VERSION,
      vendorCommit: SIMULATOR_VENDOR_COMMIT,
    },
  });

  if (goal.done(ctx)) {
    const result: RunResult = {
      seed,
      reached: true,
      timeToGoalMs: 0,
      records: world.records.length,
      stoppedBecause: "goal",
      validity: "partial",
      scenario: "synthetic-early-game",
    };
    world.emit({ kind: "event", name: "sim.result", data: { goal: goal.id, ...result } });
    return result;
  }

  let done = false;
  let replan: (event?: CompletionEvent) => void;

  if (options.farm) {
    // HWGW engine: completions are coalesced into the next pass, and the
    // dispatcher is told about actions the world refused so reservations
    // never leak.
    let farmMemory = initFarm();
    let pending: CompletionEvent[] = [];
    replan = (event?: CompletionEvent): void => {
      if (done) return;
      if (event) pending.push(event);
      const completions = pending;
      pending = [];
      const result = planFarm(world.view(), farmMemory, completions, {
        goalRemaining: goal.remainingMoney?.(ctx) ?? Infinity,
        // No feature drivers or arbiter run here — the dispatcher is the only
        // owner of fleet growth in farm mode.
        buyInfrastructure: true,
      });
      farmMemory = result.memory;
      const failed: number[] = [];
      let executed = 0;
      for (const action of result.actions) {
        if (goal.allows && !goal.allows(action)) {
          world.emit({ kind: "event", name: "action.blocked", data: { action } });
          if ("opId" in action && action.opId !== undefined) failed.push(action.opId);
          continue;
        }
        if (world.execute(action)) executed++;
        else if ("opId" in action && action.opId !== undefined) failed.push(action.opId);
      }
      if (failed.length > 0) reportFailed(farmMemory, failed);
      if (world.inFlight() === 0) world.execute({ type: "sleep", ms: executed > 0 ? 200 : 2_000 });
    };
  } else {
    let memory = planner.init(world.view());
    replan = (): void => {
      if (done) return;
      const result = planner.plan(world.view(), memory);
      memory = result.memory;
      let executed = 0;
      for (const action of result.actions) {
        if (goal.allows && !goal.allows(action)) {
          world.emit({ kind: "event", name: "action.blocked", data: { action } });
          continue;
        }
        if (world.execute(action)) executed++;
      }
      // Idle guard: nothing running means nothing will ever settle — nap and
      // replan (longer when the whole plan failed, e.g. waiting for money).
      if (world.inFlight() === 0) world.execute({ type: "sleep", ms: executed > 0 ? 1_000 : 10_000 });
    };
  }

  world.onSettled = replan;
  replan();

  const stoppedBecause = world.clock.run(() => goal.done(ctx), horizonMs);
  done = true;
  const reached = stoppedBecause === "goal";
  const result: RunResult = {
    seed,
    reached,
    timeToGoalMs: reached ? world.clock.now() : Infinity,
    records: world.records.length,
    stoppedBecause,
    validity: "partial",
    scenario: "synthetic-early-game",
  };
  world.emit({ kind: "event", name: "sim.result", data: { goal: goal.id, ...result } });
  return result;
}

function parseDuration(raw: string): number {
  const match = /^(\d+(?:\.\d+)?)(ms|s|m|h|d)?$/.exec(raw);
  if (!match) throw new Error(`bad duration: ${raw}`);
  const scale = { ms: 1, s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 }[match[2] ?? "ms"]!;
  return Number(match[1]) * scale;
}

/** Distinct `ns.tprint` lines shown in a run's summary. */
const TOP_OUTPUT_LINES = 5;

/** Sizes the way `parseDuration` reads durations: a bare number is bytes, a
 * suffix scales it. Binary units, because RSS is reported in them. */
export function parseBytes(raw: string): number {
  const match = /^(\d+(?:\.\d+)?)(b|kb|mb|gb)?$/i.exec(raw);
  if (!match) throw new Error(`bad size: ${raw}`);
  const scale = { b: 1, kb: 1024, mb: 1024 ** 2, gb: 1024 ** 3 }[(match[2] ?? "b").toLowerCase()]!;
  return Number(match[1]) * scale;
}

function parseSeeds(raw: string): number[] {
  const range = /^(\d+)\.\.(\d+)$/.exec(raw);
  if (range) {
    const from = Number(range[1]);
    const to = Number(range[2]);
    return Array.from({ length: to - from + 1 }, (_, i) => from + i);
  }
  return raw.split(",").map(Number);
}

function quantile(sorted: number[], q: number): number {
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  return sorted[lo]! + (sorted[Math.ceil(pos)]! - sorted[lo]!) * (pos - lo);
}

export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms)) return "never";
  const s = ms / 1000;
  if (s < 90) return `${s.toFixed(1)}s`;
  if (s < 5400) return `${(s / 60).toFixed(1)}m`;
  return `${(s / 3600).toFixed(2)}h`;
}

/** Mint the checkpoint that starts the NEXT leg, from a leg run that actually
 * finished its own.
 *
 * The next entrance comes from the ROUTE, not from the completing run's own
 * forecast of where to go next: the harness grants SF4.3 to every controller
 * run, so a leg inside BN4 believes it has already earned the node and points
 * at BN1. The route says otherwise, and the route is what is being measured.
 * Only the intelligence is taken from the run — it is the one part of an
 * entrance the order cannot predict.
 *
 * Gated by `assertPromotableSession`, which is the repository's existing
 * statement of what may become route state: a reached goal at `valid`
 * fidelity, with an experiment identity and a fingerprint. */
async function mintNextLegCheckpoint(
  profile: { route?: { leg: string } },
  artifacts: SimArtifactSession,
  exitIntelligence: number,
): Promise<void> {
  try {
    assertPromotableSession(artifacts.manifest());
  } catch (error) {
    // Not promotable is the ordinary case — a horizon stop, or a fidelity
    // gap. Say why once, and mint nothing.
    console.log(`  no checkpoint minted: ${error instanceof Error ? error.message : String(error)}`);
    return;
  }

  const legs = deriveRouteLegs();
  const index = legs.findIndex((leg) => leg.leg === profile.route?.leg);
  const next = index >= 0 ? legs[index + 1] : undefined;
  if (!next) {
    console.log("  no checkpoint minted: this is the route's final leg");
    return;
  }

  // Intelligence survives a node transition only with owned SF5 (sim/world.ts
  // zeroes it otherwise), so carrying a measured exit into a leg that has not
  // earned SF5 yet would describe a state the game cannot reach.
  const keepsIntelligence = next.node === 5 || (next.entranceSourceFiles["5"] ?? 0) > 0;
  const entrance = keepsIntelligence
    ? { ...next, entranceIntelligence: exitIntelligence, intelligenceSource: "measured" as const }
    // Not a measurement and not an estimate: without SF5 the game zeroes
    // intelligence at the transition, so 0 is the only reachable entrance.
    : { ...next, entranceIntelligence: 0, intelligenceSource: "estimated" as const };
  const { mintLegSave } = await import("../tools/mint-leg-save.ts");
  try {
    const minted = mintLegSave(entrance, {
      note: keepsIntelligence
        ? `minted from a completed ${profile.route?.leg} run: entrance intelligence ` +
          `${exitIntelligence} measured at that leg's goal`
        : `minted from a completed ${profile.route?.leg} run: intelligence 0, because this leg ` +
          `does not own SF5 and the node transition zeroes it`,
    });
    // NOT pushed onto `artifacts.files`: that list becomes the session
    // manifest's `artifacts`, which sim/compare.ts resolves against the
    // manifest's own directory and parses as a record stream.
    console.log(
      `  minted next checkpoint: ${minted.entry.id} -> ${minted.file} ` +
      `(entrance intelligence ${entrance.entranceIntelligence})`,
    );
  } catch (error) {
    // A registered blob's bytes are embedded in route lineage, so this never
    // overwrites one on its own.
    console.log(`  checkpoint not registered: ${error instanceof Error ? error.message : String(error)}`);
    console.log(`  to replace it deliberately: bun run tools/mint-leg-save.ts ${next.leg} --force`);
  }
}

/** CLI.
 *
 * Two drivers. `--driver game` (the default) runs the REAL game/ controller
 * against the synthetic world; `--driver planner` runs shared/strategy's
 * planner directly, which is the older, narrower A/B loop and stays because it
 * isolates planner changes from driver changes.
 *
 * The game driver is one run per process — the vendored core's currentNodeMults
 * and game/'s globalThis rendezvous slots are both module state — so a
 * multi-seed sweep re-invokes this file once per seed. */
if (import.meta.main) {
  const args = process.argv.slice(2);
  const goalSpecs: string[] = [];
  let seeds: number[] | undefined;
  let horizonMs: number | undefined;
  let label: string | undefined;
  let outDir = "runs";
  // `undefined`, not 1: the profile's `bitnode` has to be able to win, and a
  // default of 1 makes `bitnode ?? profile?.bitnode` silently always 1 — which
  // gates every faction feature off while the run looks healthy.
  let bitnode: number | undefined;
  let homeRam: number | undefined;
  let startingMoney: number | undefined;
  let verbose = false;
  let compact = false;
  let perf = false;
  let farm = true;
  let driver: "game" | "planner" = "game";
  let profileId: string | undefined;
  let saveId: string | undefined;
  let freshEntrance = false;
  let routeId: string | undefined;
  let child = false;
  // Minting the next leg's checkpoint writes saves/ and rewrites the shared
  // saves/index.json, so exactly ONE process in a fan-out may do it. The
  // parent hands this flag to the first seed's child only.
  let mintNext = false;
  let wallBudgetMs: number | undefined;
  let memoryBudgetBytes: number | undefined;
  let cost = false;
  let costSampleEveryMs: number | undefined;
  let featureOnly: FeatureId[] | undefined;
  let featureAdd: FeatureId[] | undefined;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    const next = () => args[++i] ?? (() => { throw new Error(`${arg} needs a value`); })();
    if (arg === "--goal") goalSpecs.push(next());
    else if (arg === "--seed") seeds = [Number(next())];
    else if (arg === "--seeds") seeds = parseSeeds(next());
    else if (arg === "--horizon") horizonMs = parseDuration(next());
    else if (arg === "--label") label = next();
    else if (arg === "--out-dir") outDir = next();
    else if (arg === "--bitnode") bitnode = Number(next());
    else if (arg === "--homeRam") homeRam = Number(next());
    else if (arg === "--money") startingMoney = Number(next());
    else if (arg === "--verbose") verbose = true;
    else if (arg === "--compact") compact = true;
    else if (arg === "--perf") perf = true;
    // --horizon bounds virtual time; --wall-budget bounds the wait. Its reason
    // for existing is profiling: Bun writes a CPU profile on process exit, so a
    // run that stops cleanly after N real seconds is what makes a window of an
    // hours-long simulation profilable at all.
    else if (arg === "--wall-budget") wallBudgetMs = parseDuration(next());
    // --wall-budget bounds the wait; --memory-budget bounds the host. Per
    // PROCESS, and a multi-seed profile fans out to one child per seed below,
    // so what the machine must hold is seeds x budget.
    else if (arg === "--memory-budget") memoryBudgetBytes = parseBytes(next());
    else if (arg === "--cost") cost = true;
    // Sampling finer than the default matters on short budgets: the drift
    // number needs several intervals before its direction means anything.
    else if (arg === "--cost-every") costSampleEveryMs = parseDuration(next());
    else if (arg === "--farm") farm = true;
    else if (arg === "--baseline") farm = false;
    else if (arg === "--profile") profileId = next();
    // Feature switches on the command line, so a profile's isolation can be
    // narrowed or widened without editing sim/profiles.ts. `--only` replaces
    // the set outright; `--features` adds to whatever the profile enabled.
    else if (arg === "--only") featureOnly = parseFeatureList(next());
    else if (arg === "--features") featureAdd = parseFeatureList(next());
    else if (arg === "--save") saveId = next();
    else if (arg === "--fresh") freshEntrance = true;
    else if (arg === "--route") routeId = next();
    else if (arg === "--driver") {
      const value = next();
      if (value !== "game" && value !== "planner") throw new Error(`--driver wants game|planner, got ${value}`);
      driver = value;
    } else if (arg === "--child") child = true;
    else if (arg === "--mint-next") mintNext = true;
    else if (arg === "--list") {
      const { PROFILES } = await import("./profiles.ts");
      for (const entry of PROFILES) {
        console.log(`${entry.id.padEnd(20)} ${entry.experiment.padEnd(16)} ${entry.description}`);
      }
      process.exit(0);
    } else throw new Error(`unknown argument: ${arg}`);
  }

  const profile = profileId ? (await import("./profiles.ts")).findProfile(profileId) : undefined;
  if (freshEntrance && saveId !== undefined) throw new Error("--fresh and --save are mutually exclusive");
  const specs = goalSpecs.length > 0 ? goalSpecs : [...(profile?.goals ?? [])];
  const goal = parseGoals(specs);
  const runSeeds = seeds ?? profile?.seeds ?? [1];
  const horizon = horizonMs ?? (profile ? parseDuration(profile.horizon) : parseDuration("24h"));
  const save = freshEntrance ? undefined : saveId ?? profile?.save;
  const runLabel = label ?? profile?.id;
  // `--only` replaces the profile's selection; `--features` widens it.
  const features = resolveFeatures(profile?.features, featureOnly, featureAdd);
  const runBitnode = bitnode ?? profile?.bitnode ?? 1;
  const runMoney = startingMoney ?? profile?.startingMoney;

  let gitRev = "unknown";
  try {
    gitRev = execSync("git rev-parse --short HEAD", { encoding: "utf8" }).trim();
  } catch {
    /* not fatal */
  }
  mkdirSync(outDir, { recursive: true });

  const experimentClass = profile?.experiment ?? "feature-scenario";
  const saveEntry = save ? (await import("../tools/save-io.ts")).findSave(save) : undefined;
  const entrance: EntranceIdentity = saveEntry
    ? {
        kind: "save",
        saveId: saveEntry.id,
        bitNode: saveEntry.bitNode,
        sha256: (await import("../tools/save-io.ts")).saveFileSha256(saveEntry),
      }
    : profile?.chainedLeg
      // A chained leg's derived grants are the profile's identity, not a
      // checkpoint; `--save` above still replaces the whole entrance.
      ? {
          kind: "chained",
          bitNode: runBitnode,
          sourceFiles: { ...profile.chainedLeg.entranceSourceFiles },
          intelligence: profile.chainedLeg.entranceIntelligence,
        }
      : experimentClass === "bitnode-route"
        // A fresh entrance is the run's own BitNode; assertValidExperiment
        // enforces that it equals the leg's declared node, so a stray --bitnode
        // cannot silently retime a route leg against the wrong world.
        ? { kind: "fresh", bitNode: runBitnode }
        : { kind: "synthetic", bitNode: runBitnode, ...(profileId ? { profile: profileId } : {}) };
  const experiment: ExperimentIdentity = {
    class: experimentClass,
    entrance,
    ...(profile?.route ? { route: { ...profile.route, route: routeId ?? profile.route.route } } : {}),
  };
  if (routeId !== undefined && profile?.route === undefined) {
    throw new Error("--route requires a bitnode-route profile");
  }
  assertValidExperiment(experiment);

  console.log(`goal: ${goal.describe()}`);
  console.log(
    `driver: ${driver}  experiment: ${experiment.class}  rev: ${gitRev}` +
      `${runLabel ? `  profile: ${runLabel}` : ""}` +
      `${entrance.kind === "save" ? `  save: ${entrance.saveId}@${entrance.sha256.slice(0, 12)}` : `  entrance: ${entrance.kind}`}` +
      `  horizon: ${formatDuration(horizon)}`,
  );

  // A multi-seed game run fans out to one child process per seed, because the
  // game driver cannot be run twice in one process: `currentNodeMults`, the
  // StockMarket singleton and the patched timers are all module state.
  //
  // That isolation is exactly what makes the seeds safe to run CONCURRENTLY —
  // no seed can observe another. Bounded by the core count rather than
  // unbounded, because a fully-loaded machine makes every seed slower and the
  // per-seed wall clock is itself a number people read. Launch all bounded
  // children before awaiting them so independent seeds run concurrently.
  if (driver === "game" && runSeeds.length > 1 && !child) {
    const base = args.filter((a, i) => a !== "--seeds" && args[i - 1] !== "--seeds" && a !== "--mint-next");
    const lanes = Math.max(1, Math.min(runSeeds.length, (navigator.hardwareConcurrency || 4) - 1));
    const pending = [...runSeeds];
    let validProcesses = 0;
    // A Ctrl-C on the batch must reach the seeds, not just the parent. Each
    // child owns the only copy of its artifact session, so a parent that
    // exited on the signal would leave three runs to be killed by the shell
    // with no manifest between them. Forward, stop launching, and let the
    // workers below await the exits they already have.
    const children = new Set<{ kill: (signal?: number | NodeJS.Signals) => void }>();
    let interrupted = false;
    for (const signal of ["SIGINT", "SIGTERM"] as const) {
      process.on(signal, () => {
        if (interrupted) process.exit(signal === "SIGINT" ? 130 : 143);
        interrupted = true;
        pending.length = 0;
        console.log(`\n${signal}: stopping ${children.size} seed process(es)`);
        for (const proc of children) proc.kill(signal);
      });
    }
    const worker = async (): Promise<void> => {
      for (;;) {
        const seed = pending.shift();
        if (seed === undefined) return;
        // Only the first seed may mint: the children run concurrently, and two
        // of them writing saves/index.json would leave a registered SHA-256
        // that does not match the blob actually on disk.
        const mintArg = seed === runSeeds[0] ? ["--mint-next"] : [];
        const proc = Bun.spawn(["bun", "run", "sim/run.ts", ...base, "--child", ...mintArg, "--seed", String(seed)], {
          stdout: "inherit",
          stderr: "inherit",
        });
        children.add(proc);
        try {
          if ((await proc.exited) === 0) validProcesses++;
        } finally {
          children.delete(proc);
        }
      }
    };
    await Promise.all(Array.from({ length: lanes }, () => worker()));
    console.log(`\n${validProcesses}/${runSeeds.length} seed processes completed without invalid results`);
    process.exit(interrupted ? 130 : validProcesses === runSeeds.length ? 0 : 2);
  }

  const times: number[] = [];
  const saveBitNode = saveEntry?.bitNode;
  // The session the signal handlers must close. Reassigned per seed; a handler
  // that fires between seeds finds the finished one, whose close() is a no-op.
  let openSession: SimArtifactSession | undefined;
  let stoppingAt: number | undefined;
  // A Ctrl-C in a terminal is delivered by the kernel to the whole foreground
  // process group, so a fanned-out seed receives it directly AND again from the
  // parent's forward a moment later. Treating that echo as "the operator says
  // the first one is not working" would `process.exit` straight through the
  // close this handler exists to perform. Only a signal that arrives after the
  // close has had its bounded chance escalates.
  const ECHO_WINDOW_MS = 1_500;
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, () => {
      if (stoppingAt !== undefined) {
        if (realEpochMs() - stoppingAt >= ECHO_WINDOW_MS) process.exit(signal === "SIGINT" ? 130 : 143);
        return;
      }
      stoppingAt = realEpochMs();
      const session = openSession;
      // Registering a handler suppresses default termination, so the exit has
      // to be explicit — and bounded, because a wedged sink must not turn a
      // Ctrl-C into a hang. The last checkpoint is on disk either way, so a
      // close that REJECTS must exit exactly like one that hangs: without the
      // catch the rejection escapes, `.then` never runs, and the Ctrl-C looks
      // like it did nothing at all.
      void Promise.race([session?.close() ?? Promise.resolve(), Bun.sleep(1_000)])
        .then(
          () => `session closed -> ${session?.manifestFile ?? "(none open)"}`,
          (error: unknown) => `session close FAILED: ${String(error)}`,
        )
        .then((outcome) => {
          console.log(`\n${signal}: ${outcome}`);
          process.exit(signal === "SIGINT" ? 130 : 143);
        });
    });
  }
  for (const seed of runSeeds) {
    const artifacts = new SimArtifactSession({
      outDir,
      label: runLabel ?? goal.id,
      seed,
      bitNode: saveBitNode ?? (driver === "game" ? runBitnode : bitnode),
      ...(save ? { seededFrom: save } : {}),
      experiment,
    });
    openSession = artifacts;
    artifacts.note({
      phase: "config",
      goal: goal.describe(),
      driver,
      rev: gitRev,
      ...(runLabel !== undefined ? { profile: runLabel } : {}),
      horizonMs: horizon,
      ...(wallBudgetMs !== undefined ? { wallBudgetMs } : {}),
      ...(memoryBudgetBytes !== undefined ? { memoryBudgetBytes } : {}),
    });

    let result: {
      reached: boolean;
      timeToGoalMs: number;
      records: number;
      stoppedBecause: string;
      validity: RunValidity;
      scenario: ScenarioClass;
    };
    // Everything from here to `close()` is inside the try: a throw out of a
    // driver used to lose the whole session, manifest included, because
    // `close()` was only ever reached on the success path.
    try {
      if (driver === "planner") {
        result = runSim({
          goal,
          seed,
          horizonMs: horizon,
          label: runLabel ?? gitRev,
          experiment,
          farm,
          world: { bitnode: runBitnode, homeRam, startingMoney: runMoney, verbose },
          onRecord: (line) => artifacts.write(line),
        });
      } else {
        const { runGame } = await import("./game-run.ts");
        let seedData;
        if (save) {
          const { findSave, readSnapshot } = await import("../tools/save-io.ts");
          const { saveToSeed } = await import("../shared/save/to-sim.ts");
          seedData = saveToSeed(readSnapshot(findSave(save).file));
        }
        const outcome = await runGame({
          goal,
          seed,
          horizonMs: horizon,
          label: runLabel ?? gitRev,
          verbose,
          // A registered checkpoint is the authoritative route entrance. A
          // profile's synthetic fixture must not overwrite its topology/player
          // state merely because the profile supplies strategy/goals.
          ...(profileWorldForEntrance(profile?.world, save !== undefined) ?? {}),
          ...(profileId !== undefined ? { profile: profileId } : {}),
          ...(save !== undefined ? { saveId: save } : {}),
          experiment,
          // A route leg's goal IS its node's destruction, so the operator hold
          // would make the goal unreachable by construction.
          ...(experimentClass === "bitnode-route" ? { allowBitNodeCompletion: true } : {}),
          goFidelity: AGGREGATE_GO_MODEL,
          ...(seedData ? { save: seedData } : { bitnode: runBitnode }),
          ...(features ? { features } : {}),
          ...(homeRam !== undefined ? { homeRam } : profile?.homeRam !== undefined ? { homeRam: profile.homeRam } : {}),
          ...(runMoney !== undefined ? { startingMoney: runMoney } : {}),
          ...(perf ? { telemetry: false } : {}),
          ...(wallBudgetMs !== undefined ? { wallBudgetMs } : {}),
          ...(memoryBudgetBytes !== undefined ? { memoryBudgetBytes } : {}),
          ...(cost ? { cost: true } : {}),
          // The heartbeat, and the only reason a long run is watchable. Every
          // sample appends one NDJSON line and checkpoints the manifest and the
          // open artifact's sidecar, so `tail -f` follows a live run and a run
          // killed from outside still leaves its evidence one interval stale.
          onProgress: (sample) => {
            artifacts.note({
              phase: "sample",
              wallMs: Math.round(sample.wallMs),
              virtualMs: Math.round(sample.virtualMs),
              throughput: Number(sample.throughput.toFixed(3)),
              rssBytes: sample.rssBytes,
              events: sample.events,
              records: sample.records,
              ...(sample.processes !== undefined ? { processes: sample.processes } : {}),
              ...(sample.servers !== undefined ? { servers: sample.servers } : {}),
            });
            artifacts.checkpoint();
          },
          ...(costSampleEveryMs !== undefined ? { costSampleEveryMs } : {}),
          ...(compact ? {
            // Preserve identity, validity, milestones and terminal result while
            // dropping enormous periodic state payloads. Goal evaluation still
            // consumes every record inside runGame before this artifact filter.
            recordFilter: (record) => record.kind === "event" && (
              record.name.startsWith("sim.") ||
              record.name === "endgame.route" ||
              record.name.startsWith("install")
            ),
          } : {}),
          onRecord: (line) => artifacts.write(line),
        });
        result = outcome;
        if (outcome.cost) console.log(formatReport(outcome.cost));
        const gaps = Object.entries(outcome.unmodeled);
        if (gaps.length > 0) {
          console.log(`  not modelled: ${gaps.map(([name, count]) => `${name} x${count}`).join(", ")}`);
        }
        for (const crash of outcome.crashes.slice(0, 3)) {
          console.log(`  CRASH ${crash.filename}: ${crash.error}`);
        }
        if (outcome.stoppedBecause === "memory") {
          console.log(
            `  stopped: memory budget ${formatBytes(memoryBudgetBytes ?? 0)} exceeded ` +
              `(rss ${formatBytes(outcome.stoppedAtRssBytes ?? 0)} after a forced collection)`,
          );
        }
        // What the run said about itself, deduplicated. Printed rather than
        // dropped: this channel carried the warning that named a controller
        // deadlock through an entire silent run. Counts come from the source
        // tally, so a flood reports the number of times it actually happened
        // rather than the number of copies the capture happened to retain.
        const spoken = outcome.outputCounts;
        for (const { line, count } of spoken.slice(0, TOP_OUTPUT_LINES)) {
          console.log(`  said${count > 1 ? ` x${count}` : ""}: ${line}`);
        }
        const counted = spoken.reduce((sum, entry) => sum + entry.count, 0);
        if (spoken.length > TOP_OUTPUT_LINES || counted < outcome.outputTotal) {
          const parts: string[] = [];
          if (spoken.length > TOP_OUTPUT_LINES) {
            parts.push(`${spoken.length - TOP_OUTPUT_LINES} more distinct output lines`);
          }
          if (counted < outcome.outputTotal) {
            parts.push(`${outcome.outputTotal - counted} lines past the distinct-line cap`);
          }
          console.log(`  ... ${parts.join(", and ")}`);
        }
        if (profile?.experiment === "bitnode-route") {
          // The chain ledger (sim/tests/baselines/route-legs.json) records a
          // leg's exit intelligence as the next leg's entrance; only a
          // goal-reached exit qualifies. Also in the sim.result record.
          console.log(`  exit intelligence: ${outcome.strategy.actualSkills.intelligence ?? 0}`);
          // A fanned-out child mints only when the parent elected it; a
          // standalone run always may.
          if (!child || mintNext) {
            await mintNextLegCheckpoint(profile, artifacts, outcome.strategy.actualSkills["intelligence"] ?? 0);
          }
        }
      }
    } finally {
      await artifacts.close();
    }
    times.push(result.timeToGoalMs);
    console.log(
      `seed ${seed}: [${result.validity}] ${result.reached ? `reached in ${formatDuration(result.timeToGoalMs)}` : `NOT reached (${result.stoppedBecause})`}  ` +
        `records=${result.records}  -> ${artifacts.files.join(", ")}  session=${artifacts.manifestFile}`,
    );
    if (result.validity === "invalid-for-goal") process.exitCode = 2;
  }

  if (runSeeds.length > 1) {
    const reached = times.filter(Number.isFinite).sort((a, b) => a - b);
    console.log(
      `\nreached ${reached.length}/${runSeeds.length}` +
        (reached.length > 0
          ? `  median=${formatDuration(quantile(reached, 0.5))}  p10=${formatDuration(quantile(reached, 0.1))}  p90=${formatDuration(quantile(reached, 0.9))}`
          : ""),
    );
  }
}
