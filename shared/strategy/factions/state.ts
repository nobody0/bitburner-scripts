import type { PlayerRequirement } from "@ns";
import type { AugInfo, ObjectiveWeights, PriceContext } from "./augs.ts";
import type { ChannelWorth, RateChannel } from "../income.ts";
import type { MeasuredMarginal } from "../progression/marginal.ts";
import type { RepContext, RepPerson, WorkType } from "./rep.ts";
import type { RequirementView } from "./requirements.ts";
import type { RouteId } from "../progression/endgame.ts";
import type { CyclePace } from "./pace.ts";
import type { FeatureId } from "../../features/ids.ts";

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
  /** Requirements for an invitation, straight from the game.
   * https://github.com/bitburner-official/bitburner-src/blob/3162fd2590e221eadd0c0fbd46151913f7c4c41c/src/NetscriptFunctions/Singularity.ts#L759-L766 */
  requirements: PlayerRequirement[];
  enemies: string[];
  offers: { hacking: boolean; field: boolean; security: boolean };
  /** Special factions (Bladeburners, Church of the Machine God) are joined
   *  through their own mechanic, never by satisfying invite requirements.
   * https://github.com/bitburner-official/bitburner-src/blob/3162fd2590e221eadd0c0fbd46151913f7c4c41c/src/Faction/FactionInfo.tsx#L695-L813 */
  special: boolean;
}

/** The slice of the view the reputation formulas actually read.
 *
 * `FactionsView` satisfies it, and so does the much smaller profile the work
 * CLAIM assembles from telemetry. That is the point: the claim has to price
 * itself on every pass, including the ones where the planner exited early and
 * published no work rate at all, and it cannot build a whole `FactionsView`
 * without a driver context. Predicting reputation needs a person, the node
 * context and the alternatives table — nothing else. */
export interface RepProfileView {
  person: RepPerson & { skills: Record<string, number> };
  repContext: RepContext;
  /** The alternatives table and what each channel is worth, so the WORK TYPE is
   *  chosen with the same arithmetic the arbiter prices the claim with. Field
   *  and security work pay combat experience alongside reputation; picking on
   *  reputation alone throws that away, and a posted combat gate then goes to
   *  crime while the reputation it could have earned at the same time does not
   *  happen. Absent falls back to reputation per second — the previous rule. */
  rates?: {
    best: ReadonlyMap<RateChannel, MeasuredMarginal>;
    worth: ChannelWorth;
  };
  /** What the player is doing right now, so the continuation guard can tell
   *  "our work is still running" from "something else took the slot" — and so a
   *  measured rate is attributed only to the work actually being run. */
  currentWork?: { kind: string; faction?: string; detail?: string; workType?: WorkType; focused: boolean };
}

export interface FactionsView extends RepProfileView {
  /** Virtual or wall-clock ms. Passed in; never read from a clock here. */
  time: number;

  requirementView: RequirementView;
  /** Requirement owners that can still act in this run. Absent preserves the
   * ordinary all-features assumption used by pure callers. */
  availableOwners?: ReadonlySet<FeatureId>;
  priceContext: PriceContext;

  factions: FactionStanding[];
  /** Every augmentation the game knows about, by name. */
  catalog: ReadonlyMap<string, AugInfo>;
  /** Installed or queued.
   * https://github.com/bitburner-official/bitburner-src/blob/3162fd2590e221eadd0c0fbd46151913f7c4c41c/src/NetscriptFunctions/Singularity.ts#L79-L92 */
  owned: ReadonlySet<string>;
  /** Bought during this install cycle but not installed yet. Kept separate
   * because only this set makes an augmentation install possible. */
  queued: ReadonlySet<string>;
  graftable?: { name: string; price: number; timeMs: number }[];
  entropy?: number;

  /** What the run is optimising for: BN-seconds per unit of `ln(mult)` on each
   *  multiplier field, derived from `rates.worth` by `weightsFromMarginals`. */
  weights: ObjectiveWeights;
  /** The chosen way to end the node. Route-specific augmentations only receive
   * their terminal value when they belong to this route. */
  route?: RouteId;
  /** Remaining time in which a package can pay off. */
  horizonSec: number;
  /** Elapsed seconds since the current augmentation prestige. Incremental
   * post-plan work is capped as a fraction of this measured cycle length. */
  installCycleSec?: number;
  /** How fast the run is accelerating, so a gap becomes seconds at a rate that
   * RISES rather than at today's spot rate. Fitted by progression from its cycle
   * samples and published as a digest. Absent means no signal yet, and every
   * conversion degrades to the spot-rate answer — see `pace.ts`. */
  cyclePace?: CyclePace;
  /** The permanent augmentation-count target. Infinity means "take as many as
   * the horizon permits" rather than inventing a count target. */
  targetAugCount: number;

  /** Favor needed before donations unlock, from ns.getFavorToDonate().
   * https://github.com/bitburner-official/bitburner-src/blob/3162fd2590e221eadd0c0fbd46151913f7c4c41c/src/NetscriptFunctions.ts#L1414-L1416 */
  favorToDonate: number;
  /** Progression's install-cadence verdict says the reset should happen NOW
   * (published installWanted). This feature must conclude: stop pushing the
   * objective and run the final sweep with the reputation already banked. */
  installRequested?: boolean;
  /** One-shot subset progression actually priced when it requested the reset. */
  installFundedAugmentations?: readonly string[];
  /** The selected high-level route itself requires this reset now. */
  routeInstallRequired?: boolean;
  /** The run will destroy the BitNode instead of installing augmentations;
   * install-lifetime donations have no surviving value in that mode. */
  endingByDestroy?: boolean;
  /** Money the arbiter granted the AUGMENTATION FUND this tick — the per-claim
   * amount, never the feature's summed grants (a travel grant must not top up
   * a purchase). */
  moneyGranted: number;
  /** Money granted the graft fund, when grafting is planned. Defaults to
   * `moneyGranted` where a caller (tests) does not distinguish. */
  graftGranted?: number;
  /** Actual cash on hand. Planning uses this; execution still obeys the
   * arbiter's narrower `moneyGranted`. */
  moneyAvailable: number;
  /** Cash we do not hold yet but will, net of the spread and commission to get
   *  it: the market book, which is liquidated before every install.
   *
   *  It belongs in the purchase plan for two reasons. Planning the batch against
   *  cash alone understates the bankroll and picks a smaller set than the run can
   *  afford. Worse, it picks the wrong ORDER — buying the one item today's cash
   *  covers charges the 1.9x escalation to the dearer item that the liquidation
   *  would have covered outright, and that mistake is permanent. Money left unspent
   *  is also money the market can keep compounding, so waiting is not a sacrifice.
   *
   *  Zero when there is no market, no position, or no reason to expect a
   *  liquidation. */
  pendingProceeds: number;
  /** Whether that book is actually being CONVERTED right now, rather than merely
   *  existing.
   *
   *  The distinction is the difference between patience and a livelock. Planning
   *  may count the book whenever it exists — it will be cash before the install,
   *  whenever that comes. Waiting for it may not: mid-run nobody is selling, so
   *  holding a purchase until the proceeds arrive would hold it for ever, and
   *  `factions` not finishing is itself what keeps `stock` from being asked to
   *  sell. Only a liquidation in progress has a settlement date. */
  proceedsSettling: boolean;
  /** Whether this feature holds Player.currentWork. */
  holdsWorkSlot: boolean;

  /** Measured income per second, for the donate-vs-work crossover. */
  incomePerSec: number;
  /** Measured seconds a prestige spends replaying what the reset erased, from
   * progression's own install verdict. The install-cycle budget divides by it,
   * and it is NOT a constant: a cycle that installs bigger multipliers replays
   * faster, so the overhead shrinks as the run improves. Absent means no
   * measurement yet, which prices the reset as free rather than inventing a
   * cost. */
  resetOverheadSec?: number;

  /** SF4 level and BitNode, for the 80 GB single-call blocker. */
  sf4Level: number;
  bitNode: number;
}

/** Money that is ours already or will be within a bounded, known wait: cash plus
 * the market book, which is liquidated before every install.
 *
 * This is the figure every "can we afford it / how long until we can" question in
 * this feature should use, and it is deliberately NOT cash alone. Money parked in
 * the market is money the run will spend on augmentations — `progression` refuses
 * to reset while the book is open — so pricing plans against cash understates the
 * bankroll, shrinks the objective to something smaller than the run can afford,
 * and picks a worse purchase order than waiting would.
 *
 * It counts the book only while `proceedsSettling` — a liquidation actually under
 * way. A book nobody is selling has no settlement date, and waiting on one is a
 * livelock: mid-run `stock` has not been asked to sell, and `factions` not
 * finishing is precisely what stops it being asked.
 *
 * It is also deliberately not "cash plus income over the horizon". Patience has to
 * terminate. Waiting on income over an open-ended horizon does not: it would stall
 * purchases indefinitely, and — because `progression` refuses to install while any
 * augmentation is still purchasable — a factions feature that holds out forever and
 * a progression feature waiting for it to buy are a livelock, not caution. A
 * liquidation settles in bounded time, after which `pendingProceeds` is zero and
 * the hold releases itself. */
export function settlingMoney(view: FactionsView): number {
  return view.moneyAvailable + (view.proceedsSettling ? Math.max(0, view.pendingProceeds) : 0);
}
