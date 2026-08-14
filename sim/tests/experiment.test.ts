import { describe, expect, test } from "bun:test";
import { assertValidExperiment, type ExperimentIdentity } from "../../shared/experiment.ts";

describe("simulation experiment identity", () => {
  test("accepts the canonical fresh BN1 route entrance", () => {
    const identity: ExperimentIdentity = {
      class: "bitnode-route",
      entrance: { kind: "fresh", bitNode: 1 },
      route: { route: "all-source-files-3", leg: "bn1-first", index: 0, bitNode: 1 },
    };
    expect(() => assertValidExperiment(identity)).not.toThrow();
  });

  test("route evidence cannot originate from a synthetic fixture", () => {
    expect(() => assertValidExperiment({
      class: "bitnode-route",
      entrance: { kind: "synthetic", bitNode: 1, profile: "late-game-lab" },
      route: { route: "all-source-files-3", leg: "bn1-first", index: 0, bitNode: 1 },
    })).toThrow("cannot use synthetic entrance state");
  });

  test("a switchable checkpoint must still enter the leg's declared BitNode", () => {
    expect(() => assertValidExperiment({
      class: "bitnode-route",
      entrance: { kind: "save", saveId: "later-route", bitNode: 5, sha256: "ab".repeat(32) },
      route: { route: "all-source-files-3", leg: "bn1-first", index: 0, bitNode: 1 },
    })).toThrow("expects BN1, but its entrance is BN5");
  });

  test("feature pressure scenarios cannot claim route lineage", () => {
    expect(() => assertValidExperiment({
      class: "feature-scenario",
      entrance: { kind: "synthetic", bitNode: 8 },
      route: { route: "all-source-files-3", leg: "bn8", index: 4, bitNode: 8 },
    })).toThrow("cannot claim a speedrun route leg");
  });
});
