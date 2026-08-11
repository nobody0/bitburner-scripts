import { describe, expect, test } from "bun:test";
import { parseGoals } from "../../shared/goals/presets.ts";
import { only } from "../../shared/features/profile.ts";
import { runGame } from "../game-run.ts";
import { findProfile } from "../profiles.ts";

describe("BN1 multi-install progression profile", () => {
  test("makes reputation actionable and changes Go priorities across real installs", async () => {
    const profile = findProfile("bn1-progression");
    const opponentsByInstall: string[][] = [[]];
    const factionWorkByInstall: boolean[] = [false];
    let installs = 0;

    // The named profile continues through a third install. The regression
    // test stops at the second: that is the minimum cross-prestige window that
    // proves the capability gate, reputation work and Go retargeting together,
    // without making every `bun test` execute the whole benchmark.
    expect(profile.goals).toEqual(["augs:13", "installs:3"]);
    const result = await runGame({
      goal: parseGoals(["installs:2"]),
      seed: 1,
      horizonMs: 3 * 60 * 60_000,
      bitnode: profile.bitnode,
      homeRam: profile.homeRam,
      startingMoney: profile.startingMoney,
      features: profile.features,
      ...profile.world,
      telemetry: false,
      recordFilter: (record) => record.kind === "event" && (
        record.name === "go.game" || record.name === "faction.work" || record.name === "sim.prestige"
      ),
      onRecord: (line) => {
        const record = JSON.parse(line) as {
          name?: string;
          data?: { opponent?: string };
        };
        if (record.name === "go.game" && record.data?.opponent) {
          (opponentsByInstall[installs] ??= []).push(record.data.opponent);
        } else if (record.name === "faction.work") {
          factionWorkByInstall[installs] = true;
        } else if (record.name === "sim.prestige") {
          installs++;
          opponentsByInstall[installs] ??= [];
          factionWorkByInstall[installs] ??= false;
        }
      },
    });

    expect(result.reached).toBe(true);
    expect(result.validity).toBe("valid");
    expect(result.unmodeled).toEqual({});
    expect(result.crashes).toEqual([]);
    expect(installs).toBe(2);

    const activeCycles = opponentsByInstall.slice(0, installs).filter((opponents) => opponents.length > 0);
    expect(activeCycles).toHaveLength(2);
    const allOpponents = new Set(activeCycles.flat());
    expect(allOpponents).toEqual(new Set(["Daedalus", "Illuminati", "The Black Hand", "Netburners"]));
    expect(
      activeCycles.some((opponents, cycle) =>
        factionWorkByInstall[cycle] === true && opponents.includes("Daedalus")
      ),
    ).toBe(true);
  }, 150_000);

  test("the late JIT profile installs The Red Pill, regrows, and benefits materially from Go", async () => {
    const profile = findProfile("bn1-jit-stress");
    const run = async (withGo: boolean, horizonMs = 2 * 60 * 60_000) => {
      let installedRedPill = false;
      const opponents = new Set<string>();
      const result = await runGame({
        goal: parseGoals(profile.goals),
        seed: 1,
        horizonMs,
        bitnode: profile.bitnode,
        homeRam: profile.homeRam,
        startingMoney: profile.startingMoney,
        features: withGo ? profile.features : only("hacking", "factions", "progression"),
        ...profile.world,
        telemetry: false,
        recordFilter: (record) => record.kind === "event" && (
          record.name === "go.game" || record.name === "sim.prestige"
        ),
        onRecord: (line) => {
          const record = JSON.parse(line) as {
            name?: string;
            data?: { opponent?: string; newlyInstalled?: [string, number][] };
          };
          if (record.name === "go.game" && record.data?.opponent) opponents.add(record.data.opponent);
          if (
            record.name === "sim.prestige"
            && record.data?.newlyInstalled?.some(([name]) => name === "The Red Pill")
          ) installedRedPill = true;
        },
      });
      return { result, installedRedPill, opponents };
    };

    const enabled = await run(true);
    expect(enabled.result.reached).toBe(true);
    expect(enabled.result.validity).toBe("valid");
    expect(enabled.result.unmodeled).toEqual({});
    expect(enabled.result.crashes).toEqual([]);
    expect(enabled.installedRedPill).toBe(true);

    // This is a censored A/B: once the control has run long enough that even
    // reaching immediately would be >21% slower, more virtual time cannot
    // strengthen the conclusion. It also avoids making the test execute the
    // control's entire two-hour horizon before starting the treatment.
    const materialControlHorizon = Math.ceil(enabled.result.timeToGoalMs / 0.79);
    const baseline = await run(false, materialControlHorizon);
    for (const run of [baseline]) {
      expect(run.result.validity).toBe("valid");
      expect(run.result.unmodeled).toEqual({});
      expect(run.result.crashes).toEqual([]);
    }
    const knownOpponents = new Set(["Netburners", "Slum Snakes", "The Black Hand", "Tetrads", "Daedalus", "Illuminati"]);
    expect([...enabled.opponents].every((opponent) => knownOpponents.has(opponent))).toBe(true);
    expect(enabled.opponents.has("Daedalus")).toBe(true);
    expect(enabled.opponents.has("Illuminati")).toBe(true);
    expect(enabled.opponents.size).toBeGreaterThan(1);
    const controlLowerBound = baseline.result.reached
      ? baseline.result.timeToGoalMs
      : materialControlHorizon;
    expect(enabled.result.timeToGoalMs).toBeLessThan(controlLowerBound * 0.8);
  }, 300_000);
});
