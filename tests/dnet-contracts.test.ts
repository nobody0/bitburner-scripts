import { describe, expect, test } from "bun:test";
import {
  contractKey,
  darknetContractIsActionable,
  darknetContractsFromListings,
  mergeContractQueue,
  pendingDarknetContracts,
  type ContractQueueEntry,
} from "../game/lib/contracts.ts";
import { syncDarknetContracts } from "../game/lib/features/dnet.ts";
import type { GameState } from "../game/lib/state.ts";
import { emptyKnowledge, foldKnowledgeReports } from "../shared/strategy/dnet/host.ts";

const observed: ContractQueueEntry = {
  host: "dn-1",
  file: "alpha.cct",
  dnet: { identity: "10.0.0.1", observedAt: 1_000 },
};

describe("darknet contract queue", () => {
  test("requires the current stamped listing, identity, and validity window", () => {
    const listing = {
      "dn-1": {
        identity: "10.0.0.1",
        observedAt: 1_000,
        validUntil: 2_000,
        files: ["alpha.cct"],
      },
    };
    expect(darknetContractIsActionable(observed, listing, 1_999)).toBe(true);
    expect(darknetContractIsActionable(observed, listing, 2_001)).toBe(false);
    expect(darknetContractIsActionable(observed, {
      "dn-1": { ...listing["dn-1"], identity: "10.0.0.2" },
    }, 1_500)).toBe(false);
    expect(darknetContractIsActionable(observed, {
      "dn-1": { ...listing["dn-1"], observedAt: 1_001 },
    }, 1_500)).toBe(false);
  });

  test("prioritizes darknet work and deduplicates ordinary discovery", () => {
    const merged = mergeContractQueue(
      [observed],
      [{ host: "dn-1", file: "alpha.cct" }, { host: "home", file: "beta.cct" }],
      10,
    );
    expect(merged.map(contractKey)).toEqual(["dn-1\0alpha.cct", "home\0beta.cct"]);
    expect(merged[0]?.dnet).toBeDefined();
  });

  test("materializes every fresh listing independently of the bounded queue", () => {
    const contracts = darknetContractsFromListings({
      "dn-2": { identity: "10.0.0.2", observedAt: 900, validUntil: 2_000, files: ["b.cct"] },
      "dn-1": { identity: "10.0.0.1", observedAt: 1_000, validUntil: 2_000, files: ["a.cct", "c.cct"] },
      stale: { identity: "10.0.0.3", observedAt: 500, validUntil: 999, files: ["old.cct"] },
    }, 1_000);
    expect(contracts.map(contractKey)).toEqual(["dn-1\0a.cct", "dn-1\0c.cct", "dn-2\0b.cct"]);
  });

  test("rejects identity-less listings and terminal observations", () => {
    const listings = {
      invalid: { identity: undefined, observedAt: 1_000, validUntil: 2_000, files: ["old.cct"] },
      "dn-1": { identity: "10.0.0.1", observedAt: 1_000, validUntil: 2_000, files: ["a.cct", "b.cct"] },
    } as unknown as Record<string, { identity: string; observedAt: number; validUntil: number; files: string[] }>;
    expect(darknetContractsFromListings(listings, 1_500).map(contractKey))
      .toEqual(["dn-1\0a.cct", "dn-1\0b.cct"]);
    expect(pendingDarknetContracts(
      darknetContractsFromListings(listings, 1_500),
      { ["dn-1\0a.cct"]: 1_000 },
      { ["dn-1\0b.cct"]: {} },
    )).toEqual([]);
  });

  test("queues a fresh folded fact once and permits a newer observation", () => {
    const state = {
      topics: {}, dirty: new Set(), mirrors: {}, mirrorDirty: new Set(),
      probeFailures: {}, featureLastRun: {},
    } as GameState;
    let knowledge = foldKnowledgeReports(emptyKnowledge("run"), [{
      hostname: "dn-1",
      identity: "10.0.0.1",
      at: 1_000,
      present: true,
      contracts: ["alpha.cct"],
    }], 1_000, { bitNode: 15, netDepth: 5 }).knowledge;
    syncDarknetContracts(state, knowledge, 1_000, { bitNode: 15, netDepth: 5 });
    expect(state.contractQueue?.map(contractKey)).toEqual(["dn-1\0alpha.cct"]);

    state.darknetContractHandledAt = { ["dn-1\0alpha.cct"]: 1_000 };
    syncDarknetContracts(state, knowledge, 1_001, { bitNode: 15, netDepth: 5 });
    expect(state.contractQueue).toEqual([]);

    knowledge = foldKnowledgeReports(knowledge, [{
      hostname: "dn-1",
      identity: "10.0.0.1",
      at: 1_100,
      present: true,
      contracts: ["alpha.cct"],
    }], 1_100, { bitNode: 15, netDepth: 5 }).knowledge;
    syncDarknetContracts(state, knowledge, 1_100, { bitNode: 15, netDepth: 5 });
    expect(state.contractQueue?.map(contractKey)).toEqual(["dn-1\0alpha.cct"]);
  });

  test("a dirty listing preserves attribution until fresh absence, while retirement clears it", () => {
    const state = {
      topics: {}, dirty: new Set(), mirrors: {}, mirrorDirty: new Set(),
      probeFailures: {}, featureLastRun: {},
    } as GameState;
    let knowledge = foldKnowledgeReports(emptyKnowledge("run"), [{
      hostname: "dn-1", identity: "10.0.0.1", at: 1_000, present: true,
      contracts: ["alpha.cct"],
    }], 1_000, { bitNode: 15, netDepth: 5 }).knowledge;
    syncDarknetContracts(state, knowledge, 1_000, { bitNode: 15, netDepth: 5 });
    state.darknetContractHandledAt = { ["dn-1\0alpha.cct"]: 1_000 };
    state.contractQuarantine = { ["dn-1\0bad.cct"]: {
      host: "dn-1", file: "bad.cct", origin: "darknet", type: "test",
      data: "[]", answer: "[]", reason: "bad answer", at: 1_000,
    } };

    knowledge = foldKnowledgeReports(knowledge, [{
      hostname: "dn-1", at: 1_100, present: true, invalidates: ["files"],
    }], 1_100, { bitNode: 15, netDepth: 5 }).knowledge;
    syncDarknetContracts(state, knowledge, 1_100, { bitNode: 15, netDepth: 5 });
    expect(state.darknetContractListings).toEqual({});
    expect(state.darknetContractHandledAt?.["dn-1\0alpha.cct"]).toBe(1_000);
    expect(state.contractQuarantine?.["dn-1\0bad.cct"]).toBeDefined();

    knowledge = foldKnowledgeReports(knowledge, [{
      hostname: "dn-1", identity: "10.0.0.1", at: 1_200, present: true, contracts: [],
    }], 1_200, { bitNode: 15, netDepth: 5 }).knowledge;
    syncDarknetContracts(state, knowledge, 1_200, { bitNode: 15, netDepth: 5 });
    expect(state.darknetContractHandledAt).toEqual({});
    expect(state.contractQuarantine).toEqual({});

    state.darknetContractHandledAt = { ["dn-1\0alpha.cct"]: 1_200 };
    state.contractQuarantine = { ["dn-1\0bad.cct"]: {
      host: "dn-1", file: "bad.cct", origin: "darknet", type: "test",
      data: "[]", answer: "[]", reason: "bad answer", at: 1_200,
    } };
    syncDarknetContracts(state, knowledge, 1_201, { bitNode: 15, netDepth: 5 }, ["dn-1"]);
    expect(state.darknetContractHandledAt).toEqual({});
    expect(state.contractQuarantine).toEqual({});
  });
});
