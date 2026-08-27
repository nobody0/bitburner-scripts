import { valueAfter } from "../sim/dnet-bench.ts";
import { generateNet, runSpreadCase, summarizeSpreadRuns, type SpreadRun } from "../sim/dnet-spread.ts";

interface Tier {
  id: string;
  name: string;
  augs: number;
  redPill?: boolean;
  defaultSeeds: number;
  capMs?: number;
}

const tiers: readonly Tier[] = [
  { id: "rung0", name: "rung 0 (depth 7)", augs: 0, defaultSeeds: 40 },
  { id: "deep", name: "deep (depth 23)", augs: 3, defaultSeeds: 10, capMs: 3 * 60 * 60 * 1000 },
  { id: "deepest", name: "deepest (depth 29)", augs: 6, defaultSeeds: 6, capMs: 6 * 60 * 60 * 1000 },
  { id: "full", name: "full Dnet (depth 36)", augs: 6, redPill: true, defaultSeeds: 4, capMs: 6 * 60 * 60 * 1000 },
];

if (process.argv.includes("--help")) {
  console.error(
    "Usage: bun run bench:sim:dnet-spread [--seeds N] [--tier all|rung0|deep|deepest|full] [--debug]\n"
    + "--seeds is the exact number of seeds per selected tier; --debug emits one planner snapshot per virtual minute.",
  );
  process.exit(0);
}
if (process.argv.includes("--debug")) process.env["DNET_SPREAD_DEBUG"] = "1";

const seedOverrideText = valueAfter("--seeds");
const seedOverride = seedOverrideText === undefined ? undefined : Number(seedOverrideText);
if (seedOverride !== undefined && (!Number.isInteger(seedOverride) || seedOverride <= 0)) {
  throw new Error(`--seeds must be a positive integer, got ${seedOverrideText}`);
}

const tierId = valueAfter("--tier");
const selected = tierId === undefined || tierId === "all"
  ? tiers
  : tiers.filter((tier) => tier.id === tierId);
if (selected.length === 0) {
  throw new Error(`--tier must be one of all, ${tiers.map((tier) => tier.id).join(", ")}; got ${tierId}`);
}

const minutes = (ms: number | undefined): string => ms === undefined ? "-" : (ms / 60_000).toFixed(2);

for (const tier of selected) {
  const seedCount = seedOverride ?? tier.defaultSeeds;
  const runs: SpreadRun[] = [];
  const startedAt = performance.now();
  for (let seed = 1; seed <= seedCount; seed++) {
    const net = generateNet(seed, { augs: tier.augs, ...(tier.redPill ? { redPill: true } : {}) });
    const run = runSpreadCase(net, tier.capMs);
    runs.push(run);
    console.error(
      `[${tier.id}] seed ${seed}/${seedCount}: ${run.solved ? "walker placed" : run.reason}`
      + ` at ${minutes(run.msToWalkerStart)} virtual min`,
    );
  }

  const summary = summarizeSpreadRuns(runs);
  const bands = runs.map((run) => run.msToAllBandsReached).filter((value): value is number => value !== undefined);
  console.error(`\n=== ${tier.name}: ${seedCount} fresh seeded Dnets ===`);
  console.table([{
    solved: `${summary.solved}/${summary.cases}`,
    "lab sighted (min)": minutes(runs.reduce((sum, run) => sum + (run.msToLabSighted ?? run.elapsedMs), 0) / runs.length),
    "bands reached (min)": bands.length === 0 ? "-" : minutes(bands.reduce((sum, value) => sum + value, 0) / bands.length),
    "lab to walker (min)": minutes(summary.meanMsLabToWalkerStart),
    "walker placed (min)": minutes(summary.meanMsToWalkerStart),
    "induce calls": Math.round(runs.reduce((sum, run) => sum + run.induceCalls, 0) / runs.length),
    "mean cracked": summary.meanCracked.toFixed(1),
    "planted peak": summary.meanPlantedPeak.toFixed(1),
    "wall time (s)": ((performance.now() - startedAt) / 1000).toFixed(1),
  }]);
}
