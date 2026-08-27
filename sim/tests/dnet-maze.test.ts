import { describe, expect, test } from "bun:test";
import { SimWorld } from "../world.ts";
import { ProcessTable } from "../ns/process.ts";
import { DarknetSystem } from "../features/dnet.ts";
import { generateMaze, MAZE_PATH, surroundingsVisualized } from "../features/dnet-maze.ts";
import { mulberry32 } from "../core/rng.ts";
import { darkwebServerSpec } from "../network.ts";
import { LAB_LADDER, labMazeSize } from "../../shared/strategy/dnet/rates.ts";
import {
  decideLab,
  emptyField,
  LAB_FIRST_PROBE,
  labPrior,
  observeLab,
  readCoords,
  readSurroundings,
  refuseEdge,
  type Cell,
  type Direction,
  type LabField,
} from "../../shared/strategy/dnet/maze.ts";

/** The labyrinth, end to end: the walker in `shared/strategy/dnet/maze.ts`
 * against the maze in `sim/features/dnet-maze.ts`.
 *
 * This is the only test in the feature where the strategy and the model are
 * genuinely two halves of one claim. `decideLab` is a pure planner over parsed
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

/** Walk one maze the way `walkJob` does: probe blind, parse the coordinates
 * out of the message, fold every render into the field, and let `decideLab`
 * choose between the next move and a paid radar. */
function walk(dnet: DarknetSystem, lab: string, pid: number, cap: number): {
  done: boolean;
  at?: Cell;
  radars: number;
} {
  const prior = labPrior(LAB_LADDER[0]!);
  let field: LabField = emptyField();
  let at: Cell | undefined;
  let pending: Direction | undefined;
  let radars = 0;
  for (let i = 0; i < cap; i++) {
    let direction: Direction;
    if (at === undefined) {
      direction = LAB_FIRST_PROBE;
    } else {
      const plan = decideLab(field, at, prior);
      if (plan.kind === "lost") return { done: false, at, radars };
      field = plan.field;
      if (plan.kind === "radar") {
        const seen = dnet.labRadar(pid);
        radars++;
        if (seen.success) field = observeLab(field, at, seen.message, prior) ?? field;
        continue;
      }
      direction = plan.direction;
    }
    pending = direction;
    const answer = dnet.labAttempt(lab, direction, pid);
    if (answer.ok) return { done: true, ...(at ? { at } : {}), radars };
    const where = readCoords(answer.message);
    if (where === undefined) return { done: false, ...(at ? { at } : {}), radars };
    const seen = observeLab(field, where, answer.data, prior);
    if (seen === undefined) return { done: false, at: where, radars };
    field = seen;
    if (at !== undefined && where[0] === at[0] && where[1] === at[1]) {
      field = refuseEdge(field, at, pending);
    }
    at = where;
  }
  return { done: false, ...(at ? { at } : {}), radars };
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
    // step two cells with the wall as the one between. The planner's `ahead`
    // helper depends on it exactly.
    const maze = generateMaze(20, 14, mulberry32(13));
    expect(maze[1]![1]).toBe(MAZE_PATH);
    for (let y = 0; y < maze.length; y += 2) {
      for (let x = 0; x < maze[0]!.length; x += 2) {
        // Every even/even cell is a pillar the carve can never open.
        expect(maze[y]![x]).not.toBe(MAZE_PATH);
      }
    }
  });

  test("the planner's prior matches what the generator can actually build", () => {
    // Everything `decideLab` believes before the first move, checked against
    // the transcribed generator itself: the produced dimensions, that every
    // standing cell is floor, that the seams are wall everywhere EXCEPT the
    // computed door candidates, that each exclusive candidate set holds exactly
    // one punched door, and that each quadrant is a perfect maze — a spanning
    // TREE, which is what licenses the "connected already means walled between"
    // inference.
    for (const [stageIndex, stage] of [LAB_LADDER[0]!, LAB_LADDER[1]!, LAB_LADDER[2]!, LAB_LADDER[3]!].entries()) {
      const prior = labPrior(stage);
      for (let seed = 1; seed <= 25; seed++) {
        const maze = generateMaze(stage.mazeWidth, stage.mazeHeight, mulberry32(seed * 131 + stageIndex));
        expect({ width: maze[0]!.length, height: maze.length })
          .toEqual({ width: prior.width, height: prior.height });

        for (let y = 1; y < prior.height - 1; y += 2) {
          for (let x = 1; x < prior.width - 1; x += 2) {
            expect(maze[y]![x]).toBe(MAZE_PATH);
          }
        }

        const doorSlots = new Set(Object.keys(prior.doorIndex));
        for (let y = 1; y < prior.height - 1; y += 2) {
          if (maze[y]![prior.seamX!] === MAZE_PATH) expect(doorSlots.has(`${prior.seamX},${y}`)).toBe(true);
        }
        for (let x = 1; x < prior.width - 1; x += 2) {
          if (maze[prior.seamY!]![x] === MAZE_PATH) expect(doorSlots.has(`${x},${prior.seamY}`)).toBe(true);
        }
        for (const [setIndex, set] of prior.doorSets.entries()) {
          if (prior.doorSetExclusive[setIndex] !== true) continue;
          const open = set.filter((held) => {
            const [x, y] = held.split(",").map(Number);
            return maze[y!]![x!] === MAZE_PATH;
          });
          expect(open).toHaveLength(1);
        }

        // Structure check per quadrant: upstream's carve never marks its start
        // `[1,1]` visited, so the wave later carves INTO it exactly once more.
        // Each quadrant is therefore a spanning tree PLUS one extra edge — one
        // open slot per standing cell — and every edge that closes a cycle is
        // incident to the quadrant's own top-left cell. `decideLab`'s
        // "connected already means walled between" inference is licensed by
        // exactly this shape.
        for (const [left, top] of [[true, true], [false, true], [true, false], [false, false]]) {
          const xs = { from: left ? 1 : prior.seamX! + 1, to: left ? prior.seamX! - 1 : prior.width - 2 };
          const ys = { from: top ? 1 : prior.seamY! + 1, to: top ? prior.seamY! - 1 : prior.height - 2 };
          const cells = ((xs.to - xs.from) / 2 + 1) * ((ys.to - ys.from) / 2 + 1);
          const start: Cell = [xs.from, ys.from];
          const away: Cell[] = [];
          const touching: Cell[] = [];
          for (let y = ys.from; y <= ys.to; y++) {
            for (let x = xs.from; x <= xs.to; x++) {
              if ((x % 2) + (y % 2) !== 1 || maze[y]![x] !== MAZE_PATH) continue;
              const touchesStart = (x === start[0] && Math.abs(y - start[1]) === 1)
                || (y === start[1] && Math.abs(x - start[0]) === 1);
              (touchesStart ? touching : away).push([x, y]);
            }
          }
          // The late carve INTO the start can re-open the wall it already came
          // through, so the extra edge exists at most once: tree, or tree + 1.
          expect([cells - 1, cells]).toContain(away.length + touching.length);
          const parent = new Map<string, string>();
          const find = (held: string): string => {
            let root = held;
            while (parent.get(root) !== undefined && parent.get(root) !== root) root = parent.get(root)!;
            return root;
          };
          let cycles = 0;
          // Start-incident edges LAST, so any cycle is charged to one of them:
          // the claim is that the edges away from the start are a forest.
          for (const [x, y] of [...away, ...touching]) {
            const a = x % 2 === 0 ? `${x - 1},${y}` : `${x},${y - 1}`;
            const b = x % 2 === 0 ? `${x + 1},${y}` : `${x},${y + 1}`;
            const rootA = find(a);
            const rootB = find(b);
            if (rootA === rootB) {
              cycles++;
              expect(touching.some(([hx, hy]) => hx === x && hy === y)).toBe(true);
            } else {
              parent.set(rootA, rootB);
            }
          }
          expect(cycles).toBeLessThanOrEqual(1);
          expect(away.length + touching.length - cycles).toBe(cells - 1);
        }
      }
    }
  });

  test("the render is 3x3, centred, with the player shown and the exit hidden", () => {
    // The current walker needs no `heartbleed`: enough local information to
    // finish arrives with each move. `labradar` can reveal MORE (radius 3 and
    // the exit), but costs one authentication and is benchmarked separately.
    // The move handler itself renders with `showEnd = false`.
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
