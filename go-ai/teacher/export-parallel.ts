/** Process-parallel wrapper for export.ts.
 *
 * The upstream oracle stores game state globally, so threads inside one Bun
 * process would race. Independent worker processes safely saturate CPU cores.
 */
import { unlink } from "node:fs/promises";
import { availableParallelism } from "node:os";

function numberFlag(name: string, fallback: number): number {
  const index = Bun.argv.indexOf(name);
  return index >= 0 ? Number(Bun.argv[index + 1] ?? fallback) : fallback;
}

function stringFlag(name: string, fallback: string): string {
  const index = Bun.argv.indexOf(name);
  return index >= 0 ? Bun.argv[index + 1] ?? fallback : fallback;
}

async function main(): Promise<void> {
  const games = Math.max(1, Math.floor(numberFlag("--games", 96)));
  const workers = Math.max(1, Math.min(games, Math.floor(numberFlag("--workers", availableParallelism()))));
  const start = numberFlag("--seed", 24301);
  const opponent = stringFlag("--opponent", "Illuminati");
  const output = stringFlag("--out", "go-ai/teacher-illuminati.tsv");
  const model = stringFlag("--model", "");
  const mixed = Bun.argv.includes("--mixed");
  const small5 = Bun.argv.includes("--small5");
  const daemon19 = Bun.argv.includes("--daemon19");
  if (Number(mixed) + Number(small5) + Number(daemon19) > 1) {
    throw new Error("choose only one of --mixed, --small5, or --daemon19");
  }
  const maxCandidates = Math.max(0, Math.floor(numberFlag("--max-candidates", 0)));
  const statesPerGame = Math.max(0, Math.floor(numberFlag("--states-per-game", 0)));
  const variations = Math.max(1, Math.floor(numberFlag("--variations", 1)));
  const exploration = Math.max(0, Math.min(1, numberFlag("--exploration", 0)));
  const learnerContinuations = Bun.argv.includes("--learner-continuations");
  const trajectoryOnly = Bun.argv.includes("--trajectory-only");
  const imitation = Bun.argv.includes("--imitation");
  const hardNegatives = Bun.argv.includes("--hard-negatives");
  const teacherTrajectories = Bun.argv.includes("--teacher-trajectories");
  const teacherShortlist = Math.max(0, Math.floor(numberFlag("--teacher-shortlist", 0)));
  const teacherCandidates = Math.max(0, Math.floor(numberFlag("--teacher-candidates", 0)));
  const teacherOverrideMargin = Math.max(0, numberFlag("--teacher-override-margin", 0));
  const shards: { path: string; process: ReturnType<typeof Bun.spawn> }[] = [];
  for (let worker = 0; worker < workers; worker++) {
    const begin = Math.floor(games * worker / workers);
    const end = Math.floor(games * (worker + 1) / workers);
    const path = `${output}.worker-${worker}`;
    const command = [
      "bun", "run", imitation ? "go-ai/teacher/imitation-export.ts" : "go-ai/teacher/export.ts",
      "--games", String(end - begin),
      "--game-offset", String(begin),
      "--seed", String(start),
      "--opponent", opponent,
      "--out", path,
    ];
    if (model) command.push("--model", model);
    if (mixed) command.push("--mixed");
    if (small5) command.push("--small5");
    if (daemon19) command.push("--daemon19");
    if (maxCandidates) command.push("--max-candidates", String(maxCandidates));
    if (statesPerGame) command.push("--states-per-game", String(statesPerGame));
    command.push("--variations", String(variations));
    if (exploration) command.push("--exploration", String(exploration));
    if (learnerContinuations) command.push("--learner-continuations");
    if (trajectoryOnly) command.push("--trajectory-only");
    if (hardNegatives) command.push("--hard-negatives");
    if (teacherTrajectories) command.push("--teacher-trajectories");
    if (teacherShortlist) command.push("--teacher-shortlist", String(teacherShortlist));
    if (teacherCandidates) command.push("--teacher-candidates", String(teacherCandidates));
    if (teacherOverrideMargin) command.push("--teacher-override-margin", String(teacherOverrideMargin));
    const process = Bun.spawn(command, { stdout: "pipe", stderr: "pipe" });
    shards.push({ path, process });
  }
  const workerResults = await Promise.all(shards.map(async ({ process }) => {
    const [exitCode, stdout, stderr] = await Promise.all([
      process.exited,
      new Response(process.stdout).text(),
      new Response(process.stderr).text(),
    ]);
    if (exitCode !== 0) {
      for (const shard of shards) if (shard.process !== process) shard.process.kill();
    }
    return { exitCode, stdout, stderr };
  }));
  const failure = workerResults.find(({ exitCode }) => exitCode !== 0);
  if (failure) throw new Error(failure.stderr || `teacher worker exited ${failure.exitCode}`);
  const summaries = workerResults.map(({ stdout }) => JSON.parse(stdout.trim()) as {
    wins: number;
    states: number;
    examples: number;
    trajectoryFallbacks: number;
    continuationFallbacks: number;
    totalTrainingPower: number;
    totalRounds: number;
  });
  const writer = Bun.file(output).writer();
  writer.write("# bitburner-go-teacher-v1\n");
  writer.write("# game state candidate opponent size elapsed remaining won power selected bx by wx wy before after\n");
  for (const { path } of shards) {
    const contents = await Bun.file(path).text();
    writer.write(contents.split("\n").filter((line) => line && !line.startsWith("#")).join("\n") + "\n");
  }
  await writer.end();
  await Promise.all(shards.map(({ path }) => unlink(path)));
  const totals = summaries.reduce((sum, value) => ({
    wins: sum.wins + value.wins,
    states: sum.states + value.states,
    examples: sum.examples + value.examples,
    trajectoryFallbacks: sum.trajectoryFallbacks + value.trajectoryFallbacks,
    continuationFallbacks: sum.continuationFallbacks + value.continuationFallbacks,
    totalTrainingPower: sum.totalTrainingPower + value.totalTrainingPower,
    totalRounds: sum.totalRounds + value.totalRounds,
  }), { wins: 0, states: 0, examples: 0, trajectoryFallbacks: 0, continuationFallbacks: 0,
    totalTrainingPower: 0, totalRounds: 0 });
  console.log(JSON.stringify({
    output, games, workers, profile: mixed ? "mixed" : small5 ? "small5"
      : daemon19 ? "daemon19" : "fixed",
    variations, exploration, trajectoryOnly, imitation, hardNegatives, teacherTrajectories,
    teacherShortlist,
    teacherCandidates,
    teacherOverrideMargin,
    continuations: learnerContinuations ? "learner" : "teacher",
    source: model || "frozen-teacher",
    ...totals, winRate: totals.wins / games,
    trainingPowerPerRound: totals.totalTrainingPower / Math.max(totals.totalRounds, 1),
  }));
}

if (import.meta.main) await main();
