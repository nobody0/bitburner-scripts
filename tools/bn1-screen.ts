/** Screening harness for the BN1 route: run `bn1-full` for a bounded slice and
 * report the handful of numbers the route decisions actually move.
 *
 * Deliberately NOT a benchmark. A short slice cannot say how long BN1 takes; it
 * says whether the run installs at all, how fast augmentations accumulate, and
 * whether the route estimate is sane — which is what the install-cadence and
 * package-size knobs change. Confirm anything promising with a full
 * `bun run sim --profile bn1-full --compact` before believing it.
 *
 *   bun run tools/bn1-screen.ts [--hours 4] [--seed 1] [--label baseline]
 */
import { parseGoals } from "../shared/goals/presets.ts";
import { findProfile } from "../sim/profiles.ts";
import { runGame } from "../sim/game-run.ts";
import { AGGREGATE_GO_MODEL } from "../sim/fidelity.ts";

const args = process.argv.slice(2);
const arg = (name: string, fallback: string): string => {
  const index = args.indexOf(`--${name}`);
  return index >= 0 && args[index + 1] !== undefined ? args[index + 1]! : fallback;
};
const hours = Number(arg("hours", "4"));
const seed = Number(arg("seed", "1"));
const label = arg("label", "screen");

const profile = findProfile("bn1-full");
let t0 = 0;
const installAt: number[] = [];
let augCount = 0;
let hackingSkill = 0;
let money = 0;
let routeEtaSec = Infinity;
const parts = new Map<string, number>();
/** Why the reset did or did not happen, counted over the whole slice. */
const verdicts = new Map<string, number>();
const blockers = new Map<string, number>();
let lastPlan: Record<string, unknown> = {};
const factionActions = new Map<string, number>();
const factionResults = new Map<string, number>();
let lastFactions: Record<string, unknown> = {};
const slotHolders = new Map<string, number>();
const slotBids = new Map<string, { n: number; sum: number }>();

await runGame({
  goal: parseGoals(["bn:1", "installs:2"]),
  seed,
  horizonMs: hours * 3_600_000,
  bitnode: profile.bitnode!,
  homeRam: profile.homeRam!,
  features: profile.features,
  // Same Go fidelity `sim/run.ts` gives the benchmark. Without it this harness
  // is screening a different game than the one being measured.
  goFidelity: AGGREGATE_GO_MODEL,
  ...profile.world,
  telemetry: true,
  onRecord: (line) => {
    let record: any;
    try { record = JSON.parse(line); } catch { return; }
    t0 ||= record.t;
    if (record.kind === "event" && record.name === "sim.prestige") {
      installAt.push((record.t - t0) / 1_000);
      return;
    }
    if (record.kind !== "state") return;
    if (record.key === "player") {
      hackingSkill = record.data?.skills?.hacking ?? hackingSkill;
      money = record.data?.money ?? money;
    }
    if (record.key === "arbitration") {
      const slot = record.data?.slot;
      if (slot) slotHolders.set(`${slot.by}:${slot.id}`, (slotHolders.get(`${slot.by}:${slot.id}`) ?? 0) + 1);
      for (const bid of record.data?.slotValues ?? []) {
        const key = `${bid.by}:${bid.id} (${bid.pricing})`;
        const entry = slotBids.get(key) ?? { n: 0, sum: 0 };
        entry.n++;
        entry.sum += bid.valueSec ?? 0;
        slotBids.set(key, entry);
      }
    }
    if (record.key === "factions") {
      const plan = record.data?.plan;
      if (plan) {
        const action = `${plan.action?.type}${plan.action?.awaitingWorkSlot ? "/slot-held" : ""}: ${String(plan.action?.why ?? "").slice(0, 60)}`;
        factionActions.set(action, (factionActions.get(action) ?? 0) + 1);
        const result = plan.lastResult ? `${plan.lastResult.action}:${plan.lastResult.ok ? "ok" : "no"}:${String(plan.lastResult.detail).slice(0, 44)}` : "-";
        factionResults.set(result, (factionResults.get(result) ?? 0) + 1);
        lastFactions = {
          action,
          intent: plan.objective?.intent?.faction,
          repTarget: plan.objective?.intent?.repTarget,
          recommendInstall: plan.recommendInstall !== undefined,
          drainCeiling: plan.drainCeiling,
          nextBuy: plan.nextBuy?.name,
          nextBuyPrice: plan.nextBuy?.price,
          joined: (record.data?.joined ?? []).length,
        };
      }
    }
    if (record.key === "progression") {
      const plan = record.data?.plan;
      if (!plan) return;
      augCount = record.data?.augCount ?? augCount;
      const decision = plan.installDecision ?? {};
      const key = `${decision.verdict ?? "-"}/${decision.effective ?? "-"} wanted=${plan.installWanted} ready=${plan.installReady}`;
      verdicts.set(key, (verdicts.get(key) ?? 0) + 1);
      for (const blocker of plan.installBlockers ?? []) {
        blockers.set(blocker.kind, (blockers.get(blocker.kind) ?? 0) + 1);
      }
      lastPlan = {
        verdict: decision.verdict, effective: decision.effective,
        A: decision.resetValueMult, push: decision.pushRate, thr: decision.threshold,
        wanted: plan.installWanted, ready: plan.installReady, queued: (plan.queuedAugmentations ?? []).length,
      };
      const route = plan.routes?.find((entry: any) => entry.id === plan.route);
      if (route) {
        routeEtaSec = route.etaSec;
        for (const part of route.parts ?? []) parts.set(part.what, part.sec);
      }
    }
  },
});

const fmt = (sec: number) => Number.isFinite(sec) ? `${(sec / 3600).toFixed(2)}h` : "never";

/** Most frequent first — every tally below is read the same way. */
function tally(title: string, counts: ReadonlyMap<string, number>, limit = 6): void {
  if (counts.size === 0) return;
  console.log(`${title}:`);
  for (const [key, count] of [...counts].sort((a, b) => b[1] - a[1]).slice(0, limit)) {
    console.log(`   ${count.toString().padStart(6)}  ${key}`);
  }
}

console.log(`
=== ${label} (seed ${seed}, ${hours}h slice) ===`);
console.log(`installs      ${installAt.length}${installAt.length ? ` at ${installAt.map(fmt).join(", ")}` : ""}`);
console.log(`first install ${installAt[0] === undefined ? "NONE" : fmt(installAt[0])}`);
console.log(`augmentations ${augCount}`);
console.log(`hacking       ${hackingSkill}`);
console.log(`money         ${money.toExponential(3)}`);
console.log(`route ETA     ${fmt(routeEtaSec)}`);
for (const [what, sec] of parts) console.log(`   ${what.padEnd(38)} ${fmt(sec)}`);
console.log(`last plan     ${JSON.stringify(lastPlan)}`);
tally("verdicts", verdicts);
if (blockers.size > 0) console.log(`blockers:     ${[...blockers].map(([k, n]) => `${k} x${n}`).join(", ")}`);
tally("work slot holders", slotHolders);
console.log("work slot bids (mean BN-seconds):");
for (const [key, entry] of [...slotBids].sort((a, b) => b[1].n - a[1].n).slice(0, 8)) {
  console.log(`   ${entry.n.toString().padStart(6)}  ${key.padEnd(42)} mean=${(entry.sum / entry.n).toExponential(3)}`);
}
console.log(`last factions ${JSON.stringify(lastFactions)}`);
tally("faction actions", factionActions);
tally("faction results", factionResults);
