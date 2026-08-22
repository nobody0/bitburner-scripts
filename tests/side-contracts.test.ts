import { describe, expect, test } from "bun:test";
import type { NS } from "@ns";
import type { DodgeGlobals } from "../game/lib/dodge-shared.ts";
import { sideModule } from "../game/lib/features/side.ts";
import type { DriverContext } from "../game/lib/features/index.ts";
import type { GameState } from "../game/lib/state.ts";
import { emptyArbitration } from "../shared/strategy/arbiter.ts";

function harness(attempt: (answer: unknown) => string) {
  let execs = 0;
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
      const globals = globalThis as typeof globalThis & DodgeGlobals;
      queueMicrotask(async () => {
        try {
          globals.dodge_cb?.(await globals.dodge_func!(stubNs));
        } catch (error) {
          globals.dodge_reject?.(error);
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
    acquireDodge: () => ({ host: "home", release: () => {} }),
  } as unknown as DriverContext;
  return { ctx, state, execs: () => execs };
}

describe("Side contract execution", () => {
  test("inspection, data, and attempt are separate low-RAM batch stages", async () => {
    const submitted: unknown[] = [];
    const h = harness((answer) => { submitted.push(answer); return "$1m"; });
    await sideModule.driver.tick(h.ctx);

    expect(submitted).toEqual([1]);
    expect(h.execs()).toBe(3);
    expect(sideModule).not.toHaveProperty('peakStepGb');
    expect(h.state.topics.side?.contracts).toEqual([]);
    expect(h.state.topics.side?.contractTotal).toBe(0);
    expect(h.state.contractQuarantine).toEqual({});
    expect(h.state.topics.side?.lastResult?.detail).toContain("$1m");
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
    const h = harness(() => "$1m");
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

});
