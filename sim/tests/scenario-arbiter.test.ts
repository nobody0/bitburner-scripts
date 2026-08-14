import { expect, test } from "bun:test";
import { scenarioDescribe } from "./scenario-lane.ts";
import { only } from "../../shared/features/profile.ts";
import { parseGoals } from "../../shared/goals/presets.ts";
import type { ArbitrationDigest } from "../../shared/telemetry/topics/progression.ts";
import { runGame } from "../game-run.ts";

/** One already-prepped target keeps these scenarios about arbitration rather
 * than prep latency. Every assertion reads telemetry emitted by the real
 * controller; none reaches into resolveClaims or simulator-owned state. */
const TARGET = {
  hostname: "arbiter-target",
  organizationName: "scenario",
  hackDifficulty: 3,
  currentDifficulty: 1,
  moneyAvailable: 1e12,
  currentMoney: 25e12,
  requiredHackingSkill: 1,
  serverGrowth: 100,
  numOpenPortsRequired: 0,
  maxRam: 0,
} as const;

interface ArbiterTrace {
  arbitrations: ArbitrationDigest[];
  purchases: string[];
  failures: string[];
}

async function arbiterRun(options: {
  startingMoney: number;
  horizonMs: number;
  hacknet?: boolean;
  homeRam?: number;
  hackingSkill?: number;
  targetMoney?: number;
}): Promise<ArbiterTrace> {
  const trace: ArbiterTrace = { arbitrations: [], purchases: [], failures: [] };
  await runGame({
    goal: parseGoals(["earn:1e30"]),
    seed: 1,
    horizonMs: options.horizonMs,
    bitnode: 1,
    homeRam: options.homeRam ?? 32,
    startingMoney: options.startingMoney,
    ...(options.hackingSkill ? {
      person: {
        skills: { hacking: options.hackingSkill },
        exp: { hacking: options.hackingSkill * options.hackingSkill * 100 },
      },
    } : {}),
    features: options.hacknet ? only("hacking", "hacknet", "progression") : only("hacking", "progression"),
    network: [{
      ...TARGET,
      ...(options.targetMoney !== undefined
        ? { moneyAvailable: options.targetMoney, currentMoney: options.targetMoney * 25 }
        : {}),
    }],
    topology: { home: [TARGET.hostname], [TARGET.hostname]: ["home"] },
    telemetry: true,
    onRecord: (line) => {
      let record: { kind?: string; key?: string; name?: string; data?: Record<string, unknown> };
      try { record = JSON.parse(line) as typeof record; } catch { return; }
      if (record.kind === "state" && record.key === "progression" && record.data?.arbitration) {
        trace.arbitrations.push(record.data.arbitration as unknown as ArbitrationDigest);
      }
      if (record.kind === "event") {
        if (record.name === "buyServer" || record.name === "upgradeServer") trace.purchases.push(record.name);
        if (record.name === "action.failed") {
          const data = record.data as { reason?: string } | undefined;
          if (data?.reason) trace.failures.push(data.reason);
        }
      }
    },
  });
  return trace;
}

function grants(trace: ArbiterTrace, by: string, id: string) {
  return trace.arbitrations.flatMap((entry) => entry.grants).filter((grant) => grant.by === by && grant.id === id);
}

scenarioDescribe("scenario: arbiter outcomes", () => {
  test("a lone affordable economic claim is granted", async () => {
    // Pins the integration defect that motivated this suite: a positive RAM
    // claim with ample cash and no competitor was denied as a zero-value outbid.
    const trace = await arbiterRun({ startingMoney: 200e6, horizonMs: 60_000 });
    expect(grants(trace, "hacking", "infrastructure:ram").some((grant) => grant.amount > 0)).toBe(true);
    expect(trace.purchases.length).toBeGreaterThan(0);
  }, 120_000);

  test("a step claim reserves income until its rung becomes affordable", async () => {
    // An indivisible infrastructure rung must accumulate cash across passes and
    // land once affordable; attempting it early recreates the stale-grant bug.
    const trace = await arbiterRun({
      startingMoney: 50_000,
      horizonMs: 20 * 60_000,
      homeRam: 256,
      hackingSkill: 500,
      targetMoney: 100_000,
    });
    expect(grants(trace, "hacking", "infrastructure:ram").some((grant) => grant.mode === "reserve" && grant.partial)).toBe(true);
    expect(trace.purchases.length).toBeGreaterThan(0);
    expect(trace.failures.some((reason) => reason.includes("insufficient money"))).toBe(false);
  }, 120_000);

  test("lambda reports both real priced participants", async () => {
    // A one-claim waterline is not a shadow price. With hacking infrastructure
    // and Hacknet both bidding in the investment band, telemetry must preserve
    // that the same lambda compared more than one priced participant.
    const trace = await arbiterRun({
      startingMoney: 5e6,
      horizonMs: 20 * 60_000,
      hacknet: true,
      hackingSkill: 100,
      targetMoney: 1e6,
    });
    const waterlines = trace.arbitrations.flatMap((entry) => entry.waterlines ?? []);
    expect(waterlines.some((entry) => entry.pricedClaimCount > 1)).toBe(true);
  }, 120_000);
});
