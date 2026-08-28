import { mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import {
  ownedDirectories,
  parseSyncControl,
  syncControl,
  SYNC_CONTROL_FILE,
} from "../shared/deployment.ts";
import { buildScripts } from "./build.ts";
import type { BitburnerConfig } from "./config.ts";
import type { RfaSession } from "./rfa-session.ts";
import { sweepStaleFiles } from "./rfa-sweep.ts";

export interface SyncOptions {
  typesOnly?: boolean;
  perf?: boolean;
  readable?: boolean;
}

export type SyncLog = (line: string) => void;

export function parseSyncArgs(argv: readonly string[]): SyncOptions {
  const options: SyncOptions = {};
  let sync = false;
  for (const arg of argv) {
    if (arg === "--sync") sync = true;
    else if (arg === "--types-only") options.typesOnly = true;
    else if (arg === "--perf") options.perf = true;
    else if (arg === "--readable") options.readable = true;
    else throw new Error(`unknown flag ${arg}`);
  }
  if (sync === Boolean(options.typesOnly)) {
    throw new Error("choose exactly one of --sync or --types-only");
  }
  return options;
}

export function syncOptionsFrom(body: unknown): SyncOptions {
  if (body === null || typeof body !== "object") return {};
  const record = body as Record<string, unknown>;
  const options: SyncOptions = {};
  for (const key of ["typesOnly", "perf", "readable"] as const) {
    if (record[key] === true) options[key] = true;
  }
  return options;
}

const TYPES_FILE = fileURLToPath(new URL("../types/NetscriptDefinitions.d.ts", import.meta.url));
const READY_TIMEOUT_MS = 30_000;
const READY_POLL_MS = 100;

async function refreshTypes(session: RfaSession, config: BitburnerConfig, log: SyncLog): Promise<void> {
  const definitions = await session.request("getDefinitionFile", { server: config.server });
  if (typeof definitions !== "string") throw new Error("getDefinitionFile returned a non-string result");
  await mkdir(path.dirname(TYPES_FILE), { recursive: true });
  await writeFile(TYPES_FILE, definitions, "utf8");
  log(`updated ${path.relative(process.cwd(), TYPES_FILE)}`);
}

interface SweepHost {
  hostname: string;
  hasAdminRights: boolean;
}

export function selectSweepHosts(configServer: string, servers: readonly SweepHost[]): string[] {
  const hosts = new Set([configServer]);
  for (const server of servers) {
    if (server.hasAdminRights || server.hostname === "darkweb") hosts.add(server.hostname);
  }
  return [...hosts];
}

function keepSet(pushed: readonly string[]): Set<string> {
  const keep = new Set(pushed);
  for (const filename of pushed) {
    if (filename.startsWith("dnet/")) keep.add(filename.slice(filename.lastIndexOf("/") + 1));
  }
  return keep;
}

async function waitForReady(session: RfaSession, server: string, id: string): Promise<void> {
  const deadline = Date.now() + READY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const control = parseSyncControl(await session.getFile(server, SYNC_CONTROL_FILE));
    if (control?.id === id && control.phase === "ready") return;
    await new Promise((resolve) => setTimeout(resolve, READY_POLL_MS));
  }
  throw new Error(`sync wrapper did not become ready within ${READY_TIMEOUT_MS / 1_000}s`);
}

export async function runSync(
  session: RfaSession,
  config: BitburnerConfig,
  options: SyncOptions,
  log: SyncLog,
): Promise<void> {
  if (options.typesOnly) return refreshTypes(session, config, log);

  const artifacts = await buildScripts(config, {
    telemetry: !options.perf,
    minifyNames: !options.readable,
  });
  const hosts = selectSweepHosts(config.server, await session.getAllServers());
  const id = crypto.randomUUID();
  await session.pushFile(config.server, SYNC_CONTROL_FILE, syncControl({
    id,
    phase: "prepare",
    hosts,
  }));
  log(`waiting for sync wrapper ${id}`);
  await waitForReady(session, config.server, id);
  log(`stopped scripts across ${hosts.length} servers`);

  for (const artifact of artifacts) {
    await session.pushFile(config.server, artifact.filename, artifact.content);
    log(`pushed ${config.server}:${artifact.filename}`);
  }

  const owned = ownedDirectories(config.entries.map((entry) => entry.target));
  const deleted = await sweepStaleFiles(session, owned, keepSet(artifacts.map((artifact) => artifact.filename)), hosts);
  log(`swept ${deleted.length} stale files across ${hosts.length} servers`);

  await session.pushFile(config.server, SYNC_CONTROL_FILE, syncControl({
    id,
    phase: "commit",
  }));
  log(`committed sync ${id}`);
}
