import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { setGoNeuralRuntimeForTest } from "../../game/lib/features/remaining.ts";
import { parseGoals } from "../../shared/goals/presets.ts";
import { only } from "../../shared/features/profile.ts";
import { ramCostContext, runGame } from "../game-run.ts";
import { getFunctionRamCost, getRamCost } from "../ns/ram-costs.ts";
import { StubGoValueBackend } from "../../tests/support/go-value-backend.ts";
import { TestGoNeuralRuntime } from "../../tests/support/go-neural-runtime.ts";
import { Clock } from "../clock.ts";
import { installVirtualTime } from "../realm/timers.ts";
import { calculateExp } from "../vendor/bitburner/src/PersonObjects/formulas/skill.ts";
import { lane } from "../../tests/support/lanes.ts";

/** The synthetic ns exists to run game/ for real. These pin the mechanics that
 * make that possible, and the end-to-end proof that it does. */

// Controller scenarios exercise a complete async Netscript/process lifecycle.
// Several finish in 5-6 seconds on a busy host, so Bun's 5 second default can
// abandon runGame while its process-wide virtual-time realm is still installed.
// That turns one timeout into cascading failures in later virtual-time files.
setDefaultTimeout(30_000);

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
    expect(getFunctionRamCost("formulas.dnet.getAuthenticateTime")).toBe(0);
    expect(() => getFunctionRamCost("formulas.dnet")).toThrow("invalid type");
    expect(() => getFunctionRamCost("noSuchFunction")).toThrow();
    expect(() => getFunctionRamCost("gang.noSuchFunction")).toThrow();
  });
});

/** The whole controller driven through virtual game time — the integration
 * run, not a unit check. It installs process-wide virtual time, so it also has
 * to stay out of a process shared with anything else. `bun run long world`,
 * or `bun run long bn1`. */
lane({ feature: "world", bn: 1 }).describe("running game/ in the synthetic world", () => {
  beforeAll(() => {
    setGoNeuralRuntimeForTest(new TestGoNeuralRuntime((weights) => new StubGoValueBackend(weights)));
  });

  afterAll(() => {
    setGoNeuralRuntimeForTest();
  });

  test("the real controller completes Go games and records its selections", async () => {
    let games = 0;
    const selected = new Set<string>();
    const result = await runGame({
      goal: parseGoals(["earn:1e30"]),
      seed: 1,
      horizonMs: 10 * 60_000,
      homeRam: 1_024,
      label: "go-integration",
      features: only("hacking", "progression", "go"),
      onRecord: (line) => {
        const record = JSON.parse(line) as {
          kind: string;
          key?: string;
          name?: string;
          data?: {
            stats?: { bonusPercent: number }[];
            plan?: { selection?: { preferred?: { opponent?: string } } };
          };
        };
        if (record.kind === "event" && record.name === "go.game") games++;
        if (record.kind !== "state" || record.key !== "go") return;
        const opponent = record.data?.plan?.selection?.preferred?.opponent;
        if (opponent) selected.add(opponent);
      },
    });

    expect(result.stoppedBecause).toBe("horizon");
    expect(result.validity).toBe("valid");
    expect(result.crashes).toEqual([]);
    expect(games).toBeGreaterThanOrEqual(2);
    expect(selected.size).toBeGreaterThanOrEqual(1);
    expect(Object.keys(result.unmodeled).filter((gap) => gap.toLowerCase().includes("go"))).toEqual([]);
  }, 10_000);

  test("the real controller reaches a money goal", async () => {
    const result = await runGame({
      goal: parseGoals(["earn:1e6"]),
      seed: 1,
      horizonMs: 60 * 60_000,
      homeRam: 16,
      label: "test",
      features: only("hacking", "progression"),
    });

    expect(result.reached).toBe(true);
    expect(result.stoppedBecause).toBe("goal");
    // No script may die of anything but a deliberate kill.
    expect(result.crashes).toEqual([]);
    // The controller announces itself, which proves start.js's main ran.
    expect(result.output[0]).toContain("start.js online");
    expect(result.records).toBeGreaterThan(100);
    expect(result.validity).toBe("valid");
  }, 10_000);

  test("a setup failure restores every process-wide virtual primitive", async () => {
    const realDate = Date;
    const realRandom = Math.random;
    await expect(runGame({
      goal: parseGoals(["earn:1"]),
      seed: 1,
      horizonMs: 1_000,
      homeRam: 1,
      features: only("hacking"),
    })).rejects.toThrow("too little RAM");
    expect(Date).toBe(realDate);
    expect(Math.random).toBe(realRandom);
    const probe = installVirtualTime(new Clock());
    probe.restore();
  });

  test("the sweep roots and deploys, and the dispatcher lands real ops", async () => {
    let farm: { landed?: Record<string, number>; totals?: Record<string, number> } | undefined;
    const events = new Set<string>();
    await runGame({
      goal: parseGoals(["earn:1e6"]),
      seed: 1,
      horizonMs: 60 * 60_000,
      homeRam: 16,
      features: only("hacking", "progression"),
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
      features: only("hacking", "progression"),
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
    // ≤4/frame for ordinary completions; queued weakens bypass it) still
    // coalesces many landings, but it must be non-zero: zero
    // means the wake resolver was never armed (the pre-wake bug, where
    // spec/targeting.md documented a mechanism that did not exist).
    expect(landed).toBeGreaterThan(0);
    expect(maxWakePumps).toBeGreaterThan(0);
  });

  test("the capability gate detects the BitNode and derives unlocks", async () => {
    let caps: { bitNode?: number; sourceFiles?: Record<string, number>; unlocked?: Record<string, string> } | undefined;
    await runGame({
      goal: parseGoals(["earn:1e30"]),
      seed: 1,
      horizonMs: 30_000,
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
    expect(caps?.unlocked?.["go"]).toBe("yes");
    // The save is fresh, but controller runs explicitly receive SF4.3 so the
    // otherwise-manual Singularity boundary can be automated.
    expect(caps?.sourceFiles?.["4"]).toBe(3);
    expect(caps?.unlocked?.["factions"]).toBe("yes");
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
      features: only("hacking", "progression", "gang", "stock"),
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
      // The SF4 automation allowance intentionally unlocks the modeled
      // Singularity surface. Seed an actually unmodeled subsystem so this test
      // continues to exercise gap reporting rather than depending on SF4=0.
      gates: { inGang: true },
      features: { go: "off" },
    });

    // Probes for features we do not simulate hit the wall and say so...
    const gaps = Object.keys(result.unmodeled);
    expect(gaps.length).toBeGreaterThan(0);
    // Every gap names a real ns path or subsystem rather than a bare
    // placeholder. Deliberately NOT pinned to a specific call: as feature
    // slices land, individual gaps close, and a hardcoded name turns that
    // progress into a test failure.
    expect(gaps.every((gap) => /^(ns|subsystem|initial-state) \S/.test(gap))).toBe(true);
    // ...with no leading-dot mangling of the root namespace...
    expect(gaps.every((gap) => !gap.includes(" ."))).toBe(true);
    // ...and the run still completes, because probe-runner isolates each probe.
    expect(result.reached).toBe(true);
    expect(result.crashes).toEqual([]);
    expect(result.validity).toBe("invalid-for-goal");
    expect(result.scenario).toBe("synthetic-early-game");
  });

  test("the ten-minute coding-contract interval cannot pass silently", async () => {
    const result = await runGame({
      goal: parseGoals(["earn:1e99"]),
      seed: 1,
      horizonMs: 10 * 60_000 + 1,
      homeRam: 16,
      features: only("hacking", "progression", "side"),
    });

    expect(result.unmodeled["subsystem coding contract generation"]).toBe(1);
    expect(result.validity).toBe("invalid-for-goal");
  });

  test("an installed Red Pill acquires the final opener and completes the real daemon transition", async () => {
    const events: { name?: string; data?: Record<string, unknown> }[] = [];
    const result = await runGame({
      goal: parseGoals(["bn:1"]),
      seed: 1,
      horizonMs: 120_000,
      bitnode: 1,
      homeRam: 1_024,
      startingMoney: 1e9,
      features: only("hacking", "progression"),
      network: [
        { hostname: "The-Cave", hackDifficulty: 100, moneyAvailable: 0, requiredHackingSkill: 925, serverGrowth: 0, numOpenPortsRequired: 5, maxRam: 0 },
        { hostname: "w0r1d_d43m0n", hackDifficulty: 100, moneyAvailable: 0, requiredHackingSkill: 3_000, serverGrowth: 0, numOpenPortsRequired: 5, maxRam: 0 },
      ],
      topology: {
        home: ["The-Cave"],
        "The-Cave": ["home", "w0r1d_d43m0n"],
        w0r1d_d43m0n: ["The-Cave"],
      },
      person: { skills: { hacking: 3_000 }, exp: { hacking: calculateExp(3_000) } },
      playerState: {
        augmentations: [{ name: "The Red Pill", level: 1 }],
        sourceFiles: { "4": 3 },
      },
      homeFiles: ["BruteSSH.exe", "FTPCrack.exe", "relaySMTP.exe", "HTTPWorm.exe"],
      telemetry: false,
      recordFilter: (record) => record.kind === "event",
      onRecord: (line) => events.push(JSON.parse(line)),
    });

    expect(result.reached).toBe(true);
    expect(result.validity).toBe("valid");
    expect(result.unmodeled).toEqual({});
    expect(result.crashes).toEqual([]);
    expect(events).toContainEqual(expect.objectContaining({
      name: "program.bought",
      data: { program: "SQLInject.exe", cost: 250_000_000 },
    }));
    expect(events).toContainEqual(expect.objectContaining({
      name: "bitnode.reset",
      data: expect.objectContaining({ from: 1, to: 1, callback: "start.js" }),
    }));
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
      features: only("hacking", "progression"),
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
    expect(caps!.data.unlocked.factions).toBe("yes");
    expect(result.reached).toBe(true);
  });
});
