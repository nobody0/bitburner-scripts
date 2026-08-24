/** Stanek's Gift: fragment packing and charge scheduling.
 *
 * Two separable problems, and separating them is the point:
 *
 *  1. **Packing** — 2D bin packing with rotation, searched exhaustively until
 *     an explicit node cap. An uncapped result is provably optimal for the
 *     stated weight objective; a capped result is marked approximate.
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

/** Rotate a shape by `rotation` quarter-turns and normalise to the origin.
 * Source convention: https://github.com/bitburner-official/bitburner-src/blob/3162fd2590e221eadd0c0fbd46151913f7c4c41c/src/CotMG/Fragment.ts#L24-L51 */
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
 * position) combination and keeps the best. v3.0.1 permits gifts up to 25x25,
 * so the node cap is material; when reached, the caller is told through
 * `approximated` rather than receiving a capped answer labeled exact.
 * Source size bound: https://github.com/bitburner-official/bitburner-src/blob/3162fd2590e221eadd0c0fbd46151913f7c4c41c/src/CotMG/data/Constants.ts#L1-L5 */
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
