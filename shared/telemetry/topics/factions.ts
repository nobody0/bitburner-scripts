/** Factions feature — reputation and augmentations (grafting included: it is
 * an augmentation acquisition path, not a separate problem). Problem: reach a
 * target augmentation set for the least wall-clock, trading faction work
 * against donations against grafting. */

export interface FactionStanding {
  name: string;
  rep: number;
  favor: number;
  /** Favor needed before donations unlock (ns.getFavorToDonate). */
  favorToDonate?: number;
  workTypes?: string[];
}

export interface AugmentationOffer {
  name: string;
  faction: string;
  price: number;
  repReq: number;
  /** True once rep >= repReq for at least one offering faction. */
  affordableRep: boolean;
  owned: boolean;
  prereqs?: string[];
}

export interface GraftOffer {
  name: string;
  price: number;
  timeMs: number;
}

export interface FactionsState {
  /** Faction names from Player.factions — free, always available. */
  joined: string[];
  /** Populated only with the singularity API (BN4/SF4). */
  standings?: FactionStanding[];
  invites?: string[];
  /** Requirements per pending invite, stringified for display. */
  inviteRequirements?: Record<string, string[]>;
  ownedAugs?: string[];
  /** Not-yet-owned augmentations offered by joined factions. Capped by the
   * probe (see FACTION_AUG_LIMIT) so a late-game save cannot balloon the
   * record; `augTotal` reports the true count. */
  offers?: AugmentationOffer[];
  augTotal?: number;
  graftable?: GraftOffer[];
}
