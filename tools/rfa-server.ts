import { mkdir, watch, writeFile } from "node:fs/promises";
import path from "node:path";
import { WebSocketServer, type WebSocket } from "ws";
import { buildScripts } from "./build.ts";
import { loadConfig } from "./config.ts";
import { RfaSession } from "./rfa-session.ts";

const args = new Set(process.argv.slice(2));
const watchMode = args.has("--watch");
const onceMode = args.has("--once");
const typesOnly = args.has("--types-only");
const telemetry = !args.has("--perf");
if ([watchMode, onceMode, typesOnly].filter(Boolean).length !== 1) {
  throw new Error("choose exactly one of --watch, --once, or --types-only");
}

const config = await loadConfig();
const server = new WebSocketServer({ host: config.host, port: config.port });
let activeSession: RfaSession | undefined;
let syncing: Promise<void> | undefined;
let debounce: ReturnType<typeof setTimeout> | undefined;

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

function queueSync(): void {
  if (!activeSession || syncing) return;
  syncing = buildAndPush(activeSession)
    .catch((error) => console.error(error))
    .finally(() => {
      syncing = undefined;
    });
}

server.on("connection", async (socket: WebSocket) => {
  activeSession?.dispose(new Error("A newer Bitburner connection replaced this session"));
  const session = new RfaSession(socket);
  activeSession = session;
  console.log("Bitburner connected");

  try {
    await refreshTypes(session);
    if (!typesOnly) await buildAndPush(session);
    if (onceMode || typesOnly) {
      socket.close();
      server.close();
    }
  } catch (error) {
    console.error(error);
    if (onceMode || typesOnly) process.exitCode = 1;
  }
});

if (watchMode) {
  for (const dir of config.watchDirs) {
    const watcher = watch(dir, { recursive: true });
    void (async () => {
      for await (const _event of watcher) {
        if (debounce) clearTimeout(debounce);
        debounce = setTimeout(queueSync, 100);
      }
    })();
  }
}

console.log(`waiting for Bitburner at ws://${config.host}:${config.port}`);

