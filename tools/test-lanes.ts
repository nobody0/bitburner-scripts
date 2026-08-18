export {};

import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** THE SIMULATION RUNNER — see tests/support/lanes.ts for what a lane is.
 *
 *     bun run long go              every long Go run
 *     bun run long bn1             everything specific to BitNode 1
 *     bun run long hacking stock   two features at once
 *     bun run long --all
 *     bun run long --list          what exists, without running it
 *     bun run long hacking --file scenario-   narrow to matching files
 *
 * Every case gets its own Bun process. Simulations install process-wide
 * virtual time, so a case that times out leaves the primitive installed and
 * poisons everything after it in the same process; one process per case means
 * a blown soak costs exactly that soak. */

/** Lane files that cannot declare themselves: they import `ipvgobruteforce/`,
 * the certificate tree and its 28 GB corpus that live outside this repository,
 * so the import throws before any lane() call is reached. `bunfig.toml` keeps
 * them out of the default `bun test` — this is where they get their tags
 * back. Keep the two lists in step. */
const EXTERNAL: { file: string; tags: string[]; requires: string }[] = [
  { file: "tests/ipvgo-bruteforce-arena.test.ts", tags: ["go"], requires: "ipvgobruteforce" },
  { file: "tests/ipvgo-bruteforce-multi-arena.test.ts", tags: ["go"], requires: "ipvgobruteforce" },
  { file: "tests/go-certified-terminal-regret.test.ts", tags: ["go"], requires: "ipvgobruteforce" },
];

/** bunfig's ignore list applies to explicitly named files too, so a lane run
 * has to override it. Any glob that matches nothing will do. */
const NO_IGNORES = "**/.lane-runner-ignores-nothing/**";
/** Discovery must register every case without executing one. */
const MATCHES_NO_TEST = "__lane_discovery_matches_no_test__";

const tokens: string[] = [];
const fileFilters: string[] = [];
let listOnly = false;
let timeoutMs = 900_000;

const argv = process.argv.slice(2);
for (let index = 0; index < argv.length; index++) {
  const arg = argv[index]!;
  if (arg === "--all") tokens.push("all");
  else if (arg === "--list") listOnly = true;
  else if (arg === "--file") fileFilters.push(argv[++index] ?? "");
  else if (arg === "--timeout") timeoutMs = Number(argv[++index]);
  else if (arg.startsWith("-")) throw new Error(`unknown flag: ${arg}`);
  else tokens.push(arg.toLowerCase());
}

if (tokens.length === 0 && !listOnly) {
  console.error("usage: bun run long <feature|bnN|--all> [more tokens] [--file <substring>] [--list]");
  console.error("       bun run long --list      to see every lane and its tokens");
  process.exit(2);
}

const selection = tokens.length > 0 ? tokens.join(",") : "all";
const wants = (entryTokens: string[]): boolean =>
  listOnly || tokens.includes("all") || entryTokens.some((token) => tokens.includes(token));

interface Case {
  file: string;
  /** Undefined for a whole-file lane: run the file, not one case in it. */
  name?: string;
  tags: string[];
  requires?: string;
}

/** Register every lane case without running any of it, and read back what
 * registered. Cheaper than parsing the sources, and it cannot drift from what
 * the files actually declare. */
async function discover(): Promise<Case[]> {
  const directory = mkdtempSync(join(tmpdir(), "bb-lanes-"));
  const manifest = join(directory, "manifest.jsonl");
  writeFileSync(manifest, "");
  try {
    const child = Bun.spawn([
      "bun",
      "test",
      "--test-name-pattern",
      MATCHES_NO_TEST,
      "--pass-with-no-tests",
    ], {
      env: { ...process.env, BB_LANE_MANIFEST: manifest, BB_LANES: "" },
      stdout: "ignore",
      stderr: "ignore",
    });
    if (await child.exited !== 0) {
      // A file that throws at import contributes no lanes and says nothing
      // about it, so a silent discovery failure would quietly shrink a run.
      console.error("warning: discovery pass exited non-zero; a test file may be failing to import");
    }

    const seen = new Set<string>();
    const cases: Case[] = [];
    for (const line of readFileSync(manifest, "utf8").split("\n")) {
      if (line.trim().length === 0) continue;
      const entry = JSON.parse(line) as { kind: string; name: string; file?: string; tags: string[] };
      if (entry.file === undefined) {
        console.error(`lane "${entry.name}" did not report a file; running it by name across the suite`);
      }
      const key = `${entry.file ?? ""}::${entry.name}`;
      if (seen.has(key)) continue;
      seen.add(key);
      cases.push({ file: relative(entry.file), name: entry.name, tags: entry.tags });
    }
    return cases;
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

const root = join(import.meta.dir, "..").replaceAll("\\", "/");
const relative = (file: string | undefined): string =>
  file === undefined ? "." : file.startsWith(root) ? file.slice(root.length + 1) : file;

const escapeRegex = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const discovered = await discover();
const all: Case[] = [
  ...discovered,
  ...EXTERNAL.map((entry) => ({ file: entry.file, tags: entry.tags, requires: entry.requires })),
];

if (listOnly) {
  const byToken = new Map<string, Case[]>();
  for (const entry of all) {
    for (const token of entry.tags) byToken.set(token, [...(byToken.get(token) ?? []), entry]);
  }
  for (const token of [...byToken.keys()].sort()) {
    console.log(`\n${token}`);
    for (const entry of byToken.get(token)!.sort((a, b) => a.file.localeCompare(b.file))) {
      console.log(`  ${entry.file}${entry.name === undefined ? " (whole file)" : ` :: ${entry.name}`}`);
    }
  }
  console.log(`\n${all.length} lane cases. Run one token's worth with: bun run long <token>`);
  process.exit(0);
}

const chosen = all
  .filter((entry) => wants(entry.tags))
  .filter((entry) => fileFilters.length === 0 || fileFilters.some((filter) => entry.file.includes(filter)))
  .sort((a, b) => (a.file + (a.name ?? "")).localeCompare(b.file + (b.name ?? "")));

if (chosen.length === 0) {
  const known = [...new Set(all.flatMap((entry) => entry.tags))].sort();
  console.error(`no lane matched: ${[...tokens, ...fileFilters].join(", ")}`);
  console.error(`tokens in use: ${known.join(", ")}`);
  console.error("bun run long --list shows every lane and the cases behind it");
  process.exit(1);
}

const label = (entry: Case): string =>
  `${entry.file}${entry.name === undefined ? "" : ` :: ${entry.name}`}`;

const failed: Case[] = [];
const unavailable: Case[] = [];
let done = 0;
for (const entry of chosen) {
  if (entry.requires !== undefined && !existsSync(join(root, entry.requires))) {
    unavailable.push(entry);
    continue;
  }
  console.log(`\n=== [${++done}/${chosen.length - unavailable.length}] ${label(entry)} ===`);
  const child = Bun.spawn([
    "bun",
    "test",
    entry.file,
    ...(entry.name === undefined ? [] : ["--test-name-pattern", escapeRegex(entry.name)]),
    "--timeout",
    String(timeoutMs),
    "--path-ignore-patterns",
    NO_IGNORES,
  ], {
    env: { ...process.env, BB_LANES: selection },
    stdout: "inherit",
    stderr: "inherit",
  });
  if (await child.exited !== 0) failed.push(entry);
}

const ran = chosen.length - unavailable.length;
const plural = (count: number): string => (count === 1 ? "case" : "cases");
for (const entry of unavailable) {
  console.log(`\nskipped ${label(entry)}: ${entry.requires}/ is not present in this checkout`);
}
if (failed.length > 0) {
  // Named, not counted: a lane run is long enough that scrolling back through
  // twenty inherited test outputs to find which one broke is its own chore.
  console.error(`\n${failed.length}/${ran} lane ${plural(ran)} failed:`);
  for (const entry of failed) console.error(`  ${label(entry)}`);
  process.exit(1);
}
console.log(`\n${ran} lane ${plural(ran)} passed${unavailable.length > 0 ? `, ${unavailable.length} unavailable` : ""}`);
