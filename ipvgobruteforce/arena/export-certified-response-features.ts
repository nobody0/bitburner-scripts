/** Bounded exact-response feature shard for certified behavior contrasts. */
import { createHash } from "node:crypto";
import { readFile, rename, unlink } from "node:fs/promises";
import { join } from "node:path";
import {
  modelInputKey,
  parseCertificate,
  type CandidateActor,
} from "./export-certified-v9.ts";
import {
  GO_CANDIDATE_RESPONSE_FEATURES,
  candidateResponseFeatures,
} from "../../shared/strategy/go/neural/candidate-features.ts";
import { GO_ARENA_OPPONENTS } from "../../go-ai/teacher/arena.ts";
import type { GoRewardOpponent } from "../../shared/strategy/go/rules.ts";
import { KataGoAdvisor, KATAGO_MODELS, type KataGoMove } from "../../go-ai/katago/advisor.ts";

const FEATURE_SCHEMA = "exact-seeded-post-reply-candidate-v1";
const KOMI: Readonly<Record<string, number>> = Object.fromEntries(
  GO_ARENA_OPPONENTS.filter(({ requestedSize }) => requestedSize === 5)
    .map(({ name, komi }) => [name, komi]),
);

function flag(name: string, fallback = ""): string {
  const index = Bun.argv.indexOf(name);
  return index >= 0 ? Bun.argv[index + 1] ?? fallback : fallback;
}

function integerFlag(name: string, fallback: number): number {
  const value = Number(flag(name, String(fallback)));
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${name} must be a positive integer`);
  return value;
}

function sha256(value: Uint8Array | string): string {
  return createHash("sha256").update(value).digest("hex");
}

async function readGzip(path: string): Promise<Record<string, unknown>[]> {
  const bytes = Bun.gunzipSync(new Uint8Array(await Bun.file(path).arrayBuffer()));
  return new TextDecoder().decode(bytes).trimEnd().split("\n")
    .filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>);
}

async function writeGzip(path: string, rows: Record<string, unknown>[]): Promise<void> {
  if (await Bun.file(path).exists()) throw new Error(`refusing to overwrite ${path}`);
  const partial = `${path}.partial`;
  if (await Bun.file(partial).exists()) throw new Error(`stale partial exists: ${partial}`);
  try {
    await Bun.write(partial, Bun.gzipSync(new TextEncoder().encode(
      `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`)));
    await rename(partial, path);
  } catch (error) {
    await unlink(partial).catch(() => undefined);
    throw error;
  }
}

function conditionalGroup(row: Record<string, unknown>): string {
  const generation = row.generation as Record<string, unknown>;
  if (typeof generation.conditionalGroupSha256 === "string") {
    return generation.conditionalGroupSha256;
  }
  const example = row.example as Record<string, unknown>;
  return modelInputKey(String(example.state), example.behavior as number[],
    Number(example.elapsed)).toString("hex");
}

export function selectGroups(
  rows: Record<string, unknown>[], perStratum: number,
): Record<string, unknown>[] {
  const groups = new Map<string, Record<string, unknown>[]>();
  for (const row of rows) {
    const generation = row.generation as Record<string, unknown>;
    const group = conditionalGroup(row);
    const stratum = `${row.split}:${generation.opponent}`;
    const key = `${stratum}:${group}`;
    const values = groups.get(key) ?? [];
    values.push(row);
    groups.set(key, values);
  }
  const strata = new Map<string, Array<[string, Record<string, unknown>[]]>>();
  for (const [key, values] of groups) {
    const generation = values[0]!.generation as Record<string, unknown>;
    const stratum = `${values[0]!.split}:${generation.opponent}`;
    const candidates = strata.get(stratum) ?? [];
    candidates.push([key, values]);
    strata.set(stratum, candidates);
  }
  const selected: Record<string, unknown>[] = [];
  for (const [stratum, candidates] of [...strata].sort()) {
    candidates.sort((left, right) => sha256(left[0]).localeCompare(sha256(right[0])));
    if (candidates.length < perStratum) {
      throw new Error(`${stratum} has only ${candidates.length}/${perStratum} groups`);
    }
    selected.push(...candidates.slice(0, perStratum).flatMap((entry) => entry[1]));
  }
  return selected;
}

function candidateKey(actor: CandidateActor): string {
  return modelInputKey(actor.state, actor.behavior, actor.elapsed).toString("hex");
}

async function main(): Promise<void> {
  const input = flag("--input");
  const out = flag("--out");
  const netburners = flag("--netburners-dir");
  const slumSnakes = flag("--slum-snakes-dir");
  const directories: Readonly<Record<string, string>> = {
    Netburners: netburners,
    "Slum Snakes": slumSnakes,
    "The Black Hand": flag("--black-hand-dir"),
    Tetrads: flag("--tetrads-dir"),
    Daedalus: flag("--daedalus-dir"),
    Illuminati: flag("--illuminati-dir"),
  };
  if (!input || !out) {
    throw new Error("--input and --out are required");
  }
  const inputRows = await readGzip(input);
  const eligible = Bun.argv.includes("--certificate-root-only")
    ? inputRows.filter((row) => Number(
      (row.generation as Record<string, unknown>).certificateRound) === 1)
    : inputRows;
  const selected = selectGroups(eligible, integerFlag("--groups-per-stratum", 64));
  const kataBinary = flag("--katago-binary");
  const kata = kataBinary ? new KataGoAdvisor(
    kataBinary,
    flag("--katago-model", KATAGO_MODELS.small5.file),
    flag("--katago-config", "go-ai/katago/config/analysis.cfg"),
  ) : undefined;
  const kataVisits = integerFlag("--katago-visits", 16);
  const kataLimit = integerFlag("--katago-limit", 4);
  const kataCache = new Map<string, Promise<number[]>>();
  const byCertificate = new Map<string, Record<string, unknown>[]>();
  for (const row of selected) {
    const generation = row.generation as Record<string, unknown>;
    const opponent = String(generation.opponent);
    const directory = directories[opponent];
    if (!directory) throw new Error(`unsupported certified opponent ${opponent}`);
    const path = join(directory, "policies", String(generation.certificate));
    const values = byCertificate.get(path) ?? [];
    values.push(row);
    byCertificate.set(path, values);
  }

  const output: Record<string, unknown>[] = [];
  try {
  for (const [path, records] of byCertificate) {
    const opponent = String(
      (records[0]!.generation as Record<string, unknown>).opponent,
    ) as GoRewardOpponent;
    const parsed = parseCertificate(await readFile(path, "utf8"), path, opponent);
    const candidates = new Map(parsed.candidates.map((actor) => [candidateKey(actor), actor]));
    for (const record of records) {
      const example = record.example as Record<string, unknown>;
      const key = modelInputKey(String(example.state), example.behavior as number[],
        Number(example.elapsed)).toString("hex");
      const actor = candidates.get(key);
      if (!actor) throw new Error(`certificate ${path} lacks selected model input ${key}`);
      const moves = example.moves as number[];
      const features = moves.map((move) => Array.from(candidateResponseFeatures(
        actor.board, actor.history, actor.passes, opponent, KOMI[opponent]!,
        actor.opponentSeed, move)));
      const kataKey = sha256(JSON.stringify({ actor: actor.board.rows,
        history: actor.history, komi: KOMI[opponent] }));
      let kataGoActions: number[] | undefined;
      if (kata) {
        let pending = kataCache.get(kataKey);
        if (!pending) {
          pending = kata.shortlist(actor.board, actor.history, KOMI[opponent]!,
            kataVisits, kataLimit).then((values) => values.map(({ move }) =>
              move === "pass" ? actor.board.size ** 2
                : (move as Exclude<KataGoMove, "pass">)[0] * actor.board.size
                  + (move as Exclude<KataGoMove, "pass">)[1]));
          kataCache.set(kataKey, pending);
        }
        kataGoActions = await pending;
      }
      const teacherAction = (example.actions as number[])[0]!;
      const group = conditionalGroup(record);
      output.push({
        ...record,
        example: { ...example, candidateResponseFeatures: features },
        generation: { ...(record.generation as Record<string, unknown>),
          conditionalGroupSha256: group,
          conditionalGroupKind: typeof (record.generation as Record<string, unknown>)
            .conditionalGroupSha256 === "string" ? "preexisting" : "exact-model-input-v1",
          candidateResponseFeatureSchema: FEATURE_SCHEMA,
          candidateResponseFeatureCount: GO_CANDIDATE_RESPONSE_FEATURES,
          ...(kataGoActions ? { kataGoActions,
            kataGoAgrees: kataGoActions.includes(teacherAction),
            kataGoVisits: kataVisits, kataGoLimit: kataLimit } : {}) },
      });
    }
  }
  } finally {
    await kata?.close();
  }
  output.sort((left, right) => {
    const a = left.generation as Record<string, unknown>;
    const b = right.generation as Record<string, unknown>;
    return conditionalGroup(left).localeCompare(conditionalGroup(right))
      || String(modelInputKey(String((left.example as Record<string, unknown>).state),
        (left.example as Record<string, unknown>).behavior as number[],
        Number((left.example as Record<string, unknown>).elapsed)).toString("hex"))
        .localeCompare(modelInputKey(String((right.example as Record<string, unknown>).state),
          (right.example as Record<string, unknown>).behavior as number[],
          Number((right.example as Record<string, unknown>).elapsed)).toString("hex"));
  });
  await writeGzip(out, output);
  console.log(JSON.stringify({ input, out, records: output.length,
    groups: new Set(output.map((row) =>
      (row.generation as Record<string, unknown>).conditionalGroupSha256)).size,
    featureSchema: FEATURE_SCHEMA, features: GO_CANDIDATE_RESPONSE_FEATURES,
    kataGoStates: kataCache.size,
    sha256: sha256(new Uint8Array(await Bun.file(out).arrayBuffer())) }));
}

if (import.meta.main) await main();
