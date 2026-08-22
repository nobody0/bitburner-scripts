import type { NS } from "@ns";
import { AUGMENTATIONS } from "../../../shared/features/augmentations.ts";
import { effectiveBitNodeMultipliers, WORLD_DAEMON_BASE_SKILL } from "../../../shared/features/bitnode.ts";
import { BLADEBURNER_RANK_CHANNEL, currencyWorth } from "../../../shared/strategy/income.ts";
import { careerBestPerSec, earnedSinceInstall, incomeShares } from "../income.ts";
import { blindBankrollRatePerSec } from "../../../shared/strategy/stock/decide.ts";
import { sfLevel } from "../../../shared/features/unlock.ts";
import { disabledByProfile } from "../../../shared/features/profile.ts";
import { PRIORITY, type Claim, type ClaimValueCurve } from "../../../shared/strategy/arbiter.ts";
import { stepBladeburner } from "../../../shared/strategy/bladeburner/decide.ts";
import { successChance, type CrimeStats } from "../../../shared/strategy/career/crimes.ts";
import { stepCorp } from "../../../shared/strategy/corp/stages.ts";
import { stepDarknet } from "../../../shared/strategy/dnet/decide.ts";
import { planBackdoors, type HoldHost } from "../../../shared/strategy/dnet/hold.ts";
import type { AttemptOutcome, ReportHost } from "../../../shared/strategy/dnet/courier.ts";
import { overseerArgs, residentArgs } from "../../../shared/strategy/dnet/mission.ts";
import { versionedScript } from "../../../shared/deployment.ts";
import { gameBuildId } from "../build-id.ts";
import { gameGlobal } from "../globals.ts";
import { publishKnowledge } from "../../../shared/strategy/dnet/publish.ts";
import {
  CONTROLLER_METHODS,
  RESIDENT_METHODS,
  priceAgent,
  residentLastLife,
  type DnetRendezvous,
  type DnetSpreadReport,
  type DnetFarmReport,
  type DnetListenReport,
  type DnetHoldReport,
} from "../../dnet/realm.ts";
import type { DarknetAgentDigest } from "../../../shared/telemetry/topics/dnet.ts";
import {
  DEFAULT_NET_DEPTH,
  isLabyrinth,
  msPerHostEventAny,
  mutationIntervalMs,
  netDepthFromLabs,
} from "../../../shared/strategy/dnet/rates.ts";
import { DARKSCAPE_TOTAL_COST, stepDarkscape } from "../../../shared/strategy/dnet/unlock.ts";
import {
  coverage,
  emptyKnowledge,
  foldAttempts,
  foldReports,
  fresh,
  isImmune,
  type DarknetKnowledge,
  type ExpiryOpts,
} from "../../../shared/strategy/dnet/knowledge.ts";
import {
  isSoA,
  NEUROFLUX,
  nextPurchasableAugmentation,
  scoreAugMults,
  weightsFromMarginals,
} from "../../../shared/strategy/factions/augs.ts";
import { workRepPerSec, type WorkType } from "../../../shared/strategy/factions/rep.ts";
import { stepGang } from "../../../shared/strategy/gang/decide.ts";
import { goDemands } from "../../../shared/strategy/go/demand.ts";
import {
  goNeuralPositionIdentity,
} from "../../../shared/strategy/go/neural/worker-protocol.ts";
import { GO_OPPONENT_MODEL } from "../../../shared/strategy/go/opponent.ts";
import { GO_REWARD_RULES, goFavorRepCap, rankGoGames, type GoEtaDemand, type GoRewardView } from "../../../shared/strategy/go/rewards.ts";
import { goRamPricingCandidate, planGoSchedule } from "../../../shared/strategy/go/schedule.ts";
import { GO_ENGINE_CYCLE_MS, goAiWaitMs } from "../../../shared/strategy/go/rng.ts";
import {
  applyGoCheat,
  GO_OPPONENTS,
  GO_REWARD_OPPONENTS,
  territory as goTerritory,
  isGoCheatAction,
  isGoRewardOpponent,
  playMove,
  scoreBoard,
  type GoAction,
  type GoDecision,
  type GoObservedBoardSize,
  type GoPlayingAction,
  type GoRewardOpponent,
  type GoView,
} from "../../../shared/strategy/go/rules.ts";
import {
  GO_DISPATCH_GUARD_MS,
  goChooseSeedTarget,
  goDispatchLatency,
  goPhaseAgrees,
  goPredictedPlaytime,
  type GoSeedTarget,
  type GoTickPhase,
} from "../../../shared/strategy/go/tick.ts";
import type { Need } from "../../../shared/strategy/needs.ts";
import {
  countClosureAffordable,
  countSlotValueFor,
  fundedActivationBatch,
  routeCountVerdict,
} from "../../../shared/strategy/progression/activation.ts";
import { bankedFavorActivationValue, chooseNextBitNode, dwellInstallVerdict, INSTALL_VERDICT_OVERHEAD_SEC, installCadencePushRate, installCadenceRemainingSec, installVerdict, labCacheDeferral, stepProgression } from "../../../shared/strategy/progression/decide.ts";
import {
  DAEDALUS_COMBAT,
  daedalusAugsRequired,
  GANG_FACTIONS,
  GANG_KARMA,
  RED_PILL,
  stepEndgame,
  type EndgameView,
  type RouteId,
} from "../../../shared/strategy/progression/endgame.ts";
import {
  chooseRoute,
  FALLBACK_MONEY_PER_SEC,
  regrowInstallOverride,
  routeEtas,
  type RouteChoice,
  type RouteRates,
} from "../../../shared/strategy/progression/eta.ts";
import {
  forecastAt,
  IMMINENT_INSTALL_SEC,
  installForecast,
  installHorizonSec,
  nodeForecast,
  shouldReforecast,
  usableForecastSec,
  type PlanningHorizons,
} from "../../../shared/strategy/progression/forecast.ts";
import { progressionMarginals } from "../../../shared/strategy/progression/marginal.ts";
import {
  augmentationAcquisitionRate,
  cycleProgressExponent,
  retainCycleCurve,
  type AugmentationCycle,
  type CyclePoint,
} from "../../../shared/strategy/progression/regrowth.ts";
import { stepSleeves, type SleevesView, type SleeveTask } from "../../../shared/strategy/sleeves/decide.ts";
import { packFragments } from "../../../shared/strategy/stanek/pack.ts";
import type {
  GoActionDigest,
  GoPlan,
  GoTurnPrediction,
  GoResponse,
  GoTurnResult,
} from "../../../shared/telemetry/topics/go.ts";
import type { CrimeOption } from "../../../shared/telemetry/topics/career.ts";
import type { ProgressionPlan, RouteEtaDigest } from "../../../shared/telemetry/topics/progression.ts";
import { isScriptDeath } from "../errors.ts";
import { goNeuralWorkerRuntime, resetGoNeuralWorkerRuntime, type GoNeuralRuntime } from "../go-neural-worker.ts";
import { runGoNeuralSeedDispatch } from "../go-neural.ts";
import { resetInstallSignal, takeInstallSignal } from "../install-signal.ts";
import { armSleeveCompletion, consumeSleeveCompletion, pendingSleeveCompletions, resetSleeveCompletions } from "../sleeve-completion.ts";
import { merge, set, type GameState } from "../state.ts";
import type { WorkTaskLike } from "../work-completion.ts";
import type { FeatureClaim } from "./claims.ts";
import { actionRamClaim, featureDodge, featureDodgeOn, featureGoDodge } from "./dodge.ts";
import { liquidatableValue } from "./factions.ts";
import type { ClaimContext, DriverContext, FeatureDriver, FeatureModule, NeedContext } from "./index.ts";

/** Drivers for the features whose game-side work is a thin execution layer
 * over a pure strategy that lives in shared/strategy/.
 *
 * They share a file because they share a SHAPE, not because they are small:
 * build a view from the store, call one pure `step*`, execute at most one
 * action per tick inside one dodge, and write the decision digest back. Any
 * one of them can move to its own file the moment it needs more than that —
 * `factions`, `career`, `hacknet` and `stock` already have. */

/** Go's pure ROI policy needs a cold estimate before a runtime request exists;
 * this is not used for broker sizing or placement. */
const GO_ESTIMATED_GB = 4;
const GO_CHEAT_CANDIDATE_LIMIT = 4;
const GO_CHEAT_DOUBLE_MOVE_LIMIT = 2;
// This is far beyond the useful portion of the rapidly decaying chance curve
// and keeps the worker independent of Netscript throughout practical games.
const GO_CHEAT_CHANCE_SAMPLES = 1_024;
const GO_MAX_FLEET_SHARE = 0.01;
/** A filler game must finish this comfortably inside the preferred entry
 * window — overrunning forfeits the aligned start and re-plans onto the next
 * recurrence of the route. */
const GO_FILLER_MARGIN = 1.25;
/** Reset dispatch plus first-turn planning allowance for a filler game. */
const GO_FILLER_OVERHEAD_SEC = 10;
const BLADES_SIMULACRUM = "The Blade's Simulacrum";

type Result = { action: string; ok: boolean; detail: string; at: number } | undefined;
const results: Record<string, Result> = {};

function record(id: string, action: string, ok: boolean, detail: string): void {
  results[id] = { action, ok, detail, at: Date.now() };
}

function requireResult(id: string): NonNullable<Result> {
  const result = results[id];
  if (!result) throw new Error(`missing ${id} action result`);
  return result;
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
  lane: "ordinary" | "go" = "ordinary",
): Promise<T | undefined> {
  try {
    const outcome = lane === "go"
      ? await featureGoDodge(ctx, goActionClaimId(action), methods, body)
      : await featureDodge(ctx, id as Claim["by"], actionClaimId(action), methods, body);
    if (!outcome.ok) {
      record(id, action, false, outcome.reason);
      return;
    }
    const value = outcome.value;
    const { ok, detail } = describe(value);
    record(id, action, ok, detail);
    return value;
  } catch (error) {
    if (isScriptDeath(error)) throw error;
    record(id, action, false, String(error));
  }
}

function actionClaimId(action: string): string { return `action:${action}`; }

/** Move, pass, resume and the tick-anchoring probe share one turn-sized RAM
 * grant: anchoring always runs immediately before the turn it aligns, and its
 * own dodge is far smaller than the grant already reserved for that turn. */
function goActionClaimId(action: string): string {
  return action === "move" || action === "pass" || action === "resume" || action === "align"
    || action.startsWith("cheat")
    ? "action:turn"
    : actionClaimId(action);
}

function maybeActionClaim(
  by: Claim["by"],
  ctx: ClaimContext,
  action: string | undefined,
  methods: readonly string[],
): FeatureClaim[] {
  if (!action || methods.length === 0) return [];
  return [actionRamClaim(ctx, by, actionClaimId(action), methods)];
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
      // Gang respect is the direct input to gang-faction reputation. When BN2
      // selected this route, make that terminal objective dominate equipment
      // money; on other routes retain the balanced standing policy.
      weights: ctx.route === "gang"
        ? { respect: 10, money: 1e-8 }
        : { respect: 1, money: 1e-6 },
    });

    merge(ctx.state, "gang", {
      plan: {
        actions: decision.actions.map((action) => ({
          type: action.type,
          ...("member" in action ? { member: action.member } : {}),
          ...("task" in action ? { task: action.task } : {}),
          ...("engage" in action ? { engage: action.engage } : {}),
        })),
        assignment: {
          total: decision.assignment.total,
          approximated: decision.assignment.approximated,
          choices: decision.assignment.choices.map((choice) => ({
            member: choice.agent.name,
            task: choice.task.name,
            score: choice.score,
          })),
        },
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
        action: {
          type: decision.action.type,
          ...(decision.action.type === "expandIndustry" ? { industry: decision.action.industry, division: decision.action.division } : {}),
          ...("division" in decision.action ? { division: decision.action.division } : {}),
          ...("city" in decision.action ? { city: decision.action.city } : {}),
          ...("size" in decision.action ? { size: decision.action.size } : {}),
          ...("job" in decision.action ? { job: decision.action.job } : {}),
          ...("material" in decision.action ? { material: decision.action.material } : {}),
          ...("round" in decision.action ? { round: decision.action.round } : {}),
          ...("name" in decision.action ? { name: decision.action.name } : {}),
        },
        stage: decision.stage,
        completed: decision.completed,
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
        // v3.0.1 exposes the level-adjusted base rank gain directly; action
        // completion applies its random offset around that base.
        // Source: https://github.com/bitburner-official/bitburner-src/blob/3162fd2590e221eadd0c0fbd46151913f7c4c41c/src/NetscriptFunctions/Bladeburner.ts#L165-L171
        rankGain: action.rankGain ?? 0,
        rankLoss: action.rankLoss ?? 0,
        ...(action.rankNeeded !== undefined ? { rankNeeded: action.rankNeeded } : {}),
      })),
      skills: topic.skills ?? {},
      ...(topic.current ? { current: { type: topic.current.type, name: topic.current.name } } : {}),
    });

    merge(ctx.state, "bladeburner", {
      plan: {
        action: {
          type: decision.action.type,
          ...(decision.action.type === "act" ? { actionType: decision.action.actionType, name: decision.action.name } : {}),
          ...(decision.action.type === "upgrade" ? { skill: decision.action.skill } : {}),
        },
        ranked: decision.ranked.slice(0, 8).map((entry) => ({
          name: entry.name,
          actionType: entry.actionType,
          rankPerSec: entry.rankPerSec,
          chanceLow: entry.chanceLow,
        })),
        ...(results["bladeburner"] ? { lastResult: results["bladeburner"] } : {}),
      },
    });

    if (decision.action.type === "continue") return;
    const hasSimulacrum = (ctx.state.topics.progression?.ownedAugs?.[BLADES_SIMULACRUM] ?? 0) > 0;
    if (decision.action.type === "act" && !hasSimulacrum && !ctx.grants.slot) {
      // Starting a Bladeburner action cancels Player.currentWork unless the
      // installed Blade's Simulacrum exempts it. Wait for the arbiter's slot.
      // Source: https://github.com/bitburner-official/bitburner-src/blob/3162fd2590e221eadd0c0fbd46151913f7c4c41c/src/Bladeburner/Bladeburner.ts#L173-L182
      record("bladeburner", "act", false, "waiting for Player.currentWork slot");
      return;
    }
    await act(
      ctx,
      "bladeburner",
      decision.action.type,
      bladeMethods(decision.action.type),
      (stubNs: NS) => {
        const action = decision.action;
        if (action.type === "stop") {
          // Stopping is a separate API call; merely declining to start a new
          // action leaves the current Bladeburner action running.
          // Source: https://github.com/bitburner-official/bitburner-src/blob/3162fd2590e221eadd0c0fbd46151913f7c4c41c/src/NetscriptFunctions/Bladeburner.ts#L108-L124
          stubNs["bladeburner"]["stopBladeburnerAction"]();
          return true;
        }
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

export function sleeveView(state: GameState): SleevesView | undefined {
  const topic = state.topics.sleeves;
  if (!topic) return undefined;
  const completed = pendingSleeveCompletions();
  const sleeves = (topic.sleeves ?? []).map((sleeve) => ({
    index: sleeve.index,
    shock: sleeve.shock,
    sync: sleeve.sync,
    city: sleeve.city,
    skills: sleeve.skills as unknown as Record<string, number>,
    ...(sleeve.task
      ? {
          task: {
            type: sleeve.task.type,
            detail: sleeve.task.detail,
            ...(sleeve.task.workType !== undefined ? { workType: sleeve.task.workType } : {}),
          },
        }
      : {}),
    ...(completed.has(sleeve.index) ? { allowCrimeSwitch: true } : {}),
  }));
  const progression = state.topics.progression;
  const node = effectiveBitNodeMultipliers(
    progression?.bitNode,
    sfLevel(progression?.sourceFiles, 12),
    progression?.multipliers,
  ) ?? {};
  const playerMults = (state.topics.player?.mults ?? {}) as unknown as Record<string, number>;
  // This per-run option zeros every sleeve experience field in
  // calculateCrimeWorkStats/calculateFactionExp, but leaves money, reputation,
  // karma, and kills intact.
  // Source: https://github.com/bitburner-official/bitburner-src/blob/3162fd2590e221eadd0c0fbd46151913f7c4c41c/src/Work/Formulas.ts#L24-L35
  const sleeveExpEnabled = state.topics.capabilities?.restrictions.disableSleeveExpAndAugmentation !== true;
  const crimes = state.topics.career?.crimes ?? [];
  const tasks: SleeveTask[] = [
    { type: "recovery", outcomes: [{ rates: {}, moneyPerSec: 0 }] },
    { type: "synchro", outcomes: [{ rates: {}, moneyPerSec: 0 }] },
  ];
  for (const crime of crimes) {
    // getCrimeStats replaces the base money/experience with gains calculated
    // for the current PLAYER. Undo those factors before applying each sleeve's
    // own multipliers; otherwise player augmentations are counted once and
    // sleeve augmentations a second time.
    // Source: https://github.com/bitburner-official/bitburner-src/blob/3162fd2590e221eadd0c0fbd46151913f7c4c41c/src/NetscriptFunctions/Singularity.ts#L1068-L1090
    // Source: https://github.com/bitburner-official/bitburner-src/blob/3162fd2590e221eadd0c0fbd46151913f7c4c41c/src/Work/Formulas.ts#L58-L79
    const baseGain = (value: number, factor: number): number =>
      crime.gainsAreEffective ? (factor > 0 ? value / factor : 0) : value;
    const baseMoney = baseGain(
      crime.money,
      (playerMults["crime_money"] ?? 1) * (node["CrimeMoney"] ?? 1),
    );
    const baseExp = Object.fromEntries(Object.entries(crime.exp ?? {}).map(([skill, value]) => [
      skill,
      baseGain(
        value,
        (skill === "intelligence" ? 1 : (playerMults[`${skill}_exp`] ?? 1)) * (node["CrimeExpGain"] ?? 1),
      ),
    ]));
    const outcomes = (topic.sleeves ?? []).map((sleeve) => {
      const mults = sleeve.mults ?? {};
      const stats: CrimeStats = {
        type: crime.name,
        timeMs: crime.timeMs,
        money: baseMoney,
        difficulty: crime.difficulty ?? 1,
        karma: Math.abs(crime.karma),
        kills: crime.kills ?? 0,
        weights: crime.weights ?? {},
        exp: baseExp,
      };
      const chance = successChance(
        stats,
        { skills: sleeve.skills as unknown as Record<string, number>, mults: { crime_success: mults["crime_success"] ?? 1, crime_money: mults["crime_money"] ?? 1 } },
        { crimeSuccessRate: node["CrimeSuccessRate"] ?? 1, crimeMoney: node["CrimeMoney"] ?? 1 },
      );
      const seconds = crime.timeMs / 1_000;
      const sync = sleeve.sync / 100;
      const expectedExp = 0.25 + 0.75 * chance;
      const exp = baseExp;
      const expRate = (skill: string): number =>
        sleeveExpEnabled
          ? expectedExp * sync * (exp[skill] ?? 0) * (mults[`${skill}_exp`] ?? 1) * (node["CrimeExpGain"] ?? 1) / seconds
          : 0;
      const rates = {
        combatSkills: Math.min(expRate("strength"), expRate("defense"), expRate("dexterity"), expRate("agility")),
        charisma: expRate("charisma"),
      };
      const contributions = Object.keys(exp)
        .map((skill) => ({ kind: "skill" as const, subject: skill, perSec: expRate(skill) }))
        .filter((entry) => entry.perSec > 0);
      // SleeveCrimeWork changes karma/kills directly. Neither is multiplied by
      // shock; karma is multiplied by sync, while kills are not.
      // Source: https://github.com/bitburner-official/bitburner-src/blob/3162fd2590e221eadd0c0fbd46151913f7c4c41c/src/PersonObjects/Sleeve/Work/SleeveCrimeWork.ts#L37-L50
      const shockExemptRates = {
        karma: chance * Math.abs(crime.karma) * sync / seconds,
        kills: chance * (crime.kills ?? 0) / seconds,
      };
      // Outcomes are deliberately pre-shock: stepSleeves applies shock once
      // while comparing every task. SleeveCrimeWork shocks these WorkStats
      // before paying them, while only karma/kills bypass that scaling.
      // Source: https://github.com/bitburner-official/bitburner-src/blob/3162fd2590e221eadd0c0fbd46151913f7c4c41c/src/PersonObjects/Sleeve/Work/SleeveCrimeWork.ts#L31-L50
      const moneyPerSec = chance * baseMoney * (mults["crime_money"] ?? 1) * (node["CrimeMoney"] ?? 1) / seconds;
      return { sleeve: sleeve.index, rates, contributions, shockExemptRates, moneyPerSec };
    });
    tasks.push({
      type: "crime",
      detail: crime.name,
      outcomes,
    });
  }

  // The current faction reputation breakpoint is an outcome sleeves can
  // advance in parallel with Player.currentWork. Each faction is capacity-one
  // in the game, while crime remains freely repeatable across sleeves.
  const factionTopic = state.topics.factions;
  const repTarget = factionTopic?.plan?.until;
  if (repTarget?.kind === "rep" && repTarget.faction && factionTopic?.joined.includes(repTarget.faction)) {
    const standing = factionTopic.standings?.find((entry) => entry.name === repTarget.faction);
    const offered = factionTopic.workTypes?.[repTarget.faction] ?? [];
    const sourceFiles = state.topics.progression?.sourceFiles ?? {};
    for (const workType of ["hacking", "field", "security"] as const) {
      if (!offered.includes(workType)) continue;
      const outcomes = (topic.sleeves ?? []).map((sleeve) => {
        const mults = sleeve.mults ?? {};
        const contributions = [{
          kind: "factionRep" as const,
          subject: repTarget.faction,
          // Outcomes are pre-shock; stepSleeves applies the exact shock factor
          // once. Sleeve faction reputation is not scaled by sync.
          // Source: https://github.com/bitburner-official/bitburner-src/blob/3162fd2590e221eadd0c0fbd46151913f7c4c41c/src/PersonObjects/Sleeve/Work/SleeveFactionWork.ts#L30-L38
          perSec: workRepPerSec(
            workType as WorkType,
            {
              skills: {
                hacking: sleeve.skills.hacking,
                strength: sleeve.skills.strength,
                defense: sleeve.skills.defense,
                dexterity: sleeve.skills.dexterity,
                agility: sleeve.skills.agility,
                charisma: sleeve.skills.charisma,
                intelligence: sleeve.skills.intelligence ?? 0,
              },
              mults: { faction_rep: mults["faction_rep"] ?? 1 },
            },
            standing?.favor ?? 0,
            {
              factionWorkRepGain: node["FactionWorkRepGain"] ?? 1,
              shareBonus: state.topics.fleet?.sharePower ?? 1,
              sf15Level: sfLevel(sourceFiles, 15),
              hasFocusAug: true,
            },
            true,
          ),
        }];
        return { sleeve: sleeve.index, rates: {}, contributions, moneyPerSec: 0 };
      });
      tasks.push({
        type: "faction",
        detail: repTarget.faction,
        workType,
        exclusiveKey: `faction:${repTarget.faction}`,
        outcomes,
      });
    }
  }
  return { sleeves, tasks, shockCeiling: 50, syncFloor: 50 };
}

const sleeves: FeatureDriver = {
  id: "sleeves",
  everyMs: 30_000,
  wake: () => pendingSleeveCompletions().size > 0,
  requires: "sleeves",
  async tick(ctx: DriverContext) {
    const topic = ctx.state.topics.sleeves;
    const view = sleeveView(ctx.state);
    if (!topic || !view) return;
    const decision = stepSleeves(view, ctx.board);

    merge(ctx.state, "sleeves", {
      plan: {
        assignments: decision.assignments.map((entry) => ({
          index: entry.index,
          task: `${entry.task.type}${entry.task.detail ? `:${entry.task.detail}` : ""}${entry.task.workType ? `:${entry.task.workType}` : ""}`,
        })),
        selection: decision.assignment.choices.map((entry) => ({
          index: entry.agent.index,
          task: `${entry.task.type}${entry.task.detail ? `:${entry.task.detail}` : ""}${entry.task.workType ? `:${entry.task.workType}` : ""}`,
          score: entry.score,
        })),
        totalScore: decision.assignment.total,
        ...(results["sleeves"] ? { lastResult: results["sleeves"] } : {}),
      },
    });

    const completed = [...pendingSleeveCompletions()];
    if (decision.assignments.length === 0 && completed.length === 0) return;

    // ONE DODGE PER TASK TYPE, then one to read back.
    //
    // Every sleeve API method costs SleeveBase (4 GB), and the batch used to
    // union getTask with one setter per DISTINCT task type — so a six-type
    // batch demanded 4x(6+1) + 2.1 = 30.1 GB of CONTIGUOUS RAM on one host.
    // Split, the peak is the 6.1 GB floor of any single sleeve call.
    //
    // The setters are independent writes on distinct sleeve indices: no shared
    // stub state, no live handle crossing the boundary, and nothing here is
    // read-then-write. The getTask pass is a read-back that arms completions —
    // sleeves.core performs the identical read every 30 s — not an atomicity
    // requirement, which is why it can be its own stub too.
    const byType = new Map<string, typeof decision.assignments>();
    for (const next of decision.assignments) {
      const group = byType.get(next.task.type);
      if (group) group.push(next);
      else byType.set(next.task.type, [next]);
    }
    const changed: number[] = [];
    let anyRefused = false;
    for (const [type, group] of byType) {
      const applied = await featureDodge(
        ctx,
        "sleeves",
        `action:set-${type}`,
        sleeveMethods(type),
        (stubNs: NS) => {
          const set: number[] = [];
          for (const next of group) {
            let ok = false;
            if (next.task.type === "recovery") ok = stubNs["sleeve"]["setToShockRecovery"](next.index);
            else if (next.task.type === "synchro") ok = stubNs["sleeve"]["setToSynchronize"](next.index);
            else if (next.task.type === "crime") ok = stubNs["sleeve"]["setToCommitCrime"](next.index, next.task.detail as never);
            else if (next.task.type === "gym") ok = stubNs["sleeve"]["setToGymWorkout"](next.index, "Powerhouse Gym" as never, next.task.detail as never);
            else if (next.task.type === "class") ok = stubNs["sleeve"]["setToUniversityCourse"](next.index, "Rothman University" as never, next.task.detail as never);
            else if (next.task.type === "faction") {
              ok = Boolean(stubNs["sleeve"]["setToFactionWork"](next.index, next.task.detail as never, next.task.workType as never));
            }
            if (ok) set.push(next.index);
          }
          return set;
        },
      );
      // A refused group leaves those sleeves on their previous task and retries
      // next pass; the groups that did land are still worth reading back.
      if (applied.ok) changed.push(...applied.value);
      else anyRefused = true;
    }

    const outcome = await featureDodge(
      ctx,
      "sleeves",
      "action:observe",
      ["sleeve.getTask"],
      (stubNs: NS) => {
        const observed: { index: number; task?: { type: string; detail?: string; workType?: string } }[] = [];
        for (const sleeve of topic.sleeves ?? []) {
          const task = stubNs["sleeve"]["getTask"](sleeve.index) as (WorkTaskLike & Record<string, unknown>) | null;
          armSleeveCompletion(sleeve.index, task);
          if (!task) observed.push({ index: sleeve.index });
          else {
            const detail = task.factionName ?? task.companyName ?? task.crimeType ?? task.classType;
            observed.push({
              index: sleeve.index,
              task: {
                type: String(task.type),
                ...(detail !== undefined ? { detail: String(detail) } : {}),
                ...(task.factionWorkType !== undefined ? { workType: String(task.factionWorkType) } : {}),
              },
            });
          }
        }
        return { changed, observed };
      },
    );
    if (outcome.ok) {
      for (const index of completed) consumeSleeveCompletion(index);
      const observed = new Map(outcome.value.observed.map((entry) => [entry.index, entry.task]));
      merge(ctx.state, "sleeves", {
        sleeves: (topic.sleeves ?? []).map((sleeve) => {
          const task = observed.get(sleeve.index);
          return task === undefined ? { ...sleeve, task: undefined } : { ...sleeve, task };
        }),
      });
      results["sleeves"] = {
        action: "batch",
        ok: !anyRefused,
        detail: anyRefused
          ? `updated ${outcome.value.changed.length} sleeves; some assignments were refused RAM`
          : `updated ${outcome.value.changed.length} sleeves`,
        at: Date.now(),
      };
    }
  },
};

// --- go ---------------------------------------------------------------------

function goActionDigest(action: GoAction): GoActionDigest {
  switch (action.type) {
    case "move": return { type: action.type, x: action.x, y: action.y };
    case "cheatTwoMoves": return {
      type: action.type, x1: action.x1, y1: action.y1, x2: action.x2, y2: action.y2,
    };
    case "cheatRemoveRouter":
    case "cheatDestroyNode":
    case "cheatRepairNode": return { type: action.type, x: action.x, y: action.y };
    case "newGame": return { type: action.type, opponent: action.opponent, boardSize: action.boardSize };
    case "pass":
    case "resume": return { type: action.type };
  }
}

export function goFactionFavor(ctx: DriverContext): GoRewardView["factionFavor"] {
  const result: GoRewardView["factionFavor"] = {};
  const joined = new Set(ctx.state.topics.factions?.joined ?? []);
  // The committed intent is the only concurrent faction farm, but favor
  // persists through installs, so its value is ALSO the reachable ladder
  // work over the remaining node (favorValue model) — including the
  // donation-gate crossing. Without the node-scoped term, an imminent
  // install priced every favor event at zero and Go idled on a finished
  // board (screenshot 2026-08-18).
  const intent = ctx.state.topics.factions?.plan?.objective?.intent;
  // READ, do not recompute. Deriving this here meant rebuilding the whole
  // augmentation catalogue and re-walking every joined faction's rep ladder
  // on each five-second Go tick; the factions driver publishes the same
  // numbers as a by-product of the view it already builds.
  const pointValues = ctx.state.topics.factions?.favorPointValues;
  const standings = new Map((ctx.state.topics.factions?.standings ?? []).map((standing) => [standing.name, standing]));
  for (const opponent of GO_OPPONENTS) {
    if (!joined.has(opponent)) continue;
    const standing = standings.get(opponent);
    if (!standing) continue;
    const pointValue = pointValues?.[opponent];
    result[opponent] = {
      favor: standing.favor,
      remainingWorkSec: Math.max(
        intent?.faction === opponent ? Math.max(0, intent.repSec) : 0,
        pointValue?.remainingWorkSec ?? 0,
      ),
      ...(pointValue
        ? { pointValue: { donationUnlockSec: pointValue.donationUnlockSec, donateThreshold: pointValue.donateThreshold } }
        : {}),
    };
  }
  return result;
}

function observedGoBoardSize(board: readonly string[]): GoObservedBoardSize {
  const size = board.length;
  if ((size !== 5 && size !== 7 && size !== 9 && size !== 13 && size !== 19)
    || board.some((column) => column.length !== size)) {
    throw new Error(`unexpected Go reset board dimensions ${size}x${board[0]?.length ?? 0}`);
  }
  return size;
}

type RawGoResponse = Awaited<ReturnType<NS["go"]["makeMove"]>>;
type GoActionOutcome = {
  response?: RawGoResponse;
  player?: ReturnType<NS["getPlayer"]>;
  playerObservedAt?: number;
  action?: GoPlayingAction;
  decision?: GoDecision;
  prediction?: GoTurnPrediction;
  predictionParentId?: string;
  responsePlayer?: ReturnType<NS["getPlayer"]>;
  responseObservedAt?: number;
  responseReadyAt?: number;
  responseBonusCycles?: number;
};

function normalizeGoResponse(response: RawGoResponse): GoResponse {
  if (response.type === "move") {
    if (response.x === null || response.y === null) throw new Error("Go move response omitted its coordinates");
    return { type: "move", x: response.x, y: response.y };
  }
  if (response.x !== null || response.y !== null) throw new Error(`Go ${response.type} response carried coordinates`);
  return { type: response.type, x: null, y: null };
}

/** Successful turns chain immediately; five seconds is the failure retry. */
let goContinuationReady = false;
let goCompletionReady = false;
let goTurnRunning = false;
/** Planning is asynchronous (including the GPU batch), so the
 * turn-running flag alone no longer covers the whole tick: a controller-cadence
 * pass can arrive while the detached continuation is still preparing. Two
 * concurrent planners would interleave into the engine's single packing buffer
 * and dispatch two turns for one position. */
let goPlanning = false;
let goGeneration = 0;
/** Large worker-only chance table. Keeping it out of the telemetry topic avoids
 * sending 1,024 redundant values on every Go update. */
let goCheatSuccessByCount: number[] | undefined;
/** Parent commit accepted by the worker for the board expected on the next
 * Black turn. A mismatching public board falls back to a full install. */
let goPredictionParent: string | undefined;
/** Exact on chained turns (the opponent promise resolution); cold starts use
 * the first actionable Black-turn observation. */
let goTurnReadyAt: number | undefined;

/** Certified playbook lines in live play.
 *
 * The playbook is consulted for every 5x5 opponent it covers: a certified hit
 * is a proven move and a miss costs one table lookup, so mid-game consultation
 * is free upside (measured: never below the neural baseline, +3 games for
 * Tetrads).
 *
 * `maxWaitPhases` is separate and expensive. A certified line is only entered
 * from a phase-aligned game start, so the controller must defer the game until
 * the route's entry phase, playing no Go at all meanwhile. That is worth doing
 * only where the certified line beats ordinary neural play by enough to pay
 * for the wait. Per-opponent results from one 3,072-game combined arena
 * (2026-08-18, `go:combined:arena --games 3072 --unrouted-baseline`, 512 games
 * each), certified-root routing versus the neural baseline on ordinary phases:
 *
 * | Opponent | routed line | neural, unrouted |
 * |---|---:|---:|
 * | Illuminati | 505/512 | 364/512 |
 * | Tetrads | 512/512 | 487/512 |
 * | Daedalus | 512/512 | 490/512 |
 * | The Black Hand | 512/512 | 507/512 |
 * | Netburners | 512/512 | 511/512 |
 * | Slum Snakes | 512/512 | 511/512 |
 *
 * So Illuminati justifies a long wait, Daedalus and Tetrads a short one, and
 * the remaining three justify none — their certified lines win no games the
 * network does not already win. */
const GO_PLAYBOOK_OPPONENTS: Readonly<Record<string, { maxWaitPhases: number }>> = {
  Illuminati: { maxWaitPhases: 5_000 },
  Daedalus: { maxWaitPhases: 900 },
  Tetrads: { maxWaitPhases: 900 },
  "The Black Hand": { maxWaitPhases: 0 },
  Netburners: { maxWaitPhases: 0 },
  "Slum Snakes": { maxWaitPhases: 0 },
};
/** Proceed with the aligned reset once the route entry is this close: the
 * remaining seconds are absorbed tick-exactly by the first move's dispatch
 * target. Must exceed the driver's 5 s go cadence so an approaching window
 * cannot fall between two passes, and cover reset plus first-turn planning. */
const GO_PLAYBOOK_START_SLACK_PHASES = 30;
/** A certified sleep longer than this abandons the line instead of holding
 * the controller's turn loop mid-game. */
const GO_PLAYBOOK_MAX_SLEEP_PHASES = 25;
/** Alignment credit for the certified line of the active game (mirrors the
 * standalone combined driver's per-game credit). */
let goPlaybookCredit = 0;
/** Credit grant that becomes effective once the engine clock reaches the
 * given tick — the controller-shaped form of the standalone driver sleeping
 * an align/sleep entry before continuing the line. */
let goPlaybookPendingCredit: { atPlaytime: number; credit: number } | undefined;
/** Committed phase-aligned game start; consumed by the first Black move. */
let goPlaybookEntry: { opponent: string; entryPlaytime: number } | undefined;

function resetGoPlaybookLine(): void {
  goPlaybookCredit = 0;
  goPlaybookPendingCredit = undefined;
}

/** The held board is a LOCAL SIMULATION, advanced by applying our move and the
 * AI's reply with this repo's own rules. It is trustworthy only between the
 * moment the game's own rows were read and the moment we dispatch the next
 * board-changing call.
 *
 * SET AT DISPATCH, cleared only by proof (the post-turn verification), a
 * rebuild (hydrate), or an authoritative rows return (resetBoardState). That
 * ordering is the whole design: every way a turn can fail after the call was
 * issued — a refusal, a rules-drift throw, an unsettled lane promise, a stub
 * killed after makeMove already resolved in-game — leaves this set, so the next
 * pass rebuilds. None of them is classified by its error text, because the last
 * of them records no text at all. */
let goRehydrate = false;
let goRehydrateReason: string | undefined;

function invalidateGoMirror(reason: string): void {
  goRehydrate = true;
  goRehydrateReason = reason;
}

const GO_DISPATCH_UNMERGED = "a turn was dispatched and its outcome never merged";

let testGoRuntime: GoNeuralRuntime | undefined;

function goNeuralRuntime(): GoNeuralRuntime {
  return testGoRuntime ?? goNeuralWorkerRuntime();
}

/** Replace the browser worker only for Bun controller/simulator tests. The
 * production bundle imports no direct V9 engine or model weights on the main
 * thread; those exist solely inside the embedded worker source. */
export function setGoNeuralRuntimeForTest(runtime?: GoNeuralRuntime): void {
  if (typeof Bun === "undefined") throw new Error("Go backend test injection is only available under Bun");
  testGoRuntime?.dispose();
  testGoRuntime = runtime;
}

export function setGoCheatSuccessTableForTest(chances?: number[]): void {
  if (typeof Bun === "undefined") throw new Error("Go cheat test injection is only available under Bun");
  goCheatSuccessByCount = chances;
}

/** Wall-clock anchor for the 200 ms engine cycle, established by observing a
 * totalPlaytime transition. Held across turns: one observation keeps the phase
 * known for as long as the browser advances time normally. */
let goTickPhase: GoTickPhase | undefined;

/** Sampling period for the anchoring poll. Two milliseconds matches the final
 * read-to-call guard without busy-waiting. */
export const GO_ANCHOR_POLL_MS = 2;

/** A game that is paused or hard-throttled never rolls over, and retrying a
 * full-cycle poll every turn would waste a dodge each time. */
const GO_ANCHOR_RETRY_MS = 30_000;
let goAnchorFailedAt = 0;

/** Observe one engine-cycle rollover.
 *
 * This is deliberately its own dodge: it may wait most of a 200 ms cycle, and
 * the turn dodge that follows must reserve `go.makeMove` at 4 GB. Polling here
 * costs only `getPlayer` (0.5 GB) plus the stub base, so the large grant is
 * never held while merely waiting for the clock. Netscript prices RAM per
 * distinct function used rather than per call, so the poll loop itself is
 * free. */
async function observeGoTickPhase(stubNs: NS): Promise<GoTickPhase | undefined> {
  const initial = stubNs["getPlayer"]().totalPlaytime;
  const attempts = Math.ceil(GO_ENGINE_CYCLE_MS / GO_ANCHOR_POLL_MS) + 2;
  for (let attempt = 0; attempt < attempts; attempt++) {
    await stubNs["sleep"](GO_ANCHOR_POLL_MS);
    const playtime = stubNs["getPlayer"]().totalPlaytime;
    if (playtime !== initial) return { wallAt: Date.now(), playtime };
  }
  // A paused or heavily throttled game never rolls over; report failure and
  // let the caller fall back to dispatching against the current tick.
  return undefined;
}

function sameGoPosition(plan: GoPlan | undefined, topic: NonNullable<GameState["topics"]["go"]>): boolean {
  if (!plan || plan.input.status !== topic.status || plan.input.currentPlayer !== topic.currentPlayer) return false;
  return plan.input.board.length === topic.board?.length
    && plan.input.board.every((column, index) => column === topic.board?.[index]);
}

/** Claims are collected before tick() computes the next plan. Derive lifecycle
 * transitions from the current public board so a freshly completed promise can
 * act immediately even though the stored plan describes the preceding turn. */
function goCheatUnlocked(caps: DriverContext["caps"]): boolean {
  const level = sfLevel(caps.sourceFiles, 14);
  return level > 1 || (caps.bitNode === 14 && level === 1);
}

function goClaimAction(state: GameState, caps: DriverContext["caps"]): GoAction["type"] | "hydrate" | undefined {
  const topic = state.topics.go;
  if (!topic?.status || !topic.currentPlayer) return undefined;
  // goRehydrate first: an unproven mirror must be rebuilt before it is
  // planned on, and the claim has to be sized for the read that will happen.
  if (goRehydrate || !topic.board || !topic.previousBoards || (goCheatUnlocked(caps) && (!topic.cheat || !goCheatSuccessByCount))) return "hydrate";
  if (topic.status === "gameOver" || topic.currentPlayer === "None") return "newGame";
  if (topic.currentPlayer !== "Black") return "resume";
  if (sameGoPosition(topic.plan, topic)) {
    const planned = topic.plan!.action.type;
    if (planned === "move" || planned === "pass" || planned === "newGame" || planned.startsWith("cheat")) return planned;
  }
  return topic.board.some((column) => column.includes(".")) ? "move" : "pass";
}

/** Finish active games, but start Go only when its fixed RAM cost is small
 * relative to the fleet. GoPower and SF14 scale the admission threshold. */
function goActionAdmitted(state: GameState, caps: DriverContext["caps"]): boolean {
  const topic = state.topics.go;
  if ((topic?.previousBoards?.length ?? 0) > 0 && topic?.status !== "gameOver") return true;
  const pie = state.topics.farm?.ramPie;
  if (!pie) return false;
  const usableGb = pie.farm + pie.prep + pie.share + pie.free + pie.reserve;
  const nodeMults = effectiveBitNodeMultipliers(
    caps.bitNode,
    sfLevel(caps.sourceFiles, 12),
    state.topics.progression?.multipliers,
  );
  const rewardScale = (nodeMults?.GoPower ?? 1) * (sfLevel(caps.sourceFiles, 14) > 0 ? 2 : 1);
  // Same displacement pricing as goGamePaysForRam: a dodge the free arena can
  // absorb outright costs the fleet nothing, so admission never blocks it.
  const displacedGb = Math.max(0, GO_ESTIMATED_GB - pie.free);
  return usableGb > 0 && displacedGb / usableGb <= GO_MAX_FLEET_SHARE * rewardScale;
}

/** A Go candidate reports route-seconds saved per second spent playing. Its
 * opportunity cost is the fraction of productive fleet RAM the fixed Go dodge
 * actually DISPLACES: RAM the farm was going to use. Free arena RAM displaces
 * nothing, so with idle capacity any positive utility plays — pricing idle
 * gigabytes at full farm throughput zeroed Go out in exactly the windows
 * (node tail, saturated farm) where a marginal 0.5s was still free money.
 * This stays a marginal test: an asymptotically positive bonus does not
 * justify playing forever once its next increment is smaller than the
 * throughput it genuinely displaces. */
export function goGamePaysForRam(utilityPerSec: number, usableGb: number, freeGb = 0): boolean {
  if (!(utilityPerSec > 0) || !(usableGb > 0)) return false;
  const displacedGb = Math.max(0, GO_ESTIMATED_GB - Math.max(0, freeGb));
  return utilityPerSec > displacedGb / usableGb;
}

const go: FeatureDriver = {
  id: "go",
  everyMs: 5_000,
  wake: () => goContinuationReady || goCompletionReady,
  requires: "go",
  async tick(ctx: DriverContext) {
    // Hold one guard across the whole asynchronous body, including planning.
    if (goTurnRunning || goPlanning) return;
    const generation = goGeneration;
    goPlanning = true;
    try {
      await goTick(ctx, generation);
    } finally {
      goPlanning = false;
    }
  },
};

async function goTick(ctx: DriverContext, generation: number): Promise<void> {
    if (generation !== goGeneration) return;
    if (goTurnRunning) return;
    // A completed game/new-game transition needs a fresh central claim. A
    // failed turn uses this pass only to release the stale claim, then retains
    // the five-second retry backoff.
    if (goCompletionReady) {
      goCompletionReady = false;
      if (!goContinuationReady) return;
    }
    // Consume the edge. A successful action below raises it again when the
    // authoritative game promise resolves. Failure falls back to the normal
    // cadence, except for a one-pass stale-claim transition corrected below.
    goContinuationReady = false;
    const topic = ctx.state.topics.go;
    if (
      !topic?.status || !topic.currentPlayer || !topic.opponent || !topic.stats || !isGoRewardOpponent(topic.opponent)
    ) return;
    if (!goActionAdmitted(ctx.state, ctx.caps)) return;
    const claimedAction = goClaimAction(ctx.state, ctx.caps);
    const cheatUnlocked = goCheatUnlocked(ctx.caps);
    if (goRehydrate || !topic.board || !topic.boardSize || !topic.previousBoards
      || (cheatUnlocked && (!topic.cheat || !goCheatSuccessByCount))) {
      const hydrated = await act(
        ctx,
        "go",
        "hydrate",
        goMethods("hydrate", cheatUnlocked),
        (stubNs: NS) => ({
          board: stubNs["go"]["getBoardState"](),
          history: stubNs["go"]["getMoveHistory"](),
          cheat: cheatUnlocked ? {
            unlocked: true,
            count: stubNs["go"]["cheat"]["getCheatCount"](),
            successByCount: Array.from({ length: GO_CHEAT_CHANCE_SAMPLES }, (_, count) =>
              stubNs["go"]["cheat"]["getCheatSuccessChance"](count)),
          } : undefined,
        }),
        (value) => ({ ok: value.board.length > 0, detail: `read ${value.board.length}x${value.board.length} Go board` }),
      );
      if (generation !== goGeneration) return;
      if (hydrated) {
        if (hydrated.cheat) goCheatSuccessByCount = hydrated.cheat.successByCount;
        const boardSize = observedGoBoardSize(hydrated.board);
        const hydratedBoard = { rows: hydrated.board, size: boardSize };
        const controlled = goTerritory(hydratedBoard);
        // Komi is immutable opponent data; the pinned constant covers the gap
        // before the core probe has reported it, exactly as the planner view
        // does, so the score always lands with the board it describes.
        const hydratedKomi = topic.komi
          ?? (topic.opponent && isGoRewardOpponent(topic.opponent)
            ? GO_REWARD_RULES[topic.opponent].komi
            : undefined);
        const hydratedScore = hydratedKomi === undefined
          ? undefined
          : scoreBoard(hydratedBoard, hydratedKomi);
        merge(ctx.state, "go", {
          board: hydrated.board,
          boardSize,
          previousBoards: hydrated.history,
          moveCount: hydrated.history.length,
          territory: { black: controlled.X, white: controlled.O },
          ...(hydratedScore
            ? { blackScore: hydratedScore.X, whiteScore: hydratedScore.O, komi: hydratedKomi }
            : {}),
          ...(hydrated.cheat ? { cheat: {
            unlocked: true,
            count: hydrated.cheat.count,
            successChance: hydrated.cheat.successByCount[hydrated.cheat.count] ?? 0,
          } } : {}),
          boardUnverified: false,
          // Live state, not the `topic` snapshot taken above: merge replaces the
          // topic object, so a monotonic counter read from `topic` would reset.
          ...(goRehydrate ? {
            boardResyncs: (ctx.state.topics.go?.boardResyncs ?? 0) + 1,
            lastBoardResyncAt: Date.now(),
            ...(goRehydrateReason ? { lastBoardResyncReason: goRehydrateReason } : {}),
          } : {}),
        });
        goRehydrate = false;
        goRehydrateReason = undefined;
        // A rebuilt position invalidates the worker's committed parent and any
        // certified line the lost turns were on: both describe a board we no
        // longer believe we were ever on.
        goPredictionParent = undefined;
        resetGoPlaybookLine();
        // Wake rather than wait: recovery is hydrate -> play, not hydrate -> 5 s.
        goContinuationReady = true;
      }
      return;
    }
    if (
      goTurnReadyAt === undefined
      && claimedAction !== undefined
      && claimedAction !== "hydrate"
      && claimedAction !== "newGame"
    ) {
      // Cold start has no preceding Go promise to timestamp. The first pass
      // with a complete actionable Black position is its truthful boundary.
      // Every dispatching action kind is stamped, cheat turns included, so the
      // latency breakdown never has to invent a boundary it does not hold.
      goTurnReadyAt = Date.now();
    }
    const joined = new Set(ctx.state.topics.factions?.joined ?? []);
    const stats = topic.stats;
    const allowWorldDaemon = Boolean(ctx.state.topics.progression?.ownedAugs?.["The Red Pill"]);
    const nodeMults = effectiveBitNodeMultipliers(
      ctx.caps.bitNode,
      sfLevel(ctx.caps.sourceFiles, 12),
      ctx.state.topics.progression?.multipliers,
    );
    const installRemainingSec = installHorizonSec(ctx.horizons);
    const rewardOpponents: readonly GoRewardOpponent[] = allowWorldDaemon ? GO_REWARD_OPPONENTS : GO_OPPONENTS;
    // Certified entry windows for the wait-aware ranker. Measured only when a
    // new game could start, the phase clock is anchored, and cheats are
    // locked (certified lines are unreachable in cheat games, remaining.ts
    // playbookEnabled). Each lookup is a cheap worker table read; opponents
    // beyond their per-opponent wait cap are simply not offered aligned.
    let playbookEntries: Partial<Record<GoRewardOpponent, { waitSec: number; entryPlaytime: number }>> | undefined;
    if (claimedAction === "newGame" && goTickPhase && !cheatUnlocked) {
      const runtime = goNeuralRuntime();
      const routePlaytime = goPredictedPlaytime(goTickPhase, Date.now());
      // One round trip per routed opponent, ISSUED TOGETHER: they are
      // independent table reads against the same tick, and awaiting them in
      // series added a worker latency per opponent to every new-game pass.
      const routes = await Promise.all(
        Object.entries(GO_PLAYBOOK_OPPONENTS)
          .filter(([, config]) => config.maxWaitPhases > 0)
          .map(async ([opponent, config]) => ({
            opponent,
            config,
            route: await runtime.playbookRoute(routePlaytime, opponent).catch(() => undefined),
          })),
      );
      if (generation !== goGeneration) return;
      for (const { opponent, config, route } of routes) {
        if (!route || route.waits > config.maxWaitPhases) continue;
        (playbookEntries ??= {})[opponent as GoRewardOpponent] = {
          waitSec: route.waits * GO_ENGINE_CYCLE_MS / 1_000,
          entryPlaytime: route.entryPlaytime,
        };
      }
    }
    const goIncomeShares = incomeShares(ctx.state);
    // The income-maximising crime, for the only reward whose elasticity has a
    // reachable ceiling. Absent without SF4, and the leg is then omitted rather
    // than guessed — the missing source file hides the cap as well as the rate.
    const bestCrime = (ctx.state.topics.career?.crimes ?? [])
      .reduce<CrimeOption | undefined>((best, crime) => best === undefined || crime.moneyPerSec > best.moneyPerSec ? crime : best, undefined);
    const crimeIncome = bestCrime
      ? {
        successChance: bestCrime.chance,
        perSec: bestCrime.moneyPerSec,
        careerBestPerSec: careerBestPerSec(ctx.state),
      }
      : undefined;
    const rewardView = {
      opponents: rewardOpponents,
      stats,
      joinedFactions: joined,
      factionFavor: goFactionFavor(ctx),
      demands: goDemands({
        horizons: ctx.horizons,
        // LIVE gross shares, not the since-install ledger. `MoneySource.total`
        // is net of expenses, so a run that had bought Hacknet nodes reported a
        // hacknet share above one — pinned at the cap by the clamp — for as
        // long as the ledger stayed skewed.
        incomeShares: goIncomeShares,
        openNeeds: ctx.board.open,
        canEarnFactionRep: ctx.caps.unlocked.factions === "yes",
        canRunBladeburner: ctx.caps.unlocked.bladeburner === "yes",
        ...(crimeIncome ? { crimeIncome } : {}),
      }),
      goPower: nodeMults?.GoPower ?? 1,
      hasSourceFile14: sfLevel(ctx.caps.sourceFiles, 14) > 0,
      favorRepCap: goFavorRepCap(sfLevel(ctx.caps.sourceFiles, 14)),
      installRemainingSec,
      ...(playbookEntries ? { playbookEntries } : {}),
    } as const;
    const candidates = rankGoGames(rewardView);
    const schedule = planGoSchedule({
      candidates,
      cadenceSec: 5,
      fillerMarginFactor: GO_FILLER_MARGIN,
      fillerOverheadSec: GO_FILLER_OVERHEAD_SEC,
    });
    if (!schedule) return;
    // The game to start next: the filler when one fits the preferred entry
    // window, otherwise the preferred candidate itself. A hold starts nothing
    // this pass but the engine still plans toward the preferred target.
    const preferred = schedule.kind === "hold" ? schedule.preferred : schedule.game;
    // Decided BEFORE the plan is published, so a refusal to start is visible
    // instead of a silent early return: a quiet Go used to look identical
    // whether it had judged the next game not worth the dodge or had failed
    // outright, which is miserable to debug from a screenshot.
    const ramPie = ctx.state.topics.farm?.ramPie;
    const usableGb = ramPie ? ramPie.farm + ramPie.prep + ramPie.share + ramPie.free + ramPie.reserve : 0;
    const freeGb = ramPie?.free ?? 0;
    const ramSubject = goRamPricingCandidate(schedule);
    const ramGate = {
      pays: goGamePaysForRam(ramSubject.utilityPerSec, usableGb, freeGb),
      opponent: ramSubject.opponent,
      utilityPerSec: ramSubject.utilityPerSec,
      displacedGb: Math.max(0, GO_ESTIMATED_GB - Math.max(0, freeGb)),
      usableGb,
    };
    const view: GoView = {
      board: { rows: topic.board, size: topic.boardSize },
      currentPlayer: topic.currentPlayer,
      opponent: topic.opponent,
      status: topic.status,
      previousBoards: topic.previousBoards,
      // resetBoardState returns the new board before the core probe refreshes
      // its metadata. Komi is immutable opponent data, so use the pinned
      // public constant during that one-pass gap and keep live and arena
      // scoring identical.
      komi: topic.komi ?? GO_REWARD_RULES[topic.opponent].komi,
      // Mirrors the exact count the confirm path derives after a turn, so the
      // planner sees the same pass state either way. Our own pass followed by
      // theirs is two, which a response-only test cannot express.
      consecutivePasses: topic.lastTurn?.opponentResponse?.type === "pass"
        ? topic.lastTurn.action.type === "pass" ? 2 : 1
        : 0,
      bonusCycles: topic.bonusCycles ?? 0,
      // candidateLimit is deliberately absent: the engine resolves the
      // production finalist budget from GO_PROFILE_CANDIDATE_LIMITS (strict
      // K=1 for the policy-only daemon19 profile, including 7/9/13 boards;
      // K=4 for small5), so live play and the arenas share one contract.
      ...(topic.cheat && goCheatSuccessByCount ? { cheat: {
        unlocked: topic.cheat.unlocked,
        count: topic.cheat.count,
        successByCount: goCheatSuccessByCount,
        // Exact faction analysis dominates 19x19 latency on cheat-created
        // states. There the strongest family gets the whole budget; selectable
        // boards retain four finalists per topology-changing family.
        candidateLimit: topic.boardSize === 19 ? 0 : GO_CHEAT_CANDIDATE_LIMIT,
        doubleMoveLimit: topic.boardSize === 19 ? 1 : GO_CHEAT_DOUBLE_MOVE_LIMIT,
      } } : {}),
      nextGame: {
        opponent: preferred.opponent,
        boardSize: preferred.boardSize,
      },
    };
    // Re-anchor the engine-cycle phase before planning when it is unknown or
    // has drifted. This runs in its own small-RAM dodge and only when needed;
    // once anchored, the wall clock carries the phase across turns.
    const playerPlaytime = ctx.state.topics.player?.totalPlaytime;
    if (
      playerPlaytime !== undefined
      && goTickPhase
      && !goPhaseAgrees(goTickPhase, playerPlaytime, ctx.state.playerObservedAt ?? Date.now())
    ) {
      goTickPhase = undefined;
    }
    if (
      !goTickPhase
      && (claimedAction === "move" || claimedAction === "pass")
      && Date.now() - goAnchorFailedAt > GO_ANCHOR_RETRY_MS
    ) {
      const anchored = await act(
        ctx,
        "go",
        "align",
        goMethods("align"),
        (stubNs: NS) => observeGoTickPhase(stubNs),
        (value) => ({
          ok: value !== undefined,
          detail: value ? `anchored engine tick ${value.playtime}` : "no engine tick observed",
        }),
        "go",
      );
      if (generation !== goGeneration) return;
      if (anchored) goTickPhase = anchored;
      else goAnchorFailedAt = Date.now();
    }

    let decision: GoDecision;
    // Candidate enumeration and reply option spaces are seed-independent. The
    // exact seed-dependent half runs inside the dodge immediately before the
    // Go call. Preparation never waits for a chosen seed; only dispatch inside
    // the rollover guard may target the next tick and wait its short remainder.
    // This decision is provisional: it uses the last observed playtime only to
    // fix the action type for RAM pricing and publish a plan digest.
    const planStartedAt = Date.now();
    const neuralRuntime = goNeuralRuntime();
    const expectedPredictionParent = goPredictionParent;
    const playbookEnabled = view.status === "inProgress"
      && view.currentPlayer === "Black"
      && view.board.size === 5
      && GO_PLAYBOOK_OPPONENTS[view.opponent] !== undefined
      // Certified lines were proven against the plain rules. With cheats
      // unlocked the engine may dispatch a cheat action instead of a move,
      // whose board change is not on any certified line, and the turn's RAM
      // grant is priced for the claimed action — a playbook move substituted
      // into a cheat turn would not even be affordable. Cheat games therefore
      // stay purely neural.
      && view.cheat?.unlocked !== true;
    // A committed aligned start binds only the first Black move of its game.
    const committedEntry = playbookEnabled
      && goPlaybookEntry
      && goPlaybookEntry.opponent === view.opponent
      && view.previousBoards.length === 0
      ? goPlaybookEntry
      : undefined;
    const installed = await neuralRuntime.install(view, expectedPredictionParent);
    const preparationMs = installed.preparationMs;
    const provisionalAt = Date.now();
    const observedPlaytime = goTickPhase
      ? goPredictedPlaytime(goTickPhase, provisionalAt)
      : ctx.state.topics.player?.totalPlaytime ?? 0;
    if (playbookEnabled && goPlaybookPendingCredit) {
      if (observedPlaytime >= goPlaybookPendingCredit.atPlaytime) {
        goPlaybookCredit = goPlaybookPendingCredit.credit;
        goPlaybookPendingCredit = undefined;
      } else {
        // A certified align/sleep wait is in progress; the line resumes on a
        // later pass once the engine clock reaches the granted tick.
        goContinuationReady = true;
        return;
      }
    }
    const provisionalDispatch = goTickPhase
      ? goChooseSeedTarget(
        goTickPhase,
        observedPlaytime,
        provisionalAt,
        GO_DISPATCH_GUARD_MS,
        committedEntry?.entryPlaytime,
      ).targetPlaytime
      : observedPlaytime;
    // This first request also covers a cold position. On normal chained
    // turns the worker already holds both the position and likely seed set
    // because it evaluated them during the preceding White response.
    const provisionalEvaluation = await neuralRuntime.evaluate(
      installed.positionId,
      provisionalDispatch,
      expectedPredictionParent,
    );
    decision = provisionalEvaluation.decision;
    if (generation !== goGeneration) return;
    const certifiedProvisional = playbookEnabled
      ? await neuralRuntime.playbook(installed.positionId, provisionalDispatch, goPlaybookCredit)
        .catch(() => undefined)
      : undefined;
    if (generation !== goGeneration) return;
    const provisionalPlaybookAction = certifiedProvisional?.action;
    if (provisionalPlaybookAction?.kind === "align") {
      goPlaybookPendingCredit = {
        atPlaytime: provisionalDispatch + GO_ENGINE_CYCLE_MS,
        credit: certifiedProvisional!.alignmentBoards,
      };
      goContinuationReady = true;
      return;
    }
    if (provisionalPlaybookAction?.kind === "sleep"
      && provisionalPlaybookAction.variant <= GO_PLAYBOOK_MAX_SLEEP_PHASES) {
      goPlaybookPendingCredit = {
        atPlaytime: provisionalDispatch + provisionalPlaybookAction.variant * GO_ENGINE_CYCLE_MS,
        credit: certifiedProvisional!.alignmentCredit,
      };
      goContinuationReady = true;
      return;
    }
    if (provisionalPlaybookAction?.kind === "move") {
      decision = { ...decision, action: {
        type: "move",
        x: provisionalPlaybookAction.x,
        y: provisionalPlaybookAction.y,
      } };
    } else if (provisionalPlaybookAction?.kind === "pass") {
      decision = { ...decision, action: { type: "pass" } };
    }
    const decisionAt = Date.now();
    // Provisional planning ended here. The breakdown assembled at dispatch
    // uses this as the boundary between page-side preparation and the RAM
    // lease that follows.
    const preparedAt = decisionAt;
    const plan: GoPlan = {
      action: goActionDigest(decision.action),
      ranked: decision.ranked,
      input: {
        at: decisionAt,
        board: [...view.board.rows],
        previousBoards: view.previousBoards.map((position) => [...position]),
        status: view.status,
        currentPlayer: view.currentPlayer,
        komi: view.komi,
      },
      planning: { finalistCount: decision.finalists, positionValue: decision.positionValue },
      selection: {
        preferred,
        candidates,
        schedule: {
          kind: schedule.kind,
          ...(schedule.kind === "filler" ? { fillerOpponent: schedule.game.opponent } : {}),
          ...(schedule.kind === "hold" ? { holdSec: schedule.resumeInSec } : {}),
        },
        ramGate,
        context: {
          goPower: rewardView.goPower,
          hasSourceFile14: rewardView.hasSourceFile14,
          favorRepCap: rewardView.favorRepCap,
          installRemainingSec,
          joinedFactions: [...joined].sort(),
          // The single field that explains any ranking: which producer earns
          // what fraction of the run's dollars, and therefore how much of a
          // money bottleneck each reward can honestly claim.
          incomeShares: goIncomeShares,
          demands: rewardView.demands,
        },
      },
    };

    merge(ctx.state, "go", { plan });

    let action = decision.action;
    if (action.type === "newGame") {
      // The scheduler decided nothing fits before the preferred certified
      // entry: hold on the ordinary 5 s cadence without consuming the
      // makeMove-sized grant.
      if (schedule.kind === "hold") return;
      // Positive but vanishing Go power is not free: the dodge occupies RAM
      // the income engine could use. Decided above so the refusal is published
      // rather than a silent return.
      if (!ramGate.pays) return;
      const newGameAction = action;
      // Certified playbook lines are only reachable from a phase-aligned game
      // start. The opening board itself — obstacles and the Illuminati
      // handicap stone — is generated from the engine tick the game is created
      // in, so the reset, not merely the first move, has to land on the
      // route's entry phase. Only a candidate the scheduler selected AS
      // aligned confirms its route here — an unaligned or filler start must
      // never be captured by a nearby window the ranker already priced and
      // declined.
      goPlaybookEntry = undefined;
      const playbookStart = GO_PLAYBOOK_OPPONENTS[newGameAction.opponent];
      if (
        preferred.aligned
        && preferred.opponent === newGameAction.opponent
        && playbookStart
        && newGameAction.boardSize === 5
        && goTickPhase
      ) {
        // Confirm just before dispatch: waits computed at plan time drift
        // down one phase per 200 ms, and a slipped pass re-plans.
        const routeAt = Date.now();
        const route = await neuralRuntime
          .playbookRoute(goPredictedPlaytime(goTickPhase, routeAt), newGameAction.opponent)
          .catch(() => undefined);
        if (generation !== goGeneration) return;
        if (route && playbookStart.maxWaitPhases > 0 && route.waits <= playbookStart.maxWaitPhases) {
          // The schedule said play (wait within one cadence), so exceeding
          // the start slack here is a one-pass race at most: hold and re-plan.
          if (route.waits > GO_PLAYBOOK_START_SLACK_PHASES) return;
          goPlaybookEntry = { opponent: newGameAction.opponent, entryPlaytime: route.entryPlaytime };
        }
      }
      const alignedEntry = goPlaybookEntry;
      const actionStartedAt = Date.now();
      const reset = await act(
        ctx,
        "go",
        action.type,
        goMethods(action.type, cheatUnlocked, alignedEntry !== undefined),
        async (stubNs: NS) => {
          // A reset that lands in-game but whose stub then dies is a desync
          // source like any other dispatch, so invalidate before either call.
          invalidateGoMirror("a board reset was dispatched and its result never merged");
          if (!alignedEntry || !goTickPhase) {
            return stubNs["go"]["resetBoardState"](newGameAction.opponent, newGameAction.boardSize);
          }
          const seeded = await runGoNeuralSeedDispatch({
            phase: goTickPhase,
            notBeforePlaytime: alignedEntry.entryPlaytime,
            clock: {
              now: Date.now,
              player: () => stubNs["getPlayer"](),
              sleep: async (ms) => { await stubNs["sleep"](ms); },
            },
            infer: async () => undefined,
            dispatch: async () =>
              stubNs["go"]["resetBoardState"](newGameAction.opponent, newGameAction.boardSize),
          });
          goTickPhase = seeded.phase;
          return seeded.response;
        },
        (value) => ({
          ok: value !== undefined,
          detail: value
            ? `new ${value.length}x${value.length} game against ${newGameAction.opponent}`
            : `could not start a game against ${newGameAction.opponent}`,
        }),
      );
      if (generation !== goGeneration) return;
      const result = requireResult("go");
      const lastTurn: GoTurnResult = {
        at: result.at,
        durationMs: Date.now() - actionStartedAt,
        action: goActionDigest(action),
        ok: result.ok,
        detail: result.detail,
      };
      if (reset) {
        // A fresh game starts a fresh certified line at zero credit; a
        // committed goPlaybookEntry deliberately survives for its first move.
        resetGoPlaybookLine();
        goPredictionParent = undefined;
        // The new game's first Black turn has no preceding opponent promise to
        // time from; leaving the finished game's boundary here would report a
        // ready-to-play latency spanning the reset.
        goTurnReadyAt = undefined;
        // A new opponent has a different komi. Clear every board-derived value
        // until the core probe supplies that public metadata; retaining the
        // completed game's score would make the first new-game record lie.
        const fresh: NonNullable<typeof topic> = {
          ...topic,
          board: reset,
          boardSize: observedGoBoardSize(reset),
          previousBoards: [],
          moveCount: 0,
          currentPlayer: "Black",
          status: "inProgress",
          opponent: action.opponent,
          territory: { black: 0, white: 0 },
          // `fresh` is built from the PREVIOUS topic, so an unverified flag set
          // by the turn before this reset would survive into a board the game
          // itself just handed us.
          boardUnverified: false,
          ...(topic.cheat ? { cheat: { ...topic.cheat, count: 0 } } : {}),
          plan,
          lastTurn,
        };
        delete fresh.blackScore;
        delete fresh.whiteScore;
        delete fresh.komi;
        set(ctx.state, "go", fresh);
        // The one merge that is authoritative without a separate read:
        // resetBoardState RETURNS the game's own rows, and the history of a
        // fresh game genuinely is empty.
        goRehydrate = false;
        goRehydrateReason = undefined;
        goContinuationReady = true;
      } else {
        merge(ctx.state, "go", { plan, lastTurn });
        // The board can transition between action kinds while the prior plan
        // is still stored. Retry that bookkeeping mismatch next pass; do not
        // hot-loop genuine RAM denial or an unavailable host.
        if (claimedAction !== action.type) goContinuationReady = true;
      }
      return;
    }

    goTurnRunning = true;
    let turnCompleted = false;
    let continueImmediately = false;
    const runTurn = async (): Promise<void> => {
      const actionStartedAt = Date.now();
      const rawOutcome = await act(
        ctx,
        "go",
        action.type,
        goMethods(action.type, cheatUnlocked),
        async (stubNs: NS): Promise<GoActionOutcome> => {
          // The RAM broker admitted us and the dodge stub is running. Anything
          // before this instant is lease cost, not planning or alignment.
          const stubEnteredAt = Date.now();
          let finalizeMs = 0;
          let dispatchPlayer: ReturnType<NS["getPlayer"]> | undefined;
          let dispatchPlayerObservedAt: number | undefined;
          let dispatchedAction: GoPlayingAction | undefined = action.type === "resume" || action.type === "newGame"
            ? undefined : action;
          let dispatchedDecision: GoDecision | undefined;
          let dispatchPrediction: GoTurnPrediction | undefined;
          let predictionParentId: string | undefined;
          let boundaryRetries = 0;
          let response: RawGoResponse | undefined;
          let moveDispatchedAt: number | undefined;
          if (dispatchedAction) {
            const finalizeForSlot = async (
              player: ReturnType<NS["getPlayer"]>,
              target?: GoSeedTarget,
            ) => {
              const sampledAt = Date.now();
              // The AI seeds from the tick it is dispatched in, so forecast
              // for the tick this turn will actually land in rather than the
              // one that happens to be current while planning.
              const dispatchPlaytime = target?.targetPlaytime ?? player.totalPlaytime;
              // Usually this is a completed pushed result. A missed seed
              // still reuses the worker's prepared position and GPU weights;
              // the main game thread only performs this small RPC.
              // The provisional lookup normally targeted this exact slot. Do
              // not turn an already-consumed pushed result into a redundant
              // worker round trip during the final verified dispatch path.
              const evaluated = dispatchPlaytime === provisionalDispatch
                ? provisionalEvaluation
                : await neuralRuntime.evaluate(
                  installed.positionId,
                  dispatchPlaytime,
                  expectedPredictionParent,
                );
              const exactDecision = evaluated.decision;
              // The certified lookup is bound to the exact dispatch tick. A
              // boundary retry that slips the slot re-consults; when the new
              // slot is off the line (including an align/sleep there), the
              // neural decision for that same slot takes over.
              const certified = !playbookEnabled
                ? undefined
                : dispatchPlaytime === provisionalDispatch
                  ? certifiedProvisional
                  : await neuralRuntime.playbook(installed.positionId, dispatchPlaytime, goPlaybookCredit)
                    .catch(() => undefined);
              const certifiedAction = certified?.action;
              const playbookAction = certifiedAction?.kind === "move"
                ? { type: "move" as const, x: certifiedAction.x, y: certifiedAction.y }
                : certifiedAction?.kind === "pass"
                  ? { type: "pass" as const }
                  : undefined;
              const decisionAt = Date.now();
              finalizeMs += decisionAt - sampledAt;
              const exactAction = playbookAction ?? exactDecision.action;
              if (exactAction.type === "resume" || exactAction.type === "newGame") {
                throw new Error(`V9 returned ${exactAction.type} for an active Black turn`);
              }
              return {
                action: exactAction,
                decision: playbookAction ? { ...exactDecision, action: playbookAction } : exactDecision,
                playbookCertified: playbookAction ? certified : undefined,
                positionId: installed.positionId,
                seeds: evaluated.opponentSeeds,
                nextRolloverAt: target
                  ? target.rolloverAt + (target.waitsForRollover ? GO_ENGINE_CYCLE_MS : 0)
                  : undefined,
                // A certified move is not the committed neural action, so the
                // worker's push-ahead commit (which verifies its own decision)
                // is skipped; the next turn issues a fresh install/evaluate.
                continuationHints: playbookAction ? [] : evaluated.continuations,
                prediction: {
                  ...(playbookAction ? { playbook: true as const } : {}),
                  model: GO_OPPONENT_MODEL,
                  backend: evaluated.backend ?? "webgpu",
                  modelProfile: evaluated.modelProfile,
                  // Every board above 5x5 is rated by the 19x19 daemon weights
                  // on a padded board. That is V9's deliberate profile routing
                  // for the selectable intermediate sizes, but it is out of
                  // distribution and must be visible when such a game plays badly.
                  ...(evaluated.modelExtent !== view.board.size ? { paddedToExtent: evaluated.modelExtent } : {}),
                  sampledTotalPlaytime: player.totalPlaytime,
                  sampledAt,
                  decisionAt,
                  ...(preparationMs === undefined ? {} : { preparationMs }),
                  finalizationMs: evaluated.finalizationMs,
                  totalPlanningMs: decisionAt - planStartedAt,
                  engineCycleMs: GO_ENGINE_CYCLE_MS,
                  aiWaitMs: goAiWaitMs(topic.bonusCycles),
                  seedCandidates: evaluated.opponentSeeds,
                  dispatchPlaytime,
                  ...(target ? { rolloverMarginMs: target.marginMs, waitedForRollover: target.waitsForRollover } : {}),
                  positionCacheHit: installed.cached,
                  pushedPredictionHit: evaluated.pushed,
                  seedCacheHit: evaluated.cached,
                  // boundaryRetries is deliberately absent: this closure runs
                  // before the retry count is known. The dispatch site below
                  // supplies the settled value.
                } satisfies Omit<GoTurnPrediction, "boundaryRetries">,
              };
            };

            const seeded = await runGoNeuralSeedDispatch({
              phase: goTickPhase,
              ...(committedEntry ? { notBeforePlaytime: committedEntry.entryPlaytime } : {}),
              clock: {
                now: Date.now,
                player: () => stubNs["getPlayer"](),
                sleep: async (ms) => { await stubNs["sleep"](ms); },
              },
              infer: finalizeForSlot,
              dispatch: async (finalized): Promise<RawGoResponse> => {
                // A reset invalidates both the board and the prepared batch.
                // Check at the last possible instant, after inference and seed
                // assurance but before the irreversible Go call.
                if (generation !== goGeneration) throw new Error("Go generation changed before dispatch");
                const dispatchWallAt = Date.now();
                moveDispatchedAt = dispatchWallAt;
                // From here the game board and the mirror can only be reconciled
                // by observing the game. Anything that stops us reaching the
                // merge below leaves this set and the next pass rebuilds.
                invalidateGoMirror(GO_DISPATCH_UNMERGED);
                const responsePromise = finalized.action.type === "move"
                  ? stubNs["go"]["makeMove"](finalized.action.x, finalized.action.y)
                  : finalized.action.type === "pass"
                    ? stubNs["go"]["passTurn"]()
                    : finalized.action.type === "cheatTwoMoves"
                      ? stubNs["go"]["cheat"]["playTwoMoves"](
                        finalized.action.x1, finalized.action.y1,
                        finalized.action.x2, finalized.action.y2,
                      )
                      : finalized.action.type === "cheatRemoveRouter"
                        ? stubNs["go"]["cheat"]["removeRouter"](finalized.action.x, finalized.action.y)
                        : finalized.action.type === "cheatDestroyNode"
                          ? stubNs["go"]["cheat"]["destroyNode"](finalized.action.x, finalized.action.y)
                          : stubNs["go"]["cheat"]["repairOfflineNode"](finalized.action.x, finalized.action.y);
                // The game promise is now sleeping through White's response.
                // Start likely successor evaluations without awaiting them or
                // extending the RAM-holding main-thread dodge.
                if (finalized.continuationHints.length) {
                  predictionParentId = neuralRuntime.commit(
                    finalized.positionId,
                    finalized.prediction.dispatchPlaytime,
                    dispatchWallAt,
                    finalized.nextRolloverAt ?? dispatchWallAt + GO_ENGINE_CYCLE_MS,
                    finalized.action,
                    expectedPredictionParent,
                  );
                }
                return responsePromise;
              },
            });
            goTickPhase = seeded.phase;
            boundaryRetries = seeded.boundaryRetries;
            dispatchPlayer = seeded.attempt.player;
            dispatchPlayerObservedAt = seeded.attempt.observedAt;
            dispatchedAction = seeded.attempt.value.action;
            dispatchedDecision = seeded.attempt.value.decision;
            // Without a preceding boundary there is no honest span to report.
            // Substituting planStartedAt would publish a flattering few
            // milliseconds in exactly the cold-start case worth seeing.
            const latency = goTurnReadyAt !== undefined && moveDispatchedAt !== undefined
              ? goDispatchLatency({
                turnReadyAt: goTurnReadyAt,
                planStartedAt,
                preparedAt,
                actionStartedAt,
                stubEnteredAt,
                finalizeMs,
                alignMs: seeded.waitedMs,
                verifiedAt: seeded.attempt.observedAt,
                dispatchedAt: moveDispatchedAt,
              })
              : undefined;
            dispatchPrediction = {
              ...seeded.attempt.value.prediction,
              dispatchPlaytime: seeded.attempt.dispatchPlaytime,
              boundaryRetries,
              ...(latency ? { dispatchBreakdown: latency } : {}),
            };
            response = seeded.response;
            if (playbookEnabled) {
              // Every dispatched turn spends one board of alignment credit,
              // certified or not. The credit records how many further boards
              // the certificate proved under controlled timing — a property of
              // the environment and our own prompt dispatch, not of who chose
              // the move — and it is part of an entry's lookup key, so zeroing
              // it on a turn the network merely reproduced would strand the
              // rest of the line (the residual pass strips exactly such
              // entries). A genuine divergence yields a board and history no
              // entry on the line carries, so the surviving credit cannot
              // match a wrong entry.
              const dispatchedCertified = seeded.attempt.value.playbookCertified;
              goPlaybookCredit = Math.max(0,
                (dispatchedCertified?.alignmentCredit ?? goPlaybookCredit) - 1);
              goPlaybookPendingCredit = undefined;
            }
            if (goPlaybookEntry?.opponent === view.opponent) goPlaybookEntry = undefined;
          }
          if (response !== undefined) {
            // Seed-assured neural dispatch above already started and awaited
            // the Go action at the verified tick, and invalidated the mirror.
          } else if (dispatchedAction?.type === "move" || action.type === "resume" || dispatchedAction?.type === "pass") {
            // One statement for all three unseeded dispatch paths: each issues a
            // board-changing call, so from here the mirror is unproven.
            invalidateGoMirror(GO_DISPATCH_UNMERGED);
            if (dispatchedAction?.type === "move") {
              response = await stubNs["go"]["makeMove"](dispatchedAction.x, dispatchedAction.y);
            } else if (action.type === "resume") {
              // makeMove/passTurn already await this same promise. This branch only
              // reattaches after a restart interrupted an in-flight white turn.
              response = await stubNs["go"]["opponentNextTurn"](false, false);
            } else {
              response = await stubNs["go"]["passTurn"]();
            }
          } else {
            throw new Error(`invalid Go turn action ${action.type}`);
          }
          const responseReadyAt = Date.now();
          // Predictions are intentionally absent on the latency-bounded 19x19
          // cheat path. Observe this public state unconditionally so offline
          // bonus-cycle accounting never depends on speculative continuations.
          const responseBonusCycles = stubNs["go"]["getGameState"]().bonusCycles;
          // Resume turns have no worker commit to confirm and their RAM claim
          // intentionally excludes getPlayer. Only sample the compact clock
          // confirmation after a neural move actually armed the worker.
          const responsePlayer = predictionParentId ? stubNs["getPlayer"]() : undefined;
          const responseObservedAt = responsePlayer ? Date.now() : undefined;
          return {
            response,
            ...(dispatchPlayer ? { player: dispatchPlayer } : {}),
            ...(dispatchPlayerObservedAt !== undefined ? { playerObservedAt: dispatchPlayerObservedAt } : {}),
            ...(dispatchedAction ? { action: dispatchedAction } : {}),
            ...(dispatchedDecision ? { decision: dispatchedDecision } : {}),
            ...(dispatchPrediction ? { prediction: dispatchPrediction } : {}),
            ...(predictionParentId ? { predictionParentId } : {}),
            ...(responsePlayer ? { responsePlayer } : {}),
            ...(responseObservedAt !== undefined ? { responseObservedAt } : {}),
            responseReadyAt,
            responseBonusCycles,
          } satisfies GoActionOutcome;
        },
        (value) => ({
          ok: value.response !== undefined,
          detail: `${value.action?.type ?? action.type}; opponent ${value.response?.type}`,
        }),
        "go",
      );
      if (generation !== goGeneration) return;
      const result = requireResult("go");
      if (rawOutcome?.action && rawOutcome.decision) {
        action = rawOutcome.action;
        decision = rawOutcome.decision;
        plan.action = goActionDigest(decision.action);
        plan.ranked = decision.ranked;
        plan.planning = { finalistCount: decision.finalists, positionValue: decision.positionValue };
      }
      const dispatched = rawOutcome?.prediction;
      if (rawOutcome?.player) {
        set(ctx.state, "player", rawOutcome.player);
        ctx.state.playerObservedAt = rawOutcome.playerObservedAt ?? Date.now();
      }
      if (!rawOutcome?.response) {
        // Refused AFTER dispatch: the game may or may not have applied it, so
        // the mirror is unproven and goRehydrate is already set. The guard is
        // what keeps a PRE-dispatch failure (RAM denial, queueing, a missed seed
        // tick, a generation change) from forcing a pointless rebuild — the
        // discrimination is whether the call was issued, never its error text.
        if (goRehydrate) goRehydrateReason = `turn refused: ${result.detail}`;
        merge(ctx.state, "go", {
          plan,
          boardUnverified: goRehydrate,
          lastTurn: {
            at: result.at,
            durationMs: Date.now() - actionStartedAt,
            action: goActionDigest(action),
            ...(dispatched ? { prediction: dispatched } : {}),
            ok: result.ok,
            detail: result.detail,
          },
        });
        if (claimedAction !== action.type) goContinuationReady = true;
        return;
      }
      const response = normalizeGoResponse(rawOutcome.response);
      const bonusCyclesAfterResponse = rawOutcome.responseBonusCycles;

      // makeMove/passTurn returns the AI's actual public response. Advance the
      // held board immediately so the driver never replays a stale move while
      // waiting for the next 30 s probe sweep. No hidden AI state is inferred.
      let board = view.board;
      const previousBoards = [...view.previousBoards];
      if (action.type === "move") {
        const ours = playMove(board, action.x, action.y, "X", new Set(previousBoards.map((prior) => prior.join(""))));
        if (!ours) throw new Error(`Go rules drift: accepted move ${action.x},${action.y} was locally illegal`);
        previousBoards.unshift(board.rows);
        board = ours.board;
      } else if (isGoCheatAction(action)) {
        const cheated = applyGoCheat(board, action);
        if (!cheated) throw new Error(`Go rules drift: accepted ${action.type} was locally invalid`);
        // Upstream cheats do not push the pre-cheat board into positional-
        // superko history. White's subsequent ordinary placement pushes this
        // post-cheat board below.
        board = cheated.board;
      }
      if (response.type === "move") {
        const theirs = playMove(board, response.x, response.y, "O", new Set(previousBoards.map((prior) => prior.join(""))));
        if (!theirs) throw new Error(`Go rules drift: accepted AI move ${response.x},${response.y} was locally illegal`);
        previousBoards.unshift(board.rows);
        board = theirs.board;
      }
      if (rawOutcome.predictionParentId && rawOutcome.responsePlayer && rawOutcome.responseObservedAt !== undefined) {
        const confirmedPositionId = goNeuralPositionIdentity({
          ...view,
          board,
          previousBoards,
          currentPlayer: response.type === "gameOver" ? "None" : "Black",
          status: response.type === "gameOver" ? "gameOver" : "inProgress",
          consecutivePasses: response.type === "move" ? 0 : action.type === "pass" ? 2 : 1,
          ...(bonusCyclesAfterResponse !== undefined ? { bonusCycles: bonusCyclesAfterResponse } : {}),
          ...(view.cheat ? { cheat: {
            ...view.cheat,
            count: view.cheat.count + (isGoCheatAction(action) ? 1 : 0),
          } } : {}),
        }).id;
        neuralRuntime.confirm(
          rawOutcome.predictionParentId,
          response,
          confirmedPositionId,
          rawOutcome.responsePlayer.totalPlaytime,
          rawOutcome.responseObservedAt,
        );
        set(ctx.state, "player", rawOutcome.responsePlayer);
        ctx.state.playerObservedAt = rawOutcome.responseObservedAt;
      }
      const predicted = decision.forecast ?? [];
      const predictionTotal = predicted.reduce((sum, candidate) => sum + candidate.count, 0);
      const matching = predicted.reduce((sum, candidate) => {
        const matches = response.type === "move"
          ? candidate.x === response.x && candidate.y === response.y
          : candidate.x === null && candidate.y === null;
        return sum + (matches ? candidate.count : 0);
      }, 0);
      const controlled = goTerritory(board);
      const score = scoreBoard(board, view.komi);
      // Hoisted out of the merge so the verification below can republish it with
      // its own result attached.
      const lastTurn: GoTurnResult = {
        at: result.at,
        durationMs: Date.now() - actionStartedAt,
        action: goActionDigest(action),
        opponentResponse: response,
        ...(dispatched ? { prediction: dispatched } : {}),
        ...(predictionTotal > 0 ? { predictionSupport: { matching, total: predictionTotal } } : {}),
        ok: result.ok,
        detail: result.detail,
      };
      merge(ctx.state, "go", {
        board: board.rows,
        previousBoards,
        moveCount: previousBoards.length,
        ...(bonusCyclesAfterResponse !== undefined ? { bonusCycles: bonusCyclesAfterResponse } : {}),
        ...(topic.cheat ? { cheat: {
          ...topic.cheat,
          count: topic.cheat.count + (isGoCheatAction(action) ? 1 : 0),
          successChance: goCheatSuccessByCount?.[
            topic.cheat.count + (isGoCheatAction(action) ? 1 : 0)
          ] ?? 0,
        } } : {}),
        territory: { black: controlled.X, white: controlled.O },
        blackScore: score.X,
        whiteScore: score.O,
        komi: view.komi,
        currentPlayer: response.type === "gameOver" ? "None" : "Black",
        status: response.type === "gameOver" ? "gameOver" : "inProgress",
        plan,
        lastTurn,
      });

      // The mirror was advanced by applying rules LOCALLY. Prove it against the
      // game before the next turn plans on it.
      //
      // Its own small ordinary-lane dodge, deliberately: go.getBoardState is
      // 4 GB and must not enlarge the turn's contiguous long-lane grant, and
      // nothing may be inserted between the verified clock read and makeMove
      // (go-neural.ts, runGoNeuralSeedDispatch). Running it here costs neither —
      // the game board is settled, White has already replied, and no Go promise
      // is outstanding.
      //
      // ORDERING: verifyGoMirror calls act(), which overwrites results["go"].
      // That is safe only because requireResult("go") was consumed above and
      // `lastTurn` was already built from it.
      const verified = response.type === "gameOver"
        ? { result: "skipped" as const, ms: 0, scope: undefined }
        : await verifyGoMirror(ctx, board.rows, previousBoards);
      if (generation !== goGeneration) return;
      if (verified.result === "match" || verified.result === "skipped") {
        goRehydrate = false;
        goRehydrateReason = undefined;
      } else if (verified.result === "drift") {
        invalidateGoMirror(verified.scope === "history"
          ? "the game move history disagreed with the simulated mirror"
          : "the game board disagreed with the simulated mirror");
      } else {
        // "unavailable" deliberately leaves the mirror invalidated: an unproven
        // mirror degrades into a hydrate, which reads board AND history — a
        // superset of what this verification would have told us. It gets its
        // own reason, though. The turn itself merged, so carrying the
        // dispatch-time reason forward would tell the panel a desync happened
        // when in fact only the proof could not be placed.
        invalidateGoMirror("the post-turn board verification could not be placed");
      }
      merge(ctx.state, "go", {
        boardUnverified: goRehydrate,
        lastTurn: { ...lastTurn, boardVerify: { ms: verified.ms, result: verified.result } },
        // Live state, not the `topic` snapshot: merge replaced the topic object.
        ...(verified.result === "drift"
          ? {
            boardDrifts: (ctx.state.topics.go?.boardDrifts ?? 0) + 1,
            lastBoardDriftAt: Date.now(),
          }
          : {}),
      });
      // A drifted position means the worker's committed parent and the certified
      // alignment credit both describe a board that never existed.
      goPredictionParent = response.type === "gameOver" || goRehydrate
        ? undefined
        : rawOutcome.predictionParentId;
      if (goRehydrate) resetGoPlaybookLine();
      goTurnReadyAt = response.type === "gameOver" ? undefined : rawOutcome.responseReadyAt;
      turnCompleted = true;
      continueImmediately = response.type !== "gameOver";
      goContinuationReady = false;
    };
    void runTurn().catch((error: unknown) => {
      if (!isScriptDeath(error)) record("go", action.type, false, String(error));
    }).finally(() => {
      if (generation !== goGeneration) return;
      goTurnRunning = false;
      if (continueImmediately) {
        // The opponent and worker cleanup are complete; dispatch the next turn
        // without waiting for the controller cadence.
        void Promise.resolve().then(() => go.tick(ctx)).catch((error: unknown) => {
          if (!isScriptDeath(error)) record("go", "continue", false, String(error));
        });
        return;
      }
      goCompletionReady = true;
      // A finished game should select/start the next one on the next central
      // pass. Failure releases the claim now but retries on ordinary cadence.
      goContinuationReady = turnCompleted;
    });
}

// --- stanek -----------------------------------------------------------------

const stanek: FeatureDriver = {
  id: "stanek",
  // Normal charging takes 1,000 ms; stored cycles shorten the API delay to
  // 200 ms. This driver is awaited in the controller's serial feature loop,
  // so charging on that same one-second cadence would monopolise the loop and
  // starve the 200 ms hacking dispatcher. Thirty seconds is a policy tradeoff:
  // it charges opportunistically without making a long Netscript call hot.
  // Source: https://github.com/bitburner-official/bitburner-src/blob/3162fd2590e221eadd0c0fbd46151913f7c4c41c/src/NetscriptFunctions/Stanek.ts#L45-L54
  everyMs: 30_000,
  requires: "stanek",
  async tick(ctx: DriverContext) {
    const topic = ctx.state.topics.stanek;
    if (!topic) return;

    // Old telemetry records did not include shape. Skip those definitions;
    // treating an unknown footprint as one cell would fabricate a packing.
    const fragments = (topic.availableTypes ?? []).flatMap((entry) => entry.shape ? [{
      id: entry.id,
      shape: entry.shape,
      power: entry.power,
      // Charging value comes from the board: a run that needs hacking charges
      // the hacking fragment.
      weight: entry.power,
    }] : []);

    const packed = packFragments(fragments, topic.width, topic.height);
    // Packing is advisory until clear/place execution is modeled. Charging a
    // hypothetical root can throw or charge the wrong fragment; use observed
    // active roots and exclude boosters, which the API rejects.
    const order = (topic.fragments ?? [])
      .filter((fragment) => fragment.chargeable !== false)
      .slice()
      .sort((a, b) => b.power - a.power || a.id - b.id)
      .map((fragment) => fragment.id);

    merge(ctx.state, "stanek", {
      plan: {
        placements: packed.placements,
        value: packed.value,
        approximated: packed.approximated,
        chargeOrder: order,
        ...(results["stanek"] ? { lastResult: results["stanek"] } : {}),
      },
    });

    // Charge the highest-value placed fragment.
    const first = order[0];
    if (first === undefined) return;
    const placement = topic.fragments.find((entry) => entry.id === first && entry.chargeable !== false);
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

/** What agents have told us, as opposed to what home can see for itself.
 *
 * Module-scope rather than on the store because it is the driver's working
 * memory: the store carries the published digest, this carries the full fact
 * set with each fact's observation time. `dnetModule.reset` clears it. */
let dnetKnowledge: DarknetKnowledge | undefined;
/** Cumulative response codes reported by agents. Kept next to the knowledge so
 * one reset clears both. */
let dnetCodes: Record<string, number> = {};
/** The controller's last spread verdict: how many plants it admitted and why it
 * refused the rest. A SNAPSHOT, replaced whole on each drain rather than
 * accumulated, because a standing refusal is one problem however many ticks
 * noticed it. Undefined until the first derivation lands. */
let dnetSpread: DnetSpreadReport | undefined;
/** The controller's last farm verdict, on the same snapshot discipline. */
let dnetFarm: DnetFarmReport | undefined;
/** The last bleed-gate verdict, on the same snapshot discipline as the two
 *  above. */
let dnetListen: DnetListenReport | undefined;
/** The last hold derivation: the pin, the push and the walk. */
let dnetHold: DnetHoldReport | undefined;
/** Karma spent opening caches this generation. Negative, and it SURVIVES an
 * install — which is the whole reason it is worth publishing rather than
 * logging: `gang` wants -54000 and a cache is free progress toward it. */
let dnetKarmaLoss = 0;
/** Log-grammar drift, as the controller last tallied it. Shapes, never lines —
 *  see `DarknetState.grammar`. */
let dnetGrammar: { unrecognised: number; shapes: Record<string, number> } | undefined;
/** When a `.d.cache` was last seen to land, held here so it survives a
 * controller death and is replayed to the replacement. The phishing cache
 * cooldown is NET-WIDE engine state exposed through no ns member at all. */
let dnetLastPhishCacheAt: number | undefined;
/** When the lab-cache install deferral was first raised, so it can EXPIRE.
 *
 * The asymmetry is the point and it is stated here because this is the variable
 * that enforces it: missing the deferral costs one augmentation's price scaling,
 * once. Blocking an install costs the whole cycle. */
let dnetLabCacheSince: number | undefined;
/** Credentials agents recovered, keyed by host.
 *
 * MODULE STATE AND NOTHING ELSE. It is never merged into a topic and never
 * sent: the telemetry rule permits holding state we do not send, and forbids the
 * reverse. What the panel gets is the boolean `credentialKnown` per host.
 *
 * Held here rather than only out in the darknet because an overseer dies with
 * its host, and re-cracking a net we already opened would be the most expensive
 * possible way to recover from a reboot. */
let dnetVault: Map<string, string> = new Map();
/** Darknet hosts HOME has backdoored, and the backoff that keeps a structurally
 *  impossible one from relaunching a stub every pass.
 *
 *  Home's own record rather than an observed fact, for the same reason the
 *  stasis set is the controller's: `singularity.installBackdoor` acts on the
 *  terminal's current server, so home is the only thing in the run that can
 *  install one — and `ns.getServer().backdoorInstalled` is 2 GB home does not
 *  spend on a host it already knows about. A restart clears the backdoor
 *  (~9%/tick on a backdoored host), so the set is trimmed whenever the host is
 *  seen to have gone and re-earned otherwise. */
let dnetBackdoored: Map<string, number> = new Map();
let dnetBackdoorNextAt = 0;
let dnetBackdoorInFlight = false;
/** What the backdoor policy last decided, published beside the other planners'
 *  refusals: `planBackdoors` spends only the FREE allowance, so "why not" is
 *  its usual answer and the only interesting one. */
let dnetBackdoorReport: { install: string[]; refused: Record<string, number>; examples: { host: string; why: string; detail: string }[] } | undefined;
/** The controller's own stasis set, as drained. Unioned with the dodged probe's
 *  reading, because the two see it at different cadences and a pinned host that
 *  reads as perishable costs a survey a minute for ever. */
let dnetStasisLinked: Set<string> = new Set();
/** The highest charisma a JOB said it needed. Today only the maze walker
 *  reports one, and it is folded into the career need `stepDarknet` already
 *  posts rather than into a second channel. */
let dnetCharismaNeeded: number | undefined;
/** Model ids the game produced that `shared/strategy/dnet/models.ts` does not
 * know. Counted rather than ignored: a non-empty tally is a game update or a
 * hole in our transcription, and both are things to hear about. */
let dnetUnknownModels: Record<string, number> = {};
/** Agent hosts seen this generation, and how many stopped reporting. The gap
 * between them is agent mortality — see spec/dnet.md's Observability note. */
let dnetAgentsSeen: Set<string> = new Set();
/** Residents the overseer last reported, keyed by HOST.
 *
 * A host keeps exactly one resident — that is the spawn-chain design — and the
 * overseer is tracked separately (`dnetOverseerBeatAt`), so nothing shares a
 * key. Keying by host is also what the map needs: the badge sits on a box. */
let dnetAgents: Map<string, DarknetAgentDigest & { host: string }> = new Map();
/** Residents the controller has lost since boot. Agent mortality, which out
 * there is the loss that actually matters: the channel does not drop data, hosts
 * drop agents. */
let dnetResidentsLost = 0;
/** When the overseer last said it was alive. Home cannot see into the darknet,
 * so this beat is the ONLY evidence the beachhead is still standing. */
/** How long a silent overseer is given before home re-seeds. Four missed beats
 * at the overseer's 15 s cadence: `darkweb` does reboot — there is a literature
 * file about it — and when it does, the coordinator dies with it. */
const OVERSEER_STALE_MS = 60_000;
/** First retry after a failed seed, doubling to the cap. A world where the seed
 * can never work must not re-exec every tick for ever. */
const DNET_SEED_BACKOFF_MS = 30_000;
/** Workers home keeps standing on `darkweb`: one observer and one breaker.
 * Two, not more, because `darkweb` is 16 GB and the deeper crew is planted from
 * out there rather than from here. */
const DNET_CREW_SIZE = 2;
const DNET_SEED_MAX_BACKOFF_MS = 5 * 60_000;

let dnetOverseerBeatAt = 0;
let dnetSeedAttempts = 0;
let dnetSeedNextAt = 0;
let dnetSeedBackoffMs = DNET_SEED_BACKOFF_MS;

/** Take what the darknet has learned, and hand it what only home can see.
 *
 * Every script the game runs shares one JS realm, so the controller's own object
 * IS reachable from here. That is not a shortcut past a game rule: what
 * preserves BN15's challenge is enforced by the engine — sessions are per-PID,
 * `probe()` is host-local, and the network kills your scripts.
 *
 * Four rules keep the handover honest:
 *
 * - `drain()` hands each observation over ONCE, so home cannot double-count.
 * - Home folds into knowledge IT owns, so a controller dying loses scheduling
 *   rather than the map.
 * - The generation is checked here, because agents outlive controllers and a
 *   live script from a dead run describes a world this one no longer shares.
 * - Credentials land in `dnetVault`, which is module state that is never merged
 *   into a topic and never sent. */
function drainDarknet(generation: string): {
  hosts: ReportHost[];
  attempts: { hostname: string; outcome: AttemptOutcome }[];
  residents: string[];
  drained: number;
  rejected: number;
  credentials: number;
} {
  const rendezvous = dnetRendezvous();
  if (!rendezvous) return { hosts: [], attempts: [], residents: [], drained: 0, rejected: 0, credentials: 0 };
  if (rendezvous.generation !== generation) {
    // A controller from a world this run no longer shares. Its facts describe a
    // darknet that was destroyed by the prestige that ended it.
    return { hosts: [], attempts: [], residents: [], drained: 0, rejected: 1, credentials: 0 };
  }
  const taken = rendezvous.drain();
  for (const entry of taken.credentials) {
    if (entry.hostname.length > 0) dnetVault.set(entry.hostname, entry.password);
  }
  for (const [code, count] of Object.entries(taken.codes)) {
    dnetCodes[code] = (dnetCodes[code] ?? 0) + Number(count);
  }
  if (taken.spread) dnetSpread = taken.spread;
  if (taken.farm) dnetFarm = taken.farm;
  if (taken.listen) dnetListen = taken.listen;
  if (taken.hold) dnetHold = taken.hold;
  for (const hostname of taken.stasisLinked ?? []) dnetStasisLinked.add(hostname);
  if (taken.charismaNeeded !== undefined) {
    dnetCharismaNeeded = Math.max(dnetCharismaNeeded ?? 0, taken.charismaNeeded);
  }
  // ACCUMULATED, not assigned: `drain()` hands over the karma spent since the
  // last drain and clears it, exactly as it does with `codes`. A controller
  // dies with its host out here, and assigning a re-seeded controller's
  // since-boot total would reset home's tally to zero for the rest of the run.
  if (taken.karmaLoss !== undefined) dnetKarmaLoss += taken.karmaLoss;
  if (taken.grammar) dnetGrammar = taken.grammar;
  if (taken.lastPhishCacheAt !== undefined) {
    dnetLastPhishCacheAt = Math.max(dnetLastPhishCacheAt ?? 0, taken.lastPhishCacheAt);
  }
  for (const resident of taken.residents) {
    // Every field of the drained resident IS a digest field — the digest is a
    // superset — so the record travels whole rather than being re-listed and
    // silently missing whatever counter is added next. `alive` is recomputed
    // from the beat window at publish time.
    dnetAgents.set(resident.host, { ...resident, role: "resident", alive: true });
  }
  dnetOverseerBeatAt = Math.max(dnetOverseerBeatAt, rendezvous.lastBeatAt);
  dnetResidentsLost += taken.residentsLost;
  return {
    // Straight through: a `ReportHost` already carries the timestamp of the job
    // that saw it, which is the only thing the fold needs.
    hosts: taken.hosts,
    attempts: taken.attempts,
    residents: taken.residents.map((resident) => resident.host),
    drained: taken.hosts.length,
    rejected: 0,
    credentials: taken.credentials.length,
  };
}

/** The darknet controller, if one is running. Typed access to the realm slot the
 * agents install, so home never reaches into `globalThis` by hand. */
function dnetRendezvous(): DnetRendezvous | undefined {
  return (globalThis as typeof globalThis & { dnet_overseer?: DnetRendezvous }).dnet_overseer;
}

const dnet: FeatureDriver = {
  id: "dnet",
  everyMs: 30_000,
  requires: "dnet",
  async tick(ctx: DriverContext) {
    const topic = ctx.state.topics.dnet;
    if (!topic) return;

    // The far net is learned ONLY from delivered reports. home's own probe can
    // see darkweb and nothing else, so without this the map stops at the first
    // hop. See spec/dnet.md.
    const now = Date.now();
    // The generation is the install epoch: agents survive a controller cold
    // boot and a build handoff, so a report has to be tied to the world it was
    // gathered in, not to this process.
    const progression = ctx.state.topics.progression;
    const generation = `${progression?.bitNode ?? 0}:${progression?.lastAugReset ?? 0}`;
    if (!dnetKnowledge || dnetKnowledge.generation !== generation) {
      dnetKnowledge = emptyKnowledge(generation);
      dnetCodes = {};
    }
    const {
      hosts: reported,
      attempts: reportedAttempts,
      residents,
      drained,
      rejected,
      credentials: vaultDrained,
    } = drainDarknet(generation);
    const rendezvous = dnetRendezvous();
    const bitNode = progression?.bitNode ?? 1;
    // A stasis-linked host is outside the mutation clock entirely, and WE are the
    // only thing that links or releases one — so the set comes from here rather
    // than from an observed fact that could itself go stale.
    // `getNetDepth()` IS the current labyrinth's depth, and all eight lab servers
    // are constructed with the net itself — so one sighting of any of them pins
    // the net's depth exactly, long before it is reachable. That matters twice
    // over: the mutation clock is `30_000 / netDepth`, so without a sighting
    // every staleness expiry below runs on the `DEFAULT_NET_DEPTH` fallback
    // instead of the real depth, and the map cannot draw the rows we have not
    // reached without knowing how many there are. Carried over from the topic
    // between sightings, since it only changes when a lab is completed.
    const netDepth = netDepthFromLabs(Object.keys(dnetKnowledge.hosts)) ?? topic.netDepth;
    const expiry: ExpiryOpts = {
      bitNode,
      ...(netDepth !== undefined ? { netDepth } : {}),
      // Both sources, because they see the set at different cadences: the
      // dodged probe reads `getStasisLinkedServers` when it happens to run, and
      // the controller knows every link it spent the moment it spent one.
      stasisLinked: new Set([...(topic.stasisLinked ?? []), ...dnetStasisLinked]),
    };
    // Home's own probe is folded as one more vantage rather than kept beside the
    // map in a second shape. It is the only source for `darkweb` until a resident
    // is standing out there, and it costs nothing to merge.
    const folded = foldReports(dnetKnowledge, [...(topic.probed ?? []), ...reported], now, expiry);
    dnetKnowledge = folded.knowledge;
    // Attempt outcomes fold into home's OWN ledger — the same helper the
    // controller uses — so the panel's cracking progress survives a controller
    // death the way the map does. An unknown-model outcome is also the only
    // channel that ever populates `unknownModels`: the overseer detects the
    // case, but only home accumulates it across controller lifetimes.
    for (const { hostname, outcome } of reportedAttempts) {
      foldAttempts(dnetKnowledge.hosts[hostname], [outcome]);
      if (outcome.status === "unknown-model") {
        const id = outcome.modelId ?? "(no model id)";
        dnetUnknownModels[id] = (dnetUnknownModels[id] ?? 0) + 1;
      }
    }
    // A host we hold a credential for is flagged on the knowledge record so the
    // fold can drop the flag when the host disappears — the credential itself
    // stays in the vault and out of everything that is published.
    for (const hostname of dnetVault.keys()) {
      const host = dnetKnowledge.hosts[hostname];
      if (host && host.goneAt === undefined) host.credentialKnown = true;
    }
    // A vault entry for a host that has gone is dead weight: the host returns
    // cleaned, with a new password, so keeping it would hand a stale credential
    // to the next attempt and burn a call proving it wrong.
    for (const hostname of [...dnetVault.keys()]) {
      const host = dnetKnowledge.hosts[hostname];
      if (!host || host.goneAt !== undefined) dnetVault.delete(hostname);
    }
    // The hosts that actually reported, so `seenEver - live` is agent mortality
    // rather than a count of the one label a drain used to carry.
    for (const host of residents) dnetAgentsSeen.add(host);
    const cover = coverage(dnetKnowledge, now, expiry);
    // From the FOLD, for the same reason `topologyComplete` is. Home's probe
    // computes this over its own one hop, and `probe()` is HOST-LOCAL — so from
    // home it sees `darkweb` and nothing else, and darkweb's depth is -1. The
    // number could therefore never be anything but -1, however far the crawler
    // had actually spread, which is exactly what the panel kept reporting.
    const deepest = Object.values(dnetKnowledge.hosts).reduce((found, host) => {
      if (host.goneAt !== undefined) return found;
      const depth = fresh<number>(host, "depth", now, {
        ...expiry,
        immune: isImmune(host, { stasisLinked: expiry.stasisLinked }),
      });
      return depth !== undefined && depth > found ? depth : found;
    }, -1);
    // Topology completeness is a property of the FOLD, not of home's own probe —
    // which hardcodes false because it can only ever see one hop. Deriving it
    // here is what makes it reachable at all: it becomes true the first time
    // every host we know about has a neighbour list we still believe, which is
    // exactly the condition `reachableFrom` needs to be an exact answer rather
    // than a partial graph presented as one.
    const topologyComplete = cover.known > 0 && cover.adjacencyKnown === cover.known;
    // --- the labyrinth cache, and the one rule that governs it --------------
    //
    // `getLabReward` calls `Player.queueAugmentation` directly, and the generic
    // augmentation price multiplier is `1.9 ^ (queued non-SoA)` charged against
    // every purchase made after it. The labyrinth six are not SoA-exempt, so
    // opening a lab cache mid-shopping-trip multiplies the rest of the cycle's
    // bill by 1.9x — and it silently invalidates the drainOrder and drainCeiling
    // `shared/strategy/factions/` froze, because the price context moved under
    // them. So it is held until the last purchase of an install cycle.
    //
    // `openable` is a conjunction of things we have OBSERVED, and every term is
    // there because `progression` raises an INSTALL BLOCKER off this value:
    //
    //   the cache file is known to exist, AND the host is online, AND a live
    //   resident is standing on it.
    //
    // Anything else — no file, no resident, the lab offline, the maze never
    // walked — publishes nothing at all and the install proceeds unchanged. The
    // asymmetry is deliberate: missing the deferral costs one augmentation's
    // price scaling once; blocking an install costs the whole cycle.
    let labCache: { host: string; filename: string; openable: boolean } | undefined;
    for (const host of Object.values(dnetKnowledge.hosts)) {
      if (!isLabyrinth(host.hostname, fresh<string>(host, "modelId", now, expiry))) continue;
      const files = fresh<string[]>(host, "caches", now, expiry) ?? [];
      const filename = [...files].sort()[0];
      if (filename === undefined) continue;
      const resident = dnetAgents.get(host.hostname);
      labCache = {
        host: host.hostname,
        filename,
        openable: host.goneAt === undefined
          && resident !== undefined
          && now - resident.lastBeatAt < OVERSEER_STALE_MS,
      };
      break;
    }
    // Work in flight, summed from each resident's last report. Live residents
    // only: a dead one's queue died with it, so counting its pending jobs would
    // report work that no longer exists.
    const liveResidents = [...dnetAgents.values()].filter((agent) => now - agent.lastBeatAt < OVERSEER_STALE_MS);
    const activeByKind: Record<string, number> = {};
    for (const agent of liveResidents) {
      if (agent.active !== undefined) activeByKind[agent.active] = (activeByKind[agent.active] ?? 0) + 1;
    }
    merge(ctx.state, "dnet", {
      channel: {
        drained,
        rejected,
        forgotten: folded.hostsForgotten.length,
        vaultDrained,
      },
      coverage: cover,
      codes: { ...dnetCodes },
      // Beside the response codes, and for the same reason: our own planner's
      // refusals are as attributable as the game's. Without this, removing the
      // three invented spread caps would have been unobservable.
      ...(dnetSpread ? { spread: dnetSpread } : {}),
      // The farm's own refusals, beside the spread's. Both answer "what did the
      // planner decline, and by what name".
      // The phishing window rides the farm block, because that is where its
      // reader is. The stamp is the only part that travels: the three-minute
      // interval is a constant, and the countdown is arithmetic.
      ...(dnetFarm
        ? {
          farm: {
            ...dnetFarm,
            ...(dnetLastPhishCacheAt !== undefined ? { lastPhishCacheAt: dnetLastPhishCacheAt } : {}),
          },
        }
        : {}),
      ...(dnetListen ? { listen: dnetListen } : {}),
      // The deliberate three, beside the farm and the spread and for the same
      // reason: each has a real price, so "why not" is the common answer.
      ...(dnetHold || dnetBackdoorReport
        ? {
          hold: {
            ...(dnetHold ?? { admitted: {}, refused: {}, examples: [] }),
            ...(dnetBackdoorReport ? { backdoors: dnetBackdoorReport } : {}),
          },
        }
        : {}),
      ...(dnetKarmaLoss !== 0 ? { karmaLoss: dnetKarmaLoss } : {}),
      ...(dnetGrammar ? { grammar: dnetGrammar } : {}),
      ...(labCache ? { labCache } : {}),
      // THE MAP, and the only host representation the topic carries.
      knowledge: publishKnowledge(dnetKnowledge, now, {
        bitNode,
        // Without this the digest's own staleness ran on the default depth while
        // the tick above ran on the real one, so the panel and the driver could
        // disagree about what was still believable.
        ...(netDepth !== undefined ? { netDepth } : {}),
        stasisLinked: expiry.stasisLinked,
        vault: new Set(dnetVault.keys()),
        unknownModels: dnetUnknownModels,
        // Published by HOST, because that is what the map draws a badge on. The
        // freshest agent on a host wins, so a host with a live worker never
        // reads as abandoned because a dead one shares it.
        agents: Object.fromEntries(
          [...dnetAgents.values()]
            .sort((a, b) => a.lastBeatAt - b.lastBeatAt)
            .map(({ host, ...digest }) => [
              host,
              // Only "alive" while the beat is recent. A roster that never
              // expired would report a full crew on a net that has lost every
              // one of them, which is exactly the number worth watching.
              { ...digest, alive: now - digest.lastBeatAt < OVERSEER_STALE_MS },
            ]),
        ),
        agentsLost: [...dnetAgents.values()].filter((agent) => now - agent.lastBeatAt >= OVERSEER_STALE_MS).length,
        agentsSeenEver: Math.max(dnetAgentsSeen.size, dnetAgents.size),
        overseer: {
          host: "darkweb",
          lastBeatAt: dnetOverseerBeatAt,
          alive: now - dnetOverseerBeatAt < OVERSEER_STALE_MS,
          seedAttempts: dnetSeedAttempts,
        },
        queue: {
          pending: liveResidents.reduce((sum, agent) => sum + (agent.pending ?? 0), 0),
          active: Object.values(activeByKind).reduce((sum, count) => sum + count, 0),
          byKind: activeByKind,
        },
      }),
      ...(netDepth !== undefined ? { netDepth } : {}),
      maxDepth: deepest,
      mutationIntervalMs: mutationIntervalMs(netDepth, bitNode),
      charisma: ctx.state.topics.player?.skills.charisma ?? 1,
      topologyComplete,
    });
    const decision = stepDarknet({
      topologyComplete,
      // From the FOLD, not from home's one hop: the traversal is a
      // max-reachable-under-a-budget problem, and it was being handed `darkweb`
      // and its neighbours as though that were the graph.
      servers: Object.values(dnetKnowledge.hosts).map((host) => {
        const neighbours = fresh<string[]>(host, "neighbours", now, expiry);
        return {
          hostname: host.hostname,
          // -1 is darkweb's real depth AND our "no believable position", which is
          // safe here because the traversal only ever tests `depth === 0` to seed
          // its walk: a host we cannot place must not seed one either.
          depth: fresh<number>(host, "depth", now, expiry) ?? -1,
          // A missing value means "not known", and the strategy only ever
          // compares it as a capacity, so treat it as none.
          blockedRam: fresh<number>(host, "blockedRam", now, expiry) ?? 0,
          isOnline: host.goneAt === undefined,
          requiredCharisma: fresh<number>(host, "requiredCharisma", now, expiry) ?? 0,
          stasisLinked: expiry.stasisLinked?.has(host.hostname) === true,
          ...(neighbours ? { neighbours } : {}),
        };
      }),
      stasisLinked: topic.stasisLinked ?? [],
      charisma: ctx.state.topics.player?.skills.charisma ?? 1,
    });

    merge(ctx.state, "dnet", {
      plan: {
        ranked: decision.ranked.slice(0, 8).map((entry) => ({
          hostname: entry.hostname,
          depth: entry.depth,
          unlocks: entry.unlocks,
        })),
        // Two sources, one channel. `stepDarknet` reads the map and says what
        // the next host would cost; the maze walker reports what the ENGINE
        // refused it. The higher of the two is the one that unblocks anything.
        ...(Math.max(decision.charismaNeeded ?? 0, dnetCharismaNeeded ?? 0) > 0
          ? { charismaNeeded: Math.max(decision.charismaNeeded ?? 0, dnetCharismaNeeded ?? 0) }
          : {}),
        ...(results["dnet"] ? { lastResult: results["dnet"] } : {}),
      },
    });

    // --- the beachhead ------------------------------------------------------
    //
    // Everything above this point observes. This is the only part that ACTS, and
    // it does exactly one thing: put an overseer on `darkweb` and let it run the
    // net from there. home cannot play this feature itself — `probe()` is
    // host-local, so from here the darknet is one host wide — and it cannot hold
    // a session either, because a session belongs to the PID that won it and
    // home's controller (`start.js`) is pinned at 3.6 GB static.
    //
    // Pinned to `home` for a reason that is easy to get wrong: `ns.exec`
    // evaluates its direct-connection requirement BEFORE the darkweb early-out,
    // and only home holds the TOR edge. A stub anywhere else scps happily and
    // then gets a silent 0.
    const overseerAlive = now - dnetOverseerBeatAt < OVERSEER_STALE_MS;
    // A host keeps exactly ONE resident, and it is the only thing that can start
    // work there. Home plants the first two — the controller and darkweb's own
    // resident — and after that the net plants itself: a resident that opens a
    // neighbour scp's the agent across and execs a resident on it.
    //
    // Home keeps topping darkweb's resident up because a resident dies with its
    // host, and `darkweb` does reboot. Nothing else can put one back: planting
    // needs a session AND adjacency, and home is adjacent to nothing else.
    // Job-aware, not raw-beat: `lastBeatAt` freezes for the whole job — spawn
    // killed the resident, by design — and `JOB_TIMEOUT_MS` equals the stale
    // window, so a merely slow authenticate read as a dead resident and home
    // execed a SECOND agent onto darkweb while the first was still working.
    const darkwebResident = rendezvous?.queues.get("darkweb");
    const residentAlive = darkwebResident !== undefined
      && now - residentLastLife(darkwebResident) < OVERSEER_STALE_MS;
    if ((!overseerAlive || !residentAlive) && now >= dnetSeedNextAt
      && (topic.probed ?? []).some((server) => server.hostname === "darkweb")) {
      const buildId = gameBuildId();
      const controllerFile = versionedScript("dnet/overseer.js", buildId);
      const agentFile = versionedScript("dnet/agent.js", buildId);
      // The agent carries its identity in ns.args rather than reading the realm,
      // so a resident planted by a controller that has since died still knows
      // which run artifact its telemetry belongs to.
      const identity = JSON.stringify(gameGlobal.artifactIdentity ?? {});
      const charisma = ctx.state.topics.player?.skills.charisma ?? 1;
      const missionId = `dnet-${generation}-${Math.floor(now / 1000)}`;
      const controllerArgs = overseerArgs({ missionId, generation, identity, charisma, agentFile });
      const residentLaunchArgs = residentArgs({
        missionId,
        generation,
        identity,
        agentId: "resident-darkweb",
      });
      const wantController = !overseerAlive;

      const seeded = await featureDodgeOn(ctx, "dnet", "action:seed", ["scp", "exec"], "home", (stubNs: NS) => {
        // Both payloads in ONE scp. `exec` of a file that is not there returns 0,
        // which is indistinguishable from "the host is full" — the same trap
        // game/lib/net.ts documents for the dodge stub — so the agent must never
        // arrive without the controller beside it, or the other way round.
        if (!stubNs["scp"]([controllerFile, agentFile], "darkweb", "home")) {
          return { controller: 0, resident: 0, reason: "scp refused" };
        }
        // The controller is the durable half and holds the accumulated map, so a
        // live one is left strictly alone: restarting it to fix a missing
        // resident would throw the map away to solve a smaller problem.
        const controller = wantController
          ? stubNs["exec"](
            controllerFile,
            "darkweb",
            { threads: 1, ramOverride: priceAgent(stubNs, CONTROLLER_METHODS) },
            ...controllerArgs,
          )
          : -1;
        if (controller === 0) {
          return { controller, resident: 0, reason: "exec refused (darkweb full, or not synced)" };
        }
        const resident = stubNs["exec"](
          agentFile,
          "darkweb",
          { threads: 1, ramOverride: priceAgent(stubNs, RESIDENT_METHODS) },
          ...residentLaunchArgs,
        );
        return {
          controller,
          resident,
          reason: resident === 0 ? "no room on darkweb for a resident" : "",
        };
      });
      dnetSeedAttempts++;
      if (seeded.ok && seeded.value.controller !== 0 && seeded.value.resident !== 0) {
        record(
          "dnet",
          "seed",
          true,
          seeded.value.controller === -1
            ? `replaced darkweb's resident (pid ${seeded.value.resident})`
            : `controller pid ${seeded.value.controller}, resident pid ${seeded.value.resident}`,
        );
        dnetSeedBackoffMs = DNET_SEED_BACKOFF_MS;
      } else {
        record("dnet", "seed", false, seeded.ok ? seeded.value.reason : seeded.reason);
        // Exponential backoff. Without it, a world where the seed can never work
        // — not synced, no room, a node without access — re-execs on every tick
        // for ever, and the failure is loud in exactly the way that trains people
        // to ignore it.
        dnetSeedBackoffMs = Math.min(dnetSeedBackoffMs * 2, DNET_SEED_MAX_BACKOFF_MS);
      }
      dnetSeedNextAt = now + dnetSeedBackoffMs;
    }

    // Tell the controller what only home can see. It cannot afford `getPlayer`
    // (0.5 GB out of 1.65), and it needs charisma to know which hosts a job may
    // heartbleed at all. The vault is replayed with it so a restarted controller
    // does not re-crack a net we already opened.
    // The one darknet action home performs itself, and it performs it because
    // it is the only thing that can: a backdoor is installed on the TERMINAL's
    // current server. Spends only the free allowance, so most passes it decides
    // to do nothing and says why.
    await serveDarknetBackdoors(
      ctx,
      dnetKnowledge,
      now,
      expiry,
      netDepth,
      bitNode,
      ctx.state.topics.player?.skills.charisma ?? 1,
      topic.instability?.authenticationDurationMultiplier ?? 1,
    );

    // Symbols worth spreading propaganda about, and the bar is deliberately
    // high: `promoteStock` raises VOLATILITY and never forecast, so it
    // amplifies whatever edge a symbol already has in BOTH directions and is
    // worth nothing on a symbol we have no view on. The stock planner's own
    // ranking is that view — an entry it would take, priced net of commission —
    // and two symbols is as far as it is worth spreading a charge curve that
    // saturates. Usually empty, and the farm ladder says so by name.
    const promoteSymbols = (ctx.state.topics.stock?.plan?.ranked ?? [])
      .filter((entry) => entry.expectedProfit > 0)
      .slice(0, 2)
      .map((entry) => entry.sym);

    if (overseerAlive && rendezvous) {
      rendezvous.order({
        charisma: ctx.state.topics.player?.skills.charisma ?? 1,
        // The clock the controller's expiries run on. Home pins the real depth
        // from a lab sighting and knows which node this is; without the order
        // the controller sits on the shared defaults for ever and re-observes
        // more than it needs to. Both conditional: the controller's own default
        // (BN15, depth 5) errs toward re-observing, and ordering the `?? 1`
        // guess would DOUBLE its expiries in a BN15 run whose progression topic
        // has not landed — the unsafe direction.
        ...(netDepth !== undefined ? { netDepth } : {}),
        ...(progression?.bitNode !== undefined ? { bitNode } : {}),
        // The one permission home grants the farm ladder, and it is granted only
        // while `progression` is actually holding an install open for it. The
        // controller refuses a labyrinth cache by name otherwise.
        openLabCache: progression?.plan?.installBlockers?.includes("dnet-lab-cache") === true,
        // Three things only home can see, and every one of them is a term in a
        // decision the controller makes rather than a status line.
        //
        // The backdoor COUNT is a mutation rate: a backdoored host carries a
        // ~9%/tick restart and a ~4%/tick delete on top of the ordinary
        // branches, so every knowledge expiry out there is shorter once we hold
        // any. The stasis LIMIT is `1 + TheBrokenWings + TheHammer + TheStaff`,
        // read by the dodged probe. And the symbols are the market, which the
        // darknet cannot see at all.
        backdoored: dnetBackdoored.size,
        ...(promoteSymbols.length > 0 ? { promoteSymbols } : {}),
        // The net facts only the dodged probe can read. The controller PLANS
        // stasis — it is the only thing that knows which hosts have live
        // residents and which are irreplaceable — and it ACTS, because
        // `setStasisLink` pins the calling host. But it cannot see how many
        // links exist or which hosts already hold one, so those come from here.
        ...(topic.stasisLinkLimit !== undefined ? { stasisLimit: topic.stasisLinkLimit } : {}),
        ...(topic.stasisLinked !== undefined ? { stasisLinked: topic.stasisLinked } : {}),

        ...(dnetLastPhishCacheAt !== undefined ? { lastPhishCacheAt: dnetLastPhishCacheAt } : {}),
        ...(dnetVault.size > 0
          ? {
            vault: [...dnetVault].map(([hostname, password]) => ({
              hostname,
              password,
              via: "cracked" as const,
              at: now,
            })),
          }
          : {}),
      });
    }

    // Nothing follows. `stepDarknet` no longer proposes an action for home to
    // refuse: authentication happens in a job standing next door to its target,
    // and `setStasisLink` pins the CALLING host, so neither was ever something
    // this driver could carry out. The block that recorded those refusals went
    // with them — a standing refusal for work nobody was going to attempt is
    // noise in the one panel that exists to say why the net is stuck.
  },
};

/** ns members the darknet backdoor dodge calls. NO `scan`: `ns.scan` omits
 * darknet servers outright, so the BFS the hacking backdoor uses cannot find a
 * route out here at all — the route comes from the controller's folded
 * adjacency instead, which is the only place it exists. */
const DNET_BACKDOOR_CALLS = ["singularity.connect", "singularity.installBackdoor"] as const;
/** How long a failed darknet backdoor waits before it is tried again. Longer
 * than the hacking one's 30 s floor because the failure mode out here is a net
 * that moved, and it will have moved again in thirty seconds. */
const DNET_BACKDOOR_BACKOFF_MS = 120_000;

/** The terminal route from home to a darknet host, or nothing.
 *
 * `singularity.connect` walks `serversOnNetwork` one hop at a time, and darknet
 * edges ARE on it — so the walk is possible. What is not possible is finding it
 * the way the hacking backdoor does: `ns.scan` omits darknet servers, so its BFS
 * sees `darkweb` and stops. The graph has to come from the fold.
 *
 * Every hop is walked over a neighbour list we still BELIEVE, which is what the
 * `fresh` call does: a stale hop is not a slower route, it is a route that ends
 * with the terminal stranded somewhere deep while the net rearranges around it.
 * Adjacency is the shortest-lived fact we hold, so this refuses far more often
 * than it succeeds, and that is the correct ratio. */
export function darknetRoute(
  knowledge: DarknetKnowledge,
  target: string,
  now: number,
  expiry: ExpiryOpts,
): string[] | undefined {
  // `darkweb` is the one darknet host home is adjacent to — it holds the TOR
  // edge — so every route starts there and nowhere else.
  if (target === "darkweb") return ["darkweb"];
  const parents = new Map<string, string | undefined>([["darkweb", undefined]]);
  const queue = ["darkweb"];
  for (let index = 0; index < queue.length && !parents.has(target); index++) {
    const current = queue[index]!;
    const host = knowledge.hosts[current];
    if (!host || host.goneAt !== undefined) continue;
    const neighbours = fresh<string[]>(host, "neighbours", now, expiry);
    // A hop whose adjacency has expired is not a hop. Skipping it rather than
    // trusting it is the whole safety property here.
    if (neighbours === undefined) continue;
    for (const neighbour of neighbours) {
      if (parents.has(neighbour)) continue;
      parents.set(neighbour, current);
      queue.push(neighbour);
    }
  }
  if (!parents.has(target)) return undefined;
  const route: string[] = [];
  for (let at: string | undefined = target; at !== undefined; at = parents.get(at)) route.push(at);
  return route.reverse();
}

/** Install one backdoor on one darknet host, from home's terminal.
 *
 * Home-side and not a dnet job, because there is no other choice:
 * `singularity.installBackdoor` acts on `Player.getCurrentServer()` — the
 * TERMINAL's server — and only home has a terminal. A darknet backdoor is a
 * flat four seconds (`calculateHackingTime` returns 16 for a DarknetServer, and
 * the install is a quarter of it) and skips the hacking-skill gate entirely,
 * which is what makes it worth having at all.
 *
 * What it buys is remote `exec`: the reachability gate tests
 * `backdoorBypasses && backdoorInstalled` and nothing else, so a backdoored host
 * can be reached from anywhere rather than only from a neighbour. What it costs
 * is `1.07 ^ surplus` on EVERY authentication in the net past a free allowance
 * of `max(rootedMovable / 24, 2)` — which is why `planBackdoors` spends only the
 * allowance and why two are always free. */
async function serveDarknetBackdoors(
  ctx: DriverContext,
  knowledge: DarknetKnowledge,
  now: number,
  expiry: ExpiryOpts,
  netDepth: number | undefined,
  bitNode: number,
  charisma: number,
  instability: number,
): Promise<void> {
  const hosts: HoldHost[] = Object.values(knowledge.hosts).map((host) => {
    const neighbours = fresh<string[]>(host, "neighbours", now, expiry);
    const depth = fresh<number>(host, "depth", now, expiry);
    return {
      hostname: host.hostname,
      ...(depth !== undefined ? { depth } : {}),
      agentAlive: (dnetAgents.get(host.hostname)?.lastBeatAt ?? 0) > now - OVERSEER_STALE_MS,
      hasCredential: dnetVault.has(host.hostname),
      ...(neighbours !== undefined ? { neighbours } : {}),
      ...(fresh<boolean>(host, "isStationary", now, expiry) === true ? { isStationary: true } : {}),
      // A stasis link SETS `backdoorInstalled` (`effects.ts:234`), so a pinned
      // host already has one and is also outside the counted pool. Recording it
      // as backdoored is what stops us spending a four-second install on a host
      // that has been reachable all along.
      ...(dnetBackdoored.has(host.hostname) || dnetStasisLinked.has(host.hostname) ? { backdoored: true } : {}),
      ...(dnetStasisLinked.has(host.hostname) ? { stasisLinked: true } : {}),
      ...(host.goneAt !== undefined ? { gone: true } : {}),
    };
  });
  const plan = planBackdoors({
    hosts,
    netDepth: netDepth ?? DEFAULT_NET_DEPTH,
    stasisLimit: ctx.state.topics.dnet?.stasisLinkLimit ?? 1,
    charisma,
    authDurationMultiplier: instability,
  });
  const byReason: Record<string, number> = {};
  const examples: { host: string; why: string; detail: string }[] = [];
  for (const refusal of plan.refused) {
    byReason[refusal.why] = (byReason[refusal.why] ?? 0) + 1;
    if (byReason[refusal.why] === 1) {
      examples.push({ host: refusal.hostname, why: refusal.why, detail: refusal.detail });
    }
  }
  dnetBackdoorReport = { install: plan.install, refused: byReason, examples };

  if (dnetBackdoorInFlight || now < dnetBackdoorNextAt) return;
  // THE BELIEF EXPIRES, exactly as every other darknet fact does. A backdoored
  // host carries a ~9%/tick restart and a restart CLEARS the backdoor
  // (`restartServer` drops `backdoorInstalled`), and nothing home can afford
  // observes it: `ns.getServer` is 2 GB and no darknet server detail reports
  // one. So the install is a stamped fact checked against the mutation clock —
  // and holding it past its life is the expensive direction twice over, because
  // it both suppresses the re-install and inflates the instability count the
  // controller runs its expiries on.
  const backdoorLife = msPerHostEventAny(
    ["restarted", "deleted"],
    netDepth ?? DEFAULT_NET_DEPTH,
    bitNode,
    dnetBackdoored.size,
  );
  for (const [hostname, installedAt] of [...dnetBackdoored]) {
    const host = knowledge.hosts[hostname];
    if (!host || host.goneAt !== undefined || now - installedAt > backdoorLife) {
      dnetBackdoored.delete(hostname);
    }
  }
  const target = plan.install[0];
  if (target === undefined) return;
  const route = darknetRoute(knowledge, target, now, expiry);
  if (route === undefined) {
    // Not a failure to record against the host: the map is stale, which the
    // next survey fixes on its own.
    dnetBackdoorNextAt = now + DNET_BACKDOOR_BACKOFF_MS;
    dnetBackdoorReport.refused["stale-route"] = (dnetBackdoorReport.refused["stale-route"] ?? 0) + 1;
    dnetBackdoorReport.examples.push({
      host: target,
      why: "stale-route",
      detail: "no hop-by-hop route from darkweb whose every adjacency we still believe",
    });
    return;
  }
  dnetBackdoorInFlight = true;
  try {
    const outcome = await featureDodgeOn(ctx, "dnet", "action:backdoor", DNET_BACKDOOR_CALLS, "home", async (stubNs: NS) => {
      // Home first, always: the terminal is global state and some other dodge
      // may have left it anywhere. Without this the first hop is measured from
      // a server we are not on and the walk fails at step one.
      if (!stubNs["singularity"]["connect"]("home" as never)) {
        throw new Error("could not return the terminal to home");
      }
      for (const hop of route) {
        if (!stubNs["singularity"]["connect"](hop as never)) {
          throw new Error(`route to ${target} failed at ${hop}`);
        }
      }
      await stubNs["singularity"]["installBackdoor"]();
      // Back to home rather than left deep in the net. While the terminal is
      // ON a darknet server that server is `isImmutable` and cannot be moved —
      // which sounds useful and is not: it is one host pinned by accident, and
      // every other backdoor and every terminal-using dodge would start from
      // wherever this one stopped.
      stubNs["singularity"]["connect"]("home" as never);
      return route.length;
    });
    if (outcome.ok) {
      dnetBackdoored.set(target, Date.now());
      record("dnet", "backdoor", true, `${target} backdoored, ${outcome.value} hops out`);
    } else if (!outcome.queued) {
      dnetBackdoorNextAt = now + DNET_BACKDOOR_BACKOFF_MS;
      record("dnet", "backdoor", false, outcome.reason);
    }
  } catch (error) {
    if (isScriptDeath(error)) throw error;
    dnetBackdoorNextAt = now + DNET_BACKDOOR_BACKOFF_MS;
    record("dnet", "backdoor", false, String(error).slice(0, 200));
  } finally {
    dnetBackdoorInFlight = false;
  }
}

/** Whether home should be holding RAM for a seed this pass.
 *
 * Read from the same two facts the tick uses, so the claim and the action cannot
 * disagree: a claim without an action wastes a reservation, and an action
 * without a claim spends RAM the broker never accounted for. */
function dnetSeedWanted(state: GameState): boolean {
  if (!(state.topics.dnet?.probed ?? []).some((server) => server.hostname === "darkweb")) return false;
  const now = Date.now();
  // Either the controller is gone, or darkweb has no resident to run anything.
  if (now - dnetOverseerBeatAt >= OVERSEER_STALE_MS) return true;
  const resident = dnetRendezvous()?.queues.get("darkweb");
  return resident === undefined || now - resident.lastBeatAt >= OVERSEER_STALE_MS;
}

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
    },
  ];
}

// --- progression ------------------------------------------------------------

/** Observed rate over a sliding window of samples. The window (30 min, 30 s
 * granularity) is long enough to smooth probe cadence and short enough that a
 * mid-run regime change (new augs, new fleet) shows up within the dwell the
 * route choice already applies. A NEGATIVE delta means the series was reset
 * under us (an install dropped money to zero, a node reset dropped a skill) —
 * the window restarts rather than reporting a nonsense negative rate. */
class RateTracker {
  private samples: { t: number; v: number }[] = [];

  /** `monotone` treats the series as cumulative earnings: small decreases (a
   * realized trading loss shaving the net) are clamped to the running maximum
   * instead of read as a prestige. Without this, every losing round trip
   * cleared the money tracker's whole window and the route priced a
   * market-driven node at the 250k/s FALLBACK rate while the market produced
   * 20k+/s measured — inverting the money/exp marginal ratio and funding
   * experience RAM out of the trading bankroll. Prestige still clears these
   * trackers, explicitly, at the reset boundary sampledRates already detects —
   * but a PLUNGE (below half the running max) still clears even a monotone
   * tracker: the explicit clear latches on `lastAugReset`, and if the
   * money-sources probe was queued on the post-install pass the clear fired
   * on, the first sample after it is the surviving PRE-install topic value.
   * Clamping to that fabricated high would pin the window there until real
   * earnings exceeded the previous run's total; the input series
   * (earnedSinceInstall) is cost-basis-corrected, so its only genuine
   * decreases are small realized losses and a halving is a boundary. */
  constructor(private readonly monotone = false) {}

  sample(t: number, v: number): void {
    const last = this.samples[this.samples.length - 1];
    if (last && t - last.t < 30_000) return;
    if (last && v < last.v) {
      if (!this.monotone || v < last.v * 0.5) this.samples.length = 0;
      else v = last.v;
    }
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
    gangRep: RateTracker;
    blackOps: RateTracker;
    rank: RateTracker;
  };
  choice?: RouteChoice;
  installArmedAt?: number;
  installQueueKey?: string;
  /** Marginal install-vs-push hysteresis: the candidate verdict, when it
   * first held, and the dwelled effective verdict. A raw verdict flip must
   * hold for VERDICT_DWELL_MS (either direction) before it takes effect; the
   * only permanent latch is the sweep reaching ready/armed, which is read
   * from the published plan rather than held here. */
  verdictCandidate?: "push" | "install";
  verdictCandidateSince?: number;
  effectiveVerdict?: "push" | "install";
  nodeCompletionArmedAt?: number;
  cyclePoints: CyclePoint[];
  previousCyclePoints?: CyclePoint[];
  cycleResetAt?: number;
  cycleStartAugCount?: number;
  /** Whether this controller observed the cycle from a clean prestige
   * boundary. A startup save can already contain queued augs and banked rep;
   * its next immediate reset is a censored partial cycle, not evidence that a
   * fresh install can reproduce that acquisition rate. */
  cycleObservedFromBoundary?: boolean;
  augmentationCycles: AugmentationCycle[];
}

function freshProgressionMemory(): ProgressionMemory {
  return {
    trackers: {
      moneyEarned: new RateTracker(true),
      hacking: new RateTracker(),
      combat: new RateTracker(),
      augs: new RateTracker(),
      daedalusRep: new RateTracker(),
      gangRep: new RateTracker(),
      blackOps: new RateTracker(),
      rank: new RateTracker(),
    },
    cyclePoints: [],
    augmentationCycles: [],
  };
}

let progressionMemory = freshProgressionMemory();

/** Install cycle in which the Darkscape purchase was attempted. The program is
 * wiped by every install, so this is keyed to the cycle rather than being a
 * plain boolean — a new cycle must be allowed to buy it again. */
let darkscapeGrantedAt: number | undefined;
/** Route change since the controller last asked, for the `endgame.route`
 * telemetry event — the takeTargetSwitch pattern: recorded here, emitted by
 * the controller, which is the only module that touches Telemetry. */
let routeChange:
  | { from?: RouteId; to: RouteId; etaSec: number; expectedEndAt: number; routes: RouteEtaDigest[] }
  | undefined;

/** What the last emitted `endgame.route` event said, so recalibration can be
 * reported when it becomes MATERIAL (>25% eta movement or a part flipping to
 * measured) without spamming an event per refresh. */
let lastRouteEmit: { at: number; etaSec: number; partsKey: string } | undefined;

const ROUTE_REEMIT_MOVE = 0.25;
const ROUTE_REEMIT_MIN_MS = 600_000;

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
/** The daemon's real destroy gate. The server observation wins; live node
 * multipliers (which the game itself reports) come second. Returns undefined
 * when neither exists, keeping the static-table fallback in stepEndgame. */
function worldDaemonRequiredSkillOf(ctx: NeedContext): number | undefined {
  const observed = ctx.state.topics.servers?.["w0r1d_d43m0n"]?.requiredHackingSkill;
  if (observed !== undefined && observed > 0) return observed;
  const live = ctx.state.topics.progression?.multipliers;
  if (!live) return undefined;
  const difficulty = (live as Record<string, number>)["WorldDaemonDifficulty"];
  return difficulty !== undefined ? WORLD_DAEMON_BASE_SKILL * difficulty : undefined;
}

function endgameView(ctx: NeedContext): EndgameView | undefined {
  const player = ctx.state.topics.player;
  if (!player) return undefined;
  const prog = ctx.state.topics.progression;
  const factions = ctx.state.topics.factions;
  const blade = ctx.state.topics.bladeburner;
  const observedWorldDaemonSkill = worldDaemonRequiredSkillOf(ctx);

  const installed = prog?.ownedAugs ?? {};
  const ownedAll = factions?.ownedAugs ?? Object.keys(installed);
  const installedOccurrences = new Set(Object.keys(installed));
  const seenInstalled = new Set<string>();
  const queuedAugs: string[] = [];
  for (const name of ownedAll) {
    if (installedOccurrences.has(name) && !seenInstalled.has(name)) seenInstalled.add(name);
    else queuedAugs.push(name);
  }
  // End-loaded packages are acquired in the strategic sense (their
  // reputation work is complete) but intentionally not purchased yet. Count
  // those commitments only in the projected queue used by route cadence; do
  // not add them to `ownedAll`, because no multiplier or Red Pill ownership
  // exists before the transaction.
  for (const name of factions?.plan?.bankedAugmentations ?? []) {
    if (!installedOccurrences.has(name) && !queuedAugs.includes(name)) queuedAugs.push(name);
  }
  const skills = player.skills;
  const gang = ctx.state.topics.gang;
  const gangFactionRep = gang
    ? factions?.standings?.find((standing) => standing.name === gang.faction)?.rep ?? 0
    : undefined;
  const gangCreateFaction = (factions?.joined ?? []).find((name) =>
    (GANG_FACTIONS as readonly string[]).includes(name));
  const bladeburnerAvailable = ctx.caps.restrictions.disableBladeburner !== true && (
    ctx.caps.bitNode === 6
    || ctx.caps.bitNode === 7
    || (ctx.caps.sourceFiles["6"] ?? 0) > 0
    || (ctx.caps.sourceFiles["7"] ?? 0) > 0
  );

  // Preferred source: the core probe's derived count (30 s cadence, 0 GB
  // extra). Fallback: count the detail probe's action table once it lands.
  // Neither present -> undefined; "unknown" must stay expressible, or a
  // fabricated 0 re-prices completed ops into the route estimate and feeds a
  // phantom 0->N jump into the rate tracker.
  const blackOpsFromActions = blade?.actions
    ? blade.actions.filter((action) => action.type === "blackop" && (action.countRemaining ?? 1) <= 0).length
    : undefined;
  const blackOpsComplete = blade?.blackOpsComplete ?? blackOpsFromActions;

  return {
    bitNode: ctx.caps.bitNode,
    sourceFiles: ctx.caps.sourceFiles ?? {},
    augCount: prog?.augCount ?? Object.keys(installed).length,
    installedAugs: installed,
    queuedAugs,
    ownsRedPill: ownedAll.includes(RED_PILL),
    redPillInstalled: RED_PILL in installed,
    worldDaemonRooted: ctx.state.topics.servers?.["w0r1d_d43m0n"]?.hasAdminRights === true,
    // The observed server is authoritative; live node multipliers are the
    // next-best source (the static table is one recursion level low inside
    // BN12). Absent both, stepEndgame falls back to the static formula.
    ...(observedWorldDaemonSkill !== undefined
      ? { worldDaemonRequiredSkill: observedWorldDaemonSkill }
      : {}),
    money: player.money,
    hackingSkill: skills.hacking,
    lowestCombatSkill: Math.min(skills.strength, skills.defense, skills.dexterity, skills.agility),
    daedalusRep: factions?.standings?.find((standing) => standing.name === "Daedalus")?.rep ?? 0,
    gangAvailable: ctx.caps.bitNode === 2 && ctx.caps.restrictions.disableGang !== true,
    inGang: gang !== undefined,
    ...(gang ? { gangFaction: gang.faction } : {}),
    ...(gangFactionRep !== undefined ? { gangFactionRep } : {}),
    karma: player.karma ?? 0,
    ...(gangCreateFaction ? { gangCreateFaction } : {}),
    bladeburnerAvailable,
    darknetAvailable: ctx.caps.unlocked.dnet === "yes",
    // The labyrinth needs FULL access, which DarkscapeNavigator.exe does not
    // grant. Passing only the first flag would advertise a Red Pill route that
    // does not exist in the node we are standing in.
    darknetFullAccess: ctx.caps.darknetFullAccess === "yes",
    // The current dnet driver can observe and plan traversal but deliberately
    // refuses host-local authentication/stasis actions until dispatch can
    // lease the intended darknet host. Do not select an ETA we cannot execute.
    labyrinthAutomationAvailable: false,
    inBladeburner: ctx.caps.unlocked.bladeburner === "yes",
    charismaSkill: skills.charisma,
    ...(blackOpsComplete !== undefined ? { blackOpsComplete } : {}),
    ...(blade?.rank !== undefined ? { bladeburnerRank: blade.rank } : {}),
  };
}

function sampledRates(ctx: NeedContext, view: EndgameView): RouteRates {
  const t = ctx.now;
  const trackers = progressionMemory.trackers;
  const progression = ctx.state.topics.progression;
  // Distortion-corrected (see earnedSinceInstall): the raw ledger plunges by a
  // position's whole cost at every open, and the decrease-clearing RateTracker
  // then never accumulates a window — a market-driven node measured 0.554 $/s
  // while the market produced 22,400 $/s, and every route ETA priced off it.
  const earned = earnedSinceInstall(ctx.state);
  const resetAt = progression?.lastAugReset;
  if (resetAt !== undefined && progressionMemory.cycleResetAt !== resetAt) {
    const previousResetAt = progressionMemory.cycleResetAt;
    const previousAugCount = progressionMemory.cycleStartAugCount;
    if (
      previousResetAt !== undefined
      && previousAugCount !== undefined
      && progressionMemory.cycleObservedFromBoundary === true
    ) {
      const completed: AugmentationCycle = {
        sec: Math.max(0, (resetAt - previousResetAt) / 1_000),
        augmentations: Math.max(0, view.augCount - previousAugCount),
      };
      if (completed.sec > 0 && completed.augmentations > 0) {
        progressionMemory.augmentationCycles.push(completed);
        if (progressionMemory.augmentationCycles.length > 6) progressionMemory.augmentationCycles.shift();
      }
    }
    if (progressionMemory.cyclePoints.length >= 2) {
      progressionMemory.previousCyclePoints = progressionMemory.cyclePoints;
    }
    progressionMemory.cyclePoints = [];
    progressionMemory.cycleResetAt = resetAt;
    progressionMemory.cycleStartAugCount = view.augCount;
    progressionMemory.cycleObservedFromBoundary = (view.queuedAugs?.length ?? 0) === 0;
    // Aug count does not decrease on prestige, so RateTracker's generic
    // decrease detector cannot discover the boundary. Without this explicit
    // clear, the install jump is divided by post-install idle time and remains
    // a fabricated acquisition rate for another 30 minutes. The monotone
    // moneyEarned tracker opted out of that detector, so it clears here too.
    trackers.augs.clear();
    trackers.moneyEarned.clear();
  }
  if (resetAt !== undefined && earned !== undefined) {
    const sec = Math.max(0, (t - resetAt) / 1_000);
    const last = progressionMemory.cyclePoints.at(-1);
    if (!last || sec - last.sec >= 60) {
      progressionMemory.cyclePoints.push({
        sec,
        money: Math.max(0, earned),
        hacking: view.hackingSkill,
        combat: view.lowestCombatSkill,
      });
      // Preserve the cold bootstrap instead of turning this into a sliding
      // window. Fresh-install ETA needs the first minutes where skill, RAM and
      // rooted hosts unlock one another; dropping those points after two
      // hours made every long cycle look like its late plateau and forecasts
      // grew *longer* as real progress accumulated. At the fixed bound retain
      // two dense hours at each end and discard only the oldest middle point.
      retainCycleCurve(progressionMemory.cyclePoints);
    }
  }
  if (earned !== undefined) trackers.moneyEarned.sample(t, earned);
  trackers.hacking.sample(t, view.hackingSkill);
  trackers.combat.sample(t, view.lowestCombatSkill);
  // Series whose zero can be FABRICATED (the backing probe has not landed
  // yet) are sampled only when the reading is real: a phantom (t0, 0) sample
  // would sit in the 30-minute window and inflate the rate ~24x when the
  // true value arrives — the increase-jump passes the decrease-only reset
  // guard by design.
  const augsKnown =
    ctx.state.topics.progression?.augCount !== undefined || ctx.state.topics.factions?.ownedAugs !== undefined;
  if (augsKnown) trackers.augs.sample(t, view.augCount);
  if (ctx.state.topics.factions?.standings !== undefined) trackers.daedalusRep.sample(t, view.daedalusRep);
  if (view.gangFactionRep !== undefined) trackers.gangRep.sample(t, view.gangFactionRep);
  if (view.blackOpsComplete !== undefined) trackers.blackOps.sample(t, view.blackOpsComplete);
  if (view.bladeburnerRank !== undefined) trackers.rank.sample(t, view.bladeburnerRank);
  // The rank tracker needs two samples 30s apart before it reports anything,
  // and reports 0 whenever bladeburner is idle — but the bladeburner plan
  // already SCORES its best action's rank/sec before ever executing it. Using
  // that forward estimate ahead of the static prior marks the route's
  // bladeburner leg `measured` as soon as the feature RUNS, instead of
  // pricing the route off a fallback constant for the first half hour. The
  // execution evidence matters: the tracker also reads 0 when the plan never
  // executes at all (no work slot, stamina gate), and pricing the route at a
  // planned rate while actual progress is zero forecast the node's end hours
  // early — an action in flight or a recent successful result is required.
  const blade = ctx.state.topics.bladeburner;
  const bladeExecuting =
    blade?.current !== undefined
    || (blade?.plan?.lastResult?.ok === true && t - blade.plan.lastResult.at < 300_000);
  const plannedRank = bladeExecuting ? blade?.plan?.ranked?.[0]?.rankPerSec : undefined;
  const sampledRank = trackers.rank.perSec();
  const curvePoints = progressionMemory.cyclePoints;
  const priorCyclePoints = progressionMemory.previousCyclePoints;
  const committedNames = new Set([
    ...(ctx.state.topics.factions?.plan?.bankedAugmentations ?? []),
    ...(view.queuedAugs ?? []),
  ]);
  const augMeta = ctx.state.topics.factions?.augMeta ?? {};
  const committedMultiplier = (field: string): number => {
    let result = 1;
    for (const name of committedNames) {
      const value = augMeta[name]?.mults?.[field];
      if (value !== undefined && value > 0) result *= value;
    }
    return result;
  };
  // The unmeasured-money PRIOR, composed per channel from the node's own
  // transcribed multipliers instead of one flat hacking-era constant. In BN1
  // this reduces to exactly the tuned FALLBACK_MONEY_PER_SEC (both hacking
  // multipliers are 1, the market is inaccessible), so nothing recalibrates.
  // In BN8 it is what the multipliers already say out loud: hacked money pays
  // `ScriptHackMoney x ScriptHackMoneyGain = 0`, and the accessible market's
  // rough worth is the same closed-form blind rate the unlock ladder prices
  // with, taken on the current bankroll. Without this, the route priced a
  // market-only node's money at 250k/s until the first trades were measured,
  // the money marginal read ~400k seconds while the hacking marginal read
  // millions, and the cold-start auction handed the trading bankroll to
  // experience RAM before the market could prove itself.
  const measuredMoneyPerSec = trackers.moneyEarned.perSec();
  const nodeMultsForPrior = effectiveBitNodeMultipliers(
    ctx.caps.bitNode,
    sfLevel(ctx.caps.sourceFiles, 12),
    progression?.multipliers,
  );
  const hackingPrior = FALLBACK_MONEY_PER_SEC
    * (nodeMultsForPrior?.["ScriptHackMoney"] ?? 1)
    * (nodeMultsForPrior?.["ScriptHackMoneyGain"] ?? 1);
  const stockTopicForPrior = ctx.state.topics.stock;
  const marketPrior = stockTopicForPrior?.hasTixApiAccess === true
    ? blindBankrollRatePerSec(
        (ctx.state.topics.player?.money ?? 0) + Math.max(0, stockTopicForPrior.portfolioValue ?? 0),
      )
    : 0;
  return {
    moneyPerSec: measuredMoneyPerSec > 0 ? measuredMoneyPerSec : hackingPrior + marketPrior,
    hackingSkillPerSec: trackers.hacking.perSec(),
    combatSkillPerSec: trackers.combat.perSec(),
    augsPerSec: augmentationAcquisitionRate(progressionMemory.augmentationCycles) || trackers.augs.perSec(),
    daedalusRepPerSec: trackers.daedalusRep.perSec(),
    gangRepPerSec: trackers.gangRep.perSec(),
    blackOpsPerSec: trackers.blackOps.perSec(),
    bladeburnerRankPerSec: sampledRank > 0 ? sampledRank : plannedRank ?? 0,
    postInstallHackingSkillMult: committedMultiplier("hacking"),
    postInstallCombatSkillMult: Math.min(
      committedMultiplier("strength"),
      committedMultiplier("defense"),
      committedMultiplier("dexterity"),
      committedMultiplier("agility"),
    ),
    ...(curvePoints.length >= 2 || (priorCyclePoints?.length ?? 0) >= 2
      ? {
          cycle: {
            points: curvePoints,
            elapsedSec: Math.max(0, (t - (resetAt ?? t)) / 1_000),
            ...(priorCyclePoints && priorCyclePoints.length >= 2 ? { priorPoints: priorCyclePoints } : {}),
          },
        }
      : {}),
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

/** The published plan, but only if THIS bundle can read it.
 *
 * The plan outlives the code that wrote it: module state dies with the old bundle
 * while the topic lives in the realm store, which is the whole point of
 * `previousChoice` below. The corollary is that a plan written before a field
 * existed will be missing it, and the type — which describes what we write, not
 * what we may find — says nothing about that.
 *
 * THE BUG this exists to prevent: `plan.forecasts.node` was read unguarded, so
 * after a rebuild that added `forecasts` the refresh threw
 * `Cannot read properties of undefined (reading 'node')` on every pass. It threw
 * BEFORE publishing, so it could never replace the plan that was breaking it —
 * permanently wedged, reporting "waiting for the progression planner" while every
 * other feature ran normally. A stale plan has to be discarded, not trusted.
 *
 * Checked by the fields later code dereferences rather than by a version number:
 * there is no schema version to bump, and this cannot drift out of date silently
 * the way a hand-maintained one would. */
function readablePlan(state: GameState): ProgressionPlan | undefined {
  const plan = state.topics.progression?.plan;
  if (!plan?.forecasts?.node || !plan.forecasts.install) return undefined;
  if (!plan.queuedAugmentations || !plan.installBlockers || typeof plan.liquidationWanted !== "boolean") return undefined;
  return plan;
}

/** The previous route decision, surviving a build handoff: module state dies
 * with the old bundle, but the published plan lives in the realm store. */
function previousChoice(ctx: NeedContext): RouteChoice | undefined {
  if (progressionMemory.choice) return progressionMemory.choice;
  const plan = readablePlan(ctx.state);
  if (!plan?.route || plan.decidedAt === undefined) return undefined;
  const node = plan.forecasts.node;
  return {
    route: plan.route,
    etaSec: node.state === "unknown" ? 0 : Math.max(0, (node.expectedAt - ctx.now) / 1_000),
    decidedAt: plan.decidedAt,
  };
}

/** An augmentation that could still be PURCHASED right now, if there is one.
 *
 * The half of the install barrier that is not about stocks. Cash does not survive
 * an install, so resetting while something is still affordable destroys money
 * that could have become a permanent multiplier — the reset should always lose
 * that race. Returned as a name so the blocker can say which one is holding it.
 *
 * The test is {@link nextPurchasableAugmentation}. It is deliberately NOT the same
 * code path factions buys through — see there for why the two converge instead of
 * matching, and why NeuroFlux holds this barrier without wedging it. */
export function purchasableAugmentation(ctx: NeedContext): string | undefined {
  const factions = ctx.state.topics.factions;
  const money = ctx.state.topics.player?.money ?? 0;
  if (!factions?.offers) return undefined;
  const owned = new Set(factions.ownedAugs ?? []);
  // During a drain, test the drain's own frozen budget, not live cash: income
  // arriving while the drain runs must not hold the barrier up — the drain has
  // already declined to spend it (see FactionPlan.drainCeiling).
  const plan = factions.plan;
  const ceiling = plan?.drainCeiling ?? Infinity;
  // Once the transaction starts, the drain's exact ordered batch is the sole
  // authority. Testing isolated live offers here ignores the price escalation
  // already paid by the queue and can resurrect an item the frozen package
  // deliberately dropped, deadlocking the install behind a purchase factions
  // will never make. The probed NeuroFlux offer can also be one pass stale.
  const draining = plan?.drainCeiling !== undefined;
  if (draining) return plan.nextBuy?.name;
  return nextPurchasableAugmentation({
    offers: factions.offers,
    joined: new Set(factions.joined ?? []),
    owned,
    prereqs: (name) => factions.augMeta?.[name]?.prereqs ?? [],
    money: Math.min(money, ceiling),
  })?.name;
}

/** Decide how this BitNode ends and when, then publish it before this pass's
 * needs, claims, and feature ticks consume the result. */
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
  const statusOf = new Map(endgame.routes.map((route) => [route.id, route]));
  const routesDigest: RouteEtaDigest[] = etas.map((eta) => ({
    id: eta.id,
    available: eta.available,
    ...(eta.actionable !== undefined ? { actionable: eta.actionable } : {}),
    complete: eta.complete,
    blocker: blockerOf.get(eta.id) ?? "",
    etaSec: Math.round(eta.etaSec),
    parts: eta.parts.map((entry) => ({ what: entry.what, resource: entry.resource, sec: Math.round(entry.sec), measured: entry.measured })),
    ...(eta.stage ? { stage: eta.stage } : {}),
    ...(eta.needs ? { needs: eta.needs } : {}),
    ...(eta.nextMandatoryInstall
      ? { nextMandatoryInstall: { ...eta.nextMandatoryInstall, sec: Math.round(eta.nextMandatoryInstall.sec) } }
      : {}),
    ...(statusOf.get(eta.id)?.optionalInstall !== undefined
      ? { optionalInstall: statusOf.get(eta.id)!.optionalInstall }
      : {}),
  }));
  const selectedEta = choice ? etas.find((eta) => eta.id === choice.route) : undefined;
  const selectedStatus = choice ? endgame.routes.find((route) => route.id === choice.route) : undefined;
  let routeRequiresInstall = selectedStatus?.mandatoryInstall?.ready === true;
  const regrowOverride = regrowInstallOverride({
    ...(selectedStatus?.stage !== undefined ? { stage: selectedStatus.stage } : {}),
    ...(selectedStatus?.optionalInstall !== undefined
      ? { optionalInstallAllowed: selectedStatus.optionalInstall }
      : {}),
    ...(endgame.worldDaemonSkill !== undefined ? { worldDaemonSkill: endgame.worldDaemonSkill } : {}),
    hackingSkill: view.hackingSkill,
    rates,
  });
  // The OVERRIDDEN permission, as handed to installForecast and the digests:
  // the regrow comparison may flip the route's raw optional-install guard.
  const optionalInstallAllowed = regrowOverride || (selectedStatus?.optionalInstall ?? true);
  const nodeBasis = JSON.stringify({
    route: choice?.route,
    complete: selectedEta?.complete,
    blocker: endgame.routes.find((route) => route.id === choice?.route)?.blocker,
    parts: selectedEta?.parts.map((part) => [part.what, part.measured]),
  });
  const previousNodeForecast = readablePlan(ctx.state)?.forecasts.node;
  const nextNodeForecast = shouldReforecast(previousNodeForecast, ctx.now, nodeBasis)
    ? nodeForecast(ctx.now, selectedEta, nodeBasis)
    : forecastAt(previousNodeForecast!, ctx.now);
  // Emit on switch, and ALSO on material recalibration of the kept route:
  // the topic self-corrects continuously, but the decision record in
  // runs/*.jsonl only shows what was emitted — a single all-priors event per
  // run made every calibration look unrevised. Rate-limited so a noisy rate
  // tracker cannot flood the event ring.
  const partsKey = selectedEta?.parts.map((part) => `${part.what}:${part.measured}`).join("|") ?? "";
  const materialMove =
    choice !== undefined
    && lastRouteEmit !== undefined
    && ctx.now - lastRouteEmit.at >= ROUTE_REEMIT_MIN_MS
    && (Math.abs(choice.etaSec - lastRouteEmit.etaSec) > lastRouteEmit.etaSec * ROUTE_REEMIT_MOVE
      || partsKey !== lastRouteEmit.partsKey);
  if ((switched || materialMove) && choice && nextNodeForecast.state !== "unknown") {
    routeChange = {
      ...(switched && previous ? { from: previous.route } : {}),
      to: choice.route,
      etaSec: Math.round(choice.etaSec),
      expectedEndAt: nextNodeForecast.expectedAt,
      routes: routesDigest,
    };
    lastRouteEmit = { at: ctx.now, etaSec: choice.etaSec, partsKey };
  } else if (switched === false && choice !== undefined && lastRouteEmit === undefined) {
    // A choice that predates this bundle (plan read back from the store)
    // seeds the baseline without emitting.
    lastRouteEmit = { at: ctx.now, etaSec: choice.etaSec, partsKey };
  }

  // --- install cadence, on real inputs rather than the stubbed constants the
  // first cut shipped with (affordableValueProduct 1, runSec 0).
  const installed = prog?.ownedAugs ?? {};
  const occurrences = new Map<string, number>();
  for (const name of factions?.ownedAugs ?? []) occurrences.set(name, (occurrences.get(name) ?? 0) + 1);
  const pending: string[] = [];
  for (const [name, count] of occurrences) {
    // Installed augmentations appear once in getOwnedAugmentations(true), even
    // when NeuroFlux's installed level is greater than one. Every additional
    // occurrence is queued and must survive into the reset record.
    const installedOccurrence = (installed[name] ?? 0) > 0 ? 1 : 0;
    for (let i = installedOccurrence; i < count; i++) pending.push(name);
  }
  pending.sort();
  const standings = Object.fromEntries(
    (factions?.standings ?? []).map((standing) => [standing.name, { rep: standing.rep, favor: standing.favor }]),
  );
  const purchasable = purchasableAugmentation(ctx);

  // --- install-vs-push: the marginal-value verdict --------------------------
  // Value the reset would ACTIVATE: multiplier-only score (flat bonuses mark
  // necessity, not rate, and the route-mandatory case is routeRequiresInstall's
  // job) of the queue PLUS what the final sweep would still convert — offers
  // whose reputation is met and price is within the bankroll. Purchases are
  // end-loaded, so mid-cycle the queue is empty by design; without the
  // realizable set the reset side reads zero and the verdict pushes forever.
  // Priced by the route's OWN marginals — the same measurement this feature
  // publishes — so the accrued side of the cadence comes out in BN-seconds and
  // can be compared with the push rate without either being a made-up unit.
  // Which branch of Daedalus binds is no longer a switch to set: a combat gate
  // that is not on the critical path measures zero and prices its
  // augmentations accordingly.
  // The PUBLISHED marginals: this pass computes its own further down, but the
  // valuation is wanted before then and a one-pass-old measurement of a slowly
  // moving route estimate is not a different answer.
  const publishedWorth = currencyWorth(ctx.state.topics.progression?.plan?.marginals);
  const verdictWeights = weightsFromMarginals(publishedWorth, {
    hackingTarget: endgame.worldDaemonSkill,
    combatTarget: DAEDALUS_COMBAT,
    multipliers: (player.mults ?? {}) as unknown as Record<string, number>,
    incomeShares: incomeShares(ctx.state),
  });
  // Clamped at zero per augmentation: cost-reduction multipliers sit BELOW 1,
  // so a beneficial aug can carry a negative log-score — the accrued signal
  // measures what an install would activate, and that is never negative.
  const scoreMults = (name: string): number => {
    const aug = AUGMENTATIONS[name];
    if (!aug) return 0;
    return Math.max(0, scoreAugMults(
      { name, baseCost: aug.cost, baseRepRequirement: aug.rep, factions: [...aug.factions], prereqs: [...(aug.prereqs ?? [])], mults: { ...(aug.mults ?? {}) }, ...(aug.multsUnknown ? { multsUnknown: true } : {}) },
      verdictWeights,
    ));
  };
  const realizable = new Set<string>();
  // The sweep's budget is cash PLUS the liquidatable stock book — the same
  // frozen ceiling the drain itself uses (cash + pendingProceeds). Cash alone
  // read near-zero on stock-funded nodes (BN8 keeps the bankroll invested by
  // design), so realizable stayed empty and the verdict pushed forever.
  const sweepBudget = player.money + liquidatableValue(ctx);
  // Joined factions only: the sweep can only buy from a faction we are IN,
  // and after a prestige the offers list can briefly describe factions the
  // reset just removed — counting those manufactured install pressure in a
  // cycle with nothing joined and deadlocked it (installRequested stops the
  // very faction work that would have made something realizable).
  const joinedSet = new Set(factions?.joined ?? []);
  const ownedOrQueued = new Set<string>(pending);
  for (const offer of factions?.offers ?? []) if (offer.owned) ownedOrQueued.add(offer.name);
  const affordable: string[] = [];
  for (const offer of factions?.offers ?? []) {
    if (offer.owned || !joinedSet.has(offer.faction)) continue;
    if (!offer.affordableRep || offer.price > sweepBudget) continue;
    affordable.push(offer.name);
  }
  // Prereq closure: every real purchase path skips a prereq-unmet aug
  // (augs.ts nextPurchasableAugmentation), so an offer only counts as
  // realizable when its prerequisites are owned, queued, or themselves
  // realizable this sweep — otherwise a rep-locked prereq chain manufactures
  // install pressure for value the sweep can never convert, the exact
  // deadlock shape the joined-factions filter above was added for.
  for (let moved = true; moved; ) {
    moved = false;
    for (const name of affordable) {
      if (realizable.has(name)) continue;
      const prereqs = AUGMENTATIONS[name]?.prereqs ?? [];
      if (prereqs.every((prereq) => ownedOrQueued.has(prereq) || realizable.has(prereq))) {
        realizable.add(name);
        moved = true;
      }
    }
  }
  for (const name of pending) realizable.delete(name);

  // "Every item fits this bankroll on its own" is not a funded reset set:
  // the second and later purchases pay the 1.9x queue escalation. Cadence used
  // to sum every individually affordable offer here, then the frozen sweep
  // could buy only a strict subset. That fabricated reset value and armed an
  // early install (measured in the full BN1 harness: eight candidates valued,
  // five actually bought). Select the jointly affordable one-shot set using
  // the same value-order / payment-order split as the transaction boundary.
  // Purchases remain entirely end-loaded; this is only the honest value of
  // what the current bankroll could convert if progression ended the cycle.
  const daedalusRequired = choice?.route === "daedalus" && view.bitNode !== undefined
    ? daedalusAugsRequired(view.bitNode, view.sf12Level ?? view.sourceFiles["12"] ?? 0)
    : undefined;
  const activationOwned = new Set([...ownedOrQueued, ...pending]);
  const activationOffers = factions?.offers ?? [];
  const activationPriceContext = {
    queuedNonSoA: pending.filter((name) => !isSoA(name)).length,
    ownedSoA: Object.keys(installed).filter(isSoA).length,
    neurofluxLevel: (installed[NEUROFLUX] ?? 0) + pending.filter((name) => name === NEUROFLUX).length,
    sf11Level: view.sourceFiles["11"] ?? 0,
    augMoneyCost: effectiveBitNodeMultipliers(
      view.bitNode,
      view.sf12Level ?? view.sourceFiles["12"] ?? 0,
      prog?.multipliers,
    )?.AugmentationMoneyCost ?? 1,
    augRepCost: 1,
  };
  const fundedActivation = fundedActivationBatch({
    realizable,
    offers: activationOffers,
    joined: joinedSet,
    owned: activationOwned,
    weights: verdictWeights,
    countSlotValue: countSlotValueFor(publishedWorth, daedalusRequired ?? Infinity, view.augCount),
    neurofluxCountable: daedalusRequired !== undefined && !activationOwned.has(NEUROFLUX),
    ctx: activationPriceContext,
    money: sweepBudget,
  });

  if (daedalusRequired !== undefined && view.augCount < daedalusRequired) {
    const installedNames = new Set(Object.keys(view.installedAugs ?? {}));
    const queuedCountable = new Set(
      pending.filter((name) => name !== NEUROFLUX || !installedNames.has(NEUROFLUX)),
    );
    routeRequiresInstall = routeRequiresInstall || countClosureAffordable({
      realizable,
      offers: activationOffers,
      joined: joinedSet,
      owned: ownedOrQueued,
      wanted: Math.max(0, daedalusRequired - view.augCount - queuedCountable.size),
      neurofluxCountable: !installedNames.has(NEUROFLUX),
      ctx: activationPriceContext,
      money: sweepBudget,
    });
  }
  // Banked-but-unrealized favor, priced with packageValue's OWN favor terms
  // (futureRateGain + crossesDonation) at current rep. The frontier's favor
  // packages accrue value that only an install banks — without this term the
  // push stream counts that value as income while the reset side never sees
  // it, and a favor-purpose objective can never conclude.
  const favorDonateAt = factions?.favorToDonate ?? 150;
  const bankedFavorValue = bankedFavorActivationValue({
    standings: (factions?.standings ?? []).filter((standing) => joinedSet.has(standing.name)),
    offers: factions?.offers ?? [],
    favorToDonate: favorDonateAt,
    reputationWorthSec: publishedWorth.get("reputation") ?? 0,
  });
  // Unit-consistent with packageValue (count + quality + favor terms): the
  // push rate is denominated in package value, where every augmentation
  // carries a flat +1 count on top of its multiplier quality — an accrued
  // side without the count term could never clear the threshold on cheap
  // augs however many of them an install would activate.
  // Count slots pay at the Daedalus gate rather than accelerating the next
  // cycle, but a sufficiently large partial tranche has persistent route
  // value: it avoids forcing every remaining slot through one exponential
  // 1.9^N transaction. The node-relative consolidation policy remains the
  // guard against tiny late resets; below it count contributes zero here.
  const resetMultiplierValue = [...pending, ...fundedActivation.map((candidate) => candidate.name)].reduce(
    (sum, name) => sum + scoreMults(name),
    0,
  );
  let routeCountValue = 0;
  let countCadenceReady = true;
  if (daedalusRequired !== undefined) {
    const installedNames = new Set(Object.keys(view.installedAugs ?? {}));
    const verdict = routeCountVerdict({
      required: daedalusRequired,
      installed: view.augCount,
      affordableDistinct: new Set(
        [...pending, ...fundedActivation.map((candidate) => candidate.name)]
          .filter((name) => !installedNames.has(name)),
      ).size,
      consolidationAllowed: selectedStatus?.optionalInstall === true,
      worth: publishedWorth,
    });
    countCadenceReady = verdict.ready;
    routeCountValue = verdict.value;
  }
  const resetValueMult = resetMultiplierValue + bankedFavorValue + routeCountValue;
  const intent = factions?.plan?.objective?.intent;
  // The package selector also values permanent Daedalus count slots. They
  // advance the route, but do not accelerate the next cycle, so cadence uses
  // its separately measured reset-activated stream. A nearly-complete package
  // can report eta=1 while purchases are deliberately end-loaded; treating
  // activationValue/1s as a production rate makes the renewal threshold blow
  // up exactly when a cycle is done. installCadencePushRate bounds that forward
  // estimate by value actually accrued over this cycle, so a completed package
  // remains a sample rather than masquerading as an exhausted frontier.
  const runSec = prog?.lastAugReset ? Math.max(0, (ctx.now - prog.lastAugReset) / 1000) : 0;
  const cadencePushRate = installCadencePushRate({
    runSec,
    resetValueMult,
    ...(intent?.activationValue !== undefined ? { intentActivationValue: intent.activationValue } : {}),
    ...(intent?.etaSec !== undefined ? { intentEtaSec: intent.etaSec } : {}),
    ...(intent?.marginalActivationRate !== undefined
      ? { intentMarginalActivationRate: intent.marginalActivationRate }
      : {}),
  });
  // Convert the measured nonlinear money bootstrap into an equivalent delay.
  // For cumulative y=a*t^p, the tangent at the current point reaches y=0 at
  // t*(1-1/p): that is the startup delay a steady-state stream would have to
  // pay to reproduce the observed curve. Linear production (p<=1) loses only
  // the physical install interruption; an accelerating cold start pays more,
  // without charging unrelated faction work and purchases as if they had to
  // be repeated. The exponent is the same bounded fit used by route ETA.
  const bootstrapExponent = cycleProgressExponent(progressionMemory.cyclePoints, "money");
  const measuredBootstrapDelay = bootstrapExponent !== undefined && bootstrapExponent > 1
    ? runSec * (1 - 1 / bootstrapExponent)
    : 0;
  const resetOverheadSec = Math.max(INSTALL_VERDICT_OVERHEAD_SEC, measuredBootstrapDelay);
  const rawVerdict = installVerdict({
    routeEtaKnown: selectedEta !== undefined,
    resetValueMult,
    resetOverheadSec,
    ...(cadencePushRate !== undefined ? { pushMarginalRate: cadencePushRate } : {}),
    // A published factions plan naming no intent is a concluded frontier; a
    // missing plan is a frontier that has not run yet (see installVerdict).
    // A HORIZON-STARVED objective is neither: raw candidates exist but the
    // node forecast currently prices them all out — a transient state that
    // recalibrates, and reading it as "concluded" armed a premature install
    // (irreversible once the sweep starts buying) at package boundaries.
    frontierIdle:
      factions?.plan !== undefined
      && intent === undefined
      && factions.plan.objective?.horizonStarved !== true,
  });
  // Install is irreversible: it must dwell before opening the transaction,
  // while contrary push evidence cancels immediately. The only true latch is
  // the point where the final sweep has become ready/armed.
  const pastPointOfNoReturn =
    pending.length > 0
    || factions?.plan?.drainCeiling !== undefined
    || prog?.plan?.installReady === true
    || progressionMemory.installArmedAt !== undefined;
  let marginalInstall: boolean | undefined;
  if (pastPointOfNoReturn) {
    marginalInstall = true;
  } else if (rawVerdict.verdict === "no-data") {
    marginalInstall = undefined;
  } else {
    const dwelled = dwellInstallVerdict(rawVerdict.verdict, {
      ...(progressionMemory.verdictCandidate !== undefined ? { candidate: progressionMemory.verdictCandidate } : {}),
      ...(progressionMemory.verdictCandidateSince !== undefined ? { candidateSince: progressionMemory.verdictCandidateSince } : {}),
      ...(progressionMemory.effectiveVerdict !== undefined ? { effective: progressionMemory.effectiveVerdict } : {}),
    }, ctx.now);
    progressionMemory.verdictCandidate = dwelled.state.candidate;
    progressionMemory.verdictCandidateSince = dwelled.state.candidateSince;
    progressionMemory.effectiveVerdict = dwelled.state.effective;
    marginalInstall = dwelled.install;
  }
  // On the finite Daedalus count route, a small multiplier package can clear
  // the generic renewal threshold while still being a terrible reset: it pays
  // another full cold bootstrap but barely advances the installed-count gate.
  // Do not even OPEN the end-loaded transaction until the currently funded
  // distinct set covers a target-relative early tranche. This is cadence
  // permission only; route-mandatory Red Pill/count-closure installs bypass it
  // through routeRequiresInstall and an already-started queue remains latched.
  if (marginalInstall === true && !routeRequiresInstall && !pastPointOfNoReturn && !countCadenceReady) {
    marginalInstall = false;
  }

  // The lab-cache deferral, and its deadline. The blocker is raised only while
  // `dnet` says the cache is openable RIGHT NOW, and abandoned once the window
  // has run out — so an install can never stall on a cache we do not have,
  // cannot reach, or asked for and never got.
  const labCacheOpen = ctx.state.topics.dnet?.labCache?.openable === true;
  const deferral = labCacheDeferral({ since: dnetLabCacheSince }, labCacheOpen, ctx.now);
  dnetLabCacheSince = deferral.since;

  const decision = stepProgression({
    queued: pending,
    ...(deferral.defer ? { labCacheOpenable: true } : {}),
    affordableValueProduct: affordableValueProduct(ctx),
    factionWorkInProgress: ctx.state.topics.career?.currentWork?.type === "FACTION",
    // Once factions has published any plan it owns the pre-install handshake:
    // progression may reset only after the last-chance drain reports ready.
    factionsReadyToInstall:
      ctx.caps.unlocked.factions === "no" || Boolean(factions?.plan?.recommendInstall),
    factionsNeedLiquidation: Boolean(factions?.plan?.liquidationNeeded),
    // The market's OWN answer, not a scan of its positions: `flat` accounts for
    // an exit decided but not yet executed and for an entry wanted on the next
    // pass, neither of which a position snapshot can show. A market that has
    // never published a plan is not evidence of flatness, so it blocks — except
    // where there is no market to be flat at all, which the two guards cover.
    stockReadyToInstall:
      ctx.caps.unlocked.stock === "no"
      || ctx.state.topics.stock?.hasTixApiAccess !== true
      || ctx.state.topics.stock.plan?.flat === true,
    ...(purchasable !== undefined ? { purchasableAugmentation: purchasable } : {}),
    graftInProgress: ctx.state.topics.career?.currentWork?.type === "GRAFTING",
    money: player.money,
    // Distortion-corrected (see earnedSinceInstall): the raw ledger plunges by
    // an open position's whole cost, which held this figure at ~0 in a
    // market-driven run and silently disarmed phaseOf's cash-ratio install arm.
    earnedThisRun: earnedSinceInstall(ctx.state) ?? ctx.state.topics.farm?.totals?.moneyEarned ?? 0,
    factions: standings,
    favorToDonate: factions?.favorToDonate ?? 150,
    homeRam: ctx.state.topics.servers?.["home"]?.maxRam ?? 8,
    // No probe prices the home upgrade yet; Infinity keeps the budget advisory.
    homeRamUpgradeCost: Infinity,
    runSec,
    ...(selectedEta !== undefined ? { nodeRemainingSec: selectedEta.etaSec } : {}),
    routeRequiresInstall,
    optionalInstallAllowed,
    resetValueMult,
    // Banked favor may only OPEN the gate when the sweep can actually convert
    // something — any joined offer with rep met (NeuroFlux included), or a
    // donation path (favor past the donate wall on a faction with unowned
    // augs). Rep-locked value must not arm an install whose installRequested
    // then halts the very rep work that would unlock it: with nothing
    // convertible the queue stays empty and the "nothing queued yet" blocker
    // holds the reset forever, with faction work frozen.
    resetRealizable:
      realizable.size > 0
      || (bankedFavorValue > 0.01
        && ((factions?.offers ?? []).some((offer) => !offer.owned && joinedSet.has(offer.faction) && offer.affordableRep)
          || (factions?.standings ?? []).some(
            (standing) =>
              joinedSet.has(standing.name)
              && standing.favor >= favorDonateAt
              && (factions?.offers ?? []).some(
                (offer) => !offer.owned && offer.faction === standing.name,
              ),
          ))),
    ...(cadencePushRate !== undefined ? { pushMarginalRate: cadencePushRate } : {}),
    ...(intent?.etaSec !== undefined ? { pushEtaSec: intent.etaSec } : {}),
    ...(marginalInstall !== undefined ? { marginalInstall } : {}),
  });

  const queueKey = pending.join("\0");
  const persistedArm = prog?.plan?.installReady && prog.plan.installArmedAt !== undefined
    ? prog.plan.installArmedAt
    : undefined;
  if (progressionMemory.installArmedAt === undefined && persistedArm !== undefined) {
    progressionMemory.installArmedAt = persistedArm;
    progressionMemory.installQueueKey = prog?.plan?.queuedAugmentations.join("\0") ?? queueKey;
  }
  if (
    !decision.installReady
    || (progressionMemory.installQueueKey !== undefined && progressionMemory.installQueueKey !== queueKey)
  ) {
    progressionMemory.installArmedAt = undefined;
    progressionMemory.installQueueKey = undefined;
  }
  const armedAt = progressionMemory.installArmedAt;
  const cadenceRemainingSec = installCadenceRemainingSec({
    runSec,
    resetValueMult,
    ...(rawVerdict.pushRate !== undefined ? { pushMarginalRate: rawVerdict.pushRate } : {}),
    ...(bootstrapExponent !== undefined ? { bootstrapExponent } : {}),
  });

  const installBasis = JSON.stringify({
    phase: decision.phase,
    wanted: decision.installWanted,
    liquidate: decision.liquidationWanted,
    ready: decision.installReady,
    blockers: decision.installBlockers,
    optionalAllowed: optionalInstallAllowed,
    countCadenceReady,
    mandatory: selectedEta?.nextMandatoryInstall,
    queue: pending,
    intent: factions?.plan?.objective?.intent
      ? {
          faction: factions.plan.objective.intent.faction,
          repTarget: factions.plan.objective.intent.repTarget,
          augmentations: factions.plan.objective.intent.augmentations,
          purpose: factions.plan.objective.intent.purpose,
        }
      : undefined,
  });
  const previousInstallForecast = readablePlan(ctx.state)?.forecasts.install;
  const nextInstallForecast = shouldReforecast(previousInstallForecast, ctx.now, installBasis)
      ? installForecast(ctx.now, {
        installNow: decision.installReady && armedAt !== undefined,
        installWanted: decision.installWanted,
        queuedCount: pending.length,
        phase: decision.phase,
        ...(factions?.plan?.objective?.intent ? { intent: factions.plan.objective.intent } : {}),
        workMeasured: factions?.plan?.until?.kind === "rep",
        moneyMeasured: (factions?.plan?.context?.incomePerSec ?? 0) > 0,
        finalSweepReady: decision.installReady,
        ...(decision.installWanted
          && factions?.plan?.recommendInstall === undefined
          && factions?.plan?.objective?.intent?.etaSec !== undefined
            ? { committedPackageSec: factions.plan.objective.intent.etaSec }
            : {}),
        ...(cadenceRemainingSec !== undefined ? { cadenceSec: cadenceRemainingSec } : {}),
        countCadenceReady,
        optionalInstallAllowed,
        ...(selectedEta?.nextMandatoryInstall ? { mandatory: selectedEta.nextMandatoryInstall } : {}),
      }, installBasis)
    : forecastAt(previousInstallForecast!, ctx.now);
  const forecasts: PlanningHorizons = { node: nextNodeForecast, install: nextInstallForecast };
  const marginals = progressionMarginals({
    view,
    decision: endgame,
    rates,
    ...(choice ? { selectedRoute: choice.route } : {}),
    install: nextInstallForecast,
  });
  const nextBitNode = selectedEta?.complete && view.bitNode !== undefined
    ? chooseNextBitNode(view.bitNode, view.sourceFiles)
    : undefined;
  const canAutomateNodeCompletion =
    view.bitNode === 4 || (view.sourceFiles["4"] ?? 0) > 0;
  const routeAction =
    choice?.route === "bladeburner"
    && selectedStatus?.stage === "bladeburner-join"
    && view.lowestCombatSkill >= 100
      ? { type: "joinBladeburner" as const }
      : choice?.route === "gang"
        && selectedStatus?.stage === "gang-create"
        && (view.karma ?? 0) <= GANG_KARMA
        && view.gangCreateFaction
        ? {
            type: "createGang" as const,
            faction: view.gangCreateFaction,
          }
        : undefined;
  if (!selectedEta?.complete) progressionMemory.nodeCompletionArmedAt = undefined;
  // "About to install" and "about to destroy the BitNode" are DIFFERENT
  // terminal modes with opposite money policies. An install preserves augs,
  // favor, and cash, so hoarding for the final sweep is right. A destroy
  // erases all three — the only surviving use of money is speeding up the
  // remaining minutes, so install-shaped reserves (aug-fund, donations) must
  // release and let infrastructure spending through. Conflating them held a
  // ~$9e14 sweep reserve while a RAM purchase that would have finished the
  // node sat outbid. Fail-open by design: if the forecast is wrong and the
  // node does NOT end, the released money bought productive RAM, not waste.
  const endingByDestroy =
    selectedEta !== undefined
    && selectedEta.etaSec < IMMINENT_INSTALL_SEC
    && selectedStatus?.mandatoryInstall === undefined
    && !routeRequiresInstall
    && decision.installWanted !== true;
  merge(ctx.state, "progression", {
    plan: {
      phase: decision.phase,
      ...(endingByDestroy ? { endingByDestroy: true } : {}),
      installWanted: decision.installWanted,
      liquidationWanted: decision.liquidationWanted,
      installBlockers: decision.installBlockers,
      installReady: decision.installReady,
      ...(armedAt !== undefined ? { installArmedAt: armedAt } : {}),
      queuedAugmentations: pending,
      ...(!routeRequiresInstall && decision.installWanted
        ? {
            installFundedAugmentations: fundedActivation
              .map((candidate) => candidate.name)
              .filter((name) => name !== NEUROFLUX),
          }
        : {}),
      install: decision.installReady && armedAt !== undefined,
      favorCrossings: decision.favorCrossings,
      installDecision: {
        verdict: rawVerdict.verdict,
        effective: marginalInstall === undefined ? "legacy" : marginalInstall ? "install" : "push",
        ...(rawVerdict.pushRate !== undefined ? { pushRate: rawVerdict.pushRate } : {}),
        ...(rawVerdict.threshold !== undefined ? { threshold: rawVerdict.threshold } : {}),
        resetValueMult,
        ...(bankedFavorValue > 0 ? { resetFavorValue: bankedFavorValue } : {}),
        ...(intent?.etaSec !== undefined ? { pushEtaSec: Math.round(intent.etaSec) } : {}),
        ...(selectedEta !== undefined ? { remainingSec: Math.round(selectedEta.etaSec) } : {}),
        latched: pastPointOfNoReturn,
      },
      ...(choice
        ? {
            route: choice.route,
            decidedAt: choice.decidedAt,
          }
        : {}),
      routes: routesDigest,
      routeInstallRequired: routeRequiresInstall,
      forecasts,
      marginals,
      ...(routeAction ? { routeAction } : {}),
      ...(nextBitNode
        ? {
            completion: {
              ready: true,
              automatic: canAutomateNodeCompletion,
              nextBitNode: nextBitNode.bitNode,
              targetLevel: nextBitNode.targetLevel,
              ...(progressionMemory.nodeCompletionArmedAt !== undefined
                ? { armedAt: progressionMemory.nodeCompletionArmedAt }
                : {}),
              execute: canAutomateNodeCompletion && progressionMemory.nodeCompletionArmedAt !== undefined,
            },
          }
        : {}),
    },
  });
}

/** DarkscapeNavigator.exe: darknet access, and the only path to it without BN15
 * or an active SF15.
 *
 * **`progression` owns this purchase, not `dnet`, and that is forced.**
 * `driverEnabled` never ticks a driver whose own feature reads anything but
 * "yes", so a gated `dnet` can never buy its own unlock — the exact deadlock
 * `spec/features.md` records from the stock rebuild, where gating on
 * `hasWseAccount` made the account unbuyable. `progression` is always active and
 * already reads darknet availability for the endgame route, so it is the module
 * that can act. Moving this to `dnet` would silently stop it working. */
function shouldBuyDarkscape(ctx: DriverContext | NeedContext): boolean {
  const caps = ctx.caps;
  // The gate probe's raw `hasDarknetProgram` reading is consumed by
  // deriveCapabilities and not retained, but it is recoverable from the two
  // capability flags: access without full access can only have come from the
  // program. Safe because stepDarkscape returns on the BN15/SF15 guard before
  // it consults this, which is the one case where access does NOT imply the
  // file is present.
  const access = caps.unlocked.dnet;
  return stepDarkscape({
    dnetDisabled: disabledByProfile(caps, "dnet"),
    ...(caps.bitNode !== undefined ? { bitNode: caps.bitNode } : {}),
    sf15: sfLevel(caps.sourceFiles, 15),
    ...(access === "unknown" ? {} : { hasProgram: access === "yes" }),
    money: ctx.state.topics.player?.money ?? 0,
  });
}

const progression: FeatureDriver = {
  id: "progression",
  everyMs: 60_000,
  // Armed installs carry themselves pass-to-pass; the install signal covers
  // the FIRST evaluation after factions' drain concludes, which otherwise
  // waits out the 60-second cadence (game/lib/install-signal.ts).
  wake: () =>
    progressionMemory.installArmedAt !== undefined
    || progressionMemory.nodeCompletionArmedAt !== undefined
    || takeInstallSignal(),
  async tick(ctx: DriverContext) {
    const plan = readablePlan(ctx.state);
    if (plan?.completion?.ready && plan.completion.automatic) {
      if (progressionMemory.nodeCompletionArmedAt === undefined) {
        progressionMemory.nodeCompletionArmedAt = Date.now();
        merge(ctx.state, "progression", {
          plan: {
            ...plan,
            completion: {
              ...plan.completion,
              armedAt: progressionMemory.nodeCompletionArmedAt,
              execute: false,
            },
          },
        });
        return;
      }
      if (!plan.completion.execute || plan.completion.armedAt !== progressionMemory.nodeCompletionArmedAt) return;
      const outcome = await featureDodge(
        ctx,
        "progression",
        "action:complete-bitnode",
        ["singularity.destroyW0r1dD43m0n"],
        (stubNs) => {
          stubNs["singularity"]["destroyW0r1dD43m0n"](plan.completion!.nextBitNode, "/start.js");
          return true;
        },
      );
      if (!outcome.ok && !outcome.queued) progressionMemory.nodeCompletionArmedAt = undefined;
      return;
    }
    if (plan?.routeAction?.type === "joinBladeburner") {
      await featureDodge(
        ctx,
        "progression",
        "action:join-bladeburner",
        ["bladeburner.joinBladeburnerDivision"],
        (stubNs) => stubNs["bladeburner"]["joinBladeburnerDivision"](),
      );
      return;
    }

    if (shouldBuyDarkscape(ctx) && darkscapeGrantedAt !== progressionMemory.cycleResetAt) {
      const outcome = await featureDodge(
        ctx,
        "progression",
        "unlock:darkscape",
        // TOR first: purchaseProgram fails without it, and purchaseTor is
        // idempotent, so this is cheaper than probing for something the player
        // snapshot does not expose.
        ["singularity.purchaseTor", "singularity.purchaseProgram"],
        (stubNs) => {
          stubNs["singularity"]["purchaseTor"]();
          // `purchaseProgram` returns TRUE for an already-owned program
          // (Singularity.ts logs "You already have..." and returns true), so a
          // true return means owned-or-bought and the latch below is safe on it.
          // False is a genuine refusal — no TOR, or the money moved between the
          // decision and this call — which retries next pass.
          return stubNs["singularity"]["purchaseProgram"]("DarkscapeNavigator.exe");
        },
      );
      if (outcome.ok && outcome.value === true) {
        // Latched because the gate probe only re-reads the file on its 30 s
        // sweep — without this the next few passes would re-attempt a purchase
        // that has already happened.
        darkscapeGrantedAt = progressionMemory.cycleResetAt;
        record("progression", "unlock:darkscape", true, `bought for ${DARKSCAPE_TOTAL_COST}`);
      } else if (outcome.ok) {
        record("progression", "unlock:darkscape", false, "purchase refused; retrying next pass");
      }
      return;
    }
    if (plan?.routeAction?.type === "createGang") {
      const faction = plan.routeAction.faction;
      await featureDodge(
        ctx,
        "progression",
        "action:create-gang",
        ["gang.createGang"],
        (stubNs) => stubNs["gang"]["createGang"](faction as never),
      );
      return;
    }
    if (!plan?.installReady) {
      progressionMemory.installArmedAt = undefined;
      progressionMemory.installQueueKey = undefined;
      return;
    }
    const queueKey = plan.queuedAugmentations.join("\0");
    if (progressionMemory.installArmedAt === undefined) {
      progressionMemory.installArmedAt = Date.now();
      progressionMemory.installQueueKey = queueKey;
      merge(ctx.state, "progression", {
        plan: { ...plan, install: false, installArmedAt: progressionMemory.installArmedAt },
      });
      return;
    }
    if (!plan.install || progressionMemory.installQueueKey !== queueKey) return;

    // The rooted callback is deliberate: relative "start.js" would resolve
    // beside the versioned dodge stub as lib/start.js.
    const outcome = await featureDodge(
      ctx,
      "progression",
      "action:install",
      ["singularity.installAugmentations"],
      (stubNs) => {
        stubNs["singularity"]["installAugmentations"]("/start.js");
        return true;
      },
    );
    if (!outcome.ok && !outcome.queued) {
      progressionMemory.installArmedAt = undefined;
      progressionMemory.installQueueKey = undefined;
      const { installArmedAt: _armed, ...disarmed } = plan;
      merge(ctx.state, "progression", {
        plan: { ...disarmed, install: false },
      });
    }
    return;
  },
};

// --- modules ----------------------------------------------------------------

const reset = (): void => {
  for (const key of Object.keys(results)) delete results[key];
};

/** Shared reset shape: drop the recorded outcomes AND this feature's
 * published topic — the digest describes a node that no longer exists, and
 * each module clears its own rather than the controller keeping a per-field
 * blacklist of what everyone publishes. */
const resetWithTopic =
  (topic: keyof GameState["topics"]) =>
  (state: GameState): void => {
    reset();
    delete state.topics[topic];
  };

export const gangModule: FeatureModule = {
  driver: gang,
  reset: resetWithTopic("gang"),
  claims: (ctx) => {
    const action = ctx.state.topics.gang?.plan?.actions.find((entry) => entry.type !== "idle")?.type;
    return maybeActionClaim("gang", ctx, action, gangMethods(action));
  },
};

export const corpModule: FeatureModule = {
  driver: corp,
  reset: resetWithTopic("corp"),
  // NO money claim while corporation actions are unimplemented (the driver's
  // own contract: the stage machine plans but never executes). The old $150b
  // `corp:seed` reserve at priority 85 was doubly wrong: the corp feature only
  // unlocks once a corporation ALREADY exists (`hasCorporation` gates it), so
  // the claim could never fund the founding it named — and being a standing
  // reserve it permanently starved every investment band below 85 the moment
  // the bankroll crossed $150b. Re-post it (at `corp:seed`) the day execute()
  // spends money.
  claims: () => [],
};

export const bladeburnerModule: FeatureModule = {
  driver: bladeburner,
  reset: resetWithTopic("bladeburner"),
  claims: (ctx) => {
    const action = ctx.state.topics.bladeburner?.plan?.action.type;
    const claims = maybeActionClaim("bladeburner", ctx, action, bladeMethods(action));
    const hasSimulacrum = (ctx.state.topics.progression?.ownedAugs?.[BLADES_SIMULACRUM] ?? 0) > 0;
    if (action === "act" && !hasSimulacrum) {
      // ANNOUNCE THE RATE. A time claim with no `produces` is a HARD claim, and
      // hard claims outrank every priced one outright — so leaving this silent
      // would hand Bladeburner the exclusive work slot ahead of faction
      // reputation on nothing but the absence of a number. Rank is a priced
      // channel (`bladeburnerRank`), and the planner already publishes the rate
      // it would earn.
      const rankPerSec = ctx.state.topics.bladeburner?.plan?.ranked?.[0]?.rankPerSec;
      claims.push({
        by: "bladeburner",
        id: "work",
        resource: "time",
        amount: 1,
        shape: "step",
        pricing: "hard",
        value: { state: "unknown", reason: "a time claim is priced by `produces`, not by this field" },
        priority: PRIORITY["factions:work"],
        mode: "spend",
        ...(rankPerSec !== undefined && rankPerSec > 0
          ? { produces: { [BLADEBURNER_RANK_CHANNEL]: rankPerSec } }
          : {}),
      });
    }
    return claims;
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
      },
    ];
  },
};

export const sleevesModule: FeatureModule = {
  driver: sleeves,
  reset: (state) => {
    resetSleeveCompletions();
    delete state.topics.sleeves;
  },
  claims: (ctx) => {
    const view = sleeveView(ctx.state);
    if (!view) return [];
    const decision = stepSleeves(view, ctx.board);
    // The batch now runs as one stub per task type plus a read-back, so the RAM
    // the arbiter must find at once is the LARGEST of those, not their sum.
    const methods = sleeveBatchPeakMethods(decision.assignments.map((entry) => entry.task.type));
    if (methods.length === 0 && pendingSleeveCompletions().size === 0) return [];
    return [actionRamClaim(ctx, "sleeves", "action:batch", methods.length > 0 ? methods : ["sleeve.getTask"])];
  },
};

export const goModule: FeatureModule = {
  driver: go,
  reset: (state) => {
    goGeneration++;
    goTurnRunning = false;
    // goPlanning is deliberately not cleared here: its owner always clears it
    // in a finally, and clearing it early would let a fresh tick plan
    // concurrently with the reset one.
    goCompletionReady = false;
    goContinuationReady = false;
    // The topic is deleted below, so the next pass hydrates regardless; clearing
    // keeps the flag from outliving the board it described.
    goRehydrate = false;
    goRehydrateReason = undefined;
    goPredictionParent = undefined;
    goCheatSuccessByCount = undefined;
    goTurnReadyAt = undefined;
    resetGoPlaybookLine();
    goPlaybookEntry = undefined;
    // Drop board/seed work crossing a prestige. The worker itself remains the
    // single V9 owner across controller handoffs; its backend is rebuilt after
    // this reset before the successor game is evaluated.
    if (testGoRuntime) void testGoRuntime.reset();
    else resetGoNeuralWorkerRuntime();
    goTickPhase = undefined;
    goAnchorFailedAt = 0;
    delete state.topics.go;
  },
  claims: (ctx) => {
    if (goTurnRunning || (goCompletionReady && !goContinuationReady)) return [];
    if (!goActionAdmitted(ctx.state, ctx.caps)) return [];
    const action = goClaimAction(ctx.state, ctx.caps);
    const methods = goMethods(action, goCheatUnlocked(ctx.caps));
    if (!action || methods.length === 0) return [];
    return [actionRamClaim(ctx, "go", goActionClaimId(action), methods)];
  },
};

export const stanekModule: FeatureModule = {
  driver: stanek,
  reset: resetWithTopic("stanek"),
  claims: (ctx) => maybeActionClaim(
    "stanek",
    ctx,
    ctx.state.topics.stanek?.plan?.chargeOrder?.length ? "charge" : undefined,
    ["stanek.chargeFragment"],
  ),
};

export const dnetModule: FeatureModule = {
  driver: dnet,
  reset: (state) => {
    // Module state as well as the topic: an agent's knowledge describes the
    // world we just left, and a BitNode reset destroys the darknet outright.
    // A stale fold surviving a prestige would hand the new node the old net's
    // map, which is the same class of bug as a stale topic.
    dnetKnowledge = undefined;
    dnetCodes = {};
    dnetSpread = undefined;
    dnetFarm = undefined;
    dnetListen = undefined;
    dnetHold = undefined;
    // Backdoors and stasis links are per-WORLD: a prestige rebuilds the net and
    // `prestigeDarknetState` drops every link with it, so carrying either set
    // across would have home believing it held reach it does not.
    dnetBackdoored = new Map();
    dnetBackdoorReport = undefined;
    dnetBackdoorNextAt = 0;
    dnetStasisLinked = new Set();
    dnetCharismaNeeded = undefined;
    dnetKarmaLoss = 0;
    dnetGrammar = undefined;
    // `prestigeDarknetState` restamps `lastPhishingCacheTime`, so an install
    // starts with the window SHUT. Clearing this to undefined would tell the
    // next controller the opposite; stamping it now is what upstream does.
    dnetLastPhishCacheAt = Date.now();
    dnetLabCacheSince = undefined;
    // The vault goes with the knowledge, and for a stronger reason: a BitNode
    // reset destroys the darknet outright, so every password we hold is for a
    // host that no longer exists. Carrying them across would be the credential
    // equivalent of a map of a dead world.
    dnetVault = new Map();
    dnetUnknownModels = {};
    dnetAgentsSeen = new Set();
    dnetAgents = new Map();
    dnetResidentsLost = 0;
    dnetOverseerBeatAt = 0;
    dnetSeedAttempts = 0;
    dnetSeedNextAt = 0;
    dnetSeedBackoffMs = DNET_SEED_BACKOFF_MS;
    resetWithTopic("dnet")(state);
  },
  claims: (ctx) => {
    // The seed is the ONLY darknet action home performs, so it is the only thing
    // there is to reserve RAM for. `stepDarknet` used to propose traversal
    // actions here too; none of them were executable from home, so the claim
    // beside them reserved RAM for work that always refused.
    if (dnetSeedWanted(ctx.state)) {
      return [actionRamClaim(ctx, "dnet", "action:seed", DNET_SEED_METHODS)];
    }
    return [];
  },
  needs: dnetNeeds,
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
  if (action === "stop") return ["bladeburner.stopBladeburnerAction"];
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

/** Positional-superko history equality. Both sides are newest-first lists of
 * board rows: the game's own `previousBoards` (go.getMoveHistory returns it
 * directly) and the mirror's copy, advanced by unshift. */
function sameGoHistory(live: readonly string[][], mirror: readonly string[][]): boolean {
  if (live.length !== mirror.length) return false;
  return live.every((position, index) => {
    const held = mirror[index];
    return held !== undefined && position.length === held.length
      && position.every((column, row) => column === held[row]);
  });
}

type GoVerification = "match" | "drift" | "unavailable" | "skipped";

/** Read the game's own rows and compare them with the mirror we just merged.
 *
 * ORDINARY lane on purpose. The turn runs on the exclusive long lane, whose
 * running-guard rejects a second concurrent call outright ("a Go turn is
 * already running"), and go.getBoardState is 4 GB — folding it into the turn's
 * method list would push that grant from 6.6 GB to 10.6 GB of CONTIGUOUS RAM on
 * a single non-home host, since the long lane is banned from home. As its own
 * 6.1 GB stub (1.6 base + 4 + 0.5 margin) it may sit on home and competes with
 * nothing the turn needs.
 *
 * Deliberately NOT declared in goModule.claims: that returns exactly one claim
 * per pass, and a permanent 4.5 GB claim would inflate Go's continuous
 * reservation and fight goActionAdmitted. A queued verification degrades into a
 * hydrate, which is the correct behaviour. */
async function verifyGoMirror(
  ctx: DriverContext,
  expected: readonly string[],
  expectedHistory: readonly string[][],
): Promise<{ result: GoVerification; ms: number; scope?: "board" | "history" }> {
  const startedAt = Date.now();
  // go.getMoveHistory is 0 GB, so reading it here is FREE and keeps the whole
  // check to a single consistent post-turn observation. It is also the only
  // thing that can validate `previousBoards` — the positional-superko set —
  // which the board rows alone cannot.
  const live = await act(
    ctx,
    "go",
    "verify",
    ["go.getBoardState", "go.getMoveHistory"],
    (stubNs: NS) => ({
      board: stubNs["go"]["getBoardState"](),
      history: stubNs["go"]["getMoveHistory"](),
    }),
    (value) => ({ ok: value.board.length > 0, detail: `verified ${value.board.length}x${value.board.length} board` }),
  );
  const ms = Date.now() - startedAt;
  if (!live?.board.length) return { result: "unavailable", ms };
  const sameBoard = live.board.length === expected.length
    && live.board.every((column, index) => column === expected[index]);
  if (!sameBoard) return { result: "drift", ms, scope: "board" };
  if (!sameGoHistory(live.history, expectedHistory)) return { result: "drift", ms, scope: "history" };
  return { result: "match", ms };
}

function goMethods(
  action: string | undefined,
  cheatUnlocked = false,
  /** A phase-aligned certified start waits for its exact engine tick inside
   * the dodge, which needs the same cheap clock reads a Black turn prices. */
  alignedStart = false,
): readonly string[] {
  if (action === "hydrate") return [
    "go.getBoardState",
    "go.getMoveHistory",
    ...(cheatUnlocked ? ["go.cheat.getCheatCount", "go.cheat.getCheatSuccessChance"] : []),
  ];
  // Seed anchoring is split out precisely because it is cheap: 0.5 GB of
  // getPlayer instead of the 4 GB go.makeMove grant, which must not be held
  // while waiting for an engine tick.
  if (action === "align") return ["getPlayer", "sleep"];
  // A dispatch-time seed change can legitimately flip the V9 decision between
  // move and pass. Price both calls for every Black turn so the exact action is
  // always executable. passTurn is zero-RAM in v3.0.1, so this does not enlarge
  // the 4 GB move grant.
  if (action === "move" || action === "pass" || action?.startsWith("cheat")) {
    // Every cheat action costs the same 8 GB and exactly one is called. Pricing
    // one representative method reserves the exact maximum dynamic-RAM path
    // without incorrectly summing four mutually exclusive calls.
    return cheatUnlocked
      ? ["getPlayer", "sleep", "go.getGameState", "go.cheat.playTwoMoves"]
      : ["getPlayer", "sleep", "go.getGameState", "go.makeMove", "go.passTurn"];
  }
  if (action === "resume") return ["go.getGameState", "go.opponentNextTurn"];
  if (action === "newGame") {
    return alignedStart
      ? ["getPlayer", "sleep", "go.resetBoardState"]
      : ["go.resetBoardState"];
  }
  return [];
}

/** The peak single-stub cost of a batch: every sleeve method is SleeveBase, so
 * the largest step is one setter (or the getTask read-back). Reserving the sum
 * would re-create the 30 GB contiguous demand the split exists to remove. */
function sleeveBatchPeakMethods(actions: readonly string[]): readonly string[] {
  for (const action of actions) {
    const methods = sleeveMethods(action);
    if (methods.length > 0) return methods;
  }
  return ["sleeve.getTask"];
}

/** What the seed stub calls. The seed is the one darknet action home performs
 * itself, and it is a real 1.9 GB of dynamic RAM inside the stub — pricing it is
 * what makes the claim honest, because an unpriced action would place a stub the
 * broker never reserved for. */
const DNET_SEED_METHODS: readonly string[] = ["scp", "exec"];

/** A dollar held through the install transaction advances the binding money
 * clock by 1 / measuredIncome seconds. Scale by how much of the install clock
 * the published money marginal actually binds. Missing income or marginal
 * evidence stays unknown; it is never fabricated as a zero curve. */
function progressionReserveValueCurve(claim: Claim, ctx: ClaimContext): ClaimValueCurve | undefined {
  if (
    claim.resource !== "money"
    || claim.shape !== "continuous"
    || (claim.id !== "imminent-install" && claim.id !== "install-freeze")
  ) return undefined;
  const marginal = ctx.state.topics.progression?.plan?.marginals?.money;
  if (!marginal || marginal.state === "unknown") return undefined;
  if (!(marginal.secondsPerRelativeRate > 0)) return { demandAt: () => 0 };

  const progression = ctx.state.topics.progression;
  // Same distortion-corrected earnings as the route rates (earnedSinceInstall).
  const earned = earnedSinceInstall(ctx.state);
  const resetAt = progression?.lastAugReset;
  const elapsedSec = resetAt === undefined ? 0 : Math.max(0, (ctx.now - resetAt) / 1_000);
  if (earned === undefined || !(earned > 0) || !(elapsedSec > 0)) return undefined;
  const incomePerSec = earned / elapsedSec;
  if (!(incomePerSec > 0)) return undefined;

  const installSec = usableForecastSec(ctx.horizons.install);
  const bindingFraction = installSec !== undefined && installSec > 0
    ? Math.min(1, marginal.secondsPerRelativeRate / installSec)
    : 1;
  const valuePerDollar = bindingFraction / incomePerSec;
  return {
    demandAt: (lambda) => Math.max(0, lambda) <= valuePerDollar ? claim.amount : 0,
  };
}

export const progressionModule: FeatureModule = {
  driver: progression,
  reset: (state: GameState, kind) => {
    reset();
    // Rates and the route choice describe the node that just ended; the next
    // one re-measures and re-decides from scratch.
    const completedCycle = progressionMemory.cyclePoints.length >= 2
      ? progressionMemory.cyclePoints
      : progressionMemory.previousCyclePoints;
    const augmentationCycles = [...progressionMemory.augmentationCycles];
    if (kind === "augmentation") {
      const next = state.topics.progression;
      const previousResetAt = progressionMemory.cycleResetAt;
      const previousAugCount = progressionMemory.cycleStartAugCount;
      if (next && previousResetAt !== undefined && previousAugCount !== undefined) {
        const completed: AugmentationCycle = {
          sec: Math.max(0, (next.lastAugReset - previousResetAt) / 1_000),
          augmentations: Math.max(0, next.augCount - previousAugCount),
        };
        if (completed.sec > 0 && completed.augmentations > 0) augmentationCycles.push(completed);
      }
    }
    progressionMemory = freshProgressionMemory();
    if (kind === "augmentation" && completedCycle) {
      progressionMemory.previousCyclePoints = completedCycle;
    }
    if (kind === "augmentation") {
      progressionMemory.augmentationCycles = augmentationCycles.slice(-6);
    }
    routeChange = undefined;
    lastRouteEmit = undefined;
    // The install that just happened wiped the program, so the next cycle must
    // be free to buy it again.
    darkscapeGrantedAt = undefined;
    resetInstallSignal();
    // Field-level, not the whole topic: the gate batch has ALREADY written
    // the new node's bitNode/sourceFiles/ownedAugs into it by the time the
    // reset walk runs. The plan (route, ETA, phase) and the multiplier latch
    // are ours and describe the dead node — dropping the latch also re-arms
    // the progression.mults probe.
    if (state.topics.progression) {
      delete state.topics.progression.plan;
      delete state.topics.progression.multipliers;
    }
  },
  refresh: progressionRefresh,
  needs: (ctx) => {
    const plan = readablePlan(ctx.state);
    const route = plan?.route === undefined ? undefined : plan.routes?.find((candidate) => candidate.id === plan.route);
    if (!route?.needs) return [];
    return route.needs.map((need): Need => ({
      by: "progression",
      kind: need.kind,
      ...(need.subject !== undefined ? { subject: need.subject } : {}),
      target: need.target,
      have: need.have,
      weight: 5,
      urgency: "blocking",
    }));
  },
  claims: (ctx) => {
    const plan = readablePlan(ctx.state);
    if (plan?.completion?.execute) {
      return [actionRamClaim(
        ctx,
        "progression",
        "action:complete-bitnode",
        ["singularity.destroyW0r1dD43m0n"],
        PRIORITY["progression:terminal-action"],
      )];
    }
    // A pending route action is additive: it does NOT excuse the bankroll
    // reservations below. An unfunded createGang/joinBladeburner can stay
    // pending for many arbitration passes, and leaving the install brakes off
    // for that window lets investments spend cash the armed reset would wipe.
    const routeClaims: FeatureClaim[] = [];
    if (plan?.routeAction?.type === "createGang") {
      routeClaims.push(actionRamClaim(
        ctx,
        "progression",
        "action:create-gang",
        ["gang.createGang"],
      ));
    }
    if (plan?.routeAction?.type === "joinBladeburner") {
      routeClaims.push(actionRamClaim(
        ctx,
        "progression",
        "action:join-bladeburner",
        ["bladeburner.joinBladeburnerDivision"],
      ));
    }
    // Darknet access. Posted from routeClaims so it survives the imminent-install
    // reserve check below only when it should: the program is wiped by the very
    // install that reserve is protecting, so buying it minutes beforehand throws
    // the money away. Falling through to the brake is correct.
    if (shouldBuyDarkscape(ctx)) {
      routeClaims.push({
        by: "progression",
        id: "unlock:darkscape",
        resource: "money",
        amount: DARKSCAPE_TOTAL_COST,
        priority: PRIORITY["income:investment"],
        mode: "spend",
        // Indivisible: there is no smaller version of a program, and it cannot
        // be written (`create: null` upstream). Hard rather than economic
        // because its payoff — the .cache reward table — is unmodelled, and
        // asserting an income rate we have never measured would be worse than
        // admitting we are buying it on affordability. The 10% affordability
        // guard in stepDarkscape is what keeps an unpriced claim from
        // displacing a priced investment.
        shape: "step",
        pricing: "hard",
        value: { state: "unknown", reason: "darknet cache yield is not modelled" },
      });
    }

    if (!plan?.installReady) {
      // The IMMINENT-install brake: when the install forecast says the reset
      // is minutes away, everything with an install lifetime stops buying —
      // its ROI window is about to close. The reserve outranks ordinary
      // investments but not reset prerequisites; `installReady` later applies
      // the full freeze.
      const installSec = usableForecastSec(ctx.horizons.install);
      if (installSec !== undefined && installSec < IMMINENT_INSTALL_SEC) {
        routeClaims.push({
          by: "progression",
          id: "imminent-install",
          resource: "money",
          amount: ctx.state.topics.player?.money ?? 0,
          priority: PRIORITY["progression:imminent-install"],
          mode: "reserve",
          shape: "continuous",
        });
      }
      return routeClaims;
    }
    const claims: FeatureClaim[] = [...routeClaims, {
      by: "progression",
      id: "install-freeze",
      resource: "money",
      amount: ctx.state.topics.player?.money ?? 0,
      priority: PRIORITY["progression:install-freeze"],
      mode: "reserve",
      shape: "continuous",
    }];
    if (plan.install) {
      claims.push(actionRamClaim(
        ctx,
        "progression",
        "action:install",
        ["singularity.installAugmentations"],
        PRIORITY["progression:terminal-action"],
      ));
    }
    return claims;
  },
  valueCurve: progressionReserveValueCurve,
};
