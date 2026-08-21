/** Darknet traversal.
 *
 * Objective: reach as much of the darknet graph as possible while managing
 * authentication, charisma, instability and — the binding constraint — the
 * LIMITED STASIS LINKS. A stasis link freezes a server so it stays reachable;
 * there are only so many, which makes this a max-reachable-under-a-budget
 * problem rather than a plain traversal.
 *
 * That budget is a genuinely contended resource, so it goes through the
 * arbiter as a third claim class alongside money and the work slot. */

export interface DarknetServer {
  hostname: string;
  depth: number;
  blockedRam: number;
  isOnline: boolean;
  requiredCharisma: number;
  stasisLinked: boolean;
  /** Neighbours, for the reachability search. */
  neighbours?: string[];
}

export interface DarknetView {
  /** True only when every server's neighbor list has been observed. */
  topologyComplete: boolean;
  servers: DarknetServer[];
  reachable: number;
  maxDepth: number;
  stasisLinkLimit: number;
  stasisLinked: string[];
  instability: { authenticationDurationMultiplier: number; authenticationTimeoutChance: number };
  charisma: number;
  /** Instability above which further backdooring is counter-productive. */
  instabilityCeiling: number;
}

export type DarknetAction =
  | { type: "authenticate"; hostname: string }
  | { type: "stasis"; hostname: string }
  | { type: "releaseStasis"; hostname: string }
  | { type: "idle" };

export interface DarknetDecision {
  action: DarknetAction;
  /** Servers ranked by how much depth they unlock per stasis link spent. */
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
    // A server that has gone offline is only traversable while held in stasis.
    if (!server || (!server.isOnline && !linked.has(name))) continue;
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
  const linked = new Set(view.stasisLinked);

  // ns.dnet.probe() is local to the script execution host. Ranking stasis
  // links from one local neighbor list would present a partial graph as an
  // exact reachability answer, so refuse until acquisition traverses it.
  // Source: https://github.com/bitburner-official/bitburner-src/blob/3162fd2590e221eadd0c0fbd46151913f7c4c41c/src/NetscriptFunctions/Darknet.ts#L314-L335
  if (!view.topologyComplete) {
    return {
      action: { type: "idle" },
      ranked: [],
    };
  }

  const ranked = view.servers
    .filter((server) => !server.stasisLinked)
    .map((server) => ({
      hostname: server.hostname,
      depth: server.depth,
      unlocks: unlockValue(view, server.hostname),
    }))
    .sort((a, b) => b.unlocks - a.unlocks || b.depth - a.depth || (a.hostname < b.hostname ? -1 : 1));

  // Charisma gates authentication; career can deliver it, so it becomes a need
  // rather than something this feature grinds itself.
  const blocked = view.servers.filter((server) => server.requiredCharisma > view.charisma);
  const charismaNeeded = blocked.length > 0 ? Math.min(...blocked.map((server) => server.requiredCharisma)) : undefined;

  // Instability rises with activity and makes authentication unreliable;
  // above the ceiling, more backdooring makes things worse, not better.
  if (view.instability.authenticationTimeoutChance > view.instabilityCeiling) {
    return {
      action: { type: "idle" },
      ranked,
      ...(charismaNeeded !== undefined ? { charismaNeeded } : {}),
    };
  }

  // Spend a stasis link on the server that keeps the most of the graph alive.
  if (linked.size < view.stasisLinkLimit) {
    const best = ranked.find((entry) => entry.unlocks > 0);
    if (best) {
      return {
        action: { type: "stasis", hostname: best.hostname },
        ranked,
        ...(charismaNeeded !== undefined ? { charismaNeeded } : {}),
      };
    }
  }

  // Links exhausted: release one that no longer unlocks anything, so the
  // budget is recycled rather than stranded.
  if (linked.size >= view.stasisLinkLimit) {
    const wasted = view.servers.find((server) => server.stasisLinked && server.isOnline && unlockValue(view, server.hostname) === 0);
    if (wasted) {
      return {
        action: { type: "releaseStasis", hostname: wasted.hostname },
        ranked,
        ...(charismaNeeded !== undefined ? { charismaNeeded } : {}),
      };
    }
  }

  const target = view.servers.find(
    (server) => server.isOnline && server.requiredCharisma <= view.charisma && !server.stasisLinked,
  );
  if (target) {
    return {
      action: { type: "authenticate", hostname: target.hostname },
      ranked,
      ...(charismaNeeded !== undefined ? { charismaNeeded } : {}),
    };
  }

  return {
    action: { type: "idle" },
    ranked,
    ...(charismaNeeded !== undefined ? { charismaNeeded } : {}),
  };
}
