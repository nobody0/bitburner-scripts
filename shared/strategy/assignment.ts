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
