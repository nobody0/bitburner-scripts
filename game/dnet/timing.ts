import type { AgentIo, DnetDelayRequest } from "./shared.ts";

/** Thrown into a body that the controller released from a call it was still
 * waiting on. Not a failure and not an error: the work simply stops here, and
 * the process goes on to its exit path and its next job. */
export const RELEASED = Symbol("dnet-released");

/** Await one delayed Darknet operation while exposing its best cached estimate,
 * and while remaining interruptible.
 *
 * The call itself cannot be cancelled — the engine will finish it in its own
 * time — but WAITING for it can be, and waiting is the only part that costs us
 * anything. So the body races the call against a release hook it publishes on
 * its handle. Whichever settles first wins: the ordinary path is unchanged, and
 * a controller that has decided this work no longer matters pulls the hook and
 * the body falls straight through to its exit path.
 *
 * This replaces hard-killing the process. `ns.kill` cost an ns call, ran the
 * victim's atExit inside the killer's stack, and could not happen until a later
 * derive pass — so a plant preempting a six-second phish waited out most of the
 * phish anyway.
 *
 * ## Walking away from the wait does NOT give the script back to us
 *
 * Bitburner allows a script ONE Netscript call at a time. While `call()` is
 * outstanding the engine holds `env.runningFn`, and every other `ns` member in
 * this process throws:
 *
 *     CONCURRENCY ERROR — Currently running: induceServerMigration,
 *                         Tried to run: getScriptName
 *
 * The exit path is made of `ns` calls (`getScriptName`, `spawn`, `atExit`), so
 * a released body used to walk out of its wait and straight into that throw —
 * which killed the respawn and left the host holding its prober alone. That is
 * the whole prober-only failure, and it hit hardest exactly where preemption
 * was most useful, because a released body is the only kind that reaches its
 * exit with a call still running.
 *
 * So the release publishes the outstanding call. The body stops waiting for
 * the RESULT immediately — the controller re-plans in that same instant, which
 * is what the release was for — and the process waits for the engine before it
 * touches `ns` again. Nothing here can shorten that: interrupting a call in
 * flight is `ns.kill` from another script and nothing else. */
export async function awaitDnetOperation<T>(
  io: AgentIo,
  request: DnetDelayRequest,
  call: () => Promise<T>,
): Promise<T> {
  const delay = io.deps.expectedDelayMs(request);
  io.setExpectedDoneAt(delay === undefined ? undefined : Date.now() + delay);
  let release!: () => void;
  const released = new Promise<never>((_, reject) => { release = () => reject(RELEASED); });
  const settled = call();
  // The engine's own result may land long after we stopped waiting for it,
  // and a process that has since exited turns that into a ScriptDeath.
  void settled.catch(() => {});
  try {
    io.hold(release);
    return await Promise.race([settled, released]);
  } catch (error) {
    if (error === RELEASED) io.inFlight(settled);
    throw error;
  } finally {
    io.hold(undefined);
    io.setExpectedDoneAt(undefined);
  }
}
