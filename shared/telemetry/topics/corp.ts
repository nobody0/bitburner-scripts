import type { CorpAction, CorpStage, CorpStatus } from "../../strategy/corp/decide.ts";

/** Corporation observation and the deliberately small Agriculture foundation.
 * Product, investment, research, listing, and dividend policy are not yet
 * automated. */

export interface CorpOfficeDigest {
  city: string;
  size: number;
  numEmployees: number;
  avgEnergy: number;
  avgMorale: number;
  jobs: Record<string, number>;
}

export interface CorpWarehouseDigest {
  city: string;
  level: number;
  size: number;
  sizeUsed: number;
  smartSupplyEnabled: boolean;
  materials: {
    name: string;
    desiredSellAmount: string | number;
    desiredSellPrice: string | number;
  }[];
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
  unlocks: {
    officeApi: boolean;
    warehouseApi: boolean;
    smartSupply: boolean;
  };
  /** Owned solely by `corp.divisions`; core merges must not blank it. */
  divisions?: CorpDivisionDigest[];
  plan?: CorpPlan;
}

export interface CorpPlan {
  stage: CorpStage;
  status: CorpStatus;
  detail: string;
  actions: CorpAction[];
  lastResults?: { action: string; ok: boolean; detail: string; at: number }[];
}
