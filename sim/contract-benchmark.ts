/** Benchmark the coding-contract solvers against the official generators.
 *
 * Usage: bun run sim/contract-benchmark.ts [--cases N] [--seed N] [--only substring] */
import { CONTRACT_SOLVERS, solveContract } from "../game/lib/features/side.ts";
import { mulberry32 } from "./core/rng.ts";
import { CodingContractTypes } from "./vendor/bitburner/src/CodingContract/ContractTypes.ts";

const args = process.argv.slice(2);
function flag(name: string, fallback: string): string {
  const at = args.indexOf(`--${name}`);
  return at >= 0 ? (args[at + 1] ?? fallback) : fallback;
}
const cases = Number(flag("cases", "40"));
const seed = Number(flag("seed", String(0xc0de_0301)));
const only = flag("only", "");

interface Row { type: string; ms: number; per: number; ok: boolean }
const rows: Row[] = [];
const missing: string[] = [];

const originalRandom = Math.random;
for (const [type, definition] of Object.entries(CodingContractTypes)) {
  if (only && !type.toLowerCase().includes(only.toLowerCase())) continue;
  // Every official type has a solver -- contracts-parity.test.ts pins that -- so
  // a missing one is reported rather than quietly skipped.
  if (!(type in CONTRACT_SOLVERS)) {
    missing.push(type);
    continue;
  }
  // Generate up front with a fixed seed so every build sees identical work.
  Math.random = mulberry32(seed);
  const instances: unknown[] = [];
  const states: unknown[] = [];
  for (let i = 0; i < cases; i++) {
    const state = definition.generate();
    states.push(state);
    instances.push(definition.getData ? (definition.getData as (s: unknown) => unknown)(state) : state);
  }
  Math.random = originalRandom;

  let ok = true;
  // Warm the JIT, and check correctness while we are at it.
  for (let i = 0; i < instances.length; i++) {
    const answer = solveContract(type, instances[i]);
    if (!definition.validateAnswer(answer)
      || !(definition.solver as (s: unknown, a: unknown) => boolean)(states[i], answer)) ok = false;
  }
  const start = performance.now();
  for (const data of instances) solveContract(type, data);
  const ms = performance.now() - start;
  rows.push({ type, ms, per: ms / instances.length, ok });
}
Math.random = originalRandom;

rows.sort((a, b) => b.per - a.per);
const total = rows.reduce((sum, row) => sum + row.per, 0);
console.log(`cases=${cases} seed=0x${seed.toString(16)}`);
console.log("  per-case-ms   total-ms  ok  type");
for (const row of rows) {
  console.log(`  ${row.per.toFixed(4).padStart(10)} ${row.ms.toFixed(2).padStart(10)}  ${row.ok ? " y" : " N"}  ${row.type}`);
}
console.log(`  ${total.toFixed(4).padStart(10)} sum of per-case means`);
for (const type of missing) console.log(`  no solver registered: ${type}`);
const rejected = rows.filter((row) => !row.ok).map((row) => row.type);
if (rejected.length > 0) console.error(`answers rejected by the official validator: ${rejected.join(", ")}`);
if (rejected.length > 0 || missing.length > 0) process.exit(1);
