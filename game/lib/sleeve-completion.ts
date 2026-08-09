import type { WorkTaskLike } from "./work-completion.ts";

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
