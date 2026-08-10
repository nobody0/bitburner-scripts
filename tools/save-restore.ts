import { readFileSync } from "node:fs";
import path from "node:path";
import { buildScript } from "./build.ts";
import { loadConfig } from "./config.ts";
import { waitForRfaConnection } from "./rfa-connect.ts";
import { findSave, prepareIndexedDbSave, readSnapshot, SAVES_DIR } from "./save-io.ts";

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
  const fileBytes = new Uint8Array(readFileSync(path.join(SAVES_DIR, entry.file)));
  const prepared = prepareIndexedDbSave(fileBytes);

  const header = JSON.stringify({
    id: entry.id,
    bitNode: snapshot.bitNode,
    playtimeSinceLastBitnode: snapshot.player.playtimeSinceLastBitnode,
    capturedAt: entry.capturedAt,
    storage: prepared.storage,
  });
  const payload = `${header}\n${Buffer.from(prepared.bytes).toString("base64")}`;

  const config = await loadConfig();
  if (!config.restoreEntry) {
    console.error("restoreEntry is missing from bitburner.config.json");
    process.exit(1);
  }
  const restore = await buildScript(config, config.restoreEntry, { telemetry: true });

  // The repository is the Remote File API server and Bitburner is the client,
  // so this waits for the game to connect. Port 12525 holds only one listener,
  // so an in-progress sync must finish first.
  console.log(`waiting for Bitburner at ws://${config.host}:${config.port} ...`);
  const connection = await waitForRfaConnection(config);
  try {
    await connection.session.pushFile(config.server, "restore-payload.txt", payload);
    await connection.session.pushFile(config.server, "restore.js", restore.content);
  } finally {
    connection.close();
  }

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
