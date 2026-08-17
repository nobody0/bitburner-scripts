/** Bounded DAgger actors from fixed points on frozen-student routes. */
import { createHash } from "node:crypto";
import { rename, unlink } from "node:fs/promises";
import {
  GoNeuralEngine, finalizeNeuralGoDecision, prepareNeuralGoDecision,
} from "../../shared/strategy/go/neural/engine.ts";
import {
  KataGoAdvisor, KATAGO_COMMIT, KATAGO_MODELS, type KataGoMove,
} from "../katago/advisor.ts";
import {
  GO_ARENA_OPPONENTS, goArenaSeedPairs, playGoArenaPolicyGame,
  type ArenaBlackInput, type ArenaBlackPolicy, type GoArenaInitialState,
} from "./arena.ts";
import { encodeOpponentTurnBehavior, opponentTurnBehavior } from
  "../../shared/strategy/go/opponent.ts";
import { encodedState } from "./export-v9-advisers.ts";
import { PythonV9Backend } from "./python-v9-backend.ts";
import { alignedAiSeed } from "./strategy/rng.ts";
import { shouldSampleDaggerPoint } from "./dagger-schedule.ts";

const SCHEMA = "bitburner-go-exhaustive-proposals-v9.5";
const TEACHER_SHA = "c73cb5811a441e466c4a6112da313c53f37219d68ef499b69c5e8a39ac71703e";
const ORACLE = "bitburner-go-ai-v3.0.1";
const TIE_ROLL = 0.5;

interface Point {
  elapsed: number;
  state: GoArenaInitialState;
  studentAction: number;
}

type Profile = "small5" | "daemon19";

function flag(name: string, fallback = ""): string {
  const index = Bun.argv.indexOf(name);
  return index >= 0 ? Bun.argv[index + 1] ?? fallback : fallback;
}

function integerFlag(name: string, fallback: number): number {
  const value = Number(flag(name, String(fallback)));
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${name} requires a non-negative integer`);
  return value;
}

function sha(value: Uint8Array | string): string {
  return createHash("sha256").update(value).digest("hex");
}

function actionIndex(action: KataGoMove, size: number): number {
  return action === "pass" ? size * size : action[0] * size + action[1];
}

function decisionAction(decision: { action: { type: string; x?: number; y?: number } }, size: number): number {
  if (decision.action.type === "pass") return size * size;
  if (decision.action.type === "move") return decision.action.x! * size + decision.action.y!;
  throw new Error(`unexpected student action ${decision.action.type}`);
}

function episodeForOrdinal(split: "train" | "heldout", ordinal: number): number {
  return split === "heldout" ? ordinal * 10 : Math.floor(ordinal / 9) * 10 + ordinal % 9 + 1;
}

function splitForEnvironment(environmentId: string): "train" | "heldout" {
  return Number.parseInt(sha(environmentId).slice(0, 8), 16) % 10 === 0 ? "heldout" : "train";
}

async function writeGzip(path: string, text: string): Promise<void> {
  if (await Bun.file(path).exists()) throw new Error(`output already exists: ${path}`);
  const partial = `${path}.partial`;
  if (await Bun.file(partial).exists()) throw new Error(`stale partial exists: ${partial}`);
  try {
    await Bun.write(partial, Bun.gzipSync(new TextEncoder().encode(text)));
    await rename(partial, path);
  } catch (error) {
    await unlink(partial).catch(() => undefined);
    throw error;
  }
}

async function main(): Promise<void> {
  const out = flag("--out");
  const model = flag("--student");
  if (!out || !model) throw new Error("--out and --student are required");
  const profile = flag("--profile", "daemon19") as Profile;
  if (profile !== "small5" && profile !== "daemon19") {
    throw new Error("--profile must be small5 or daemon19");
  }
  const games = integerFlag("--games", 32);
  const pointsPerGame = integerFlag("--points-per-game", 8);
  const stride = integerFlag("--stride", 8);
  const visits = integerFlag("--visits", 8);
  if (!games || !pointsPerGame || !stride || visits < 2) throw new Error("games/points/stride must be positive and visits >= 2");
  const seedStart = integerFlag("--seed", 202_608_1701);
  const handicapStart = integerFlag("--handicap-seed", 202_608_1702);
  const studentBytes = new Uint8Array(await Bun.file(model).arrayBuffer());
  const studentSha256 = sha(studentBytes);
  const candidateLimit = integerFlag("--candidate-limit", profile === "small5" ? 4 : 1);
  if (!candidateLimit) throw new Error("--candidate-limit must be positive");
  const backend = await PythonV9Backend.create(model, flag("--device", "mps"));
  const engine = new GoNeuralEngine(() => backend);
  const cases = goArenaSeedPairs(games, seedStart, handicapStart, 0);
  const routes: Array<{ environmentId: string; seed: number; handicapSeed: number;
    opponent: typeof GO_ARENA_OPPONENTS[number]; points: Point[] }> = [];
  let studentWins = 0;
  try {
    for (let routeIndex = 0; routeIndex < cases.length; routeIndex++) {
      const { seed, handicapSeed } = cases[routeIndex]!;
      const opponent = profile === "daemon19" ? GO_ARENA_OPPONENTS[6]!
        : GO_ARENA_OPPONENTS[routeIndex % 6]!;
      const environmentId = `${profile}-katago-dagger:${studentSha256}:${opponent.name}:${seed}:${handicapSeed}:tie-${TIE_ROLL}`;
      const points: Point[] = [];
      let elapsed = 0;
      const policy: ArenaBlackPolicy = async (input: ArenaBlackInput) => {
        const prepared = prepareNeuralGoDecision({
          board: input.board, currentPlayer: "Black", opponent: input.opponent,
          status: "inProgress", previousBoards: input.previousBoards,
          candidateLimit, consecutivePasses: input.consecutivePasses, komi: input.komi,
        });
        const decision = await finalizeNeuralGoDecision(
          prepared, [alignedAiSeed(input.dispatchPlaytime, 0)], engine, input.dispatchPlaytime);
        if (shouldSampleDaggerPoint(
          elapsed, points.length, stride, pointsPerGame, Boolean(prepared.immediate))) {
          points.push({
            elapsed,
            state: { board: input.board, previousBoards: input.previousBoards,
              consecutivePasses: input.consecutivePasses, dispatchPlaytime: input.dispatchPlaytime },
            studentAction: decisionAction(decision, input.board.size),
          });
        }
        elapsed++;
        return decision;
      };
      const game = await playGoArenaPolicyGame(
        opponent, seed, TIE_ROLL, false, policy, handicapSeed, null);
      if (!game.completed || !points.length) throw new Error(`student route ${routeIndex} failed`);
      studentWins += Number(game.won);
      routes.push({ environmentId, seed, handicapSeed, opponent, points });
      console.error(JSON.stringify({ phase: "student-routes", completed: routeIndex + 1, games,
        sampledPoints: points.length, turns: game.turns, won: game.won }));
    }
  } finally {
    await engine.dispose();
  }

  const adviser = new KataGoAdvisor(
    flag("--katago", "go-ai/.deps/KataGo/build/ipvgo-opencl/katago"),
    flag("--katago-model", KATAGO_MODELS[profile].file),
    flag("--katago-config", "go-ai/katago/config/analysis.cfg"));
  const rows: Record<string, unknown>[] = [];
  let aligned = 0;
  let ordinal = 0;
  try {
    for (let routeIndex = 0; routeIndex < routes.length; routeIndex++) {
      const route = routes[routeIndex]!;
      const opponent = route.opponent;
      const split = splitForEnvironment(route.environmentId);
      const episode = episodeForOrdinal(split, routeIndex);
      for (const point of route.points) {
        const advice = await adviser.advise(
          point.state.board, point.state.previousBoards, opponent.komi, visits);
        const action = actionIndex(advice.move, point.state.board.size);
        aligned += Number(action === point.studentAction);
        const prepared = prepareNeuralGoDecision({
          board: point.state.board, currentPlayer: "Black", opponent: opponent.name,
          status: "inProgress", previousBoards: point.state.previousBoards,
          candidateLimit, consecutivePasses: point.state.consecutivePasses, komi: opponent.komi,
        });
        if (prepared.immediate) throw new Error("sampled DAgger state has an immediate action");
        const moves = prepared.candidates.map((candidate) => candidate.action.type === "pass"
          ? point.state.board.size ** 2
          : candidate.action.type === "move"
            ? candidate.action.x * point.state.board.size + candidate.action.y
            : -1);
        if (!moves.includes(action)) throw new Error("KataGo selected an illegal DAgger action");
        const behavior = Array.from(encodeOpponentTurnBehavior(
          opponentTurnBehavior(opponent.name, alignedAiSeed(point.state.dispatchPlaytime, 0)),
          profile === "small5" ? opponent.komi : undefined));
        rows.push({
          schema: SCHEMA, kind: "actor", profile,
          teacherSha256: profile === "daemon19" ? TEACHER_SHA : studentSha256,
          opponentOracle: ORACLE, split,
          example: {
            episode, state: encodedState(point.state.board, point.state.previousBoards,
              point.state.consecutivePasses, false), behavior, elapsed: point.elapsed,
            moves, action, actions: [action], source: "katago",
          },
          generation: {
            source: "katago", opponent: opponent.name,
            environmentId: route.environmentId, pairedEnvironmentId: route.environmentId,
            originalEpisode: routeIndex, kataGoDaggerAuthority: "katago-exact-action-v1",
            originatingStudentSha256: studentSha256, studentAction: point.studentAction,
            selectedWithoutOutcome: true,
            selectionSchedule: {
              kind: "first-policy-state-at-or-after-stride-v1", stride, pointsPerGame,
            },
            kataGoCommit: KATAGO_COMMIT, modelSha256: KATAGO_MODELS[profile].sha256, visits,
            effectiveSeeds: { playtimeSeed: route.seed, handicapSeed: route.handicapSeed,
              defenseSeed: null, opponentTieRoll: TIE_ROLL,
              originDispatchPlaytime: point.state.dispatchPlaytime,
              originOpponentAiSeed: alignedAiSeed(point.state.dispatchPlaytime, 0) },
          },
        });
        ordinal++;
        console.error(JSON.stringify({ phase: "katago-labels", completed: ordinal,
          total: routes.reduce((sum, candidate) => sum + candidate.points.length, 0) }));
      }
    }
  } finally {
    await adviser.close();
  }
  await writeGzip(out, `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`);
  console.log(JSON.stringify({ out, sha256: sha(new Uint8Array(await Bun.file(out).arrayBuffer())),
    profile, studentSha256, games, studentWins, actors: rows.length, aligned,
    alignedRate: aligned / rows.length,
    candidateLimit,
    policyStateSchedule: {
      kind: "first-policy-state-at-or-after-stride-v1", stride, pointsPerGame,
    }, visits }));
}

if (import.meta.main) await main();
