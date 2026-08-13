/** Configurable V9 arena. Every model evaluation uses the production WGSL
 * backend; the host injects __goArenaConfig before this bundle starts. */
import {
  configureGoArenaEngine,
  GO_ARENA_OPPONENTS,
  goArenaSeeds,
  playGoArenaGame,
  summarizeGoArena,
  type GoArenaGameResult,
} from "../../sim/go-arena.ts";
import { createRequiredWebGpuGoValueBackend } from "../../shared/strategy/go/neural/webgpu.ts";

type Profile = "small5" | "daemon19";
interface ArenaConfig { profile: Profile; games: number; seed: number; candidateLimit?: number }

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
  if (!Number.isInteger(config.games) || config.games < 1 || !Number.isFinite(config.seed)) {
    throw new Error("arena games and seed must be finite positive integers");
  }
  const selected = GO_ARENA_OPPONENTS.filter((opponent) =>
    config.profile === "daemon19" ? opponent.name === "????????????" : opponent.requestedSize === 5);
  configureGoArenaEngine((weights) => createRequiredWebGpuGoValueBackend(weights));
  const allGames: GoArenaGameResult[] = [];
  const opponents: unknown[] = [];
  const originalRandom = Math.random;
  Math.random = () => 0.5;
  try {
    for (let opponentIndex = 0; opponentIndex < selected.length; opponentIndex++) {
      const opponent = selected[opponentIndex]!;
      const games: GoArenaGameResult[] = [];
      for (const seed of goArenaSeeds(config.games, config.seed + opponentIndex * 20_003)) {
        games.push(await playGoArenaGame(opponent, seed, 0.5, false, {
          ...(config.candidateLimit === undefined ? {} : { candidateLimit: config.candidateLimit }),
        }));
      }
      allGames.push(...games);
      const summary = summarizeGoArena(opponent.name, games);
      opponents.push({
        opponent: summary.opponent,
        games: summary.games,
        wins: summary.wins,
        completed: summary.completed,
        pointDifference: summary.pointDifference,
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
    meanFinalists: +(finalists.reduce((sum, value) => sum + value, 0)
      / Math.max(1, finalists.length)).toFixed(2),
    latencyMs: {
      p50: +percentile(latencies, 0.5).toFixed(2),
      p95: +percentile(latencies, 0.95).toFixed(2),
      max: +percentile(latencies, 1).toFixed(2),
    },
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
