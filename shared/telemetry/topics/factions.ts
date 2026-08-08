import type { PlayerRequirement } from "@ns";
import type { FeatureId } from "../../features/ids.ts";

/** Factions feature — reputation and augmentations (grafting included: it is
 * an augmentation acquisition path, not a separate problem). Problem: reach a
 * target augmentation set for the least wall-clock, trading faction work
 * against donations against grafting. */

export interface FactionStanding {
  name: string;
  rep: number;
  favor: number;
  /** @deprecated Legacy records may contain this; new probes emit it only at
   * FactionsState.favorToDonate. */
  favorToDonate?: number;
}

export interface AugmentationOffer {
  name: string;
  faction: string;
  /** Price at the CURRENT queue depth — what it would cost to buy next. */
  price: number;
  /** Base price before the 1.9^queued escalation, so the panel can show both
   *  and the escalation is visible rather than looking like a price change. */
  basePrice?: number;
  repReq: number;
  /** True once rep >= repReq for at least one offering faction. */
  affordableRep: boolean;
  /** Reputation still needed at the cheapest offering faction. */
  repGap?: number;
  owned: boolean;
  prereqs?: string[];
  /** Multiplier fields, for the value column. */
  mults?: Record<string, number>;
  /** Score under the run's objective weights. */
  score?: number;
  /** Shadows-of-Anarchy pricing (7^owned), which is not the normal curve. */
  soa?: boolean;
  /** NeuroFlux pricing (1.14^level on BOTH rep and money). */
  neuroflux?: boolean;
}

export interface GraftOffer {
  name: string;
  price: number;
  timeMs: number;
}

/** One thing standing between us and the objective, and who can fix it. */
export interface PlanBlocker {
  faction: string;
  kind: string;
  subject?: string;
  target: number;
  have: number;
  progress: number;
  /** The feature that can deliver this — the cross-feature contract, rendered
   *  so a stalled faction names its dependency instead of just sitting there. */
  owner: FeatureId;
  reachable: boolean;
  negated?: boolean;
  why: string;
}

/** The decision digest: what we are doing, why, and what would change it. */
export interface FactionPlan {
  objective?: {
    factions: string[];
    augmentations: string[];
    value: number;
    foreclosed: { name: string; bannedBy: string }[];
    why: string;
  };
  action: { type: string; why: string; faction?: string; augmentation?: string; city?: string; workType?: string };
  /** Scored runners-up, so a decision can be argued with rather than trusted. */
  alternatives: { label: string; value: number; why: string }[];
  blockers: PlanBlocker[];
  /** Expected next milestone. */
  until?: { kind: string; faction?: string; target: number; have: number; etaSec: number };
  /** What the last executed action actually returned. Every singularity call's
   *  `false` is a MODELLED OUTCOME, not an error, so it is reported as one. */
  lastResult?: { action: string; ok: boolean; detail: string; at: number };
  /** Set when the feature cannot act at all (the SF4 RAM wall). */
  blocked?: string;
  /** Set when factions thinks the run should end. Advisory: the reset cadence
   *  belongs to `progression`. */
  recommendInstall?: { why: string; augmentations: string[] };
}

export interface FactionsState {
  /** Faction names from Player.factions — free, always available. */
  joined: string[];
  /** Populated only with the singularity API (BN4/SF4). */
  standings?: FactionStanding[];
  invites?: string[];
  /** Favor needed before donations unlock. Top-level because it is one number
   *  for the whole save, not per faction. */
  favorToDonate?: number;
  /** Complete faction catalogue, including factions not joined or invited.
   * These cannot live on standings because deciding whether to join needs the
   * metadata before a standing exists. */
  workTypes?: Record<string, string[]>;
  enemies?: Record<string, string[]>;
  /** STRUCTURED invite requirements, per faction — the tree, not a display
   *  string. The strategy must INTERPRET these (an OR branch is not an AND),
   *  so a stringified form would be useless to it. */
  requirements?: Record<string, PlayerRequirement[]>;
  ownedAugs?: string[];
  /** Not-yet-owned augmentations offered by joined factions. Capped by the
   * probe (see FACTION_AUG_LIMIT) so a late-game save cannot balloon the
   * record; `augTotal` reports the true count. */
  offers?: AugmentationOffer[];
  augTotal?: number;
  graftable?: GraftOffer[];
  /** The decision digest. */
  plan?: FactionPlan;
}
