/** Remove only bounded KataGo DAgger actors while copying every other JSONL line verbatim. */
import { createHash } from "node:crypto";
import { rename, unlink } from "node:fs/promises";

interface CorpusRecord {
  kind?: string;
  generation?: {
    kataGoDaggerAuthority?: unknown;
    originatingStudentSha256?: unknown;
  };
}

export interface KataGoDaggerAblationResult {
  retainedLines: string[];
  removedRecords: number;
}

/** Remove either every DAgger actor or only actors generated from one frozen
 * student. The latter makes successive DAgger rounds byte-matched: the control
 * retains all earlier corrections and differs only by the new round. */
export function ablateKataGoDaggerLines(
  lines: string[], originatingStudentSha256?: string,
): KataGoDaggerAblationResult {
  const retainedLines: string[] = [];
  let removedRecords = 0;
  for (const line of lines) {
    if (!line) continue;
    const record = JSON.parse(line) as CorpusRecord;
    const authority = record.generation?.kataGoDaggerAuthority;
    if (authority === undefined
      || (originatingStudentSha256 !== undefined
        && record.generation?.originatingStudentSha256 !== originatingStudentSha256)) {
      retainedLines.push(line);
      continue;
    }
    if (record.kind !== "actor" || authority !== "katago-exact-action-v1"
      || typeof record.generation?.originatingStudentSha256 !== "string") {
      throw new Error("malformed KataGo DAgger authority record");
    }
    removedRecords++;
  }
  if (!removedRecords) {
    throw new Error(originatingStudentSha256 === undefined
      ? "input contains no KataGo DAgger actors"
      : `input contains no KataGo DAgger actors for student ${originatingStudentSha256}`);
  }
  return { retainedLines, removedRecords };
}

function flag(name: string): string {
  const index = Bun.argv.indexOf(name);
  const value = index >= 0 ? Bun.argv[index + 1] : undefined;
  if (!value) throw new Error(`missing ${name}`);
  return value;
}

async function main(): Promise<void> {
  const input = flag("--in");
  const output = flag("--out");
  if (await Bun.file(output).exists()) throw new Error(`output already exists: ${output}`);
  const compressed = new Uint8Array(await Bun.file(input).arrayBuffer());
  const text = new TextDecoder().decode(Bun.gunzipSync(compressed));
  if (!text.endsWith("\n")) throw new Error("input JSONL is missing its final newline");
  const result = ablateKataGoDaggerLines(
    text.slice(0, -1).split("\n"),
    Bun.argv.includes("--originating-student-sha256")
      ? flag("--originating-student-sha256") : undefined,
  );
  const partial = `${output}.partial`;
  try {
    await Bun.write(partial, Bun.gzipSync(
      new TextEncoder().encode(`${result.retainedLines.join("\n")}\n`)));
    await rename(partial, output);
  } catch (error) {
    await unlink(partial).catch(() => undefined);
    throw error;
  }
  const outputBytes = new Uint8Array(await Bun.file(output).arrayBuffer());
  console.log(JSON.stringify({ input, inputSha256: createHash("sha256").update(compressed).digest("hex"),
    output, outputSha256: createHash("sha256").update(outputBytes).digest("hex"),
    removedRecords: result.removedRecords, retainedRecords: result.retainedLines.length,
    retainedLinesCopiedVerbatim: true }));
}

if (import.meta.main) await main();
