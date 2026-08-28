/** Read-only darknet guidance for home: stasis ranking and required charisma.
 * Executable authentication and stasis actions are planned on connected Dnet
 * hosts in `plan.ts` and `hold.ts`. */

export interface DarknetServer {
  hostname: string;
  depth: number;
  requiredCharisma: number;
  stasisLinked: boolean;
  /** Neighbours, for the reachability search. */
  neighbours?: string[];
}

export interface DarknetView {
  /** True only when every server's neighbour list has been observed. */
  topologyComplete: boolean;
  servers: DarknetServer[];
  stasisLinked: string[];
  charisma: number;
}

export interface DarknetDecision {
  /** Servers ranked by how much of the graph a stasis link on them keeps alive.
   *  Empty while the topology is partial: see `stepDarknet`. */
  ranked: { hostname: string; depth: number; unlocks: number }[];
  /** Charisma the run needs, posted to the board for career to deliver. */
  charismaNeeded?: number;
}

/** Servers reachable from the online set, under the current stasis links.
 *
 * A shortest-path/max-reachable computation over a small graph, so this is an
 * exact search rather than a heuristic. */
export function reachableFrom(servers: readonly DarknetServer[], linked: ReadonlySet<string>): Set<string> {
  const byName = new Map(servers.map((server) => [server.hostname, server]));
  const seen = new Set<string>();
  const stack: string[] = servers.filter((server) => server.depth === 0).map((server) => server.hostname);
  while (stack.length > 0) {
    const name = stack.pop()!;
    if (seen.has(name)) continue;
    const server = byName.get(name);
    if (!server) continue;
    seen.add(name);
    for (const neighbour of server.neighbours ?? []) stack.push(neighbour);
  }
  return seen;
}

/** How many extra servers a stasis link on `hostname` would keep reachable. */
export function unlockValue(view: DarknetView, hostname: string): number {
  const current = new Set(view.stasisLinked);
  const before = reachableFrom(view.servers, current).size;
  current.add(hostname);
  return reachableFrom(view.servers, current).size - before;
}

export function stepDarknet(view: DarknetView): DarknetDecision {
  // Charisma is worked out FIRST, before the topology gate below, because the
  // two answer independent questions. The gate is about whether a reachability
  // number is exact; a charisma requirement is a per-host identity fact that is
  // just as true on a partial map. Computing it after the gate meant the need
  // never reached the board on any run whose topology was incomplete — which is
  // nearly every run, and exactly the runs whose charisma is short.
  const blocked = view.servers.filter((server) => server.requiredCharisma > view.charisma);
  const charismaNeeded = blocked.length > 0 ? Math.min(...blocked.map((server) => server.requiredCharisma)) : undefined;
  const need = charismaNeeded !== undefined ? { charismaNeeded } : {};

  // ns.dnet.probe() is local to the script execution host. Ranking stasis links
  // from one local neighbour list would present a partial graph as an exact
  // reachability answer, so refuse until the fold has traversed it.
  // Source: https://github.com/bitburner-official/bitburner-src/blob/3162fd2590e221eadd0c0fbd46151913f7c4c41c/src/NetscriptFunctions/Darknet.ts#L314-L335
  if (!view.topologyComplete) return { ranked: [], ...need };

  const ranked = view.servers
    .filter((server) => !server.stasisLinked)
    .map((server) => ({
      hostname: server.hostname,
      depth: server.depth,
      unlocks: unlockValue(view, server.hostname),
    }))
    .sort((a, b) => b.unlocks - a.unlocks || b.depth - a.depth || (a.hostname < b.hostname ? -1 : 1));

  return { ranked, ...need };
}
