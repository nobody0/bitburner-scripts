import { execSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { FEATURE_IDS, type FeatureId } from "../shared/features/ids.ts";
import { only, type FeatureOverrides } from "../shared/features/profile.ts";
import { initialContext, reduceRecord } from "../shared/goals/evaluate.ts";
import type { Goal } from "../shared/goals/goal.ts";
import { parseGoals } from "../shared/goals/presets.ts";
import { initFarm, planFarm, reportFailed } from "../shared/strategy/farm-planner.ts";
import { defaultPlanner } from "../shared/strategy/planner.ts";
import type { CompletionEvent, Planner } from "../shared/world.ts";
import { DEFAULT_NETWORK } from "./network.ts";
import { SimWorld, type SimOptions } from "./world.ts";
import { SIM_FEATURE_COVERAGE, type RunValidity, type ScenarioClass } from "./fidelity.ts";
import { scenarioFingerprint } from "./scenario.ts";

export interface RunOptions {
  goal: Goal;
  seed: number;
  horizonMs: number;
  planner?: Planner<unknown>;
  /** Use the HWGW farm engine (evaluator + dispatcher) instead of `planner`. */
  farm?: boolean;
  world?: Partial<SimOptions>;
  label?: string;
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
  fromProfile: FeatureOverrides | undefined,
  onlyList: FeatureId[] | undefined,
  addList: FeatureId[] | undefined,
): FeatureOverrides | undefined {
  if (onlyList) {
    // Replaces outright, profile included.
    const base = only(...onlyList);
    for (const id of addList ?? []) delete base[id];
    return base;
  }
  if (!addList) return fromProfile;
  // Widen: clear the "off" the profile set for each named feature. Not forced
  // "on" — a feature the save cannot really play must stay locked rather than
  // being pretended into existence.
  const merged: FeatureOverrides = { ...(fromProfile ?? {}) };
  for (const id of addList) delete merged[id];
  return Object.keys(merged).length > 0 ? merged : undefined;
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
      scenario: "synthetic-early-game",
      scenarioFingerprint: scenarioFingerprint({
        driver: "planner",
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
      coverage: SIM_FEATURE_COVERAGE,
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
    // never leak (the earlier rewrite's dispatcher bug; see README).
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
  let farm = true;
  let driver: "game" | "planner" = "game";
  let profileId: string | undefined;
  let saveId: string | undefined;
  let child = false;
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
    else if (arg === "--farm") farm = true;
    else if (arg === "--baseline") farm = false;
    else if (arg === "--profile") profileId = next();
    // Feature switches on the command line, so a profile's isolation can be
    // narrowed or widened without editing sim/profiles.ts. `--only` replaces
    // the set outright; `--features` adds to whatever the profile enabled.
    else if (arg === "--only") featureOnly = parseFeatureList(next());
    else if (arg === "--features") featureAdd = parseFeatureList(next());
    else if (arg === "--save") saveId = next();
    else if (arg === "--driver") {
      const value = next();
      if (value !== "game" && value !== "planner") throw new Error(`--driver wants game|planner, got ${value}`);
      driver = value;
    } else if (arg === "--child") child = true;
    else if (arg === "--list") {
      const { PROFILES } = await import("./profiles.ts");
      for (const entry of PROFILES) console.log(`${entry.id.padEnd(16)} ${entry.description}`);
      process.exit(0);
    } else throw new Error(`unknown argument: ${arg}`);
  }

  const profile = profileId ? (await import("./profiles.ts")).findProfile(profileId) : undefined;
  const specs = goalSpecs.length > 0 ? goalSpecs : [...(profile?.goals ?? [])];
  const goal = parseGoals(specs);
  const runSeeds = seeds ?? profile?.seeds ?? [1];
  const horizon = horizonMs ?? (profile ? parseDuration(profile.horizon) : parseDuration("24h"));
  const save = saveId ?? profile?.save;
  const runLabel = label ?? profile?.id;
  // `--only` replaces the profile's isolation; `--features` widens it by
  // clearing the "off" for the named features.
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

  console.log(`goal: ${goal.describe()}`);
  console.log(
    `driver: ${driver}  rev: ${gitRev}${runLabel ? `  profile: ${runLabel}` : ""}` +
      `${save ? `  save: ${save}` : ""}  horizon: ${formatDuration(horizon)}`,
  );

  // A multi-seed game run fans out to one child process per seed, because the
  // game driver cannot be run twice in one process.
  if (driver === "game" && runSeeds.length > 1 && !child) {
    const base = args.filter((a, i) => a !== "--seeds" && args[i - 1] !== "--seeds");
    let validProcesses = 0;
    for (const seed of runSeeds) {
      const proc = Bun.spawn(["bun", "run", "sim/run.ts", ...base, "--child", "--seed", String(seed)], {
        stdout: "inherit",
        stderr: "inherit",
      });
      if ((await proc.exited) === 0) validProcesses++;
    }
    console.log(`\n${validProcesses}/${runSeeds.length} seed processes completed without invalid results`);
    process.exit(validProcesses === runSeeds.length ? 0 : 2);
  }

  const times: number[] = [];
  for (const seed of runSeeds) {
    const stamp = Date.now();
    const name = [stamp, "sim", runLabel ?? goal.id.replaceAll(/[^\w.-]/g, "_"), save, `seed${seed}`]
      .filter(Boolean)
      .join("-");
    const file = path.join(outDir, `${name}.jsonl`);
    const sink = Bun.file(file).writer();

    let result: {
      reached: boolean;
      timeToGoalMs: number;
      records: number;
      stoppedBecause: string;
      validity: RunValidity;
      scenario: ScenarioClass;
    };
    if (driver === "planner") {
      result = runSim({
        goal,
        seed,
        horizonMs: horizon,
        label: runLabel ?? gitRev,
        farm,
        world: { bitnode, homeRam, startingMoney, verbose },
        onRecord: (line) => void sink.write(line + "\n"),
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
        ...(profile?.world ?? {}),
        ...(profileId !== undefined ? { profile: profileId } : {}),
        ...(save !== undefined ? { saveId: save } : {}),
        ...(seedData ? { save: seedData } : { bitnode: runBitnode }),
        ...(features ? { features } : {}),
        ...(homeRam !== undefined ? { homeRam } : profile?.homeRam !== undefined ? { homeRam: profile.homeRam } : {}),
        ...(runMoney !== undefined ? { startingMoney: runMoney } : {}),
        onRecord: (line) => void sink.write(line + "\n"),
      });
      result = outcome;
      const gaps = Object.entries(outcome.unmodeled);
      if (gaps.length > 0) {
        console.log(`  not modelled: ${gaps.map(([name, count]) => `${name} x${count}`).join(", ")}`);
      }
      for (const crash of outcome.crashes.slice(0, 3)) {
        console.log(`  CRASH ${crash.filename}: ${crash.error}`);
      }
    }

    void sink.end();
    times.push(result.timeToGoalMs);
    console.log(
      `seed ${seed}: [${result.validity}] ${result.reached ? `reached in ${formatDuration(result.timeToGoalMs)}` : `NOT reached (${result.stoppedBecause})`}  ` +
        `records=${result.records}  -> ${file}`,
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
