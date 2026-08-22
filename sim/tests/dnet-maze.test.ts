import { describe, expect, test } from "bun:test";
import { SimWorld } from "../world.ts";
import { ProcessTable } from "../ns/process.ts";
import { DarknetSystem } from "../features/dnet.ts";
import { generateMaze, MAZE_PATH, surroundingsVisualized } from "../features/dnet-maze.ts";
import { mulberry32 } from "../core/rng.ts";
import { darkwebServerSpec } from "../network.ts";
import { LAB_LADDER, labMazeSize } from "../../shared/strategy/dnet/rates.ts";
import {
  emptyMaze,
  readCoords,
  readSurroundings,
  stepMaze,
  type Cell,
  type MazeKnowledge,
} from "../../shared/strategy/dnet/maze.ts";

/** The labyrinth, end to end: the walker in `shared/strategy/dnet/maze.ts`
 * against the maze in `sim/features/dnet-maze.ts`.
 *
 * This is the only test in the feature where the strategy and the model are
 * genuinely two halves of one claim. `stepMaze` is a pure DFS over parsed
 * strings and can be unit-tested against hand-written renders — `tests/
 * dnet-maze.test.ts` does exactly that — but a hand-written render is a render
 * WE wrote, and every one of the walker's failure modes is a disagreement about
 * what the engine actually sends back:
 *
 * - the render is 3x3 with the player overlaid at the centre and the exit NOT
 *   shown, so the walker never sees where it is going;
 * - a step is two cells and the wall is the one between;
 * - a refused move answers "You are still at X,Y" and does not move;
 * - the maze is not the size `labData` asks for, so the corner to aim at is
 *   `[cols - 2, rows - 2]` of the STITCHED result.
 *
 * Get any of those wrong in the same direction in both halves and a unit test
 * still passes. So the assertion here is the one thing that cannot be faked: a
 * walk that reaches the exit, in a bounded number of moves, driven only by what
 * the engine hands back. */

function labWorld(charisma: number, seed = 5): { dnet: DarknetSystem; lab: string } {
  const world = new SimWorld({
    seed: 1,
    bitnode: 15,
    network: [
      { hostname: "n00dles", hackDifficulty: 1, moneyAvailable: 1, requiredHackingSkill: 1, serverGrowth: 1, numOpenPortsRequired: 1, maxRam: 4 },
      darkwebServerSpec(),
    ],
  });
  world.person.exp.charisma = 0;
  world.person.skills.charisma = charisma;
  const processes = new ProcessTable(world.servers, world.clock);
  const network = new Map<string, string[]>([["home", ["n00dles", "darkweb"]], ["darkweb", ["home"]]]);
  const dnet = new DarknetSystem({
    servers: world.servers,
    network,
    processes,
    generate: mulberry32(seed),
    random: mulberry32(6),
    logNoise: mulberry32(7),
    bitNode: 15,
    fullAccess: () => true,
    hasProgram: () => false,
    installedAugmentations: () => new Set<string>(),
    allowRedPill: () => true,
    world,
    player: world.player,
    homeFiles: () => new Set<string>(),
    darknetMoneyMultiplier: () => 1,
  });
  dnet.populate();
  return { dnet, lab: LAB_LADDER[0]!.hostname };
}

/** Walk one maze the way `walkJob` does: parse the coordinates out of the
 * message, the walls out of the render, and hand both to `stepMaze`. */
function walk(dnet: DarknetSystem, lab: string, pid: number, cap: number): {
  moves: number;
  walls: number;
  done: boolean;
  at?: Cell;
} {
  const bounds = labMazeSize(LAB_LADDER[0]!);
  let known: MazeKnowledge = emptyMaze();
  let at: Cell | undefined;
  let render = "";
  let moves = 0;
  let walls = 0;
  for (let i = 0; i < cap; i++) {
    const step = at === undefined
      ? { kind: "go" as const, direction: "north" as const, known }
      : stepMaze(known, at, render, bounds);
    if (step.kind !== "go") return { moves, walls, done: false, ...(at ? { at } : {}) };
    const answer = dnet.labAttempt(lab, step.direction, pid);
    if (answer.ok) return { moves, walls, done: true, ...(at ? { at } : {}) };
    const where = readCoords(answer.message);
    if (where === undefined) return { moves, walls, done: false, ...(at ? { at } : {}) };
    if (at !== undefined && (where[0] !== at[0] || where[1] !== at[1])) moves++;
    else if (at !== undefined) walls++;
    at = where;
    render = answer.data;
    known = step.known ?? known;
  }
  return { moves, walls, done: false, ...(at ? { at } : {}) };
}

describe("the maze the game actually builds", () => {
  test("it is not the size labData asks for, and the strategy knows the real one", () => {
    // `generateMaze` stitches four sub-mazes and `mazeMaker` rounds each one up
    // to odd first, so a lab that declares 20x14 has a 21x13 maze. A walker
    // aiming at `[18, 12]` instead of `[19, 11]` searches the wrong block of a
    // maze that is hundreds of moves across on the deep labs.
    const maze = generateMaze(20, 14, mulberry32(11));
    expect(maze.length).toBe(13);
    expect(maze[0]!.length).toBe(21);
    expect(labMazeSize({ mazeWidth: 20, mazeHeight: 14 })).toEqual({ width: 21, height: 13 });
    // ...and the same arithmetic on the biggest lab.
    const big = generateMaze(60, 40, mulberry32(12));
    expect({ width: big[0]!.length, height: big.length }).toEqual(labMazeSize({ mazeWidth: 60, mazeHeight: 40 }));
  });

  test("standing positions are odd and the cells between them are wall slots", () => {
    // The carve steps two cells at a time from [1,1], which is what makes a
    // step two cells with the wall as the one between. `stepMaze`'s `ahead`
    // depends on it exactly.
    const maze = generateMaze(20, 14, mulberry32(13));
    expect(maze[1]![1]).toBe(MAZE_PATH);
    for (let y = 0; y < maze.length; y += 2) {
      for (let x = 0; x < maze[0]!.length; x += 2) {
        // Every even/even cell is a pillar the carve can never open.
        expect(maze[y]![x]).not.toBe(MAZE_PATH);
      }
    }
  });

  test("the render is 3x3, centred, with the player shown and the exit hidden", () => {
    // Why the walker needs no `heartbleed` and no `labradar`: everything it can
    // know arrives with the move. And why it cannot simply head for the exit:
    // the move handler renders with `showEnd = false`.
    const maze = generateMaze(20, 14, mulberry32(14));
    const view = surroundingsVisualized(maze, 1, 1, 1, true, false);
    const rows = view.split("\n");
    expect(rows).toHaveLength(3);
    expect(rows[1]![1]).toBe("@");
    expect(view).not.toContain("X");
    expect(readSurroundings(view)).toBeDefined();
  });
});

describe("walking it", () => {
  test("the walker reaches the exit, driven only by what the engine answers", () => {
    const { dnet, lab } = labWorld(400);
    const outcome = walk(dnet, lab, 1, 4000);
    expect(outcome.done).toBe(true);
    // Measured, and pinned as a ratchet rather than as a hope: the NormalLab is
    // ~121 moves on average and the search is deterministic given the maze, so
    // a change that made the walker wander shows up here as a number rather
    // than as a slower run nobody notices.
    expect(outcome.moves).toBeGreaterThan(20);
    expect(outcome.moves).toBeLessThan(600);
    // A wall refusal costs a call and moves nothing. The DFS only ever steps
    // into a direction the render showed open, so these should be rare — the
    // one exception is the blind first probe.
    expect(outcome.walls).toBeLessThanOrEqual(1);
  });

  test("reaching it roots the lab, drops the_great_work, and opens a session", () => {
    const { dnet, lab } = labWorld(400);
    expect(walk(dnet, lab, 1, 4000).done).toBe(true);
    expect(dnet.cachesOn(lab).some((name) => name.includes("the_great_work"))).toBe(true);
    // The session is written for the walking PID. Asserted on the raw set
    // rather than through `isAuthenticated`, which prunes any pid the process
    // table does not know — and this walk has no process behind it.
    expect(dnet.hosts.get(lab)!.sessions.has(1)).toBe(true);
    // And the walk pays charisma at a fixed 32-thread equivalent, which is the
    // largest single grant in the feature.
    expect(dnet.labAttempt(lab, "north", 1).message).toContain("discovered the end");
  });

  test("its cache queues an augmentation rather than paying money", () => {
    // The whole reason home defers this one cache: `getLabReward` calls
    // `queueAugmentation` directly, and the generic price multiplier is
    // `1.9 ^ (queued non-SoA)` against every purchase made after it.
    const { dnet, lab } = labWorld(400);
    expect(walk(dnet, lab, 1, 4000).done).toBe(true);
    const filename = dnet.cachesOn(lab).find((name) => name.includes("the_great_work"))!;
    const opened = dnet.openCache(lab, filename);
    expect(opened.message).toContain("augmentation");
    // The FIRST rung's reward, by name: `getLabAugReward` walks the six in
    // prereq order and this run has installed none of them.
    expect(opened.message).toContain("The W1ngs of Icarus");
  });

  test("a second process starts over, because the position is keyed by PID", () => {
    // The fact the whole job design turns on. `DarknetState.labLocations[pid]`
    // means a dead process abandons its walk with no way to resume — which is
    // why the walker never spawns, why it is the only long-lived job, and why
    // its host is the first thing a stasis link is spent on.
    const { dnet, lab } = labWorld(400);
    const first = dnet.labPosition(1);
    dnet.labAttempt(lab, "south", 1);
    expect(dnet.labPosition(1)).not.toEqual(first);
    // A different PID has never moved.
    expect(dnet.labPosition(2)).toEqual([1, 1]);
  });

  test("below the lab's charisma every single move is a 451", () => {
    // So a walker that started anyway would spend hours collecting refusals.
    // `walkJob` reads the requirement before its first move and posts the
    // shortfall as a career need instead.
    const { dnet, lab } = labWorld(LAB_LADDER[0]!.cha - 1);
    const refused = dnet.labAttempt(lab, "north", 1);
    expect(refused.code).toBe(451);
    expect(refused.ok).toBe(false);
    // ...and it learns nothing: no render, and the position is untouched.
    expect(refused.data).toBe("");
  });

  test("a wall answers with the position UNCHANGED, and says so", () => {
    // The branch a walker cannot recover from getting wrong: assuming a move
    // landed desyncs it from the engine permanently, and nothing ever corrects
    // it because every later response is read relative to a position it made
    // up. Parsing the coordinates out of every message is what makes that
    // impossible.
    const { dnet, lab } = labWorld(400);
    const start = dnet.labPosition(1);
    // The maze is walled all around [1,1] except where the carve opened it, so
    // one of north or west is guaranteed to be a wall.
    const blocked = ["north", "west"].map((direction) => dnet.labAttempt(lab, direction, 1));
    const wall = blocked.find((answer) => answer.message.includes("still at"))!;
    expect(wall).toBeDefined();
    expect(readCoords(wall.message)).toEqual(start);
    expect(dnet.labPosition(1)).toEqual(start);
  });

  test("the lab's own password is refused on purpose", () => {
    const { dnet, lab } = labWorld(400);
    const refused = dnet.labAttempt(lab, "(the labyrinth is not a password)", 1);
    expect(refused.ok).toBe(false);
    expect(refused.message).toContain("not to try and skip it");
  });
});
