/** Bounded daemon19 counterfactuals rooted on fresh frozen-student games. */
import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { rename, unlink } from "node:fs/promises";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createGzip } from "node:zlib";
import {
  GoNeuralEngine, finalizeNeuralGoDecision, prepareNeuralGoDecision,
  selectV9ProposalFinalists,
} from "../../shared/strategy/go/neural/engine.ts";
import { KataGoAdvisor, KATAGO_MODELS, type KataGoMove } from "../katago/advisor.ts";
import {
  GO_ARENA_OPPONENTS, decideGoArenaBlack, goArenaSeedPairs,
  playGoArenaContinuationTrace, playGoArenaImmediateReply,
  playGoArenaPolicyGame, playGoArenaPositionTrace,
  type ArenaBlackInput, type ForcedBlackAction, type GoArenaInitialState,
  type GoArenaTurnTrace, type ArenaBlackPolicy,
} from "./arena.ts";
import type { GoDecision } from "./strategy/decide.ts";
import { encodeOpponentTurnBehavior, opponentTurnBehavior } from
  "../../shared/strategy/go/opponent.ts";
import { continuationPolicyIdentity } from "./export-handcrafted-continuations.ts";
import { advance, encodedState, futureBehaviorFor } from "./export-v9-advisers.ts";
import { PythonV9Backend } from "./python-v9-backend.ts";
import { alignedAiSeed } from "./strategy/rng.ts";

const SCHEMA = "bitburner-go-exhaustive-proposals-v9.5";
const TEACHER_SHA = "c73cb5811a441e466c4a6112da313c53f37219d68ef499b69c5e8a39ac71703e";
const AUTHOR = "environment-rollout:student-root-handcrafted-continuation-v2";
const ORACLE = "bitburner-go-ai-v3.0.1";
const TIE_ROLL = 0.5;
/** Route distribution must match deployed daemon19 K=1. Wider policy moves
 * are probes only: they are never allowed to steer the state trajectory. */
export const DAEMON_STUDENT_ROUTE_K = 1;
export const DAEMON_STUDENT_PROBE_TOP_K = 16;
const ENGINE_CYCLE_MS = 200;
const FUTURE_PHASE_STRIDE_CYCLES = 7_919;

type SelectionKind = "last-aligned" | "first-divergence" | "post-divergence";
interface DecisionPoint {
  elapsed: number;
  state: GoArenaInitialState;
  studentFinalists: number[];
  studentPolicyTop16: number[];
  studentRequestedLimit: number;
  studentAdaptiveLimit: number;
  studentPerSeedReserve: number;
  studentProposalSeedCount: number;
  studentAction: number;
  handcraftedAction: number;
  aligned: boolean;
}
interface SelectedPosition extends DecisionPoint {
  selectionKind: SelectionKind;
  environmentId: string;
  seed: number;
  handicapSeed: number;
  routeTraceSha256: string;
  kataGoPreferred: number;
  candidates: number[];
  positionContentSha256: string;
}
interface Manifest { schema: string; studentSha256: string; selectionInputs: Record<string, unknown>; positions: SelectedPosition[] }
interface PhaseOutcome {
  phase: number;
  dispatchOffsetCycles: number;
  won: boolean;
  blackPower: number;
  whiteScore: number;
  lossPenalizedBlackPower: number;
  continuationLength: number;
  totalRouteTurns: number;
  continuationDispatchPlaytimes: number[];
  continuationOpponentAiSeeds: number[];
  finalState: string;
  traceSha256: string;
}
interface RouteCache {
  schema: "bitburner-go-student-root-routes-v2";
  studentSha256: string;
  seedStart: number;
  handicapStart: number;
  routes: Array<{ environmentId: string; points: DecisionPoint[]; seed: number;
    handicapSeed: number; trace: GoArenaTurnTrace[] }>;
}

function flag(name: string, fallback = ""): string {
  const index = Bun.argv.indexOf(name);
  return index >= 0 ? Bun.argv[index + 1] ?? fallback : fallback;
}
function numberFlag(name: string, fallback: number): number {
  const value = Number(flag(name, String(fallback)));
  if (!Number.isFinite(value)) throw new Error(`${name} requires a number`);
  return value;
}
function sha(value: Uint8Array | string): string { return createHash("sha256").update(value).digest("hex"); }
function actionIndex(action: ForcedBlackAction, size: number): number {
  return action === "pass" ? size * size : action[0] * size + action[1];
}
function forced(index: number, size: number): ForcedBlackAction {
  return index === size * size ? "pass" : [Math.floor(index / size), index % size];
}
function decisionAction(decision: { action: { type: string; x?: number; y?: number } }, size: number): number {
  if (decision.action.type === "pass") return size * size;
  if (decision.action.type === "move") return decision.action.x! * size + decision.action.y!;
  throw new Error(`unexpected arena action ${decision.action.type}`);
}
function initialState(trace: GoArenaTurnTrace): GoArenaInitialState {
  return {
    board: { size: trace.board.length, rows: [...trace.board] },
    previousBoards: trace.previousBoards.map((board) => [...board]),
    consecutivePasses: trace.consecutivePasses,
    dispatchPlaytime: trace.dispatchPlaytime,
  };
}
function afterState(trace: GoArenaTurnTrace): string {
  const next = advance(trace);
  return encodedState(next.board, next.history, next.passes, next.responsePass, next.responseNoOp);
}
function diagnosticTrace(trace: GoArenaTurnTrace[]): Array<Record<string, unknown>> {
  return trace.map((turn, index) => ({
    turn: 2 * index,
    dispatchPlaytime: turn.dispatchPlaytime,
    opponentAiSeed: alignedAiSeed(turn.dispatchPlaytime, 0),
    black: turn.black,
    white: turn.white,
    afterState: afterState(turn),
  }));
}
function dedupe(values: readonly number[]): number[] { return [...new Set(values)]; }
function mean(values: readonly number[]): number {
  if (!values.length) throw new Error("cannot average an empty list");
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}
export function boundedExpectedPositions(
  positions: SelectedPosition[], count: number,
): SelectedPosition[] {
  if (!Number.isSafeInteger(count) || count < 1 || count > positions.length) {
    throw new Error("--expected-groups must be within the manifest size");
  }
  const kinds = (["last-aligned", "first-divergence", "post-divergence"] as const)
    .filter((kind) => positions.some((position) => position.selectionKind === kind));
  const quotas = new Map<SelectionKind, number>();
  const fractions: Array<{ kind: SelectionKind; fraction: number }> = [];
  let assigned = 0;
  for (const kind of kinds) {
    const available = positions.filter((position) => position.selectionKind === kind).length;
    const exact = count * available / positions.length;
    const quota = Math.min(available, Math.floor(exact));
    quotas.set(kind, quota);
    fractions.push({ kind, fraction: exact - quota });
    assigned += quota;
  }
  fractions.sort((left, right) => right.fraction - left.fraction
    || left.kind.localeCompare(right.kind));
  while (assigned < count) {
    const next = fractions.find(({ kind }) => quotas.get(kind)!
      < positions.filter((position) => position.selectionKind === kind).length);
    if (!next) throw new Error("cannot allocate bounded selection quotas");
    quotas.set(next.kind, quotas.get(next.kind)! + 1);
    assigned++;
  }
  const selected = new Set<string>();
  for (const kind of kinds) {
    const candidates = positions.filter((position) => position.selectionKind === kind)
      .sort((left, right) => sha(left.positionContentSha256)
        .localeCompare(sha(right.positionContentSha256)));
    for (const position of candidates.slice(0, quotas.get(kind))) {
      selected.add(position.positionContentSha256);
    }
  }
  return positions.filter((position) => selected.has(position.positionContentSha256));
}
export function futureMarginalizedTarget(
  originElapsed: number,
  outcomes: Array<Pick<PhaseOutcome,
    "won" | "blackPower" | "lossPenalizedBlackPower" | "continuationLength" | "totalRouteTurns">>,
): {
  expectedWinProbability: number;
  expectedLossPenalizedPowerPerTotalTurn: number;
  effectiveContinuationLength: number;
  effectiveLossPenalizedBlackPower: number;
  meanBlackPower: number;
} {
  const expectedWinProbability = mean(outcomes.map((outcome) => Number(outcome.won)));
  const expectedLossPenalizedPowerPerTotalTurn = mean(outcomes.map((outcome) =>
    outcome.lossPenalizedBlackPower / Math.max(outcome.totalRouteTurns, 1)));
  const effectiveContinuationLength = mean(outcomes.map((outcome) => outcome.continuationLength));
  return {
    expectedWinProbability,
    expectedLossPenalizedPowerPerTotalTurn,
    effectiveContinuationLength,
    effectiveLossPenalizedBlackPower: expectedLossPenalizedPowerPerTotalTurn
      * (originElapsed + effectiveContinuationLength),
    meanBlackPower: mean(outcomes.map((outcome) => outcome.blackPower)),
  };
}
function splitForEnvironment(environmentId: string): "train" | "heldout" {
  return Number.parseInt(sha(environmentId).slice(0, 8), 16) % 10 === 0 ? "heldout" : "train";
}
function episodeForOrdinal(split: "train" | "heldout", ordinal: number): number {
  return split === "heldout" ? ordinal * 10 : Math.floor(ordinal / 9) * 10 + ordinal % 9 + 1;
}
async function writeGzip(path: string, value: unknown): Promise<void> {
  if (await Bun.file(path).exists()) throw new Error(`output already exists: ${path}`);
  const partial = `${path}.partial`;
  try {
    await Bun.write(partial, Bun.gzipSync(new TextEncoder().encode(
      typeof value === "string" ? value : JSON.stringify(value))));
    await rename(partial, path);
  } catch (error) { await unlink(partial).catch(() => undefined); throw error; }
}
async function replaceGzipJsonl(path: string, rows: readonly unknown[]): Promise<void> {
  const partial = `${path}.partial`;
  try {
    const jsonl = `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`;
    await Bun.write(partial, Bun.gzipSync(new TextEncoder().encode(jsonl)));
    await rename(partial, path);
  } catch (error) { await unlink(partial).catch(() => undefined); throw error; }
}
async function readGzipJsonl(path: string): Promise<Record<string, unknown>[]> {
  const text = new TextDecoder().decode(Bun.gunzipSync(
    new Uint8Array(await Bun.file(path).arrayBuffer()),
  ));
  return text.trim().split("\n").filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}
async function replaceRouteCache(path: string, value: RouteCache): Promise<void> {
  const partial = `${path}.partial`;
  async function* json(): AsyncGenerator<string> {
    yield `{"schema":${JSON.stringify(value.schema)},"studentSha256":${JSON.stringify(value.studentSha256)},`;
    yield `"seedStart":${value.seedStart},"handicapStart":${value.handicapStart},"routes":[`;
    for (let index = 0; index < value.routes.length; index++) {
      if (index) yield ",";
      // A single route is bounded; never materialize every 19x19 trace twice.
      yield JSON.stringify(value.routes[index]);
    }
    yield "]}";
  }
  try {
    await pipeline(Readable.from(json()), createGzip(), createWriteStream(partial));
    await rename(partial, path);
  } catch (error) {
    await unlink(partial).catch(() => undefined);
    throw error;
  }
}
async function readGzip<T>(path: string): Promise<T> {
  return JSON.parse(new TextDecoder().decode(Bun.gunzipSync(
    new Uint8Array(await Bun.file(path).arrayBuffer())))) as T;
}

/** Outcome-blind quota assignment. Route outcome is deliberately absent. */
export function selectRoots(routes: Array<{ environmentId: string; points: DecisionPoint[] }>): Array<DecisionPoint & { environmentId: string; selectionKind: SelectionKind }> {
  const available = routes.map((route) => {
    const first = route.points.find((point) => !point.aligned);
    const last = first
      ? [...route.points.slice(0, first.elapsed)].reverse().find((point) => point.aligned)
      : [...route.points].reverse().find((point) => point.aligned);
    const firstIndex = first ? route.points.indexOf(first) : -1;
    const recovery = firstIndex >= 0
      ? route.points[firstIndex + Math.max(1, Math.floor((route.points.length - firstIndex) / 2))]
        ?? route.points.at(-1)! : undefined;
    return { ...route, first, last, recovery, hash: sha(route.environmentId) };
  }).sort((a, b) => a.hash.localeCompare(b.hash));
  if (available.some((route) => !route.first)) {
    throw new Error("a student route never diverged from the exact production finalist set");
  }
  const chosenLast = new Set<string>();
  for (const route of available) {
    if (chosenLast.size >= 64) break;
    if (route.last) chosenLast.add(route.environmentId);
  }
  const chosenFirst = new Set(available.filter((route) => !chosenLast.has(route.environmentId))
    .slice(0, 64).map((route) => route.environmentId));
  return available.map((route) => chosenLast.has(route.environmentId)
    ? { ...route.last!, environmentId: route.environmentId, selectionKind: "last-aligned" as const }
    : chosenFirst.has(route.environmentId)
      ? { ...route.first!, environmentId: route.environmentId,
        selectionKind: "first-divergence" as const }
      : { ...route.recovery!, environmentId: route.environmentId,
        selectionKind: "post-divergence" as const });
}

async function prepare(): Promise<void> {
  const out = flag("--out");
  const model = flag("--model", "go-ai/runs/v9-core-proof-20260814/daemon19-pass-head-64/v9.model");
  const requestedGames = Math.floor(numberFlag("--games", 128));
  const gameOffset = Math.floor(numberFlag("--game-offset", 0));
  const seedStart = Math.floor(numberFlag("--seed", 202_608_1581));
  const handicapStart = Math.floor(numberFlag("--handicap-seed", 202_608_1582));
  const bytes = new Uint8Array(await Bun.file(model).arrayBuffer());
  const studentSha256 = sha(bytes);
  const opponent = GO_ARENA_OPPONENTS[6]!;
  let routes: RouteCache["routes"];
  const routeCaches = flag("--route-caches");
  if (routeCaches) {
    const caches = await Promise.all(routeCaches.split(",").map((path) => readGzip<RouteCache>(path)));
    if (caches.some((cache) => cache.schema !== "bitburner-go-student-root-routes-v2"
      || cache.studentSha256 !== studentSha256 || cache.seedStart !== seedStart
      || cache.handicapStart !== handicapStart)) throw new Error("route cache identity mismatch");
    routes = caches.flatMap((cache) => cache.routes).sort((a, b) => a.seed - b.seed);
    if (routes.length !== 128 || new Set(routes.map((route) => route.environmentId)).size !== 128) {
      throw new Error("route caches do not contain exactly 128 distinct environments");
    }
  } else {
    const routeCacheOut = flag("--route-cache-out");
    let resumedRoutes: RouteCache["routes"] = [];
    if (routeCacheOut && await Bun.file(routeCacheOut).exists()) {
      const cache = await readGzip<RouteCache>(routeCacheOut);
      if (cache.schema !== "bitburner-go-student-root-routes-v2"
        || cache.studentSha256 !== studentSha256 || cache.seedStart !== seedStart
        || cache.handicapStart !== handicapStart) {
        throw new Error("partial route cache identity mismatch");
      }
      resumedRoutes = cache.routes;
    }
    const backend = await PythonV9Backend.create(
      model, flag("--device", "mps"), flag("--python", "go-ai/.venv-gpu/bin/python"),
    );
    const engine = new GoNeuralEngine(() => backend);
    const cases = goArenaSeedPairs(128, seedStart, handicapStart, 0)
      .slice(gameOffset, gameOffset + requestedGames);
    routes = [...resumedRoutes];
    const completedEnvironments = new Set(routes.map((route) => route.environmentId));
    try {
      for (let episode = 0; episode < cases.length; episode++) {
      const { seed, handicapSeed } = cases[episode]!;
      const environmentId = `daemon19-student-root:${studentSha256}:${seed}:${handicapSeed}:tie-${TIE_ROLL}`;
      if (completedEnvironments.has(environmentId)) continue;
      const points: DecisionPoint[] = [];
      const policy: ArenaBlackPolicy = async (input: ArenaBlackInput): Promise<GoDecision> => {
        const prepared = prepareNeuralGoDecision({
          board: input.board, currentPlayer: "Black", opponent: input.opponent,
          status: "inProgress", previousBoards: input.previousBoards,
          candidateLimit: DAEMON_STUDENT_ROUTE_K,
          consecutivePasses: input.consecutivePasses, komi: input.komi,
        });
        const proposalOffset = backend.proposals.length;
        const decision = await finalizeNeuralGoDecision(
          prepared, [alignedAiSeed(input.dispatchPlaytime, 0)], engine, input.dispatchPlaytime);
        const selectedAction = decisionAction(decision, input.board.size);
        let studentFinalists: number[];
        let studentPolicyTop16: number[];
        let studentAdaptiveLimit: number;
        let studentPerSeedReserve: number;
        let studentProposalSeedCount: number;
        if (prepared.immediate) {
          studentFinalists = [selectedAction];
          studentPolicyTop16 = [selectedAction];
          studentAdaptiveLimit = 1;
          studentPerSeedReserve = 0;
          studentProposalSeedCount = 0;
        } else {
          const proposal = backend.proposals[proposalOffset];
          if (!proposal) throw new Error("student proposal was not captured");
          const area = backend.extent * backend.extent;
          const moveIndices = prepared.candidates.map((candidate) => candidate.action.type === "pass"
            ? area : candidate.action.type === "move" ? candidate.action.x * backend.extent + candidate.action.y : area);
          const selection = selectV9ProposalFinalists(
            moveIndices, proposal.moves, 1, area + 1, DAEMON_STUDENT_ROUTE_K,
          );
          studentFinalists = selection.finalists.map((index) => moveIndices[index]!);
          studentPolicyTop16 = selection.ranked.slice(0, DAEMON_STUDENT_PROBE_TOP_K)
            .map((index) => moveIndices[index]!);
          studentAdaptiveLimit = selection.adaptiveLimit;
          studentPerSeedReserve = selection.perSeedReserve;
          studentProposalSeedCount = 1;
        }
        if (!studentFinalists.includes(selectedAction)) {
          throw new Error("frozen student selected an action outside its exact production finalists");
        }
        const handcrafted = decideGoArenaBlack(
          input.board, input.previousBoards, input.opponent, input.komi,
          input.dispatchPlaytime, input.consecutivePasses);
        const handcraftedIndex = decisionAction(handcrafted, input.board.size);
        points.push({
          elapsed: points.length,
          state: { board: input.board, previousBoards: input.previousBoards,
            consecutivePasses: input.consecutivePasses, dispatchPlaytime: input.dispatchPlaytime },
          studentFinalists, studentPolicyTop16,
          studentRequestedLimit: DAEMON_STUDENT_ROUTE_K,
          studentAdaptiveLimit, studentPerSeedReserve, studentProposalSeedCount,
          studentAction: selectedAction, handcraftedAction: handcraftedIndex,
          aligned: studentFinalists.includes(handcraftedIndex),
        });
        return decision as unknown as GoDecision;
      };
      const game = await playGoArenaPolicyGame(opponent, seed, TIE_ROLL, true, policy, handicapSeed, null);
      if (!game.completed || !game.trace?.length || game.trace.length !== points.length) {
        throw new Error(`student route ${episode} failed or decision trace misaligned`);
      }
      routes.push({ environmentId, points, seed, handicapSeed, trace: game.trace });
        if (routeCacheOut) await replaceRouteCache(routeCacheOut, {
          schema: "bitburner-go-student-root-routes-v2", studentSha256,
          seedStart, handicapStart, routes,
        } satisfies RouteCache);
        console.error(JSON.stringify({ phase: "student-games", completed: episode + 1,
          retainedRoutes: routes.length, games: cases.length, gameOffset, turns: game.turns }));
      }
    } finally { await engine.dispose(); }
    if (Bun.argv.includes("--route-cache")) {
      const cache: RouteCache = { schema: "bitburner-go-student-root-routes-v2",
        studentSha256, seedStart, handicapStart, routes };
      // `--route-cache-out` may be the final path: every completed route was
      // already atomically persisted there, so do not reject it as an
      // existing immutable output when the requested set finishes.
      if (routeCacheOut !== out) await writeGzip(out, cache);
      console.log(JSON.stringify({ out, routes: routes.length, gameOffset,
        sha256: sha(new Uint8Array(await Bun.file(out).arrayBuffer())) }));
      return;
    }
    if (routes.length !== 128) throw new Error("student-root experiment requires exactly 128 games");
  }
  const games = routes.length;
  const roots = selectRoots(routes.map(({ environmentId, points }) => ({ environmentId, points })));
  const adviser = new KataGoAdvisor(
    flag("--katago", "go-ai/.deps/KataGo/build/ipvgo-opencl/katago"),
    flag("--katago-model", KATAGO_MODELS.daemon19.file),
    flag("--katago-config", "go-ai/katago/config/analysis.cfg"));
  const positions: SelectedPosition[] = [];
  try {
    for (let index = 0; index < roots.length; index++) {
      const root = roots[index]!;
      const route = routes.find((candidate) => candidate.environmentId === root.environmentId)!;
      const advice = await adviser.advise(root.state.board, root.state.previousBoards, opponent.komi, 8);
      const kataGoPreferred = actionIndex(advice.move, root.state.board.size);
      const candidates = dedupe([
        root.studentAction,
        ...root.studentPolicyTop16,
        root.handcraftedAction,
        kataGoPreferred,
      ]);
      const content = sha(JSON.stringify({ environmentId: root.environmentId, elapsed: root.elapsed,
        board: root.state.board.rows, history: root.state.previousBoards, passes: root.state.consecutivePasses,
        studentFinalists: root.studentFinalists, studentPolicyTop16: root.studentPolicyTop16,
        studentRequestedLimit: root.studentRequestedLimit,
        studentAdaptiveLimit: root.studentAdaptiveLimit,
        studentPerSeedReserve: root.studentPerSeedReserve,
        studentProposalSeedCount: root.studentProposalSeedCount,
        handcraftedAction: root.handcraftedAction, kataGoPreferred }));
      positions.push({ ...root, seed: route.seed, handicapSeed: route.handicapSeed,
        routeTraceSha256: sha(JSON.stringify(route.trace)), kataGoPreferred, candidates,
        positionContentSha256: content });
      console.error(JSON.stringify({ phase: "katago-roots", completed: index + 1, games, candidates: candidates.length }));
    }
  } finally { await adviser.close(); }
  const manifest: Manifest = { schema: "bitburner-go-student-root-manifest-v2", studentSha256,
    selectionInputs: { games, seedStart, handicapStart, defenseSeed: null, tieRoll: TIE_ROLL,
      requestedLimit: DAEMON_STUDENT_ROUTE_K,
      probePolicyTopK: DAEMON_STUDENT_PROBE_TOP_K,
      selector: "shared-production-v9-k1-plus-policy-probes",
      kataGoVisits: 8, selectionReadsOutcomes: false }, positions };
  await writeGzip(out, manifest);
  console.log(JSON.stringify({ out, sha256: sha(new Uint8Array(await Bun.file(out).arrayBuffer())),
    positions: positions.length, lastAligned: positions.filter((p) => p.selectionKind === "last-aligned").length,
    firstDivergence: positions.filter((p) => p.selectionKind === "first-divergence").length,
    postDivergence: positions.filter((p) => p.selectionKind === "post-divergence").length,
    candidates: positions.reduce((sum, p) => sum + p.candidates.length, 0) }));
}

async function futurePhaseOutcomes(
  position: SelectedPosition,
  move: number,
  phases: number,
): Promise<{ first: GoArenaTurnTrace; outcomes: PhaseOutcome[] }> {
  const opponent = GO_ARENA_OPPONENTS[6]!;
  const action = forced(move, position.state.board.size);
  const baseline = await playGoArenaPositionTrace(
    opponent, position.seed, TIE_ROLL, position.state, action, undefined, null);
  if (!baseline.completed || !baseline.trace?.length) {
    throw new Error(`continuation ${position.positionContentSha256}:${move} failed`);
  }
  const first = baseline.trace[0]!;
  const next = advance(first);
  const outcome = (
    phase: number,
    game: typeof baseline,
    trace: GoArenaTurnTrace[],
  ): PhaseOutcome => {
    const normalized = diagnosticTrace(trace);
    const lossPenalized = game.score.X * (game.won ? 1 : 0.5);
    return {
      phase,
      dispatchOffsetCycles: phase * FUTURE_PHASE_STRIDE_CYCLES,
      won: game.won,
      blackPower: game.score.X,
      whiteScore: game.score.O,
      lossPenalizedBlackPower: lossPenalized,
      continuationLength: trace.length,
      totalRouteTurns: position.elapsed + trace.length,
      continuationDispatchPlaytimes: trace.map((turn) => turn.dispatchPlaytime),
      continuationOpponentAiSeeds: trace.map((turn) => alignedAiSeed(turn.dispatchPlaytime, 0)),
      finalState: afterState(trace.at(-1)!),
      traceSha256: sha(JSON.stringify(normalized)),
    };
  };
  const outcomes = [outcome(0, baseline, baseline.trace)];
  if (next.passes >= 2 || baseline.trace.length === 1) {
    while (outcomes.length < phases) outcomes.push({
      ...outcomes[0]!,
      phase: outcomes.length,
      dispatchOffsetCycles: outcomes.length * FUTURE_PHASE_STRIDE_CYCLES,
    });
    return { first, outcomes };
  }
  const nextDispatch = baseline.trace[1]!.dispatchPlaytime;
  for (let phase = 1; phase < phases; phase++) {
    const continued = await playGoArenaContinuationTrace(
      opponent,
      position.seed,
      TIE_ROLL,
      {
        board: next.board,
        previousBoards: next.history,
        consecutivePasses: next.passes,
        dispatchPlaytime: nextDispatch
          + phase * FUTURE_PHASE_STRIDE_CYCLES * ENGINE_CYCLE_MS,
      },
      undefined,
      null,
    );
    if (!continued.completed || !continued.trace?.length) {
      throw new Error(`future phase ${phase} ${position.positionContentSha256}:${move} failed`);
    }
    outcomes.push(outcome(phase, continued, [first, ...continued.trace]));
  }
  return { first, outcomes };
}

async function rollout(): Promise<void> {
  const manifestPath = flag("--manifest");
  const out = flag("--out");
  const workerIndex = Math.floor(numberFlag("--worker-index", 0));
  const workerCount = Math.floor(numberFlag("--worker-count", 1));
  const futurePhases = Math.floor(numberFlag("--future-phases", 1));
  const expectedGroups = Math.floor(numberFlag("--expected-groups", 128));
  const excludeFirstGroups = Math.floor(numberFlag("--exclude-first-groups", 0));
  if (!Number.isSafeInteger(futurePhases) || futurePhases < 1) {
    throw new Error("--future-phases must be a positive integer");
  }
  if (!Number.isSafeInteger(excludeFirstGroups) || excludeFirstGroups < 0
    || excludeFirstGroups >= expectedGroups) {
    throw new Error("--exclude-first-groups must be nonnegative and smaller than --expected-groups");
  }
  const manifest = await readGzip<Manifest>(manifestPath);
  if (manifest.schema !== "bitburner-go-student-root-manifest-v2"
    || !/^[0-9a-f]{64}$/.test(manifest.studentSha256) || manifest.positions.length !== 128) {
    throw new Error("invalid student-root manifest");
  }
  const opponent = GO_ARENA_OPPONENTS[6]!;
  const policyIdentity = await continuationPolicyIdentity();
  const manifestSha256 = sha(new Uint8Array(await Bun.file(manifestPath).arrayBuffer()));
  const selectedPositions = futurePhases > 1
    ? boundedExpectedPositions(manifest.positions, expectedGroups)
    : manifest.positions;
  // An immutable smaller assay can be extended without recomputing its roots.
  // The prefix is defined by the same outcome-blind content selection, while
  // global ordinals still refer to the full selected set for stable identity.
  const excluded = new Set(excludeFirstGroups > 0
    ? boundedExpectedPositions(manifest.positions, excludeFirstGroups)
      .map((position) => position.positionContentSha256)
    : []);
  const incrementalPositions = selectedPositions.filter(
    (position) => !excluded.has(position.positionContentSha256));
  const assignedPositions = incrementalPositions.filter(
    (_position, index) => index % workerCount === workerIndex);
  const checkpoint = flag("--checkpoint", `${out}.checkpoint`);
  const rows: Record<string, unknown>[] = await Bun.file(checkpoint).exists()
    ? await readGzipJsonl(checkpoint) : [];
  const assignedIds = new Set(assignedPositions.map((position) =>
    `daemon19-student-root:${position.positionContentSha256}`));
  const checkpointCounts = new Map<string, number>();
  for (const row of rows) {
    const generation = row.generation as Record<string, unknown> | undefined;
    const group = String(generation?.counterfactualGroupId ?? "");
    if (row.kind !== "trajectory" || !assignedIds.has(group)
      || generation?.originalManifestSha256 !== manifestSha256
      || Number(generation?.futurePhaseCount ?? 1) !== futurePhases) {
      throw new Error("incompatible student-root rollout checkpoint");
    }
    checkpointCounts.set(group, (checkpointCounts.get(group) ?? 0) + 1);
  }
  const completedGroups = new Set<string>();
  for (const position of assignedPositions) {
    const group = `daemon19-student-root:${position.positionContentSha256}`;
    const count = checkpointCounts.get(group) ?? 0;
    if (count !== 0 && count !== position.candidates.length) {
      throw new Error(`partial checkpoint group ${group}`);
    }
    if (count) completedGroups.add(group);
  }
  const positions = assignedPositions.filter((position) =>
    !completedGroups.has(`daemon19-student-root:${position.positionContentSha256}`));
  let ordinal = selectedPositions.slice(0, workerIndex).reduce((sum, p) => sum + p.candidates.length, 0);
  // Worker-local ordinals are made globally unique by the manifest position index.
  for (const position of positions) {
    const positionIndex = selectedPositions.findIndex((candidate) => candidate.positionContentSha256 === position.positionContentSha256);
    const originalPositionIndex = manifest.positions.findIndex((candidate) =>
      candidate.positionContentSha256 === position.positionContentSha256);
    const prefix = selectedPositions.slice(0, positionIndex).reduce((sum, p) => sum + p.candidates.length, 0);
    for (let candidateIndex = 0; candidateIndex < position.candidates.length; candidateIndex++) {
      const move = position.candidates[candidateIndex]!;
      const action = forced(move, position.state.board.size);
      const immediate = await playGoArenaImmediateReply(opponent, TIE_ROLL, position.state, action);
      const phased = futurePhases > 1
        ? await futurePhaseOutcomes(position, move, futurePhases)
        : undefined;
      const game = phased ? undefined : await playGoArenaPositionTrace(
        opponent, position.seed, TIE_ROLL, position.state, action, undefined, null);
      if (!phased && (!game?.completed || !game.trace?.length)) {
        throw new Error(`continuation ${position.positionContentSha256}:${move} failed`);
      }
      const firstTrace = phased?.first ?? game!.trace![0]!;
      const first = advance(firstTrace);
      if (JSON.stringify(immediate.white) !== JSON.stringify(firstTrace.white)
        || immediate.after.rows.join("") !== first.board.rows.join("")) {
        throw new Error("standalone exact reply disagrees with rollout trace");
      }
      const split = splitForEnvironment(position.environmentId);
      const globalOrdinal = prefix + candidateIndex;
      const candidateCount = position.candidates.length;
      const groupId = `daemon19-student-root:${position.positionContentSha256}`;
      const commonGeneration = {
        source: "handcrafted",
        counterfactualGroupId: groupId, counterfactualCandidateIndex: candidateIndex,
        counterfactualCandidateCount: candidateCount, positionContentSha256: position.positionContentSha256,
        selectionKind: position.selectionKind, originatingStudentSha256: manifest.studentSha256,
        originalEpisode: originalPositionIndex, originElapsed: position.elapsed,
        originState: encodedState(position.state.board, position.state.previousBoards,
          position.state.consecutivePasses, false),
        originBehavior: Array.from(encodeOpponentTurnBehavior(
          opponentTurnBehavior(opponent.name, alignedAiSeed(position.state.dispatchPlaytime, 0)))),
        studentAction: position.studentAction,
        studentFinalistMoves: position.studentFinalists,
        studentPolicyTop16Moves: position.studentPolicyTop16,
        studentRequestedLimit: position.studentRequestedLimit,
        studentAdaptiveLimit: position.studentAdaptiveLimit,
        studentPerSeedReserve: position.studentPerSeedReserve,
        studentProposalSeedCount: position.studentProposalSeedCount,
        handcraftedChosenAction: position.handcraftedAction,
        kataGoPreferredAction: position.kataGoPreferred, forcedAction: move,
        candidateMoves: position.candidates,
        candidateFlags: { studentFinalist: position.studentFinalists.includes(move),
          studentPolicyTop16: position.studentPolicyTop16.includes(move),
          handcraftedChosen: move === position.handcraftedAction,
          kataGoPreferred: move === position.kataGoPreferred },
        actualReply: firstTrace.white, opponent: opponent.name,
        environmentId: position.environmentId, pairedEnvironmentId: position.environmentId,
        continuationPolicy: policyIdentity,
        routeTraceSha256: position.routeTraceSha256,
        originalManifest: manifestPath, originalManifestSha256: manifestSha256,
      };
      if (phased) {
        const { expectedWinProbability, expectedLossPenalizedPowerPerTotalTurn,
          effectiveContinuationLength, effectiveLossPenalizedBlackPower,
          meanBlackPower } = futureMarginalizedTarget(position.elapsed, phased.outcomes);
        const author = "environment-rollout:student-root-future-marginalized-v1";
        rows.push({
          schema: SCHEMA, kind: "trajectory", profile: "daemon19", teacherSha256: TEACHER_SHA,
          opponentOracle: ORACLE, split, episode: episodeForOrdinal(split, globalOrdinal),
          values: [{ state: afterState(firstTrace), behavior: futureBehaviorFor(19, opponent),
            elapsed: position.elapsed + 1, won: expectedWinProbability,
            score: effectiveLossPenalizedBlackPower, blackPower: meanBlackPower,
            remaining: effectiveContinuationLength, weight: 1 / candidateCount, author }],
          generation: {
            ...commonGeneration,
            numericAuthor: author,
            counterfactualTargetScope: "immediate-post-reply-future-marginalized",
            effectiveSeeds: { requestedPlaytimeSeedStart: manifest.selectionInputs.seedStart,
              playtimeSeed: position.seed, handicapSeed: position.handicapSeed, defenseSeed: null,
              opponentTieRoll: TIE_ROLL, originDispatchPlaytime: position.state.dispatchPlaytime,
              originOpponentAiSeed: alignedAiSeed(position.state.dispatchPlaytime, 0),
              futurePhaseStrideCycles: FUTURE_PHASE_STRIDE_CYCLES,
              futurePhaseOffsetsCycles: phased.outcomes.map((outcome) => outcome.dispatchOffsetCycles) },
            futurePhaseCount: futurePhases,
            futurePhaseStrideCycles: FUTURE_PHASE_STRIDE_CYCLES,
            phaseOutcomes: phased.outcomes,
            terminalOutcome: { expectedWinProbability,
              expectedLossPenalizedPowerPerTotalTurn,
              effectiveLossPenalizedBlackPower, effectiveContinuationLength,
              meanBlackPower, phaseCount: futurePhases },
          },
        });
        continue;
      }
      const won = Number(game!.won);
      const trainingScore = game!.score.X * (game!.won ? 1 : 0.5);
      rows.push({
        schema: SCHEMA, kind: "trajectory", profile: "daemon19", teacherSha256: TEACHER_SHA,
        opponentOracle: ORACLE, split, episode: episodeForOrdinal(split, globalOrdinal),
        values: [{ state: afterState(game!.trace![0]!), behavior: futureBehaviorFor(19, opponent),
          elapsed: position.elapsed + 1, won, score: trainingScore, blackPower: game!.score.X,
          remaining: game!.trace!.length, weight: 1 / candidateCount, author: AUTHOR }],
        generation: {
          ...commonGeneration, numericAuthor: AUTHOR,
          counterfactualTargetScope: "immediate-post-reply",
          effectiveSeeds: { requestedPlaytimeSeedStart: manifest.selectionInputs.seedStart,
            playtimeSeed: position.seed, handicapSeed: position.handicapSeed, defenseSeed: null,
            opponentTieRoll: TIE_ROLL, originDispatchPlaytime: position.state.dispatchPlaytime,
            originOpponentAiSeed: alignedAiSeed(position.state.dispatchPlaytime, 0),
            continuationDispatchPlaytimes: game!.trace!.map((turn) => turn.dispatchPlaytime),
            continuationOpponentAiSeeds: game!.trace!.map((turn) => alignedAiSeed(turn.dispatchPlaytime, 0)) },
          continuationTrace: diagnosticTrace(game!.trace!),
          continuationFinalState: afterState(game!.trace!.at(-1)!),
          terminalOutcome: { won: game!.won, blackPower: game!.score.X, whiteScore: game!.score.O,
            lossPenalizedBlackPower: trainingScore, continuationLength: game!.trace!.length,
            totalRouteTurns: position.elapsed + game!.trace!.length },
        },
      });
    }
    console.error(JSON.stringify({ workerIndex, completedGroups: rows.length ? rows.filter((r) =>
      (r.generation as Record<string, unknown>).counterfactualCandidateIndex === 0).length : 0,
      assignedGroups: assignedPositions.length }));
    await replaceGzipJsonl(checkpoint, rows);
  }
  const jsonl = `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`;
  await writeGzip(out, jsonl);
  await unlink(checkpoint).catch(() => undefined);
  console.log(JSON.stringify({ out, workerIndex, workerCount, groups: assignedPositions.length,
    continuations: rows.length, futurePhases,
    sha256: sha(new Uint8Array(await Bun.file(out).arrayBuffer())), ordinal }));
}

async function emitActors(): Promise<void> {
  const manifestPath = flag("--manifest");
  const out = flag("--out");
  const manifest = await readGzip<Manifest>(manifestPath);
  if (manifest.schema !== "bitburner-go-student-root-manifest-v2"
    || !/^[0-9a-f]{64}$/.test(manifest.studentSha256) || manifest.positions.length !== 128) {
    throw new Error("invalid student-root manifest");
  }
  const manifestSha256 = sha(new Uint8Array(await Bun.file(manifestPath).arrayBuffer()));
  const opponent = GO_ARENA_OPPONENTS[6]!;
  const rows: Record<string, unknown>[] = [];
  for (let index = 0; index < manifest.positions.length; index++) {
    const position = manifest.positions[index]!;
    const prepared = prepareNeuralGoDecision({
      board: position.state.board,
      currentPlayer: "Black",
      opponent: opponent.name,
      status: "inProgress",
      previousBoards: position.state.previousBoards,
      candidateLimit: DAEMON_STUDENT_ROUTE_K,
      consecutivePasses: position.state.consecutivePasses,
      komi: opponent.komi,
    });
    if (prepared.immediate) throw new Error("student-root actor unexpectedly has an immediate move");
    const moves = prepared.candidates.map((candidate) => {
      if (candidate.action.type === "pass") return position.state.board.size ** 2;
      if (candidate.action.type === "move") {
        return candidate.action.x * position.state.board.size + candidate.action.y;
      }
      throw new Error("student-root proposal unexpectedly contains a cheat action");
    });
    const state = encodedState(position.state.board, position.state.previousBoards,
      position.state.consecutivePasses, false);
    const behavior = Array.from(encodeOpponentTurnBehavior(
      opponentTurnBehavior(opponent.name, alignedAiSeed(position.state.dispatchPlaytime, 0))));
    const split = splitForEnvironment(position.environmentId);
    for (const [source, action, authority] of [
      ["handcrafted", position.handcraftedAction, "frozen-handcrafted-exploit-root-v1"],
      ["katago", position.kataGoPreferred, "katago-preferred-root-v1"],
    ] as const) {
      if (!moves.includes(action)) throw new Error(`${source} student-root action is illegal`);
      rows.push({
        schema: SCHEMA, kind: "actor", profile: "daemon19", teacherSha256: TEACHER_SHA,
        opponentOracle: ORACLE, split,
        example: { episode: episodeForOrdinal(split, index), state, behavior,
          elapsed: position.elapsed, moves, action, actions: [action], source },
        generation: {
          source, opponent: opponent.name, environmentId: position.environmentId,
          pairedEnvironmentId: position.environmentId, originalEpisode: index,
          positionContentSha256: position.positionContentSha256,
          selectionKind: position.selectionKind, originatingStudentSha256: manifest.studentSha256,
          studentRootActorAuthority: authority,
          originalManifest: manifestPath, originalManifestSha256: manifestSha256,
          effectiveSeeds: { playtimeSeed: position.seed, handicapSeed: position.handicapSeed,
            defenseSeed: null, opponentTieRoll: TIE_ROLL,
            originDispatchPlaytime: position.state.dispatchPlaytime,
            originOpponentAiSeed: alignedAiSeed(position.state.dispatchPlaytime, 0) },
        },
      });
    }
  }
  await writeGzip(out, `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`);
  console.log(JSON.stringify({ out, roots: manifest.positions.length, actors: rows.length,
    sha256: sha(new Uint8Array(await Bun.file(out).arrayBuffer())) }));
}

if (import.meta.main) {
  const mode = flag("--mode");
  if (mode === "prepare") await prepare();
  else if (mode === "rollout") await rollout();
  else if (mode === "emit-actors") await emitActors();
  else throw new Error("--mode must be prepare, rollout, or emit-actors");
}
