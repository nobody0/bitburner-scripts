import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { extname, relative, resolve, sep } from "node:path";

const root = resolve(import.meta.dir, "..");
const sourceExtensions = new Set([".ts", ".js"]);

function sourceFiles(directory: string): string[] {
  return readdirSync(resolve(root, directory), { withFileTypes: true }).flatMap((entry) => {
    const path = resolve(root, directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(relative(root, path));
    return sourceExtensions.has(extname(entry.name)) ? [path] : [];
  });
}

function importedModules(path: string): string[] {
  const source = readFileSync(path, "utf8");
  const modules: string[] = [];
  const pattern = /(?:import|export)\s+(?:type\s+)?(?:[^"']*?\s+from\s+)?["']([^"']+)["']|import\(\s*["']([^"']+)["']\s*\)/g;
  for (const match of source.matchAll(pattern)) modules.push(match[1] ?? match[2]!);
  return modules;
}

function display(path: string): string {
  return relative(root, path).split(sep).join("/");
}

describe("sub-project boundaries", () => {
  test("game does not import simulator, UI, or host runtime APIs", () => {
    const violations = sourceFiles("game").flatMap((path) =>
      importedModules(path)
        .filter((module) => /(?:^|\/)\.{0,2}\/?(?:sim|ui)(?:\/|$)/.test(module) || /^(?:bun|node:)/.test(module))
        .map((module) => `${display(path)} -> ${module}`),
    );
    expect(violations).toEqual([]);
  });

  test("shared stays pure and independent of compile-time game flags", () => {
    const violations = sourceFiles("shared").flatMap((path) => {
      const imports = importedModules(path)
        .filter((module) => /^(?:bun|node:)/.test(module) || /(?:^|\/)\.{0,2}\/?(?:game|sim|ui)(?:\/|$)/.test(module))
        .map((module) => `${display(path)} -> ${module}`);
      return readFileSync(path, "utf8").includes("__TELEMETRY__")
        ? [...imports, `${display(path)} -> __TELEMETRY__`]
        : imports;
    });
    expect(violations).toEqual([]);
  });

  test("UI does not import game code", () => {
    const violations = sourceFiles("ui").flatMap((path) =>
      importedModules(path)
        .filter((module) => /(?:^|\/)\.{0,2}\/?game(?:\/|$)/.test(module))
        .map((module) => `${display(path)} -> ${module}`),
    );
    expect(violations).toEqual([]);
  });

  test("vendored simulator internals are imported only from sim", () => {
    const violations = ["game", "shared", "tests", "tools", "ui"].flatMap((directory) =>
      sourceFiles(directory).flatMap((path) =>
        importedModules(path)
          .filter((module) => module.includes("sim/vendor/"))
          .map((module) => `${display(path)} -> ${module}`),
      ),
    );
    expect(violations).toEqual([]);
  });
});
