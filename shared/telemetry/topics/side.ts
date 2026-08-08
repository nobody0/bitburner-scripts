/** Side feature — coding contracts and infiltration. Universal income with no
 * BitNode of its own. Two loosely related problems kept together because
 * neither justifies a tab alone:
 *  - contracts: solve every .cct on the network before it expires (pure
 *    algorithm work, zero strategy),
 *  - infiltration: rank locations by reward per real-time minute.
 * The casino (the other classic early-game money source) has no ns API — it
 * is DOM-driven only — so it is deliberately absent. */

export interface ContractDigest {
  host: string;
  file: string;
  type: string;
  triesRemaining: number;
}

export interface InfiltrationDigest {
  location: string;
  city: string;
  difficulty: number;
  maxClearanceLevel: number;
  startingSecurityLevel: number;
  repReward: number;
  moneyReward: number;
  /** Money per unit difficulty — the ranking that matters. */
  moneyPerDifficulty: number;
}

export interface SideState {
  /** Contracts we hold a solver for, most-at-risk first, capped by the probe
   *  (see CONTRACT_LIMIT in game/lib/probes/dodged.ts, which carries the full
   *  reasoning). NEVER the whole network: a long-lived save reached 8,557
   *  contracts, and dumping them made this one record 1.66 MB. */
  contracts: ContractDigest[];
  /** Every .cct on the network, solvable or not. */
  contractTotal?: number;
  /** How many of `contractTotal` we can solve. `contracts.length` is the
   *  capped window onto these, not the count. */
  solvableTotal?: number;
  /** Contracts with no registered solver, counted PER TYPE. One row per type
   *  is the actionable shape: a gap in the registry is a missing solver, and
   *  an unsolved contract expires, so this is a countdown, not a curiosity. */
  unsolvableByType?: Record<string, number>;
  unsolvableTotal?: number;
  /** Ranked; the probe caps the list (getInfiltration is 15 GB per call, so
   * the full sweep is rare and partial results are normal). */
  infiltration?: InfiltrationDigest[];
  infiltrationTotal?: number;
  plan?: SidePlan;
}

export interface SidePlan {
  /** The attempt queue, capped exactly as `SideState.contracts` is. */
  solvable: { host: string; file: string; type: string }[];
  solvableTotal: number;
  /** Missing solvers, one row per type rather than one per file. */
  unsolvable: { type: string; count: number }[];
  unsolvableTotal: number;
  infiltration: { location: string; city: string; valuePerMinute: number }[];
  /** Permanent blocker, reported rather than omitted. */
  casino: string;
  why: string;
  lastResult?: { action: string; ok: boolean; detail: string; at: number };
}
