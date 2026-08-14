import { expect, test } from "bun:test";
import { scenarioDescribe } from "./scenario-lane.ts";
import { only } from "../../shared/features/profile.ts";
import { parseGoals } from "../../shared/goals/presets.ts";
import { runGame } from "../game-run.ts";

/** A prepped, high-value farm makes the share decision about reputation
 * opportunity cost, not startup prep. Seed and topology are fixed so the
 * observable split is deterministic. */
const TARGET = {
  hostname: "share-target",
  organizationName: "scenario",
  hackDifficulty: 3,
  currentDifficulty: 1,
  moneyAvailable: 1e8,
  currentMoney: 2.5e9,
  requiredHackingSkill: 1,
  serverGrowth: 100,
  numOpenPortsRequired: 0,
  maxRam: 0,
} as const;

async function shareRun(reputationDemand: boolean) {
  let maxShareGb = 0;
  let maxFleetGb = 0;
  const result = await runGame({
    goal: parseGoals([reputationDemand ? "rep:CyberSec:1e12" : "earn:1e30"]),
    seed: 7,
    horizonMs: 5 * 60_000,
    bitnode: reputationDemand ? 4 : 1,
    homeRam: 256,
    startingMoney: 1e6,
    person: { skills: { hacking: 250 }, exp: { hacking: 6_250_000 } },
    ...(reputationDemand ? {
      playerState: { factions: ["CyberSec"] },
      factions: { CyberSec: { rep: 0, favor: 0 } },
      features: only("hacking", "factions", "career", "progression"),
    } : { features: only("hacking", "progression") }),
    network: [TARGET],
    topology: { home: [TARGET.hostname], [TARGET.hostname]: ["home"] },
    telemetry: true,
    onRecord: (line) => {
      let record: { kind?: string; key?: string; data?: Record<string, unknown> };
      try { record = JSON.parse(line) as typeof record; } catch { return; }
      if (record.kind === "state" && record.key === "farm") {
        const pie = record.data?.ramPie as { share?: number } | undefined;
        if (typeof pie?.share === "number") maxShareGb = Math.max(maxShareGb, pie.share);
      }
      if (record.kind === "state" && record.key === "fleet" && typeof record.data?.maxRam === "number") {
        maxFleetGb = Math.max(maxFleetGb, record.data.maxRam);
      }
    },
  });
  return { result, maxShareGb, maxFleetGb };
}

scenarioDescribe("scenario: share allocation", () => {
  test("reputation on the critical path receives a non-zero bounded slice", async () => {
    // Pins the marginal crossing end to end. It would catch both the old
    // whole-fleet seizure and a disconnected share driver that always stays 0.
    const run = await shareRun(true);
    expect(run.result.validity).not.toBe("invalid-for-goal");
    expect(run.maxShareGb).toBeGreaterThan(0);
    expect(run.maxShareGb).toBeLessThan(run.maxFleetGb);
  }, 120_000);

  test("without reputation demand share remains zero", async () => {
    // Share is a RAM taker: absent demand is not permission to consume spare
    // capacity. This control catches a stale objective leaking across runs.
    const run = await shareRun(false);
    expect(run.result.validity).not.toBe("invalid-for-goal");
    expect(run.maxShareGb).toBe(0);
  }, 120_000);
});
