/** Split certified-playbook actor rows into general-Go and opponent-exploit
 * classes using independent KataGo agreement.
 *
 * A certified action wins against every modeled White outcome, but that is a
 * statement about the *seeded* opponent, not about Go. When KataGo also
 * approves the action, it is ordinary strong Go and may train the shared board
 * representation. When KataGo disagrees, the action is justified only jointly
 * with the exact behaviour input and must not train as a general board pattern.
 *
 * This tool only labels. It writes the two component-preserving subsets and a
 * summary; it never edits the source shard, invents authority, or trains.
 */
import { createHash } from "node:crypto";
import { KataGoAdvisor, KATAGO_MODELS, type KataGoMove } from "./advisor.ts";
import { GO_ARENA_OPPONENTS } from "../../sim/go-arena.ts";
import type { GoBoard } from "../teacher/strategy/decide.ts";

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

/** `state` is `board|legalMask|passes|...`; the board is row-major over
 * `point = x * size + y`, exactly like `rules.ts` indexing. */
function decodeBoard(state: string): GoBoard {
  const cells = state.split("|")[0]!;
  const size = Math.round(Math.sqrt(cells.length));
  if (size * size !== cells.length) throw new Error(`state is not square: ${cells.length}`);
  const rows: string[] = [];
  for (let x = 0; x < size; x++) rows.push(cells.slice(x * size, x * size + size));
  return { size, rows } as GoBoard;
}

function moveKey(point: number, size: number): string {
  return point === size * size ? "pass" : `${Math.floor(point / size)},${point % size}`;
}

function adviceKey(move: KataGoMove): string {
  return move === "pass" ? "pass" : `${move[0]},${move[1]}`;
}

async function main(): Promise<void> {
  const input = flag("--in");
  const outAgree = flag("--out-agree");
  const outExploit = flag("--out-exploit");
  const summaryOut = flag("--summary-out");
  const visits = Number(flag("--visits", "8"));
  const topK = Number(flag("--top-k", "4"));
  const limit = Number(flag("--limit", "0"));
  const model = flag("--model", KATAGO_MODELS.small5.file);
  const binary = flag("--binary", "go-ai/.deps/KataGo/build/ipvgo-opencl/katago");
  const config = flag("--config", "go-ai/katago/config/analysis.cfg");
  for (const path of [outAgree, outExploit, summaryOut]) {
    if (await Bun.file(path).exists()) throw new Error(`output already exists: ${path}`);
  }

  const compressed = new Uint8Array(await Bun.file(input).arrayBuffer());
  const decoded = new TextDecoder().decode(Bun.gunzipSync(compressed));
  const lines = decoded.endsWith("\n") ? decoded.slice(0, -1).split("\n") : decoded.split("\n");
  const komiFor = new Map(GO_ARENA_OPPONENTS.map((value) => [String(value.name), value.komi]));

  const kata = new KataGoAdvisor(binary, model, config);
  const agree: string[] = [];
  const exploit: string[] = [];
  let queried = 0;
  let skipped = 0;
  const perOpponent = new Map<string, { agree: number; exploit: number }>();
  // KataGo's own top-1, kept separately: agreement with the executed move is a
  // stronger claim than mere membership in its approved set.
  let strictAgree = 0;

  try {
    for (const line of lines) {
      if (!line) continue;
      const record = JSON.parse(line) as Json;
      const example = record.example as Json;
      if (record.kind !== "actor" || !example) { skipped++; continue; }
      if (limit > 0 && queried >= limit) break;
      const board = decodeBoard(String(example.state));
      const size = board.size;
      const opponent = String(record.generation?.opponent ?? "");
      const komi = komiFor.get(opponent);
      if (komi === undefined) throw new Error(`unknown opponent komi: ${opponent}`);
      const allowed = new Set((example.moves as number[]).map((point) => moveKey(point, size)));
      const advice = await kata.shortlist(board, [], komi, visits, topK, allowed);
      queried++;
      const approved = new Set(advice.map((value) => adviceKey(value.move)));
      const certified = moveKey(Number(example.action), size);
      const bucket = perOpponent.get(opponent) ?? { agree: 0, exploit: 0 };
      if (advice.length > 0 && adviceKey(advice[0]!.move) === certified) strictAgree++;
      if (approved.has(certified)) { agree.push(line); bucket.agree++; }
      else { exploit.push(line); bucket.exploit++; }
      perOpponent.set(opponent, bucket);
      if (queried % 250 === 0) {
        console.error(JSON.stringify({ queried, agree: agree.length, exploit: exploit.length }));
      }
    }
  } finally {
    await kata.close();
  }

  const write = async (path: string, rows: string[]): Promise<string> => {
    const payload = new TextEncoder().encode(rows.length ? `${rows.join("\n")}\n` : "");
    await Bun.write(path, Bun.gzipSync(payload));
    return createHash("sha256")
      .update(new Uint8Array(await Bun.file(path).arrayBuffer())).digest("hex");
  };
  const agreeSha = await write(outAgree, agree);
  const exploitSha = await write(outExploit, exploit);

  const summary = {
    schema: "bitburner-go-certified-katago-agreement-v1",
    input,
    inputSha256: createHash("sha256").update(compressed).digest("hex"),
    katagoModel: model,
    visits,
    topK,
    queried,
    skipped,
    agree: agree.length,
    exploit: exploit.length,
    agreeFraction: queried ? agree.length / queried : 0,
    strictTop1Agree: strictAgree,
    strictTop1Fraction: queried ? strictAgree / queried : 0,
    perOpponent: Object.fromEntries(perOpponent),
    outputs: { agree: outAgree, agreeSha256: agreeSha, exploit: outExploit, exploitSha256: exploitSha },
  };
  await Bun.write(summaryOut, `${JSON.stringify(summary, null, 2)}\n`);
  console.log(JSON.stringify(summary, null, 2));
}

await main();
