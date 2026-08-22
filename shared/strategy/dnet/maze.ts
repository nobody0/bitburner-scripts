/** Walking the labyrinth, as a pure function of what has been seen.
 *
 * The labyrinth is the one darknet "model" that is not a password. There is no
 * `move()` call: **the lab host's password field IS the direction**, so
 * `authenticate(lab, "north")` steps one cell, and a wrong turn comes back as an
 * ordinary `AuthFailure` carrying the surroundings. Attempting the lab's actual
 * password is refused on purpose — *"the best way to beat a maze is to find the
 * end, and not to try and skip it."*
 *
 * Three properties of the engine shape everything here.
 *
 * **Vision is free, and it arrives with the move.** Every response — success,
 * wall, or step — carries a radius-1 render of the surroundings in `data`, and
 * the new coordinates in `message` (`labyrinth.ts:308-330`). So the walker never
 * needs `heartbleed`, and it never needs `labradar` either: the radius-3 look is
 * the same information for a full authentication time. This is the only model in
 * the feature whose feedback comes back through `authenticate`'s own return
 * value.
 *
 * **A step is TWO cells, and the wall is the one between.** `newLocation` is
 * `[x + dx*2, y + dy*2]` while the wall test reads `[x + dx, y + dy]`, so the
 * maze is the usual grid-with-walls: every position we can stand on has odd
 * coordinates, and the even ones between them are wall slots.
 *
 * **Position is keyed by PID.** `DarknetState.labLocations[pid]` means one
 * process must walk an entire maze — a dead PID abandons its progress and the
 * next one is re-seeded at a randomly offset start. That is why the walker is
 * the one job in this feature that must never `spawn`, and why its host is worth
 * a stasis link. None of that is this file's problem; this file is the part that
 * can be tested without a game.
 *
 * Source: ../bitburner-src at 3162fd2590e221eadd0c0fbd46151913f7c4c41c
 *   src/DarkNet/effects/labyrinth.ts:17-20 (the direction vectors), :185-215
 *   (the render), :236-330 (the move handler), :364-382 (maze and endpoint) */

/** Upstream's four, in the words its parser accepts (`labyrinth.ts:348-361`).
 * The single words are used rather than `"go north"`: `getDirectionFromInput`
 * splits on spaces and takes the first token that parses, so the extra word buys
 * nothing and would only be one more thing to get wrong. */
export const DIRECTIONS = ["north", "east", "south", "west"] as const;
export type Direction = (typeof DIRECTIONS)[number];

/** `NORTH = [0, -1]`, `EAST = [1, 0]`, `SOUTH = [0, 1]`, `WEST = [-1, 0]`.
 * y grows DOWNWARD, which is why north is negative. */
const STEP: Record<Direction, readonly [number, number]> = {
  north: [0, -1],
  east: [1, 0],
  south: [0, 1],
  west: [-1, 0],
};

/** `const PATH = " "` (`labyrinth.ts:23`). Anything else in the render is wall,
 * except the two overlays: `"@"` marks us and `"X"` marks the exit. */
const PATH = " ";
const PLAYER = "@";
const EXIT = "X";

export type Cell = readonly [number, number];

/** What the walker has learned. Plain JSON so it can ride in a job's state.
 *
 * Keyed by string rather than by tuple because a `Map` with array keys compares
 * by identity, which would silently never hit. */
export interface MazeKnowledge {
  /** `"x,y"` of every position stood on. */
  visited: string[];
  /** `"x,y>direction"` -> whether that step is passable. */
  edges: Record<string, boolean>;
  /** The route back, as the positions we stepped from. Popped when a dead end
   *  forces a retreat, which is what makes this a depth-first search rather than
   *  a random walk that revisits forever. */
  trail: string[];
  /** The exit, once a render has actually shown it. */
  exit?: string;
}

export function emptyMaze(): MazeKnowledge {
  return { visited: [], edges: {}, trail: [] };
}

export const key = (at: Cell): string => `${at[0]},${at[1]}`;
const parse = (k: string): Cell => {
  const [x, y] = k.split(",");
  return [Number(x), Number(y)];
};
const edgeKey = (at: Cell, direction: Direction): string => `${key(at)}>${direction}`;

/** Where a step in `direction` lands. Two cells, per the move handler. */
export function ahead(at: Cell, direction: Direction): Cell {
  const [dx, dy] = STEP[direction];
  return [at[0] + dx * 2, at[1] + dy * 2];
}

/** Read the radius-1 render into the four walls around us.
 *
 * Rows run `y-1 .. y+1` and columns `x-1 .. x+1`, so the wall slots are the four
 * edge-midpoints of a 3x3 block: north is row 0 column 1, east is row 1 column
 * 2, and so on (`labyrinth.ts:219-226` reads exactly these indices).
 *
 * Returns undefined for a render that is not 3x3 — a grammar change should stop
 * the walker rather than send it into a wall repeatedly.
 *
 * EXACTLY three rows, not "at least three". The indices below are absolute, so
 * a wider render -- `labradar`'s radius-3 look, which `readExit` right below
 * this deliberately does handle -- would be read from its TOP-LEFT corner
 * instead of its centre and answer with a neighbouring cell's walls. That is
 * not a degraded reading, it is a confident wrong one, and `stepMaze` would
 * then choose a direction the engine refuses.
 */
export function readSurroundings(render: string): Record<Direction, boolean> | undefined {
  const rows = render.split("\n");
  if (rows.length !== 3) return undefined;
  const at = (row: number, col: number): string | undefined => rows[row]?.[col];
  const open = (row: number, col: number): boolean => {
    const char = at(row, col);
    // The exit overlay sits ON a path square, so it is passable. The player
    // overlay only ever appears at the centre, never in a wall slot.
    return char === PATH || char === EXIT || char === PLAYER;
  };
  if (rows[0]!.length < 3 || rows[1]!.length < 3 || rows[2]!.length < 3) return undefined;
  return { north: open(0, 1), east: open(1, 2), south: open(2, 1), west: open(1, 0) };
}

/** The exit's position, if this render happens to show it.
 *
 * The move handler renders with `showEnd = false`, so in practice this never
 * fires and the walker finds the exit by standing on it. It is here because
 * `labradar` renders with the overlay, so a walker that ever pays for one should
 * get the free information out of it rather than throw it away. */
export function readExit(render: string, at: Cell): Cell | undefined {
  const rows = render.split("\n");
  const radius = Math.floor(rows.length / 2);
  for (let row = 0; row < rows.length; row++) {
    const col = rows[row]!.indexOf(EXIT);
    if (col === -1) continue;
    return [at[0] - radius + col, at[1] - radius + row];
  }
  return undefined;
}

/** Record that a step we believed open was REFUSED.
 *
 * The engine answers a blocked move by leaving the position unchanged, and the
 * render that made us choose that direction has not changed either -- so without
 * this the next call reaches the identical decision and the walker bumps the
 * same wall until its host dies. `stepMaze` reads it back through `edges`. */
export function markBlocked(known: MazeKnowledge, at: Cell, direction: Direction): MazeKnowledge {
  return { ...known, edges: { ...known.edges, [edgeKey(at, direction)]: false } };
}

export type MazeStep =
  | { kind: "go"; direction: Direction; known: MazeKnowledge; note: string }
  /** Every reachable cell has been stood on and none of them was the exit. That
   *  is not a maze we failed to solve; it is a maze whose exit we cannot reach,
   *  which means our model of it is wrong. */
  | { kind: "exhausted"; reason: string }
  | { kind: "blind"; reason: string };

/** Where the exit is expected, from the maze's own dimensions.
 *
 * `labEndpoint` is `[width - 2 - offsetX, height - 2 - offsetY]` with each offset
 * a random 0, 2 or 4 (`labyrinth.ts:364-382`). So the exit is not known exactly,
 * but it is always within four cells of the bottom-right corner — which is
 * plenty to aim at. Aiming matters: these mazes reach 60x40, and a search that
 * spread out evenly would walk thousands of cells before reaching the far
 * corner. */
export function expectedExit(width: number, height: number): Cell {
  return [width - 2, height - 2];
}

const manhattan = (a: Cell, b: Cell): number => Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]);

/** Choose the next move.
 *
 * A depth-first search over an unknown graph, biased toward the corner the exit
 * sits in. Unvisited neighbours first, nearest-to-the-exit among them; when a
 * position has none, retreat along the trail. Depth-first rather than
 * breadth-first for a mechanical reason, not a stylistic one: we cannot teleport
 * to a frontier cell, every "jump" would have to be walked back through the
 * maze, and each step costs a full authentication. Retreating one cell at a time
 * along a trail we already know is the cheap version of that.
 *
 * Deterministic given the same knowledge, so a resumed walk continues rather
 * than wandering. */
export function stepMaze(
  known: MazeKnowledge,
  at: Cell,
  surroundings: string,
  bounds?: { width: number; height: number },
): MazeStep {
  const walls = readSurroundings(surroundings);
  if (!walls) {
    return { kind: "blind", reason: `surroundings ${JSON.stringify(surroundings.slice(0, 40))} are not a 3x3 render` };
  }

  const here = key(at);
  const visited = known.visited.includes(here) ? known.visited : [...known.visited, here];
  const edges = { ...known.edges };
  for (const direction of DIRECTIONS) {
    // A recorded refusal OUTRANKS the render, and this is the only thing that
    // stops a bump repeating for ever: the render is what we chose on, so if the
    // engine disagreed with it, choosing on the render again picks the same
    // direction, and the same one after that. `markBlocked` is how the walker
    // writes that disagreement down; here is where it is honoured, which is what
    // makes `edges` load-bearing rather than a map nobody consults.
    if (known.edges[edgeKey(at, direction)] === false) walls[direction] = false;
    edges[edgeKey(at, direction)] = walls[direction];
  }

  const seenExit = readExit(surroundings, at);
  const exit = known.exit ?? (seenExit ? key(seenExit) : undefined);
  const aim: Cell = exit !== undefined
    ? parse(exit)
    : bounds
      ? expectedExit(bounds.width, bounds.height)
      : [at[0] + 1, at[1] + 1];

  // Unvisited, passable, nearest the corner.
  const options = DIRECTIONS
    .filter((direction) => walls[direction])
    .map((direction) => ({ direction, to: ahead(at, direction) }))
    .filter((option) => !visited.includes(key(option.to)))
    .sort((a, b) => manhattan(a.to, aim) - manhattan(b.to, aim)
      || DIRECTIONS.indexOf(a.direction) - DIRECTIONS.indexOf(b.direction));

  if (options.length > 0) {
    const chosen = options[0]!;
    return {
      kind: "go",
      direction: chosen.direction,
      known: { visited, edges, trail: [...known.trail, here], ...(exit !== undefined ? { exit } : {}) },
      note: `${chosen.direction} into new ground`,
    };
  }

  // Dead end: walk back the way we came.
  const trail = [...known.trail];
  while (trail.length > 0) {
    const back = trail.pop()!;
    const target = parse(back);
    const direction = DIRECTIONS.find((d) => key(ahead(at, d)) === back);
    if (direction !== undefined && walls[direction]) {
      return {
        kind: "go",
        direction,
        known: { visited, edges, trail, ...(exit !== undefined ? { exit } : {}) },
        note: `back ${direction} toward ${back}`,
      };
    }
    // The trail entry is not adjacent — we have already retreated past it — so
    // keep popping. `at` only ever moves one cell per call, so this converges.
    if (direction === undefined && key(target) === here) continue;
  }

  return {
    kind: "exhausted",
    reason: `every route from ${here} has been walked (${visited.length} cells) without reaching the exit`,
  };
}

/** The coordinates out of `"You have moved to X,Y."` / `"You are still at X,Y."`.
 *
 * Both phrasings appear — a successful step reports the new position, a refused
 * one reports the unchanged position — and both are equally useful, because what
 * the walker needs is where it IS. Parsing them rather than tracking position
 * ourselves means a desync with the engine is impossible. */
export function readCoords(message: string): Cell | undefined {
  const found = message.match(/(?:moved to|still at)\s+(\d+)\s*,\s*(\d+)/i);
  if (!found) return undefined;
  return [Number(found[1]), Number(found[2])];
}
