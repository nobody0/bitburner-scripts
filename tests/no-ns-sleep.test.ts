import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { extname, join, relative } from "node:path";

const ROOT = join(import.meta.dir, "..");
const RUNTIME_ROOTS = [
  "game",
  "ipvgobruteforce/arena",
  "tools/combined-standalone",
] as const;
const DIRECT_NS_SLEEP = /\bns\s*(?:\.\s*sleep|\[\s*["']sleep["']\s*\])\s*\(/;

function runtimeSources(directory: string): string[] {
  const result: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) result.push(...runtimeSources(path));
    else if ([".ts", ".js"].includes(extname(entry.name))) result.push(path);
  }
  return result;
}

test("production runtimes never call ns.sleep", () => {
  const violations: string[] = [];
  for (const root of RUNTIME_ROOTS) {
    for (const path of runtimeSources(join(ROOT, root))) {
      const sourceWithoutComments = readFileSync(path, "utf8")
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/\/\/.*$/gm, "");
      if (DIRECT_NS_SLEEP.test(sourceWithoutComments)) {
        violations.push(relative(ROOT, path).replaceAll("\\", "/"));
      }
    }
  }
  expect(violations).toEqual([]);
});
