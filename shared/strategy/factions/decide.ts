import { formatNumber } from "../../format.ts";
import {
  augCost,
  canAfford,
  closePrereqs,
  countSlotWeight,
  entropyCost,
  NEUROFLUX,
  orderPurchases,
  orderPurchasesWithNeurofluxByLevel,
  scoreAug,
  totalCost,
  type PurchaseCandidate,
} from "./augs.ts";
import {
  FOCUS_DWELL_MS,
  INTENT_STALL_MS,
  NFG_MIN_PAYBACK_SEC,
  RATE_SMOOTHING,
  WORK_SWITCH_MARGIN,
  type FactionAction,
  type FactionDecision,
  type FactionMemory,
  type FactionObjective,
  type InvalidationKey,
  type ScoredAlternative,
  type Until,
} from "./plan.ts";
import { buildFrontiers } from "./packages.ts";
import { selectFactionPortfolio } from "./portfolio.ts";
import { FORECAST_RECALIBRATION_MS } from "../progression/forecast.ts";
import {
  donationCrossoverIncome,
  donationForRep,
  factionWorkExpPerSec,
  passiveRepPerSec,
  workRepPerSec,
  type WorkType,
} from "./rep.ts";
import {
  AUGMENTATIONS_CHANNEL,
  channelForNeed,
  compareSlotValues,
  raiseBest,
  REPUTATION_CHANNEL,
  slotValue,
  type RateChannel,
  type SlotValue,
} from "../income.ts";
import { evaluateAll, type Blocker } from "./requirements.ts";
import { settlingMoney, type FactionStanding, type FactionsView, type RepProfileView } from "./state.ts";
import {
  allocateResidualDonations,
  assignDonationSellers,
  selectDonationAwareBatch,
  selectDonationAwareCountClosure,
} from "./liquidation.ts";
import { factionFavorPointValues } from "./favorValue.ts";

/** Once the planned package is banked, opportunistic work may extend this
 * cycle by at most one percent. Purchases themselves remain end-loaded and do
 * not consume this budget. */
export const EXTRA_AUG_PUSH_FRACTION = 0.01;

/** The faction decision.
 *
 * Pure: same view + same memory => same decision, always. It reads no clock
 * (`view.time` is passed in), no ns, no telemetry.
 *
 * ACTION PRECEDENCE, and why it is this order:
 *
 *   purchaseAugmentation -> joinFactions -> travelTo -> donate -> graft
 *   -> workForFaction -> stopWork -> idle
 *
 * Purchase is first only after the final transaction has been closed. Before
 * that boundary it is deliberately absent: queued augmentations provide no
 * benefit, and each one makes every later purchase 1.9x dearer. Joins come
 * next because an invitation can be REVOKED by joining an enemy. Travel is
 * last among the cheap actions and heavily guarded — see below.
 * https://github.com/bitburner-official/bitburner-src/blob/3162fd2590e221eadd0c0fbd46151913f7c4c41c/src/Faction/FactionHelpers.tsx#L35-L51
 *
 * `installAugmentations` is deliberately never selected. spec/features.md
 * gives the reset cadence to `progression`; this feature emits
 * `recommendInstall` and lets that decision be made with the whole run in
 * view. */

/** The single most important rule in this file.
 *
 * `ns.singularity.workForFaction` does NOT queue behind existing work — it
 * silently CANCELS it. So re-issuing the same work order every 30 s tick would
 * restart the activity each time and accumulate almost no reputation, while
 * looking entirely healthy in the logs. If the last action was long-running,
 * the game still shows it running, its `until` is unmet, and nothing
 * invalidated the plan, the only correct answer is "keep going".
 * https://github.com/bitburner-official/bitburner-src/blob/3162fd2590e221eadd0c0fbd46151913f7c4c41c/src/PersonObjects/Player/PlayerObjectWorkMethods.ts#L5-L22 */
function shouldContinue(
  view: FactionsView,
  memory: FactionMemory,
  invalidation: InvalidationKey[],
  target: { faction: string; workType: WorkType },
): boolean {
  const last = memory.lastAction;
  if (!last || last.type !== "workForFaction") return false;
  // A completed breakpoint can promote another faction without changing any
  // coarse invalidation key: reputation deliberately is not one because it
  // changes every tick. Continuing is correct only when the promoted target
  // is still the work we started. Otherwise the guard strands the new package
  // in the plan while the player keeps earning obsolete reputation forever.
  if (target.faction !== last.faction || target.workType !== last.workType) return false;
  const work = view.currentWork;
  if (!work || work.kind !== "faction" || work.faction !== last.faction) return false;
  if (work.workType !== last.workType) return false;
  return !invalidationChanged(memory.lastInvalidation, invalidation);
}

function invalidationChanged(before: readonly InvalidationKey[], after: readonly InvalidationKey[]): boolean {
  if (before.length !== after.length) return true;
  const previous = new Map(before.map((key) => [key.label, key.value]));
  for (const key of after) {
    if (previous.get(key.label) !== key.value) return true;
  }
  return false;
}

/** Facts whose change should make the planner reconsider. Deliberately coarse:
 * a key that changes every tick would defeat the continuation guard entirely. */
function invalidationKeys(view: FactionsView): InvalidationKey[] {
  return [
    { label: "joined", value: view.factions.filter((f) => f.joined).map((f) => f.name).sort().join(",") },
    { label: "invited", value: view.factions.filter((f) => f.invited).map((f) => f.name).sort().join(",") },
    { label: "owned", value: view.owned.size },
    // Bucketed, so ordinary skill drift does not invalidate; a level-up that
    // actually changes the work-type ranking does.
    { label: "hackingBucket", value: Math.floor(Math.log10(Math.max(1, view.person.skills.hacking)) * 10) },
    { label: "slot", value: view.holdsWorkSlot },
  ];
}

/** Invite blockers for one faction.
 *
 * Exported so the driver can report the gate for EVERY faction rather than
 * only the objective's: "what is still missing, for each of the 34" is the
 * question the factions panel exists to answer, and re-deriving it in the
 * viewer would put a second, drifting copy of this interpretation there. */
export function blockersFor(standing: FactionStanding, view: FactionsView): Blocker[] {
  if (standing.joined) return [];
  if (standing.invited) return [];
  // A special faction is joined through its own mechanic (Bladeburner's
  // division, Stanek's gift), never by satisfying invite requirements — so a
  // requirement list we cannot meet is not the reason we have not joined.
  if (standing.special) {
    return [
      {
        kind: "bitNode",
        target: 0,
        have: 0,
        progress: 0,
        owner: "progression",
        reachable: false,
      },
    ];
  }
  const evaluated = evaluateAll(standing.requirements, view.requirementView);
  if (!view.availableOwners) return evaluated;
  return evaluated.map((entry) => view.availableOwners!.has(entry.owner)
    ? entry
    : { ...entry, reachable: false });
}

/** Measured reputation rate, EWMA over observed deltas. Reality beats the
 * formula: a share bonus, an unnoticed unfocus or a BitNode multiplier we
 * mis-read all show up here and nowhere else. */
export function updateMeasuredRates(view: FactionsView, memory: FactionMemory): FactionMemory {
  const elapsedSec = (view.time - memory.lastRepAt) / 1000;
  const measured = { ...memory.measuredRepPerSec };
  const lastRep: Record<string, number> = {};
  for (const standing of view.factions) {
    lastRep[standing.name] = standing.rep;
    if (memory.lastRepAt === 0 || elapsedSec <= 0) continue;
    const before = memory.lastRep[standing.name];
    if (before === undefined) continue;
    const delta = standing.rep - before;
    // A DROP means an install banked reputation into favor; that is not a
    // rate, and folding it in would poison the average with a large negative.
    if (delta < 0) continue;
    const rate = delta / elapsedSec;
    const previous = measured[standing.name];
    measured[standing.name] = previous === undefined ? rate : previous * (1 - RATE_SMOOTHING) + rate * RATE_SMOOTHING;
  }
  return { ...memory, measuredRepPerSec: measured, lastRep, lastRepAt: view.time };
}

/** Everything one work type at one faction produces, in board vocabulary.
 *
 * A combat requirement is met by the WEAKEST of the four stats, so that is what
 * field and security work produce toward it — the same rule crime scoring uses.
 * The individual `skill:*` rates are kept beside it because a faction can
 * require one specific stat. */
function workProduces(
  type: WorkType,
  repPerSec: number,
  view: RepProfileView,
): Record<RateChannel, number> {
  const exp = factionWorkExpPerSec(type, view.person, view.repContext, true);
  const produces: Record<RateChannel, number> = { [REPUTATION_CHANNEL]: Math.max(0, repPerSec) };
  const add = (channel: RateChannel, rate: number): void => {
    if (rate > 0) produces[channel] = (produces[channel] ?? 0) + rate;
  };
  for (const [skill, rate] of Object.entries(exp)) {
    add(channelForNeed({ kind: "skill", subject: skill }), rate);
    if (skill === "charisma") add(channelForNeed({ kind: "charisma" }), rate);
  }
  const combat = Math.min(exp.strength ?? 0, exp.defense ?? 0, exp.dexterity ?? 0, exp.agility ?? 0);
  add(channelForNeed({ kind: "combatSkills" }), combat);
  return produces;
}

/** Which work type to run at a faction, and everything it earns.
 *
 * NOT "whichever pays the most reputation". Field and security work pay combat
 * and charisma experience while they earn, so the type is chosen by what the
 * whole package is worth — the same `slotValue` the arbiter prices the claim
 * with. Reputation still breaks ties, and with nothing priced yet the ordering
 * degenerates to reputation per second, which is the rule this replaces. */
export function chooseWorkType(faction: string, standing: FactionStanding, view: RepProfileView, memory: FactionMemory): {
  type: WorkType;
  repPerSec: number;
  produces: Record<RateChannel, number>;
} | undefined {
  const measured = memory.measuredRepPerSec[faction];
  // Only trust a measured rate while we were actually working that faction.
  const trustMeasured = measured !== undefined && measured > 0 && view.currentWork?.faction === faction;
  const candidates = (["hacking", "field", "security"] as const)
    .filter((type) => standing.offers[type])
    .map((type) => {
      // The measurement describes the type we were ACTUALLY running; applying
      // it to a different one would attribute the wrong observation to it.
      const repPerSec = trustMeasured && view.currentWork?.workType === type
        ? measured
        : workRepPerSec(type, view.person, standing.favor, view.repContext, true);
      return { type, repPerSec, produces: workProduces(type, repPerSec, view) };
    });
  if (candidates.length === 0) return undefined;

  // The candidates are each other's field. Without raising the best-known rate
  // by what they offer, every channel would score as a fraction of an unknown
  // and all three would tie at zero — the same reason the arbiter folds its own
  // claims into the alternatives table.
  const field = raiseBest(view.rates?.best ?? new Map(), candidates.map((entry) => entry.produces));
  const worth = view.rates?.worth ?? new Map();
  let best: (typeof candidates)[number] & { value: SlotValue } | undefined;
  for (const entry of candidates) {
    const value = slotValue({ produces: entry.produces, best: field, worth });
    const better = best === undefined
      || compareSlotValues(value, best.value) < 0
      || (compareSlotValues(value, best.value) === 0 && entry.repPerSec > best.repPerSec);
    if (better) best = { ...entry, value };
  }
  return best === undefined
    ? undefined
    : { type: best.type, repPerSec: best.repPerSec, produces: best.produces };
}

/** Reputation still needed at a faction to buy everything we want from it. */
function repNeeded(faction: string, view: FactionsView, wanted: readonly string[]): number {
  let highest = 0;
  for (const name of wanted) {
    const aug = view.catalog.get(name);
    if (!aug || !aug.factions.includes(faction)) continue;
    const { repCost } = augCost(aug, view.priceContext);
    if (repCost > highest) highest = repCost;
  }
  return highest;
}

/** The order to BUY an already-chosen set in.
 *
 * Selection and payment answer different questions. A set is chosen by value —
 * which augmentations are worth having — and an augmentation does nothing until it
 * is installed, so within one reset there is no reason to prefer getting a cheap
 * one early. Payment order, on the other hand, changes the bill: each queued
 * non-SoA purchase multiplies the price of every later one, so the dearest item
 * belongs in the cheapest slot. Buying $1m before $500m pays the escalation on the
 * $500m and can leave the batch unaffordable halfway through.
 * https://github.com/bitburner-official/bitburner-src/blob/3162fd2590e221eadd0c0fbd46151913f7c4c41c/src/Faction/FactionHelpers.tsx#L109-L141
 * https://github.com/bitburner-official/bitburner-src/blob/3162fd2590e221eadd0c0fbd46151913f7c4c41c/src/Augmentation/AugmentationHelpers.ts#L24-L38
 *
 * This is the EXACT solver, and it is exponential in the set size — 0.3 ms at ten
 * items, 40 ms at sixteen. That is affordable here and only here: an objective is a
 * single faction's package, the feature decides every 30 s, and this is where money
 * actually changes hands. Estimates that run per candidate on the package frontier
 * use `estimatedCost` instead; using this one there costs seconds per decision. */
function purchaseOrder(view: FactionsView, names: readonly string[]): string[] {
  const candidates: PurchaseCandidate[] = [];
  for (const name of names) {
    const aug = view.catalog.get(name);
    // `faction` is unused by the ordering — the caller resolves the seller.
    if (aug && !view.owned.has(name)) candidates.push({ name, aug, faction: aug.factions[0] ?? "" });
  }
  return orderPurchases(candidates, view.priceContext).map((candidate) => candidate.name);
}

/** Dependency-safe cost of the reputation breakpoints already banked this
 * cycle. End-loading must not confuse "rep complete" with "base plan
 * complete" while its real purchase set is still short of cash. */
function bankedPackageCost(view: FactionsView, names: ReadonlySet<string>): number {
  const candidates: PurchaseCandidate[] = [];
  for (const name of closePrereqs([...names], view.catalog, view.owned)) {
    const aug = view.catalog.get(name);
    if (!aug) return Infinity;
    const repCost = augCost(aug, view.priceContext).repCost;
    const seller = view.factions.find(
      (standing) => standing.joined && standing.rep >= repCost && aug.factions.includes(standing.name),
    );
    if (!seller) return Infinity;
    candidates.push({ name, aug, faction: seller.name });
  }
  return totalCost(orderPurchases(candidates, view.priceContext), view.priceContext);
}

export function stepFactions(
  view: FactionsView,
  memoryIn: FactionMemory,
): { decision: FactionDecision; memory: FactionMemory } {
  const out = decideFactions(view, memoryIn);
  // `nextBuy` is the money the driver has to claim, and during the endgame drain
  // the drain is its SOLE author: it prices the frozen order against the frozen
  // pile and deliberately withholds an intent the pile cannot cover.
  //
  // There is no objective-derived fallback here. The only names the objective
  // could contribute beyond the frozen order are the ones the final batch
  // selector already dropped for cost, and publishing one is a deadlock: the
  // driver hands `nextBuy.name` to progression as `purchasableAugmentation`,
  // which raises the `augmentations` install blocker, while the drain — latched
  // out of all faction work — will never buy a name outside `drainOrder`. The
  // run then sits on a frozen bankroll with `installReady` permanently false.
  let decision = out.decision;
  const endgameDrain = decision.recommendInstall !== undefined || decision.drainCeiling !== undefined;

  // End-loaded buying can reach its first purchase with most of the bankroll
  // still in stocks. Publish the bootstrap separately so progression may ask
  // stock to liquidate without treating an empty queue as installable.
  const nextBuy = decision.nextBuy;
  if (
    endgameDrain &&
    view.queued.size === 0 &&
    nextBuy &&
    view.moneyAvailable < nextBuy.price &&
    view.moneyAvailable + Math.max(0, view.pendingProceeds) >= nextBuy.price
  ) {
    decision = {
      ...decision,
      nextBuy,
      action: { type: "idle", reason: "waiting" },
      liquidationNeeded: {
        augmentation: nextBuy.name,
        price: nextBuy.price,
        cash: view.moneyAvailable,
        pendingProceeds: Math.max(0, view.pendingProceeds),
      },
    };
  }
  return decision === out.decision ? out : { ...out, decision };
}

function decideFactions(
  view: FactionsView,
  memoryIn: FactionMemory,
): { decision: FactionDecision; memory: FactionMemory } {
  const memory = updateMeasuredRates(view, memoryIn);
  const invalidation = invalidationKeys(view);
  const alternatives: ScoredAlternative[] = [];

  // The SF4 level-1 wall. A single SingularityFn3 call is 5 GB x16 = 80 GB and
  // cannot be split further, so multi-step dodging does not help. Report it
  // and stop, rather than spinning on a probe that will never fit.
  if (view.sf4Level === 1 && view.bitNode !== 4) {
    return {
      memory,
      decision: {
        objective: undefined,
        action: { type: "idle", reason: "blocked" },
        alternatives,
        blockers: [],
        needOwners: [],
        invalidation,
        blocked: true,
      },
    };
  }

  const blockers = new Map(view.factions.map((standing) => [standing.name, blockersFor(standing, view)]));

  // End-loading deliberately leaves a completed package physically unowned.
  // Without a separate planning commitment, its now-zero work ETA wins the
  // frontier on every refresh: the objective remains complete, factions sits
  // idle, and progression continues to say push forever. Bank completed
  // one-shot names for SELECTION only. The real view is retained below for
  // purchases, affordability and ownership, so no benefit is fabricated
  // before the install transaction actually runs.
  const bankedAugmentations = new Set(memory.bankedAugmentations);
  const rememberedIntent = memory.objective?.intent;
  const rememberedStanding = rememberedIntent
    ? view.factions.find((standing) => standing.name === rememberedIntent.faction)
    : undefined;
  if (rememberedIntent && rememberedStanding && rememberedStanding.rep >= rememberedIntent.repTarget) {
    for (const name of rememberedIntent.augmentations) {
      if (name !== NEUROFLUX && !view.owned.has(name)) bankedAugmentations.add(name);
    }
  }
  const planningOwned = new Set([...view.owned, ...bankedAugmentations]);
  const planningView: FactionsView = planningOwned.size === view.owned.size
    ? view
    : { ...view, owned: planningOwned };
  // A bank is a pool of reputation-complete opportunities, not a promise to
  // buy every item in it.  In particular, once a faction-acquisition route has
  // banked The Red Pill, an optional wish list must not hold the terminal reset
  // hostage.  Require the route-critical dependency closure to fit, then let
  // the final-sweep solver freeze the best affordable subset of the rest.
  // For ordinary packages progression prices the same jointly affordable
  // subset the final sweep will freeze. Requiring every reputation-banked name
  // to fit instead deadlocks whenever one more 1.9x slot is unaffordable: the
  // cadence requests a valid partial reset while factions waits for the entire
  // bank. Terminal route dependencies retain the stronger closure gate below.
  const terminalBanked = (view.route === "daedalus" || view.route === "gang")
    && bankedAugmentations.has("The Red Pill");
  const terminalRequired = terminalBanked
    ? closePrereqs(["The Red Pill"], view.catalog, view.owned)
    : [];
  const fundedBase = terminalRequired.length > 0
    ? new Set(terminalRequired)
    : bankedAugmentations;
  const bankedFunded = bankedPackageCost(view, fundedBase)
    <= view.moneyAvailable + Math.max(0, view.pendingProceeds);

  // --- objective ------------------------------------------------------------
  // The frontiers are rebuilt every pass — reputation, income and blockers all
  // move — but the BUDGET is not re-swept every pass. A sweep is 24 solves; a
  // re-solve at the committed budget is one, and it is what keeps the plan
  // current against today's frontiers between recalibrations. The budget itself
  // re-derives on the same cadence progression re-forecasts on, or immediately
  // when a structural input changes.
  const { frontiers, horizonDropped } = buildFrontiers(planningView, blockers);
  const basis = invalidation.map((entry) => `${entry.label}=${entry.value}`).join("|");
  const budgetStale = basis !== memory.portfolioBasis
    || view.time - (memory.portfolioAt ?? 0) >= FORECAST_RECALIBRATION_MS;
  const selection = selectFactionPortfolio(planningView, frontiers, {
    resetOverheadSec: view.resetOverheadSec ?? 0,
    basis,
    ...(memory.portfolioBudgetSec !== undefined ? { previousBudgetSec: memory.portfolioBudgetSec } : {}),
    ...(budgetStale || memory.portfolioBudgetSec === undefined
      ? {}
      : {
          budgetSec: memory.portfolioBudgetSec,
          ...(memory.portfolioChoices ? { committed: memory.portfolioChoices } : {}),
        }),
  });
  // The objective is the whole SET, not its head. `shouldRecommendInstall` reads
  // this list to decide the cycle's work is done; giving it only the package
  // being worked now would declare the run over the moment the FIRST push
  // completed, with the rest of the committed portfolio still outstanding.
  const objectiveAugs = closePrereqs(
    selection.portfolio.augmentations.length > 0
      ? selection.portfolio.augmentations
      : (selection.intent?.augmentations ?? []),
    view.catalog,
    planningOwned,
  );
  const fresh: FactionObjective = {
    // The whole committed set, in the order it will be worked — not the one
    // faction that happened to win a rate comparison.
    factions: selection.portfolio.packages.map((pkg) => pkg.faction),
    augmentations: objectiveAugs,
    value: selection.intent?.value ?? 0,
    foreclosed: selection.foreclosed,
    ...(selection.intent ? { intent: selection.intent } : {}),
    ...(selection.runnerUp ? { runnerUp: selection.runnerUp } : {}),
    ...(selection.intent === undefined && horizonDropped > 0 ? { horizonStarved: true } : {}),
    portfolio: selection.portfolio,
    // The sweep only runs on the recalibration cadence, so most passes carry no
    // curve of their own. Republish the last one rather than dropping it: the
    // budget it justifies is still the committed budget, and a field that
    // vanishes for 59 of every 60 seconds reads as "no sweep happened" to every
    // consumer of the record.
    ...(selection.horizonCurve.length > 0
      ? { horizonCurve: selection.horizonCurve }
      : memory.objective?.horizonCurve && memory.objective.horizonCurve.length > 0
        ? { horizonCurve: memory.objective.horizonCurve }
        : {}),
  };

  // Keep the promised breakpoint stable while it is in flight. In
  // particular, joining a city faction makes its enemy disappear from the
  // current-cycle frontier; recomputing freely at that moment would erase the
  // runner-up opportunity cost and push the joined faction all the way to its
  // deepest augmentation. Once the package is complete we may switch to a
  // compatible runner immediately, but an enemy runner means "install, then
  // join it next cycle".
  // https://github.com/bitburner-official/bitburner-src/blob/3162fd2590e221eadd0c0fbd46151913f7c4c41c/src/Faction/FactionHelpers.tsx#L35-L51
  const previous = memory.objective;
  const previousIntent = previous?.intent;
  const previousRunner = previous?.runnerUp;
  const previousStanding = previousIntent
    ? view.factions.find((standing) => standing.name === previousIntent.faction)
    : undefined;
  // Complete = the WORK is done (reputation banked). Ownership is not part of
  // it any more: purchases are end-loaded, so a finished package's
  // augmentations stay unbought until the final sweep while the frontier
  // moves on to the next package.
  const previousComplete = Boolean(
    previousIntent && previousStanding && previousStanding.rep >= previousIntent.repTarget,
  );
  // Stability latches the promised BREAKPOINT, not the estimates captured on
  // the tick that selected it. Invite blockers, measured work rates, income,
  // favor and the current rep gap all change while a package is in flight. A
  // stale pre-join intent can otherwise retain a years-long unlockSec after
  // the faction has been joined; progression then sees an almost-zero push
  // rate and repeatedly installs optional NFG instead of finishing the route.
  const refreshedPreviousIntent = previousIntent
    ? selection.frontiers.get(previousIntent.faction)?.find(
        (candidate) => Math.abs(candidate.repTarget - previousIntent.repTarget) <= 1e-9,
      )
    : undefined;
  const refreshedPrevious = previous && refreshedPreviousIntent
    ? {
        ...previous,
        augmentations: closePrereqs(refreshedPreviousIntent.augmentations, view.catalog, view.owned),
        value: refreshedPreviousIntent.value,
        intent: refreshedPreviousIntent,
      }
    : previous;
  const runnerBlockedThisCycle = Boolean(
    previousRunner &&
    view.factions.some(
      (member) =>
        member.joined &&
        member.name !== previousRunner.faction &&
        (member.enemies.includes(previousRunner.faction) ||
          (view.factions.find((standing) => standing.name === previousRunner.faction)?.enemies.includes(member.name) ?? false)),
    ),
  );
  const runnerStanding = previousRunner
    ? view.factions.find((standing) => standing.name === previousRunner.faction)
    : undefined;
  const promotedRunner: FactionObjective | undefined =
    previousComplete && previousRunner && runnerStanding && !runnerBlockedThisCycle
      ? {
          factions: [previousRunner.faction],
          augmentations: closePrereqs(previousRunner.augmentations, view.catalog, view.owned),
          value: previousRunner.value,
          foreclosed: fresh.foreclosed,
          intent: previousRunner,
        }
      : undefined;
  // A completed, still-unpurchased package is not itself a reason to stop selection. If its
  // recorded runner is enemy-blocked this cycle, `fresh` already contains the
  // best compatible package after excluding every banked augmentation. Keep
  // the completed objective here and an end-loaded augmentation remains
  // physically unowned, so the feature can sit idle on it forever while a
  // route-level batch policy correctly refuses the too-small reset.
  // Progression still closes the cycle when no compatible fresh package is
  // worth pursuing; an empty fresh frontier is the explicit conclude signal.
  // Once a queue entry exists the transaction is irreversible, however, and
  // the pre-join stopping point must remain closed rather than reopening work
  // under an already-inflated price ladder.
  let keepPrevious = Boolean(
    previousIntent
    && previousStanding
    && (!previousComplete || (runnerBlockedThisCycle && view.queued.size > 0))
    // A latched package that can no longer DELIVER anything is not worth
    // protecting from replanning: every augmentation it promised is already
    // owned or queued, so continuing to grind its reputation target earns
    // nothing at all. Completeness is deliberately about reputation rather than
    // ownership — purchases are end-loaded — but "nothing left to buy" is a
    // different question from "not paid for yet", and only this one can strand
    // the work loop on an empty promise.
    // An EMPTY promise is not the same thing: a favor-only breakpoint sells no
    // augmentation at all, and `[].every(...)` is true, so testing ownership
    // alone would refuse to latch every favor push and thrash the plan.
    && !(previousIntent.augmentations.length > 0
      && previousIntent.augmentations.every((name) => view.owned.has(name))),
  );
  // Membership is a structural improvement in certainty. A speculative
  // package whose faction is still locked must not hold the latch after a
  // joined/invited package becomes the fresh winner: its ETA is executable
  // now, while the old ETA still depends on another feature's coarse blocker
  // model. Measured failure before this rule: each newly joined early faction
  // sat unused behind a five-minute stall window for an unjoined combat/city
  // faction, consuming most of an install cycle without earning reputation.
  const freshStanding = fresh.intent
    ? view.factions.find((standing) => standing.name === fresh.intent!.faction)
    : undefined;
  if (
    keepPrevious
    && previousStanding
    && !previousStanding.joined
    && !previousStanding.invited
    && (freshStanding?.joined === true || freshStanding?.invited === true)
  ) {
    keepPrevious = false;
  }
  // Once the selected faction-acquisition route exposes its terminal
  // augmentation, it is no longer an ordinary value/sec bidder. Do not let a
  // previously latched optional package delay the route-ending reputation
  // grind merely because that package is still making progress. This remains
  // route-generic: routeAware selection is what decides whether The Red Pill
  // is terminal, and routes that do not use it never produce this fresh intent.
  if (
    keepPrevious
    && fresh.intent?.augmentations.includes("The Red Pill")
    && !previousIntent?.augmentations.includes("The Red Pill")
  ) {
    keepPrevious = false;
  }
  // Stall escape for the latch: zero reputation progress for INTENT_STALL_MS
  // while the frontier prefers a DIFFERENT package means the latched intent
  // is not merely slow, it is unservable — measured: an employment-gated
  // package latched at t=0 held the whole feature idle for two hours while a
  // one-blocker faction sat ignored. Re-selecting the same package resets
  // nothing, so a legitimately slow grind is never dropped.
  let intentKey = memory.intentKey;
  let intentRepSeen = memory.intentRepSeen;
  let intentProgressAt = memory.intentProgressAt;
  if (keepPrevious && previousIntent && previousStanding) {
    if (intentKey !== previousIntent.faction || intentRepSeen === undefined || previousStanding.rep > intentRepSeen) {
      intentKey = previousIntent.faction;
      intentRepSeen = previousStanding.rep;
      intentProgressAt = view.time;
    } else if (
      view.time - (intentProgressAt ?? view.time) >= INTENT_STALL_MS &&
      fresh.intent !== undefined &&
      fresh.intent.faction !== previousIntent.faction
    ) {
      keepPrevious = false;
    }
  }
  const objective = keepPrevious ? refreshedPrevious! : promotedRunner ?? fresh;
  if (!keepPrevious) {
    intentKey = objective.intent?.faction;
    intentRepSeen = undefined;
    intentProgressAt = view.time;
  }
  if (objective.runnerUp) {
    alternatives.push({
      label: `${objective.runnerUp.faction} to ${formatNumber(objective.runnerUp.repTarget)} rep`,
      value: objective.runnerUp.value / Math.max(1, objective.runnerUp.etaSec),
    });
  }

  const allBlockers: (Blocker & { faction: string })[] = [];
  for (const name of objective.factions) {
    for (const entry of blockers.get(name) ?? []) allBlockers.push({ ...entry, faction: name });
  }
  const needOwners = [...new Set(allBlockers.filter((b) => b.reachable).map((b) => b.owner))];

  // The drain ceiling survives ONLY through consecutive recommending-drain
  // decisions (set again below); any other decision clears it, so an aborted
  // drain can never leak a stale, lower snapshot into the next one.
  const {
    drainCeiling: _staleCeiling,
    drainOrder: _staleOrder,
    drainSources: _staleSources,
    drainResidualDonations: _staleResidualDonations,
    drainStartNeurofluxLevel: _staleDrainNfg,
    intentKey: _ik,
    intentRepSeen: _irs,
    intentProgressAt: _ipa,
    ...carried
  } = memory;
  const next = {
    ...carried,
    bankedAugmentations: [...bankedAugmentations].sort(),
    objective,
    lastInvalidation: invalidation,
    // Committed only when the budget was actually re-derived this pass. A
    // reused budget must not refresh its own timestamp, or the recalibration
    // cadence would never fire.
    ...(budgetStale
      ? {
          portfolioBudgetSec: selection.portfolio.budgetSec,
          portfolioBasis: basis,
          portfolioAt: view.time,
          portfolioChoices: selection.portfolio.packages.map((pkg) => ({
            faction: pkg.faction,
            repTarget: pkg.repTarget,
          })),
        }
      : {}),
    ...(intentKey !== undefined ? { intentKey } : {}),
    ...(intentRepSeen !== undefined ? { intentRepSeen } : {}),
    ...(intentProgressAt !== undefined ? { intentProgressAt } : {}),
  };
  // Irreversible transaction boundary: after the first final-sweep purchase
  // was authorized, only finish that sweep and install. No graft, join,
  // travel, or renewed work may reopen the package under escalated prices.
  // `installRequested` is not this boundary: it can stay set through minutes
  // of committed work, when safe memberships should already earn passive rep.
  const drainLatched = memory.drainCeiling !== undefined;

  // --- 1) join --------------------------------------------------------------
  // Consume every compatible invitation in ONE action. Spawning one dodge per
  // faction turned a seven-invite backlog into minutes of avoidable latency,
  // during which none of those factions earned passive reputation.
  //
  // Planned factions go first. Unplanned invitations are welcome when they do
  // not conflict with any still-unjoined faction in the committed portfolio.
  // The durable choices are included alongside the current objective because a
  // promoted/latching objective can temporarily expose only its current head.
  // Check both enemy directions: metadata is a fact about each faction, not a
  // promise that every synthetic or partially observed table is symmetric.
  const protectedFactions = new Set([
    ...objective.factions,
    ...(next.portfolioChoices ?? []).map((choice) => choice.faction),
  ]);
  const conflictsWith = (left: FactionStanding, right: FactionStanding): boolean =>
    left.enemies.includes(right.name) || right.enemies.includes(left.name);
  const pendingInvites = view.factions.filter((standing) => standing.invited && !standing.joined);
  const inviteOrder = [...pendingInvites].sort((left, right) => {
    const leftPlanned = protectedFactions.has(left.name);
    const rightPlanned = protectedFactions.has(right.name);
    if (leftPlanned !== rightPlanned) return leftPlanned ? -1 : 1;
    // With no planned preference, choose the least-exclusive side first. For
    // the city graph this selects the three compatible eastern factions over
    // a two-faction western side or Volhaven alone.
    const leftConflicts = pendingInvites.filter((other) => other !== left && conflictsWith(left, other)).length;
    const rightConflicts = pendingInvites.filter((other) => other !== right && conflictsWith(right, other)).length;
    return leftConflicts - rightConflicts || left.name.localeCompare(right.name);
  });
  const invitations: FactionStanding[] = [];
  if (!drainLatched) {
    for (const candidate of inviteOrder) {
      if (view.factions.some((member) => member.joined && conflictsWith(candidate, member))) continue;
      if (
        !protectedFactions.has(candidate.name) &&
        view.factions.some(
          (planned) =>
            !planned.joined &&
            protectedFactions.has(planned.name) &&
            conflictsWith(candidate, planned),
        )
      ) continue;
      if (invitations.some((selected) => conflictsWith(candidate, selected))) continue;
      invitations.push(candidate);
    }
  }
  if (invitations.length > 0) {
    const action: FactionAction = {
      type: "joinFactions",
      factions: invitations.map((standing) => standing.name),
    };
    return {
      memory: { ...next, lastAction: action },
      decision: { objective, action, alternatives, blockers: allBlockers, needOwners, invalidation },
    };
  }

  if (view.currentWork?.kind === "grafting") {
    // https://github.com/bitburner-official/bitburner-src/blob/3162fd2590e221eadd0c0fbd46151913f7c4c41c/src/Work/GraftingWork.tsx#L26-L98
    const action: FactionAction = { type: "idle", reason: "continue" };
    return {
      memory: { ...next, lastAction: action },
      decision: { objective, action, alternatives, blockers: allBlockers, needOwners, invalidation },
    };
  }

  // --- 2) purchase: DELIBERATELY ABSENT mid-run -------------------------------
  // The two-loop money rule: an augmentation does nothing until the install
  // reset, and every queued purchase escalates every LATER purchase 1.9x. So
  // buying mid-run both pulls money out of compounding investments and pays
  // the escalation on items a later package would have wanted cheap. ALL
  // purchases happen in the final-sweep drain (below), dearest-first, once
  // the objective work is done and the whole bankroll is known. The old
  // buy-as-soon-as-rep-and-money-allow path lived here.
  // https://github.com/bitburner-official/bitburner-src/blob/3162fd2590e221eadd0c0fbd46151913f7c4c41c/src/Faction/FactionHelpers.tsx#L109-L141
  // https://github.com/bitburner-official/bitburner-src/blob/3162fd2590e221eadd0c0fbd46151913f7c4c41c/src/Augmentation/AugmentationHelpers.ts#L24-L38

  // Grafting is priced in MONEY AND TIME and needs no reputation at all, so the
  // reputation-budgeted objective is the wrong filter for it. An augmentation
  // this cycle declined to grind for — because its reputation gate is hours
  // away — may still be sixty seconds and ten million dollars away at the
  // clinic. Offer the objective first (it keeps purchase priority), then every
  // other graftable name by its own value; `nextGraft` applies the entropy,
  // affordability and horizon tests itself, so widening the candidate list
  // cannot loosen any of them.
  const graftCandidates = objective.augmentations.concat(
    (view.graftable ?? [])
      .filter((offer) => !objective.augmentations.includes(offer.name) && !view.owned.has(offer.name))
      .map((offer) => offer.name)
      .sort((a, b) => {
        const left = view.catalog.get(a);
        const right = view.catalog.get(b);
        return (right ? scoreAug(right, view.weights, view.rates?.worth) : 0)
          - (left ? scoreAug(left, view.weights, view.rates?.worth) : 0);
      }),
  );
  const graft = view.installRequested || drainLatched ? undefined : nextGraft(view, graftCandidates);
  if (graft) {
    // https://github.com/bitburner-official/bitburner-src/blob/3162fd2590e221eadd0c0fbd46151913f7c4c41c/src/NetscriptFunctions/Grafting.ts#L17-L103
    const action: FactionAction = view.requirementView.city === "New Tokyo"
      ? { type: "graft", augmentation: graft }
      : { type: "travelTo", city: "New Tokyo" };
    return {
      memory: { ...next, lastAction: action },
      decision: { objective, action, alternatives, blockers: allBlockers, needOwners, invalidation },
    };
  }

  // --- 3) travel ------------------------------------------------------------
  // ONLY when it is the last remaining requirement for a faction. Travelling
  // invalidates other city-bound requirements, so issuing it speculatively
  // produces a loop: travel for A, which breaks B, travel back for B, which
  // breaks A.
  // https://github.com/bitburner-official/bitburner-src/blob/3162fd2590e221eadd0c0fbd46151913f7c4c41c/src/Faction/FactionJoinCondition.ts#L196-L214
  const travel = view.installRequested || drainLatched ? undefined : soleTravelBlocker(allBlockers);
  if (travel) {
    const action: FactionAction = { type: "travelTo", city: travel.subject! };
    return {
      memory: { ...next, lastAction: action },
      decision: { objective, action, alternatives, blockers: allBlockers, needOwners, invalidation },
    };
  }

  // --- 4) work / donate -----------------------------------------------------
  // Progression owns the install CADENCE. When its marginal-value rule says
  // the reset now beats pushing further, this feature must CONCLUDE — stop
  // working toward the objective and run the final sweep with whatever
  // reputation is banked. Without this the install waits on "factions has not
  // finished its sweep" while factions keeps pushing a multi-hour objective
  // it was never told to abandon (measured: 0 installs in 30 minutes on the
  // cadence fixture while progression wanted one from minute 2).
  const extraPushBudgetSec = Math.max(0, view.installCycleSec ?? 0) * EXTRA_AUG_PUSH_FRACTION;
  const activePackageInFlight = Boolean(
    view.installRequested
    && view.routeInstallRequired !== true
    && memory.drainCeiling === undefined
    && objective.intent
    && objective.intent.purpose === "augmentations"
    && previousIntent
    && objective.intent.faction === previousIntent.faction
    && objective.intent.repTarget === previousIntent.repTarget
    && !previousComplete,
  );
  const opportunisticPush = Boolean(
    view.installRequested
    && view.routeInstallRequired !== true
    && memory.drainCeiling === undefined
    && !activePackageInFlight
    && objective.intent
    && objective.intent.purpose === "augmentations"
    && objective.intent.augmentations.some((name) => !view.owned.has(name))
    && objective.intent.etaSec <= extraPushBudgetSec,
  );
  // Cadence may arm while a committed package is still in flight. Finish that
  // package: the 1% rule applies only AFTER its breakpoint, to a promoted
  // runner/new extra package. Treating the active package itself as the extra
  // abandoned nearly-complete augmentations and made the published install
  // ETA cease to describe the work we would actually perform.
  // Starting the first purchase closes the package. Progression can revise its
  // marginal-value verdict after the queue changes, but that must not reopen
  // faction work: doing so buys the base package, then earns another package
  // under inflated prices, exactly the ordering loss end-loading avoids.
  const target = !drainLatched && (!view.installRequested || activePackageInFlight || opportunisticPush)
    ? pickWorkFaction(view, next, objective, alternatives)
    : undefined;
  if (!target) {
    // Completing one faction breakpoint does not decide the install. Keep the
    // bankroll unqueued while progression's renewal model still says push;
    // otherwise every package boundary starts paying the 1.9x ladder early.
    // An existing queue is already irreversible (including external/manual
    // purchases), and a route-mandatory reset may close immediately.
    const mayCloseTransaction = (view.installRequested && !activePackageInFlight && bankedFunded)
      || view.routeInstallRequired === true
      || view.queued.size > 0
      || drainLatched;
    const recommendation = (view.installRequested
        && !activePackageInFlight
        && bankedAugmentations.size > 0
        && (terminalRequired.length === 0 || bankedFunded)
        ? { augmentations: [...bankedAugmentations] }
        : undefined)
      ?? (mayCloseTransaction ? shouldRecommendInstall(view, objective) : undefined)
      ?? (drainLatched
      ? { augmentations: [...view.queued] }
      : undefined);
    // Last-chance drain. This is intentionally broader than the objective:
    // once progression is about to reset, every augmentation we can still buy
    // beats carrying the cash into the reset — WITHIN the BitNode. The metric
    // is BN completion time: augmentations are lost when the node ends, so a
    // NeuroFlux level (~+1% mults) is only worth its acceleration of the
    // REMAINING node. With minutes left it can never repay the drain and
    // install overhead, so NFG drops out of the sweep; an unknown horizon
    // (Infinity) keeps the full drain. Keep the same priority order, falling
    // downward when a better item is not currently affordable. NeuroFlux is
    // repeatable; the frozen-set solver interleaves its funded levels with
    // one-shots at the cheapest dependency-safe positions.
    // The drain spends the pile that exists when it STARTS — cash on hand PLUS
    // the stock book's liquidation value, because the book only converts once
    // the endgame begins and its proceeds are exactly the money this drain
    // exists to convert. Frozen once, here: testing against live money instead
    // lets a fast farm outrun the NeuroFlux price ladder level after level,
    // and the install waits on a race.
    // https://github.com/bitburner-official/bitburner-src/blob/3162fd2590e221eadd0c0fbd46151913f7c4c41c/src/Augmentation/Augmentations.ts#L1159-L1209
    // https://github.com/bitburner-official/bitburner-src/blob/3162fd2590e221eadd0c0fbd46151913f7c4c41c/src/Augmentation/AugmentationHelpers.ts#L24-L38
    const proposedCeiling = recommendation
      ? memory.drainCeiling
        ?? view.moneyAvailable
          + (view.queued.size === 0 || view.proceedsSettling ? view.pendingProceeds : 0)
      : undefined;
    // The spend-down bound applies to the NEUROFLUX LADDER ONLY: it is the
    // repeatable item whose price escalation can race income forever. It
    // drops out of the sweep when the next level exceeds min(frozen ceiling,
    // cash on hand) — or when the remaining node cannot repay it. One-shot
    // augmentations keep nextPurchase's own patience rules (hold only while
    // liquidation proceeds with a settlement date cover the gap).
    const cadenceRequired = view.routeInstallRequired === true
      ? []
      : (view.installFundedAugmentations ?? []).filter(
          (name) => name !== NEUROFLUX && !view.owned.has(name),
        );
    const proposedSweepPlan = recommendation
      ? finalSweepWanted(
          view,
          proposedCeiling ?? Infinity,
          [...terminalRequired, ...cadenceRequired],
        )
      : { order: [], sources: {}, requiredFunded: true };
    const proposedSweep = proposedSweepPlan.order;
    const startNfgLevel = memory.drainStartNeurofluxLevel ?? view.priceContext.neurofluxLevel;
    let consumedNfg = Math.max(0, view.priceContext.neurofluxLevel - startNfgLevel);
    const frozenRemaining = memory.drainOrder?.filter((name) => {
      if (name !== NEUROFLUX || consumedNfg === 0) return true;
      consumedNfg--;
      return false;
    });
    const sweepAll = frozenRemaining ?? proposedSweep;
    const sweepSources = memory.drainSources ?? proposedSweepPlan.sources;
    const drainBudget = proposedCeiling !== undefined ? Math.min(proposedCeiling, view.moneyAvailable) : 0;
    // The payback filter is part of SET selection. Once the first purchase
    // freezes a proven order, changing horizon estimates may not remove an NFG
    // from the middle and expose later items to a different 1.9x queue depth.
    const wanted = memory.drainOrder !== undefined
      || view.routeInstallRequired === true
      || view.horizonSec > NFG_MIN_PAYBACK_SEC
        ? sweepAll
        : sweepAll.filter((name) => name !== NEUROFLUX);
    // Merely completing a reputation breakpoint is not a transaction. If the
    // frozen pile selects no purchase and the queue is still empty, release
    // the tentative boundary so income and the next package can continue.
    // Once even one purchase exists, the 1.9x escalation is irreversible and
    // the latch must survive until install.
    // A route may project reputation-banked names into its count queue before
    // they are purchased. That is useful for deciding when the closing batch
    // is ready, but it is not proof the frozen bankroll can buy every required
    // slot under 1.9x escalation. Do not start the irreversible transaction
    // unless the actual affordable set closes the finite gate. Repeated NFG
    // naturally contributes only once through Set semantics.
    const projectedDistinctCount = new Set([
      ...view.owned,
      ...view.queued,
      ...wanted,
    ]).size;
    const fundedRouteCount = view.routeInstallRequired !== true
      || !Number.isFinite(view.targetAugCount)
      || view.owned.size >= view.targetAugCount
      || projectedDistinctCount >= view.targetAugCount;
    const recommend = recommendation !== undefined
      && fundedRouteCount
      && (memory.drainOrder !== undefined || proposedSweepPlan.requiredFunded)
      && (wanted.length > 0 || view.queued.size > 0)
      ? recommendation
      : undefined;
    const ceiling = recommend ? proposedCeiling : undefined;
    const drainOrder = recommend ? memory.drainOrder ?? wanted : undefined;
    const drainSources = recommend ? sweepSources : undefined;
    const drainStartNeurofluxLevel = recommend ? startNfgLevel : undefined;
    let drainMemory = {
      ...next,
      ...(ceiling !== undefined ? { drainCeiling: ceiling } : {}),
      ...(drainOrder !== undefined ? { drainOrder } : {}),
      ...(drainSources !== undefined ? { drainSources } : {}),
      ...(memory.drainResidualDonations !== undefined
        ? { drainResidualDonations: memory.drainResidualDonations }
        : {}),
      ...(drainStartNeurofluxLevel !== undefined ? { drainStartNeurofluxLevel } : {}),
    };
    // What the drain would buy if money were no object. Published on the decision
    // so the driver can claim exactly that much: `nextPurchase` above tests the
    // GRANTED budget, and a grant only exists once something claimed it. Derived
    // from the plan rather than the funded action, it survives the whole drain —
    // including the ticks where a purchase is in flight — so the claim does not
    // blink out between buys.
    // Publish only an intent the frozen drain pile can really fund. Infinity
    // is appropriate before the boundary (it bootstraps a claim), but here it
    // resurrects a candidate the batch selector deliberately dropped and
    // leaves progression waiting on an impossible purchase forever.
    const nextName = recommend
      ? wanted.find((name) => name === NEUROFLUX || !view.owned.has(name))
      : undefined;
    const nextAug = nextName ? view.catalog.get(nextName) : undefined;
    const nextBuyDigest = nextName && nextAug
      ? { nextBuy: { name: nextName, price: augCost(nextAug, view.priceContext).moneyCost } }
      : {};
    let drainCosts = recommend && nextName !== undefined
      ? remainingSweepCosts(view, wanted, sweepSources)
      : { purchase: 0, donation: 0, residualDonation: 0, total: 0 };
    // Decide from the frozen cash pile, then let the driver enforce the
    // current-pass arbiter grant. Deciding from moneyGranted is circular: the
    // claim comes from the published decision, so a purchase can remain idle
    // even while the arbiter is granting both its exact fund and RAM.
    const sweep = recommend
      ? nextSweepAction({ ...view, moneyGranted: drainBudget }, wanted, sweepSources)
      : undefined;
    if (sweep) {
      const ceilingDigest = { drainCeiling: ceiling!, drainCosts };
      return {
        memory: {
          ...drainMemory,
          lastAction: sweep,
        },
        decision: { objective, action: sweep, alternatives, blockers: allBlockers, needOwners, invalidation, ...nextBuyDigest, ...ceilingDigest },
      };
    }

    // Once every frozen purchase has landed, snapshot the remaining cash once
    // and turn it into useful post-install favor. The snapshot is part of the
    // transaction memory: income arriving after it cannot reopen the drain.
    if (recommend && nextName === undefined) {
      const pointValues = factionFavorPointValues(view);
      const futureWorkSec = Object.fromEntries(
        [...pointValues].map(([faction, value]) => [faction, value.remainingWorkSec]),
      );
      const residual = memory.drainResidualDonations
        ?? (view.endingByDestroy === true
          ? []
          : allocateResidualDonations({
            money: view.moneyAvailable,
            standings: view.factions,
            favorToDonate: view.favorToDonate,
            factionRepMult: view.person.mults.faction_rep,
            factionWorkRepGain: view.repContext.factionWorkRepGain,
            futureWorkSec,
          }));
      const pendingResidual: { standing: FactionStanding; amount: number }[] = [];
      for (const entry of residual) {
        const standing = view.factions.find((candidate) => candidate.name === entry.faction);
        if (!standing || standing.rep + 1e-9 >= entry.repTarget) continue;
        pendingResidual.push({
          standing,
          amount: donationForRep(
            entry.repTarget - standing.rep,
            view.person.mults.faction_rep,
            view.repContext.factionWorkRepGain,
          ),
        });
      }
      const residualDonation = pendingResidual.reduce((sum, entry) => sum + entry.amount, 0);
      drainCosts = { purchase: 0, donation: 0, residualDonation, total: residualDonation };
      drainMemory = { ...drainMemory, drainResidualDonations: residual };
      const pending = pendingResidual[0];
      if (pending) {
        const action: FactionAction = {
          type: "donate",
          faction: pending.standing.name,
          amount: pending.amount,
        };
        return {
          memory: { ...drainMemory, lastAction: action },
          decision: {
            objective,
            action,
            alternatives,
            blockers: allBlockers,
            needOwners,
            invalidation,
            drainCeiling: ceiling!,
            drainCosts,
          },
        };
      }
    }
    const ceilingDigest = ceiling !== undefined ? { drainCeiling: ceiling, drainCosts } : {};
    const action: FactionAction = {
      type: "idle",
      reason: allBlockers.length > 0 ? "blocked" : "waiting",
    };
    return {
      memory: {
        ...drainMemory,
        lastAction: action,
      },
      decision: {
        objective,
        action,
        alternatives,
        blockers: allBlockers,
        needOwners,
        invalidation,
        ...nextBuyDigest,
        ...ceilingDigest,
        ...(recommend ? { recommendInstall: recommend } : {}),
      },
    };
  }

  // Published on every decision from here on, including the ones that idle —
  // see `FactionDecision.workRate` for why the idle case is the important one.
  //
  // Reputation work also produces AUGMENTATIONS, and saying so is what stops the
  // work slot being a money-only auction: reaching this package's reputation
  // target is the only way its augmentations become buyable, so the work
  // advances the route's count leg at `package size / package ETA`. That is a
  // property of the PACKAGE, identical for all three work types, so it is added
  // here rather than in `workProduces` — it cannot change which type wins.
  //
  // MEASURED on a cold `bn1-full` start: without it `career` outbid faction work
  // roughly 120:1 on money alone and held `Player.currentWork` on 89% of passes.
  // That is self-defeating — the money gate it bids for is reached through the
  // multipliers only an install grants, and only reputation unlocks the
  // augmentations an install activates.
  const packageIntent = objective.intent?.faction === target.faction ? objective.intent : undefined;
  const packageAugsPerSec = packageIntent && packageIntent.augmentations.length > 0
    ? packageIntent.augmentations.length / Math.max(1, packageIntent.etaSec)
    : 0;
  const workRate = {
    faction: target.faction,
    repPerSec: target.repPerSec,
    produces: packageAugsPerSec > 0
      ? { ...target.produces, [AUGMENTATIONS_CHANNEL]: packageAugsPerSec }
      : target.produces,
  };

  // Donation beats working once income exceeds the crossover — and only once
  // favor actually allows it. Favor cannot grow within a run, so a locked
  // route is a message to `progression`, not something to wait for.
  // https://github.com/bitburner-official/bitburner-src/blob/3162fd2590e221eadd0c0fbd46151913f7c4c41c/src/Faction/Faction.ts#L77-L85
  // https://github.com/bitburner-official/bitburner-src/blob/3162fd2590e221eadd0c0fbd46151913f7c4c41c/src/Faction/formulas/donation.ts#L7-L30
  const donateUnlocked = target.standing.favor >= view.favorToDonate;
  const repGap = Math.max(0, target.needed - target.standing.rep);
  const donationNeeded = donationForRep(repGap, view.person.mults.faction_rep, view.repContext.factionWorkRepGain);
  const crossover = donationCrossoverIncome(
    target.repPerSec,
    view.person.mults.faction_rep,
    view.repContext.factionWorkRepGain,
  );
  const intent = objective.intent?.faction === target.faction ? objective.intent : undefined;
  const donationIsFaster = (intent?.donationCost ?? 0) > 0 || view.incomePerSec > crossover;
  if (donateUnlocked && donationIsFaster) {
    const amount = donationNeeded;
    // The purchase this donation is reserving alongside itself is whichever one we
    // will actually make next, which is the head of the COST order — not the head
    // of the objective's value order. Reserving the cheaper one would let the
    // donation eat the difference and leave the purchase unaffordable.
    const nextAugmentation = purchaseOrder(view, objective.augmentations)[0];
    const nextAug = nextAugmentation ? view.catalog.get(nextAugmentation) : undefined;
    const nextPurchaseCost = nextAug ? augCost(nextAug, view.priceContext).moneyCost : 0;
    const action: FactionAction = {
      type: "donate",
      faction: target.faction,
      amount,
      ...(nextPurchaseCost > 0 ? { purchaseCost: nextPurchaseCost } : {}),
    };
    return {
      memory: { ...next, lastAction: action },
      decision: {
        objective,
        action,
        alternatives,
        blockers: allBlockers,
        needOwners,
        invalidation,
        workRate,
        until: untilRep(target.faction, target.needed, target.standing.rep, target.repPerSec),
      },
    };
  }

  // The continuation guard comes after cheap actions but before reissuing the
  // same work order.
  if (shouldContinue(view, memory, invalidation, target)) {
    const action: FactionAction = { type: "idle", reason: "continue" };
    return {
      memory: { ...next, lastAction: memory.lastAction },
      decision: {
        objective,
        action,
        alternatives,
        blockers: allBlockers,
        needOwners,
        invalidation,
        workRate,
        until: untilRep(target.faction, target.needed, target.standing.rep, target.repPerSec),
      },
    };
  }

  if (!view.holdsWorkSlot) {
    // The player can only do ONE thing. Saying so explicitly matters: the
    // panel previously showed the intended work as if it were running, which
    // read as a contradiction against the game's own display.
    // https://github.com/bitburner-official/bitburner-src/blob/3162fd2590e221eadd0c0fbd46151913f7c4c41c/src/PersonObjects/Player/PlayerObjectWorkMethods.ts#L5-L22
    const action: FactionAction = { type: "idle", reason: "slot" };
    return {
      memory: { ...next, lastAction: action },
      decision: {
        objective,
        action,
        alternatives,
        blockers: allBlockers,
        needOwners,
        invalidation,
        workRate,
      },
    };
  }

  // Below the crossover, working a faction SUPPRESSES its passive tick and
  // earns less than it gave up. Idling is strictly better, and saying so is
  // the whole point of modelling it.
  // https://github.com/bitburner-official/bitburner-src/blob/3162fd2590e221eadd0c0fbd46151913f7c4c41c/src/Faction/FactionHelpers.tsx#L143-L176
  const passive = passiveRepPerSec(view.person, target.standing.favor, view.repContext);
  if (target.repPerSec <= passive) {
    const action: FactionAction = { type: "idle", reason: "waiting" };
    alternatives.push({
      label: `work ${target.faction}`,
      value: target.repPerSec,
    });
    return {
      memory: { ...next, lastAction: action },
      decision: {
        objective,
        action,
        alternatives,
        blockers: allBlockers,
        needOwners,
        invalidation,
        workRate,
      },
    };
  }

  const action: FactionAction = {
    type: "workForFaction",
    faction: target.faction,
    workType: target.workType,
    focus: true,
  };
  return {
    memory: { ...next, lastAction: action, focusFaction: target.faction, focusSince: view.time },
    decision: {
      objective,
      action,
      alternatives,
      blockers: allBlockers,
      needOwners,
      invalidation,
      workRate,
      until: untilRep(target.faction, target.needed, target.standing.rep, target.repPerSec),
    },
  };
}
function untilRep(faction: string, target: number, have: number, ratePerSec: number): Until {
  const remaining = Math.max(0, target - have);
  return {
    kind: "rep",
    faction,
    target,
    have,
    etaSec: ratePerSec > 0 ? remaining / ratePerSec : Infinity,
  };
}

/** Travel is issued ONLY when it is the sole remaining blocker.
 *
 * Structurally typed on the fields it actually reads, so the claim phase can
 * ask the SAME question of the published digest. That matters: the fare is
 * claimed one pass before the decision that spends it, and a claim derived from
 * the previously-published action cannot anticipate an action the planner has
 * not taken yet. On a live BN12 run the two never coincided — 85 executions
 * recorded "waiting for $200,000 travel grant" while $57.7m sat unclaimed. */
export function soleTravelBlocker<T extends { faction: string; kind: string; subject?: string; negated?: boolean }>(
  blockers: readonly T[],
): T | undefined {
  const byFaction = new Map<string, T[]>();
  for (const entry of blockers) {
    const list = byFaction.get(entry.faction) ?? [];
    list.push(entry);
    byFaction.set(entry.faction, list);
  }
  for (const [, list] of byFaction) {
    if (list.length !== 1) continue;
    const only = list[0]!;
    if (only.kind === "city" && !only.negated && only.subject) return only;
  }
  return undefined;
}

function nextGraft(view: FactionsView, wanted: readonly string[]): string | undefined {
  if (!view.holdsWorkSlot) return undefined;
  const entropyPenalty = view.owned.has("violet Congruity Implant") ? 0 : entropyCost(view.weights);
  for (const name of wanted) {
    if (view.owned.has(name)) continue;
    const offer = view.graftable?.find((entry) => entry.name === name);
    const aug = view.catalog.get(name);
    if (!offer || !aug || offer.timeMs / 1_000 >= view.horizonSec) continue;
    if (aug.prereqs.some((prereq) => !view.owned.has(prereq))) continue;
    const benefit = scoreAug(aug, view.weights, view.rates?.worth);
    if (benefit <= entropyPenalty || (view.graftGranted ?? view.moneyGranted) < offer.price) continue;
    return name;
  }
  return undefined;
}

/** Everything the run may still spend, including income over what is left of the
 * horizon. This chooses the SET, where guessing high costs only a re-plan.
 *
 * An unknown horizon contributes nothing rather than everything: `horizonSec` is
 * `Infinity` when the forecast has no answer, and an infinite budget would "afford"
 * the entire catalogue. */
function plannedBudget(view: FactionsView): number {
  const horizonSec = Number.isFinite(view.horizonSec) ? Math.max(0, view.horizonSec) : 0;
  return view.moneyAvailable
    + Math.max(0, view.pendingProceeds)
    + Math.max(0, view.incomePerSec) * horizonSec;
}

/** The next augmentation we can actually buy right now.
 *
 * `money` defaults to the granted budget — what we may spend. Pass `Infinity` to
 * ask the different question "what WOULD we buy", which is what a money claim has
 * to be derived from: the purchase needs a grant, the grant needs a claim, and a
 * claim read off the already-funded decision can never bootstrap.
 *
 * PATIENCE. `wanted` arrives dearest-first, and falling through to a cheaper item
 * because the dearest is momentarily short of cash is not a graceful degradation —
 * it is the ordering mistake this whole path exists to avoid, and it is permanent:
 * the skipped item now costs 1.9x more forever. So a MONEY shortfall on an item we
 * still expect to afford stops the walk. Two shortfalls do not:
 *
 *  - REPUTATION. We cannot buy it at any price today, and no amount of waiting at
 *    this step changes that — work and donation are what move it, and they are the
 *    actions further down the tree. Fall through.
 *  - MONEY WITH NO SETTLEMENT DATE. Once {@link settlingMoney} — cash plus the
 *    market book — cannot cover the item, there is nothing definite to wait for,
 *    and a cheaper augmentation owned beats a dearer one admired. Fall through.
 *
  * AN EMPTY QUEUE NEEDS A DIFFERENT HANDSHAKE. This function cannot wait on an
  * inactive liquidation: outside the final drain it falls through to an affordable
  * item, avoiding the old factions/stock deadlock. At the final drain boundary,
  * `stepFactions` may instead publish `liquidationNeeded` when the book covers the
  * dearest planned item. Progression then starts liquidation without pretending an
  * empty queue is installable, and this function can safely hold once settlement is
  * actually under way.
  * https://github.com/bitburner-official/bitburner-src/blob/3162fd2590e221eadd0c0fbd46151913f7c4c41c/src/Augmentation/AugmentationHelpers.ts#L24-L38 */
function nextPurchase(
  view: FactionsView,
  wanted: readonly string[],
  money: number = view.moneyGranted,
): { action: FactionAction; name: string; price: number } | undefined {
  // `Infinity` marks the intent query, which asks what we would buy rather than
  // whether to buy it yet, so it never waits. Nor does the run's first purchase.
  const hold = money !== Infinity && view.queued.size > 0;
  const settling = hold ? settlingMoney(view) : Infinity;
  for (const name of wanted) {
    const aug = view.catalog.get(name);
    if (!aug || (name !== NEUROFLUX && view.owned.has(name))) continue;
    // Prerequisites must already be owned or queued.
    // https://github.com/bitburner-official/bitburner-src/blob/3162fd2590e221eadd0c0fbd46151913f7c4c41c/src/Faction/FactionHelpers.tsx#L52-L108
    if (aug.prereqs.some((prereq) => !view.owned.has(prereq))) continue;
    const { moneyCost, repCost } = augCost(aug, view.priceContext);
    const sellers = view.factions.filter(
      (standing) => standing.joined && aug.factions.includes(standing.name),
    );
    const sources = sellers
      .map((standing) => {
        const verdict = canAfford({
          moneyCost,
          repCost,
          factionRep: standing.rep,
          money,
        });
        return { standing, verdict };
      })
      .filter((source) => source.verdict.ok)
      .sort(
        (a, b) =>
          // Donation rep does NOT scale with favor (rep.ts repFromDonation) —
          // favor only gates eligibility — so the cheapest source is the one
          // needing the smallest donation, i.e. the highest rep. Favor is a
          // deterministic tie-break that also happens to leave the top-favor
          // faction's rep intact for the NeuroFlux ladder.
          a.verdict.needDonation - b.verdict.needDonation ||
          b.standing.rep - a.standing.rep ||
          b.standing.favor - a.standing.favor ||
          (a.standing.name < b.standing.name ? -1 : 1),
      );
    const source = sources[0];
    if (!source) {
      // Short of cash on something we still expect to afford: wait for it rather
      // than jumping the queue. Anything cheaper stays cheap; this one would not.
      // Reputation shortfalls the book cannot close fall through instead — and
      // that check must be EXPLICIT: an item that is both rep-short and
      // money-short with no donation path is a rep problem money cannot cure,
      // and holding for its settlement deadlocked the whole sweep behind a
      // faction joined at reputation 1 (measured: the drain sat idle for a
      // full run while a funded NeuroFlux waited behind CashRoot's 12,500-rep
      // wall). A DONATION-CLOSABLE gap is a money problem, though: skipping
      // it buys something cheaper first and pays 1.9x escalation on the dear
      // item the settlement would have funded.
      const settleable = sellers.some(
        (standing) => standing.rep >= repCost || standing.favor >= view.favorToDonate,
      );
      if (hold && settleable && money < moneyCost && settling >= moneyCost) return undefined;
      continue;
    }
    return {
      name,
      price: moneyCost,
      action: {
        type: "purchaseAugmentation",
        faction: source.standing.name,
        augmentation: name,
      },
    };
  }
  return undefined;
}
/** All joined-faction purchases worth attempting before an install, in the order
 * to BUY them.
 *
 * Selection is by value, execution is by price. Ordering is not cosmetic: buying a $1m
 * augmentation before a $500m one pays the 1.9x queue escalation on the $500m
 * instead of on the $1m, and the batch that was affordable as a plan stops being
 * affordable as a sequence. The drain freezes this list before its first
 * purchase and buys one head per tick, reproducing the planned order.
 *
 * NeuroFlux is selected as a residual sink, then jointly reordered with the
 * accepted one-shot set; it is not forced to the expensive end of the ladder.
 * https://github.com/bitburner-official/bitburner-src/blob/3162fd2590e221eadd0c0fbd46151913f7c4c41c/src/Augmentation/AugmentationHelpers.ts#L24-L38 */
interface FinalSweepPlan {
  order: string[];
  sources: Record<string, string>;
  requiredFunded: boolean;
}

function finalSweepWanted(
  view: FactionsView,
  budgetCap = Infinity,
  requiredNames: readonly string[] = [],
): FinalSweepPlan {
  const joined = new Set(view.factions.filter((standing) => standing.joined).map((standing) => standing.name));
  const countSlotsRemaining = Number.isFinite(view.targetAugCount)
    ? Math.max(0, view.targetAugCount - view.owned.size)
    : 0;
  const countValue = countSlotWeight(view.rates?.worth ?? new Map(), countSlotsRemaining);
  const byValue = [...view.catalog.values()]
    .filter(
      (aug) =>
        aug.name !== NEUROFLUX &&
        !view.owned.has(aug.name) &&
        aug.factions.some((faction) => joined.has(faction)),
    )
    .sort(
      (a, b) => {
        const aValue = Math.max(1e-9, scoreAug(a, view.weights, view.rates?.worth) + countValue);
        const bValue = Math.max(1e-9, scoreAug(b, view.weights, view.rates?.worth) + countValue);
        // Before a route's installed-augmentation gate is full, every unique
        // one-shot also advances that gate by one. Select the affordable SET
        // by route-value per base dollar; the exact payment solver below still
        // buys the chosen set dearest-first to minimise 1.9x escalation.
        const efficiency = a.baseCost / aValue - b.baseCost / bValue;
        return efficiency || scoreAug(b, view.weights, view.rates?.worth) - scoreAug(a, view.weights, view.rates?.worth) || (a.name < b.name ? -1 : 1);
      },
    )
    .map((aug) => aug.name);

  const budget = Math.min(plannedBudget(view), budgetCap);

  // A route-mandatory count transaction first proves the cheapest distinct
  // closure, including donation costs, then spends the residual on quality.
  const countClosure = view.routeInstallRequired === true && countSlotsRemaining > 0
    ? selectDonationAwareCountClosure({
      catalog: new Map([...view.catalog].filter(([name]) => name !== NEUROFLUX)),
      standings: view.factions,
      owned: view.owned,
      wanted: countSlotsRemaining,
      ctx: view.priceContext,
      money: budget,
      favorToDonate: view.favorToDonate,
      factionRepMult: view.person.mults.faction_rep,
      factionWorkRepGain: view.repContext.factionWorkRepGain,
      tieValue: (aug) => scoreAug(aug, view.weights, view.rates?.worth),
    }).order.map((candidate) => candidate.name)
    : [];

  // The selector proves the required closure before accepting optional value,
  // so an attractive optional item cannot displace a route requirement.
  // De-duplicate after closing both lists because
  // an optional augmentation may share a prerequisite with the required one.
  const required = closePrereqs(requiredNames, view.catalog, view.owned);
  const candidateNames = [
    ...required,
    ...countClosure,
    ...closePrereqs(byValue, view.catalog, new Set([...view.owned, ...required, ...countClosure])),
  ];
  const seen = new Set<string>();
  const valueOrder: string[] = [];
  for (const name of candidateNames) if (!seen.has(name)) { seen.add(name); valueOrder.push(name); }
  // The whole bankroll, not the granted slice, and not cash alone: this decides
  // which SET is worth planning, and at this boundary the market book is about to
  // become cash while the cash itself is about to be deleted by the install.
  // The drain passes its frozen ceiling as the cap: planning with the
  // income-over-horizon slack there names items the pile can never cover, and
  // the driver's priority-90 reserve for an uncoverable nextBuy starves every
  // lower band with no timeout.
  const plan = selectDonationAwareBatch({
    valueOrder,
    required: [...required, ...countClosure],
    catalog: view.catalog,
    standings: view.factions,
    owned: view.owned,
    ctx: view.priceContext,
    money: budget,
    favorToDonate: view.favorToDonate,
    factionRepMult: view.person.mults.faction_rep,
    factionWorkRepGain: view.repContext.factionWorkRepGain,
  });

  let order = plan.order;
  const neuroflux = view.catalog.get(NEUROFLUX);
  if (neuroflux) {
    const sellers = view.factions.filter(
      (standing) => standing.joined && neuroflux.factions.includes(standing.name),
    );
    // The ladder's nominal seller is the one whose donation gap per level is
    // smallest: highest reputation first (donation rep does not scale with
    // favor — favor only gates), favor then name as deterministic tie-breaks.
    // sellers[0] was whatever order view.factions arrived in, which could
    // price the whole ladder against a rep-1 faction and underfill it.
    const source = [...sellers]
      .sort((a, b) => b.rep - a.rep || b.favor - a.favor || (a.name < b.name ? -1 : 1))[0]?.name;
    if (source) {
      let nfgCandidate: PurchaseCandidate = { name: NEUROFLUX, aug: neuroflux, faction: source };
      let bestOrder = order;
      // Prices grow by at least 1.9x per level, so this terminates in a handful
      // of iterations in real data. The cap is only a corruption guard.
      //
      // Bound the search first, with the NeuroFlux ladder priced ALONE at a
      // zero queue offset: the one-shots can only make each level dearer, so
      // this is a true upper bound on the levels any budget can reach. Then one
      // joint solve yields the order for every count within it — the DP state
      // already carries the level counter, so re-entering it per level made
      // this decision (which chainWake runs at controller-pass cadence during
      // the drain) re-derive every cheaper answer from scratch.
      let ladderCost = 0;
      let maxLevels = 0;
      while (maxLevels < 64) {
        ladderCost += augCost(
          neuroflux,
          { ...view.priceContext, neurofluxLevel: view.priceContext.neurofluxLevel + maxLevels },
        ).moneyCost;
        if (ladderCost > budget) break;
        maxLevels++;
      }
      for (let count = 1; count <= maxLevels; count++) {
        const repCost = augCost(
          neuroflux,
          { ...view.priceContext, neurofluxLevel: view.priceContext.neurofluxLevel + count - 1 },
        ).repCost;
        // Re-solve seller assignment with the highest NFG reputation target as
        // one synthetic requirement. This captures the important shared-cost
        // case: a donation made for NFG also unlocks every lower one-shot sold
        // by that faction, rather than being charged twice.
        const synthetic = {
          ...neuroflux,
          name: `${NEUROFLUX}#${count}`,
          baseRepRequirement: repCost / Math.max(1e-12, view.priceContext.augRepCost),
          prereqs: [],
        };
        const assignment = assignDonationSellers({
          augs: [...plan.order.map((candidate) => candidate.aug), synthetic],
          standings: view.factions,
          favorToDonate: view.favorToDonate,
          factionRepMult: view.person.mults.faction_rep,
          factionWorkRepGain: view.repContext.factionWorkRepGain,
          ctx: view.priceContext,
        });
        if (!assignment) break;
        const nfgSource = assignment.candidates.find((candidate) => candidate.name === synthetic.name)?.faction;
        if (!nfgSource) break;
        const oneShots = assignment.candidates.filter((candidate) => candidate.name !== synthetic.name);
        nfgCandidate = { name: NEUROFLUX, aug: neuroflux, faction: nfgSource };
        const trial = orderPurchasesWithNeurofluxByLevel(oneShots, nfgCandidate, count, view.priceContext)[count]!;
        const trialTotal = totalCost(trial, view.priceContext) + assignment.cost;
        if (trialTotal > budget) break;
        bestOrder = trial;
      }
      order = bestOrder;
    }
  }
  return {
    order: order.map((candidate) => candidate.name),
    sources: Object.fromEntries(order.map((candidate) => [candidate.name, candidate.faction])),
    requiredFunded: plan.requiredFunded,
  };
}

/** Remaining obligation of the frozen order at today's queue depth and rep. */
function remainingSweepCosts(
  view: FactionsView,
  wanted: readonly string[],
  sources: Readonly<Record<string, string>>,
): NonNullable<FactionDecision["drainCosts"]> {
  const candidates: PurchaseCandidate[] = [];
  const repTargets = new Map<string, number>();
  let neurofluxLevel = view.priceContext.neurofluxLevel;
  for (const name of wanted) {
    const aug = view.catalog.get(name)!;
    const faction = sources[name]!;
    const repCost = augCost(aug, name === NEUROFLUX
      ? { ...view.priceContext, neurofluxLevel: neurofluxLevel++ }
      : view.priceContext).repCost;
    candidates.push({ name, aug, faction });
    repTargets.set(faction, Math.max(repTargets.get(faction) ?? 0, repCost));
  }
  const purchase = totalCost(candidates, view.priceContext);
  const donation = [...repTargets].reduce((sum, [faction, target]) => {
    const standing = view.factions.find((entry) => entry.name === faction)!;
    return sum + donationForRep(
      Math.max(0, target - standing.rep),
      view.person.mults.faction_rep,
      view.repContext.factionWorkRepGain,
    );
  }, 0);
  return { purchase, donation, residualDonation: 0, total: purchase + donation };
}

function nextSweepAction(
  view: FactionsView,
  wanted: readonly string[],
  sources: Readonly<Record<string, string>>,
): FactionAction | undefined {
  // The batch solver already proved this exact order and seller assignment.
  // Never scan ahead for a rep-met cheaper item: doing so charges its queue
  // multiplier to the donation-gated expensive item and invalidates the proof.
  for (const name of wanted) {
    const aug = view.catalog.get(name);
    if (!aug || (name !== NEUROFLUX && view.owned.has(name))) continue;
    if (aug.prereqs.some((prereq) => !view.owned.has(prereq))) continue;
    const { moneyCost, repCost } = augCost(aug, view.priceContext);
    const source = view.factions.find((standing) => standing.name === sources[name]);
    if (!source || !source.joined || !aug.factions.includes(source.name)) return undefined;
    if (source.rep < repCost) {
      if (source.favor < view.favorToDonate) return undefined;
      const donation = donationForRep(
        repCost - source.rep,
        view.person.mults.faction_rep,
        view.repContext.factionWorkRepGain,
      );
      if (view.moneyAvailable < donation + moneyCost) return undefined;
      return { type: "donate", faction: source.name, amount: donation, purchaseCost: moneyCost };
    }
    if (view.moneyGranted < moneyCost || view.moneyAvailable < moneyCost) return undefined;
    return { type: "purchaseAugmentation", faction: source.name, augmentation: name };
  }
  return undefined;
}

/** The faction the slot would work, and everything that work produces. */
interface WorkTarget {
  faction: string;
  standing: FactionStanding;
  workType: WorkType;
  repPerSec: number;
  produces: Record<RateChannel, number>;
  needed: number;
}

/** Which joined faction to work, and how fast. */
function pickWorkFaction(
  view: FactionsView,
  memory: FactionMemory,
  objective: FactionObjective,
  alternatives: ScoredAlternative[],
): WorkTarget | undefined {
  let best: WorkTarget | undefined;

  for (const name of objective.factions) {
    const standing = view.factions.find((entry) => entry.name === name);
    if (!standing || !standing.joined) continue;
    // Defensive: `chooseWorkType` already filters on `offers`, but a faction
    // that offers NOTHING (Shadows of Anarchy gains reputation only by
    // infiltrating) must never be selected for work at all.
    if (!standing.offers.hacking && !standing.offers.field && !standing.offers.security) continue;
    const needed = objective.intent?.faction === name
      ? objective.intent.repTarget
      : repNeeded(name, view, objective.augmentations);
    if (needed <= standing.rep) continue; // nothing left to earn here
    const rate = chooseWorkType(name, standing, view, memory);
    if (!rate) continue;
    const value = rate.repPerSec;
    alternatives.push({ label: `work ${name} (${rate.type})`, value });
    // FIRST viable member of the set, not the fastest one.
    //
    // `objective.factions` is the order the plan committed to, and the order is
    // load-bearing: player work is sequential, so the solver chose it against
    // the whole cycle's critical path and reordered it when that helped.
    // Re-ranking here by raw reputation per second silently overrides that —
    // and on a route it would work an optional faction ahead of the terminal
    // package the node cannot end without, purely because the optional one
    // grinds faster.
    if (!best) {
      best = { faction: name, standing, workType: rate.type, repPerSec: value, produces: rate.produces, needed };
    }
  }

  // Focus dwell: do not switch faction before FOCUS_DWELL_MS unless the new
  // one is clearly better, because switching cancels the current work.
  //
  // It does not get to hold an optional faction in front of the augmentation
  // the node cannot end without. The dwell exists to stop thrash between
  // near-equal bidders, and a route's terminal package is not a bidder — the
  // same reason the objective latch has its own Red Pill escape. Without this,
  // a multi-faction plan whose head IS the terminal package would still grind
  // the optional member, because near-equal reputation rates keep the incumbent
  // every pass and the dwell window never opens.
  const terminalHead = objective.intent !== undefined
    && objective.factions[0] === objective.intent.faction
    && objective.intent.augmentations.includes("The Red Pill");
  if (!terminalHead && best && memory.focusFaction && memory.focusFaction !== best.faction) {
    const incumbent = view.factions.find((entry) => entry.name === memory.focusFaction);
    const withinDwell = view.time - memory.focusSince < FOCUS_DWELL_MS;
    if (incumbent && incumbent.joined && withinDwell) {
      const incumbentRate = chooseWorkType(incumbent.name, incumbent, view, memory);
      const incumbentNeeded = objective.intent?.faction === incumbent.name
        ? objective.intent.repTarget
        : repNeeded(incumbent.name, view, objective.augmentations);
      if (incumbentRate && incumbentNeeded > incumbent.rep && best.repPerSec < incumbentRate.repPerSec * WORK_SWITCH_MARGIN) {
        return {
          faction: incumbent.name,
          standing: incumbent,
          workType: incumbentRate.type,
          repPerSec: incumbentRate.repPerSec,
          produces: incumbentRate.produces,
          needed: incumbentNeeded,
        };
      }
    }
  }
  return best;
}

/** Should the run end? Nothing further is buyable and reputation is worth more
 * banked as favor than as more of this run.
 *
 * Emitted as a RECOMMENDATION, never acted on: the reset cadence belongs to
 * `progression`, which can see the whole run. */
function shouldRecommendInstall(
  view: FactionsView,
  objective: FactionObjective,
): { augmentations: string[] } | undefined {
  // Purchases are END-LOADED (the two-loop money rule), so the endgame begins
  // when the objective's WORK is done — every augmentation owned or its
  // reputation requirement met at a joined seller. Ownership is NOT required:
  // money is the drain's business, and the final sweep buys the package
  // dearest-first once this fires.
  const outstanding = objective.augmentations.filter((name) => !view.owned.has(name));
  // When progression has REQUESTED the install, unmet reputation does not
  // veto: the sweep converts whatever is buyable and the rest waits for the
  // next cycle — that is exactly what "install now beats pushing" means.
  if (!view.installRequested) {
    for (const name of outstanding) {
      const aug = view.catalog.get(name);
      if (!aug) continue;
      const { repCost } = augCost(aug, view.priceContext);
      const seller = view.factions.some(
        (standing) => standing.joined && aug.factions.includes(standing.name) && standing.rep >= repCost,
      );
      if (!seller) return undefined;
    }
  }
  // An install needs SOMETHING to convert: already queued, or buyable now.
  const queued = [...view.queued].filter((name) => view.catalog.has(name));
  // NFG may be the frontier's next ROI-positive breakpoint, but a repeatable
  // level alone does not get to declare the cycle over. Progression compares
  // its multiplier value with the reset cost and then re-enters here with
  // installRequested; an existing queue also makes it a strict residual sink.
  if (
    !view.installRequested
    && queued.length === 0
    && outstanding.length > 0
    && outstanding.every((name) => name === NEUROFLUX)
  ) return undefined;
  if (queued.length === 0 && outstanding.length === 0) return undefined;
  return { augmentations: [...queued, ...outstanding] };
}
