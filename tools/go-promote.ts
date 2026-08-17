/** V9-only promotion gate.
 *
 * Champion and candidate are exported in turn and play the same fixed corpus
 * through the production WGSL backend in Chrome. CPU gameplay inference is
 * deliberately unsupported: it is too slow for iteration and does not model
 * the deployed runtime. On apply, the full-precision checkpoint becomes the
 * champion, the q8 artifact is retained, and C++ champion -> WebGPU numerical
 * agreement is regenerated and checked transactionally.
 */
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { DAEMON19_GO_MODEL } from "../shared/strategy/go/neural/models/daemon19.ts";
import { SMALL5_GO_MODEL } from "../shared/strategy/go/neural/models/small5.ts";
import { runGoProfileArena, type GoArenaProfile, type GoProfileArenaResult } from "./go-profile-arena.ts";
import { GO_PROFILE_CANDIDATE_LIMITS } from "../shared/strategy/go/neural/engine.ts";
import { goArenaSeeds } from "../sim/go-arena.ts";
import {
  MINIMUM_PROMOTION_GAMES_PER_OPPONENT,
  pairedPromotionEvidence,
} from "./go-promotion-statistics.ts";
import {
  DEFAULT_GO_ARENA_SEED_LEDGER,
  recordGoArenaSeedUse,
  seedUseFromConfig,
} from "./go-arena-seed-ledger.ts";

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
  if (!value) throw new Error(`${name} requires a path`);
  return value;
}

async function sha256(path: string): Promise<string> {
  return createHash("sha256").update(new Uint8Array(await Bun.file(path).arrayBuffer())).digest("hex");
}

async function magic(path: string): Promise<string> {
  return (await Bun.file(path).slice(0, 64).text()).trimStart().split(/\s+/, 1)[0] ?? "";
}

const V9_MAGICS = [
  "bitburner-go-value-v9",
  "bitburner-go-value-v9-global-policy-v1",
  "bitburner-go-value-v9-tactical-global-policy-v1",
] as const;

function isV9Magic(value: string): boolean {
  return (V9_MAGICS as readonly string[]).includes(value);
}

function run(step: string[]): void {
  const result = Bun.spawnSync(step, { cwd: ROOT, stdout: "inherit", stderr: "inherit" });
  if (result.exitCode !== 0) throw new Error(`step failed: ${step.join(" ")}`);
}

function printArena(label: string, result: GoProfileArenaResult): void {
  console.log(`${label.padEnd(9)} ${result.wins}/${result.games} wins, `
    + `${result.pointDifference >= 0 ? "+" : ""}${result.pointDifference.toFixed(1)} points, `
    + `${result.meanPowerPerTurn} Power/turn, ${result.meanTurns} mean turns, `
    + `${result.latencyMs.p50}/${result.latencyMs.p95} ms p50/p95, `
    + `${result.meanFinalists} mean finalists [${result.backend}]`);
}

const [profileArg, candidate] = [Bun.argv[2], Bun.argv[3]];
if (profileArg !== "small5" && profileArg !== "daemon19") {
  throw new Error("usage: bun run go:promote <small5|daemon19> <candidate.model> [--games N] [--seed N] [--handicap-seed N] [--defense-seed N] [--candidate-limit N] [--seed-ledger PATH] [--summary PATH] [--apply]");
}
const profile: GoArenaProfile = profileArg;
if (!candidate || !await Bun.file(candidate).exists()) throw new Error(`candidate ${candidate ?? "(missing)"} does not exist`);
const candidateMagic = await magic(candidate);
if (!isV9Magic(candidateMagic)) {
  throw new Error("promotion accepts V9 checkpoints only");
}

const champion = join(ROOT, "go-ai", `${profile}-champion.model`);
const artifact = join(ROOT, "shared", "strategy", "go", "neural", "models", `${profile}.ts`);
const fixture = join(ROOT, "tests", "fixtures", "go-value.json");
if (!isV9Magic(await magic(champion))) {
  throw new Error(`installed ${profile} champion is not V9`);
}

const summaryPath = stringFlag("--summary", join(dirname(candidate), "summary.json"));
if (!await Bun.file(summaryPath).exists()) throw new Error(`missing V9 training summary ${summaryPath}`);
const summary = await Bun.file(summaryPath).json() as {
  profile?: string; modelSha256?: string; cppParityRelativeError?: number;
  shortlistDataAllowed?: boolean; shortlistGate?: unknown;
};
const candidateHash = await sha256(candidate);
if (summary.profile !== profile || summary.modelSha256 !== candidateHash) {
  throw new Error("V9 summary does not identify this profile and checkpoint");
}
if (!Number.isFinite(summary.cppParityRelativeError)
  || summary.cppParityRelativeError! > 2e-4) {
  throw new Error("V9 summary does not prove C++ checkpoint parity");
}
if (!summary.shortlistDataAllowed) {
  console.warn(`diagnostic: exhaustive shortlist data gate failed: ${JSON.stringify(summary.shortlistGate ?? {})}`);
  console.warn("this checkpoint must not generate learned-shortlist training data; promotion remains arena-owned");
}

const installedArtifact = profile === "small5" ? SMALL5_GO_MODEL : DAEMON19_GO_MODEL;
const championHash = await sha256(champion);
// A deployment derivative stays bound to its champion: the module may hold a
// transformed payload, but its championSha256 must still name the installed
// champion checkpoint this promotion measures against.
const championBinding = installedArtifact.derivative?.championSha256 ?? installedArtifact.sourceSha256;
if (installedArtifact.topology !== "bitburner-go-value-v9" || championBinding !== championHash) {
  throw new Error(`${profile} artifact is not exported from the installed V9 champion`);
}

const minimumApplyGames = MINIMUM_PROMOTION_GAMES_PER_OPPONENT[profile];
const applyRequested = Bun.argv.includes("--apply");
const seedWasExplicit = Bun.argv.includes("--seed");
const handicapSeedWasExplicit = Bun.argv.includes("--handicap-seed");
const defenseSeedWasExplicit = Bun.argv.includes("--defense-seed");
const arenaConfig = {
  profile,
  games: Math.max(1, Math.floor(numberFlag("--games", minimumApplyGames))),
  seed: Math.floor(numberFlag("--seed", profile === "small5" ? 10_992_001 : 7_193_001)),
  handicapSeed: Math.floor(numberFlag("--handicap-seed", profile === "small5" ? 1_909_821_719 : 3_265_482_731)),
  defenseSeed: Math.floor(numberFlag("--defense-seed", profile === "small5" ? 2_779_096_653 : 1_013_904_223)),
  ...(Bun.argv.includes("--candidate-limit") ? {
    candidateLimit: Math.max(1, Math.floor(numberFlag("--candidate-limit", 8))),
  } : {}),
};
const effectiveSeed = goArenaSeeds(1, arenaConfig.seed)[0]!;
if (applyRequested && arenaConfig.games < minimumApplyGames) {
  throw new Error(`--apply requires at least ${minimumApplyGames} game(s) per opponent`);
}
if (applyRequested && !seedWasExplicit) {
  throw new Error("--apply requires an explicit fresh --seed that was not used to screen or train the candidate");
}
if (applyRequested && !handicapSeedWasExplicit) {
  throw new Error("--apply requires an explicit fresh --handicap-seed that was not used to screen or train the candidate");
}
if (applyRequested && !defenseSeedWasExplicit) {
  throw new Error("--apply requires an explicit fresh --defense-seed that was not used to screen or train the candidate");
}
if (candidateHash === championHash) throw new Error("candidate is byte-identical to the installed champion");
const seedLedgerPath = stringFlag("--seed-ledger", DEFAULT_GO_ARENA_SEED_LEDGER);
const seedUse = seedUseFromConfig(
  arenaConfig,
  applyRequested ? "promotion-apply" : "promotion-dry-run",
  [candidateHash],
);
await recordGoArenaSeedUse(seedUse, seedLedgerPath, applyRequested);
console.log(`arena corpus recorded as ${seedUse.id} in ${seedLedgerPath}; it is now burned for future apply gates`);
const originals = {
  champion: await Bun.file(champion).text(),
  artifact: await Bun.file(artifact).text(),
  fixture: await Bun.file(fixture).text(),
};
let keepCandidate = false;
try {
  console.log(`V9 WebGPU gate: ${profile}, ${arenaConfig.games} game(s) per opponent, `
    + `raw seed ${arenaConfig.seed}, effective engine-tick seed ${effectiveSeed}, `
    + `handicap seed ${arenaConfig.handicapSeed}, defense seed ${arenaConfig.defenseSeed}, `
    + `candidate limit ${arenaConfig.candidateLimit ?? GO_PROFILE_CANDIDATE_LIMITS[profile]} `
    + `(${arenaConfig.candidateLimit === undefined ? "profile default" : "explicit flag"})`);
  const championResult = await runGoProfileArena(arenaConfig);
  run(["bun", "run", "tools/go-export-model.ts", candidate, profile]);
  const candidateResult = await runGoProfileArena(arenaConfig);
  printArena("champion", championResult);
  printArena("candidate", candidateResult);

  const evidence = pairedPromotionEvidence(profile, candidateResult.gameMetrics, championResult.gameMetrics);
  const improved = evidence.promotionGatePassed;
  console.log(`paired evidence: ${evidence.favorableWinFlips} favorable/`
    + `${evidence.unfavorableWinFlips} unfavorable win flips, `
    + `one-sided sign p=${evidence.oneSidedWinPValue.toFixed(6)}, `
    + `Power/turn lower95=${evidence.powerPerTurnLower95.toFixed(6)}, `
    + `fewer-turns lower95=${evidence.fewerTurnsLower95.toFixed(4)}, `
    + `criterion=${evidence.criterion}, minimum-sample=${evidence.minimumSampleMet}`);
  console.log(`diagnostic only (matched losses): ${evidence.lossFloor.matchedLosses} pairs, `
    + `${evidence.lossFloor.candidateCloser}/${evidence.lossFloor.incumbentCloser} closer/worse margins, `
    + `margin lower95=${evidence.lossFloor.scoreMarginLower95.toFixed(4)}, `
    + `loss-only Power/turn lower95=${evidence.lossFloor.powerPerTurnLower95.toFixed(6)}`);
  console.log(`opponent evidence: ${JSON.stringify(evidence.opponents)}`);
  console.log(`verdict: ${improved ? "PROMOTE" : "REJECT"} `
    + `(${candidateResult.wins - championResult.wins >= 0 ? "+" : ""}`
    + `${candidateResult.wins - championResult.wins} wins, `
    + `${candidateResult.meanPowerPerTurn - championResult.meanPowerPerTurn >= 0 ? "+" : ""}`
    + `${(candidateResult.meanPowerPerTurn - championResult.meanPowerPerTurn).toFixed(6)} Power/turn, `
    + `${candidateResult.meanTurns - championResult.meanTurns >= 0 ? "+" : ""}`
    + `${(candidateResult.meanTurns - championResult.meanTurns).toFixed(2)} mean turns, `
    + `${candidateResult.pointDifference - championResult.pointDifference >= 0 ? "+" : ""}`
    + `${(candidateResult.pointDifference - championResult.pointDifference).toFixed(1)} points)`);
  if (!improved) throw new Error("WebGPU promotion gate rejected the candidate");
  if (!applyRequested) {
    console.log("this dry-run corpus is burned; choose fresh playtime, handicap, and defense seeds for a one-shot --apply gate");
  } else {
    await Bun.write(champion, Bun.file(candidate));
    // Re-export from the staged champion path. The gate run above exported the
    // identical bytes from the candidate's own path, so the generated module
    // still records that provenance and `--check` below would reject it.
    run(["bun", "run", "tools/go-export-model.ts", champion, profile]);
    run(["bun", "run", "tools/go-golden-fixture.ts"]);
    run(["bun", "run", "tools/go-export-model.ts", "--check"]);
    run(["bun", "run", "tools/go-webgpu-test.ts"]);
    keepCandidate = true;
    console.log(`installed ${profile} V9 champion ${candidateHash}`);
  }
} finally {
  if (!keepCandidate) {
    await Bun.write(champion, originals.champion);
    await Bun.write(artifact, originals.artifact);
    await Bun.write(fixture, originals.fixture);
  }
}
