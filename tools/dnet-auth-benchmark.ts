import {
  DNET_AUTH_CASES,
  runDnetAuthentication,
} from "../sim/dnet-auth-benchmark.ts";
import { percentile, valueAfter } from "../sim/dnet-bench.ts";

const seeds = Number(valueAfter("--seeds") ?? 25);
const repeats = Number(valueAfter("--repeats") ?? 7);
const only = (valueAfter("--only") ?? "").toLowerCase();
if (!Number.isInteger(seeds) || seeds <= 0) throw new Error(`--seeds must be a positive integer, got ${seeds}`);
if (!Number.isInteger(repeats) || repeats <= 0) throw new Error(`--repeats must be a positive integer, got ${repeats}`);

const selected = DNET_AUTH_CASES.filter(({ model }) => !only || model.toLowerCase().includes(only));
if (selected.length === 0) throw new Error(`--only ${JSON.stringify(only)} matched no password model`);
interface Row {
  model: string;
  hosts: number;
  attempts: number[];
  cpuMsPerAttempt: number[];
}

// One unmeasured pass both warms Bun and refuses to benchmark a broken solver.
for (const entry of selected) {
  for (const difficulty of entry.difficulties) {
    for (let seed = 0; seed < seeds; seed++) {
      assertOpened(entry.model, difficulty, seed, false);
    }
  }
}

const rows: Row[] = [];
for (const entry of selected) {
  const attempts: number[] = [];
  const cpuMsPerAttempt: number[] = [];
  for (let repeat = 0; repeat < repeats; repeat++) {
    let roundNs = 0n;
    let roundCalls = 0;
    for (const difficulty of entry.difficulties) {
      for (let seed = 0; seed < seeds; seed++) {
        const outcome = assertOpened(entry.model, difficulty, seed, true);
        if (repeat === 0) attempts.push(outcome.calls);
        roundNs += outcome.decisionNs;
        roundCalls += outcome.calls;
      }
    }
    cpuMsPerAttempt.push(Number(roundNs) / 1e6 / roundCalls);
  }
  rows.push({
    model: entry.model,
    hosts: entry.difficulties.length * seeds,
    attempts,
    cpuMsPerAttempt,
  });
}

const attemptRows = rows.map((row) => ({
  model: row.model,
  hosts: row.hosts,
  mean: mean(row.attempts).toFixed(2),
  p95: percentile(row.attempts, 0.95),
  max: Math.max(...row.attempts),
})).sort((a, b) => b.max - a.max || b.p95 - a.p95 || Number(b.mean) - Number(a.mean));

const cpuRows = rows.map((row) => ({
  model: row.model,
  hosts: row.hosts,
  "median ms/attempt": median(row.cpuMsPerAttempt).toFixed(6),
  "best ms/attempt": Math.min(...row.cpuMsPerAttempt).toFixed(6),
})).sort((a, b) => Number(b["median ms/attempt"]) - Number(a["median ms/attempt"]));

console.info(`Dnet authentication benchmark: ${seeds} seeds per difficulty, ${repeats} measured CPU rounds.`);
console.info("Attempts (authenticate calls; lower is better)");
console.table(attemptRows);
console.info("Pure decision CPU (generation, feedback, and I/O excluded; lower is better)");
console.table(cpuRows);

function assertOpened(
  model: (typeof DNET_AUTH_CASES)[number]["model"],
  difficulty: number,
  seed: number,
  measured: boolean,
) {
  const outcome = runDnetAuthentication(model, difficulty, seed, {
    ...(measured ? { nowNs: process.hrtime.bigint } : {}),
  });
  if (!outcome.opened) throw new Error(`${model} @${difficulty} seed ${seed}: ${outcome.detail}`);
  if (outcome.budget !== undefined && outcome.calls > outcome.budget) {
    throw new Error(`${model} @${difficulty} seed ${seed}: ${outcome.calls} calls exceeded budget ${outcome.budget}`);
  }
  return outcome;
}

function mean(values: readonly number[]): number {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
}
