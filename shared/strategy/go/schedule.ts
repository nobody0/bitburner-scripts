import type { GoGameCandidate } from "./rewards.ts";

/** New-game scheduling over the ranked candidate list.
 *
 * The ranker already prices alignment waits into `utilityPerSec`, so the top
 * candidate is the right THING to play — this module decides what to do with
 * the wall-clock until it can start. Three answers: start it now, start a
 * whole different game that finishes inside the wait window (a filler is
 * near-free — streaks are per-opponent, so it cannot break the preferred
 * opponent's favor cadence), or hold the cadence and re-plan.
 *
 * Pure so the sim can exercise every branch without the worker RPC. */

export interface GoScheduleView {
  /** rankGoGames output, best first. */
  candidates: readonly GoGameCandidate[];
  /** Driver pass cadence in seconds — a wait at most this long is "now". */
  cadenceSec: number;
  /** Safety factor on a filler's expected duration: overrunning the window
   * forfeits the preferred entry and re-plans onto the next recurrence. */
  fillerMarginFactor: number;
  /** Reset dispatch + first-turn planning allowance, seconds. */
  fillerOverheadSec: number;
}

export type GoSchedule =
  | { kind: "play"; game: GoGameCandidate; why: string }
  | { kind: "filler"; game: GoGameCandidate; preferred: GoGameCandidate; why: string }
  | { kind: "hold"; preferred: GoGameCandidate; resumeInSec: number; why: string };

export function planGoSchedule(view: GoScheduleView): GoSchedule | undefined {
  const preferred = view.candidates[0];
  if (!preferred) return undefined;
  if (preferred.waitSec <= view.cadenceSec) {
    return {
      kind: "play",
      game: preferred,
      why: preferred.aligned
        ? `certified entry within the ${view.cadenceSec}s cadence`
        : "best candidate is available now",
    };
  }
  // The window is real. A candidate that starts now and completes — with
  // margin — before the preferred entry tick costs nothing: pick the most
  // valuable one that fits. "Free" holds only for a DIFFERENT opponent —
  // streaks and their favor cadence are per-opponent, so the preferred
  // opponent's own unaligned variant would move the very streak the aligned
  // candidate was priced against (a loss resets it outright).
  const filler = view.candidates.find((candidate) =>
    candidate.opponent !== preferred.opponent
    && candidate.waitSec === 0
    && candidate.expectedGameSec * view.fillerMarginFactor + view.fillerOverheadSec <= preferred.waitSec,
  );
  if (filler) {
    return {
      kind: "filler",
      game: filler,
      preferred,
      why: `${filler.opponent} (~${Math.round(filler.expectedGameSec)}s) fits inside the ${Math.round(preferred.waitSec)}s ${preferred.opponent} entry window`,
    };
  }
  return {
    kind: "hold",
    preferred,
    resumeInSec: preferred.waitSec,
    why: `no game fits the ${Math.round(preferred.waitSec)}s window before ${preferred.opponent}'s certified entry`,
  };
}
