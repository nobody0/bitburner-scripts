import type { NS, Server } from "@ns";
import { dodge } from "./dodge.ts";
import {
  DODGED_PROBES,
  GATE_PROBE,
  LOCAL_PROBES,
  type DodgedProbe,
  type Emission,
  type ProbeContext,
} from "./probes/index.ts";
import {
  caps,
  clearProbeFailure,
  merge,
  recordProbeFailure,
  recordProbeSkip,
  set,
  type GameState,
} from "./state.ts";

/** Budget-aware state acquisition: the read half of the feature axis.
 *
 * This runs unconditionally, in every build. It writes what it reads into the
 * game-state store (./state.ts) and never touches telemetry — a --perf build
 * probes exactly as hard as a telemetry build, because the controller gates
 * feature drivers on the capabilities this produces. Sending the results is
 * ./telemetry-sink.ts's job and nobody else's.
 *
 * The constraint that shapes everything: the heap hands the dispatcher every
 * gigabyte above HOME_RESERVE_GB, so free home RAM hovers near 4.5 GB
 * indefinitely and a dodge stub costs 1.6 GB of that before it calls anything.
 * The affordable dynamic budget is therefore ~2.5 GB most of the time — far
 * below a corporation probe (20 GB) or an SF4-less augmentation sweep (80 GB).
 *
 * So: price every probe at runtime with ns.getFunctionRamCost (0 GB, and it
 * already folds in the singularity 16/4/1 multiplier), pack what fits, and
 * record what did not with its price. A feature panel that stays empty should
 * say why.
 *
 * Cadence per sweep (30 s): one gate batch, then at most one packed feature
 * batch. Bounding it to one keeps the dodge mutex — single-flight, ~2 game
 * ticks per launch — out of the dispatcher's way. */

/** Left free on top of the stub so ns.exec of the stub itself never fails. */
export const SAFETY_GB = 0.5;
const STUB_BASE_GB = 1.6;
/** Fallback when getFunctionRamCost cannot price a name (renamed API, typo). */
const UNKNOWN_METHOD_GB = 4;

export interface ProbeRunner {
  readonly lastRunAt: Map<string, number>;
  /** Probe id -> summed RAM cost of its distinct methods. */
  readonly costs: Map<string, number>;
}

export function initProbeRunner(): ProbeRunner {
  return { lastRunAt: new Map(), costs: new Map() };
}

function methodCost(ns: NS, method: string): number {
  try {
    // Returns 0 both for genuinely-free functions and for names it does not
    // know; the free ones are all in the gate batch, so a 0 on a detail probe
    // is treated as free and simply costs nothing.
    return ns.getFunctionRamCost(method);
  } catch {
    return UNKNOWN_METHOD_GB;
  }
}

/** Sum of the distinct method costs. Bitburner charges a script for each ns
 * function it references once, however many times it calls it, so a probe
 * that reads 12 gang members still pays getMemberInformation a single time. */
function priceProbe(ns: NS, runner: ProbeRunner, probe: DodgedProbe): number {
  const cached = runner.costs.get(probe.id);
  if (cached !== undefined) return cached;
  let total = 0;
  for (const method of new Set(probe.methods)) total += methodCost(ns, method);
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

function publish(state: GameState, emissions: Emission[], mergeTopic: boolean): void {
  for (const emission of emissions) {
    if (mergeTopic) merge(state, emission.key, emission.data);
    else set(state, emission.key, emission.data);
  }
}

/** The capability gate batch: cheap, and everything downstream depends on it —
 * probe gating AND feature-driver gating — so it runs first and every sweep. */
async function runGateBatch(ns: NS, state: GameState, budget: number): Promise<void> {
  if (budget < GATE_PROBE.cost) {
    recordProbeSkip(state, GATE_PROBE.id, GATE_PROBE.cost, budget);
    return;
  }
  try {
    const gates = await dodge(ns, GATE_PROBE.run, GATE_PROBE.cost);
    set(state, "capabilities", gates.caps);
    if (gates.progression) merge(state, "progression", gates.progression);
    if (gates.failures.length > 0) recordProbeFailure(state, GATE_PROBE.id, gates.failures.join(", "));
    else clearProbeFailure(state, GATE_PROBE.id);
    delete state.probeSkips[GATE_PROBE.id];
  } catch (error) {
    recordProbeFailure(state, GATE_PROBE.id, error);
  }
}

/** One sweep's worth of acquisition. Requires `player` and `servers` to be in
 * the store already — the controller writes both before calling. */
export async function runProbes(ns: NS, runner: ProbeRunner, state: GameState): Promise<void> {
  const servers = state.topics.servers;
  const player = state.topics.player;
  if (!servers || !player) return;

  const now = Date.now();
  const budget = dodgeBudget(servers);

  await runGateBatch(ns, state, budget);

  const ctx: ProbeContext = { player, servers, caps: caps(state) };
  const applicable = (probe: DodgedProbe | (typeof LOCAL_PROBES)[number]): boolean => {
    if (probe.requires && ctx.caps.unlocked[probe.requires] !== "yes") return false;
    return probe.when ? probe.when(ctx.caps, state.topics) : true;
  };

  // Local probes: no ns, no budget, no excuse for an empty panel.
  for (const probe of LOCAL_PROBES) {
    if (!due(runner, probe.id, probe.everyMs, now) || !applicable(probe)) continue;
    runner.lastRunAt.set(probe.id, now);
    try {
      publish(state, probe.run(ctx), probe.merge ?? false);
      clearProbeFailure(state, probe.id);
    } catch (error) {
      recordProbeFailure(state, probe.id, error);
    }
  }

  // One packed dodged batch. Earliest-deadline-first so a cheap 30 s probe
  // cannot starve behind an expensive 10 min one.
  const dueProbes = DODGED_PROBES.filter((probe) => due(runner, probe.id, probe.everyMs, now) && applicable(probe)).sort(
    (a, b) => lastRun(runner, a.id) + a.everyMs - (lastRun(runner, b.id) + b.everyMs),
  );

  const batch: DodgedProbe[] = [];
  const methods = new Set<string>();
  let cost = 0;
  for (const probe of dueProbes) {
    // Shared methods are charged once for the whole stub, so the marginal cost
    // of adding a probe is only its methods we are not already paying for.
    let marginal = 0;
    for (const method of new Set(probe.methods)) {
      if (!methods.has(method)) marginal += methodCost(ns, method);
    }
    if (cost + marginal > budget) {
      // Only a probe that cannot fit an EMPTY stub is genuinely unaffordable;
      // one merely crowded out of this pass will run next sweep.
      const solo = priceProbe(ns, runner, probe);
      if (solo > budget) recordProbeSkip(state, probe.id, solo, budget);
      continue;
    }
    batch.push(probe);
    for (const method of probe.methods) methods.add(method);
    cost += marginal;
    delete state.probeSkips[probe.id];
  }

  if (batch.length === 0) return;
  for (const probe of batch) runner.lastRunAt.set(probe.id, now);
  state.probeBatch = { ids: batch.map((p) => p.id), cost, budget };

  let results: { id: string; emissions?: Emission[]; error?: string }[];
  try {
    results = await dodge(
      ns,
      async (stubNs) => {
        const out: { id: string; emissions?: Emission[]; error?: string }[] = [];
        for (const probe of batch) {
          // Per-probe isolation: ns.gang.* and ns.bladeburner.* throw outside
          // their BitNode, and one throw must not cost the whole batch.
          try {
            out.push({ id: probe.id, emissions: await probe.run(stubNs, ctx) });
          } catch (error) {
            out.push({ id: probe.id, error: String(error) });
          }
        }
        return out;
      },
      cost,
    );
  } catch (error) {
    // The stub itself failed to launch or timed out — the whole batch is lost.
    for (const probe of batch) recordProbeFailure(state, probe.id, error);
    return;
  }

  for (const result of results) {
    const probe = batch.find((p) => p.id === result.id)!;
    if (result.error !== undefined) {
      recordProbeFailure(state, result.id, result.error);
      continue;
    }
    publish(state, result.emissions ?? [], probe.merge ?? false);
    clearProbeFailure(state, result.id);
  }
}

function lastRun(runner: ProbeRunner, id: string): number {
  return runner.lastRunAt.get(id) ?? 0;
}

function due(runner: ProbeRunner, id: string, everyMs: number, now: number): boolean {
  return now - lastRun(runner, id) >= everyMs;
}
