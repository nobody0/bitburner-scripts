import { readFile } from "node:fs/promises";
import path from "node:path";

export interface BuildEntry {
  source: string;
  target: string;
  /** Qualify this runtime helper with the build id. */
  versioned?: boolean;
}

export interface BitburnerConfig {
  host: string;
  port: number;
  server: string;
  buildDir: string;
  entries: BuildEntry[];
  /** Destructive maintenance entrypoint, excluded from normal build/sync. */
  restoreEntry?: BuildEntry;
}

function relativePath(value: unknown, field: string, extension?: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${field} must be a non-empty string`);
  }
  const normalized = path.posix.normalize(value.replaceAll("\\", "/"));
  if (path.posix.isAbsolute(normalized) || normalized === ".." || normalized.startsWith("../")) {
    throw new Error(`${field} must stay inside the repository`);
  }
  if (extension && !normalized.endsWith(extension)) {
    throw new Error(`${field} must end in ${extension}`);
  }
  return normalized;
}

/** buildScripts recursively clears this directory, so it must be unmistakably
 * disposable even when a typed config bypasses JSON validation. */
export function safeBuildDir(value: unknown): string {
  const buildDir = relativePath(value, "buildDir");
  if (!/^build(?:$|[-/])/.test(buildDir)) {
    throw new Error("buildDir must be build/ or a build-* test directory");
  }
  return buildDir;
}

function parseBuildEntry(value: unknown, field: string): BuildEntry {
  if (value === null || typeof value !== "object") throw new Error(`${field} must be an object`);
  const item = value as Record<string, unknown>;
  const source = relativePath(item.source, `${field}.source`, ".ts");
  if (!source.startsWith("game/")) {
    throw new Error(`${field}.source must live under game/ (only game/ is synced)`);
  }
  const target = relativePath(item.target, `${field}.target`, ".js");
  if (item.versioned !== undefined && typeof item.versioned !== "boolean") {
    throw new Error(`${field}.versioned must be a boolean`);
  }
  return { source, target, ...(item.versioned === true ? { versioned: true } : {}) };
}

export function validateConfig(raw: unknown): BitburnerConfig {
  if (raw === null || typeof raw !== "object") throw new Error("config must be an object");
  const value = raw as Record<string, unknown>;
  if (typeof value.host !== "string" || value.host.length === 0) throw new Error("host must be a string");
  if (!Number.isInteger(value.port) || (value.port as number) < 1 || (value.port as number) > 65535) {
    throw new Error("port must be an integer between 1 and 65535");
  }
  if (typeof value.server !== "string" || value.server.length === 0) throw new Error("server must be a string");
  const buildDir = safeBuildDir(value.buildDir);
  if (!Array.isArray(value.entries) || value.entries.length === 0) throw new Error("entries must not be empty");

  const targets = new Set<string>();
  const entries = value.entries.map((entry, index) => {
    const parsed = parseBuildEntry(entry, `entries[${index}]`);
    if (targets.has(parsed.target)) throw new Error(`duplicate target: ${parsed.target}`);
    targets.add(parsed.target);
    return parsed;
  });

  const restoreEntry = value.restoreEntry === undefined ? undefined : parseBuildEntry(value.restoreEntry, "restoreEntry");
  if (restoreEntry && targets.has(restoreEntry.target)) throw new Error(`duplicate target: ${restoreEntry.target}`);

  return {
    host: value.host,
    port: value.port as number,
    server: value.server,
    buildDir,
    entries,
    ...(restoreEntry ? { restoreEntry } : {}),
  };
}

export async function loadConfig(filename = "bitburner.config.json"): Promise<BitburnerConfig> {
  const raw = JSON.parse(await readFile(filename, "utf8")) as unknown;
  return validateConfig(raw);
}
