import type { Report } from "./shared.ts";
import { logShape } from "../../shared/strategy/dnet/oracle.ts";

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

/** At most this many distinct shapes per job. Drift shows up in the first one or
 * two; a whole bleed's worth would be a list of the same shape. */
export const SHAPES_PER_JOB = 2;

/** What a bleed learned about our own parser, in a form that is safe to carry.
 *
 * The COUNT says the grammar has drifted; the shapes say which line drifted, and
 * `logShape` is what makes reporting them safe — see its comment. Undefined when
 * nothing was unrecognised, so the common case adds no field. */
export function grammarDrift(
  unrecognised: readonly string[],
): { unrecognised: number; shapes: string[] } | undefined {
  if (unrecognised.length === 0) return undefined;
  const shapes: string[] = [];
  for (const line of unrecognised) {
    const shape = logShape(line);
    if (shape.length > 0 && !shapes.includes(shape)) shapes.push(shape);
    if (shapes.length >= SHAPES_PER_JOB) break;
  }
  return { unrecognised: unrecognised.length, shapes };
}

/** The two response codes that say something about the TARGET rather than the
 * attempt: 351 means the edge is gone, 503 means the host is. */
export function targetStateFor(code: number): Pick<Report, "targetState"> {
  if (code === 351) return { targetState: "edge-lost" };
  if (code === 503) return { targetState: "gone" };
  return {};
}
