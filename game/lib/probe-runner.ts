import type { NS, Server } from "@ns";
import { unknownCapabilities, type Capabilities } from "../../shared/features/unlock.ts";
import type { StateKey, StateMap } from "../../shared/telemetry/state-map.ts";
import { dodge } from "./dodge.ts";
import {
  DODGED_PROBES,
  GATE_PROBE,
  LOCAL_PROBES,
  type DodgedProbe,
  type Emission,
  type ProbeContext,
} from "./probes/index.ts";
import type { Telemetry } from "./telemetry.ts";

/** Budget-aware feature probe scheduler.
 *
 * The constraint that shapes everything: the heap hands the dispatcher every
 * gigabyte above HOME_RESERVE_GB, so free home RAM hovers near 4.5 GB
 * indefinitely and a dodge stub costs 1.6 GB of that before it calls anything.
 * The affordable dynamic budget is therefore ~2.5 GB most of the time — far
 * below a corporation probe (20 GB) or an SF4-less augmentation sweep (80 GB).
 *
 * So: price every probe at runtime with ns.getFunctionRamCost (0 GB, and it
 * already folds in the singularity 16/4/1 multiplier), pack what fits, and
 * report what did not as `probe.skipped` with its price. A feature panel that
 * stays empty should say why.
 *
 * Cadence per sweep (30 s): one gate batch, then at most one packed feature
 * batch. Bounding it to one keeps the dodge mutex — single-flight, ~2 game
 * ticks per launch — out of the dispatcher's way. */

/** Left free on top of the stub so ns.exec of the stub itself never fails. */
const SAFETY_GB = 0.5;
const STUB_BASE_GB = 1.6;
/** Fallback when getFunctionRamCost cannot price a name (renamed API, typo). */
const UNKNOWN_METHOD_GB = 4;

export interface ProbeRunner {
  caps: Capabilities;
  /** Last emitted payload per topic, for probes declaring `merge`. */
  readonly lastByKey: Map<StateKey, Record<string, unknown>>;
  readonly lastRunAt: Map<string, number>;
  readonly costs: Map<string, number>;
  /** Ids reported as skipped, so we report each price change once, not every
   *  sweep — a permanently unaffordable probe must not spam the feed. */
  readonly reportedSkips: Map<string, number>;
  /** Last batch composition, for the same reason: in steady state the same
   *  handful of probes runs every sweep forever, and repeating that trace
   *  would crowd everything else out of the event feed. */
  lastBatchSignature?: string;
}

export function initProbeRunner(): ProbeRunner {
  return {
    caps: unknownCapabilities(),
    lastByKey: new Map(),
    lastRunAt: new Map(),
    costs: new Map(),
    reportedSkips: new Map(),
  };
}

/** Sum of the distinct method costs. Bitburner charges a script for each ns
 * function it references once, however many times it calls it, so a probe
 * that reads 12 gang members still pays getMemberInformation a single time. */
function priceProbe(ns: NS, runner: ProbeRunner, probe: DodgedProbe): number {
  const cached = runner.costs.get(probe.id);
  if (cached !== undefined) return cached;
  let total = 0;
  for (const method of new Set(probe.methods)) {
    let cost: number;
    try {
      cost = ns.getFunctionRamCost(method);
    } catch {
      cost = UNKNOWN_METHOD_GB;
    }
    // getFunctionRamCost returns 0 both for genuinely-free functions and for
    // names it does not know; the free ones are all in the gate batch, so a 0
    // here on a detail probe is treated as free and simply costs nothing.
    total += cost;
  }
  runner.costs.set(probe.id, total);
  return total;
}

/** Dynamic RAM a dodge closure can use right now. Uses the sweep's own fresh
 * scan, so it costs nothing. */
export function dodgeBudget(servers: Record<string, Server>): number {
  const home = servers["home"];
  if (!home) return 0;
  return Math.max(0, home.maxRam - home.ramUsed - STUB_BASE_GB - SAFETY_GB);
}

function publish(runner: ProbeRunner, tel: Telemetry, emissions: Emission[], merge: boolean): void {
  for (const { key, data } of emissions) {
    let payload = data as Record<string, unknown>;
    if (merge) {
      const previous = runner.lastByKey.get(key);
      // Drop undefined so an absent optional field never erases a known one.
      const defined: Record<string, unknown> = {};
      for (const [field, value] of Object.entries(payload)) {
        if (value !== undefined) defined[field] = value;
      }
      payload = previous ? { ...previous, ...defined } : defined;
    }
    runner.lastByKey.set(key, payload);
    tel.state(key, payload as StateMap[typeof key]);
  }
}

/** One sweep's worth of probing. Call from the start.js sweep, inside a
 * TELEMETRY guard — perf builds carry none of this. */
export async function runProbes(
  ns: NS,
  runner: ProbeRunner,
  tel: Telemetry,
  ctx: Omit<ProbeContext, "caps">,
): Promise<void> {
  const now = Date.now();
  const budget = dodgeBudget(ctx.servers);

  // 1) Gates. Cheap, and everything else depends on the capabilities they
  //    produce, so they run first and every sweep.
  if (budget >= GATE_PROBE.cost) {
    try {
      const gates = await dodge(ns, GATE_PROBE.run, GATE_PROBE.cost);
      runner.caps = gates.caps;
      tel.state("capabilities", gates.caps);
      if (gates.progression) publish(runner, tel, [{ key: "progression", data: gates.progression }], true);
      if (gates.failures.length > 0) tel.event("probe.failed", { id: GATE_PROBE.id, calls: gates.failures });
    } catch (error) {
      tel.event("probe.failed", { id: GATE_PROBE.id, error: String(error) });
    }
  } else {
    reportSkip(runner, tel, GATE_PROBE.id, GATE_PROBE.cost, budget);
  }

  const full: ProbeContext = { ...ctx, caps: runner.caps };

  // 2) Local probes: no ns, no budget, no excuse for an empty panel.
  for (const probe of LOCAL_PROBES) {
    if (!due(runner, probe.id, probe.everyMs, now)) continue;
    if (probe.requires && full.caps.unlocked[probe.requires] !== "yes") continue;
    runner.lastRunAt.set(probe.id, now);
    try {
      publish(runner, tel, probe.run(full), probe.merge ?? false);
    } catch (error) {
      tel.event("probe.failed", { id: probe.id, error: String(error) });
    }
  }

  // 3) One packed dodged batch. Earliest-deadline-first so a cheap 30 s probe
  //    cannot starve behind an expensive 10 min one.
  const dueProbes = DODGED_PROBES.filter(
    (probe) =>
      due(runner, probe.id, probe.everyMs, now) &&
      (!probe.requires || full.caps.unlocked[probe.requires] === "yes"),
  ).sort((a, b) => lastRun(runner, a.id) + a.everyMs - (lastRun(runner, b.id) + b.everyMs));

  const batch: DodgedProbe[] = [];
  const methods = new Set<string>();
  let cost = 0;
  for (const probe of dueProbes) {
    const solo = priceProbe(ns, runner, probe);
    // Shared methods are charged once for the whole stub, so the marginal
    // cost of adding a probe is only its methods we are not already paying.
    let marginal = 0;
    for (const method of new Set(probe.methods)) {
      if (methods.has(method)) continue;
      try {
        marginal += ns.getFunctionRamCost(method);
      } catch {
        marginal += UNKNOWN_METHOD_GB;
      }
    }
    if (cost + marginal > budget) {
      if (solo > budget) reportSkip(runner, tel, probe.id, solo, budget);
      continue;
    }
    batch.push(probe);
    for (const method of probe.methods) methods.add(method);
    cost += marginal;
  }

  if (batch.length === 0) return;
  for (const probe of batch) runner.lastRunAt.set(probe.id, now);

  const failures: { id: string; error: string }[] = [];
  const collected: { emissions: Emission[]; merge: boolean }[] = [];
  try {
    const results = await dodge(
      ns,
      async (stubNs) => {
        const out: { id: string; emissions?: Emission[]; error?: string }[] = [];
        for (const probe of batch) {
          // Per-probe isolation: ns.gang.* and ns.bladeburner.* throw outside
          // their BitNode, and one throw must not cost the whole batch.
          try {
            out.push({ id: probe.id, emissions: await probe.run(stubNs, full) });
          } catch (error) {
            out.push({ id: probe.id, error: String(error) });
          }
        }
        return out;
      },
      cost,
    );
    for (const result of results) {
      const probe = batch.find((p) => p.id === result.id)!;
      if (result.error !== undefined) failures.push({ id: result.id, error: result.error });
      else collected.push({ emissions: result.emissions ?? [], merge: probe.merge ?? false });
    }
  } catch (error) {
    // The stub itself failed to launch or timed out — the whole batch is lost.
    tel.event("probe.failed", { id: "batch", ids: batch.map((p) => p.id), error: String(error) });
    return;
  }

  for (const { emissions, merge } of collected) publish(runner, tel, emissions, merge);
  for (const failure of failures) tel.event("probe.failed", failure);

  const ids = batch.map((p) => p.id);
  const signature = ids.join(",");
  if (signature !== runner.lastBatchSignature) {
    runner.lastBatchSignature = signature;
    tel.debug("probe.batch", { ids, cost, budget });
  }
}

function lastRun(runner: ProbeRunner, id: string): number {
  return runner.lastRunAt.get(id) ?? 0;
}

function due(runner: ProbeRunner, id: string, everyMs: number, now: number): boolean {
  return now - lastRun(runner, id) >= everyMs;
}

/** Report an unaffordable probe once per price, not once per sweep. */
function reportSkip(runner: ProbeRunner, tel: Telemetry, id: string, cost: number, budget: number): void {
  if (runner.reportedSkips.get(id) === cost) return;
  runner.reportedSkips.set(id, cost);
  tel.event("probe.skipped", { id, cost, budget });
}
