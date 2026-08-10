import { describe, expect, test } from "bun:test";
import { goalFrom } from "../../shared/goals/goal.ts";
import { parseGoal } from "../../shared/goals/presets.ts";
import type { LogRecord } from "../../shared/telemetry/schema.ts";
import type { Planner } from "../../shared/world.ts";
import { DEFAULT_NETWORK } from "../network.ts";
import { runSim } from "../run.ts";

describe("runSim initialization", () => {
  test("reaches an initial money goal at time zero without invoking the planner", () => {
    let initCalls = 0;
    let planCalls = 0;
    const planner: Planner<null> = {
      init: () => {
        initCalls++;
        return null;
      },
      plan: () => {
        planCalls++;
        return { actions: [], memory: null };
      },
    };

    const result = runSim({
      goal: parseGoal("money:1000"),
      seed: 1,
      horizonMs: 1,
      planner: planner as Planner<unknown>,
      world: { startingMoney: 1_000 },
    });

    expect(result).toMatchObject({
      reached: true,
      timeToGoalMs: 0,
      stoppedBecause: "goal",
      validity: "partial",
      scenario: "synthetic-early-game",
    });
    expect(initCalls).toBe(0);
    expect(planCalls).toBe(0);
  });

  test("delivers the complete initial snapshot to the record sink in sequence order", () => {
    const records: LogRecord[] = [];
    runSim({
      goal: parseGoal("money:1000"),
      seed: 7,
      horizonMs: 1,
      onRecord: (line) => records.push(JSON.parse(line) as LogRecord),
    });

    expect(records.map((record) => record.seq)).toEqual(records.map((_, index) => index));
    expect(records[0]).toMatchObject({ kind: "event", name: "sim.started", seq: 0, src: "sim" });
    expect(records[1]).toMatchObject({ kind: "state", key: "getPlayer", seq: 1, src: "sim" });
    const initialServers = records.filter(
      (record) => record.kind === "state" && record.key.startsWith("getServer:"),
    );
    // Derived, not hardcoded: home plus the network. A literal here goes stale
    // every time a server is added and says nothing about the property under
    // test, which is that EVERY server is snapshotted before the run starts.
    expect(initialServers.length).toBe(DEFAULT_NETWORK.length + 1);
    expect(initialServers.some((record) => record.kind === "state" && record.key === "getServer:home")).toBe(true);
    expect(records.some((record) => record.kind === "event" && record.name === "sim.meta")).toBe(true);
    expect(records.at(-1)).toMatchObject({ kind: "event", name: "sim.result" });
  });

  test("continues emitting and evaluating records after an unsatisfied initial state", () => {
    const records: LogRecord[] = [];
    const goal = goalFrom("root-n00dles", { servers: { n00dles: { hasAdminRights: true } } });
    const result = runSim({
      goal,
      seed: 1,
      horizonMs: 60_000,
      onRecord: (line) => records.push(JSON.parse(line) as LogRecord),
    });

    expect(result.reached).toBe(true);
    expect(records.some((record) => record.kind === "event" && record.name === "nuke")).toBe(true);
    expect(
      records.some(
        (record) =>
          record.kind === "state" &&
          record.key === "getServer:n00dles" &&
          (record.data as { hasAdminRights?: boolean }).hasAdminRights === true,
      ),
    ).toBe(true);
  });
});
