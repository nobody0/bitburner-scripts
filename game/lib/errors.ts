/** ScriptDeath is Bitburner's normal cancellation marker: it is thrown out of
 * any pending ns call when the script is killed, the game reloads, or a build
 * handoff kills the old instance. It is not a failure, and nothing may swallow
 * it — a caught ScriptDeath that does not propagate turns "this script was
 * killed" into a silent retry loop. */
export function isScriptDeath(error: unknown): boolean {
  return error instanceof Error && error.name === "ScriptDeath";
}

export function errorDetails(error: unknown): { name: string; message: string; stack?: string } {
  if (!(error instanceof Error)) return { name: "UnknownError", message: String(error) };
  return {
    name: error.name,
    message: error.message,
    ...(error.stack ? { stack: error.stack } : {}),
  };
}
