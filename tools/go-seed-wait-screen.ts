/** Paired screen for the one-cycle seed wait.
 *
 * White's reply is seeded from the tick we dispatch in, so a position whose
 * every continuation is predicted to lose at this tick may have a winning one
 * at the next. This screen plays an identical corpus with the wait disabled
 * and enabled (at most one wait per turn) and reports wins, Power per turn,
 * how many turns actually waited, and decision latency.
 *
 * The policy-only contract reports no win probability — the daemon19 value
 * head is neutral by construction, so a daemon19 arm is expected to measure
 * zero waits and identical games; the screen verifies that expectation.
 *
 * Usage:
 *   bun run go:seedwait:screen --profile small5 [--opponent Illuminati]
 *     --games 384 --seed N --handicap-seed N --defense-seed N
 *     [--mode value|rollout] [--loss-threshold 0.5] [--minimum-gain 0.05]
 *     [--rollout-plies 60] [--out FILE]
 */
import { join } from "node:path";
import { runGoProfileArena, type GoProfileArenaResult } from "./go-profile-arena.ts";
import { recordGoArenaSeedUse, seedUseFromConfig } from "./go-arena-seed-ledger.ts";
import type { GoSeedWaitV1 } from "../shared/strategy/go/neural/engine.ts";

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

const requestedProfile = stringFlag("--profile", "small5");
if (requestedProfile !== "small5" && requestedProfile !== "daemon19") {
  throw new Error("--profile must be small5 or daemon19");
}
const profile: "small5" | "daemon19" = requestedProfile;
const opponentIndex = Bun.argv.indexOf("--opponent");
const base = {
  profile,
  games: Math.max(1, Math.floor(numberFlag("--games", 384))),
  seed: Math.floor(numberFlag("--seed", 0)),
  handicapSeed: Math.floor(numberFlag("--handicap-seed", 0)),
  defenseSeed: Math.floor(numberFlag("--defense-seed", 0)),
  ...(opponentIndex >= 0 ? { opponent: Bun.argv[opponentIndex + 1]! } : {}),
};
for (const [name, value] of Object.entries(base)) {
  if (typeof value === "number" && value === 0) throw new Error(`--${name} must be an explicit fresh value`);
}
const mode = stringFlag("--mode", "value");
if (mode !== "value" && mode !== "rollout") throw new Error("--mode must be value or rollout");
const seedWait: GoSeedWaitV1 = {
  mode,
  lossThreshold: numberFlag("--loss-threshold", 0.5),
  minimumGain: numberFlag("--minimum-gain", 0.05),
  rolloutPlies: Math.max(1, Math.floor(numberFlag("--rollout-plies", 60))),
};

const use = seedUseFromConfig(base, "screen", []);
await recordGoArenaSeedUse(use, undefined, true);
console.log(`corpus recorded: ${use.id}`);
console.log(`${base.opponent ?? "full field"}: ${base.games} games per arm, ${mode} detector`
  + (mode === "value"
    ? `, wait below ${seedWait.lossThreshold} win, requiring +${seedWait.minimumGain}`
    : `, ${seedWait.rolloutPlies} ply rollouts`));

const control = await runGoProfileArena({ ...base, seedWait: null });
console.log(`control:  ${control.wins}/${control.games} (${(control.winRate * 100).toFixed(1)}%), `
  + `P/t ${control.meanPowerPerTurn.toFixed(4)}, p50/p95 ${control.latencyMs.p50}/${control.latencyMs.p95} ms`);
const waited = await runGoProfileArena({ ...base, seedWait });
console.log(`seed wait: ${waited.wins}/${waited.games} (${(waited.winRate * 100).toFixed(1)}%), `
  + `P/t ${waited.meanPowerPerTurn.toFixed(4)}, p50/p95 ${waited.latencyMs.p50}/${waited.latencyMs.p95} ms, `
  + `${waited.seedWaits} waited turns`);

const flips = { favorable: 0, unfavorable: 0 };
const perOpponent: Record<string, { games: number; control: number; waited: number }> = {};
waited.gameMetrics.forEach((game, index) => {
  const other = control.gameMetrics[index]!;
  if (game.opponent !== other.opponent || game.seed !== other.seed) {
    throw new Error(`paired corpora diverged at game ${index}`);
  }
  if (game.won && !other.won) flips.favorable++;
  if (!game.won && other.won) flips.unfavorable++;
  const entry = perOpponent[game.opponent] ??= { games: 0, control: 0, waited: 0 };
  entry.games++;
  if (other.won) entry.control++;
  if (game.won) entry.waited++;
});
console.log(`paired flips +${flips.favorable}/-${flips.unfavorable}`);
for (const [opponent, entry] of Object.entries(perOpponent)) {
  console.log(`  ${opponent}: ${entry.control}/${entry.games} -> ${entry.waited}/${entry.games}`);
}

const compact = (result: GoProfileArenaResult) => ({
  wins: result.wins, games: result.games, winRate: result.winRate,
  powerPerTurn: result.meanPowerPerTurn, meanTurns: result.meanTurns,
  latencyMs: result.latencyMs, seedWaits: result.seedWaits,
});
const outPath = stringFlag("--out", join(ROOT, "go-ai", "derivatives",
  `${profile}-seed-wait-screen-${base.seed}.json`));
await Bun.write(outPath, `${JSON.stringify({
  schema: 1,
  recordedAt: new Date().toISOString(),
  seedUseId: use.id,
  config: { ...base, seedWait },
  control: compact(control),
  waited: compact(waited),
  flips,
  perOpponent,
}, null, 2)}\n`);
console.log(`screen written to ${outPath}`);
