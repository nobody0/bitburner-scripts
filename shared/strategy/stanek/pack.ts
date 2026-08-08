/** Stanek's Gift: fragment packing and charge scheduling.
 *
 * Two separable problems, and separating them is the point:
 *
 *  1. **Packing** — 2D bin packing with rotation into a small grid. The grid
 *     is small enough that EXHAUSTIVE search is provably optimal, which makes
 *     this the strongest evidence available anywhere in the roster: not "our
 *     packing beats first-fit", but "no packing exists that is better".
 *  2. **Charging** — an ordering problem over the placed fragments, weighted
 *     by the run's objective. Independent of the packing once it is fixed. */

export interface Fragment {
  id: number;
  /** Shape as a list of occupied cells at rotation 0. */
  shape: { x: number; y: number }[];
  /** Effect magnitude, for the charge ordering. */
  power: number;
  /** Objective weight of this fragment's effect. */
  weight: number;
}

export interface Placement {
  id: number;
  x: number;
  y: number;
  /** 0-3, quarter turns. */
  rotation: number;
}

export interface PackResult {
  placements: Placement[];
  /** Total weight of the fragments that fit. */
  value: number;
  /** True when the search was capped and the answer may not be optimal. */
  approximated: boolean;
}

/** Rotate a shape by `rotation` quarter-turns and normalise to the origin. */
export function rotate(shape: readonly { x: number; y: number }[], rotation: number): { x: number; y: number }[] {
  let cells = shape.map((cell) => ({ ...cell }));
  for (let turn = 0; turn < (((rotation % 4) + 4) % 4); turn++) {
    cells = cells.map((cell) => ({ x: -cell.y, y: cell.x }));
  }
  const minX = Math.min(...cells.map((cell) => cell.x));
  const minY = Math.min(...cells.map((cell) => cell.y));
  return cells
    .map((cell) => ({ x: cell.x - minX, y: cell.y - minY }))
    .sort((a, b) => a.y - b.y || a.x - b.x);
}

/** Distinct rotations of a shape — a square block has one, an L has four.
 * Deduplicating matters: it cuts the search space by up to 4x per fragment. */
export function distinctRotations(shape: readonly { x: number; y: number }[]): number[] {
  const seen = new Set<string>();
  const out: number[] = [];
  for (let rotation = 0; rotation < 4; rotation++) {
    const key = rotate(shape, rotation)
      .map((cell) => `${cell.x},${cell.y}`)
      .join("|");
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(rotation);
  }
  return out;
}

/** Exhaustive maximum-weight packing.
 *
 * Provably optimal: it enumerates every (fragment subset x rotation x
 * position) combination and keeps the best. The grid is at most 9x9 and the
 * fragment count small, so this terminates — and when it does not, the caller
 * is TOLD via `approximated` rather than handed a greedy answer dressed as an
 * exact one. */
export function packFragments(
  fragments: readonly Fragment[],
  width: number,
  height: number,
  maxNodes = 2_000_000,
): PackResult {
  const occupied = new Uint8Array(width * height);
  let best: PackResult = { placements: [], value: 0, approximated: false };
  let nodes = 0;
  let capped = false;

  const fits = (cells: { x: number; y: number }[], ox: number, oy: number): boolean => {
    for (const cell of cells) {
      const x = ox + cell.x;
      const y = oy + cell.y;
      if (x < 0 || y < 0 || x >= width || y >= height) return false;
      if (occupied[y * width + x]) return false;
    }
    return true;
  };
  const mark = (cells: { x: number; y: number }[], ox: number, oy: number, value: number): void => {
    for (const cell of cells) occupied[(oy + cell.y) * width + (ox + cell.x)] = value;
  };

  const current: Placement[] = [];
  let currentValue = 0;

  const recurse = (index: number): void => {
    if (++nodes > maxNodes) {
      capped = true;
      return;
    }
    if (currentValue > best.value) {
      best = { placements: current.map((p) => ({ ...p })), value: currentValue, approximated: false };
    }
    if (index >= fragments.length) return;

    // Branch 1: skip this fragment. Necessary for correctness — the best
    // packing may leave a large fragment out to fit two smaller ones.
    recurse(index + 1);

    const fragment = fragments[index]!;
    for (const rotation of distinctRotations(fragment.shape)) {
      const cells = rotate(fragment.shape, rotation);
      for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
          if (!fits(cells, x, y)) continue;
          mark(cells, x, y, 1);
          current.push({ id: fragment.id, x, y, rotation });
          currentValue += fragment.weight;
          recurse(index + 1);
          currentValue -= fragment.weight;
          current.pop();
          mark(cells, x, y, 0);
        }
      }
    }
  };

  recurse(0);
  return { ...best, approximated: capped };
}

/** Charge ordering: highest weighted effect first.
 *
 * Charging raises a fragment's effect, so the run's objective weights decide
 * which fragment is worth the charge time. Read from the needs board by the
 * driver, so a run that needs hacking charges the hacking fragment. */
export function chargeOrder(fragments: readonly Fragment[], placed: readonly Placement[]): number[] {
  const placedIds = new Set(placed.map((placement) => placement.id));
  return fragments
    .filter((fragment) => placedIds.has(fragment.id))
    .slice()
    .sort((a, b) => b.weight * b.power - a.weight * a.power || a.id - b.id)
    .map((fragment) => fragment.id);
}
