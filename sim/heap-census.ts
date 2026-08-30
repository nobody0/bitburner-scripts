/** Where a run's memory actually IS, split into the two halves that fail
 * differently.
 *
 * The companion to sim/cost.ts's RSS sampling: RSS says a run is accumulating,
 * this says whether what it accumulates is reachable JavaScript — objects some
 * collection is holding, fixable by dropping the reference — or memory the
 * collector already gave up on, which is the allocator's growth and is fixed
 * by allocating less. A 24h leg run has died at 58.69 GB RSS
 * (sim/tests/baselines/bn4.json) and the two diagnoses have nothing in common,
 * so measuring only the total tells you nothing about which one you have.
 *
 * `bun:jsc`'s `heapStats()` is the cheap instrument: no heap walk, and
 * `heapCapacity` (what JSC holds) against `heapSize` (what is live in it) is
 * the fragmentation ratio directly. It is Bun-only and loaded lazily, so a
 * non-Bun host simply reports nothing rather than failing. */

export interface HeapCensus {
  /** Live bytes, as of the last collection. */
  liveBytes: number;
  /** Bytes JSC's heap holds, live or not. */
  capacityBytes: number;
  /** Native memory JSC attributes to JS objects (typed-array backing stores
   * and the like) — counted in RSS, never in `liveBytes`. */
  extraBytes: number;
  objectCount: number;
  /** Objects a native reference pins against collection. A growing protected
   * count is a leak the collector cannot fix for you. */
  protectedObjectCount: number;
  /** Top object types by live count. */
  types: { name: string; count: number }[];
}

interface JscHeapStats {
  heapSize: number;
  heapCapacity: number;
  extraMemorySize: number;
  objectCount: number;
  protectedObjectCount: number;
  objectTypeCounts: Record<string, number>;
}

/** Resolved once. `null` means "this host has no bun:jsc", which is a fact
 * about the host and never changes mid-run. */
let heapStatsFn: (() => JscHeapStats) | null | undefined;

function resolveHeapStats(): (() => JscHeapStats) | null {
  if (heapStatsFn !== undefined) return heapStatsFn;
  heapStatsFn = null;
  try {
    // Bun-only, and `require` rather than `import` because the census is called
    // synchronously from a cost sample.
    const jsc = (globalThis as { require?: (id: string) => unknown }).require?.("bun:jsc")
      ?? (typeof require === "function" ? (require as (id: string) => unknown)("bun:jsc") : undefined);
    const fn = (jsc as { heapStats?: () => JscHeapStats } | undefined)?.heapStats;
    if (typeof fn === "function") heapStatsFn = fn;
  } catch {
    /* not Bun, or bun:jsc unavailable: the census is optional by design */
  }
  return heapStatsFn;
}

/** A census, or undefined where the runtime cannot produce one.
 *
 * `collect` forces a full collection first, so `liveBytes` means live rather
 * than "live as of whenever JSC last swept". That is the only reading that can
 * be compared against RSS, and it is why this is diagnosis-only. */
export function heapCensus(topTypes = 10, collect = true): HeapCensus | undefined {
  const heapStats = resolveHeapStats();
  if (heapStats === null) return undefined;
  if (collect) (globalThis as { Bun?: { gc?: (force: boolean) => void } }).Bun?.gc?.(true);
  const stats = heapStats();
  const types = Object.entries(stats.objectTypeCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, topTypes)
    .map(([name, count]) => ({ name, count }));
  return {
    liveBytes: stats.heapSize,
    capacityBytes: stats.heapCapacity,
    extraBytes: stats.extraMemorySize,
    objectCount: stats.objectCount,
    protectedObjectCount: stats.protectedObjectCount,
    types,
  };
}

export function formatHeapCensus(census: HeapCensus): string {
  const mb = (bytes: number): string => `${(bytes / 1024 ** 2).toFixed(1)}MB`;
  return (
    `heap live=${mb(census.liveBytes)} capacity=${mb(census.capacityBytes)} extra=${mb(census.extraBytes)} `
    + `objects=${census.objectCount} protected=${census.protectedObjectCount}  `
    + census.types.map((entry) => `${entry.name}=${entry.count}`).join(" ")
  );
}
