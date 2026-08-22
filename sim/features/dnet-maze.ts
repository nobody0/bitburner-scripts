/** The labyrinth, transcribed.
 *
 * The maze is the one part of the darknet that is not a password and not a
 * network: a grid of walls, a position keyed by PID, and four direction words
 * that go through `authenticate` like any other guess. It lives in its own file
 * for the same reason `dnet-generators.ts` does — `sim/features/dnet.ts` is the
 * NETWORK, and a maze generator that happens to be reachable from it is not
 * network behaviour.
 *
 * Three things here are easy to get wrong, and each one would make a walker
 * that works in the simulator fail in the game:
 *
 * 1. **The maze is not the size `labData` asks for.** `generateMaze` stitches
 *    four sub-mazes together and `mazeMaker` rounds each one UP to an odd
 *    number of rows and columns first, then the halves overlap by one. A lab
 *    that declares 20x14 has a 21x13 maze, and its exit is at `[19, 11]`.
 * 2. **A step is two cells and the wall is the one between.** `newLocation` is
 *    `[x + dx*2, y + dy*2]` while the wall test reads `[x + dx, y + dy]`.
 *    Standing positions are always odd; the even cells between them are wall
 *    slots.
 * 3. **A refused move does not move you.** The wall branch answers "You are
 *    still at X,Y" and leaves `labLocations[pid]` untouched, so a walker that
 *    assumed its move landed would desync from the engine permanently.
 *
 * Source: ../bitburner-src at 3162fd2590e221eadd0c0fbd46151913f7c4c41c
 *   src/DarkNet/effects/labyrinth.ts:17-23 (the vectors and the glyphs),
 *   :112-186 (generateMaze and mazeMaker), :188-215 (the render),
 *   :236-330 (the move handler), :332-346 (position and direction parsing),
 *   :364-382 (the maze and the endpoint, with their offsets) */

/** `WALL = "█"`, `PATH = " "`. The renderer overlays `"@"` for the player and
 * `"X"` for the exit, and the move handler asks for the player and NOT the
 * exit — which is why a walker never sees where it is going. */
export const MAZE_WALL = "█";
export const MAZE_PATH = " ";

const NORTH: readonly [number, number] = [0, -1];
const EAST: readonly [number, number] = [1, 0];
const SOUTH: readonly [number, number] = [0, 1];
const WEST: readonly [number, number] = [-1, 0];

/** Above this width the maze is four stitched sub-mazes rather than one.
 * Every real lab is far above it; the branch below the threshold is
 * transcribed anyway because it is what decides the parity of the result. */
const MULTI_MAZE_THRESHOLD = 5;

/** `mazeMaker`: an iterative-backtracking carve over a grid of walls.
 *
 * The number of draws it takes is unbounded — it is a random DFS — which is
 * exactly why the caller derives a dedicated generator from ONE world draw
 * rather than taking these off a shared stream. Same reasoning as the password
 * generators in `dnet-generators.ts`.
 *
 * Upstream's dimensions are rounded UP to odd, because the carve steps two
 * cells at a time from `[1, 1]` and an even edge would leave a wall it can
 * never open. */
function mazeMaker(setWidth: number, setHeight: number, random: () => number): string[][] {
  const width = setWidth % 2 === 0 ? setWidth + 1 : setWidth;
  const height = setHeight % 2 === 0 ? setHeight + 1 : setHeight;
  const maze: string[][] = Array.from({ length: height }, () => new Array<string>(width).fill(MAZE_WALL));
  const stack: [number, number][] = [[1, 1]];
  const directions = [NORTH, EAST, SOUTH, WEST];
  while (stack.length > 0) {
    const node = stack.pop()!;
    const [x, y] = node;
    const neighbours = directions
      .map(([dx, dy]) => [x + dx * 2, y + dy * 2] as [number, number])
      .filter(([nx, ny]) => nx > 0 && nx < width && ny > 0 && ny < height && maze[ny]![nx] === MAZE_WALL);
    if (neighbours.length > 0) {
      stack.push([x, y]);
      const [nx, ny] = neighbours[Math.floor(random() * neighbours.length)]!;
      maze[(y + ny) / 2]![(x + nx) / 2] = MAZE_PATH;
      maze[ny]![nx] = MAZE_PATH;
      stack.push([nx, ny]);
    }
  }
  return maze;
}

/** `generateMaze`: four sub-mazes, overlapped, with four gaps punched between
 * them.
 *
 * The stitching is what makes the result a different SIZE from the request, and
 * `labMazeSize` in `shared/strategy/dnet/rates.ts` is the same arithmetic on the
 * strategy side — a walker aims at the corner this function actually produces.
 * The four gaps are what make the halves reachable from each other at all. */
export function generateMaze(width: number, height: number, random: () => number): string[] {
  if (width < MULTI_MAZE_THRESHOLD) return mazeMaker(width, height, random).map((row) => row.join(""));

  const halfWidth = Math.ceil(width / 2);
  const halfHeight = Math.ceil(height / 2);
  const maze1 = mazeMaker(halfWidth, halfHeight, random);
  const maze2 = mazeMaker(halfWidth, halfHeight, random);
  const maze3 = mazeMaker(halfWidth, halfHeight, random);
  const maze4 = mazeMaker(halfWidth, halfHeight, random);

  const top = maze1.map((row, y) => row.slice(0, -1).concat(maze2[y]!));
  const bottom = maze3.map((row, y) => row.slice(0, -1).concat(maze4[y]!));
  const result = top.slice(0, -1).concat(bottom);

  const subWidth = maze1[0]!.length - 1;
  const subHeight = maze1.length - 1;

  const topGap = Math.floor((random() * halfWidth) / 4) * 2 + 1;
  if (result[topGap]) result[topGap]![subWidth] = MAZE_PATH;
  const leftGap = Math.floor((random() * halfHeight) / 4) * 2 + 1;
  if (result[subHeight]) result[subHeight]![leftGap] = MAZE_PATH;
  const bottomGap = (Math.floor((random() * halfWidth) / 4) + 1) * 2;
  // Indexed off the REQUESTED height rather than the produced one, which is
  // upstream's own arithmetic and can miss the array entirely on a small maze.
  // Guarded rather than corrected: a fix here would be a different maze from
  // the one the game builds.
  if (result[height - bottomGap - 1]) result[height - bottomGap - 1]![subWidth] = MAZE_PATH;
  const rightGap = (Math.floor((random() * halfHeight) / 4) + 1) * 2;
  if (result[subHeight]) result[subHeight]![width - rightGap - 1] = MAZE_PATH;

  return result.map((row) => row.join(""));
}

/** `getSurroundingsVisualized`. Rows run `y - range .. y + range`, columns the
 * same in x, and anything off the edge of the maze renders as PATH — which is a
 * lie the walker cannot act on, because the wall test is done against the maze
 * and not against the render.
 *
 * Upstream destructures the endpoint as `[endpointY, endpointX]` and then
 * compares `i === endpointX && j === endpointY`, which swaps the axes twice and
 * so happens to be right. Transcribed as written. */
export function surroundingsVisualized(
  maze: readonly string[],
  x: number,
  y: number,
  range = 1,
  showPlayer = false,
  showEnd = false,
  endpoint?: readonly [number, number],
): string {
  const [endpointY, endpointX] = endpoint ?? [(maze[0]?.length ?? 2) - 2, maze.length - 2];
  const rows: string[] = [];
  for (let i = y - range; i <= y + range; i++) {
    let row = "";
    for (let j = x - range; j <= x + range; j++) {
      if (i === y && j === x && showPlayer) {
        row += "@";
        continue;
      }
      if (i === endpointX && j === endpointY && showEnd) {
        row += "X";
        continue;
      }
      row += maze[i]?.[j] ?? MAZE_PATH;
    }
    rows.push(row);
  }
  return rows.join("\n");
}

/** `getDirectionFromInput`: split on spaces, take the first token that parses.
 *
 * So `"north"`, `"n"`, `"up"` and `"go north"` are all the same move, and
 * anything else is `[0, 0]` — which the handler answers with *"You don't know
 * how to do that"* rather than a wall. */
export function directionFromInput(input: string): [number, number] {
  for (const word of input.split(" ")) {
    const found = ordinal(word);
    if (found) return [found[0], found[1]];
  }
  return [0, 0];
}

function ordinal(input: string): readonly [number, number] | undefined {
  const word = input.toLowerCase().trim();
  if (["n", "north", "up"].includes(word)) return NORTH;
  if (["e", "east", "right"].includes(word)) return EAST;
  if (["s", "south", "down"].includes(word)) return SOUTH;
  if (["w", "west", "left"].includes(word)) return WEST;
  return undefined;
}
