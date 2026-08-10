import type { NS, PlayerRequirement } from "@ns";
import { effectiveBitNodeMultipliers } from "../../../shared/features/bitnode.ts";
import { AUGMENTATIONS } from "../../../shared/features/augmentations.ts";
import { formatMoney, formatNumber } from "../../../shared/format.ts";
import { sfLevel } from "../../../shared/features/unlock.ts";
import { grantFor, PRIORITY, type Claim } from "../../../shared/strategy/arbiter.ts";
import {
  NEUROFLUX,
  augCost,
  isSoA,
  weightsForRoute,
  type AugInfo,
  type PriceContext,
} from "../../../shared/strategy/factions/augs.ts";
import { blockersFor, stepFactions } from "../../../shared/strategy/factions/decide.ts";
import { initFactionMemory, type FactionAction, type FactionDecision, type FactionMemory } from "../../../shared/strategy/factions/plan.ts";
import { donationForRep, repFromDonation } from "../../../shared/strategy/factions/rep.ts";
import type { FactionStanding, FactionsView } from "../../../shared/strategy/factions/state.ts";
import { isReachable, type RequirementView } from "../../../shared/strategy/factions/requirements.ts";
import type { Need } from "../../../shared/strategy/needs.ts";
import { slotPriority } from "../../../shared/strategy/income.ts";
import { COMMISSION } from "../../../shared/strategy/stock/market.ts";
import { daedalusAugsRequired } from "../../../shared/strategy/progression/endgame.ts";
import { usableForecastSec } from "../../../shared/strategy/progression/forecast.ts";
import type { FactionGate, FactionPlan } from "../../../shared/telemetry/topics/factions.ts";
import { isScriptDeath } from "../errors.ts";
import { merge, type GameState } from "../state.ts";
import { signalInstallCheck } from "../install-signal.ts";
import { armWorkCompletion, disarmWorkCompletion, peekWorkCompletion, workDetail, type WorkTaskLike } from "../work-completion.ts";
import { actionRamClaim, featureDodge } from "./dodge.ts";
import type { ClaimContext, DriverContext, FeatureDriver, FeatureModule, NeedContext } from "./index.ts";

/** The factions driver: build a view, decide, execute ONE action, report.
 *
 * Thin by design. Every decision lives in shared/strategy/factions/, which is
 * pure and unit-tested; this file only moves data and turns one `FactionAction`
 * into one dodged singularity call.
 *
 * Two rules that are specific to this feature and easy to get wrong:
 *
 *  - **One action per tick, in one dodge.** The only multi-call case is a
 *    purchase run, which loops the affordable prefix inside a single stub —
 *    because each purchase changes the price of the next, so they have to see
 *    each other's effects.
 *  - **A `false` return is an OUTCOME, not an error.** Every singularity call
 *    returns false when the game refuses (not enough money, not invited, wrong
 *    city). That is a modelled result the plan digest reports, not something
 *    to throw on and certainly not something to retry blindly. */

/** Largest single dodge step this feature needs, declared next to the driver
 * so it cannot drift from the probes. Two singularity methods in one step at
 * SF4 level 3 is ~10 GB; the augmentation probe's `rep` step is the widest. */
const PEAK_STEP_GB = 12;
const SHADOWS_OF_ANARCHY = "Shadows of Anarchy";

let memory: FactionMemory = initFactionMemory();
/** Last executed action's outcome, for the plan digest. */
let lastResult: FactionPlan["lastResult"];
/** Set by a successful purchase: the next action is probably enabled RIGHT NOW
 * (the next NeuroFlux level, a freed prerequisite), so the driver asks for an
 * early wake instead of sleeping out the 30-second cadence. One-shot: cleared
 * when the wake is served. */
let chainWake = false;
/** The work-completion notice this driver last reacted to. The notice is a
 * SHARED single slot (work-completion.ts) that career may take several passes
 * to consume — without the latch, factions re-runs its full planner every
 * 200ms pass of that window, for every crime completion, forever (measured:
 * the factions-join profile spent most of its CPU in stepFactions at 5 Hz). */
let seenCompletion: unknown;

export function resetFactionsState(): void {
  memory = initFactionMemory();
  lastResult = undefined;
  chainWake = false;
  seenCompletion = undefined;
}

/** The grant won by ONE of this feature's money claims — never the sum.
 * Same contract as hacking's moneyGrantFor and stock's StockGrants: four
 * claims at one priority summed together would let a travel grant top up a
 * purchase the arbiter never funded. */
function moneyGrantFor(ctx: Pick<DriverContext, "grants">, claimId: string): number {
  const grant = grantFor(ctx.grants.result, "factions", claimId);
  return grant && grant.resource === "money" ? grant.amount : 0;
}

/** Exposed for tests and the sim harness. */
export function factionsMemory(): FactionMemory {
  return memory;
}

// --- view assembly ----------------------------------------------------------

function requirementView(state: GameState): RequirementView {
  const player = state.topics.player;
  const servers = state.topics.servers ?? {};
  const factions = state.topics.factions;
  const career = state.topics.career;
  const hacknet = state.topics.hacknet;
  const bladeburner = state.topics.bladeburner;
  const progression = state.topics.progression;

  const backdoored = new Set<string>();
  for (const server of Object.values(servers)) {
    if (server.backdoorInstalled) backdoored.add(server.hostname);
  }
  const files = new Set(factions?.files ?? []);

  const owned = new Set(factions?.ownedAugs ?? []);
  return {
    money: player?.money ?? 0,
    skills: { ...(player?.skills ?? {}) } as Record<string, number>,
    karma: player?.karma ?? 0,
    numPeopleKilled: player?.numPeopleKilled ?? 0,
    augCount: owned.size,
    jobs: { ...(player?.jobs ?? {}) } as Record<string, string>,
    companyRep: Object.fromEntries(
      Object.entries(career?.companies ?? {}).map(([name, standing]) => [name, standing.rep]),
    ),
    jobTitles: Object.values((player?.jobs ?? {}) as Record<string, string>),
    city: String(player?.city ?? "Sector-12"),
    location: String(player?.location ?? "home"),
    backdoored,
    files,
    hacknetRam: hacknet?.nodes?.reduce((sum, node) => sum + node.ram, 0) ?? 0,
    hacknetCores: hacknet?.nodes?.reduce((sum, node) => sum + node.cores, 0) ?? 0,
    hacknetLevels: hacknet?.nodes?.reduce((sum, node) => sum + node.level, 0) ?? 0,
    bitNode: progression?.bitNode ?? 1,
    sourceFiles: progression?.sourceFiles ?? {},
    bladeburnerRank: bladeburner?.rank ?? 0,
    // The game does not expose a completion counter. Its own Shadows of
    // Anarchy requirement treats the resulting invitation/membership as the
    // authoritative proof that one infiltration was completed.
    numInfiltrations: factions?.joined.includes(SHADOWS_OF_ANARCHY)
      || factions?.invites?.includes(SHADOWS_OF_ANARCHY) ? 1 : 0,
  };
}

function incomeRate(value: number | [number, number] | undefined): number {
  if (value === undefined) return 0;
  return Array.isArray(value) ? (value[0] ?? 0) : value;
}

/** Cash the market book will hand back, net of getting out of it.
 *
 * The book is liquidated before every install — `progression` will not reset while
 * it is open — so from the purchase plan's point of view this money is spoken for
 * and merely late. Counting it changes both the SET we plan for and, more
 * importantly, the ORDER: buying the one augmentation today's cash covers charges
 * the 1.9x queue escalation to the dearer one the liquidation would have paid for
 * outright, and no later correction can undo it.
 *
 * `position.value` is already marked at bid/ask, so the spread is priced in; what
 * remains is one $100k commission per position on the way out. Netted, never
 * negative — a book worth less than its exit costs is not a source of funds. */
export function liquidatableValue(ctx: Pick<DriverContext, "state" | "caps">): number {
  const stock = ctx.state.topics.stock;
  if (!stock || ctx.caps.unlocked.stock === "no") return 0;
  const positions = (stock.positions ?? []).filter(
    (position) => position.shares > 0 || position.sharesShort > 0,
  );
  if (positions.length === 0) return 0;
  const gross = positions.reduce((sum, position) => sum + position.value, 0);
  return Math.max(0, gross - positions.length * COMMISSION);
}

/** Assemble everything the pure strategy decides from. */
export function buildFactionsView(ctx: DriverContext, now: number): FactionsView | undefined {
  const { state, caps } = ctx;
  const player = state.topics.player;
  const topic = state.topics.factions;
  if (!player || !topic) return undefined;

  const ownedList = topic.ownedAugs ?? [];
  const owned = new Set(ownedList);
  const catalog = new Map<string, AugInfo>();
  for (const [name, aug] of Object.entries(AUGMENTATIONS)) {
    if (aug.factions.length === 0) continue;
    catalog.set(name, {
      name,
      baseCost: aug.cost,
      baseRepRequirement: aug.rep,
      factions: [...aug.factions],
      prereqs: [...(aug.prereqs ?? [])],
      mults: { ...(aug.mults ?? {}) },
      ...(aug.multsUnknown ? { multsUnknown: true } : {}),
    });
  }
  // Offers are (faction, augmentation) pairs; the per-augmentation facts live
  // once in `augMeta` and are joined back on by name here.
  const meta = topic.augMeta ?? {};
  for (const offer of topic.offers ?? []) {
    const existing = catalog.get(offer.name);
    if (existing) {
      // Several factions can offer the same augmentation; merge the sources.
      if (!existing.factions.includes(offer.faction)) existing.factions.push(offer.faction);
      // The unstable augmentation is randomised for this save. Every other
      // augmentation keeps the pinned static multiplier table.
      const dynamicMults = meta[offer.name]?.mults;
      if (dynamicMults && existing.multsUnknown) existing.mults = { ...dynamicMults };
      continue;
    }
    catalog.set(offer.name, {
      name: offer.name,
      baseCost: offer.basePrice ?? offer.price,
      baseRepRequirement: offer.repReq,
      factions: [offer.faction],
      prereqs: meta[offer.name]?.prereqs ?? [],
      mults: meta[offer.name]?.mults ?? {},
    });
  }

  const joined = new Set(topic.joined);
  const invited = new Set(topic.invites ?? []);
  const standingByName = new Map((topic.standings ?? []).map((standing) => [standing.name, standing]));
  const names = new Set<string>([...joined, ...invited, ...Object.keys(topic.requirements ?? {})]);

  const factions: FactionStanding[] = [...names].sort().map((name) => {
    const standing = standingByName.get(name);
    return {
      name,
      joined: joined.has(name),
      invited: invited.has(name),
      rep: standing?.rep ?? 0,
      favor: standing?.favor ?? 0,
      requirements: (topic.requirements?.[name] ?? []) as PlayerRequirement[],
      enemies: topic.enemies?.[name] ?? [],
      // Work types come from `ns.singularity.getFactionWorkTypes`. When the
      // probe has not reported yet, offer NOTHING rather than assuming all
      // three: a wrong guess makes the driver call
      // `workForFaction(Tetrads, "hacking")` — which Tetrads does not offer —
      // and the call fails silently every tick while reputation never accrues.
      // Not working for one minute until the probe lands is cheap; working
      // the wrong type forever is not.
      offers: {
        hacking: topic.workTypes?.[name]?.includes("hacking") ?? false,
        field: topic.workTypes?.[name]?.includes("field") ?? false,
        security: topic.workTypes?.[name]?.includes("security") ?? false,
      },
      special: false,
    };
  });

  const mults = (player.mults ?? {}) as unknown as Record<string, number>;
  // The SF5 getter is optional, but BitNode multipliers are not: donation
  // conversion and augmentation prices are wrong in BN4 (and several other
  // nodes) if absence of the getter is treated as BN1. The static table is
  // identical to the getter; live readings override it when available.
  const nodeMults = effectiveBitNodeMultipliers(
    ctx.caps.bitNode,
    sfLevel(ctx.caps.sourceFiles, 12),
    state.topics.progression?.multipliers,
  ) ?? {};
  const career = state.topics.career;

  const installed = state.topics.progression?.ownedAugs ?? {};
  const occurrences = new Map<string, number>();
  for (const name of ownedList) occurrences.set(name, (occurrences.get(name) ?? 0) + 1);
  const queuedAugs = new Set<string>();
  let queuedNonSoA = 0;
  for (const [name, count] of occurrences) {
    const installedEntry = (installed[name] ?? 0) > 0 ? 1 : 0;
    const queuedCount = Math.max(0, count - installedEntry);
    if (queuedCount > 0) {
      queuedAugs.add(name);
      // Player.queueAugmentation appends one queue entry per NeuroFlux level,
      // so repeated purchases each increase the generic price exponent.
      if (!isSoA(name)) queuedNonSoA += queuedCount;
    }
  }
  const installedNeuroflux = installed[NEUROFLUX] ?? 0;
  const neurofluxOccurrences = occurrences.get(NEUROFLUX) ?? 0;
  const queuedNeuroflux = Math.max(0, neurofluxOccurrences - (installedNeuroflux > 0 ? 1 : 0));
  const priceContext: PriceContext = {
    queuedNonSoA,
    ownedSoA: [...owned].filter(isSoA).length,
    neurofluxLevel: installedNeuroflux + queuedNeuroflux,
    sf11Level: sfLevel(caps.sourceFiles, 11),
    augMoneyCost: nodeMults["AugmentationMoneyCost"] ?? 1,
    augRepCost: nodeMults["AugmentationRepCost"] ?? 1,
  };

  return {
    time: now,
    person: {
      skills: { ...(player.skills ?? {}) } as never,
      mults: { faction_rep: mults["faction_rep"] ?? 1 },
    } as FactionsView["person"],
    requirementView: requirementView(state),
    repContext: {
      factionWorkRepGain: nodeMults["FactionWorkRepGain"] ?? 1,
      shareBonus: state.topics.fleet?.sharePower ?? 1,
      sf15Level: sfLevel(caps.sourceFiles, 15),
      hasFocusAug: owned.has("Neuroreceptor Management Implant"),
    },
    priceContext,
    factions,
    catalog,
    owned,
    queued: queuedAugs,
    graftable: topic.graftable ?? [],
    entropy: player.entropy ?? 0,
    weights: weightsForRoute(ctx.route),
    ...(ctx.route ? { route: ctx.route } : {}),
    // Factions creates the package that will eventually trigger the install,
    // so it plans against the node horizon rather than circularly depending
    // on the not-yet-known install horizon. Unknown means no arbitrary cutoff.
    horizonSec: usableForecastSec(ctx.horizons.node) ?? Infinity,
    targetAugCount: daedalusAugsRequired(ctx.caps.bitNode, sfLevel(ctx.caps.sourceFiles, 12)) ?? Infinity,
    favorToDonate: topic.favorToDonate ?? 150,
    // Progression owns the install cadence: when its published plan wants the
    // reset, this feature concludes (stops working, runs the final sweep).
    ...(ctx.state.topics.progression?.plan?.installWanted === true ? { installRequested: true } : {}),
    // PER-CLAIM, not the feature sum: `ctx.grants.money` adds aug-fund +
    // donation + graft + travel together, so a partial aug-fund grant plus a
    // $200k travel grant could fund a purchase the arbiter never allocated
    // (the failure hacking's moneyGrantFor and stock's StockGrants exist to
    // prevent). Purchases spend the aug fund; grafting spends its own.
    moneyGranted: moneyGrantFor(ctx, "aug-fund"),
    graftGranted: moneyGrantFor(ctx, "graft-fund"),
    moneyAvailable: player.money,
    pendingProceeds: liquidatableValue(ctx),
    proceedsSettling: state.topics.stock?.plan?.liquidate === true,
    holdsWorkSlot: ctx.grants.slot,
    ...(career?.currentWork
      ? {
          currentWork: {
            kind: career.currentWork.type === "FACTION" ? "faction" : String(career.currentWork.type).toLowerCase(),
            faction: career.currentWork.detail,
            detail: career.currentWork.detail,
            ...(career.currentWork.workType
              ? { workType: career.currentWork.workType as "hacking" | "field" | "security" }
              : {}),
            focused: true,
          },
        }
      : {}),
    // ns.getTotalScriptIncome returns a [sinceInstall, sinceStart] tuple; the
    // first element is the rate this run, which is the one the donate-vs-work
    // crossover is about.
    incomePerSec: incomeRate(state.topics.fleet?.scriptIncome),
    sf4Level: sfLevel(caps.sourceFiles, 4),
    bitNode: caps.bitNode ?? 1,
  };
}

// --- execution --------------------------------------------------------------

/** Turn one decided action into one dodged singularity call.
 *
 * Every branch reports what the game actually returned. `false` from a
 * singularity call is the game REFUSING — not enough money, not invited, wrong
 * city — and is a modelled outcome the plan reports rather than an exception. */
async function execute(_ns: NS, ctx: DriverContext, action: FactionAction, view: FactionsView): Promise<void> {
  const at = Date.now();
  const record = (ok: boolean, detail: string): void => {
    lastResult = { action: action.type, ok, detail, at };
  };

  const refused = Symbol("feature dodge refused");
  const run = async <T>(methods: readonly string[], body: (stubNs: NS) => T | Promise<T>): Promise<T | typeof refused> => {
    const outcome = await featureDodge(ctx, "factions", factionClaimId(action.type), methods, body);
    if (!outcome.ok) {
      record(false, outcome.reason);
      return refused;
    }
    return outcome.value;
  };

  switch (action.type) {
    case "idle":
      return;

    case "joinFaction": {
      const ok = await run(["singularity.joinFaction"], (stubNs) =>
        stubNs["singularity"]["joinFaction"](action.faction as never),
      );
      if (ok === refused) return;
      record(Boolean(ok), ok ? `joined ${action.faction}` : "game refused the join (invitation withdrawn?)");
      return;
    }

    case "workForFaction": {
      const ok = await run(["singularity.workForFaction"], (stubNs) =>
        stubNs["singularity"]["workForFaction"](action.faction as never, action.workType as never, action.focus),
      );
      if (ok === refused) return;
      record(
        Boolean(ok),
        ok ? `working ${action.faction} (${action.workType})` : `${action.faction} does not offer ${action.workType}`,
      );
      return;
    }

    case "stopWork": {
      const ok = await run(["singularity.stopAction"], (stubNs) => stubNs["singularity"]["stopAction"]());
      if (ok === refused) return;
      record(true, "stopped");
      return;
    }

    case "travelTo": {
      if (moneyGrantFor(ctx, "travel-fund") < 200_000) {
        record(false, "waiting for $200,000 travel grant");
        return;
      }
      const ok = await run(["singularity.travelToCity"], (stubNs) =>
        stubNs["singularity"]["travelToCity"](action.city as never),
      );
      if (ok === refused) return;
      record(Boolean(ok), ok ? `travelled to ${action.city}` : `could not afford travel to ${action.city}`);
      return;
    }

    case "donate": {
      // The decision can precede the arbiter grant that it causes. Keep the
      // intent published so the next claims pass reserves the exact amount,
      // but do not bypass that grant in the meantime.
      const reserve = action.amount + (action.purchaseCost ?? 0);
      if (moneyGrantFor(ctx, "donation-fund") < reserve) {
        record(false, `waiting for ${formatMoney(reserve)} donation and purchase grant`);
        return;
      }
      const plannedRep = view.factions.find((standing) => standing.name === action.faction)?.rep ?? 0;
      const repTarget = plannedRep
        + repFromDonation(action.amount, view.person.mults.faction_rep, view.repContext.factionWorkRepGain);
      const result = await run(
        ["singularity.getFactionRep", "singularity.donateToFaction"],
        (stubNs) => {
          // A donation can wait behind its money grant while faction work or
          // passive gain keeps raising reputation. Read BEFORE mutating, then
          // preserve the planner's target with the smallest current donation.
          const currentRep = stubNs["singularity"]["getFactionRep"](action.faction as never);
          const amount = donationForRep(
            Math.max(0, repTarget - currentRep),
            view.person.mults.faction_rep,
            view.repContext.factionWorkRepGain,
          );
          if (amount <= 0) return { ok: true, amount: 0, rep: currentRep };
          const ok = stubNs["singularity"]["donateToFaction"](action.faction as never, amount);
          return {
            ok,
            amount,
            rep: ok
              ? currentRep + repFromDonation(amount, view.person.mults.faction_rep, view.repContext.factionWorkRepGain)
              : currentRep,
          };
        },
      );
      if (result === refused) return;
      setFactionRep(ctx.state, action.faction, result.rep);
      record(
        result.ok,
        result.ok
          ? result.amount > 0
            ? `donated ${formatMoney(result.amount)}`
            : `already reached ${formatNumber(repTarget)} reputation`
          : "donation refused (favor too low?)",
      );
      return;
    }

    case "purchaseAugmentation": {
      // The purchase spends the AUG FUND's own grant, never the feature sum —
      // a partial fund grant topped up by a travel/donation grant would spend
      // money the arbiter allocated elsewhere. Priced from the probed offer,
      // falling back to the plan's own escalated estimate.
      const offer = (ctx.state.topics.factions?.offers ?? []).find((entry) => entry.name === action.augmentation);
      const catalogAug = view.catalog.get(action.augmentation);
      const estimated = catalogAug ? augCost(catalogAug, view.priceContext).moneyCost : 0;
      // Max of the probed offer and the locally escalated estimate: an offer
      // from a never-probed faction used to fall back to 0, silently waiving
      // the funding gate entirely.
      const fundNeeded = Math.max(offer?.price ?? 0, estimated);
      if (fundNeeded > 0 && moneyGrantFor(ctx, "aug-fund") < fundNeeded) {
        record(false, `waiting for the ${formatMoney(fundNeeded)} augmentation fund grant`);
        return;
      }
      const ok = await run(["singularity.purchaseAugmentation"], (stubNs) =>
        stubNs["singularity"]["purchaseAugmentation"](action.faction as never, action.augmentation as never),
      );
      if (ok === refused) return;
      // `true` means the game has already queued the augmentation. Record that
      // authoritative transition locally; the later catalogue probe merely
      // reconciles external/manual changes. Appending also models another NFG
      // level correctly.
      if (ok) {
        merge(ctx.state, "factions", {
          ownedAugs: [...(ctx.state.topics.factions?.ownedAugs ?? []), action.augmentation],
        });
        // A successful purchase usually enables the next one immediately
        // (NeuroFlux re-offers at the escalated price; a prereq unlocks its
        // dependents). Waiting out the 30-second cadence between each level
        // dominates time-to-install, so ask for an early wake instead.
        chainWake = true;
      }
      record(Boolean(ok), ok ? `bought ${action.augmentation}` : "purchase refused (rep or money short)");
      return;
    }

    case "graft": {
      if (!ctx.grants.slot) {
        record(false, "waiting for Player.currentWork");
        return;
      }
      const result = await run(["grafting.graftAugmentation", "singularity.getCurrentWork"], (stubNs) => {
        disarmWorkCompletion();
        const ok = stubNs["grafting"]["graftAugmentation"](action.augmentation as never, true);
        const task = stubNs["singularity"]["getCurrentWork"]() as (Record<string, unknown> & WorkTaskLike) | null;
        if (task) armWorkCompletion(task);
        return {
          ok,
          currentWork: task
            ? {
                type: String(task.type),
                detail: workDetail(task) ?? "",
                cyclesWorked: typeof task.cyclesWorked === "number" ? task.cyclesWorked : 0,
                observedAt: Date.now(),
              }
            : null,
        };
      });
      if (result === refused) return;
      merge(ctx.state, "career", { currentWork: result.currentWork });
      record(Boolean(result.ok), result.ok ? `grafting ${action.augmentation}` : "grafting refused");
      return;
    }

    case "installAugmentations":
      // Deliberately unreachable: `decide` never selects it, because the reset
      // cadence belongs to `progression`. Kept in the union so the sim can
      // execute it when progression asks.
      record(false, "install is progression's decision, not factions'");
      return;
  }
}

/** Apply a known reputation gain without disturbing favor or other factions. */
function setFactionRep(state: GameState, faction: string, rep: number): void {
  const standings = state.topics.factions?.standings ?? [];
  let found = false;
  const next = standings.map((standing) => {
    if (standing.name !== faction) return standing;
    found = true;
    return { ...standing, rep };
  });
  if (!found) next.push({ name: faction, rep, favor: 0 });
  merge(state, "factions", { standings: next });
}

// --- digest -----------------------------------------------------------------

function planDigest(decision: FactionDecision, view: FactionsView): FactionPlan {
  return {
    context: {
      evaluatedAt: view.time,
      horizonSec: view.horizonSec,
      ...(view.route ? { route: view.route } : {}),
      ...(Number.isFinite(view.targetAugCount) ? { targetAugCount: view.targetAugCount } : {}),
      ownedAugCount: view.owned.size,
      queuedAugCount: view.queued.size,
      incomePerSec: view.incomePerSec,
      moneyAvailable: view.moneyAvailable,
      moneyGranted: view.moneyGranted,
      holdsWorkSlot: view.holdsWorkSlot,
      favorToDonate: view.favorToDonate,
      priceQueue: {
        nonSoA: view.priceContext.queuedNonSoA,
        ownedSoA: view.priceContext.ownedSoA,
        neurofluxLevel: view.priceContext.neurofluxLevel,
      },
    },
    ...(decision.objective ? { objective: decision.objective } : {}),
    action: {
      type: decision.action.type,
      ...(decision.action.type === "idle" ? { reason: decision.action.reason } : {}),
      why: decision.action.why,
      ...("faction" in decision.action ? { faction: decision.action.faction } : {}),
      ...("augmentation" in decision.action ? { augmentation: decision.action.augmentation } : {}),
      ...("city" in decision.action ? { city: decision.action.city } : {}),
      ...("workType" in decision.action ? { workType: decision.action.workType } : {}),
      ...("amount" in decision.action ? { amount: decision.action.amount } : {}),
      ...("purchaseCost" in decision.action && decision.action.purchaseCost !== undefined
        ? { purchaseCost: decision.action.purchaseCost }
        : {}),
    },
    alternatives: decision.alternatives,
    invalidation: decision.invalidation,
    ...(decision.drainCeiling !== undefined ? { drainCeiling: decision.drainCeiling } : {}),
    blockers: decision.blockers.map((blocker) => ({
      faction: blocker.faction,
      kind: blocker.kind,
      ...(blocker.subject !== undefined ? { subject: blocker.subject } : {}),
      target: blocker.target,
      have: blocker.have,
      progress: blocker.progress,
      owner: blocker.owner,
      reachable: blocker.reachable,
      ...(blocker.negated ? { negated: true } : {}),
      why: blocker.why,
    })),
    ...(decision.until ? { until: decision.until } : {}),
    ...(lastResult ? { lastResult } : {}),
    ...(decision.blocked ? { blocked: decision.blocked.why } : {}),
    ...(decision.recommendInstall ? { recommendInstall: decision.recommendInstall } : {}),
    ...(decision.liquidationNeeded ? { liquidationNeeded: decision.liquidationNeeded } : {}),
    ...(decision.nextBuy ? { nextBuy: decision.nextBuy } : {}),
  };
}

/** Escalated prices for the offers panel, so the 1.9^queued multiplier is
 * visible as an escalation rather than looking like the price changed. */
function annotateOffers(state: GameState, view: FactionsView): void {
  const topic = state.topics.factions;
  if (!topic?.offers) return;
  const offers = topic.offers.map((offer) => {
    const aug = view.catalog.get(offer.name);
    if (!aug) return offer;
    const { moneyCost, repCost } = augCost(aug, view.priceContext);
    return { ...offer, basePrice: aug.baseCost, price: moneyCost, repReq: repCost };
  });
  merge(state, "factions", { offers });
}

/** The invitation gate for every faction, not just the objective's.
 *
 * `plan.blockers` is deliberately narrow — it is what the CURRENT objective is
 * waiting on, and it feeds the needs board. This is the whole board: what each
 * of the 34 factions still wants, so the panel can show which ones are one
 * backdoor away and which need a different BitNode. */
function gatesFrom(view: FactionsView): Record<string, FactionGate> {
  const gates: Record<string, FactionGate> = {};
  for (const standing of view.factions) {
    const missing = blockersFor(standing, view);
    gates[standing.name] = {
      joined: standing.joined,
      invited: standing.invited,
      // The bottleneck, not the average: a faction missing a BitNode is 0%
      // there however close its other requirements are.
      progress: missing.length === 0 ? 1 : Math.min(...missing.map((blocker) => blocker.progress)),
      reachable: standing.joined || standing.invited || isReachable(missing),
      missing: missing.map((blocker) => ({
        kind: blocker.kind,
        ...(blocker.subject !== undefined ? { subject: blocker.subject } : {}),
        target: blocker.target,
        have: blocker.have,
        progress: blocker.progress,
        owner: blocker.owner,
        reachable: blocker.reachable,
        ...(blocker.negated ? { negated: true } : {}),
        why: blocker.why,
      })),
    };
  }
  return gates;
}

// --- module -----------------------------------------------------------------

const driver: FeatureDriver = {
  id: "factions",
  everyMs: 30_000,
  // A released progress lock can hand this feature Player.currentWork now;
  // do not wait for the ordinary 30-second planning cadence to use it. Same
  // for a purchase chain: the follow-up buy is enabled the moment the last
  // one succeeded. A notice already reacted to does NOT keep waking us —
  // career can take a while to consume it, and one reaction is enough.
  wake: () => {
    if (chainWake) return true;
    const notice = peekWorkCompletion();
    return notice !== undefined && notice !== seenCompletion;
  },
  requires: "factions",
  async tick(ctx: DriverContext) {
    chainWake = false;
    const now = Date.now();
    const view = buildFactionsView(ctx, now);
    // The completion notice latches only once planning can actually react to
    // it: latching before the view guard marked a notice as reacted-to while
    // topics were momentarily unreadable (early boot, right after a reset),
    // and the freed work slot then idled until the ordinary cadence.
    if (!view) return;
    seenCompletion = peekWorkCompletion();

    const { decision, memory: next } = stepFactions(view, memory);
    memory = next;

    // While the final-sweep drain is pending — an install is recommended and
    // the next buy is affordable with cash on hand — keep waking at tick
    // cadence. Each pass publishes the freshly escalated price, the next
    // pass's claim funds it, and the whole drain completes in seconds instead
    // of one 30-second cadence per NeuroFlux level.
    if (decision.recommendInstall && decision.nextBuy && view.moneyAvailable >= decision.nextBuy.price) {
      chainWake = true;
    }
    // Drain concluded, or its first purchase needs the stock book converted.
    // Wake progression NOW — its 60-second cadence otherwise delays either
    // the liquidation handshake or the finished drain for most of a minute.
    if ((decision.recommendInstall && !decision.nextBuy) || decision.liquidationNeeded) signalInstallCheck();

    annotateOffers(ctx.state, view);
    merge(ctx.state, "factions", { plan: planDigest(decision, view), gates: gatesFrom(view) });

    try {
      await execute(ctx.ns, ctx, decision.action, view);
      // Publish the outcome in the same controller pass. Waiting until the
      // next 30-second faction decision made result telemetry lag one action
      // behind and could lose the final successful purchase when a goal/reset
      // ended the run immediately afterward.
      merge(ctx.state, "factions", { plan: planDigest(decision, view) });
    } catch (error) {
      // ScriptDeath is a kill, not a feature bug — rethrow so the controller
      // can shut down cleanly rather than looping on a corpse.
      if (isScriptDeath(error)) throw error;
      lastResult = { action: decision.action.type, ok: false, detail: String(error), at: now };
      merge(ctx.state, "factions", { plan: planDigest(decision, view) });
    }
  },
};

/** What this feature wants FROM OTHERS, derived from the objective's blockers.
 *
 * The translation is the whole cross-feature contract: a blocker says "CyberSec
 * needs a backdoor on CSEC, and hacking owns that", and this turns it into a
 * `Need` the board publishes. factions never says HOW — it does not know
 * whether career should Mug or commit Homicide for karma. */
function needs(ctx: NeedContext): Need[] {
  const plan = ctx.state.topics.factions?.plan;
  if (!plan) return [];

  // How many blockers stand between us and each faction. A blocker that is the
  // LAST one is genuinely blocking — clearing it unlocks a join right now. One
  // of five is merely wanted.
  //
  // The distinction is load-bearing, not cosmetic: `career` claims the work
  // slot at `career:blocking-need` (75) whenever ANY blocking need exists,
  // which outranks `factions:work` (60). Marking every far-off requirement as
  // blocking therefore made factions starve ITSELF — career held the slot
  // permanently chasing Daedalus's hacking 2500, and factions could never work
  // for the reputation it was asking for.
  const remaining = new Map<string, number>();
  for (const blocker of plan.blockers) {
    if (!blocker.reachable) continue;
    remaining.set(blocker.faction, (remaining.get(blocker.faction) ?? 0) + 1);
  }

  const out: Need[] = [];
  for (const blocker of plan.blockers) {
    if (!blocker.reachable) continue;
    if (blocker.owner === "factions") continue; // ours to solve
    // Non-deliverable kinds have no owner to ask.
    if (blocker.kind === "bitNode" || blocker.kind === "sourceFile" || blocker.kind === "location") continue;
    out.push({
      by: "factions",
      kind: blocker.kind as Need["kind"],
      ...(blocker.subject !== undefined ? { subject: blocker.subject } : {}),
      target: blocker.target,
      have: blocker.have,
      // Weight rises as the blocker nears completion: finishing a nearly-done
      // requirement unblocks a whole faction, while a barely-started one is
      // speculative.
      weight: 1 + blocker.progress * 4,
      urgency: (remaining.get(blocker.faction) ?? 0) <= 1 ? "blocking" : "wanted",
      why: `${blocker.faction} ${blocker.why}`,
    });
  }
  // Near-complete NON-OBJECTIVE gates: a faction sitting ONE reachable,
  // other-owned blocker away from an invite is worth asking for even when it
  // is not the objective. The measured failure: CyberSec was one cheap CSEC
  // backdoor from an invite for an entire two-hour run while the objective
  // was deadlocked on an unservable employment requirement — and the board
  // never heard about the backdoor because only objective blockers post.
  // Urgency "wanted", never "blocking": these must not preempt real work.
  const gates = ctx.state.topics.factions?.gates ?? {};
  const posted = new Set(plan.blockers.map((blocker) => `${blocker.kind}\0${blocker.subject ?? ""}`));
  for (const [faction, gate] of Object.entries(gates)) {
    if (gate.joined || gate.invited || gate.missing.length !== 1) continue;
    const blocker = gate.missing[0]!;
    if (!blocker.reachable || blocker.owner === "factions") continue;
    if (blocker.kind === "bitNode" || blocker.kind === "sourceFile" || blocker.kind === "location") continue;
    const key = `${blocker.kind}\0${blocker.subject ?? ""}`;
    if (posted.has(key)) continue;
    posted.add(key);
    out.push({
      by: "factions",
      kind: blocker.kind as Need["kind"],
      ...(blocker.subject !== undefined ? { subject: blocker.subject } : {}),
      target: blocker.target,
      have: blocker.have,
      weight: 1 + blocker.progress * 2,
      urgency: "wanted",
      why: `${faction} ${blocker.why} — one step from an invite`,
    });
  }
  if (plan.until?.kind === "rep" && plan.until.faction && plan.until.have < plan.until.target) {
    out.push({
      by: "factions",
      kind: "factionRep",
      subject: plan.until.faction,
      target: plan.until.target,
      have: plan.until.have,
      weight: 6,
      urgency: "blocking",
      why: `${plan.until.faction} reputation unlocks the current augmentation package`,
    });
  }
  return out;
}

/** A joined faction whose objective augmentations still need reputation.
 *
 * Read from the store rather than recomputed: `claims` is pure and must not
 * duplicate the planner's work, and "is there anything at all to work toward"
 * is a much weaker question than "what exactly should we work on". */
function nextWorkFaction(state: GameState): string | undefined {
  const topic = state.topics.factions;
  if (!topic?.standings) return undefined;
  const joined = new Set(topic.joined);
  const objective = new Set(topic.plan?.objective?.factions ?? []);
  const intent = topic.plan?.objective?.intent;
  let best: { name: string; gap: number } | undefined;
  for (const standing of topic.standings) {
    if (!joined.has(standing.name)) continue;
    if (objective.size > 0 && !objective.has(standing.name)) continue;
    // The package frontier deliberately stops at a breakpoint. Asking for the
    // faction's highest offer here would silently undo that decision and keep
    // the shared work slot forever.
    let needed = intent?.faction === standing.name ? intent.repTarget : 0;
    if (needed === 0) {
      for (const offer of topic.offers ?? []) {
        if (offer.faction !== standing.name) continue;
        if (offer.repReq > needed) needed = offer.repReq;
      }
    }
    const gap = needed - standing.rep;
    if (gap <= 0) continue;
    if (!best || gap < best.gap) best = { name: standing.name, gap };
  }
  if (best) return best.name;

  // "Is there faction work worth doing" is a DURABLE fact, and the bug was deriving
  // it from a momentary one.
  //
  // The gap above is the current breakpoint's, and reaching a breakpoint closes it.
  // That made this return `undefined` for one pass — not because the answer had
  // changed, but because the planner had not yet named the next target. Dropping a
  // claim is how an incumbent RELEASES the slot (arbiter rule 3), so the feature
  // forgot what it wanted between breakpoints and handed the slot away every time.
  // Measured on a live BN12 run: 91 s of reputation per 650 s cycle, turning a 14 h
  // Daedalus grind into ~100 h.
  //
  // So answer the durable question directly — is there reputation still worth
  // earning at a faction we have joined — rather than inferring it from whichever
  // breakpoint happens to be current. This is the weaker question the doc above
  // describes, and asking it HERE cannot undo the breakpoint decision: it names no
  // target and changes no plan. WHAT to work on stays entirely the planner's call;
  // this only reports that the answer is not "nothing". Re-issuing the SAME claim id
  // is what preserves incumbency, so the intent's faction is preferred.
  //
  // When there is genuinely nothing left, it still returns `undefined` and the slot
  // is released — otherwise factions would sit on it doing nothing and `career`
  // could never earn again.
  const stillWanted = (topic.offers ?? []).some((offer) => {
    if (offer.owned) return false;
    if (!joined.has(offer.faction)) return false;
    const standing = topic.standings?.find((entry) => entry.name === offer.faction);
    return standing !== undefined && offer.repReq > standing.rep;
  });
  if (!stillWanted) return undefined;
  return intent?.faction !== undefined && joined.has(intent.faction) ? intent.faction : undefined;
}

/** What this feature is bidding for. */
function claims(ctx: ClaimContext): Claim[] {
  const topic = ctx.state.topics.factions;
  const plan = topic?.plan;
  const out: Claim[] = [];

  if (!plan) return out;

  // Work has a two-resource bootstrap: the previous plan could not select
  // work without the time slot, but once this pass grants that slot the driver
  // will immediately select workForFaction. Claim its RAM in the SAME pass or
  // execution observes a slot grant with no matching dodge grant.
  const working = plan.action.type === "workForFaction" ? plan.action.faction : undefined;
  const wanted = working ?? nextWorkFaction(ctx.state);

  const methods = factionMethods(plan.action.type);
  if (methods.length > 0) {
    out.push(actionRamClaim(ctx, "factions", factionClaimId(plan.action.type), methods, `factions ${plan.action.type}`));
  }
  if (plan.action.type === "idle" && plan.action.reason === "slot" && wanted) {
    out.push(actionRamClaim(
      ctx,
      "factions",
      factionClaimId("workForFaction"),
      factionMethods("workForFaction"),
      `start faction work at ${wanted} if the work slot is granted`,
    ));
  }

  const owned = new Set(topic?.ownedAugs ?? []);
  const objectiveAug = plan.objective?.augmentations.find((name) => !owned.has(name));
  const graftOffer = (topic?.offers ?? []).find((offer) => offer.name === objectiveAug);
  const graft = (topic?.graftable ?? []).find(
    (offer) => offer.name === objectiveAug && graftOffer?.affordableRep !== true,
  );

  // Fund whatever the PLAN says it will buy next, not whichever objective
  // augmentation happens to come first by value.
  //
  // THE BUG this replaces: the claim was derived from `plan.objective`, so by the
  // time the last-chance drain ran — objective complete, nothing left to work
  // toward — there was no objective augmentation, no claim, and no grant. The
  // purchase tests the GRANTED budget, so the drain bought nothing and every
  // install silently discarded the cash on hand. Once the install barrier began
  // blocking on "an augmentation is still purchasable" that became a hard
  // deadlock: progression waited for a purchase factions was never funded to make.
  //
  // `plan.nextBuy.price` is our own escalated price; the probed offer is the
  // game's. Reserve the larger of the two — a reserve that is short by a rounding
  // error buys nothing at all.
  // ENDGAME ONLY: purchases are end-loaded (the two-loop money rule — an aug
  // does nothing before the install reset, so mid-run the money compounds in
  // investments instead of sitting in a 90-priority reserve). The fund claim
  // therefore exists only while the final-sweep drain is live: install
  // recommended, drain running, or a purchase actually in flight.
  const endgame =
    plan.recommendInstall !== undefined || plan.drainCeiling !== undefined || plan.action.type === "purchaseAugmentation";
  if (endgame && plan.nextBuy && !graft && plan.action.type !== "donate") {
    const probed = (topic?.offers ?? []).find((offer) => offer.name === plan.nextBuy!.name);
    out.push({
      by: "factions",
      id: "aug-fund",
      resource: "money",
      amount: Math.max(plan.nextBuy.price, probed?.price ?? 0),
      priority: PRIORITY["factions:aug-fund"],
      mode: "reserve",
      divisible: true,
      why: `buying ${plan.nextBuy.name}`,
    });
    // The decision is made at tick time, AFTER this pass's arbitration — so a
    // purchase decided this pass would find no RAM grant and burn a whole
    // 30-second cadence waiting for the next one (measured: one dead pass per
    // NeuroFlux level on factions-install). Same anticipation contract as the
    // workForFaction claim above: whenever the plan is funding a buy, reserve
    // the dodge RAM that buy will need in the same pass.
    if (plan.action.type !== "purchaseAugmentation") {
      out.push(actionRamClaim(
        ctx,
        "factions",
        factionClaimId("purchaseAugmentation"),
        factionMethods("purchaseAugmentation"),
        `purchase ${plan.nextBuy.name} when the fund grant lands`,
      ));
    }
  }
  if (graft) {
    if (plan.action.type !== "graft") {
      out.push(actionRamClaim(ctx, "factions", factionClaimId("graft"), factionMethods("graft"), `graft ${graft.name}`));
    }
    // Grafting is only started in New Tokyo. Reserve the travel call before
    // the planner emits `travelTo`; otherwise the first travel decision cannot
    // obtain a RAM lease until the following slow faction tick.
    if (ctx.state.topics.player?.city !== "New Tokyo" && plan.action.type !== "travelTo") {
      out.push(actionRamClaim(ctx, "factions", factionClaimId("travelTo"), factionMethods("travelTo"), "travel to New Tokyo for grafting"));
    }
    out.push(
      {
        by: "factions",
        id: "graft-fund",
        resource: "money",
        amount: graft.price,
        priority: PRIORITY["factions:aug-fund"],
        mode: "reserve",
        divisible: false,
        why: `graft ${graft.name}`,
      },
      {
        by: "factions",
        id: `graft:${graft.name}`,
        resource: "time",
        amount: 1,
        priority: PRIORITY["factions:work"],
        mode: "spend",
        why: `grafting ${graft.name} occupies Player.currentWork`,
      },
    );
  }
  if (plan.action.type === "travelTo") {
    out.push({
      by: "factions",
      id: "travel-fund",
      resource: "money",
      amount: 200_000,
      priority: PRIORITY["factions:aug-fund"],
      mode: "spend",
      divisible: false,
      why: "travel costs $200,000",
    });
  }

  if (plan.action.type === "donate" && plan.action.amount && plan.action.amount > 0) {
    out.push({
      by: "factions",
      id: "donation-fund",
      resource: "money",
      amount: plan.action.amount + (plan.action.purchaseCost ?? 0),
      // The band the table names for donations — 70, deliberately below the
      // aug fund (90): converting cash to reputation waits behind converting
      // it to augmentations.
      priority: PRIORITY["factions:donate"],
      mode: "reserve",
      divisible: true,
      why: `donating exactly enough for ${plan.action.faction}'s reputation breakpoint and preserving its purchase`,
    });
  }

  // Bid for the work slot whenever there is a joined faction with reputation
  // still to earn — NOT only when the last plan already said `workForFaction`.
  //
  // Deriving the claim from the previous decision cannot bootstrap: the
  // decision needs the slot, the slot needs the claim, and the claim was
  // waiting for the decision. The feature would sit at "another feature holds
  // Player.currentWork" forever with nobody actually holding it.
  if (wanted) {
    out.push({
      by: "factions",
      // Stable per faction: re-issuing the SAME id is what holds the slot
      // across ticks, and a new faction is correctly a new claim.
      id: `work:${wanted}`,
      resource: "time",
      amount: 1,
      // Scored on what the slot yields, like every other claimant — see
      // `shared/strategy/income.ts`. Faction work is the only source of faction
      // reputation, so whenever it wants the slot it IS the best reputation option
      // and takes the full `REP_SPAN`; it pays no salary, so its money fraction is
      // zero. That arithmetic reproduces the constant this used to be, which is the
      // point: the number stops being a magic 60 and becomes a consequence.
      priority: slotPriority({ repFraction: 1 }),
      mode: "spend",
      ratePerSec: plan.until?.etaSec ? 1 / plan.until.etaSec : 0,
      why: working ? plan.action.why : `reputation still needed at ${wanted}`,
    });
  }

  return out;
}

function factionClaimId(type: string): string {
  return `action:${type}`;
}

function factionMethods(type: string): readonly string[] {
  switch (type) {
    case "joinFaction": return ["singularity.joinFaction"];
    case "workForFaction": return ["singularity.workForFaction"];
    case "stopWork": return ["singularity.stopAction"];
    case "travelTo": return ["singularity.travelToCity"];
    case "donate": return ["singularity.getFactionRep", "singularity.donateToFaction"];
    case "purchaseAugmentation": return ["singularity.purchaseAugmentation"];
    case "graft": return ["grafting.graftAugmentation", "singularity.getCurrentWork"];
    default: return [];
  }
}

export const factionsModule: FeatureModule = {
  driver,
  reset: (state) => {
    resetFactionsState();
    // The published topic is live data from a dead node. Left in place, the
    // new node's FIRST route decision reads the old run's Red Pill out of
    // ownedAugs — and the singularity probe that would correct it can be
    // unaffordable for a long time on a fresh home.
    delete state.topics.factions;
  },
  claims,
  needs,
  peakStepGb: PEAK_STEP_GB,
};
