/** Search-budget screen for a single opponent.
 *
 * The production selector is sized for the whole 5x5 field and spends only a
 * fraction of the 50 ms decision budget. Opponents are not equally hard, so
 * this screen replays one opponent's corpus under several finalist/deep-search
 * budgets and reports wins, Power per turn, and decision latency for each.
 *
 * Every arm plays the identical corpus (same playtime, handicap, and defense
 * streams), so the differences are the budget. The corpus is burned in the
 * seed ledger before the first arm runs. Nothing is installed: a winning arm
 * becomes a `GO_OPPONENT_SEARCH` entry only after the result replicates on a
 * disjoint corpus, per go-ai/DEPLOYMENT.md.
 *
 * Usage:
 *   bun run go:search:screen --opponent Illuminati --games 384
 *     --seed N --handicap-seed N --defense-seed N [--arms K/f/u,...] [--out FILE]
 */
import { join } from "node:path";
import { runGoProfileArena } from "./go-profile-arena.ts";
import { recordGoArenaSeedUse, seedUseFromConfig } from "./go-arena-seed-ledger.ts";
import {
  GO_PROFILE_CANDIDATE_LIMITS,
  GO_PROFILE_DEEP_SEARCH,
  type GoDeepSearchV1,
} from "../shared/strategy/go/neural/engine.ts";

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
  if (!value) throw new Error(`${name} requires a value`);
  return value;
}

const deep = (followUpK: number, uncertaintyTicks: number): GoDeepSearchV1 => ({
  schema: "bitburner-go-deep-search-v1",
  followUpK,
  uncertaintyTicks,
});

/** Arms as `K/followUpK/uncertaintyTicks` triples, production default first.
 * Override with `--arms 4/3/1,8/5/1,12/5/1`. */
const DEFAULT_ARMS = "4/3/1,4/5/1,6/3/1,6/5/1,8/5/1,6/5/2";
const ARMS: readonly { label: string; candidateLimit?: number; deepSearch?: GoDeepSearchV1 }[] =
  stringFlag("--arms", DEFAULT_ARMS).split(",").map((spec, index) => {
    const [limit, followUpK, uncertaintyTicks] = spec.split("/").map(Number);
    if (![limit, followUpK, uncertaintyTicks].every((value) => Number.isInteger(value) && value! >= 0)) {
      throw new Error(`invalid arm ${spec}; expected K/followUpK/uncertaintyTicks`);
    }
    return {
      label: `${index === 0 ? "control " : ""}K=${limit} f${followUpK} u${uncertaintyTicks}`,
      candidateLimit: limit!,
      deepSearch: deep(followUpK!, uncertaintyTicks!),
    };
  });

/** The live contract: no arm may be adopted whose p95 decision exceeds this. */
const DECISION_BUDGET_MS = 50;

const opponent = stringFlag("--opponent", "Illuminati");
const base = {
  profile: "small5" as const,
  games: Math.max(1, Math.floor(numberFlag("--games", 384))),
  seed: Math.floor(numberFlag("--seed", 0)),
  handicapSeed: Math.floor(numberFlag("--handicap-seed", 0)),
  defenseSeed: Math.floor(numberFlag("--defense-seed", 0)),
  opponent,
};
for (const [name, value] of Object.entries(base)) {
  if (typeof value === "number" && value === 0) throw new Error(`--${name} must be an explicit fresh value`);
}

const use = seedUseFromConfig(base, "screen", []);
await recordGoArenaSeedUse(use, undefined, true);
console.log(`corpus recorded: ${use.id}`);
console.log(`${opponent}: ${base.games} games per arm, production default `
  + `K=${GO_PROFILE_CANDIDATE_LIMITS.small5} `
  + `f${GO_PROFILE_DEEP_SEARCH.small5?.followUpK} `
  + `u${GO_PROFILE_DEEP_SEARCH.small5?.uncertaintyTicks}`);

const results: unknown[] = [];
let baseline: { wins: number; games: number } | undefined;
for (const arm of ARMS) {
  const result = await runGoProfileArena({
    ...base,
    ...(arm.candidateLimit === undefined ? {} : { candidateLimit: arm.candidateLimit }),
    ...(arm.deepSearch === undefined ? {} : { deepSearch: arm.deepSearch }),
  });
  baseline ??= { wins: result.wins, games: result.games };
  const flips = { favorable: 0, unfavorable: 0 };
  results.push({
    label: arm.label,
    candidateLimit: arm.candidateLimit ?? GO_PROFILE_CANDIDATE_LIMITS.small5,
    deepSearch: arm.deepSearch ?? GO_PROFILE_DEEP_SEARCH.small5,
    wins: result.wins,
    games: result.games,
    winRate: result.winRate,
    powerPerTurn: result.meanPowerPerTurn,
    meanTurns: result.meanTurns,
    latencyMs: result.latencyMs,
    withinBudget: result.latencyMs.p95 <= DECISION_BUDGET_MS,
    gameMetrics: result.gameMetrics,
    flips,
  });
  console.log(`${arm.label}: ${result.wins}/${result.games} `
    + `(${(result.winRate * 100).toFixed(1)}%), P/t ${result.meanPowerPerTurn.toFixed(4)}, `
    + `p50/p95 ${result.latencyMs.p50}/${result.latencyMs.p95} ms`
    + `${result.latencyMs.p95 > DECISION_BUDGET_MS ? "  OVER BUDGET" : ""}`);
}

// Paired flips against the first arm, which is the production default.
const rows = results as { label: string; gameMetrics: { won: boolean }[];
  flips: { favorable: number; unfavorable: number } }[];
const control = rows[0]!.gameMetrics;
for (const row of rows.slice(1)) {
  row.gameMetrics.forEach((game, index) => {
    const other = control[index]!;
    if (game.won && !other.won) row.flips.favorable++;
    if (!game.won && other.won) row.flips.unfavorable++;
  });
  console.log(`${row.label}: paired flips +${row.flips.favorable}/-${row.flips.unfavorable} `
    + "versus the production default");
}
for (const row of rows) delete (row as { gameMetrics?: unknown }).gameMetrics;

const outPath = stringFlag("--out", join(ROOT, "go-ai", "derivatives",
  `small5-search-screen-${opponent.toLowerCase().replace(/\s+/g, "-")}-${base.seed}.json`));
await Bun.write(outPath, `${JSON.stringify({
  schema: 1,
  recordedAt: new Date().toISOString(),
  seedUseId: use.id,
  config: base,
  decisionBudgetMs: DECISION_BUDGET_MS,
  baseline,
  arms: results,
}, null, 2)}\n`);
console.log(`screen written to ${outPath}`);
