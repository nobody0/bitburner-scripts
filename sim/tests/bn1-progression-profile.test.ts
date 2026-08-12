import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { setGoBackendFactoryForTest } from "../../game/lib/features/remaining.ts";
import { parseGoals } from "../../shared/goals/presets.ts";
import { StubGoValueBackend } from "../../tests/support/go-value-backend.ts";
import { only } from "../../shared/features/profile.ts";
import { runGame } from "../game-run.ts";
import { findProfile } from "../profiles.ts";

describe("BN1 multi-install progression profile", () => {
  beforeAll(() => {
    setGoBackendFactoryForTest((weights) => new StubGoValueBackend(weights));
  });

  afterAll(() => {
    setGoBackendFactoryForTest();
  });

  test("does not extrapolate a preloaded startup reset as fresh-cycle augmentation speed", async () => {
    const profile = findProfile("bn1-progression");
    let installs = 0;

    // This fixture intentionally starts mid-cycle with a queue and reputation
    // already banked. Its immediate first prestige is useful for lifecycle
    // coverage, but it is censored acquisition evidence: none of that work was
    // observed from a clean reset. Ten virtual minutes are enough to catch the
    // old failure ("20 remaining augmentations in 8 seconds") without forcing
    // a strategically bad second install merely to satisfy a test counter.
    const result = await runGame({
      goal: parseGoals(["installs:2"]),
      seed: 1,
      horizonMs: 10 * 60_000,
      bitnode: profile.bitnode,
      homeRam: profile.homeRam,
      startingMoney: profile.startingMoney,
      features: profile.features,
      ...profile.world,
      telemetry: false,
      recordFilter: (record) => record.kind === "event" && record.name === "sim.prestige",
      onRecord: (line) => {
        const record = JSON.parse(line) as {
          name?: string;
        };
        if (record.name === "sim.prestige") {
          installs++;
        }
      },
    });

    expect(result.reached).toBe(false);
    expect(result.validity).toBe("valid");
    expect(result.unmodeled).toEqual({});
    expect(result.crashes).toEqual([]);
    expect(installs).toBe(1);
    const postInstallPackage = result.strategy.routeParts.find(
      (part) => part.what === "final augmentation package",
    );
    expect(postInstallPackage).toMatchObject({ measured: false });
    expect(postInstallPackage!.sec).toBeGreaterThanOrEqual(30_000);
  }, 150_000);

  // This assertion measures the trained policy's strength, so running it with
  // a Bun-side fake would be dishonest. The production model is exercised by
  // the Chromium/Dawn arena (`bun run go:arena`); Bun retains the independent
  // no-Go progression and lifecycle coverage above.
  test.skip("the late JIT profile installs The Red Pill, regrows, and benefits materially from Go", async () => {
    const profile = findProfile("bn1-jit-stress");
    const run = async (withGo: boolean, horizonMs = 2.5 * 60 * 60_000) => {
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
