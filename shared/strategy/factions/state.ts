import type { PlayerRequirement } from "@ns";
import type { AugInfo, ObjectiveWeights, PriceContext } from "./augs.ts";
import type { RepContext, RepPerson, WorkType } from "./rep.ts";
import type { RequirementView } from "./requirements.ts";

/** The flat snapshot `stepFactions` decides from.
 *
 * Everything is plain data assembled by the driver from `GameState`. The
 * strategy reads no clock, no ns, no telemetry and no Bun — `time` is passed
 * in — which is what lets the identical function run in the game, in the
 * simulator and in a unit test. */

export interface FactionStanding {
  name: string;
  joined: boolean;
  invited: boolean;
  rep: number;
  favor: number;
  /** Requirements for an invitation, straight from the game. */
  requirements: PlayerRequirement[];
  enemies: string[];
  offers: { hacking: boolean; field: boolean; security: boolean };
  /** Special factions (Bladeburners, Church of the Machine God) are joined
   *  through their own mechanic, never by satisfying invite requirements. */
  special: boolean;
}

export interface FactionsView {
  /** Virtual or wall-clock ms. Passed in; never read from a clock here. */
  time: number;

  person: RepPerson & { skills: Record<string, number> };
  requirementView: RequirementView;
  repContext: RepContext;
  priceContext: PriceContext;

  factions: FactionStanding[];
  /** Every augmentation the game knows about, by name. */
  catalog: ReadonlyMap<string, AugInfo>;
  /** Installed or queued. */
  owned: ReadonlySet<string>;

  /** What the run is optimising for. */
  weights: ObjectiveWeights;

  /** Favor needed before donations unlock, from ns.getFavorToDonate(). */
  favorToDonate: number;
  /** Money the arbiter granted this feature this tick. */
  moneyGranted: number;
  /** Whether this feature holds Player.currentWork. */
  holdsWorkSlot: boolean;

  /** What the player is doing right now, so the continuation guard can tell
   *  "our work is still running" from "something else took the slot". */
  currentWork?: { kind: string; faction?: string; workType?: WorkType; focused: boolean };

  /** Measured income per second, for the donate-vs-work crossover. */
  incomePerSec: number;

  /** SF4 level and BitNode, for the 80 GB single-call blocker. */
  sf4Level: number;
  bitNode: number;
}
