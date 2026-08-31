/** The directories a deployment writes into, derived from its build targets.
 *
 * Ownership is claimed by DIRECTORY, not by filename, and that is the whole
 * point: a renamed or retired artifact stops appearing in the keep set the
 * moment it leaves the config, and the sweep collects it without anyone
 * maintaining a list of names this project used to use. A hand-kept list is
 * wrong the first time someone forgets to update it.
 *
 * Targets at the root contribute nothing. The root is shared with the game and
 * the player — every file the game generates (.msg, .lit, .exe, .cct) lives
 * there and has no directory form — so we never claim it. */
export function ownedDirectories(targets: readonly string[]): Set<string> {
  const owned = new Set<string>();
  for (const target of targets) {
    const cut = target.lastIndexOf("/");
    if (cut > 0) owned.add(target.slice(0, cut + 1));
  }
  return owned;
}

/** True for a file the sync sweep may delete: a `.js` file directly inside a
 * directory this build writes into, that this build did not just push.
 *
 * The `.js` restriction is not decoration. Our owned directories contain
 * nothing else, so it costs us no coverage, and it means a player who saves
 * notes as `lib/notes.txt` keeps them. */
export function isSweepableFile(
  filename: string,
  owned: ReadonlySet<string>,
  keep: ReadonlySet<string>,
): boolean {
  if (keep.has(filename)) return false;
  if (!filename.endsWith(".js")) return false;
  const cut = filename.lastIndexOf("/");
  if (cut <= 0) return false;
  return owned.has(filename.slice(0, cut + 1));
}

/** Repository/game rendezvous for an already-staged deployment. */
export const SYNC_CONTROL_FILE = "sync-control.txt";

export interface SyncControl {
  id: string;
  hosts: string[];
}

export function parseSyncControl(raw: string | undefined): SyncControl | undefined {
  if (!raw?.trim()) return undefined;
  try {
    const value = JSON.parse(raw) as Record<string, unknown>;
    if (typeof value["id"] !== "string" || value["id"] === "") return;
    const hosts = value["hosts"];
    if (!Array.isArray(hosts) || hosts.some((host) => typeof host !== "string" || host === "")) return;
    return { id: value["id"], hosts: [...new Set(hosts as string[])] };
  } catch {
    return undefined;
  }
}

export function syncControl(control: SyncControl): string {
  return JSON.stringify(control);
}
