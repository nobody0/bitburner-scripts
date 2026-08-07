import type { NS } from "@ns";
import { FEATURE_IDS, type FeatureId } from "../../../shared/features/ids.ts";
import type { Capabilities } from "../../../shared/features/unlock.ts";
import type { GameState } from "../state.ts";
import { hacking } from "./hacking.ts";

/** Feature drivers: the write half of the feature axis.
 *
 * A probe reads one feature's state; a driver acts on it. One driver per entry
 * in shared/features/registry.ts, gated on the capabilities the gate batch
 * produces — which is why acquisition can never sit behind the telemetry flag.
 * A --perf build must make the same decisions as a telemetry build, and those
 * decisions start here.
 *
 * Twelve of the fourteen are declared but inert. That is deliberate: a
 * registered no-op makes the gating visible, gives the scheduler its real
 * shape, and lets tests/features.test.ts enforce a driver per feature exactly
 * as it enforces a probe, a topic and a tab. Filling one in is a local change
 * to one file, not a change to the loop. */

export interface DriverContext {
  ns: NS;
  state: GameState;
  caps: Capabilities;
  /** RAM a dodge closure can use right now, if this driver needs to dodge. */
  budgetGb: number;
  /** Controller tick counter, for drivers that want a phase offset. */
  tick: number;
}

export interface FeatureDriver {
  id: FeatureId;
  /** Minimum interval between ticks. A plain literal, matching the probe
   *  table's convention. */
  everyMs: number;
  /** Ticks only while capabilities report this feature as "yes". Omit for
   *  features that are always playable. */
  requires?: FeatureId;
  tick(ctx: DriverContext): void | Promise<void>;
}

/** Declared, not yet implemented. `problem` is the one-line contract from the
 * registry — the question this driver has to answer once it grows a body. */
function inert(id: FeatureId, everyMs: number, requires?: FeatureId): FeatureDriver {
  return { id, everyMs, ...(requires ? { requires } : {}), tick() {} };
}

export const FEATURE_DRIVERS: readonly FeatureDriver[] = [
  // TODO(progression): choose the BitNode destroy order and the
  // augmentation/reset cadence that minimises wall-clock to a source-file set.
  inert("progression", 60_000),
  hacking,
  // TODO(factions): reach a target augmentation set in the least wall-clock,
  // trading faction work against donations against grafting.
  inert("factions", 30_000, "factions"),
  // TODO(career): reach the stat, karma and company-rep thresholds other
  // features depend on, using crime as early income.
  inert("career", 10_000),
  // TODO(hacknet): schedule purchases and upgrades so cumulative production
  // minus spend is maximised over the run horizon.
  inert("hacknet", 10_000),
  // TODO(stock): allocate capital across symbols from forecast and volatility.
  inert("stock", 5_000, "stock"),
  // TODO(gang): assign tasks, schedule ascensions and equipment.
  inert("gang", 10_000, "gang"),
  // TODO(corp): sequence divisions, offices, research and investment rounds.
  inert("corp", 30_000, "corp"),
  // TODO(bladeburner): pick the action sequence that climbs rank fastest.
  inert("bladeburner", 5_000, "bladeburner"),
  // TODO(sleeves): assign N sleeves across crime, work, training and sync.
  inert("sleeves", 30_000, "sleeves"),
  // TODO(go): maximise territory captured per game against each opponent.
  inert("go", 10_000, "go"),
  // TODO(stanek): pack fragments into the gift grid, then schedule charging.
  inert("stanek", 30_000, "stanek"),
  // TODO(dnet): traverse the darknet graph, spending stasis links.
  inert("dnet", 30_000, "dnet"),
  // TODO(side): solve contracts before they expire; rank infiltration targets.
  inert("side", 60_000),
];

/** Which drivers should run now. Pure, so the scheduling rule is unit-tested
 * rather than inferred from live behaviour.
 *
 * "unknown" never runs a driver: not having looked is not the same as being
 * unlocked, and acting on a feature we cannot see would spend a stub launch
 * discovering an API that throws. */
export function selectDue(
  drivers: readonly FeatureDriver[],
  lastRun: Record<string, number>,
  caps: Capabilities,
  now: number,
): FeatureDriver[] {
  return drivers.filter((driver) => {
    if (driver.requires && caps.unlocked[driver.requires] !== "yes") return false;
    return now - (lastRun[driver.id] ?? 0) >= driver.everyMs;
  });
}

export { FEATURE_IDS };
