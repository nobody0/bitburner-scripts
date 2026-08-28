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
  // The webstorm restarts every movable survivor at once, so armour is the only
  // policy with anything left standing afterwards.
  { ...SHIPPED_FARM, name: "armour", armour: true },
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
    "inventory/h": summary.meanInventoryCallsPerHour.toFixed(1),
    "walker interrupts": summary.totalWalkerInterruptions,
    "walker attempts": summary.meanWalkerAttempts.toFixed(0),
  };
}));

// The restart ledger. Until this lane modelled restarts at all it credited the
// whole fleet with surviving the storm it fires itself, so these rows are the
// honest cost of the shipped policy as much as they are the armour's case.
process.stdout.write(
  "\nRestart ledger: occupied restarts are residents the engine killed; the storm's own\n"
  + "mass restart (every movable survivor) is broken out. `dodged` are hosts whose armoured\n"
  + "prober outlived the kill and re-planted in the same instant. `stranded` and `armour GB-h`\n"
  + "are the two sides of the trade, both integrated on the same clock.\n",
);
console.table(policies.map((policy) => {
  const held = runs.get(policy.name)!;
  const sum = (pick: (run: FarmRun) => number): number =>
    held.reduce((total, run) => total + pick(run), 0) / held.length;
  return {
    policy: policy.name,
    "restarts": sum((r) => r.occupiedRestarts).toFixed(1),
    "of which storm": sum((r) => r.stormRestarts).toFixed(1),
    "dodged": sum((r) => r.restartsDodged).toFixed(1),
    "recovered": sum((r) => r.restartRecovered).toFixed(1),
    "unrecovered": sum((r) => r.restartUnrecovered).toFixed(1),
    "stranded GB-h": (sum((r) => r.restartLostGbMs) / 3_600_000).toFixed(2),
    "armour GB-h": (sum((r) => r.armourGbMs) / 3_600_000).toFixed(2),
    "armour peak": sum((r) => r.armourPeak).toFixed(1),
  };
}));

const cachesOf = (held: readonly FarmRun[]): number[] => held.map((run) => run.cachesPerHour);
const moneyOf = (held: readonly FarmRun[]): number[] => held.map((run) => run.moneyPerHour / 1e6);
const baseline = runs.get(SHIPPED_FARM.name)!;
const noStorm = runs.get("no storm")!;
const strandedOf = (held: readonly FarmRun[]): number[] =>
  held.map((run) => run.restartLostGbMs / 3_600_000);
/** What the policy actually costs the fleet: capacity stranded by restarts PLUS
 *  the capacity armour holds. One number, so the trade cannot be read one-sided. */
const totalCostOf = (held: readonly FarmRun[]): number[] =>
  held.map((run) => (run.restartLostGbMs + run.armourGbMs) / 3_600_000);
const armour = runs.get("armour")!;
const against = (
  metric: string,
  candidate: readonly FarmRun[],
  name: string,
  pick: (held: readonly FarmRun[]) => number[],
  lowerIsBetter: boolean,
): { metric: string; result: ReturnType<typeof pairedComparison> } => ({
  metric,
  result: pairedComparison(
    { name: SHIPPED_FARM.name, values: pick(baseline) },
    { name, values: pick(candidate) },
    lowerIsBetter,
  ),
});
const comparisons = [
  against("caches/h", noStorm, "no storm", cachesOf, false),
  against("money/h ($m)", noStorm, "no storm", moneyOf, false),
  // The armour arms, paired on the same seeds as everything else. `stranded`
  // and `total cost` are the two that decide it: earnings move slowly against
  // seed noise, while the capacity ledger is what armour directly changes.
  against("caches/h", armour, "armour", cachesOf, false),
  against("money/h ($m)", armour, "armour", moneyOf, false),
  against("stranded GB-h", armour, "armour", strandedOf, true),
  against("total cost GB-h", armour, "armour", totalCostOf, true),
];
console.table(comparisons.map(({ metric, result }) => {
  return {
    metric,
    candidate: result.candidate,
    better: result.candidateBetter,
    tied: result.tied,
    worse: result.candidateWorse,
    ratio: result.ratio.toFixed(3),
    "mean delta": result.meanDelta.toFixed(2),
    "95% CI": `${result.ci95Low.toFixed(2)}..${result.ci95High.toFixed(2)}`,
  };
}));

// `caseId` is the net's depth, which every seed of a tier shares — name the
// seed too, or a failure cannot be reproduced from the message.
baseline.forEach((run, index) => {
  const where = `${run.caseId} seed ${seeds[index]}`;
  if (run.walkerInterruptions !== 0 || run.walkerAttempts <= 0) {
    throw new Error(`${where}: shipped farm failed the pinned-walker invariant`);
  }
  if (!(run.cachesPerHour > 0) || !(run.moneyPerHour > 0)) {
    throw new Error(`${where}: shipped farm stopped producing during the measured window`);
  }
});
