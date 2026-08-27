import { pairedComparison, percentile, valueAfter } from "../sim/dnet-bench.ts";
import {
  runFarmCase,
  SHIPPED_FARM,
  summarizeFarmRuns,
  type FarmScenario,
  type FarmRun,
} from "../sim/dnet-farm.ts";
import { generateNet } from "../sim/dnet-spread.ts";

const seedCount = Number(valueAfter("--seeds") ?? 8);
const hours = Number(valueAfter("--hours") ?? 2);
const warmupHours = Number(valueAfter("--warmup") ?? 1);
if (!Number.isInteger(seedCount) || seedCount <= 0) {
  throw new Error(`--seeds must be a positive integer, got ${seedCount}`);
}
if (!Number.isFinite(hours) || hours <= 0) {
  throw new Error(`--hours must be positive, got ${hours}`);
}
if (!Number.isFinite(warmupHours) || warmupHours < 0) {
  throw new Error(`--warmup must be non-negative, got ${warmupHours}`);
}

// The no-storm scenario prices the storm; post-lab is the real lifecycle phase
// after the walker gate retires. Production strategy itself is fixed.
const policies: FarmScenario[] = [
  SHIPPED_FARM,
  { ...SHIPPED_FARM, name: "no storm", stormEnabled: false },
  { ...SHIPPED_FARM, name: "post-lab (no walker)", labPresent: false },
];

const seeds = Array.from({ length: seedCount }, (_, index) => index + 1);
const runs = new Map<string, FarmRun[]>(policies.map((policy) => [
  policy.name,
  seeds.map((seed) => runFarmCase(generateNet(seed, { stock: true }), policy, hours, warmupHours)),
]));

process.stdout.write(
  `Earn-in-a-full-net paired benchmark: ${seedCount} seeded worlds x ${warmupHours}h warmup + ${hours}h measured.\n`
  + "Established net (spread done, lab vantage pinned, walker mid-walk); the real planFarm/\n"
  + "planStorm run against the real DarknetSystem cache, seed, and storm mechanics.\n"
  + "Rates exclude the initial block backlog; p10 is the lower-tail regression signal.\n",
);

console.table(policies.map((policy) => {
  const held = runs.get(policy.name)!;
  const summary = summarizeFarmRuns(held);
  return {
    policy: summary.policy,
    "caches/h": summary.meanCachesPerHour.toFixed(1),
    "p10 caches/h": percentile(held.map((run) => run.cachesPerHour), 0.1).toFixed(1),
    "money/h": `$${(summary.meanMoneyPerHour / 1e6).toFixed(0)}m`,
    "p10 money/h": `$${(percentile(held.map((run) => run.moneyPerHour), 0.1) / 1e6).toFixed(0)}m`,
    "phish caches": summary.meanPhishCaches.toFixed(1),
    "storms fired": summary.meanStormsFired.toFixed(1),
    "walker interrupts": summary.totalWalkerInterruptions,
    "walker attempts": summary.meanWalkerAttempts.toFixed(0),
  };
}));

const cachesOf = (held: readonly FarmRun[]): number[] => held.map((run) => run.cachesPerHour);
const baseline = runs.get(SHIPPED_FARM.name)!;
console.table(policies.filter((policy) => policy.name === "no storm").map((policy) => {
  const compared = pairedComparison(
    { name: SHIPPED_FARM.name, values: cachesOf(baseline) },
    { name: policy.name, values: cachesOf(runs.get(policy.name)!) },
    false, // caches per hour: higher is better
  );
  return {
    candidate: compared.candidate,
    "more caches": compared.candidateBetter,
    tied: compared.tied,
    fewer: compared.candidateWorse,
    "cache ratio": compared.ratio.toFixed(3),
    "mean delta (caches/h)": compared.meanDelta.toFixed(2),
    "95% CI": `${compared.ci95Low.toFixed(2)}..${compared.ci95High.toFixed(2)}`,
  };
}));

for (const run of baseline) {
  if (run.walkerInterruptions !== 0 || run.walkerAttempts <= 0) {
    throw new Error(`${run.caseId}: shipped farm failed the pinned-walker invariant`);
  }
  if (!(run.cachesPerHour > 0) || !(run.moneyPerHour > 0)) {
    throw new Error(`${run.caseId}: shipped farm stopped producing during the measured window`);
  }
}
