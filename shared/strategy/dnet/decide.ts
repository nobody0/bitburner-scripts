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
  | { type: "authenticate"; hostname: string; why: string }
  | { type: "stasis"; hostname: string; why: string }
  | { type: "releaseStasis"; hostname: string; why: string }
  | { type: "idle"; why: string };

export interface DarknetDecision {
  action: DarknetAction;
  /** Servers ranked by how much depth they unlock per stasis link spent. */
  ranked: { hostname: string; depth: number; unlocks: number; why: string }[];
  /** Charisma the run needs, posted to the board for career to deliver. */
  charismaNeeded?: number;
  why: string;
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

  const ranked = view.servers
    .filter((server) => !server.stasisLinked)
    .map((server) => ({
      hostname: server.hostname,
      depth: server.depth,
      unlocks: unlockValue(view, server.hostname),
      why: `depth ${server.depth}, keeps ${unlockValue(view, server.hostname)} servers reachable`,
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
      action: {
        type: "idle",
        why: `authentication timeout chance ${(view.instability.authenticationTimeoutChance * 100).toFixed(0)}% exceeds the ceiling`,
      },
      ranked,
      ...(charismaNeeded !== undefined ? { charismaNeeded } : {}),
      why: "waiting for instability to fall",
    };
  }

  // Spend a stasis link on the server that keeps the most of the graph alive.
  if (linked.size < view.stasisLinkLimit) {
    const best = ranked.find((entry) => entry.unlocks > 0);
    if (best) {
      return {
        action: { type: "stasis", hostname: best.hostname, why: best.why },
        ranked,
        ...(charismaNeeded !== undefined ? { charismaNeeded } : {}),
        why: `${linked.size}/${view.stasisLinkLimit} links used`,
      };
    }
  }

  // Links exhausted: release one that no longer unlocks anything, so the
  // budget is recycled rather than stranded.
  if (linked.size >= view.stasisLinkLimit) {
    const wasted = view.servers.find((server) => server.stasisLinked && server.isOnline && unlockValue(view, server.hostname) === 0);
    if (wasted) {
      return {
        action: { type: "releaseStasis", hostname: wasted.hostname, why: "server is online again; the link is doing nothing" },
        ranked,
        ...(charismaNeeded !== undefined ? { charismaNeeded } : {}),
        why: "recycling a stasis link",
      };
    }
  }

  const target = view.servers.find(
    (server) => server.isOnline && server.requiredCharisma <= view.charisma && !server.stasisLinked,
  );
  if (target) {
    return {
      action: { type: "authenticate", hostname: target.hostname, why: `charisma ${view.charisma} clears ${target.requiredCharisma}` },
      ranked,
      ...(charismaNeeded !== undefined ? { charismaNeeded } : {}),
      why: "extending reach",
    };
  }

  return {
    action: { type: "idle", why: charismaNeeded !== undefined ? `blocked on charisma ${charismaNeeded}` : "nothing reachable" },
    ranked,
    ...(charismaNeeded !== undefined ? { charismaNeeded } : {}),
    why: "blocked",
  };
}
