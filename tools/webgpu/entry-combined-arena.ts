/** Browser half of the combined playbook/neural arena: the stripped merged
 * playbook plus the production WebGPU neural stack, against the vendored
 * upstream AI. */
import { validateMergedPlaybook } from "../../shared/strategy/go/playbook-facade.ts";
import { playCombinedArenaGame, type CombinedArenaTiming } from "../../sim/go-combined-arena.ts";
import { GoNeuralEngine } from "../../shared/strategy/go/neural/engine.ts";
import { createRequiredWebGpuGoValueBackend } from "../../shared/strategy/go/neural/webgpu.ts";

interface CombinedArenaConfig {
  games: number;
  startPhase: number;
  phaseStride: number;
  timing: CombinedArenaTiming;
  defenseSeed: number;
  opponent?: string;
  arms: readonly ("combined" | "neuralOnly" | "playbookOnly" | "neuralUnrouted" | "combinedUnrouted")[];
}

function percentile(values: readonly number[], fraction: number): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))]!;
}

async function main(): Promise<unknown> {
  const config = globalThis.__goCombinedArenaConfig;
  if (!config) throw new Error("missing __goCombinedArenaConfig");
  // Injected by the driver as an inlined classic script: the generated module
  // is too large for esbuild's parser. Its packed tables inflate
  // asynchronously, so await readiness first.
  const injected = globalThis as {
    __combinedPlaybook?: unknown; __combinedPlaybookReady?: Promise<unknown> };
  await injected.__combinedPlaybookReady;
  const playbook = validateMergedPlaybook(injected.__combinedPlaybook);
  const engine = new GoNeuralEngine((weights) => createRequiredWebGpuGoValueBackend(weights));
  interface Bucket {
    games: number; wins: number; completed: number;
    certifiedTurns: number; neuralTurns: number; neuralReturns: number;
    blackPower: number; totalRounds: number;
    neuralLatency: number[]; failures: string[];
  }
  const newBucket = (): Bucket => ({ games: 0, wins: 0, completed: 0, certifiedTurns: 0,
    neuralTurns: 0, neuralReturns: 0, blackPower: 0, totalRounds: 0, neuralLatency: [],
    failures: [] });
  const results: Record<string, Bucket> = {};
  const perOpponent: Record<string, Record<string, Bucket>> = {};
  for (const arm of config.arms) {
    results[arm] = newBucket();
    perOpponent[arm] = {};
  }
  // With no pinned opponent the corpus rotates through every covered enemy, so
  // one run measures the mixed field each arm actually faces in a real game.
  const rotation = config.opponent ? [config.opponent] : [...playbook.OPPONENTS];
  for (let index = 0; index < config.games; index++) {
    const startPhase = (config.startPhase + index * config.phaseStride) % 150_000;
    const defenseSeed = (config.defenseSeed + index * 0x9e37_79b9) >>> 0;
    const opponent = rotation[index % rotation.length]!;
    for (const arm of config.arms) {
      const game = await playCombinedArenaGame(playbook, startPhase, engine, {
        timing: config.timing,
        defenseSeed,
        opponent,
        neuralOnly: arm === "neuralOnly" || arm === "neuralUnrouted",
        playbookOnly: arm === "playbookOnly",
        unrouted: arm === "neuralUnrouted" || arm === "combinedUnrouted",
      });
      const armOpponents = perOpponent[arm]!;
      armOpponents[game.enemy] ??= newBucket();
      for (const bucket of [results[arm]!, armOpponents[game.enemy]!]) {
      bucket.games++;
      if (game.completed) bucket.completed++;
      if (game.won) bucket.wins++;
      bucket.certifiedTurns += game.certifiedTurns;
      bucket.neuralTurns += game.neuralTurns;
      bucket.neuralReturns += game.neuralReturns;
      bucket.blackPower += game.won ? game.blackScore : game.blackScore * 0.5;
      bucket.totalRounds += game.policyRounds;
      bucket.neuralLatency.push(...game.neuralLatencyMs);
      if (game.failure && bucket.failures.length < 20) {
        bucket.failures.push(`${game.enemy}@${startPhase}: ${game.failure}`);
      }
      }
    }
  }
  const summarize = (bucket: Bucket) => ({
    games: bucket.games,
    wins: bucket.wins,
    completed: bucket.completed,
    winRate: bucket.wins / Math.max(1, bucket.games),
    certifiedTurns: bucket.certifiedTurns,
    neuralTurns: bucket.neuralTurns,
    neuralReturns: bucket.neuralReturns,
    powerPerTurn: bucket.blackPower / Math.max(1, bucket.totalRounds),
    neuralLatencyMs: {
      p50: +percentile(bucket.neuralLatency, 0.5).toFixed(2),
      p95: +percentile(bucket.neuralLatency, 0.95).toFixed(2),
      count: bucket.neuralLatency.length,
    },
    failures: bucket.failures,
  });
  return {
    ok: true,
    backend: "webgpu",
    config: { ...config },
    arms: Object.fromEntries(Object.entries(results).map(([arm, bucket]) =>
      [arm, summarize(bucket)])),
    perOpponent: Object.fromEntries(Object.entries(perOpponent).map(([arm, opponents]) =>
      [arm, Object.fromEntries(Object.entries(opponents).map(([enemy, bucket]) =>
        [enemy, summarize(bucket)]))])),
  };
}

declare global {
  // eslint-disable-next-line no-var
  var __goCombinedArenaConfig: CombinedArenaConfig | undefined;
  // eslint-disable-next-line no-var
  var __goWebGpuResult: Promise<unknown>;
}
globalThis.__goWebGpuResult = main().catch((error: unknown) => ({
  ok: false, backend: "webgpu", error: String(error),
}));
export {};
