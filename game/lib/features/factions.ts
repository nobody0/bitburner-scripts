import type { NS, PlayerRequirement } from "@ns";
import { effectiveBitNodeMultipliers, worldDaemonSkill } from "../../../shared/features/bitnode.ts";
import { AUGMENTATIONS } from "../../../shared/features/augmentations.ts";
import { formatMoney, formatNumber } from "../../../shared/format.ts";
import { sfLevel } from "../../../shared/features/unlock.ts";
import { FEATURE_IDS } from "../../../shared/features/ids.ts";
import { grantFor, PRIORITY, type Claim } from "../../../shared/strategy/arbiter.ts";
import { REPUTATION_CHANNEL } from "../../../shared/strategy/income.ts";
import { incomeShares, slotRates } from "../income.ts";
import {
  NEUROFLUX,
  augCost,
  isSoA,
  weightsFromMarginals,
  type AugInfo,
  type PriceContext,
} from "../../../shared/strategy/factions/augs.ts";
import { blockersFor, chooseWorkType, soleTravelBlocker, stepFactions } from "../../../shared/strategy/factions/decide.ts";
import { initFactionMemory, type FactionAction, type FactionDecision, type FactionMemory } from "../../../shared/strategy/factions/plan.ts";
import { donationForRep, repFromDonation } from "../../../shared/strategy/factions/rep.ts";
import type { FactionStanding, FactionsView, RepProfileView } from "../../../shared/strategy/factions/state.ts";
import { estimateBlockerSec, isReachable, type RequirementView } from "../../../shared/strategy/factions/requirements.ts";
import {
  backdoorCostSeconds,
  companyBackdoorSavedSeconds,
  factionGateSavedSeconds,
} from "../../../shared/strategy/access/value.ts";
import { makeHackContext } from "../../../shared/formulas.ts";
import type { Need } from "../../../shared/strategy/needs.ts";
import { COMMISSION } from "../../../shared/strategy/stock/market.ts";
import { daedalusAugsRequired, labyrinthCharismaTargetFor, RED_PILL } from "../../../shared/strategy/progression/endgame.ts";
import { DEFAULT_PLANNING_HORIZON_SEC, forecastAt, usableForecastSec } from "../../../shared/strategy/progression/forecast.ts";
import { factionFavorPointValues } from "../../../shared/strategy/factions/favorValue.ts";
import type {
  FactionGate,
  FactionPlan,
  FavorPointValueDigest,
  PlanBlocker,
} from "../../../shared/telemetry/topics/factions.ts";
import { isScriptDeath } from "../errors.ts";
import { merge, type GameState } from "../state.ts";
import { signalInstallCheck } from "../install-signal.ts";
import { armWorkCompletion, disarmWorkCompletion, peekWorkCompletion, workDetail, type WorkTaskLike } from "../work-completion.ts";
import type { ClaimContext, DriverContext, FeatureDriver, FeatureModule, NeedContext } from "./index.ts";

/** The factions driver: build a view, decide, execute ONE action, report.
 *
 * Thin by design. Every decision lives in shared/strategy/factions/, which is
 * pure and unit-tested; this file only moves data and turns one `FactionAction`
 * into singularity calls on the ns proxy.
 *
 * Two rules that are specific to this feature and easy to get wrong:
 *
 *  - **One action per tick.** The only multi-call case is a purchase run,
 *    which walks the affordable prefix in order — because each purchase
 *    changes the price of the next, so they have to see each other's effects.
 *  - **A `false` return is an OUTCOME, not an error.** Boolean mutation calls
 *    use false for ordinary refusals (funds, membership, prerequisites).
 *    Invalid enum input and grafting outside New Tokyo throw instead, and
 *    those throws propagate rather than being recorded as a refusal.
 *
 * Pinned upstream Singularity action contracts:
 * https://github.com/bitburner-official/bitburner-src/blob/3162fd2590e221eadd0c0fbd46151913f7c4c41c/src/NetscriptFunctions/Singularity.ts#L771-L967
 * https://github.com/bitburner-official/bitburner-src/blob/3162fd2590e221eadd0c0fbd46151913f7c4c41c/src/NetscriptFunctions/Grafting.ts#L17-L103 */

const SHADOWS_OF_ANARCHY = "Shadows of Anarchy";
/** These factions are joined/progressed through their own mechanics, not by
 * satisfying the ordinary invitation/work loop.
 * https://github.com/bitburner-official/bitburner-src/blob/3162fd2590e221eadd0c0fbd46151913f7c4c41c/src/Faction/FactionInfo.tsx#L695-L813 */
const SPECIAL_FACTIONS = new Set(["Bladeburners", "Church of the Machine God", SHADOWS_OF_ANARCHY]);

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
/** A faction package is ready to work but lost Player.currentWork to a
 * completable task. Wake exactly at that task's completion so ordinary
 * faction priority can compete before career starts the next unit. */
let waitingForWorkSlot = false;

export function resetFactionsState(): void {
  memory = initFactionMemory();
  lastResult = undefined;
  chainWake = false;
  seenCompletion = undefined;
  waitingForWorkSlot = false;
}

/** The grant won by ONE of this feature's money claims — never the sum.
 * Same contract as hacking's moneyGrantFor and stock's StockGrants: four
 * claims at one priority summed together would let a travel grant top up a
 * purchase the arbiter never funded. */
function moneyGrantFor(ctx: Pick<DriverContext, "grants">, claimId: string): number {
  const grant = grantFor(ctx.grants.result, "factions", claimId);
  return grant && grant.resource === "money" ? grant.amount : 0;
}

// --- view assembly ----------------------------------------------------------

type ServerSnapshot = NonNullable<GameState["topics"]["servers"]>[string];

/** Company organization -> every server the game attributes to it, hostname
 * order. A MULTIMAP on purpose: `fulcrumtech` and `fulcrumassets` share the
 * organization "Fulcrum Technologies", and the game's 0.75x required-reputation
 * discount fires when ANY of a company's servers is backdoored. A
 * last-write-wins map would miss the discount half the time. */
function serversByOrganization(state: GameState): Map<string, ServerSnapshot[]> {
  const out = new Map<string, ServerSnapshot[]>();
  for (const server of Object.values(state.topics.servers ?? {})) {
    if (!server.organizationName) continue;
    const list = out.get(server.organizationName) ?? [];
    list.push(server);
    out.set(server.organizationName, list);
  }
  for (const list of out.values()) list.sort((a, b) => (a.hostname < b.hostname ? -1 : 1));
  return out;
}

/** Companies whose required reputation the game is ALREADY discounting. */
function backdooredCompanies(state: GameState): Set<string> {
  const out = new Set<string>();
  for (const [organization, servers] of serversByOrganization(state)) {
    if (servers.some((server) => server.backdoorInstalled)) out.add(organization);
  }
  return out;
}

/** Company -> the best reputation rate career has actually observed there. */
function measuredCompanyRepPerSec(state: GameState): Map<string, number> {
  const out = new Map<string, number>();
  for (const entry of state.topics.career?.plan?.ranked ?? []) {
    for (const contribution of entry.contributions ?? []) {
      if (contribution.kind !== "companyRep" || !contribution.subject || !(contribution.perSec > 0)) continue;
      out.set(contribution.subject, Math.max(out.get(contribution.subject) ?? 0, contribution.perSec));
    }
  }
  return out;
}

function requirementView(state: GameState, companyWork?: RequirementView["companyWork"]): RequirementView {
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

  // Price backdoor blockers with the real formulas (hackTime/4 at the acting
  // skill, measured exp rate for the wait) instead of the interpreter's
  // nominal constants. Optional by construction: without a player snapshot
  // the interpreter degrades to the old coarse estimate.
  const viewNodeMults = effectiveBitNodeMultipliers(
    progression?.bitNode,
    progression?.sourceFiles["12"] ?? 0,
    progression?.multipliers,
  ) ?? {};
  const playerMults = (player?.mults ?? {}) as unknown as Record<string, number>;
  const hackCtx = player
    ? makeHackContext({
        skill: player.skills?.hacking ?? 1,
        intelligence: player.skills?.intelligence ?? 0,
        mults: {
          hacking_chance: playerMults["hacking_chance"] ?? 1,
          hacking_money: playerMults["hacking_money"] ?? 1,
          hacking_speed: playerMults["hacking_speed"] ?? 1,
          hacking_exp: playerMults["hacking_exp"] ?? 1,
          hacking_grow: playerMults["hacking_grow"] ?? 1,
        },
      }, viewNodeMults)
    : undefined;
  const expRate = state.topics.farm?.expRate;
  const accessEstimates = (server: (typeof servers)[string]): { installSec: number; skillWaitSec: number } | undefined => {
    if (!hackCtx || !player) return undefined;
    const cost = backdoorCostSeconds({
      requiredHackingSkill: server.requiredHackingSkill ?? 1,
      hackDifficulty: server.hackDifficulty ?? server.minDifficulty ?? 1,
      ctx: hackCtx,
      hackingExp: player.exp?.hacking ?? 0,
      hackingSkillMult: playerMults["hacking"] ?? 1,
      ...(expRate !== undefined ? { expPerSec: expRate } : {}),
    });
    return { installSec: cost.actionSec, skillWaitSec: cost.skillWaitSec };
  };

  // Invitation requirements count INSTALLED augmentations for positive
  // targets; queued purchases do not qualify. getResetInfo().ownedAugs is the
  // installed list, while singularity.getOwnedAugmentations(true) also contains
  // the queue.
  // https://github.com/bitburner-official/bitburner-src/blob/3162fd2590e221eadd0c0fbd46151913f7c4c41c/src/Faction/FactionJoinCondition.ts#L119-L132
  return {
    money: player?.money ?? 0,
    skills: { ...(player?.skills ?? {}) } as Record<string, number>,
    karma: player?.karma ?? 0,
    numPeopleKilled: player?.numPeopleKilled ?? 0,
    augCount: progression?.augCount ?? 0,
    purchasedAugCount: new Set((factions?.ownedAugs ?? []).filter((name) => name !== NEUROFLUX)).size,
    jobs: { ...(player?.jobs ?? {}) } as Record<string, string>,
    companyRep: Object.fromEntries(
      Object.entries(career?.companies ?? {}).map(([name, standing]) => [name, standing.rep]),
    ),
    jobTitles: Object.values((player?.jobs ?? {}) as Record<string, string>),
    city: String(player?.city ?? "Sector-12"),
    location: String(player?.location ?? "home"),
    backdoored,
    backdoorAccess: Object.fromEntries(
      Object.entries(servers).map(([hostname, server]) => [hostname, {
        requiredHackingSkill: server.requiredHackingSkill ?? 0,
        numOpenPortsRequired: server.numOpenPortsRequired ?? 0,
        openPortCount: server.openPortCount ?? 0,
        ...(accessEstimates(server) ?? {}),
      }]),
    ),
    portOpeners: state.topics.fleet?.portOpeners ?? 0,
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
    ...(companyWork ? { companyWork } : {}),
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
/** The person and node context the reputation formulas read, from telemetry alone.
 *
 * Extracted so `buildFactionsView` and the work CLAIM derive them the same way.
 * The claim has to price itself on passes where the planner exited early and
 * published no work rate, and it runs on a `NeedContext` with no driver context
 * to build a whole view from — but predicting reputation never needed one. */
/** Which work types a faction offers, from the probe.
 *
 * An unreported probe offers NOTHING rather than all three: a wrong guess makes
 * the driver call `workForFaction(Tetrads, "hacking")` — which Tetrads does not
 * offer — and the call fails silently every tick while reputation never accrues.
 * Not working for one minute until the probe lands is cheap; working the wrong
 * type forever is not. */
function workOffers(state: GameState, faction: string): FactionStanding["offers"] {
  const types = state.topics.factions?.workTypes?.[faction] ?? [];
  return {
    hacking: types.includes("hacking"),
    field: types.includes("field"),
    security: types.includes("security"),
  };
}

/** What the player is doing right now, in view vocabulary. Shared by the view
 * and the work claim so a measured rate is attributed the same way in both. */
function currentWorkView(state: GameState): RepProfileView["currentWork"] {
  const work = state.topics.career?.currentWork;
  if (!work) return undefined;
  return {
    kind: work.type === "FACTION" ? "faction" : String(work.type).toLowerCase(),
    faction: work.detail,
    detail: work.detail,
    ...(work.workType ? { workType: work.workType as "hacking" | "field" | "security" } : {}),
    focused: true,
  };
}

function repProfile(
  state: GameState,
  caps: Pick<NeedContext["caps"], "bitNode" | "sourceFiles">,
  owned: ReadonlySet<string>,
): Pick<RepProfileView, "person" | "repContext"> {
  const player = state.topics.player;
  const mults = (player?.mults ?? {}) as unknown as Record<string, number>;
  const nodeMults = effectiveBitNodeMultipliers(
    caps.bitNode,
    sfLevel(caps.sourceFiles, 12),
    state.topics.progression?.multipliers,
  ) ?? {};
  return {
    person: {
      // `intelligence` is a term in every reputation formula and is absent from
      // a snapshot taken before the stat exists. Defaulting it to 0 keeps the
      // bid a number: a NaN rate compares false against everything and would
      // silently drop the claim out of the auction.
      skills: { intelligence: 0, ...(player?.skills ?? {}) } as never,
      // The `*_exp` multipliers are what `factionWorkExpPerSec` scales the work
      // type's experience by. Omitting them left every one defaulting to 1, so
      // the combat and hacking a field/security shift actually pays was scored
      // below what crime pays for the same second.
      mults: {
        faction_rep: mults["faction_rep"] ?? 1,
        hacking_exp: mults["hacking_exp"] ?? 1,
        strength_exp: mults["strength_exp"] ?? 1,
        defense_exp: mults["defense_exp"] ?? 1,
        dexterity_exp: mults["dexterity_exp"] ?? 1,
        agility_exp: mults["agility_exp"] ?? 1,
        charisma_exp: mults["charisma_exp"] ?? 1,
      },
    } as RepProfileView["person"],
    repContext: {
      factionWorkRepGain: nodeMults["FactionWorkRepGain"] ?? 1,
      factionWorkExpGain: nodeMults["FactionWorkExpGain"] ?? 1,
      factionPassiveRepGain: nodeMults["FactionPassiveRepGain"] ?? 1,
      shareBonus: state.topics.fleet?.sharePower ?? 1,
      sf15Level: sfLevel(caps.sourceFiles, 15),
      hasFocusAug: owned.has("Neuroreceptor Management Implant"),
    },
  };
}

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

  // The live getter is authoritative for node- and gang-dependent offers
  // (notably The Red Pill is removed from Daedalus in BN15, while gang
  // factions can gain a different filtered catalogue). Replace static seller
  // lists only after the stepped probe proves its capped result is complete.
  // https://github.com/bitburner-official/bitburner-src/blob/3162fd2590e221eadd0c0fbd46151913f7c4c41c/src/Faction/FactionHelpers.tsx#L172-L210
  if (topic.offers && topic.augTotal !== undefined && topic.offers.length === topic.augTotal) {
    const dynamicSellers = new Map<string, string[]>();
    for (const offer of topic.offers) {
      const sellers = dynamicSellers.get(offer.name) ?? [];
      if (!sellers.includes(offer.faction)) sellers.push(offer.faction);
      dynamicSellers.set(offer.name, sellers);
    }
    for (const [name, aug] of catalog) {
      if (!owned.has(name) || name === NEUROFLUX) aug.factions = dynamicSellers.get(name) ?? [];
    }
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
      offers: workOffers(state, name),
      special: SPECIAL_FACTIONS.has(name),
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
  const rates = slotRates(state, ctx.board);
  const profile = repProfile(state, ctx.caps, owned);
  const currentWork = currentWorkView(state);
  // The labyrinth's final charisma gate, where that route exists; the
  // worth("charisma") factor is zero everywhere else, so deriving it
  // unconditionally prices nothing into other nodes.
  const charismaTarget = labyrinthCharismaTargetFor(
    ctx.caps.bitNode,
    sfLevel(ctx.caps.sourceFiles, 12),
    ctx.caps.darknetFullAccess === "yes",
    owned.has(RED_PILL),
  );

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
    ...profile,
    // Company blockers (employment / companyRep / jobTitle) are priced with
    // the real work-line model. Company reputation at never-held employers is
    // invisible to telemetry, so those walks start from 0 — an underestimate
    // of progress, never of cost. `focusMult` is 1, not the unfocused 0.8:
    // career always starts company work focused (`workForCompany(name, true)`),
    // so 0.8 would price every ladder 25% slower than the driver delivers.
    requirementView: requirementView(state, {
      person: {
        skills: { ...(player.skills ?? {}) } as Record<string, number>,
        mults: {
          company_rep: mults["company_rep"] ?? 1,
          work_money: mults["work_money"] ?? 1,
        },
      },
      ctx: {
        companyWorkRepGain: nodeMults["CompanyWorkRepGain"] ?? 1,
        companyWorkMoney: nodeMults["CompanyWorkMoney"] ?? 1,
        focusMult: 1,
      },
      favor: Object.fromEntries(
        Object.entries(state.topics.career?.companies ?? {}).map(([name, standing]) => [name, standing.favor]),
      ),
      // Server -> company identity IS observable (`organizationName`), so the
      // promotion ladder's reputation gates get the same 0.75x discount the
      // game applies once any of the company's servers is backdoored.
      // `measuredRepPerSec` stays unset deliberately: the walker attributes a
      // measured rate to the FIRST rung of whichever track it walks, which is
      // only the observed one when career happens to hold that same track.
      backdooredCompanies: backdooredCompanies(state),
    }),
    availableOwners: new Set(FEATURE_IDS.filter((id) => caps.unlocked[id] !== "no")),
    priceContext,
    factions,
    catalog,
    owned,
    queued: queuedAugs,
    graftable: topic.graftable ?? [],
    entropy: player.entropy ?? 0,
    // The route no longer selects a weight table; the route's own MARGINALS
    // price every channel, and a branch that is not binding is simply worth
    // nothing. `routeAugmentationFocus` went with it — "is combat the critical
    // alternative" is a measurement, not a switch to set.
    weights: weightsFromMarginals(rates.worth, {
      hackingTarget: worldDaemonSkill(ctx.caps.bitNode, sfLevel(ctx.caps.sourceFiles, 12)),
      combatTarget: 1_500,
      ...(charismaTarget !== undefined ? { charismaTarget } : {}),
      multipliers: mults,
      incomeShares: incomeShares(state),
    }),
    ...(ctx.route ? { route: ctx.route } : {}),
    // Factions creates the package that will eventually trigger the install,
    // so it plans against the node horizon rather than circularly depending
    // on the not-yet-known install horizon. Unknown means no arbitrary cutoff.
    horizonSec: usableForecastSec(ctx.horizons.node) ?? Infinity,
    installCycleSec: Math.max(
      0,
      (now - (state.topics.progression?.lastAugReset ?? now)) / 1_000,
    ),
    // Rates do not hold still within a cycle, so a reputation or money gap is
    // converted to seconds through progression's fitted curve rather than
    // divided by today's rate. Absent until progression has enough samples to
    // fit, and the conversion degrades to the spot answer meanwhile.
    ...((): { cyclePace?: FactionsView["cyclePace"]; resetOverheadSec?: number } => {
      const pace = ctx.state.topics.progression?.plan?.pace;
      if (!pace) return {};
      return {
        cyclePace: {
          elapsedSec: pace.elapsedSec,
          exponent: {
            ...(pace.money !== undefined ? { money: pace.money } : {}),
            ...(pace.hacking !== undefined ? { hacking: pace.hacking } : {}),
            ...(pace.combat !== undefined ? { combat: pace.combat } : {}),
          },
        },
        resetOverheadSec: pace.resetOverheadSec,
      };
    })(),
    // Only a route KNOWN not to be Daedalus lifts the count goal. Before
    // progression has published one — the whole early window, until an endgame
    // view and measured rates exist — `Infinity` would zero `countSlotWeight`,
    // disable the repeat-NeuroFlux suppression and skip the route-count
    // closure, so early cycles buy cheap multipliers instead of accumulating
    // the distinct installs the invitation gate counts.
    targetAugCount: ctx.route === undefined || ctx.route === "daedalus"
      ? daedalusAugsRequired(ctx.caps.bitNode, sfLevel(ctx.caps.sourceFiles, 12)) ?? Infinity
      : Infinity,
    favorToDonate: topic.favorToDonate ?? 150,
    // Progression owns the install cadence: when its published plan wants the
    // reset, this feature concludes (stops working, runs the final sweep).
    ...(ctx.state.topics.progression?.plan?.installWanted === true ? { installRequested: true } : {}),
    ...(ctx.state.topics.progression?.plan?.installFundedAugmentations
      ? { installFundedAugmentations: ctx.state.topics.progression.plan.installFundedAugmentations }
      : {}),
    ...(ctx.state.topics.progression?.plan?.routeInstallRequired === true
      ? { routeInstallRequired: true }
      : {}),
    ...(ctx.state.topics.progression?.plan?.endingByDestroy === true
      ? { endingByDestroy: true }
      : {}),
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
    rates,
    ...(currentWork ? { currentWork } : {}),
    // ns.getTotalScriptIncome returns [current live-script rate,
    // since-last-install hacking rate]. The crossover needs the first one.
    incomePerSec: incomeRate(state.topics.fleet?.scriptIncome),
    sf4Level: sfLevel(caps.sourceFiles, 4),
    bitNode: caps.bitNode ?? 1,
  };
}

// --- execution --------------------------------------------------------------

/** Turn one decided action into singularity calls on the ns proxy.
 *
 * Every branch reports what the game actually returned. `false` from a
 * boolean Singularity mutation is a modelled refusal rather than an exception;
 * a genuine throw (no SF4, a rejected enum) propagates to the driver's own
 * handler, which is the only thing that should latch a backoff. */
async function execute(_ns: NS, ctx: DriverContext, action: FactionAction, view: FactionsView): Promise<void> {
  const at = Date.now();
  const record = (ok: boolean, detail: string): void => {
    lastResult = { action: action.type, ok, detail, at };
  };

  switch (action.type) {
    case "idle":
      return;

    case "joinFactions": {
      const joined: string[] = [];
      const failed: string[] = [];
      for (const faction of action.factions) {
        if (await ctx.nsp("singularity.joinFaction", faction as never)) joined.push(faction);
        else failed.push(faction);
      }
      if (joined.length > 0 || failed.length > 0) {
        const topic = ctx.state.topics.factions;
        const accepted = new Set(joined);
        // A faction the game REFUSED leaves `invites` too. Nothing else clears
        // it, and `joinFactions` is the first decision step — so one invitation
        // the game will not honour (a withdrawn invite, an enemy our metadata
        // does not predict) would otherwise be re-decided on every single pass,
        // starving purchase, travel, donate and work until the 30 s probe
        // happened to refresh the list. The probe republishes it if it was real.
        const refusedByGame = new Set(failed);
        const acceptedStandings = view.factions.filter((standing) => accepted.has(standing.name));
        const invalidated = new Set(
          view.factions
            .filter((standing) => acceptedStandings.some(
              (member) =>
                member.enemies.includes(standing.name) ||
                standing.enemies.includes(member.name),
            ))
            .map((standing) => standing.name),
        );
        merge(ctx.state, "factions", {
          ...(joined.length > 0
            ? { joined: [...new Set([...(topic?.joined ?? []), ...joined])] }
            : {}),
          invites: (topic?.invites ?? []).filter(
            (faction) => !accepted.has(faction) && !invalidated.has(faction) && !refusedByGame.has(faction),
          ),
        });
        // Membership changes the immediately actionable work frontier.
        if (joined.length > 0) chainWake = true;
      }
      const complete = failed.length === 0;
      record(
        complete,
        complete
          ? `joined ${joined.join(", ")}`
          : `joined ${joined.join(", ") || "none"}; game refused ${failed.join(", ")}`,
      );
      return;
    }

    case "workForFaction": {
      const ok = await ctx.nsp("singularity.workForFaction", action.faction as never, action.workType as never, action.focus);
      record(
        ok,
        ok ? `working ${action.faction} (${action.workType})` : `${action.faction} does not offer ${action.workType}`,
      );
      return;
    }

    case "stopWork": {
      const ok = await ctx.nsp("singularity.stopAction");
      record(ok, ok ? "stopped" : "nothing was running");
      return;
    }

    case "travelTo": {
      if (moneyGrantFor(ctx, "travel-fund") < 200_000) {
        record(false, "waiting for $200,000 travel grant");
        return;
      }
      const ok = await ctx.nsp("singularity.travelToCity", action.city as never);
      record(ok, ok ? `travelled to ${action.city}` : `could not afford travel to ${action.city}`);
      return;
    }

    case "donate": {
      // The decision can precede the arbiter grant that it causes. Keep the
      // intent published so the next claims pass reserves the exact amount,
      // but do not bypass that grant in the meantime.
      const reserve = action.amount + (action.purchaseCost ?? 0);
      if (Math.max(moneyGrantFor(ctx, "donation-fund"), moneyGrantFor(ctx, "aug-fund")) < reserve) {
        record(false, `waiting for ${formatMoney(reserve)} donation and purchase grant`);
        return;
      }
      const plannedRep = view.factions.find((standing) => standing.name === action.faction)?.rep ?? 0;
      const repTarget = plannedRep
        + repFromDonation(action.amount, view.person.mults.faction_rep, view.repContext.factionWorkRepGain);
      // A donation can wait behind its money grant while faction work or
      // passive gain keeps raising reputation. Read BEFORE mutating, then
      // preserve the planner's target with the smallest current donation.
      const currentRep = await ctx.nsp("singularity.getFactionRep", action.faction as never);
      const amount = donationForRep(
        Math.max(0, repTarget - currentRep),
        view.person.mults.faction_rep,
        view.repContext.factionWorkRepGain,
      );
      const donated = amount > 0
        ? await ctx.nsp("singularity.donateToFaction", action.faction as never, amount)
        : false;
      setFactionRep(
        ctx.state,
        action.faction,
        donated
          ? currentRep + repFromDonation(amount, view.person.mults.faction_rep, view.repContext.factionWorkRepGain)
          : currentRep,
      );
      const ok = amount <= 0 || donated;
      record(
        ok,
        ok
          ? amount > 0
            ? `donated ${formatMoney(amount)}`
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
        // Claims are collected from the previously published plan. After one
        // successful purchase raises the 1.9x queue exponent, the next tick
        // can therefore decide a dearer action than this pass funded. Publish
        // that new price (below) and wake immediately so the next arbitration
        // funds it; otherwise every escalation burns the full 30-second
        // faction cadence despite the end-loaded transaction being ready.
        chainWake = true;
        record(false, `waiting for the ${formatMoney(fundNeeded)} augmentation fund grant`);
        return;
      }
      const ok = await ctx.nsp("singularity.purchaseAugmentation", action.faction as never, action.augmentation as never);
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
      record(ok, ok ? `bought ${action.augmentation}` : "purchase refused (rep or money short)");
      return;
    }

    case "graft": {
      if (!ctx.grants.slot) {
        record(false, "waiting for Player.currentWork");
        return;
      }
      // Disarm before starting: a completion belonging to the work the graft
      // displaces must not be read as this graft's own.
      disarmWorkCompletion();
      const ok = await ctx.nsp("grafting.graftAugmentation", action.augmentation as never, true);
      const task = await ctx.nsp("singularity.getCurrentWork") as (Record<string, unknown> & WorkTaskLike) | null;
      if (task) armWorkCompletion(task);
      merge(ctx.state, "career", {
        currentWork: task
          ? {
              type: String(task.type),
              detail: workDetail(task) ?? "",
              cyclesWorked: typeof task.cyclesWorked === "number" ? task.cyclesWorked : 0,
              observedAt: Date.now(),
            }
          : null,
      });
      record(ok, ok ? `grafting ${action.augmentation}` : "grafting refused");
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

function planDigest(decision: FactionDecision, view: FactionsView, bankedAugmentations: readonly string[]): FactionPlan {
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
    bankedAugmentations: [...bankedAugmentations],
    ...(decision.objective ? { objective: decision.objective } : {}),
    action: {
      type: decision.action.type,
      ...(decision.action.type === "idle" && decision.action.reason === "slot" ? { awaitingWorkSlot: true } : {}),
      ...("faction" in decision.action ? { faction: decision.action.faction } : {}),
      ...("factions" in decision.action ? { factions: [...decision.action.factions] } : {}),
      ...("augmentation" in decision.action ? { augmentation: decision.action.augmentation } : {}),
      ...("city" in decision.action ? { city: decision.action.city } : {}),
      ...("workType" in decision.action ? { workType: decision.action.workType } : {}),
      ...("amount" in decision.action ? { amount: decision.action.amount } : {}),
      ...("purchaseCost" in decision.action && decision.action.purchaseCost !== undefined
        ? { purchaseCost: decision.action.purchaseCost }
        : {}),
    },
    alternatives: decision.alternatives.map(({ label, value }) => ({ label, value })),
    invalidation: decision.invalidation,
    ...(decision.drainCeiling !== undefined ? { drainCeiling: decision.drainCeiling } : {}),
    ...(decision.drainCosts !== undefined ? { drainCosts: decision.drainCosts } : {}),
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
      ...(blocker.etaSec !== undefined ? { etaSec: blocker.etaSec } : {}),
    })),
    ...(decision.until ? { until: decision.until } : {}),
    ...(decision.workRate ? { workRate: decision.workRate } : {}),
    ...(lastResult ? { lastResult } : {}),
    ...(decision.blocked ? { blocked: { kind: "singularityRam", bitNode: view.bitNode, sf4Level: view.sf4Level, callRamGb: 80 } } : {}),
    ...(decision.recommendInstall ? { recommendInstall: { augmentations: decision.recommendInstall.augmentations } } : {}),
    ...(decision.liquidationNeeded ? { liquidationNeeded: {
      augmentation: decision.liquidationNeeded.augmentation,
      price: decision.liquidationNeeded.price,
      cash: decision.liquidationNeeded.cash,
      pendingProceeds: decision.liquidationNeeded.pendingProceeds,
    } } : {}),
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
        ...(blocker.etaSec !== undefined ? { etaSec: blocker.etaSec } : {}),
      })),
    };
  }
  return gates;
}

/** Publish the favor economics this view already implies. Rounded to whole
 * seconds: these feed a five-second Go decision, not an accounting ledger. */
export function favorPointValuesFrom(view: FactionsView): Record<string, FavorPointValueDigest> {
  const values: Record<string, FavorPointValueDigest> = {};
  for (const [faction, value] of factionFavorPointValues(view)) {
    values[faction] = {
      remainingWorkSec: Math.round(value.remainingWorkSec),
      donationUnlockSec: Math.round(value.donationUnlockSec),
      donateThreshold: value.donateThreshold,
    };
  }
  return values;
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
    // Career consumes the shared notice too. A completed crime/course/program
    // can change a faction gate, but those gates are safely refreshed on this
    // driver's ordinary 30-second cadence. Only our own faction-work tick must
    // immediately advance a reputation breakpoint; waking the full frontier
    // solver on every short crime dominated long benchmark wall time.
    return notice !== undefined
      && notice !== seenCompletion
      && (notice.type === "FACTION" || waitingForWorkSlot);
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
    // "Waiting" covers wanting the slot as well as being blocked on it: when a
    // higher band preempts live faction work or a graft, our last decision was
    // workForFaction/graft, not idle-for-slot. Without this the freeing
    // completion is ignored and the player stands idle for a full cadence.
    waitingForWorkSlot = decision.action.type === "idle"
      ? decision.action.reason === "slot"
      : decision.action.type === "workForFaction" || decision.action.type === "graft";

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
    merge(ctx.state, "factions", {
      plan: planDigest(decision, view, memory.bankedAugmentations),
      gates: gatesFrom(view),
      favorPointValues: favorPointValuesFrom(view),
    });

    try {
      await execute(ctx.ns, ctx, decision.action, view);
      // Publish the outcome in the same controller pass. Waiting until the
      // next 30-second faction decision made result telemetry lag one action
      // behind and could lose the final successful purchase when a goal/reset
      // ended the run immediately afterward.
      merge(ctx.state, "factions", { plan: planDigest(decision, view, memory.bankedAugmentations) });
    } catch (error) {
      // ScriptDeath is a kill, not a feature bug — rethrow so the controller
      // can shut down cleanly rather than looping on a corpse.
      if (isScriptDeath(error)) throw error;
      lastResult = { action: decision.action.type, ok: false, detail: String(error), at: now };
      merge(ctx.state, "factions", { plan: planDigest(decision, view, memory.bankedAugmentations) });
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
  // slot at `career:blocking-need` whenever any blocking need exists, which
  // outranks `factions:work`. Marking every far-off requirement as
  // blocking therefore made factions starve ITSELF — career held the slot
  // permanently chasing Daedalus's hacking 2500, and factions could never work
  // for the reputation it was asking for.
  const remaining = new Map<string, number>();
  for (const blocker of plan.blockers) {
    if (!blocker.reachable) continue;
    remaining.set(blocker.faction, (remaining.get(blocker.faction) ?? 0) + 1);
  }

  // The megacorp unlock chain (apply -> work -> 400k rep -> invite) is
  // SEQUENTIAL work owned by career: the rep grind is unservable until the
  // job exists, so counting both blockers kept every corporate faction at
  // "wanted" forever and career fell through to crime. For these
  // career-chain kinds the FIRST ACTIONABLE step of the objective's chain is
  // genuinely blocking — the objective is by construction the best value/sec
  // use of the slot (same rationale as the until-rep need below). Other kinds
  // keep the last-blocker rule: a far-off skill/combat gate marked blocking
  // is exactly the career-starves-factions failure documented above.
  const jobs = (ctx.state.topics.player?.jobs ?? {}) as Record<string, string>;
  const chainKinds = new Set(["employment", "companyRep", "jobTitle"]);
  const actionable = (blocker: { kind: string; subject?: string }): boolean =>
    blocker.kind === "companyRep" ? Object.hasOwn(jobs, blocker.subject ?? "") : true;
  const chainHead = new Set<(typeof plan.blockers)[number]>();
  const byFaction = new Map<string, (typeof plan.blockers)[number][]>();
  for (const blocker of plan.blockers) {
    if (!blocker.reachable || blocker.owner === "factions" || !chainKinds.has(blocker.kind)) continue;
    const chain = byFaction.get(blocker.faction) ?? [];
    chain.push(blocker);
    byFaction.set(blocker.faction, chain);
  }
  for (const chain of byFaction.values()) {
    const head = chain.find((blocker) => blocker.kind === "employment")
      ?? chain.find(actionable)
      ?? chain[0]!;
    chainHead.add(head);
  }

  // BN-second economics for ACCESS blockers (root and backdoor): the gate is
  // worth the remaining horizon minus what the faction's other unmet blockers
  // still cost — the LAST blocker of a faction is worth the whole horizon,
  // and a backdoor whose faction is still far away ranks accordingly. The
  // consumer (hacking) uses this `valueSec` to order server-access actions
  // and to decide whether an install may preempt farm RAM.
  const nodeForecast = ctx.state.topics.progression?.plan?.forecasts?.node;
  const horizonSec = (nodeForecast ? usableForecastSec(forecastAt(nodeForecast, ctx.now)) : undefined)
    ?? DEFAULT_PLANNING_HORIZON_SEC;
  const incomePerSec = plan.context?.incomePerSec ?? 0;
  const blockerSec = (blocker: Omit<PlanBlocker, "faction">): number =>
    estimateBlockerSec(blocker as Parameters<typeof estimateBlockerSec>[0], incomePerSec);
  const accessValueSec = (
    blocker: Omit<PlanBlocker, "faction"> & { kind: string },
    siblings: readonly Omit<PlanBlocker, "faction">[],
  ): number | undefined => {
    if (blocker.kind !== "root" && blocker.kind !== "backdoor") return undefined;
    const otherBlockersSec = siblings
      .filter((other) => other !== blocker && other.reachable)
      .reduce((sum, other) => sum + blockerSec(other), 0);
    const savedSec = factionGateSavedSeconds({ horizonSec, otherBlockersSec });
    // `valueSec` is "measured, or absent" — never zero (see needs.ts). A gate
    // whose siblings already outrun the horizon has no measurement to offer,
    // and posting a literal 0 would suppress `rankingValueSec`'s weight-based
    // fallback and sink the need below every unpriced one.
    return savedSec > 0 ? savedSec : undefined;
  };

  const out: Need[] = [];
  for (const blocker of plan.blockers) {
    if (!blocker.reachable) continue;
    if (blocker.owner === "factions") continue; // ours to solve
    // Non-deliverable kinds have no owner to ask.
    if (blocker.kind === "bitNode" || blocker.kind === "sourceFile" || blocker.kind === "location") continue;
    const isChainHead = chainHead.has(blocker) && actionable(blocker);
    const valueSec = accessValueSec(blocker, plan.blockers.filter((other) => other.faction === blocker.faction));
    out.push({
      by: "factions",
      kind: blocker.kind as Need["kind"],
      ...(blocker.subject !== undefined ? { subject: blocker.subject } : {}),
      target: blocker.target,
      have: blocker.have,
      // Weight rises as the blocker nears completion: finishing a nearly-done
      // requirement unblocks a whole faction, while a barely-started one is
      // speculative. The chain head carries the until-rep parity weight.
      weight: isChainHead ? 6 : 1 + blocker.progress * 4,
      ...(valueSec !== undefined ? { valueSec } : {}),
      urgency: isChainHead || (remaining.get(blocker.faction) ?? 0) <= 1 ? "blocking" : "wanted",
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
  for (const gate of Object.values(gates)) {
    if (gate.joined || gate.invited || gate.missing.length === 0) continue;
    // A multi-blocker gate posts only the FIRST ACTIONABLE step of its chain
    // (employment before the rep it enables), and only when the whole chain
    // is reachable — half a dead chain is not worth anyone's time. Weight
    // shrinks with chain length so long unlocks rank below near ones.
    if (!gate.missing.every((blocker) => blocker.reachable)) continue;
    const deliverable = gate.missing.filter(
      (blocker) =>
        blocker.owner !== "factions"
        && blocker.kind !== "bitNode" && blocker.kind !== "sourceFile" && blocker.kind !== "location",
    );
    const blocker = deliverable.find((entry) => entry.kind === "employment")
      ?? deliverable.find(actionable)
      ?? deliverable[0];
    if (!blocker) continue;
    const key = `${blocker.kind}\0${blocker.subject ?? ""}`;
    if (posted.has(key)) continue;
    posted.add(key);
    const valueSec = accessValueSec(blocker, gate.missing);
    out.push({
      by: "factions",
      kind: blocker.kind as Need["kind"],
      ...(blocker.subject !== undefined ? { subject: blocker.subject } : {}),
      target: blocker.target,
      have: blocker.have,
      weight: (1 + blocker.progress * 2) / gate.missing.length,
      ...(valueSec !== undefined ? { valueSec } : {}),
      urgency: "wanted",
    });
  }
  // Megacorp company servers: a backdoor multiplies the company's required
  // reputation by 0.75 — for the faction's companyRep invite gate AND for job
  // promotions — but the game only reveals the discounted number AFTER the
  // backdoor exists, so the requirement tree alone never asks for it. Post
  // the backdoor with the measured grinding time it saves. An unmeasured rep
  // rate uses the modest nominal fallback, which is exactly the "deprioritize
  // corps we are not actually working for" behaviour with no per-company
  // rule; once career works there and a rate is measured, the value grows on
  // its own. Objective-chain companies post at "wanted", speculative gate
  // companies at "nice" — never "blocking": the discount accelerates a grind,
  // it does not gate one.
  const serversByOrg = serversByOrganization(ctx.state);
  const measuredRepPerSec = measuredCompanyRepPerSec(ctx.state);
  const companyGates: { faction: string; company: string; target: number; have: number; urgency: Need["urgency"] }[] = [];
  for (const blocker of plan.blockers) {
    if (blocker.kind !== "companyRep" || !blocker.reachable || !blocker.subject) continue;
    companyGates.push({ faction: blocker.faction, company: blocker.subject, target: blocker.target, have: blocker.have, urgency: "wanted" });
  }
  for (const [faction, gate] of Object.entries(gates)) {
    if (gate.joined || gate.invited) continue;
    for (const blocker of gate.missing) {
      if (blocker.kind !== "companyRep" || !blocker.reachable || !blocker.subject) continue;
      companyGates.push({ faction, company: blocker.subject, target: blocker.target, have: blocker.have, urgency: "nice" });
    }
  }
  for (const gate of companyGates) {
    // The discount is per COMPANY, not per server, and Fulcrum Technologies
    // owns two of them — so one backdoored server anywhere in the organization
    // has already discounted `gate.target`, and asking for a second install
    // would buy a saving that was banked and double-count it.
    const servers = serversByOrg.get(gate.company) ?? [];
    if (servers.length === 0 || servers.some((entry) => entry.backdoorInstalled)) continue;
    const server = servers[0]!;
    const key = `backdoor\0${server.hostname}`;
    if (posted.has(key)) continue;
    const rate = measuredRepPerSec.get(gate.company);
    const savedSec = companyBackdoorSavedSeconds({
      repTarget: gate.target,
      repHave: gate.have,
      ...(rate !== undefined ? { repPerSec: rate } : {}),
    });
    if (!(savedSec > 0)) continue;
    posted.add(key);
    out.push({
      by: "factions",
      kind: "backdoor",
      subject: server.hostname,
      target: 1,
      have: 0,
      weight: 1,
      // `valueSec` is MEASURED-or-absent (needs.ts). Without an observed
      // company rep rate `savedSec` rests on the nominal 10 rep/sec constant,
      // and publishing that as a measurement let a corp we have never worked
      // for set `routeHackingSkillGoal` through hacking's `backdoorSkillGoal`
      // — the exact hijack that gate is documented to prevent. Unmeasured, the
      // need still ranks through `rankingValueSec`'s weight fallback.
      ...(rate !== undefined ? { valueSec: savedSec } : {}),
      urgency: gate.urgency,
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

/** What working `faction` would earn right now, from the reputation formulas.
 *
 * The same `chooseWorkType` the planner uses, so the claim and the decision
 * cannot disagree about what the work is worth — including the measured
 * override, which still wins at the faction we are actually working. */
function predictedWorkProduces(ctx: ClaimContext, faction: string | undefined): Record<string, number> {
  const standing = ctx.state.topics.factions?.standings?.find((entry) => entry.name === faction);
  if (faction === undefined || !standing) return { [REPUTATION_CHANNEL]: 0 };
  const work = currentWorkView(ctx.state);
  const profile: RepProfileView = {
    ...repProfile(ctx.state, ctx.caps, new Set(ctx.state.topics.factions?.ownedAugs ?? [])),
    rates: slotRates(ctx.state, ctx.board),
    // Carried so the MEASUREMENT still overrides the formula at the faction we
    // are actually working, exactly as it does in the planner. Reality beats the
    // prediction — a share bonus or a mis-read node multiplier shows up here and
    // nowhere else — and the claim must not disagree with the decision about
    // what the same work is worth.
    ...(work ? { currentWork: work } : {}),
  };
  const chosen = chooseWorkType(
    faction,
    { ...standing, offers: workOffers(ctx.state, faction) } as FactionStanding,
    profile,
    memory,
  );
  return chosen?.produces ?? { [REPUTATION_CHANNEL]: 0 };
}

/** What this feature is bidding for. */
function claims(ctx: ClaimContext): Claim[] {
  const topic = ctx.state.topics.factions;
  const plan = topic?.plan;
  const out: Claim[] = [];

  if (!plan) return out;

  const working = plan.action.type === "workForFaction" ? plan.action.faction : undefined;
  const wanted = working ?? nextWorkFaction(ctx.state);
  const routePackage =
    (plan.context?.route === "daedalus" || plan.context?.route === "gang")
    && plan.objective?.intent?.purpose === "augmentations";
  // The route-mandatory band is for the window BEFORE the transaction opens:
  // route mechanics require this install and the route-weighted package is the
  // remaining pre-reset WORK. Once progression also wants the install,
  // `stepFactions` has stopped working entirely — its two exceptions (an active
  // package in flight, the 1% opportunistic push) are both gated on
  // `routeInstallRequired !== true` — and the decision is the frozen purchase
  // drain, which needs money and RAM, not player time. Claiming the slot there,
  // at the highest band in the table, parks player time on a feature that will
  // not use it and locks career out of the karma that is the one thing an
  // install does NOT wipe.
  const routeInstallRequired = ctx.state.topics.progression?.plan?.routeInstallRequired === true;
  const installDrain = routeInstallRequired && ctx.state.topics.progression?.plan?.installWanted === true;
  const installPackage = routePackage && routeInstallRequired && !installDrain;

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
  // ENDING BY DESTROY: everything this fund can buy — augmentations, NFG,
  // donated favor — is erased with the node, while the reserved cash could be
  // speeding up the destroy (infrastructure RAM). Release every install-shaped
  // money reserve; an install-shaped ending keeps them.
  const endingByDestroy = ctx.state.topics.progression?.plan?.endingByDestroy === true;
  const endgame =
    plan.recommendInstall !== undefined || plan.drainCeiling !== undefined || plan.action.type === "purchaseAugmentation";
  const drainObligation = plan.drainCosts?.total ?? 0;
  const hasDrainObligation = drainObligation > 0;
  if (endgame && !endingByDestroy && !graft && (hasDrainObligation || (plan.nextBuy && plan.action.type !== "donate"))) {
    const probed = plan.nextBuy
      ? (topic?.offers ?? []).find((offer) => offer.name === plan.nextBuy!.name)
      : undefined;
    out.push({
      by: "factions",
      id: "aug-fund",
      resource: "money",
      amount: hasDrainObligation
        ? Math.min(drainObligation, ctx.state.topics.player?.money ?? 0)
        : Math.max(plan.nextBuy?.price ?? 0, probed?.price ?? 0),
      priority: PRIORITY["factions:aug-fund"],
      mode: "reserve",
      shape: "step",
      pricing: "hard",
      value: { state: "unknown", reason: "hard-priority atomic claim" },
    });
  }
  if (graft) {
    out.push(
      {
        by: "factions",
        id: "graft-fund",
        resource: "money",
        amount: graft.price,
        priority: PRIORITY["factions:aug-fund"],
        mode: "reserve",
        shape: "step",
        pricing: "hard",
        value: { state: "unknown", reason: "hard-priority atomic claim" },
      },
      {
        by: "factions",
        id: `graft:${graft.name}`,
        resource: "time",
        amount: 1,
        shape: "step",
        pricing: "hard",
        value: { state: "unknown", reason: "a time claim is priced by `produces`, not by this field" },
        priority: PRIORITY["factions:work"],
        mode: "spend",
      },
    );
  }
  // ANTICIPATED, not derived from the published action. `travelTo` is decided
  // at tick time from a plan this claim phase has not seen yet, and the driver
  // refuses to travel without the grant already in hand — so a fare claimed only
  // once the action is published is always one pass late, and the plan has moved
  // on by the next one. Same contract as the purchase and work RAM claims above:
  // when travel is plausible, the $200,000 is on the table.
  // The anticipation carries the planner's OWN guard with it: `decideFactions`
  // never issues travel once an install is requested, so anticipating one then
  // would hold $200,000 at the aug-fund band away from the package the drain
  // exists to buy, every pass, for a trip that will not be taken.
  const anticipatedTravel = !installDrain && soleTravelBlocker(plan.blockers ?? []) !== undefined;
  if (plan.action.type === "travelTo" || anticipatedTravel) {
    out.push({
      by: "factions",
      id: "travel-fund",
      resource: "money",
      amount: 200_000,
      priority: PRIORITY["factions:aug-fund"],
      mode: "spend",
      shape: "step",
      pricing: "hard",
      value: { state: "unknown", reason: "hard-priority atomic claim" },
    });
  }

  if (plan.action.type === "donate" && plan.action.amount && plan.action.amount > 0 && !endingByDestroy && plan.drainCosts === undefined) {
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
      shape: "step",
      pricing: "hard",
      value: { state: "unknown", reason: "hard-priority atomic claim" },
    });
  }

  // Bid for the work slot whenever there is a joined faction with reputation
  // still to earn — NOT only when the last plan already said `workForFaction`.
  //
  // Deriving the claim from the previous decision cannot bootstrap: the
  // decision needs the slot, the slot needs the claim, and the claim was
  // waiting for the decision. The feature would sit at "another feature holds
  // Player.currentWork" forever with nobody actually holding it.
  // ...and during that drain the slot is released outright, for the same reason
  // "nothing left to work toward" releases it: a feature that will not work must
  // not hold the one resource only one feature can hold.
  //
  // Everything the work would EARN, which is what the claim is priced on.
  //
  // The planner's rate is preferred when it names the faction we want, because
  // that pass had route context this one does not. When it does not — the early
  // exits for joining, travelling and "no target yet" return before a work
  // target is ever computed — the claim PREDICTS the rate rather than
  // remembering one. Reputation is exactly predictable, so there is no reason
  // to bid a memory.
  //
  // The predecessor fell back to the measured EWMA, and the passes that fallback
  // existed for are precisely the passes on which the EWMA is zero or unset: a
  // faction just joined has never been worked. `{ reputation: 0 }` prices as
  // UNPRICED and loses the slot to any crime holding cash — the exact outcome
  // the fallback was written to prevent. It also announced reputation alone,
  // dropping the combat and charisma experience field and security work pay
  // alongside it, so a posted combat gate went to crime while the reputation
  // that same second could have earned did not happen.
  const workProduces = plan.workRate !== undefined && plan.workRate.faction === wanted
    ? plan.workRate.produces
    : predictedWorkProduces(ctx, wanted);
  if (wanted && !(installDrain && working === undefined)) {
    out.push({
      by: "factions",
      // Stable per faction: re-issuing the SAME id is what holds the slot
      // across ticks, and a new faction is correctly a new claim.
      id: `work:${wanted}`,
      resource: "time",
      amount: 1,
      shape: "step",
      pricing: "hard",
      value: { state: "unknown", reason: "a time claim is priced by `produces`, not by this field" },
      // Scored on what the slot yields, like every other claimant — see
      // `shared/strategy/income.ts`. Faction work is the only source of faction
      // reputation, so whenever it wants the slot it IS the best reputation
      // option and takes the whole of what reputation is worth; it pays no
      // salary, so it announces no money at all.
      //
      // A route-MANDATORY package is the one case that is not a rate: the run
      // cannot end without this install, so the slot is taken by the lattice
      // rather than bid for.
      priority: installPackage ? PRIORITY["factions:install-work"] : PRIORITY["factions:work"],
      ...(installPackage ? {} : { produces: workProduces }),
      mode: "spend",
      ratePerSec: plan.until?.etaSec ? 1 / plan.until.etaSec : 0,
    });
  }

  return out;
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
};
