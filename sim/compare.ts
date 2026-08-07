import type { EventRecord, LogRecord } from "../shared/telemetry/schema.ts";
import { formatDuration } from "./run.ts";

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
}

async function readRun(file: string): Promise<RunInfo> {
  const text = await Bun.file(file).text();
  let meta: { goal?: string; label?: string; seed?: number } = {};
  let result: { goal?: string; reached?: boolean; timeToGoalMs?: number } | undefined;
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
  };
}

const files = process.argv.slice(2);
if (files.length < 2) {
  console.error("usage: bun run sim:compare <baseline.jsonl> <candidate.jsonl> [more...]");
  process.exit(1);
}

const runs = await Promise.all(files.map(readRun));
const goals = new Set(runs.map((r) => r.goal));
if (goals.size > 1) console.warn(`warning: comparing different goals: ${[...goals].join(" vs ")}`);

const baseline = runs[0]!;
console.log(`goal: ${baseline.goal}\n`);
for (const run of runs) {
  const time = run.reached ? formatDuration(run.timeToGoalMs) : "not reached";
  let delta = "";
  if (run !== baseline && run.reached && baseline.reached) {
    const diff = run.timeToGoalMs - baseline.timeToGoalMs;
    const pct = (diff / baseline.timeToGoalMs) * 100;
    delta = diff === 0 ? "  (=)" : `  (${diff > 0 ? "+" : ""}${formatDuration(Math.abs(diff))}, ${pct > 0 ? "+" : ""}${pct.toFixed(1)}% ${diff > 0 ? "slower" : "faster"})`;
  }
  const tag = [run.label, run.seed !== undefined ? `seed${run.seed}` : undefined].filter(Boolean).join(" ");
  console.log(`${run === baseline ? "base " : "cand "} ${time}${delta}  [${tag}] ${run.file}`);
}
