import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { buildScripts } from "./build.ts";
import { loadConfig } from "./config.ts";
import { waitForRfaConnection, type RfaConnection } from "./rfa-connect.ts";
import type { RfaSession } from "./rfa-session.ts";

const args = new Set(process.argv.slice(2));
const syncMode = args.has("--sync");
const typesOnly = args.has("--types-only");
const telemetry = !args.has("--perf");
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

async function buildAndPush(session: RfaSession): Promise<void> {
  const artifacts = await buildScripts(config, { telemetry });
  for (const artifact of artifacts) {
    await session.pushFile(config.server, artifact.filename, artifact.content);
    console.log(`pushed ${config.server}:${artifact.filename}`);
  }
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
