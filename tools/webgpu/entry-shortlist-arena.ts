/** V9 shortlist quality/latency frontier on identical upstream-backed games. */
import {
  configureGoArenaEngine,
  GO_ARENA_OPPONENTS,
  goArenaSeeds,
  playGoArenaGame,
  type GoArenaGameResult,
} from "../../sim/go-arena.ts";
import { createRequiredWebGpuGoValueBackend } from "../../shared/strategy/go/neural/webgpu.ts";

// Keep this a useful development-time gate. Three policy points reveal the
// quality/latency knee without turning one WebGPU check into a long campaign.
const LIMITS = [4, 8, 16] as const;

function percentile(values: number[], fraction: number): number {
  values.sort((a, b) => a - b);
  return values[Math.min(values.length - 1, Math.floor(values.length * fraction))] ?? 0;
}

function metrics(games: GoArenaGameResult[]) {
  const latencies = games.flatMap((game) => game.planningMs);
  const finalists = games.flatMap((game) => game.finalists);
  return {
    games: games.length,
    wins: games.filter((game) => game.won).length,
    completed: games.filter((game) => game.completed).length,
    decisions: latencies.length,
    meanFinalists: +(finalists.reduce((sum, value) => sum + value, 0)
      / Math.max(finalists.length, 1)).toFixed(2),
    latencyMs: {
      p50: +percentile([...latencies], 0.5).toFixed(2),
      p95: +percentile([...latencies], 0.95).toFixed(2),
      max: +Math.max(0, ...latencies).toFixed(2),
    },
  };
}

async function main(): Promise<unknown> {
  const originalRandom = Math.random;
  Math.random = () => 0.5;
  const frontier: unknown[] = [];
  try {
    for (const limit of LIMITS) {
      configureGoArenaEngine((weights) => createRequiredWebGpuGoValueBackend(weights));
      const ordinary: GoArenaGameResult[] = [];
      const daemon: GoArenaGameResult[] = [];
      for (const opponent of GO_ARENA_OPPONENTS) {
        const target = opponent.name === "????????????" ? daemon : ordinary;
        const seeds = goArenaSeeds(opponent.name === "????????????" ? 1 : 6, 654_321);
        for (const seed of seeds) {
          target.push(await playGoArenaGame(opponent, seed, 0.5, false, { candidateLimit: limit }));
        }
      }
      frontier.push({ limit, ordinary: metrics(ordinary), daemon19: metrics(daemon) });
    }
  } finally {
    Math.random = originalRandom;
  }
  return {
    ok: frontier.every((row) => {
      const value = row as { ordinary: { completed: number; games: number }; daemon19: { completed: number; games: number } };
      return value.ordinary.completed === value.ordinary.games
        && value.daemon19.completed === value.daemon19.games;
    }),
    frontier,
  };
}

declare global { var __goWebGpuResult: Promise<unknown>; }
globalThis.__goWebGpuResult = main().catch((error: unknown) => ({
  ok: false,
  error: String(error),
}));
