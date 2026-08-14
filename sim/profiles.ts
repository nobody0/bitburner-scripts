import { only, type FeatureOverrides } from "../shared/features/profile.ts";
import type { GameRunOptions } from "./game-run.ts";
import { AUGMENTATION_TABLE } from "./vendor/bitburner/src/Augmentation/AugmentationTable.ts";
import { calculateExp } from "./vendor/bitburner/src/PersonObjects/formulas/skill.ts";
import { VANILLA_NETWORK } from "./network.ts";
import type { ExperimentClass, RouteLegIdentity } from "../shared/experiment.ts";

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
  /** Route benchmarks produce promotable speedrun evidence. Feature scenarios
   * are deliberately synthetic pressure/recovery experiments. */
  experiment: ExperimentClass;
  /** Required only for route benchmarks. The entrance save remains overridable
   * with `--save`, so alternate checkpoints and completion orders need no code
   * changes. */
  route?: RouteLegIdentity;
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
  world?: Pick<GameRunOptions, "network" | "topology" | "homeIp" | "augmentationStats" | "person" | "playerState" | "factions" | "companies" | "bladeburnerRank" | "homeFiles">;
}

export const FACTION_DONATION_TARGET = "Synaptic Enhancement Implant";

/** One valid upstream roll for the randomized UCM augmentation. */
const UCM_FIXTURE_ROLL = {
  company_rep: 1.25,
  faction_rep: 1.15,
  work_money: 1.7,
} as const;

function augmentationMultiplierSnapshot(
  names: readonly string[],
  randomEffects: Readonly<Record<string, number>> = {},
): Record<string, number> {
  const result: Record<string, number> = {};
  for (const name of names) {
    const aug = AUGMENTATION_TABLE[name];
    if (!aug || aug.multsUnknown) continue;
    for (const [field, value] of Object.entries(aug.mults)) {
      result[field] = (result[field] ?? 1) * value;
    }
  }
  for (const [field, value] of Object.entries(randomEffects)) {
    result[field] = (result[field] ?? 1) * value;
  }
  return result;
}

const CYBERSEC_DONATION_AUGMENTATIONS = Object.values(AUGMENTATION_TABLE)
  // This fixture tests an ordinary economic install. An installed Red Pill
  // would put the real planner in its no-extra-resets daemon-regrow phase.
  .filter((aug) =>
    aug.name !== FACTION_DONATION_TARGET
    && aug.name !== "NeuroFlux Governor"
    && aug.name !== "The Red Pill"
  )
  .map((aug) => ({ name: aug.name, level: 1 }));

const CYBERSEC_DONATION_MULTS = augmentationMultiplierSnapshot(
  CYBERSEC_DONATION_AUGMENTATIONS.map((aug) => aug.name),
  UCM_FIXTURE_ROLL,
);

const CYBERSEC_DONATION_WORLD: NonNullable<SimProfile["world"]> = {
  augmentationStats: { "Unstable Circadian Modulator": UCM_FIXTURE_ROLL },
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
    // Synthetic skill and experience must describe the same reachable state.
    // The simulator will derive the installed augmentation multiplier below.
    exp: { hacking: calculateExp(1_000, CYBERSEC_DONATION_MULTS.hacking) },
  },
  playerState: {
    factions: ["CyberSec"],
    augmentations: CYBERSEC_DONATION_AUGMENTATIONS,
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

/** Multi-install fixture. Owns NOTHING (an aug-saturated world makes later
 * installs objectively worthless, and the cadence rule then correctly
 * refuses them — the first version of this fixture proved exactly that).
 * Instead reputation is BANKED at three factions, so each cycle has a real
 * set of multiplier augmentations to convert and an install that is
 * genuinely optimal: cycle 1 sweeps CyberSec on the starting bankroll,
 * cycles 2-3 rejoin the city factions, earn the join cash, and convert the
 * banked rep as soon as the accrued value clears the cadence threshold. */
const CYBERSEC_CADENCE_WORLD: NonNullable<SimProfile["world"]> = {
  ...CYBERSEC_INSTALL_WORLD,
  // This is a cadence/transaction fixture, not a reputation-throughput
  // benchmark. Keep its second cross-prestige package short enough that the
  // test does not encode the old policy of forcing a tiny install at Tian Di
  // Hui instead of continuing into a worthwhile runner.
  person: {
    ...CYBERSEC_INSTALL_WORLD.person,
    exp: { hacking: calculateExp(1_000) },
    mults: { faction_rep: 10 },
  },
  playerState: {
    ...CYBERSEC_INSTALL_WORLD.playerState,
    augmentations: [],
  },
  factions: {
    CyberSec: { rep: 100_000, favor: 149 },
    "Sector-12": { rep: 60_000, favor: 0 },
    Aevum: { rep: 50_000, favor: 0 },
    // Favor is permanent even before membership. Cycle 2 joins Tian Di Hui,
    // earns the small exact crossing, then exercises a second reset without
    // relying on reputation that prestige must erase.
    "Tian Di Hui": { rep: 0, favor: 149.9 },
  },
};

/** Cross-node stock fixture. This is a reachable mid-run BN5 state rather than
 * free market access: the controller must decide whether WSE + TIX are worth
 * their real $5.2b cost. Every omega-net field is a vendored upstream value
 * (the midpoint where upstream declares a range), and the paired profiles
 * differ only by whether the stock feature is enabled. */
const BN5_STOCK_WORLD: NonNullable<SimProfile["world"]> = {
  network: [
    {
      hostname: "omega-net",
      organizationName: "Omega Software",
      hackDifficulty: 30,
      moneyAvailable: 65_000_000,
      requiredHackingSkill: 200,
      serverGrowth: 35,
      numOpenPortsRequired: 2,
      maxRam: 32,
    },
  ],
  person: {
    skills: { hacking: 300 },
    exp: { hacking: calculateExp(300) },
  },
  homeFiles: ["BruteSSH.exe", "FTPCrack.exe"],
};

/** Reachable mid-BN1 state with SF4/SF14 and one real queued reset. UCM is
 * installed with the explicit roll above so the simulator never invents it. */
const BN1_PROGRESSION_WORLD: NonNullable<SimProfile["world"]> = {
  ...VANILLA_NETWORK,
  network: [
    ...VANILLA_NETWORK.network,
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
  topology: {
    ...VANILLA_NETWORK.topology,
    home: [...(VANILLA_NETWORK.topology.home ?? []), "faction-farm"],
    "faction-farm": ["home"],
  },
  person: {
    skills: { hacking: 100 },
    exp: { hacking: calculateExp(100) },
    mults: augmentationMultiplierSnapshot(["Unstable Circadian Modulator"], UCM_FIXTURE_ROLL),
  },
  playerState: {
    factions: ["CyberSec", "Sector-12", "Tian Di Hui"],
    augmentations: [{ name: "Unstable Circadian Modulator", level: 1 }],
    queuedAugmentations: [{ name: "Synaptic Enhancement Implant", level: 1 }],
    sourceFiles: { "4": 3, "14": 3 },
  },
  factions: {
    CyberSec: { rep: 100_000, favor: 149 },
    "Sector-12": { rep: 60_000, favor: 0 },
    "Tian Di Hui": { rep: 50_000, favor: 0 },
  },
};

/** Late-game JIT fixture retaining the final package, Daedalus, Red Pill
 * install, and post-install world-daemon regrow phases. This is deliberately
 * separate from bn1-full, whose contract is a cold 8 GB bootstrap. */
const BN1_LATE_INSTALLED = [
  ...Object.values(AUGMENTATION_TABLE)
    .filter((aug) => !aug.isSpecial && (aug.mults.hacking ?? 1) > 1)
    .map((aug) => aug.name),
  // Gen V requires Gen IV, which has no hacking multiplier itself.
  "Cranial Signal Processors - Gen IV",
  // Avoid querying an unknown randomized UCM roll.
  "Unstable Circadian Modulator",
] as const;

const JIT_LATEGAME_WORLD: NonNullable<SimProfile["world"]> = {
  ...VANILLA_NETWORK,
  augmentationStats: { "Unstable Circadian Modulator": UCM_FIXTURE_ROLL },
  person: {
    skills: { hacking: 1_500 },
    exp: {
      hacking: calculateExp(
        1_500,
        augmentationMultiplierSnapshot(BN1_LATE_INSTALLED, UCM_FIXTURE_ROLL).hacking,
      ),
    },
    mults: augmentationMultiplierSnapshot(BN1_LATE_INSTALLED, UCM_FIXTURE_ROLL),
  },
  playerState: {
    factions: ["BitRunners"],
    augmentations: BN1_LATE_INSTALLED.map((name) => ({ name, level: 1 })),
    queuedAugmentations: ["DataJack", "ADR-V2 Pheromone Gene", "Neuroreceptor Management Implant"]
      .map((name) => ({ name, level: 1 })),
    sourceFiles: { "4": 3, "14": 3 },
  },
  factions: {
    BitRunners: { rep: 2_000_000, favor: 0 },
    Daedalus: { rep: 0, favor: 0 },
  },
};


/** Full first-route benchmark: a genuinely fresh BN1 save fixture. It grants
 * no earned Source Files, augmentations, money, skill, reputation, fleet or
 * home upgrades. The controller harness separately applies the declared SF4.3
 * automation allowance; unlike the older calibration fixture, it grants no
 * SF14 policy/reward advantage. */
const BN1_FULL_WORLD: NonNullable<SimProfile["world"]> = {
  ...VANILLA_NETWORK,
  augmentationStats: { "Unstable Circadian Modulator": UCM_FIXTURE_ROLL },
};

/** Same cold BN1 benchmark with the exact persistent benefit granted by
 * SF12.30: one installed NeuroFlux object at level 30 and its multiplier
 * applied thirty times. This is a calibration accelerator, not a planner
 * shortcut; all money, skills, reputation, programs and infrastructure still
 * start from prestige state and the real controller sees ordinary APIs. */
const SF12_CALIBRATION_LEVEL = 30;
const BN1_FULL_SF12_30_WORLD: NonNullable<SimProfile["world"]> = {
  ...BN1_FULL_WORLD,
  person: {
    mults: augmentationMultiplierSnapshot(
      Array.from({ length: SF12_CALIBRATION_LEVEL }, () => "NeuroFlux Governor"),
    ),
  },
  playerState: {
    sourceFiles: { "4": 3, "12": SF12_CALIBRATION_LEVEL, "14": 3 },
    augmentations: [{ name: "NeuroFlux Governor", level: SF12_CALIBRATION_LEVEL }],
  },
};

/** Synthetic late-game JIT laboratory. Unlike the BN profiles this removes
 * game RAM as the limiting factor entirely, so live worker count — the
 * quantity that motivates HGW and pooled workers — becomes observable on its
 * own. Kept as a TIER-1 pressure profile: `sim/tests/scenario-jit-stress.test.ts`
 * covers the same benchmarks in seconds, but only at small scale, and the
 * process-count behaviour it cannot reach is exactly what this exists for. */
const JIT_PROCESS_PRESSURE_WORLD: NonNullable<SimProfile["world"]> = {
  network: [{
    hostname: "jit-pressure",
    organizationName: "JIT process-pressure laboratory",
    hackDifficulty: 90,
    moneyAvailable: 1e12,
    requiredHackingSkill: 900,
    serverGrowth: 100,
    numOpenPortsRequired: 0,
    maxRam: 0,
    // The constructor roll derives minDifficulty=30 and moneyMax=$25t. This
    // is a prepared late-game snapshot of that same server, not a different
    // formula or a sim-only controller branch.
    currentDifficulty: 30,
    currentMoney: 25e12,
  }],
  person: {
    skills: { hacking: 1_000 },
    exp: { hacking: calculateExp(1_000) },
  },
};

export const PROFILES: readonly SimProfile[] = [
  {
    id: "bn1-speedrun",
    experiment: "feature-scenario",
    description: "Synthetic early-game fixture: how fast does the small deterministic BN1 network reach $1b?",
    goals: ["earn:1e9"],
    horizon: "8h",
    seeds: [1, 2, 3],
  },
  {
    id: "bn1-progression",
    experiment: "feature-scenario",
    description:
      "Mid-BN1 route across three installs: reach 13 augmentations while Go follows the changing reputation and income bottlenecks.",
    bitnode: 1,
    features: only("hacking", "factions", "progression", "go"),
    // Prevent low-value resets from satisfying the install count alone.
    goals: ["augs:13", "installs:3"],
    homeRam: 256,
    startingMoney: 1.5e9,
    world: BN1_PROGRESSION_WORLD,
    horizon: "3h",
    seeds: [1, 2, 3],
  },
  {
    id: "bn1-full",
    experiment: "bitnode-route",
    route: { route: "all-source-files-3", leg: "bn1-first", index: 0, bitNode: 1 },
    description:
      "Complete BN1 cold start on the fixed vanilla network: bootstrap from 8 GB through strategy-chosen installs and the actual w0r1d_d43m0n transition, with the declared SF4.3 automation allowance.",
    bitnode: 1,
    // Full-route benchmark: career must be live because city, karma, kills and
    // combat gates are genuine competing faction paths. Disabling it makes
    // the optimiser solve a smaller game and invalidates route timing.
    // Full mechanically playable BN1 surface for this save. `only` does not
    // force any capability on; it merely excludes the currently unmodelled
    // node-specific systems. Hacknet, the market and side income are universal
    // systems and must compete with hacking/career in a full-node benchmark.
    // `side` stays excluded until coding-contract generation is modeled; the
    // simulator correctly reports that oracle-only subsystem as unmodeled.
    features: only("hacking", "factions", "progression", "go", "career", "hacknet", "stock"),
    goals: ["bn:1", "installs:2"],
    homeRam: 8,
    world: BN1_FULL_WORLD,
    horizon: "24h",
    seeds: [1, 2, 3],
  },
  {
    id: "bn1-full-sf12-30",
    experiment: "feature-scenario",
    description:
      "Full BN1 calibration run with the exact free NeuroFlux level and multipliers granted by SF12.30.",
    bitnode: 1,
    features: only("hacking", "factions", "progression", "go", "career", "hacknet", "stock"),
    goals: ["bn:1", "installs:2"],
    homeRam: 8,
    world: BN1_FULL_SF12_30_WORLD,
    horizon: "24h",
    seeds: [1],
  },
  {
    id: "jit-lategame",
    experiment: "feature-scenario",
    description:
      "Late-game fixture with large home RAM; validates Red Pill and JIT regrowth lifecycle, not process-pressure mode thresholds.",
    bitnode: 1,
    features: only("hacking", "factions", "progression", "go"),
    goals: ["bn:1", "installs:2"],
    homeRam: 32_768,
    startingMoney: 1e11,
    world: JIT_LATEGAME_WORLD,
    horizon: "2.7h",
    seeds: [1, 2, 3],
  },
  {
    id: "jit-process-pressure",
    experiment: "feature-scenario",
    description:
      "Synthetic late-game JIT laboratory: game RAM is abundant and a long high-security pipeline stresses live worker count, HGW, and pooling.",
    bitnode: 1,
    features: only("hacking", "progression"),
    goals: ["earn:1e12"],
    homeRam: 134_217_728,
    world: JIT_PROCESS_PRESSURE_WORLD,
    horizon: "12m",
    seeds: [1],
  },
  {
    id: "hacking-early",
    experiment: "feature-scenario",
    description: "The first million, for fast A/B of dispatcher and targeting changes.",
    features: only("hacking", "progression"),
    goals: ["earn:1e6"],
    horizon: "1h",
    seeds: [1, 2, 3, 4, 5],
  },
  {
    id: "bn5-hacking",
    experiment: "feature-scenario",
    description:
      "BN5 control: hacking alone grows a $12b mid-run bankroll to $20b on the vendored omega-net midpoint.",
    bitnode: 5,
    features: only("hacking", "progression"),
    goals: ["wealth:20e9"],
    horizon: "12h",
    seeds: [1, 2, 3],
    startingMoney: 12e9,
    homeRam: 512,
    world: BN5_STOCK_WORLD,
  },
  {
    id: "bn5-hacking-stock",
    experiment: "feature-scenario",
    description:
      "BN5 treatment: the identical hacking run may buy and trade stocks through the shared money arbiter.",
    bitnode: 5,
    features: only("hacking", "stock", "progression"),
    goals: ["wealth:20e9"],
    horizon: "12h",
    seeds: [1, 2, 3],
    startingMoney: 12e9,
    homeRam: 512,
    world: BN5_STOCK_WORLD,
  },
  {
    id: "factions-join",
    experiment: "feature-scenario",
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
    experiment: "feature-scenario",
    description:
      "Hacking must close CyberSec's exact donation cash gap; the unlocked augmentation stays banked until an end-loaded install sweep.",
    bitnode: 4,
    features: only("hacking", "factions", "progression"),
    // Above the augmentation's 2,000-rep breakpoint so the run records the
    // donation that crosses it rather than stopping on the preceding work
    // sample; still no purchase is needed or permitted before an install.
    goals: ["rep:CyberSec:3000"],
    homeRam: 256,
    startingMoney: 1.5e9,
    world: CYBERSEC_DONATION_WORLD,
    horizon: "30m",
    seeds: [1, 2, 3],
  },
  {
    id: "factions-install",
    experiment: "feature-scenario",
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
    id: "install-cadence",
    experiment: "feature-scenario",
    description:
      "Two consecutive install resets on the banked-rep fixture: prestige soundness and the install-vs-push cadence at speed.",
    bitnode: 4,
    // The second-cycle packages include city factions. Career owns travel and
    // therefore has to participate; otherwise the faction planner correctly
    // rejects those packages as impossible and this is no longer a cadence
    // experiment.
    features: only("hacking", "factions", "career", "progression"),
    goals: ["installs:2"],
    homeRam: 256,
    startingMoney: 1.5e9,
    world: CYBERSEC_CADENCE_WORLD,
    // Cycle 1 converts the banked rep immediately. Cycle 2 rejoins Tian Di Hui,
    // earns a real permanent-favor crossing, and converts its package.
    horizon: "125m",
    seeds: [1, 2, 3],
  },
  {
    id: "career-karma",
    experiment: "feature-scenario",
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
    experiment: "feature-scenario",
    description:
      "The market in isolation, in BN8 where it is the only income: how fast does $250m become $1b with hacking " +
      "switched off entirely? Answers 'does the trading model make money on its own', with no farm to confound it.",
    bitnode: 8,
    features: only("stock", "progression"),
    goals: ["wealth:1e9"],
    horizon: "8h",
    seeds: [1, 2, 3],
    // BN8's starting money (Prestige.ts: BitNode8StartingMoney). Below roughly
    // this the $200k round trip dominates any position the bankroll can fund.
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
