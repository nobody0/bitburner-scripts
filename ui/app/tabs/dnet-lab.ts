import { esc } from "../lib/format.ts";
import { labPrior, type LabPrior } from "../../../shared/strategy/dnet/maze.ts";
import { labStage } from "../../../shared/strategy/dnet/rates.ts";
import type { DarknetLabDigest, DarknetLabWalker } from "../../../shared/telemetry/topics/dnet.ts";

/** The maze, drawn from the one fact about a lab the panel cannot derive.
 *
 * Everything else on the Labyrinth card follows from the hostname — `labStage`
 * gives the rung and the charisma gate, `labPrior` turns that into the produced
 * dimensions, the two seams, the door candidates and the nine exit candidates.
 * What no formula supplies is what the walkers have actually SEEN, and that
 * arrives as one character per grid cell (`DarknetLabDigest.grid`).
 *
 * Drawn as SVG for the same reason the net map is: it scales without a
 * re-render, and the whole thing is a string the tab can return.
 *
 * ## Why the grid is three nodes and not 2501 rects
 *
 * The largest rung is 61x41. A rect per cell would put two and a half thousand
 * nodes into a panel that re-renders every frame. Instead unknown is painted as
 * ONE background rect and the cells we do know are merged along each row into
 * runs, emitted as a single path per class — so the grid is three nodes at any
 * size, whatever else is overlaid on top of it. A maze is mostly long runs, so
 * the merge is worth an order of magnitude rather than a few percent.
 */

/** Cell classes, as `renderLabField` writes them. */
const UNKNOWN = "?";
const WALL = "#";

/** The four door draws, in `labPrior`'s order: the vertical seam's upper then
 * lower half, then the horizontal seam's left then right. Named so a mark can
 * say WHICH crossing it is — the four are not interchangeable, since each joins
 * a different pair of quadrants. */
const DOOR_SIDES = ["north", "south", "west", "east"] as const;

/** SVG units per grid cell. The viewBox is in these units and the element is
 * sized in CSS, so this fixes only the ratio between a cell and the strokes and
 * radii of the overlays drawn on it. */
const CELL = 4;

interface Run {
  x: number;
  y: number;
  length: number;
}

/** Merge each row's consecutive like cells into runs. */
function runsOf(grid: string, width: number, height: number, want: (char: string) => boolean): Run[] {
  const runs: Run[] = [];
  for (let y = 0; y < height; y++) {
    let start = -1;
    for (let x = 0; x <= width; x++) {
      const inRun = x < width && want(grid[y * width + x] ?? UNKNOWN);
      if (inRun && start === -1) start = x;
      else if (!inRun && start !== -1) {
        runs.push({ x: start, y, length: x - start });
        start = -1;
      }
    }
  }
  return runs;
}

const pathOf = (runs: readonly Run[]): string => runs
  .map((run) => `M${run.x * CELL} ${run.y * CELL}h${run.length * CELL}v${CELL}h${-run.length * CELL}z`)
  .join("");

const parse = (key: string): [number, number] | undefined => {
  const [x, y] = key.split(",").map(Number);
  return x === undefined || y === undefined || !Number.isFinite(x) || !Number.isFinite(y) ? undefined : [x, y];
};

/** The centre of a grid cell, in SVG units. */
const centre = (at: readonly [number, number]): [number, number] => [
  at[0] * CELL + CELL / 2,
  at[1] * CELL + CELL / 2,
];

/** How much of the maze has been mapped.
 *
 * Counted over WALL SLOTS only — the odd/even cells the generator actually
 * decides. The pillars and the border are wall by construction and the standing
 * cells are floor by construction, so counting them would start every walk at
 * 60% mapped and never reach a number that meant anything. */
export function labExplored(lab: DarknetLabDigest): { known: number; total: number; fraction: number } {
  let known = 0;
  let total = 0;
  for (let y = 1; y < lab.height - 1; y++) {
    for (let x = 1; x < lab.width - 1; x++) {
      if ((x % 2) + (y % 2) !== 1) continue;
      total++;
      if ((lab.grid[y * lab.width + x] ?? UNKNOWN) !== UNKNOWN) known++;
    }
  }
  return { known, total, fraction: total === 0 ? 0 : known / total };
}

/** How much the planner's own plan cost UNDER-states the walk still to come.
 *
 * `believedLeft` is the A* cost of the route the planner is currently
 * following, and that route is optimistic by construction: it prices unmapped
 * ground at a flat premium and then walks through it as though the walls it has
 * not seen are not there. Every wall it then discovers is a detour the estimate
 * did not contain.
 *
 * Measured rather than guessed. Over 10,276 mid-walk samples across all eight
 * rungs — the authentications a walk actually had left against the plan cost at
 * that moment — the ratio runs p25 0.97, MEDIAN 1.31, p75 1.81, and the plan is
 * optimistic in 72% of samples. So the raw number would read low almost three
 * times in four; multiplying by the median makes it read low about half the
 * time, which is what an estimate should do. The spread is real and the
 * tooltip on the tile says so. */
const PLAN_OPTIMISM = 1.3;

/** What this walker expects to have left, in milliseconds.
 *
 * Priced at its OWN measured pace rather than from any benchmark: threads,
 * charisma above the gate, The B00ts, SF15 and the backdoor tax all multiply
 * the authentication time, and a walk that times itself needs to know none of
 * them. Undefined until there is enough of a walk to divide by. */
export function walkerEtaMs(walker: DarknetLabWalker): number | undefined {
  if (walker.believedLeft === undefined) return undefined;
  const elapsed = walker.beatAt - walker.startedAt;
  if (elapsed <= 0 || walker.attempts <= 0) return undefined;
  return (walker.believedLeft * PLAN_OPTIMISM * elapsed) / walker.attempts;
}

/** The party's ETA: the SOONEST any walker expects to arrive.
 *
 * Whichever PID reaches the endpoint roots the lab for everyone, so the party
 * finishes when its luckiest member does — a max or a mean would both describe
 * a race nobody is running. */
export function labEtaMs(lab: DarknetLabDigest): number | undefined {
  const etas = lab.walkers.map(walkerEtaMs).filter((held): held is number => held !== undefined);
  return etas.length === 0 ? undefined : Math.min(...etas);
}

/** Everything the generator fixes about this rung before the first move.
 *
 * Derived here rather than published, which is the trade this whole module
 * exists to make: the digest carries what was SEEN and the panel works out what
 * was always true. Undefined for a lab hostname outside the ladder — a game
 * update, or a rename — and the maze then draws without its seams rather than
 * not at all. */
export function labPriorFor(lab: DarknetLabDigest): LabPrior | undefined {
  const stage = labStage(lab.host);
  return stage === undefined ? undefined : labPrior(stage);
}

/** The maze as SVG, or an empty string for a grid that does not match its own
 * dimensions — which is a shape change between a running controller and a rebuilt
 * panel, and is better drawn as nothing than as a maze read off the wrong
 * stride. The caller keys the legend off the same emptiness. */
export function labMaze(lab: DarknetLabDigest, prior?: LabPrior): string {
  const { width, height, grid } = lab;
  if (grid.length < width * height) return "";
  const walls = pathOf(runsOf(grid, width, height, (char) => char === WALL));
  const open = pathOf(runsOf(grid, width, height, (char) => char !== WALL && char !== UNKNOWN));

  // The two seams, faint. They are the reason the maze has a macro-structure at
  // all — four sub-mazes joined by four punched doors — and therefore the reason
  // the marks below matter: every seam slot outside a door set is wall before
  // the first move, so those four doors are the only ways between quadrants.
  // Nothing here says which walker takes which pair — the route bias is a
  // job-side decision (`routePrior`) and no walker entry carries it.
  const seams = prior === undefined || prior.seamX === undefined || prior.seamY === undefined
    ? ""
    : `<path class="seam" d="M${prior.seamX * CELL + CELL / 2} 0V${height * CELL}`
      + `M0 ${prior.seamY * CELL + CELL / 2}H${width * CELL}"/>`;

  // The door candidates, as marks on the seam. Computed here rather than read
  // off the grid because a ruled-out candidate is an INFERENCE the walker never
  // writes into `field.slots`: the digest can only carry what was SEEN, so a
  // slot the planner has already priced at Infinity arrives looking exactly like
  // an unvisited one, and the seam's dash phase puts its gaps nowhere in
  // particular. The three states follow `planStep` exactly — seen open is a
  // door, seen wall is wall, and a slot in an EXCLUSIVE set whose door is
  // already found is wall too. Without that exclusivity guard the mark would
  // assert knowledge the planner itself refuses on an overlapping set, which no
  // real rung produces today but a resize upstream could reintroduce. At most 26
  // marks on a 61x41 — the same order as the nine exit marks, so the three-node
  // grid budget above is untouched.
  const charAt = (x: number, y: number): string => grid[y * width + x] ?? UNKNOWN;
  // Open exactly as the `open` path decides it, so a mark can never disagree
  // with the cell it sits on.
  const isOpen = (at: readonly [number, number]): boolean =>
    charAt(at[0], at[1]) !== WALL && charAt(at[0], at[1]) !== UNKNOWN;
  const drawn = new Set<string>();
  const doors = prior === undefined ? "" : prior.doorSets
    .flatMap((set, index) => {
      const found = prior.doorSetExclusive[index] === true
        && set.some((held) => { const at = parse(held); return at !== undefined && isOpen(at); });
      return set.map((held) => {
        // A slot can sit in two sets only when neither is exclusive — in which
        // case neither closure applies — so drawing it once loses nothing.
        if (drawn.has(held)) return "";
        drawn.add(held);
        const at = parse(held);
        if (at === undefined || at[0] >= width || at[1] >= height) return "";
        const open = isOpen(at);
        const shut = !open && (charAt(at[0], at[1]) === WALL || found);
        const [cx, cy] = centre(at);
        const title = `${DOOR_SIDES[index] ?? "seam"} door — `
          + (open ? "open" : shut ? "provably wall" : `one of ${set.length} candidates`);
        return `<circle class="door${open ? " found" : shut ? " shut" : ""}"`
          + ` cx="${cx}" cy="${cy}" r="${CELL * 0.5}"><title>${esc(title)}</title></circle>`;
      });
    })
    .join("");

  // Exit candidates. On the shallow rungs there is one and it is known before
  // the first move; on the deep ones there are nine and knocking them down is
  // half of what a radar is for. Drawn hollow while they are still a question
  // and filled once the exit is settled.
  const marks = lab.candidates
    .map(parse)
    .filter((held): held is [number, number] => held !== undefined)
    .map((held) => {
      const [cx, cy] = centre(held);
      return `<circle class="exit${lab.exitKnown ? " known" : ""}" cx="${cx}" cy="${cy}" r="${CELL * 0.8}"/>`;
    })
    .join("");

  // The single PID-bound finisher.
  const dots = lab.walkers
    .map((walker) => {
      const at = walker.at === undefined ? undefined : parse(walker.at);
      if (at === undefined) return "";
      const [cx, cy] = centre(at);
      const title = `finisher from ${walker.from}`
        + ` — ${walker.moves} moves, ${walker.attempts} authentications`
        + (walker.pinned ? ", pinned" : ", not pinned");
      return `<circle class="walker finisher${walker.pinned ? " pinned" : ""}"`
        + ` cx="${cx}" cy="${cy}" r="${CELL}"><title>${esc(title)}</title></circle>`;
    })
    .join("");

  return `<div class="labmaze-wrap">`
    + `<svg class="labmaze" role="img" viewBox="0 0 ${width * CELL} ${height * CELL}"`
    + ` preserveAspectRatio="xMidYMid meet"`
    + ` aria-label="labyrinth map, ${width} by ${height}, ${Math.round(labExplored(lab).fraction * 100)}% mapped">`
    // The fog is one rect rather than a path over every unknown cell: unknown is
    // the DEFAULT state, so painting what we know on top of it is both cheaper
    // and the honest way round.
    + `<rect class="fog" x="0" y="0" width="${width * CELL}" height="${height * CELL}"/>`
    + `<path class="open" d="${open}"/>`
    + `<path class="wall" d="${walls}"/>`
    + seams
    + doors
    + marks
    + dots
    + `</svg></div>`;
}

/** The maze's own legend. Seven glyphs, and every one of them is a decision the
 * walk actually turns on. */
export function labMazeLegend(): string {
  return `<div class="labkey">`
    + `<span><i class="sw open"></i>mapped floor</span>`
    + `<span><i class="sw wall"></i>proven wall</span>`
    + `<span><i class="sw fog"></i>unseen</span>`
    + `<span><i class="sw seamkey"></i>quadrant seam</span>`
    + `<span><i class="sw walkerkey"></i>finisher</span>`
    + `<span><i class="sw exitkey"></i>exit candidate</span>`
    + `<span><i class="sw doorkey"></i>door candidate (filled = found)</span>`
    + `</div>`;
}
