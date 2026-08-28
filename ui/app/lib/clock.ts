import { NONE } from "./dom.ts";
import { fmtTime } from "./format.ts";
import { html, type Html } from "./html.ts";
import type { ProjectedState } from "../project.ts";

/** The clock a panel must read, and the words for an age taken off it.
 *
 * Nothing in a panel may reach for `Date.now()` directly:
 *
 *  - A replay must use its recorded time base, not the current wall clock.
 *  - A SIMULATED run does not use wall time at all. Records carry VIRTUAL
 *    timestamps (`sim/realm/timers.ts` installs the clock under the real
 *    controller), so subtracting them from `Date.now()` is subtracting two
 *    different units.
 *  - A frozen topic must age against the newest record the viewer holds.
 *
 * So the clock is the run's own newest observation, and wall time is consulted
 * only for a live GAME run — where the records are `Date.now()`-stamped anyway
 * and the dispatcher's 1 Hz publish would otherwise make every age lag a
 * second behind the truth. */

export function nowFor(state: ProjectedState): number {
  if (state.live && state.src === "game") return Math.max(state.lastT, Date.now());
  return state.lastT || Date.now();
}

/** How long ago `at` was observed, in the run's own time base; `undefined` when
 * there is no stamp to measure.
 *
 * Clamped at zero rather than allowed to go negative: a topic can be stamped a
 * few milliseconds after the record the clock was derived from, and "-40ms ago"
 * is the kind of detail that makes a reader distrust the whole panel. */
export function ageMs(state: ProjectedState, at: number | undefined | null): number | undefined {
  if (at === undefined || at === null || !Number.isFinite(at)) return undefined;
  return Math.max(0, nowFor(state) - at);
}

/** An age as words: `now`, `3.2m ago`, or the empty-value dash.
 *
 * The point is that an UNSTAMPED reading and a FRESH one cannot come out the
 * same. A panel that prints an outcome with no age lets the last failure of an
 * hour ago read as the current state, which is the single most common way these
 * tabs mislead. */
export function ago(state: ProjectedState, at: number | undefined | null): string {
  const age = ageMs(state, at);
  if (age === undefined) return NONE;
  return age < 1_000 ? "now" : `${fmtTime(age)} ago`;
}

/** The same reading as a muted trailing fragment, for a line that already says
 * what happened: `outcome(plan.lastResult) + stamp(state, plan.lastResult.at)`.
 *
 * `Html`, not a string, so it can be dropped into a TEXT slot (a tile value, a
 * note) without the markup being printed at the operator. */
export function stamp(state: ProjectedState, at: number | undefined | null, prefix = ""): Html {
  const age = ageMs(state, at);
  if (age === undefined) return html`<span class="muted" title="nothing on the wire says when this was observed">unstamped</span>`;
  return html`<span class="muted" title="measured against the newest record in this run, not against the wall clock">${prefix}${ago(state, at)}</span>`;
}

/** Past this, a reading is old enough that presenting it as current is a lie.
 *
 * Deliberately generous and deliberately one number: a per-topic expiry is a
 * claim about that topic's publish rate, and the only place in this repository
 * that gets to make such a claim from evidence is the darknet's own rate table
 * (`shared/strategy/dnet/rates.ts`). This is the viewer's blunt "you are
 * looking at something that stopped moving" mark. */
export const STALE_AFTER_MS = 60_000;

export function isStale(state: ProjectedState, at: number | undefined | null, afterMs = STALE_AFTER_MS): boolean {
  const age = ageMs(state, at);
  return age !== undefined && age > afterMs;
}
