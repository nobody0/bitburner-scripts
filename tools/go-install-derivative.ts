/** Install a champion-bound deployment derivative for live play.
 *
 * A derivative is a transformed export of the installed champion — never a
 * new champion. Two transforms are supported:
 *
 * - daemon19 `strip-neutral-value-v1` (lossless): the champion's exactly-zero
 *   value head is stripped. Gate ladder: exact decision parity over a traced
 *   battery (max logit diff 0), the full WGSL golden gate, and a paired arena
 *   that must complete game-for-game identically.
 * - small5 `structured-distill-v1` (lossy): a distilled student checkpoint
 *   (`--candidate`) is retained under go-ai/derivatives/ and exported with
 *   the champion binding. Gate ladder: decision parity in report mode (the
 *   full production-K decision contract, reported not exactness-gated), the
 *   golden fixture regenerated from the student's own full-precision
 *   checkpoint plus the WGSL gate, and a paired arena the derivative must
 *   win lexicographically (wins first, Power/turn on an exact win tie, then
 *   fewer turns).
 *
 * The module and fixture are restored on any failure or without --apply; the
 * champion checkpoint is never written. A later `go:promote --apply`
 * deliberately replaces the derivative with the new champion's full export.
 *
 * Usage:
 *   bun run go:derivative:install daemon19 [--games N] [--parity-games N]
 *     [--seed N --handicap-seed N --defense-seed N]
 *     [--parity-seed N --parity-handicap-seed N --parity-defense-seed N]
 *     [--seed-ledger PATH] [--apply]
 *   bun run go:derivative:install small5 --candidate <student.model> [same flags]
 */
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { runGoProfileArena, type GoProfileArenaResult } from "./go-profile-arena.ts";
import { runInHeadlessChrome } from "./webgpu/chrome-runner.ts";
import { pairedPromotionEvidence } from "./go-promotion-statistics.ts";
import {
  DEFAULT_GO_ARENA_SEED_LEDGER,
  recordGoArenaSeedUse,
  seedUseFromConfig,
} from "./go-arena-seed-ledger.ts";
import type { GoValueModelArtifact } from "../shared/strategy/go/neural/artifact.ts";
import { loadGoValueWeights } from "../shared/strategy/go/neural/artifact.ts";

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

function run(step: string[]): void {
  const result = Bun.spawnSync(step, { cwd: ROOT, stdout: "inherit", stderr: "inherit" });
  if (result.exitCode !== 0) throw new Error(`step failed: ${step.join(" ")}`);
}

async function sha256File(path: string): Promise<string> {
  return createHash("sha256")
    .update(new Uint8Array(await Bun.file(path).arrayBuffer())).digest("hex");
}

function exportStagedModule(checkpoint: string, profile: string, scratch: string,
  name: string, extraFlags: readonly string[]): string {
  const module = join(scratch, `${name}.ts`);
  run(["bun", "run", "tools/go-export-model.ts", checkpoint, profile, ...extraFlags,
    "--output-module", module, "--constant", "STAGED_GO_MODEL"]);
  return module;
}

// Bun caches a directory's entries when it first resolves an import from it,
// so every staged module must exist before the first dynamic import.
async function importStagedModule(module: string):
  Promise<{ artifact: GoValueModelArtifact; moduleText: string }> {
  const { STAGED_GO_MODEL } = await import(module) as { STAGED_GO_MODEL: GoValueModelArtifact };
  return { artifact: STAGED_GO_MODEL, moduleText: await Bun.file(module).text() };
}

function compactArm(result: GoProfileArenaResult) {
  return {
    wins: result.wins,
    games: result.games,
    points: result.pointDifference,
    powerPerTurn: result.meanPowerPerTurn,
    meanTurns: result.meanTurns,
    latencyMs: result.latencyMs,
  };
}

const profileArg = Bun.argv[2];
if (profileArg !== "daemon19" && profileArg !== "small5") {
  throw new Error("usage: bun run go:derivative:install <daemon19|small5> [--candidate student.model] [flags] [--apply]");
}
const profile: "daemon19" | "small5" = profileArg === "daemon19" ? "daemon19" : "small5";
const transform = profile === "daemon19" ? "strip-neutral-value-v1" : "structured-distill-v1";
const applyRequested = Bun.argv.includes("--apply");
const champion = join(ROOT, "go-ai", `${profile}-champion.model`);
const moduleTarget = join(ROOT, "shared", "strategy", "go", "neural", "models", `${profile}.ts`);
const fixtureTarget = join(ROOT, "tests", "fixtures", "go-value.json");
const championSha = await sha256File(champion);
const seedLedgerPath = stringFlag("--seed-ledger", DEFAULT_GO_ARENA_SEED_LEDGER);

const candidateFlag = stringFlag("--candidate", "");
if (profile === "small5" && !candidateFlag) {
  throw new Error("small5 structured-distill install requires --candidate <student.model>");
}
if (profile === "daemon19" && candidateFlag) {
  throw new Error("the daemon19 strip transform derives from the champion; --candidate is invalid");
}

const arenaConfig = {
  profile,
  games: Math.max(1, Math.floor(numberFlag("--games", profile === "daemon19" ? 128 : 384))),
  seed: Math.floor(numberFlag("--seed", 33_333_301)),
  handicapSeed: Math.floor(numberFlag("--handicap-seed", 33_333_302)),
  defenseSeed: Math.floor(numberFlag("--defense-seed", 33_333_303)),
};
const parityConfig = {
  profile,
  games: Math.max(1, Math.floor(numberFlag("--parity-games", profile === "daemon19" ? 40 : 64))),
  seed: Math.floor(numberFlag("--parity-seed", 44_444_401)),
  handicapSeed: Math.floor(numberFlag("--parity-handicap-seed", 44_444_402)),
  defenseSeed: Math.floor(numberFlag("--parity-defense-seed", 44_444_403)),
};

const originalModule = await Bun.file(moduleTarget).text();
const originalFixture = await Bun.file(fixtureTarget).text();
const scratch = mkdtempSync(join(tmpdir(), "go-derivative-install-"));
let keepDerivative = false;
try {
  // For small5, retain the student under a stable repo path first: the
  // installed module's `source` must outlive this process so golden and
  // `go:export --check` can regenerate from it.
  let derivativeCheckpoint = champion;
  if (profile === "small5") {
    const studentSha = await sha256File(candidateFlag);
    const retainedDir = join(ROOT, "go-ai", "derivatives");
    mkdirSync(retainedDir, { recursive: true });
    derivativeCheckpoint = join(retainedDir, `small5-${studentSha.slice(0, 12)}.model`);
    await Bun.write(derivativeCheckpoint, Bun.file(candidateFlag));
  }
  const championModule = exportStagedModule(champion, profile, scratch, "champion", []);
  const derivativeModule = exportStagedModule(derivativeCheckpoint, profile, scratch, "derivative",
    profile === "daemon19" ? ["--strip-neutral-value"] : ["--derivative-of", champion]);
  const championExport = await importStagedModule(championModule);
  const derivativeExport = await importStagedModule(derivativeModule);
  const derivative = derivativeExport.artifact;
  if (derivative.derivative?.championSha256 !== championSha
    || derivative.derivative.transform !== transform) {
    throw new Error("staged derivative is not bound to the installed champion checkpoint");
  }

  // Burn both corpora before any evaluation.
  const arenaUse = seedUseFromConfig(arenaConfig,
    applyRequested ? "derivative-apply" : "derivative-dry-run", [derivative.payloadSha256]);
  await recordGoArenaSeedUse(arenaUse, seedLedgerPath, applyRequested);
  const parityUse = seedUseFromConfig(parityConfig, "screen", [derivative.payloadSha256]);
  await recordGoArenaSeedUse(parityUse, seedLedgerPath, false);
  console.log(`corpora recorded: arena ${arenaUse.id}, parity battery ${parityUse.id}`);

  // 1. Decision parity over a traced battery: exact for the lossless strip,
  // report mode for a lossy student.
  const parityMode = profile === "daemon19" ? "exact" : "report";
  const parityRun = await runInHeadlessChrome(
    join(import.meta.dir, "webgpu", "entry-derivative-parity.ts"),
    Math.max(1_800_000, parityConfig.games * 30_000),
    { __goDerivativeParityConfig: {
      ...parityConfig,
      championArtifact: championExport.artifact,
      derivativeArtifact: derivative,
      mode: parityMode,
    } },
  );
  const parity = parityRun.result as {
    ok: boolean; states: number; exact: boolean; logitMaxAbsDiff: number;
    actionAgreement: number; finalistAgreement: number; forecastAgreement: number;
    examples: unknown[]; error?: string;
  };
  console.log(`parity (${parityMode}): ${parity.states} states, exact=${parity.exact}, `
    + `action agreement=${parity.actionAgreement?.toFixed?.(4)}, `
    + `logit max |diff|=${parity.logitMaxAbsDiff}`);
  if (!parity.ok || (parityMode === "exact" && !parity.exact)) {
    throw new Error(`derivative decision parity failed: ${JSON.stringify(parity.examples ?? parity.error)}`);
  }

  // 2. Champion arm on the still-installed module, then stage the derivative
  // and run the full export/golden/WGSL gates against it. The fixture is
  // regenerated only for a lossy transform, whose deployed weights differ
  // from the champion's.
  const championArena = await runGoProfileArena(arenaConfig);
  await Bun.write(moduleTarget, derivativeExport.moduleText.replace(
    "STAGED_GO_MODEL", `${profile.toUpperCase()}_GO_MODEL`));
  if (transform === "structured-distill-v1") {
    run(["bun", "run", "tools/go-golden-fixture.ts"]);
  }
  run(["bun", "run", "tools/go-export-model.ts", "--check"]);
  run(["bun", "run", "tools/go-webgpu-test.ts"]);

  // 3. Derivative arm on the identical corpus.
  const derivativeArena = await runGoProfileArena(arenaConfig);
  const identical = championArena.gameMetrics.length === derivativeArena.gameMetrics.length
    && championArena.gameMetrics.every((game, index) => {
      const other = derivativeArena.gameMetrics[index]!;
      return game.opponent === other.opponent && game.seed === other.seed
        && game.won === other.won && game.power === other.power
        && game.turns === other.turns && game.blackScore === other.blackScore;
    });
  const evidence = pairedPromotionEvidence(profile,
    derivativeArena.gameMetrics, championArena.gameMetrics);
  console.log(`arena: champion ${championArena.wins}/${championArena.games}, `
    + `derivative ${derivativeArena.wins}/${derivativeArena.games}, `
    + `game-for-game identical=${identical}`);
  if (transform === "strip-neutral-value-v1" && !identical) {
    throw new Error("lossless derivative diverged from the champion in the paired arena");
  }
  if (transform === "structured-distill-v1") {
    // Wins first; Power/turn breaks an exact win tie; fewer turns break the
    // next tie. The derivative must not be lexicographically worse.
    const lexicographicPass = derivativeArena.wins > championArena.wins
      || (derivativeArena.wins === championArena.wins
        && (derivativeArena.meanPowerPerTurn > championArena.meanPowerPerTurn
          || (derivativeArena.meanPowerPerTurn === championArena.meanPowerPerTurn
            && derivativeArena.meanTurns <= championArena.meanTurns)));
    if (!lexicographicPass) {
      throw new Error(`lossy derivative failed the lexicographic arena gate: `
        + `${derivativeArena.wins}/${derivativeArena.games} wins versus champion `
        + `${championArena.wins}/${championArena.games}, Power/turn `
        + `${derivativeArena.meanPowerPerTurn} versus ${championArena.meanPowerPerTurn}`);
    }
  }

  const summary = {
    schema: "go-deployment-derivative-summary-v1",
    profile,
    transform,
    championSha256: championSha,
    ...(profile === "small5" ? {
      derivativeCheckpoint: relative(ROOT, derivativeCheckpoint),
      derivativeCheckpointSha256: derivative.sourceSha256,
    } : {}),
    derivativePayloadSha256: derivative.payloadSha256,
    bytes: {
      fullPrecisionChampionCheckpoint: (await Bun.file(champion).arrayBuffer()).byteLength,
      ...(profile === "small5" ? {
        fullPrecisionDerivativeCheckpoint:
          (await Bun.file(derivativeCheckpoint).arrayBuffer()).byteLength,
      } : {}),
      fullArtifactPayload: championExport.artifact.byteLength,
      derivativePayload: derivative.byteLength,
      fullModule: championExport.moduleText.length,
      derivativeModule: derivativeExport.moduleText.length,
    },
    parameters: {
      full: loadGoValueWeights(championExport.artifact).flat.length,
      retained: loadGoValueWeights(derivative).flat.length,
    },
    decisionParity: parity,
    pairedArena: {
      seedUseId: arenaUse.id,
      config: arenaConfig,
      champion: compactArm(championArena),
      derivative: compactArm(derivativeArena),
      gameForGameIdentical: identical,
      evidence: {
        favorableWinFlips: evidence.favorableWinFlips,
        unfavorableWinFlips: evidence.unfavorableWinFlips,
        oneSidedWinPValue: evidence.oneSidedWinPValue,
        powerPerTurnLower95: evidence.powerPerTurnLower95,
        fewerTurnsLower95: evidence.fewerTurnsLower95,
      },
    },
    applied: applyRequested,
    recordedAt: new Date().toISOString(),
  };
  const summaryDir = join(ROOT, "go-ai", "derivatives");
  mkdirSync(summaryDir, { recursive: true });
  const summaryPath = join(summaryDir,
    `${profile}-${championSha.slice(0, 12)}-${transform === "strip-neutral-value-v1" ? "strip" : "distill"}-summary.json`);
  await Bun.write(summaryPath, `${JSON.stringify(summary, null, 2)}\n`);
  console.log(`summary written to ${relative(ROOT, summaryPath)}`);

  if (applyRequested) {
    keepDerivative = true;
    console.log(`installed ${profile} ${transform} derivative `
      + `(payload ${derivative.byteLength.toLocaleString()} B, champion ${championSha})`);
  } else {
    console.log("dry run passed; module and fixture restored. Re-run with --apply and fresh seeds to install.");
  }
} finally {
  if (!keepDerivative) {
    await Bun.write(moduleTarget, originalModule);
    await Bun.write(fixtureTarget, originalFixture);
  }
  rmSync(scratch, { recursive: true, force: true });
}
