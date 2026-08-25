/** Side feature — coding contracts. Contracts persist until solved or
 * destroyed by wrong answers, so the topic carries a bounded work window and
 * enough totals to explain the solver without dumping the whole network. */

/** Where a contract was found. Declared here because everything that carries
 * it is a digest: the solver registry and the reward parser never need it.
 * `network` is the ordinary `ls` sweep; `darknet` is a resident listing. */
export type ContractOrigin = "network" | "darknet";

/** One origin's solver outcomes since the last prestige.
 *
 * Cumulative, so the viewer differentiates for a rate — that costs no bytes and
 * makes a replay scrub recompute the identical curve. The window matches
 * `progression.moneySources.sinceInstall` on purpose: the cross-check between
 * the two only means anything if both cover the same span. */
export interface ContractOriginTotals {
  /** `attempt` calls submitted. */
  attempted: number;
  /** Attempts that returned a non-empty string, so the contract was consumed. */
  solved: number;
  /** Solves whose string was "No reward for this contract". A consumed contract
   *  that paid nothing is not a parse failure and must not read as one. */
  unrewarded: number;
  /** Files quarantined, all reasons. */
  quarantined: number;
  /** APPROXIMATE, and the name says so because a UI cannot rename a wire field.
   *  Summed from `formatMoney` display text carrying ~4 significant digits, so
   *  a magnitude and never a ledger.
   *  `progression.moneySources.sinceInstall.codingcontract` is the EXACT figure
   *  for the same window with no origin split; the two are read together. */
  moneyApprox: number;
  /** Solves that paid money at all — the denominator for `moneyApprox`, and
   *  what separates "BN8 pays $0" from "nothing paid money". */
  moneySolves: number;
  /** EXACT: these reward strings carry a raw JS number. */
  factionRep: number;
  companyRep: number;
  /** Reward strings this build could not classify. Non-zero means `moneyApprox`
   *  is UNDER-counting by an unknown amount because the game's number format,
   *  currency symbol or locale moved out from under the parser. Never folded
   *  into the money total as a zero. */
  unparsed: number;
}

/** One recent solve, kept as an example. The totals say what the pipeline
 * earned; these say what the game actually said, in its own words. */
export interface ContractSolveReport {
  at: number;
  origin: ContractOrigin;
  host: string;
  file: string;
  type: string;
  /** Verbatim, capped by the driver's existing reason limit. */
  reward: string;
  currency: "money" | "factionRep" | "companyRep" | "none" | "unparsed";
  /** Money only, and APPROXIMATE — see ContractOriginTotals.moneyApprox. */
  moneyApprox?: number;
  /** Reputation only, exact. For the split award this is the true total. */
  rep?: number;
  /** Named recipients, capped; `toTotal` is the real count when it is longer. */
  to?: string[];
  toTotal?: number;
}

export interface ContractDigest {
  host: string;
  file: string;
  origin?: ContractOrigin;
}

/** Diagnostic first-failure record. Strings are intentional: contract data
 * can contain BigInts or huge answer arrays. The game caps each replay field
 * and records the original length when truncated. */
export interface ContractFailure {
  host: string;
  file: string;
  /** Where the contract came from, so a quarantine is attributable too. */
  origin?: ContractOrigin;
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
  /** Bounded work window; totals below describe the full census. */
  contracts: ContractDigest[];
  /** Every observed .cct across ordinary servers and the darknet. */
  contractTotal?: number;
  /** Unquarantined candidates, including rows outside the work window. */
  solvableTotal?: number;
  /** Full census by discovery path. */
  contractsByOrigin: Record<ContractOrigin, { observed: number; solvable: number }>;
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
  /** Solver outcomes and earnings split by contract ORIGIN, so profit can be
   *  attributed. An origin is ABSENT until it has attempted something: absent
   *  means "never seen", not zero. Cleared with the topic on prestige, so the
   *  window is the same "since install" one `moneySources.sinceInstall` uses. */
  rewards?: Partial<Record<ContractOrigin, ContractOriginTotals>>;
  /** When the first attempt counted in `rewards` landed, so a rate has a
   *  denominator even for a viewer that attached mid-run. Putting the open on
   *  the wire, as `stock.tradeFlowSince` does. */
  rewardsSince?: number;
  /** Newest last. A bounded SAMPLE sized so one full driver batch always fits;
   *  `rewards` is the census. */
  recentSolves?: ContractSolveReport[];
  lastResult?: { action: string; ok: boolean; detail: string; at: number };
}
