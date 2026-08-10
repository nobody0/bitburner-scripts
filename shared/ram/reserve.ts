import type { FeatureId } from "../features/ids.ts";
import { formatNumber } from "../format.ts";
import { HOME_RESERVE_GB } from "./heap.ts";

/** How much home RAM to keep out of the dispatcher's hands.
 *
 * The problem this solves: the heap hands the dispatcher every gigabyte above
 * the reserve, so free home RAM converges on exactly the reserve and stays
 * there. With a single 4.5 GB constant that leaves ~2.4 GB of dynamic dodge
 * budget forever — enough for a scan, and not enough for any singularity probe
 * worth running. A feature whose cheapest useful step costs 8 GB would be
 * reported as "unaffordable" every sweep for the entire run, with no path to
 * ever becoming affordable, because the dispatcher would always have eaten the
 * headroom first.
 *
 * So the reserve is computed, not constant: base plus the largest single dodge
 * step any ENABLED feature declares. Feature demand is declared on the feature
 * module next to its probe (`FeatureModule.peakStepGb`), so it cannot drift
 * from what the probe actually costs.
 *
 * The clamp is the honest part. On a fresh 8 GB home the base reserve is
 * already 56% of the machine; letting a feature push it to 12 GB would starve
 * the dispatcher of the income needed to ever buy more RAM. So the increase is
 * capped, and a capped reserve is REPORTED (`capped: true`) rather than
 * silently applied — the feature says "I need a bigger home", which is a real
 * and actionable blocker, instead of quietly never running.
 *
 * Pure: the sim and the game compute the same reserve from the same inputs. */

/** Ceiling on the reserve as a fraction of home, so the dispatcher always
 * keeps a usable share of a small home. Never applied below `base`, which is a
 * hard requirement — under it, `ns.exec` of the dodge stub itself fails and the
 * script loses its only way to read the world. */
export const MAX_RESERVE_FRACTION = 0.4;

export interface ReserveInput {
  /** Floor. HOME_RESERVE_GB unless a caller is testing. */
  base?: number;
  /** Features reading "yes" — a locked feature's probe never runs, so its
   *  demand must not cost the dispatcher anything. */
  enabled: readonly FeatureId[];
  /** Largest single dodge step each feature needs, in GB. */
  demand: Partial<Record<FeatureId, number>>;
  homeMaxRam: number;
}

export interface ReserveResult {
  reserveGb: number;
  /** True when feature demand was cut down by the fraction ceiling. */
  capped: boolean;
  /** The feature that drove the reserve up, if any. */
  driver?: FeatureId;
  /** What the reserve would have been without the ceiling. */
  wantedGb: number;
  why: string;
}

export function homeReserveGb(input: ReserveInput): ReserveResult {
  const base = input.base ?? HOME_RESERVE_GB;
  const enabled = new Set(input.enabled);

  let peak = 0;
  let driver: FeatureId | undefined;
  // Deterministic on ties: iterate the declared demand in a sorted order so
  // two features asking for the same peak always name the same driver.
  for (const id of Object.keys(input.demand).sort() as FeatureId[]) {
    if (!enabled.has(id)) continue;
    const want = input.demand[id] ?? 0;
    if (want > peak) {
      peak = want;
      driver = id;
    }
  }

  const wantedGb = base + peak;
  const ceiling = Math.max(base, input.homeMaxRam * MAX_RESERVE_FRACTION);
  const reserveGb = Math.min(wantedGb, ceiling);
  const capped = reserveGb < wantedGb;

  return {
    reserveGb,
    capped,
    ...(driver !== undefined && peak > 0 ? { driver } : {}),
    wantedGb,
    why: describe({ base, peak, driver, capped, reserveGb, wantedGb, homeMaxRam: input.homeMaxRam }),
  };
}

function describe(d: {
  base: number;
  peak: number;
  driver: FeatureId | undefined;
  capped: boolean;
  reserveGb: number;
  wantedGb: number;
  homeMaxRam: number;
}): string {
  if (d.peak === 0 || d.driver === undefined) return `${d.base} GB base reserve; no feature declares a dodge step`;
  const wanted = `${d.base} GB base + ${d.peak} GB for ${d.driver}`;
  if (!d.capped) return `${wanted} = ${d.reserveGb} GB`;
  return (
    `${wanted} = ${d.wantedGb} GB, capped to ${round(d.reserveGb)} GB ` +
    `(${Math.round(MAX_RESERVE_FRACTION * 100)}% of a ${formatNumber(d.homeMaxRam)} GB home) — ${d.driver} needs more home RAM`
  );
}

function round(gb: number): number {
  return Math.round(gb * 100) / 100;
}

export { HOME_RESERVE_GB };
