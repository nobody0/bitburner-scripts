/** Event bridge for Task.nextCompletion.
 *
 * `getCurrentWork()` returns the work object's cached `nextCompletion` promise.
 * It resolves on the next completion OR cancellation; callers therefore disarm
 * before replacing work deliberately. Dodge closures and the controller share
 * one JavaScript realm, so a short-lived probe can attach this listener and
 * exit instead of trying to reconstruct progress from `cyclesWorked`.
 * Source: https://github.com/bitburner-official/bitburner-src/blob/3162fd2590e221eadd0c0fbd46151913f7c4c41c/src/Work/Work.ts#L5-L22 and https://github.com/bitburner-official/bitburner-src/blob/3162fd2590e221eadd0c0fbd46151913f7c4c41c/src/ScriptEditor/NetscriptDefinitions.d.ts#L1747-L1763 */

export interface WorkTaskLike {
  type: string;
  nextCompletion?: Promise<void>;
  cyclesWorked?: number;
  factionName?: unknown;
  factionWorkType?: unknown;
  companyName?: unknown;
  crimeType?: unknown;
  classType?: unknown;
  programName?: unknown;
  augmentation?: unknown;
}

export interface WorkCompletionNotice {
  type: string;
  detail?: string;
  at: number;
}

interface WorkCompletionGlobals {
  workPromise?: Promise<void>;
  workToken?: number;
  workNotice?: WorkCompletionNotice;
  workChanged?: boolean;
}

type CompletionGlobalThis = typeof globalThis & WorkCompletionGlobals;

function globals(): CompletionGlobalThis {
  return globalThis as CompletionGlobalThis;
}

export function workDetail(task: WorkTaskLike): string | undefined {
  const detail = task.factionName ?? task.companyName ?? task.crimeType ?? task.classType ?? task.programName ?? task.augmentation;
  return detail === undefined ? undefined : String(detail);
}

export function armWorkCompletion(task: WorkTaskLike): void {
  // Tests, older game builds, and capability-gated mock objects may expose the
  // task digest without the v3 completion promise. Do not invent a completion.
  if (!task.nextCompletion || typeof task.nextCompletion.then !== "function") return;
  const g = globals();
  if (g.workPromise === task.nextCompletion) return;

  const token = (g.workToken ?? 0) + 1;
  g.workToken = token;
  g.workPromise = task.nextCompletion;
  g.workChanged = true;
  const type = String(task.type);
  const detail = workDetail(task);

  void task.nextCompletion.then(
    () => {
      if (globals().workToken !== token) return;
      g.workPromise = undefined;
      g.workNotice = { type, ...(detail !== undefined ? { detail } : {}), at: Date.now() };
    },
    () => {
      // A rejected task promise is not a completion. The next observation can
      // arm the replacement task without making an unsafe switch now.
      if (globals().workToken === token) g.workPromise = undefined;
    },
  );
}

/** Invalidate a listener before deliberately replacing work. Its cancellation
 * promise will resolve, but must not masquerade as a completed unit. */
export function disarmWorkCompletion(): void {
  const g = globals();
  g.workToken = (g.workToken ?? 0) + 1;
  g.workPromise = undefined;
}

export function peekWorkCompletion(): WorkCompletionNotice | undefined {
  return globals().workNotice;
}

export function workCompletionArmed(): boolean {
  return globals().workPromise !== undefined;
}

export function workChangedPending(): boolean {
  return globals().workChanged === true;
}

export function consumeWorkChanged(): void {
  globals().workChanged = false;
}

export function consumeWorkCompletion(): WorkCompletionNotice | undefined {
  const g = globals();
  const notice = g.workNotice;
  g.workNotice = undefined;
  return notice;
}

export function resetWorkCompletion(): void {
  const g = globals();
  g.workToken = (g.workToken ?? 0) + 1;
  g.workPromise = undefined;
  g.workNotice = undefined;
  g.workChanged = false;
}
