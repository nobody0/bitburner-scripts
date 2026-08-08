import type { NS, PlayerRequirement } from "@ns";
import { sfLevel } from "../../../shared/features/unlock.ts";
import { PRIORITY, type Claim } from "../../../shared/strategy/arbiter.ts";
import { augCost, defaultWeights, type AugInfo, type PriceContext } from "../../../shared/strategy/factions/augs.ts";
import { stepFactions } from "../../../shared/strategy/factions/decide.ts";
import { initFactionMemory, type FactionAction, type FactionDecision, type FactionMemory } from "../../../shared/strategy/factions/plan.ts";
import type { FactionStanding, FactionsView } from "../../../shared/strategy/factions/state.ts";
import type { RequirementView } from "../../../shared/strategy/factions/requirements.ts";
import type { Need } from "../../../shared/strategy/needs.ts";
import type { FactionPlan } from "../../../shared/telemetry/topics/factions.ts";
import { isScriptDeath } from "../errors.ts";
import { merge, type GameState } from "../state.ts";
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

let memory: FactionMemory = initFactionMemory();
/** Last executed action's outcome, for the plan digest. */
let lastResult: FactionPlan["lastResult"];

export function resetFactionsState(): void {
  memory = initFactionMemory();
  lastResult = undefined;
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
  const side = state.topics.side;
  const progression = state.topics.progression;

  const backdoored = new Set<string>();
  for (const server of Object.values(servers)) {
    if (server.backdoorInstalled) backdoored.add(server.hostname);
  }
  // Literature and message files live on home.
  const files = new Set<string>();

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
    numInfiltrations: side?.infiltrationTotal ?? 0,
  };
}

function incomeRate(value: number | [number, number] | undefined): number {
  if (value === undefined) return 0;
  return Array.isArray(value) ? (value[0] ?? 0) : value;
}

/** Assemble everything the pure strategy decides from. */
export function buildFactionsView(ctx: DriverContext, now: number): FactionsView | undefined {
  const { state, caps } = ctx;
  const player = state.topics.player;
  const topic = state.topics.factions;
  if (!player || !topic) return undefined;

  const owned = new Set(topic.ownedAugs ?? []);
  const catalog = new Map<string, AugInfo>();
  for (const offer of topic.offers ?? []) {
    const existing = catalog.get(offer.name);
    if (existing) {
      // Several factions can offer the same augmentation; merge the sources.
      if (!existing.factions.includes(offer.faction)) existing.factions.push(offer.faction);
      continue;
    }
    catalog.set(offer.name, {
      name: offer.name,
      baseCost: offer.basePrice ?? offer.price,
      baseRepRequirement: offer.repReq,
      factions: [offer.faction],
      prereqs: offer.prereqs ?? [],
      mults: offer.mults ?? {},
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
  const nodeMults = state.topics.progression?.multipliers ?? {};
  const career = state.topics.career;

  const priceContext: PriceContext = {
    queuedNonSoA: 0,
    ownedSoA: 0,
    neurofluxLevel: state.topics.progression?.ownedAugs?.["NeuroFlux Governor"] ?? 0,
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
    weights: defaultWeights(),
    favorToDonate: topic.favorToDonate ?? 150,
    moneyGranted: ctx.grants.money,
    holdsWorkSlot: ctx.grants.slot,
    ...(career?.currentWork
      ? {
          currentWork: {
            kind: career.currentWork.type === "FACTION" ? "faction" : String(career.currentWork.type).toLowerCase(),
            faction: career.currentWork.detail,
            focused: true,
          },
        }
      : {}),
    // ns.getTotalScriptIncome returns a [sinceInstall, sinceStart] tuple; the
    // first element is the rate this run, which is the one the donate-vs-work
    // crossover is about.
    incomePerSec: incomeRate(state.topics.fleet?.scriptIncome),
    horizonSec: 3600,
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
async function execute(_ns: NS, ctx: DriverContext, action: FactionAction): Promise<void> {
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
      const ok = await run(["singularity.travelToCity"], (stubNs) =>
        stubNs["singularity"]["travelToCity"](action.city as never),
      );
      if (ok === refused) return;
      record(Boolean(ok), ok ? `travelled to ${action.city}` : `could not afford travel to ${action.city}`);
      return;
    }

    case "donate": {
      const ok = await run(["singularity.donateToFaction"], (stubNs) =>
        stubNs["singularity"]["donateToFaction"](action.faction as never, action.amount),
      );
      if (ok === refused) return;
      record(Boolean(ok), ok ? `donated $${Math.round(action.amount)}` : "donation refused (favor too low?)");
      return;
    }

    case "purchaseAugmentation": {
      const ok = await run(["singularity.purchaseAugmentation"], (stubNs) =>
        stubNs["singularity"]["purchaseAugmentation"](action.faction as never, action.augmentation as never),
      );
      if (ok === refused) return;
      record(Boolean(ok), ok ? `bought ${action.augmentation}` : "purchase refused (rep or money short)");
      return;
    }

    case "graft": {
      const ok = await run(["grafting.graftAugmentation"], (stubNs) =>
        stubNs["grafting"]["graftAugmentation"](action.augmentation as never, false),
      );
      if (ok === refused) return;
      record(Boolean(ok), ok ? `grafting ${action.augmentation}` : "grafting refused");
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

// --- digest -----------------------------------------------------------------

function planDigest(decision: FactionDecision): FactionPlan {
  return {
    ...(decision.objective ? { objective: decision.objective } : {}),
    action: {
      type: decision.action.type,
      why: decision.action.why,
      ...("faction" in decision.action ? { faction: decision.action.faction } : {}),
      ...("augmentation" in decision.action ? { augmentation: decision.action.augmentation } : {}),
      ...("city" in decision.action ? { city: decision.action.city } : {}),
      ...("workType" in decision.action ? { workType: decision.action.workType } : {}),
    },
    alternatives: decision.alternatives,
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

// --- module -----------------------------------------------------------------

const driver: FeatureDriver = {
  id: "factions",
  everyMs: 30_000,
  requires: "factions",
  async tick(ctx: DriverContext) {
    const now = Date.now();
    const view = buildFactionsView(ctx, now);
    if (!view) return;

    const { decision, memory: next } = stepFactions(view, memory);
    memory = next;

    annotateOffers(ctx.state, view);
    merge(ctx.state, "factions", { plan: planDigest(decision) });

    try {
      await execute(ctx.ns, ctx, decision.action);
    } catch (error) {
      // ScriptDeath is a kill, not a feature bug — rethrow so the controller
      // can shut down cleanly rather than looping on a corpse.
      if (isScriptDeath(error)) throw error;
      lastResult = { action: decision.action.type, ok: false, detail: String(error), at: now };
      merge(ctx.state, "factions", { plan: planDigest(decision) });
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
  let best: { name: string; gap: number } | undefined;
  for (const standing of topic.standings) {
    if (!joined.has(standing.name)) continue;
    if (objective.size > 0 && !objective.has(standing.name)) continue;
    // Highest outstanding reputation requirement among its offers.
    let needed = 0;
    for (const offer of topic.offers ?? []) {
      if (offer.faction !== standing.name) continue;
      if (offer.repReq > needed) needed = offer.repReq;
    }
    const gap = needed - standing.rep;
    if (gap <= 0) continue;
    if (!best || gap < best.gap) best = { name: standing.name, gap };
  }
  return best?.name;
}

/** What this feature is bidding for. */
function claims(ctx: ClaimContext): Claim[] {
  const topic = ctx.state.topics.factions;
  const plan = topic?.plan;
  const out: Claim[] = [];

  if (!plan) return out;

  const methods = factionMethods(plan.action.type);
  if (methods.length > 0) {
    out.push(actionRamClaim(ctx, "factions", factionClaimId(plan.action.type), methods, `factions ${plan.action.type}`));
  }

  const owned = new Set(topic?.ownedAugs ?? []);
  const objectiveAug = plan.objective?.augmentations.find((name) => !owned.has(name));
  const next = (topic?.offers ?? []).find((offer) => offer.name === objectiveAug);
  if (next) {
    out.push({
      by: "factions",
      id: "aug-fund",
      resource: "money",
      amount: next?.price ?? 0,
      priority: PRIORITY["factions:aug-fund"],
      mode: "reserve",
      why: `buying ${next.name}`,
    });
  }

  // Bid for the work slot whenever there is a joined faction with reputation
  // still to earn — NOT only when the last plan already said `workForFaction`.
  //
  // Deriving the claim from the previous decision cannot bootstrap: the
  // decision needs the slot, the slot needs the claim, and the claim was
  // waiting for the decision. The feature would sit at "another feature holds
  // Player.currentWork" forever with nobody actually holding it.
  const working = plan.action.type === "workForFaction" ? plan.action.faction : undefined;
  const wanted = working ?? nextWorkFaction(ctx.state);
  if (wanted) {
    out.push({
      by: "factions",
      // Stable per faction: re-issuing the SAME id is what holds the slot
      // across ticks, and a new faction is correctly a new claim.
      id: `work:${wanted}`,
      resource: "time",
      amount: 1,
      priority: PRIORITY["factions:work"],
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
    case "donate": return ["singularity.donateToFaction"];
    case "purchaseAugmentation": return ["singularity.purchaseAugmentation"];
    case "graft": return ["grafting.graftAugmentation"];
    default: return [];
  }
}

export const factionsModule: FeatureModule = {
  driver,
  reset: resetFactionsState,
  claims,
  needs,
  peakStepGb: PEAK_STEP_GB,
};
