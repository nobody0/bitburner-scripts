import { LAB_LADDER } from "../shared/strategy/dnet/rates.ts";
import {
  biasedDfsRoute,
  compareLabRuns,
  generateLabCorpus,
  plannerRoute,
  runLabCase,
  runLabParty,
  summarizeLabRuns,
  type LabPartyMember,
  type LabRoute,
} from "../sim/dnet-lab.ts";

const valueAfter = (name: string): string | undefined => {
  const at = process.argv.indexOf(name);
  return at === -1 ? undefined : process.argv[at + 1];
};

const seedCount = Number(valueAfter("--seeds") ?? 200);
if (!Number.isInteger(seedCount) || seedCount <= 0) {
  throw new Error(`--seeds must be a positive integer, got ${seedCount}`);
}

const cases = generateLabCorpus(Array.from({ length: seedCount }, (_, index) => index + 1));
// The deployed planner first, then the retired DFS in its three probe guises,
// then the planner's dials wiggled one at a time — a standing check that the
// committed LAB_TUNING is still the sweep's winner.
const routes: LabRoute[] = [
  plannerRoute(),
  biasedDfsRoute("north"),
  biasedDfsRoute("east"),
  biasedDfsRoute("south"),
  plannerRoute({ unknownCost: 1.5 }),
  plannerRoute({ radarDoorCover: Infinity }),
  plannerRoute({ radarMinCover: 2 }),
  plannerRoute({ radarEconomicCost: 6 }),
  plannerRoute({ corridorBias: 0.7 }),
];
const runs = new Map(routes.map((route) => [
  route.name,
  cases.map((lab) => runLabCase(lab, route)),
]));

console.log(
  `Lab-only paired benchmark: ${seedCount} seeds x 8 lab rungs = ${cases.length} cases.\n`
  + "Timing snapshot: minimum allowed charisma for each rung, 1 thread, 0 intelligence, no Boots/SF15/backdoor multiplier.\n"
  + "Every direction attempt, radar included, costs one authentication duration; radars earn no charisma.",
);

console.table(routes.map((route) => {
  const held = runs.get(route.name)!;
  const summary = summarizeLabRuns(held);
  return {
    route: summary.route,
    solved: `${summary.solved}/${summary.cases}`,
    "mean attempts": summary.meanAttempts.toFixed(2),
    "p95 attempts": summary.p95Attempts,
    "max attempts": summary.maxAttempts,
    "mean minutes": (summary.meanElapsedMs / 60_000).toFixed(2),
    "attempts / oracle": (summary.totalAttempts / summary.totalShortestMoves).toFixed(3),
    radars: held.reduce((sum, run) => sum + run.radars, 0),
    blocked: held.reduce((sum, run) => sum + run.blocked, 0),
  };
}));

// --- the party: what a second adjacent host is worth --------------------------
//
// Deep rungs only (the shallow ones are over in a couple of minutes and rarely
// have a second vantage anyway). Wall-clock is the winner's own elapsed —
// members pay their delays in parallel and EITHER pid reaching the endpoint
// roots the lab. `lifetimeMs` models an UNPINNED scout: a mutation eats its
// host, and it respawns as a new PID at a fresh offset start with nothing kept
// but the shared field. The gap between the immortal and the mortal scout is
// the most a SECOND stasis link could ever buy.
const deepCases = generateLabCorpus(
  Array.from({ length: seedCount }, (_, index) => index + 1),
  LAB_LADDER.filter((stage) => stage.offsetStartAndEnd),
);
const parties: [string, LabPartyMember[]][] = [
  ["solo (party of one)", [{ name: "finisher" }]],
  ["finisher + southern scout", [{ name: "finisher" }, { name: "scout", route: "southern" }]],
  ["finisher + mortal scout (5m)", [
    { name: "finisher" },
    { name: "scout", route: "southern", lifetimeMs: 300_000 },
  ]],
  ["finisher + two scouts", [
    { name: "finisher" },
    { name: "s1", route: "southern" },
    { name: "s2", route: "eastern" },
  ]],
];
const soloPartyMs = deepCases.reduce((sum, lab) => sum + runLabParty(lab, parties[0]![1]).wallClockMs, 0);
console.table(parties.map(([label, party]) => {
  const held = deepCases.map((lab) => runLabParty(lab, party));
  const wallMs = held.reduce((sum, run) => sum + run.wallClockMs, 0);
  return {
    party: label,
    solved: `${held.filter((run) => run.solved).length}/${held.length}`,
    "mean minutes": (wallMs / held.length / 60_000).toFixed(2),
    "vs solo": (wallMs / soloPartyMs).toFixed(3),
    "total attempts": held.reduce((sum, run) => sum + run.attempts, 0),
    deaths: held.reduce((sum, run) => sum + run.members.reduce((m, member) => m + member.deaths, 0), 0),
  };
}));

const baseline = runs.get(routes[0]!.name)!;
console.table(routes.slice(1).map((route) => {
  const compared = compareLabRuns(baseline, runs.get(route.name)!);
  return {
    candidate: compared.candidate,
    faster: compared.candidateFaster,
    tied: compared.tied,
    slower: compared.candidateSlower,
    "attempt delta": compared.attemptDelta,
    "time delta (hours)": (compared.elapsedDeltaMs / 3_600_000).toFixed(2),
    "time ratio": compared.elapsedRatio.toFixed(5),
    "mean delta (s)": (compared.meanElapsedDeltaMs / 1_000).toFixed(3),
    "95% CI (s)": `${(compared.ci95LowMs / 1_000).toFixed(3)}..${(compared.ci95HighMs / 1_000).toFixed(3)}`,
  };
}));
