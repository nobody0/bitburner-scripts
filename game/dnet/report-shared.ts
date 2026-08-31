import type { Report } from "./shared.ts";

/** Pure report-shaping helpers shared by the order bodies.
 *
 * `orders.ts`, `attempt.ts` and `walk.ts` each carried private copies of these,
 * and three copies of a response-code mapping is how a new code gets handled in
 * two places and missed in the third. Everything here is plain string/number
 * code — no `ns` member is referenced, so under the by-member-name RAM rule the
 * order bodies' file headers describe, sharing it costs nothing. */

/** Every read drains the complete upstream ring. A target-owned pending count
 * preserves any records that cannot be read yet because charisma is too low. */
export const LOG_LINES = 200;

/** At most this many distinct unparsed lines per job. Drift normally shows up in
 * the first one or two; a whole bleed's worth would repeat the same line. */
export const LINES_PER_JOB = 2;

/** Enough of a line to write the parser fix against; the rest is more of the
 * same. BOUNDED because a line is not a shape any more: it travels on the wire
 * report, is kept as a KEY in the controller's recovery blob and the `dnet`
 * topic, and is rendered into a table. A log ring line is generated text of no
 * declared maximum, so without this one pathological line becomes a map key of
 * that length in three places at once. */
export const LINE_MAX = 160;

/** What a bleed learned about our own parser. Undefined when nothing was
 * unrecognised, so the common case adds no field. */
export function grammarDrift(
  unrecognised: readonly string[],
): { unrecognised: number; lines: string[] } | undefined {
  if (unrecognised.length === 0) return undefined;
  const lines: string[] = [];
  for (const raw of unrecognised) {
    const line = raw.slice(0, LINE_MAX);
    if (line.length > 0 && !lines.includes(line)) lines.push(line);
    if (lines.length >= LINES_PER_JOB) break;
  }
  return { unrecognised: unrecognised.length, lines };
}

/** The two response codes that say something about the TARGET rather than the
 * attempt: 351 means the edge is gone, 503 means the host is. */
export function targetStateFor(code: number): Pick<Report, "targetState"> {
  if (code === 351) return { targetState: "edge-lost" };
  if (code === 503) return { targetState: "gone" };
  return {};
}
