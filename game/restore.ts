import type { NS } from "@ns";

/** Restore a saved snapshot into the running game.
 *
 * DESTRUCTIVE, and deliberately its own entrypoint rather than anything
 * start.js can reach: it overwrites the live save with a file pushed from the
 * repository, and there is no undo. Keeping it separate means the controller
 * never carries a code path that can clobber real progress, and never pays RAM
 * for one.
 *
 * How it works (bitburner-src/src/db.ts and SaveObject.ts @ v3.0.1): the save
 * lives in IndexedDB under database `bitburnerSave` version 2, object store
 * `savestring`, key `save`, holding exactly the bytes Export Game writes. So
 * restoring is: write those bytes back, then reload — which is what the game's
 * own importGame does.
 *
 * RAM: 0 GB beyond the 1.6 GB base. indexedDB, atob and location are browser
 * globals, and ns.read / ns.prompt / ns.getResetInfo are all free.
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
    // The store already exists in any real game; creating it here only matters
    // if the version bump fires on a database that predates it.
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
    };
  });
}

function writeSave(db: IDBDatabase, data: Uint8Array): Promise<void> {
  return new Promise((resolve, reject) => {
    const transaction = db.transaction([STORE], "readwrite");
    transaction.objectStore(STORE).put(data, KEY);
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(new Error("could not write the save"));
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
  const db = await openDb();
  await writeSave(db, bytes);
  db.close();
  ns.tprint(`restored "${header.id}" — reloading...`);
  // importGame does exactly this: write, then a hard reload.
  location.reload();
}
