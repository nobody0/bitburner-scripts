/** Scheduling policy for Player.currentWork.
 *
 * The game has two materially different kinds of work:
 * - continuous work pays every 200 ms engine cycle and is safe to replace;
 * - progress work only banks its value at completion and loses the partial
 *   unit when replaced.
 *
 * Keep this pure. The game-side completion watcher supplies the event; this
 * module only decides whether that event (or the wall clock) makes a review
 * due.
 *
 * CrimeWork's `cyclesWorked` is cumulative across its repeating units; the
 * unexposed `unitCompleted` is reduced after each completion.
 * https://github.com/bitburner-official/bitburner-src/blob/3162fd2590e221eadd0c0fbd46151913f7c4c41c/src/Work/CrimeWork.ts#L34-L49 */

export const CONTINUOUS_REVIEW_MS = 5_000;

/** One engine cycle. `cyclesWorked` counts these, so it is the unit that turns
 *  observed progress into elapsed milliseconds. */
export const ENGINE_CYCLE_MS = 200;

/** When the progress task in flight will BANK, from the game's own numbers.
 *
 * This is the boundary the slot lock exists to protect, and it is the boundary at
 * which the job should be re-chosen. `undefined` means we cannot tell — see
 * `progressLockUntil` for why that must NOT be treated as "hold for ever".
 *
 * Not a guess: `totalMs` is the duration the game reports for this exact
 * activity and `cyclesWorked` is the work object's observed cycle count. For
 * repeating CrimeWork, cumulative cycles are reduced modulo one unit before
 * computing the remainder. */
export function progressBanksAt(input: {
  mode: CareerWorkMode;
  /** Duration of the activity in flight, from the crime or graft table. */
  totalMs: number | undefined;
  cyclesWorked: number | undefined;
  /** When `getCurrentWork` produced the observation the cycles came from. */
  observedAt: number | undefined;
  /** Repeating work exposes cumulative cycles, so progress is modulo one unit. */
  repeating?: boolean;
}): number | undefined {
  if (input.mode !== "progress") return undefined;
  if (input.totalMs === undefined || input.observedAt === undefined) return undefined;
  let spentMs = Math.max(0, input.cyclesWorked ?? 0) * ENGINE_CYCLE_MS;
  if (input.repeating && input.totalMs > 0) spentMs %= input.totalMs;
  return input.observedAt + Math.max(0, input.totalMs - spentMs);
}

/** Whether the slot lock still applies, and until when.
 *
 * The lock is bounded by the moment the progress actually banks. Before it, the
 * lock is real and absolute — cancelling a crime at 99% throws the whole thing away.
 * After it, career competes for the slot at its ordinary band, so the end of a crime
 * is a fair re-evaluation rather than an automatic renewal.
 *
 * An unknown boundary yields NO lock, which is the deliberate direction. A lock we
 * cannot bound is a lock we cannot guarantee to release; losing one partial crime
 * is recoverable. In practice
 * `undefined` only happens before the crime table has been probed, which is brief.
 *
 * Continuous work is never locked: it banks every engine cycle, so it can be
 * replaced at any moment and there is nothing to protect. */
export function progressLockUntil(input: {
  mode: CareerWorkMode;
  totalMs: number | undefined;
  cyclesWorked: number | undefined;
  observedAt: number | undefined;
  repeating?: boolean;
  /** A banked-progress notice already in hand ends the lock immediately. */
  completionPending: boolean;
  now: number;
}): number | undefined {
  if (input.completionPending) return undefined;
  const banksAt = progressBanksAt(input);
  if (banksAt === undefined) return undefined;
  return input.now < banksAt ? banksAt : undefined;
}

export type CareerWorkMode = "idle" | "continuous" | "progress";
export type CareerReviewReason = "idle" | "completion" | "continuous-interval" | "initial";

export function careerWorkMode(type: string | undefined): CareerWorkMode {
  switch (type?.toUpperCase()) {
    case undefined:
      return "idle";
    case "CRIME":
    case "GRAFTING":
      return "progress";
    default:
      return "continuous";
  }
}

export interface CareerScheduleInput {
  now: number;
  lastReviewedAt?: number;
  currentWorkType?: string;
  completionPending: boolean;
}

export interface CareerSchedule {
  due: boolean;
  mode: CareerWorkMode;
  reason?: CareerReviewReason;
  nextReviewAt?: number;
}

/** A measured cumulative counter sampled at a faster cadence than its probe.
 * `at` advances only when a real observation window begins or produces value;
 * unchanged intermediary samples must not shorten that window. */
export interface ActivityRateSample {
  value: number;
  at: number;
  active: boolean;
  perSec?: number;
}

export function updateActivityRate(
  previous: ActivityRateSample | undefined,
  value: number,
  now: number,
  active: boolean,
): ActivityRateSample {
  if (!previous || previous.active !== active || value < previous.value) {
    return { value, at: now, active, ...(previous?.perSec !== undefined ? { perSec: previous.perSec } : {}) };
  }
  if (active && value > previous.value && now > previous.at) {
    return { value, at: now, active, perSec: (value - previous.value) / ((now - previous.at) / 1_000) };
  }
  return previous;
}

export function careerSchedule(input: CareerScheduleInput): CareerSchedule {
  const mode = careerWorkMode(input.currentWorkType);
  if (input.lastReviewedAt === undefined) return { due: true, mode, reason: "initial" };
  if (input.completionPending) return { due: true, mode, reason: "completion" };
  if (mode === "idle") return { due: true, mode, reason: "idle" };
  if (mode === "progress") return { due: false, mode };

  const nextReviewAt = input.lastReviewedAt + CONTINUOUS_REVIEW_MS;
  return input.now >= nextReviewAt
    ? { due: true, mode, reason: "continuous-interval", nextReviewAt }
    : { due: false, mode, nextReviewAt };
}
