/** Transactionally verify a V9 deployment candidate without installing it.
 *
 * The candidate is exported, the C++ golden fixture is regenerated from that
 * exact full-precision checkpoint, and the production q8 WGSL plus complete-game
 * arena run in Chrome. Champion, artifact, and fixture are always restored.
 *
 * `--decision-parity` additionally replays a traced arena battery through the
 * champion and candidate artifacts at the production candidate limit and
 * reports exact shortlist/action/forecast agreement rates — the full
 * K-decision contract, not policy-only agreement. A lossy student is not
 * expected to agree exactly; the report is the baseline and the paired arena
 * stays the authority.
 */
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runGoProfileArena, type GoArenaProfile, type GoProfileArenaResult } from "./go-profile-arena.ts";
import { runInHeadlessChrome } from "./webgpu/chrome-runner.ts";
import type { GoValueModelArtifact } from "../shared/strategy/go/neural/artifact.ts";
import {
  DEFAULT_GO_ARENA_SEED_LEDGER,
  recordGoArenaSeedUse,
  seedUseFromConfig,
} from "./go-arena-seed-ledger.ts";

const ROOT = join(import.meta.dir, "..");
const candidate = Bun.argv[2];
if (!candidate || !await Bun.file(candidate).exists()) {
  throw new Error("usage: bun run go:compress:verify <candidate.model> [--profile small5|daemon19] [--golden-only] [--value-factor PATH] [--games N] [--seed N] [--handicap-seed N] [--defense-seed N] [--decision-parity [--parity-games N] [--parity-seed N] [--parity-handicap-seed N] [--parity-defense-seed N]]");
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

const profileFlag = stringFlag("--profile") ?? "small5";
if (profileFlag !== "small5" && profileFlag !== "daemon19") {
  throw new Error("--profile must be small5 or daemon19");
}
const profile: GoArenaProfile = profileFlag;
const goldenOnly = Bun.argv.includes("--golden-only");
const champion = join(ROOT, "go-ai", `${profile}-champion.model`);
const artifact = join(ROOT, "shared", "strategy", "go", "neural", "models", `${profile}.ts`);
const fixture = join(ROOT, "tests", "fixtures", "go-value.json");
const originals = {
  champion: await Bun.file(champion).text(),
  artifact: await Bun.file(artifact).text(),
  fixture: await Bun.file(fixture).text(),
};
const config = {
  profile,
  games: Math.max(1, Math.floor(numberFlag("--games", profile === "small5" ? 12 : 4))),
  seed: Math.floor(numberFlag("--seed", 20_260_813)),
  handicapSeed: Math.floor(numberFlag("--handicap-seed", 1_179_139_743)),
  defenseSeed: Math.floor(numberFlag("--defense-seed", 1_013_904_223)),
};
const valueFactor = stringFlag("--value-factor");
if (valueFactor && !await Bun.file(valueFactor).exists()) {
  throw new Error(`value factor ${valueFactor} does not exist`);
}
if (valueFactor && profile !== "small5") {
  throw new Error("--value-factor is supported only for small5");
}

const decisionParity = Bun.argv.includes("--decision-parity");
const scratch = decisionParity ? mkdtempSync(join(tmpdir(), "go-compress-parity-")) : undefined;
const candidateSha = createHash("sha256")
  .update(new Uint8Array(await Bun.file(candidate).arrayBuffer())).digest("hex");
if (!goldenOnly) {
  const seedUse = seedUseFromConfig(config, "screen", [candidateSha]);
  await recordGoArenaSeedUse(seedUse, DEFAULT_GO_ARENA_SEED_LEDGER, false);
  console.log(`arena corpus recorded as ${seedUse.id}; it cannot be reused for an apply gate`);
}

try {
  const championArena = goldenOnly ? undefined : await runGoProfileArena(config);
  let parity: unknown;
  if (decisionParity && scratch) {
    // Both staged modules must exist before the first dynamic import: Bun
    // caches a directory's entries when it first resolves an import from it.
    run(["bun", "run", "tools/go-export-model.ts", champion, profile,
      "--output-module", join(scratch, "champion.ts"), "--constant", "STAGED_GO_MODEL"]);
    run(["bun", "run", "tools/go-export-model.ts", candidate, profile,
      ...(valueFactor ? ["--value-factor", valueFactor] : []),
      "--output-module", join(scratch, "candidate.ts"), "--constant", "STAGED_GO_MODEL"]);
    const championArtifact = (await import(join(scratch, "champion.ts")) as {
      STAGED_GO_MODEL: GoValueModelArtifact }).STAGED_GO_MODEL;
    const candidateArtifact = (await import(join(scratch, "candidate.ts")) as {
      STAGED_GO_MODEL: GoValueModelArtifact }).STAGED_GO_MODEL;
    const parityGames = Math.max(1, Math.floor(numberFlag("--parity-games", 24)));
    const parityRun = await runInHeadlessChrome(
      join(import.meta.dir, "webgpu", "entry-derivative-parity.ts"),
      Math.max(1_800_000, parityGames * 30_000),
      { __goDerivativeParityConfig: {
        profile,
        games: parityGames,
        seed: Math.floor(numberFlag("--parity-seed", 66_666_601)),
        handicapSeed: Math.floor(numberFlag("--parity-handicap-seed", 66_666_602)),
        defenseSeed: Math.floor(numberFlag("--parity-defense-seed", 66_666_603)),
        championArtifact,
        derivativeArtifact: candidateArtifact,
        mode: "report",
      } },
    );
    parity = parityRun.result;
  }
  await Bun.write(champion, Bun.file(candidate));
  run(["bun", "run", "tools/go-export-model.ts", candidate, profile,
    ...(valueFactor ? ["--value-factor", valueFactor] : [])]);
  run(["bun", "run", "tools/go-golden-fixture.ts"]);
  run(["bun", "run", "tools/go-webgpu-test.ts"]);
  const candidateArena = goldenOnly ? undefined : await runGoProfileArena(config);
  console.log(JSON.stringify({
    ok: true,
    backend: "webgpu",
    candidate,
    ...(valueFactor ? { valueFactor } : {}),
    ...(parity !== undefined ? { decisionParity: parity } : {}),
    ...(championArena && candidateArena ? {
      champion: compact(championArena),
      compressed: compact(candidateArena),
      delta: {
        wins: candidateArena.wins - championArena.wins,
        pointDifference: candidateArena.pointDifference - championArena.pointDifference,
        latencyP50Ms: candidateArena.latencyMs.p50 - championArena.latencyMs.p50,
        latencyP95Ms: candidateArena.latencyMs.p95 - championArena.latencyMs.p95,
      },
    } : { goldenOnly: true }),
    note: "verification only; the candidate checkpoint was not installed",
  }, null, 2));
} finally {
  await Bun.write(champion, originals.champion);
  await Bun.write(artifact, originals.artifact);
  await Bun.write(fixture, originals.fixture);
  if (scratch) rmSync(scratch, { recursive: true, force: true });
}
