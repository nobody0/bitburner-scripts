/** Side feature — coding contracts. Contracts persist until solved or
 * destroyed by wrong answers, so the topic carries a bounded work window and
 * enough totals to explain the solver without dumping the whole network. */

export interface ContractDigest {
  host: string;
  file: string;
}

/** Diagnostic first-failure record. Strings are intentional: contract data
 * can contain BigInts or huge answer arrays. The game caps each replay field
 * and records the original length when truncated. */
export interface ContractFailure {
  host: string;
  file: string;
  type: string;
  data: string;
  answer: string;
  triesBefore?: number;
  reason: string;
  at: number;
}

/** Repeated state records carry the actionable index, not the potentially
 * large input and answer. The full replay is a report-once event. */
export type ContractFailureSummary = Omit<ContractFailure, "data" | "answer">;

export interface SideState {
  /** Unquarantined contract work queue, capped by the probe
   *  (see the Side limits in shared/strategy/side/contracts.ts). NEVER the
   *  whole network: a long-lived save reached 8,557
   *  contracts, and dumping them made this one record 1.66 MB. */
  contracts: ContractDigest[];
  /** Every .cct on the network, solvable or not. */
  contractTotal?: number;
  /** Unquarantined candidates. Types are filled by bounded driver inspection;
   * unsupported files leave this count when quarantined. `contracts.length`
   * is the capped work window, not the count. */
  solvableTotal?: number;
  /** Contracts with no registered solver, counted PER TYPE. One row per type
   *  is the actionable shape: a gap in the registry is a missing solver. */
  unsolvableByType?: Record<string, number>;
  unsolvableTotal?: number;
  /** Whether every type reported by the running game has a local solver. */
  registryComplete?: boolean;
  contractTypeTotal?: number;
  supportedTypeTotal?: number;
  /** Wall-clock/virtual timestamp of the authoritative network ls sweep. */
  contractScannedAt?: number;
  /** First rejection per quarantined file, newest first and capped. Full
   * replay data is emitted once as `contract.quarantined`. */
  failures?: ContractFailureSummary[];
  quarantinedTotal?: number;
  lastResult?: { action: string; ok: boolean; detail: string; at: number };
}
