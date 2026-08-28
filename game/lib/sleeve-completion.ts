import type { SleeveDigest } from "../../shared/telemetry/topics/sleeves.ts";
import { workDetail, type WorkTaskLike } from "./work-completion.ts";

/** Sleeve tasks inherit the same cached nextCompletion promise as player work;
 * getTask returns the current work's API copy containing that live promise.
 * Source: https://github.com/bitburner-official/bitburner-src/blob/3162fd2590e221eadd0c0fbd46151913f7c4c41c/src/Work/Work.ts#L7-L22
 * Source: https://github.com/bitburner-official/bitburner-src/blob/3162fd2590e221eadd0c0fbd46151913f7c4c41c/src/PersonObjects/Sleeve/Work/Work.ts#L27-L38
 * Source: https://github.com/bitburner-official/bitburner-src/blob/3162fd2590e221eadd0c0fbd46151913f7c4c41c/src/NetscriptFunctions/Sleeve.ts#L184-L192 */

interface SleeveCompletionState {
  tokens: Map<number, number>;
  promises: Map<number, Promise<void>>;
  notices: Set<number>;
}

type SleeveGlobal = typeof globalThis & { sleeveCompletionState?: SleeveCompletionState };

function state(): SleeveCompletionState {
  const root = globalThis as SleeveGlobal;
  return (root.sleeveCompletionState ??= { tokens: new Map(), promises: new Map(), notices: new Set() });
}

export function armSleeveCompletion(index: number, task: WorkTaskLike | null): void {
  const s = state();
  if (!task?.nextCompletion || typeof task.nextCompletion.then !== "function") {
    if (s.promises.has(index)) {
      s.tokens.set(index, (s.tokens.get(index) ?? 0) + 1);
      s.promises.delete(index);
    }
    return;
  }
  if (s.promises.get(index) === task.nextCompletion) return;
  const token = (s.tokens.get(index) ?? 0) + 1;
  s.tokens.set(index, token);
  s.promises.set(index, task.nextCompletion);
  void task.nextCompletion.then(
    () => {
      if (state().tokens.get(index) !== token) return;
      s.promises.delete(index);
      s.notices.add(index);
    },
    () => {
      if (state().tokens.get(index) === token) s.promises.delete(index);
    },
  );
}

/** Invalidate a listener before deliberately replacing a sleeve task. The
 * old task's finish() resolves nextCompletion, which is cancellation rather
 * than evidence that a repeatable unit completed naturally. */
export function disarmSleeveCompletion(index: number): void {
  const s = state();
  s.tokens.set(index, (s.tokens.get(index) ?? 0) + 1);
  s.promises.delete(index);
}

/** Normalize the public SleeveTask union once for both probe and driver
 * readback. Fields that do not exist stay absent; an empty-string detail makes
 * RECOVERY and SYNCHRO look different from their planned task every pass. */
export function sleeveTaskDigest(task: WorkTaskLike | null): SleeveDigest["task"] | undefined {
  if (!task) return undefined;
  const detail = workDetail(task);
  return {
    type: String(task.type),
    ...(detail !== undefined ? { detail } : {}),
    ...(task.factionWorkType !== undefined ? { workType: String(task.factionWorkType) } : {}),
  };
}

export function pendingSleeveCompletions(): ReadonlySet<number> {
  return state().notices;
}

export function consumeSleeveCompletion(index: number): void {
  state().notices.delete(index);
}

export function resetSleeveCompletions(): void {
  const s = state();
  for (const index of s.tokens.keys()) s.tokens.set(index, (s.tokens.get(index) ?? 0) + 1);
  s.promises.clear();
  s.notices.clear();
}
