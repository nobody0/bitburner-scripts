import { pairedComparison, valueAfter } from "../sim/dnet-bench.ts";
import {
  runFarmCase,
  SHIPPED_FARM,
  summarizeFarmRuns,
  type FarmPolicy,
  type FarmRun,
} from "../sim/dnet-farm.ts";
import { generateNet } from "../sim/dnet-spread.ts";

const seedCount = Number(valueAfter("--seeds") ?? 12);
const hours = Number(valueAfter("--hours") ?? 2);
if (!Number.isInteger(seedCount) || seedCount <= 0) {
  throw new Error(`--seeds must be a positive integer, got ${seedCount}`);
}
if (!Number.isFinite(hours) || hours <= 0) {
  throw new Error(`--hours must be positive, got ${hours}`);
}

// The shipped policy first, then the storm withheld — the axis this lane
// exists to price — then the post-lab shape where the walker gate has retired,
// then the tuning dials wiggled one at a time. Sweep history (12 seeds x 2h):
// - "no storm" 0.973x (-6.7 caches/h): the storm EARNS its keep once the
//   budget-refused-blocks gate stopped deadlocking it.
// - "hunter by capacity" tied 12/12 exactly — but this arena passes no promote
//   symbols, so the election never has to divert anyone; the tie is an arena
//   limitation, not proof. The depth default stands until a promote-bearing
//   sweep says otherwise.
// - "fire window 90s" +5.0 caches/h with a CI crossing zero: promising,
//   unproven. Left at 30s.
// - "clear budget 20m" -2.5 caches/h and fewer storms (the longer grind holds
//   gate 4 longer): rejected.
const policies: FarmPolicy[] = [
  SHIPPED_FARM,
  { ...SHIPPED_FARM, name: "no storm", stormEnabled: false },
  { ...SHIPPED_FARM, name: "post-lab (no walker)", labPresent: false },
  { ...SHIPPED_FARM, name: "hunter by capacity", hunterElection: "capacity" },
  { ...SHIPPED_FARM, name: "fire window 90s", phishOverlapMs: 90_000 },
  { ...SHIPPED_FARM, name: "clear budget 20m", clearBudgetMs: 20 * 60_000 },
];

const seeds = Array.from({ length: seedCount }, (_, index) => index + 1);
const runs = new Map<string, FarmRun[]>(policies.map((policy) => [
  policy.name,
  seeds.map((seed) => runFarmCase(generateNet(seed, { stock: true }), policy, hours)),
]));

console.log(
  `Earn-in-a-full-net paired benchmark: ${seedCount} seeded worlds x ${hours}h of virtual time.\n`
  + "Established net (spread done, lab vantage pinned, walker mid-walk); the real planFarm/\n"
  + "planStorm run against the real DarknetSystem cache, seed, and storm mechanics.\n"
  + "walker interrupts MUST stay 0 — that column is the axis-4 invariant, not a score.",
);

console.table(policies.map((policy) => {
  const held = runs.get(policy.name)!;
  const summary = summarizeFarmRuns(held);
  return {
    policy: summary.policy,
    "caches/h": summary.meanCachesPerHour.toFixed(1),
    "money/h": `$${(summary.meanMoneyPerHour / 1e6).toFixed(0)}m`,
    "phish caches": summary.meanPhishCaches.toFixed(1),
    "storms fired": summary.meanStormsFired.toFixed(1),
    "walker interrupts": summary.totalWalkerInterruptions,
    "walker attempts": summary.meanWalkerAttempts.toFixed(0),
  };
}));

const cachesOf = (held: readonly FarmRun[]): number[] => held.map((run) => run.cachesPerHour);
const baseline = runs.get(SHIPPED_FARM.name)!;
console.table(policies.slice(1).map((policy) => {
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
