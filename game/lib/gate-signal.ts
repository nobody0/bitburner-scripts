/** One-shot rendezvous between `progression` and the controller's sweep, same
 * shape as install-signal.ts: progression raises it when it changes something
 * the capability gate reads (today: buying DarkscapeNavigator.exe), and the
 * controller consumes it to run the gate sweep on the NEXT pass instead of up
 * to a full 30-second sweep cadence later. Without it the dnet beachhead sits
 * launchable but locked, waiting on a probe that only re-reads the file on its
 * own schedule.
 *
 * Best-effort: if the gate lease comes back queued on that pass, the recheck
 * degrades to the ordinary sweep cadence. The signal carries no data, only
 * "worth re-evaluating now". */

let pending = false;

export function signalGateRecheck(): void {
  pending = true;
}

/** Consume the signal. Single consumer: the controller loop. */
export function takeGateSignal(): boolean {
  const was = pending;
  pending = false;
  return was;
}

export function resetGateSignal(): void {
  pending = false;
}
