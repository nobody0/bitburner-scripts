/** Transactionally verify a compressed small5 V9 checkpoint without installing it.
 *
 * The candidate is exported, the C++ golden fixture is regenerated from that
 * exact full-precision checkpoint, and the production q8 WGSL plus complete-game
 * arena run in Chrome. Champion, artifact, and fixture are always restored.
 */
import { join } from "node:path";
import { runGoProfileArena, type GoProfileArenaResult } from "./go-profile-arena.ts";

const ROOT = join(import.meta.dir, "..");
const candidate = Bun.argv[2];
if (!candidate || !await Bun.file(candidate).exists()) {
  throw new Error("usage: bun run go:compress:verify <small5-student.model> [--value-factor PATH] [--games N] [--seed N]");
}

function stringFlag(name: string): string | undefined {
  const index = Bun.argv.indexOf(name);
  if (index < 0) return undefined;
  const value = Bun.argv[index + 1];
  if (!value) throw new Error(`${name} requires a path`);
  return value;
}

function numberFlag(name: string, fallback: number): number {
  const index = Bun.argv.indexOf(name);
  if (index < 0) return fallback;
  const value = Number(Bun.argv[index + 1]);
  if (!Number.isFinite(value)) throw new Error(`${name} requires a number`);
  return value;
}

function run(command: string[]): void {
  const process = Bun.spawnSync(command, { cwd: ROOT, stdout: "inherit", stderr: "inherit" });
  if (process.exitCode !== 0) throw new Error(`step failed: ${command.join(" ")}`);
}

function compact(result: GoProfileArenaResult): object {
  return {
    games: result.games,
    wins: result.wins,
    winRate: result.winRate,
    pointDifference: result.pointDifference,
    latencyMs: result.latencyMs,
    meanFinalists: result.meanFinalists,
  };
}

const champion = join(ROOT, "go-ai", "small5-champion.model");
const artifact = join(ROOT, "shared", "strategy", "go", "neural", "models", "small5.ts");
const fixture = join(ROOT, "tests", "fixtures", "go-value.json");
const originals = {
  champion: await Bun.file(champion).text(),
  artifact: await Bun.file(artifact).text(),
  fixture: await Bun.file(fixture).text(),
};
const config = {
  profile: "small5" as const,
  games: Math.max(1, Math.floor(numberFlag("--games", 12))),
  seed: Math.floor(numberFlag("--seed", 20_260_813)),
};
const valueFactor = stringFlag("--value-factor");
if (valueFactor && !await Bun.file(valueFactor).exists()) {
  throw new Error(`value factor ${valueFactor} does not exist`);
}

try {
  const championArena = await runGoProfileArena(config);
  await Bun.write(champion, Bun.file(candidate));
  run(["bun", "run", "tools/go-export-model.ts", candidate, "small5",
    ...(valueFactor ? ["--value-factor", valueFactor] : [])]);
  run(["bun", "run", "tools/go-golden-fixture.ts"]);
  run(["bun", "run", "tools/go-webgpu-test.ts"]);
  const candidateArena = await runGoProfileArena(config);
  console.log(JSON.stringify({
    ok: true,
    backend: "webgpu",
    candidate,
    ...(valueFactor ? { valueFactor } : {}),
    champion: compact(championArena),
    compressed: compact(candidateArena),
    delta: {
      wins: candidateArena.wins - championArena.wins,
      pointDifference: candidateArena.pointDifference - championArena.pointDifference,
      latencyP50Ms: candidateArena.latencyMs.p50 - championArena.latencyMs.p50,
      latencyP95Ms: candidateArena.latencyMs.p95 - championArena.latencyMs.p95,
    },
    note: "measurement only; the compressed checkpoint was not installed",
  }, null, 2));
} finally {
  await Bun.write(champion, originals.champion);
  await Bun.write(artifact, originals.artifact);
  await Bun.write(fixture, originals.fixture);
}
