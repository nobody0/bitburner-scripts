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

function run(step: string[]): void {
  const result = Bun.spawnSync(step, { cwd: ROOT, stdout: "inherit", stderr: "inherit" });
  if (result.exitCode !== 0) throw new Error(`step failed: ${step.join(" ")}`);
}

function printArena(label: string, result: GoProfileArenaResult): void {
  console.log(`${label.padEnd(9)} ${result.wins}/${result.games} wins, `
    + `${result.pointDifference >= 0 ? "+" : ""}${result.pointDifference.toFixed(1)} points, `
    + `${result.latencyMs.p50}/${result.latencyMs.p95} ms p50/p95, `
    + `${result.meanFinalists} mean finalists [${result.backend}]`);
}

const [profileArg, candidate] = [Bun.argv[2], Bun.argv[3]];
if (profileArg !== "small5" && profileArg !== "daemon19") {
  throw new Error("usage: bun run go:promote <small5|daemon19> <candidate.model> [--games N] [--seed N] [--summary PATH] [--apply]");
}
const profile: GoArenaProfile = profileArg;
if (!candidate || !await Bun.file(candidate).exists()) throw new Error(`candidate ${candidate ?? "(missing)"} does not exist`);
if (await magic(candidate) !== "bitburner-go-value-v9") throw new Error("promotion accepts V9 checkpoints only");

const champion = join(ROOT, "go-ai", `${profile}-champion.model`);
const artifact = join(ROOT, "shared", "strategy", "go", "neural", "models", `${profile}.ts`);
const fixture = join(ROOT, "tests", "fixtures", "go-value.json");
if (await magic(champion) !== "bitburner-go-value-v9") {
  throw new Error(`installed ${profile} champion is not V9`);
}

const summaryPath = stringFlag("--summary", join(dirname(candidate), "summary.json"));
if (!await Bun.file(summaryPath).exists()) throw new Error(`missing V9 training summary ${summaryPath}`);
const summary = await Bun.file(summaryPath).json() as {
  profile?: string; modelSha256?: string; shortlistDataAllowed?: boolean; shortlistGate?: unknown;
};
const candidateHash = await sha256(candidate);
if (summary.profile !== profile || summary.modelSha256 !== candidateHash) {
  throw new Error("V9 summary does not identify this profile and checkpoint");
}
if (!summary.shortlistDataAllowed) {
  throw new Error(`V9 exhaustive shortlist recall gate failed: ${JSON.stringify(summary.shortlistGate ?? {})}`);
}

const installedArtifact = profile === "small5" ? SMALL5_GO_MODEL : DAEMON19_GO_MODEL;
const championHash = await sha256(champion);
if (installedArtifact.topology !== "bitburner-go-value-v9"
  || installedArtifact.sourceSha256 !== championHash) {
  throw new Error(`${profile} artifact is not exported from the installed V9 champion`);
}

const arenaConfig = {
  profile,
  games: Math.max(1, Math.floor(numberFlag("--games", profile === "small5" ? 12 : 4))),
  seed: Math.floor(numberFlag("--seed", profile === "small5" ? 10_992_001 : 7_193_001)),
};
const originals = {
  champion: await Bun.file(champion).text(),
  artifact: await Bun.file(artifact).text(),
  fixture: await Bun.file(fixture).text(),
};
let keepCandidate = false;
try {
  console.log(`V9 WebGPU gate: ${profile}, ${arenaConfig.games} game(s) per opponent, seed ${arenaConfig.seed}`);
  const championResult = await runGoProfileArena(arenaConfig);
  run(["bun", "run", "tools/go-export-model.ts", candidate, profile]);
  const candidateResult = await runGoProfileArena(arenaConfig);
  printArena("champion", championResult);
  printArena("candidate", candidateResult);

  const improved = candidateResult.wins > championResult.wins
    || (candidateResult.wins === championResult.wins
      && candidateResult.pointDifference > championResult.pointDifference);
  console.log(`verdict: ${improved ? "PROMOTE" : "REJECT"} `
    + `(${candidateResult.wins - championResult.wins >= 0 ? "+" : ""}`
    + `${candidateResult.wins - championResult.wins} wins, `
    + `${candidateResult.pointDifference - championResult.pointDifference >= 0 ? "+" : ""}`
    + `${(candidateResult.pointDifference - championResult.pointDifference).toFixed(1)} points)`);
  if (!improved) throw new Error("WebGPU promotion gate rejected the candidate");
  if (!Bun.argv.includes("--apply")) {
    console.log("re-run with --apply to install the candidate");
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
