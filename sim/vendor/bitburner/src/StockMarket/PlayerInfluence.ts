// Vendored from bitburner-src v3.0.1:src/StockMarket/PlayerInfluencing.ts (5 symbols, extracted by
// tools/vendor.ts — the rest of that file is not portable) — DO NOT EDIT
import { Stock } from "./Stock";
import { StockMarket, stockRandom } from "./MarketAdapter";

/** The two fields upstream's `Server` argument is actually read for. */
interface Server {
  organizationName: string;
  moneyMax: number;
}
interface Company { name: string; }

export const forecastForecastChangeFromHack = 0.1;

export const forecastForecastChangeFromCompanyWork = 0.001;

export function influenceStockThroughServerHack(server: Server, moneyHacked: number): void {
  const orgName = server.organizationName;
  let stock: Stock | null = null;
  if (typeof orgName === "string" && orgName !== "") {
    stock = StockMarket[orgName];
  }
  if (!(stock instanceof Stock)) {
    return;
  }

  const percTotalMoneyHacked = moneyHacked / server.moneyMax;
  if (stockRandom() < percTotalMoneyHacked) {
    stock.changeForecastForecast(stock.otlkMagForecast - forecastForecastChangeFromHack);
  }
}

export function influenceStockThroughServerGrow(server: Server, moneyGrown: number): void {
  const orgName = server.organizationName;
  let stock: Stock | null = null;
  if (typeof orgName === "string" && orgName !== "") {
    stock = StockMarket[orgName];
  }
  if (!(stock instanceof Stock)) {
    return;
  }

  const percTotalMoneyGrown = moneyGrown / server.moneyMax;
  if (stockRandom() < percTotalMoneyGrown) {
    stock.changeForecastForecast(stock.otlkMagForecast + forecastForecastChangeFromHack);
  }
}

export function influenceStockThroughCompanyWork(
  company: Company,
  performanceMult: number,
  cyclesOfWork: number,
): void {
  const compName = company.name;
  let stock: Stock | null = null;
  stock = StockMarket[compName];
  if (!(stock instanceof Stock)) {
    return;
  }

  if (stockRandom() < 0.002 * cyclesOfWork) {
    const change = forecastForecastChangeFromCompanyWork * performanceMult;
    stock.changeForecastForecast(stock.otlkMagForecast + change);
  }
}
