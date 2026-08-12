/** Promotion gate: decide whether a trained candidate beats the deployed
 * champion, and — only if it does — move it into the deployment pipeline.
 *
 * This encodes go-ai's promotion rule as an executable check instead of a
 * documented manual procedure: more complete-game wins on a fixed unseen
 * corpus always wins, and only an exact win tie is broken by higher
 * loss-penalized terminal Power per total round. A candidate that does not
 * strictly improve is rejected with a nonzero exit status.
 *
 *   bun run go:promote small5 go-ai/runs/small5-next/checkpoint-42.model
 *   bun run go:promote daemon19 <candidate.model> --games 128 --seed 7193001
 *   bun run go:promote small5 <candidate.model> --apply
 *
 * `--apply` replaces the champion, re-exports the runtime artifact, and
 * regenerates the C++ golden fixture, so the deployed weights, the artifact,
 * and the test oracle can never drift apart.
 */
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");
const RELEASE = join(ROOT, "go-ai", "build", "release");

type Profile = "small5" | "daemon19";

interface Row {
  model: string;
  games: number;
  wins: number;
  winRate: number;
  powerPerRound: number;
}

function flag(name: string, fallback: number): number {
  const index = Bun.argv.indexOf(name);
  if (index < 0) return fallback;
  const value = Number(Bun.argv[index + 1]);
  if (!Number.isFinite(value)) throw new Error(`${name} requires a numeric value`);
  return value;
}

const [profileArg, candidate] = [Bun.argv[2], Bun.argv[3]];
if (profileArg !== "small5" && profileArg !== "daemon19") {
  throw new Error("usage: bun run go:promote <small5|daemon19> <candidate.model> [--games N] [--seed N] [--apply]");
}
const profile: Profile = profileArg;
if (!candidate || !await Bun.file(candidate).exists()) {
  throw new Error(`candidate model ${candidate ?? "(missing)"} does not exist`);
}
const champion = join(ROOT, "go-ai", `${profile}-champion.model`);
if (!await Bun.file(champion).exists()) throw new Error(`champion ${champion} does not exist`);

// Defaults match the gate corpora documented in go-ai/BASELINES.md. Use a
// fresh seed for every real promotion: reusing one lets a candidate be
// selected against a corpus it was implicitly tuned on.
const games = Math.max(1, Math.floor(flag("--games", profile === "small5" ? 2_400 : 128)));
const seed = Math.floor(flag("--seed", profile === "small5" ? 10_992_001 : 7_193_001));

const command = profile === "small5"
  ? [join(RELEASE, "go_cpp_evaluate_mixed"), String(games), String(seed), champion, candidate, "--small5"]
  : [join(RELEASE, "go_cpp_evaluate"), String(games), String(seed), "????????????", "19", champion, candidate];

const binary = command[0]!;
if (!await Bun.file(binary).exists()) {
  throw new Error(`${binary} is missing; run: cmake --build go-ai/build/release -j 12`);
}

console.log(`gate: ${profile}, ${games} complete games, corpus seed ${seed}`);
const gate = Bun.spawnSync(command, { stdout: "pipe", stderr: "pipe" });
if (gate.exitCode !== 0) throw new Error(gate.stderr.toString() || "evaluator failed");
const output = gate.stdout.toString();
console.log(output.trimEnd());

const rows: Row[] = output.trim().split("\n").slice(1).map((line) => {
  const [model, gameCount, wins, winRate, powerPerRound] = line.split("\t");
  return {
    model: model!,
    games: Number(gameCount),
    wins: Number(wins),
    winRate: Number(winRate),
    powerPerRound: Number(powerPerRound),
  };
});
const championRow = rows.find((row) => row.model === champion);
const candidateRow = rows.find((row) => row.model === candidate);
if (!championRow || !candidateRow) throw new Error("evaluator did not report both models");

const improved = candidateRow.wins > championRow.wins
  || (candidateRow.wins === championRow.wins && candidateRow.powerPerRound > championRow.powerPerRound);
const margin = candidateRow.wins - championRow.wins;
console.log(`\nchampion  ${championRow.wins}/${championRow.games} wins, ${championRow.powerPerRound.toFixed(5)} power/round`);
console.log(`candidate ${candidateRow.wins}/${candidateRow.games} wins, ${candidateRow.powerPerRound.toFixed(5)} power/round`);
console.log(`verdict:  ${improved ? "PROMOTE" : "REJECT"} (${margin >= 0 ? "+" : ""}${margin} wins)`);

if (!improved) {
  console.error("\ncandidate does not improve on the champion; not promoting");
  throw new Error("promotion gate rejected the candidate");
}

if (!Bun.argv.includes("--apply")) {
  console.log("\nre-run with --apply to install this candidate and refresh the deployment artifacts");
} else {
  await Bun.write(champion, Bun.file(candidate));
  console.log(`\ninstalled ${candidate} as ${champion}`);
  for (const step of [
    [join(ROOT, "tools", "go-export-model.ts"), champion, profile],
    [join(ROOT, "tools", "go-golden-fixture.ts")],
  ]) {
    const run = Bun.spawnSync(["bun", "run", ...step], { stdout: "inherit", stderr: "inherit" });
    if (run.exitCode !== 0) throw new Error(`post-promotion step failed: ${step.join(" ")}`);
  }
  console.log(
    "\nartifact and golden fixture refreshed. Next:\n"
    + "  bun test tests/go-neural.test.ts        # TS reference vs C++ golden vectors\n"
    + "  bun run go:gpu                          # WGSL shader vs the same vectors\n"
    + "  bun run go:arena --games 128            # refresh winrate/latency priors\n"
    + "  then refit GO_REWARD_RULES in shared/strategy/go/rewards.ts",
  );
}
