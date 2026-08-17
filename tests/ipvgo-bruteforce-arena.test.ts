import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { existsSync, readFileSync, statSync } from "node:fs";
import {
  auditPlaybookRoutes,
  loadPhasePlaybook,
  packPlaybookBoard,
  playbookLookupHashed,
  playbookLookupMove,
  playbookModel,
} from "../ipvgobruteforce/arena/playbook.ts";
import {
  playbookInitialBoardAtPlaytime,
  playPlaybookArenaGame,
} from "../sim/ipvgobruteforce-arena.ts";
import { playMove } from "../shared/strategy/go/rules.ts";

const PLAYBOOK_PATH = join(
  import.meta.dir,
  "../ipvgobruteforce/data/seeded-phases/netburners-5x5-epoch2697-v16-sweep/merged/playbook.phase.js",
);
const COLLISION_REPORT_PATH = join(
  import.meta.dir,
  "../ipvgobruteforce/data/seeded-phases/netburners-5x5-epoch2697-v16-sweep/merged/phase-collisions.tsv",
);

describe("IPvGO brute-force phase playbook", () => {
  test("all root routes commit to valid entry phases with legal openings", async () => {
    const playbook = await loadPhasePlaybook(PLAYBOOK_PATH);
    const routes = auditPlaybookRoutes(playbook);
    expect(routes.phases).toBe(150_000);
    expect(routes.enterPhases).toBe(7_504);
    expect(routes.uniqueEntryPolicies).toHaveLength(7_563);
    expect(routes.maximumDodges).toBe(161);
    expect(playbook.PLAYBOOK_SCHEMA).toBe(4);
    expect(statSync(PLAYBOOK_PATH).size).toBeLessThan(10_000_000);

    for (const { entryPhase: phase } of routes.uniqueEntryPolicies) {
      const playtime = playbookModel(playbook, "Netburners").playtimeEpoch * 30_000_000 + phase * 200;
      const board = playbookInitialBoardAtPlaytime("Netburners", playtime, 1);
      const encoded = playbookLookupMove(
        playbook,
        "Netburners",
        phase,
        packPlaybookBoard(board.rows),
        0,
        0,
        [],
      );
      expect(encoded, `entry phase ${phase}`).not.toBe(playbook.MISS);
      const action = playbook.describeMove(encoded);
      // v16 certifies entries that open with an ALIGN; those must resolve to
      // a certified legal move at the next phase under full alignment credit.
      expect(["move", "align"], `entry phase ${phase}`).toContain(action.kind);
      if (action.kind === "move") {
        expect(playMove(board, action.x, action.y, "X"), `entry phase ${phase}`).toBeDefined();
      } else if (action.kind === "align") {
        const followUp = playbookLookupMove(
          playbook,
          "Netburners",
          (phase + 1) % playbook.PHASES,
          packPlaybookBoard(board.rows),
          0,
          playbookModel(playbook, "Netburners").alignmentBoards,
          [],
        );
        expect(followUp, `entry phase ${phase} post-align`).not.toBe(playbook.MISS);
        const followUpAction = playbook.describeMove(followUp);
        expect(followUpAction.kind, `entry phase ${phase} post-align`).toBe("move");
        if (followUpAction.kind === "move") {
          expect(playMove(board, followUpAction.x, followUpAction.y, "X"),
            `entry phase ${phase} post-align`).toBeDefined();
        }
      }
    }
  }, 30_000);

  test("validates every exact CHECK action when the optional collision audit is retained", async () => {
    if (!existsSync(COLLISION_REPORT_PATH)) return;
    const playbook = await loadPhasePlaybook(PLAYBOOK_PATH);
    expect(playbook.lookupHashed).toBeDefined();
    const rows = readFileSync(COLLISION_REPORT_PATH, "utf8").trimEnd().split("\n");
    const header = rows.shift()!.split("\t");
    const column = (name: string) => {
      const index = header.indexOf(name);
      if (index < 0) throw new Error(`collision report lacks ${name}`);
      return index;
    };
    const phaseColumn = column("phase");
    const hashColumn = column("selected_hash");
    const hash2Column = column("selected_hash2");
    const actionColumn = column("action");
    let mismatches = 0;
    for (const row of rows) {
      const fields = row.split("\t");
      const actual = playbookLookupHashed(
        playbook,
        "Netburners",
        Number(fields[phaseColumn]),
        Number(fields[hashColumn]),
        Number(fields[hash2Column]),
      );
      if (actual !== Number(fields[actionColumn])) mismatches++;
    }
    expect(rows.length).toBeGreaterThan(0);
    expect(mismatches).toBe(0);
  }, 30_000);

  test("representative committed policies win under both modeled timing bounds", async () => {
    const playbook = await loadPhasePlaybook(PLAYBOOK_PATH);
    const routes = auditPlaybookRoutes(playbook);
    const samples = 1_024;
    for (let sample = 0; sample < samples; sample++) {
      const { enemy, entryPhase: phase } = routes.uniqueEntryPolicies[
        Math.floor(sample * routes.uniqueEntryPolicies.length / samples)
      ]!;
      for (const timing of ["minimum", "maximum"] as const) {
        const game = await playPlaybookArenaGame(playbook, phase, {
          timing,
          defenseSeed: (phase ^ 0x9e37_79b9) >>> 0,
          enterCommittedPhase: true,
          opponent: enemy,
        });
        expect(game.failure, `entry phase ${phase}, ${timing}`).toBeUndefined();
        expect(game.completed, `entry phase ${phase}, ${timing}`).toBe(true);
        expect(game.won, `entry phase ${phase}, ${timing}, score ${JSON.stringify(game.score)}`).toBe(true);
      }
    }
  }, 30_000);
});
