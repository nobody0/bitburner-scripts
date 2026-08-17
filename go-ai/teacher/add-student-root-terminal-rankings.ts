/** Add truthful candidate-group rankings to student-root counterfactual trajectories. */
import { createHash } from "node:crypto";
import { rename, unlink } from "node:fs/promises";

type Json = Record<string, any>;

interface RankingResult {
  records: Json[];
  groups: number;
}

function requiredObject(value: unknown, label: string): Json {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`missing ${label}`);
  return value as Json;
}

function requiredInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) throw new Error(`invalid ${label}`);
  return Number(value);
}

function terminalOrder(left: Json, right: Json): number {
  const leftTerminal = requiredObject(requiredObject(left.generation, "generation").terminalOutcome,
    "terminalOutcome");
  const rightTerminal = requiredObject(requiredObject(right.generation, "generation").terminalOutcome,
    "terminalOutcome");
  const leftWon = Number(leftTerminal.expectedWinProbability
    ?? (leftTerminal.won === true ? 1 : 0));
  const rightWon = Number(rightTerminal.expectedWinProbability
    ?? (rightTerminal.won === true ? 1 : 0));
  if (leftWon !== rightWon) return rightWon - leftWon;
  const leftRate = Number(leftTerminal.expectedLossPenalizedPowerPerTotalTurn
    ?? Number(leftTerminal.lossPenalizedBlackPower)
      / Math.max(Number(leftTerminal.totalRouteTurns), 1e-6));
  const rightRate = Number(rightTerminal.expectedLossPenalizedPowerPerTotalTurn
    ?? Number(rightTerminal.lossPenalizedBlackPower)
      / Math.max(Number(rightTerminal.totalRouteTurns), 1e-6));
  if (leftRate !== rightRate) return rightRate - leftRate;
  return requiredInteger(requiredObject(left.generation, "generation").counterfactualCandidateIndex,
    "counterfactualCandidateIndex")
    - requiredInteger(requiredObject(right.generation, "generation").counterfactualCandidateIndex,
      "counterfactualCandidateIndex");
}

export function terminalRankingRecords(records: Json[]): RankingResult {
  const grouped = new Map<string, Json[]>();
  for (const record of records) {
    const generation = record.generation;
    const oldAuthority = generation?.counterfactualTargetScope === "immediate-post-reply"
      && generation.numericAuthor === "environment-rollout:student-root-handcrafted-continuation-v2";
    const expectedAuthority = generation?.counterfactualTargetScope
      === "immediate-post-reply-future-marginalized"
      && generation.numericAuthor === "environment-rollout:student-root-future-marginalized-v1";
    if (record.kind !== "trajectory" || (!oldAuthority && !expectedAuthority)) continue;
    const group = String(generation.counterfactualGroupId ?? "");
    if (!group) throw new Error("student-root trajectory is missing counterfactualGroupId");
    const bucket = grouped.get(group) ?? [];
    bucket.push(record);
    grouped.set(group, bucket);
  }
  if (!grouped.size) throw new Error("input contains no v2 student-root counterfactual groups");

  const rankings: Json[] = [];
  for (const [groupId, rows] of [...grouped].sort(([left], [right]) => left.localeCompare(right))) {
    const firstGeneration = requiredObject(rows[0]!.generation, "generation");
    const moves = (firstGeneration.candidateMoves as unknown[]).map((move) => requiredInteger(move, "candidate move"));
    const count = requiredInteger(firstGeneration.counterfactualCandidateCount, "counterfactualCandidateCount");
    if (moves.length !== count || rows.length !== count || new Set(moves).size !== count) {
      throw new Error(`${groupId}: incomplete or duplicated candidate group`);
    }
    const byMove = new Map<number, Json>();
    for (const row of rows) {
      const generation = requiredObject(row.generation, "generation");
      if (row.split !== rows[0]!.split || generation.counterfactualCandidateCount !== count
        || JSON.stringify(generation.candidateMoves) !== JSON.stringify(moves)) {
        throw new Error(`${groupId}: inconsistent group provenance`);
      }
      const move = requiredInteger(generation.forcedAction, "forcedAction");
      if (!moves.includes(move) || byMove.has(move)) throw new Error(`${groupId}: invalid forced action`);
      byMove.set(move, row);
    }
    const ordered = moves.map((move) => byMove.get(move)!);
    const best = [...ordered].sort(terminalOrder)[0]!;
    const bestGeneration = requiredObject(best.generation, "generation");
    const bestMove = requiredInteger(bestGeneration.forcedAction, "best forcedAction");
    const bestTerminal = requiredObject(bestGeneration.terminalOutcome, "terminalOutcome");
    const bestWon = Number(bestTerminal.expectedWinProbability
      ?? (bestTerminal.won === true ? 1 : 0));
    const candidates = ordered.map((row) => {
      const values = row.values;
      if (!Array.isArray(values) || values.length !== 1) throw new Error(`${groupId}: expected one immediate value`);
      const value = requiredObject(values[0], "immediate value");
      return [{ state: value.state, behavior: value.behavior, elapsed: value.elapsed,
        won: value.won, score: value.score, remaining: value.remaining, weight: 1,
        author: value.author }];
    });
    const winGroupMoves = ordered.filter((row) => {
      const terminal = requiredObject(requiredObject(row.generation, "generation").terminalOutcome,
        "terminalOutcome");
      return Math.abs(Number(terminal.expectedWinProbability
        ?? (terminal.won === true ? 1 : 0)) - bestWon) <= 1e-9;
    })
      .map((row) => requiredInteger(requiredObject(row.generation, "generation").forcedAction,
        "forcedAction"));
    rankings.push({
      schema: rows[0]!.schema,
      kind: "actor-ranking",
      profile: rows[0]!.profile,
      teacherSha256: rows[0]!.teacherSha256,
      opponentOracle: rows[0]!.opponentOracle,
      split: rows[0]!.split,
      episode: rows[0]!.episode,
      example: {
        episode: rows[0]!.episode,
        state: firstGeneration.originState,
        behavior: firstGeneration.originBehavior,
        elapsed: firstGeneration.originElapsed,
        moves,
        bestMove,
        winGroupMoves,
        candidates,
        source: "counterfactual",
      },
      generation: {
        source: "counterfactual",
        numericAuthor: firstGeneration.numericAuthor,
        counterfactualGroupId: groupId,
        counterfactualTargetScope: firstGeneration.counterfactualTargetScope,
        selectionKind: firstGeneration.selectionKind,
        counterfactualRankingAuthority: bestGeneration.counterfactualTargetScope
          === "immediate-post-reply-future-marginalized"
          ? "future-marginalized-terminal-v1" : "real-terminal-v1",
        objective: "win-first-loss-penalized-black-power-per-total-turn",
        originatingStudentSha256: firstGeneration.originatingStudentSha256,
      },
    });
  }
  return { records: rankings, groups: grouped.size };
}

function flag(name: string): string {
  const index = Bun.argv.indexOf(name);
  const value = index >= 0 ? Bun.argv[index + 1] : undefined;
  if (!value) throw new Error(`missing ${name}`);
  return value;
}

async function sha256(path: string): Promise<string> {
  return createHash("sha256").update(new Uint8Array(await Bun.file(path).arrayBuffer())).digest("hex");
}

async function main(): Promise<void> {
  const input = flag("--in");
  const output = flag("--out");
  if (await Bun.file(output).exists()) throw new Error(`output already exists: ${output}`);
  const partial = `${output}.partial`;
  if (await Bun.file(partial).exists()) throw new Error(`stale partial exists: ${partial}`);
  const compressed = new Uint8Array(await Bun.file(input).arrayBuffer());
  const decoded = new TextDecoder().decode(Bun.gunzipSync(compressed));
  if (!decoded.endsWith("\n")) throw new Error("input JSONL is missing its final newline");
  const lines = decoded.slice(0, -1).split("\n");
  const source = lines.map((line) => JSON.parse(line) as Json);
  const derived = terminalRankingRecords(source);
  const encoded = new TextEncoder().encode(
    `${lines.join("\n")}\n${derived.records.map((record) => JSON.stringify(record)).join("\n")}\n`);
  try {
    await Bun.write(partial, Bun.gzipSync(encoded));
    await rename(partial, output);
  } catch (error) {
    await unlink(partial).catch(() => undefined);
    throw error;
  }
  console.log(JSON.stringify({ input, inputSha256: createHash("sha256").update(compressed).digest("hex"),
    inputRecords: lines.length, output, outputSha256: await sha256(output),
    outputRecords: lines.length + derived.records.length, addedRankings: derived.records.length,
    groups: derived.groups, retainedLinesCopiedVerbatim: true }));
}

if (import.meta.main) await main();
