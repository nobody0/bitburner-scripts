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
  // The deep-world dials and their standing losers. The round-4 shipped shape
  // is the charge-wave budget (pushers sized to close the target's believed
  // remaining migration charge in one 6 s wave) plus the frontier PROGRESS
  // criterion (only bands reaching past our deepest agent admit a push) —
  // the round-3 blunt caps and the old uncapped pump are its predecessors.
  // "no induce" abandons the ferry/lab/seat purposes the post-lab net leans
  // on; the stasis-slack widening linked bigger hosts and still lost 1.2x.
  { ...SHIPPED_SPREAD, name: "round-3 caps (p2+f0)", maxPushers: 2, maxFrontier: 0 },
  { ...SHIPPED_SPREAD, name: "no induce", induce: false },
  { ...SHIPPED_SPREAD, name: "spare slack 2 + ram/dist", spareSlack: 2, spareScoring: "ramPerDistance" },
  // The round-5 descent pipeline's standing losers (depth-36 evidence, 6
  // paired seeds: both on 33.3 min, ferry race alone 38.7, pre-charge alone
  // 41.3, neither 53.3): racing carriers multiplies gap-crossing landings per
  // wave, and pre-charging an about-to-crack target overlaps its whole
  // induce wave with the final authenticate.
  { ...SHIPPED_SPREAD, name: "no pre-charge", precharge: false },
  { ...SHIPPED_SPREAD, name: "single ferry per band", maxFerriesPerBand: 1 },
];

// The two worlds the sweep runs against. Rung 0 is the round-2 baseline world;
// the DEEP tier (3 augs -> ub3r_l4byr1nth, depth 23, air gaps at 8 and 16,
// stasis limit 3) is where induce, ferrying, and spare placement actually
// exist. Deep cases run ~10-50x longer, so the tier gets fewer seeds.
const tiers: { name: string; augs: number; redPill?: boolean; seeds: number; capMs?: number }[] = [
  { name: "rung 0 (depth 7)", augs: 0, seeds: seedCount },
  { name: "deep (depth 23)", augs: 3, seeds: Math.max(8, Math.floor(seedCount / 4)), capMs: 3 * 60 * 60 * 1000 },
  // The two deepest worlds: 6 augs -> et3rn4l (three air gaps), and with the
  // Red Pill installed -> b0nus at depth 36 (FOUR gaps, the full dnet — the
  // "complete a dnet" question). Few seeds: a case is minutes of wall clock.
  { name: "deepest (depth 29)", augs: 6, seeds: Math.max(6, Math.floor(seedCount / 8)), capMs: 6 * 60 * 60 * 1000 },
  { name: "full dnet (depth 36)", augs: 6, redPill: true, seeds: Math.max(4, Math.floor(seedCount / 10)), capMs: 6 * 60 * 60 * 1000 },
];

for (const tier of tiers) {
  const seeds = Array.from({ length: tier.seeds }, (_, index) => index + 1);
  const runs = new Map<string, SpreadRun[]>(policies.map((policy) => [
    policy.name,
    seeds.map((seed) => runSpreadCase(generateNet(seed, { augs: tier.augs, ...(tier.redPill ? { redPill: true } : {}) }), policy, tier.capMs)),
  ]));

  console.log(
    `\n=== ${tier.name}: ${tier.seeds} seeded worlds, cold start on darkweb ===\n`
    + "Real planners (candidatesFrom/planSpread/deriveTasks/planHold/planFarm) against the real\n"
    + "DarknetSystem mutation clock; execution abstracted to the transcribed rates.ts waits.",
  );

  console.table(policies.map((policy) => {
    const held = runs.get(policy.name)!;
    const summary = summarizeSpreadRuns(held);
    const bands = held.map((run) => run.msToAllBandsReached).filter((v): v is number => v !== undefined);
    return {
      policy: summary.policy,
      solved: `${summary.solved}/${summary.cases}`,
      "walker start (min)": (summary.meanMsToWalkerStart / 60_000).toFixed(2),
      "bands reached (min)": bands.length > 0
        ? (bands.reduce((a, b) => a + b, 0) / bands.length / 60_000).toFixed(2)
        : "-",
      "induce calls": Math.round(held.reduce((a, r) => a + r.induceCalls, 0) / held.length),
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
}
