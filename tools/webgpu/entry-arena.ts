/** Browser-side GPU arena: real games against the vendored upstream AI with
 * the value network running on the actual WGSL shader.
 *
 * Golden-vector equality is the numerical oracle; this gate plays complete
 * upstream-backed games solely through the deployed GPU policy.
 */
import {
  configureGoArenaEngine,
  GO_ARENA_OPPONENTS,
  goArenaSeedPairs,
  playGoArenaGame,
  summarizeGoArena,
  type GoArenaGameResult,
} from "../../sim/go-arena.ts";
import { createRequiredWebGpuGoValueBackend } from "../../shared/strategy/go/neural/webgpu.ts";

async function playCorpus(
  opponent: (typeof GO_ARENA_OPPONENTS)[number],
  cases: readonly { seed: number; handicapSeed: number; defenseSeed: number }[],
): Promise<GoArenaGameResult[]> {
  const games: GoArenaGameResult[] = [];
  const config = globalThis.__goArenaOptions;
  for (const { seed, handicapSeed, defenseSeed } of cases) games.push(await playGoArenaGame(opponent, seed, undefined, false, {
    handicapSeed,
    defenseSeed,
    ...(config?.cheat ? { cheat: {
      enabled: true,
      ...(config.cheatChance !== undefined ? { successChance: config.cheatChance } : {}),
      ...(config.cheatK !== undefined ? { candidateLimit: config.cheatK } : {}),
      ...(config.cheatDoubleK !== undefined ? { doubleMoveLimit: config.cheatDoubleK } : {}),
    } } : {}),
  }));
  return games;
}

async function main(): Promise<unknown> {
  const failures: string[] = [];
  const originalRandom = Math.random;
  const summaries: unknown[] = [];
  try {
    const config = globalThis.__goArenaOptions;
    const selected = GO_ARENA_OPPONENTS.filter((opponent) => {
      if (!config?.opponent) return true;
      const query = config.opponent.toLowerCase();
      if (query === "ordinary" || query === "factions") return opponent.name !== "????????????";
      if ((query === "secret" || query === "world-daemon") && opponent.name === "????????????") return true;
      return opponent.name.toLowerCase().includes(query);
    });
    for (const selectedOpponent of selected) {
      const requestedBoard = ([5, 7, 9, 13] as const)
        .find((size) => size === config?.boardSize);
      const opponent = requestedBoard !== undefined
        ? { ...selectedOpponent, requestedSize: requestedBoard }
        : selectedOpponent;
      const daemon = opponent.name === "????????????";
      // The default all-opponents gate keeps its 2-game daemon smoke; an
      // explicitly selected daemon bench plays the full requested corpus.
      const cases = goArenaSeedPairs(
        daemon && !config?.opponent ? Math.min(2, config?.games ?? 12) : config?.games ?? 12,
        123_456,
        3_203_338_803,
      );

      configureGoArenaEngine(async (weights) => {
        return createRequiredWebGpuGoValueBackend(weights);
      });
      const gpuGames = await playCorpus(opponent, cases);
      for (const game of gpuGames) {
        if (!game.completed) failures.push(`${opponent.name} seed ${game.seed}: game did not complete`);
      }

      const summary = summarizeGoArena(opponent.name, gpuGames);
      const phase = (name: keyof GoArenaGameResult["planningPhases"]) => {
        const values = gpuGames.flatMap((game) => game.planningPhases[name]).sort((a, b) => a - b);
        const at = (fraction: number) => values[Math.min(values.length - 1, Math.floor(values.length * fraction))] ?? 0;
        return { p50: +at(0.5).toFixed(2), p95: +at(0.95).toFixed(2), max: +(values.at(-1) ?? 0).toFixed(2) };
      };
      const actionLatency = Object.fromEntries([...new Set(gpuGames.flatMap((game) => game.actions))].map((action) => {
        const values = gpuGames.flatMap((game) => game.planningMs
          .filter((_, index) => game.actions[index] === action)).sort((a, b) => a - b);
        const at = (fraction: number) => values[Math.min(values.length - 1, Math.floor(values.length * fraction))] ?? 0;
        return [action, { count: values.length, p50: +at(0.5).toFixed(2), p95: +at(0.95).toFixed(2), max: +(values.at(-1) ?? 0).toFixed(2) }];
      }));
      summaries.push({
        opponent: summary.opponent,
        games: summary.games,
        wins: summary.wins,
        winRate: +summary.winRate.toFixed(4),
        wilsonLower95: +summary.wilsonLower95.toFixed(4),
        meanCheatsPlayed: +summary.meanCheatsPlayed.toFixed(2),
        meanBlackScore: +summary.meanBlackScore.toFixed(2),
        meanNodePowerGain: +summary.meanNodePowerGain.toFixed(3),
        nodePowerPerTurn: +summary.nodePowerPerTurn.toFixed(4),
        nodePowerPerSecond: +summary.nodePowerPerSecond.toFixed(4),
        decisions: summary.decisions,
        latencyMs: {
          p50: +summary.latencyMs.p50.toFixed(2),
          p95: +summary.latencyMs.p95.toFixed(2),
          max: +summary.latencyMs.max.toFixed(2),
        },
        planningPhases: {
          preparation: phase("preparationMs"),
          gpuAndSelection: phase("gpuAndSelectionMs"),
        },
        actionLatency,
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
  var __goArenaOptions: {
    cheat: boolean;
    games: number;
    opponent?: string;
    boardSize?: number;
    cheatChance?: number;
    cheatK?: number;
    cheatDoubleK?: number;
  } | undefined;
}
globalThis.__goWebGpuResult = main().catch((error: unknown) => ({
  ok: false,
  failures: [`harness error: ${String(error)}`],
}));
export {};
