import type { NS, Player, Server } from "@ns";
import type { FeatureId } from "../../../shared/features/ids.ts";
import type { Capabilities } from "../../../shared/features/unlock.ts";
import type { StateKey, StateMap } from "../../../shared/telemetry/state-map.ts";
import type { NsProxy } from "../ns-proxy.ts";
import type { GameState, Topics } from "../state.ts";
import { PRICED_PROBES } from "./priced.ts";
import { DIRECT_PROBES } from "./direct.ts";
import { LOCAL_PROBES } from "./local.ts";

/** Feature probes: the read half of the feature axis. One probe collects the
 * state for one feature and returns typed topic emissions; the runner
 * (../probe-runner.ts) decides when to call it.
 *
 * Three tiers, by what a body is allowed to touch:
 *  - LOCAL   — derived from the sweep snapshot (player, servers). No ns call
 *              at all, so it always runs. Karma, skills, joined factions and
 *              fleet totals live here, so those panels are never empty.
 *  - DIRECT  — synchronous reads on main.js's own `ns`, every one of them
 *              re-verified 0 GB by the runner before it calls them.
 *  - PRICED  — everything with a price. The body awaits `ctx.nsp(path, ...)`,
 *              which runs the member on a resident script sized for it
 *              (../ns-proxy.ts), so nothing here is billed to main.js.
 *
 * A priced body names the member as a STRING PATH and never as a property.
 * Bitburner charges by member NAME across the whole bundle regardless of the
 * receiver, so `stubNs["gang"]["getGangInformation"]` billed main.js exactly
 * as a dotted call would have; only the string escapes the static parser. The
 * path is typed (`AutoPath`), so a wrong one is a compile error rather than a
 * probe that silently never runs — which is why probes no longer carry a
 * `methods` table for the runner to price against. The call IS the price now,
 * and the two cannot drift apart.
 * Source: https://github.com/bitburner-official/bitburner-src/blob/3162fd2590e221eadd0c0fbd46151913f7c4c41c/src/Script/RamCalculations.ts#L405-L440 */

export interface ProbeContext {
  player: Player;
  servers: Record<string, Server>;
  caps: Capabilities;
  state: GameState;
  /** The general-purpose ns resident. Every priced read a probe makes goes
   *  through here: the resident pays for each distinct member once, memoises
   *  it, and respawns into a bigger allocation when its budget fills — so a
   *  body may await as many members as the feature needs, in plain sequential
   *  code, without anything to declare or split. */
  nsp: NsProxy;
  /** `ns.enums`, the one ns PROPERTY a probe needs and the one thing the proxy
   *  cannot serve (it calls functions). It is 0 GB, so the runner reads it off
   *  main.js process's own ns and hands it down. `FactionName` is what lets the
   *  planner reason about factions it has not been invited to yet. */
  enums: NS["enums"];
}

/** A typed topic write. The mapped type keeps `key` and `data` in agreement,
 * so a probe cannot emit a gang payload under the "corp" key. */
export type Emission = { [K in StateKey]: { key: K; data: StateMap[K] } }[StateKey];

export function emit<K extends StateKey>(key: K, data: StateMap[K]): Emission {
  return { key, data } as Emission;
}

/** Emission from a probe declaring `merge: true`, which contributes only part
 * of a topic. Completeness is relaxed; field names and types are still checked
 * against the topic, so a renamed or misspelled field is a compile error
 * rather than a field the UI silently never finds. */
export function emitPartial<K extends StateKey>(key: K, data: Partial<StateMap[K]>): Emission {
  return { key, data } as Emission;
}

interface ProbeBase {
  /** Stable id, used for scheduling and in probe.* telemetry. */
  id: string;
  feature: FeatureId;
  /** Minimum interval between runs, and the SOLE authority on this probe's
   *  cadence. The controller derives its acquisition interval from the fastest
   *  value in the table (`probeCadenceMs`), so a feature that needs to be read
   *  every 4 s declares 4 s and gets it.
   *
   *  Acquisition runs on this derived cadence rather than inheriting the 30 s
   *  fleet sweep. Under-sampling a ticking subject compounds several changes
   *  into one observation, so fast declarations must also remain cheap. */
  everyMs: number;
  /** Skipped unless capabilities report this feature as "yes". Omit for
   *  probes that are themselves the source of capability information. */
  requires?: FeatureId;
  /** Extra gate for conditions the feature axis cannot express: a source-file
   *  requirement, or a one-shot latch on something already in the store.
   *  Returning false is "not applicable", NOT "unaffordable" — such a probe is
   *  never reported as skipped, because there is no price that would help. */
  when?(caps: Capabilities, topics: Topics): boolean;
  /** Shallow-merge this emission over the last one for the same key instead
   *  of replacing it. Several probes contribute to one topic at different
   *  cost tiers (the free `factions.joined` and the SF4-gated `standings`,
   *  say); without this the cheap one would clobber the expensive one every
   *  sweep. Merged fields are additive digests, so a stale field simply
   *  persists until its probe runs again — acceptable, and the alternative
   *  (a topic per tier) would fragment the UI's state. */
  merge?: boolean;
}

export interface LocalProbe extends ProbeBase {
  kind: "local";
  run(ctx: ProbeContext): Emission[];
}

/** Synchronous NS reads whose declared methods all cost exactly 0 GB. The
 * runner verifies that invariant against the live API before invoking them. */
export interface DirectProbe extends ProbeBase {
  kind: "direct";
  methods: string[];
  run(ns: NS, ctx: ProbeContext): Emission[];
}

/** A probe with a price: its body reads through `ctx.nsp` and may await as
 * many distinct members as the feature needs.
 *
 * The resident spends its RAM budget over its lifetime and respawns larger
 * when it fills, so a probe need only fit one member at a time and exposes no
 * partial-step contract. One indivisible expensive call remains a hard floor: a
 * `SingularityFn3` at SF4 level 1 is 80 GB, and that simply raises the floor
 * the resident's placer must satisfy before the call runs. */
export interface PricedProbe extends ProbeBase {
  kind: "priced";
  run(ctx: ProbeContext): Promise<Emission[]>;
}

export type Probe = LocalProbe | DirectProbe | PricedProbe;

/** The fastest cadence anything in the table asks for.
 *
 * The controller schedules acquisition from this rather than from a constant of
 * its own, so adding a probe that needs to be read every second needs no
 * controller change — and no probe's declared `everyMs` can be silently ignored
 * by a coarser caller. Each probe's own `everyMs` still gates it inside the pass,
 * so a 10-minute probe costs nothing extra for being scheduled alongside a 4 s
 * one. */
export function probeCadenceMs(probes: readonly Probe[]): number {
  return probes.reduce((fastest, probe) => Math.min(fastest, probe.everyMs), Infinity);
}

export { GATE_PROBE, type GateResult } from "./gates.ts";
export { LOCAL_PROBES, DIRECT_PROBES, PRICED_PROBES };

/** Every scheduled probe, both tiers. The one list `probeCadenceMs` is derived
 *  from, so the controller's acquisition interval cannot drift from the table. */
export const ALL_PROBES: readonly Probe[] = [...LOCAL_PROBES, ...DIRECT_PROBES, ...PRICED_PROBES];
