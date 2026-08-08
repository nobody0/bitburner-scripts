/** Scheduling policy for Player.currentWork.
 *
 * The game has two materially different kinds of work:
 * - continuous work pays every 200 ms engine cycle and is safe to replace;
 * - progress work only banks its value at completion and loses the partial
 *   unit when replaced.
 *
 * Keep this pure. The game-side completion watcher supplies the event; this
 * module only decides whether that event (or the wall clock) makes a review
 * due. */

export const CONTINUOUS_REVIEW_MS = 5_000;

export type CareerWorkMode = "idle" | "continuous" | "progress";
export type CareerReviewReason = "idle" | "completion" | "continuous-interval" | "initial";

export function careerWorkMode(type: string | undefined): CareerWorkMode {
  switch (type?.toUpperCase()) {
    case undefined:
      return "idle";
    case "CRIME":
    case "CREATE_PROGRAM":
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
