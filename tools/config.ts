import { readFile } from "node:fs/promises";
import path from "node:path";

export interface BuildEntry {
  source: string;
  target: string;
}

export interface BitburnerConfig {
  host: string;
  port: number;
  server: string;
  buildDir: string;
  entries: BuildEntry[];
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

export function validateConfig(raw: unknown): BitburnerConfig {
  if (raw === null || typeof raw !== "object") throw new Error("config must be an object");
  const value = raw as Record<string, unknown>;
  if (typeof value.host !== "string" || value.host.length === 0) throw new Error("host must be a string");
  if (!Number.isInteger(value.port) || (value.port as number) < 1 || (value.port as number) > 65535) {
    throw new Error("port must be an integer between 1 and 65535");
  }
  if (typeof value.server !== "string" || value.server.length === 0) throw new Error("server must be a string");
  const buildDir = relativePath(value.buildDir, "buildDir");
  if (buildDir === ".") throw new Error("buildDir cannot be the repository root");
  if (!Array.isArray(value.entries) || value.entries.length === 0) throw new Error("entries must not be empty");

  const targets = new Set<string>();
  const entries = value.entries.map((entry, index) => {
    if (entry === null || typeof entry !== "object") throw new Error(`entries[${index}] must be an object`);
    const item = entry as Record<string, unknown>;
    const source = relativePath(item.source, `entries[${index}].source`, ".ts");
    if (!source.startsWith("game/")) {
      throw new Error(`entries[${index}].source must live under game/ (only game/ is synced)`);
    }
    const target = relativePath(item.target, `entries[${index}].target`, ".js");
    if (targets.has(target)) throw new Error(`duplicate target: ${target}`);
    targets.add(target);
    return { source, target };
  });

  return { host: value.host, port: value.port as number, server: value.server, buildDir, entries };
}

export async function loadConfig(filename = "bitburner.config.json"): Promise<BitburnerConfig> {
  const raw = JSON.parse(await readFile(filename, "utf8")) as unknown;
  return validateConfig(raw);
}

