import { describe, expect, test } from "bun:test";
import type { NS } from "@ns";
import { sideModule } from "../game/lib/features/side.ts";
import type { DriverContext } from "../game/lib/features/index.ts";
import type { NsProxy } from "../game/lib/ns-proxy.ts";
import type { GameState } from "../game/lib/state.ts";
import { emptyArbitration } from "../shared/strategy/arbiter.ts";

/** A stand-in for the ns proxy: the driver's only route to the game is a dotted
 * path, so a fake is a table of paths. `killOnce` makes one path throw a
 * ScriptDeath, which is how a killed resident reaches a driver mid-pipeline. */
function harness(attempt: (answer: unknown) => string) {
  const calls: string[] = [];
  const killOnce = new Set<string>();
  const table: Record<string, (...args: never[]) => unknown> = {
    "codingcontract.getContractType": () => "Array Jumping Game",
    "codingcontract.getNumTriesRemaining": () => 1,
    "codingcontract.getData": () => [2, 3, 1, 1, 4],
    "codingcontract.attempt": ((answer: unknown) => attempt(answer)) as never,
  };
  const nsp = ((path: string, ...args: unknown[]) => {
    calls.push(path);
    if (killOnce.has(path)) {
      killOnce.delete(path);
      const death = new Error("script killed");
      death.name = "ScriptDeath";
      throw death;
    }
    const fn = table[path];
    if (!fn) throw new Error(`unexpected proxy call ns.${path}`);
    return Promise.resolve((fn as (...a: unknown[]) => unknown)(...args));
  }) as unknown as NsProxy;
  const ns = { getFunctionRamCost: () => 1, sleep: async () => {} } as unknown as NS;
  const state = {
    topics: {
      side: {
        contracts: [{ host: "n00dles", file: "jump.cct" }],
        contractTotal: 1,
        solvableTotal: 1,
        contractsByOrigin: {
          network: { observed: 1, solvable: 1 },
          darknet: { observed: 0, solvable: 0 },
        },
        unsolvableByType: {},
        unsolvableTotal: 0,
      },
    },
    dirty: new Set(), mirrors: {}, mirrorDirty: new Set(), probeFailures: {}, featureLastRun: {},
  } as GameState;
  const result = emptyArbitration();
  const ctx = {
    ns,
    nsp,
    nspLong: nsp,
    state,
    caps: { unlocked: {} },
    grants: {
      money: 0,
      slot: false,
      result,
    },
  } as unknown as DriverContext;
  return { ctx, state, calls, killOnce };
}

function callsTo(calls: readonly string[], path: string): number {
  return calls.filter((seen) => seen === path).length;
}

describe("Side contract execution", () => {
  test("a contract is inspected, read, and attempted exactly once", async () => {
    const submitted: unknown[] = [];
    // A real reward string. The game always prefixes "Gained "; a bare "$1m" is
    // a shape it never emits, and the parser rejects it on purpose.
    const h = harness((answer) => { submitted.push(answer); return "Gained $1.000m"; });
    await sideModule.driver.tick(h.ctx);

    expect(submitted).toEqual([1]);
    expect(callsTo(h.calls, "codingcontract.getData")).toBe(1);
    expect(callsTo(h.calls, "codingcontract.attempt")).toBe(1);
    expect(h.state.topics.side?.contracts).toEqual([]);
    expect(h.state.topics.side?.contractTotal).toBe(0);
    expect(h.state.topics.side?.contractsByOrigin.network).toEqual({ observed: 0, solvable: 0 });
    expect(h.state.contractQuarantine).toEqual({});
    expect(h.state.topics.side?.lastResult?.detail).toContain("1 solved");
    expect(h.state.topics.side?.rewards?.network).toMatchObject({
      attempted: 1, solved: 1, moneySolves: 1, moneyApprox: 1e6, unparsed: 0,
    });
  });

  test("the first rejected answer is replayable and never retried", async () => {
    let attempts = 0;
    const h = harness(() => { attempts++; return ""; });
    await sideModule.driver.tick(h.ctx);

    const failure = Object.values(h.state.contractQuarantine ?? {})[0]!;
    expect(failure).toMatchObject({
      host: "n00dles",
      file: "jump.cct",
      type: "Array Jumping Game",
      data: "[2,3,1,1,4]",
      answer: "1",
      triesBefore: 1,
      reason: "answer rejected",
    });
    expect(h.state.topics.side?.failures?.[0]).not.toHaveProperty("data");
    expect(h.state.topics.side?.failures?.[0]).not.toHaveProperty("answer");
    expect(attempts).toBe(1);

    // Recreate the stale discovery row: quarantine, not queue ordering, is
    // what prevents a bad solver from burning the contract's final attempt.
    h.state.topics.side!.contracts = [{ host: "n00dles", file: "jump.cct" }];
    await sideModule.driver.tick(h.ctx);
    expect(attempts).toBe(1);
  });

  test("a solved darknet contract retires exactly the observation that was attempted", async () => {
    const h = harness(() => "Gained $1.000m");
    const observedAt = Date.now();
    h.state.contractQueue = [{
      host: "dn-1",
      file: "jump.cct",
      dnet: { identity: "10.0.0.1", observedAt },
    }];
    h.state.darknetContractListings = {
      "dn-1": {
        identity: "10.0.0.1",
        observedAt,
        validUntil: observedAt + 60_000,
        files: ["jump.cct"],
      },
    };
    h.state.topics.side!.contractsByOrigin = {
      network: { observed: 0, solvable: 0 },
      darknet: { observed: 1, solvable: 1 },
    };
    await sideModule.driver.tick(h.ctx);
    expect(h.state.darknetContractHandledAt?.["dn-1\0jump.cct"]).toBe(observedAt);
    expect(h.state.darknetContractRefreshHosts?.["dn-1"]).toBeDefined();
    expect(h.state.contractQueue).toEqual([]);
  });

  test("earnings are attributed to the origin the contract came from", async () => {
    const h = harness(() => "Gained $2.000m");
    const observedAt = Date.now();
    h.state.contractQueue = [{ host: "dn-1", file: "jump.cct", dnet: { identity: "10.0.0.1", observedAt } }];
    h.state.darknetContractListings = {
      "dn-1": { identity: "10.0.0.1", observedAt, validUntil: observedAt + 60_000, files: ["jump.cct"] },
    };
    h.state.topics.side!.contractsByOrigin = {
      network: { observed: 0, solvable: 0 },
      darknet: { observed: 1, solvable: 1 },
    };
    await sideModule.driver.tick(h.ctx);

    expect(h.state.topics.side?.rewards?.darknet).toMatchObject({
      attempted: 1, solved: 1, moneySolves: 1, moneyApprox: 2e6,
    });
    // Absent, NOT a zero row: the network origin has never attempted anything,
    // and reporting it at zero would claim we measured it.
    expect(h.state.topics.side?.rewards?.network).toBeUndefined();
    expect(h.state.topics.side?.recentSolves?.[0]).toMatchObject({
      origin: "darknet", currency: "money", host: "dn-1", file: "jump.cct",
    });
    // The darknet identity never reaches the wire.
    expect(JSON.stringify(h.state.topics.side)).not.toContain("10.0.0.1");
  });

  test("reputation is recorded exactly, and split awards total across factions", async () => {
    const h = harness(() => "Gained 277 reputation for each of the following factions: CyberSec, NiteSec");
    await sideModule.driver.tick(h.ctx);

    expect(h.state.topics.side?.rewards?.network).toMatchObject({
      solved: 1, factionRep: 554, moneyApprox: 0, moneySolves: 0, unparsed: 0,
    });
    expect(h.state.topics.side?.recentSolves?.[0]).toMatchObject({
      currency: "factionRep", rep: 554, to: ["CyberSec", "NiteSec"],
    });
  });

  test("a contract that paid nothing is counted, not treated as unreadable", async () => {
    const h = harness(() => "No reward for this contract");
    await sideModule.driver.tick(h.ctx);

    expect(h.state.topics.side?.rewards?.network).toMatchObject({
      solved: 1, unrewarded: 1, unparsed: 0, moneyApprox: 0, moneySolves: 0,
    });
  });

  test("an unreadable reward is counted loudly and never as a zero", async () => {
    // A locale whose decimal comma collides with a grouping comma.
    const h = harness(() => "Gained $1,235m");
    await sideModule.driver.tick(h.ctx);

    expect(h.state.topics.side?.rewards?.network).toMatchObject({
      solved: 1, unparsed: 1, moneyApprox: 0, moneySolves: 0,
    });
    expect(h.state.topics.side?.lastResult?.detail).toContain("1 reward(s) unreadable");
  });

  test("a rejected answer is attributed to its origin's quarantine count", async () => {
    const h = harness(() => "");
    await sideModule.driver.tick(h.ctx);

    expect(h.state.topics.side?.rewards?.network).toMatchObject({ attempted: 1, solved: 0, quarantined: 1 });
    expect(Object.values(h.state.contractQuarantine ?? {})[0]).toMatchObject({ origin: "network" });
  });

  test("a pipeline aborted before the attempt resumes without double counting", async () => {
    // The regression this guards: the attempt stage has no resume cache, so if
    // the pipeline is not released once the attempts are submitted, the next
    // tick re-runs them and burns a try on a one-try contract. A ScriptDeath on
    // the attempt call is how the run reaches that state — the resident died
    // between reading the contract and answering it.
    let attempts = 0;
    const h = harness(() => { attempts++; return "Gained $1.000m"; });
    h.killOnce.add("codingcontract.attempt");

    await expect(sideModule.driver.tick(h.ctx)).rejects.toThrow("script killed");
    expect(attempts).toBe(0);
    expect(h.state.topics.side?.rewards).toBeUndefined();
    // The two read stages are cached: resuming re-answers, it does not re-read.
    const readsBefore = callsTo(h.calls, "codingcontract.getData");

    await sideModule.driver.tick(h.ctx);
    expect(attempts).toBe(1);
    expect(callsTo(h.calls, "codingcontract.getData")).toBe(readsBefore);
    expect(h.state.topics.side?.rewards?.network).toMatchObject({ attempted: 1, solved: 1, moneyApprox: 1e6 });

    // A third tick must find nothing left to do rather than re-attempt.
    await sideModule.driver.tick(h.ctx);
    expect(attempts).toBe(1);
    expect(h.state.topics.side?.rewards?.network).toMatchObject({ attempted: 1, solved: 1, moneyApprox: 1e6 });
  });

  test("totals accumulate across ticks and the ring stays bounded", async () => {
    const h = harness(() => "Gained $1.000m");
    await sideModule.driver.tick(h.ctx);
    h.state.topics.side!.contracts = [{ host: "n00dles", file: "second.cct" }];
    h.state.contractQueue = [{ host: "n00dles", file: "second.cct" }];
    await sideModule.driver.tick(h.ctx);

    expect(h.state.topics.side?.rewards?.network).toMatchObject({ solved: 2, moneyApprox: 2e6 });
    const recent = h.state.topics.side?.recentSolves ?? [];
    expect(recent.length).toBe(2);
    expect(recent[recent.length - 1]?.file).toBe("second.cct");
  });

  test("prestige clears the ledger with the topic", async () => {
    const h = harness(() => "Gained $1.000m");
    await sideModule.driver.tick(h.ctx);
    expect(h.state.contractLedger).toBeDefined();

    sideModule.reset!(h.state, "augmentation");
    expect(h.state.contractLedger).toBeUndefined();
    expect(h.state.topics.side).toBeUndefined();
  });

});
