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
  contracts: ContractDigest[];
  /** Ranked; the probe caps the list (getInfiltration is 15 GB per call, so
   * the full sweep is rare and partial results are normal). */
  infiltration?: InfiltrationDigest[];
  infiltrationTotal?: number;
}
