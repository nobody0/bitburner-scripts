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
