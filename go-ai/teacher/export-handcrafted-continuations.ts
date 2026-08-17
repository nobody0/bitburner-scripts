/** Build terminal counterfactuals for a content-hash-selected daemon19 shard.
 *
 * Selection reads no outcome fields. Every selected position is replayed from
 * the legacy fixed-teacher seed ledger, and its chosen-action suffix must match
 * every retained post-reply state before any candidate in the group is kept.
 */
import { createHash } from "node:crypto";
import { rename, unlink } from "node:fs/promises";
import {
  GO_ARENA_OPPONENTS,
  goArenaSeeds,
  playGoArenaPolicyGame,
  playGoArenaPositionTrace,
  type ForcedBlackAction,
  type GoArenaGameResult,
  type GoArenaInitialState,
  type GoArenaTurnTrace,
} from "./arena.ts";
import {
  advance,
  encodedState,
  futureBehaviorFor,
  type CorpusValue,
} from "./export-v9-advisers.ts";
import { alignedAiSeed } from "./strategy/rng.ts";

const SCHEMA = "bitburner-go-exhaustive-proposals-v9.5";
const ORACLE = "bitburner-go-ai-v3.0.1";
const PROFILE = "daemon19";
const TEACHER_SHA = "c73cb5811a441e466c4a6112da313c53f37219d68ef499b69c5e8a39ac71703e";
const LEGACY_SEED_START = 8_501;
const LEGACY_TIE_ROLL = 0.5;
const AUTHOR = "environment-rollout:handcrafted-continuation-v1";
const STAGES = ["early", "middle", "late"] as const;
type Stage = typeof STAGES[number];

interface ValueRow extends CorpusValue {
  author?: string;
  blackPower?: number;
}

interface RankingRow {
  schema: string;
  kind: "actor-ranking";
  profile: string;
  teacherSha256: string;
  opponentOracle: string;
  split: "train" | "heldout";
  example: {
    episode: number;
    state: string;
    behavior: number[];
    elapsed: number;
    moves: number[];
    bestMove: number;
    candidates: ValueRow[][];
    source: "handcrafted";
  };
  generation: Record<string, unknown>;
}

interface TrajectoryRow {
  schema: string;
  kind: "trajectory";
  profile: string;
  teacherSha256: string;
  opponentOracle: string;
  split: "train" | "heldout";
  episode: number;
  values: ValueRow[];
  generation: Record<string, unknown>;
}

interface SelectedPosition {
  ranking: RankingRow;
  trajectory: TrajectoryRow;
  originalEpisode: number;
  environmentId: string;
  stage: Stage;
  contentHash: string;
}

function positionsByRoute(positions: SelectedPosition[]): Map<number, SelectedPosition[]> {
  const grouped = new Map<number, SelectedPosition[]>();
  for (const position of positions) {
    const group = grouped.get(position.originalEpisode) ?? [];
    group.push(position);
    grouped.set(position.originalEpisode, group);
  }
  return grouped;
}

function stringFlag(name: string, fallback = ""): string {
  const index = Bun.argv.indexOf(name);
  return index >= 0 ? Bun.argv[index + 1] ?? fallback : fallback;
}

function numberFlag(name: string, fallback: number): number {
  const value = Number(stringFlag(name, String(fallback)));
  if (!Number.isFinite(value)) throw new Error(`${name} requires a number`);
  return value;
}

function sha256Bytes(value: Uint8Array | string): string {
  return createHash("sha256").update(value).digest("hex");
}

async function fileSha256(path: string): Promise<string> {
  return sha256Bytes(new Uint8Array(await Bun.file(path).arrayBuffer()));
}

function stablePositionHash(row: RankingRow): string {
  // Deliberately omit every outcome, candidate marker, split, and generation
  // field. The selected content is only the decision input and move set.
  return sha256Bytes(JSON.stringify({
    state: row.example.state,
    behavior: row.example.behavior,
    elapsed: row.example.elapsed,
    moves: row.example.moves,
    bestMove: row.example.bestMove,
  }));
}

function stageOf(elapsed: number, routeLength: number): Stage {
  const fraction = elapsed / Math.max(routeLength, 1);
  return fraction < 1 / 3 ? "early" : fraction < 2 / 3 ? "middle" : "late";
}

export function selectPositions(
  rankings: RankingRow[],
  trajectories: Map<number, TrajectoryRow>,
  count: number,
): SelectedPosition[] {
  const quotas = new Map<Stage, number>(STAGES.map((stage, index) => [
    stage,
    Math.floor(count / STAGES.length) + Number(index < count % STAGES.length),
  ]));
  const pools = new Map<Stage, SelectedPosition[]>(STAGES.map((stage) => [stage, []]));
  for (const ranking of rankings) {
    const trajectory = trajectories.get(ranking.example.episode);
    if (!trajectory) throw new Error(`ranking route ${ranking.example.episode} lacks trajectory`);
    const originalEpisode = Number(ranking.generation.originalEpisode);
    const environmentId = String(ranking.generation.environmentId ?? "");
    if (!Number.isSafeInteger(originalEpisode) || originalEpisode < 0 || !environmentId) {
      throw new Error(`ranking route ${ranking.example.episode} lacks stable environment provenance`);
    }
    const stage = stageOf(ranking.example.elapsed, trajectory.values.length);
    pools.get(stage)!.push({
      ranking, trajectory, originalEpisode, environmentId, stage,
      contentHash: stablePositionHash(ranking),
    });
  }
  for (const pool of pools.values()) pool.sort((a, b) =>
    a.contentHash.localeCompare(b.contentHash));
  const selected: SelectedPosition[] = [];
  const perRoute = new Map<number, number>();
  for (const stage of STAGES) {
    const quota = quotas.get(stage)!;
    for (const position of pools.get(stage)!) {
      if ((perRoute.get(position.originalEpisode) ?? 0) >= 2) continue;
      selected.push(position);
      perRoute.set(position.originalEpisode, (perRoute.get(position.originalEpisode) ?? 0) + 1);
      if (selected.filter((candidate) => candidate.stage === stage).length === quota) break;
    }
    const actual = selected.filter((candidate) => candidate.stage === stage).length;
    if (actual !== quota) throw new Error(`only ${actual}/${quota} selectable ${stage} positions`);
  }
  return selected;
}

function actionFromIndex(index: number, size: number): ForcedBlackAction {
  return index === size * size ? "pass" : [Math.floor(index / size), index % size];
}

function decisionState(trace: GoArenaTurnTrace): string {
  return encodedState(
    { size: trace.board.length, rows: trace.board },
    trace.previousBoards,
    trace.consecutivePasses,
    false,
  );
}

function afterState(trace: GoArenaTurnTrace): string {
  const after = advance(trace);
  return encodedState(
    after.board, after.history, after.passes, after.responsePass, after.responseNoOp,
  );
}

function initialState(trace: GoArenaTurnTrace): GoArenaInitialState {
  return {
    board: { size: trace.board.length, rows: trace.board },
    previousBoards: trace.previousBoards,
    consecutivePasses: trace.consecutivePasses,
    dispatchPlaytime: trace.dispatchPlaytime,
  };
}

function terminalIdentity(game: GoArenaGameResult): string {
  return JSON.stringify({
    won: game.won,
    score: game.score,
    states: game.trace?.map(afterState),
  });
}

export async function continuationPolicyIdentity(): Promise<Record<string, unknown>> {
  const files = [
    "analysis.ts", "decide.ts", "illuminati-book.ts", "opponent.ts",
    "patterns.ts", "policy-book.ts", "rewards.ts", "rng.ts",
    "secret-book.ts",
  ];
  const hashes: Record<string, string> = {};
  for (const file of files) hashes[file] = await fileSha256(`go-ai/teacher/strategy/${file}`);
  return {
    kind: "frozen-handcrafted-policy",
    sourceCommit: "23bbb772665fbfc866e3a464ff3d8dac2325ca04",
    manifest: "go-ai/teacher/SOURCE.md",
    manifestSha256: await fileSha256("go-ai/teacher/SOURCE.md"),
    sourceFilesSha256: hashes,
    bundleSha256: sha256Bytes(JSON.stringify(hashes)),
  };
}

function candidateValues(
  game: GoArenaGameResult,
  originElapsed: number,
  candidateCount: number,
  futureBehavior: number[],
): ValueRow[] {
  if (!game.completed || !game.trace?.length) throw new Error("counterfactual did not terminate");
  const won = Number(game.won);
  const trainingScore = game.score.X * (game.won ? 1 : 0.5);
  const length = game.trace.length;
  return game.trace.map((trace, index) => ({
    state: afterState(trace),
    behavior: futureBehavior,
    elapsed: originElapsed + index + 1,
    won,
    score: trainingScore,
    blackPower: game.score.X,
    remaining: length - index,
    weight: 1 / (candidateCount * length),
    author: AUTHOR,
  }));
}

function splitForEnvironment(environmentId: string): "train" | "heldout" {
  // This is fixed before continuation outcomes exist and keeps every position
  // from one paired external environment in the same standalone split.
  return Number.parseInt(sha256Bytes(environmentId).slice(0, 8), 16) % 10 === 0
    ? "heldout" : "train";
}

function episodeForOrdinal(split: "train" | "heldout", ordinal: number): number {
  if (split === "heldout") return ordinal * 10;
  return Math.floor(ordinal / 9) * 10 + ordinal % 9 + 1;
}

async function main(): Promise<void> {
  const input = stringFlag(
    "--in",
    "go-ai/corpora/v9-daemon19-component-split-paired-authority-future-v9.5-20260814-g256-c32.jsonl.gz",
  );
  const output = stringFlag("--out");
  if (!output) throw new Error("missing --out");
  if (await Bun.file(output).exists()) throw new Error(`output already exists: ${output}`);
  const partial = `${output}.partial`;
  if (await Bun.file(partial).exists()) throw new Error(`stale partial exists: ${partial}`);
  const requested = Math.max(1, Math.floor(numberFlag("--positions", 256)));
  const positionStart = Math.max(0, Math.floor(numberFlag("--position-start", 0)));
  const bytes = new Uint8Array(await Bun.file(input).arrayBuffer());
  const inputSha256 = sha256Bytes(bytes);
  const rows = new TextDecoder().decode(Bun.gunzipSync(bytes)).trim().split("\n")
    .filter(Boolean).map((line) => JSON.parse(line));
  const trajectories = new Map<number, TrajectoryRow>();
  const rankings: RankingRow[] = [];
  for (const row of rows) {
    const source = row.example?.source ?? row.generation?.source;
    if (source !== "handcrafted") continue;
    if (row.kind === "trajectory") trajectories.set(row.episode, row as TrajectoryRow);
    if (row.kind === "actor-ranking") rankings.push(row as RankingRow);
  }
  const selectedAll = selectPositions(rankings, trajectories, requested);
  const workerCount = Math.max(1, Math.floor(numberFlag("--worker-count", 1)));
  const workerIndex = Math.max(0, Math.floor(numberFlag("--worker-index", 0)));
  if (workerIndex >= workerCount) throw new Error("--worker-index must be below --worker-count");
  const positionCount = Math.max(0, Math.floor(numberFlag(
    "--position-count", selectedAll.length - positionStart,
  )));
  const ranged = selectedAll.slice(positionStart, positionStart + positionCount);
  const selected = ranged.filter((_, index) => index % workerCount === workerIndex);
  if (!selected.length) throw new Error("selected position range is empty");
  const candidateOffsets = new Map(selectedAll.map((position, index) => [
    position.contentHash,
    selectedAll.slice(0, index).reduce(
      (sum, prior) => sum + prior.ranking.example.moves.length, 0),
  ]));
  const opponent = GO_ARENA_OPPONENTS.find((candidate) => candidate.name === "????????????")!;
  const seeds = goArenaSeeds(256, LEGACY_SEED_START);
  const policyIdentity = await continuationPolicyIdentity();
  const records: TrajectoryRow[] = [];
  const selectedByRoute = positionsByRoute(selected);
  let completedGroups = 0;
  for (const [originalEpisode, positions] of selectedByRoute) {
    const seed = seeds[originalEpisode];
    if (seed === undefined) throw new Error(`original episode ${originalEpisode} is outside seed ledger`);
    const legacyHandicapSeed = (seed ^ 0xa5a5a5a5) >>> 0;
    const baseline = await playGoArenaPolicyGame(
      opponent, seed, LEGACY_TIE_ROLL, true, undefined, legacyHandicapSeed, null,
    );
    if (!baseline.completed || !baseline.trace?.length) {
      throw new Error(`baseline route ${originalEpisode} did not complete`);
    }
    const retainedTrajectory = positions[0]!.trajectory;
    const retainedStates = retainedTrajectory.values.map((value) => value.state);
    const replayStates = baseline.trace.map(afterState);
    const retainedWon = retainedTrajectory.values[0]!.won === 1;
    const retainedTrainingScore = retainedTrajectory.values[0]!.score;
    const expectedTrainingScore = baseline.score.X * (baseline.won ? 1 : 0.5);
    if (JSON.stringify(replayStates) !== JSON.stringify(retainedStates)
      || baseline.won !== retainedWon
      || baseline.trace.length !== retainedTrajectory.values.length
      || expectedTrainingScore !== retainedTrainingScore) {
      throw new Error(`legacy route ${originalEpisode} failed exact retained-corpus replay`);
    }
    for (const position of positions) {
      const { ranking } = position;
      const elapsed = ranking.example.elapsed;
      const trace = baseline.trace[elapsed];
      if (!trace) throw new Error(`route ${originalEpisode} lacks elapsed ${elapsed}`);
      if (decisionState(trace) !== ranking.example.state) {
        throw new Error(`route ${originalEpisode} elapsed ${elapsed} decision state mismatch`);
      }
      const candidateCount = ranking.example.moves.length;
      if (candidateCount < 2) throw new Error("counterfactual group has fewer than two candidates");
      const groupId = `daemon19-handcrafted-terminal:${position.contentHash}`;
      const futureBehavior = futureBehaviorFor(trace.board.length, opponent);
      const games: GoArenaGameResult[] = [];
      for (const move of ranking.example.moves) {
        const game = await playGoArenaPositionTrace(
          opponent, seed, LEGACY_TIE_ROLL, initialState(trace),
          actionFromIndex(move, trace.board.length), undefined, null,
        );
        if (!game.completed || !game.trace?.length) {
          throw new Error(`group ${groupId} move ${move} did not terminate`);
        }
        games.push(game);
      }
      const controlIndex = ranking.example.moves.indexOf(ranking.example.bestMove);
      const control = games[controlIndex]!;
      const expectedControlStates = retainedStates.slice(elapsed);
      if (JSON.stringify(control.trace!.map(afterState)) !== JSON.stringify(expectedControlStates)
        || terminalIdentity(control) !== terminalIdentity({
          ...baseline,
          trace: baseline.trace.slice(elapsed),
        })) {
        throw new Error(`group ${groupId} chosen-action control did not reproduce original suffix`);
      }
      for (let candidateIndex = 0; candidateIndex < candidateCount; candidateIndex++) {
        const move = ranking.example.moves[candidateIndex]!;
        const game = games[candidateIndex]!;
        const firstState = afterState(game.trace![0]!);
        const predictedStates = ranking.example.candidates[candidateIndex]!.map((value) => value.state);
        if (!predictedStates.includes(firstState)) {
          throw new Error(`group ${groupId} move ${move} actual exact reply absent from ranking group`);
        }
        const values = candidateValues(game, elapsed, candidateCount, futureBehavior);
        const split = splitForEnvironment(position.environmentId);
        const ordinal = candidateOffsets.get(position.contentHash)! + candidateIndex;
        const episode = episodeForOrdinal(split, ordinal);
        const actualReply = game.trace![0]!.white;
        records.push({
          schema: SCHEMA,
          kind: "trajectory",
          profile: PROFILE,
          teacherSha256: TEACHER_SHA,
          opponentOracle: ORACLE,
          split,
          episode,
          values,
          generation: {
            source: "handcrafted",
            numericAuthor: AUTHOR,
            counterfactualGroupId: groupId,
            counterfactualCandidateIndex: candidateIndex,
            counterfactualCandidateCount: candidateCount,
            positionContentSha256: position.contentHash,
            stage: position.stage,
            originatingComposedEpisode: ranking.example.episode,
            originalEpisode,
            originElapsed: elapsed,
            originState: ranking.example.state,
            originBehavior: ranking.example.behavior,
            chosenAction: ranking.example.bestMove,
            forcedAction: move,
            candidateMoves: ranking.example.moves,
            actualReply,
            controlCandidate: move === ranking.example.bestMove,
            controlReproducesOriginal: move === ranking.example.bestMove,
            opponent: opponent.name,
            environmentId: position.environmentId,
            effectiveSeeds: {
              requestedPlaytimeSeedStart: LEGACY_SEED_START,
              playtimeSeed: seed,
              legacyHandicapSeed,
              defenseSeed: null,
              opponentTieRoll: LEGACY_TIE_ROLL,
              originDispatchPlaytime: trace.dispatchPlaytime,
              originOpponentAiSeed: alignedAiSeed(trace.dispatchPlaytime, 0),
              continuationDispatchPlaytimes: game.trace!.map((turn) => turn.dispatchPlaytime),
              continuationOpponentAiSeeds: game.trace!.map((turn) =>
                alignedAiSeed(turn.dispatchPlaytime, 0)),
            },
            continuationPolicy: policyIdentity,
            terminalOutcome: {
              won: game.won,
              blackPower: game.score.X,
              whiteScore: game.score.O,
              lossPenalizedBlackPower: game.score.X * (game.won ? 1 : 0.5),
              continuationLength: game.trace!.length,
              totalRouteTurns: elapsed + game.trace!.length,
            },
            originalCorpus: input,
            originalCorpusSha256: inputSha256,
          },
        });
      }
      completedGroups++;
      console.error(JSON.stringify({
        completedGroups, requested: selected.length, originalEpisode, elapsed,
        stage: position.stage, candidates: candidateCount,
      }));
    }
  }
  if (completedGroups !== selected.length) {
    throw new Error(`generated ${completedGroups}/${selected.length} counterfactual groups`);
  }
  const jsonl = `${records.map((record) => JSON.stringify(record)).join("\n")}\n`;
  try {
    await Bun.write(partial, Bun.gzipSync(new TextEncoder().encode(jsonl)));
    await rename(partial, output);
  } catch (error) {
    await unlink(partial).catch(() => undefined);
    throw error;
  }
  console.log(JSON.stringify({
    output,
    sha256: await fileSha256(output),
    input,
    inputSha256,
    selectedPositions: selected.length,
    totalSelectedPositions: selectedAll.length,
    positionStart,
    positionCount: ranged.length,
    workerIndex,
    workerCount,
    continuations: records.length,
    stageCounts: Object.fromEntries(STAGES.map((stage) => [
      stage, selected.filter((position) => position.stage === stage).length,
    ])),
    distinctOriginRoutes: new Set(selected.map((position) => position.originalEpisode)).size,
    maxPositionsPerRoute: Math.max(...[...positionsByRoute(selected).values()]
      .map((positions) => positions.length)),
    author: AUTHOR,
  }));
}

if (import.meta.main) await main();
