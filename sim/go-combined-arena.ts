/** Combined playbook-first / neural-fallback arena.
 *
 * Plays complete games against the vendored upstream AI with the merged
 * (optionally neural-stripped) phase playbook as the primary policy. A
 * playbook miss no longer forfeits: the production neural engine decides the
 * turn (profile candidate limit plus the deep-search finalizer) and the
 * playbook is consulted again on the next turn, so a stripped entry whose
 * action the network reproduces re-enters the certified line at full strength.
 *
 * The timing, defense-tie, and White-oracle mechanics deliberately mirror the
 * proof arena in `sim/ipvgobruteforce-arena.ts` so ledgers stay comparable.
 */
import {
  applyGoCheat,
  GO_CHEAT_LIMITS_BY_SIZE,
  isGoCheatAction,
  playMove,
  scoreBoard,
  type GoBoard,
  type GoCheatState,
  type GoRewardOpponent,
} from "../shared/strategy/go/rules.ts";
import { goArenaCheatSuccessTable } from "./go-arena.ts";
import {
  finalizeNeuralGoDecision,
  prepareNeuralGoDecision,
  type GoNeuralEngine,
} from "../shared/strategy/go/neural/engine.ts";
import { goOpponentSeedCandidates } from "../shared/strategy/go/rng.ts";
import { GO_REWARD_RULES } from "../shared/strategy/go/rewards.ts";
import { GoColor, GoOpponent, GoPlayType } from "./vendor/bitburner/src/Go/Enums.ts";
import { getMove } from "./vendor/bitburner/src/Go/boardAnalysis/goAI.ts";
import { getNewBoardStateFromSimpleBoard } from "./vendor/bitburner/src/Go/boardState/boardState.ts";
import { Go, sleepLog } from "./vendor/bitburner/src/Go/OracleStubs.ts";
import {
  normalizePlaybookPhase as normalizePhase,
  packCombinedBoard as packPlaybookBoard,
  type MergedPlaybook as MultiPhasePlaybook,
} from "../shared/strategy/go/playbook-facade.ts";
import { oracleInitialBoard } from "./features/go-oracle.ts";

const ORACLES: Record<string, { oracle: GoOpponent; komi: number }> = {
  Netburners: { oracle: GoOpponent.Netburners, komi: 1.5 },
  "Slum Snakes": { oracle: GoOpponent.SlumSnakes, komi: 3.5 },
  "The Black Hand": { oracle: GoOpponent.TheBlackHand, komi: 3.5 },
  Tetrads: { oracle: GoOpponent.Tetrads, komi: 5.5 },
  Daedalus: { oracle: GoOpponent.Daedalus, komi: 5.5 },
  Illuminati: { oracle: GoOpponent.Illuminati, komi: 7.5 },
};

export type CombinedArenaTiming = "minimum" | "maximum" | "random";

export interface CombinedArenaOptions {
  timing: CombinedArenaTiming;
  defenseSeed: number;
  timingSeed?: number;
  opponent?: string;
  /** Disable the playbook: every turn is neural (baseline arm). */
  neuralOnly?: boolean;
  /** Disable the fallback: a miss fails the game (proof-arena behavior). */
  playbookOnly?: boolean;
  /** Start at the requested phase instead of the playbook's certified root.
   * Certified roots are a biased subpopulation of the phase ring (the phases
   * where a guaranteed line exists), so a neural baseline measured on them is
   * not the neural baseline of ordinary play. This arm measures the latter in
   * the same harness. */
  unrouted?: boolean;
  maxPolicyRounds?: number;
  /** Cheat-unlocked play: neural-fallback turns may cheat on roll-safe ticks
   * (the same slip-safe WHRNG gate live play uses). With `seeded`, a certified
   * hit additionally offers the playbook-seeded double move — first stone the
   * certified move, second neural — and a chosen cheat deliberately leaves the
   * certified line (fully neural afterwards). `minOnLineTurn` delays that
   * on-line offer until the given Black policy turn, so the certified opening
   * is banked before a cheat may spend the line to finish faster; off-line
   * turns cheat regardless. */
  cheat?: { enabled: boolean; successChance?: number; seeded?: boolean; minOnLineTurn?: number };
}

export interface CombinedArenaGame {
  enemy: string;
  entryPhase: number;
  dodgedBoards: number;
  completed: boolean;
  won: boolean;
  blackScore: number;
  whiteScore: number;
  policyRounds: number;
  certifiedTurns: number;
  neuralTurns: number;
  neuralReturns: number;
  cheatsPlayed: number;
  failure?: string;
  neuralLatencyMs: number[];
}

function randomFor(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 2 ** 32;
  };
}

function ordinaryTicks(random: () => number, timing: CombinedArenaTiming, waitMs: number): number {
  const processing = timing === "minimum" ? 5 : timing === "maximum" ? 90
    : 5 + Math.floor(random() * 86);
  const offset = timing === "minimum" ? 0 : timing === "maximum" ? 199
    : Math.floor(random() * 200);
  return Math.max(1, Math.floor((offset + waitMs + processing) / 200));
}

function oracleState(
  board: GoBoard,
  oldestHistory: readonly string[][],
  consecutivePasses: number,
  opponent: GoOpponent,
) {
  const state = getNewBoardStateFromSimpleBoard(board.rows, undefined, opponent, GoColor.black);
  state.previousBoards = [...oldestHistory].reverse().map((position) => position.join(""));
  state.passCount = consecutivePasses;
  state.ai = opponent;
  Go.currentGame = state;
  return state;
}

/** A mid-line start state for outcome evaluation: the combined policy plays
 * from an arbitrary certificate state, optionally with a forced first Black
 * action (the divergence branch under test). */
export interface CombinedContinuationStart {
  enemy: string;
  phase: number;
  board: GoBoard;
  /** Oldest first, matching the certificate history column. */
  history: readonly string[][];
  passes: number;
  forcedFirstAction?: { kind: "move"; x: number; y: number } | { kind: "pass" };
}

export async function playCombinedContinuation(
  playbook: MultiPhasePlaybook,
  engine: GoNeuralEngine,
  start: CombinedContinuationStart,
  options: CombinedArenaOptions,
): Promise<CombinedArenaGame> {
  const enemy = start.enemy;
  const oracle = ORACLES[enemy];
  if (!oracle) throw new Error(`combined arena does not support ${enemy}`);
  const model = playbook.modelFor(enemy);
  let playtime = model.playtimeEpoch * 30_000_000 + normalizePhase(playbook, start.phase) * 200;
  let board = start.board;
  const history: string[][] = start.history.map((position) => [...position]);
  let passes = start.passes;
  let phase = normalizePhase(playbook, start.phase);
  let forced = start.forcedFirstAction;
  let alignmentCredit = 0;
  let policyRounds = 0;
  let certifiedTurns = 0;
  let neuralTurns = 0;
  let neuralReturns = 0;
  let offCertificate = false;
  let failure: string | undefined;
  let cheatCount = 0;
  let cheatsPlayed = 0;
  const cheatState: Omit<GoCheatState, "count"> | undefined = options.cheat?.enabled
    ? {
      unlocked: true,
      successByCount: goArenaCheatSuccessTable(options.cheat.successChance),
      candidateLimit: GO_CHEAT_LIMITS_BY_SIZE[5]!.candidateLimit,
      doubleMoveLimit: GO_CHEAT_LIMITS_BY_SIZE[5]!.doubleMoveLimit,
    }
    : undefined;
  const neuralLatencyMs: number[] = [];
  const defenseRandom = randomFor(options.defenseSeed);
  const timingRandom = randomFor(options.timingSeed ?? (options.defenseSeed ^ 0x9e37_79b9));
  const maximumRounds = options.maxPolicyRounds ?? Math.max(200, model.maximumProofRounds * 5);
  const originalRandom = Math.random;

  try {
    Math.random = defenseRandom;
    for (let step = 0; passes < 2 && policyRounds < maximumRounds && step < maximumRounds * 4; step++) {
      let action: { kind: "move"; x: number; y: number } | { kind: "pass" } | { kind: "cheat"; board: GoBoard };
      if (forced) {
        // The branch under test: the forced move replaces this turn's policy
        // and pins the game off (or on) the certified line deliberately.
        action = forced;
        forced = undefined;
        alignmentCredit = 0;
        offCertificate = true;
      } else {
      const packedBoard = packPlaybookBoard(board.rows);
      const packedHistory = history.map(packPlaybookBoard);
      const encoded = options.neuralOnly ? playbook.MISS : playbook.lookupMove(
        enemy, phase, packedBoard, passes, alignmentCredit, packedHistory);
      if (encoded !== playbook.MISS) {
        const described = playbook.describeMove(encoded);
        if (described.kind === "align") {
          phase = normalizePhase(playbook, phase + 1);
          playtime += 200;
          alignmentCredit = model.alignmentBoards;
          policyRounds++;
          certifiedTurns++;
          continue;
        }
        if (described.kind === "sleep") {
          phase = normalizePhase(playbook, phase + described.variant);
          playtime += described.variant * 200;
          certifiedTurns++;
          continue;
        }
        if (described.kind !== "move" && described.kind !== "pass") {
          failure = `playbook described ${encoded} as ${described.kind}`;
          break;
        }
        action = described.kind === "move"
          ? { kind: "move", x: described.x, y: described.y }
          : { kind: "pass" };
        if (offCertificate) {
          neuralReturns++;
          offCertificate = false;
        }
        // The seeded arm: on a certified move, let the engine weigh the
        // playbook-seeded double (first stone the certified move, second
        // neural) against the plain certified continuation. A chosen cheat
        // wins and deliberately leaves the line — the live driver's exact
        // precedence.
        let seededCheat = false;
        // The threshold counts Black turns the way the live driver does —
        // goBlackTurnIndex = floor(previousBoards.length / 2), one history
        // entry per placed stone — NOT policyRounds, which also advances on
        // certified align turns that place nothing.
        if (cheatState && options.cheat?.seeded && action.kind === "move"
          && Math.floor(history.length / 2) >= (options.cheat.minOnLineTurn ?? 0)) {
          const view = {
            board,
            currentPlayer: "Black",
            opponent: enemy as GoRewardOpponent,
            status: "inProgress",
            previousBoards: [...history].reverse(),
            consecutivePasses: passes,
            komi: GO_REWARD_RULES[enemy as GoRewardOpponent].komi,
            bonusCycles: 0,
            cheat: { ...cheatState, count: cheatCount },
          } as const;
          const started = performance.now();
          const decision = await finalizeNeuralGoDecision(
            prepareNeuralGoDecision(view),
            goOpponentSeedCandidates(playtime, 0),
            engine,
            playtime,
            { preferredFirstMove: { x: action.x, y: action.y } },
          );
          neuralLatencyMs.push(performance.now() - started);
          // Mirrors resolveGoExactAction: a cheat from an evaluation whose
          // certified benchmark was dropped never competed against the
          // certified continuation, so the certified move stands.
          if (decision.preferredFirstMoveRetained !== false && isGoCheatAction(decision.action)) {
            const cheated = applyGoCheat(board, decision.action);
            if (!cheated) {
              failure = `seeded cheat produced invalid ${decision.action.type}`;
              break;
            }
            action = { kind: "cheat", board: cheated.board };
            cheatCount++;
            cheatsPlayed++;
            neuralTurns++;
            alignmentCredit = 0;
            offCertificate = true;
            seededCheat = true;
          }
        }
        if (!seededCheat) certifiedTurns++;
      } else if (options.playbookOnly) {
        failure = `playbook miss at phase ${phase}, round ${policyRounds}`;
        break;
      } else {
        // Neural fallback: the production decision at the current tick.
        //
        // The alignment credit is deliberately NOT reset here. It records how
        // many further boards the certificate proved under controlled timing,
        // which is a property of the environment plus our own prompt dispatch,
        // not of who chose the move — and it is part of an entry's lookup key,
        // so zeroing it makes every later entry of the line unmatchable even
        // when the network reproduces the certified move exactly. A genuine
        // divergence produces a board and history no
        // certified entry on this line carries, so a preserved credit cannot
        // match the wrong entry; it only keeps the right one reachable.
        offCertificate = true;
        const view = {
          board,
          currentPlayer: "Black",
          opponent: enemy as GoRewardOpponent,
          status: "inProgress",
          previousBoards: [...history].reverse(),
          consecutivePasses: passes,
          komi: GO_REWARD_RULES[enemy as GoRewardOpponent].komi,
          bonusCycles: 0,
          ...(cheatState ? { cheat: { ...cheatState, count: cheatCount } } : {}),
        } as const;
        const started = performance.now();
        const decision = await finalizeNeuralGoDecision(
          prepareNeuralGoDecision(view),
          goOpponentSeedCandidates(playtime, 0),
          engine,
          playtime,
        );
        neuralLatencyMs.push(performance.now() - started);
        neuralTurns++;
        if (decision.action.type === "move") {
          action = { kind: "move", x: decision.action.x, y: decision.action.y };
        } else if (decision.action.type === "pass") {
          action = { kind: "pass" };
        } else if (isGoCheatAction(decision.action)) {
          const cheated = applyGoCheat(board, decision.action);
          if (!cheated) {
            failure = `neural fallback produced invalid ${decision.action.type}`;
            break;
          }
          action = { kind: "cheat", board: cheated.board };
          cheatCount++;
          cheatsPlayed++;
          // Live play zeroes the playbook line on ANY dispatched cheat
          // (resetGoPlaybookLine): the diverged board can never match a
          // certified entry again. Keeping the credit here — as the comment
          // above rightly does for reproduced MOVES — would let this arm
          // re-match credit-window entries live play cannot reach.
          alignmentCredit = 0;
        } else {
          failure = `neural fallback produced ${decision.action.type}`;
          break;
        }
      }
      }

      const timingControlled = alignmentCredit > 0;
      if (action.kind === "cheat") {
        // Cheat transitions were resolved by applyGoCheat above; like the
        // game, a cheat records no history entry.
        board = action.board;
        passes = 0;
      } else if (action.kind === "move") {
        const played = playMove(board, action.x, action.y, "X",
          new Set(history.map((position) => position.join(""))));
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
      Go.storedCycles = 0;
      const white = await getMove(
        oracleState(board, history, passes, oracle.oracle),
        GoColor.white, oracle.oracle, false, playtime + 200);
      let placementMs = 0;
      if (white.type === GoPlayType.move) placementMs = 200;
      const waitMs = sleepLog.reduce((sum, wait) => sum + wait, 0) + placementMs;
      let elapsedTicks: number;
      if (timingControlled) {
        elapsedTicks = Math.max(1, Math.floor(waitMs / 200));
      } else {
        elapsedTicks = ordinaryTicks(timingRandom, options.timing, waitMs);
      }
      phase = normalizePhase(playbook, phase + elapsedTicks);
      playtime += elapsedTicks * 200;
      if (alignmentCredit > 0) alignmentCredit--;

      if (white.type === GoPlayType.move) {
        const played = playMove(board, white.x, white.y, "O",
          new Set(history.map((position) => position.join(""))));
        if (played) {
          history.push([...board.rows]);
          board = played.board;
          passes = 0;
        }
        // A superko-rejected priority move is a non-pass no-op upstream.
      } else {
        passes++;
      }
    }
  } finally {
    Math.random = originalRandom;
    sleepLog.length = 0;
  }

  if (!failure && passes < 2) failure = `game exceeded ${maximumRounds} policy rounds`;
  const score = scoreBoard(board, oracle.komi);
  return {
    enemy,
    entryPhase: normalizePhase(playbook, start.phase),
    dodgedBoards: 0,
    completed: passes >= 2,
    won: passes >= 2 && score.X > score.O,
    blackScore: score.X,
    whiteScore: score.O,
    policyRounds,
    certifiedTurns,
    neuralTurns,
    neuralReturns,
    cheatsPlayed,
    ...(failure ? { failure } : {}),
    neuralLatencyMs,
  };
}

export async function playCombinedArenaGame(
  playbook: MultiPhasePlaybook,
  requestedStartPhase: number,
  engine: GoNeuralEngine,
  options: CombinedArenaOptions,
): Promise<CombinedArenaGame> {
  const startPhase = normalizePhase(playbook, requestedStartPhase);
  const route = options.unrouted
    ? { enemy: options.opponent ?? playbook.OPPONENTS[0]!, entryPhase: startPhase, waits: 0 }
    : playbook.selectRoot(startPhase, options.opponent)
      ?? { enemy: options.opponent ?? playbook.OPPONENTS[0]!, entryPhase: startPhase, waits: 0 };
  const oracle = ORACLES[route.enemy];
  if (!oracle) throw new Error(`combined arena does not support ${route.enemy}`);
  const model = playbook.modelFor(route.enemy);
  const playtime = model.playtimeEpoch * 30_000_000 + route.entryPhase * 200;
  const result = await playCombinedContinuation(playbook, engine, {
    enemy: route.enemy,
    phase: route.entryPhase,
    board: oracleInitialBoard(5, oracle.oracle, playtime, options.defenseSeed),
    history: [],
    passes: 0,
  }, options);
  return { ...result, dodgedBoards: route.waits };
}
