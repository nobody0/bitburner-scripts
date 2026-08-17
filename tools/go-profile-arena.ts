import { join } from "node:path";
import { runInHeadlessChrome } from "./webgpu/chrome-runner.ts";
import type { GoRewardOpponent } from "../shared/strategy/go/rules.ts";
import {
  GO_PROFILE_CANDIDATE_LIMITS,
  type GoDeepSearchV1,
  type GoSeedWaitV1,
} from "../shared/strategy/go/neural/engine.ts";

export type GoArenaProfile = "small5" | "daemon19";
export interface GoProfileArenaConfig {
  profile: GoArenaProfile;
  /** Games per ordinary opponent; daemon19 has one opponent. */
  games: number;
  seed: number;
  /** Independent start of the unseeded-handicap sample stream. */
  handicapSeed: number;
  /** Independent start of the unseeded defense tie-break stream. */
  defenseSeed: number;
  candidateLimit?: number;
  deepSearch?: GoDeepSearchV1 | null;
  /** Explicit one-cycle seed-wait policy, or null to disable it for a
   * baseline arm; absent resolves the per-profile production default. */
  seedWait?: GoSeedWaitV1 | null;
  /** Restrict the corpus to one opponent; omit for the full field. The
   * daemon19 profile's sole opponent is not a reward opponent, so this is
   * matched by name rather than typed to the reward union. */
  opponent?: GoRewardOpponent | string;
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
  meanTurns: number;
  meanPowerPerTurn: number;
  meanFinalists: number;
  /** Turns that waited one engine cycle for a better seed. */
  seedWaits: number;
  latencyMs: { p50: number; p95: number; max: number };
  /** Finalist budget the games were played at. When no explicit limit is
   * configured the arena view carries none, so the engine resolves the same
   * per-profile production default as live play. */
  candidateLimit: number;
  candidateLimitSource: "profile-default" | "explicit";
  gameMetrics: {
    opponent: string;
    seed: number;
    handicapSeed: number;
    defenseSeed: number | null;
    completed: boolean;
    won: boolean;
    power: number;
    turns: number;
    blackScore: number;
    whiteScore: number;
  }[];
  opponents: unknown[];
  error?: string;
}

export async function runGoProfileArena(config: GoProfileArenaConfig): Promise<GoProfileArenaResult> {
  // A daemon19 candidate can take materially longer than the installed champion.
  // Give each requested game its own budget so a legitimate slow candidate is not
  // misreported as an arena failure halfway through a comparison.
  // Rollout-mode seed waiting replays whole lines at one policy pass per ply,
  // which dominates the arm's runtime — most of all on 19x19, where a game is
  // long and every pass is a full-board evaluation.
  const rolloutFactor = config.seedWait?.mode === "rollout"
    ? Math.max(2, Math.ceil((config.seedWait.rolloutPlies ?? 60) / 10))
    : 1;
  const timeoutMs = (config.profile === "daemon19"
    ? Math.max(900_000, config.games * 20_000)
    : 900_000) * rolloutFactor;
  const run = await runInHeadlessChrome(
    join(import.meta.dir, "webgpu", "entry-profile-arena.ts"),
    timeoutMs,
    { __goArenaConfig: config },
  );
  const result = run.result as GoProfileArenaResult;
  if (!result || result.ok !== true || result.backend !== "webgpu") {
    throw new Error(`WebGPU profile arena failed: ${JSON.stringify(result)}`);
  }
  result.candidateLimit = config.candidateLimit ?? GO_PROFILE_CANDIDATE_LIMITS[config.profile];
  result.candidateLimitSource = config.candidateLimit === undefined ? "profile-default" : "explicit";
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
    throw new Error("usage: bun run tools/go-profile-arena.ts <small5|daemon19> [--games N] "
      + "[--seed N] [--handicap-seed N] [--defense-seed N] [--candidate-limit N] [--opponent NAME]");
  }
  const candidateLimitIndex = Bun.argv.indexOf("--candidate-limit");
  const opponentIndex = Bun.argv.indexOf("--opponent");
  const result = await runGoProfileArena({
    profile,
    games: Math.max(1, Math.floor(numberFlag("--games", profile === "small5" ? 6 : 2))),
    seed: Math.floor(numberFlag("--seed", 918_273)),
    handicapSeed: Math.floor(numberFlag("--handicap-seed", 2_654_435_761)),
    defenseSeed: Math.floor(numberFlag("--defense-seed", 1_013_904_223)),
    ...(candidateLimitIndex < 0 ? {} : {
      candidateLimit: Math.max(1, Math.floor(numberFlag("--candidate-limit", 8))),
    }),
    ...(opponentIndex < 0 ? {} : { opponent: Bun.argv[opponentIndex + 1] as GoRewardOpponent }),
  });
  console.log(JSON.stringify(result, null, 2));
}
