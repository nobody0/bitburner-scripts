import {
  augCost,
  canAfford,
  closePrereqs,
  isSoA,
  NEUROFLUX,
  orderPurchases,
  scoreAug,
  type AugInfo,
  type PurchaseCandidate,
} from "./augs.ts";
import {
  FOCUS_DWELL_MS,
  RATE_SMOOTHING,
  SWITCH_MARGIN,
  WORK_SWITCH_MARGIN,
  type FactionAction,
  type FactionDecision,
  type FactionMemory,
  type FactionObjective,
  type InvalidationKey,
  type ScoredAlternative,
  type Until,
} from "./plan.ts";
import { selectFactions, type FactionCandidate } from "./objective.ts";
import { bestWorkType, favorNeededToDonate, passiveRepPerSec, type WorkType } from "./rep.ts";
import { combinedEtaSec, estimateBlockerSec, evaluateAll, isReachable, type Blocker } from "./requirements.ts";
import type { FactionStanding, FactionsView } from "./state.ts";

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

/** Augmentations a faction can supply that we do not own. */
function offeredBy(faction: string, view: FactionsView): AugInfo[] {
  const out: AugInfo[] = [];
  for (const aug of view.catalog.values()) {
    if (view.owned.has(aug.name)) continue;
    if (!aug.factions.includes(faction)) continue;
    out.push(aug);
  }
  return out;
}

/** Value of committing to one faction: the augmentations only it can give us,
 * scored, minus nothing — the cost side is the ETA, handled separately. */
function factionValue(faction: string, view: FactionsView): { value: number; augs: string[] } {
  let value = 0;
  const augs: string[] = [];
  for (const aug of offeredBy(faction, view)) {
    const score = scoreAug(aug, view.weights);
    if (score <= 0) continue;
    value += score;
    augs.push(aug.name);
  }
  return { value, augs };
}

function blockersFor(standing: FactionStanding, view: FactionsView): Blocker[] {
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

/** Stand-in ETA for a faction whose reputation cannot be earned by working —
 * either it offers no work type we can use, or its work types have not been
 * probed yet. A day: heavy enough that any workable faction outranks it,
 * finite enough that it still appears in the objective. */
const UNWORKABLE_REP_SEC = 86_400;

/** Build one candidate per faction. */
export function buildCandidates(view: FactionsView): {
  candidates: FactionCandidate[];
  blockers: Map<string, Blocker[]>;
  augs: Map<string, string[]>;
} {
  const candidates: FactionCandidate[] = [];
  const blockers = new Map<string, Blocker[]>();
  const augs = new Map<string, string[]>();

  for (const standing of view.factions) {
    const missing = blockersFor(standing, view);
    blockers.set(standing.name, missing);
    const { value, augs: offered } = factionValue(standing.name, view);
    augs.set(standing.name, offered);

    // Score by VALUE PER SECOND, not raw value. The objective is least
    // wall-clock to an augmentation set, so a faction worth twice as much but
    // ten times further away is a worse commitment — and ranking on raw value
    // alone makes a fresh run commit to Daedalus (30 augmentations, $100b)
    // over CyberSec (one backdoor) and then idle for hours with nothing it can
    // act on.
    const joinSec = standing.joined
      ? 0
      : combinedEtaSec(missing, (blocker) => estimateBlockerSec(blocker, view.incomePerSec));
    // Plus the time to earn the reputation the augmentations need.
    //
    // A faction we cannot WORK is not worthless — its augmentations are still
    // real, and reputation can come from donation, or the faction may be worth
    // joining for its own sake. Scoring an unworkable faction at Infinity
    // divides its value to exactly zero, which drops it from the objective
    // entirely; that emptied the whole plan the moment work types were probed
    // properly, because an un-joined faction's work types are simply not known
    // yet. Penalise heavily, never annihilate.
    const rate = bestWorkType(standing.offers, view.person, standing.favor, view.repContext, true);
    const repTarget = repNeeded(standing.name, view, offered);
    const repSec =
      repTarget <= standing.rep
        ? 0
        : rate && rate.repPerSec > 0
          ? (repTarget - standing.rep) / rate.repPerSec
          : UNWORKABLE_REP_SEC;
    const etaSec = joinSec + repSec;

    candidates.push({
      name: standing.name,
      // Per-second, floored so a zero-ETA faction does not divide by zero.
      value: value / Math.max(1, etaSec),
      enemies: standing.enemies,
      // Already joined counts as reachable regardless of requirements.
      reachable: standing.joined || standing.invited || isReachable(missing),
    });
  }
  return { candidates, blockers, augs };
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

export function stepFactions(
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

  const { candidates, blockers, augs } = buildCandidates(view);

  // --- objective ------------------------------------------------------------
  const selection = selectFactions(candidates);
  const objectiveAugs = closePrereqs(
    selection.chosen.flatMap((name) => augs.get(name) ?? []),
    view.catalog,
    view.owned,
  );
  const fresh: FactionObjective = {
    factions: selection.chosen,
    augmentations: objectiveAugs,
    value: selection.value,
    foreclosed: selection.foreclosed,
    why: selection.approximated
      ? "greedy over a ban-graph component larger than the exact search limit"
      : "exact max-weight independent set over the ban graph",
  };

  // Hysteresis: only switch objective when the new one is clearly better.
  const committed = memory.objective;
  const objective =
    committed && fresh.value <= committed.value * SWITCH_MARGIN && sameSet(committed.factions, fresh.factions)
      ? committed
      : fresh;
  if (committed && objective !== committed) {
    alternatives.push({ label: `keep ${committed.factions.join(", ")}`, value: committed.value, why: "previous objective" });
  }

  const allBlockers: (Blocker & { faction: string })[] = [];
  for (const name of objective.factions) {
    for (const entry of blockers.get(name) ?? []) allBlockers.push({ ...entry, faction: name });
  }
  const needOwners = [...new Set(allBlockers.filter((b) => b.reachable).map((b) => b.owner))];

  const next = { ...memory, objective, lastInvalidation: invalidation };

  // --- 1) purchase ----------------------------------------------------------
  const purchase = nextPurchase(view, objective.augmentations);
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

  // --- 2) join --------------------------------------------------------------
  const invitation = view.factions.find(
    (standing) => standing.invited && !standing.joined && objective.factions.includes(standing.name),
  );
  if (invitation) {
    const lost = selection.foreclosed.filter((entry) => entry.bannedBy === invitation.name);
    const action: FactionAction = {
      type: "joinFaction",
      faction: invitation.name,
      why:
        lost.length > 0
          ? `joining ${invitation.name} permanently forecloses ${lost.map((e) => e.name).join(", ")}`
          : `${invitation.name} is in the objective and has invited us`,
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
    const action: FactionAction = {
      type: "idle",
      reason: allBlockers.length > 0 ? "blocked" : "waiting",
      why,
    };
    const recommend = shouldRecommendInstall(view, objective);
    return {
      memory: { ...next, lastAction: action },
      decision: {
        objective,
        action,
        alternatives,
        blockers: allBlockers,
        needOwners,
        invalidation,
        ...(recommend ? { recommendInstall: recommend } : {}),
      },
    };
  }

  // Donation beats working once income exceeds the crossover — and only once
  // favor actually allows it. Favor cannot grow within a run, so a locked
  // route is a message to `progression`, not something to wait for.
  const donateUnlocked = target.standing.favor >= favorNeededToDonate(view.favorToDonate / 150 || 1);
  if (donateUnlocked && view.moneyGranted > 0) {
    const action: FactionAction = {
      type: "donate",
      faction: target.faction,
      amount: view.moneyGranted,
      why: `donating beats working at $${Math.round(view.incomePerSec)}/sec income`,
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
      reason: "waiting",
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

function sameSet(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  const set = new Set(a);
  return b.every((entry) => set.has(entry));
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

/** The next augmentation we can actually buy right now. */
function nextPurchase(
  view: FactionsView,
  wanted: readonly string[],
): { action: FactionAction } | undefined {
  const candidates: PurchaseCandidate[] = [];
  for (const name of wanted) {
    const aug = view.catalog.get(name);
    if (!aug || view.owned.has(name)) continue;
    // Prerequisites must already be owned or queued.
    if (aug.prereqs.some((prereq) => !view.owned.has(prereq))) continue;
    const source = view.factions.find(
      (standing) => standing.joined && aug.factions.includes(standing.name),
    );
    if (!source) continue;
    candidates.push({ name, aug, faction: source.name });
  }
  if (candidates.length === 0) return undefined;

  for (const candidate of orderPurchases(candidates, view.priceContext)) {
    const standing = view.factions.find((entry) => entry.name === candidate.faction)!;
    const { moneyCost, repCost } = augCost(candidate.aug, view.priceContext);
    const donationRate =
      standing.favor >= view.favorToDonate
        ? { factionRepMult: view.person.mults.faction_rep, factionWorkRepGain: view.repContext.factionWorkRepGain }
        : undefined;
    const verdict = canAfford({
      moneyCost,
      repCost,
      factionRep: standing.rep,
      money: view.moneyGranted,
      ...(donationRate ? { donationRate } : {}),
    });
    if (!verdict.ok) continue;
    return {
      action: {
        type: "purchaseAugmentation",
        faction: candidate.faction,
        augmentation: candidate.name,
        why: `${verdict.reason}; $${Math.round(moneyCost).toLocaleString()} at ${
          isSoA(candidate.name) ? "SoA" : candidate.name === NEUROFLUX ? "NeuroFlux" : "standard"
        } pricing`,
      },
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
    const needed = repNeeded(name, view, objective.augmentations);
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
      const incumbentNeeded = repNeeded(incumbent.name, view, objective.augmentations);
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
  const queued = [...view.owned].filter((name) => view.catalog.has(name));
  if (queued.length === 0) return undefined;
  const unbuyable = objective.augmentations.filter((name) => !view.owned.has(name));
  if (unbuyable.length > 0) return undefined;
  return {
    why: "every augmentation in the objective is owned; banked reputation converts to favor only at install",
    augmentations: queued,
  };
}

export { combinedEtaSec };
