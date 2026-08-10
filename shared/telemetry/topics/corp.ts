/** Corporation feature — BN3's theme. Problem: sequence divisions, offices,
 * warehouses, research and investment rounds to maximise valuation (and then
 * dividends) per real-time cycle. The deepest optimization surface in the
 * game, and the most expensive to probe — getCorporation and getDivision are
 * 10 GB each. */

export interface CorpOfficeDigest {
  city: string;
  size: number;
  numEmployees: number;
  avgEnergy: number;
  avgMorale: number;
  /** Employees per job title. */
  jobs: Record<string, number>;
}

export interface CorpWarehouseDigest {
  city: string;
  level: number;
  size: number;
  sizeUsed: number;
  smartSupplyEnabled: boolean;
}

export interface CorpDivisionDigest {
  name: string;
  industry: string;
  awareness: number;
  popularity: number;
  productionMult: number;
  researchPoints: number;
  lastCycleRevenue: number;
  lastCycleExpenses: number;
  numAdVerts: number;
  cities: string[];
  products: string[];
  maxProducts: number;
  offices?: CorpOfficeDigest[];
  warehouses?: CorpWarehouseDigest[];
}

export interface CorpState {
  name: string;
  funds: number;
  revenue: number;
  expenses: number;
  public: boolean;
  valuation: number;
  sharePrice: number;
  totalShares: number;
  numShares: number;
  issuedShares: number;
  dividendRate: number;
  dividendEarnings: number;
  state: string;
  /** Owned solely by the `corp.divisions` probe. `corp.core` runs twice as
   *  often and cannot afford getDivision, so it must not write this field —
   *  topic merges are shallow, and a placeholder here would blank the table
   *  every other sweep. */
  divisions?: CorpDivisionDigest[];
  investmentOffer?: { round: number; funds: number; shares: number };
  bonusTime?: number;
  plan?: CorpPlan;
}

export interface CorpPlan {
  action: {
    type: string;
    industry?: string;
    division?: string;
    city?: string;
    size?: number;
    job?: string;
    material?: string;
    round?: number;
    name?: string;
  };
  /** Which stage produced the action, so a stall is attributable. */
  stage: string;
  completed: string[];
  lastResult?: { action: string; ok: boolean; detail: string; at: number };
}
