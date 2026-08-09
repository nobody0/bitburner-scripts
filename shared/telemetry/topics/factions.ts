import type { PlayerRequirement } from "@ns";
import type { FactionObjective } from "../../strategy/factions/plan.ts";
import type { FeatureId } from "../../features/ids.ts";

/** Factions feature — reputation and augmentations (grafting included: it is
 * an augmentation acquisition path, not a separate problem). Problem: reach a
 * target augmentation set for the least wall-clock, trading faction work
 * against donations against grafting. */

export interface FactionStanding {
  name: string;
  rep: number;
  favor: number;
}

/** One (faction, augmentation) pair. Deliberately carries only what varies
 * BETWEEN pairs — an augmentation offered by four factions produces four of
 * these, and duplicating its multiplier table four times is what made this
 * topic 198 KB per record. The per-augmentation facts live once, in
 * `FactionsState.augMeta`. */
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
  /** Score under the run's objective weights. */
  score?: number;
  /** Shadows-of-Anarchy pricing (7^owned), which is not the normal curve. */
  soa?: boolean;
  /** NeuroFlux pricing (1.14^level on BOTH rep and money). */
  neuroflux?: boolean;
}

/** Facts that belong to an augmentation rather than to an offer of it. Keyed
 * by augmentation name, so N offering factions cost one copy, not N. */
export interface AugmentationMeta {
  prereqs?: string[];
  /** Multiplier fields, for the value column. */
  mults?: Record<string, number>;
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

/** One unmet invite requirement, without the faction name — the gate it
 * belongs to is the key. */
export type GateBlocker = Omit<PlanBlocker, "faction">;

/** Inputs needed to reproduce and challenge a faction decision later. The
 * full world state remains in the surrounding topic; these are the volatile
 * strategy parameters that otherwise disappear behind the chosen package. */
export interface FactionDecisionContext {
  /** Time at which the planner evaluated this snapshot. */
  evaluatedAt: number;
  horizonSec: number;
  route?: "daedalus" | "labyrinth" | "bladeburner";
  targetAugCount?: number;
  /** Owned augmentations as reported by the game, including queued purchases. */
  ownedAugCount: number;
  queuedAugCount: number;
  incomePerSec: number;
  moneyAvailable: number;
  moneyGranted: number;
  holdsWorkSlot: boolean;
  favorToDonate: number;
  priceQueue: {
    nonSoA: number;
    ownedSoA: number;
    neurofluxLevel: number;
  };
}

/** How close we are to an invitation from ONE faction, and what is in the way.
 *
 * Emitted for EVERY faction the game knows, not only the ones the current
 * objective is chasing. Deciding whether an objective is worth switching to
 * needs the whole board, and so does the operator reading the panel. */
export interface FactionGate {
  joined: boolean;
  invited: boolean;
  /** The BOTTLENECK requirement's progress, in [0, 1] — a faction is only as
   *  close as its furthest-away condition, and averaging would report
   *  "80% there" for one that is missing a BitNode. 1 when nothing is
   *  missing. */
  progress: number;
  /** False when nothing in this run can satisfy it (wrong BitNode, a negated
   *  karma requirement, a special faction joined by its own mechanic). */
  reachable: boolean;
  missing: GateBlocker[];
}

/** The decision digest: what we are doing, why, and what would change it. */
export interface FactionPlan {
  context: FactionDecisionContext;
  objective?: FactionObjective;
  action: {
    type: string;
    /** Why an idle action was selected. `slot` is also consumed by the driver
     * to bootstrap the matching time and RAM claims atomically. */
    reason?: "blocked" | "waiting" | "continue" | "slot";
    why: string;
    faction?: string;
    augmentation?: string;
    city?: string;
    workType?: string;
    amount?: number;
    purchaseCost?: number;
  };
  /** Scored runners-up, so a decision can be argued with rather than trusted. */
  alternatives: { label: string; value: number; why: string }[];
  blockers: PlanBlocker[];
  /** Coarse facts that invalidate a continuing work order. Logged so a plan
   * transition can be attributed to its changing input rather than guessed. */
  invalidation?: { label: string; value: string | number | boolean }[];
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
  /** The next augmentation the plan intends to buy, priced at its slot in the
   *  purchase order — the dearest item first, so the 1.9x queue escalation lands on
   *  the cheapest. The driver claims money against this. During the last-chance
   *  drain it is whatever is still buyable at all: money does not survive an
   *  install and a permanent multiplier does, so a dollar left unspent at that
   *  boundary is a dollar thrown away. */
  nextBuy?: { name: string; price: number };
  /** The final-sweep drain's frozen budget (cash on hand when the drain began).
   *  Published so `progression`'s install barrier tests the same money the drain
   *  is willing to spend — fresh income beyond it must not hold the install. */
  drainCeiling?: number;
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
  /** Evaluated invite requirements, per faction. The strategy's own reading of
   *  `requirements` against the current player — reported rather than
   *  re-derived in the viewer, so there is one interpretation of an OR branch
   *  in the repository, not two. */
  gates?: Record<string, FactionGate>;
  ownedAugs?: string[];
  /** Not-yet-owned augmentations offered by joined factions. Capped by the
   * probe (see FACTION_AUG_LIMIT) so a late-game save cannot balloon the
   * record; `augTotal` reports the true count. */
  offers?: AugmentationOffer[];
  /** Per-augmentation facts for everything named in `offers`, deduped by name. */
  augMeta?: Record<string, AugmentationMeta>;
  augTotal?: number;
  graftable?: GraftOffer[];
  /** The decision digest. */
  plan?: FactionPlan;
}
