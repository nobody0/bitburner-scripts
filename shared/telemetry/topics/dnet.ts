/** Darknet feature — BN15's theme (new in game v3.0.0). Problem: traverse the
 * darknet graph by depth, spending stasis links and charisma to keep servers
 * authenticated while instability rises. A routing/budget problem with a
 * decaying resource. */

export interface DarknetServerDigest {
  hostname: string;
  depth: number;
  blockedRam: number;
  isOnline?: boolean;
  requiredCharisma?: number;
  stasisLinked?: boolean;
}

export interface DarknetState {
  reachable: number;
  maxDepth: number;
  stasisLinkLimit: number;
  stasisLinked: string[];
  instability: { authenticationDurationMultiplier: number; authenticationTimeoutChance: number };
  servers: DarknetServerDigest[];
  plan?: DarknetPlan;
}

export interface DarknetPlan {
  action: { type: string; why: string; hostname?: string };
  ranked: { hostname: string; depth: number; unlocks: number; why: string }[];
  why: string;
  /** Charisma the traversal is blocked on, posted to the needs board. */
  charismaNeeded?: number;
  lastResult?: { action: string; ok: boolean; detail: string; at: number };
}
