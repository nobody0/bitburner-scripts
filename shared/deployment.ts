/** Turn a stable script name into the immutable filename for one build.
 *
 * The build id is already baked into every game bundle. Reusing it here keeps
 * the controller and its helper artifacts on exactly the same version without
 * introducing a mutable counter that can collide across branches or concurrent
 * builds. */
export function versionedScript(filename: string, buildId: string): string {
  if (!filename.endsWith(".js")) throw new Error(`script filename must end in .js: ${filename}`);
  if (!/^[a-z0-9-]+$/i.test(buildId)) throw new Error(`invalid build id: ${buildId}`);
  return `${filename.slice(0, -3)}.${buildId}.js`;
}

/** True for the stable legacy name or any build-id-qualified member of the
 * same script family. Used by the fleet reaper during build handoffs. */
export function isScriptVersion(filename: string, stableName: string): boolean {
  if (filename === stableName) return true;
  if (!stableName.endsWith(".js")) return false;
  const stem = stableName.slice(0, -3);
  if (!filename.startsWith(`${stem}.`) || !filename.endsWith(".js")) return false;
  return /^[a-z0-9-]+$/i.test(filename.slice(stem.length + 1, -3));
}

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
