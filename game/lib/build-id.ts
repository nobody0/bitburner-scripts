/** The bundler replaces __BUILD_ID__ in game artifacts. Resolve lazily because
 * the simulator installs compile flags after host-side modules may already be
 * cached by the test runner. */
export function gameBuildId(): string {
  return typeof __BUILD_ID__ === "undefined" ? "dev" : __BUILD_ID__;
}
