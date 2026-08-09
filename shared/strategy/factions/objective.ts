/** Which factions to commit to.
 *
 * Joining a faction BANS its enemies for the current install cycle (and prunes their pending
 * invitations), so faction selection is a maximum-weight independent set
 * problem over the ban graph — not a greedy "join everything useful" walk.
 * Getting it wrong is unrecoverable within a run: joining Sector-12 forecloses
 * Chongqing, New Tokyo, Ishima and Volhaven forever.
 *
 * The real graph is small and known: one component of the six city factions
 * plus isolated nodes. So the EXACT answer is computable by exhaustive search
 * over each connected component, and `tests/factions-objective.test.ts` checks
 * it against brute force over all 2^n subsets. A greedy fallback exists only
 * for components above a size the real data never reaches.
 *
 * One distinction that is easy to get wrong and is its own test: a criminal
 * organisation's `notEmployedBy` condition is a JOIN BLOCKER, not a ban edge.
 * It restricts when you may join; it does not foreclose anything afterwards. */

export interface FactionCandidate {
  name: string;
  /** Value of committing to this faction, in the caller's own units. */
  value: number;
  /** Factions this one bans (and which ban it). */
  enemies: readonly string[];
  /** False when its requirements cannot be met this run. */
  reachable: boolean;
}

export interface ObjectiveResult {
  /** The chosen set, in a stable order. */
  chosen: string[];
  value: number;
  /** Factions excluded because a chosen one bans them. */
  foreclosed: { name: string; bannedBy: string }[];
  /** True when a component was too large for the exact search. */
  approximated: boolean;
}

/** Above this component size, fall back to greedy. The real ban graph's
 * largest component is 6, so this never triggers on real data — it exists so a
 * modded or future BitNode cannot hang the controller's 200 ms tick. */
export const EXACT_SEARCH_LIMIT = 20;

/** Build the undirected ban graph. Bans are symmetric in effect even where the
 * table lists them one-way, because joining either side forecloses the other. */
function buildGraph(candidates: readonly FactionCandidate[]): Map<string, Set<string>> {
  const names = new Set(candidates.map((candidate) => candidate.name));
  const graph = new Map<string, Set<string>>();
  for (const candidate of candidates) graph.set(candidate.name, new Set());
  for (const candidate of candidates) {
    for (const enemy of candidate.enemies) {
      if (!names.has(enemy)) continue;
      graph.get(candidate.name)!.add(enemy);
      graph.get(enemy)!.add(candidate.name);
    }
  }
  return graph;
}

/** Split into connected components, so each is solved independently — which is
 * what makes the exact search feasible: 34 factions is 2^34, but the real
 * graph is one 6-node component plus 28 isolated nodes. */
function components(graph: Map<string, Set<string>>): string[][] {
  const seen = new Set<string>();
  const out: string[][] = [];
  for (const start of graph.keys()) {
    if (seen.has(start)) continue;
    const stack = [start];
    const group: string[] = [];
    seen.add(start);
    while (stack.length > 0) {
      const node = stack.pop()!;
      group.push(node);
      for (const neighbour of graph.get(node) ?? []) {
        if (seen.has(neighbour)) continue;
        seen.add(neighbour);
        stack.push(neighbour);
      }
    }
    out.push(group.sort());
  }
  return out;
}

/** Exhaustive max-weight independent set over one component. Exact. */
function exactMwis(
  group: readonly string[],
  graph: Map<string, Set<string>>,
  value: (name: string) => number,
): { chosen: string[]; value: number } {
  let bestSet: string[] = [];
  let bestValue = 0;
  const size = group.length;
  for (let mask = 0; mask < 1 << size; mask++) {
    const picked: string[] = [];
    let total = 0;
    let independent = true;
    for (let i = 0; i < size && independent; i++) {
      if ((mask & (1 << i)) === 0) continue;
      const name = group[i]!;
      for (const chosen of picked) {
        if (graph.get(name)!.has(chosen)) {
          independent = false;
          break;
        }
      }
      if (!independent) break;
      picked.push(name);
      total += value(name);
    }
    if (independent && total > bestValue) {
      bestValue = total;
      bestSet = picked;
    }
  }
  return { chosen: bestSet, value: bestValue };
}

/** Greedy fallback: highest value first, skipping anything already banned. */
function greedyMwis(
  group: readonly string[],
  graph: Map<string, Set<string>>,
  value: (name: string) => number,
): { chosen: string[]; value: number } {
  const order = [...group].sort((a, b) => {
    const diff = value(b) - value(a);
    return diff !== 0 ? diff : a < b ? -1 : 1;
  });
  const chosen: string[] = [];
  const banned = new Set<string>();
  let total = 0;
  for (const name of order) {
    if (banned.has(name)) continue;
    chosen.push(name);
    total += value(name);
    for (const enemy of graph.get(name) ?? []) banned.add(enemy);
  }
  return { chosen, value: total };
}

export function selectFactions(candidates: readonly FactionCandidate[]): ObjectiveResult {
  // Unreachable factions cannot be committed to, but they still BAN — no: a
  // faction you never join forecloses nothing. Drop them entirely.
  const usable = candidates.filter((candidate) => candidate.reachable && candidate.value > 0);
  const valueOf = new Map(usable.map((candidate) => [candidate.name, candidate.value]));
  const graph = buildGraph(usable);
  const value = (name: string): number => valueOf.get(name) ?? 0;

  const chosen: string[] = [];
  let total = 0;
  let approximated = false;
  for (const group of components(graph)) {
    const solved =
      group.length <= EXACT_SEARCH_LIMIT ? exactMwis(group, graph, value) : greedyMwis(group, graph, value);
    if (group.length > EXACT_SEARCH_LIMIT) approximated = true;
    chosen.push(...solved.chosen);
    total += solved.value;
  }
  chosen.sort((a, b) => {
    const diff = value(b) - value(a);
    return diff !== 0 ? diff : a < b ? -1 : 1;
  });

  const chosenSet = new Set(chosen);
  const foreclosed: { name: string; bannedBy: string }[] = [];
  for (const candidate of candidates) {
    if (chosenSet.has(candidate.name)) continue;
    for (const enemy of candidate.enemies) {
      if (chosenSet.has(enemy)) {
        foreclosed.push({ name: candidate.name, bannedBy: enemy });
        break;
      }
    }
  }

  return { chosen, value: total, foreclosed, approximated };
}

/** Would joining `name` foreclose anything currently worth having? Used by the
 * driver to explain a join before it happens — an exclusion lasts for this install cycle, so the UI
 * should say what is being given up. */
export function foreclosedBy(name: string, candidates: readonly FactionCandidate[]): FactionCandidate[] {
  const candidate = candidates.find((entry) => entry.name === name);
  if (!candidate) return [];
  const enemies = new Set(candidate.enemies);
  return candidates.filter((entry) => entry.name !== name && (enemies.has(entry.name) || entry.enemies.includes(name)));
}
