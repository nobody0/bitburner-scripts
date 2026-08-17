/** Paired deep-search benchmark: flat profile-default baseline versus
 * K-narrowed deep-search configurations on one fresh corpus.
 *
 * The deep mode reinvests a narrower root shortlist into round-two expansion;
 * this screen measures whether that buys wins at comparable runtime. Every
 * arm plays the identical corpus; the p95 decision latency of every arm must
 * stay under the 50 ms budget or the configuration is rejected outright.
 * Screens are exploratory and never promotion-eligible.
 *
 * Usage:
 *   bun run go:deep:arena [--games N] [--seed N --handicap-seed N --defense-seed N]
 *     [--root-k list] [--k2 list] [--uncertainty list] [--out result.json]
 */
import { createHash } from "node:crypto";
import { join } from "node:path";
import { runGoProfileArena, type GoProfileArenaResult } from "./go-profile-arena.ts";
import { pairedPromotionEvidence } from "./go-promotion-statistics.ts";
import {
  DEFAULT_GO_ARENA_SEED_LEDGER,
  recordGoArenaSeedUse,
  seedUseFromConfig,
} from "./go-arena-seed-ledger.ts";

const ROOT = join(import.meta.dir, "..");
const LATENCY_BUDGET_P95_MS = 50;

function numberFlag(name: string, fallback: number): number {
  const index = Bun.argv.indexOf(name);
  if (index < 0) return fallback;
  const value = Number(Bun.argv[index + 1]);
  if (!Number.isFinite(value)) throw new Error(`${name} requires a number`);
  return value;
}

function listFlag(name: string, fallback: readonly number[]): number[] {
  const index = Bun.argv.indexOf(name);
  if (index < 0) return [...fallback];
  const values = (Bun.argv[index + 1] ?? "").split(",").map(Number);
  if (!values.length || values.some((value) => !Number.isSafeInteger(value))) {
    throw new Error(`${name} requires a comma-separated integer list`);
  }
  return values;
}

function stringFlag(name: string, fallback: string): string {
  const index = Bun.argv.indexOf(name);
  if (index < 0) return fallback;
  const value = Bun.argv[index + 1];
  if (!value) throw new Error(`${name} requires a value`);
  return value;
}

const config = {
  profile: "small5" as const,
  games: Math.max(1, Math.floor(numberFlag("--games", 128))),
  seed: Math.floor(numberFlag("--seed", 55_555_501)),
  handicapSeed: Math.floor(numberFlag("--handicap-seed", 55_555_502)),
  defenseSeed: Math.floor(numberFlag("--defense-seed", 55_555_503)),
};
const rootKs = listFlag("--root-k", [4]);
const followUpKs = listFlag("--k2", [2, 3]);
const uncertainties = listFlag("--uncertainty", [0, 1]);
const outPath = stringFlag("--out", join(ROOT, "go-ai", "derivatives",
  `small5-deep-eval-${config.seed}.json`));

const championSha = createHash("sha256").update(new Uint8Array(
  await Bun.file(join(ROOT, "go-ai", "small5-champion.model")).arrayBuffer())).digest("hex");
const seedUse = seedUseFromConfig(config, "screen", [championSha]);
await recordGoArenaSeedUse(seedUse, DEFAULT_GO_ARENA_SEED_LEDGER, true);
console.log(`screen corpus recorded as ${seedUse.id}`);

function armSummary(label: string, result: GoProfileArenaResult) {
  return {
    label,
    wins: result.wins,
    games: result.games,
    points: result.pointDifference,
    powerPerTurn: result.meanPowerPerTurn,
    meanTurns: result.meanTurns,
    meanFinalists: result.meanFinalists,
    latencyMs: result.latencyMs,
    withinLatencyBudget: result.latencyMs.p95 < LATENCY_BUDGET_P95_MS,
  };
}

console.log(`baseline: flat K=8, deep search explicitly disabled`);
const baseline = await runGoProfileArena({ ...config, candidateLimit: 8, deepSearch: null });
console.log(JSON.stringify(armSummary("baseline-flat-k8", baseline)));

const arms: unknown[] = [armSummary("baseline-flat-k8", baseline)];
for (const rootK of rootKs) {
  for (const followUpK of followUpKs) {
    for (const uncertaintyTicks of uncertainties) {
      const label = `deep-k${rootK}-f${followUpK}-u${uncertaintyTicks}`;
      console.log(`arm: ${label}`);
      const result = await runGoProfileArena({
        ...config,
        candidateLimit: rootK,
        deepSearch: {
          schema: "bitburner-go-deep-search-v1",
          followUpK,
          uncertaintyTicks,
        },
      });
      const evidence = pairedPromotionEvidence(
        config.profile, result.gameMetrics, baseline.gameMetrics);
      const summary = {
        ...armSummary(label, result),
        rootK,
        followUpK,
        uncertaintyTicks,
        pairedVersusBaseline: {
          favorableWinFlips: evidence.favorableWinFlips,
          unfavorableWinFlips: evidence.unfavorableWinFlips,
          oneSidedWinPValue: evidence.oneSidedWinPValue,
          powerPerTurnLower95: evidence.powerPerTurnLower95,
          fewerTurnsLower95: evidence.fewerTurnsLower95,
        },
      };
      arms.push(summary);
      console.log(JSON.stringify(summary));
    }
  }
}

const report = {
  schema: "go-deep-eval-screen-v1",
  screenOnly: true,
  promotionEligible: false,
  seedUseId: seedUse.id,
  config,
  latencyBudgetP95Ms: LATENCY_BUDGET_P95_MS,
  championSha256: championSha,
  arms,
  recordedAt: new Date().toISOString(),
};
await Bun.write(outPath, `${JSON.stringify(report, null, 2)}\n`);
console.log(`deep-eval screen written to ${outPath}`);
