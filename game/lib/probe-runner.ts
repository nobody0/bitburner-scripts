import type { NS } from "@ns";
import { dodge } from "./dodge.ts";
import type { DodgeAcquire } from "./ram.ts";
import {
  DODGED_PROBES,
  DIRECT_PROBES,
  GATE_PROBE,
  isStepped,
  LOCAL_PROBES,
  type DodgedProbe,
  type DirectProbe,
  type Emission,
  type ProbeAcc,
  type ProbeContext,
  type SingleStepProbe,
  type SteppedProbe,
} from "./probes/index.ts";
import {
  caps,
  clearProbeFailure,
  merge,
  recordProbeFailure,
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
 * Source: https://github.com/bitburner-official/bitburner-src/blob/3162fd2590e221eadd0c0fbd46151913f7c4c41c/src/Netscript/RamCostGenerator.ts#L82-L95 and https://github.com/bitburner-official/bitburner-src/blob/3162fd2590e221eadd0c0fbd46151913f7c4c41c/src/NetscriptFunctions.ts#L1501-L1507
 *
 * Each acquisition pass launches at most one packed single-step feature batch;
 * the capability gate runs separately on the 30 s fleet sweep. Bounding the
 * packed batch keeps the single-flight dodge mutex out of the dispatcher's
 * way (stepped probes necessarily launch once per step). */

/** Left free on top of the stub so ns.exec of the stub itself never fails. */
/** Fallback when getFunctionRamCost cannot price a name (renamed API, typo).
 * Matches dodge.ts's conservative SF4-level-1 SingularityFn3 ceiling. */
const UNKNOWN_METHOD_GB = 80;

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
    // Free functions return 0; an unknown name throws because
    // getFunctionRamCost asks getRamCost to reject undefined paths.
    // Source: https://github.com/bitburner-official/bitburner-src/blob/3162fd2590e221eadd0c0fbd46151913f7c4c41c/src/NetscriptFunctions.ts#L1501-L1507 and https://github.com/bitburner-official/bitburner-src/blob/3162fd2590e221eadd0c0fbd46151913f7c4c41c/src/Netscript/RamCostGenerator.ts#L743-L763
    return ns.getFunctionRamCost(method);
  } catch {
    return UNKNOWN_METHOD_GB;
  }
}

/** Sum of the distinct method costs in one closure. Bitburner charges a script
 * for each ns function it references once, however many times it calls it, so a
 * probe that reads 12 gang members still pays getMemberInformation a single
 * time.
 * Source: https://github.com/bitburner-official/bitburner-src/blob/3162fd2590e221eadd0c0fbd46151913f7c4c41c/src/Script/RamCalculations.ts#L403-L440 */
function priceMethods(ns: NS, methods: readonly string[]): number {
  let total = 0;
  for (const method of new Set(methods)) total += methodCost(ns, method);
  return total;
}

/** What a probe costs to LAUNCH.
 *
 * For a stepped probe this is the largest single step, not the sum — that is
 * the entire point of splitting one. Each step is its own stub, so the peak
 * RAM the game ever has to find at once is one step's worth. */
function priceProbe(ns: NS, runner: ProbeRunner, probe: DodgedProbe): number {
  const cached = runner.costs.get(probe.id);
  if (cached !== undefined) return cached;
  const price = isStepped(probe)
    ? probe.steps.reduce((peak, step) => Math.max(peak, priceMethods(ns, step.methods)), 0)
    : priceMethods(ns, probe.methods);
  runner.costs.set(probe.id, price);
  return price;
}

/** Dynamic RAM a dodge closure can use right now.
 *
 * Fleet-wide: with placement in the picture (shared/ram/placement.ts) the
 * question is what the whole realm can serve, not what is left on home. A
 * rooted 64 GB client dwarfs anything home will have for hours, and a probe
 * priced against home alone would report itself unaffordable while 200 GB sat
 * idle two hops away. */
function publish(state: GameState, emissions: Emission[], mergeTopic: boolean): void {
  for (const emission of emissions) {
    if (mergeTopic) merge(state, emission.key, emission.data);
    else set(state, emission.key, emission.data);
  }
}

/** The capability gate batch: cheap, and everything downstream depends on it —
 * probe gating AND feature-driver gating.
 *
 * Called by the controller from the SWEEP rather than from `runProbes`, and that
 * separation is load-bearing in two directions. It must not run on the fast
 * acquisition cadence: capabilities change on the scale of a BitNode, so reading
 * them every few seconds would spend a 1.5 GB dodge to learn nothing. And it must
 * run where the controller can act on what changed — the reset walk keys off the
 * capability delta this produces, and a node change detected outside the sweep
 * would leave the fleet, the heap and every cached decision describing a game
 * that no longer exists. */
export async function runGateProbe(
  ns: NS,
  state: GameState,
  acquire: (budgetGb: number, id: string) => DodgeAcquire,
): Promise<void> {
  return runGateBatch(ns, state, acquire);
}

async function runGateBatch(
  ns: NS,
  state: GameState,
  acquire: (budgetGb: number, id: string) => DodgeAcquire,
): Promise<void> {
  const lease = acquire(GATE_PROBE.cost, GATE_PROBE.id);
  if (lease.status === 'queued') return;
  try {
    const gates = await dodge(ns, GATE_PROBE.run, GATE_PROBE.cost, { host: lease.host });
    set(state, "capabilities", gates.caps);
    if (gates.progression) merge(state, "progression", gates.progression);
    if (gates.failures.length > 0) recordProbeFailure(state, GATE_PROBE.id, gates.failures.join(", "));
    else clearProbeFailure(state, GATE_PROBE.id);
  } catch (error) {
    recordProbeFailure(state, GATE_PROBE.id, error);
  } finally {
    lease.release();
  }
}

/** One pass of acquisition. Requires `player` and `servers` to be in the store
 * already — the controller writes both before calling.
 *
 * Runs on its OWN cadence, derived from the fastest `everyMs` in the table
 * (`probeCadenceMs`), and every probe's own `everyMs` gates it from there. It used
 * to be called only from the 30 s fleet sweep, which silently made 30 s the floor
 * for the whole table — see the note on `ProbeBase.everyMs`. Nothing here is tied
 * to the sweep any more: the capability gate, which genuinely is, moved out to
 * `runGateProbe`.
 *
 * `hosts` describes where a stub may run and how much room each has; the
 * controller builds it from the scan plus the dispatcher's heap
 * (game/lib/ram.ts). Placement is per dodge, so a 40 GB augmentation step can
 * land on a big client while a 1.5 GB gate batch stays on home. */
export async function runProbes(
  ns: NS,
  runner: ProbeRunner,
  state: GameState,
  /** Reserves the chosen host's RAM for the life of the stub, so the
   *  dispatcher plans around it instead of racing it. */
  acquire: (budgetGb: number, id: string) => DodgeAcquire,
): Promise<void> {
  const servers = state.topics.servers;
  const player = state.topics.player;
  if (!servers || !player) return;

  const now = Date.now();
  const ctx: ProbeContext = { player, servers, caps: caps(state), state };
  const applicable = (probe: DodgedProbe | DirectProbe | (typeof LOCAL_PROBES)[number]): boolean => {
    // A probe never runs while its OWN feature reads "no". Mirrors the same
    // rule in selectDue: `requires` is a dependency, this is the feature
    // itself, and without it an isolation profile would still spend its dodge
    // budget probing features it switched off. No-op in the real game, where
    // the always-playable features read "yes" unconditionally.
    if (ctx.caps.unlocked[probe.feature] === "no") return false;
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

  // Verified-free synchronous reads. If an API update gives any declared
  // method a RAM price, refuse the direct call and report the drift instead of
  // overrunning start.js's allocation.
  for (const probe of DIRECT_PROBES) {
    if (!due(runner, probe.id, probe.everyMs, now) || !applicable(probe)) continue;
    runner.lastRunAt.set(probe.id, now);
    try {
      const priced = probe.methods.map((method) => [method, methodCost(ns, method)] as const);
      const costly = priced.find(([, cost]) => cost !== 0);
      if (costly) throw new Error(`direct probe method ${costly[0]} costs ${costly[1]}GB`);
      publish(state, probe.run(ns, ctx), probe.merge ?? false);
      clearProbeFailure(state, probe.id);
    } catch (error) {
      recordProbeFailure(state, probe.id, error);
    }
  }

  // Earliest-deadline-first so a cheap 30 s probe cannot starve behind an
  // expensive 10 min one.
  const dueProbes = DODGED_PROBES.filter((probe) => due(runner, probe.id, probe.everyMs, now) && applicable(probe)).sort(
    (a, b) => lastRun(runner, a.id) + a.everyMs - (lastRun(runner, b.id) + b.everyMs),
  );

  // Stepped probes run on their own, one dodge per step: their whole reason
  // for existing is that their methods must NOT share a stub, so they cannot
  // join the packed batch. They go first — a probe that was split is one that
  // could not be afforded otherwise, and it should not lose its slot to
  // cheaper company.
  for (const probe of dueProbes) {
    if (isStepped(probe)) await runSteppedProbe(ns, runner, state, probe, ctx, acquire, now);
  }

  // ONE probe per pass, not a packed batch. Keeping the broker request
  // identity stable while it is queued matters more than sharing a stub: a
  // cheap arrival joining an older waiting request would change that request's
  // executable footprint under the broker and restart its wait.
  const batch: SingleStepProbe[] = [];
  let cost = 0;
  for (const probe of dueProbes) {
    if (isStepped(probe)) continue;
    batch.push(probe);
    cost = priceMethods(ns, probe.methods);
    break;
  }

  if (batch.length === 0) return;
  for (const probe of batch) runner.lastRunAt.set(probe.id, now);
  state.probeBatch = { ids: batch.map((p) => p.id), cost, budget: cost };

  const lease = acquire(cost, `batch:${batch.map((probe) => probe.id).join(',')}`);
  if (lease.status === 'queued') {
    // Placement moved under us between pricing and launching. Report it as a
    // skip against every member rather than a failure — nothing went wrong,
    // the RAM simply went elsewhere first. Each probe is reported at ITS OWN
    // price, not the batch's: telling the panel that `hacknet.core` costs the
    // whole batch's 13.2 GB would be a plain lie about that probe.
    for (const probe of batch) runner.lastRunAt.delete(probe.id);
    return;
  }

  let results: { id: string; emissions?: Emission[]; error?: string }[];
  try {
    results = await dodge(
      ns,
      async (stubNs) => {
        const out: { id: string; emissions?: Emission[]; error?: string }[] = [];
        for (const probe of batch) {
          // Per-probe isolation: ns.gang.* and ns.bladeburner.* throw outside
          // their BitNode, and one throw must not cost the whole batch.
          // Source: https://github.com/bitburner-official/bitburner-src/blob/3162fd2590e221eadd0c0fbd46151913f7c4c41c/src/NetscriptFunctions/Gang.ts#L18-L23 and https://github.com/bitburner-official/bitburner-src/blob/3162fd2590e221eadd0c0fbd46151913f7c4c41c/src/NetscriptFunctions/Bladeburner.ts#L30-L42
          try {
            out.push({ id: probe.id, emissions: await probe.run(stubNs, ctx) });
          } catch (error) {
            out.push({ id: probe.id, error: String(error) });
          }
        }
        return out;
      },
      cost,
      { host: lease.host },
    );
  } catch (error) {
    // The stub itself failed to launch or timed out — the whole batch is lost.
    for (const probe of batch) recordProbeFailure(state, probe.id, error);
    return;
  } finally {
    lease.release();
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

/** Run one stepped probe: a dodge per step, sequentially, accumulating into a
 * shared bag.
 *
 * Partial results are kept on purpose. A five-step probe whose last step is
 * unaffordable still learned four steps' worth, and emitting that beats
 * discarding it — the topics these write are `merge: true` digests, so a
 * missing field simply keeps its previous value. What must not happen is
 * silence: the step that did not fit is recorded with ITS price, so the panel
 * can say which half of the probe is blocked rather than reporting the whole
 * probe as unaffordable at a price no single stub was ever asked to pay. */
async function runSteppedProbe(
  ns: NS,
  runner: ProbeRunner,
  state: GameState,
  probe: SteppedProbe,
  ctx: ProbeContext,
  acquire: (budgetGb: number, id: string) => DodgeAcquire,
  now: number,
): Promise<void> {
  runner.lastRunAt.set(probe.id, now);
  const acc: ProbeAcc = {};
  let ran = 0;

  for (const step of probe.steps) {
    const cost = priceMethods(ns, step.methods);
    const lease = acquire(cost, `${probe.id}:${step.id}`);
    if (lease.status === 'queued') {
      // BREAK, not return: the steps that already ran spent real RAM, and this
      // function's contract (see the docstring) is that their partial digest is
      // published rather than discarded. Returning here silently threw away
      // everything the probe had already learned.
      runner.lastRunAt.delete(probe.id);
      break;
    }
    try {
      await dodge(ns, async (stubNs) => await step.run(stubNs, ctx, acc), cost, { host: lease.host });
      ran++;
    } catch (error) {
      // One step failing is not the probe failing: report it and keep what the
      // earlier steps learned.
      recordProbeFailure(state, `${probe.id}:${step.id}`, error);
      break;
    } finally {
      lease.release();
    }
  }

  if (ran > 0) {
    try {
      publish(state, probe.finish(acc), probe.merge ?? false);
      clearProbeFailure(state, probe.id);
    } catch (error) {
      recordProbeFailure(state, probe.id, error);
    }
  }

}

function lastRun(runner: ProbeRunner, id: string): number {
  return runner.lastRunAt.get(id) ?? 0;
}

function due(runner: ProbeRunner, id: string, everyMs: number, now: number): boolean {
  return now - lastRun(runner, id) >= everyMs;
}
