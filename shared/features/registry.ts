import type { MoneySource } from "@ns";
import type { StateKey } from "../telemetry/state-map.ts";
import { FEATURE_IDS, type FeatureId } from "./ids.ts";

/** The feature registry: the one list of separable optimization problems.
 *
 * A feature earns an entry when it can be optimized in isolation — its own
 * state, its own objective, its own simulator model — and rejoins the others
 * only through shared money and time. That is also why the list is derived
 * from the BitNodes: each node picks one feature, multiplies it, and asks you
 * to beat the game with it.
 *
 * Three consumers read this list:
 *  - ui/app builds its tab bar from it (order here == tab order),
 *  - game/lib/probes attaches each probe to a feature for gating + reporting,
 *  - sim/ will hang one model per feature off it.
 * Adding a feature is: an id in ./ids.ts, a topic in ../telemetry/topics/,
 * an entry here, a probe, and a tab. tests/features.test.ts enforces the set. */

export interface Feature {
  id: FeatureId;
  /** Tab label. */
  label: string;
  /** BitNodes whose theme is this feature. Drives the BitNode grid's labels. */
  bitnodes: number[];
  /** StateMap topics this feature owns. */
  topics: StateKey[];
  /** The isolated optimization problem in one line. This is the question a
   *  sim model for this feature has to answer. */
  problem: string;
  /** MoneySource fields attributable to this feature, for the Overview
   *  income breakdown. Expenses are included where the game tracks them
   *  separately (gang_expenses, hacknet_expenses). */
  moneySources: (keyof MoneySource)[];
  /** false when no ns API exists, so the UI can say so instead of showing an
   *  empty panel forever. */
  api: boolean;
}

export const FEATURES: readonly Feature[] = [
  {
    id: "progression",
    label: "BitNode",
    // BN12 (The Recursion) is the node *about* the reset loop itself. BN1 is
    // the unmodified baseline and belongs to hacking, which is all it has.
    bitnodes: [12],
    topics: ["progression", "capabilities"],
    problem:
      "Choose the BitNode destroy order and the augmentation/reset cadence that minimises total wall-clock to a target source-file set.",
    moneySources: ["augmentations"],
    api: true,
  },
  {
    id: "hacking",
    label: "Hacking",
    // BN1 is pure hacking with no other system unlocked; BN5's intelligence
    // feeds the hack formulas directly through intBonus.
    bitnodes: [1, 5],
    topics: ["servers", "farm", "fleet"],
    problem:
      "Maximise $/sec/GB across the rooted fleet: pick a target, hold it at min security and max money, and spend every free gigabyte on it.",
    moneySources: ["hacking", "servers"],
    api: true,
  },
  {
    id: "factions",
    label: "Factions",
    bitnodes: [4],
    topics: ["factions"],
    problem:
      "Reach a target augmentation set in the least wall-clock, trading faction work against donations against grafting.",
    moneySources: [],
    api: true,
  },
  {
    id: "career",
    label: "Career",
    bitnodes: [11],
    topics: ["career"],
    problem:
      "Reach the stat, karma and company-rep thresholds other features depend on (gang needs -54k karma; Bladeburner needs 100 in every combat stat) as fast as possible, using crime as early income.",
    moneySources: ["crime", "work", "class"],
    api: true,
  },
  {
    id: "hacknet",
    label: "Hacknet",
    bitnodes: [9],
    topics: ["hacknet"],
    problem:
      "Buy the node or level/RAM/core upgrade with the fastest ROI that still repays before the run horizon, competing with other income investments in the same unit.",
    moneySources: ["hacknet", "hacknet_expenses"],
    api: true,
  },
  {
    id: "stock",
    label: "Stocks",
    bitnodes: [8],
    topics: ["stock"],
    problem:
      "Allocate capital across symbols for the most money at the END OF THE RUN, net of the spread, the commission and the 75-tick regime cycle — and steer the hacking farm's hack/grow at the symbols held, since those move prices.",
    moneySources: ["stock"],
    api: true,
  },
  {
    id: "gang",
    label: "Gang",
    bitnodes: [2],
    topics: ["gang"],
    problem:
      "Assign each member to a task and schedule ascensions and equipment so respect, money and territory grow without the wanted-level penalty eating the gains.",
    moneySources: ["gang", "gang_expenses"],
    api: true,
  },
  {
    id: "corp",
    label: "Corp",
    bitnodes: [3],
    topics: ["corp"],
    problem:
      "Sequence divisions, offices, warehouses, research and investment rounds to maximise valuation, then dividends, per real-time cycle.",
    moneySources: ["corporation"],
    api: true,
  },
  {
    id: "bladeburner",
    label: "Bladeburner",
    bitnodes: [6, 7],
    topics: ["bladeburner"],
    problem:
      "Pick the action sequence that climbs rank fastest without dying, spending skill points and managing stamina and city chaos.",
    moneySources: ["bladeburner"],
    api: true,
  },
  {
    id: "sleeves",
    label: "Sleeves",
    bitnodes: [10],
    topics: ["sleeves"],
    problem:
      "Assign N sleeves across recovery, synchronisation, crime and faction work, accounting for source-accurate shock, sync and target exclusivity.",
    moneySources: ["sleeves"],
    api: true,
  },
  {
    id: "go",
    label: "Go",
    bitnodes: [14],
    topics: ["go"],
    problem:
      "Maximise subnet score with rules-correct adversarial search plus parity-proven seeded AI forecasts, then farm the bonus worth most to other features.",
    moneySources: [],
    api: true,
  },
  {
    id: "stanek",
    label: "Stanek",
    bitnodes: [13],
    topics: ["stanek"],
    problem:
      "Pack the chosen fragments into the gift grid (2D bin packing with rotation), then schedule charging so the fragments that matter reach high charge first.",
    moneySources: [],
    api: true,
  },
  {
    id: "dnet",
    label: "Darknet",
    bitnodes: [15],
    topics: ["dnet"],
    problem:
      "Traverse the darknet graph by depth, spending stasis links and charisma to keep servers authenticated while instability rises.",
    moneySources: [],
    api: true,
  },
  {
    id: "side",
    label: "Side",
    bitnodes: [],
    topics: ["side"],
    problem:
      "Solve every coding contract in low-RAM batches and quarantine the first rejected answer for diagnosis without risking another attempt.",
    moneySources: ["codingcontract"],
    api: true,
  },
];

/** The feature a BitNode is themed around, if any. */
export function featureForBitNode(n: number): Feature | undefined {
  return FEATURES.find((f) => f.bitnodes.includes(n));
}

export { FEATURE_IDS, type FeatureId };
