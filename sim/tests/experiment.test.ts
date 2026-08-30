import { describe, expect, test } from "bun:test";
import { assertValidExperiment, type ExperimentIdentity } from "../../shared/experiment.ts";

describe("simulation experiment identity", () => {
  test("accepts the canonical fresh BN4 route entrance", () => {
    const identity: ExperimentIdentity = {
      class: "bitnode-route",
      entrance: { kind: "fresh", bitNode: 4 },
      route: { route: "all-sf3-bn4-first", leg: "bn4.1", index: 0, bitNode: 4 },
    };
    expect(() => assertValidExperiment(identity)).not.toThrow();
  });

  test("accepts a fresh entrance of the leg's own BitNode — a market-first BN8 route needs no checkpoint", () => {
    const identity: ExperimentIdentity = {
      class: "bitnode-route",
      entrance: { kind: "fresh", bitNode: 8 },
      route: { route: "bn8-first", leg: "bn8-fresh", index: 0, bitNode: 8 },
    };
    expect(() => assertValidExperiment(identity)).not.toThrow();
  });

  test("a fresh entrance must still enter the leg's declared BitNode", () => {
    expect(() => assertValidExperiment({
      class: "bitnode-route",
      entrance: { kind: "fresh", bitNode: 1 },
      route: { route: "bn8-first", leg: "bn8-fresh", index: 0, bitNode: 8 },
    })).toThrow("expects BN8, but its entrance is BN1");
  });

  test("route evidence cannot originate from a synthetic fixture", () => {
    expect(() => assertValidExperiment({
      class: "bitnode-route",
      entrance: { kind: "synthetic", bitNode: 4, profile: "late-game-lab" },
      route: { route: "all-sf3-bn4-first", leg: "bn4.1", index: 0, bitNode: 4 },
    })).toThrow("cannot use synthetic entrance state");
  });

  test("a switchable checkpoint must still enter the leg's declared BitNode", () => {
    expect(() => assertValidExperiment({
      class: "bitnode-route",
      entrance: { kind: "save", saveId: "later-route", bitNode: 5, sha256: "ab".repeat(32) },
      route: { route: "all-sf3-bn4-first", leg: "bn4.1", index: 0, bitNode: 4 },
    })).toThrow("expects BN4, but its entrance is BN5");
  });

  test("feature pressure scenarios cannot claim route lineage", () => {
    expect(() => assertValidExperiment({
      class: "feature-scenario",
      entrance: { kind: "synthetic", bitNode: 8 },
      route: { route: "all-sf3-bn4-first", leg: "bn8.1", index: 21, bitNode: 8 },
    })).toThrow("cannot claim a speedrun route leg");
  });
});
