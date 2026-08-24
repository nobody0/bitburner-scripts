import { pairedComparison, valueAfter } from "../sim/dnet-bench.ts";
import {
  generateNet,
  runSpreadCase,
  SHIPPED_SPREAD,
  summarizeSpreadRuns,
  type SpreadPolicy,
  type SpreadRun,
} from "../sim/dnet-spread.ts";

const seedCount = Number(valueAfter("--seeds") ?? 40);
if (!Number.isInteger(seedCount) || seedCount <= 0) {
  throw new Error(`--seeds must be a positive integer, got ${seedCount}`);
}

// The shipped policy first, then its dials wiggled one at a time — a standing
// check that each deployed choice is still pulling its weight on the road from
// a cold darkweb to a full-thread lab walker.
const policies: SpreadPolicy[] = [
  SHIPPED_SPREAD,
  { ...SHIPPED_SPREAD, name: "single-thread attempts", threadScaledAttempts: false },
  { ...SHIPPED_SPREAD, name: "no bootstrap reclaim", bootstrapReclaim: false },
  { ...SHIPPED_SPREAD, name: "single grinder", gangReclaim: false },
  { ...SHIPPED_SPREAD, name: "vantage by raw RAM", vantageScoring: "maxRam" },
  // A confirmed no-op at this world size (60/60 exact ties): the future
  // vantage cracks quickly on pure depth order anyway. Kept as documentation.
  { ...SHIPPED_SPREAD, name: "lab-adjacent bonus 8", labAdjacentBonus: 8 },
];

const seeds = Array.from({ length: seedCount }, (_, index) => index + 1);
const runs = new Map<string, SpreadRun[]>(policies.map((policy) => [
  policy.name,
  seeds.map((seed) => runSpreadCase(generateNet(seed), policy)),
]));

console.log(
  `Reach-the-lab paired benchmark: ${seedCount} seeded worlds, cold start on darkweb.\n`
  + "Real planners (candidatesFrom/planSpread/deriveTasks/planHold/planFarm) against the real\n"
  + "DarknetSystem mutation clock; execution abstracted to the transcribed rates.ts waits. Solver models\n"
  + "are charged their declared budget, dictionary models the true password's position.",
);

console.table(policies.map((policy) => {
  const held = runs.get(policy.name)!;
  const summary = summarizeSpreadRuns(held);
  return {
    policy: summary.policy,
    solved: `${summary.solved}/${summary.cases}`,
    "walker start (min)": (summary.meanMsToWalkerStart / 60_000).toFixed(2),
    "first crack (s)": (summary.meanMsToFirstCrack / 1_000).toFixed(1),
    "half cracked (min)": (summary.meanMsToHalfCracked / 60_000).toFixed(2),
    "mean cracked": summary.meanCracked.toFixed(1),
    "planted peak": summary.meanPlantedPeak.toFixed(1),
  };
}));

// Paired on walker-start; an unsolved run is charged its cap, which is the
// honest cost of a policy that stalls.
const startsOf = (held: readonly SpreadRun[]): number[] =>
  held.map((run) => run.msToWalkerStart ?? run.elapsedMs);
const baseline = runs.get(SHIPPED_SPREAD.name)!;
console.table(policies.slice(1).map((policy) => {
  const compared = pairedComparison(
    { name: SHIPPED_SPREAD.name, values: startsOf(baseline) },
    { name: policy.name, values: startsOf(runs.get(policy.name)!) },
  );
  return {
    candidate: compared.candidate,
    faster: compared.candidateBetter,
    tied: compared.tied,
    slower: compared.candidateWorse,
    "time ratio": compared.ratio.toFixed(3),
    "mean delta (min)": (compared.meanDelta / 60_000).toFixed(2),
    "95% CI (min)": `${(compared.ci95Low / 60_000).toFixed(2)}..${(compared.ci95High / 60_000).toFixed(2)}`,
  };
}));
