import { TELEMETRY_PORT } from "../shared/telemetry/schema.ts";
import { loadConfig } from "./config.ts";
import { waitForRfaConnection, type RfaConnection } from "./rfa-connect.ts";
import { parseSyncArgs, runSync } from "./sync.ts";

/** CLI entry for `bun run sync` / `bun run types`.
 *
 * The ui/ hub permanently owns the Remote File API port and keeps the game
 * connected, so while it is running every sync MUST route through it — this
 * process could not bind the port anyway. The options parse into the same
 * SyncOptions the hub's POST /sync accepts, so flags like --readable behave
 * identically on both transports. Only when no hub is listening does the CLI
 * fall back to the original one-shot listener, which is then free to bind. */

const options = parseSyncArgs(process.argv.slice(2));
const hubPort = Number(process.env["UI_PORT"] ?? TELEMETRY_PORT);

/** True when a hub answered (successfully or not); false only when nothing is
 * listening, which is the one case where the one-shot fallback can run. */
async function syncViaHub(): Promise<boolean> {
  let response: Response;
  try {
    response = await fetch(`http://127.0.0.1:${hubPort}/sync`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(options),
    });
  } catch {
    return false;
  }
  const body = (await response.json().catch(() => ({}))) as { code?: number; output?: string; error?: string };
  if (body.output) console.log(body.output);
  if (!response.ok || body.code !== 0) {
    console.error(`sync through the ui/ hub failed: ${body.error ?? `exit ${body.code ?? "?"}`}`);
    process.exitCode = 1;
  } else {
    console.log(`synced through the ui/ hub on port ${hubPort}`);
  }
  return true;
}

if (!(await syncViaHub())) {
  const config = await loadConfig();
  console.log(`no ui/ hub on port ${hubPort}; waiting for Bitburner at ws://${config.host}:${config.port}`);
  let connection: RfaConnection | undefined;
  try {
    connection = await waitForRfaConnection(config);
    console.log("Bitburner connected");
    await runSync(connection.session, config, options, (line) => console.log(line));
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
  } finally {
    connection?.close();
  }
}
