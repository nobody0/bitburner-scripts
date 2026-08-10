import type { PlayerRequirement } from "@ns";
import type { AugInfo, ObjectiveWeights, PriceContext } from "./augs.ts";
import type { RepContext, RepPerson, WorkType } from "./rep.ts";
import type { RequirementView } from "./requirements.ts";
import type { RouteId } from "../progression/endgame.ts";

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
  /** Bought during this install cycle but not installed yet. Kept separate
   * because only this set makes an augmentation install possible. */
  queued: ReadonlySet<string>;
  graftable?: { name: string; price: number; timeMs: number }[];
  entropy?: number;

  /** What the run is optimising for. */
  weights: ObjectiveWeights;
  /** The chosen way to end the node. Route-specific augmentations only receive
   * their terminal value when they belong to this route. */
  route?: RouteId;
  /** Remaining time in which a package can pay off. */
  horizonSec: number;
  /** The permanent augmentation-count target. Infinity means "take as many as
   * the horizon permits" rather than inventing a count target. */
  targetAugCount: number;

  /** Favor needed before donations unlock, from ns.getFavorToDonate(). */
  favorToDonate: number;
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

  /** What the player is doing right now, so the continuation guard can tell
   *  "our work is still running" from "something else took the slot". */
  currentWork?: { kind: string; faction?: string; detail?: string; workType?: WorkType; focused: boolean };

  /** Measured income per second, for the donate-vs-work crossover. */
  incomePerSec: number;

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
