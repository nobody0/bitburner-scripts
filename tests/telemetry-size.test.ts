import { describe, expect, test } from "bun:test";
import type { NS, Server } from "@ns";
import { DODGED_PROBES, isStepped, type SingleStepProbe } from "../game/lib/probes/index.ts";
import type { GameState } from "../game/lib/state.ts";
import {
  CONTRACT_QUEUE_LIMIT,
  CONTRACT_REPORT_LIMIT,
  SOLVERS,
} from "../shared/strategy/side/contracts.ts";
import type { SideState } from "../shared/telemetry/topics/side.ts";
import type { GoGameCandidateDigest, GoState } from "../shared/telemetry/topics/go.ts";

/** State records are last-write-wins and rare, which makes it tempting to put
 * a whole subsystem in one. That is exactly what went wrong: the `side` topic
 * dumped every .cct on the network, so a long-lived save produced a 1.66 MB
 * record, 88 MB across a single run, and a viewer snapshot large enough to
 * stall the browser before its first paint.
 *
 * "DIGESTS, NOT DUMPS" (shared/telemetry/state-map.ts) is the rule; this file
 * is what makes it fail loudly instead of rotting. A topic that outgrows the
 * budget should be given a cap and a total, not a bigger budget. */

/** Per-record ceiling. Generous — the largest healthy topic is well under it —
 * but three orders of magnitude below what an unbounded dump reaches. */
const MAX_RECORD_BYTES = 64_000;
const MAX_SIDE_RECORD_BYTES = 16_000;

function singleStep(id: string): SingleStepProbe {
  const probe = DODGED_PROBES.find((p) => p.id === id);
  if (!probe || isStepped(probe)) throw new Error(`no single-step probe ${id}`);
  return probe;
}

/** Enough of an ns for ls-only contract discovery. */
function contractNs(perHost: number): NS {
  return {
    ls: (host: string, ext: string) =>
      ext === ".cct" ? Array.from({ length: perHost }, (_, i) => `contract-${host}-${i}.cct`) : [],
    codingcontract: {
      getContractTypes: () => Object.keys(SOLVERS),
    },
  } as unknown as NS;
}

describe("telemetry record size", () => {
  test("Go retains a reproducible decision snapshot without becoming a board-history dump", () => {
    const empty = [".....", ".....", ".....", ".....", "....."];
    const history = Array.from({ length: 100 }, (_, turn) => {
      const board = [...empty];
      const x = turn % 5;
      const y = Math.floor(turn / 5) % 5;
      board[x] = board[x]!.slice(0, y) + (turn % 2 ? "O" : "X") + board[x]!.slice(y + 1);
      return board;
    });
    const ranked = Array.from({ length: 8 }, (_, i) => ({
      x: i % 5,
      y: Math.floor(i / 5),
      score: (10 - i) / 10,
      powerPerRound: 11 - i,
      captures: i,
      predictedReplies: Array.from({ length: 6 }, (_, seed) => ({ x: seed % 5, y: i % 5, count: 1 })),
    }));
    const opponents = ["Netburners", "Slum Snakes", "The Black Hand", "Tetrads", "Daedalus", "Illuminati"] as const;
    const sizes = [5, 7, 9, 13] as const;
    const candidates: GoGameCandidateDigest[] = opponents.flatMap((opponent) => sizes.map((boardSize, index) => ({
      opponent,
      boardSize,
      observedBoardSize: boardSize,
      aligned: false,
      waitSec: 0,
      winProbability: 0.8 - index * 0.05,
      expectedBlackScore: 15 + index,
      expectedGameSec: 70 + index * 20,
      difficultyMultiplier: 0.5,
      currentWinStreak: 0,
      powerIfWin: 15,
      powerIfLoss: 5,
      expectedNodePower: 12 + index,
      multiplierBefore: 1,
      multiplierAfter: 1.01,
      transientSecSaved: 20,
      favorEventProbability: 0,
      favorBefore: 0,
      favorAfter: 0,
      favorRemainingWorkSec: 0,
      expectedFavorGain: opponent === "Daedalus" ? 0.5 : 0,
      favorSecSaved: opponent === "Daedalus" ? 5 : 0,
      totalSecSaved: opponent === "Daedalus" ? 25 : 20,
      utilityPerSec: 20 / 70,
      planningGames: 8,
      horizonNodePower: 80,
      horizonTransientSecSaved: 60,
      horizonFavorSecSaved: opponent === "Daedalus" ? 10 : 0,
    })));
    candidates.push({
      ...candidates[0]!, opponent: "????????????", boardSize: 5, observedBoardSize: 19,
    });
    const data: GoState = {
      status: "inProgress",
      currentPlayer: "Black",
      opponent: "Netburners",
      boardSize: 5,
      board: empty,
      previousBoards: history,
      stats: [],
      plan: {
        action: { type: "move", x: 0, y: 0 },
        ranked,
        input: { at: 1, board: empty, previousBoards: history, status: "inProgress", currentPlayer: "Black", opponent: "Netburners" },
        planning: { finalistCount: 4, positionValue: 1 },
        prediction: {
          model: "clean-room-v3.0.1",
          sampledTotalPlaytime: 1_000,
          sampledAt: 1,
          decisionAt: 2,
          preparationMs: 1,
          finalizationMs: 1,
          totalPlanningMs: 2,
          readyToDispatchMs: 1,
          engineCycleMs: 200,
          aiWaitMs: 200,
          seedCandidates: [1_200],
          dispatchPlaytime: 1_000,
          boundaryRetries: 0,
        },
        selection: {
          preferred: candidates[0]!,
          candidates,
          context: {
            goPower: 1, hasSourceFile14: false, favorRepCap: 100_000, installRemainingSec: 3_600,
            joinedFactions: [], demands: {}, factionFavor: {},
          },
        },
      },
      lastTurn: { at: 2, durationMs: 200, action: { type: "move", x: 0, y: 0 }, opponentResponse: { type: "move", x: 1, y: 1 }, predictionSupport: { matching: 4, total: 6 }, ok: true, detail: "move; opponent move" },
    };
    const encoded = JSON.stringify(data);
    expect(JSON.parse(encoded).plan.input.previousBoards).toHaveLength(100);
    expect(data.plan?.selection.candidates).toHaveLength(25);
    expect(encoded.length).toBeLessThan(MAX_RECORD_BYTES);
  });

  test("the contract probe discovers with ls only and never dumps the network", () => {
    const hosts = Array.from({ length: 60 }, (_, i) => `host-${i}`);
    const servers = Object.fromEntries(hosts.map((h) => [h, { hostname: h } as Server]));
    const state = {} as GameState;
    const emissions = singleStep("side.contracts").run(contractNs(200), {
      servers,
      player: {} as never,
      caps: {} as never,
      state,
    });
    expect(emissions).toBeInstanceOf(Array);
    const data = (emissions as { key: string; data: SideState }[])[0]!.data;

    // 12,000 contracts on the network, all covered by the exact v3 registry.
    expect(data.contractTotal).toBe(12_000);
    expect(data.solvableTotal).toBe(12_000);
    expect(data.unsolvableTotal).toBe(0);
    expect(data.registryComplete).toBe(true);
    // ...and the record carries a bounded window plus counts, not the list.
    expect(data.contracts).toHaveLength(CONTRACT_REPORT_LIMIT);
    expect(state.contractQueue).toHaveLength(CONTRACT_QUEUE_LIMIT);
    expect(singleStep("side.contracts").methods).toEqual(["ls", "codingcontract.getContractTypes"]);
    expect(JSON.stringify(data).length).toBeLessThan(MAX_SIDE_RECORD_BYTES);
  });

  test("the capped window is stable and excludes quarantined contracts", () => {
    const hosts = ["a", "b"];
    const servers = Object.fromEntries(hosts.map((h) => [h, { hostname: h } as Server]));
    const state = {
      contractQuarantine: {
        ["a\0contract-a-0.cct"]: {
          host: "a", file: "contract-a-0.cct", type: "Array Jumping Game", data: "[]", answer: "0",
          reason: "answer rejected", at: 1,
        },
        ["gone\0stale.cct"]: {
          host: "gone", file: "stale.cct", type: "Array Jumping Game", data: "[]", answer: "0",
          reason: "answer rejected", at: 0,
        },
      },
    } as unknown as GameState;
    const emissions = singleStep("side.contracts").run(contractNs(40), {
      servers,
      player: {} as never,
      caps: {} as never,
      state,
    });
    const data = (emissions as { key: string; data: SideState }[])[0]!.data;
    expect(data.contracts[0]).toEqual({ host: "a", file: "contract-a-1.cct" });
    expect(data.contracts.some((contract) => contract.file === "contract-a-0.cct")).toBe(false);
    expect(data.quarantinedTotal).toBe(1);
    expect(data.solvableTotal).toBe(79);
    expect(state.contractQueue).toHaveLength(79);
    expect(data.failures?.[0]).not.toHaveProperty("data");
    expect(data.failures?.[0]).not.toHaveProperty("answer");
    expect(state.contractQuarantine?.["gone\0stale.cct"]).toBeUndefined();
  });

  test("augmentation offers carry no per-augmentation duplication", () => {
    const probe = DODGED_PROBES.find((p) => p.id === "factions.augs");
    if (!probe || !isStepped(probe)) throw new Error("factions.augs is not a stepped probe");

    // One augmentation offered by four factions — the shape that used to
    // duplicate a multiplier table four times.
    const mults = Object.fromEntries(
      Array.from({ length: 12 }, (_, i) => [`some_long_multiplier_name_${i}`, 1.5]),
    );
    const emissions = probe.finish({
      byFaction: {
        Daedalus: ["The Red Pill", "Shared Aug"],
        Illuminati: ["Shared Aug"],
        NWO: ["Shared Aug"],
        BitRunners: ["Shared Aug"],
      },
      prices: { "The Red Pill": 1e12, "Shared Aug": 5e9 },
      repReq: { "The Red Pill": 2.5e6, "Shared Aug": 1e5 },
      factionRep: { Daedalus: 3e6 },
      prereqs: { "Shared Aug": ["Some Prereq"] },
      mults: { "Shared Aug": mults, "The Red Pill": mults },
    });
    const data = (emissions as { key: string; data: { offers?: unknown[]; augMeta?: Record<string, unknown> } }[])[0]!
      .data;

    expect(data.offers).toHaveLength(5);
    // Five offers, two augmentations: the heavy fields are stored per
    // augmentation, so the pair count no longer multiplies them.
    expect(Object.keys(data.augMeta ?? {}).sort()).toEqual(["Shared Aug", "The Red Pill"]);
    for (const offer of data.offers as Record<string, unknown>[]) {
      expect(offer["mults"]).toBeUndefined();
      expect(offer["prereqs"]).toBeUndefined();
    }
    expect(JSON.stringify(data).length).toBeLessThan(MAX_RECORD_BYTES);
  });
});
