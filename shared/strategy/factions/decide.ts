import {
  augCost,
  canAfford,
  closePrereqs,
  entropyCost,
  isSoA,
  NEUROFLUX,
  orderPurchases,
  scoreAug,
  selectAffordableBatch,
  type PurchaseCandidate,
} from "./augs.ts";
import {
  FOCUS_DWELL_MS,
  INTENT_STALL_MS,
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
import { selectFactionPackage } from "./packages.ts";
import {
  bestWorkType,
  donationCrossoverIncome,
  donationForRep,
  passiveRepPerSec,
  type WorkType,
} from "./rep.ts";
import { evaluateAll, type Blocker } from "./requirements.ts";
import { settlingMoney, type FactionStanding, type FactionsView } from "./state.ts";

/** The faction decision.
 *
 * Pure: same view + same memory => same decision, always. It reads no clock
 * (`view.time` is passed in), no ns, no telemetry.
 *
 * ACTION PRECEDENCE, and why it is this order:
 *
 *   purchaseAugmentation -> joinFaction -> travelTo -> donate -> graft
 *   -> workForFaction -> stopWork -> idle
 *
 * Purchases come first because reputation is a bank that survives to install
 * while money is fungible: converting rep into augmentations the moment it is
 * possible can never be worse, and delaying risks the run ending with unspent
 * reputation. Joins come next because an invitation can be REVOKED by joining
 * an enemy. Travel is last among the cheap actions and heavily guarded — see
 * below.
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
 * invalidated the plan, the only correct answer is "keep going". */
function shouldContinue(view: FactionsView, memory: FactionMemory, invalidation: InvalidationKey[]): boolean {
  const last = memory.lastAction;
  if (!last || last.type !== "workForFaction") return false;
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
        why: `${standing.name} is joined through its own mechanic, not an invitation`,
      },
    ];
  }
  return evaluateAll(standing.requirements, view.requirementView);
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

function repRate(faction: string, standing: FactionStanding, view: FactionsView, memory: FactionMemory): {
  type: WorkType;
  repPerSec: number;
} | undefined {
  const formula = bestWorkType(standing.offers, view.person, standing.favor, view.repContext, true);
  if (!formula) return undefined;
  const measured = memory.measuredRepPerSec[faction];
  // Only trust a measured rate while we were actually working that faction.
  if (measured !== undefined && measured > 0 && view.currentWork?.faction === faction) {
    return { type: formula.type, repPerSec: measured };
  }
  return formula;
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

export function stepFactions(
  view: FactionsView,
  memoryIn: FactionMemory,
): { decision: FactionDecision; memory: FactionMemory } {
  const out = decideFactions(view, memoryIn);
  // `nextBuy` is the money the driver has to claim. The drain fills it in itself
  // (a different candidate set); otherwise it is the head of the objective's
  // purchase order. Priced with unlimited money on purpose: `nextPurchase` tests
  // the GRANTED budget, a grant only exists once something claimed it, and a claim
  // read off the already-funded decision could never bootstrap.
  if (out.decision.nextBuy) return out;
  const intended = nextPurchase(view, purchaseOrder(view, out.decision.objective?.augmentations ?? []), Infinity);
  if (!intended) return out;
  return {
    ...out,
    decision: { ...out.decision, nextBuy: { name: intended.name, price: intended.price } },
  };
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
        action: { type: "idle", reason: "blocked", why: "singularity RAM wall" },
        alternatives,
        blockers: [],
        needOwners: [],
        invalidation,
        blocked: {
          why:
            "SF4 level 1 outside BN4: one singularity call costs 5GB x16 = 80GB and is indivisible. " +
            "Fully fundable in BN4 or at SF4 level 3.",
        },
      },
    };
  }

  const blockers = new Map(view.factions.map((standing) => [standing.name, blockersFor(standing, view)]));

  // --- objective ------------------------------------------------------------
  const selection = selectFactionPackage(view, blockers);
  const objectiveAugs = closePrereqs(selection.intent?.augmentations ?? [], view.catalog, view.owned);
  const fresh: FactionObjective = {
    factions: selection.intent ? [selection.intent.faction] : [],
    augmentations: objectiveAugs,
    value: selection.intent?.value ?? 0,
    foreclosed: selection.foreclosed,
    why: selection.intent
      ? `finite-horizon package frontier; next target is ${selection.intent.faction} at ${Math.round(selection.intent.repTarget).toLocaleString()} rep`
      : "no faction package fits the planning horizon",
    ...(selection.intent ? { intent: selection.intent } : {}),
    ...(selection.runnerUp ? { runnerUp: selection.runnerUp } : {}),
  };

  // Keep the promised breakpoint stable while it is in flight. In
  // particular, joining a city faction makes its enemy disappear from the
  // current-cycle frontier; recomputing freely at that moment would erase the
  // runner-up opportunity cost and push the joined faction all the way to its
  // deepest augmentation. Once the package is complete we may switch to a
  // compatible runner immediately, but an enemy runner means "install, then
  // join it next cycle".
  const previous = memory.objective;
  const previousIntent = previous?.intent;
  const previousRunner = previous?.runnerUp;
  const previousStanding = previousIntent
    ? view.factions.find((standing) => standing.name === previousIntent.faction)
    : undefined;
  const previousComplete = Boolean(
    previousIntent &&
    previousStanding &&
    previousStanding.rep >= previousIntent.repTarget &&
    previousIntent.augmentations.every((name) => view.owned.has(name)),
  );
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
  let keepPrevious = Boolean(previousIntent && previousStanding && (!previousComplete || runnerBlockedThisCycle));
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
  const objective = keepPrevious ? previous! : fresh;
  if (!keepPrevious) {
    intentKey = objective.intent?.faction;
    intentRepSeen = undefined;
    intentProgressAt = view.time;
  }
  if (objective.runnerUp) {
    alternatives.push({
      label: `${objective.runnerUp.faction} to ${Math.round(objective.runnerUp.repTarget).toLocaleString()} rep`,
      value: objective.runnerUp.value / Math.max(1, objective.runnerUp.etaSec),
      why: objective.runnerUp.why,
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
  const { drainCeiling: _staleCeiling, intentKey: _ik, intentRepSeen: _irs, intentProgressAt: _ipa, ...carried } = memory;
  const next = {
    ...carried,
    objective,
    lastInvalidation: invalidation,
    ...(intentKey !== undefined ? { intentKey } : {}),
    ...(intentRepSeen !== undefined ? { intentRepSeen } : {}),
    ...(intentProgressAt !== undefined ? { intentProgressAt } : {}),
  };

  if (view.currentWork?.kind === "grafting") {
    const action: FactionAction = {
      type: "idle",
      reason: "continue",
      why: `grafting ${view.currentWork.detail ?? "augmentation"} is protected until completion`,
    };
    return {
      memory: { ...next, lastAction: action },
      decision: { objective, action, alternatives, blockers: allBlockers, needOwners, invalidation },
    };
  }

  // --- 1) purchase ----------------------------------------------------------
  // Cost order, not the objective's value order: see `purchaseOrder`. Reputation
  // still gates each item, and `nextPurchase` falls through to the next when it is
  // short — so this buys the dearest item we can actually buy, never nothing.
  const purchase = nextPurchase(view, purchaseOrder(view, objective.augmentations));
  if (purchase) {
    return {
      memory: { ...next, lastAction: purchase.action },
      decision: {
        objective,
        action: purchase.action,
        alternatives,
        blockers: allBlockers,
        needOwners,
        invalidation,
      },
    };
  }

  const graft = nextGraft(view, objective.augmentations);
  if (graft) {
    const action: FactionAction = view.requirementView.city === "New Tokyo"
      ? { type: "graft", augmentation: graft.name, why: graft.why }
      : { type: "travelTo", city: "New Tokyo", why: `${graft.name} is worth grafting; VitaLife is in New Tokyo` };
    return {
      memory: { ...next, lastAction: action },
      decision: { objective, action, alternatives, blockers: allBlockers, needOwners, invalidation },
    };
  }

  // --- 2) join --------------------------------------------------------------
  const invitation = view.factions.find(
    (standing) => standing.invited && !standing.joined && objective.factions.includes(standing.name),
  );
  if (invitation) {
    const lost = objective.foreclosed.filter((entry) => entry.bannedBy === invitation.name);
    const action: FactionAction = {
      type: "joinFaction",
      faction: invitation.name,
      why:
        lost.length > 0
          ? `joining ${invitation.name} forecloses ${lost.map((e) => e.name).join(", ")} until the next install`
          : `${invitation.name} is in the objective and has invited us`,
    };
    return {
      memory: { ...next, lastAction: action },
      decision: { objective, action, alternatives, blockers: allBlockers, needOwners, invalidation },
    };
  }

  // --- 2b) free joins -------------------------------------------------------
  // An invitation that forecloses NOTHING is pure upside regardless of the
  // objective: it costs one call, unlocks the faction's augmentations and
  // reputation forever, and cannot ban anything (no enemies in either
  // direction). Measured failure without this: CyberSec's invite arrived with
  // half an hour left in the run and sat unaccepted because the objective had
  // moved on — the entire backdoor chain completed for nothing. Enemy-bearing
  // invitations still wait for the objective to want them.
  const freeInvite = view.factions.find(
    (standing) =>
      standing.invited &&
      !standing.joined &&
      standing.enemies.length === 0 &&
      !view.factions.some((member) => member.joined && member.enemies.includes(standing.name)),
  );
  if (freeInvite) {
    const action: FactionAction = {
      type: "joinFaction",
      faction: freeInvite.name,
      why: `${freeInvite.name} invited us and forecloses nothing`,
    };
    return {
      memory: { ...next, lastAction: action },
      decision: { objective, action, alternatives, blockers: allBlockers, needOwners, invalidation },
    };
  }

  // --- 3) travel ------------------------------------------------------------
  // ONLY when it is the last remaining requirement for a faction. Travelling
  // invalidates other city-bound requirements, so issuing it speculatively
  // produces a loop: travel for A, which breaks B, travel back for B, which
  // breaks A. The predecessor scripts hit exactly this and added the same
  // guard (src/_lib/factions.ts:256-262).
  const travel = soleTravelBlocker(allBlockers);
  if (travel) {
    const action: FactionAction = {
      type: "travelTo",
      city: travel.subject!,
      why: `${travel.faction} needs us in ${travel.subject}, and it is the only requirement left`,
    };
    return {
      memory: { ...next, lastAction: action },
      decision: { objective, action, alternatives, blockers: allBlockers, needOwners, invalidation },
    };
  }

  // --- 4) work / donate -----------------------------------------------------
  const target = pickWorkFaction(view, next, objective, alternatives);
  if (!target) {
    const why = allBlockers.length > 0 ? "every objective faction is blocked" : "nothing left to work toward";
    const recommend = shouldRecommendInstall(view, objective);
    // Last-chance drain. This is intentionally broader than the objective:
    // once progression is about to reset, every permanent augmentation we can
    // still buy is better than carrying the cash and reputation into oblivion.
    // Keep the same priority order, falling downward when a better item is not
    // currently affordable; NeuroFlux is repeatable and comes last.
    const wanted = recommend ? finalSweepWanted(view) : [];
    // The drain spends the pile that exists when it STARTS. Frozen once, here:
    // testing against live money instead lets a fast farm outrun the NeuroFlux
    // price ladder level after level, and the install waits on a race.
    const ceiling = recommend ? memory.drainCeiling ?? view.moneyAvailable : undefined;
    const ceilingDigest = ceiling !== undefined ? { drainCeiling: ceiling } : {};
    // What the drain would buy if money were no object. Published on the decision
    // so the driver can claim exactly that much: `nextPurchase` above tests the
    // GRANTED budget, and a grant only exists once something claimed it. Derived
    // from the plan rather than the funded action, it survives the whole drain —
    // including the ticks where a purchase is in flight — so the claim does not
    // blink out between buys. An intent beyond the frozen ceiling is not an
    // intent: the drain is over, and publishing it would keep the barrier up.
    const drainIntent = recommend ? nextPurchase(view, wanted, Infinity) : undefined;
    // Spend DOWN, never wait: an intent must clear both the frozen ceiling and
    // the cash actually on hand. Testing the ceiling alone re-admits the race
    // in miniature — a level priced just under the ceiling but just over the
    // bank waits on income, which is the exact wait the ceiling exists to end.
    const drainBudget = ceiling !== undefined ? Math.min(ceiling, view.moneyAvailable) : undefined;
    const drainBuy = drainIntent && drainBudget !== undefined && drainIntent.price <= drainBudget ? drainIntent : undefined;
    const nextBuyDigest = drainBuy ? { nextBuy: { name: drainBuy.name, price: drainBuy.price } } : {};
    // No sweep once the ceiling is exhausted; the donate leg still runs while
    // nothing at all is rep-affordable (drainIntent undefined), as before.
    const sweep = recommend && (drainBuy || !drainIntent) ? nextSweepAction(view, wanted) : undefined;
    if (sweep) {
      return {
        memory: { ...next, lastAction: sweep, ...(ceiling !== undefined ? { drainCeiling: ceiling } : {}) },
        decision: { objective, action: sweep, alternatives, blockers: allBlockers, needOwners, invalidation, ...nextBuyDigest, ...ceilingDigest },
      };
    }
    const action: FactionAction = {
      type: "idle",
      reason: allBlockers.length > 0 ? "blocked" : "waiting",
      why,
    };
    return {
      memory: { ...next, lastAction: action, ...(ceiling !== undefined ? { drainCeiling: ceiling } : {}) },
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

  // Donation beats working once income exceeds the crossover — and only once
  // favor actually allows it. Favor cannot grow within a run, so a locked
  // route is a message to `progression`, not something to wait for.
  const donateUnlocked = target.standing.favor >= view.favorToDonate;
  const repGap = Math.max(0, target.needed - target.standing.rep);
  const donationNeeded = donationForRep(repGap, view.person.mults.faction_rep, view.repContext.factionWorkRepGain);
  const crossover = donationCrossoverIncome(
    target.repPerSec,
    view.person.mults.faction_rep,
    view.repContext.factionWorkRepGain,
  );
  const intent = objective.intent?.faction === target.faction ? objective.intent : undefined;
  const packageCashNeeded = donationNeeded + (intent?.purchaseCost ?? 0);
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
      why:
        `reserve $${Math.round(packageCashNeeded).toLocaleString()} for reputation and purchase; ` +
        `income $${Math.round(view.incomePerSec)}/sec beats the $${Math.round(crossover)}/sec crossover`,
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
        until: untilRep(target.faction, target.needed, target.standing.rep, target.repPerSec),
      },
    };
  }

  // The continuation guard. Must come after the cheap actions (a purchase we
  // can afford now should not wait for work to finish) but before we would
  // re-issue the same work order.
  if (shouldContinue(view, memory, invalidation)) {
    const action: FactionAction = { type: "idle", reason: "continue", why: "faction work already running" };
    return {
      memory: { ...next, lastAction: memory.lastAction },
      decision: {
        objective,
        action,
        alternatives,
        blockers: allBlockers,
        needOwners,
        invalidation,
        until: untilRep(target.faction, target.needed, target.standing.rep, target.repPerSec),
      },
    };
  }

  if (!view.holdsWorkSlot) {
    // The player can only do ONE thing. Saying so explicitly matters: the
    // panel previously showed the intended work as if it were running, which
    // read as a contradiction against the game's own display.
    const action: FactionAction = {
      type: "idle",
      reason: "slot",
      why:
        `would work ${target.faction} (${target.workType}) but another feature holds ` +
        `Player.currentWork — only one activity can run at a time`,
    };
    return {
      memory: { ...next, lastAction: action },
      decision: { objective, action, alternatives, blockers: allBlockers, needOwners, invalidation },
    };
  }

  // Below the crossover, working a faction SUPPRESSES its passive tick and
  // earns less than it gave up. Idling is strictly better, and saying so is
  // the whole point of modelling it.
  const passive = passiveRepPerSec(view.person, target.standing.favor, view.repContext);
  if (target.repPerSec <= passive) {
    const action: FactionAction = {
      type: "idle",
      reason: "waiting",
      why:
        `working ${target.faction} would earn ${target.repPerSec.toFixed(4)} rep/sec but suppress a ` +
        `${passive.toFixed(4)} rep/sec passive tick — idling is strictly better`,
    };
    alternatives.push({
      label: `work ${target.faction}`,
      value: target.repPerSec,
      why: "below the passive-rep crossover",
    });
    return {
      memory: { ...next, lastAction: action },
      decision: { objective, action, alternatives, blockers: allBlockers, needOwners, invalidation },
    };
  }

  const action: FactionAction = {
    type: "workForFaction",
    faction: target.faction,
    workType: target.workType,
    focus: true,
    why: `${target.repPerSec.toFixed(3)} rep/sec toward ${Math.round(target.needed)} needed`,
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

/** Travel is issued ONLY when it is the sole remaining blocker. */
function soleTravelBlocker(blockers: readonly (Blocker & { faction: string })[]): (Blocker & { faction: string }) | undefined {
  const byFaction = new Map<string, (Blocker & { faction: string })[]>();
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

function nextGraft(view: FactionsView, wanted: readonly string[]): { name: string; why: string } | undefined {
  if (!view.holdsWorkSlot) return undefined;
  const entropyPenalty = view.owned.has("violet Congruity Implant") ? 0 : entropyCost(view.weights);
  for (const name of wanted) {
    if (view.owned.has(name)) continue;
    const offer = view.graftable?.find((entry) => entry.name === name);
    const aug = view.catalog.get(name);
    if (!offer || !aug || offer.timeMs / 1_000 >= view.horizonSec) continue;
    if (aug.prereqs.some((prereq) => !view.owned.has(prereq))) continue;
    const benefit = scoreAug(aug, view.weights);
    if (benefit <= entropyPenalty || view.moneyGranted < offer.price) continue;
    return {
      name,
      why: `graft value ${benefit.toFixed(3)} exceeds one-step entropy cost ${entropyPenalty.toFixed(3)} and completes within the run horizon`,
    };
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
  return settlingMoney(view) + Math.max(0, view.incomePerSec) * horizonSec;
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
 * AND THE FIRST PURCHASE OF A RUN IS NEVER HELD, which is not a nicety — without
 * it the hold cannot end. The book is liquidated when `progression` enters its
 * `ending` phase, and `phaseOf` requires a non-empty install queue to get there. So
 * holding out for the market book while nothing is queued waits for a liquidation
 * that our own waiting prevents: queue stays empty, phase never turns, stock never
 * sells, the proceeds never arrive. Buying one item bootstraps the phase machine,
 * and because the walk is dearest-first that item is the dearest we can currently
 * afford — the best available choice, not merely a legal one. */
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
          a.verdict.needDonation - b.verdict.needDonation ||
          b.standing.rep - a.standing.rep ||
          (a.standing.name < b.standing.name ? -1 : 1),
      );
    const source = sources[0];
    if (!source) {
      // Short of cash on something we still expect to afford: wait for it rather
      // than jumping the queue. Anything cheaper stays cheap; this one would not.
      // Reputation shortfalls and gaps the book cannot close fall through instead —
      // see the note above.
      if (hold && sellers.length > 0 && money < moneyCost && settling >= moneyCost) return undefined;
      continue;
    }
    return {
      name,
      price: moneyCost,
      action: {
        type: "purchaseAugmentation",
        faction: source.standing.name,
        augmentation: name,
        why: `${source.verdict.reason}; $${Math.round(moneyCost).toLocaleString()} at ${
          isSoA(name) ? "SoA" : name === NEUROFLUX ? "NeuroFlux" : "standard"
        } pricing`,
      },
    };
  }
  return undefined;
}
/** All joined-faction purchases worth attempting before an install, in the order
 * to BUY them.
 *
 * Selection is by value, execution is by price — see
 * {@link selectAffordableBatch}. Ordering is not cosmetic: buying a $1m
 * augmentation before a $500m one pays the 1.9x queue escalation on the $500m
 * instead of on the $1m, and the batch that was affordable as a plan stops being
 * affordable as a sequence. The drain re-plans every tick and always buys the head
 * of this list, so executing one purchase per tick reproduces the planned order.
 *
 * NeuroFlux comes last, as the sink for whatever the batch leaves behind. */
function finalSweepWanted(view: FactionsView): string[] {
  const joined = new Set(view.factions.filter((standing) => standing.joined).map((standing) => standing.name));
  const byValue = [...view.catalog.values()]
    .filter(
      (aug) =>
        aug.name !== NEUROFLUX &&
        !view.owned.has(aug.name) &&
        aug.factions.some((faction) => joined.has(faction)),
    )
    .sort(
      (a, b) =>
        scoreAug(b, view.weights) - scoreAug(a, view.weights) ||
        (a.name < b.name ? -1 : 1),
    )
    .map((aug) => aug.name);

  const candidates: PurchaseCandidate[] = [];
  for (const name of closePrereqs(byValue, view.catalog, view.owned)) {
    const aug = view.catalog.get(name);
    const faction = aug?.factions.find((candidate) => joined.has(candidate));
    if (aug && faction) candidates.push({ name, aug, faction });
  }
  // The whole bankroll, not the granted slice, and not cash alone: this decides
  // which SET is worth planning, and at this boundary the market book is about to
  // become cash while the cash itself is about to be deleted by the install.
  const plan = selectAffordableBatch({
    candidates,
    owned: view.owned,
    ctx: view.priceContext,
    money: plannedBudget(view),
  });

  const order = plan.order.map((candidate) => candidate.name);
  const neuroflux = view.catalog.get(NEUROFLUX);
  if (neuroflux?.factions.some((faction) => joined.has(faction))) order.push(NEUROFLUX);
  return order;
}

function nextSweepAction(view: FactionsView, wanted: readonly string[]): FactionAction | undefined {
  const purchase = nextPurchase(view, wanted);
  if (purchase) return purchase.action;

  // A high-priority item may be cash-affordable but reputation-locked. At the
  // last-chance boundary donations are not compared with work time: there is
  // no more work time. Reserve the donation and purchase together so the
  // donation can never consume the dollars needed for its augmentation.
  for (const name of wanted) {
    const aug = view.catalog.get(name);
    if (!aug || (name !== NEUROFLUX && view.owned.has(name))) continue;
    if (aug.prereqs.some((prereq) => !view.owned.has(prereq))) continue;
    const { moneyCost, repCost } = augCost(aug, view.priceContext);
    const source = view.factions
      .filter(
        (standing) =>
          standing.joined &&
          standing.favor >= view.favorToDonate &&
          aug.factions.includes(standing.name) &&
          standing.rep < repCost,
      )
      .map((standing) => ({
        standing,
        donation: donationForRep(
          repCost - standing.rep,
          view.person.mults.faction_rep,
          view.repContext.factionWorkRepGain,
        ),
      }))
      .filter(({ donation }) => view.moneyAvailable >= donation + moneyCost)
      .sort((a, b) => a.donation - b.donation || (a.standing.name < b.standing.name ? -1 : 1))[0];
    if (!source) continue;
    return {
      type: "donate",
      faction: source.standing.name,
      amount: source.donation,
      purchaseCost: moneyCost,
      why: `final install sweep: donate exactly enough to unlock ${name}, while reserving its $${Math.round(moneyCost).toLocaleString()} purchase`,
    };
  }
  return undefined;
}

/** Which joined faction to work, and how fast. */
function pickWorkFaction(
  view: FactionsView,
  memory: FactionMemory,
  objective: FactionObjective,
  alternatives: ScoredAlternative[],
): { faction: string; standing: FactionStanding; workType: WorkType; repPerSec: number; needed: number } | undefined {
  let best:
    | { faction: string; standing: FactionStanding; workType: WorkType; repPerSec: number; needed: number }
    | undefined;

  for (const name of objective.factions) {
    const standing = view.factions.find((entry) => entry.name === name);
    if (!standing || !standing.joined) continue;
    // Defensive: `bestWorkType` already filters on `offers`, but a faction
    // that offers NOTHING (Shadows of Anarchy gains reputation only by
    // infiltrating) must never be selected for work at all.
    if (!standing.offers.hacking && !standing.offers.field && !standing.offers.security) continue;
    const needed = objective.intent?.faction === name
      ? objective.intent.repTarget
      : repNeeded(name, view, objective.augmentations);
    if (needed <= standing.rep) continue; // nothing left to earn here
    const rate = repRate(name, standing, view, memory);
    if (!rate) continue;
    // Rank by how much of the remaining gap this closes per second.
    const value = rate.repPerSec;
    alternatives.push({ label: `work ${name} (${rate.type})`, value, why: `${Math.round(needed - standing.rep)} rep short` });
    if (!best || value > best.repPerSec) {
      best = { faction: name, standing, workType: rate.type, repPerSec: value, needed };
    }
  }

  // Focus dwell: do not switch faction before FOCUS_DWELL_MS unless the new
  // one is clearly better, because switching cancels the current work.
  if (best && memory.focusFaction && memory.focusFaction !== best.faction) {
    const incumbent = view.factions.find((entry) => entry.name === memory.focusFaction);
    const withinDwell = view.time - memory.focusSince < FOCUS_DWELL_MS;
    if (incumbent && incumbent.joined && withinDwell) {
      const incumbentRate = repRate(incumbent.name, incumbent, view, memory);
      const incumbentNeeded = objective.intent?.faction === incumbent.name
        ? objective.intent.repTarget
        : repNeeded(incumbent.name, view, objective.augmentations);
      if (incumbentRate && incumbentNeeded > incumbent.rep && best.repPerSec < incumbentRate.repPerSec * WORK_SWITCH_MARGIN) {
        return {
          faction: incumbent.name,
          standing: incumbent,
          workType: incumbentRate.type,
          repPerSec: incumbentRate.repPerSec,
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
): { why: string; augmentations: string[] } | undefined {
  const queued = [...view.queued].filter((name) => view.catalog.has(name));
  if (queued.length === 0) return undefined;
  const unbuyable = objective.augmentations.filter((name) => !view.owned.has(name));
  if (unbuyable.length > 0) return undefined;
  return {
    why: "every augmentation in the objective is owned; banked reputation converts to favor only at install",
    augmentations: queued,
  };
}
