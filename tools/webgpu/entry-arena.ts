/** Browser-side GPU arena: real games against the vendored upstream AI with
 * the value network running on the actual WGSL shader.
 *
 * Golden-vector equality is the numerical oracle; this gate plays complete
 * upstream-backed games solely through the deployed GPU policy.
 */
import {
  configureGoArenaEngine,
  GO_ARENA_OPPONENTS,
  goArenaSeeds,
  playGoArenaGame,
  summarizeGoArena,
  type GoArenaGameResult,
} from "../../sim/go-arena.ts";
import { createRequiredWebGpuGoValueBackend } from "../../shared/strategy/go/neural/webgpu.ts";

async function playCorpus(
  opponent: (typeof GO_ARENA_OPPONENTS)[number],
  seeds: readonly number[],
): Promise<GoArenaGameResult[]> {
  const games: GoArenaGameResult[] = [];
  for (const seed of seeds) games.push(await playGoArenaGame(opponent, seed));
  return games;
}

async function main(): Promise<unknown> {
  const failures: string[] = [];
  const originalRandom = Math.random;
  Math.random = () => 0.5;
  const summaries: unknown[] = [];
  try {
    for (const opponent of GO_ARENA_OPPONENTS) {
      const daemon = opponent.name === "????????????";
      const seeds = goArenaSeeds(daemon ? 2 : 12, 123_456);

      configureGoArenaEngine(async (weights) => {
        return createRequiredWebGpuGoValueBackend(weights);
      });
      const gpuGames = await playCorpus(opponent, seeds);
      for (const game of gpuGames) {
        if (!game.completed) failures.push(`${opponent.name} seed ${game.seed}: game did not complete`);
      }

      const summary = summarizeGoArena(opponent.name, gpuGames);
      summaries.push({
        opponent: summary.opponent,
        games: summary.games,
        wins: summary.wins,
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
  return {
    ok: failures.length === 0,
    backends: ["webgpu"],
    summaries,
    failures,
  };
}

declare global {
  // eslint-disable-next-line no-var
  var __goWebGpuResult: Promise<unknown>;
}
globalThis.__goWebGpuResult = main().catch((error: unknown) => ({
  ok: false,
  failures: [`harness error: ${String(error)}`],
}));
export {};
