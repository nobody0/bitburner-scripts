import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, extname, isAbsolute, relative, resolve, sep } from "node:path";

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
  test("game runtime imports stay inside game/shared and avoid host APIs", () => {
    const gameRoot = resolve(root, "game");
    const sharedRoot = resolve(root, "shared");
    const violations = sourceFiles("game").flatMap((path) =>
      importedModules(path)
        .filter((module) => {
          if (module.includes("bitburner-src") || /^(?:bun|node:)/.test(module)) return true;
          if (!module.startsWith(".") && !isAbsolute(module)) return false;
          const target = resolve(dirname(path), module);
          return !target.startsWith(`${gameRoot}${sep}`) && !target.startsWith(`${sharedRoot}${sep}`);
        })
        .map((module) => `${display(path)} -> ${module}`),
    );
    expect(violations).toEqual([]);
  });

  test("shared is self-contained and independent of runtime/project-specific code", () => {
    const sharedRoot = resolve(root, "shared");
    const violations = sourceFiles("shared").flatMap((path) => {
      const imports = importedModules(path)
        .filter((module) => {
          if (module.startsWith(".")) return !resolve(dirname(path), module).startsWith(`${sharedRoot}${sep}`);
          // @ns is erased type information supplied by the game. Shared may
          // describe its public data shapes with it, but may not depend on a
          // runtime package or host API.
          return module !== "@ns";
        })
        .map((module) => `${display(path)} -> ${module}`);
      const source = readFileSync(path, "utf8");
      if (/(?:import|export)\s+(?!type\b)[^;]*?from\s*["']@ns["']|import\(\s*["']@ns["']\s*\)/s.test(source)) {
        imports.push(`${display(path)} -> runtime @ns`);
      }
      if (source.includes("__TELEMETRY__")) imports.push(`${display(path)} -> __TELEMETRY__`);
      return imports;
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

  // A raw control character in a source file is invisible in review, makes git
  // and grep treat the file as binary, and silently redefines any string
  // literal it lands in. Separators that need one (the weaken-group key, the
  // missed-window key) must be written as an escape, never as the byte.
  test("source files carry no raw control characters", () => {
    // Tab is the only control character that legitimately appears in source.
    const control = (line: string): boolean =>
      [...line].some((character) => character.charCodeAt(0) < 32 && character.charCodeAt(0) !== 9);
    const violations = ["game", "shared", "sim", "tests", "tools", "ui"].flatMap((directory) =>
      sourceFiles(directory).flatMap((path) => {
        const at = readFileSync(path, "utf8").split(/\r?\n/).findIndex((line) => control(line));
        return at === -1 ? [] : [`${display(path)}:${at + 1}`];
      }),
    );
    expect(violations).toEqual([]);
  });
});
