import { describe, expect, test } from "bun:test";
import { CORP_CITIES, CORP_COST, stepCorp, type CorpView } from "../shared/strategy/corp/decide.ts";
import { PRICED_PROBES } from "../game/lib/probes/index.ts";
import { probeCtx } from "./support/probe-fixture.ts";
import type { NS } from "@ns";
import { FEATURE_MODULES, noGrants, type ClaimContext, type DriverContext } from "../game/lib/features/index.ts";
import { initState } from "../game/lib/state.ts";
import { deriveCapabilities } from "../shared/features/unlock.ts";

function view(over: Partial<CorpView> = {}): CorpView {
  return {
    hasCorporation: true,
    bitNode: 3,
    sf3Level: 0,
    moneyGranted: 0,
    funds: 0,
    revenue: 0,
    expenses: 0,
    unlocks: { officeApi: true, warehouseApi: true, smartSupply: false },
    divisions: [],
    ...over,
  };
}

describe("corporation foundation", () => {
  test("BN3 uses the seed path, while outside BN3 only SF3.3 may self-fund", () => {
    expect(stepCorp(view({ hasCorporation: false, seedFundCheck: "Success" })).actions).toEqual([
      { type: "createCorporation", name: "Automation", selfFund: false },
    ]);
    expect(stepCorp(view({ hasCorporation: false, bitNode: 1, sf3Level: 2 })).status).toBe("blocked");
    expect(stepCorp(view({
      hasCorporation: false,
      bitNode: 1,
      sf3Level: 3,
      selfFundCheck: "Success",
      moneyGranted: CORP_COST.selfFund,
    })).actions[0]).toEqual({ type: "createCorporation", name: "Automation", selfFund: true });
  });

  test("costed steps wait for their exact funding source", () => {
    expect(stepCorp(view()).detail).toContain("$25b");
    expect(stepCorp(view({ funds: CORP_COST.smartSupply })).actions[0]).toEqual({
      type: "purchaseUnlock", unlock: "Smart Supply",
    });
    expect(stepCorp(view({
      funds: CORP_COST.agriculture - 1,
      unlocks: { officeApi: true, warehouseApi: true, smartSupply: true },
    })).stage).toBe("agriculture");
  });

  test("a complete six-city Agriculture baseline stops only after observed profit", () => {
    const division = {
      name: "Agriculture",
      industry: "Agriculture",
      cities: [...CORP_CITIES],
      offices: CORP_CITIES.map((city) => ({
        city, size: 3, numEmployees: 3, jobs: { Operations: 1, Engineer: 1, Business: 1 },
      })),
      warehouses: CORP_CITIES.map((city) => ({
        city,
        smartSupplyEnabled: true,
        materials: ["Plants", "Food"].map((name) => ({ name, desiredSellAmount: "MAX", desiredSellPrice: "MP" })),
      })),
    };
    const waiting = stepCorp(view({
      unlocks: { officeApi: true, warehouseApi: true, smartSupply: true }, divisions: [division], revenue: 1, expenses: 2,
    }));
    expect(waiting.stage).toBe("waiting-profit");
    expect(stepCorp(view({
      unlocks: { officeApi: true, warehouseApi: true, smartSupply: true }, divisions: [division], revenue: 2, expenses: 1,
    })).status).toBe("ready");
  });

  test("core probe observes API unlocks and does not query investment offers", async () => {
    const probe = PRICED_PROBES.find((entry) => entry.id === "corp.core")!;
    const [emission] = await probe.run(probeCtx({
      "corporation.getCorporation": () => ({
        name: "Acme", funds: 1, revenue: 0, expenses: 0, public: false,
        valuation: 1, sharePrice: 1, totalShares: 1, numShares: 1,
        issuedShares: 0, dividendRate: 0, dividendEarnings: 0, nextState: "START",
      }),
      "corporation.hasUnlock": (name: unknown) => name !== "Smart Supply",
    }));
    expect((emission!.data as { unlocks: unknown }).unlocks).toEqual({
      officeApi: true, warehouseApi: true, smartSupply: false,
    });
  });

  test("the live driver can found before a corporation topic exists", async () => {
    const state = initState();
    const caps = deriveCapabilities({
      bitNode: 3,
      sourceFiles: {},
      hasCorporation: false,
      canSelfFundCorporation: "Success",
      canSeedFundCorporation: "Success",
    });
    const calls: { path: string; args: unknown[] }[] = [];
    await FEATURE_MODULES.corp.driver.tick({
      ns: {} as NS,
      nsp: async (path: string, ...args: unknown[]) => {
        calls.push({ path, args });
        return true;
      },
      state,
      caps,
      grants: noGrants(),
    } as unknown as DriverContext);
    expect(calls).toEqual([{
      path: "corporation.createCorporation",
      args: ["Automation", false],
    }]);
    FEATURE_MODULES.corp.reset?.(state, "bitnode");
  });

  test("outside BN3 the arbiter claim is one exact SF3.3 founding spend", () => {
    const state = initState();
    const caps = deriveCapabilities({
      bitNode: 1,
      sourceFiles: { "3": 3 },
      hasCorporation: false,
      canSelfFundCorporation: "Success",
      canSeedFundCorporation: "UseSeedMoneyOutsideBN3",
    });
    const claims = FEATURE_MODULES.corp.claims!({ state, caps } as unknown as ClaimContext);
    expect(claims).toMatchObject([{
      id: "found", amount: CORP_COST.selfFund, mode: "spend", shape: "step", pricing: "hard",
    }]);
  });

  test("void actions are not repeated against the same stale observation", async () => {
    const state = initState();
    state.topics.corp = {
      name: "Acme",
      funds: CORP_COST.smartSupply,
      revenue: 0,
      expenses: 0,
      public: false,
      valuation: 0,
      sharePrice: 0,
      totalShares: 1e9,
      numShares: 1e9,
      issuedShares: 0,
      dividendRate: 0,
      dividendEarnings: 0,
      state: "START",
      unlocks: { officeApi: true, warehouseApi: true, smartSupply: false },
    };
    const caps = deriveCapabilities({
      bitNode: 3,
      sourceFiles: {},
      hasCorporation: true,
      canSelfFundCorporation: "CorporationExists",
      canSeedFundCorporation: "CorporationExists",
    });
    const calls: string[] = [];
    const ctx = {
      ns: {} as NS,
      nsp: async (path: string) => {
        calls.push(path);
        return true;
      },
      state,
      caps,
      grants: noGrants(),
    } as unknown as DriverContext;
    await FEATURE_MODULES.corp.driver.tick(ctx);
    await FEATURE_MODULES.corp.driver.tick(ctx);
    expect(calls).toEqual(["corporation.purchaseUnlock"]);
    expect(state.topics.corp.plan?.lastResults?.[0]?.detail).toContain("awaiting probe");
    FEATURE_MODULES.corp.reset?.(state, "bitnode");
  });
});
