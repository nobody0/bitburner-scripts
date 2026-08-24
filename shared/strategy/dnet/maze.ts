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
 * needs `heartbleed`, and radius-1 information alone is enough to finish.
 * `labradar` reveals more (radius 3 and the exit overlay) but costs another
 * full authentication and earns no charisma, so the deployed planner — the
 * second half of this file — pays for one only when a single render decides
 * the exit or scouts several seam-door candidates at once. This is the only
 * model in the feature whose feedback comes back through `authenticate`'s own
 * return value.
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
 * ## Two walkers
 *
 * `stepMaze` is the original corner-biased DFS. It is no longer deployed and is
 * kept for one job: it is the BASELINE the paired benchmark measures against
 * (`sim/dnet-lab.ts`'s `biasedDfsRoute`), which is what makes the improvement
 * below a number anyone can re-check rather than a claim in a comment. It costs
 * the game nothing to keep here — no game file imports it, so esbuild shakes it
 * out of the built artifact entirely, which is checkable by grepping
 * `build/dnet/controller.*.js` for one of its note strings.
 *
 * `decideLab` is what `game/dnet/orders.ts` actually walks with. It folds every
 * render into a wall-slot field, adds everything the generator's arithmetic
 * fixes before the first move (`labPrior`), and replans with A* each step —
 * ~0.65x the DFS's wall-clock over the whole ladder, and it never pays an
 * authentication to bump a wall.
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
 * The move handler renders with `showEnd = false`, so the free render that
 * arrives with every move never carries the overlay — a walker relying on those
 * alone finds the exit by standing on it. `labradar` DOES render it, which is
 * most of why the planner pays for one: `observeLab` calls this on every render
 * it folds in, so a radar that catches the exit settles the question outright
 * rather than merely narrowing it. */
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
function expectedExit(width: number, height: number): Cell {
  return [width - 2, height - 2];
}

const manhattan = (a: Cell, b: Cell): number => Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]);

/** Choose the next move — THE RETIRED WALKER, kept as the benchmark baseline.
 * `decideLab` is what the game runs; see this file's header.
 *
 * A depth-first search over an unknown graph, biased toward the corner the exit
 * sits in. Unvisited neighbours first, nearest-to-the-exit among them; when a
 * position has none, retreat along the trail. Depth-first rather than
 * breadth-first for a mechanical reason, not a stylistic one: we cannot teleport
 * to a frontier cell, every "jump" would have to be walked back through the
 * maze, and each step costs a full authentication. Retreating one cell at a time
 * along a trail we already know is the cheap version of that.
 *
 * What it cannot do, and what the planner that replaced it does: it knows
 * nothing the render has not shown it, so it walks into the seams hoping for a
 * door, re-treads corridors a proof could have ruled out, and pays an
 * authentication every time the engine disagrees with a render it acted on.
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

/* ---------------------------------------------------------------------------
 * The planning walker.
 *
 * The DFS above needs nothing but the last render. This walker instead exploits
 * everything `generateMaze` fixes in advance (`labyrinth.ts:112-186`):
 *
 * - **Four quadrants, each a spanning tree PLUS one extra edge at its own
 *   top-left cell.** `mazeMaker` is an iterative-backtracking carve, so each
 *   sub-maze is a spanning tree over its standing cells (every odd/odd cell is
 *   floor) — except that upstream never marks the carve's start `[1,1]` as
 *   visited, so the wave later carves INTO it once more (sometimes re-opening
 *   a wall that was already open). Each quadrant therefore carries AT MOST one
 *   cycle, and its closing edge is incident to the quadrant's local start
 *   cell. Two cells of one quadrant already connected by known-open
 *   edges can be joined by another edge only if that edge touches the
 *   quadrant's start and the quadrant's cycle has not been seen yet; every
 *   other unknown wall slot between connected cells is provably wall.
 *   `sim/tests/dnet-maze.test.ts` proves the property against the transcribed
 *   generator.
 * - **The seams are wall except four punched doors, and the candidate slots
 *   are computable.** The stitch leaves a solid wall column and row between the
 *   quadrants, then punches one gap per half-seam at
 *   `floor(random * half / 4) * 2 + 1` (top/left) or
 *   `size - (floor(random * half / 4) + 1) * 2 - 1` (bottom/right, indexed off
 *   the REQUESTED dimensions rather than the produced ones). Every other seam
 *   slot is wall before a single move is made, and on every real rung the four
 *   candidate sets are disjoint — so the first door found in a set closes the
 *   rest of that set.
 * - **The exit is one of at most nine known cells.** `[width-2-ox, height-2-oy]`
 *   with each offset 0, 2 or 4 on the deep labs and exactly 0 on the shallow
 *   ones. Standing on a candidate without winning rules it out, and one
 *   `labradar` — radius 3, exit overlay ON — either pinpoints the exit or rules
 *   out every candidate inside its window.
 *
 * The decision itself is repeated A* over everything known: known-open edges
 * cost one authentication, provably-walled edges are impassable, and unknown
 * edges cost `unknownCost` — an empirically tuned estimate of what walking into
 * unmapped ground really costs (~54% of a perfect maze's slots are open). The
 * first edge of any plan is always already known, because every response's free
 * radius-1 render reveals all four adjacent slots BEFORE the next choice — so
 * unlike the DFS this walker never pays an authentication to bump a wall.
 * ------------------------------------------------------------------------- */

/** The stage facts the planner exploits. A subset of `LabStage` so tests can
 * hand in tiny synthetic stages. */
export interface LabStageShape {
  mazeWidth: number;
  mazeHeight: number;
  offsetStartAndEnd: boolean;
}

/** Everything true of the maze before the first move, derived purely from the
 * generator's arithmetic. Not serialized — cheap to rebuild from the stage. */
export interface LabPrior {
  /** PRODUCED dimensions (the stitched maze, not the request). */
  width: number;
  height: number;
  /** The wall column and row between the quadrants. Undefined below the
   *  stitching threshold (only synthetic test stages are that small). */
  seamX?: number;
  seamY?: number;
  /** The four punched doors' candidate slots, one set per draw. Every seam
   *  slot in none of these sets is wall. */
  doorSets: readonly (readonly string[])[];
  /** Per set, whether "one open member closes the rest" is sound — true only
   *  when the set overlaps no other set, which holds on every real rung. */
  doorSetExclusive: readonly boolean[];
  /** `"x,y"` -> index into `doorSets`. */
  doorIndex: Record<string, number>;
  /** Where the exit can be. One entry on the shallow labs, nine on the deep. */
  exitCandidates: readonly string[];
}

/** Upstream rounds each sub-maze UP to odd; the halves then overlap by one. */
const oddUp = (value: number): number => (value % 2 === 0 ? value + 1 : value);

/** `Math.floor(random() * half / 4)` draws 0..this, inclusive. */
const maxGapDraw = (half: number): number => Math.floor((half - 1) / 4);

/** Same threshold as upstream's `MULTI_MAZE_THRESHOLD`: below it the maze is a
 * single un-stitched carve. No real lab is below it. */
const STITCH_THRESHOLD = 5;

export function labPrior(stage: LabStageShape): LabPrior {
  const stitched = stage.mazeWidth >= STITCH_THRESHOLD;
  const width = stitched ? 2 * oddUp(Math.ceil(stage.mazeWidth / 2)) - 1 : oddUp(stage.mazeWidth);
  const height = stitched ? 2 * oddUp(Math.ceil(stage.mazeHeight / 2)) - 1 : oddUp(stage.mazeHeight);

  const offsets = stage.offsetStartAndEnd ? [0, 2, 4] : [0];
  const exitCandidates = offsets.flatMap((oy) => offsets.map((ox) => key([width - 2 - ox, height - 2 - oy])));

  if (!stitched) return { width, height, doorSets: [], doorSetExclusive: [], doorIndex: {}, exitCandidates };

  const seamX = oddUp(Math.ceil(stage.mazeWidth / 2)) - 1;
  const seamY = oddUp(Math.ceil(stage.mazeHeight / 2)) - 1;
  const draws = (half: number): number[] => Array.from({ length: maxGapDraw(half) + 1 }, (_, v) => v);
  // A slot must sit strictly inside the maze and between two standing cells.
  // The bottom/right formulas can miss both on odd requested sizes — upstream
  // guards the write, which means such a draw punches NO door at all.
  const slot = (x: number, y: number): string | undefined =>
    x > 0 && x < width - 1 && y > 0 && y < height - 1 && (x % 2) + (y % 2) === 1 ? key([x, y]) : undefined;
  const present = (candidates: (string | undefined)[]): string[] =>
    candidates.filter((held): held is string => held !== undefined);
  const doorSets: string[][] = [
    present(draws(Math.ceil(stage.mazeWidth / 2)).map((v) => slot(seamX, 2 * v + 1))),
    present(draws(Math.ceil(stage.mazeWidth / 2)).map((v) => slot(seamX, stage.mazeHeight - 2 * (v + 1) - 1))),
    present(draws(Math.ceil(stage.mazeHeight / 2)).map((v) => slot(2 * v + 1, seamY))),
    present(draws(Math.ceil(stage.mazeHeight / 2)).map((v) => slot(stage.mazeWidth - 2 * (v + 1) - 1, seamY))),
  ];
  const doorIndex: Record<string, number> = {};
  const shared = new Set<string>();
  for (let set = 0; set < doorSets.length; set++) {
    for (const held of doorSets[set]!) {
      if (held in doorIndex) shared.add(held);
      doorIndex[held] = set;
    }
  }
  const doorSetExclusive = doorSets.map((set) => set.every((held) => !shared.has(held)));
  return { width, height, seamX, seamY, doorSets, doorSetExclusive, doorIndex, exitCandidates };
}

/** What the planner has learned. Plain JSON so it can ride in a job's state.
 * Keyed by WALL SLOT rather than by cell-and-direction: the slot is the thing
 * the engine actually tests, and one entry serves both of its sides. */
export interface LabField {
  /** `"x,y"` of a wall slot -> true when open, false when wall. */
  slots: Record<string, boolean>;
  /** Exit candidates disproved — stood on without winning, or inside a radar
   *  window that did not show the exit. */
  ruledOut: string[];
  /** Positions a radar has been paid for, so one vantage never pays twice. */
  radared: string[];
  /** The exit, once a radar has shown it or eliminated everything else. */
  exit?: string;
}

export function emptyField(): LabField {
  return { slots: {}, ruledOut: [], radared: [] };
}

/** Fold one render — the free radius-1 view or a paid radius-3 radar — into
 * the field. Returns undefined for a render that is not a centred odd square,
 * which should stop the walker rather than teach it lies.
 *
 * Two truths about the render shape this depends on:
 * - Anything off the edge of the maze renders as PATH (`labyrinth.ts:209`), so
 *   out-of-bounds window cells are SKIPPED rather than believed.
 * - The `@` and `X` overlays only ever sit on standing cells, so every slot
 *   character is honestly ` ` or wall.
 *
 * A radar whose window does NOT contain the exit overlay rules out every
 * candidate the window covers — the negative reading is as good as the
 * positive one, and eliminating all but one candidate names the exit. */
export function observeLab(field: LabField, at: Cell, render: string, prior: LabPrior): LabField | undefined {
  const rows = render.split("\n");
  const radius = Math.floor(rows.length / 2);
  if (rows.length < 3 || rows.length % 2 === 0) return undefined;
  const slots = { ...field.slots };
  for (let row = 0; row < rows.length; row++) {
    const line = rows[row]!;
    if (line.length < rows.length) return undefined;
    for (let col = 0; col < rows.length; col++) {
      const x = at[0] - radius + col;
      const y = at[1] - radius + row;
      if (x <= 0 || y <= 0 || x >= prior.width - 1 || y >= prior.height - 1) continue;
      if ((x % 2) + (y % 2) !== 1) continue;
      slots[key([x, y])] = line[col] === PATH;
    }
  }
  const shown = readExit(render, at);
  let exit = field.exit ?? (shown ? key(shown) : undefined);
  let ruledOut = field.ruledOut;
  if (exit === undefined && radius > 1) {
    const covered = prior.exitCandidates.filter((held) => {
      const [cx, cy] = parse(held);
      return Math.abs(cx - at[0]) <= radius && Math.abs(cy - at[1]) <= radius && !ruledOut.includes(held);
    });
    if (covered.length > 0) ruledOut = [...ruledOut, ...covered];
  }
  if (exit === undefined) {
    const remaining = prior.exitCandidates.filter((held) => !ruledOut.includes(held));
    if (remaining.length === 1) exit = remaining[0]!;
  }
  return { slots, ruledOut, radared: field.radared, ...(exit !== undefined ? { exit } : {}) };
}

/** Record that a step the walker believed open was REFUSED by the engine.
 * With the prior in place this should never fire — the border is pre-walled and
 * the first edge of every plan is already known open — but a real game that
 * disagrees with our model must be written down, or the identical decision
 * repeats forever. */
export function refuseEdge(field: LabField, at: Cell, direction: Direction): LabField {
  const [dx, dy] = STEP[direction];
  return { ...field, slots: { ...field.slots, [key([at[0] + dx, at[1] + dy])]: false } };
}

/** Which macro-route through the four quadrants a walker commits to.
 *
 * The exit's quadrant is reachable through exactly two door pairs: the
 * "eastern" route crosses the vertical seam's TOP door and the horizontal
 * seam's RIGHT door, the "southern" route crosses the LEFT door and then the
 * vertical seam's BOTTOM door. A lone walker plans over both ("any"); a SECOND
 * walker sharing the same field is worth most when it commits to the route the
 * first one is not on, instead of shadowing it. */
export type LabRouteBias = "any" | "eastern" | "southern";

/** Shape a prior to one macro-route by treating the OTHER route's still-unknown
 * door candidates as wall.
 *
 * Sound and self-healing: `planStep` consults the shared field BEFORE the
 * prior, so a door the other walker has actually seen open is used no matter
 * what this bias says — the bias only stops the walker from HOPING its way
 * through doors it was told to leave to someone else. Should the bias ever
 * make a maze unroutable (it cannot on a real rung: the property test proves
 * every set holds a door), the caller falls back to the unbiased prior. */
export function routePrior(prior: LabPrior, bias: LabRouteBias): LabPrior {
  if (bias === "any" || prior.seamX === undefined) return prior;
  // Door set order is fixed by `labPrior`: 0 top, 1 bottom, 2 left, 3 right.
  const hidden = bias === "eastern" ? [1, 2] : [0, 3];
  return {
    ...prior,
    doorSets: prior.doorSets.map((set, index) => (hidden.includes(index) ? [] : set)),
    doorIndex: Object.fromEntries(
      Object.entries(prior.doorIndex).filter(([, set]) => !hidden.includes(set)),
    ),
  };
}

/** Fold one walker's field into another's. Everything in a field is an
 * observed fact or a proof, so a merge is a union: slots (the newer walker's
 * reading wins a disagreement, though honest fields never disagree), disproved
 * exit candidates, spent radar vantages, and the exit itself from whichever
 * side has it. This is what lets two PID-bound walkers in ONE maze act as one
 * mapper: each folds the shared field in before deciding, and publishes its
 * own after observing. */
export function mergeLabFields(base: LabField, extra: LabField | undefined): LabField {
  if (extra === undefined) return base;
  const ruledOut = [...base.ruledOut];
  for (const held of extra.ruledOut) if (!ruledOut.includes(held)) ruledOut.push(held);
  const radared = [...base.radared];
  for (const held of extra.radared) if (!radared.includes(held)) radared.push(held);
  const exit = base.exit ?? extra.exit;
  return {
    slots: { ...base.slots, ...extra.slots },
    ruledOut,
    radared,
    ...(exit !== undefined ? { exit } : {}),
  };
}

/** The planner's two dials, with the values the paired benchmark in
 * `sim/tests/dnet-lab-benchmark.test.ts` (and the sweep in
 * `tools/dnet-lab-benchmark.ts`) settled on. */
export interface LabTuning {
  /** What an UNKNOWN edge is priced at, against 1 for a known-open one. Above
   *  1 because roughly half of a perfect maze's slots are wall, so unmapped
   *  ground costs more than the map says. */
  unknownCost: number;
  /** Pay for a speculative radar when its window covers at least this many
   *  live exit candidates. A DECISIVE radar — one whose window covers all, or
   *  all but one, of the remaining candidates, so its answer names the exit
   *  either way — always fires regardless of this dial. Infinity (the tuned
   *  default) allows only the decisive one, which the sweep found strictly
   *  better than paying for partial eliminations. */
  radarMinCover: number;
  /** Pay for a door-scouting radar when the window covers at least this many
   *  UNKNOWN door-candidate slots of a seam whose door has not been found.
   *  Infinity disables the scout. */
  radarDoorCover: number;
}

export const LAB_TUNING: LabTuning = { unknownCost: 2.5, radarMinCover: Infinity, radarDoorCover: 3 };

/** The probe that opens every walk. The position is unknown until the first
 * response, so the first move is blind either way — but where the DFS probed
 * north (a guaranteed wall from the top row), a probe TOWARD the exit's corner
 * is a free step in the right direction whenever it happens to land, and the
 * paired benchmark prefers east to south. */
export const LAB_FIRST_PROBE: Direction = "east";

export type LabPlan =
  | {
    kind: "move";
    direction: Direction;
    field: LabField;
    note: string;
    /** The A* cost of the whole plan this move opens, in authentications — the
     *  planner's own honest estimate of what is left, priced with unknown
     *  ground at `unknownCost`. Published as the walk's progress readout: it is
     *  the only forward-looking number in the walk that is not a guess pulled
     *  from a benchmark average. */
    believedCost: number;
  }
  | { kind: "radar"; field: LabField; note: string }
  | { kind: "lost"; reason: string };

/** Choose the next paid action: a move, or a radar.
 *
 * Deterministic given the same field, so a resumed walk continues rather than
 * wandering. Must be called only after `observeLab` has folded in a render
 * centred on `at` — that is what guarantees the first edge of the plan is
 * already known open. */
export function decideLab(field: LabField, at: Cell, prior: LabPrior, tuning: LabTuning = LAB_TUNING): LabPlan {
  const here = key(at);
  // Standing here while still being asked to decide proves this is not the exit.
  let ruledOut = field.ruledOut;
  if (field.exit === undefined && prior.exitCandidates.includes(here) && !ruledOut.includes(here)) {
    ruledOut = [...ruledOut, here];
  }
  const remaining = prior.exitCandidates.filter((held) => !ruledOut.includes(held));
  const exit = field.exit ?? (remaining.length === 1 ? remaining[0] : undefined);
  if (exit === undefined && remaining.length === 0) {
    return { kind: "lost", reason: `every exit candidate is ruled out at ${here}` };
  }

  // A radar either shows the exit or disproves every candidate it covers, so
  // covering all-but-one is as decisive as covering all.
  if (exit === undefined && remaining.length > 1 && !field.radared.includes(here)) {
    const covered = remaining.filter((held) => {
      const [cx, cy] = parse(held);
      return Math.abs(cx - at[0]) <= 3 && Math.abs(cy - at[1]) <= 3;
    });
    if (covered.length > 0 && (covered.length >= tuning.radarMinCover || covered.length >= remaining.length - 1)) {
      return {
        kind: "radar",
        field: { ...field, ruledOut, radared: [...field.radared, here] },
        note: `radar covers ${covered.length} of ${remaining.length} exit candidates`,
      };
    }
  }

  // A door-scouting radar, when enabled: reveal several still-unknown seam
  // door candidates in one authentication instead of crawling the seam.
  if (Number.isFinite(tuning.radarDoorCover) && !field.radared.includes(here)) {
    let doors = 0;
    for (const [slotKey, set] of Object.entries(prior.doorIndex)) {
      if (field.slots[slotKey] !== undefined) continue;
      if (prior.doorSetExclusive[set] === true
        && prior.doorSets[set]!.some((held) => field.slots[held] === true)) continue;
      const [sx, sy] = parse(slotKey);
      if (Math.abs(sx - at[0]) <= 3 && Math.abs(sy - at[1]) <= 3) doors++;
    }
    if (doors >= tuning.radarDoorCover) {
      return {
        kind: "radar",
        field: { ...field, ruledOut, radared: [...field.radared, here] },
        note: `radar scouts ${doors} door candidates`,
      };
    }
  }

  // Aim at the exit once it is known, and at every candidate that is still
  // live until then. Arriving at one either wins or disproves it, and the
  // decisive radar above fires from anywhere inside their corner — so there is
  // nothing to aim at but the candidates themselves.
  const targets = exit !== undefined ? [exit] : remaining;
  const step = planStep(field, at, prior, targets, tuning.unknownCost);
  if (step === undefined) {
    return { kind: "lost", reason: `no believable route from ${here} to ${targets.join(" or ")}` };
  }
  return {
    kind: "move",
    direction: step.direction,
    field: { ...field, ruledOut, ...(exit !== undefined ? { exit } : {}) },
    note: `${step.direction} toward ${step.target} (${step.cost.toFixed(1)} believed)`,
    believedCost: step.cost,
  };
}

/** The field as one character per grid cell, row-major — the whole discovered
 * maze in `width * height` characters.
 *
 * `?` unknown, `#` wall, `.` open. Standing cells (odd/odd) are always `.`
 * because the generator floors every one of them, and the border is always `#`.
 * A 61x41 maze is 2501 characters, which is what makes the map cheap enough to
 * publish every tick — the alternative, the `slots` record as JSON, is an order
 * of magnitude larger and says exactly the same thing.
 *
 * Deliberately NOT a picture: the caller decides how to draw it. This is the
 * one thing about a walk that `ui/` genuinely cannot derive, so it is the one
 * thing the digest carries. */
export function renderLabField(field: LabField, prior: LabPrior): string {
  const rows: string[] = [];
  for (let y = 0; y < prior.height; y++) {
    let row = "";
    for (let x = 0; x < prior.width; x++) {
      const parity = (x % 2) + (y % 2);
      // The border and the even/even pillars are wall by construction, and every
      // odd/odd cell is floor — the carve steps two at a time from [1,1]. Only
      // the odd/even wall SLOTS between them were ever in question.
      if (x === 0 || y === 0 || x === prior.width - 1 || y === prior.height - 1) row += "#";
      else if (parity === 0) row += "#";
      else if (parity === 2) row += ".";
      else {
        const held = field.slots[`${x},${y}`];
        row += held === undefined ? "?" : held ? "." : "#";
      }
    }
    rows.push(row);
  }
  return rows.join("");
}

/** Exit candidates a walk has not yet disproved. At most nine, so this travels
 * whole rather than as a count: the panel draws them, and "three left" reads
 * very differently from "these three". */
export function liveExitCandidates(field: LabField, prior: LabPrior): string[] {
  if (field.exit !== undefined) return [field.exit];
  return prior.exitCandidates.filter((held) => !field.ruledOut.includes(held));
}

/** A* from `at` to the cheapest target over everything known and inferable.
 *
 * Edge prices: known-open 1, known-wall impassable, unknown `unknownCost`.
 * Two exact inferences close edges the walker has never seen:
 * - a seam slot outside its door candidates is wall, and a door found in an
 *   exclusive set closes the rest of that set;
 * - an unknown slot between two cells of ONE quadrant already connected by
 *   known-open edges is wall, because each quadrant is a spanning tree plus at
 *   most one extra edge at the quadrant's own start cell — so the only such
 *   slot still licensed is one touching that start, until the cycle is seen.
 * The heuristic is manhattan-distance-in-moves, admissible because every move
 * costs at least 1 and covers two grid units. */
function planStep(
  field: LabField,
  at: Cell,
  prior: LabPrior,
  targets: readonly string[],
  unknownCost: number,
): { direction: Direction; target: string; cost: number } | undefined {
  const cols = (prior.width - 1) >> 1;
  const rows = (prior.height - 1) >> 1;
  const nodeCount = cols * rows;
  const nodeOf = (x: number, y: number): number => ((y - 1) >> 1) * cols + ((x - 1) >> 1);
  const cellOf = (node: number): Cell => [(node % cols) * 2 + 1, Math.floor(node / cols) * 2 + 1];

  // Union-find over known-open NON-SEAM edges: within a quadrant the maze is a
  // spanning tree plus AT MOST one extra edge at the quadrant's own top-left
  // cell, so connectivity proves the walls between already-joined corridors —
  // except for that one cycle edge, which is licensed until it has been seen.
  const parent = new Int32Array(nodeCount).fill(-1);
  const find = (node: number): number => {
    let root = node;
    while (parent[root]! >= 0) root = parent[root]!;
    while (parent[node]! >= 0) {
      const next = parent[node]!;
      parent[node] = root;
      node = next;
    }
    return root;
  };
  const onSeam = (x: number, y: number): boolean => x === prior.seamX || y === prior.seamY;
  const quadrantOf = (x: number, y: number): number =>
    (prior.seamX !== undefined && x > prior.seamX ? 1 : 0) + (prior.seamY !== undefined && y > prior.seamY ? 2 : 0);
  const quadrantStart = (quadrant: number): Cell => [
    (quadrant & 1) === 1 ? prior.seamX! + 1 : 1,
    (quadrant & 2) === 2 ? prior.seamY! + 1 : 1,
  ];
  const cycleSeen = [false, false, false, false];
  for (const [slotKey, open] of Object.entries(field.slots)) {
    if (!open) continue;
    const [sx, sy] = parse(slotKey);
    if (onSeam(sx, sy)) continue;
    const a = sx % 2 === 0 ? nodeOf(sx - 1, sy) : nodeOf(sx, sy - 1);
    const b = sx % 2 === 0 ? nodeOf(sx + 1, sy) : nodeOf(sx, sy + 1);
    const rootA = find(a);
    const rootB = find(b);
    if (rootA !== rootB) parent[rootA] = rootB;
    else cycleSeen[quadrantOf(sx, sy)] = true;
  }
  const touchesQuadrantStart = (sx: number, sy: number): boolean => {
    const [qx, qy] = quadrantStart(quadrantOf(sx, sy));
    return (sx === qx && (sy === qy - 1 || sy === qy + 1)) || (sy === qy && (sx === qx - 1 || sx === qx + 1));
  };
  // A door observed open in an exclusive candidate set closes the whole set.
  const doorFound = prior.doorSets.map((set, index) =>
    prior.doorSetExclusive[index] === true && set.some((held) => field.slots[held] === true));

  const price = (sx: number, sy: number): number => {
    if (sx <= 0 || sy <= 0 || sx >= prior.width - 1 || sy >= prior.height - 1) return Infinity;
    const held = field.slots[`${sx},${sy}`];
    if (held !== undefined) return held ? 1 : Infinity;
    if (onSeam(sx, sy)) {
      const set = prior.doorIndex[`${sx},${sy}`];
      if (set === undefined || doorFound[set] === true) return Infinity;
      return unknownCost;
    }
    const a = sx % 2 === 0 ? nodeOf(sx - 1, sy) : nodeOf(sx, sy - 1);
    const b = sx % 2 === 0 ? nodeOf(sx + 1, sy) : nodeOf(sx, sy + 1);
    if (find(a) === find(b)) {
      // Already connected: wall, unless this could still be the quadrant's one
      // cycle edge — incident to the quadrant's start, cycle not yet seen.
      if (cycleSeen[quadrantOf(sx, sy)] === true || !touchesQuadrantStart(sx, sy)) return Infinity;
      return unknownCost;
    }
    return unknownCost;
    // NOTE, so the next tuner does not re-dig this hole: a "degree inference"
    // (three provable walls around a cell force its fourth slot open, priced 1)
    // was implemented and swept — byte-identical results over 480 paired cases.
    // A radius-1 render reveals all four slots of every visited cell at once,
    // so the three-known-one-unknown situation never decides a real route.
  };

  const goals = targets.map(parse);
  const goalSet = new Set(targets);
  const heuristic = (x: number, y: number): number => {
    let best = Infinity;
    for (const [gx, gy] of goals) {
      const held = (Math.abs(x - gx) + Math.abs(y - gy)) / 2;
      if (held < best) best = held;
    }
    return best;
  };

  // Binary heap keyed on (f, insertion order): deterministic tie-breaks.
  const heapNode: number[] = [];
  const heapF: number[] = [];
  const heapSeq: number[] = [];
  let sequence = 0;
  const before = (i: number, j: number): boolean =>
    heapF[i]! < heapF[j]! || (heapF[i] === heapF[j] && heapSeq[i]! < heapSeq[j]!);
  const push = (node: number, f: number): void => {
    heapNode.push(node);
    heapF.push(f);
    heapSeq.push(sequence++);
    let child = heapNode.length - 1;
    while (child > 0) {
      const above = (child - 1) >> 1;
      if (!before(child, above)) break;
      swap(child, above);
      child = above;
    }
  };
  const swap = (i: number, j: number): void => {
    [heapNode[i], heapNode[j]] = [heapNode[j]!, heapNode[i]!];
    [heapF[i], heapF[j]] = [heapF[j]!, heapF[i]!];
    [heapSeq[i], heapSeq[j]] = [heapSeq[j]!, heapSeq[i]!];
  };
  const pop = (): number => {
    const top = heapNode[0]!;
    const last = heapNode.length - 1;
    swap(0, last);
    heapNode.pop();
    heapF.pop();
    heapSeq.pop();
    let above = 0;
    for (;;) {
      const left = above * 2 + 1;
      const right = left + 1;
      let smallest = above;
      if (left < heapNode.length && before(left, smallest)) smallest = left;
      if (right < heapNode.length && before(right, smallest)) smallest = right;
      if (smallest === above) break;
      swap(above, smallest);
      above = smallest;
    }
    return top;
  };

  const distance = new Float64Array(nodeCount).fill(Infinity);
  const cameBy = new Int8Array(nodeCount).fill(-1);
  const settled = new Uint8Array(nodeCount);
  const start = nodeOf(at[0], at[1]);
  distance[start] = 0;
  push(start, heuristic(at[0], at[1]));

  while (heapNode.length > 0) {
    const node = pop();
    if (settled[node] === 1) continue;
    settled[node] = 1;
    const [x, y] = cellOf(node);
    if (goalSet.has(`${x},${y}`) && node !== start) {
      // Walk the parents back to the first step out of `start`.
      let cursor = node;
      let firstDirection = cameBy[cursor]!;
      while (cursor !== start) {
        firstDirection = cameBy[cursor]!;
        const [dx, dy] = STEP[DIRECTIONS[firstDirection]!];
        const [cx, cy] = cellOf(cursor);
        cursor = nodeOf(cx - dx * 2, cy - dy * 2);
      }
      return { direction: DIRECTIONS[firstDirection]!, target: `${x},${y}`, cost: distance[node]! };
    }
    for (let index = 0; index < DIRECTIONS.length; index++) {
      const [dx, dy] = STEP[DIRECTIONS[index]!];
      const cost = price(x + dx, y + dy);
      if (cost === Infinity) continue;
      const nx = x + dx * 2;
      const ny = y + dy * 2;
      if (nx < 1 || ny < 1 || nx > prior.width - 2 || ny > prior.height - 2) continue;
      const next = nodeOf(nx, ny);
      const through = distance[node]! + cost;
      if (through >= distance[next]!) continue;
      distance[next] = through;
      cameBy[next] = index;
      push(next, through + heuristic(nx, ny));
    }
  }
  return undefined;
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
