import type { EventRecord, LogRecord } from "../shared/telemetry/schema.ts";
import { formatDuration } from "./run.ts";
import type { RunValidity, ScenarioClass } from "./fidelity.ts";

/** A/B compare stored sim runs:
 *   bun run sim:compare runs/a.jsonl runs/b.jsonl [more...]
 * Reads the sim.meta / sim.result events each run's JSONL carries; the first
 * file is the baseline. */

interface RunInfo {
  file: string;
  goal: string;
  label?: string;
  seed?: number;
  reached: boolean;
  timeToGoalMs: number;
  driver: string;
  scenario: ScenarioClass | string;
  validity: RunValidity;
  gaps: string[];
}

async function readRun(file: string): Promise<RunInfo> {
  const text = await Bun.file(file).text();
  let meta: { goal?: string; label?: string; seed?: number; driver?: string; scenario?: string } = {};
  let result: {
    goal?: string;
    reached?: boolean;
    timeToGoalMs?: number;
    validity?: RunValidity;
    scenario?: ScenarioClass;
    unmodeled?: Record<string, number>;
  } | undefined;
  for (const line of text.split("\n")) {
    if (!line) continue;
    const record = JSON.parse(line) as LogRecord;
    if (record.kind !== "event") continue;
    const event = record as EventRecord;
    if (event.name === "sim.meta") meta = event.data as typeof meta;
    if (event.name === "sim.result") result = event.data as typeof result;
  }
  if (!result) throw new Error(`${file}: no sim.result event (incomplete run?)`);
  return {
    file,
    goal: result.goal ?? meta.goal ?? "?",
    label: meta.label,
    seed: meta.seed,
    reached: result.reached ?? false,
    timeToGoalMs: result.timeToGoalMs ?? Infinity,
    driver: meta.driver ?? "legacy-unknown",
    scenario: result.scenario ?? meta.scenario ?? "legacy-unknown",
    validity: result.validity ?? "invalid-for-goal",
    gaps: Object.keys(result.unmodeled ?? {}).sort(),
  };
}

const allowInvalid = process.argv.includes("--allow-invalid");
const files = process.argv.slice(2).filter((arg) => arg !== "--allow-invalid");
if (files.length < 2) {
  console.error("usage: bun run sim:compare [--allow-invalid] <baseline.jsonl> <candidate.jsonl> [more...]");
  process.exit(1);
}

const runs = await Promise.all(files.map(readRun));
const goals = new Set(runs.map((r) => r.goal));
if (goals.size > 1) throw new Error(`refusing to compare different goals: ${[...goals].join(" vs ")}`);

const drivers = new Set(runs.map((r) => r.driver));
if (drivers.size > 1) throw new Error(`refusing to compare different drivers: ${[...drivers].join(" vs ")}`);
const scenarios = new Set(runs.map((r) => r.scenario));
if (scenarios.size > 1) throw new Error(`refusing to compare different scenario classes: ${[...scenarios].join(" vs ")}`);
const gapSets = new Set(runs.map((r) => r.gaps.join("\0")));
if (gapSets.size > 1) throw new Error("refusing to compare runs with different unmodeled gap sets");
const invalid = runs.filter((r) => r.validity === "invalid-for-goal");
if (invalid.length > 0 && !allowInvalid) {
  throw new Error("refusing invalid-for-goal run(s); inspect their gaps or pass --allow-invalid for diagnostics only");
}

const baseline = runs[0]!;
console.log(`goal: ${baseline.goal}  driver: ${baseline.driver}  scenario: ${baseline.scenario}\n`);
for (const run of runs) {
  const time = run.reached ? formatDuration(run.timeToGoalMs) : "not reached";
  let delta = "";
  if (run !== baseline && run.reached && baseline.reached) {
    const diff = run.timeToGoalMs - baseline.timeToGoalMs;
    const pct = (diff / baseline.timeToGoalMs) * 100;
    delta = diff === 0 ? "  (=)" : `  (${diff > 0 ? "+" : ""}${formatDuration(Math.abs(diff))}, ${pct > 0 ? "+" : ""}${pct.toFixed(1)}% ${diff > 0 ? "slower" : "faster"})`;
  }
  const tag = [run.label, run.seed !== undefined ? `seed${run.seed}` : undefined].filter(Boolean).join(" ");
  console.log(`${run === baseline ? "base " : "cand "} [${run.validity}] ${time}${delta}  [${tag}] ${run.file}`);
}
