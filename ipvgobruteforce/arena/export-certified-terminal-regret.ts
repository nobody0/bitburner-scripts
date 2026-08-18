/** Matched terminal regret for KataGo-disagreed certified Small5 actions. */
import { createHash } from "node:crypto";
import { readFile, rename, unlink } from "node:fs/promises";
import { join } from "node:path";
import {
  modelInputKey, parseCertificate, type CandidateActor,
} from "./export-certified-v9.ts";
import {
  GO_ARENA_OPPONENTS, decideGoArenaBlack, playGoArenaPositionTrace,
  type ArenaBlackPolicy, type ForcedBlackAction, type GoArenaGameResult,
  type GoArenaOpponent, type GoArenaTurnTrace,
} from "../../go-ai/teacher/arena.ts";
import { continuationPolicyIdentity } from
  "../../go-ai/teacher/export-handcrafted-continuations.ts";
import { advance, encodedState, futureBehaviorFor } from
  "../../go-ai/teacher/export-v9-advisers.ts";

const SCHEMA = "bitburner-go-exhaustive-proposals-v9.5";
const ORACLE = "bitburner-go-ai-v3.0.1";
const AUTHOR = "environment-rollout:certified-root-book-aware-continuation-v1";
const TIE_ROLL = 0.5;
const PHASES = 150_000;
const TICK_MS = 200;
type Json = Record<string, any>;

function flag(name: string, fallback = ""): string {
  const index = Bun.argv.indexOf(name);
  return index >= 0 ? Bun.argv[index + 1] ?? fallback : fallback;
}
function integerFlag(name: string, fallback: number): number {
  const value = Number(flag(name, String(fallback)));
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${name} must be positive`);
  return value;
}
function sha(value: Uint8Array | string): string {
  return createHash("sha256").update(value).digest("hex");
}
function actorKey(actor: CandidateActor): string {
  return modelInputKey(actor.state, actor.behavior, actor.elapsed).toString("hex");
}
function certificatePositionKey(
  phase: number, board: { rows: readonly string[] }, history: readonly string[][], passes: number,
): string {
  return `${phase}:${encodedState(
    { size: 5, rows: [...board.rows] }, history, passes, false, false)}`;
}
function certificateBoardKey(
  board: { rows: readonly string[] }, history: readonly string[][], passes: number,
): string {
  return encodedState({ size: 5, rows: [...board.rows] }, history, passes, false, false);
}
function certificateAwarePolicy(
  candidates: CandidateActor[], definition: GoArenaOpponent,
  coverage: { certified: number; fallback: number; missing: string[] },
): ArenaBlackPolicy {
  const actions = new Map(candidates.map((candidate) => [
    certificatePositionKey(candidate.phase, candidate.board, candidate.history, candidate.passes),
    candidate.action,
  ]));
  return (input) => {
    const phase = Math.floor(input.dispatchPlaytime / TICK_MS) % PHASES;
    const action = actions.get(certificatePositionKey(
      phase, input.board, input.previousBoards, input.consecutivePasses));
    if (action === undefined) {
      coverage.fallback++;
      if (coverage.missing.length < 4) coverage.missing.push(certificatePositionKey(
        phase, input.board, input.previousBoards, input.consecutivePasses));
      return decideGoArenaBlack(
        input.board, input.previousBoards, definition.name, definition.komi,
        input.dispatchPlaytime, input.consecutivePasses);
    }
    coverage.certified++;
    return {
      action: action === 25
        ? { type: "pass", why: "certified playbook continuation" }
        : { type: "move", x: Math.floor(action / 5), y: action % 5,
          why: "certified playbook continuation" },
      ranked: [], why: "certified playbook continuation", finalists: 1, positionValue: 0,
    };
  };
}
function absoluteDispatchPlaytime(
  header: { startPhase: number; playtimeEpoch: number }, phase: number,
): number {
  const phaseOffset = (phase - header.startPhase + PHASES) % PHASES;
  return (header.playtimeEpoch * PHASES + header.startPhase + phaseOffset) * TICK_MS;
}
function forced(index: number): ForcedBlackAction {
  return index === 25 ? "pass" : [Math.floor(index / 5), index % 5];
}
function postReplyState(trace: GoArenaTurnTrace): string {
  const next = advance(trace);
  return encodedState(next.board, next.history, next.passes, next.responsePass, next.responseNoOp);
}
function diagnosticTrace(trace: GoArenaTurnTrace[]): Json[] {
  return trace.map((turn, index) => ({
    turn: 2 * index, dispatchPlaytime: turn.dispatchPlaytime,
    opponentAiSeed: turn.dispatchPlaytime + 200, black: turn.black, white: turn.white,
    afterState: postReplyState(turn),
  }));
}
function episodeFor(split: "train" | "heldout", ordinal: number): number {
  return split === "heldout" ? ordinal * 10 : Math.floor(ordinal / 9) * 10 + ordinal % 9 + 1;
}
function terminalRate(game: GoArenaGameResult, originElapsed: number, continuationLength: number): number {
  const power = game.score.X * (game.won ? 1 : 0.5);
  return power / Math.max(originElapsed + continuationLength, 1);
}

async function readRows(path: string): Promise<Json[]> {
  const bytes = new Uint8Array(await Bun.file(path).arrayBuffer());
  return new TextDecoder().decode(Bun.gunzipSync(bytes)).trimEnd().split("\n")
    .filter(Boolean).map((line) => JSON.parse(line) as Json);
}
async function writeRows(path: string, rows: Json[]): Promise<void> {
  if (await Bun.file(path).exists()) throw new Error(`refusing to overwrite ${path}`);
  const partial = `${path}.partial`;
  try {
    await Bun.write(partial, Bun.gzipSync(new TextEncoder().encode(
      `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`)));
    await rename(partial, path);
  } catch (error) {
    await unlink(partial).catch(() => undefined);
    throw error;
  }
}

/** Outcome-blind content selection of complete conditional groups per split/opponent. */
export function selectDisagreedGroups(rows: Json[], perStratum: number): Json[] {
  const groups = new Map<string, Json[]>();
  for (const row of rows) {
    if (row.generation?.kataGoAgrees !== false) continue;
    const stratum = `${row.split}:${row.generation.opponent}`;
    const key = `${stratum}:${row.generation.conditionalGroupSha256}`;
    const bucket = groups.get(key) ?? [];
    bucket.push(row);
    groups.set(key, bucket);
  }
  const strata = new Map<string, Array<[string, Json[]]>>();
  for (const [key, values] of groups) {
    const stratum = `${values[0]!.split}:${values[0]!.generation.opponent}`;
    const bucket = strata.get(stratum) ?? [];
    bucket.push([key, values]);
    strata.set(stratum, bucket);
  }
  const selected: Json[] = [];
  for (const [stratum, candidates] of [...strata].sort()) {
    candidates.sort((left, right) => sha(left[0]).localeCompare(sha(right[0])));
    if (candidates.length < perStratum) {
      throw new Error(`${stratum} has only ${candidates.length}/${perStratum} disagreed groups`);
    }
    selected.push(...candidates.slice(0, perStratum).flatMap((entry) => entry[1]));
  }
  return selected;
}

function ranking(rows: Json[]): Json {
  const ordered = [...rows].sort((left, right) => {
    const a = left.generation.terminalOutcome;
    const b = right.generation.terminalOutcome;
    if (a.won !== b.won) return Number(b.won) - Number(a.won);
    return b.lossPenalizedBlackPowerPerTotalTurn - a.lossPenalizedBlackPowerPerTotalTurn;
  });
  const first = rows[0]!;
  const best = ordered[0]!;
  const bestWon = best.generation.terminalOutcome.won;
  return {
    schema: SCHEMA, kind: "actor-ranking", profile: "small5",
    teacherSha256: first.teacherSha256, opponentOracle: ORACLE,
    split: first.split, episode: first.episode,
    example: {
      episode: first.episode,
      state: first.generation.originState,
      behavior: first.generation.originBehavior,
      elapsed: first.generation.originElapsed,
      moves: first.generation.candidateMoves,
      bestMove: best.generation.forcedAction,
      winGroupMoves: rows.filter((row) => row.generation.terminalOutcome.won === bestWon)
        .map((row) => row.generation.forcedAction),
      candidates: rows.map((row) => [{
        state: row.values[0].state, behavior: row.values[0].behavior,
        elapsed: row.values[0].elapsed, won: row.values[0].won,
        score: row.values[0].score, remaining: row.values[0].remaining,
        weight: 1, author: row.values[0].author,
      }]), source: "counterfactual",
    },
    generation: {
      source: "counterfactual", numericAuthor: AUTHOR,
      counterfactualAuthority: "certified-playbook-terminal-regret-v1",
      counterfactualGroupId: first.generation.counterfactualGroupId,
      counterfactualTargetScope: "immediate-post-reply",
      selectionKind: "certified-root",
      counterfactualRankingAuthority: "real-terminal-v1",
      objective: "win-first-loss-penalized-black-power-per-total-turn",
      continuationPolicy: first.generation.continuationPolicy,
      conditionalGroupSha256: first.generation.conditionalGroupSha256,
    },
  };
}

async function main(): Promise<void> {
  const input = flag("--input");
  const out = flag("--out");
  const teacher = flag("--teacher");
  const netburners = flag("--netburners-dir");
  const slumSnakes = flag("--slum-snakes-dir");
  const directories: Readonly<Record<string, string>> = {
    Netburners: netburners,
    "Slum Snakes": slumSnakes,
    "The Black Hand": flag("--black-hand-dir"),
    Tetrads: flag("--tetrads-dir"),
    Daedalus: flag("--daedalus-dir"),
    Illuminati: flag("--illuminati-dir"),
  };
  if (!input || !out || !teacher) {
    throw new Error("--input, --out and --teacher are required");
  }
  const teacherSha256 = sha(new Uint8Array(await Bun.file(teacher).arrayBuffer()));
  const inputBytes = new Uint8Array(await Bun.file(input).arrayBuffer());
  const inputSha256 = sha(inputBytes);
  const selected = selectDisagreedGroups(await readRows(input), integerFlag("--groups-per-stratum", 16));
  const policyIdentity = await continuationPolicyIdentity();
  const certificateCache = new Map<string, Promise<{
    header: { startPhase: number; playtimeEpoch: number };
    actors: CandidateActor[]; byInput: Map<string, CandidateActor>;
  }>>();
  const trajectories: Json[] = [];
  for (const [recordIndex, record] of selected.entries()) {
    const generation = record.generation;
    const opponentName = String(generation.opponent);
    const directory = directories[opponentName];
    const definition = GO_ARENA_OPPONENTS.find((candidate) => candidate.name === opponentName);
    if (!directory || !definition) throw new Error(`unsupported opponent ${opponentName}`);
    const certificatePath = join(directory, "policies", String(generation.certificate));
    let actors = certificateCache.get(certificatePath);
    if (!actors) {
      actors = readFile(certificatePath, "utf8").then((text) => {
        const parsed = parseCertificate(text, certificatePath, definition.name);
        const candidates = parsed.candidates;
        return { header: parsed.header, actors: candidates,
          byInput: new Map(candidates.map((actor) => [actorKey(actor), actor])) };
      });
      certificateCache.set(certificatePath, actors);
    }
    const example = record.example;
    const key = modelInputKey(String(example.state), example.behavior,
      Number(example.elapsed)).toString("hex");
    const parsed = await actors;
    const actor = parsed.byInput.get(key);
    if (!actor) throw new Error(`${certificatePath} lacks selected input ${key}`);
    const candidates = [...new Set([Number(example.action), ...generation.kataGoActions.map(Number)])]
      .filter((move) => example.moves.includes(move));
    if (candidates.length < 2) throw new Error("disagreed root lacks a legal KataGo alternative");
    const groupId = `small5-certified-regret:${sha(`${key}:${candidates.join(",")}`)}`;
    const groupRows: Json[] = [];
    let controlDispatches: number[] | undefined;
    const actorsByBoard = new Map<string, CandidateActor[]>();
    for (const candidate of parsed.actors) {
      const boardKey = certificateBoardKey(
        candidate.board, candidate.history, candidate.passes);
      const values = actorsByBoard.get(boardKey) ?? [];
      values.push(candidate);
      values.sort((left, right) => left.phase - right.phase);
      actorsByBoard.set(boardKey, values);
    }
    for (const [candidateIndex, move] of candidates.entries()) {
      const initial = { board: actor.board, previousBoards: actor.history,
        consecutivePasses: actor.passes,
        dispatchPlaytime: absoluteDispatchPlaytime(parsed.header, actor.phase) };
      const continuationCoverage = { certified: 0, fallback: 0, missing: [] as string[] };
      const certifiedControl = move === Number(example.action);
      const game = await playGoArenaPositionTrace(
        definition, absoluteDispatchPlaytime(parsed.header, Number(generation.rootPhase)),
        TIE_ROLL, initial, forced(move),
        certificateAwarePolicy(parsed.actors, definition, continuationCoverage), null,
        (state, blackTurn, current) => {
          if (!certifiedControl) return controlDispatches?.[blackTurn];
          const matches = actorsByBoard.get(certificateBoardKey(
            state.board, state.previousBoards, state.consecutivePasses));
          if (!matches?.length) return undefined;
          const currentPhase = Math.floor(current / TICK_MS) % PHASES;
          const selected = matches.find((candidate) => candidate.phase >= currentPhase)
            ?? matches.at(-1)!;
          return absoluteDispatchPlaytime(parsed.header, selected.phase);
        });
      if (!game.completed || !game.trace?.length) throw new Error(`${groupId}:${move} did not complete`);
      if (certifiedControl && continuationCoverage.fallback !== 0) {
        throw new Error(`${groupId}:${move} certified control left its certificate suffix: ${
          continuationCoverage.missing.join(",")}`);
      }
      if (certifiedControl) controlDispatches = game.trace.map((turn) => turn.dispatchPlaytime);
      const first = game.trace[0]!;
      const continuationLength = game.trace.length;
      const lossPenalizedBlackPower = game.score.X * (game.won ? 1 : 0.5);
      const row = {
        schema: SCHEMA, kind: "trajectory", profile: "small5", teacherSha256,
        opponentOracle: ORACLE, split: record.split,
        episode: episodeFor(record.split, recordIndex * 5 + candidateIndex),
        values: [{ state: postReplyState(first), behavior: futureBehaviorFor(5, definition),
          elapsed: actor.elapsed + 1, won: Number(game.won), score: lossPenalizedBlackPower,
          blackPower: game.score.X, remaining: continuationLength, weight: 1 / candidates.length,
          author: AUTHOR }],
        generation: {
          source: "handcrafted", authority: "certified-playbook-terminal-regret-v1",
          counterfactualAuthority: "certified-playbook-terminal-regret-v1",
          numericAuthor: AUTHOR,
          counterfactualTargetScope: "immediate-post-reply",
          counterfactualGroupId: groupId, counterfactualCandidateIndex: candidateIndex,
          counterfactualCandidateCount: candidates.length, candidateMoves: candidates,
          forcedAction: move, certifiedAction: Number(example.action),
          kataGoActions: generation.kataGoActions, kataGoAgrees: false,
          originState: example.state, originBehavior: example.behavior,
          originElapsed: actor.elapsed, actualReply: first.white,
          opponent: opponentName, environmentId: `${generation.environmentId}:${key}`,
          pairedEnvironmentId: `${generation.environmentId}:${key}`,
          conditionalGroupSha256: generation.conditionalGroupSha256,
          selectionKind: "certified-root",
          positionContentSha256: key, originalEpisode: Number(example.episode),
          certificate: generation.certificate, certificateStateId: actor.stateId,
          continuationPolicy: { kind: "certified-book-aware-with-handcrafted-fallback-v1",
            certificateActions: true, fallback: policyIdentity },
          continuationCoverage,
          originalResponseCorpus: input,
          originalResponseCorpusSha256: inputSha256,
          effectiveSeeds: { dispatchPlaytime: absoluteDispatchPlaytime(parsed.header, actor.phase),
            opponentAiSeed: actor.opponentSeed, opponentTieRoll: TIE_ROLL,
            defenseSeed: null, continuationDispatchPlaytimes: game.trace.map((turn) => turn.dispatchPlaytime),
            continuationOpponentAiSeeds: game.trace.map((turn) => turn.dispatchPlaytime + 200) },
          continuationTrace: diagnosticTrace(game.trace),
          continuationFinalState: postReplyState(game.trace.at(-1)!),
          terminalOutcome: { won: game.won, blackPower: game.score.X,
            whiteScore: game.score.O, lossPenalizedBlackPower,
            lossPenalizedBlackPowerPerTotalTurn: terminalRate(
              game, actor.elapsed, continuationLength),
            continuationLength, totalRouteTurns: actor.elapsed + continuationLength },
        },
      };
      groupRows.push(row);
      trajectories.push(row);
    }
    trajectories.push(ranking(groupRows));
    if ((recordIndex + 1) % 25 === 0) {
      console.error(JSON.stringify({ completedRoots: recordIndex + 1, roots: selected.length }));
    }
  }
  await writeRows(out, trajectories);
  console.log(JSON.stringify({ input, inputSha256, out, outputSha256: sha(
    new Uint8Array(await Bun.file(out).arrayBuffer())), selectedRoots: selected.length,
    groups: trajectories.filter((row) => row.kind === "actor-ranking").length,
    trajectories: trajectories.filter((row) => row.kind === "trajectory").length,
    records: trajectories.length, author: AUTHOR }));
}

if (import.meta.main) await main();
