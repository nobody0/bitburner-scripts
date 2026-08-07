import { FEATURE_IDS, type FeatureId } from "./ids.ts";
import type { Capabilities, UnlockState } from "./unlock.ts";

/** Injected feature switches — the seam that lets a simulation isolate one
 * feature, or force one on that the save has not unlocked.
 *
 * In the real game this map is empty and capabilities come entirely from what
 * the gate batch can see. A simulation supplies it to ask a narrower question:
 * "how far does hacking alone get in an hour", or "what does a faction run look
 * like given only hacking income and skill gain".
 *
 * This is a DECISION, not telemetry. It is applied inside caps() in
 * game/lib/state.ts, so the feature drivers, the probe gating and the UI all
 * see one consistent answer — and it must never be compiled out of a --perf
 * build, or the two builds would play different games.
 * tests/build-perf.test.ts pins that. */

export type FeatureOverride = "on" | "off";
export type FeatureOverrides = Partial<Record<FeatureId, FeatureOverride>>;

const REASON_OFF = "disabled by simulation profile";
const REASON_ON = "forced on by simulation profile";

/** Overlay overrides onto derived capabilities. Pure, and returns a new object
 * so the underlying probe reading stays intact — the UI can still show what
 * the save actually has, alongside what this run was allowed to use. */
export function applyOverrides(caps: Capabilities, overrides?: FeatureOverrides): Capabilities {
  if (!overrides) return caps;
  const keys = Object.keys(overrides) as FeatureId[];
  if (keys.length === 0) return caps;

  const unlocked = { ...caps.unlocked } as Record<FeatureId, UnlockState>;
  const reason = { ...caps.reason };
  for (const id of keys) {
    const override = overrides[id];
    if (override === "off") {
      unlocked[id] = "no";
      reason[id] = REASON_OFF;
    } else if (override === "on") {
      unlocked[id] = "yes";
      delete reason[id];
      // Recorded even though it is not a lock, because a forced-on feature
      // whose save cannot really play it is exactly the kind of thing that
      // makes a run's numbers unexplainable later.
      if (caps.unlocked[id] !== "yes") reason[id] = REASON_ON;
    }
  }
  return { ...caps, unlocked, reason };
}

/** Overrides that disable everything except the listed features. The listed
 * ones are left alone rather than forced on: a faction run needs factions to
 * be genuinely unlocked by the save, not pretended into existence. */
export function only(...enabled: FeatureId[]): FeatureOverrides {
  const keep = new Set(enabled);
  const overrides: FeatureOverrides = {};
  for (const id of FEATURE_IDS) {
    if (!keep.has(id)) overrides[id] = "off";
  }
  return overrides;
}

export function describeOverrides(overrides?: FeatureOverrides): string {
  if (!overrides) return "all features";
  const on = (Object.keys(overrides) as FeatureId[]).filter((id) => overrides[id] === "on");
  const off = (Object.keys(overrides) as FeatureId[]).filter((id) => overrides[id] === "off");
  const enabled = FEATURE_IDS.filter((id) => overrides[id] !== "off");
  if (off.length > 0) return `only ${enabled.join(", ")}${on.length > 0 ? ` (forced: ${on.join(", ")})` : ""}`;
  return on.length > 0 ? `all features (forced: ${on.join(", ")})` : "all features";
}
