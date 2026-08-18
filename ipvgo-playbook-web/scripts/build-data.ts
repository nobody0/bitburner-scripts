import { copyFile, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { gzipSync } from "node:zlib";
import { createHash } from "node:crypto";

const ROOT = resolve(import.meta.dir, "../..");
const DATA = join(ROOT, "ipvgobruteforce/data/seeded-phases");
const OUTPUT = join(import.meta.dir, "../public/data");
const PHASES = 150_000;
const SHARD_SIZE = 1_000;

const enemies = [
  { key: "netburners", name: "Netburners", corpus: "netburners-5x5-epoch2697-v7-full", routes: "root-routes.tsv", multiplier: 0.5, komi: 1.5 },
  { key: "slum-snakes", name: "Slum Snakes", corpus: "slum-snakes-5x5-epoch2697-v7-full", routes: "root-routes.tsv", multiplier: 1, komi: 3.5 },
  { key: "black-hand", name: "The Black Hand", corpus: "black-hand-5x5-epoch2697-v7-full", routes: "root-routes.tsv", multiplier: 1, komi: 3.5 },
  { key: "tetrads", name: "Tetrads", corpus: "tetrads-5x5-epoch2697-v7-full", routes: "root-routes.tsv", multiplier: 1.5, komi: 5.5 },
  { key: "daedalus", name: "Daedalus", corpus: "daedalus-5x5-epoch2697-v7-full", routes: "root-routes.tsv", multiplier: 1.5, komi: 5.5 },
  { key: "illuminati", name: "Illuminati", corpus: "illuminati-5x5-epoch2697-v7-full", routes: "guaranteed-root-routes.tsv", multiplier: 8, komi: 7.5 },
] as const;

function columns(header: string) {
  const names = header.split("\t");
  return (name: string) => {
    const index = names.indexOf(name);
    if (index < 0) throw new Error(`missing ${name}`);
    return index;
  };
}

function u24(view: DataView, offset: number, value: number) {
  view.setUint8(offset, value & 255);
  view.setUint16(offset + 1, value >>> 8, true);
}

async function writeRoutes(enemy: typeof enemies[number], target: string) {
  const routePath = join(DATA, enemy.corpus, "generated", enemy.routes);
  const lines = (await readFile(routePath, "utf8")).trimEnd().split("\n");
  const column = columns(lines.shift()!);
  const indexes = {
    phase: column("phase"), action: column("action"), entry: column("entry_phase"),
    waits: column("waits"), power: column("worst_power"), turns: column("worst_turns"),
  };
  if (lines.length !== PHASES) throw new Error(`${routePath} has ${lines.length} routes`);
  const bytes = new Uint8Array(PHASES * 9);
  const view = new DataView(bytes.buffer);
  for (let expected = 0; expected < PHASES; expected++) {
    const fields = lines[expected]!.split("\t");
    if (Number(fields[indexes.phase]) !== expected) throw new Error(`${routePath} is unordered at ${expected}`);
    const offset = expected * 9;
    u24(view, offset, Number(fields[indexes.entry]));
    view.setUint16(offset + 3, Math.min(65535, Number(fields[indexes.waits])), true);
    view.setUint8(offset + 5, Number(fields[indexes.power]));
    view.setUint16(offset + 6, Math.min(65535, Number(fields[indexes.turns])), true);
    view.setUint8(offset + 8, fields[indexes.action] === "ENTER" ? 1 : 0);
  }
  await writeFile(join(target, "routes.bin"), gzipSync(bytes, { level: 9 }));
}

const actionCode = (raw: string) => {
  // Aligned actions carry a "@slotN" timing suffix (for example "3,1@slot0").
  // The viewer derives timing from successor phases, so only the move matters.
  const action = raw.replace(/@slot\d+$/, "");
  if (action === "pass") return 25;
  if (action === "align") return 26;
  if (action === "next-board") return 27;
  if (action === "terminal") return 28;
  const [x, y] = action.split(",").map(Number);
  if (!Number.isInteger(x) || !Number.isInteger(y)) throw new Error(`unknown certificate action ${raw}`);
  return x! * 5 + y!;
};

const classCode = (value: string) => value === "exact-single" ? 0
  : value === "exact-window" ? 1
    : value.includes("defense") || value.includes("random") ? 2 : 3;

function packBoard(board: string): bigint {
  let result = 0n;
  for (let index = 0; index < 25; index++) {
    const value = board[index] === "X" ? 1n : board[index] === "O" ? 2n : board[index] === "#" ? 3n : 0n;
    result |= value << BigInt(index * 2);
  }
  return result;
}

interface ParsedNode {
  id: number;
  key: string;
  phase: number;
  round: number;
  credit: number;
  board: bigint;
  passes: number;
  action: number;
  actionClass: number;
  successors: number[];
}

async function readPolicy(path: string): Promise<ParsedNode[]> {
  const lines = (await readFile(path, "utf8")).trimEnd().split("\n");
  const headerIndex = lines.findIndex((line) => line.startsWith("state_id\t"));
  if (headerIndex < 0) throw new Error(`${path} has no state table`);
  const column = columns(lines[headerIndex]!);
  const indexes = {
    id: column("state_id"), phase: column("phase"), round: column("round"),
    credit: column("align_credit"), board: column("board"), passes: column("passes"),
    action: column("action"), actionClass: column("action_class"), successors: column("successors"),
  };
  const nodes = lines.slice(headerIndex + 1).filter(Boolean).map((line) => {
    const fields = line.split("\t");
    return {
      id: Number(fields[indexes.id]), phase: Number(fields[indexes.phase]), round: Number(fields[indexes.round]),
      key: `${fields[indexes.phase]}|${fields[indexes.credit]}|${fields[indexes.board]}|${fields[indexes.passes]}|${fields[6]}|${fields[indexes.action]}|${fields[indexes.actionClass]}`,
      credit: Number(fields[indexes.credit]), board: packBoard(fields[indexes.board]!),
      passes: Number(fields[indexes.passes]), action: actionCode(fields[indexes.action]!),
      actionClass: classCode(fields[indexes.actionClass]!),
      successors: fields[indexes.successors] ? fields[indexes.successors]!.split(",").map(Number) : [],
    };
  });
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const signatures = new Map<number, string>();
  const signature = (id: number): string => {
    const cached = signatures.get(id);
    if (cached) return cached;
    const node = byId.get(id);
    if (!node) throw new Error(`${path}: missing successor ${id}`);
    const hash = createHash("sha256").update(node.key);
    for (const child of node.successors.map(signature).sort()) hash.update("\0").update(child);
    const result = hash.digest("hex");
    signatures.set(id, result);
    return result;
  };
  for (const node of nodes) node.key = signature(node.id);
  return nodes;
}

function encodeNodes(nodes: readonly Omit<ParsedNode, "key">[]): Uint8Array {
  const length = 4 + nodes.reduce((sum, node) => sum + 26 + node.successors.length * 4, 0);
  const result = new Uint8Array(length);
  const view = new DataView(result.buffer);
  view.setUint32(0, nodes.length, true);
  let offset = 4;
  for (const node of nodes) {
    view.setUint32(offset, node.id, true);
    view.setUint32(offset + 4, node.phase, true);
    view.setBigUint64(offset + 8, node.board, true);
    view.setUint8(offset + 16, node.round);
    view.setUint8(offset + 17, node.credit);
    view.setUint8(offset + 18, node.passes);
    view.setUint8(offset + 19, node.action);
    view.setUint8(offset + 20, node.actionClass);
    view.setUint8(offset + 21, 0);
    view.setUint16(offset + 22, node.successors.length, true);
    view.setUint16(offset + 24, 0, true);
    offset += 26;
    for (const successor of node.successors) {
      view.setUint32(offset, successor, true);
      offset += 4;
    }
  }
  return result;
}

async function writePolicies(enemy: typeof enemies[number], target: string) {
  const policyDir = join(DATA, enemy.corpus, "policies");
  const names = (await readdir(policyDir)).filter((name) => name.endsWith(".tsv"));
  const shards = new Map<number, string[]>();
  for (const name of names) {
    const phase = Number.parseInt(name, 10);
    if (!Number.isInteger(phase)) continue;
    const shard = Math.floor(phase / SHARD_SIZE);
    const entries = shards.get(shard) ?? [];
    entries.push(name);
    shards.set(shard, entries);
  }
  for (const [shard, files] of [...shards].sort(([left], [right]) => left - right)) {
    files.sort((left, right) => Number.parseInt(left, 10) - Number.parseInt(right, 10) || left.localeCompare(right));
    const index: Record<string, { name: string; root: number }[]> = {};
    const shared: Omit<ParsedNode, "key">[] = [];
    const sharedByKey = new Map<string, number>();
    for (const name of files) {
      const phase = String(Number.parseInt(name, 10));
      const nodes = await readPolicy(join(policyDir, name));
      const localToShared = new Map<number, number>();
      for (const node of nodes) {
        let id = sharedByKey.get(node.key);
        if (id === undefined) {
          id = shared.length;
          sharedByKey.set(node.key, id);
          shared.push({ ...node, id, successors: [] });
        }
        localToShared.set(node.id, id);
      }
      for (const node of nodes) {
        const id = localToShared.get(node.id)!;
        const successors = [...new Set(node.successors.map((item) => localToShared.get(item)!))].sort((a, b) => a - b);
        const existing = shared[id]!;
        if (existing.successors.length === 0) existing.successors = successors;
        else if (existing.action === node.action && existing.successors.join(",") !== successors.join(",")) {
          throw new Error(`${enemy.name}: exact state has different outcomes in ${name}`);
        }
      }
      const root = localToShared.get(0);
      if (root === undefined) throw new Error(`${name} has no root`);
      (index[phase] ??= []).push({ name: basename(name, ".tsv"), root });
    }
    const raw = encodeNodes(shared);
    const stem = `policies-${String(shard).padStart(3, "0")}`;
    await Promise.all([
      writeFile(join(target, `${stem}.bin`), gzipSync(raw, { level: 9 })),
      writeFile(join(target, `${stem}.json`), JSON.stringify(index)),
    ]);
    process.stdout.write(`${enemy.key} ${shard + 1}/150\r`);
  }
  process.stdout.write(`${enemy.key}: ${names.length.toLocaleString()} certificates\n`);
}

const routesOnly = process.argv.includes("--routes-only");
if (!routesOnly) await rm(OUTPUT, { recursive: true, force: true });
await mkdir(OUTPUT, { recursive: true });
await writeFile(join(OUTPUT, "manifest.json"), JSON.stringify({
  schema: 2, phases: PHASES, shardSize: SHARD_SIZE,
  enemies: enemies.map(({ key, name, multiplier, komi }) => ({ key, name, multiplier, komi })),
}, null, 2));

// The standalone proof-of-concept player, offered as a download on the
// write-up page. It must come from the same generation as the corpora above.
const standaloneSource = join(DATA, "all-5x5-v1", "merged", "playbook.phase.js");
await mkdir(join(OUTPUT, "downloads"), { recursive: true });
try {
  await Promise.all([
    copyFile(standaloneSource, join(OUTPUT, "downloads", "bruteforcego.js")),
    copyFile(standaloneSource, join(OUTPUT, "downloads", "ipvgo-playbook-standalone.js")),
  ]);
} catch {
  console.warn(`WARNING: ${standaloneSource} is missing; the write-up download will 404 until the merged playbook is rebuilt`);
}
// The combined proof: the neural-stripped playbook plus the deployed small5
// WebGPU model in one script — playbook-first, exact production neural
// decision on any miss. Built by `bun run go:combined:standalone` at the
// repository root from the same certificate generation.
const combinedSource = join(ROOT, "go-ai", "derivatives", "combined-standalone.js");
try {
  await copyFile(combinedSource, join(OUTPUT, "downloads", "combinedgo.js"));
} catch {
  console.warn(`WARNING: ${combinedSource} is missing; run go:playbook:residual, go:playbook:pack, and go:combined:standalone to build the combined download`);
}

for (const enemy of enemies) {
  const target = join(OUTPUT, enemy.key);
  await mkdir(target, { recursive: true });
  await writeRoutes(enemy, target);
  if (!routesOnly) await writePolicies(enemy, target);
}
