import { execSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { initialContext, reduceRecord } from "../shared/goals/evaluate.ts";
import type { Goal } from "../shared/goals/goal.ts";
import { parseGoals } from "../shared/goals/presets.ts";
import { initFarm, planFarm, reportFailed } from "../shared/strategy/farm-planner.ts";
import { defaultPlanner } from "../shared/strategy/planner.ts";
import type { CompletionEvent, Planner } from "../shared/world.ts";
import { DEFAULT_NETWORK } from "./network.ts";
import { SimWorld, type SimOptions } from "./world.ts";

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
}

/** Drive one simulated run: planner replans whenever an action settles; the
 * goal is evaluated by the shared goal reducer, while the UI independently
 * projects the same records for display. Virtual time to goal is the metric. */
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

  world.emit({ kind: "event", name: "sim.meta", data: { goal: goal.id, label: options.label, seed } });

  if (goal.done(ctx)) {
    const result: RunResult = {
      seed,
      reached: true,
      timeToGoalMs: 0,
      records: world.records.length,
      stoppedBecause: "goal",
    };
    world.emit({ kind: "event", name: "sim.result", data: { goal: goal.id, ...result } });
    return result;
  }

  let done = false;
  let replan: (event?: CompletionEvent) => void;

  if (options.farm) {
    // HWGW engine: completions are coalesced into the next pass, and the
    // dispatcher is told about actions the world refused so reservations
    // never leak (the legacy dispatcher's bug).
    let farmMemory = initFarm();
    let pending: CompletionEvent[] = [];
    replan = (event?: CompletionEvent): void => {
      if (done) return;
      if (event) pending.push(event);
      const completions = pending;
      pending = [];
      const result = planFarm(world.view(), farmMemory, completions, {
        goalRemaining: goal.remainingMoney?.(ctx) ?? Infinity,
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
  let bitnode = 1;
  let homeRam: number | undefined;
  let startingMoney: number | undefined;
  let verbose = false;
  let farm = true;
  let driver: "game" | "planner" = "game";
  let profileId: string | undefined;
  let saveId: string | undefined;
  let child = false;

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
    let reached = 0;
    for (const seed of runSeeds) {
      const proc = Bun.spawn(["bun", "run", "sim/run.ts", ...base, "--child", "--seed", String(seed)], {
        stdout: "inherit",
        stderr: "inherit",
      });
      if ((await proc.exited) === 0) reached++;
    }
    console.log(`\n${reached}/${runSeeds.length} seed processes completed`);
    process.exit(0);
  }

  const times: number[] = [];
  for (const seed of runSeeds) {
    const stamp = Date.now();
    const name = [stamp, "sim", runLabel ?? goal.id.replaceAll(/[^\w.-]/g, "_"), save, `seed${seed}`]
      .filter(Boolean)
      .join("-");
    const file = path.join(outDir, `${name}.jsonl`);
    const sink = Bun.file(file).writer();

    let result: { reached: boolean; timeToGoalMs: number; records: number; stoppedBecause: string };
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
        ...(profileId !== undefined ? { profile: profileId } : {}),
        ...(save !== undefined ? { saveId: save } : {}),
        ...(seedData ? { save: seedData } : { bitnode }),
        ...(profile?.features ? { features: profile.features } : {}),
        ...(homeRam !== undefined ? { homeRam } : profile?.homeRam !== undefined ? { homeRam: profile.homeRam } : {}),
        ...(startingMoney !== undefined ? { startingMoney } : {}),
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
      `seed ${seed}: ${result.reached ? `reached in ${formatDuration(result.timeToGoalMs)}` : `NOT reached (${result.stoppedBecause})`}  ` +
        `records=${result.records}  -> ${file}`,
    );
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
