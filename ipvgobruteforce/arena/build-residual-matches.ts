import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { PythonV9Backend } from "../../go-ai/teacher/python-v9-backend.ts";
import {
  encodeOpponentTurnBehavior,
  opponentTurnBehavior,
} from "../../shared/strategy/go/opponent.ts";
import {
  boardHash,
  playMove,
  scoreBoard,
  type GoBoard,
  type GoRewardOpponent,
} from "../../shared/strategy/go/rules.ts";
import {
  goBoardWords,
  goLegalWords,
  packGoBoard,
} from "../../shared/strategy/go/neural/backend.ts";
import { packPlaybookBoard } from "./playbook.ts";

const ROOT = resolve(import.meta.dir, "../..");
const DATA = join(ROOT, "ipvgobruteforce/data/seeded-phases");
const MODEL = join(ROOT, "go-ai/small5-champion.model");
const OUTPUT = join(DATA, "all-5x5-v1/residual");
const BATCH_STATES = 1_024;
const MARGIN = 0.75;

const SPECS = [
  ["netburners", "Netburners", "netburners-5x5-epoch2697-v7-full"],
  ["slum-snakes", "Slum Snakes", "slum-snakes-5x5-epoch2697-v7-full"],
  ["black-hand", "The Black Hand", "black-hand-5x5-h40-v1"],
  ["tetrads", "Tetrads", "tetrads-5x5-h40-v1"],
  ["daedalus", "Daedalus", "daedalus-5x5-h40-v1"],
  ["illuminati", "Illuminati", "illuminati-5x5-h40-v1"],
] as const;

const KOMI: Readonly<Record<string, number>> = {
  Netburners: 1.5,
  "Slum Snakes": 3.5,
  "The Black Hand": 3.5,
  Tetrads: 5.5,
  Daedalus: 5.5,
  Illuminati: 7.5,
};

interface State {
  phase: number;
  board: GoBoard;
  packedBoard: bigint;
  passes: number;
  credit: number;
  history: bigint[];
  action: number;
  identity: string;
}

function u32(value: number): number { return value >>> 0; }
function rotl(value: number, shift: number): number {
  return u32((value << shift) | (value >>> (32 - shift)));
}

function historyHash(history: readonly bigint[], seed = 0): number {
  const prime2 = 0x85ebca77;
  const prime3 = 0xc2b2ae3d;
  const prime4 = 0x27d4eb2f;
  const prime5 = 0x165667b1;
  let hash = u32(prime5 + history.length * 8) ^ seed;
  for (const board of history) for (const word of [Number(board & 0xffff_ffffn), Number(board >> 32n)]) {
    hash = u32(hash + Math.imul(word, prime3));
    hash = Math.imul(rotl(hash, 17), prime4);
  }
  hash ^= hash >>> 15;
  hash = Math.imul(hash, prime2);
  hash ^= hash >>> 13;
  hash = Math.imul(hash, prime3);
  return u32(hash ^ (hash >>> 16));
}

function unpackBoard(packed: bigint): GoBoard {
  const columns: string[] = [];
  for (let x = 0; x < 5; x++) {
    let column = "";
    for (let y = 0; y < 5; y++) {
      const code = Number((packed >> BigInt(2 * (x * 5 + y))) & 3n);
      column += code === 1 ? "X" : code === 2 ? "O" : code === 3 ? "#" : ".";
    }
    columns.push(column);
  }
  return { size: 5, rows: columns };
}

function parseAction(text: string): number | undefined {
  const action = text.split("@", 1)[0]!;
  if (action === "pass") return 25;
  if (action === "align" || action === "terminal") return undefined;
  const [x, y] = action.split(",").map(Number);
  return x! * 5 + y!;
}

function parseState(line: string): State | undefined {
  const fields = line.split("\t");
  if (fields.length === 9) fields.push("");
  if (fields.length !== 10) throw new Error(`invalid certificate row with ${fields.length} fields`);
  const action = parseAction(fields[7]!);
  if (action === undefined) return undefined;
  const board: GoBoard = { size: 5, rows: Array.from({ length: 5 }, (_, x) => fields[4]!.slice(x * 5, x * 5 + 5)) };
  const packedBoard = packPlaybookBoard(board.rows);
  const history = fields[6] ? fields[6].split(",").map((value) => BigInt(value)) : [];
  const phase = Number(fields[1]);
  const passes = Number(fields[5]);
  const credit = Number(fields[3]);
  const hash1 = historyHash(history);
  const hash2 = historyHash(history, 0x7f4a7c15);
  const identity = `${phase}\t0x${packedBoard.toString(16)}\t${passes}\t${credit}\t${hash1}\t${hash2}`;
  return { phase, board, packedBoard, passes, credit, history, action, identity };
}

async function selectedPhases(enemy: string): Promise<Set<number>> {
  const lines = (await readFile(join(DATA, "all-5x5-v1/merged/root-routes.tsv"), "utf8"))
    .trimEnd().split("\n");
  const header = lines.shift()!.split("\t");
  const enemyColumn = header.indexOf("enemy");
  const entryColumn = header.indexOf("entry_phase");
  if (enemyColumn < 0 || entryColumn < 0) throw new Error("merged routes lack enemy/entry_phase");
  return new Set(lines.map((line) => line.split("\t"))
    .filter((fields) => fields[enemyColumn] === enemy)
    .map((fields) => Number(fields[entryColumn])));
}

function policyPhase(filename: string): number | undefined {
  const match = /^(\d+)(?:-h\d+)?\.tsv$/.exec(filename);
  return match ? Number(match[1]) : undefined;
}

async function buildOpponent(
  backend: PythonV9Backend,
  key: string,
  enemy: GoRewardOpponent,
  corpus: string,
): Promise<Record<string, number>> {
  const phases = await selectedPhases(enemy);
  const directory = join(DATA, corpus, "policies");
  const files = (await readdir(directory)).filter((filename) => {
    const phase = policyPhase(filename);
    return phase !== undefined && phases.has(phase);
  }).sort((left, right) => policyPhase(left)! - policyPhase(right)! || left.localeCompare(right));
  const seen = new Set<string>();
  const matches: string[] = [];
  const pending: State[] = [];
  let source = 0;
  let agreements = 0;

  const flush = async () => {
    if (!pending.length) return;
    const seedCount = 2;
    const count = pending.length * seedCount;
    const words = goBoardWords(5);
    const legalWords = goLegalWords(5);
    const packed = new Uint32Array(words * count);
    const legal = new Uint32Array(legalWords * count);
    const state = new Float32Array(4 * count);
    const behavior = new Float32Array(backend.behaviorFeatures * count);
    const legalByState: number[][] = [];
    for (let item = 0; item < pending.length; item++) {
      const entry = pending[item]!;
      const historyBoards = entry.history.map(unpackBoard);
      const prior = new Set(historyBoards.map(boardHash));
      const legalMoves: number[] = [];
      for (let x = 0; x < 5; x++) for (let y = 0; y < 5; y++) {
        if (playMove(entry.board, x, y, "X", prior)) legalMoves.push(x * 5 + y);
      }
      legalByState.push(legalMoves);
      for (let seed = 0; seed < seedCount; seed++) {
        const index = item * seedCount + seed;
        packGoBoard(entry.board, 5, packed, index * words);
        for (const move of legalMoves) legal[index * legalWords + (move >> 5)]! |= 1 << (move & 31);
        state.set([entry.passes / 2, Math.floor(entry.history.length / 2) / 50, 0, 0], index * 4);
        behavior.set(encodeOpponentTurnBehavior(
          opponentTurnBehavior(enemy, (entry.phase + 1 + seed) * 200), KOMI[enemy],
        ), index * backend.behaviorFeatures);
      }
    }
    const proposal = await backend.evaluateProposal({ packed, legal, state, behavior, count });
    for (let item = 0; item < pending.length; item++) {
      const entry = pending[item]!;
      const scores: Array<[number, number]> = [];
      for (const action of [...legalByState[item]!, 25]) {
        const score = (proposal.moves[(item * 2) * 26 + action]!
          + proposal.moves[(item * 2 + 1) * 26 + action]!) / 2;
        scores.push([action, score]);
      }
      scores.sort((left, right) => right[1] - left[1] || left[0] - right[0]);
      if (scores[0]![0] === entry.action && scores[0]![1] - scores[1]![1] >= MARGIN) {
        matches.push(`${entry.identity}\t${entry.action}`);
        agreements++;
      }
    }
    pending.length = 0;
  };

  for (const filename of files) {
    const lines = (await readFile(join(directory, filename), "utf8")).split("\n").slice(7);
    for (const line of lines) {
      if (!line) continue;
      source++;
      const entry = parseState(line);
      if (!entry || seen.has(entry.identity)) continue;
      seen.add(entry.identity);
      if (entry.passes > 0) {
        const score = scoreBoard(entry.board, KOMI[enemy]!);
        if (score.X >= score.O && entry.action === 25) {
          matches.push(`${entry.identity}\t25`);
          agreements++;
          continue;
        }
      }
      pending.push(entry);
      if (pending.length >= BATCH_STATES) await flush();
    }
  }
  await flush();
  await writeFile(join(OUTPUT, `${key}.matches.tsv`),
    "phase\tboard\tpasses\talignment_credit\thistory_hash\thistory_hash2\taction\n"
      + matches.join("\n") + (matches.length ? "\n" : ""));
  return { files: files.length, sourceStates: source, distinctStates: seen.size, agreements };
}

async function main() {
  await mkdir(OUTPUT, { recursive: true });
  const backend = await PythonV9Backend.create(MODEL, process.env.IPVGO_DEVICE ?? "mps");
  try {
    const opponents: Record<string, Record<string, number>> = {};
    for (const [key, enemy, corpus] of SPECS) {
      opponents[enemy] = await buildOpponent(backend, key, enemy, corpus);
      console.log(enemy, opponents[enemy]);
    }
    const modelSha256 = createHash("sha256").update(await readFile(MODEL)).digest("hex");
    await writeFile(join(OUTPUT, "summary.json"), JSON.stringify({
      schema: 1,
      model: "go-ai/small5-champion.model",
      modelSha256,
      policy: "two-seed mean V9 policy head",
      margin: MARGIN,
      opponents,
    }, null, 2) + "\n");
  } finally {
    backend.dispose();
  }
}

if (import.meta.main) await main();
