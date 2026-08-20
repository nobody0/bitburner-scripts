/** Darknet timing, transcribed from the pinned checkout.
 *
 * These are the numbers the staleness rule is derived from, so they are kept in
 * one place with their citations rather than inlined at the call sites.
 * Source: ../bitburner-src at 3162fd2590e221eadd0c0fbd46151913f7c4c41c
 *   src/DarkNet/Enums.ts
 *   src/DarkNet/utils/darknetNetworkUtils.ts  (getDarknetCyclesPerMutation)
 *   src/DarkNet/controllers/NetworkMovement.ts (mutateDarknet)
 *   src/DarkNet/effects/labyrinth.ts          (getNetDepth) */

/** The other network constants (MAX_NET_DEPTH, AIR_GAP_DEPTH, the connection
 * chances, MAX_PASSWORD_LENGTH) are written up in
 * spec/strategy/bitnodes/bn15.md rather than exported here; nothing computes
 * with them yet, and an unused constant is a claim nobody checks. */
const MS_PER_MUTATION_PER_ROW = 30_000;
const NET_WIDTH = 8;
const SERVER_DENSITY = 0.6;
/** getNetDepth() falls back to 10 until the labyrinth reports its own depth. */
const DEFAULT_NET_DEPTH = 10;

/** How often the net gets a mutation TICK.
 *
 * `getDarknetCyclesPerMutation` is `(rateMultiplier * 150) / depth` cycles at
 * 200 ms a cycle, where rateMultiplier is 1 in BN15 and 2 everywhere else. So
 * the net churns FASTER the deeper the labyrinth goes, and twice as slowly
 * outside its own BitNode. At the default depth of 10 in BN15 that is one tick
 * every three seconds. */
export function mutationIntervalMs(netDepth = DEFAULT_NET_DEPTH, bitNode = 15): number {
  const depth = Math.max(1, netDepth);
  return ((bitNode === 15 ? 1 : 2) * MS_PER_MUTATION_PER_ROW) / depth;
}

/** `mutateDarknet` throttles itself on deep nets: it rolls against
 * `16 / depth` and returns early on a miss, so past depth 16 a growing share of
 * ticks do nothing at all. */
function mutationTickEffectiveness(netDepth = DEFAULT_NET_DEPTH): number {
  return Math.min(1, 16 / Math.max(1, netDepth));
}

/** Rough server population, from the generator's own density figures. Used to
 * turn a net-wide churn rate into a per-host one. */
function expectedServerCount(netDepth = DEFAULT_NET_DEPTH): number {
  return Math.max(1, Math.round(netDepth * NET_WIDTH * SERVER_DENSITY));
}

/** What a single mutation tick does to the net, transcribed from the roll list
 * in `mutateDarknet`. Several branches `return` early, so these are the
 * probabilities of REACHING each roll, not the raw literals.
 *
 * Deliberately expressed as hosts-touched-per-tick rather than as a half-life:
 * the aggregate is arithmetic over transcribed constants, but it has not been
 * MEASURED against a running game, and a half-life would read as though it had.
 * `sim/` is where it gets measured. */
export interface MutationBudget {
  /** Servers whose position (and therefore depth and neighbours) changes. */
  moved: number;
  /** Servers that lose every connection they had. */
  disconnected: number;
  /** Servers that gain connections. */
  connected: number;
  /** Servers killed outright. Their scripts and files go with them. */
  deleted: number;
  /** Servers restarted: scripts die, files survive. */
  restarted: number;
}

/** With no backdoored servers, the two backdoor branches cannot fire, so the
 * later rolls are reached more often. `backdoored` is therefore an input: it
 * makes the net measurably more violent, which is the cost the API docs
 * describe only as an authentication penalty. */
export function mutationBudget(backdoored = 0): MutationBudget {
  // P(reaching the rolls after the early-return branches).
  const survivesAdd = 0.9;
  const survivesBackdoorRestart = backdoored > 0 ? 0.9 : 1;
  const survivesBackdoorDelete = backdoored > 0 ? 0.95 : 1;
  const reachesLate = survivesAdd * survivesBackdoorRestart * survivesBackdoorDelete;
  const reachesDisconnect = reachesLate * 0.5;
  // deleteRandomDarknetServers(Math.random() * 3 + 1) averages 2.5 servers.
  const batch = 2.5;
  return {
    moved: 0.3 /* islands */ + reachesLate * 0.3 * 3 /* moveRandomDarknetServers(3) */,
    disconnected: reachesDisconnect * 0.5,
    connected: reachesLate * 0.5,
    deleted: 0.1 * batch + (backdoored > 0 ? survivesAdd * 0.9 * 0.05 : 0),
    restarted: reachesLate * 0.2 + (backdoored > 0 ? survivesAdd * 0.1 : 0),
  };
}

/** Expected milliseconds before a mutation touches one NAMED host in the given
 * way. This is what an expiry should be scaled against: the net churns every
 * few seconds, but any single host is stable for far longer.
 *
 * Note the scale invariance — ticks get faster with depth while the population
 * grows with it, so the per-host figure barely moves. That is why the expiry
 * below is a flat multiple rather than a function of depth. */
export function msPerHostEvent(
  kind: keyof MutationBudget,
  netDepth = DEFAULT_NET_DEPTH,
  bitNode = 15,
  backdoored = 0,
): number {
  return msPerHostEventAny([kind], netDepth, bitNode, backdoored);
}

/** Expected milliseconds before ANY of these events touches one named host.
 *
 * Rates add; times do not. A neighbour list is invalidated by a move, by a
 * disconnect and by a new connection alike, so the three processes compound into
 * a shorter life than the fastest of them — taking the minimum of the three
 * times would understate the churn and over-trust the edge. */
export function msPerHostEventAny(
  kinds: readonly (keyof MutationBudget)[],
  netDepth = DEFAULT_NET_DEPTH,
  bitNode = 15,
  backdoored = 0,
): number {
  const budget = mutationBudget(backdoored);
  const effectiveness = mutationTickEffectiveness(netDepth);
  const perTick = kinds.reduce((sum, kind) => sum + budget[kind], 0) * effectiveness;
  if (perTick <= 0) return Infinity;
  const perHostPerTick = perTick / expectedServerCount(netDepth);
  return mutationIntervalMs(netDepth, bitNode) / perHostPerTick;
}
