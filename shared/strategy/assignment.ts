/** Independent assignment over a small set of agents and tasks. */

export interface AssignmentResult<A, T> {
  /** Chosen task per agent, in agent order. */
  choices: { agent: A; task: T; score: number }[];
  /** Objective value of the chosen assignment. */
  total: number;
  /** True when the search was capped and the answer is greedy, not exact. */
  approximated: boolean;
}

/** Every agent independently takes its highest-scoring task. Exact whenever
 * the agents' payoffs do not interact. */
export function assignIndependent<A, T>(
  agents: readonly A[],
  tasks: readonly T[],
  score: (agent: A, task: T) => number,
  label: (task: T) => string,
): AssignmentResult<A, T> {
  const choices: AssignmentResult<A, T>["choices"] = [];
  let total = 0;
  for (const agent of agents) {
    let best: { task: T; score: number } | undefined;
    for (const task of tasks) {
      const value = score(agent, task);
      // Deterministic tie-break on the task's label, so the answer never
      // depends on the order tasks arrived in.
      if (!best || value > best.score || (value === best.score && label(task) < label(best.task))) {
        best = { task, score: value };
      }
    }
    if (!best) continue;
    choices.push({ agent, task: best.task, score: best.score });
    total += best.score;
  }
  return { choices, total, approximated: false };
}

/** Exhaustive search over every assignment of agents to tasks.
 *
 * Exact, and exponential — `tasks^agents`. The caller passes `maxCombinations`
 * as an explicit budget; above it this falls back to the independent argmax
 * and SAYS SO via `approximated`, because a silently-approximate answer
 * presented as exact is worse than a slower one. */
export function assignCoupled<A, T>(
  agents: readonly A[],
  tasks: readonly T[],
  /** Objective for a whole assignment — this is where coupling lives. */
  objective: (assignment: { agent: A; task: T }[]) => number,
  score: (agent: A, task: T) => number,
  label: (task: T) => string,
  maxCombinations = 200_000,
): AssignmentResult<A, T> {
  if (agents.length === 0 || tasks.length === 0) return { choices: [], total: 0, approximated: false };

  const combinations = Math.pow(tasks.length, agents.length);
  if (!Number.isFinite(combinations) || combinations > maxCombinations) {
    const greedy = assignIndependent(agents, tasks, score, label);
    return { ...greedy, total: objective(greedy.choices.map((c) => ({ agent: c.agent, task: c.task }))), approximated: true };
  }

  let bestAssignment: { agent: A; task: T }[] = [];
  let bestTotal = -Infinity;
  const current: { agent: A; task: T }[] = [];

  const recurse = (index: number): void => {
    if (index === agents.length) {
      const value = objective(current);
      if (value > bestTotal) {
        bestTotal = value;
        bestAssignment = current.map((entry) => ({ ...entry }));
      }
      return;
    }
    for (const task of tasks) {
      current.push({ agent: agents[index]!, task });
      recurse(index + 1);
      current.pop();
    }
  };
  recurse(0);

  return {
    choices: bestAssignment.map((entry) => ({ ...entry, score: score(entry.agent, entry.task) })),
    total: bestTotal,
    approximated: false,
  };
}
