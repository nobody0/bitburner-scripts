import {
  generateLabCorpus,
  plannerRoute,
  runLabCase,
  summarizeLabRuns,
} from "../sim/dnet-lab.ts";

const DEFAULT_SEEDS = 64;
const MAX_ATTEMPTS_PER_ORACLE_MOVE = 1.45;

const valueAfter = (name: string): string | undefined => {
  const at = process.argv.indexOf(name);
  return at === -1 ? undefined : process.argv[at + 1];
};

const seedCount = Number(valueAfter("--seeds") ?? DEFAULT_SEEDS);
if (!Number.isInteger(seedCount) || seedCount <= 0) {
  throw new Error(`--seeds must be a positive integer, got ${seedCount}`);
}

// This arena deliberately isolates only the protocol the production walker
// controls. It uses the upstream-shaped generator, public stage facts, paid
// move/radar responses, shared player XP, and the authentication formula. The
// route never receives the maze, start, exit, shortest path, or random seed.
const cases = generateLabCorpus(Array.from({ length: seedCount }, (_, index) => index + 1));
const runs = cases.map((lab) => runLabCase(lab, plannerRoute()));
const summary = summarizeLabRuns(runs);
const attemptsPerOracleMove = summary.totalAttempts / summary.totalShortestMoves;
const blocked = runs.reduce((sum, run) => sum + run.blocked, 0);
const radars = runs.reduce((sum, run) => sum + run.radars, 0);

process.stdout.write(
  `Production labyrinth regression: ${seedCount} seeds x 8 rungs = ${cases.length} cases.\n`
  + "Minimum allowed charisma, 1 thread, 0 intelligence, no Boots/SF15/backdoor multiplier.\n"
  + "Every move and radar pays one authentication duration; only failed authentications earn charisma XP.\n"
  + `route=${summary.route} solved=${summary.solved}/${summary.cases}`
  + ` meanAttempts=${summary.meanAttempts.toFixed(2)} p95=${summary.p95Attempts} max=${summary.maxAttempts}`
  + ` meanMinutes=${(summary.meanElapsedMs / 60_000).toFixed(2)}`
  + ` attemptsPerOracle=${attemptsPerOracleMove.toFixed(3)} radars=${radars} blocked=${blocked}\n`,
);

const failures: string[] = [];
if (summary.solved !== summary.cases) failures.push(`solved ${summary.solved}/${summary.cases}`);
const excessiveBlocks = runs.filter((run) => run.blocked > 1);
if (excessiveBlocks.length > 0) failures.push(`${excessiveBlocks.length} cases bumped more than the blind first edge`);
// The statistical ceiling belongs to the committed corpus. Custom seed counts
// remain useful for exploration without pretending a tiny sample has the same
// variance as the regression lane.
if (seedCount === DEFAULT_SEEDS && attemptsPerOracleMove > MAX_ATTEMPTS_PER_ORACLE_MOVE) {
  failures.push(`attempts/oracle ${attemptsPerOracleMove.toFixed(4)} > ${MAX_ATTEMPTS_PER_ORACLE_MOVE}`);
}
if (failures.length > 0) throw new Error(`labyrinth regression: ${failures.join("; ")}`);
