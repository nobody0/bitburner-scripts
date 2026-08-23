import { mkdtemp, mkdir, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { deflateSync } from "node:zlib";

interface OpponentSpec {
  key: string;
  name: string;
  corpus: string;
  routes: string;
}

interface Route {
  phase: number;
  enemy: number;
  entryPhase: number;
  waits: number;
  power: number;
  turns: number;
}

const ROOT = resolve(import.meta.dir, "../..");
const DATA = join(ROOT, "ipvgobruteforce/data/seeded-phases");
const PHASES = 150_000;
const OPPONENTS: readonly OpponentSpec[] = [
  { key: "netburners", name: "Netburners", corpus: "netburners-5x5-epoch2697-v16-sweep", routes: "root-routes.tsv" },
  { key: "slum-snakes", name: "Slum Snakes", corpus: "slum-snakes-5x5-epoch2697-v16-sweep", routes: "root-routes.tsv" },
  { key: "black-hand", name: "The Black Hand", corpus: "black-hand-5x5-epoch2697-v16-sweep", routes: "root-routes.tsv" },
  { key: "tetrads", name: "Tetrads", corpus: "tetrads-5x5-epoch2697-v16-sweep", routes: "root-routes.tsv" },
  { key: "daedalus", name: "Daedalus", corpus: "daedalus-5x5-epoch2697-v16-sweep", routes: "root-routes.tsv" },
  // A reset is permitted only when every possible random opening stone has a
  // replay-validated certificate at that exact phase.
  { key: "illuminati", name: "Illuminati", corpus: "illuminati-5x5-epoch2697-v16-sweep", routes: "guaranteed-root-routes.tsv" },
] as const;

async function generationCoverage() {
  const corpora: Record<string, {
    certifiedRoots: number;
    unknownRoots: number;
    fullyCertifiedPhases: number;
  }> = {};
  let unknown = 0;
  let certified = 0;
  let powerOptimal = 0;
  for (const spec of OPPONENTS) {
    const path = join(DATA, spec.corpus, "generated/summary.tsv");
    const metrics = Object.fromEntries((await readFile(path, "utf8")).trimEnd().split("\n")
      .slice(1).map((line) => line.split("\t", 2)));
    const expected = Number(metrics.expected_phase_board_roots);
    const certifiedRoots = Number(metrics.certified_phase_board_roots);
    const fullyCertifiedPhases = Number(metrics.fully_certified_phases);
    if (![expected, certifiedRoots, fullyCertifiedPhases].every(Number.isInteger)) {
      throw new Error(`${path} lacks integral generation coverage`);
    }
    const unknownRoots = expected - certifiedRoots;
    corpora[spec.name] = { certifiedRoots, unknownRoots, fullyCertifiedPhases };
    unknown += unknownRoots;
    certified += certifiedRoots;
    powerOptimal += Number(metrics.power_optimal_phase_board_roots ?? 0);
  }
  return {
    exhaustive: unknown === 0,
    optimalityProven: unknown === 0 && powerOptimal === certified,
    unknown,
    corpora,
  };
}

function valueAfter(name: string): string | undefined {
  const index = Bun.argv.indexOf(name);
  if (index >= 0) return Bun.argv[index + 1];
  return Bun.argv.find((argument) => argument.startsWith(`${name}=`))?.slice(name.length + 1);
}

async function readRoutes(spec: OpponentSpec, enemy: number): Promise<Route[]> {
  const path = join(DATA, spec.corpus, "generated", spec.routes);
  const lines = (await readFile(path, "utf8")).trimEnd().split("\n");
  const header = lines.shift()!.split("\t");
  const column = (name: string) => {
    const index = header.indexOf(name);
    if (index < 0) throw new Error(`${path} lacks ${name}`);
    return index;
  };
  const phase = column("phase");
  const entry = column("entry_phase");
  const waits = column("waits");
  const power = column("worst_power");
  const turns = column("worst_turns");
  const result = lines.map((line) => {
    const fields = line.split("\t");
    return {
      phase: Number(fields[phase]),
      enemy,
      entryPhase: Number(fields[entry]),
      waits: Number(fields[waits]),
      power: Number(fields[power]),
      turns: Number(fields[turns]),
    };
  });
  if (result.length !== PHASES || result.some((route, index) => route.phase !== index)) {
    throw new Error(`${path} is not a complete ordered phase route table`);
  }
  return result;
}

function packedValues(values: readonly number[], width: number): Uint8Array {
  const result = new Uint8Array(Math.ceil(values.length * width / 8));
  let bit = 0;
  for (const value of values) {
    if (!Number.isInteger(value) || value < 0 || value >= 2 ** width) {
      throw new Error(`value ${value} exceeds ${width}-bit storage`);
    }
    for (let offset = 0; offset < width; offset++) {
      if (value & (1 << offset)) result[(bit + offset) >> 3] |= 1 << ((bit + offset) & 7);
    }
    bit += width;
  }
  return result;
}

function base64Expression(bytes: Uint8Array): string {
  const encoded = Buffer.from(bytes).toString("base64");
  const chunks = encoded.match(/.{1,120}/g) ?? [""];
  return chunks.map((chunk, index) => `${index ? "+ " : ""}${JSON.stringify(chunk)}`).join("\n");
}

const BASE91_ALPHABET = Array.from({ length: 94 }, (_, index) =>
  String.fromCharCode(33 + index))
  .filter((character) => character !== '"' && character !== "\\" && character !== "`")
  .join("");

function base91(bytes: Uint8Array): string {
  let output = "";
  let buffer = 0;
  let bits = 0;
  for (const byte of bytes) {
    buffer = (buffer | (byte << bits)) >>> 0;
    bits += 8;
    if (bits <= 13) continue;
    let value = buffer & 8191;
    if (value > 88) {
      buffer >>>= 13;
      bits -= 13;
    } else {
      value = buffer & 16383;
      buffer >>>= 14;
      bits -= 14;
    }
    output += BASE91_ALPHABET[value % 91]! + BASE91_ALPHABET[Math.floor(value / 91)]!;
  }
  if (bits > 0) {
    output += BASE91_ALPHABET[buffer % 91]!;
    if (bits > 7 || buffer > 90) output += BASE91_ALPHABET[Math.floor(buffer / 91)]!;
  }
  if (output.includes("undefined")) throw new Error("Base91 encoder produced an invalid digit");
  return output;
}

function stringExpression(value: string): string {
  const chunks = value.match(/.{1,120}/g) ?? [""];
  return chunks.map((chunk, index) => `${index ? "+ " : ""}${JSON.stringify(chunk)}`).join("\n");
}

function compressDataTables(source: string): { source: string; packedBytes: number } {
  const pattern = /const (\w+) = (decodeBytes|decodeU32|decodeRouteBytes)\(\s*([\s\S]*?)\);/g;
  const parts: Uint8Array[] = [];
  let packedLength = 0;
  const transformed = source.replace(pattern, (_match, name: string, decoder: string, expression: string) => {
    const encoded = [...expression.matchAll(/"([A-Za-z0-9+/=]*)"/g)]
      .map((match) => match[1]!)
      .join("");
    const bytes = Buffer.from(encoded, "base64");
    if (decoder === "decodeU32" && (packedLength & 3) !== 0) {
      const padding = 4 - (packedLength & 3);
      parts.push(new Uint8Array(padding));
      packedLength += padding;
    }
    parts.push(bytes);
    packedLength += bytes.length;
    return `const ${name} = ${decoder === "decodeU32" ? "takePackedU32" : "takePackedBytes"}(${bytes.length});`;
  });
  const raw = Buffer.concat(parts, packedLength);
  const compressed = deflateSync(raw, { level: 9 });
  const encoded = base91(compressed);
  const loader = `const PACKED_BYTES = ${raw.length};
const BASE91 = ${JSON.stringify(BASE91_ALPHABET)};

function decodeBase91(encoded) {
  const result = [];
  let value = -1;
  let buffer = 0;
  let bits = 0;
  for (const character of encoded) {
    const digit = BASE91.indexOf(character);
    if (digit < 0) throw new Error("invalid packed playbook character");
    if (value < 0) {
      value = digit;
      continue;
    }
    value += digit * 91;
    buffer |= value << bits;
    bits += (value & 8191) > 88 ? 13 : 14;
    while (bits > 7) {
      result.push(buffer & 255);
      buffer >>>= 8;
      bits -= 8;
    }
    value = -1;
  }
  if (value >= 0) result.push((buffer | (value << bits)) & 255);
  return Uint8Array.from(result);
}

async function inflatePlaybook(encoded) {
  const compressed = decodeBase91(encoded);
  const stream = new Blob([compressed]).stream().pipeThrough(new DecompressionStream("deflate"));
  const result = new Uint8Array(await new Response(stream).arrayBuffer());
  if (result.length !== PACKED_BYTES) throw new Error("corrupt packed playbook");
  return result;
}

const packedData = await inflatePlaybook(packedSource());
let packedCursor = 0;

function takePackedBytes(length) {
  const result = packedData.subarray(packedCursor, packedCursor + length);
  packedCursor += length;
  return result;
}

function takePackedU32(length) {
  packedCursor = (packedCursor + 3) & ~3;
  const result = new Uint32Array(packedData.buffer, packedData.byteOffset + packedCursor, length / 4);
  packedCursor += length;
  return result;
}

`;
  const readable = transformed.replace(
      "// Runtime code is deliberately formatted; only the certificate tables are opaque.\n",
      () => "// Runtime code is deliberately formatted; only the compressed certificate blob is opaque.\n" + loader,
    );
  const packedTail = `
// Packed certificate data is deliberately last so the standalone player
// remains readable at the top of the file and in GitHub's Gist preview.
function packedSource() {
  return ${stringExpression(encoded)};
}
`;
  return {
    source: readable + packedTail,
    packedBytes: raw.length,
  };
}

function policyPhase(filename: string): number | undefined {
  const match = /^(\d+)(?:-h\d+)?\.tsv$/.exec(filename);
  return match ? Number(match[1]) : undefined;
}

async function runPacker(
  packer: string,
  spec: OpponentSpec,
  selected: ReadonlySet<number>,
  temporary: string,
  neuralMatches?: string,
): Promise<{
  source: string;
  collisionReport: string;
  summary: string;
  policies: number;
  expectedRates: Map<number, number>;
}> {
  const input = join(temporary, `${spec.key}-input`);
  const policies = join(input, "policies");
  const output = join(temporary, `${spec.key}-output`);
  await mkdir(policies, { recursive: true });
  await mkdir(output, { recursive: true });
  const sourceDirectory = join(DATA, spec.corpus, "policies");
  let linked = 0;
  let schemaChecked = false;
  const found = new Set<number>();
  for (const filename of await readdir(sourceDirectory)) {
    const phase = policyPhase(filename);
    if (phase === undefined || !selected.has(phase)) continue;
    if (!schemaChecked) {
      const certificate = await readFile(join(sourceDirectory, filename), "utf8");
      if (!certificate.startsWith("# ipvgo-seeded-certificate-v6\n")) {
        throw new Error(`${spec.name} corpus ${spec.corpus} uses a retired certificate schema; `
          + "regenerate it with ipvgo_seeded_batch before building a combined playbook");
      }
      schemaChecked = true;
    }
    await symlink(join(sourceDirectory, filename), join(policies, filename));
    found.add(phase);
    linked++;
  }
  for (const phase of selected) {
    if (!found.has(phase)) throw new Error(`${spec.name} selected phase ${phase} has no policy`);
  }
  const paths = {
    binary: join(output, "playbook.bin"),
    typescript: join(output, "playbook.ts"),
    javascript: join(output, "playbook.js"),
    phaseJavascript: join(output, "playbook.phase.js"),
    collisions: join(output, "phase-collisions.tsv"),
    routes: join(output, "root-routes.tsv"),
    quality: join(output, "policy-quality.tsv"),
  };
  const arguments_ = [
    packer,
    "--input-dir", input,
    "--enemy", spec.name,
    "--binary", paths.binary,
    "--typescript", paths.typescript,
    "--javascript", paths.javascript,
    "--phase-javascript", paths.phaseJavascript,
    "--collision-report", paths.collisions,
    "--root-routes", paths.routes,
    "--quality", paths.quality,
  ];
  if (neuralMatches) arguments_.push("--neural-matches", neuralMatches);
  const process = Bun.spawn(arguments_, { stdout: "pipe", stderr: "pipe" });
  const [exitCode, stdout, stderr] = await Promise.all([
    process.exited,
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
  ]);
  if (exitCode !== 0) throw new Error(`${spec.name} pack failed: ${stderr || stdout}`);
  const routeLines = (await readFile(paths.routes, "utf8")).trimEnd().split("\n");
  const routeHeader = routeLines.shift()!.split("\t");
  const entryColumn = routeHeader.indexOf("entry_phase");
  const expectedColumn = routeHeader.indexOf("entered_route_power_per_turn");
  if (entryColumn < 0 || expectedColumn < 0) {
    throw new Error(`${spec.name} packed routes lack entered-route quality`);
  }
  const expectedRates = new Map<number, number>();
  for (const line of routeLines) {
    const fields = line.split("\t");
    const phase = Number(fields[entryColumn]);
    const rate = Number(fields[expectedColumn]);
    const previous = expectedRates.get(phase);
    if (previous !== undefined && Math.abs(previous - rate) > 1e-9) {
      throw new Error(`${spec.name} entry phase ${phase} has inconsistent route quality`);
    }
    expectedRates.set(phase, rate);
  }
  return {
    source: await readFile(paths.phaseJavascript, "utf8"),
    collisionReport: await readFile(paths.collisions, "utf8"),
    summary: stdout.trim(),
    policies: linked,
    expectedRates,
  };
}

function bookExpression(source: string, enemy: string): string {
  const exportStart = source.indexOf("\nexport {\n");
  if (exportStart < 0) throw new Error("generated playbook lacks export block");
  let body = source.slice(0, exportStart)
    .replace('const ENEMY = "Netburners";', `const ENEMY = ${JSON.stringify(enemy)};`);
  const standaloneStart = body.indexOf("\nasync function dodgeEnemy");
  if (standaloneStart >= 0) body = body.slice(0, standaloneStart);
  return `(() => {\n${body}\nreturn {\n`
    + "  PLAYBOOK_SCHEMA, ENEMY, BOARD_SIZE, PHASES, MISS, CHECK_PROGRAMS,\n"
    + "  MAX_CHECK_STATES, MAX_CHECK_PROBES, MODEL_RUNTIME_TICKS, MODEL_AI_SEED_SLIP,\n"
    + "  MODEL_PLAYTIME_EPOCH, MODEL_ALIGNMENT_BOARDS, MODEL_MAX_ROUNDS, phaseNow, stateHash, lookupHashed,\n"
    + "  lookupMove, describeMove, rootEntryPhase, rootWaits,\n"
    + "};\n})()";
}

function mergedSource(
  routes: readonly Route[],
  books: readonly string[],
  illuminatiRoutes: readonly Route[],
  automaticOrder: readonly number[],
  expectedRates: readonly ReadonlyMap<number, number>[],
): string {
  const runEnds: number[] = [];
  const runEntries: number[] = [];
  const runEnemies: number[] = [];
  for (let begin = 0; begin < routes.length;) {
    const route = routes[begin]!;
    let end = begin + 1;
    while (end < routes.length
      && routes[end]!.enemy === route.enemy
      && routes[end]!.entryPhase === route.entryPhase) end++;
    runEnds.push(end);
    runEntries.push(route.entryPhase);
    runEnemies.push(route.enemy);
    begin = end;
  }
  const names = OPPONENTS.map((opponent) => opponent.name);
  const qualityOffsets = [0];
  const qualityPhases: number[] = [];
  const qualityRates: number[] = [];
  for (const rates of expectedRates) {
    for (const [phase, rate] of [...rates].sort((left, right) => left[0] - right[0])) {
      qualityPhases.push(phase);
      qualityRates.push(Math.min(65_535, Math.max(0, Math.round(rate * 2_048))));
    }
    qualityOffsets.push(qualityPhases.length);
  }
  const illuminatiRunEnds: number[] = [];
  const illuminatiRunEntries: number[] = [];
  for (let begin = 0; begin < illuminatiRoutes.length;) {
    const route = illuminatiRoutes[begin]!;
    let end = begin + 1;
    while (end < illuminatiRoutes.length
      && illuminatiRoutes[end]!.entryPhase === route.entryPhase) end++;
    illuminatiRunEnds.push(end);
    illuminatiRunEntries.push(route.entryPhase);
    begin = end;
  }
  return `// Generated by ipvgobruteforce/arena/build-multi.ts. Exact multi-opponent 5x5 playbook.
// Runtime code is deliberately formatted; only the certificate tables are opaque.
function decodeRouteBytes(encoded) {
  const binary = atob(encoded);
  const result = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) result[index] = binary.charCodeAt(index);
  return result;
}

function routePackedValue(array, index, width) {
  const bit = index * width;
  const byte = bit >> 3;
  const shift = bit & 7;
  const word = array[byte]
    | ((array[byte + 1] || 0) << 8)
    | ((array[byte + 2] || 0) << 16)
    | ((array[byte + 3] || 0) << 24);
  return (word >>> shift) & ((1 << width) - 1);
}

const PLAYBOOK_SCHEMA = 5;
const BOARD_SIZE = 5;
const PHASES = 150000;
const MISS = -1;
const BOARD_START_DEADLINE_MS = 50;
// Realm timer: unlike ns.sleep, this never acquires Bitburner's per-script
// Netscript concurrency lock. The standalone playbook has concurrent async
// arms, so an ns call made while ns.sleep is pending can kill the script.
function realmSleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
const OPPONENTS = Object.freeze(${JSON.stringify(names)});
const AUTOMATIC_ORDER = Object.freeze(${JSON.stringify(automaticOrder)});
const QUALITY_OFFSETS = Object.freeze(${JSON.stringify(qualityOffsets)});
const qualityPhases = decodeRouteBytes(
${base64Expression(packedValues(qualityPhases, 18))}
);
const qualityRates = decodeRouteBytes(
${base64Expression(packedValues(qualityRates, 16))}
);
const ROUTE_RUNS = ${runEnds.length};
const routeRunEnds = decodeRouteBytes(
${base64Expression(packedValues(runEnds, 18))}
);
const routeRunEntries = decodeRouteBytes(
${base64Expression(packedValues(runEntries, 18))}
);
const routeRunEnemies = decodeRouteBytes(
${base64Expression(packedValues(runEnemies, 3))}
);
const ILLUMINATI_ROUTE_RUNS = ${illuminatiRunEnds.length};
const illuminatiRouteRunEnds = decodeRouteBytes(
${base64Expression(packedValues(illuminatiRunEnds, 18))}
);
const illuminatiRouteRunEntries = decodeRouteBytes(
${base64Expression(packedValues(illuminatiRunEntries, 18))}
);
const books = Object.freeze({
${OPPONENTS.map((opponent, index) => `  ${JSON.stringify(opponent.name)}: ${bookExpression(books[index]!, opponent.name)},`).join("\n")}
});

function normalizePhase(phase) {
  return ((phase % PHASES) + PHASES) % PHASES;
}

function phaseNow(milliseconds) {
  return Math.floor((((milliseconds % 30000000) + 30000000) % 30000000) / 200);
}

function playtimeEpoch(milliseconds) {
  return Math.floor(milliseconds / 30000000);
}

function phaseSeed(epoch, phase) {
  return ((epoch * 30000000 + normalizePhase(phase) * 200) / 1000) % 30000;
}

function sameModelSeedClass(enemy, actualEpoch) {
  const model = modelFor(enemy);
  if (!model) return false;
  for (let phase = 0; phase < PHASES; phase++) {
    if (phaseSeed(model.playtimeEpoch, phase) !== phaseSeed(actualEpoch, phase)) return false;
  }
  return true;
}

function requireModelSeed(enemy, actualEpoch, phase) {
  const model = modelFor(enemy);
  if (!model || phaseSeed(model.playtimeEpoch, phase) !== phaseSeed(actualEpoch, phase)) {
    throw new Error("playbook seed class mismatch: " + enemy + " model-epoch="
      + (model?.playtimeEpoch ?? "missing") + " live-epoch=" + actualEpoch
      + " phase=" + normalizePhase(phase));
  }
}

function clockStamp(ns) {
  const milliseconds = ns.getPlayer().totalPlaytime;
  const within = ((milliseconds % 200) + 200) % 200;
  return "t=" + Math.floor(milliseconds) + " p=" + phaseNow(milliseconds)
    + "+" + within.toFixed(1);
}

function selectRoot(phase, requestedEnemy) {
  phase = normalizePhase(phase);
  if (requestedEnemy) {
    const book = books[requestedEnemy];
    if (!book) throw new Error("unknown IPvGO opponent " + requestedEnemy);
    let entryPhase;
    if (requestedEnemy === "Illuminati") {
      let low = 0;
      let high = ILLUMINATI_ROUTE_RUNS - 1;
      while (low <= high) {
        const middle = (low + high) >>> 1;
        if (phase >= routePackedValue(illuminatiRouteRunEnds, middle, 18)) low = middle + 1;
        else high = middle - 1;
      }
      entryPhase = low < ILLUMINATI_ROUTE_RUNS
        ? routePackedValue(illuminatiRouteRunEntries, low, 18)
        : MISS;
    } else {
      entryPhase = book.rootEntryPhase(phase);
    }
    return {
      enemy: requestedEnemy,
      entryPhase,
      waits: (entryPhase - phase + PHASES) % PHASES,
      expectedPowerPerTurn: entryExpectedPowerPerTurn(requestedEnemy, entryPhase),
    };
  }
  let low = 0;
  let high = ROUTE_RUNS - 1;
  while (low <= high) {
    const middle = (low + high) >>> 1;
    if (phase >= routePackedValue(routeRunEnds, middle, 18)) low = middle + 1;
    else high = middle - 1;
  }
  if (low >= ROUTE_RUNS) return { enemy: undefined, entryPhase: MISS, waits: MISS };
  const entryPhase = routePackedValue(routeRunEntries, low, 18);
  return {
    enemy: OPPONENTS[routePackedValue(routeRunEnemies, low, 3)],
    entryPhase,
    waits: (entryPhase - phase + PHASES) % PHASES,
    expectedPowerPerTurn: entryExpectedPowerPerTurn(
      OPPONENTS[routePackedValue(routeRunEnemies, low, 3)], entryPhase),
  };
}

function entryExpectedPowerPerTurn(enemy, phase) {
  const enemyIndex = OPPONENTS.indexOf(enemy);
  if (enemyIndex < 0) return undefined;
  let low = QUALITY_OFFSETS[enemyIndex];
  let high = QUALITY_OFFSETS[enemyIndex + 1] - 1;
  while (low <= high) {
    const middle = (low + high) >>> 1;
    const candidate = routePackedValue(qualityPhases, middle, 18);
    if (candidate < phase) low = middle + 1;
    else if (candidate > phase) high = middle - 1;
    else return routePackedValue(qualityRates, middle, 16) / 2_048;
  }
  return undefined;
}

function modelFor(enemy) {
  const book = books[enemy];
  return book ? {
    runtimeTicks: book.MODEL_RUNTIME_TICKS,
    aiSeedSlip: book.MODEL_AI_SEED_SLIP,
    playtimeEpoch: book.MODEL_PLAYTIME_EPOCH ?? 0,
    alignmentBoards: book.MODEL_ALIGNMENT_BOARDS,
    maximumProofRounds: book.MODEL_MAX_ROUNDS,
  } : undefined;
}

function lookupHashed(enemy, phase, hash) {
  return books[enemy]?.lookupHashed(phase, hash) ?? MISS;
}

function lookupMove(enemy, phase, board, passes = 0, credit = 0, history = []) {
  return books[enemy]?.lookupMove(phase, board, passes, credit, history) ?? MISS;
}

function describeMove(move) {
  return books[OPPONENTS[0]].describeMove(move);
}

function packBoard(columns) {
  if (columns.length !== 5 || columns.some((column) => column.length !== 5)) {
    throw new Error("expected a 5x5 IPvGO board");
  }
  let packed = 0n;
  for (let x = 0; x < 5; x++) for (let y = 0; y < 5; y++) {
    const cell = columns[x][y];
    const value = cell === "X" ? 1n : cell === "O" ? 2n : cell === "#" ? 3n : 0n;
    packed |= value << BigInt(2 * (x * 5 + y));
  }
  return packed;
}

function samePackedHistory(left, right) {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function certifiedAction(enemy, actualPhase, bonusCycles, board, passes, credit, history) {
  const phases = bonusCycles > 0
    ? [actualPhase, (actualPhase - 1 + PHASES) % PHASES]
    : [actualPhase];
  // In normal timing, only credits at or below the live tracked credit are
  // physically realizable: an entry proved with more remaining alignment
  // control assumes deterministic White timing this game cannot deliver, and
  // following it can strand the game off-certificate mid-board.
  //
  // Under bonus cycles the roles invert. Accelerated dispatch is aligned just
  // after the rollover by construction and every turn re-synchronizes by
  // exact state, so the certificate's alignment-credit key is proof
  // bookkeeping for the *normal-timing* line, not a live constraint: the
  // recorded action depends only on the board and the phase seed. Searching
  // the full credit range is what lets resynchronization land on states the
  // certificate reached through an ALIGN the accelerated game never played.
  // The returned credit stays capped at the physically tracked value so a
  // game that outlives its bonus time cannot claim unearned timing control.
  const maximumCredit = bonusCycles > 0
    ? modelFor(enemy).alignmentBoards
    : credit;
  for (const modelPhase of phases) {
    for (let matchedCredit = maximumCredit; matchedCredit >= 0; matchedCredit--) {
      const packed = lookupMove(enemy, modelPhase, board, passes, matchedCredit, history);
      if (packed === MISS) continue;
      const action = describeMove(packed);
      const acceleratedMove = bonusCycles > 0
        && (action.kind === "move" || action.kind === "pass");
      // A q-1 certificate can dispatch an accelerated move at actual q because
      // White's immediate seed is exactly the certificate's q. Internal waits
      // cannot be executed retroactively, so accept those only at actual q.
      if (modelPhase !== actualPhase && !acceleratedMove) continue;
      return {
        action,
        modelPhase,
        alignmentCredit: Math.min(matchedCredit, credit),
        dispatchPhase: acceleratedMove
          ? (modelPhase + 1) % PHASES
          : actualPhase,
      };
    }
  }
}

// Sleep most of the remaining engine cycle in one call, then let the caller
// fine-step across the boundary. The 25 ms guard absorbs timer overshoot so a
// single coarse sleep cannot skip a phase on its own; overshoot detection
// stays with the callers. This replaces polling the whole cycle at 1 ms.
async function sleepTowardPhaseEdge(ns) {
  const within = ((ns.getPlayer().totalPlaytime % 200) + 200) % 200;
  const coarse = 200 - within - 25;
  await realmSleep(coarse >= 5 ? coarse : 1);
}

async function advanceOnePhase(ns) {
  const before = phaseNow(ns.getPlayer().totalPlaytime);
  const target = (before + 1) % PHASES;
  for (;;) {
    await sleepTowardPhaseEdge(ns);
    const current = phaseNow(ns.getPlayer().totalPlaytime);
    if (current === before) continue;
    if (current !== target) {
      throw new Error("phase wait overshot target " + target + " and reached " + current);
    }
    return target;
  }
}

async function waitForPhaseChange(ns) {
  const before = phaseNow(ns.getPlayer().totalPlaytime);
  for (;;) {
    await sleepTowardPhaseEdge(ns);
    const current = phaseNow(ns.getPlayer().totalPlaytime);
    if (current === before) continue;
    return {
      phase: current,
      elapsed: (current - before + PHASES) % PHASES,
    };
  }
}

// Wait toward a known future phase. Far targets sleep whole cycles in one
// call, keeping two phases of slack so browser jitter inside the coarse sleep
// cannot overshoot the target; the caller's reroute logic still handles any
// overshoot that happens regardless.
async function waitTowardPhase(ns, target) {
  const before = phaseNow(ns.getPlayer().totalPlaytime);
  const remaining = (target - before + PHASES) % PHASES;
  if (remaining > 2) await realmSleep((remaining - 2) * 200);
  const step = await waitForPhaseChange(ns);
  return {
    phase: step.phase,
    elapsed: (step.phase - before + PHASES) % PHASES,
  };
}

function activeBoard(ns) {
  const game = ns.go.getGameState();
  if (game.currentPlayer === "None") return undefined;
  const columns = ns.go.getBoardState();
  if (columns.length !== BOARD_SIZE || columns.some((column) => column.length !== BOARD_SIZE)) {
    return undefined;
  }
  const enemy = ns.go.getOpponent();
  if (!OPPONENTS.includes(enemy)) return undefined;
  const history = ns.go.getMoveHistory();
  return {
    enemy,
    signature: enemy + "|" + columns.join("") + "|" + history.length
      + "|" + game.currentPlayer + "|" + String(game.previousMove),
  };
}

function activeRoute(ns, waitTurns, dodges, replaceSignature) {
  const active = activeBoard(ns);
  if (!active || active.signature === replaceSignature) return undefined;
  const phase = phaseNow(ns.getPlayer().totalPlaytime);
  return {
    enemy: active.enemy,
    entryPhase: phase,
    waits: waitTurns,
    dodges,
    resumed: true,
    signature: active.signature,
  };
}

async function beginCommittedGame(ns, requestedEnemy, progress, replaceSignature, telemetry) {
  const existing = activeRoute(ns, 0, 0, replaceSignature);
  if (existing) {
    if (telemetry) telemetry("RESUME", existing.enemy + " " + clockStamp(ns));
    return existing;
  }
  let waitTurns = 0;
  let dodges = 0;
  // Route from the phase we actually occupy. The loop below waits only when
  // the selected board is in the future (or this phase's safe reset window was
  // already missed), so startup does not burn an unconditional dodge turn.
  let phase = phaseNow(ns.getPlayer().totalPlaytime);
  let route = selectRoot(phase, requestedEnemy);
  let target = route.entryPhase;
  if (telemetry) telemetry("ROUTE", route.enemy + " ->" + target + " " + clockStamp(ns));
  for (;;) {
    const resumed = activeRoute(ns, waitTurns, dodges, replaceSignature);
    if (resumed) {
      if (telemetry) telemetry("RESUME", resumed.enemy + " " + clockStamp(ns));
      return resumed;
    }
    const remaining = (target - phase + PHASES) % PHASES;
    if (remaining === 0) {
      const playtime = ns.getPlayer().totalPlaytime;
      const before = phaseNow(playtime);
      const withinPhase = ((playtime % 200) + 200) % 200;
      if (before !== target || withinPhase > BOARD_START_DEADLINE_MS) {
        if (telemetry) telemetry("LATE", "target=" + target + " observed=" + before
          + "+" + withinPhase.toFixed(1));
        // The target exists only prospectively until resetBoardState is called.
        // If browser scheduling consumed the safe opening window, skip it now;
        // creating it and then resetting would forfeit an active game.
        const advanced = await waitForPhaseChange(ns);
        waitTurns += advanced.elapsed;
        dodges += advanced.elapsed;
        phase = advanced.phase;
        route = selectRoot(phase, requestedEnemy);
        target = route.entryPhase;
        if (progress) progress({ ...route, entryPhase: target, waits: waitTurns, dodges,
          remaining: (target - phase + PHASES) % PHASES });
        continue;
      }
      if (telemetry) telemetry("RESET", route.enemy + " target=" + target + " " + clockStamp(ns));
      requireModelSeed(route.enemy, playtimeEpoch(playtime), target);
      ns.go.resetBoardState(route.enemy, BOARD_SIZE);
      const after = phaseNow(ns.getPlayer().totalPlaytime);
      if (after !== target) {
        throw new Error("board creation crossed phase " + target + " and reached " + after);
      }
      const board = packBoard(ns.go.getBoardState());
      const policyEntryPhase = target;
      if (telemetry) {
        const root = lookupMove(route.enemy, policyEntryPhase, board);
        telemetry("CREATED", "board=0x" + board.toString(16)
          + " policy=" + policyEntryPhase
          + " root=" + (root === MISS ? "ALIGN" : describeMove(root).kind)
          + " " + clockStamp(ns));
      }
      return { ...route, waits: waitTurns, dodges, policyEntryPhase };
    }

    // DODGE means reject the prospective time-seeded board before creating it.
    // Never reset an active board here: doing so forfeits that game and breaks
    // the win streak. Far targets sleep in one chunk instead of stepping every
    // 200 ms phase individually.
    const advanced = await waitTowardPhase(ns, target);
    waitTurns += advanced.elapsed;
    dodges += advanced.elapsed;
    phase = advanced.phase;
    // A busy browser may skip several 200 ms phases. Keep the committed target
    // if it is still ahead; if it was skipped, choose a new certified target
    // from the phase that was actually observed.
    if (advanced.elapsed > remaining) {
      if (telemetry) telemetry("OVERSHOOT", "target=" + target + " jumped="
        + advanced.elapsed + " reached=" + phase + " " + clockStamp(ns));
      route = selectRoot(phase, requestedEnemy);
      target = route.entryPhase;
    }
    if (progress) {
      progress({ ...route, entryPhase: target, waits: waitTurns, dodges,
        remaining: (target - phase + PHASES) % PHASES });
    }
  }
}

async function playCommittedGame(ns, route, telemetry) {
  const model = modelFor(route.enemy);
  if (!model) throw new Error("missing model for " + route.enemy);
  const initialGame = ns.go.getGameState();
  let passes = initialGame.previousMove === null && ns.go.getMoveHistory().length > 0 ? 1 : 0;
  let alignmentCredit = 0;
  let turns = route.waits;
  let alignments = 0;

  if (route.policyEntryPhase !== undefined) {
    // The board was created inside the entry phase, so any difference here
    // means a browser hiccup crossed a 200 ms tick after creation and the
    // committed entry state is already unreachable. The old code waited for
    // the 150,000-phase ring to come back around, which froze the script for
    // 8+ hours with no output; fail loudly instead so recovery forfeits and
    // replaces this board.
    const entryGap = (phaseNow(ns.getPlayer().totalPlaytime)
      - route.policyEntryPhase + PHASES) % PHASES;
    if (entryGap !== 0) {
      throw new Error("missed certified entry window: entry=" + route.policyEntryPhase
        + " observed=" + phaseNow(ns.getPlayer().totalPlaytime) + " " + clockStamp(ns));
    }
  }

  let dispatchGuard = 0;
  for (;;) {
    // Certified games end within MODEL max rounds plus dodge/align overhead. A
    // driver or model defect must forfeit with an error, never wedge silently.
    if (++dispatchGuard > model.maximumProofRounds * 8 + 200) {
      throw new Error("game exceeded the certified round budget without ending "
        + clockStamp(ns));
    }
    const game = ns.go.getGameState();
    if (game.currentPlayer === "None") {
      return {
        won: game.blackScore > game.whiteScore,
        blackPower: game.blackScore,
        whitePower: game.whiteScore,
        turns,
        alignments,
      };
    }
    if (game.currentPlayer === "White") {
      await ns.go.opponentNextTurn();
      continue;
    }
    let action;
    let uncertifiedBonusWaits = 0;
    let lookupSpins = 0;
    for (;;) {
      // Every retry path in this loop yields, but none may cycle forever: a
      // browser that overshoots the dispatch phase on every attempt must
      // eventually forfeit with an error instead of wedging silently.
      if (++lookupSpins > 512) {
        throw new Error("could not dispatch a certified action after "
          + lookupSpins + " attempts " + clockStamp(ns));
      }
      const playtime = ns.getPlayer().totalPlaytime;
      let phase = phaseNow(playtime);
      const actualSeedEpoch = playtimeEpoch(playtime)
        + (phase === PHASES - 1 ? 1 : 0);
      requireModelSeed(route.enemy, actualSeedEpoch, phase + 1);
      const board = packBoard(ns.go.getBoardState());
      // Bitburner exposes newest history first; the certificate hashes oldest first.
      const history = ns.go.getMoveHistory().slice().reverse().map(packBoard);
      const snapshot = ns.go.getGameState();
      const certified = certifiedAction(
        route.enemy, phase, snapshot.bonusCycles, board, passes, alignmentCredit, history,
      );
      if (!certified) {
        const score = ns.go.getGameState();
        if (passes === 1 && score.blackScore >= score.whiteScore) {
          // White just passed. Passing now ends the game immediately, so the
          // live score is sufficient proof even if timing left the table.
          action = { kind: "pass" };
        } else if (snapshot.bonusCycles > 0) {
          // Bounded: an accelerated clock that never resynchronizes to a
          // certified state must forfeit with an error, not wait forever.
          if (++uncertifiedBonusWaits > 2048) {
            throw new Error("no certified state after " + uncertifiedBonusWaits
              + " bonus-time waits " + clockStamp(ns));
          }
          lookupSpins = 0;
          const advanced = await waitForPhaseChange(ns);
          turns += advanced.elapsed;
          alignments += advanced.elapsed;
          alignmentCredit = 0;
          if (telemetry) telemetry("BONUS-WAIT", "uncertified exact state " + clockStamp(ns));
          continue;
        } else {
          if (telemetry) telemetry("MISS", "board=0x" + board.toString(16)
            + " h=" + history.length + " pass=" + passes + " bonus=" + snapshot.bonusCycles
            + " " + clockStamp(ns));
          throw new Error("playbook miss: enemy=" + route.enemy + " phase=" + phase
            + " board=0x" + board.toString(16) + " history=" + history.length
            + " passes=" + passes + " credit=" + alignmentCredit
            + " bonus=" + snapshot.bonusCycles);
        }
      } else {
        action = certified.action;
        alignmentCredit = certified.alignmentCredit;
        const remaining = (certified.dispatchPhase - phase + PHASES) % PHASES;
        if (remaining > 0) {
          const advanced = await waitForPhaseChange(ns);
          turns += advanced.elapsed;
          alignments += advanced.elapsed;
          // Preserve the action selected for q only when q+1 was reached
          // exactly. On an overshoot, recompute against the observed phase.
          if (advanced.phase !== certified.dispatchPhase) continue;
          phase = advanced.phase;
        }
      }

      const liveBoard = packBoard(ns.go.getBoardState());
      const liveHistory = ns.go.getMoveHistory().slice().reverse().map(packBoard);
      const liveGame = ns.go.getGameState();
      if (phaseNow(ns.getPlayer().totalPlaytime) !== phase) continue;
      if (liveBoard !== board || !samePackedHistory(liveHistory, history)
          || liveGame.currentPlayer !== "Black" || ns.go.getOpponent() !== route.enemy) {
        throw new Error("CONCURRENT BOARD CHANGE: another script or manual input changed IPvGO");
      }
      break;
    }

    if (action.kind === "align") {
      await advanceOnePhase(ns);
      alignmentCredit = model.alignmentBoards;
      turns++;
      alignments++;
      continue;
    }
    if (action.kind === "sleep") {
      for (let tick = 0; tick < action.variant; tick++) await advanceOnePhase(ns);
      turns += action.variant;
      alignments += action.variant;
      continue;
    }

    if (action.kind === "move") {
      const occupied = (packBoard(ns.go.getBoardState())
        >> BigInt(2 * (action.x * BOARD_SIZE + action.y))) & 3n;
      if (occupied !== 0n) {
        throw new Error("STALE OR COLLIDING PLAYBOOK ACTION: occupied point "
          + action.x + "," + action.y);
      }
    }

    let response;
    const historyBeforeDispatch = ns.go.getMoveHistory().length;
    if (telemetry) telemetry("DISPATCH", action.kind
      + (action.kind === "move" ? " " + action.x + "," + action.y : "")
      + " h=" + historyBeforeDispatch + " " + clockStamp(ns));
    try {
      response = action.kind === "move"
        ? await ns.go.makeMove(action.x, action.y)
        : await ns.go.passTurn();
    } catch (error) {
      const message = String(error);
      if (message.includes("occupied") || message.includes("cannot place")) {
        throw new Error("STALE OR CONCURRENT BOARD CHANGE during dispatch: " + message);
      }
      throw error;
    }
    turns++;
    passes = action.kind === "pass" ? passes + 1 : 0;
    if (alignmentCredit > 0) alignmentCredit--;
    if (response.type === "gameOver") {
      const state = ns.go.getGameState();
      return {
        won: state.blackScore > state.whiteScore,
        blackPower: state.blackScore,
        whitePower: state.whiteScore,
        turns,
        alignments,
      };
    }
    // Derive the pass streak from the board record, not the response type: a
    // White priority move rejected by positional superko is reported as a
    // move but neither changes the board nor counts a pass, and the proof
    // model keys that state with the streak unchanged.
    const whitePlacedStone = ns.go.getMoveHistory().length - historyBeforeDispatch
      - (action.kind === "move" ? 1 : 0) > 0;
    if (whitePlacedStone) passes = 0;
    else if (response.type === "pass") passes += 1;
  }
}

function argumentAfter(args, name) {
  const index = args.indexOf(name);
  if (index >= 0) return args[index + 1];
  const prefix = name + "=";
  return args.find((argument) => argument.startsWith(prefix))?.slice(prefix.length);
}

function showReport(ns, stats, current) {
  const completed = stats.wins + stats.losses;
  ns.clearLog();
  ns.print("IPvGO BRUTE-FORCE 5x5");
  ns.print("PID: " + ns.pid + " | Opponent: " + stats.enemy);
  if (stats.replaced) ns.print("Stopped older copies: " + stats.replaced);
  if (current?.resumed) ns.print("Finishing active board: " + current.enemy);
  else if (current) ns.print("Finding certified board: target " + current.entryPhase
    + " | skipped " + (current.dodges ?? 0)
    + (current.remaining === undefined ? "" : " | remaining " + current.remaining));
  if (current?.expectedPowerPerTurn !== undefined) {
    ns.print("Entered-board expected power / turn: "
      + current.expectedPowerPerTurn.toFixed(3));
  }
  ns.print("Games: " + completed + " | Wins: " + stats.wins + " | Losses: " + stats.losses);
  ns.print("Win rate: " + (completed ? (100 * stats.wins / completed).toFixed(3) : "0.000") + "%");
  ns.print("Power: last " + (completed ? stats.lastPower.toFixed(1) : "-")
    + " | average/game " + (completed ? (stats.power / completed).toFixed(3) : "-"));
  ns.print("Played power / turn: "
    + (stats.playTurns ? (stats.power / stats.playTurns).toFixed(6) : "0.000000"));
  ns.print("Overall power / turn: "
    + (stats.turns ? (stats.power / stats.turns).toFixed(6) : "0.000000")
    + " | DODGEs: " + stats.dodges + " | ALIGNs: " + stats.alignments);
  ns.print("Recoveries: " + stats.recoveries);
  if (stats.lastError) ns.print("LAST ERROR: " + stats.lastError);
  if (stats.trace.length) {
    ns.print("TRACE (newest last):");
    for (const event of stats.trace.slice(-6)) ns.print(event);
  }
}

function addTrace(stats, kind, detail) {
  stats.trace.push(kind + " | " + detail);
  if (stats.trace.length > 12) stats.trace.shift();
}

function parseOpponent(value) {
  if (value === undefined) return undefined;
  if (/^\\d+$/.test(value)) return OPPONENTS[Number(value)];
  const normalized = value.toLowerCase().replace(/[^a-z0-9]/g, "");
  return OPPONENTS.find((enemy) => enemy.toLowerCase().replace(/[^a-z0-9]/g, "") === normalized);
}

export {
  PLAYBOOK_SCHEMA, BOARD_SIZE, PHASES, MISS, OPPONENTS, AUTOMATIC_ORDER, phaseNow, phaseSeed,
  sameModelSeedClass, requireModelSeed, selectRoot, modelFor, lookupHashed,
  lookupMove, describeMove, entryExpectedPowerPerTurn, certifiedAction, advanceOnePhase,
  waitForPhaseChange, activeBoard, beginCommittedGame,
};

/** @param {NS} ns */
export async function main(ns) {
  ns.disableLog("ALL");
  const args = ns.args.map(String);
  const opponentArgument = argumentAfter(args, "--enemy") ?? args[0];
  const automatic = opponentArgument === undefined || opponentArgument.toLowerCase() === "auto";
  const enemy = automatic ? undefined : parseOpponent(opponentArgument);
  const noUi = args.includes("--no-ui");
  const limitText = argumentAfter(args, "--games");
  const gameLimit = limitText === undefined ? Infinity : Math.max(0, Math.floor(Number(limitText)));
  if (!automatic && !enemy) {
    throw new Error("Opponent must be auto, 0..5, or a faction name (" + OPPONENTS.join(", ") + ")");
  }
  const epoch = playtimeEpoch(ns.getPlayer().totalPlaytime);
  const seedEnemies = enemy ? [enemy] : OPPONENTS;
  if (seedEnemies.some((candidate) => !sameModelSeedClass(candidate, epoch)
      || !sameModelSeedClass(candidate, epoch + 1))) {
    throw new Error("No certified WHRNG seed class for live epoch " + epoch);
  }

  // Different arguments normally allow several copies of one script to run.
  // IPvGO has one global board, so the newest same-file process owns it.
  let replaced = 0;
  const host = ns.getHostname();
  for (const process of ns.ps(host)) {
    if (process.pid !== ns.pid && process.filename === ns.getScriptName() && ns.kill(process.pid)) {
      replaced++;
    }
  }
  if (replaced) await realmSleep(1);

  if (!noUi) {
    ns.ui.openTail();
    ns.ui.resizeTail(560, 360);
    ns.ui.setTailTitle("IPvGO 5x5 " + (enemy ? "vs " + enemy : "automatic"));
  }
  const stats = {
    enemy: enemy ?? "Automatic",
    wins: 0,
    losses: 0,
    power: 0,
    lastPower: 0,
    turns: 0,
    playTurns: 0,
    dodges: 0,
    alignments: 0,
    recoveries: 0,
    lastError: "",
    trace: [],
    replaced,
  };
  let completed = 0;
  let replaceActive;
  showReport(ns, stats);
  while (completed < gameLimit) {
    let route;
    try {
      route = await beginCommittedGame(ns, enemy,
        (progress) => showReport(ns, stats, progress), replaceActive,
        (kind, detail) => addTrace(stats, kind, detail));
      replaceActive = undefined;
      if (route.resumed) showReport(ns, stats, route);
      const result = await playCommittedGame(ns, route,
        (kind, detail) => addTrace(stats, kind, detail));
      stats[result.won ? "wins" : "losses"]++;
      stats.power += result.blackPower;
      stats.lastPower = result.blackPower;
      stats.turns += result.turns;
      stats.playTurns += result.turns - route.waits;
      stats.dodges += route.dodges;
      stats.alignments += result.alignments;
      completed++;
      showReport(ns, stats);
    } catch (error) {
      stats.recoveries++;
      const active = activeBoard(ns);
      const historyLength = active ? ns.go.getMoveHistory().length : 0;
      stats.lastError = String(error) + " | live=" + (active?.enemy ?? "none")
        + " phase=" + phaseNow(ns.getPlayer().totalPlaytime)
        + " history=" + historyLength;
      // The ERROR prefix makes Bitburner highlight the line, and the log keeps
      // a durable record even after the tail report is redrawn.
      ns.print("ERROR IPvGO playbook recovery: " + stats.lastError);
      addTrace(stats, "RECOVER", (active ? "forfeit " + active.enemy : "no active board")
        + " h=" + historyLength + " " + clockStamp(ns));
      showReport(ns, stats, route);
      if (active) {
        // Recovery only: this exact live state is absent from the certificate,
        // so the current game cannot be completed by the standalone playbook.
        // Record the forfeit and replace exactly this board at a safe target.
        // Known active states never enter this path and are never regenerated.
        stats.losses++;
        replaceActive = active.signature;
        await realmSleep(1);
        continue;
      }
      // No board to forfeit: back off so a persistent failure (for example a
      // seed-class mismatch) logs one visible error per second instead of
      // busy-spinning the script.
      await realmSleep(1000);
    }
  }
}
`;
}

async function main(): Promise<void> {
  const packer = resolve(valueAfter("--packer") ?? join(ROOT, "ipvgobruteforce/build-arena/ipvgo_seeded_pack"));
  const outputDirectory = resolve(valueAfter("--output-dir")
    ?? join(DATA, "all-5x5-v1", "merged"));
  await mkdir(outputDirectory, { recursive: true });
  const residualDirectory = valueAfter("--residual-matches-dir");
  const writeCollisionAudits = Bun.argv.includes("--collision-audits");
  const generation = await generationCoverage();
  if ((!generation.exhaustive || !generation.optimalityProven)
      && !Bun.argv.includes("--allow-incomplete-generation")) {
    throw new Error("refusing to package an incomplete/non-optimal playbook: "
      + generation.unknown + " generation roots remain UNKNOWN and the first-winning-policy"
      + " search does not prove power/time optimality; pass --allow-incomplete-generation"
      + " only for diagnostics");
  }
  const routeTables = await Promise.all(OPPONENTS.map(readRoutes));
  const enterCounts = routeTables.map((table) => table.reduce(
    (count, route) => count + Number(route.waits === 0), 0,
  ));
  const automaticOrder = OPPONENTS.map((_, enemy) => enemy).sort(
    (left, right) => enterCounts[left]! - enterCounts[right]! || left - right,
  );
  const routes = Array.from({ length: PHASES }, (_, phase) => {
    for (let waits = 0; waits < PHASES; waits++) {
      const candidatePhase = (phase + waits) % PHASES;
      for (const enemy of automaticOrder) {
        const candidate = routeTables[enemy]![candidatePhase]!;
        if (candidate.waits === 0) return {
          ...candidate,
          phase,
          waits,
          turns: candidate.turns + waits,
        };
      }
    }
    throw new Error(`no automatic route from phase ${phase}`);
  });
  const selected = OPPONENTS.map(() => new Set<number>());
  for (const route of routes) {
    selected[route.enemy]!.add(route.entryPhase);
  }
  // A startup opponent parameter must retain that opponent's own optimal route
  // for every phase. Keeping only entries selected by the cross-opponent route
  // silently turned a fixed-enemy run into a sparse, low-power fallback.
  for (let enemy = 0; enemy < OPPONENTS.length; enemy++) {
    for (const route of routeTables[enemy]!) selected[enemy]!.add(route.entryPhase);
  }
  const temporary = await mkdtemp(join(tmpdir(), "ipvgo-multi-pack-"));
  try {
    const packed: Awaited<ReturnType<typeof runPacker>>[] = [];
    for (let enemy = 0; enemy < OPPONENTS.length; enemy++) {
      const spec = OPPONENTS[enemy]!;
      if (selected[enemy]!.size === 0) throw new Error(`${spec.name} has no selected routes`);
      const result = await runPacker(
        packer,
        spec,
        selected[enemy]!,
        temporary,
        residualDirectory ? resolve(residualDirectory, `${spec.key}.matches.tsv`) : undefined,
      );
      packed.push(result);
      console.error(`${spec.name}: ${result.policies} policy files, ${selected[enemy]!.size} phases`);
    }
    const illuminatiIndex = OPPONENTS.findIndex((opponent) => opponent.name === "Illuminati");
    const illuminatiRoutes = routeTables[illuminatiIndex]!;
    const generated = compressDataTables(mergedSource(
      routes,
      packed.map((result) => result.source),
      illuminatiRoutes,
      automaticOrder,
      packed.map((result) => result.expectedRates),
    ));
    const source = generated.source;
    await writeFile(join(outputDirectory, "playbook.phase.js"), source);
    if (writeCollisionAudits) {
      await mkdir(join(outputDirectory, "audits"), { recursive: true });
      for (let enemy = 0; enemy < OPPONENTS.length; enemy++) {
        await writeFile(
          join(outputDirectory, "audits", `${OPPONENTS[enemy]!.key}.phase-collisions.tsv`),
          `enemy\t${packed[enemy]!.collisionReport.replaceAll("\n", `\n${OPPONENTS[enemy]!.name}\t`).slice(0, -(OPPONENTS[enemy]!.name.length + 1))}`,
        );
      }
    }
    const audit = ["phase\tenemy\tentry_phase\twaits\tworst_power\tworst_turns\tpower_per_turn"];
    for (const route of routes) audit.push([
      route.phase,
      OPPONENTS[route.enemy]!.name,
      route.entryPhase,
      route.waits,
      route.power,
      route.turns,
      (route.power / route.turns).toFixed(9),
    ].join("\t"));
    await writeFile(join(outputDirectory, "root-routes.tsv"), `${audit.join("\n")}\n`);
    const sumRates = routes.reduce((sum, route) => sum + route.power / route.turns, 0);
    const sumPower = routes.reduce((sum, route) => sum + route.power, 0);
    const sumTurns = routes.reduce((sum, route) => sum + route.turns, 0);
    const summary = {
      schema: 5,
      generation,
      bytes: Buffer.byteLength(source),
      packedBytes: generated.packedBytes,
      phases: PHASES,
      meanPowerPerTurn: sumRates / PHASES,
      aggregatePowerPerTurn: sumPower / sumTurns,
      opponents: Object.fromEntries(OPPONENTS.map((opponent, enemy) => [opponent.name, {
        immediateEntryPhases: enterCounts[enemy],
        selectedStarts: routes.filter((route) => route.enemy === enemy).length,
        selectedPhases: selected[enemy]!.size,
        policyFiles: packed[enemy]!.policies,
        meanDodges: routeTables[enemy]!.reduce((sum, route) => sum + route.waits, 0) / PHASES,
        maximumDodges: routeTables[enemy]!.reduce(
          (maximum, route) => Math.max(maximum, route.waits), 0,
        ),
        meanPowerPerTurn: routeTables[enemy]!.reduce(
          (sum, route) => sum + route.power / route.turns, 0,
        ) / PHASES,
        aggregatePowerPerTurn: routeTables[enemy]!.reduce(
          (sum, route) => sum + route.power, 0,
        ) / routeTables[enemy]!.reduce((sum, route) => sum + route.turns, 0),
        playedBoardMeanPowerPerTurn: routeTables[enemy]!.filter((route) => route.waits === 0)
          .reduce((sum, route) => sum + route.power / route.turns, 0) / enterCounts[enemy]!,
        playedBoardAggregatePowerPerTurn: routeTables[enemy]!.filter((route) => route.waits === 0)
          .reduce((sum, route) => sum + route.power, 0)
          / routeTables[enemy]!.filter((route) => route.waits === 0)
            .reduce((sum, route) => sum + route.turns, 0),
      }])),
    };
    await writeFile(join(outputDirectory, "summary.json"), `${JSON.stringify(summary, null, 2)}\n`);
    console.log(JSON.stringify(summary, null, 2));
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

if (import.meta.main) await main();
