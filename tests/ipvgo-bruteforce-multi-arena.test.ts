import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import {
  auditPlaybookRoutes,
  loadPhasePlaybook,
  packPlaybookBoard,
  playbookLookupHashed,
  playbookLookupMove,
  playbookModel,
  type MultiPhasePlaybook,
  type PhasePlaybook,
} from "../ipvgobruteforce/arena/playbook.ts";
import {
  auditPlaybookRuntimeRoots,
  ordinaryTurnTicks,
  playbookInitialBoardAtPlaytime,
  playbookInitialBoardsAtPlaytime,
  playPlaybookArenaGame,
} from "../sim/ipvgobruteforce-arena.ts";
import { auditGeneration } from "../ipvgobruteforce/arena/main.ts";
import { playMove } from "../shared/strategy/go/rules.ts";

const MERGED = join(
  import.meta.dir,
  "../ipvgobruteforce/data/seeded-phases/all-5x5-v1/merged",
);
const PLAYBOOK = join(MERGED, "playbook.phase.js");

function initialBoard(playbook: PhasePlaybook, enemy: string, phase: number) {
  const epoch = playbookModel(playbook, enemy).playtimeEpoch;
  return playbookInitialBoardAtPlaytime(enemy, epoch * 30_000_000 + phase * 200, 1);
}

describe.skipIf(!existsSync(PLAYBOOK))("merged IPvGO brute-force 5x5 playbook", () => {
  test("ordinary wall delay includes every mandatory AI wait cycle", () => {
    expect(ordinaryTurnTicks(() => 0, "minimum").ticks).toBe(1);
    expect(ordinaryTurnTicks(() => 0.999999, "maximum").ticks).toBe(2);
    expect(ordinaryTurnTicks(() => 0, "minimum", 800).ticks).toBe(4);
    expect(ordinaryTurnTicks(() => 0.999999, "maximum", 800).ticks).toBe(5);
    const seen = new Set<number>();
    let state = 0x51ed_5eed;
    const random = () => {
      state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
      return state / 0x1_0000_0000;
    };
    for (let sample = 0; sample < 10_000; sample++) seen.add(ordinaryTurnTicks(random, "random").ticks);
    expect(seen).toEqual(new Set([1, 2]));
  });

  test("globally routes every phase to a legal committed opponent policy", async () => {
    const playbook = await loadPhasePlaybook(PLAYBOOK);
    const routes = auditPlaybookRoutes(playbook);
    expect(playbook.PLAYBOOK_SCHEMA).toBe(5);
    expect("OPPONENTS" in playbook ? playbook.OPPONENTS : []).toEqual([
      "Netburners",
      "Slum Snakes",
      "The Black Hand",
      "Tetrads",
      "Daedalus",
      "Illuminati",
    ]);
    expect(routes.phases).toBe(150_000);
    expect(routes.enterPhases).toBe(13_154);
    expect(routes.uniqueEntryPolicies).toHaveLength(13_154);
    expect(routes.maximumDodges).toBe(54);
    expect(routes.meanDodges).toBeCloseTo(6.218273333333333, 12);
    expect(statSync(PLAYBOOK).size).toBeLessThan(35_000_000);
    const standaloneSource = readFileSync(PLAYBOOK, "utf8");
    expect(standaloneSource).toContain("/** @param {NS} ns */\nexport async function main(ns)");
    expect(standaloneSource).toContain("Opponent must be auto, 0..5, or a faction name");
    expect(standaloneSource).toContain("ns.ui.openTail()");
    expect(standaloneSource).not.toContain("ns.tail()");
    expect(standaloneSource).not.toContain("ns.prompt(");
    expect(standaloneSource).not.toContain("ns.sleep(200)");
    expect(standaloneSource).toContain("snapshot.bonusCycles");
    expect(standaloneSource).toContain('telemetry("CREATED"');
    expect(standaloneSource).toContain('telemetry("DISPATCH"');
    expect(standaloneSource).toContain('telemetry("MISS"');
    const builderSource = readFileSync(
      join(import.meta.dir, "../ipvgobruteforce/arena/build-multi.ts"), "utf8",
    );
    expect(builderSource).toContain("refusing to package an incomplete/non-optimal playbook");
    expect(builderSource).toContain("--allow-incomplete-generation");
    const summary = JSON.parse(readFileSync(join(MERGED, "summary.json"), "utf8"));
    expect(summary.packedBytes).toBeLessThan(28_200_000);
    expect(summary.meanPowerPerTurn).toBeCloseTo(0.9821471723313265, 12);
    expect(summary.aggregatePowerPerTurn).toBeCloseTo(0.8764776573306519, 12);

    for (const route of routes.uniqueEntryPolicies) {
      const board = initialBoard(playbook, route.enemy, route.entryPhase);
      const encoded = playbookLookupMove(
        playbook,
        route.enemy,
        route.entryPhase,
        packPlaybookBoard(board.rows),
      );
      expect(encoded, `${route.enemy} phase ${route.entryPhase}`).not.toBe(playbook.MISS);
      const action = playbook.describeMove(encoded);
      // v16 certifies entries that trade the first turn for timing
      // determinism: an opening ALIGN is legal and must lead to a certified
      // legal move at the next phase under full alignment credit.
      expect(["move", "align"], `${route.enemy} phase ${route.entryPhase}`).toContain(action.kind);
      if (action.kind === "move") {
        expect(playMove(board, action.x, action.y, "X")).toBeDefined();
      } else if (action.kind === "align") {
        const model = (playbook as { modelFor(enemy: string): { alignmentBoards: number } })
          .modelFor(route.enemy);
        const followUp = playbookLookupMove(
          playbook,
          route.enemy,
          (route.entryPhase + 1) % playbook.PHASES,
          packPlaybookBoard(board.rows),
          0,
          model.alignmentBoards,
        );
        expect(followUp, `${route.enemy} phase ${route.entryPhase} post-align`)
          .not.toBe(playbook.MISS);
        const followUpAction = playbook.describeMove(followUp);
        expect(followUpAction.kind, `${route.enemy} phase ${route.entryPhase} post-align`)
          .toBe("move");
        if (followUpAction.kind === "move") {
          expect(playMove(board, followUpAction.x, followUpAction.y, "X")).toBeDefined();
        }
      }
    }
  }, 30_000);

  test("standalone timing waits for exactly the next live phase and rejects overshoot", async () => {
    const playbook = await loadPhasePlaybook(PLAYBOOK);
    const advanceOnePhase = (playbook as PhasePlaybook & {
      advanceOnePhase(ns: {
        getPlayer(): { totalPlaytime: number };
        sleep(milliseconds: number): Promise<void>;
      }): Promise<number>;
    }).advanceOnePhase;

    let playtime = 1_000;
    const exactSleeps: number[] = [];
    const exact = await advanceOnePhase({
      getPlayer: () => ({ totalPlaytime: playtime }),
      sleep: async (milliseconds) => {
        exactSleeps.push(milliseconds);
        playtime = 1_200;
      },
    });
    expect(exact).toBe(6);
    // One coarse-or-fine sleep bounded by a single engine cycle; the exact
    // duration is an implementation detail of the phase-edge scheduler.
    expect(exactSleeps.length).toBe(1);
    expect(exactSleeps[0]).toBeGreaterThan(0);
    expect(exactSleeps[0]).toBeLessThanOrEqual(200);

    playtime = 1_000;
    await expect(advanceOnePhase({
      getPlayer: () => ({ totalPlaytime: playtime }),
      sleep: async () => { playtime = 1_400; },
    })).rejects.toThrow("phase wait overshot target 6 and reached 7");
  });

  test("standalone schedules an exact state for bonus-time dispatch", async () => {
    const playbook = await loadPhasePlaybook(PLAYBOOK) as MultiPhasePlaybook & {
      certifiedAction(
        enemy: string,
        actualPhase: number,
        bonusCycles: number,
        board: bigint,
        passes: number,
        credit: number,
        history: bigint[],
      ): { action: { kind: string }; modelPhase: number; dispatchPhase: number } | undefined;
    };
    const routes = auditPlaybookRoutes(playbook);
    const route = routes.uniqueEntryPolicies.find(
      (candidate) => candidate.enemy === "Netburners" && candidate.entryPhase === 3_314,
    );
    expect(route).toBeDefined();
    const board = packPlaybookBoard(initialBoard(playbook, route!.enemy, route!.entryPhase).rows);
    const result = playbook.certifiedAction(
      route!.enemy,
      route!.entryPhase,
      10,
      board,
      0,
      0,
      [],
    );
    expect(result?.modelPhase).toBe(route!.entryPhase);
    expect(result?.dispatchPhase).toBe(route!.entryPhase + 1);
    expect(result?.action.kind).toBe("move");
  });

  test("standalone board routing tolerates skipped browser clock phases", async () => {
    const playbook = await loadPhasePlaybook(PLAYBOOK);
    const runtime = playbook as MultiPhasePlaybook & {
      beginCommittedGame(ns: {
        getPlayer(): { totalPlaytime: number };
        sleep(milliseconds: number): Promise<void>;
        go: {
          getGameState(): { currentPlayer: "Black" | "White" | "None" };
          getBoardState(): string[];
          resetBoardState(enemy: string, size: number): void;
        };
      }, enemy: string): Promise<{ enemy: string; entryPhase: number; waits: number; dodges: number }>;
    };
    const enemy = "Daedalus";
    const start = 2;
    expect(runtime.selectRoot(start, enemy).waits).toBeGreaterThanOrEqual(12);
    const expected = runtime.selectRoot(start - 1, enemy);
    const epochBase = playbookModel(playbook, enemy).playtimeEpoch * 30_000_000;
    let playtime = epochBase + (start - 1) * 200;
    let initial = true;
    let resets = 0;
    const route = await runtime.beginCommittedGame({
      getPlayer: () => ({ totalPlaytime: playtime }),
      sleep: async () => {
        if (initial) {
          initial = false;
          playtime = epochBase + start * 200;
          return;
        }
        const phase = playbook.phaseNow(playtime);
        const remaining = (expected.entryPhase - phase + playbook.PHASES) % playbook.PHASES;
        playtime += Math.min(3, remaining) * 200;
      },
      go: {
        getGameState: () => ({ currentPlayer: "None" }),
        getBoardState: () => {
          const board = initialBoard(playbook, enemy, playbook.phaseNow(playtime));
          return Array.from({ length: 5 }, (_, x) =>
            Array.from({ length: 5 }, (_, y) => board.rows[y]![x]!).join(""));
        },
        resetBoardState: () => { resets++; },
      },
    }, enemy);
    expect(route.entryPhase).toBe(expected.entryPhase);
    expect(route.waits).toBe(expected.waits);
    expect(resets).toBe(1);
    expect(route.dodges).toBe(route.waits);
  });

  test("standalone skips a prospective board when its safe opening window was missed", async () => {
    const playbook = await loadPhasePlaybook(PLAYBOOK);
    const runtime = playbook as MultiPhasePlaybook & {
      beginCommittedGame(ns: unknown, enemy: string): Promise<{
        enemy: string; entryPhase: number; waits: number; dodges: number;
      }>;
    };
    const enemy = "Netburners";
    let phase = 1;
    for (; phase < playbook.PHASES; phase++) {
      if (runtime.selectRoot(phase, enemy).waits === 0) break;
    }
    const epochBase = playbookModel(playbook, enemy).playtimeEpoch * 30_000_000;
    let playtime = epochBase
      + (phase - 1) * 200;
    let resets = 0;
    let sleeps = 0;
    const route = await runtime.beginCommittedGame({
      getPlayer: () => ({ totalPlaytime: playtime }),
      sleep: async () => {
        sleeps++;
        playtime = sleeps === 1 ? epochBase + phase * 200 + 150
          : (Math.floor(playtime / 200) + 1) * 200;
      },
      go: {
        getGameState: () => ({ currentPlayer: "None" }),
        getBoardState: () => {
          const board = initialBoard(playbook, enemy, playbook.phaseNow(playtime));
          return Array.from({ length: 5 }, (_, x) =>
            Array.from({ length: 5 }, (_, y) => board.rows[y]![x]!).join(""));
        },
        resetBoardState: () => { resets++; },
      },
    }, enemy);
    expect(resets).toBe(1);
    expect(route.entryPhase).not.toBe(phase);
    expect(route.dodges).toBeGreaterThan(0);
  });

  test("standalone routing resumes a live 5x5 board before changing opponents", async () => {
    const playbook = await loadPhasePlaybook(PLAYBOOK) as MultiPhasePlaybook & {
      beginCommittedGame(ns: unknown, enemy: string): Promise<{
        enemy: string; entryPhase: number; waits: number; dodges: number; resumed: boolean;
      }>;
    };
    const activeEnemy = "Daedalus";
    const phase = 43_016;
    const board = initialBoard(playbook, activeEnemy, phase);
    const columns = Array.from({ length: 5 }, (_, x) =>
      Array.from({ length: 5 }, (_, y) => board.rows[y]![x]!).join(""));
    let resets = 0;
    const route = await playbook.beginCommittedGame({
      getPlayer: () => ({ totalPlaytime: phase * 200 }),
      sleep: async () => { throw new Error("must not wait while a board is active"); },
      go: {
        getGameState: () => ({ currentPlayer: "Black" }),
        getBoardState: () => columns,
        getMoveHistory: () => [],
        getOpponent: () => activeEnemy,
        resetBoardState: () => { resets++; },
      },
    }, "Illuminati");
    expect(route.enemy).toBe(activeEnemy);
    expect(route.resumed).toBe(true);
    expect(route.entryPhase).toBe(phase);
    expect(resets).toBe(0);
  });

  test("standalone recovery replaces an unknown active board after a move", async () => {
    const playbook = await loadPhasePlaybook(PLAYBOOK) as MultiPhasePlaybook & {
      activeBoard(ns: unknown): { signature: string } | undefined;
      beginCommittedGame(ns: unknown, enemy: string, progress?: unknown,
        replaceSignature?: string): Promise<{
          enemy: string; entryPhase: number; waits: number; dodges: number;
        }>;
    };
    const enemy = "Netburners";
    let target = 1;
    for (; target < playbook.PHASES; target++) {
      if (playbook.selectRoot(target, enemy).waits === 0) break;
    }
    let playtime = playbookModel(playbook, enemy).playtimeEpoch * 30_000_000
      + (target - 1) * 200;
    let active = true;
    let resets = 0;
    const columns = ["X....", ".....", ".....", ".....", "....."];
    const ns = {
      getPlayer: () => ({ totalPlaytime: playtime }),
      sleep: async () => { playtime = (Math.floor(playtime / 200) + 1) * 200; },
      go: {
        getGameState: () => active
          ? ({ currentPlayer: "Black", previousMove: [0, 0] })
          : ({ currentPlayer: "None", previousMove: null }),
        getBoardState: () => columns,
        getMoveHistory: () => [columns],
        getOpponent: () => enemy,
        resetBoardState: () => { active = true; resets++; },
      },
    };
    const signature = playbook.activeBoard(ns)?.signature;
    expect(signature).toBeDefined();
    const route = await playbook.beginCommittedGame(ns, enemy, undefined, signature);
    expect(route.entryPhase).toBe(target);
    expect(resets).toBe(1);
  });

  test("standalone opponent selection routes every phase to a retained policy", async () => {
    const playbook = await loadPhasePlaybook(PLAYBOOK);
    if (!("OPPONENTS" in playbook)) throw new Error("expected a multi-opponent playbook");
    for (const enemy of playbook.OPPONENTS) {
      for (let phase = 0; phase < playbook.PHASES; phase++) {
        const route = playbook.selectRoot(phase, enemy);
        expect(route.enemy).toBe(enemy);
        expect(route.entryPhase).toBeGreaterThanOrEqual(0);
        expect(route.entryPhase).toBeLessThan(playbook.PHASES);
        expect((phase + route.waits) % playbook.PHASES).toBe(route.entryPhase);
        expect(route.expectedPowerPerTurn).toBe(
          playbook.entryExpectedPowerPerTurn(enemy, route.entryPhase),
        );
        expect(route.expectedPowerPerTurn).toBeGreaterThan(0);
      }
    }
  }, 30_000);

  test("arena detects non-periodic full-playtime WHRNG roots", async () => {
    const playbook = await loadPhasePlaybook(PLAYBOOK);
    const route = { enemy: "Netburners", entryPhase: 626, waits: 0 };
    const canonical = auditPlaybookRuntimeRoots(playbook, [route], [0]);
    const liveEpoch = auditPlaybookRuntimeRoots(playbook, [route], [2_697]);
    expect(canonical.misses).toBe(1);
    expect(liveEpoch.misses).toBe(0);
    expect(canonical.examples[0]?.playtime).toBe(125_200);
    expect(canonical.examples[0]?.board).toBeDefined();
  });

  test("packer retains every certified Illuminati opening variant", async () => {
    const playbook = await loadPhasePlaybook(PLAYBOOK);
    if (!("OPPONENTS" in playbook)) throw new Error("expected multi-opponent playbook");
    const phases = new Set<number>();
    for (let phase = 0; phase < playbook.PHASES; phase++) {
      phases.add(playbook.selectRoot(phase, "Illuminati").entryPhase);
    }
    let variants = 0;
    let misses = 0;
    for (const phase of phases) {
      const epoch = playbookModel(playbook, "Illuminati").playtimeEpoch;
      for (const board of playbookInitialBoardsAtPlaytime(
        "Illuminati", epoch * 30_000_000 + phase * 200,
      )) {
        variants++;
        if (playbookLookupMove(
          playbook, "Illuminati", phase, packPlaybookBoard(board.rows),
        ) === playbook.MISS) misses++;
      }
    }
    expect(phases.size).toBe(292);
    expect(variants).toBe(1_164);
    expect(misses).toBe(0);
    let totalWaits = 0;
    let maximumWaits = 0;
    for (let phase = 0; phase < playbook.PHASES; phase++) {
      const waits = playbook.selectRoot(phase, "Illuminati").waits;
      totalWaits += waits;
      maximumWaits = Math.max(maximumWaits, waits);
    }
    expect(totalWaits / playbook.PHASES).toBeCloseTo(607.6974933333333, 10);
    expect(maximumWaits).toBe(4_938);
  }, 30_000);

  test("arena rejects the bounded discovery corpus as an optimal proof", async () => {
    const generation = await auditGeneration();
    expect(generation.exhaustive).toBe(false);
    expect(generation.optimalityProven).toBe(false);
    expect(generation.unknown).toBe(1_787_211);
    expect(generation.corpora["illuminati-5x5-epoch2697-v16-sweep"]).toEqual({
      certifiedRoots: 9_447,
      unknownRoots: 1_070_141,
      fullyCertifiedPhases: 296,
    });
  }, 30_000);

  test("unknown states never inherit a phase-wide action", async () => {
    const playbook = await loadPhasePlaybook(PLAYBOOK);
    for (const phase of [55_587, 55_821]) {
      for (let sample = 0; sample < 1_000; sample++) {
        const board = (BigInt(sample) * 0x123456789abn) & ((1n << 50n) - 1n);
        expect(playbookLookupMove(playbook, "Netburners", phase, board)).toBe(playbook.MISS);
      }
    }
  });

  test("validates every exact CHECK action when optional collision audits are retained", async () => {
    const auditDirectory = join(MERGED, "audits");
    if (!existsSync(auditDirectory)) return;
    const playbook = await loadPhasePlaybook(PLAYBOOK);
    let records = 0;
    let mismatches = 0;
    for (const filename of readdirSync(auditDirectory).filter((name) => name.endsWith(".tsv"))) {
      const rows = readFileSync(join(auditDirectory, filename), "utf8").trimEnd().split("\n");
      const header = rows.shift()!.split("\t");
      const column = (name: string) => {
        const index = header.indexOf(name);
        if (index < 0) throw new Error(`${filename} lacks ${name}`);
        return index;
      };
      const enemyColumn = column("enemy");
      const phaseColumn = column("phase");
      const hashColumn = column("selected_hash");
      const hash2Column = column("selected_hash2");
      const actionColumn = column("action");
      for (const row of rows) {
        const fields = row.split("\t");
        const actual = playbookLookupHashed(
          playbook,
          fields[enemyColumn]!,
          Number(fields[phaseColumn]),
          Number(fields[hashColumn]),
          Number(fields[hash2Column]),
        );
        if (actual !== Number(fields[actionColumn])) mismatches++;
      }
      records += rows.length;
    }
    expect(records).toBeGreaterThan(0);
    expect(mismatches).toBe(0);
  }, 30_000);

  test("plays representative policies for every opponent and timing model", async () => {
    const playbook = await loadPhasePlaybook(PLAYBOOK);
    const routes = auditPlaybookRoutes(playbook);
    for (const enemy of "OPPONENTS" in playbook ? playbook.OPPONENTS : []) {
      const policies = routes.uniqueEntryPolicies.filter((route) => route.enemy === enemy);
      for (const route of [policies[0]!, policies[Math.floor(policies.length / 2)]!, policies.at(-1)!]) {
        for (const timing of ["minimum", "maximum", "random"] as const) {
          const game = await playPlaybookArenaGame(playbook, route.entryPhase, {
            timing,
            opponent: enemy,
            enterCommittedPhase: true,
            defenseSeed: (route.entryPhase ^ 0x9e37_79b9) >>> 0,
          });
          expect(game.failure, `${enemy} phase ${route.entryPhase}, ${timing}`).toBeUndefined();
          expect(game.won, `${enemy} phase ${route.entryPhase}, ${timing}`).toBe(true);
        }
      }
    }
  }, 30_000);

  test("plays accelerated bonus-cycle replies from exact states", async () => {
    const playbook = await loadPhasePlaybook(PLAYBOOK);
    const routes = auditPlaybookRoutes(playbook);
    for (const enemy of "OPPONENTS" in playbook ? playbook.OPPONENTS : []) {
      const policies = routes.uniqueEntryPolicies.filter((route) => route.enemy === enemy);
      for (let sample = 0; sample < Math.min(24, policies.length); sample++) {
        const route = policies[Math.floor(sample * policies.length / Math.min(24, policies.length))]!;
        const game = await playPlaybookArenaGame(playbook, route.entryPhase, {
          timing: "maximum",
          opponent: enemy,
          enterCommittedPhase: true,
          defenseSeed: (route.entryPhase ^ sample ^ 0x51ed_270b) >>> 0,
          bonusCycles: 10_000,
        });
        expect(game.failure, `${enemy} phase ${route.entryPhase}`).toBeUndefined();
        expect(game.won, `${enemy} phase ${route.entryPhase}`).toBe(true);
      }
    }
  }, 30_000);

});
