import type { NS, Player, Server } from "@ns";
import type { FeatureId } from "../../../shared/features/ids.ts";
import type { Capabilities } from "../../../shared/features/unlock.ts";
import type { StateKey, StateMap } from "../../../shared/telemetry/state-map.ts";

/** Feature probes: the read half of the feature axis. One probe collects the
 * state for one feature and returns typed topic emissions; the runner
 * (../probe-runner.ts) decides when it can afford to call it.
 *
 * Cost tiers, because home RAM is the binding constraint:
 *  - LOCAL   — derived from the sweep snapshot (player, servers). No ns call,
 *              no dodge, always runs. Karma, skills, joined factions, fleet
 *              totals all live here, so those panels are never empty.
 *  - DODGED  — runs inside a dodge stub, priced with ns.getFunctionRamCost.
 *              The runner packs what fits the current budget and reports the
 *              rest as `probe.skipped`.
 *
 * A dodged probe body must call ns through BRACKET NOTATION on its own stub
 * ns (`stubNs["gang"]["getGangInformation"]()`); a dotted call would be seen
 * by the static RAM parser and charged to start.js, which is exactly what the
 * dodge exists to avoid (spec/dodging.md). */

export interface ProbeContext {
  player: Player;
  servers: Record<string, Server>;
  caps: Capabilities;
}

/** A typed topic write. The mapped type keeps `key` and `data` in agreement,
 * so a probe cannot emit a gang payload under the "corp" key. */
export type Emission = { [K in StateKey]: { key: K; data: StateMap[K] } }[StateKey];

export function emit<K extends StateKey>(key: K, data: StateMap[K]): Emission {
  return { key, data } as Emission;
}

interface ProbeBase {
  /** Stable id, used for scheduling and in probe.* telemetry. */
  id: string;
  feature: FeatureId;
  /** Minimum interval between runs. */
  everyMs: number;
  /** Skipped unless capabilities report this feature as "yes". Omit for
   *  probes that are themselves the source of capability information. */
  requires?: FeatureId;
}

export interface LocalProbe extends ProbeBase {
  kind: "local";
  run(ctx: ProbeContext): Emission[];
}

export interface DodgedProbe extends ProbeBase {
  kind: "dodged";
  /** Fully-qualified ns methods called by `run`, exactly as
   *  ns.getFunctionRamCost expects them ("gang.getMemberInformation").
   *  Bitburner charges each distinct function once per script, so the probe's
   *  cost is the sum over this list however many times each is called.
   *  tests/features.test.ts checks every name against the type definitions. */
  methods: string[];
  run(stubNs: NS, ctx: ProbeContext): Emission[] | Promise<Emission[]>;
}

export type Probe = LocalProbe | DodgedProbe;

export { GATE_PROBE, type GateResult } from "./gates.ts";
export { LOCAL_PROBES } from "./local.ts";
export { DODGED_PROBES } from "./dodged.ts";
