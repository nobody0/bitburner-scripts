import type { NS } from "@ns";
import { PRIORITY, type Claim } from "../../../shared/strategy/arbiter.ts";
import { stepBladeburner } from "../../../shared/strategy/bladeburner/decide.ts";
import { stepCorp } from "../../../shared/strategy/corp/stages.ts";
import { stepDarknet } from "../../../shared/strategy/dnet/decide.ts";
import { stepGang } from "../../../shared/strategy/gang/decide.ts";
import { bestOpponent, stepGo } from "../../../shared/strategy/go/decide.ts";
import type { Need } from "../../../shared/strategy/needs.ts";
import { stepProgression } from "../../../shared/strategy/progression/decide.ts";
import { RED_PILL, stepEndgame, type EndgameView, type RouteId } from "../../../shared/strategy/progression/endgame.ts";
import {
  chooseRoute,
  noRates,
  routeEtas,
  type RouteChoice,
  type RouteRates,
} from "../../../shared/strategy/progression/eta.ts";
import type { RouteEtaDigest } from "../../../shared/telemetry/topics/progression.ts";
import { canSolve, rankInfiltrations, solve } from "../../../shared/strategy/side/contracts.ts";
import { chargeOrder, packFragments } from "../../../shared/strategy/stanek/pack.ts";
import { stepSleeves } from "../../../shared/strategy/sleeves/decide.ts";
import { isScriptDeath } from "../errors.ts";
import { merge } from "../state.ts";
import { actionRamClaim, featureDodge } from "./dodge.ts";
import type { ClaimContext, DriverContext, FeatureDriver, FeatureModule, NeedContext } from "./index.ts";

/** Drivers for the features whose game-side work is a thin execution layer
 * over a pure strategy that lives in shared/strategy/.
 *
 * They share a file because they share a SHAPE, not because they are small:
 * build a view from the store, call one pure `step*`, execute at most one
 * action per tick inside one dodge, and write the decision digest back. Any
 * one of them can move to its own file the moment it needs more than that —
 * `factions`, `career`, `hacknet` and `stock` already have. */

/** Every driver here reports its own peak dodge step so the home reserve can
 * cover it (shared/ram/reserve.ts). */
const STEP_GB = { gang: 6, corp: 24, bladeburner: 10, sleeves: 12, go: 4, stanek: 6, dnet: 8, side: 16, progression: 8 };

type Result = { action: string; ok: boolean; detail: string; at: number } | undefined;
const results: Record<string, Result> = {};

function record(id: string, action: string, ok: boolean, detail: string): void {
  results[id] = { action, ok, detail, at: Date.now() };
}

/** One dodged call, placed on the fleet, with its outcome recorded. A `false`
 * return is an OUTCOME, never an exception. */
async function act<T>(
  ctx: DriverContext,
  id: string,
  action: string,
  /** The ns functions the closure will call. PRICED, never guessed — a
   *  constant budget below the sum of the call costs kills the stub with a RAM
   *  USAGE ERROR (see dodge.ts#priceCalls). */
  methods: readonly string[],
  body: (stubNs: NS) => T | Promise<T>,
  describe: (value: T) => { ok: boolean; detail: string },
): Promise<void> {
  try {
    const outcome = await featureDodge(ctx, id as Claim["by"], actionClaimId(action), methods, body);
    if (!outcome.ok) {
      record(id, action, false, outcome.reason);
      return;
    }
    const value = outcome.value;
    const { ok, detail } = describe(value);
    record(id, action, ok, detail);
  } catch (error) {
    if (isScriptDeath(error)) throw error;
    record(id, action, false, String(error));
  }
}

function actionClaimId(action: string): string { return `action:${action}`; }

function maybeActionClaim(
  by: Claim["by"],
  ctx: ClaimContext,
  action: string | undefined,
  methods: readonly string[],
): Claim[] {
  if (!action || methods.length === 0) return [];
  return [actionRamClaim(ctx, by, actionClaimId(action), methods, `${by} ${action}`)];
}

// --- gang -------------------------------------------------------------------

const gang: FeatureDriver = {
  id: "gang",
  everyMs: 10_000,
  requires: "gang",
  async tick(ctx: DriverContext) {
    const topic = ctx.state.topics.gang;
    if (!topic) return;

    const members = (topic.members ?? []).map((member) => ({
      name: member.name,
      task: member.task,
      skills: member.skills,
      ascMults: member.ascMults,
      earnedRespect: member.earnedRespect,
      upgrades: member.upgrades,
    }));
    // Task rates come from the game per member; without them the strategy
    // would be scoring invented numbers.
    const taskOptions = (member: (typeof members)[number]) =>
      (topic.taskRates?.[member.name] ?? []).map((rate) => ({
        name: rate.name,
        respectGain: rate.respect,
        moneyGain: rate.money,
        wantedGain: rate.wanted,
        training: rate.name.startsWith("Train"),
      }));

    const decision = stepGang({
      faction: topic.faction,
      isHacking: topic.isHacking,
      respect: topic.respect,
      wantedLevel: topic.wantedLevel,
      wantedPenalty: topic.wantedPenalty,
      territory: topic.territory,
      territoryClashChance: topic.territoryClashChance,
      territoryWarfareEngaged: topic.territoryWarfareEngaged,
      members,
      taskOptions,
      ascensionGain: (member) => topic.ascensionGain?.[member.name] ?? 0,
      respectForNextRecruit: topic.respectForNextRecruit,
      canRecruit: topic.canRecruit,
      clashChances: topic.clashChances ?? {},
      weights: { respect: 1, money: 1e-6 },
    });

    merge(ctx.state, "gang", {
      plan: {
        actions: decision.actions.map((action) => ({ type: action.type, why: action.why })),
        why: decision.why,
        ...(decision.wantedWarning ? { warning: decision.wantedWarning } : {}),
        ...(results["gang"] ? { lastResult: results["gang"] } : {}),
      },
    });

    const next = decision.actions.find((action) => action.type !== "idle");
    if (!next) return;
    await act(
      ctx,
      "gang",
      next.type,
      gangMethods(next.type),
      (stubNs: NS) => {
        switch (next.type) {
          case "recruit":
            return stubNs["gang"]["recruitMember"](`m-${Date.now() % 100000}`);
          case "assign":
            return stubNs["gang"]["setMemberTask"](next.member, next.task);
          case "ascend":
            return stubNs["gang"]["ascendMember"](next.member) !== undefined;
          case "warfare":
            stubNs["gang"]["setTerritoryWarfare"](next.engage);
            return true;
          default:
            return false;
        }
      },
      (value) => ({ ok: Boolean(value), detail: Boolean(value) ? `${next.type} ok` : `${next.type} refused` }),
    );
  },
};

// --- corp -------------------------------------------------------------------

const corp: FeatureDriver = {
  id: "corp",
  everyMs: 30_000,
  requires: "corp",
  async tick(ctx: DriverContext) {
    const topic = ctx.state.topics.corp;
    if (!topic) return;
    const decision = stepCorp({
      hasCorporation: true,
      funds: topic.funds,
      revenue: topic.revenue,
      expenses: topic.expenses,
      public: topic.public,
      divisions: (topic.divisions ?? []).map((entry) => ({
        name: entry.name,
        industry: entry.industry,
        cities: entry.cities,
        researchPoints: entry.researchPoints,
        products: entry.products,
        maxProducts: entry.maxProducts,
        offices: entry.offices ?? [],
        warehouses: entry.warehouses ?? [],
      })),
      ...(topic.investmentOffer ? { investmentOffer: topic.investmentOffer } : {}),
      moneyGranted: ctx.grants.money,
    });

    merge(ctx.state, "corp", {
      plan: {
        action: { type: decision.action.type, why: decision.action.why },
        stage: decision.stage,
        completed: decision.completed,
        why: decision.why,
        ...(results["corp"] ? { lastResult: results["corp"] } : {}),
      },
    });
    // Execution of the corporation API is deliberately not wired yet: every
    // stage's action is a distinct multi-argument call, and issuing them
    // against an unmodelled world would be the one thing this project refuses
    // to do. The stage machine and its digest are testable without it.
    record("corp", decision.action.type, false, "corporation actions are not executed yet (see spec/progress.md)");
  },
};

// --- bladeburner ------------------------------------------------------------

const bladeburner: FeatureDriver = {
  id: "bladeburner",
  everyMs: 5_000,
  requires: "bladeburner",
  async tick(ctx: DriverContext) {
    const topic = ctx.state.topics.bladeburner;
    if (!topic) return;
    const decision = stepBladeburner({
      rank: topic.rank,
      skillPoints: topic.skillPoints,
      stamina: topic.stamina,
      city: topic.city,
      chaos: topic.cities?.find((city) => city.name === topic.city)?.chaos ?? 0,
      actions: (topic.actions ?? []).map((action) => ({
        type: action.type as "general" | "contract" | "operation" | "blackop",
        name: action.name,
        chance: action.chance,
        timeMs: action.timeMs,
        countRemaining: action.countRemaining ?? Infinity,
        level: action.level ?? 1,
        // The probe reports rank gain when it has it; 1 is the conservative
        // floor, never a fabricated estimate.
        rankGain: action.rankGain ?? 1,
        ...(action.rankNeeded !== undefined ? { rankNeeded: action.rankNeeded } : {}),
      })),
      skills: topic.skills ?? {},
      ...(topic.current ? { current: { type: topic.current.type, name: topic.current.name } } : {}),
    });

    merge(ctx.state, "bladeburner", {
      plan: {
        action: decision.action,
        ranked: decision.ranked.slice(0, 8),
        why: decision.why,
        ...(results["bladeburner"] ? { lastResult: results["bladeburner"] } : {}),
      },
    });

    if (decision.action.type === "rest") return;
    await act(
      ctx,
      "bladeburner",
      decision.action.type,
      bladeMethods(decision.action.type),
      (stubNs: NS) => {
        const action = decision.action;
        if (action.type === "upgrade") return stubNs["bladeburner"]["upgradeSkill"](action.skill as never, 1);
        if (action.type === "act") {
          return stubNs["bladeburner"]["startAction"](action.actionType as never, action.name as never);
        }
        return false;
      },
      (value) => ({ ok: Boolean(value), detail: Boolean(value) ? "started" : "refused" }),
    );
  },
};

// --- sleeves ----------------------------------------------------------------

const sleeves: FeatureDriver = {
  id: "sleeves",
  everyMs: 30_000,
  requires: "sleeves",
  async tick(ctx: DriverContext) {
    const topic = ctx.state.topics.sleeves;
    if (!topic) return;
    const decision = stepSleeves(
      {
        sleeves: (topic.sleeves ?? []).map((sleeve) => ({
          index: sleeve.index,
          shock: sleeve.shock,
          sync: sleeve.sync,
          city: sleeve.city,
          skills: sleeve.skills as unknown as Record<string, number>,
          ...(sleeve.task ? { task: { type: sleeve.task.type, detail: sleeve.task.detail } } : {}),
        })),
        tasks: topic.taskOptions ?? [],
        shockCeiling: 50,
        syncFloor: 50,
      },
      ctx.board,
    );

    merge(ctx.state, "sleeves", {
      plan: {
        assignments: decision.assignments.map((entry) => ({
          index: entry.index,
          task: `${entry.task.type}${entry.task.detail ? `:${entry.task.detail}` : ""}`,
          why: entry.why,
        })),
        why: decision.why,
        ...(results["sleeves"] ? { lastResult: results["sleeves"] } : {}),
      },
    });

    const next = decision.assignments[0];
    if (!next) return;
    await act(
      ctx,
      "sleeves",
      next.task.type,
      sleeveMethods(next.task.type),
      (stubNs: NS) => {
        switch (next.task.type) {
          case "recovery":
            return stubNs["sleeve"]["setToShockRecovery"](next.index);
          case "synchro":
            return stubNs["sleeve"]["setToSynchronize"](next.index);
          case "crime":
            return stubNs["sleeve"]["setToCommitCrime"](next.index, next.task.detail as never);
          case "gym":
            return stubNs["sleeve"]["setToGymWorkout"](next.index, "Powerhouse Gym" as never, next.task.detail as never);
          case "class":
            return stubNs["sleeve"]["setToUniversityCourse"](next.index, "Rothman University" as never, next.task.detail as never);
          case "faction":
            return stubNs["sleeve"]["setToFactionWork"](next.index, next.task.detail as never, "hacking" as never);
          default:
            return false;
        }
      },
      (value) => ({ ok: Boolean(value), detail: Boolean(value) ? `sleeve ${next.index} -> ${next.task.type}` : "refused" }),
    );
  },
};

// --- go ---------------------------------------------------------------------

const go: FeatureDriver = {
  id: "go",
  everyMs: 10_000,
  requires: "go",
  async tick(ctx: DriverContext) {
    const topic = ctx.state.topics.go;
    if (!topic?.board) return;
    const view = {
      board: { rows: topic.board, size: topic.boardSize ?? topic.board.length },
      currentPlayer: topic.currentPlayer ?? "Black",
      opponent: topic.opponent ?? "Netburners",
      opponentValue: Object.fromEntries((topic.stats ?? []).map((entry) => [entry.opponent, entry.bonusPercent])),
      maxDepth: 3,
    };
    const decision = stepGo(view);

    merge(ctx.state, "go", {
      plan: {
        action: decision.action,
        ranked: decision.ranked,
        why: decision.why,
        preferredOpponent: bestOpponent(view),
        ...(results["go"] ? { lastResult: results["go"] } : {}),
      },
    });

    await act(
      ctx,
      "go",
      decision.action.type,
      goMethods(decision.action.type),
      async (stubNs: NS) =>
        decision.action.type === "move"
          ? await stubNs["go"]["makeMove"](decision.action.x, decision.action.y)
          : await stubNs["go"]["passTurn"](),
      (value) => ({ ok: Boolean(value), detail: decision.action.type }),
    );
  },
};

// --- stanek -----------------------------------------------------------------

const stanek: FeatureDriver = {
  id: "stanek",
  everyMs: 30_000,
  requires: "stanek",
  async tick(ctx: DriverContext) {
    const topic = ctx.state.topics.stanek;
    if (!topic) return;

    const fragments = (topic.availableTypes ?? []).map((entry) => ({
      id: entry.id,
      // Shape comes from the probe when it has it; a single cell is the
      // conservative fallback and is marked as such in the plan digest.
      shape: (entry as { shape?: { x: number; y: number }[] }).shape ?? [{ x: 0, y: 0 }],
      power: entry.power,
      // Charging value comes from the board: a run that needs hacking charges
      // the hacking fragment.
      weight: entry.power,
    }));

    const packed = packFragments(fragments, topic.width, topic.height);
    const order = chargeOrder(fragments, packed.placements);

    merge(ctx.state, "stanek", {
      plan: {
        placements: packed.placements,
        value: packed.value,
        approximated: packed.approximated,
        chargeOrder: order,
        why: packed.approximated
          ? "packing search was capped — this may not be optimal"
          : `exhaustive packing over ${fragments.length} fragments in ${topic.width}x${topic.height} (provably optimal)`,
        ...(results["stanek"] ? { lastResult: results["stanek"] } : {}),
      },
    });

    // Charge the highest-value placed fragment.
    const first = order[0];
    if (first === undefined) return;
    const placement = packed.placements.find((entry) => entry.id === first);
    if (!placement) return;
    await act(
      ctx,
      "stanek",
      "charge",
      ["stanek.chargeFragment"],
      async (stubNs: NS) => await stubNs["stanek"]["chargeFragment"](placement.x, placement.y),
      () => ({ ok: true, detail: `charged fragment ${first}` }),
    );
  },
};

// --- dnet -------------------------------------------------------------------

const dnet: FeatureDriver = {
  id: "dnet",
  everyMs: 30_000,
  requires: "dnet",
  async tick(ctx: DriverContext) {
    const topic = ctx.state.topics.dnet;
    if (!topic) return;
    const decision = stepDarknet({
      servers: (topic.servers ?? []).map((server) => ({
        hostname: server.hostname,
        depth: server.depth,
        blockedRam: server.blockedRam,
        isOnline: server.isOnline ?? true,
        requiredCharisma: server.requiredCharisma ?? 0,
        stasisLinked: server.stasisLinked ?? false,
        ...((server as { neighbours?: string[] }).neighbours
          ? { neighbours: (server as { neighbours?: string[] }).neighbours! }
          : {}),
      })),
      reachable: topic.reachable,
      maxDepth: topic.maxDepth,
      stasisLinkLimit: topic.stasisLinkLimit,
      stasisLinked: topic.stasisLinked ?? [],
      instability: topic.instability,
      charisma: ctx.state.topics.player?.skills.charisma ?? 1,
      instabilityCeiling: 0.5,
    });

    merge(ctx.state, "dnet", {
      plan: {
        action: decision.action,
        ranked: decision.ranked.slice(0, 8),
        why: decision.why,
        ...(decision.charismaNeeded !== undefined ? { charismaNeeded: decision.charismaNeeded } : {}),
        ...(results["dnet"] ? { lastResult: results["dnet"] } : {}),
      },
    });

    if (decision.action.type === "idle") return;
    await act(
      ctx,
      "dnet",
      decision.action.type,
      dnetMethods(decision.action.type),
      async (stubNs: NS) => {
        const action = decision.action;
        if (action.type === "idle") return false;
        // `setStasisLink` is a TOGGLE on the CURRENTLY CONNECTED server, not a
        // per-host call — so a link or release has to connect first. Getting
        // this backwards would silently stasis the wrong server.
        stubNs["singularity"]["connect"](action.hostname as never);
        switch (action.type) {
          case "authenticate":
            // `authenticate(host, password)` needs a PASSWORD, which the
            // darknet hides behind its own discovery mechanic (server models,
            // hints, brute force). That is not modelled, so this refuses
            // rather than calling with an invented credential — a wrong
            // password costs a timeout and raises instability.
            return "password discovery is not implemented";
          case "stasis":
            return await stubNs["dnet"]["setStasisLink"](true);
          case "releaseStasis":
            return await stubNs["dnet"]["setStasisLink"](false);
        }
      },
      (value) => ({ ok: Boolean(value), detail: String(value) }),
    );
  },
};

/** Darknet needs charisma, which career owns. */
function dnetNeeds(ctx: NeedContext): Need[] {
  const needed = ctx.state.topics.dnet?.plan?.charismaNeeded;
  if (needed === undefined) return [];
  return [
    {
      by: "dnet",
      kind: "charisma",
      target: needed,
      have: ctx.state.topics.player?.skills.charisma ?? 1,
      weight: 3,
      urgency: "blocking",
      why: "darknet authentication is gated on charisma",
    },
  ];
}

// --- side -------------------------------------------------------------------

const side: FeatureDriver = {
  id: "side",
  everyMs: 60_000,
  async tick(ctx: DriverContext) {
    const topic = ctx.state.topics.side;
    if (!topic) return;

    // The probe has already partitioned the network: `contracts` is a capped,
    // most-at-risk-first window onto the SOLVABLE ones, and the rest arrive
    // pre-counted per type. Re-filtering with canSolve is defensive — a legacy
    // record predating the split carries both kinds in one list.
    const solvable = (topic.contracts ?? []).filter((contract) => canSolve(contract.type));
    const unsolvable = Object.entries(topic.unsolvableByType ?? {})
      .map(([type, count]) => ({ type, count }))
      .sort((a, b) => b.count - a.count || a.type.localeCompare(b.type));
    const solvableTotal = topic.solvableTotal ?? solvable.length;
    const unsolvableTotal = topic.unsolvableTotal ?? 0;
    const infiltration = rankInfiltrations(topic.infiltration ?? []);

    merge(ctx.state, "side", {
      plan: {
        solvable: solvable.map((contract) => ({ host: contract.host, file: contract.file, type: contract.type })),
        solvableTotal,
        // Named explicitly: an unsolved contract expires, and a type we cannot
        // solve is a gap in the registry, not a mystery. One row per TYPE —
        // the fix is a solver, and listing every file that needs it is noise.
        unsolvable,
        unsolvableTotal,
        infiltration: infiltration.slice(0, 8).map((target) => ({
          location: target.location,
          city: target.city,
          valuePerMinute: target.valuePerMinute,
        })),
        // The casino belongs to this feature conceptually but is DOM-driven
        // with no ns API at all, so it is reported as a permanent blocker
        // rather than silently omitted.
        casino: "no ns API — the casino is DOM-driven and cannot be automated",
        why: `${solvableTotal} solvable, ${unsolvableTotal} without a solver (${unsolvable.length} types), ${infiltration.length} infiltration targets`,
        ...(results["side"] ? { lastResult: results["side"] } : {}),
      },
    });

    const next = solvable[0];
    if (!next) return;
    await act(
      ctx,
      "side",
      "contract",
      ["codingcontract.getData", "codingcontract.attempt"],
      (stubNs: NS) => {
        const data = stubNs["codingcontract"]["getData"](next.file, next.host);
        const answer = solve(next.type, data);
        // Never submit a guess: a wrong answer burns one of three tries and
        // the third destroys the contract.
        if (answer === undefined) return "no solver";
        return stubNs["codingcontract"]["attempt"](answer as never, next.file, next.host);
      },
      (value) => ({ ok: typeof value === "string" && value !== "no solver" && value !== "", detail: String(value) }),
    );
  },
};

// --- progression ------------------------------------------------------------

/** Observed rate over a sliding window of samples. The window (30 min, 30 s
 * granularity) is long enough to smooth probe cadence and short enough that a
 * mid-run regime change (new augs, new fleet) shows up within the dwell the
 * route choice already applies. A NEGATIVE delta means the series was reset
 * under us (an install dropped money to zero, a node reset dropped a skill) —
 * the window restarts rather than reporting a nonsense negative rate. */
class RateTracker {
  private samples: { t: number; v: number }[] = [];

  sample(t: number, v: number): void {
    const last = this.samples[this.samples.length - 1];
    if (last && t - last.t < 30_000) return;
    if (last && v < last.v) this.samples.length = 0;
    this.samples.push({ t, v });
    while (this.samples.length > 0 && t - this.samples[0]!.t > 1_800_000) this.samples.shift();
  }

  /** Per-second rate, or 0 while there is no signal (selects the fallback). */
  perSec(): number {
    const first = this.samples[0];
    const last = this.samples[this.samples.length - 1];
    if (!first || !last || last.t <= first.t) return 0;
    return ((last.v - first.v) / (last.t - first.t)) * 1000;
  }

  clear(): void {
    this.samples.length = 0;
  }
}

interface ProgressionMemory {
  trackers: {
    moneyEarned: RateTracker;
    hacking: RateTracker;
    combat: RateTracker;
    augs: RateTracker;
    daedalusRep: RateTracker;
    blackOps: RateTracker;
    rank: RateTracker;
  };
  choice?: RouteChoice;
}

function freshProgressionMemory(): ProgressionMemory {
  return {
    trackers: {
      moneyEarned: new RateTracker(),
      hacking: new RateTracker(),
      combat: new RateTracker(),
      augs: new RateTracker(),
      daedalusRep: new RateTracker(),
      blackOps: new RateTracker(),
      rank: new RateTracker(),
    },
  };
}

let progressionMemory = freshProgressionMemory();

/** Route change since the controller last asked, for the `endgame.route`
 * telemetry event — the takeTargetSwitch pattern: recorded here, emitted by
 * the controller, which is the only module that touches Telemetry. */
let routeChange:
  | { from?: RouteId; to: RouteId; etaSec: number; expectedEndAt: number; why: string; routes: RouteEtaDigest[] }
  | undefined;

export function takeRouteChange(): typeof routeChange {
  const value = routeChange;
  routeChange = undefined;
  return value;
}

/** Assemble the endgame view from the store. Every field is already acquired
 * by an existing probe; this composes, it never calls ns.
 *
 * Two aug sets with different meanings: `factions.ownedAugs` is owned
 * INCLUDING queued (getOwnedAugmentations(true)); `progression.ownedAugs` is
 * installed only (ResetInfo). Owning the pill and having installed it are
 * exactly that distinction, and Daedalus's aug count checks installed. */
function endgameView(ctx: NeedContext): EndgameView | undefined {
  const player = ctx.state.topics.player;
  if (!player) return undefined;
  const prog = ctx.state.topics.progression;
  const factions = ctx.state.topics.factions;
  const blade = ctx.state.topics.bladeburner;

  const installed = prog?.ownedAugs ?? {};
  const ownedAll = factions?.ownedAugs ?? Object.keys(installed);
  const blackOps = (blade?.actions ?? []).filter((action) => action.type === "blackop");
  const skills = player.skills;

  return {
    bitNode: ctx.caps.bitNode,
    sourceFiles: ctx.caps.sourceFiles ?? {},
    augCount: prog?.augCount ?? Object.keys(installed).length,
    ownsRedPill: ownedAll.includes(RED_PILL),
    redPillInstalled: RED_PILL in installed,
    money: player.money,
    hackingSkill: skills.hacking,
    lowestCombatSkill: Math.min(skills.strength, skills.defense, skills.dexterity, skills.agility),
    daedalusRep: factions?.standings?.find((standing) => standing.name === "Daedalus")?.rep ?? 0,
    inBladeburner: ctx.caps.unlocked.bladeburner === "yes",
    blackOpsComplete: blackOps.filter((action) => (action.countRemaining ?? 1) <= 0).length,
    ...(blade?.rank !== undefined ? { bladeburnerRank: blade.rank } : {}),
  };
}

function sampledRates(ctx: NeedContext, view: EndgameView): RouteRates {
  const t = ctx.now;
  const trackers = progressionMemory.trackers;
  const earned = ctx.state.topics.progression?.moneySources?.sinceInstall?.total;
  if (earned !== undefined) trackers.moneyEarned.sample(t, earned);
  trackers.hacking.sample(t, view.hackingSkill);
  trackers.combat.sample(t, view.lowestCombatSkill);
  trackers.augs.sample(t, view.augCount);
  trackers.daedalusRep.sample(t, view.daedalusRep);
  trackers.blackOps.sample(t, view.blackOpsComplete);
  if (view.bladeburnerRank !== undefined) trackers.rank.sample(t, view.bladeburnerRank);
  return {
    ...noRates(),
    moneyPerSec: trackers.moneyEarned.perSec(),
    hackingSkillPerSec: trackers.hacking.perSec(),
    combatSkillPerSec: trackers.combat.perSec(),
    augsPerSec: trackers.augs.perSec(),
    daedalusRepPerSec: trackers.daedalusRep.perSec(),
    blackOpsPerSec: trackers.blackOps.perSec(),
    bladeburnerRankPerSec: trackers.rank.perSec(),
  };
}

/** Value product of the augmentations affordable right now: the product over
 * each one's multiplier product. Multipliers MULTIPLY, which is why this is a
 * product of products rather than any sum. An offer with no reported mults
 * (NeuroFlux, the odd unstable aug) counts a token 1.01 — present, near-
 * worthless, never zeroing the whole product. */
function affordableValueProduct(ctx: NeedContext): number {
  const topic = ctx.state.topics.factions;
  const offers = topic?.offers ?? [];
  const money = ctx.state.topics.player?.money ?? 0;
  // Multipliers live once per AUGMENTATION, not once per (faction,
  // augmentation) offer — carrying them on every pair duplicated each table up
  // to four times and dominated this topic's wire size.
  const meta = topic?.augMeta ?? {};
  let product = 1;
  for (const offer of offers) {
    if (offer.owned || !offer.affordableRep || offer.price > money) continue;
    const mults = Object.values(meta[offer.name]?.mults ?? {});
    product *= mults.length > 0 ? mults.reduce((a, b) => a * b, 1) : 1.01;
  }
  return product;
}

/** The previous route decision, surviving a build handoff: module state dies
 * with the old bundle, but the published plan lives in the realm store. */
function previousChoice(ctx: NeedContext): RouteChoice | undefined {
  if (progressionMemory.choice) return progressionMemory.choice;
  const plan = ctx.state.topics.progression?.plan;
  if (!plan?.route || plan.decidedAt === undefined) return undefined;
  return {
    route: plan.route,
    etaSec: plan.expectedEndAt !== undefined ? Math.max(0, (plan.expectedEndAt - ctx.now) / 1000) : 0,
    decidedAt: plan.decidedAt,
    why: plan.routeWhy ?? "",
  };
}

/** The refresh half: decide how this BitNode ends and when, from the enriched
 * store, and publish it for every feature to read this same pass. Runs before
 * any needs/claims/tick — see FeatureModule.refresh. */
function progressionRefresh(ctx: NeedContext): void {
  const player = ctx.state.topics.player;
  if (!player) return;
  const factions = ctx.state.topics.factions;
  const prog = ctx.state.topics.progression;

  // --- route: how does the run END, and how long is each way expected to take
  const view = endgameView(ctx)!;
  const endgame = stepEndgame(view);
  const rates = sampledRates(ctx, view);
  const etas = routeEtas(view, endgame, rates);
  const previous = previousChoice(ctx);
  const { choice, switched } = chooseRoute(previous, etas, ctx.now);
  progressionMemory.choice = choice;

  const blockerOf = new Map(endgame.routes.map((route) => [route.id, route.blocker]));
  const routesDigest: RouteEtaDigest[] = etas.map((eta) => ({
    id: eta.id,
    available: eta.available,
    complete: eta.complete,
    blocker: blockerOf.get(eta.id) ?? "",
    etaSec: Math.round(eta.etaSec),
    parts: eta.parts.map((entry) => ({ what: entry.what, sec: Math.round(entry.sec), measured: entry.measured })),
  }));

  const expectedEndAt = choice ? ctx.now + choice.etaSec * 1000 : undefined;
  if (switched && choice) {
    routeChange = {
      ...(previous ? { from: previous.route } : {}),
      to: choice.route,
      etaSec: Math.round(choice.etaSec),
      expectedEndAt: expectedEndAt!,
      why: choice.why,
      routes: routesDigest,
    };
  }

  // --- install cadence, on real inputs rather than the stubbed constants the
  // first cut shipped with (affordableValueProduct 1, runSec 0).
  const installed = prog?.ownedAugs ?? {};
  const pending = (factions?.ownedAugs ?? []).filter((name) => !(name in installed));
  const standings = Object.fromEntries(
    (factions?.standings ?? []).map((standing) => [standing.name, { rep: standing.rep, favor: standing.favor }]),
  );
  const decision = stepProgression({
    queued: pending,
    affordableValueProduct: affordableValueProduct(ctx),
    factionWorkInProgress: ctx.state.topics.career?.currentWork?.type === "FACTION",
    money: player.money,
    earnedThisRun: prog?.moneySources?.sinceInstall?.total ?? ctx.state.topics.farm?.totals?.moneyEarned ?? 0,
    factions: standings,
    favorToDonate: factions?.favorToDonate ?? 150,
    homeRam: ctx.state.topics.servers?.["home"]?.maxRam ?? 8,
    // No probe prices the home upgrade yet; Infinity keeps the budget advisory.
    homeRamUpgradeCost: Infinity,
    runSec: prog?.lastAugReset ? Math.max(0, (ctx.now - prog.lastAugReset) / 1000) : 0,
  });

  merge(ctx.state, "progression", {
    plan: {
      phase: decision.phase,
      install: decision.install,
      homeRamBudgetFraction: decision.homeRamBudgetFraction,
      favorCrossings: decision.favorCrossings,
      why: decision.why,
      ...(choice
        ? {
            route: choice.route,
            expectedEndAt: expectedEndAt!,
            decidedAt: choice.decidedAt,
            routeWhy: choice.why,
          }
        : {}),
      routes: routesDigest,
    },
  });
}

const progression: FeatureDriver = {
  id: "progression",
  everyMs: 60_000,
  tick(_ctx: DriverContext) {
    // The act half is deliberately empty for now. The decisions this feature
    // owns — install the queued augmentations, destroy the world daemon — end
    // the run, kill every process and are irreversible; wiring them needs the
    // prestige path proven end to end first. The refresh half publishes the
    // recommendation; nothing acts on it yet.
  },
};

// --- modules ----------------------------------------------------------------

const reset = (): void => {
  for (const key of Object.keys(results)) delete results[key];
};

export const gangModule: FeatureModule = {
  driver: gang,
  reset,
  claims: (ctx) => {
    const action = ctx.state.topics.gang?.plan?.actions.find((entry) => entry.type !== "idle")?.type;
    return maybeActionClaim("gang", ctx, action, gangMethods(action));
  },
  peakStepGb: STEP_GB.gang,
};

export const corpModule: FeatureModule = {
  driver: corp,
  reset,
  claims: (_ctx) => [
    // The single largest money claim in the roster: $150b in BN3.
    {
      by: "corp",
      id: "seed",
      resource: "money",
      amount: 150e9,
      priority: PRIORITY["corp:seed"],
      mode: "reserve",
      why: "founding a corporation costs $150b",
    },
  ],
  peakStepGb: STEP_GB.corp,
};

export const bladeburnerModule: FeatureModule = {
  driver: bladeburner,
  reset,
  claims: (ctx) => {
    const action = ctx.state.topics.bladeburner?.plan?.action.type;
    return maybeActionClaim("bladeburner", ctx, action, bladeMethods(action));
  },
  needs: (ctx) => {
    // Bladeburner needs 100 in every combat stat to join at all, which career
    // owns. Posted as an outcome, never as "go to the gym".
    const skills = ctx.state.topics.player?.skills;
    if (!skills) return [];
    const weakest = Math.min(skills.strength, skills.defense, skills.dexterity, skills.agility);
    if (weakest >= 100) return [];
    return [
      {
        by: "bladeburner",
        kind: "combatSkills",
        target: 100,
        have: weakest,
        weight: 4,
        urgency: "blocking",
        why: "the Bladeburner division requires 100 in every combat stat",
      },
    ];
  },
  peakStepGb: STEP_GB.bladeburner,
};

export const sleevesModule: FeatureModule = {
  driver: sleeves,
  reset,
  claims: (ctx) => {
    const action = ctx.state.topics.sleeves?.plan?.assignments[0]?.task.split(":", 1)[0];
    return maybeActionClaim("sleeves", ctx, action, sleeveMethods(action));
  },
  peakStepGb: STEP_GB.sleeves,
};

export const goModule: FeatureModule = {
  driver: go,
  reset,
  claims: (ctx) => {
    const action = ctx.state.topics.go?.plan?.action.type;
    return maybeActionClaim("go", ctx, action, goMethods(action));
  },
  peakStepGb: STEP_GB.go,
};

export const stanekModule: FeatureModule = {
  driver: stanek,
  reset,
  claims: (ctx) => maybeActionClaim(
    "stanek",
    ctx,
    ctx.state.topics.stanek?.plan?.chargeOrder?.length ? "charge" : undefined,
    ["stanek.chargeFragment"],
  ),
  peakStepGb: STEP_GB.stanek,
};

export const dnetModule: FeatureModule = {
  driver: dnet,
  reset,
  claims: (ctx) => {
    const action = ctx.state.topics.dnet?.plan?.action.type;
    return maybeActionClaim("dnet", ctx, action === "idle" ? undefined : action, dnetMethods(action));
  },
  needs: dnetNeeds,
  peakStepGb: STEP_GB.dnet,
};

export const sideModule: FeatureModule = {
  driver: side,
  reset,
  claims: (ctx) => maybeActionClaim(
    "side",
    ctx,
    ctx.state.topics.side?.plan?.solvable?.length ? "contract" : undefined,
    ["codingcontract.getData", "codingcontract.attempt"],
  ),
  peakStepGb: STEP_GB.side,
};

function gangMethods(action: string | undefined): readonly string[] {
  switch (action) {
    case "recruit": return ["gang.recruitMember"];
    case "assign": return ["gang.setMemberTask"];
    case "ascend": return ["gang.ascendMember"];
    case "warfare": return ["gang.setTerritoryWarfare"];
    default: return [];
  }
}

function bladeMethods(action: string | undefined): readonly string[] {
  if (action === "upgrade") return ["bladeburner.upgradeSkill"];
  if (action === "act") return ["bladeburner.startAction"];
  return [];
}

function sleeveMethods(action: string | undefined): readonly string[] {
  switch (action) {
    case "recovery": return ["sleeve.setToShockRecovery"];
    case "synchro": return ["sleeve.setToSynchronize"];
    case "crime": return ["sleeve.setToCommitCrime"];
    case "gym": return ["sleeve.setToGymWorkout"];
    case "class": return ["sleeve.setToUniversityCourse"];
    case "faction": return ["sleeve.setToFactionWork"];
    default: return [];
  }
}

function goMethods(action: string | undefined): readonly string[] {
  if (action === "move") return ["go.makeMove"];
  if (action === "pass") return ["go.passTurn"];
  return [];
}

function dnetMethods(action: string | undefined): readonly string[] {
  if (action === "authenticate") return ["singularity.connect"];
  if (action === "stasis" || action === "releaseStasis") return ["singularity.connect", "dnet.setStasisLink"];
  return [];
}

export const progressionModule: FeatureModule = {
  driver: progression,
  reset: () => {
    reset();
    // Rates and the route choice describe the node that just ended; the next
    // one re-measures and re-decides from scratch.
    progressionMemory = freshProgressionMemory();
    routeChange = undefined;
  },
  refresh: progressionRefresh,
  peakStepGb: STEP_GB.progression,
};
