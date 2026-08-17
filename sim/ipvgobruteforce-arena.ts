import { playMove, scoreBoard, type GoBoard } from "../shared/strategy/go/rules.ts";
import { oracleInitialBoard, oracleInitialBoards } from "./features/go-oracle.ts";
import { GoColor, GoOpponent, GoPlayType } from "./vendor/bitburner/src/Go/Enums.ts";
import { getMove } from "./vendor/bitburner/src/Go/boardAnalysis/goAI.ts";
import { getNewBoardStateFromSimpleBoard } from "./vendor/bitburner/src/Go/boardState/boardState.ts";
import { Go, sleepLog } from "./vendor/bitburner/src/Go/OracleStubs.ts";
import {
  normalizePhase,
  packPlaybookBoard,
  playbookLookupMove,
  playbookModel,
  playbookOpponents,
  playbookRoute,
  type PlaybookRoute,
  type PhasePlaybook,
  type PlaybookMove,
} from "../ipvgobruteforce/arena/playbook.ts";

const OPPONENTS: Readonly<Record<string, { oracle: GoOpponent; komi: number }>> = {
  Netburners: { oracle: GoOpponent.Netburners, komi: 1.5 },
  "Slum Snakes": { oracle: GoOpponent.SlumSnakes, komi: 3.5 },
  "The Black Hand": { oracle: GoOpponent.TheBlackHand, komi: 3.5 },
  Tetrads: { oracle: GoOpponent.Tetrads, komi: 5.5 },
  Daedalus: { oracle: GoOpponent.Daedalus, komi: 5.5 },
  Illuminati: { oracle: GoOpponent.Illuminati, komi: 7.5 },
};

export function playbookInitialBoard(enemy: string, phase: number, handicapSeed: number): GoBoard {
  const opponent = OPPONENTS[enemy];
  if (!opponent) throw new Error(`arena does not support ${enemy}`);
  return oracleInitialBoard(5, opponent.oracle, phase * 200, handicapSeed);
}

export function playbookInitialBoardAtPlaytime(
  enemy: string,
  playtime: number,
  handicapSeed: number,
): GoBoard {
  const opponent = OPPONENTS[enemy];
  if (!opponent) throw new Error(`arena does not support ${enemy}`);
  return oracleInitialBoard(5, opponent.oracle, playtime, handicapSeed);
}

export function playbookInitialBoardsAtPlaytime(enemy: string, playtime: number): GoBoard[] {
  const opponent = OPPONENTS[enemy];
  if (!opponent) throw new Error(`arena does not support ${enemy}`);
  return oracleInitialBoards(5, opponent.oracle, playtime);
}

export function netburnersInitialBoard(phase: number, defenseSeed: number): GoBoard {
  return playbookInitialBoard("Netburners", phase, defenseSeed);
}

export type ArenaTiming = "minimum" | "maximum" | "random";

export interface PlaybookArenaOptions {
  timing: ArenaTiming;
  defenseSeed: number;
  timingSeed?: number;
  tieRoll?: number;
  maxPolicyRounds?: number;
  trace?: boolean;
  opponent?: string;
  /** Enter an already committed root policy even if that phase would choose a
   * different route when optimized again from zero elapsed waits. */
  enterCommittedPhase?: boolean;
  /** Exercise the standalone runtime's accelerated-AI phase resynchronization. */
  bonusCycles?: number;
  /** Full Player.totalPlaytime at board creation. Its phase must equal the
   * committed entry phase. This must not be reduced to the nominal WHRNG period. */
  entryPlaytime?: number;
}

export interface PlaybookArenaTrace {
  step: number;
  phase: number;
  passes: number;
  alignmentCredit: number;
  board: string[];
  action: PlaybookMove;
  waitMilliseconds?: number;
  processingMilliseconds?: number;
  playtimeBeforeResponse?: number;
  playtimeAfterResponse?: number;
  waits?: number[];
  placementMilliseconds?: number;
}

export interface PlaybookArenaGame {
  enemy: string;
  startPhase: number;
  entryPhase: number;
  dodgedBoards: number;
  timing: ArenaTiming;
  defenseSeed: number;
  tieRoll: number | null;
  completed: boolean;
  won: boolean;
  score: { X: number; O: number };
  policyRounds: number;
  opponentTurns: number;
  alignments: number;
  controlledSleeps: number;
  whiteNoOps: number;
  completionTicks: { one: number; two: number; three: number; four: number; fiveOrMore: number };
  processingMilliseconds: { minimum: number | null; maximum: number | null };
  finalPhase: number;
  failure?: string;
  trace?: PlaybookArenaTrace[];
}

export interface RuntimeRootAudit {
  epochs: number[];
  roots: number;
  boards: number;
  misses: number;
  examples: Array<{
    enemy: string;
    entryPhase: number;
    epoch: number;
    playtime: number;
    board: string;
  }>;
}

export function auditPlaybookRuntimeRoots(
  playbook: PhasePlaybook,
  routes: readonly PlaybookRoute[],
  epochs: readonly number[],
): RuntimeRootAudit {
  let boards = 0;
  let misses = 0;
  const examples: RuntimeRootAudit["examples"] = [];
  for (const route of routes) for (const epoch of epochs) {
    if (!Number.isInteger(epoch) || epoch < 0) throw new Error(`invalid playtime epoch ${epoch}`);
    const playtime = epoch * 30_000_000 + route.entryPhase * 200;
    for (const board of playbookInitialBoardsAtPlaytime(route.enemy, playtime)) {
      boards++;
      const packed = packPlaybookBoard(board.rows);
      let covered = playbookLookupMove(
        playbook, route.enemy, route.entryPhase, packed,
      ) !== playbook.MISS;
      if (covered) continue;
      misses++;
      if (examples.length < 50) examples.push({
        enemy: route.enemy,
        entryPhase: route.entryPhase,
        epoch,
        playtime,
        board: `0x${packed.toString(16)}`,
      });
    }
  }
  return { epochs: [...epochs], roots: routes.length, boards, misses, examples };
}

function randomFor(seed: number): () => number {
  let state = Math.floor(seed) >>> 0;
  return () => {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
    return state / 0x1_0000_0000;
  };
}

function chooseUncertainty(random: () => number, maximum: number, timing: ArenaTiming): number {
  if (timing === "minimum") return 0;
  if (timing === "maximum") return maximum;
  return Math.floor(random() * (maximum + 1));
}

/** Per-reply wall-processing budget the alignment model assumes. One ALIGN
 * anchors dispatch just after an engine rollover; each controlled reply then
 * drifts the next dispatch offset by its own processing time, so claiming
 * alignmentBoards deterministic boards requires
 * alignmentBoards * budget < one 200 ms engine cycle. The arena models this
 * drift explicitly instead of hard-coding one-tick completions, so a model
 * whose claimed board count exceeds the budget fails here rather than only in
 * the live game. */
export const CONTROLLED_REPLY_BUDGET_MS = 20;

/** Add ordinary processing and engine-offset uncertainty to the exact sum of
 * upstream AI waitCycle/pattern/placement sleeps.
 *
 * The certified +0/+1 completion window holds exactly while
 * offset + fractional pattern sleeps + processing stays under two engine
 * cycles (400 ms). With up to 100 ms of pattern sleeps and a worst-case
 * 199 ms offset that leaves a 100 ms processing budget, so "maximum" probes
 * the model's guaranteed boundary at 90 ms. Heavier real-browser lag lands
 * at base+2, which the runtime detects as a miss and forfeits — a fail-safe
 * outside the model, not a covered outcome. */
export function ordinaryTurnTicks(
  random: () => number,
  timing: ArenaTiming,
  mandatoryWaitMilliseconds = 200,
): { ticks: number; processingMilliseconds: number; engineOffsetMilliseconds: number } {
  const processingMilliseconds = timing === "minimum" ? 5
    : timing === "maximum" ? 90
    : 5 + Math.floor(random() * 86);
  const engineOffsetMilliseconds = timing === "minimum" ? 0
    : timing === "maximum" ? 199
    : Math.floor(random() * 200);
  const ticks = Math.max(1, Math.floor(
    (engineOffsetMilliseconds + mandatoryWaitMilliseconds + processingMilliseconds) / 200,
  ));
  return { ticks, processingMilliseconds, engineOffsetMilliseconds };
}

function oracleState(
  board: GoBoard,
  oldestHistory: readonly string[][],
  consecutivePasses: number,
  opponent: GoOpponent,
) {
  const state = getNewBoardStateFromSimpleBoard(
    board.rows,
    undefined,
    opponent,
    GoColor.black,
  );
  // Bitburner stores newest first; the playbook hashes oldest first.
  state.previousBoards = [...oldestHistory].reverse().map((position) => position.join(""));
  state.passCount = consecutivePasses;
  state.ai = opponent;
  Go.currentGame = state;
  return state;
}

export async function playPlaybookArenaGame(
  playbook: PhasePlaybook,
  requestedStartPhase: number,
  options: PlaybookArenaOptions,
): Promise<PlaybookArenaGame> {
  const startPhase = normalizePhase(playbook, requestedStartPhase);
  const route = options.enterCommittedPhase
    ? {
        enemy: options.opponent ?? playbookOpponents(playbook)[0]!,
        entryPhase: startPhase,
        waits: 0,
      }
    : options.opponent !== undefined && "OPPONENTS" in playbook
      ? playbook.selectRoot(startPhase, options.opponent)
      : playbookRoute(playbook, startPhase);
  const { enemy, entryPhase, waits: dodgedBoards } = route;
  const opponent = OPPONENTS[enemy];
  if (!opponent) throw new Error(`arena does not support ${enemy}`);
  const model = playbookModel(playbook, enemy);
  if (model.aiSeedSlip !== 0) {
    throw new Error(`arena does not support AI seed slip ${model.aiSeedSlip}`);
  }
  if (model.alignmentBoards * CONTROLLED_REPLY_BUDGET_MS >= 200) {
    throw new Error(`alignment model claims ${model.alignmentBoards} controlled boards, `
      + `but the ${CONTROLLED_REPLY_BUDGET_MS} ms per-reply drift budget supports at most `
      + `${Math.floor(199 / CONTROLLED_REPLY_BUDGET_MS)}`);
  }
  if (normalizePhase(playbook, startPhase + dodgedBoards) !== entryPhase) {
    throw new Error(`committed route ${startPhase} does not reach ${entryPhase}`);
  }

  let playtime = options.entryPlaytime
    ?? model.playtimeEpoch * 30_000_000 + entryPhase * 200;
  if (Math.floor(playtime / 30_000_000) !== model.playtimeEpoch) {
    throw new Error(`entry playtime epoch does not match certified epoch ${model.playtimeEpoch}`);
  }
  if (normalizePhase(playbook, Math.floor(playtime / 200)) !== entryPhase) {
    throw new Error(`entry playtime ${playtime} is not in phase ${entryPhase}`);
  }
  let board = playbookInitialBoardAtPlaytime(enemy, playtime, options.defenseSeed);
  const history: string[][] = [];
  let passes = 0;
  let phase = entryPhase;
  let bonusCycles = options.bonusCycles ?? 0;
  let alignmentCredit = 0;
  /** Milliseconds past the last engine rollover at which Black dispatches.
   * ALIGN and controlled sleeps re-anchor it to zero; each controlled reply
   * advances it by that reply's processing time. */
  let controlledOffsetMilliseconds = 0;
  let policyRounds = 0;
  let opponentTurns = 0;
  let alignments = 0;
  let controlledSleeps = 0;
  let whiteNoOps = 0;
  let oneTickCompletions = 0;
  let twoTickCompletions = 0;
  let threeTickCompletions = 0;
  let fourTickCompletions = 0;
  let fiveOrMoreTickCompletions = 0;
  let minimumProcessingMilliseconds = Number.POSITIVE_INFINITY;
  let maximumProcessingMilliseconds = Number.NEGATIVE_INFINITY;
  let failure: string | undefined;
  const trace: PlaybookArenaTrace[] = [];
  const defenseRandom = options.tieRoll === undefined ? randomFor(options.defenseSeed) : () => options.tieRoll!;
  const timingRandom = randomFor(options.timingSeed ?? (options.defenseSeed ^ 0x9e37_79b9));
  const maximumRounds = options.maxPolicyRounds ?? Math.max(200, model.maximumProofRounds * 5);
  const maximumSteps = maximumRounds * 4 + (enemy === "Illuminati" ? playbook.PHASES : 0);
  const originalRandom = Math.random;

  try {
    Math.random = defenseRandom;
    for (let step = 0; passes < 2 && step < maximumSteps && policyRounds < maximumRounds; step++) {
      const packedBoard = packPlaybookBoard(board.rows);
      const packedHistory = history.map(packPlaybookBoard);
      const resynchronizing = options.bonusCycles !== undefined && "OPPONENTS" in playbook;
      const synced = !resynchronizing
        ? undefined
        : playbook.certifiedAction(
            enemy, phase, bonusCycles, packedBoard, passes, alignmentCredit, packedHistory,
          );
      if (resynchronizing && !synced) {
        phase = normalizePhase(playbook, phase + 1);
        playtime = (Math.floor(playtime / 200) + 1) * 200;
        alignmentCredit = 0;
        alignments++;
        policyRounds++;
        continue;
      }
      const encoded = synced === undefined
        ? playbookLookupMove(
            playbook, enemy, phase, packedBoard, passes, alignmentCredit, packedHistory,
          )
        : 0;
      if (synced === undefined && encoded === playbook.MISS) {
        failure = `playbook miss at phase ${phase}, round ${policyRounds}`;
        break;
      }
      if (synced) {
        alignmentCredit = synced.alignmentCredit;
        const elapsed = normalizePhase(playbook, synced.dispatchPhase - phase);
        playtime = (Math.floor(playtime / 200) + elapsed) * 200;
        phase = synced.dispatchPhase;
      }
      const action = synced?.action ?? playbook.describeMove(encoded);
      if (options.trace) trace.push({
        step,
        phase,
        passes,
        alignmentCredit,
        board: [...board.rows],
        action,
      });

      if (action.kind === "miss") {
        failure = `playbook described ${encoded} as a miss`;
        break;
      }
      if (action.kind === "align") {
        phase = normalizePhase(playbook, phase + 1);
        playtime += 200;
        alignmentCredit = model.alignmentBoards;
        controlledOffsetMilliseconds = 0;
        alignments++;
        policyRounds++;
        continue;
      }
      if (action.kind === "sleep") {
        if (!Number.isInteger(action.variant) || action.variant < 1) {
          failure = `invalid controlled sleep ${action.variant}`;
          break;
        }
        phase = normalizePhase(playbook, phase + action.variant);
        playtime += action.variant * 200;
        controlledOffsetMilliseconds = 0;
        controlledSleeps++;
        continue;
      }

      const timingControlled = alignmentCredit > 0;
      if (action.kind === "move") {
        const played = playMove(
          board,
          action.x,
          action.y,
          "X",
          new Set(history.map((position) => position.join(""))),
        );
        if (!played) {
          failure = `illegal black move ${action.x},${action.y} at phase ${phase}`;
          break;
        }
        history.push([...board.rows]);
        board = played.board;
        passes = 0;
      } else {
        passes++;
      }
      policyRounds++;
      if (passes >= 2) break;

      sleepLog.length = 0;
      Go.storedCycles = bonusCycles;
      const accelerated = options.bonusCycles !== undefined && bonusCycles > 0;
      const white = await getMove(
        oracleState(board, history, passes, opponent.oracle),
        GoColor.white,
        opponent.oracle,
        options.bonusCycles !== undefined,
        accelerated ? playtime : playtime + 200,
      );
      bonusCycles = Go.storedCycles;
      let placementMilliseconds = 0;
      if (white.type === GoPlayType.move) {
        if (options.bonusCycles !== undefined && bonusCycles > 0) {
          bonusCycles -= 2;
          placementMilliseconds = 40;
        } else {
          placementMilliseconds = 200;
        }
      }
      const waitMilliseconds = sleepLog.reduce((sum, wait) => sum + wait, 0)
        + placementMilliseconds;
      const ordinary = ordinaryTurnTicks(timingRandom, options.timing, waitMilliseconds);
      // ALIGN controls only the sub-tick offset. Branch-specific 200 ms AI
      // waits remain real phase advances and must never be collapsed.
      // Bonus-time dispatch is deliberately aligned just after q+1. Its three
      // accelerated waits consume 80/120 ms, not the ordinary mandatory
      // 200 ms. Add only modeled processing latency; stacking another full
      // uncertainty tick here fabricated q+3 states that cannot occur in the
      // scoped 200..360 ms model.
      const acceleratedProcessingMilliseconds = options.timing === "minimum" ? 5
        : options.timing === "maximum" ? 50
        : 5 + Math.floor(timingRandom() * 46);
      const acceleratedMilliseconds = waitMilliseconds + acceleratedProcessingMilliseconds;
      const playtimeBeforeResponse = playtime;
      const acceleratedTicks = Math.floor(
        ((playtime % 200) + acceleratedMilliseconds) / 200,
      );
      const controlledProcessingMilliseconds = options.timing === "minimum" ? 5
        : options.timing === "maximum" ? CONTROLLED_REPLY_BUDGET_MS
        : 5 + Math.floor(timingRandom() * (CONTROLLED_REPLY_BUDGET_MS - 4));
      let controlledTicks = Math.max(1, Math.floor(waitMilliseconds / 200));
      if (!accelerated && timingControlled) {
        const controlledWall = controlledOffsetMilliseconds + waitMilliseconds
          + controlledProcessingMilliseconds;
        controlledTicks = Math.max(1, Math.floor(controlledWall / 200));
        controlledOffsetMilliseconds = controlledWall % 200;
      }
      const elapsedTicks = accelerated
        ? (1 + acceleratedTicks) as 1 | 2
        : timingControlled ? controlledTicks : ordinary.ticks;
      if (elapsedTicks === 1) oneTickCompletions++;
      else if (elapsedTicks === 2) twoTickCompletions++;
      else if (elapsedTicks === 3) threeTickCompletions++;
      else if (elapsedTicks === 4) fourTickCompletions++;
      else fiveOrMoreTickCompletions++;
      minimumProcessingMilliseconds = Math.min(
        minimumProcessingMilliseconds, ordinary.processingMilliseconds,
      );
      maximumProcessingMilliseconds = Math.max(
        maximumProcessingMilliseconds, ordinary.processingMilliseconds,
      );
      if (options.bonusCycles !== undefined) {
        playtime += acceleratedMilliseconds;
        phase = normalizePhase(playbook, Math.floor(playtime / 200));
      } else {
        phase = normalizePhase(playbook, phase + elapsedTicks);
        playtime += elapsedTicks * 200;
      }
      if (options.trace) Object.assign(trace.at(-1)!, {
        waitMilliseconds,
        processingMilliseconds: accelerated ? acceleratedProcessingMilliseconds
          : ordinary.processingMilliseconds,
        playtimeBeforeResponse,
        playtimeAfterResponse: playtime,
        waits: [...sleepLog],
        placementMilliseconds,
      });
      if (alignmentCredit > 0) alignmentCredit--;
      opponentTurns++;

      if (white.type === GoPlayType.move) {
        const played = playMove(
          board,
          white.x,
          white.y,
          "O",
          new Set(history.map((position) => position.join(""))),
        );
        if (played) {
          history.push([...board.rows]);
          board = played.board;
          passes = 0;
        } else {
          // Upstream priority moves can be rejected by positional superko. The
          // game records a non-pass no-op and leaves the position unchanged.
          whiteNoOps++;
        }
      } else {
        passes++;
      }
    }
  } finally {
    Math.random = originalRandom;
    sleepLog.length = 0;
  }

  if (!failure && passes < 2) failure = `game exceeded ${maximumRounds} policy rounds`;
  const score = scoreBoard(board, opponent.komi);
  const completed = passes >= 2;
  return {
    enemy,
    startPhase,
    entryPhase,
    dodgedBoards,
    timing: options.timing,
    defenseSeed: options.defenseSeed,
    tieRoll: options.tieRoll ?? null,
    completed,
    won: !failure && completed && score.X > score.O,
    score,
    policyRounds,
    opponentTurns,
    alignments,
    controlledSleeps,
    whiteNoOps,
    completionTicks: {
      one: oneTickCompletions,
      two: twoTickCompletions,
      three: threeTickCompletions,
      four: fourTickCompletions,
      fiveOrMore: fiveOrMoreTickCompletions,
    },
    processingMilliseconds: {
      minimum: Number.isFinite(minimumProcessingMilliseconds) ? minimumProcessingMilliseconds : null,
      maximum: Number.isFinite(maximumProcessingMilliseconds) ? maximumProcessingMilliseconds : null,
    },
    finalPhase: phase,
    ...(failure ? { failure } : {}),
    ...(options.trace ? { trace } : {}),
  };
}
