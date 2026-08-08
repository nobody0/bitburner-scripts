import { readFileSync } from "node:fs";
import path from "node:path";
import { WebSocketServer, type WebSocket } from "ws";
import { buildScripts } from "./build.ts";
import { loadConfig } from "./config.ts";
import { RfaSession } from "./rfa-session.ts";
import { findSave, readSnapshot, SAVES_DIR } from "./save-io.ts";

/** Push a registered save into the game, ready for restore.js to apply.
 *
 * This half only DELIVERS. It never writes to the game's save: the actual
 * overwrite happens in game/restore.ts, behind a prompt that shows the live
 * game's BitNode and playtime next to the snapshot's. Splitting it that way
 * means a mistyped id here cannot destroy anything — the worst case is an
 * unused file on home.
 *
 * The payload is a header line plus base64 of the raw export bytes, because
 * the Remote File API moves text and the export is binary gzip. */

async function main(): Promise<void> {
  const id = process.argv[2];
  if (!id) {
    console.error("usage: bun run save:restore <id>");
    console.error("       bun run tools/save-io.ts list   # to see registered saves");
    process.exit(1);
  }

  const entry = findSave(id);
  // Decoded here purely to fail early: a corrupt blob should not reach the game.
  const snapshot = readSnapshot(entry.file);
  const bytes = readFileSync(path.join(SAVES_DIR, entry.file));

  const header = JSON.stringify({
    id: entry.id,
    bitNode: snapshot.bitNode,
    playtimeSinceLastBitnode: snapshot.player.playtimeSinceLastBitnode,
    capturedAt: entry.capturedAt,
  });
  const payload = `${header}\n${bytes.toString("base64")}`;

  const config = await loadConfig();
  const artifacts = await buildScripts(config, { telemetry: true });
  const restore = artifacts.find((artifact) => artifact.filename === "restore.js");
  if (!restore) {
    console.error("restore.js is not an entrypoint — add game/restore.ts to bitburner.config.json");
    process.exit(1);
  }

  // The repository is the Remote File API server and Bitburner is the client,
  // so this waits for the game to connect. Port 12525 holds only one listener,
  // so an in-progress sync must finish first.
  let server: WebSocketServer;
  try {
    server = new WebSocketServer({ host: config.host, port: config.port });
  } catch {
    console.error(`could not listen on ${config.host}:${config.port} — wait for the active sync and retry`);
    process.exit(1);
  }
  server.on("error", (error) => {
    console.error(`${String(error)}\n(if this is EADDRINUSE, wait for the active sync and retry)`);
    process.exit(1);
  });

  console.log(`waiting for Bitburner at ws://${config.host}:${config.port} ...`);
  await new Promise<void>((resolve, reject) => {
    server.on("connection", (socket: WebSocket) => {
      const session = new RfaSession(socket);
      void (async () => {
        try {
          await session.pushFile(config.server, "restore-payload.txt", payload);
          await session.pushFile(config.server, "restore.js", restore.content);
          resolve();
        } catch (error) {
          reject(error instanceof Error ? error : new Error(String(error)));
        } finally {
          session.dispose();
          socket.close();
          server.close();
        }
      })();
    });
  });

  console.log(`pushed "${entry.id}" (BN${snapshot.bitNode}, ${(snapshot.player.playtimeSinceLastBitnode / 3_600_000).toFixed(1)}h into the node)`);
  console.log("");
  console.log("In the game's terminal, run:");
  console.log(`    run restore.js ${entry.id}`);
  console.log("");
  console.log("It will show the live game's BitNode and playtime beside the snapshot's,");
  console.log("then ask for confirmation. There is NO automatic backup — export first if");
  console.log("your current progress matters.");
}

await main();
