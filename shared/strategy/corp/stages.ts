/** Corporation: a staged script, not a general optimiser.
 *
 * THE OPTIMIZATION BOUNDARY IS STATED OPENLY, because it is unusual for this
 * project: this feature is near-optimal *within the modelled stage graph*, not
 * globally. A corporation has hundreds of interacting levers (materials,
 * products, research, exports, investment timing, share issuance) and no
 * tractable exact objective, so the honest claim is "a well-understood
 * Agriculture -> Tobacco path with every stage's precondition and expected
 * effect explicit", measured against a fixed known-good script as the
 * baseline. Claiming more would be false precision.
 *
 * What each stage DOES give is a testable contract: a precondition that says
 * when it may run, an action list, and an expected effect that the next
 * stage's precondition checks. A stage that does not produce its expected
 * effect is a visible failure rather than a silent stall. */

export interface CorpView {
  hasCorporation: boolean;
  funds: number;
  revenue: number;
  expenses: number;
  public: boolean;
  divisions: {
    name: string;
    industry: string;
    cities: string[];
    researchPoints: number;
    products: string[];
    maxProducts: number;
    offices: { city: string; size: number; numEmployees: number; jobs: Record<string, number> }[];
    warehouses: { city: string; level: number; size: number; sizeUsed: number; smartSupplyEnabled: boolean }[];
  }[];
  investmentOffer?: { round: number; funds: number; shares: number };
  /** Money the arbiter granted. */
  moneyGranted: number;
}

export type CorpAction =
  | { type: "createCorporation"; why: string }
  | { type: "expandIndustry"; industry: string; division: string; why: string }
  | { type: "expandCity"; division: string; city: string; why: string }
  | { type: "buyWarehouse"; division: string; city: string; why: string }
  | { type: "upgradeOffice"; division: string; city: string; size: number; why: string }
  | { type: "hire"; division: string; city: string; job: string; why: string }
  | { type: "smartSupply"; division: string; city: string; why: string }
  | { type: "sellMaterial"; division: string; city: string; material: string; why: string }
  | { type: "acceptInvestment"; round: number; why: string }
  | { type: "makeProduct"; division: string; city: string; name: string; why: string }
  | { type: "idle"; why: string };

export interface CorpStage {
  id: string;
  /** May this stage run? */
  ready(view: CorpView): boolean;
  /** Has it already achieved what it exists to achieve? */
  done(view: CorpView): boolean;
  /** What to do next within the stage. */
  next(view: CorpView): CorpAction | undefined;
  /** What the next stage's precondition should observe afterwards. */
  expect: string;
}

export const AGRICULTURE = "Agriculture";
export const TOBACCO = "Tobacco";
const START_CITY = "Sector-12";
const CITIES = ["Sector-12", "Aevum", "Chongqing", "New Tokyo", "Ishima", "Volhaven"];

function division(view: CorpView, industry: string): CorpView["divisions"][number] | undefined {
  return view.divisions.find((entry) => entry.industry === industry || entry.name === industry);
}

/** The staged path. Order matters and each stage's `expect` is the next one's
 * precondition, so a stall is attributable to a specific stage. */
export const CORP_STAGES: CorpStage[] = [
  {
    id: "found",
    ready: (view) => !view.hasCorporation,
    done: (view) => view.hasCorporation,
    next: () => ({ type: "createCorporation", why: "a corporation is the precondition for everything else" }),
    expect: "hasCorporation",
  },
  {
    id: "agriculture",
    ready: (view) => view.hasCorporation && !division(view, AGRICULTURE),
    done: (view) => Boolean(division(view, AGRICULTURE)),
    next: () => ({
      type: "expandIndustry",
      industry: AGRICULTURE,
      division: AGRICULTURE,
      // Agriculture first because it is cheap, profitable early, and its
      // materials feed the later product division.
      why: "cheapest profitable industry, and it supplies the product division later",
    }),
    expect: "an Agriculture division exists",
  },
  {
    id: "agriculture-cities",
    ready: (view) => Boolean(division(view, AGRICULTURE)),
    done: (view) => (division(view, AGRICULTURE)?.cities.length ?? 0) >= CITIES.length,
    next: (view) => {
      const agri = division(view, AGRICULTURE);
      if (!agri) return undefined;
      const missing = CITIES.find((city) => !agri.cities.includes(city));
      if (!missing) return undefined;
      return { type: "expandCity", division: agri.name, city: missing, why: `production scales with cities; ${missing} is next` };
    },
    expect: "Agriculture operates in all six cities",
  },
  {
    id: "agriculture-warehouses",
    ready: (view) => (division(view, AGRICULTURE)?.cities.length ?? 0) > 0,
    done: (view) => {
      const agri = division(view, AGRICULTURE);
      return Boolean(agri && agri.warehouses.length >= agri.cities.length);
    },
    next: (view) => {
      const agri = division(view, AGRICULTURE);
      if (!agri) return undefined;
      const city = agri.cities.find((entry) => !agri.warehouses.some((warehouse) => warehouse.city === entry));
      if (!city) return undefined;
      return { type: "buyWarehouse", division: agri.name, city, why: "production without storage is discarded" };
    },
    expect: "every Agriculture city has a warehouse",
  },
  {
    id: "smart-supply",
    ready: (view) => (division(view, AGRICULTURE)?.warehouses.length ?? 0) > 0,
    done: (view) => {
      const agri = division(view, AGRICULTURE);
      return Boolean(agri && agri.warehouses.every((warehouse) => warehouse.smartSupplyEnabled));
    },
    next: (view) => {
      const agri = division(view, AGRICULTURE);
      const warehouse = agri?.warehouses.find((entry) => !entry.smartSupplyEnabled);
      if (!agri || !warehouse) return undefined;
      return {
        type: "smartSupply",
        division: agri.name,
        city: warehouse.city,
        // Without it, input materials are bought at a fixed rate regardless of
        // production, which wastes funds continuously.
        why: "smart supply matches input purchases to actual production",
      };
    },
    expect: "smart supply is on everywhere",
  },
  {
    id: "investment-1",
    ready: (view) => Boolean(view.investmentOffer && view.investmentOffer.round <= 2 && view.revenue > 0),
    done: (view) => !view.investmentOffer || view.investmentOffer.round > 2,
    next: (view) =>
      view.investmentOffer
        ? {
            type: "acceptInvestment",
            round: view.investmentOffer.round,
            // Early rounds trade shares cheaply for the capital that funds the
            // product division; later rounds are worth far more per share.
            why: `round ${view.investmentOffer.round} funds the product division`,
          }
        : undefined,
    expect: "seed capital raised",
  },
  {
    id: "tobacco",
    ready: (view) => view.funds > 20e9 && !division(view, TOBACCO),
    done: (view) => Boolean(division(view, TOBACCO)),
    next: () => ({
      type: "expandIndustry",
      industry: TOBACCO,
      division: TOBACCO,
      why: "products scale far beyond materials; Tobacco is the standard product path",
    }),
    expect: "a Tobacco division exists",
  },
  {
    id: "tobacco-products",
    ready: (view) => Boolean(division(view, TOBACCO)),
    done: (view) => {
      const tobacco = division(view, TOBACCO);
      return Boolean(tobacco && tobacco.products.length >= tobacco.maxProducts);
    },
    next: (view) => {
      const tobacco = division(view, TOBACCO);
      if (!tobacco) return undefined;
      return {
        type: "makeProduct",
        division: tobacco.name,
        city: START_CITY,
        name: `Product-${tobacco.products.length + 1}`,
        why: "each product compounds revenue; keep the slate full",
      };
    },
    expect: "the product slate is full",
  },
];

export interface CorpDecision {
  action: CorpAction;
  /** Which stage produced it, so a stall is attributable. */
  stage: string;
  /** Stages already satisfied. */
  completed: string[];
  why: string;
}

export function stepCorp(view: CorpView): CorpDecision {
  const completed: string[] = [];
  for (const stage of CORP_STAGES) {
    if (stage.done(view)) {
      completed.push(stage.id);
      continue;
    }
    if (!stage.ready(view)) {
      return {
        action: { type: "idle", why: `waiting for ${stage.id}'s precondition` },
        stage: stage.id,
        completed,
        why: `stage ${stage.id} is not ready — expects: ${stage.expect}`,
      };
    }
    const action = stage.next(view);
    if (!action) continue;
    return { action, stage: stage.id, completed, why: `stage ${stage.id}: ${stage.expect}` };
  }
  return {
    action: { type: "idle", why: "every modelled stage is complete" },
    stage: "done",
    completed,
    why: "the modelled stage graph is exhausted — beyond this the feature makes no optimality claim",
  };
}
