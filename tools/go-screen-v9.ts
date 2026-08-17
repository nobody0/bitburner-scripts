/** Compare V9 checkpoints under identical production WebGPU arena conditions.
 * The generated artifact is restored; the seed ledger deliberately records
 * the corpus so it cannot later masquerade as a fresh apply gate. */
import { join } from "node:path";
import { createHash } from "node:crypto";
import { runGoProfileArena, type GoArenaProfile, type GoProfileArenaResult } from "./go-profile-arena.ts";
import {
  MINIMUM_PROMOTION_GAMES_PER_OPPONENT,
  pairedPromotionEvidence,
} from "./go-promotion-statistics.ts";
import { goArenaSeeds } from "../sim/go-arena.ts";
import { GO_PROFILE_CANDIDATE_LIMITS } from "../shared/strategy/go/neural/engine.ts";
import {
  DEFAULT_GO_ARENA_SEED_LEDGER,
  recordGoArenaSeedUse,
  seedUseFromConfig,
} from "./go-arena-seed-ledger.ts";

const ROOT = join(import.meta.dir, "..");

function numberFlag(name: string, fallback: number): number {
  const index = Bun.argv.indexOf(name);
  if (index < 0) return fallback;
  const value = Number(Bun.argv[index + 1]);
  if (!Number.isFinite(value)) throw new Error(`${name} requires a number`);
  return value;
}

function stringFlag(name: string, fallback: string): string {
  const index = Bun.argv.indexOf(name);
  if (index < 0) return fallback;
  const value = Bun.argv[index + 1];
  if (!value) throw new Error(`${name} requires a path`);
  return value;
}

async function sha256(path: string): Promise<string> {
  return createHash("sha256").update(new Uint8Array(await Bun.file(path).arrayBuffer())).digest("hex");
}

function run(step: string[]): void {
  const result = Bun.spawnSync(step, { cwd: ROOT, stdout: "inherit", stderr: "inherit" });
  if (result.exitCode !== 0) throw new Error(`step failed: ${step.join(" ")}`);
}

const profileArg = Bun.argv[2];
if (profileArg !== "small5" && profileArg !== "daemon19") {
  throw new Error("usage: bun run tools/go-screen-v9.ts <small5|daemon19> MODEL... [--games N] [--seed N] [--handicap-seed N] [--defense-seed N] [--seed-ledger PATH]");
}
const profile: GoArenaProfile = profileArg;
const flagAt = Bun.argv.findIndex((value, index) => index >= 3 && value.startsWith("--"));
const candidates = Bun.argv.slice(3, flagAt < 0 ? undefined : flagAt);
if (!candidates.length) throw new Error("at least one V9 checkpoint is required");

const config = {
  profile,
  games: Math.max(1, Math.floor(numberFlag("--games", profile === "small5" ? 6 : 2))),
  seed: Math.floor(numberFlag("--seed", 4_271_903)),
  handicapSeed: Math.floor(numberFlag("--handicap-seed", 2_949_720_237)),
  defenseSeed: Math.floor(numberFlag("--defense-seed", 1_013_904_223)),
  ...(Bun.argv.includes("--candidate-limit") ? {
    candidateLimit: Math.max(1, Math.floor(numberFlag("--candidate-limit", 8))),
  } : {}),
};
const effectiveSeed = goArenaSeeds(1, config.seed)[0]!;
console.log(`arena seeds: raw playtime ${config.seed}, effective engine tick ${effectiveSeed}, `
  + `handicap ${config.handicapSeed}, defense ${config.defenseSeed}`);
console.log(`candidate limit ${config.candidateLimit ?? GO_PROFILE_CANDIDATE_LIMITS[profile]} `
  + `(${config.candidateLimit === undefined ? "profile default" : "explicit flag"})`);
console.log(`screen-only evidence: ${config.games} game(s) per opponent; promotion requires `
  + `${MINIMUM_PROMOTION_GAMES_PER_OPPONENT[profile]} per opponent on a fresh, never-screened corpus`);
const candidateHashes = await Promise.all(candidates.map(sha256));
const seedLedgerPath = stringFlag("--seed-ledger", DEFAULT_GO_ARENA_SEED_LEDGER);
const seedUse = seedUseFromConfig(config, "screen", candidateHashes);
await recordGoArenaSeedUse(seedUse, seedLedgerPath);
console.log(`screen corpus recorded as ${seedUse.id} in ${seedLedgerPath}; it cannot be reused for --apply`);
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
      + `${result.meanPowerPerTurn} Power/turn, ${result.meanTurns} mean turns, `
      + `${result.latencyMs.p50}/${result.latencyMs.p95} ms p50/p95, `
      + `${result.meanFinalists} finalists`);
  }
} finally {
  await Bun.write(artifact, original);
}

rows.sort((a, b) => b.result.wins - a.result.wins
  || b.result.meanPowerPerTurn - a.result.meanPowerPerTurn
  || a.result.meanTurns - b.result.meanTurns
  || a.result.latencyMs.p95 - b.result.latencyMs.p95);
console.log(`screen-only lexicographic leader: ${rows[0]!.model}`);
const baseline = rows.find((row) => row.model === candidates[0])!;
const paired = rows.filter((row) => row !== baseline).map((row) => {
  const evidence = pairedPromotionEvidence(profile, row.result.gameMetrics, baseline.result.gameMetrics);
  return {
    baseline: baseline.model,
    model: row.model,
    exploratoryOnly: true,
    promotionEligible: false,
    statisticalAndSampleGatePassedOnScreen: evidence.promotionGatePassed,
    ...evidence,
  };
});
// Per-game metrics are intentionally retained by the promotion gate for paired
// inference, but dumping thousands of rows makes an exploratory screen's log
// unusable. The aggregate fields are the screen's public result.
const printableRows = rows.map(({ model, result }) => {
  const { gameMetrics: _gameMetrics, ...aggregate } = result;
  return { model, result: aggregate };
});
console.log(JSON.stringify({ backend: "webgpu", screenOnly: true, promotionEligible: false,
  requestedGamesPerOpponent: config.games,
  minimumPromotionGamesPerOpponent: MINIMUM_PROMOTION_GAMES_PER_OPPONENT[profile],
  minimumSampleMet: config.games >= MINIMUM_PROMOTION_GAMES_PER_OPPONENT[profile],
  seedUseId: seedUse.id, config: { ...config, effectiveSeed },
  rows: printableRows, paired }, null, 2));
