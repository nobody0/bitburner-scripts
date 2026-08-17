import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");
const temporary: string[] = [];

afterEach(async () => {
  await Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true })));
});

function row(kind: string, episode: number, source: string, won?: number,
             mode?: string): object {
  const metadata = {
    schema: "bitburner-go-exhaustive-proposals-v9.5",
    profile: "small5",
    teacherSha256: "teacher",
    opponentOracle: "oracle",
  };
  if (kind === "trajectory") return {
    ...metadata, kind, episode, values: [{ won }], generation: { source, mode },
  };
  return {
    ...metadata, kind, example: { episode, source }, generation: { source, mode },
  };
}

describe("fixed-teacher actor filtering", () => {
  test("keeps every outcome but clones actions only from winning routes", async () => {
    const directory = await mkdtemp(join(tmpdir(), "go-winning-actors-"));
    temporary.push(directory);
    const input = join(directory, "input.jsonl.gz");
    const output = join(directory, "output.jsonl.gz");
    const rows = [
      row("trajectory", 0, "katago", 1),
      row("actor", 0, "katago"),
      row("actor-ranking", 0, "katago", undefined, "predictive"),
      row("trajectory", 1, "handcrafted", 0),
      row("actor", 1, "handcrafted"),
    ];
    await Bun.write(input, Bun.gzipSync(new TextEncoder().encode(
      `${rows.map((value) => JSON.stringify(value)).join("\n")}\n`,
    )));

    const run = Bun.spawnSync([
      "bun", "run", "go-ai/teacher/filter-v9-winning-actors.ts",
      "--in", input, "--out", output,
    ], { cwd: ROOT });
    expect(run.exitCode).toBe(0);
    const filtered = new TextDecoder().decode(Bun.gunzipSync(
      new Uint8Array(await Bun.file(output).arrayBuffer()),
    )).trim().split("\n").map((line) => JSON.parse(line));
    expect(filtered.filter((value) => value.kind === "trajectory")).toHaveLength(2);
    expect(filtered.filter((value) => value.kind === "actor")).toEqual([
      expect.objectContaining({ example: expect.objectContaining({ episode: 0, source: "katago" }) }),
    ]);
    expect(filtered.filter((value) => value.kind === "actor-ranking")).toHaveLength(1);
  });

  test("drops post-reply rankings from non-predictive KataGo only", async () => {
    const directory = await mkdtemp(join(tmpdir(), "go-teacher-authority-"));
    temporary.push(directory);
    const input = join(directory, "input.jsonl.gz");
    const output = join(directory, "output.jsonl.gz");
    const rows = [
      row("trajectory", 0, "katago", 1, "plain"),
      row("actor", 0, "katago", undefined, "plain"),
      row("actor-ranking", 0, "katago", undefined, "plain"),
      row("trajectory", 1, "handcrafted", 1),
      row("actor-ranking", 1, "handcrafted"),
    ];
    await Bun.write(input, Bun.gzipSync(new TextEncoder().encode(
      `${rows.map((value) => JSON.stringify(value)).join("\n")}\n`,
    )));

    const run = Bun.spawnSync([
      "bun", "run", "go-ai/teacher/filter-v9-winning-actors.ts",
      "--in", input, "--out", output,
    ], { cwd: ROOT });
    expect(run.exitCode).toBe(0);
    const filtered = new TextDecoder().decode(Bun.gunzipSync(
      new Uint8Array(await Bun.file(output).arrayBuffer()),
    )).trim().split("\n").map((line) => JSON.parse(line));
    expect(filtered.filter((value) => value.kind === "trajectory")).toHaveLength(2);
    expect(filtered.filter((value) => value.kind === "actor")).toHaveLength(1);
    expect(filtered.filter((value) => value.kind === "actor-ranking")).toEqual([
      expect.objectContaining({ example: expect.objectContaining({ source: "handcrafted" }) }),
    ]);
  });
});
