/** Configurable V9 arena. Every model evaluation uses the production WGSL
 * backend; the host injects __goArenaConfig before this bundle starts. */
import {
  configureGoArenaEngine,
  GO_ARENA_OPPONENTS,
  goProfileArenaSeedCases,
  playGoArenaGame,
  summarizeGoArena,
  type GoArenaGameResult,
} from "../../sim/go-arena.ts";
import { createRequiredWebGpuGoValueBackend } from "../../shared/strategy/go/neural/webgpu.ts";
import type { GoDeepSearchV1, GoSeedWaitV1 } from "../../shared/strategy/go/neural/engine.ts";

type Profile = "small5" | "daemon19";
interface ArenaConfig {
  profile: Profile;
  games: number;
  seed: number;
  handicapSeed: number;
  defenseSeed: number;
  candidateLimit?: number;
  /** Explicit config, or null to force flat finalization for baseline arms;
   * absent resolves the per-profile production default. */
  deepSearch?: GoDeepSearchV1 | null;
  /** Explicit one-cycle seed-wait policy, or null to disable it. */
  seedWait?: GoSeedWaitV1 | null;
  /** Restrict the corpus to one opponent; omit for the full field. */
  opponent?: string;
}

function percentile(values: readonly number[], fraction: number): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))]!;
}

async function main(): Promise<unknown> {
  const config = globalThis.__goArenaConfig;
  if (!config || (config.profile !== "small5" && config.profile !== "daemon19")) {
    throw new Error("missing or invalid __goArenaConfig");
  }
  if (!Number.isInteger(config.games) || config.games < 1
    || !Number.isFinite(config.seed) || !Number.isFinite(config.handicapSeed)
    || !Number.isFinite(config.defenseSeed)) {
    throw new Error("arena games, playtime seed, handicap seed, and defense seed must be finite integers");
  }
  const selected = GO_ARENA_OPPONENTS.filter((opponent) =>
    (config.profile === "daemon19" ? opponent.name === "????????????" : opponent.requestedSize === 5)
    // A single-opponent screen spends the whole corpus where the question is,
    // instead of paying for five opponents to answer about one.
    && (config.opponent === undefined || opponent.name === config.opponent));
  if (selected.length === 0) throw new Error(`opponent ${String(config.opponent)} is not in profile ${config.profile}`);
  configureGoArenaEngine(
    (weights) => createRequiredWebGpuGoValueBackend(weights), {}, config.deepSearch,
    config.seedWait);
  const allGames: GoArenaGameResult[] = [];
  const opponents: unknown[] = [];
  const originalRandom = Math.random;
  try {
    const corpora = goProfileArenaSeedCases(
      config.profile,
      config.games,
      config.seed,
      config.handicapSeed,
      config.defenseSeed,
    );
    for (const corpus of corpora) {
      const opponent = selected.find((value) => value.name === corpus.opponent);
      // A single-opponent screen still draws the full seed plan, so the other
      // opponents' corpora are skipped rather than played.
      if (!opponent) continue;
      const games: GoArenaGameResult[] = [];
      for (const { seed, handicapSeed, defenseSeed } of corpus.cases) {
        games.push(await playGoArenaGame(opponent, seed, undefined, false, {
          handicapSeed,
          defenseSeed,
          ...(config.candidateLimit === undefined ? {} : { candidateLimit: config.candidateLimit }),
        }));
      }
      allGames.push(...games);
      const summary = summarizeGoArena(opponent.name, games);
      opponents.push({
        opponent: summary.opponent,
        games: summary.games,
        wins: summary.wins,
        winRate: summary.winRate,
        completed: summary.completed,
        pointDifference: summary.pointDifference,
        meanBlackScore: summary.meanBlackScore,
        meanDurationMs: summary.meanDurationMs,
        decisions: summary.decisions,
        latencyMs: {
          p50: +summary.latencyMs.p50.toFixed(2),
          p95: +summary.latencyMs.p95.toFixed(2),
          max: +summary.latencyMs.max.toFixed(2),
        },
      });
    }
  } finally {
    Math.random = originalRandom;
  }
  const latencies = allGames.flatMap((game) => game.planningMs);
  const finalists = allGames.flatMap((game) => game.finalists);
  const wins = allGames.filter((game) => game.won).length;
  const completed = allGames.filter((game) => game.completed).length;
  return {
    ok: completed === allGames.length,
    backend: "webgpu",
    config,
    games: allGames.length,
    wins,
    winRate: wins / allGames.length,
    completed,
    pointDifference: allGames.reduce((sum, game) => sum + game.score.X - game.score.O, 0),
    decisions: latencies.length,
    meanTurns: +(allGames.reduce((sum, game) => sum + game.turns, 0)
      / Math.max(1, allGames.length)).toFixed(2),
    meanPowerPerTurn: +(allGames.reduce((sum, game) => sum
      + game.score.X * (game.won ? 1 : 0.5), 0)
      / Math.max(1, allGames.reduce((sum, game) => sum + game.turns, 0))).toFixed(6),
    meanFinalists: +(finalists.reduce((sum, value) => sum + value, 0)
      / Math.max(1, finalists.length)).toFixed(2),
    latencyMs: {
      p50: +percentile(latencies, 0.5).toFixed(2),
      p95: +percentile(latencies, 0.95).toFixed(2),
      max: +percentile(latencies, 1).toFixed(2),
    },
    seedWaits: allGames.reduce((sum, game) => sum + game.seedWaits, 0),
    gameMetrics: allGames.map((game) => ({
      opponent: game.opponent,
      seed: game.seed,
      handicapSeed: game.handicapSeed,
      defenseSeed: game.defenseSeed,
      completed: game.completed,
      won: game.won,
      power: game.score.X * (game.won ? 1 : 0.5),
      turns: game.turns,
      blackScore: game.score.X,
      whiteScore: game.score.O,
    })),
    opponents,
  };
}

declare global {
  // eslint-disable-next-line no-var
  var __goArenaConfig: ArenaConfig | undefined;
  // eslint-disable-next-line no-var
  var __goWebGpuResult: Promise<unknown>;
}
globalThis.__goWebGpuResult = main().catch((error: unknown) => ({
  ok: false, backend: "webgpu", error: String(error),
}));
export {};
