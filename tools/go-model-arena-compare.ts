/** Per-opponent paired arena between the installed small5 module and an
 * arbitrary reference checkpoint (normally the full-f32 champion).
 *
 * `go:derivative:install` proves a derivative aggregate-wise; this tool answers
 * the per-opponent question that gate cannot: does the deployed artifact hold
 * the champion's win rate against each individual opponent, in particular the
 * hardest one (Illuminati)? Both arms play the identical corpus through the
 * production selector, so any difference is the model.
 *
 * The reference arm is staged by exporting the reference checkpoint over the
 * installed module and is restored from an in-memory copy afterwards, including
 * on failure — the installed module is byte-identical when this tool exits.
 *
 * Usage:
 *   bun run go:arena:compare --reference go-ai/small5-champion.model
 *     [--games N] [--seed N --handicap-seed N --defense-seed N] [--out FILE]
 */
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { runGoProfileArena, type GoProfileArenaResult } from "./go-profile-arena.ts";
import { recordGoArenaSeedUse, seedUseFromConfig } from "./go-arena-seed-ledger.ts";

const ROOT = join(import.meta.dir, "..");
const MODULE = join(ROOT, "shared", "strategy", "go", "neural", "models", "small5.ts");

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

function run(command: string[]): void {
  const result = Bun.spawnSync(command, { cwd: ROOT, stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) {
    throw new Error(`${command.join(" ")} failed: ${result.stderr.toString()}`);
  }
}

interface OpponentSummary {
  opponent: string;
  games: number;
  installedWins: number;
  referenceWins: number;
  installedWinRate: number;
  referenceWinRate: number;
  /** Installed win rate as a fraction of the reference's. */
  retention: number;
  favorableWinFlips: number;
  unfavorableWinFlips: number;
  installedPowerPerTurn: number;
  referencePowerPerTurn: number;
}

function perOpponent(
  installed: GoProfileArenaResult,
  reference: GoProfileArenaResult,
): OpponentSummary[] {
  const byOpponent = new Map<string, { installedWins: number; referenceWins: number; games: number;
    favorable: number; unfavorable: number; installedPower: number; referencePower: number;
    installedTurns: number; referenceTurns: number }>();
  for (let index = 0; index < installed.gameMetrics.length; index++) {
    const left = installed.gameMetrics[index]!;
    const right = reference.gameMetrics[index]!;
    if (left.opponent !== right.opponent || left.seed !== right.seed) {
      throw new Error(`paired corpora diverged at game ${index}`);
    }
    const entry = byOpponent.get(left.opponent) ?? { installedWins: 0, referenceWins: 0, games: 0,
      favorable: 0, unfavorable: 0, installedPower: 0, referencePower: 0,
      installedTurns: 0, referenceTurns: 0 };
    entry.games++;
    if (left.won) entry.installedWins++;
    if (right.won) entry.referenceWins++;
    if (left.won && !right.won) entry.favorable++;
    if (!left.won && right.won) entry.unfavorable++;
    entry.installedPower += left.power;
    entry.referencePower += right.power;
    entry.installedTurns += left.turns;
    entry.referenceTurns += right.turns;
    byOpponent.set(left.opponent, entry);
  }
  return [...byOpponent].map(([opponent, entry]) => ({
    opponent,
    games: entry.games,
    installedWins: entry.installedWins,
    referenceWins: entry.referenceWins,
    installedWinRate: entry.installedWins / entry.games,
    referenceWinRate: entry.referenceWins / entry.games,
    retention: entry.referenceWins === 0 ? 1 : entry.installedWins / entry.referenceWins,
    favorableWinFlips: entry.favorable,
    unfavorableWinFlips: entry.unfavorable,
    installedPowerPerTurn: entry.installedPower / Math.max(1, entry.installedTurns),
    referencePowerPerTurn: entry.referencePower / Math.max(1, entry.referenceTurns),
  })).sort((left, right) => left.opponent.localeCompare(right.opponent));
}

const referencePath = stringFlag("--reference", "go-ai/small5-champion.model");
const arenaConfig = {
  profile: "small5" as const,
  games: Math.max(1, Math.floor(numberFlag("--games", 384))),
  seed: Math.floor(numberFlag("--seed", 0)),
  handicapSeed: Math.floor(numberFlag("--handicap-seed", 0)),
  defenseSeed: Math.floor(numberFlag("--defense-seed", 0)),
};
for (const [name, value] of Object.entries(arenaConfig)) {
  if (typeof value === "number" && value === 0) throw new Error(`--${name} must be an explicit fresh value`);
}

// Burn the corpus before evaluating it, exactly like every other arena gate.
const use = seedUseFromConfig(arenaConfig, "screen", []);
await recordGoArenaSeedUse(use, undefined, true);
console.log(`corpus recorded: ${use.id}`);

const installedModule = await readFile(MODULE, "utf8");
const installedSha = createHash("sha256").update(installedModule).digest("hex");
let installed: GoProfileArenaResult;
let reference: GoProfileArenaResult;
try {
  console.log(`installed arm: ${arenaConfig.games} games per opponent`);
  installed = await runGoProfileArena(arenaConfig);
  console.log(`installed: ${installed.wins}/${installed.games}`);
  run(["bun", "run", "tools/go-export-model.ts", referencePath, "small5"]);
  console.log(`reference arm (${referencePath})`);
  reference = await runGoProfileArena(arenaConfig);
  console.log(`reference: ${reference.wins}/${reference.games}`);
} finally {
  await writeFile(MODULE, installedModule);
  const restored = createHash("sha256").update(await readFile(MODULE, "utf8")).digest("hex");
  if (restored !== installedSha) throw new Error("failed to restore the installed small5 module");
  console.log("installed module restored byte-identically");
}

const opponents = perOpponent(installed, reference);
const report = {
  schema: 1,
  recordedAt: new Date().toISOString(),
  seedUseId: use.id,
  config: arenaConfig,
  reference: referencePath,
  installed: { wins: installed.wins, games: installed.games, winRate: installed.winRate,
    powerPerTurn: installed.meanPowerPerTurn, latencyMs: installed.latencyMs },
  referenceArm: { wins: reference.wins, games: reference.games, winRate: reference.winRate,
    powerPerTurn: reference.meanPowerPerTurn, latencyMs: reference.latencyMs },
  opponents,
};
const outPath = stringFlag("--out", join(ROOT, "go-ai", "derivatives",
  `small5-arena-compare-${arenaConfig.seed}.json`));
await Bun.write(outPath, `${JSON.stringify(report, null, 2)}\n`);
for (const entry of opponents) {
  console.log(`${entry.opponent}: installed ${entry.installedWins}/${entry.games} `
    + `(${(entry.installedWinRate * 100).toFixed(1)}%) vs reference ${entry.referenceWins}/${entry.games} `
    + `(${(entry.referenceWinRate * 100).toFixed(1)}%), retention ${(entry.retention * 100).toFixed(2)}%, `
    + `flips +${entry.favorableWinFlips}/-${entry.unfavorableWinFlips}`);
}
console.log(`report written to ${outPath}`);
