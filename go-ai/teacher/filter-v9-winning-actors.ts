/** Retain every fixed-teacher outcome route, but remove supervision outside a
 * teacher's authority. Losing routes do not supply positive policy rows, and
 * non-predictive KataGo does not rank opponent-specific post-reply boards. */
import { createHash } from "node:crypto";

interface RecordRow {
  schema?: string;
  profile?: string;
  teacherSha256?: string;
  opponentOracle?: string;
  kind?: string;
  episode?: number;
  values?: Array<{ won?: number }>;
  generation?: { source?: string; mode?: string };
  example?: { episode?: number; source?: string };
}

const FIXED_SOURCES = new Set(["katago", "handcrafted"]);

function flag(name: string): string {
  const index = Bun.argv.indexOf(name);
  const value = index >= 0 ? Bun.argv[index + 1] : undefined;
  if (!value) throw new Error(`missing ${name}`);
  return value;
}

function routeKey(source: string | undefined, episode: number | undefined): string {
  if (!source || episode === undefined) throw new Error("fixed-teacher record lacks route identity");
  return `${source}:${episode}`;
}

const input = flag("--in");
const output = flag("--out");
if (await Bun.file(output).exists()) throw new Error(`output already exists: ${output}`);
const compressed = new Uint8Array(await Bun.file(input).arrayBuffer());
const text = new TextDecoder().decode(Bun.gunzipSync(compressed));
const rows = text.trim().split("\n").filter(Boolean)
  .map((line) => JSON.parse(line) as RecordRow);
const reference = rows[0];
if (!reference) throw new Error("input corpus is empty");
if (rows.some((row) => row.schema !== reference.schema
  || row.profile !== reference.profile
  || row.teacherSha256 !== reference.teacherSha256
  || row.opponentOracle !== reference.opponentOracle)) {
  throw new Error("input corpus mixes incompatible metadata");
}

const fixedRoutes = rows.filter((row) => row.kind === "trajectory"
  && FIXED_SOURCES.has(row.generation?.source ?? ""));
if (!fixedRoutes.length) throw new Error("input corpus has no fixed-teacher trajectories");
const routeKeys = new Set(fixedRoutes.map((row) =>
  routeKey(row.generation?.source, row.episode)));
const winningRoutes = new Set(fixedRoutes
  .filter((row) => row.values?.[0]?.won === 1)
  .map((row) => routeKey(row.generation?.source, row.episode)));

let actorRows = 0;
let retainedActorRows = 0;
let removedActorRows = 0;
let removedUnauthorizedRankingRows = 0;
const filtered = rows.filter((row) => {
  const source = row.example?.source ?? row.generation?.source;
  if (row.kind === "actor") {
    if (!FIXED_SOURCES.has(source ?? "")) return true;
    actorRows++;
    const key = routeKey(source, row.example?.episode);
    if (!routeKeys.has(key)) throw new Error(`actor references missing trajectory ${key}`);
    if (winningRoutes.has(key)) {
      retainedActorRows++;
      return true;
    }
    removedActorRows++;
    return false;
  }
  if (row.kind === "actor-ranking" && source === "katago"
    && row.generation?.mode !== "predictive") {
    removedUnauthorizedRankingRows++;
    return false;
  }
  return true;
});
if (!actorRows) throw new Error("input corpus has no fixed-teacher actor rows");
for (const row of filtered) {
  if (row.kind !== "actor-ranking") continue;
  const source = row.example?.source ?? row.generation?.source;
  if (FIXED_SOURCES.has(source ?? "")
    && !winningRoutes.has(routeKey(source, row.example?.episode))) {
    throw new Error("losing fixed-teacher route contains an actor ranking");
  }
}

const encoded = new TextEncoder().encode(
  `${filtered.map((row) => JSON.stringify(row)).join("\n")}\n`,
);
await Bun.write(output, Bun.gzipSync(encoded));
const digest = createHash("sha256")
  .update(new Uint8Array(await Bun.file(output).arrayBuffer())).digest("hex");
console.log(JSON.stringify({
  input,
  output,
  inputRecords: rows.length,
  outputRecords: filtered.length,
  fixedRoutes: fixedRoutes.length,
  winningRoutes: winningRoutes.size,
  actorRows,
  retainedActorRows,
  removedActorRows,
  removedUnauthorizedRankingRows,
  sha256: digest,
}));
