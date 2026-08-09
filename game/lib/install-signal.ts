/** One-shot rendezvous between `factions` and `progression`, same shape as
 * work-completion.ts: factions raises it when its final-sweep drain concludes
 * (install recommended, nothing left to buy), and progression's wake consumes
 * it so the install evaluation runs on the NEXT controller pass instead of up
 * to a full 60-second cadence later. Measured on factions-install: the drain
 * finishes in seconds, then the install waited out the rest of the minute.
 *
 * Observation-only on the wake side, per the FeatureDriver.wake contract: the
 * signal carries no data, only "worth re-evaluating now". */

let pending = false;

export function signalInstallCheck(): void {
  pending = true;
}

/** Consume the signal. Single consumer: progression's wake. */
export function takeInstallSignal(): boolean {
  const was = pending;
  pending = false;
  return was;
}

export function resetInstallSignal(): void {
  pending = false;
}
