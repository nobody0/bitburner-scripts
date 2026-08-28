/** Neural-agreement residual matches for the playbook merge/compaction step.
 *
 * For every packable certificate state (move/pass actions, all six production
 * corpora — the exact set `ipvgobruteforce/arena/build-multi.ts` packs), this
 * tool asks whether the deployed neural stack would already play the certified
 * action. Matching entries can be stripped from the merged playbook
 * (`go:bruteforce:pack -- --residual-matches-dir <out>`): the combined
 * playbook-first/neural-fallback runtime reproduces them for free.
 *
 * Two stages keep the full production decision affordable across millions of
 * states:
 *
 * 1. A batched policy screen through the deployed small5 weights (the
 *    derivative's policy tensors are bit-identical to the champion's): the
 *    certified action must be the top-1 policy logit under BOTH proven White
 *    seed ticks `(phase+1)` and `(phase+2)`; the row's margin is the smaller
 *    top-1/top-2 gap. A pass that already ends a won game matches exactly.
 * 2. A browser calibration run replays a reservoir sample of screen matches
 *    through the actual production decision (deep-search finalizer, WebGPU)
 *    at both dispatch ticks, then picks the smallest margin threshold whose
 *    retained sample keeps production agreement at or above
 *    `--deep-agreement` (default 0.995). Only rows at or above that margin
 *    are emitted.
 *
 * Output: `<out>/<key>.matches.tsv` in the packer's exact format plus a
 * `summary.json` manifest with the calibration table. Reads certificates and
 * route tables from `ipvgobruteforce/data/` read-only; never writes there.
 *
 * Usage:
 *   bun run go:playbook:residual [--corpus key]... [--out DIR] [--outcome-prune]
 *     [--calibrate N] [--deep-agreement F] [--margin F] [--device mps|cpu]
 *     [--limit-files N]
 */
import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, rename, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { PythonV9Backend } from "../go-ai/teacher/python-v9-backend.ts";
import { packPlaybookBoard } from "../ipvgobruteforce/arena/playbook.ts";
import {
  boardHash,
  playMove,
  scoreBoard,
  type GoBoard,
  type GoRewardOpponent,
} from "../shared/strategy/go/rules.ts";
import {
  encodeOpponentTurnBehavior,
  opponentTurnBehavior,
} from "../shared/strategy/go/opponent.ts";
import { goBoardWords, goLegalWords, packGoBoard } from "../shared/strategy/go/neural/backend.ts";
import { GO_REWARD_RULES } from "../shared/strategy/go/rewards.ts";
import { SMALL5_GO_MODEL } from "../shared/strategy/go/neural/models/small5.ts";
import { runInHeadlessChrome } from "./webgpu/chrome-runner.ts";

const ROOT = resolve(import.meta.dir, "..");
const DATA = join(ROOT, "ipvgobruteforce", "data", "seeded-phases");
const CHAMPION = join(ROOT, "go-ai", "small5-champion.model");
const BATCH_STATES = 1024;

/** The exact corpora and route tables build-multi packs. */
const SPECS: readonly { key: string; enemy: GoRewardOpponent; corpus: string; routes: string }[] = [
  { key: "netburners", enemy: "Netburners", corpus: "netburners-5x5-epoch2697-v16-sweep", routes: "root-routes.tsv" },
  { key: "slum-snakes", enemy: "Slum Snakes", corpus: "slum-snakes-5x5-epoch2697-v16-sweep", routes: "root-routes.tsv" },
  { key: "black-hand", enemy: "The Black Hand", corpus: "black-hand-5x5-epoch2697-v16-sweep", routes: "root-routes.tsv" },
  { key: "tetrads", enemy: "Tetrads", corpus: "tetrads-5x5-epoch2697-v16-sweep", routes: "root-routes.tsv" },
  { key: "daedalus", enemy: "Daedalus", corpus: "daedalus-5x5-epoch2697-v16-sweep", routes: "root-routes.tsv" },
  { key: "illuminati", enemy: "Illuminati", corpus: "illuminati-5x5-epoch2697-v16-sweep", routes: "guaranteed-root-routes.tsv" },
];

const MATCH_HEADER = "phase\tboard\tpasses\talignment_credit\thistory_hash\thistory_hash2\taction";

function u32(value: number): number { return value >>> 0; }
function rotl(value: number, shift: number): number {
  return u32((value << shift) | (value >>> (32 - shift)));
}

/** Bit-identical to the packer's history_hash32 and the generated runtime. */
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

interface CertificateState {
  phase: number;
  board: GoBoard;
  passes: number;
  credit: number;
  history: bigint[];
  action: number;
  identity: string;
}

function parseAction(text: string): number | undefined {
  const action = text.split("@", 1)[0]!;
  if (action === "pass") return 25;
  const point = /^(\d),(\d)$/.exec(action);
  return point ? Number(point[1]) * 5 + Number(point[2]) : undefined;
}

function parseState(line: string): CertificateState | undefined {
  const fields = line.split("\t");
  if (fields.length === 9) fields.push("");
  if (fields.length !== 10) throw new Error(`invalid certificate row with ${fields.length} fields`);
  const action = parseAction(fields[7]!);
  if (action === undefined) return undefined;
  const board: GoBoard = {
    size: 5,
    rows: Array.from({ length: 5 }, (_, x) => fields[4]!.slice(x * 5, x * 5 + 5)),
  };
  const history = fields[6] ? fields[6].split(",").map((value) => BigInt(value)) : [];
  const phase = Number(fields[1]);
  const passes = Number(fields[5]);
  const credit = Number(fields[3]);
  const identity = `${phase}\t0x${packPlaybookBoard(board.rows).toString(16)}\t${passes}\t${credit}`
    + `\t${historyHash(history)}\t${historyHash(history, 0x7f4a7c15)}`;
  return { phase, board, passes, credit, history, action, identity };
}

/** Skip the variable-length `#` header block. */
function certificateRows(text: string): string[] {
  const lines = text.split("\n");
  let index = 0;
  while (index < lines.length && lines[index]!.startsWith("#")) index++;
  if (!lines[index]?.startsWith("state_id\t")) {
    throw new Error("certificate is missing its state_id column header");
  }
  return lines.slice(index + 1).filter((line) => line.length > 0);
}

async function entryPhases(path: string, enemy?: string): Promise<Set<number>> {
  const lines = (await readFile(path, "utf8")).trimEnd().split("\n");
  const header = lines.shift()!.split("\t");
  const entryColumn = header.indexOf("entry_phase");
  const enemyColumn = header.indexOf("enemy");
  if (entryColumn < 0) throw new Error(`${path} lacks entry_phase`);
  return new Set(lines.map((line) => line.split("\t"))
    .filter((fields) => enemy === undefined || enemyColumn < 0 || fields[enemyColumn] === enemy)
    .map((fields) => Number(fields[entryColumn])));
}

/** Union of the merged router's entry phases for this enemy and the corpus's
 * own route table: build-multi packs both, so omission must cover both. */
async function selectedPhases(spec: (typeof SPECS)[number]): Promise<Set<number>> {
  const merged = await entryPhases(join(DATA, "all-5x5-v1", "merged", "root-routes.tsv"), spec.enemy);
  const own = await entryPhases(join(DATA, spec.corpus, "generated", spec.routes));
  return new Set([...merged, ...own]);
}

function numberFlag(name: string, fallback: number): number {
  const index = Bun.argv.indexOf(name);
  if (index < 0) return fallback;
  const value = Number(Bun.argv[index + 1]);
  if (!Number.isFinite(value)) throw new Error(`${name} requires a number`);
  return value;
}

function stringFlag(name: string, fallback: string): string {
  const index = Bun.argv.indexOf(name);
  if (index < 0) return fallback;
  const value = Bun.argv[index + 1];
  if (!value) throw new Error(`${name} requires a value`);
  return value;
}

interface Stage1Match {
  identity: string;
  action: number;
  margin: number;
}

interface CalibrationState {
  key: string;
  opponent: GoRewardOpponent;
  komi: number;
  phase: number;
  boardRows: string[];
  /** Newest first, matching GoView.previousBoards. */
  previousBoards: string[][];
  passes: number;
  action: number;
  margin: number;
}

const corpusFilters = Bun.argv.flatMap((argument, index) =>
  argument === "--corpus" ? [Bun.argv[index + 1]!] : []);
const outDirectory = resolve(ROOT, stringFlag("--out", "go-ai/derivatives/playbook-residual"));
const calibrateCount = Math.floor(numberFlag("--calibrate", 6000));
const deepAgreement = numberFlag("--deep-agreement", 0.995);
const marginOverride = Bun.argv.includes("--margin") ? numberFlag("--margin", 0) : undefined;
const limitFiles = Math.floor(numberFlag("--limit-files", Number.POSITIVE_INFINITY));
const device = stringFlag("--device", process.env.IPVGO_DEVICE ?? "mps");
/** Skip the outcome stage and emit calibrated policy agreements only. */
const policyOnly = Bun.argv.includes("--policy-only");
/** Default: strip an entry only where the deployed production decision
 * reproduces the certified action exactly at both proven dispatch ticks, so a
 * certified line's guarantee survives stripping. `--outcome-prune` restores
 * the older, more aggressive rollout-based pruning, which measurably breaks
 * guaranteed-win lines and exists only for size experiments. */
const outcomePrune = Bun.argv.includes("--outcome-prune");
/** Independent defense/timing draws each branch must survive. The certificate
 * guarantee is "wins under every draw", so one sample cannot justify a prune. */
const outcomeDraws = Math.max(1, Math.floor(numberFlag("--outcome-draws", 4)));
/** A kept entry must beat the neural branch by winning a game the net loses
 * or by more than this Power-per-turn fraction. */
const powerDrop = numberFlag("--power-drop", 0.05);
const outcomeBatch = Math.max(1, Math.floor(numberFlag("--outcome-batch", 800)));
const maxEvaluations = Math.floor(numberFlag("--max-evaluations", Number.POSITIVE_INFINITY));

const specs = SPECS.filter((spec) => !corpusFilters.length || corpusFilters.includes(spec.key));
if (!specs.length) throw new Error(`--corpus must be one of ${SPECS.map((spec) => spec.key).join(", ")}`);
await mkdir(outDirectory, { recursive: true });

const backend = await PythonV9Backend.create(CHAMPION, device);
const reservoir: CalibrationState[] = [];
let reservoirSeen = 0;
// Deterministic reservoir stream so reruns sample identically.
let reservoirState = 0x9e3779b9;
const reservoirNext = () => {
  reservoirState = u32(Math.imul(reservoirState ^ (reservoirState >>> 15), 0x2c1b3c6d));
  reservoirState = u32(Math.imul(reservoirState ^ (reservoirState >>> 12), 0x297a2d39));
  return (reservoirState ^ (reservoirState >>> 15)) >>> 0;
};

const perCorpus: Record<string, { source: number; screened: Stage1Match[] }> = {};

for (const spec of specs) {
  const phases = await selectedPhases(spec);
  const directory = join(DATA, spec.corpus, "policies");
  const files = (await readdir(directory)).filter((filename) => {
    const match = /^(\d+)(?:-h\d+)?\.tsv$/.exec(filename);
    return match !== null && phases.has(Number(match[1]));
  }).sort().slice(0, limitFiles);
  const seen = new Set<string>();
  const screened: Stage1Match[] = [];
  let source = 0;
  const pending: CertificateState[] = [];

  const offerCalibration = (entry: CertificateState, margin: number) => {
    reservoirSeen++;
    const state: CalibrationState = {
      key: spec.key,
      opponent: spec.enemy,
      komi: GO_REWARD_RULES[spec.enemy].komi,
      phase: entry.phase,
      boardRows: entry.board.rows,
      previousBoards: entry.history.map(unpackBoard).map((board) => board.rows).reverse(),
      passes: entry.passes,
      action: entry.action,
      margin,
    };
    if (reservoir.length < calibrateCount) reservoir.push(state);
    else {
      const slot = reservoirNext() % reservoirSeen;
      if (slot < calibrateCount) reservoir[slot] = state;
    }
  };

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
      const prior = new Set(entry.history.map(unpackBoard).map(boardHash));
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
          opponentTurnBehavior(spec.enemy, (entry.phase + 1 + seed) * 200),
          GO_REWARD_RULES[spec.enemy].komi,
        ), index * backend.behaviorFeatures);
      }
    }
    const proposal = await backend.evaluateProposal({ packed, legal, state, behavior, count });
    for (let item = 0; item < pending.length; item++) {
      const entry = pending[item]!;
      // The certificate proves the action under both White ticks; require the
      // policy to agree under each tick separately, not merely on average.
      let minimumMargin = Number.POSITIVE_INFINITY;
      let agreed = true;
      for (let seed = 0; seed < seedCount && agreed; seed++) {
        let bestAction = -1;
        let bestScore = Number.NEGATIVE_INFINITY;
        let runnerUp = Number.NEGATIVE_INFINITY;
        for (const action of [...legalByState[item]!, 25]) {
          const score = proposal.moves[(item * seedCount + seed) * 26 + action]!;
          if (score > bestScore || (score === bestScore && action < bestAction)) {
            runnerUp = bestScore;
            bestScore = score;
            bestAction = action;
          } else if (score > runnerUp) runnerUp = score;
        }
        if (bestAction !== entry.action) agreed = false;
        else minimumMargin = Math.min(minimumMargin, bestScore - runnerUp);
      }
      if (agreed) {
        screened.push({ identity: entry.identity, action: entry.action, margin: minimumMargin });
        offerCalibration(entry, minimumMargin);
      }
    }
    pending.length = 0;
  };

  for (const filename of files) {
    for (const line of certificateRows(await readFile(join(directory, filename), "utf8"))) {
      const entry = parseState(line);
      if (!entry || seen.has(entry.identity)) continue;
      seen.add(entry.identity);
      source++;
      const score = scoreBoard(entry.board, GO_REWARD_RULES[spec.enemy].komi);
      if (entry.passes > 0 && entry.action === 25 && score.X >= score.O) {
        // A pass that ends a won game: the engine's immediate-decision rule
        // accepts it before any network work, so it matches exactly.
        screened.push({ identity: entry.identity, action: entry.action, margin: Number.POSITIVE_INFINITY });
        continue;
      }
      pending.push(entry);
      if (pending.length >= BATCH_STATES) await flush();
    }
  }
  await flush();
  perCorpus[spec.key] = { source, screened };
  console.log(`${spec.key}: ${source} distinct states, ${screened.length} policy-screen matches`);
}
backend.dispose();

// Stage 2: calibrate the margin threshold against the production decision.
let margin = marginOverride ?? 0;
let calibration: unknown;
if (marginOverride === undefined && policyOnly && reservoir.length) {
  const sample = reservoir.filter((state) => Number.isFinite(state.margin));
  console.log(`calibrating production-decision agreement on ${sample.length} sampled matches`);
  const run = await runInHeadlessChrome(
    join(import.meta.dir, "webgpu", "entry-playbook-deep-check.ts"),
    1_800_000,
    { __goPlaybookDeepCheck: { states: sample } },
  );
  const result = run.result as { ok: boolean; agreements: boolean[]; error?: string };
  if (!result.ok || result.agreements.length !== sample.length) {
    throw new Error(`production-decision calibration failed: ${result.error ?? "incomplete"}`);
  }
  const rows = sample
    .map((state, index) => ({ margin: state.margin, agreed: result.agreements[index]! }))
    .sort((left, right) => left.margin - right.margin);
  let agreedAbove = rows.reduce((sum, row) => sum + (row.agreed ? 1 : 0), 0);
  let countAbove = rows.length;
  let chosen: number | undefined;
  const table: Array<{ margin: number; kept: number; agreement: number }> = [];
  for (let index = 0; index < rows.length; index++) {
    const agreement = agreedAbove / Math.max(1, countAbove);
    if (index % Math.max(1, Math.floor(rows.length / 40)) === 0) {
      table.push({ margin: +rows[index]!.margin.toFixed(4), kept: countAbove,
        agreement: +agreement.toFixed(5) });
    }
    if (chosen === undefined && agreement >= deepAgreement) chosen = rows[index]!.margin;
    if (rows[index]!.agreed) agreedAbove--;
    countAbove--;
  }
  if (chosen === undefined) {
    throw new Error(`no margin threshold reaches ${deepAgreement} production agreement`);
  }
  margin = chosen;
  calibration = { sampled: sample.length, deepAgreement, chosenMargin: +margin.toFixed(6), table };
  console.log(`chosen margin threshold ${margin.toFixed(4)} at >=${deepAgreement} production agreement`);
}

/** Stage 3 (default): outcome-based pruning with cascade reachability.
 *
 * The certificate rows of one corpus form a successor graph. Walking from
 * each file's roots:
 *   - a margin-calibrated policy agreement is stripped and the line continues
 *     (the net reproduces the move, so successors stay reachable);
 *   - any other reachable move/pass state is played out both ways from that
 *     exact state (neural move first versus certified move first, combined
 *     policy afterwards). The entry is kept only when dropping it would turn
 *     a win into a loss or cost more than `--power-drop` Power per turn;
 *     otherwise it is pruned and its whole subtree becomes unreachable;
 *   - align/sleep/terminal rows are pass-through graph links.
 * The emitted omission list is everything except kept-and-reachable states,
 * so unreachable subtrees are pruned without ever being evaluated. */
interface GraphRow {
  id: number;
  operation: "move" | "pass" | "align" | "sleep" | "terminal";
  action: number;
  successors: number[];
  identity?: string;
  entry?: CertificateState;
}

function parseGraphRow(line: string): GraphRow {
  const fields = line.split("\t");
  if (fields.length === 9) fields.push("");
  if (fields.length !== 10) throw new Error(`invalid certificate row with ${fields.length} fields`);
  const id = Number(fields[0]);
  const successors = fields[9] ? fields[9].split(",").map(Number) : [];
  const raw = fields[7]!.split("@", 1)[0]!;
  if (raw === "align") return { id, operation: "align", action: 26, successors };
  if (raw === "terminal") return { id, operation: "terminal", action: 28, successors };
  if (raw.startsWith("sleep")) return { id, operation: "sleep", action: 27, successors };
  const entry = parseState(line);
  if (!entry) throw new Error(`unclassifiable certificate action ${raw}`);
  return {
    id,
    operation: entry.action === 25 ? "pass" : "move",
    action: entry.action,
    successors,
    identity: entry.identity,
    entry,
  };
}

const opponents: Record<string, unknown> = {};
const playbookPath = join(DATA, "all-5x5-v1", "merged", "playbook.phase.js");
let playbookPrelude: string | undefined;
let totalEvaluations = 0;

for (const spec of specs) {
  const { source, screened } = perCorpus[spec.key]!;
  const agreeMargins = new Map<string, number>();
  for (const row of screened) agreeMargins.set(row.identity, row.margin);
  const staged = join(outDirectory, `.${spec.key}.matches.tsv.tmp`);
  const target = join(outDirectory, `${spec.key}.matches.tsv`);

  if (policyOnly) {
    const kept = screened.filter((row) => row.margin >= margin);
    const body = kept.map((row) => `${row.identity}\t${row.action}`).join("\n");
    await writeFile(staged, `${MATCH_HEADER}\n${body}${body ? "\n" : ""}`);
    await rename(staged, target);
    opponents[spec.enemy] = { sourceStates: source, screenMatches: screened.length, emitted: kept.length };
    console.log(`${spec.key}: emitted ${kept.length}/${screened.length} matches at margin >= ${margin.toFixed(4)}`);
    continue;
  }

  playbookPrelude ??= (await import("./go-playbook-inline.ts"))
    .inlinePlaybookScript(await readFile(playbookPath, "utf8"));
  const phases = await selectedPhases(spec);
  const directory = join(DATA, spec.corpus, "policies");
  const files = (await readdir(directory)).filter((filename) => {
    const match = /^(\d+)(?:-h\d+)?\.tsv$/.exec(filename);
    return match !== null && phases.has(Number(match[1]));
  }).sort().slice(0, limitFiles);

  // Parse every file once into successor graphs.
  const graphs: { rows: Map<number, GraphRow>; roots: number[] }[] = [];
  for (const filename of files) {
    const rows = new Map<number, GraphRow>();
    const referenced = new Set<number>();
    for (const line of certificateRows(await readFile(join(directory, filename), "utf8"))) {
      const row = parseGraphRow(line);
      rows.set(row.id, row);
      for (const successor of row.successors) referenced.add(successor);
    }
    const roots = [...rows.keys()].filter((id) => !referenced.has(id));
    graphs.push({ rows, roots });
  }

  // "strip": the production decision reproduces the move, so the line
  // continues through the network. "keep": the certified entry earns its
  // place. "prune": the network's own continuation is good enough, so the
  // entry and its followups go. Only the browser verification below may mark
  // a strip — the policy screen is a prefilter, not a decision.
  const decisions = new Map<string, "strip" | "keep" | "prune">();

  let evaluations = 0;
  /** Entries whose certified branch wins a game the deployed net loses: the
   * win-saving states the playbook exists for. */
  const winSaves: CertificateState[] = [];
  /** States where neither branch wins from here: the highest-value targets
   * for new certificate generation (deeper or corrected lines). */
  const generationPriority: CertificateState[] = [];

  {
    // Line-safe stripping. A certified line is a *chain*: its guarantee holds
    // only while every one of its decisions is reproduced. Dropping an entry
    // because a sampled rollout still won (the outcome mode below) breaks that
    // chain.
    //
    // So an entry is dropped only when the deployed production decision
    // selects the certified action *exactly*, at both proven dispatch ticks.
    // Then the successor state is the certified successor by construction and
    // the rest of the line stays intact, which is why nothing cascades.
    // Unreachable states (no path from any root) are dropped as before.
    const reachable = new Map<string, CertificateState>();
    for (const graph of graphs) {
      const queue = [...graph.roots];
      const seenIds = new Set<number>();
      while (queue.length) {
        const id = queue.pop()!;
        if (seenIds.has(id)) continue;
        seenIds.add(id);
        const row = graph.rows.get(id);
        if (!row) continue;
        // Every certified decision keeps its own successors reachable, whether
        // it is played from the playbook or reproduced by the network.
        queue.push(...row.successors);
        if (row.operation === "move" || row.operation === "pass") {
          reachable.set(row.identity!, row.entry!);
        }
      }
    }
    // Only a state whose raw policy already agrees under both ticks can be
    // reproduced by the production decision often enough to be worth a
    // browser check; a policy disagreement keeps the entry. This prefilter is
    // conservative in the safe direction (it can only retain entries).
    const candidates = [...reachable.values()].filter((entry) => agreeMargins.has(entry.identity));
    console.log(`${spec.key}: ${reachable.size} reachable entries, `
      + `${candidates.length} policy-screened candidates to verify`);
    const verified = new Set<string>();
    for (let offset = 0; offset < candidates.length; offset += outcomeBatch) {
      const batch = candidates.slice(offset, offset + outcomeBatch);
      const run = await runInHeadlessChrome(
        join(import.meta.dir, "webgpu", "entry-playbook-deep-check.ts"),
        Math.max(1_800_000, batch.length * 500),
        { __goPlaybookDeepCheck: { states: batch.map((entry) => ({
          opponent: spec.enemy,
          komi: GO_REWARD_RULES[spec.enemy].komi,
          phase: entry.phase,
          boardRows: entry.board.rows,
          previousBoards: entry.history.map(unpackBoard).map((board) => board.rows).reverse(),
          passes: entry.passes,
          action: entry.action,
        })) } },
      );
      const result = run.result as { ok: boolean; agreements: boolean[]; error?: string };
      if (!result.ok || result.agreements.length !== batch.length) {
        throw new Error(`production verification failed: ${result.error ?? "incomplete"}`);
      }
      batch.forEach((entry, index) => {
        evaluations++;
        totalEvaluations++;
        if (result.agreements[index]) verified.add(entry.identity);
      });
      console.log(`${spec.key}: verified ${Math.min(offset + batch.length, candidates.length)}`
        + `/${candidates.length} (${verified.size} exact reproductions)`);
    }
    for (const identity of verified) decisions.set(identity, "strip");
    if (outcomePrune) {
      // Tier 2, on top of the exact strips: an entry whose action the network
      // does not reproduce is still unnecessary when the plain neural
      // continuation wins anyway and gives up no more than --power-drop of the
      // certified branch's Power per turn. Pruning it makes its followups
      // unreachable, so they are dropped with it.
      //
      // Entries are tested in rounds outward from the roots: a pruned entry
      // ends its line, so its whole subtree is skipped rather than tested.
      // That is what keeps this affordable on a 359k-state corpus.
      playbookPrelude ??= (await import("./go-playbook-inline.ts"))
        .inlinePlaybookScript(await readFile(playbookPath, "utf8"));
      for (let round = 0; ; round++) {
        const frontier = new Map<string, CertificateState>();
        for (const graph of graphs) {
          const queue = [...graph.roots];
          const seenIds = new Set<number>();
          while (queue.length) {
            const id = queue.pop()!;
            if (seenIds.has(id)) continue;
            seenIds.add(id);
            const row = graph.rows.get(id);
            if (!row) continue;
            if (row.operation !== "move" && row.operation !== "pass") {
              queue.push(...row.successors);
              continue;
            }
            const decision = decisions.get(row.identity!);
            if (decision === "prune") continue;
            if (decision === undefined) {
              frontier.set(row.identity!, row.entry!);
              continue;
            }
            queue.push(...row.successors);
          }
        }
        if (!frontier.size) break;
        const states = [...frontier.values()];
        console.log(`${spec.key}: outcome round ${round}, ${states.length} divergence entries `
          + `over up to ${outcomeDraws} draws each (${evaluations} done)`);
        for (let offset = 0; offset < states.length; offset += outcomeBatch) {
          const batch = states.slice(offset, offset + outcomeBatch);
          if (totalEvaluations + batch.length > maxEvaluations) {
            throw new Error(`outcome evaluation budget exceeded at ${totalEvaluations}`);
          }
          const run = await runInHeadlessChrome(
            join(import.meta.dir, "webgpu", "entry-playbook-outcome-check.ts"),
            Math.max(1_800_000, batch.length * outcomeDraws * 3_000),
            { __goPlaybookOutcomeCheck: { draws: outcomeDraws, states: batch.map((entry) => ({
              enemy: spec.enemy,
              komi: GO_REWARD_RULES[spec.enemy].komi,
              phase: entry.phase,
              boardRows: entry.board.rows,
              historyRows: entry.history.map(unpackBoard).map((board) => board.rows),
              passes: entry.passes,
              certAction: entry.action,
              defenseSeed: (historyHash(entry.history) ^ entry.phase) >>> 0,
            })) } },
            [playbookPrelude],
          );
          const result = run.result as {
            ok: boolean;
            results: { neural: { wonAll: boolean; wins: number; meanPowerPerTurn: number };
              cert: { wonAll: boolean; wins: number; meanPowerPerTurn: number };
              neuralAction: number }[];
            error?: string;
          };
          if (!result.ok || result.results.length !== batch.length) {
            throw new Error(`outcome evaluation failed: ${result.error ?? "incomplete"}`);
          }
          batch.forEach((entry, index) => {
            const outcome = result.results[index]!;
            evaluations++;
            totalEvaluations++;
            if (outcome.cert.wonAll && !outcome.neural.wonAll) winSaves.push(entry);
            else if (!outcome.cert.wonAll && !outcome.neural.wonAll) generationPriority.push(entry);
            // Keep only what earns its place: the certified branch wins every
            // draw and the network either loses one or gives up Power per turn.
            const keep = outcome.cert.wonAll
              && (!outcome.neural.wonAll
                || outcome.neural.meanPowerPerTurn
                  < (1 - powerDrop) * outcome.cert.meanPowerPerTurn);
            decisions.set(entry.identity, keep ? "keep" : "prune");
          });
        }
      }
    }

    // Reachability with prunes applied: a pruned entry is a line exit, so its
    // successors are unreachable unless another surviving parent reaches them.
    const keptReachable = new Set<string>();
    for (const graph of graphs) {
      const queue = [...graph.roots];
      const seenIds = new Set<number>();
      while (queue.length) {
        const id = queue.pop()!;
        if (seenIds.has(id)) continue;
        seenIds.add(id);
        const row = graph.rows.get(id);
        if (!row) continue;
        if (row.operation !== "move" && row.operation !== "pass") {
          queue.push(...row.successors);
          continue;
        }
        const decision = decisions.get(row.identity!);
        if (decision === "prune") continue;
        if (decision !== "strip") keptReachable.add(row.identity!);
        queue.push(...row.successors);
      }
    }
    const omitted: string[] = [];
    const emittedIdentities = new Set<string>();
    for (const graph of graphs) {
      for (const row of graph.rows.values()) {
        if (row.operation !== "move" && row.operation !== "pass") continue;
        const identity = row.identity!;
        if (keptReachable.has(identity) || emittedIdentities.has(identity)) continue;
        emittedIdentities.add(identity);
        omitted.push(`${identity}\t${row.action}`);
      }
    }
    const body = omitted.join("\n");
    await writeFile(staged, `${MATCH_HEADER}\n${body}${body ? "\n" : ""}`);
    await rename(staged, target);
    if (outcomePrune) {
      const stateRow = (entry: CertificateState) =>
        `${entry.phase}\t${entry.board.rows.join("")}\t${entry.passes}`
        + `\t${entry.history.map((value) => `0x${value.toString(16)}`).join(",")}`;
      const stateHeader = "phase\tboard\tpasses\thistory\n";
      await writeFile(join(outDirectory, `${spec.key}.win-saves.tsv`),
        stateHeader + winSaves.map(stateRow).join("\n") + (winSaves.length ? "\n" : ""));
      await writeFile(join(outDirectory, `${spec.key}.generation-priority.tsv`),
        stateHeader + generationPriority.map(stateRow).join("\n")
        + (generationPriority.length ? "\n" : ""));
    }
    const counts = { strip: 0, keep: 0, prune: 0 };
    for (const decision of decisions.values()) counts[decision]++;
    opponents[spec.enemy] = {
      sourceStates: source,
      policyScreenMatches: screened.length,
      reachableEntries: reachable.size,
      verifiedCandidates: candidates.length,
      exactReproductions: verified.size,
      ...(outcomePrune ? { outcomeEvaluations: evaluations, outcomeDraws,
        winSaves: winSaves.length, generationPriority: generationPriority.length } : {}),
      decisions: counts,
      keptReachable: keptReachable.size,
      omitted: omitted.length,
    };
    console.log(`${spec.key}: kept ${keptReachable.size} reachable entries `
      + `(${counts.strip} exact reproductions, ${counts.keep} keeps, ${counts.prune} prunes`
      + `${outcomePrune ? `, ${winSaves.length} win-saves, ${generationPriority.length} generation-priority` : ""}); `
      + `omitted ${omitted.length}/${source} states`);
    continue;
  }

}

const artifactSha = createHash("sha256")
  .update(Uint8Array.from(atob(SMALL5_GO_MODEL.weights), (c) => c.charCodeAt(0))).digest("hex");
await writeFile(join(outDirectory, "summary.json"), `${JSON.stringify({
  schema: 4,
  policy: policyOnly
    ? "per-seed top-1 policy screen + production deep-decision margin calibration"
    : outcomePrune
      ? "exact production strip + multi-draw pure-neural outcome pruning with cascade"
      : "line-safe strip: exact production reproduction at both proven ticks, no cascade",
  championModel: existsSync(CHAMPION) ? "go-ai/small5-champion.model" : CHAMPION,
  deployedArtifactPayloadSha256: SMALL5_GO_MODEL.payloadSha256,
  deployedArtifactVerifiedSha256: artifactSha,
  ...(policyOnly ? { marginThreshold: +margin.toFixed(6), calibration: calibration ?? { override: marginOverride } } : {}),
  ...(outcomePrune ? { powerDropFraction: powerDrop, outcomeDraws } : {}),
  ...(policyOnly ? {} : { productionEvaluations: totalEvaluations }),
  opponents,
}, null, 2)}\n`);
console.log(`wrote ${join(outDirectory, "summary.json")}`);
