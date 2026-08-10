/** ScriptDeath is Bitburner's normal cancellation marker: it is thrown out of
 * a pending delaying ns call when the script is killed, and every later ns call
 * checks the same stop flag. It is not a failure, and nothing may swallow it —
 * a caught ScriptDeath that does not propagate turns "this script was killed"
 * into a silent retry loop.
 * Source: https://github.com/bitburner-official/bitburner-src/blob/3162fd2590e221eadd0c0fbd46151913f7c4c41c/src/Netscript/NetscriptHelpers.tsx#L398-L431 */
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
