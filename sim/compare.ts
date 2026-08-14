import type { EventRecord, LogRecord } from "../shared/telemetry/schema.ts";
import { formatDuration } from "./run.ts";
import type { RunValidity, ScenarioClass } from "./fidelity.ts";
import { assertComparable } from "./compare-policy.ts";
import path from "node:path";
import type { SimSessionManifest } from "./artifacts.ts";
import type { ExperimentIdentity } from "../shared/experiment.ts";

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
  scenarioFingerprint?: string;
  experimentClass?: string;
  validity: RunValidity;
  gaps: string[];
}

async function readRun(file: string): Promise<RunInfo> {
  let inputs = [file];
  if (file.endsWith(".session.json")) {
    const manifest = JSON.parse(await Bun.file(file).text()) as SimSessionManifest;
    inputs = manifest.artifacts.map((artifact) => path.join(path.dirname(file), artifact));
  }
  let meta: {
    goal?: string;
    label?: string;
    seed?: number;
    driver?: string;
    scenario?: string;
    scenarioFingerprint?: string;
    experiment?: ExperimentIdentity;
  } = {};
  let result: {
    goal?: string;
    reached?: boolean;
    timeToGoalMs?: number;
    validity?: RunValidity;
    scenario?: ScenarioClass;
    unmodeled?: Record<string, number>;
  } | undefined;
  for (const input of inputs) {
    const text = await Bun.file(input).text();
    for (const line of text.split("\n")) {
      if (!line) continue;
      const record = JSON.parse(line) as LogRecord;
      if (record.kind !== "event") continue;
      const event = record as EventRecord;
      if (event.name === "sim.meta") meta = event.data as typeof meta;
      if (event.name === "sim.result") result = event.data as typeof result;
    }
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
    scenarioFingerprint: meta.scenarioFingerprint,
    experimentClass: meta.experiment?.class,
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
assertComparable(runs, allowInvalid);

const baseline = runs[0]!;
console.log(
  `goal: ${baseline.goal}  driver: ${baseline.driver}  experiment: ${baseline.experimentClass ?? "legacy-unknown"}  ` +
  `scenario: ${baseline.scenario}\n`,
);
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
