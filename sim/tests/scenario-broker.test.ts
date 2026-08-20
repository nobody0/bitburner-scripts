import { expect, test } from "bun:test";
import { scenarioDescribe } from "./scenario-lane.ts";
import { only } from "../../shared/features/profile.ts";
import { parseGoals } from "../../shared/goals/presets.ts";
import { runGame } from "../game-run.ts";

const FARM = {
  hostname: "broker-farm",
  organizationName: "scenario",
  hackDifficulty: 3,
  currentDifficulty: 1,
  moneyAvailable: 1e7,
  currentMoney: 2.5e8,
  requiredHackingSkill: 1,
  serverGrowth: 100,
  numOpenPortsRequired: 0,
  maxRam: 0,
} as const;

const CSEC = {
  hostname: "CSEC",
  organizationName: "CyberSec",
  hackDifficulty: 3,
  currentDifficulty: 1,
  moneyAvailable: 0,
  currentMoney: 0,
  requiredHackingSkill: 1,
  serverGrowth: 1,
  numOpenPortsRequired: 1,
  maxRam: 0,
} as const;

scenarioDescribe("scenario: dodge broker", () => {
  test("an above-floor request queues and drains on a worker landing", async () => {
    // Pins the broker/controller seam: faction/career discovery creates a
    // deferrable request larger than the guaranteed dynamic floor while the
    // farm is active. It must remain queued (never denied or low-priority-
    // preempted) until an ordinary farm worker frees a block.
    let queuedKey: string | undefined;
    let sawDrainedAfterQueue = false;
    let sawProgramWork = false;
    let preemptions = 0;
    let landedAtQueue = 0;
    let maxLanded = 0;
    let queueGone = false;

    const result = await runGame({
      goal: parseGoals(["faction:CyberSec"]),
      seed: 11,
      horizonMs: 10 * 60_000,
      bitnode: 4,
      homeRam: 32,
      startingMoney: 1_000,
      person: { skills: { hacking: 100 }, exp: { hacking: 1_000_000 } },
      features: only("hacking", "factions", "career", "progression"),
      network: [FARM, CSEC],
      topology: {
        home: [FARM.hostname, CSEC.hostname],
        [FARM.hostname]: ["home"],
        [CSEC.hostname]: ["home"],
      },
      telemetry: true,
      onRecord: (line) => {
        let record: { kind?: string; key?: string; name?: string; data?: Record<string, unknown> };
        try { record = JSON.parse(line) as typeof record; } catch { return; }
        if (record.kind === "event" && record.name === "ram.preempt") preemptions += 1;
        // `ramArena` is its own topic now, split out of `progression`.
        if (record.kind === "state" && record.key === "ramArena" && record.data) {
          const arena = record.data as {
            waits?: Array<{ by?: string; id?: string; class?: string; gb?: number }>;
            guaranteedDynamicGb?: number;
          };
          if (!queuedKey) {
            const queued = arena.waits?.find((entry) =>
              entry.class === "deferrable"
              && typeof entry.gb === "number"
              && entry.gb > (arena.guaranteedDynamicGb ?? Infinity)
            );
            if (queued) {
              queuedKey = `${queued.by}:${queued.id}`;
              landedAtQueue = maxLanded;
            }
          } else {
            queueGone = !(arena.waits ?? []).some((entry) => `${entry.by}:${entry.id}` === queuedKey);
            if (queueGone && maxLanded > landedAtQueue) sawDrainedAfterQueue = true;
          }
        }
        if (record.kind === "state" && record.key === "career") {
          const work = record.data?.currentWork as { type?: string } | undefined;
          if (work?.type?.toUpperCase().includes("PROGRAM")) sawProgramWork = true;
        }
        if (record.kind === "state" && record.key === "farm") {
          const landed = record.data?.landed as { hack?: number; grow?: number; weaken?: number } | undefined;
          if (landed) {
            maxLanded = Math.max(maxLanded, (landed.hack ?? 0) + (landed.grow ?? 0) + (landed.weaken ?? 0));
            if (queueGone && maxLanded > landedAtQueue) sawDrainedAfterQueue = true;
          }
        }
      },
    });

    expect(result.validity).not.toBe("invalid-for-goal");
    expect(queuedKey).toBeDefined();
    expect(sawDrainedAfterQueue).toBe(true);
    expect(sawProgramWork).toBe(true);
    expect(preemptions).toBe(0);
  }, 120_000);
});
