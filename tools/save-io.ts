import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { decodeSaveJson } from "../shared/save/decode.ts";
import type { SaveSnapshot } from "../shared/save/snapshot.ts";

/** Save file IO and the snapshot registry.
 *
 * The bytes half of the save story: shared/save/decode.ts is pure and takes a
 * string, so gunzip, base64 and the filesystem live here.
 *
 * What Export Game writes (bitburner-src/src/utils/SaveDataUtils.ts @ v3.0.1):
 * raw gzip bytes of the save JSON, named bitburnerSave_<epoch>_BN<n>x<lvl>.json.gz.
 * Two other encodings must be accepted because Import does:
 *   - plain base64 of the JSON, when the browser lacks CompressionStream
 *   - base64 of the gzip bytes, the Steam Cloud format */

export const SAVES_DIR = fileURLToPath(new URL("../saves", import.meta.url));
export const INDEX_FILE = path.join(SAVES_DIR, "index.json");

export interface SaveEntry {
  id: string;
  label: string;
  file: string;
  bitNode: number;
  /** Wall-clock ms when the snapshot was registered. */
  capturedAt: number;
  /** Game playtime in the current BitNode, ms — the useful "when" for a save. */
  playtimeSinceLastBitnode: number;
  /** SHA-256 of the registered file's exact bytes. Optional only for legacy
   * index entries; every newly registered checkpoint records it. */
  sha256?: string;
  /** Written by the simulator from a derived route-leg entrance rather than
   * exported from a real game. Such a blob satisfies the simulator's decoder,
   * but the repo cannot verify the full key set the live game requires (no
   * vendored SaveObject.ts), so save-restore refuses it. */
  minted?: true;
  notes?: string;
}

export interface SaveIndex {
  saves: SaveEntry[];
}

function isGzip(bytes: Uint8Array): boolean {
  return bytes[0] === 0x1f && bytes[1] === 0x8b && bytes[2] === 0x08;
}

/** Steam Cloud writes base64 OF the gzip bytes; "H4sI" is base64 of 1f 8b 08. */
function isSteamCloud(bytes: Uint8Array): boolean {
  return new TextDecoder().decode(bytes.subarray(0, 4)) === "H4sI";
}

/** Convert any accepted file encoding to the exact SaveData variant that
 * v3.0.1 expects in IndexedDB. Binary saves must be raw gzip bytes; the
 * browser fallback must remain a base64 string (a Uint8Array containing that
 * string is interpreted as gzip by decodeSaveData).
 * Source: https://github.com/bitburner-official/bitburner-src/blob/3162fd2590e221eadd0c0fbd46151913f7c4c41c/src/utils/SaveDataUtils.ts#L37-L70 */
export function prepareIndexedDbSave(bytes: Uint8Array): { storage: "binary" | "text"; bytes: Uint8Array } {
  if (isGzip(bytes)) return { storage: "binary", bytes };
  if (isSteamCloud(bytes)) {
    return { storage: "binary", bytes: new Uint8Array(Buffer.from(new TextDecoder().decode(bytes), "base64")) };
  }
  return { storage: "text", bytes };
}

/** Raw export bytes -> the save's JSON string. */
export function decodeSaveData(bytes: Uint8Array<ArrayBuffer>): string {
  if (isGzip(bytes)) return new TextDecoder().decode(Bun.gunzipSync(bytes));
  if (isSteamCloud(bytes)) {
    const inner = Buffer.from(new TextDecoder().decode(bytes), "base64");
    const gz = new Uint8Array(new ArrayBuffer(inner.byteLength));
    gz.set(inner);
    return new TextDecoder().decode(Bun.gunzipSync(gz));
  }
  // Otherwise it is the base64 fallback format: base64 of the UTF-8 JSON.
  const text = new TextDecoder().decode(bytes);
  if (text.startsWith('{"ctor"')) {
    throw new Error(
      "this looks like an already-decompressed save; import the original .json.gz that Export Game produced",
    );
  }
  return Buffer.from(text, "base64").toString("utf8");
}

export function readSnapshot(file: string): SaveSnapshot {
  const full = path.isAbsolute(file) ? file : path.join(SAVES_DIR, file);
  if (!existsSync(full)) {
    throw new Error(`save file not found: ${full}`);
  }
  return decodeSaveJson(decodeSaveData(new Uint8Array(readFileSync(full))));
}

export function readIndex(): SaveIndex {
  if (!existsSync(INDEX_FILE)) return { saves: [] };
  return JSON.parse(readFileSync(INDEX_FILE, "utf8")) as SaveIndex;
}

export function writeIndex(index: SaveIndex): void {
  mkdirSync(SAVES_DIR, { recursive: true });
  writeFileSync(INDEX_FILE, JSON.stringify(index, null, 2) + "\n");
}

export function findSave(id: string): SaveEntry {
  const entry = readIndex().saves.find((save) => save.id === id);
  if (!entry) {
    const known = readIndex().saves.map((save) => save.id);
    throw new Error(`unknown save "${id}"${known.length > 0 ? ` (have: ${known.join(", ")})` : " (saves/ is empty)"}`);
  }
  return entry;
}

/** Content identity for route checkpoint lineage. Reusing a registry id for
 * different bytes must not silently preserve downstream benchmark validity. */
export function saveFileSha256(entry: SaveEntry): string {
  const full = path.isAbsolute(entry.file) ? entry.file : path.join(SAVES_DIR, entry.file);
  if (!existsSync(full)) throw new Error(`save file not found: ${full}`);
  const actual = createHash("sha256").update(readFileSync(full)).digest("hex");
  if (entry.sha256 !== undefined && entry.sha256 !== actual) {
    throw new Error(
      `registered save "${entry.id}" changed bytes (index ${entry.sha256}, file ${actual}); ` +
      "register it under a new id or intentionally re-register it",
    );
  }
  return actual;
}

/** Register an exported save under an id. The blob is decoded once up front so
 * a corrupt file fails here rather than at the start of a simulation. */
export function registerSave(
  id: string,
  file: string,
  label?: string,
  details: { notes?: string; minted?: true } = {},
): SaveEntry {
  const { notes, minted } = details;
  const snapshot = readSnapshot(file);
  const source = path.isAbsolute(file) ? file : path.join(SAVES_DIR, file);
  const index = readIndex();
  const entry: SaveEntry = {
    id,
    label: label ?? id,
    file: path.basename(file),
    bitNode: snapshot.bitNode,
    capturedAt: Date.now(),
    playtimeSinceLastBitnode: snapshot.player.playtimeSinceLastBitnode,
    sha256: createHash("sha256").update(readFileSync(source)).digest("hex"),
    ...(minted ? { minted } : {}),
    ...(notes !== undefined ? { notes } : {}),
  };
  const existing = index.saves.findIndex((save) => save.id === id);
  if (existing >= 0) index.saves[existing] = entry;
  else index.saves.push(entry);
  writeIndex(index);
  return entry;
}

if (import.meta.main) {
  const [command, ...rest] = process.argv.slice(2);
  if (command === "list") {
    const index = readIndex();
    if (index.saves.length === 0) {
      console.log("no saves registered — drop an exported .json.gz in saves/ and run:");
      console.log("  bun run tools/save-io.ts add <id> <file> [label]");
    }
    for (const save of index.saves) {
      const hours = (save.playtimeSinceLastBitnode / 3_600_000).toFixed(1);
      console.log(`${save.id.padEnd(20)} BN${save.bitNode}  ${hours}h into the node  ${save.label}`);
    }
  } else if (command === "add") {
    const [id, file, label] = rest;
    if (!id || !file) throw new Error("usage: save-io.ts add <id> <file> [label]");
    const entry = registerSave(id, file, label);
    console.log(`registered ${entry.id}: BN${entry.bitNode}, ${entry.file}`);
  } else if (command === "show") {
    const [id] = rest;
    if (!id) throw new Error("usage: save-io.ts show <id>");
    const snapshot = readSnapshot(findSave(id).file);
    console.log(
      JSON.stringify(
        {
          bitNode: snapshot.bitNode,
          version: snapshot.version,
          activeSourceFiles: snapshot.activeSourceFiles,
          money: snapshot.player.money,
          skills: snapshot.player.skills,
          augmentations: snapshot.player.augmentations.length,
          factions: snapshot.player.factions,
          servers: snapshot.servers.size,
          homeRam: snapshot.servers.get("home")?.maxRam,
        },
        null,
        2,
      ),
    );
  } else {
    console.log("usage: save-io.ts <list|add|show>");
  }
}
