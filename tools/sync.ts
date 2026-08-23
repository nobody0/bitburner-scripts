import { mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { ownedDirectories } from "../shared/deployment.ts";
import { buildScripts, BUILD_ID_FILE } from "./build.ts";
import type { BitburnerConfig } from "./config.ts";
import type { RfaSession } from "./rfa-session.ts";
import { sweepStaleFiles } from "./rfa-sweep.ts";

/** One sync implementation, two transports. The ui/ hub runs this in-process
 * over its persistent Remote File API connection (POST /sync with a JSON body
 * of these options), and the `bun run sync` CLI parses its flags into the same
 * shape — so every option works identically from the dashboard button, an
 * HTTP call, or the command line. */
export interface SyncOptions {
  /** Refresh types/NetscriptDefinitions.d.ts instead of building and pushing. */
  typesOnly?: boolean;
  /** Build with __TELEMETRY__ = false, dropping every TELEMETRY: branch. */
  perf?: boolean;
  /** Keep source identifier names in the pushed bundles (whitespace is still
   * minified). For reading the deployed artifact in the game's editor. */
  readable?: boolean;
  /** Skip collecting stale artifacts after the push. */
  noSweep?: boolean;
  /** Report what the sweep would delete without deleting anything. */
  sweepDryRun?: boolean;
}

export type SyncLog = (line: string) => void;

/** CLI argv -> options. Exactly one mode flag is required because the two
 * package.json scripts (`sync`, `types`) are the only supported invocations,
 * and a bare call doing a full push by default would make typos destructive. */
export function parseSyncArgs(argv: readonly string[]): SyncOptions {
  const known = new Map<string, keyof SyncOptions | undefined>([
    ["--sync", undefined],
    ["--types-only", "typesOnly"],
    ["--perf", "perf"],
    ["--readable", "readable"],
    ["--no-sweep", "noSweep"],
    ["--sweep-dry-run", "sweepDryRun"],
  ]);
  const options: SyncOptions = {};
  for (const arg of argv) {
    if (!known.has(arg)) throw new Error(`unknown flag ${arg}; known: ${[...known.keys()].join(", ")}`);
    const key = known.get(arg);
    if (key) options[key] = true;
  }
  if (argv.includes("--sync") === Boolean(options.typesOnly)) {
    throw new Error("choose exactly one of --sync or --types-only");
  }
  return options;
}

/** Untrusted POST body -> options: booleans on known keys only. */
export function syncOptionsFrom(body: unknown): SyncOptions {
  if (body === null || typeof body !== "object") return {};
  const record = body as Record<string, unknown>;
  const options: SyncOptions = {};
  for (const key of ["typesOnly", "perf", "readable", "noSweep", "sweepDryRun"] as const) {
    if (record[key] === true) options[key] = true;
  }
  return options;
}

/** Anchored to the repository, not the cwd: the hub calls this too. */
const TYPES_FILE = fileURLToPath(new URL("../types/NetscriptDefinitions.d.ts", import.meta.url));

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

/** Hosts on which this deployment can leave files.
 *
 * Darkweb is deliberately included without admin rights. Bitburner v3.0.1
 * special-cases it before the ordinary admin/session checks, so the controller
 * can scp and exec the darknet beachhead there while `hasAdminRights` is false
 * (`src/DarkNet/effects/offlineServerHandling.ts`, pinned in
 * `spec/game-source.md`). */
export function selectSweepHosts(configServer: string, servers: readonly SweepHost[]): string[] {
  const hosts = new Set([configServer]);
  for (const server of servers) {
    if (server.hasAdminRights || server.hostname === "darkweb") hosts.add(server.hostname);
  }
  return [...hosts];
}

/** Every host on which the controller can leave helpers.
 * `config.server` is unioned in so home is swept even if the game's listing
 * comes back unexpectedly thin. */
async function sweepHosts(session: RfaSession, config: BitburnerConfig): Promise<string[]> {
  const servers = await session.getAllServers().catch(() => []);
  return selectSweepHosts(config.server, servers);
}

/** Stable filenames this deployment owns. */
function keepSet(config: BitburnerConfig, pushed: readonly string[]): Set<string> {
  const keep = new Set(pushed);
  for (const filename of pushed) {
    if (filename.startsWith("dnet/")) keep.add(filename.slice(filename.lastIndexOf("/") + 1));
  }
  return keep;
}

async function buildAndPush(
  session: RfaSession,
  config: BitburnerConfig,
  options: SyncOptions,
  log: SyncLog,
): Promise<void> {
  const artifacts = await buildScripts(config, {
    telemetry: !options.perf,
    minifyNames: !options.readable,
  });
  const pushOrder = [
    ...artifacts.filter((artifact) => artifact.filename !== "start.js" && artifact.filename !== BUILD_ID_FILE),
    ...artifacts.filter((artifact) => artifact.filename === "start.js"),
    ...artifacts.filter((artifact) => artifact.filename === BUILD_ID_FILE),
  ];
  for (const artifact of pushOrder) {
    await session.pushFile(config.server, artifact.filename, artifact.content);
    log(`pushed ${config.server}:${artifact.filename}`);
  }
  if (options.noSweep) return;

  const pushed = artifacts.map((artifact) => artifact.filename);
  const owned = ownedDirectories(config.entries.map((entry) => entry.target));
  const hosts = await sweepHosts(session, config);
  const dryRun = options.sweepDryRun === true;
  const result = await sweepStaleFiles(session, owned, keepSet(config, pushed), hosts, {
    dryRun,
  });

  if (dryRun) {
    for (const filename of result.deleted) log(`would delete ${filename}`);
    log(`dry run: ${result.deleted.length} stale files across ${result.hosts} servers`);
    return;
  }
  const skipped = result.skipped.length === 0 ? "" : ` (${result.skipped.length} skipped, still running)`;
  log(`swept ${result.deleted.length} stale files across ${result.hosts} servers${skipped}`);
}

export async function runSync(
  session: RfaSession,
  config: BitburnerConfig,
  options: SyncOptions,
  log: SyncLog,
): Promise<void> {
  if (options.typesOnly) return refreshTypes(session, config, log);
  return buildAndPush(session, config, options, log);
}
