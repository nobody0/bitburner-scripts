import type { NS } from "@ns";

/** Restore a saved snapshot into the running game.
 *
 * DESTRUCTIVE, and deliberately its own entrypoint rather than anything
 * start.js can reach: it overwrites the live save with a file pushed from the
 * repository, and there is no undo. Keeping it separate means the controller
 * never carries a code path that can clobber real progress, and never pays RAM
 * for one.
 *
 * How it works: the save lives in IndexedDB under database `bitburnerSave`
 * version 2, object store `savestring`, key `save`, as either a base64 string
 * or gzip bytes. Source: https://github.com/bitburner-official/bitburner-src/blob/3162fd2590e221eadd0c0fbd46151913f7c4c41c/src/db.ts#L12-L36
 * This entrypoint mirrors the database-write and reload portion of importGame;
 * unlike importGame it deliberately bypasses the game's validation/dialog/UI
 * path because the repository tooling has already selected the raw exported
 * payload. Source: https://github.com/bitburner-official/bitburner-src/blob/3162fd2590e221eadd0c0fbd46151913f7c4c41c/src/SaveObject.ts#L323-L335
 *
 * RAM: 1 GB beyond the 1.6 GB base. indexedDB, atob and location are browser
 * globals, and ns.read / ns.prompt are free; ns.getResetInfo costs 1 GB.
 * Source: https://github.com/bitburner-official/bitburner-src/blob/3162fd2590e221eadd0c0fbd46151913f7c4c41c/src/Netscript/RamCostGenerator.ts#L646-L654
 *
 * Usage:  bun run save:restore <id>     (pushes the payload, prints this)
 *         run restore.js <id>           (in the game's terminal) */

const PAYLOAD_FILE = "restore-payload.txt";
const DB_NAME = "bitburnerSave";
const DB_VERSION = 2;
const STORE = "savestring";
const KEY = "save";

interface PayloadHeader {
  id: string;
  bitNode: number;
  playtimeSinceLastBitnode: number;
  capturedAt: number;
  /** IndexedDB SaveData variant. Omitted by older payload tooling, whose
   * exports were raw gzip bytes. */
  storage?: "binary" | "text";
}

function decodeBase64(text: string): Uint8Array {
  const binary = atob(text);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(new Error(`could not open ${DB_NAME}`));
    request.onblocked = () => reject(new Error(`${DB_NAME} is open in another tab`));
    // The store already exists in any real game; creating it here only matters
    // if the version bump fires on a database that predates it.
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
    };
  });
}

function writeSave(db: IDBDatabase, data: Uint8Array | string): Promise<void> {
  return new Promise((resolve, reject) => {
    const transaction = db.transaction([STORE], "readwrite");
    transaction.objectStore(STORE).put(data, KEY);
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(new Error("could not write the save"));
    transaction.onabort = () => reject(new Error("save write was aborted"));
  });
}

function hours(ms: number): string {
  return `${(ms / 3_600_000).toFixed(1)}h`;
}

export async function main(ns: NS): Promise<void> {
  const wanted = String(ns.args[0] ?? "");
  const raw = ns.read(PAYLOAD_FILE);
  if (raw === "") {
    ns.tprint(`ERROR: no ${PAYLOAD_FILE} on home. Run: bun run save:restore <id>`);
    return;
  }

  // The payload is one header line then base64 of the export bytes, so the
  // prompt can describe what it is about to overwrite without decoding first.
  const newline = raw.indexOf("\n");
  if (newline < 0) {
    ns.tprint("ERROR: malformed restore payload");
    return;
  }
  const header = JSON.parse(raw.slice(0, newline)) as PayloadHeader;
  if (wanted !== "" && wanted !== header.id) {
    ns.tprint(`ERROR: payload holds "${header.id}", not "${wanted}". Re-push with: bun run save:restore ${wanted}`);
    return;
  }

  // The live game, so a mismatch is visible BEFORE the irreversible step. This
  // is the whole safety interlock: there is no automatic backup.
  const reset = ns.getResetInfo();
  ns.tprint("=== RESTORE — this overwrites your current save and cannot be undone ===");
  ns.tprint(`  current : BN${reset.currentNode}, ${hours(Date.now() - reset.lastNodeReset)} into the node`);
  ns.tprint(`  restoring: "${header.id}" — BN${header.bitNode}, ${hours(header.playtimeSinceLastBitnode)} into the node`);
  if (reset.currentNode !== header.bitNode) {
    ns.tprint(`  NOTE: different BitNode (${reset.currentNode} -> ${header.bitNode})`);
  }

  const confirmed = await ns.prompt(
    `Overwrite the current save with "${header.id}" (BN${header.bitNode})? This cannot be undone.`,
    { type: "boolean" },
  );
  if (!confirmed) {
    ns.tprint("restore cancelled");
    return;
  }

  const bytes = decodeBase64(raw.slice(newline + 1).trim());
  const saveData = header.storage === "text" ? new TextDecoder().decode(bytes) : bytes;
  const db = await openDb();
  await writeSave(db, saveData);
  db.close();
  ns.tprint(`restored "${header.id}" — reloading...`);
  // Import schedules the reload after the durable transaction completes.
  // Source: https://github.com/bitburner-official/bitburner-src/blob/3162fd2590e221eadd0c0fbd46151913f7c4c41c/src/SaveObject.ts#L323-L335
  setTimeout(() => location.reload(), 0);
}
