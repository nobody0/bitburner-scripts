import { describe, expect, test } from "bun:test";
import type { NS } from "@ns";
import type { DodgeLaunch } from "../game/lib/dodge-shared.ts";
import { captureLaunch } from "../game/lib/launch-shared.ts";
import { sideModule } from "../game/lib/features/side.ts";
import type { DriverContext } from "../game/lib/features/index.ts";
import type { GameState } from "../game/lib/state.ts";
import { emptyArbitration } from "../shared/strategy/arbiter.ts";

function harness(attempt: (answer: unknown) => string) {
  let execs = 0;
  const queueOnce = new Set<string>();
  const stubNs = {
    codingcontract: {
      getContractType: () => "Array Jumping Game",
      getNumTriesRemaining: () => 1,
      getData: () => [2, 3, 1, 1, 4],
      attempt,
    },
  } as unknown as NS;
  const ns = {
    getFunctionRamCost: () => 1,
    sleep: async () => {},
    exec: () => {
      execs++;
      queueMicrotask(async () => {
        const launch = captureLaunch<DodgeLaunch>("dodge");
        if (!launch) return;
        try {
          launch.resolve({ result: launch.func(stubNs) });
        } catch (error) {
          launch.reject(error);
        }
      });
      return execs;
    },
  } as unknown as NS;
  const state = {
    topics: {
      side: {
        contracts: [{ host: "n00dles", file: "jump.cct" }],
        contractTotal: 1,
        solvableTotal: 1,
        unsolvableByType: {},
        unsolvableTotal: 0,
      },
    },
    dirty: new Set(), mirrors: {}, mirrorDirty: new Set(), probeFailures: {}, featureLastRun: {},
  } as GameState;
  const result = emptyArbitration();
  const ctx = {
    ns,
    state,
    caps: { unlocked: {} },
    grants: {
      money: 0,
      ramClaims: new Map([["action:contract", {
        by: "side", id: "action:contract", resource: "ram", amount: 10.5, priority: 50,
      }]]),
      slot: false,
      result,
    },
    // `queueOnce` lets a test make ONE stage's lease come back queued, which is
    // how the broker reports "no RAM yet" and the only way to exercise the
    // pipeline resume path.
    acquireDodge: (_gb: number, request: { id: string }) => {
      if (queueOnce.has(request.id)) {
        queueOnce.delete(request.id);
        return { status: "queued" };
      }
      return { host: "home", release: () => {} };
    },
  } as unknown as DriverContext;
  return { ctx, state, execs: () => execs, queueOnce };
}

describe("Side contract execution", () => {
  test("inspection, data, and attempt are separate low-RAM batch stages", async () => {
    const submitted: unknown[] = [];
    // A real reward string. The game always prefixes "Gained "; a bare "$1m" is
    // a shape it never emits, and the parser rejects it on purpose.
    const h = harness((answer) => { submitted.push(answer); return "Gained $1.000m"; });
    await sideModule.driver.tick(h.ctx);

    expect(submitted).toEqual([1]);
    expect(h.execs()).toBe(3);
    expect(sideModule).not.toHaveProperty('peakStepGb');
    expect(h.state.topics.side?.contracts).toEqual([]);
    expect(h.state.topics.side?.contractTotal).toBe(0);
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
    expect(h.execs()).toBe(3);
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
    await sideModule.driver.tick(h.ctx);
    expect(h.state.darknetContractHandledAt?.["dn-1\0jump.cct"]).toBe(observedAt);
    expect(h.state.contractQueue).toEqual([]);
  });

  test("earnings are attributed to the origin the contract came from", async () => {
    const h = harness(() => "Gained $2.000m");
    const observedAt = Date.now();
    h.state.contractQueue = [{ host: "dn-1", file: "jump.cct", dnet: { identity: "10.0.0.1", observedAt } }];
    h.state.darknetContractListings = {
      "dn-1": { identity: "10.0.0.1", observedAt, validUntil: observedAt + 60_000, files: ["jump.cct"] },
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

  test("a queued attempt lease resumes without re-attempting or double counting", async () => {
    // The regression this guards: the attempt stage has no resume cache, so if
    // the pipeline is not released once the attempts are submitted, the next
    // tick re-runs them and burns a try on a one-try contract.
    let attempts = 0;
    const h = harness(() => { attempts++; return "Gained $1.000m"; });
    h.queueOnce.add("action:contract:attempt");

    await sideModule.driver.tick(h.ctx);
    expect(attempts).toBe(0);
    expect(h.state.topics.side?.rewards).toBeUndefined();

    await sideModule.driver.tick(h.ctx);
    expect(attempts).toBe(1);
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
