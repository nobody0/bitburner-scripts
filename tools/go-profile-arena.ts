import { join } from "node:path";
import { runInHeadlessChrome } from "./webgpu/chrome-runner.ts";

export type GoArenaProfile = "small5" | "daemon19";
export interface GoProfileArenaConfig {
  profile: GoArenaProfile;
  /** Games per ordinary opponent; daemon19 has one opponent. */
  games: number;
  seed: number;
  candidateLimit?: number;
}
export interface GoProfileArenaResult {
  ok: boolean;
  backend: "webgpu";
  games: number;
  wins: number;
  winRate: number;
  completed: number;
  pointDifference: number;
  decisions: number;
  meanFinalists: number;
  latencyMs: { p50: number; p95: number; max: number };
  opponents: unknown[];
  error?: string;
}

export async function runGoProfileArena(config: GoProfileArenaConfig): Promise<GoProfileArenaResult> {
  const run = await runInHeadlessChrome(
    join(import.meta.dir, "webgpu", "entry-profile-arena.ts"),
    900_000,
    { __goArenaConfig: config },
  );
  const result = run.result as GoProfileArenaResult;
  if (!result || result.ok !== true || result.backend !== "webgpu") {
    throw new Error(`WebGPU profile arena failed: ${JSON.stringify(result)}`);
  }
  return result;
}

function numberFlag(name: string, fallback: number): number {
  const index = Bun.argv.indexOf(name);
  if (index < 0) return fallback;
  const value = Number(Bun.argv[index + 1]);
  if (!Number.isFinite(value)) throw new Error(`${name} requires a number`);
  return value;
}

if (import.meta.main) {
  const profile = Bun.argv[2];
  if (profile !== "small5" && profile !== "daemon19") {
    throw new Error("usage: bun run tools/go-profile-arena.ts <small5|daemon19> [--games N] [--seed N] [--candidate-limit N]");
  }
  const candidateLimitIndex = Bun.argv.indexOf("--candidate-limit");
  const result = await runGoProfileArena({
    profile,
    games: Math.max(1, Math.floor(numberFlag("--games", profile === "small5" ? 6 : 2))),
    seed: Math.floor(numberFlag("--seed", 918_273)),
    ...(candidateLimitIndex < 0 ? {} : {
      candidateLimit: Math.max(1, Math.floor(numberFlag("--candidate-limit", 8))),
    }),
  });
  console.log(JSON.stringify(result, null, 2));
}
