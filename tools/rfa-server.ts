import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { WebSocketServer, type WebSocket } from "ws";
import { buildScripts } from "./build.ts";
import { loadConfig } from "./config.ts";
import { RfaSession } from "./rfa-session.ts";

const args = new Set(process.argv.slice(2));
const onceMode = args.has("--once");
const typesOnly = args.has("--types-only");
const telemetry = !args.has("--perf");
if ([onceMode, typesOnly].filter(Boolean).length !== 1) {
  throw new Error("choose exactly one of --once or --types-only");
}

const config = await loadConfig();
const server = new WebSocketServer({ host: config.host, port: config.port });

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

server.on("connection", async (socket: WebSocket) => {
  // One connection is the whole lifetime of this one-shot server. Stop
  // accepting replacements while the complete build is in flight.
  server.close();
  const session = new RfaSession(socket);
  console.log("Bitburner connected");

  try {
    await refreshTypes(session);
    if (!typesOnly) await buildAndPush(session);
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
  } finally {
    socket.close();
  }
});

console.log(`waiting for Bitburner at ws://${config.host}:${config.port}`);

