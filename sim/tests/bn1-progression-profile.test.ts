import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { setGoNeuralRuntimeForTest } from "../../game/lib/features/remaining.ts";
import { parseGoals } from "../../shared/goals/presets.ts";
import { StubGoValueBackend } from "../../tests/support/go-value-backend.ts";
import { TestGoNeuralRuntime } from "../../tests/support/go-neural-runtime.ts";
import { runGame } from "../game-run.ts";
import { findProfile } from "../profiles.ts";
import { lane } from "../../tests/support/lanes.ts";

/** A full BN1 run across installs: what the augmentation cadence and the Red
 * Pill regrowth actually look like end to end. `bun run long bn1`. */
lane({ feature: "progression", bn: 1 }).describe("BN1 multi-install progression profile", () => {
  beforeAll(() => {
    setGoNeuralRuntimeForTest(new TestGoNeuralRuntime((weights) => new StubGoValueBackend(weights)));
  });

  afterAll(() => {
    setGoNeuralRuntimeForTest();
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

});
