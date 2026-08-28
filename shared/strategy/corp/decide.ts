import type { CorporationCreateCheck } from "../../features/unlock.ts";

/** A deliberately small corporation foundation.
 *
 * This is not an optimiser. It establishes one observable, profitable
 * Agriculture baseline and stops. Products, investment timing, research,
 * dividends, and public-market policy belong in later measured strategies. */

export const CORPORATION_NAME = "Automation";
export const AGRICULTURE = "Agriculture";
export const CORP_CITIES = ["Sector-12", "Aevum", "Chongqing", "New Tokyo", "Ishima", "Volhaven"] as const;

export const CORP_COST = {
  selfFund: 150e9,
  smartSupply: 25e9,
  agriculture: 40e9,
  office: 4e9,
  warehouse: 5e9,
} as const;

export interface CorpMaterialView {
  name: string;
  desiredSellAmount: string | number;
  desiredSellPrice: string | number;
}

export interface CorpView {
  hasCorporation: boolean;
  bitNode?: number;
  sf3Level: number;
  selfFundCheck?: CorporationCreateCheck;
  seedFundCheck?: CorporationCreateCheck;
  /** Player money granted by the arbiter, not corporation funds. */
  moneyGranted: number;
  funds: number;
  revenue: number;
  expenses: number;
  unlocks: { officeApi: boolean; warehouseApi: boolean; smartSupply: boolean };
  divisions: {
    name: string;
    industry: string;
    cities: string[];
    offices: { city: string; size: number; numEmployees: number; jobs: Record<string, number> }[];
    warehouses: { city: string; smartSupplyEnabled: boolean; materials: CorpMaterialView[] }[];
  }[];
}

export type CorpAction =
  | { type: "createCorporation"; name: string; selfFund: boolean }
  | { type: "purchaseUnlock"; unlock: "Smart Supply" }
  | { type: "expandIndustry"; industry: "Agriculture"; division: string }
  | { type: "expandCity"; division: string; city: string }
  | { type: "purchaseWarehouse"; division: string; city: string }
  | { type: "hireEmployee"; division: string; city: string; position: "Operations" | "Engineer" | "Business" }
  | { type: "setSmartSupply"; division: string; city: string; enabled: true }
  | { type: "sellMaterial"; division: string; city: string; material: "Plants" | "Food"; amount: "MAX"; price: "MP" };

export type CorpStage = "founding" | "api-access" | "smart-supply" | "agriculture" | "city-setup" | "waiting-profit" | "ready";
export type CorpStatus = "acting" | "waiting" | "blocked" | "ready";

export interface CorpDecision {
  stage: CorpStage;
  status: CorpStatus;
  actions: CorpAction[];
  detail: string;
}

function decision(
  stage: CorpStage,
  status: CorpStatus,
  detail: string,
  actions: CorpAction[] = [],
): CorpDecision {
  return { stage, status, actions, detail };
}

function configured(material: CorpMaterialView | undefined): boolean {
  return material?.desiredSellAmount === "MAX" && material.desiredSellPrice === "MP";
}

/** Reconcile the observed world. Costed city creation is batched, but never
 * planned without enough corporation funds for both its office and warehouse.
 * The next probe verifies every effect; void API returns are not proof. */
export function stepCorp(view: CorpView): CorpDecision {
  if (!view.hasCorporation) {
    if (view.bitNode === 3 && view.seedFundCheck === "Success") {
      return decision("founding", "acting", "create a seed-funded BN3 corporation", [{
        type: "createCorporation", name: CORPORATION_NAME, selfFund: false,
      }]);
    }
    if (view.sf3Level !== 3) {
      return decision(
        "api-access",
        "blocked",
        "automatic founding outside BN3 requires SF3.3 so the Office and Warehouse APIs are granted at creation",
      );
    }
    if (view.selfFundCheck !== "Success") {
      return decision("founding", "blocked", `self-funded creation is unavailable (${view.selfFundCheck ?? "not observed"})`);
    }
    if (view.moneyGranted < CORP_COST.selfFund) {
      return decision("founding", "waiting", "waiting for the $150b one-shot self-funding grant");
    }
    return decision("founding", "acting", "create a self-funded SF3.3 corporation", [{
      type: "createCorporation", name: CORPORATION_NAME, selfFund: true,
    }]);
  }

  if (!view.unlocks.officeApi || !view.unlocks.warehouseApi) {
    const missing = [
      !view.unlocks.officeApi ? "Office API" : undefined,
      !view.unlocks.warehouseApi ? "Warehouse API" : undefined,
    ].filter(Boolean).join(" and ");
    return decision("api-access", "blocked", `${missing} unavailable; automatic setup requires a BN3 or SF3.3 corporation`);
  }

  if (!view.unlocks.smartSupply) {
    if (view.funds < CORP_COST.smartSupply) {
      return decision("smart-supply", "waiting", "waiting for $25b of corporation funds to buy Smart Supply");
    }
    return decision("smart-supply", "acting", "buy Smart Supply before creating warehouses", [{
      type: "purchaseUnlock", unlock: "Smart Supply",
    }]);
  }

  const agriculture = view.divisions.find((entry) => entry.industry === AGRICULTURE);
  if (!agriculture) {
    if (view.funds < CORP_COST.agriculture) {
      return decision("agriculture", "waiting", "waiting for $40b of corporation funds to create Agriculture");
    }
    return decision("agriculture", "acting", "create the Agriculture foundation", [{
      type: "expandIndustry", industry: AGRICULTURE, division: AGRICULTURE,
    }]);
  }

  const actions: CorpAction[] = [];
  let funds = view.funds;
  for (const city of CORP_CITIES) {
    let office = agriculture.offices.find((entry) => entry.city === city);
    let warehouse = agriculture.warehouses.find((entry) => entry.city === city);
    const cityExists = agriculture.cities.includes(city);

    if (!cityExists) {
      const cityCost = CORP_COST.office + CORP_COST.warehouse;
      if (funds < cityCost) {
        if (actions.length > 0) break;
        return decision("city-setup", "waiting", `waiting for $9b of corporation funds to establish ${city}`);
      }
      actions.push({ type: "expandCity", division: agriculture.name, city });
      actions.push({ type: "purchaseWarehouse", division: agriculture.name, city });
      funds -= cityCost;
      office = { city, size: 3, numEmployees: 0, jobs: {} };
      warehouse = { city, smartSupplyEnabled: false, materials: [] };
    } else if (!office) {
      return decision("city-setup", "blocked", `${city} is listed by the division but its office was not observed`);
    } else if (!warehouse) {
      if (funds < CORP_COST.warehouse) {
        if (actions.length > 0) break;
        return decision("city-setup", "waiting", `waiting for $5b of corporation funds to buy the ${city} warehouse`);
      }
      actions.push({ type: "purchaseWarehouse", division: agriculture.name, city });
      funds -= CORP_COST.warehouse;
      warehouse = { city, smartSupplyEnabled: false, materials: [] };
    }

    const jobs = { ...office.jobs };
    let employees = office.numEmployees;
    for (const position of ["Operations", "Engineer", "Business"] as const) {
      if ((jobs[position] ?? 0) >= 1) continue;
      if (employees >= office.size) {
        return decision(
          "city-setup",
          "blocked",
          `${agriculture.name}/${city} is full but lacks a ${position} employee; existing assignments are not overwritten`,
        );
      }
      actions.push({ type: "hireEmployee", division: agriculture.name, city, position });
      jobs[position] = (jobs[position] ?? 0) + 1;
      employees++;
    }

    if (!warehouse.smartSupplyEnabled) {
      actions.push({ type: "setSmartSupply", division: agriculture.name, city, enabled: true });
    }
    for (const material of ["Plants", "Food"] as const) {
      if (configured(warehouse.materials.find((entry) => entry.name === material))) continue;
      actions.push({
        type: "sellMaterial", division: agriculture.name, city, material, amount: "MAX", price: "MP",
      });
    }
  }

  if (actions.length > 0) {
    return decision("city-setup", "acting", `reconcile ${actions.length} Agriculture setup action(s)`, actions);
  }
  if (view.revenue <= view.expenses || view.revenue <= 0) {
    return decision("waiting-profit", "waiting", "setup is complete; waiting for a START cycle to report positive profit");
  }
  return decision("ready", "ready", "six-city Agriculture is configured and reporting positive profit");
}
