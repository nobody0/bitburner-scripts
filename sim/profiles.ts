import { only, type FeatureOverrides } from "../shared/features/profile.ts";

/** Named simulation runs.
 *
 * A profile is the unit of "what question is this run asking". Two shapes:
 *
 *  - **BitNode runs** enable everything and ask how fast a target is reached.
 *  - **Feature-isolation runs** disable everything except the feature under
 *    test, and ask a goal that feature alone can move.
 *
 * Isolation is rarely a single feature. A faction run still needs hacking for
 * income and skill gain — the point is that nothing ELSE is allowed to
 * contribute, so the result is attributable. That is why `only()` takes a list. */

export interface SimProfile {
  id: string;
  description: string;
  /** Absent = every feature the save unlocks. */
  features?: FeatureOverrides;
  goals: string[];
  /** Duration string for --horizon. */
  horizon: string;
  seeds: number[];
  /** Registered save id (saves/index.json). Absent = fresh BN1 fixture. */
  save?: string;
  homeRam?: number;
}

export const PROFILES: readonly SimProfile[] = [
  {
    id: "bn1-speedrun",
    description: "Everything enabled: how fast does a fresh BN1 reach $1b?",
    goals: ["earn:1e9"],
    horizon: "8h",
    seeds: [1, 2, 3],
  },
  {
    id: "hacking-only",
    description: "Hacking in isolation: money earned per unit time, nothing else contributing.",
    features: only("hacking", "progression"),
    goals: ["earn:1e9"],
    horizon: "1h",
    seeds: [1, 2, 3],
  },
  {
    id: "hacking-early",
    description: "The first million, for fast A/B of dispatcher and targeting changes.",
    features: only("hacking", "progression"),
    goals: ["earn:1e6"],
    horizon: "1h",
    seeds: [1, 2, 3, 4, 5],
  },
  {
    id: "factions",
    description:
      "Faction progress with hacking as the only income and skill source. Needs a save with BN4/SF4 for reputation to be observable at all.",
    features: only("hacking", "factions", "career", "progression"),
    goals: ["faction:CyberSec"],
    horizon: "2h",
    seeds: [1, 2, 3],
  },
] as const;

export function findProfile(id: string): SimProfile {
  const profile = PROFILES.find((entry) => entry.id === id);
  if (!profile) {
    throw new Error(`unknown profile "${id}" (have: ${PROFILES.map((p) => p.id).join(", ")})`);
  }
  return profile;
}
