import { only, type FeatureOverrides } from "../shared/features/profile.ts";
import type { GameRunOptions } from "./game-run.ts";
import { AUGMENTATION_TABLE } from "./vendor/bitburner/src/Augmentation/AugmentationTable.ts";
import { calculateExp } from "./vendor/bitburner/src/PersonObjects/formulas/skill.ts";

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
  /** Focused synthetic initial conditions. Kept separate from the common CLI
   * fields so profiles can pose a precise cross-feature experiment without
   * teaching the simulator a magic scenario name. */
  world?: Pick<GameRunOptions, "network" | "person" | "playerState" | "factions" | "companies" | "bladeburnerRank" | "homeFiles">;
}

export const FACTION_DONATION_TARGET = "Synaptic Enhancement Implant";

const CYBERSEC_DONATION_WORLD: NonNullable<SimProfile["world"]> = {
  network: [
    {
      hostname: "faction-farm",
      hackDifficulty: 1,
      moneyAvailable: 1e12,
      requiredHackingSkill: 1,
      serverGrowth: 100,
      numOpenPortsRequired: 0,
      maxRam: 512,
    },
  ],
  person: {
    skills: { hacking: 1_000 },
    exp: { hacking: calculateExp(1_000) },
  },
  playerState: {
    factions: ["CyberSec"],
    augmentations: Object.values(AUGMENTATION_TABLE)
      .filter((aug) => aug.name !== FACTION_DONATION_TARGET && aug.name !== "NeuroFlux Governor")
      .map((aug) => ({ name: aug.name, level: 1 })),
  },
  factions: { CyberSec: { rep: 0, favor: 150 } },
};

const CYBERSEC_INSTALL_WORLD: NonNullable<SimProfile["world"]> = {
  ...CYBERSEC_DONATION_WORLD,
  playerState: {
    ...CYBERSEC_DONATION_WORLD.playerState,
    queuedAugmentations: [{ name: FACTION_DONATION_TARGET, level: 1 }],
  },
  // The queued package banks enough reputation to cross the donation gate.
  // This makes the reset economically meaningful rather than merely a smoke
  // test of installAugmentations.
  factions: { CyberSec: { rep: 100_000, favor: 149 } },
};

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
    // Calibrated to the default fixture's physics, not aspiration: its eight
    // servers top out around $12k/sec under a PERFECT joesguns farm, so the
    // old earn:1e9 was two orders of magnitude out of reach and the profile
    // produced no A/B gradient (every run: NOT reached). $5m is earned around
    // minute 40 by the current strategy — reliably reached, with most of the
    // hour left as headroom for targeting/prep improvements to show up in.
    goals: ["earn:5e6"],
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
    id: "factions-donation",
    description:
      "Hacking must close CyberSec's exact donation-plus-purchase cash gap; measures time to one augmentation breakpoint.",
    bitnode: 4,
    features: only("hacking", "factions", "progression"),
    goals: [`aug:${FACTION_DONATION_TARGET}`],
    homeRam: 256,
    startingMoney: 1.5e9,
    world: CYBERSEC_DONATION_WORLD,
    horizon: "30m",
    seeds: [1, 2, 3],
  },
  {
    id: "factions-install",
    description:
      "Faction + hacking install lifecycle: bank a favor breakpoint, prestige every reset-sensitive system, and restart the controller.",
    bitnode: 4,
    features: only("hacking", "factions", "progression"),
    goals: ["installs:1"],
    homeRam: 256,
    startingMoney: 1.5e9,
    world: CYBERSEC_INSTALL_WORLD,
    horizon: "10m",
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
  {
    id: "stock-only",
    description:
      "The market in isolation, in BN8 where it is the only income: how fast does $250m become $1b with hacking " +
      "switched off entirely? Answers 'does the trading model make money on its own', with no farm to confound it.",
    bitnode: 8,
    features: only("stock", "progression"),
    goals: ["earn:1e9"],
    horizon: "6h",
    seeds: [1, 2, 3],
    // BN8's starting money (Prestige.ts: BitNode8StartingMoney). Below roughly
    // this the $200k round trip dominates any position the bankroll can fund.
    startingMoney: 250e6,
  },
  {
    id: "stock-manipulation",
    description:
      "The market WITH the farm, in BN8 where hacked money is worth zero: does driving grow/hack at the held " +
      "symbol beat trading alone? The A/B against `stock-only` is the whole value of the hacking tie-in.",
    bitnode: 8,
    features: only("stock", "hacking", "progression"),
    goals: ["earn:1e9"],
    horizon: "6h",
    seeds: [1, 2, 3],
    startingMoney: 250e6,
  },
] as const;

export function findProfile(id: string): SimProfile {
  const profile = PROFILES.find((entry) => entry.id === id);
  if (!profile) {
    throw new Error(`unknown profile "${id}" (have: ${PROFILES.map((p) => p.id).join(", ")})`);
  }
  return profile;
}
