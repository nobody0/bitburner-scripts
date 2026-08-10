import type { NS, Player, Server } from "@ns";
import type { FeatureId } from "../../../shared/features/ids.ts";
import type { Capabilities } from "../../../shared/features/unlock.ts";
import type { StateKey, StateMap } from "../../../shared/telemetry/state-map.ts";
import type { GameState, Topics } from "../state.ts";
import { DODGED_PROBES } from "./dodged.ts";
import { LOCAL_PROBES } from "./local.ts";

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
 * dodge exists to avoid (spec/dodging.md).
 * Source: https://github.com/bitburner-official/bitburner-src/blob/3162fd2590e221eadd0c0fbd46151913f7c4c41c/src/Script/RamCalculations.ts#L405-L440 */

export interface ProbeContext {
  player: Player;
  servers: Record<string, Server>;
  caps: Capabilities;
  state: GameState;
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
   *  This used to be a lie. Acquisition only ran inside the 30 s fleet sweep, so
   *  30 s was the floor for every probe however small its `everyMs` — the local
   *  tier has always asked for 5 s and always got 30. Harmless while every
   *  subject changed on a minute scale, and actively wrong for one with a clock
   *  of its own: under-sampling a 6 s subject does not give a coarser signal, it
   *  gives a corrupted one, because a sample spanning several of its ticks
   *  reports their compounded effect as a single step. A probe declaring a fast
   *  cadence is making a claim about its SUBJECT, and it should be cheap enough
   *  to honour that claim. */
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

/** A dodged probe that reads everything in one stub launch. */
export interface SingleStepProbe extends ProbeBase {
  kind: "dodged";
  /** Fully-qualified ns methods called by `run`, exactly as
   *  ns.getFunctionRamCost expects them ("gang.getMemberInformation").
   *  Bitburner charges each distinct function once per script, so the probe's
   *  cost is the sum over this list however many times each is called.
   *  tests/features.test.ts checks every name against the type definitions.
   *  Source: https://github.com/bitburner-official/bitburner-src/blob/3162fd2590e221eadd0c0fbd46151913f7c4c41c/src/Netscript/NetscriptHelpers.tsx#L434-L448 */
  methods: string[];
  run(stubNs: NS, ctx: ProbeContext): Emission[] | Promise<Emission[]>;
}

/** Whatever a stepped probe carries between its steps. Deliberately untyped at
 * this layer — each probe owns its own shape and casts once, because typing it
 * generically would force the probe TABLE to become generic and every consumer
 * with it. */
export type ProbeAcc = Record<string, unknown>;

export interface DodgeStep {
  /** Reported when this step is the one that did not fit, so the UI can say
   *  WHICH half of a probe is unaffordable rather than just "the probe". */
  id: string;
  methods: string[];
  run(stubNs: NS, ctx: ProbeContext, acc: ProbeAcc): void | Promise<void>;
}

/** A dodged probe split across several stub launches.
 *
 * The reason this shape exists: a stub's RAM bill is the sum of every distinct
 * ns function it references, so nine singularity methods in one closure cost
 * ~33.5 GB even in BN4 — against a dodge budget pinned near 2.4 GB by the home
 * reserve. Split into one method per step, the PEAK cost becomes the largest
 * single step (~5 GB) instead of the sum, and the probe becomes affordable on
 * hardware where it never could have run.
 *
 * Steps run sequentially, each in its own dodge, accumulating into a shared
 * bag. What it cannot fix is one indivisible expensive call — a single
 * `SingularityFn3` at SF4 level 1 is 80 GB and no amount of splitting helps.
 * That is reported as an explicit blocker instead. */
export interface SteppedProbe extends ProbeBase {
  kind: "dodged";
  steps: DodgeStep[];
  /** Turn the accumulator into emissions.
   *
   *  MUST tolerate a PARTIAL accumulator: when a later step cannot be afforded
   *  the earlier ones have already run, and emitting what we learned beats
   *  discarding it. The skipped step is reported separately. */
  finish(acc: ProbeAcc): Emission[];
}

export type DodgedProbe = SingleStepProbe | SteppedProbe;

export function isStepped(probe: DodgedProbe): probe is SteppedProbe {
  return "steps" in probe;
}

/** Every ns method a probe can reach, whichever shape it has. */
export function probeMethods(probe: DodgedProbe): string[] {
  return isStepped(probe) ? probe.steps.flatMap((step) => step.methods) : probe.methods;
}

export type Probe = LocalProbe | DodgedProbe;

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
export { LOCAL_PROBES, DODGED_PROBES };

/** Every scheduled probe, both tiers. The one list `probeCadenceMs` is derived
 *  from, so the controller's acquisition interval cannot drift from the table. */
export const ALL_PROBES: readonly Probe[] = [...LOCAL_PROBES, ...DODGED_PROBES];
