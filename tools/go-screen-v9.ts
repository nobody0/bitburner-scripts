/** Compare V9 checkpoints under identical production WebGPU arena conditions.
 * This is a read-only screen: the generated artifact is restored afterward. */
import { join } from "node:path";
import { runGoProfileArena, type GoArenaProfile, type GoProfileArenaResult } from "./go-profile-arena.ts";

const ROOT = join(import.meta.dir, "..");

function numberFlag(name: string, fallback: number): number {
  const index = Bun.argv.indexOf(name);
  if (index < 0) return fallback;
  const value = Number(Bun.argv[index + 1]);
  if (!Number.isFinite(value)) throw new Error(`${name} requires a number`);
  return value;
}

function run(step: string[]): void {
  const result = Bun.spawnSync(step, { cwd: ROOT, stdout: "inherit", stderr: "inherit" });
  if (result.exitCode !== 0) throw new Error(`step failed: ${step.join(" ")}`);
}

const profileArg = Bun.argv[2];
if (profileArg !== "small5" && profileArg !== "daemon19") {
  throw new Error("usage: bun run tools/go-screen-v9.ts <small5|daemon19> MODEL... [--games N] [--seed N]");
}
const profile: GoArenaProfile = profileArg;
const flagAt = Bun.argv.findIndex((value, index) => index >= 3 && value.startsWith("--"));
const candidates = Bun.argv.slice(3, flagAt < 0 ? undefined : flagAt);
if (!candidates.length) throw new Error("at least one V9 checkpoint is required");

const config = {
  profile,
  games: Math.max(1, Math.floor(numberFlag("--games", profile === "small5" ? 6 : 2))),
  seed: Math.floor(numberFlag("--seed", 4_271_903)),
};
const artifact = join(ROOT, "shared", "strategy", "go", "neural", "models", `${profile}.ts`);
const original = await Bun.file(artifact).text();
const rows: { model: string; result: GoProfileArenaResult }[] = [];
try {
  for (const candidate of candidates) {
    run(["bun", "run", "tools/go-export-model.ts", candidate, profile]);
    const result = await runGoProfileArena(config);
    rows.push({ model: candidate, result });
    console.log(`${candidate}: ${result.wins}/${result.games} wins, `
      + `${result.pointDifference >= 0 ? "+" : ""}${result.pointDifference.toFixed(1)} points, `
      + `${result.latencyMs.p50}/${result.latencyMs.p95} ms p50/p95, ${result.meanFinalists} finalists`);
  }
} finally {
  await Bun.write(artifact, original);
}

rows.sort((a, b) => b.result.wins - a.result.wins
  || b.result.pointDifference - a.result.pointDifference
  || a.result.latencyMs.p95 - b.result.latencyMs.p95);
console.log(`best WebGPU checkpoint: ${rows[0]!.model}`);
console.log(JSON.stringify({ backend: "webgpu", config, rows }, null, 2));
