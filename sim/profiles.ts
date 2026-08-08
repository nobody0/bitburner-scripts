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
  /** BitNode to run in.
   *
   *  Load-bearing for the gated features: `deriveCapabilities` reports
   *  `factions: "no"` in BN1, so every faction probe and driver is switched
   *  off and a faction goal is unreachable no matter how long the run lasts.
   *  A faction isolation profile has to declare `bitnode: 4`. */
  bitnode?: number;
  startingMoney?: number;
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
    id: "factions-join",
    description:
      "Faction progress in BN4, with hacking as the only income and skill source. Joining CyberSec needs a backdoor on CSEC.",
    // BN4 is load-bearing, not a detail. In BN1 deriveCapabilities reports
    // `factions: "no"`, so every faction probe AND the driver are gated off
    // and the goal is unreachable however long the run lasts — which is what
    // the previous version of this profile silently did.
    bitnode: 4,
    features: only("hacking", "factions", "career", "progression"),
    goals: ["faction:CyberSec"],
    // Enough for TOR ($200k) plus BruteSSH ($500k), which CSEC's single
    // required port makes a hard precondition. A fresh BN4 start earns only
    // ~$240k in two hours, so without this the profile measures the money
    // grind rather than the faction logic — and an isolation profile exists
    // precisely to isolate the feature under test from that.
    startingMoney: 1_000_000,
    horizon: "2h",
    seeds: [1, 2, 3],
  },
  {
    id: "career-karma",
    description:
      "Career serving a posted karma need in isolation: how fast does crime reach the Slum Snakes threshold?",
    bitnode: 4,
    features: only("career", "factions", "progression"),
    goals: ["karma:-9"],
    horizon: "1h",
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
