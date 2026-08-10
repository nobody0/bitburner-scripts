import { describe, expect, test } from "bun:test";
import { makeSink } from "../game/lib/telemetry-sink.ts";
import type { GameState } from "../game/lib/state.ts";
import type { Telemetry } from "../game/lib/telemetry.ts";
import { factsOnly } from "../shared/telemetry/schema.ts";
import type { ContractFailure } from "../shared/telemetry/topics/side.ts";

function failure(at: number): ContractFailure {
  return {
    host: "n00dles",
    file: "bad.cct",
    type: "Array Jumping Game",
    data: "[0]",
    answer: "1",
    triesBefore: 1,
    reason: "answer rejected",
    at,
  };
}

test("wire payloads recursively omit planner narration and keep outcome codes", () => {
  expect(factsOnly({
    why: "authored",
    modeWhy: "authored",
    hold: "authored",
    warning: "authored",
    reason: "outbid",
    nested: [{ score: 7, why: "authored" }],
  })).toEqual({ reason: "outbid", nested: [{ score: 7 }] });
});

describe("contract failure telemetry", () => {
  test("full replay is emitted once while repeated Side state stays compact", () => {
    const events: { name: string; data: unknown }[] = [];
    const states: { key: string; data: unknown }[] = [];
    const tel = {
      state: (key: string, data: unknown) => states.push({ key, data }),
      mirror: () => {},
      event: (name: string, data?: unknown) => events.push({ name, data }),
      debug: () => {},
      flush: () => {},
      dispose: () => {},
    } as Telemetry;
    const first = failure(1);
    const state = {
      topics: {
        side: {
          contracts: [],
          failures: [{
            host: first.host,
            file: first.file,
            type: first.type,
            triesBefore: first.triesBefore,
            reason: first.reason,
            at: first.at,
          }],
        },
      },
      dirty: new Set(["side"]),
      mirrors: {},
      mirrorDirty: new Set(),
      probeFailures: {},
      probeSkips: {},
      featureLastRun: {},
      contractQuarantine: { ["n00dles\0bad.cct"]: first },
    } as unknown as GameState;
    const sink = makeSink(tel);

    sink.flush(state);
    state.dirty.add("side");
    sink.flush(state);

    expect(states).toHaveLength(2);
    expect(JSON.stringify(states[0])).not.toContain('"data":"[0]"');
    expect(events).toEqual([{ name: "contract.quarantined", data: first }]);

    // Reaping releases the report-once key, so a future contract at the same
    // host/file can report its own first failure.
    delete state.contractQuarantine!["n00dles\0bad.cct"];
    sink.flush(state);
    const second = failure(2);
    state.contractQuarantine!["n00dles\0bad.cct"] = second;
    sink.flush(state);
    expect(events).toHaveLength(2);
    expect(events[1]).toEqual({ name: "contract.quarantined", data: second });
  });
});

describe("faction decision telemetry", () => {
  test("indexes decision transitions without repeating an unchanged plan", () => {
    const events: { name: string; data: unknown }[] = [];
    const tel = {
      state: () => {},
      mirror: () => {},
      event: (name: string, data?: unknown) => events.push({ name, data }),
      debug: () => {},
      flush: () => {},
      dispose: () => {},
    } as Telemetry;
    const state = {
      topics: {
        factions: {
          joined: ["CyberSec"],
          plan: {
            context: {
              evaluatedAt: 0,
              horizonSec: 0,
              ownedAugCount: 0,
              queuedAugCount: 0,
              incomePerSec: 0,
              moneyAvailable: 0,
              moneyGranted: 0,
              holdsWorkSlot: false,
              favorToDonate: 150,
              priceQueue: { nonSoA: 0, ownedSoA: 0, neurofluxLevel: 0 },
            },
            action: { type: "workForFaction", faction: "CyberSec", why: "earning reputation" },
            alternatives: [],
            blockers: [],
          },
        },
      },
      dirty: new Set(["factions"]),
      mirrors: {},
      mirrorDirty: new Set(),
      probeFailures: {},
      probeSkips: {},
      featureLastRun: {},
    } as unknown as GameState;
    const sink = makeSink(tel);

    sink.flush(state);
    state.dirty.add("factions");
    sink.flush(state);
    expect(events.map((event) => event.name)).toEqual(["faction.decision"]);

    state.topics.factions!.plan!.action = {
      type: "purchaseAugmentation",
      faction: "CyberSec",
      augmentation: "BitWire",
    };
    state.dirty.add("factions");
    sink.flush(state);
    expect(events.map((event) => event.name)).toEqual(["faction.decision", "faction.decision"]);

    state.topics.factions!.plan!.lastResult = {
      action: "purchaseAugmentation",
      ok: true,
      detail: "purchased BitWire",
      at: 3,
    };
    state.dirty.add("factions");
    sink.flush(state);
    expect(events.map((event) => event.name)).toEqual([
      "faction.decision",
      "faction.decision",
      "faction.result",
    ]);

    state.dirty.add("factions");
    sink.flush(state);
    expect(events).toHaveLength(3);
  });
});

describe("decision telemetry", () => {
  test("indexes transitions and results without emitting one event per state sample", () => {
    const events: { name: string; data: unknown }[] = [];
    const tel = {
      state: () => {},
      mirror: () => {},
      event: (name: string, data?: unknown) => events.push({ name, data }),
      debug: () => {},
      flush: () => {},
      dispose: () => {},
    } as Telemetry;
    const state = {
      topics: {
        hacknet: {
          servers: true,
          numNodes: 1,
          maxNumNodes: 20,
          purchaseNodeCost: 1_000,
          totalProduction: 0,
          productionPerSec: 1,
          nodes: [],
          plan: {
            evaluatedAt: 1,
            horizonSec: 3_600,
            moneyAvailable: 5_000,
            moneyGranted: 0,
            hashDollarValue: 250_000,
            fleetUtilization: 0.9,
            fleetDemanded: true,
            candidate: { kind: "level", node: 0, cost: 1_000 },
            why: "waiting for funds",
            hold: "level costs $1,000, granted $0",
            rankedTotal: 0,
            ranked: [],
            hashes: {
              current: 10,
              capacity: 64,
              productionPerSec: 1,
              sellForMoneyCost: 4,
              why: "accumulating hashes",
              rankedTotal: 0,
              ranked: [],
            },
          },
        },
      },
      dirty: new Set(["hacknet"]),
      mirrors: {},
      mirrorDirty: new Set(),
      probeFailures: {},
      probeSkips: {},
      featureLastRun: {},
    } as unknown as GameState;
    const sink = makeSink(tel);

    sink.flush(state);
    expect(events.map((event) => event.name)).toEqual(["investment.decision", "hash.decision"]);

    // Continuously changing observations remain in topic state but do not
    // spam the transition index when the decision itself is unchanged.
    state.topics.hacknet!.plan!.evaluatedAt = 2;
    state.topics.hacknet!.plan!.moneyAvailable = 6_000;
    state.dirty.add("hacknet");
    sink.flush(state);
    expect(events).toHaveLength(2);

    state.topics.hacknet!.plan = {
      ...state.topics.hacknet!.plan!,
      moneyGranted: 1_000,
      buy: { kind: "level", node: 0, cost: 1_000 },
      lastResult: { action: "level", ok: true, detail: "bought level", at: 3 },
    };
    state.dirty.add("hacknet");
    sink.flush(state);
    expect(events.slice(2).map((event) => event.name)).toEqual(["investment.decision", "investment.result"]);

    state.dirty.add("hacknet");
    sink.flush(state);
    expect(events).toHaveLength(4);
  });
});
