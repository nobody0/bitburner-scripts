/** Convert KataGo lookahead leaf evaluations into V9.5 post-reply value rows.
 *
 * daemon19 plays strict K=1 with a deliberately neutral value head, so it has
 * no search at all. Small5's identical deep-search structure is worth about
 * +6.7 points there, which makes a usable value head the largest remaining
 * lever on 19x19 now that distillation and capacity have both saturated.
 *
 * The lookahead generator already evaluated every leaf of an exact-reply tree
 * with KataGo. Those leaves are exactly the boards a K>1 finalizer must rank:
 * the position after Black's candidate, White's exact reply, Black's follow-up
 * and White's successor-seed reply.
 *
 * Only the win head is supervised. KataGo reports a winrate and a score lead in
 * Go points, and a score lead is *not* loss-penalized Black Power, so score and
 * remaining are emitted as zero and must be trained with
 * `--mc-score-loss-weight 0 --mc-remaining-loss-weight 0`. Inventing an IPvGO
 * Power target from a Go score lead is exactly the mistake that got KataGo
 * value rejected as a target before.
 */
import { createHash } from "node:crypto";
import { rename, unlink } from "node:fs/promises";
import { GO_ARENA_OPPONENTS } from "./arena.ts";
import { encodeOpponentFutureBehavior } from "../../shared/strategy/go/opponent.ts";
import { legalMoves, type GoBoard } from "./strategy/decide.ts";

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

/** `board|legal|passes|responsePass|responseNoOp`, matching encode_state_planes. */
function encodedState(board: GoBoard, previousBoards: readonly string[][],
  consecutivePasses: number): string {
  const size = board.size;
  const cells = board.rows.join("");
  const legal = new Uint8Array(size * size).fill(0x30);
  for (const [x, y] of legalMoves(board, "X", previousBoards)) legal[x * size + y] = 0x31;
  return [cells, new TextDecoder().decode(legal),
    String(Math.min(2, Math.max(0, consecutivePasses))), "0", "0"].join("|");
}

async function main(): Promise<void> {
  const input = flag("--in");
  const out = flag("--out");
  const teacherSha256 = flag("--teacher-sha256");
  if (await Bun.file(out).exists()) throw new Error(`output already exists: ${out}`);

  const opponent = GO_ARENA_OPPONENTS[6]!;   // World Daemon
  const decoded = new TextDecoder().decode(
    Bun.gunzipSync(new Uint8Array(await Bun.file(input).arrayBuffer())));
  // The schema derives split from episode number (episode % 10 == 0 is
  // held out). Assign whole *roots* to one side first, then number episodes to
  // match, so leaves of the same searched position can never straddle the
  // split and leak.
  const leaves: Json[] = [];
  let skipped = 0;
  for (const line of decoded.split("\n")) {
    if (!line) continue;
    const leaf = JSON.parse(line) as Json;
    const board: GoBoard = { size: leaf.board.length, rows: leaf.board };
    const previousBoards: string[][] = leaf.previousBoards ?? [];
    if (!Number.isFinite(leaf.winrate) || leaf.winrate < 0 || leaf.winrate > 1) { skipped++; continue; }
    // A post-reply value board has consumed its roll: future behaviour mode.
    leaves.push({ leaf, board, previousBoards });
  }

  const rootKey = (leaf: Json): string => `${leaf.route}:${leaf.rootElapsed}`;
  const roots = [...new Set(leaves.map((entry) => rootKey(entry.leaf)))].sort();
  const heldoutRoots = new Set(roots.filter((_, index) => index % 10 === 0));
  const records: string[] = [];
  let heldoutEpisode = 0;
  let trainEpisode = 1;
  for (const { leaf, board, previousBoards } of leaves) {
    const heldout = heldoutRoots.has(rootKey(leaf));
    let episode: number;
    if (heldout) { episode = heldoutEpisode; heldoutEpisode += 10; }
    else { episode = trainEpisode; trainEpisode += (trainEpisode + 1) % 10 === 0 ? 2 : 1; }
    const behavior = encodeOpponentFutureBehavior(opponent.name, undefined);
    records.push(JSON.stringify({
      schema: "bitburner-go-exhaustive-proposals-v9.5",
      kind: "trajectory",
      profile: "daemon19",
      teacherSha256,
      opponentOracle: "bitburner-go-ai-v3.0.1",
      split: heldout ? "heldout" : "train",
      episode,
      values: [{
        state: encodedState(board, previousBoards, Number(leaf.consecutivePasses ?? 0)),
        behavior: Array.from(behavior),
        elapsed: Number(leaf.elapsed ?? 0),
        won: Number(leaf.winrate),
        score: 0,
        remaining: 0,
        weight: 1,
        author: "katago-lookahead-leaf-v1",
      }],
      generation: {
        source: "katago",
        numericAuthor: "katago-lookahead-leaf-v1",
        originatingStudentSha256: leaf.originatingStudentSha256,
        route: leaf.route,
        candidate: leaf.candidate,
        follow: leaf.follow,
        successorSeed: leaf.successorSeed,
        katagoScoreLead: leaf.scoreLead,
        katagoVisits: leaf.visits,
        supervises: "win-only; score and remaining are unsupervised placeholders",
      },
    }));
  }
  if (!records.length) throw new Error("no usable leaf evaluations");

  const partial = `${out}.partial`;
  try {
    await Bun.write(partial, Bun.gzipSync(new TextEncoder().encode(`${records.join("\n")}\n`)));
    await rename(partial, out);
  } catch (error) {
    await unlink(partial).catch(() => undefined);
    throw error;
  }
  console.log(JSON.stringify({ input, out, records: records.length, skipped,
    outSha256: createHash("sha256")
      .update(new Uint8Array(await Bun.file(out).arrayBuffer())).digest("hex") }, null, 2));
}

await main();
