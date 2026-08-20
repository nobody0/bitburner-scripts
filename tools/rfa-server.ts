import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { ownedDirectories, versionedScript } from "../shared/deployment.ts";
import { buildScripts, BUILD_ID_FILE } from "./build.ts";
import { loadConfig } from "./config.ts";
import { waitForRfaConnection, type RfaConnection } from "./rfa-connect.ts";
import type { RfaSession } from "./rfa-session.ts";
import { sweepStaleFiles } from "./rfa-sweep.ts";

const args = new Set(process.argv.slice(2));
const syncMode = args.has("--sync");
const typesOnly = args.has("--types-only");
const telemetry = !args.has("--perf");
const sweep = !args.has("--no-sweep");
const dryRun = args.has("--sweep-dry-run");
if ([syncMode, typesOnly].filter(Boolean).length !== 1) {
  throw new Error("choose exactly one of --sync or --types-only");
}

const config = await loadConfig();

async function refreshTypes(session: RfaSession): Promise<void> {
  const definitions = await session.request("getDefinitionFile", { server: config.server });
  if (typeof definitions !== "string") throw new Error("getDefinitionFile returned a non-string result");
  const filename = path.join("types", "NetscriptDefinitions.d.ts");
  await mkdir(path.dirname(filename), { recursive: true });
  await writeFile(filename, definitions, "utf8");
  console.log(`updated ${filename}`);
}

/** Every rooted host, because the controller scp's the versioned helpers to all
 * of them. `config.server` is unioned in so home is swept even if the game's
 * listing comes back unexpectedly thin. */
async function sweepHosts(session: RfaSession): Promise<string[]> {
  const servers = await session.getAllServers().catch(() => []);
  const hosts = new Set([config.server]);
  for (const server of servers) if (server.hasAdminRights) hosts.add(server.hostname);
  return [...hosts];
}

/** Filenames this build and the previous one own.
 *
 * The previous generation is kept deliberately: the outgoing controller lives
 * for up to one tick after build-id.txt changes, and its in-flight workers
 * still reference their own worker.<id>.js. That generation is collected by the
 * NEXT sync, once nothing is running it. */
function keepSet(newIds: readonly string[], pushed: readonly string[]): Set<string> {
  const keep = new Set(pushed);
  for (const id of newIds) {
    for (const entry of config.entries) {
      if (entry.versioned) keep.add(versionedScript(entry.target, id));
    }
  }
  return keep;
}

async function buildAndPush(session: RfaSession): Promise<void> {
  // Read the installed stamp BEFORE the push replaces it.
  const installed = (await session.getFile(config.server, BUILD_ID_FILE))?.trim();

  const artifacts = await buildScripts(config, { telemetry });
  for (const artifact of artifacts) {
    await session.pushFile(config.server, artifact.filename, artifact.content);
    console.log(`pushed ${config.server}:${artifact.filename}`);
  }
  if (!sweep) return;

  const pushed = artifacts.map((artifact) => artifact.filename);
  const previous = installed && /^[a-z0-9-]+$/i.test(installed) ? [installed] : [];
  const owned = ownedDirectories(config.entries.map((entry) => entry.target));
  const hosts = await sweepHosts(session);
  const result = await sweepStaleFiles(session, owned, keepSet(previous, pushed), hosts, { dryRun });

  if (dryRun) {
    for (const filename of result.deleted) console.log(`would delete ${filename}`);
    console.log(`dry run: ${result.deleted.length} stale files across ${result.hosts} servers`);
    return;
  }
  const skipped = result.skipped.length === 0 ? "" : ` (${result.skipped.length} skipped, still running)`;
  console.log(`swept ${result.deleted.length} stale files across ${result.hosts} servers${skipped}`);
}

console.log(`waiting for Bitburner at ws://${config.host}:${config.port}`);
let connection: RfaConnection | undefined;
try {
  connection = await waitForRfaConnection(config);
  console.log("Bitburner connected");
  if (typesOnly) await refreshTypes(connection.session);
  else await buildAndPush(connection.session);
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  connection?.close();
}
