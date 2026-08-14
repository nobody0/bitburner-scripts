import { describe, expect, test } from "bun:test";
import { scenarioFingerprint } from "../scenario.ts";
import { SIMULATOR_MODEL_VERSION, SIMULATOR_VENDOR_COMMIT } from "../fidelity.ts";

describe("simulation scenario fingerprints", () => {
  test("ignore object insertion order but retain every experimental input", () => {
    const a = scenarioFingerprint({ seed: 1, world: { money: 1_000, ram: 8 } });
    const reordered = scenarioFingerprint({ world: { ram: 8, money: 1_000 }, seed: 1 });
    expect(reordered).toBe(a);
    expect(scenarioFingerprint({ seed: 2, world: { money: 1_000, ram: 8 } })).not.toBe(a);
    expect(scenarioFingerprint({ seed: 1, world: { money: 2_000, ram: 8 } })).not.toBe(a);
  });

  test("pins handwritten and upstream revisions as experimental identity", async () => {
    const manifest = await Bun.file(new URL("../vendor/manifest.json", import.meta.url)).json() as { commit: string };
    expect(SIMULATOR_MODEL_VERSION).toBeGreaterThan(0);
    expect(SIMULATOR_VENDOR_COMMIT).toBe(manifest.commit);
    expect(scenarioFingerprint({ model: 1, vendor: manifest.commit })).not.toBe(
      scenarioFingerprint({ model: 2, vendor: manifest.commit }),
    );
  });
});
