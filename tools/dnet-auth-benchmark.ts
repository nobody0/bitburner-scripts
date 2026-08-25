import {
  benchmarkHintEvidence,
  DNET_AUTH_CASES,
  mintDnetAuthHost,
  runDnetAuthentication,
  type DnetHintProfile,
} from "../sim/dnet-auth-benchmark.ts";
import { percentile, valueAfter } from "../sim/dnet-bench.ts";

const seeds = Number(valueAfter("--seeds") ?? 25);
const repeats = Number(valueAfter("--repeats") ?? 7);
const only = (valueAfter("--only") ?? "").toLowerCase();
if (!Number.isInteger(seeds) || seeds <= 0) throw new Error(`--seeds must be a positive integer, got ${seeds}`);
if (!Number.isInteger(repeats) || repeats <= 0) throw new Error(`--repeats must be a positive integer, got ${repeats}`);

const selected = DNET_AUTH_CASES.filter(({ model }) => !only || model.toLowerCase().includes(only));
if (selected.length === 0) throw new Error(`--only ${JSON.stringify(only)} matched no password model`);
const HINT_PROFILES: readonly DnetHintProfile[] = ["contains", "placement", "combined"];

interface Row {
  model: string;
  hosts: number;
  attempts: number[];
  cpuMsPerAttempt: number[];
  hinted: Record<DnetHintProfile, number[]>;
}

// One unmeasured pass both warms Bun and refuses to benchmark a broken solver.
for (const entry of selected) {
  for (const difficulty of entry.difficulties) {
    for (let seed = 0; seed < seeds; seed++) {
      assertOpened(entry.model, difficulty, seed, false);
      for (const profile of HINT_PROFILES) assertOpened(entry.model, difficulty, seed, false, profile);
    }
  }
}

const rows: Row[] = [];
for (const entry of selected) {
  const attempts: number[] = [];
  const cpuMsPerAttempt: number[] = [];
  const hinted: Record<DnetHintProfile, number[]> = { contains: [], placement: [], combined: [] };
  for (let repeat = 0; repeat < repeats; repeat++) {
    let roundNs = 0n;
    let roundCalls = 0;
    for (const difficulty of entry.difficulties) {
      for (let seed = 0; seed < seeds; seed++) {
        const outcome = assertOpened(entry.model, difficulty, seed, true);
        if (repeat === 0) {
          attempts.push(outcome.calls);
          for (const profile of HINT_PROFILES) {
            hinted[profile].push(assertOpened(entry.model, difficulty, seed, false, profile).calls);
          }
        }
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
    hinted,
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

console.log(`Dnet authentication benchmark: ${seeds} seeds per difficulty, ${repeats} measured CPU rounds.`);
console.log("Attempts (authenticate calls; lower is better)");
console.table(attemptRows);
console.log("Pure decision CPU (generation, feedback, and I/O excluded; lower is better)");
console.table(cpuRows);
console.log("Harvested hint benefit (mean authenticate calls; lower is better)");
console.table(rows.map((row) => {
  const baseline = mean(row.attempts);
  const combined = mean(row.hinted.combined);
  return {
    model: row.model,
    baseline: baseline.toFixed(2),
    contains: mean(row.hinted.contains).toFixed(2),
    placement: mean(row.hinted.placement).toFixed(2),
    combined: combined.toFixed(2),
    saved: (baseline - combined).toFixed(2),
    "hosts improved": row.attempts.filter((calls, index) => row.hinted.combined[index]! < calls).length,
  };
}).sort((a, b) => Number(b.saved) - Number(a.saved)));

function assertOpened(
  model: (typeof DNET_AUTH_CASES)[number]["model"],
  difficulty: number,
  seed: number,
  measured: boolean,
  hintProfile?: DnetHintProfile,
) {
  const host = hintProfile === undefined ? undefined : mintDnetAuthHost(model, difficulty, seed);
  const outcome = runDnetAuthentication(model, difficulty, seed, {
    ...(measured ? { nowNs: process.hrtime.bigint } : {}),
    ...(host && hintProfile ? { evidence: benchmarkHintEvidence(host.password, hintProfile) } : {}),
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
