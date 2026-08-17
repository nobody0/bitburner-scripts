import type { NS } from "@ns";
import { effectiveBitNodeMultipliers } from "../../../shared/features/bitnode.ts";
import { PRIORITY, type Claim, type ClaimValueCurve } from "../../../shared/strategy/arbiter.ts";
import {
  isSoA,
  NEUROFLUX,
  nextPurchasableAugmentation,
  scoreAugMults,
  weightsForRoute,
} from "../../../shared/strategy/factions/augs.ts";
import {
  countClosureAffordable,
  countSlotValueFor,
  fundedActivationBatch,
  routeCountVerdict,
} from "../../../shared/strategy/progression/activation.ts";
import { liquidatableValue } from "./factions.ts";
import { AUGMENTATIONS } from "../../../shared/features/augmentations.ts";
import { stepBladeburner } from "../../../shared/strategy/bladeburner/decide.ts";
import { stepCorp } from "../../../shared/strategy/corp/stages.ts";
import { stepDarknet } from "../../../shared/strategy/dnet/decide.ts";
import { stepGang } from "../../../shared/strategy/gang/decide.ts";
import {
  GO_OPPONENTS,
  GO_REWARD_OPPONENTS,
  applyGoCheat,
  isGoCheatAction,
  isGoRewardOpponent,
  playMove,
  scoreBoard,
  territory as goTerritory,
  type GoAction,
  type GoDecision,
  type GoObservedBoardSize,
  type GoPlayingAction,
  type GoFactionOpponent,
  type GoRewardOpponent,
  type GoView,
} from "../../../shared/strategy/go/rules.ts";
import {
  goChooseSeedTarget,
  GO_DISPATCH_GUARD_MS,
  goPhaseAgrees,
  goPredictedPlaytime,
  type GoSeedTarget,
  type GoTickPhase,
} from "../../../shared/strategy/go/tick.ts";
import { runGoNeuralSeedDispatch } from "../go-neural.ts";
import { goNeuralWorkerRuntime, resetGoNeuralWorkerRuntime, type GoNeuralRuntime } from "../go-neural-worker.ts";
import {
  goNeuralPositionIdentity,
} from "../../../shared/strategy/go/neural/worker-protocol.ts";
import { GO_REWARD_RULES, goFavorRepCap, rankGoGames, type GoEtaDemand } from "../../../shared/strategy/go/rewards.ts";
import { goDemands } from "../../../shared/strategy/go/demand.ts";
import { sfLevel } from "../../../shared/features/unlock.ts";
import { GO_ENGINE_CYCLE_MS, goAiWaitMs } from "../../../shared/strategy/go/rng.ts";
import { GO_OPPONENT_MODEL } from "../../../shared/strategy/go/opponent.ts";
import type { Need } from "../../../shared/strategy/needs.ts";
import { bankedFavorActivationValue, chooseNextBitNode, dwellInstallVerdict, INSTALL_VERDICT_OVERHEAD_SEC, installCadencePushRate, installCadenceRemainingSec, installVerdict, stepProgression } from "../../../shared/strategy/progression/decide.ts";
import {
  DAEDALUS_COMBAT,
  GANG_FACTIONS,
  GANG_KARMA,
  RED_PILL,
  daedalusAugsRequired,
  stepEndgame,
  type EndgameView,
  type RouteId,
} from "../../../shared/strategy/progression/endgame.ts";
import {
  chooseRoute,
  routeEtas,
  type RouteChoice,
  type RouteRates,
} from "../../../shared/strategy/progression/eta.ts";
import {
  augmentationAcquisitionRate,
  cycleProgressExponent,
  retainCycleCurve,
  type AugmentationCycle,
  type CyclePoint,
} from "../../../shared/strategy/progression/regrowth.ts";
import {
  forecastAt,
  IMMINENT_INSTALL_SEC,
  installHorizonSec,
  installForecast,
  nodeForecast,
  shouldReforecast,
  type PlanningHorizons,
  usableForecastSec,
} from "../../../shared/strategy/progression/forecast.ts";
import { progressionMarginals } from "../../../shared/strategy/progression/marginal.ts";
import type { ProgressionPlan, RouteEtaDigest } from "../../../shared/telemetry/topics/progression.ts";
import type {
  GoActionDigest,
  GoEtaDemandDigest,
  GoGameCandidateDigest,
  GoMoveDigest,
  GoPlan,
  GoResponse,
  GoTurnResult,
} from "../../../shared/telemetry/topics/go.ts";
import { packFragments } from "../../../shared/strategy/stanek/pack.ts";
import { successChance, type CrimeStats } from "../../../shared/strategy/career/crimes.ts";
import { workRepPerSec, type WorkType } from "../../../shared/strategy/factions/rep.ts";
import { stepSleeves, type SleevesView, type SleeveTask } from "../../../shared/strategy/sleeves/decide.ts";
import { isScriptDeath } from "../errors.ts";
import { resetInstallSignal, takeInstallSignal } from "../install-signal.ts";
import { merge, set, type GameState } from "../state.ts";
import { armSleeveCompletion, consumeSleeveCompletion, pendingSleeveCompletions, resetSleeveCompletions } from "../sleeve-completion.ts";
import type { WorkTaskLike } from "../work-completion.ts";
import { actionRamClaim, featureDodge, featureGoDodge } from "./dodge.ts";
import type { FeatureClaim } from "./claims.ts";
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
    const outcome = await featureDodge(
      ctx,
      "sleeves",
      "action:batch",
      sleeveBatchMethods(decision.assignments.map((entry) => entry.task.type)),
      (stubNs: NS) => {
        const changed: number[] = [];
        for (const next of decision.assignments) {
          let ok = false;
          if (next.task.type === "recovery") ok = stubNs["sleeve"]["setToShockRecovery"](next.index);
          else if (next.task.type === "synchro") ok = stubNs["sleeve"]["setToSynchronize"](next.index);
          else if (next.task.type === "crime") ok = stubNs["sleeve"]["setToCommitCrime"](next.index, next.task.detail as never);
          else if (next.task.type === "gym") ok = stubNs["sleeve"]["setToGymWorkout"](next.index, "Powerhouse Gym" as never, next.task.detail as never);
          else if (next.task.type === "class") ok = stubNs["sleeve"]["setToUniversityCourse"](next.index, "Rothman University" as never, next.task.detail as never);
          else if (next.task.type === "faction") {
            ok = Boolean(stubNs["sleeve"]["setToFactionWork"](next.index, next.task.detail as never, next.task.workType as never));
          }
          if (ok) changed.push(next.index);
        }
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
      results["sleeves"] = { action: "batch", ok: true, detail: `updated ${outcome.value.changed.length} sleeves`, at: Date.now() };
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

function goMoveDigest(move: GoDecision["ranked"][number]): GoMoveDigest {
  const { why: _why, ...facts } = move;
  return facts;
}

function goDemandDigest(demand: GoEtaDemand): GoEtaDemandDigest {
  return { seconds: demand.seconds, share: demand.share };
}

function goGameCandidateDigest(candidate: ReturnType<typeof rankGoGames>[number]): GoGameCandidateDigest {
  const { why: _why, transientDemand, ...facts } = candidate;
  return {
    ...facts,
    ...(transientDemand ? { transientDemand: goDemandDigest(transientDemand) } : {}),
  };
}

function goFactionFavor(ctx: DriverContext): Partial<Record<GoFactionOpponent, { favor: number; remainingWorkSec: number }>> {
  const result: Partial<Record<GoFactionOpponent, { favor: number; remainingWorkSec: number }>> = {};
  const joined = new Set(ctx.state.topics.factions?.joined ?? []);
  // Only the committed intent is actionable; alternatives are not concurrent
  // faction farms.
  const intent = ctx.state.topics.factions?.plan?.objective?.intent;
  const standings = new Map((ctx.state.topics.factions?.standings ?? []).map((standing) => [standing.name, standing]));
  for (const opponent of GO_OPPONENTS) {
    if (!joined.has(opponent)) continue;
    const standing = standings.get(opponent);
    if (!standing) continue;
    result[opponent] = {
      favor: standing.favor,
      remainingWorkSec: intent?.faction === opponent ? Math.max(0, intent.repSec) : 0,
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
  alignment: "none" | "same-slot" | "boundary-replan";
  dispatchPlaytime?: number;
  player?: ReturnType<NS["getPlayer"]>;
  playerObservedAt?: number;
  action?: GoPlayingAction;
  decision?: GoDecision;
  prediction?: NonNullable<GoPlan["prediction"]>;
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
 * for the wait. Per-opponent 192-game combined arenas on one fresh corpus
 * (2026-08-17, `go:combined:arena --unrouted-baseline`), certified-root
 * routing versus the neural baseline on ordinary phases:
 *
 * | Opponent | routed line | neural, unrouted |
 * |---|---:|---:|
 * | Illuminati | 192/192 | 139/192 |
 * | Daedalus | 192/192 | 184/192 |
 * | Tetrads | 192/192 | 187/192 |
 * | The Black Hand | 192/192 | 191/192 |
 * | Netburners | 192/192 | 192/192 |
 * | Slum Snakes | 192/192 | 192/192 |
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
  if (!topic.board || !topic.previousBoards || (goCheatUnlocked(caps) && (!topic.cheat || !goCheatSuccessByCount))) return "hydrate";
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
  return usableGb > 0 && GO_ESTIMATED_GB / usableGb <= GO_MAX_FLEET_SHARE * rewardScale;
}

/** A Go candidate reports route-seconds saved per second spent playing. Its
 * opportunity cost is the fraction of productive fleet RAM occupied by the
 * fixed Go dodge. This is deliberately a marginal test: active games finish,
 * but an asymptotically positive bonus does not justify playing forever after
 * its next increment is smaller than the hacking throughput it displaces. */
export function goGamePaysForRam(utilityPerSec: number, usableGb: number): boolean {
  if (!(utilityPerSec > 0) || !(usableGb > 0)) return false;
  return utilityPerSec > GO_ESTIMATED_GB / usableGb;
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
    if (!topic.board || !topic.boardSize || !topic.previousBoards
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
        const controlled = goTerritory({ rows: hydrated.board, size: boardSize });
        merge(ctx.state, "go", {
          board: hydrated.board,
          boardSize,
          previousBoards: hydrated.history,
          moveCount: hydrated.history.length,
          territory: { black: controlled.X, white: controlled.O },
          ...(hydrated.cheat ? { cheat: {
            unlocked: true,
            count: hydrated.cheat.count,
            successChance: hydrated.cheat.successByCount[hydrated.cheat.count] ?? 0,
          } } : {}),
        });
        goContinuationReady = true;
      }
      return;
    }
    if ((claimedAction === "move" || claimedAction === "pass") && goTurnReadyAt === undefined) {
      // Cold start has no preceding Go promise to timestamp. The first pass
      // with a complete actionable Black position is its truthful boundary.
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
    const rewardView = {
      opponents: rewardOpponents,
      stats,
      joinedFactions: joined,
      factionFavor: goFactionFavor(ctx),
      demands: goDemands({
        horizons: ctx.horizons,
        sinceInstall: ctx.state.topics.progression?.moneySources?.sinceInstall,
        openNeeds: ctx.board.open,
        canEarnFactionRep: ctx.caps.unlocked.factions === "yes",
        canRunBladeburner: ctx.caps.unlocked.bladeburner === "yes",
      }),
      goPower: nodeMults?.GoPower ?? 1,
      hasSourceFile14: sfLevel(ctx.caps.sourceFiles, 14) > 0,
      favorRepCap: goFavorRepCap(sfLevel(ctx.caps.sourceFiles, 14)),
      installRemainingSec,
    } as const;
    const candidates = rankGoGames(rewardView);
    const preferred = candidates[0];
    if (!preferred) return;
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
      consecutivePasses: topic.lastTurn?.opponentResponse?.type === "pass" ? 1 : 0,
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
        why: `${preferred.totalSecSaved.toFixed(1)}s immediate and ${(preferred.horizonTransientSecSaved + preferred.horizonFavorSecSaved).toFixed(1)}s over ${preferred.planningGames} games`,
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
        why: "certified playbook line",
      } };
    } else if (provisionalPlaybookAction?.kind === "pass") {
      decision = { ...decision, action: { type: "pass", why: "certified playbook line" } };
    }
    const decisionAt = Date.now();
    const plan: GoPlan = {
      action: goActionDigest(decision.action),
      ranked: decision.ranked.map(goMoveDigest),
      input: {
        at: decisionAt,
        board: [...view.board.rows],
        previousBoards: view.previousBoards.map((position) => [...position]),
        status: view.status,
        currentPlayer: view.currentPlayer,
        opponent: view.opponent,
        ...(topic.blackScore !== undefined ? { blackScore: topic.blackScore } : {}),
        ...(topic.whiteScore !== undefined ? { whiteScore: topic.whiteScore } : {}),
        komi: view.komi,
        ...(topic.bonusCycles !== undefined ? { bonusCycles: topic.bonusCycles } : {}),
        ...(topic.cheat ? { cheatCount: topic.cheat.count } : {}),
      },
      planning: { finalistCount: decision.finalists, positionValue: decision.positionValue },
      selection: {
        preferred: goGameCandidateDigest(preferred),
        candidates: candidates.map(goGameCandidateDigest),
        context: {
          goPower: rewardView.goPower,
          hasSourceFile14: rewardView.hasSourceFile14,
          favorRepCap: rewardView.favorRepCap,
          installRemainingSec,
          joinedFactions: [...joined].sort(),
          demands: Object.fromEntries(
            Object.entries(rewardView.demands).map(([opponent, demand]) => [opponent, goDemandDigest(demand)]),
          ),
          factionFavor: rewardView.factionFavor,
        },
      },
    };

    merge(ctx.state, "go", { plan });

    let action = decision.action;
    if (action.type === "newGame") {
      // Positive but vanishing Go power is not free: the dodge occupies RAM
      // the income engine could use. Compare both in the same route-seconds
      // per elapsed-second unit and stop once the marginal game loses.
      const pie = ctx.state.topics.farm?.ramPie;
      const usableGb = pie ? pie.farm + pie.prep + pie.share + pie.free + pie.reserve : 0;
      if (!goGamePaysForRam(preferred.utilityPerSec, usableGb)) return;
      const newGameAction = action;
      // Certified playbook lines are only reachable from a phase-aligned game
      // start. The opening board itself — obstacles and the Illuminati
      // handicap stone — is generated from the engine tick the game is created
      // in, so the reset, not merely the first move, has to land on the
      // route's entry phase. Hold the reset while an affordable window
      // approaches, then dispatch it tick-exactly.
      goPlaybookEntry = undefined;
      const playbookStart = GO_PLAYBOOK_OPPONENTS[newGameAction.opponent];
      if (playbookStart && newGameAction.boardSize === 5 && goTickPhase) {
        const routeAt = Date.now();
        const route = await neuralRuntime
          .playbookRoute(goPredictedPlaytime(goTickPhase, routeAt), newGameAction.opponent)
          .catch(() => undefined);
        if (generation !== goGeneration) return;
        if (route && playbookStart.maxWaitPhases > 0 && route.waits <= playbookStart.maxWaitPhases) {
          // Too far out: hold on the driver's ordinary 5 s cadence. The slack
          // window is wider than that cadence, so the approach cannot be
          // skipped between passes.
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
          ...(topic.cheat ? { cheat: { ...topic.cheat, count: 0 } } : {}),
          plan,
          lastTurn,
        };
        delete fresh.blackScore;
        delete fresh.whiteScore;
        delete fresh.komi;
        set(ctx.state, "go", fresh);
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
          let dispatchPlayer: ReturnType<NS["getPlayer"]> | undefined;
          let dispatchPlayerObservedAt: number | undefined;
          let dispatchedAction: GoPlayingAction | undefined = action.type === "resume" || action.type === "newGame"
            ? undefined : action;
          let dispatchedDecision: GoDecision | undefined;
          let dispatchPrediction: NonNullable<GoPlan["prediction"]> | undefined;
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
                ? { type: "move" as const, x: certifiedAction.x, y: certifiedAction.y, why: "certified playbook line" }
                : certifiedAction?.kind === "pass"
                  ? { type: "pass" as const, why: "certified playbook line" }
                  : undefined;
              const decisionAt = Date.now();
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
                  preparationMs,
                  finalizationMs: evaluated.finalizationMs,
                  totalPlanningMs: decisionAt - planStartedAt,
                  engineCycleMs: GO_ENGINE_CYCLE_MS,
                  aiWaitMs: goAiWaitMs(topic.bonusCycles),
                  seedCandidates: evaluated.opponentSeeds,
                  dispatchPlaytime,
                  ...(target ? { rolloverMarginMs: target.marginMs, waitedForRollover: target.waitsForRollover } : {}),
                  boundaryRetries,
                  positionCacheHit: installed.cached,
                  pushedPredictionHit: evaluated.pushed,
                  seedCacheHit: evaluated.cached,
                } satisfies NonNullable<GoPlan["prediction"]>,
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
            dispatchPrediction = {
              ...seeded.attempt.value.prediction,
              dispatchPlaytime: seeded.attempt.dispatchPlaytime,
              boundaryRetries,
              readyToDispatchMs: Math.max(0, (moveDispatchedAt ?? Date.now()) - (goTurnReadyAt ?? planStartedAt)),
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
            // the Go action at the verified tick.
          } else if (dispatchedAction?.type === "move") {
            response = await stubNs["go"]["makeMove"](dispatchedAction.x, dispatchedAction.y);
          } else if (action.type === "resume") {
            // makeMove/passTurn already await this same promise. This branch only
            // reattaches after a restart interrupted an in-flight white turn.
            response = await stubNs["go"]["opponentNextTurn"](false, false);
          } else if (dispatchedAction?.type === "pass") {
            response = await stubNs["go"]["passTurn"]();
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
            alignment: dispatchPlayer ? boundaryRetries ? "boundary-replan" : "same-slot" : "none",
            ...(dispatchPlayer ? { dispatchPlaytime: dispatchPlayer.totalPlaytime, player: dispatchPlayer } : {}),
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
        plan.ranked = decision.ranked.map(goMoveDigest);
        plan.planning = { finalistCount: decision.finalists, positionValue: decision.positionValue };
        if (rawOutcome.prediction) plan.prediction = rawOutcome.prediction;
      }
      if (rawOutcome?.player) {
        set(ctx.state, "player", rawOutcome.player);
        ctx.state.playerObservedAt = rawOutcome.playerObservedAt ?? Date.now();
      }
      if (!rawOutcome?.response) {
        merge(ctx.state, "go", {
          plan,
          lastTurn: {
            at: result.at,
            durationMs: Date.now() - actionStartedAt,
            action: goActionDigest(action),
            timing: {
              alignment: rawOutcome?.alignment ?? "none",
              ...(rawOutcome?.dispatchPlaytime !== undefined ? { dispatchPlaytime: rawOutcome.dispatchPlaytime } : {}),
              ...(plan.prediction ? { seed: plan.prediction.seedCandidates[0] } : {}),
            },
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
      const score = topic.komi === undefined ? undefined : scoreBoard(board, topic.komi);
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
        ...(score ? { blackScore: score.X, whiteScore: score.O } : {}),
        currentPlayer: response.type === "gameOver" ? "None" : "Black",
        status: response.type === "gameOver" ? "gameOver" : "inProgress",
        plan,
        lastTurn: {
          at: result.at,
          durationMs: Date.now() - actionStartedAt,
          action: goActionDigest(action),
          opponentResponse: response,
          timing: {
            alignment: rawOutcome.alignment,
            ...(rawOutcome.dispatchPlaytime !== undefined ? { dispatchPlaytime: rawOutcome.dispatchPlaytime } : {}),
            ...(plan.prediction ? { seed: plan.prediction.seedCandidates[0] } : {}),
            ...(plan.prediction?.readyToDispatchMs !== undefined
              ? { readyToDispatchMs: plan.prediction.readyToDispatchMs }
              : {}),
          },
          ...(predictionTotal > 0 ? { predictionSupport: { matching, total: predictionTotal } } : {}),
          ok: result.ok,
          detail: result.detail,
        },
      });
      goPredictionParent = response.type === "gameOver" ? undefined : rawOutcome.predictionParentId;
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

const dnet: FeatureDriver = {
  id: "dnet",
  everyMs: 30_000,
  requires: "dnet",
  async tick(ctx: DriverContext) {
    const topic = ctx.state.topics.dnet;
    if (!topic) return;
    const decision = stepDarknet({
      topologyComplete: topic.topologyComplete === true,
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
        action: {
          type: decision.action.type,
          ...(decision.action.type !== "idle" ? { hostname: decision.action.hostname } : {}),
        },
        ranked: decision.ranked.slice(0, 8).map((entry) => ({
          hostname: entry.hostname,
          depth: entry.depth,
          unlocks: entry.unlocks,
        })),
        ...(decision.charismaNeeded !== undefined ? { charismaNeeded: decision.charismaNeeded } : {}),
        ...(results["dnet"] ? { lastResult: results["dnet"] } : {}),
      },
    });

    if (decision.action.type === "idle") return;
    // Authentication needs discovered credentials and a direct connection
    // from the script host. Stasis is stricter: setStasisLink targets
    // ctx.workerScript.getServer(), not the host selected by
    // singularity.connect(), and then waits 30 seconds. Refuse both until the
    // dispatcher can lease and execute on the intended Darknet host.
    // Source: https://github.com/bitburner-official/bitburner-src/blob/3162fd2590e221eadd0c0fbd46151913f7c4c41c/src/NetscriptFunctions/Darknet.ts#L104-L157
    // Source: https://github.com/bitburner-official/bitburner-src/blob/3162fd2590e221eadd0c0fbd46151913f7c4c41c/src/NetscriptFunctions/Darknet.ts#L337-L374
    const detail = decision.action.type === "authenticate"
      ? "password discovery and direct-host authentication are not implemented"
      : "stasis actions require execution on the target Darknet host";
    record("dnet", decision.action.type, false, detail);
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
      moneyEarned: new RateTracker(),
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
function endgameView(ctx: NeedContext): EndgameView | undefined {
  const player = ctx.state.topics.player;
  if (!player) return undefined;
  const prog = ctx.state.topics.progression;
  const factions = ctx.state.topics.factions;
  const blade = ctx.state.topics.bladeburner;

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
  const earned = progression?.moneySources?.sinceInstall?.total;
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
    // a fabricated acquisition rate for another 30 minutes.
    trackers.augs.clear();
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
  return {
    moneyPerSec: trackers.moneyEarned.perSec(),
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
    why: "",
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
    ...(statusOf.get(eta.id)?.optionalInstall
      ? { optionalInstall: statusOf.get(eta.id)!.optionalInstall }
      : {}),
  }));
  const selectedEta = choice ? etas.find((eta) => eta.id === choice.route) : undefined;
  const selectedStatus = choice ? endgame.routes.find((route) => route.id === choice.route) : undefined;
  let routeRequiresInstall = selectedStatus?.mandatoryInstall?.ready === true;
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
  const routeAugmentationFocus = choice?.route === "daedalus"
    && selectedEta?.parts.some((part) => part.resource === "combat")
      ? "combat" as const
      : "hacking" as const;
  const verdictWeights = weightsForRoute(choice?.route, routeAugmentationFocus, {
    hackingTarget: endgame.worldDaemonSkill,
    combatTarget: DAEDALUS_COMBAT,
    multipliers: (player.mults ?? {}) as unknown as Record<string, number>,
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
    countSlotValue: countSlotValueFor(daedalusRequired ?? Infinity, view.augCount),
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
      consolidationAllowed: selectedStatus?.optionalInstall.allowed === true,
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

  const decision = stepProgression({
    queued: pending,
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
    earnedThisRun: prog?.moneySources?.sinceInstall?.total ?? ctx.state.topics.farm?.totals?.moneyEarned ?? 0,
    factions: standings,
    favorToDonate: factions?.favorToDonate ?? 150,
    homeRam: ctx.state.topics.servers?.["home"]?.maxRam ?? 8,
    // No probe prices the home upgrade yet; Infinity keeps the budget advisory.
    homeRamUpgradeCost: Infinity,
    runSec,
    ...(selectedEta !== undefined ? { nodeRemainingSec: selectedEta.etaSec } : {}),
    routeRequiresInstall,
    optionalInstallAllowed: selectedStatus?.optionalInstall.allowed ?? true,
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
    blockers: decision.installBlockers.map((blocker) => blocker.kind),
    optionalAllowed: selectedStatus?.optionalInstall.allowed,
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
        optionalInstallAllowed: selectedStatus?.optionalInstall.allowed ?? true,
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
      ? { type: "joinBladeburner" as const, why: "the selected Bladeburner route has cleared the division's combat gate" }
      : choice?.route === "gang"
        && selectedStatus?.stage === "gang-create"
        && (view.karma ?? 0) <= GANG_KARMA
        && view.gangCreateFaction
        ? {
            type: "createGang" as const,
            faction: view.gangCreateFaction,
            why: `the selected BN2 gang route has cleared karma and membership gates for ${view.gangCreateFaction}`,
          }
        : undefined;
  if (!selectedEta?.complete) progressionMemory.nodeCompletionArmedAt = undefined;
  merge(ctx.state, "progression", {
    plan: {
      phase: decision.phase,
      installWanted: decision.installWanted,
      liquidationWanted: decision.liquidationWanted,
      installBlockers: decision.installBlockers.map((blocker) => ({ kind: blocker.kind })),
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
              why: canAutomateNodeCompletion
                ? nextBitNode.why
                : `${nextBitNode.why}; manual completion required until BN4/SF4 unlocks Singularity`,
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
      claims.push({
        by: "bladeburner",
        id: "work",
        resource: "time",
        amount: 1,
        shape: "step",
        pricing: "hard",
        value: { state: "unknown", reason: "the player-time slot is ordered by hard priority" },
        priority: PRIORITY["factions:work"],
        mode: "spend",
        why: "Bladeburner action occupies Player.currentWork without The Blade's Simulacrum",
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
        why: "the Bladeburner division requires 100 in every combat stat",
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
    const methods = sleeveBatchMethods(decision.assignments.map((entry) => entry.task.type));
    if (methods.length === 0 && pendingSleeveCompletions().size === 0) return [];
    return [actionRamClaim(ctx, "sleeves", "action:batch", methods.length > 0 ? methods : ["sleeve.getTask"], "update and arm sleeve work")];
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
    return [actionRamClaim(ctx, "go", goActionClaimId(action), methods, `go ${action}`)];
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
  reset: resetWithTopic("dnet"),
  claims: (ctx) => {
    const action = ctx.state.topics.dnet?.plan?.action.type;
    return maybeActionClaim("dnet", ctx, action === "idle" ? undefined : action, dnetMethods(action));
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

function sleeveBatchMethods(actions: readonly string[]): readonly string[] {
  const methods = new Set<string>(["sleeve.getTask"]);
  for (const action of actions) for (const method of sleeveMethods(action)) methods.add(method);
  return [...methods];
}

function dnetMethods(_action: string | undefined): readonly string[] {
  // Every planned Darknet action currently refuses locally; none should
  // reserve RAM or launch a misleading no-op dodge.
  return [];
}

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
  const earned = progression?.moneySources?.sinceInstall?.total;
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
      why: `${route.id}/${route.stage ?? "route"}: ${need.why}`,
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
        `complete the BitNode and enter BN${plan.completion.nextBitNode}`,
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
        `create the ${plan.routeAction.faction} gang selected by the BN2 route`,
      ));
    }
    if (plan?.routeAction?.type === "joinBladeburner") {
      routeClaims.push(actionRamClaim(
        ctx,
        "progression",
        "action:join-bladeburner",
        ["bladeburner.joinBladeburnerDivision"],
        "join the Bladeburner division selected by the endgame route",
      ));
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
          why: `install expected in ${Math.round(installSec)}s; investment ROI windows are closed`,
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
      why: "freeze cash after the final augmentation sweep until the armed install executes",
    }];
    if (plan.install) {
      claims.push(actionRamClaim(
        ctx,
        "progression",
        "action:install",
        ["singularity.installAugmentations"],
        "install queued augmentations and restart /start.js",
        PRIORITY["progression:terminal-action"],
      ));
    }
    return claims;
  },
  valueCurve: progressionReserveValueCurve,
};
