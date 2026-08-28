import type { NS } from "@ns";
import { nsp } from "./proxies.ts";
import {
  PRICED_PROBES,
  DIRECT_PROBES,
  GATE_PROBE,
  LOCAL_PROBES,
  type PricedProbe,
  type DirectProbe,
  type Emission,
  type ProbeContext,
} from "./probes/index.ts";
import {
  caps,
  clearProbeFailure,
  merge,
  recordProbeFailure,
  set,
  type GameState,
} from "./state.ts";

/** State acquisition: the read half of the feature axis.
 *
 * This runs unconditionally, in every build. It writes what it reads into the
 * game-state store (./state.ts) and never touches telemetry — a --perf build
 * probes exactly as hard as a telemetry build, because the controller gates
 * feature drivers on the capabilities this produces. Sending the results is
 * ./telemetry-sink.ts's job and nobody else's.
 *
 * Budget arithmetic and placement belong to the ns resident (./ns-proxy.ts),
 * which carries its own broker lease, prices members on first call, and
 * respawns larger when needed. A pass therefore selects probes whose `everyMs`
 * is due, and a probe body remains ordinary sequential code.
 *
 * What survives is the ISOLATION. A probe's failure is recorded against that
 * probe and costs its neighbours nothing — which matters because ns.gang.*,
 * ns.bladeburner.*, ns.grafting.*, ns.stock.getPosition and
 * ns.getBitNodeMultipliers throw rather than returning empty when the BitNode
 * does not offer them. */

export interface ProbeRunner {
  readonly lastRunAt: Map<string, number>;
}

export function initProbeRunner(): ProbeRunner {
  return { lastRunAt: new Map() };
}

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
 * them every few seconds would learn nothing. And it must run where the
 * controller can act on what changed — the reset walk keys off the capability
 * delta this produces, and a node change detected outside the sweep would leave
 * the fleet, the heap and every cached decision describing a game that no longer
 * exists. */
export async function runGateProbe(state: GameState): Promise<void> {
  try {
    const gates = await GATE_PROBE.run(nsp);
    set(state, "capabilities", gates.caps);
    if (gates.progression) merge(state, "progression", gates.progression);
    if (gates.failures.length > 0) recordProbeFailure(state, GATE_PROBE.id, gates.failures.join(", "));
    else clearProbeFailure(state, GATE_PROBE.id);
  } catch (error) {
    recordProbeFailure(state, GATE_PROBE.id, error);
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
 * `runGateProbe`. */
export async function runProbes(
  ns: NS,
  runner: ProbeRunner,
  state: GameState,
): Promise<void> {
  const servers = state.topics.servers;
  const player = state.topics.player;
  if (!servers || !player) return;

  const now = Date.now();
  // `enums` is the one ns PROPERTY a probe needs and the only thing the proxy
  // cannot serve — it calls functions. It is 0 GB, so main.js reads it off its
  // own ns here and hands it down rather than paying a resident round trip.
  const ctx: ProbeContext = { player, servers, caps: caps(state), state, nsp, enums: ns["enums"] };
  const applicable = (probe: PricedProbe | DirectProbe | (typeof LOCAL_PROBES)[number]): boolean => {
    // A probe never runs while its OWN feature reads "no". Mirrors the same
    // rule in selectDue: `requires` is a dependency, this is the feature
    // itself, and without it an isolation profile would still probe features it
    // switched off. No-op in the real game, where the always-playable features
    // read "yes" unconditionally.
    if (ctx.caps.unlocked[probe.feature] === "no") return false;
    if (probe.requires && ctx.caps.unlocked[probe.requires] !== "yes") return false;
    return probe.when ? probe.when(ctx.caps, state.topics) : true;
  };

  // Local probes: no ns, no excuse for an empty panel.
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
  // overrunning main.js's allocation.
  for (const probe of DIRECT_PROBES) {
    if (!due(runner, probe.id, probe.everyMs, now) || !applicable(probe)) continue;
    runner.lastRunAt.set(probe.id, now);
    try {
      // Free functions return 0; an unknown name throws because
      // getFunctionRamCost asks getRamCost to reject undefined paths.
      // Source: https://github.com/bitburner-official/bitburner-src/blob/3162fd2590e221eadd0c0fbd46151913f7c4c41c/src/NetscriptFunctions.ts#L1501-L1507
      const priced = probe.methods.map((method) => {
        try {
          return [method, ns.getFunctionRamCost(method)] as const;
        } catch {
          return [method, NaN] as const;
        }
      });
      const costly = priced.find(([, cost]) => cost !== 0);
      if (costly) throw new Error(`direct probe method ${costly[0]} costs ${costly[1]}GB`);
      publish(state, probe.run(ns, ctx), probe.merge ?? false);
      clearProbeFailure(state, probe.id);
    } catch (error) {
      recordProbeFailure(state, probe.id, error);
    }
  }

  // Earliest-deadline-first so a cheap 30 s probe cannot starve behind an
  // expensive 10 min one. Every due probe runs, in that order: the resident
  // sizes itself to whatever a body asks for, so there is nothing left to pack
  // and nothing to defer to a later pass.
  const dueProbes = PRICED_PROBES.filter((probe) => due(runner, probe.id, probe.everyMs, now) && applicable(probe)).sort(
    (a, b) => lastRun(runner, a.id) + a.everyMs - (lastRun(runner, b.id) + b.everyMs),
  );

  const ranIds: string[] = [];
  for (const probe of dueProbes) {
    runner.lastRunAt.set(probe.id, now);
    ranIds.push(probe.id);
    try {
      // One probe, one try/catch: a throw from ns.gang.*/ns.bladeburner.*
      // outside its BitNode fails only this probe and never a neighbour's.
      publish(state, await probe.run(ctx), probe.merge ?? false);
      clearProbeFailure(state, probe.id);
    } catch (error) {
      recordProbeFailure(state, probe.id, error);
    }
  }
  if (ranIds.length > 0) state.probeBatch = { ids: ranIds };
}

function lastRun(runner: ProbeRunner, id: string): number {
  return runner.lastRunAt.get(id) ?? 0;
}

function due(runner: ProbeRunner, id: string, everyMs: number, now: number): boolean {
  return now - lastRun(runner, id) >= everyMs;
}
