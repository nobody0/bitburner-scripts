/** Convert lookahead playbook entries into K=1 policy (actor) labels.
 *
 * daemon19 deploys at strict K=1: one forward pass, argmax, no post-response
 * value dispatch. A 19x19 K>1 turn would need the TypeScript oracle to apply an
 * exact reply per candidate plus a ~29 ms multi-board value dispatch against a
 * 15/18 ms budget, so search cannot happen at inference. It has to happen here.
 *
 * Each playbook entry is a root where exact-reply lookahead, scored by KataGo at
 * the leaves, preferred a different action to KataGo's own root choice by a
 * measured margin. Emitting that action as an actor label distils the search
 * into the policy: the cost is paid once during generation, and the deployed
 * player still spends exactly one argmax.
 *
 * These are the only labels in the pipeline that KataGo distillation cannot
 * produce, because they are precisely the positions where KataGo is not the
 * right teacher.
 */
import { createHash } from "node:crypto";
import { rename, unlink } from "node:fs/promises";
import { legalMoves, type GoBoard } from "./strategy/decide.ts";
import { encodeOpponentTurnBehavior, opponentTurnBehavior } from "../../shared/strategy/go/opponent.ts";
import { GO_ARENA_OPPONENTS } from "./arena.ts";

type Json = Record<string, any>;

function flag(name: string, fallback?: string): string {
  const index = Bun.argv.indexOf(name);
  const value = index >= 0 ? Bun.argv[index + 1] : undefined;
  if (value === undefined) {
    if (fallback === undefined) throw new Error(`missing ${name}`);
    return fallback;
  }
  return value;
}

function encodedState(board: GoBoard, previousBoards: readonly string[][],
  consecutivePasses: number): string {
  const size = board.size;
  const legal = new Uint8Array(size * size).fill(0x30);
  for (const [x, y] of legalMoves(board, "X", previousBoards)) legal[x * size + y] = 0x31;
  return [board.rows.join(""), new TextDecoder().decode(legal),
    String(Math.min(2, Math.max(0, consecutivePasses))), "0", "0"].join("|");
}

async function main(): Promise<void> {
  const inputs = flag("--in").split(",").filter(Boolean);
  const out = flag("--out");
  const teacherSha256 = flag("--teacher-sha256");
  const minMargin = Number(flag("--min-margin", "0.05"));
  if (await Bun.file(out).exists()) throw new Error(`output already exists: ${out}`);
  const opponent = GO_ARENA_OPPONENTS[6]!;

  interface Row { entry: Json; key: string }
  const rows: Row[] = [];
  const seen = new Set<string>();
  let skippedMargin = 0;
  let skippedDuplicate = 0;
  let missingElapsed = 0;
  for (const input of inputs) {
    const decoded = new TextDecoder().decode(
      Bun.gunzipSync(new Uint8Array(await Bun.file(input).arrayBuffer())));
    for (const line of decoded.split("\n")) {
      if (!line) continue;
      const entry = JSON.parse(line) as Json;
      if (Number(entry.winMargin) < minMargin) { skippedMargin++; continue; }
      const board: GoBoard = { size: entry.board.length, rows: entry.board };
      const state = encodedState(board, entry.previousBoards ?? [],
        Number(entry.consecutivePasses ?? 0));
      // Deduplicate on the exact deployed input so a position searched in two
      // routes cannot be counted twice or land on both sides of the split.
      const key = `${state}|${entry.dispatchPlaytime}`;
      if (seen.has(key)) { skippedDuplicate++; continue; }
      seen.add(key);
      rows.push({ entry: { ...entry, encodedState: state }, key });
    }
  }
  if (!rows.length) throw new Error("no entries survived the margin filter");

  rows.sort((left, right) => left.key.localeCompare(right.key));
  const records: string[] = [];
  let heldoutEpisode = 0;
  let trainEpisode = 1;
  rows.forEach(({ entry }, index) => {
    const heldout = index % 10 === 0;
    let episode: number;
    if (heldout) { episode = heldoutEpisode; heldoutEpisode += 10; }
    else { episode = trainEpisode; trainEpisode += (trainEpisode + 1) % 10 === 0 ? 2 : 1; }
    const size = entry.board.length;
    const board: GoBoard = { size, rows: entry.board };
    const moves = legalMoves(board, "X", entry.previousBoards ?? [])
      .map(([x, y]) => x * size + y);
    moves.push(size * size);
    // elapsed feeds a real input plane. Entries generated before the exporter
    // recorded it must be rejected, not defaulted: stamping elapsed=1 on a
    // midgame board fabricates the input the policy is trained against.
    if (!Number.isInteger(entry.rootElapsed)) {
      missingElapsed++;
      return;
    }
    const rootElapsed = Number(entry.rootElapsed);
    const [ax, ay] = String(entry.lookaheadAction).split(",").map(Number);
    const action = String(entry.lookaheadAction) === "pass" ? size * size : ax * size + ay;
    if (!moves.includes(action)) return;
    const behavior = encodeOpponentTurnBehavior(
      opponentTurnBehavior(opponent.name, Number(entry.rootSeed)), undefined);
    records.push(JSON.stringify({
      schema: "bitburner-go-exhaustive-proposals-v9.5",
      kind: "actor",
      profile: "daemon19",
      teacherSha256,
      opponentOracle: "bitburner-go-ai-v3.0.1",
      split: heldout ? "heldout" : "train",
      episode,
      example: {
        episode, state: entry.encodedState, behavior: Array.from(behavior),
        elapsed: rootElapsed + 1, moves,
        action, actions: [action], source: "self",
      },
      generation: {
        source: "self",
        authority: "katago-lookahead-exploit-v1",
        originatingStudentSha256: entry.originatingStudentSha256,
        kataGoAction: entry.kataGoAction,
        winMargin: entry.winMargin,
        scoreMargin: entry.scoreMargin,
        rootWinrate: entry.rootWinrate,
        evaluator: entry.evaluator,
      },
    }));
  });

  const partial = `${out}.partial`;
  try {
    await Bun.write(partial, Bun.gzipSync(new TextEncoder().encode(`${records.join("\n")}\n`)));
    await rename(partial, out);
  } catch (error) {
    await unlink(partial).catch(() => undefined);
    throw error;
  }
  console.log(JSON.stringify({ inputs, out, actors: records.length,
    skippedMargin, skippedDuplicate, missingElapsed, minMargin,
    outSha256: createHash("sha256")
      .update(new Uint8Array(await Bun.file(out).arrayBuffer())).digest("hex") }, null, 2));
}

await main();
