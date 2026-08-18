/** Export replay-validated IPvGO certificates as V9.5 actor supervision.
 *
 * The certificate remains the source of truth for the runtime playbook. This
 * sidecar teaches the neural proposal head the same certified Black actions.
 * Raw phases are provenance; the tensor input is the existing exact
 * current-turn opponent-behavior encoding used by production inference.
 */
import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import {
  encodeOpponentTurnBehavior,
  opponentTurnBehavior,
} from "../../shared/strategy/go/opponent.ts";
import {
  legalMoves,
  type GoBoard,
  type GoRewardOpponent,
} from "../../shared/strategy/go/rules.ts";
import { encodedState } from "../../go-ai/teacher/export-v9-advisers.ts";

const SCHEMA = "bitburner-go-exhaustive-proposals-v9.5";
const ORACLE = "bitburner-go-ai-v3.0.1";
const CERTIFICATE_SCHEMA = "ipvgo-seeded-certificate-v6";
const PHASES = 150_000;
const TICK_MS = 200;

const KOMI: Readonly<Record<GoRewardOpponent, number>> = {
  Netburners: 1.5,
  "Slum Snakes": 3.5,
  "The Black Hand": 3.5,
  Tetrads: 5.5,
  Daedalus: 5.5,
  Illuminati: 7.5,
  "????????????": 7.5,
};

export interface PolicyIndexRow {
  opponent: GoRewardOpponent;
  phase: number;
  startBoard: string;
  policy: string;
}

export interface CertificateHeader {
  startPhase: number;
  runtimeUncertaintyTicks: number;
  aiSeedSlipTicks: number;
  playtimeEpoch: number;
  alignmentBoards: number;
  maxRounds: number;
}

export interface CandidateActor {
  stateId: number;
  phase: number;
  round: number;
  state: string;
  behavior: number[];
  elapsed: number;
  moves: number[];
  action: number;
  actionClass: string;
  historyLength: number;
  board: GoBoard;
  history: string[][];
  passes: number;
  opponentSeed: number;
}

interface RootRecord {
  environmentId: string;
  phase: number;
  startBoard: string;
  policy: string;
  header: CertificateHeader;
}

interface Summary {
  schema: number;
  datasetSchema: string;
  authority: string;
  profile: "small5";
  opponent: GoRewardOpponent;
  opponentOracle: string;
  teacher: string;
  teacherSha256: string;
  inputDirectory: string;
  policyIndex: string;
  policyIndexSha256: string;
  certificateSetSha256: string;
  policies: number;
  certificateStates: number;
  actorCandidates: number;
  alignmentStatesExcluded: number;
  terminalStatesExcluded: number;
  duplicateInputs: number;
  conflictingInputsExcluded: number;
  actors: number;
  trainActors: number;
  heldoutActors: number;
  trainRootComponents: number;
  heldoutRootComponents: number;
  output: string;
  outputBytes: number;
  outputSha256: string;
  conflictReport: string;
  indexRemoved: boolean;
  generatedAt: string;
}

function flag(name: string, fallback = ""): string {
  const index = Bun.argv.indexOf(name);
  if (index >= 0) return Bun.argv[index + 1] ?? fallback;
  return Bun.argv.find((value) => value.startsWith(`${name}=`))?.slice(name.length + 1)
    ?? fallback;
}

function hasFlag(name: string): boolean {
  return Bun.argv.includes(name);
}

function sha256(value: Uint8Array | string): string {
  return createHash("sha256").update(value).digest("hex");
}

async function fileSha256(path: string): Promise<string> {
  return sha256(new Uint8Array(await Bun.file(path).arrayBuffer()));
}

function integer(text: string, where: string): number {
  const value = Number(text);
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${where} is not a non-negative integer`);
  return value;
}

export function unpackCertificateBoard(text: string): GoBoard {
  const packed = BigInt(text);
  const rows: string[] = [];
  for (let x = 0; x < 5; x++) {
    let column = "";
    for (let y = 0; y < 5; y++) {
      const code = Number((packed >> BigInt(2 * (x * 5 + y))) & 3n);
      column += code === 1 ? "X" : code === 2 ? "O" : code === 3 ? "#" : ".";
    }
    rows.push(column);
  }
  return { size: 5, rows };
}

export function parseCertifiedAction(text: string): number | "align" | "terminal" {
  const action = text.split("@", 1)[0]!;
  if (action === "pass") return 25;
  if (action === "align" || action === "terminal") return action;
  const match = /^(\d+),(\d+)$/.exec(action);
  if (!match) throw new Error(`invalid certificate action ${text}`);
  const x = integer(match[1]!, `action x in ${text}`);
  const y = integer(match[2]!, `action y in ${text}`);
  if (x >= 5 || y >= 5) throw new Error(`certificate action is outside 5x5: ${text}`);
  return x * 5 + y;
}

export function modelInputKey(state: string, behavior: readonly number[], elapsed: number): Buffer {
  const hash = createHash("sha256");
  hash.update(state);
  hash.update("\0");
  const floats = new Float32Array(behavior);
  hash.update(new Uint8Array(floats.buffer, floats.byteOffset, floats.byteLength));
  const encodedElapsed = Buffer.allocUnsafe(4);
  encodedElapsed.writeUInt32LE(elapsed);
  hash.update(encodedElapsed);
  return hash.digest();
}

class UnionFind {
  readonly parent: number[] = [];
  readonly size: number[] = [];

  add(): number {
    const result = this.parent.length;
    this.parent.push(result);
    this.size.push(1);
    return result;
  }

  find(value: number): number {
    let root = value;
    while (this.parent[root] !== root) root = this.parent[root]!;
    while (this.parent[value] !== value) {
      const next = this.parent[value]!;
      this.parent[value] = root;
      value = next;
    }
    return root;
  }

  union(left: number, right: number): void {
    left = this.find(left);
    right = this.find(right);
    if (left === right) return;
    if (this.size[left]! < this.size[right]!) [left, right] = [right, left];
    this.parent[right] = left;
    this.size[left]! += this.size[right]!;
  }
}

export function parsePolicyIndex(text: string, expectedOpponent?: GoRewardOpponent): PolicyIndexRow[] {
  const lines = text.trimEnd().split("\n");
  const header = lines.shift()?.split("\t") ?? [];
  const column = (name: string) => {
    const found = header.indexOf(name);
    if (found < 0) throw new Error(`policy index lacks ${name}`);
    return found;
  };
  const opponentColumn = column("opponent");
  const phaseColumn = column("phase");
  const boardColumn = column("start_board");
  const policyColumn = column("policy");
  const rows = lines.filter(Boolean).map((line, index): PolicyIndexRow => {
    const fields = line.split("\t");
    const opponent = fields[opponentColumn] as GoRewardOpponent;
    if (!(opponent in KOMI)) throw new Error(`unknown opponent at policy index row ${index + 2}`);
    if (expectedOpponent && opponent !== expectedOpponent) {
      throw new Error(`policy index opponent ${opponent} does not match ${expectedOpponent}`);
    }
    const startBoard = fields[boardColumn]!;
    if (startBoard.length !== 25) throw new Error(`invalid start board at policy index row ${index + 2}`);
    return {
      opponent,
      phase: integer(fields[phaseColumn]!, `phase at policy index row ${index + 2}`),
      startBoard,
      policy: fields[policyColumn]!,
    };
  });
  rows.sort((left, right) => left.phase - right.phase
    || left.startBoard.localeCompare(right.startBoard) || left.policy.localeCompare(right.policy));
  return rows;
}

export async function derivePolicyIndex(
  inputDirectory: string,
  opponent: GoRewardOpponent,
): Promise<{ rows: PolicyIndexRow[]; text: string }> {
  const policyDirectory = join(inputDirectory, "policies");
  const names = (await readdir(policyDirectory))
    .filter((name) => name.endsWith(".tsv"))
    .sort((left, right) => left.localeCompare(right));
  const rows: PolicyIndexRow[] = [];
  for (const policy of names) {
    const path = join(policyDirectory, policy);
    const lines = (await readFile(path, "utf8")).trimEnd().split("\n");
    const header = parseHeader(lines, path);
    const stateHeader = lines.findIndex((line) => line.startsWith("state_id\t"));
    const firstState = stateHeader < 0 ? undefined : lines[stateHeader + 1];
    const fields = firstState?.split("\t") ?? [];
    const startBoard = fields[4] ?? "";
    if (startBoard.length !== 25) {
      throw new Error(`${path} lacks a 5x5 root board`);
    }
    rows.push({ opponent, phase: header.startPhase, startBoard, policy });
  }
  rows.sort((left, right) => left.phase - right.phase
    || left.startBoard.localeCompare(right.startBoard) || left.policy.localeCompare(right.policy));
  const text = ["opponent\tphase\tstart_board\tpolicy",
    ...rows.map((row) => `${row.opponent}\t${row.phase}\t${row.startBoard}\t${row.policy}`),
  ].join("\n") + "\n";
  return { rows, text };
}

function parseHeader(lines: readonly string[], path: string): CertificateHeader {
  if (lines[0] !== `# ${CERTIFICATE_SCHEMA}`) {
    throw new Error(`${path} is not a ${CERTIFICATE_SCHEMA} certificate`);
  }
  const fields = new Map<string, string>();
  for (const line of lines.slice(1, 7)) {
    const [rawName, value] = line.slice(2).split("\t");
    fields.set(rawName!, value!);
  }
  const get = (name: string) => integer(fields.get(name) ?? "", `${name} in ${path}`);
  return {
    startPhase: get("start_phase"),
    runtimeUncertaintyTicks: get("runtime_uncertainty_ticks"),
    aiSeedSlipTicks: get("ai_seed_slip_ticks"),
    playtimeEpoch: get("playtime_epoch"),
    alignmentBoards: get("alignment_boards"),
    maxRounds: get("max_rounds"),
  };
}

export function parseCertificate(
  text: string,
  path: string,
  opponent: GoRewardOpponent,
): { header: CertificateHeader; candidates: CandidateActor[]; states: number; align: number; terminal: number } {
  const lines = text.trimEnd().split("\n");
  const header = parseHeader(lines, path);
  const expected = ["state_id", "phase", "round", "align_credit", "board", "passes", "history", "action", "action_class", "successors"];
  const stateHeader = lines.findIndex((line) => line.startsWith("state_id\t"));
  const columns = stateHeader < 0 ? [] : lines[stateHeader]!.split("\t");
  if (columns.join("\t") !== expected.join("\t")) throw new Error(`${path} has an incompatible state header`);
  const candidates: CandidateActor[] = [];
  let align = 0;
  let terminal = 0;
  let states = 0;
  for (let lineNumber = stateHeader + 1; lineNumber < lines.length; lineNumber++) {
    const line = lines[lineNumber]!;
    if (!line) continue;
    states++;
    const fields = line.split("\t");
    // trimEnd() removes the final tab from terminal rows with no successors.
    if (fields.length === 9) fields.push("");
    if (fields.length !== 10) throw new Error(`${path}:${lineNumber + 1} has ${fields.length} fields`);
    const parsedAction = parseCertifiedAction(fields[7]!);
    if (parsedAction === "align") { align++; continue; }
    if (parsedAction === "terminal") { terminal++; continue; }
    const board: GoBoard = {
      size: 5,
      rows: Array.from({ length: 5 }, (_, x) => fields[4]!.slice(x * 5, x * 5 + 5)),
    };
    const history = fields[6]
      ? fields[6]!.split(",").map(unpackCertificateBoard).map((prior) => [...prior.rows])
      : [];
    const passes = integer(fields[5]!, `passes at ${path}:${lineNumber + 1}`);
    const phase = integer(fields[1]!, `phase at ${path}:${lineNumber + 1}`);
    const elapsed = Math.floor(history.length / 2);
    const moves = [
      ...legalMoves(board, "X", history).map(([x, y]) => x * 5 + y),
      25,
    ];
    if (!moves.includes(parsedAction)) {
      throw new Error(`${path}:${lineNumber + 1} certifies illegal action ${fields[7]}`);
    }
    // A fresh WHRNG is constructed after White's first engine cycle. Runtime
    // completion uncertainty changes the successor phase, not this reply seed.
    // aiSeedSlipTicks>0 represents more than one exact behavior input; emit
    // one actor for each certified seed in that bounded window.
    for (let slip = 0; slip <= header.aiSeedSlipTicks; slip++) {
      const unwrappedAiPhase = phase + 1 + slip;
      const aiPhase = unwrappedAiPhase % PHASES;
      const aiEpoch = header.playtimeEpoch + Math.floor(unwrappedAiPhase / PHASES);
      const opponentSeed = (aiEpoch * PHASES + aiPhase) * TICK_MS;
      const behavior = Array.from(encodeOpponentTurnBehavior(
        opponentTurnBehavior(opponent, opponentSeed), KOMI[opponent],
      ));
      const state = encodedState(board, history, passes, false, false);
      candidates.push({
        stateId: integer(fields[0]!, `state id at ${path}:${lineNumber + 1}`),
        phase,
        round: integer(fields[2]!, `round at ${path}:${lineNumber + 1}`),
        state,
        behavior,
        elapsed,
        moves,
        action: parsedAction,
        actionClass: fields[8]!,
        historyLength: history.length,
        board,
        history,
        passes,
        opponentSeed,
      });
    }
  }
  return { header, candidates, states, align, terminal };
}

function episodeFor(split: "train" | "heldout", ordinal: number): number {
  return split === "heldout" ? ordinal * 10 : Math.floor(ordinal / 9) * 10 + ordinal % 9 + 1;
}

async function gzipDeterministic(input: string, output: string): Promise<void> {
  const process = Bun.spawn(["gzip", "-n", "-9", "-c", input], {
    stdout: Bun.file(output), stderr: "pipe",
  });
  const [exitCode, stderr] = await Promise.all([process.exited, new Response(process.stderr).text()]);
  if (exitCode !== 0) throw new Error(stderr || `gzip exited ${exitCode}`);
}

async function main(): Promise<void> {
  const inputDirectory = resolve(flag("--input-dir"));
  const output = resolve(flag("--out"));
  const teacher = resolve(flag("--teacher"));
  const requestedOpponent = flag("--opponent") as GoRewardOpponent;
  if (!flag("--input-dir") || !flag("--out") || !flag("--teacher")) {
    throw new Error("--input-dir, --out, and --teacher are required");
  }
  if (requestedOpponent && !(requestedOpponent in KOMI)) throw new Error(`unknown --opponent ${requestedOpponent}`);
  if (await Bun.file(output).exists()) throw new Error(`refusing to overwrite ${output}`);
  const summaryPath = flag("--summary", `${output}.summary.json`);
  const conflictPath = flag("--conflicts", `${output}.conflicts.tsv`);
  const indexPath = flag("--index", `${output}.index.sqlite`);
  for (const path of [summaryPath, conflictPath, indexPath]) {
    if (await Bun.file(path).exists()) throw new Error(`refusing to overwrite ${path}`);
  }
  await mkdir(dirname(output), { recursive: true });

  const policyIndexPath = hasFlag("--derive-index")
    ? `${join(inputDirectory, "policies")} (derived from certificate headers)`
    : join(inputDirectory, "generated", "policy-index.tsv");
  const derivedIndex = hasFlag("--derive-index")
    ? await derivePolicyIndex(inputDirectory, requestedOpponent)
    : undefined;
  const policyIndexText = derivedIndex?.text ?? await readFile(policyIndexPath, "utf8");
  const policies = derivedIndex?.rows
    ?? parsePolicyIndex(policyIndexText, requestedOpponent || undefined);
  if (!policies.length) throw new Error("policy index contains no certificates");
  const opponent = policies[0]!.opponent;
  if (policies.some((policy) => policy.opponent !== opponent)) throw new Error("mixed opponents are not supported");
  const teacherSha256 = await fileSha256(teacher);
  const database = new Database(indexPath, { create: true, strict: true });
  database.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA temp_store=MEMORY;");
  database.exec(`CREATE TABLE actors (
    key BLOB PRIMARY KEY,
    state TEXT NOT NULL,
    behavior TEXT NOT NULL,
    elapsed INTEGER NOT NULL,
    moves TEXT NOT NULL,
    action INTEGER NOT NULL,
    conflict INTEGER NOT NULL DEFAULT 0,
    root INTEGER NOT NULL,
    phase INTEGER NOT NULL,
    state_id INTEGER NOT NULL,
    round INTEGER NOT NULL,
    action_class TEXT NOT NULL,
    history_length INTEGER NOT NULL,
    occurrences INTEGER NOT NULL DEFAULT 1
  ) WITHOUT ROWID`);
  const insert = database.prepare(`INSERT OR IGNORE INTO actors
    (key,state,behavior,elapsed,moves,action,root,phase,state_id,round,action_class,history_length)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`);
  const existing = database.prepare(`SELECT state,behavior,elapsed,moves,action,root,conflict
    FROM actors WHERE key=?`);
  const update = database.prepare(`UPDATE actors SET occurrences=occurrences+1,
    conflict=CASE WHEN action=? THEN conflict ELSE 1 END WHERE key=?`);
  const union = new UnionFind();
  const roots: RootRecord[] = [];
  let certificateStates = 0;
  let actorCandidates = 0;
  let alignmentStatesExcluded = 0;
  let terminalStatesExcluded = 0;
  let duplicateInputs = 0;
  let conflictsObserved = 0;
  const certificateSetHash = createHash("sha256");

  try {
    for (let policyIndex = 0; policyIndex < policies.length; policyIndex++) {
      const policy = policies[policyIndex]!;
      const path = join(inputDirectory, "policies", policy.policy);
      const certificateText = await readFile(path, "utf8");
      certificateSetHash.update(policy.policy);
      certificateSetHash.update("\0");
      certificateSetHash.update(sha256(certificateText));
      certificateSetHash.update("\n");
      const parsed = parseCertificate(certificateText, path, opponent);
      if (parsed.header.startPhase !== policy.phase) {
        throw new Error(`${path} start phase ${parsed.header.startPhase} != policy index ${policy.phase}`);
      }
      const root = union.add();
      const environmentId = ["ipvgo-certified-v6", opponent, parsed.header.playtimeEpoch,
        policy.phase, policy.startBoard].join(":");
      roots.push({ environmentId, phase: policy.phase, startBoard: policy.startBoard,
        policy: policy.policy, header: parsed.header });
      certificateStates += parsed.states;
      actorCandidates += parsed.candidates.length;
      alignmentStatesExcluded += parsed.align;
      terminalStatesExcluded += parsed.terminal;
      database.exec("BEGIN");
      try {
        for (const actor of parsed.candidates) {
          const key = modelInputKey(actor.state, actor.behavior, actor.elapsed);
          const behavior = JSON.stringify(actor.behavior);
          const moves = JSON.stringify(actor.moves);
          const result = insert.run(key, actor.state, behavior, actor.elapsed, moves,
            actor.action, root, actor.phase, actor.stateId, actor.round,
            actor.actionClass, actor.historyLength);
          if (result.changes === 0) {
            duplicateInputs++;
            const prior = existing.get(key) as {
              state: string; behavior: string; elapsed: number; moves: string;
              action: number; root: number; conflict: number;
            } | null;
            if (!prior || prior.state !== actor.state || prior.behavior !== behavior
                || prior.elapsed !== actor.elapsed || prior.moves !== moves) {
              throw new Error("SHA-256 model-input key collision");
            }
            union.union(prior.root, root);
            if (!prior.conflict && prior.action !== actor.action) conflictsObserved++;
            update.run(actor.action, key);
          }
        }
        database.exec("COMMIT");
      } catch (error) {
        database.exec("ROLLBACK");
        throw error;
      }
      if ((policyIndex + 1) % 100 === 0 || policyIndex + 1 === policies.length) {
        console.error(JSON.stringify({ phase: "certificates", completed: policyIndex + 1,
          total: policies.length, certificateStates, actorCandidates, duplicateInputs,
          conflictsObserved }));
      }
    }

    const componentEnvironments = new Map<number, string[]>();
    for (let index = 0; index < roots.length; index++) {
      const root = union.find(index);
      const environments = componentEnvironments.get(root) ?? [];
      environments.push(roots[index]!.environmentId);
      componentEnvironments.set(root, environments);
    }
    const componentSplits = new Map<number, "train" | "heldout">();
    for (const [root, environments] of componentEnvironments) {
      environments.sort();
      const heldout = Number.parseInt(sha256(environments.join("\n")).slice(0, 8), 16) % 10 === 0;
      componentSplits.set(root, heldout ? "heldout" : "train");
    }
    const conflictWriter = Bun.file(conflictPath).writer();
    conflictWriter.write("key\taction\troot\tphase\tstate_id\toccurrences\n");
    for (const row of database.query(`SELECT hex(key) AS key,action,root,phase,state_id,occurrences
        FROM actors WHERE conflict=1 ORDER BY key`).iterate() as Iterable<Record<string, unknown>>) {
      conflictWriter.write(`${row.key}\t${row.action}\t${row.root}\t${row.phase}\t${row.state_id}\t${row.occurrences}\n`);
    }
    await conflictWriter.end();

    const rawOutput = `${output}.jsonl.partial`;
    const gzipOutput = `${output}.partial`;
    await rm(rawOutput, { force: true });
    await rm(gzipOutput, { force: true });
    const writer = Bun.file(rawOutput).writer();
    let trainOrdinal = 0;
    let heldoutOrdinal = 0;
    let actors = 0;
    try {
      const rows = database.query(`SELECT hex(key) AS key,state,behavior,elapsed,moves,action,root,
        phase,state_id,round,action_class,history_length,occurrences
        FROM actors WHERE conflict=0 ORDER BY key`);
      for (const raw of rows.iterate() as Iterable<Record<string, unknown>>) {
        const rootIndex = Number(raw.root);
        const component = union.find(rootIndex);
        const split = componentSplits.get(component)!;
        const ordinal = split === "heldout" ? heldoutOrdinal++ : trainOrdinal++;
        const episode = episodeFor(split, ordinal);
        const root = roots[rootIndex]!;
        const dispatchPhase = Number(raw.phase);
        const absoluteDispatchPhase = root.header.playtimeEpoch * PHASES + root.phase
          + (dispatchPhase - root.phase + PHASES) % PHASES;
        const record = {
          schema: SCHEMA,
          kind: "actor",
          profile: "small5",
          teacherSha256,
          opponentOracle: ORACLE,
          split,
          example: {
            episode,
            state: raw.state,
            behavior: JSON.parse(String(raw.behavior)),
            elapsed: Number(raw.elapsed),
            moves: JSON.parse(String(raw.moves)),
            action: Number(raw.action),
            actions: [Number(raw.action)],
            // Compatibility with the current trainer's fixed-authority actor
            // bucket. Provenance below retains the stronger exact meaning.
            source: "handcrafted",
          },
          generation: {
            source: "certified-playbook",
            authority: "replay-validated-and-or-certificate-v6",
            opponent,
            environmentId: root.environmentId,
            pairedEnvironmentId: root.environmentId,
            certificate: root.policy,
            certificateStateId: Number(raw.state_id),
            rootPhase: root.phase,
            startBoard: root.startBoard,
            dispatchPhase,
            opponentAiPhase: (dispatchPhase + 1) % PHASES,
            selectedWithoutOutcome: false,
            certifiedAllWhiteOutcomesWin: true,
            certificateActionClass: raw.action_class,
            exactHistoryLength: Number(raw.history_length),
            certificateRound: Number(raw.round),
            equivalentInputOccurrences: Number(raw.occurrences),
            timingModel: {
              runtimeUncertaintyTicks: root.header.runtimeUncertaintyTicks,
              aiSeedSlipTicks: root.header.aiSeedSlipTicks,
              playtimeEpoch: root.header.playtimeEpoch,
              alignmentBoards: root.header.alignmentBoards,
              maxRounds: root.header.maxRounds,
            },
            effectiveSeeds: {
              resetPhase: root.phase,
              dispatchPhase,
              opponentAiSeed: (absoluteDispatchPhase + 1) * TICK_MS,
              playtimeEpoch: root.header.playtimeEpoch,
              defenseSeed: null,
            },
          },
        };
        writer.write(`${JSON.stringify(record)}\n`);
        actors++;
      }
      await writer.end();
      await gzipDeterministic(rawOutput, gzipOutput);
      await rename(gzipOutput, output);
    } finally {
      await rm(rawOutput, { force: true });
      await rm(gzipOutput, { force: true });
    }

    const conflictCount = Number((database.query(
      "SELECT count(*) AS count FROM actors WHERE conflict=1").get() as { count: number }).count);
    const outputFile = Bun.file(output);
    const summary: Summary = {
      schema: 1,
      datasetSchema: SCHEMA,
      authority: "replay-validated-and-or-certificate-v6",
      profile: "small5",
      opponent,
      opponentOracle: ORACLE,
      teacher: teacher,
      teacherSha256,
      inputDirectory,
      policyIndex: policyIndexPath,
      policyIndexSha256: sha256(policyIndexText),
      certificateSetSha256: certificateSetHash.digest("hex"),
      policies: policies.length,
      certificateStates,
      actorCandidates,
      alignmentStatesExcluded,
      terminalStatesExcluded,
      duplicateInputs,
      conflictingInputsExcluded: conflictCount,
      actors,
      trainActors: trainOrdinal,
      heldoutActors: heldoutOrdinal,
      trainRootComponents: [...componentSplits.values()].filter((value) => value === "train").length,
      heldoutRootComponents: [...componentSplits.values()].filter((value) => value === "heldout").length,
      output,
      outputBytes: outputFile.size,
      outputSha256: await fileSha256(output),
      conflictReport: conflictPath,
      indexRemoved: !hasFlag("--keep-index"),
      generatedAt: new Date().toISOString(),
    };
    await writeFile(summaryPath, `${JSON.stringify(summary, null, 2)}\n`);
    console.log(JSON.stringify(summary));
  } finally {
    database.close();
    if (!hasFlag("--keep-index")) {
      await rm(indexPath, { force: true });
      await rm(`${indexPath}-wal`, { force: true });
      await rm(`${indexPath}-shm`, { force: true });
    }
  }
}

if (import.meta.main) await main();
