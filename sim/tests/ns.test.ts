import { describe, expect, test } from "bun:test";
import type { Server } from "@ns";
import { homeDodgeBudget } from "../../game/lib/probe-runner.ts";
import { parseGoals } from "../../shared/goals/presets.ts";
import { ramCostContext, runGame } from "../game-run.ts";
import { getFunctionRamCost, getRamCost } from "../ns/ram-costs.ts";

/** The synthetic ns exists to run game/ for real. These pin the mechanics that
 * make that possible, and the end-to-end proof that it does. */

describe("ram costs", () => {
  test("prices the gate batch as the game does", () => {
    // game/lib/probes/gates.ts budgets 1.5 GB and documents ~1.1 GB actual.
    const methods = [
      "getResetInfo",
      "gang.inGang",
      "bladeburner.inBladeburner",
      "corporation.hasCorporation",
      "stock.hasWseAccount",
      "stock.hasTixApiAccess",
      "go.getGameState",
    ];
    const total = methods.reduce((sum, m) => sum + getRamCost(m), 0);
    expect(total).toBeCloseTo(1.1, 10);
  });

  test("matches the costs tests/ram-budget.test.ts pins", () => {
    expect(getRamCost("getPlayer")).toBe(0.5);
    expect(getRamCost("exec")).toBe(1.3);
    expect(getRamCost("getServer")).toBe(2);
    expect(getRamCost("getServerMoneyAvailable")).toBe(0.1);
    expect(getRamCost("getServerSecurityLevel")).toBe(0.1);
    expect(getRamCost("scp")).toBe(0.6);
    expect(getRamCost("scan")).toBe(0.2);
    expect(getRamCost("ls")).toBe(0.2);
    expect(getRamCost("ps")).toBe(0.2);
    expect(getRamCost("kill")).toBe(0.5);
    expect(getRamCost("hack")).toBe(0.1);
    expect(getRamCost("grow")).toBe(0.15);
    expect(getRamCost("weaken")).toBe(0.15);
    expect(getRamCost("nuke")).toBe(0.05);
  });

  test("applies the SF4 multiplier to singularity costs", () => {
    // SF4Cost: 16x with no SF4, 4x at level 2, 1x at 3+ or inside BN4.
    expect(getRamCost("singularity.getFactionRep", {})).toBe(16);
    expect(getRamCost("singularity.getFactionRep", { sf4Level: 2 })).toBe(4);
    expect(getRamCost("singularity.getFactionRep", { sf4Level: 3 })).toBe(1);
    expect(getRamCost("singularity.getFactionRep", { bitNode: 4 })).toBe(1);
  });

  test("the game harness does not confuse the current node's Source File with SF4", () => {
    expect(getRamCost("singularity.getFactionRep", ramCostContext(5, { "5": 3 }))).toBe(16);
    expect(getRamCost("singularity.getFactionRep", ramCostContext(5, { "4": 2, "5": 3 }))).toBe(4);
    expect(getRamCost("singularity.getFactionRep", ramCostContext(4, {}))).toBe(1);
  });

  test("the internal lookup defaults unknown names to 0, but the public API is strict", () => {
    // probe-runner relies on this: 0 means free, not missing.
    expect(getRamCost("noSuchFunction")).toBe(0);
    expect(getRamCost("gang.noSuchFunction")).toBe(0);
    expect(getRamCost("sleep")).toBe(0);
    expect(getRamCost("atExit")).toBe(0);
    expect(getRamCost("getFunctionRamCost")).toBe(0);
    expect(getFunctionRamCost("baseCost")).toBe(1.6);
    expect(getFunctionRamCost("sleep")).toBe(0);
    expect(() => getFunctionRamCost("noSuchFunction")).toThrow();
    expect(() => getFunctionRamCost("gang.noSuchFunction")).toThrow();
  });
});

describe("running game/ in the synthetic world", () => {
  test("the real controller reaches a money goal", async () => {
    const result = await runGame({
      goal: parseGoals(["earn:1e6"]),
      seed: 1,
      horizonMs: 60 * 60_000,
      homeRam: 16,
      label: "test",
    });

    expect(result.reached).toBe(true);
    expect(result.stoppedBecause).toBe("goal");
    // No script may die of anything but a deliberate kill.
    expect(result.crashes).toEqual([]);
    // The controller announces itself, which proves start.js's main ran.
    expect(result.output[0]).toContain("start.js online");
    expect(result.records).toBeGreaterThan(100);
    expect(result.validity).toBe("valid");
  });

  test("the run is deterministic for a fixed seed", async () => {
    const run = () =>
      runGame({ goal: parseGoals(["earn:1e6"]), seed: 7, horizonMs: 60 * 60_000, homeRam: 16, label: "det" });
    const [a, b] = [await run(), await run()];
    expect(a.timeToGoalMs).toBe(b.timeToGoalMs);
    expect(a.records).toBe(b.records);
  });

  test("the sweep roots and deploys, and the dispatcher lands real ops", async () => {
    let farm: { landed?: Record<string, number>; totals?: Record<string, number> } | undefined;
    const events = new Set<string>();
    await runGame({
      goal: parseGoals(["earn:1e6"]),
      seed: 1,
      horizonMs: 60 * 60_000,
      homeRam: 16,
      onRecord: (line) => {
        const record = JSON.parse(line) as { kind: string; key?: string; name?: string; data?: unknown };
        if (record.kind === "state" && record.key === "farm") farm = record.data as typeof farm;
        if (record.kind === "event" && record.name) events.add(record.name);
      },
    });

    // Rooting happened through the real net.ts closures inside a real dodge stub.
    expect(events.has("net.rooted")).toBe(true);
    // And all three op kinds actually completed against the vendored formulas.
    expect(farm?.landed?.["hack"]).toBeGreaterThan(0);
    expect(farm?.landed?.["grow"]).toBeGreaterThan(0);
    expect(farm?.landed?.["weaken"]).toBeGreaterThan(0);
    expect(farm?.totals?.["moneyEarned"]).toBeGreaterThan(1e6);
  });

  test("worker completions wake the dispatcher between ticks", async () => {
    // Farm records are dirty-field deltas, so track the running maximum
    // rather than reading one arbitrary record.
    let maxWakePumps = 0;
    let landed = 0;
    await runGame({
      goal: parseGoals(["earn:1e6"]),
      seed: 1,
      horizonMs: 60 * 60_000,
      homeRam: 16,
      onRecord: (line) => {
        const record = JSON.parse(line) as {
          kind: string;
          key?: string;
          data?: { wakePumps?: number; landed?: Record<string, number> };
        };
        if (record.kind !== "state" || record.key !== "farm") return;
        maxWakePumps = Math.max(maxWakePumps, record.data?.wakePumps ?? 0);
        const l = record.data?.landed;
        if (l) landed = Math.max(landed, (l["hack"] ?? 0) + (l["grow"] ?? 0) + (l["weaken"] ?? 0));
      },
    });

    // Ops landed, so their atExit poked dispatch_wake — the controller must
    // have run early pumps, not just the 200 ms tick. The throttle (25 ms,
    // ≤4/frame) means wakePumps < landings, but it must be non-zero: zero
    // means the wake resolver was never armed (the pre-wake bug, where
    // spec/targeting.md documented a mechanism that did not exist).
    expect(landed).toBeGreaterThan(0);
    expect(maxWakePumps).toBeGreaterThan(0);
  });

  test("the capability gate detects the BitNode and derives unlocks", async () => {
    let caps: { bitNode?: number; unlocked?: Record<string, string> } | undefined;
    await runGame({
      goal: parseGoals(["earn:1e6"]),
      seed: 1,
      horizonMs: 60 * 60_000,
      homeRam: 16,
      onRecord: (line) => {
        const record = JSON.parse(line) as { kind: string; key?: string; data?: unknown };
        if (record.kind === "state" && record.key === "capabilities") caps = record.data as typeof caps;
      },
    });

    expect(caps?.bitNode).toBe(1);
    // Always-playable five.
    expect(caps?.unlocked?.["hacking"]).toBe("yes");
    expect(caps?.unlocked?.["progression"]).toBe("yes");
    // A fresh BN1 save holds no source files, so the node-gated features lock.
    expect(caps?.unlocked?.["factions"]).toBe("no");
    expect(caps?.unlocked?.["gang"]).toBe("no");
    expect(caps?.unlocked?.["corp"]).toBe("no");
  });

  test("gates can be opened, and unlocking is observable", async () => {
    let caps: { unlocked?: Record<string, string> } | undefined;
    await runGame({
      goal: parseGoals(["earn:1e6"]),
      seed: 1,
      horizonMs: 60 * 60_000,
      homeRam: 16,
      gates: { inGang: true, hasWseAccount: true },
      onRecord: (line) => {
        const record = JSON.parse(line) as { kind: string; key?: string; data?: unknown };
        if (record.kind === "state" && record.key === "capabilities") caps = record.data as typeof caps;
      },
    });

    expect(caps?.unlocked?.["gang"]).toBe("yes");
    expect(caps?.unlocked?.["stock"]).toBe("yes");
  });

  test("unmodelled surface is reported by name and never crashes a run", async () => {
    const result = await runGame({
      goal: parseGoals(["earn:1e6"]),
      seed: 1,
      horizonMs: 60 * 60_000,
      homeRam: 16,
      label: "gaps",
      gates: { goPlayable: true },
    });

    // Probes for features we do not simulate hit the wall and say so...
    const gaps = Object.keys(result.unmodeled);
    expect(gaps.length).toBeGreaterThan(0);
    // Every gap names a real ns path or subsystem rather than a bare
    // placeholder. Deliberately NOT pinned to a specific call: as feature
    // slices land, individual gaps close, and a hardcoded name turns that
    // progress into a test failure.
    expect(gaps.every((gap) => /^(ns|subsystem) \S/.test(gap))).toBe(true);
    // ...with no leading-dot mangling of the root namespace...
    expect(gaps.every((gap) => !gap.includes(" ."))).toBe(true);
    // ...and the run still completes, because probe-runner isolates each probe.
    expect(result.reached).toBe(true);
    expect(result.crashes).toEqual([]);
    expect(result.validity).toBe("invalid-for-goal");
    expect(result.scenario).toBe("synthetic-early-game");
  });

  test("a fresh 8GB home still cannot fund a dodge on home ALONE", () => {
    // The underlying arithmetic, pinned so the motivation for fleet placement
    // cannot quietly stop being true: the sweep snapshots the network from
    // INSIDE a 4.1 GB dodge stub, so home.ramUsed carries the stub's own
    // footprint. 8 - 3.6 (controller) - 4.1 (stub) - 1.6 - 0.5 is negative,
    // and a home-only budget skips the capability gate batch forever.
    const home = { hostname: "home", maxRam: 8, ramUsed: 3.6 + 4.1 } as Server;
    expect(homeDodgeBudget({ home })).toBe(0);
  });

  test("...but fleet placement funds it anyway, so features actually unlock", async () => {
    // The Phase 0.4 payoff, and the reason this test is the inverse of what it
    // used to assert. The stub ships to every rooted host alongside the
    // worker, so a 1.5 GB gate batch lands on a client instead of competing
    // with the dispatcher for a home reserve that can never hold it. Before
    // fleet dodging, `capabilities` was NEVER emitted on an 8 GB home and no
    // gated feature could ever be discovered.
    let caps: { data: { unlocked: Record<string, string> } } | undefined;
    const result = await runGame({
      goal: parseGoals(["earn:1e6"]),
      seed: 1,
      horizonMs: 60 * 60_000,
      homeRam: 8,
      onRecord: (line) => {
        const record = JSON.parse(line) as {
          kind: string;
          key?: string;
          data: { unlocked: Record<string, string> };
        };
        if (record.kind === "state" && record.key === "capabilities") caps = record;
      },
    });

    expect(caps, "the gate batch never ran — fleet placement is not funding it").toBeDefined();
    // A real reading, not the all-unknown placeholder.
    expect(caps!.data.unlocked.hacking).toBe("yes");
    expect(caps!.data.unlocked.factions).toBe("no");
    expect(result.reached).toBe(true);
  });
});
