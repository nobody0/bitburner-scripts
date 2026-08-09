/** The 33 stock symbols, transcribed from
 * `bitburner-src v3.0.1 src/StockMarket/data/InitStockMetadata.ts` and
 * `src/Server/data/servers.ts` (see spec/game-source.md).
 *
 * Two things live here, and both are static game data no ns getter provides:
 *
 *  1. **The generation ranges.** Like `SERVER_RANGES`, most fields are declared
 *     upstream as `{min, max}` and rolled ONCE at world generation
 *     (`Stock.toNumber` -> `getRandomIntInclusive`). So a live `getVolatility()`
 *     of 0.005 is uninterpretable on its own — is that a bad roll for ECP or a
 *     great one for JGN? The ranges are also what lets the strategy act at all
 *     BEFORE 4S: without the API there is no forecast and no volatility, but the
 *     volatility RANGE is knowable, which is enough to size a position.
 *
 *  2. **The symbol <-> server mapping.** Hack/grow stock influence looks the
 *     stock up by `server.organizationName`
 *     (`StockMarket/PlayerInfluencing.ts`), so the organization is the join key
 *     between a farm target and a tradeable symbol. Computed here rather than
 *     through `ns.stock.getOrganization` (2 GB) because it cannot change.
 *
 * Two facts about that mapping the strategy has to respect:
 *  - **WDS has no server.** Watchdog Security is a company you can work for but
 *    not a host on the network, so its symbol can never be manipulated.
 *  - **FLCM has two.** `fulcrumtech` and `fulcrumassets` share Fulcrum
 *    Technologies, so either can drive the same symbol.
 *
 * Lives in `shared/features/` rather than being read from the vendored copy
 * because `game/` ships in the bundle and `ui/` may not import `sim/`
 * (tests/boundaries.test.ts). Pinned field-by-field against that copy by
 * `sim/tests/stock-parity.test.ts`; after a vendor bump a failure there is the
 * signal to update this table, not a regression. */

/** An upstream `{min, max}` (already divided by its `divisor`), or a fixed
 *  value as a degenerate range. */
export type Range = readonly [number, number];

export interface StockMetadata {
  /** `server.organizationName` — the key stock influence joins on. */
  organization: string;
  /** Hosts belonging to that organization. Empty for WDS. */
  hosts: readonly string[];
  /** Share price at world generation. Drifts immediately. */
  initPrice: Range;
  marketCap: number;
  /** `Stock.mv`, a PERCENT. `ns.stock.getVolatility()` returns `mv / 100`, and
   *  the per-tick move is `v * mv / 100` with `v ~ U(0,1)` shared by every
   *  symbol in the tick — so the realized magnitude averages HALF of what
   *  getVolatility reports. See shared/strategy/stock/market.ts. */
  mv: Range;
  /** `Stock.spreadPerc`, a PERCENT per side: ask = price * (1 + spreadPerc/100),
   *  bid = price * (1 - spreadPerc/100). A round trip therefore costs
   *  `2 * spreadPerc%` of notional — for the wide symbols (NTLK at up to 2.0)
   *  that is 4%, dwarfing the $200k of commission. */
  spreadPerc: Range;
  /** Shares that must be transacted to trigger one price movement, each of
   *  which drags the forecast back toward neutral. This is the cost of SIZE. */
  shareTxForMovement: Range;
  /** Outlook magnitude at world generation only; it random-walks from there. */
  otlkMag: number;
  /** Bull (price biased up) at world generation only. */
  bull: boolean;
}

export const STOCK_METADATA: Readonly<Record<string, StockMetadata>> = {
  ECP: { organization: "ECorp", hosts: ["ecorp"], initPrice: [17000, 28000], marketCap: 2400000000000, mv: [0.4, 0.5], spreadPerc: [0.1, 0.5], shareTxForMovement: [30000, 90000], otlkMag: 19, bull: true },
  MGCP: { organization: "MegaCorp", hosts: ["megacorp"], initPrice: [24000, 34000], marketCap: 2400000000000, mv: [0.4, 0.5], spreadPerc: [0.1, 0.5], shareTxForMovement: [30000, 90000], otlkMag: 19, bull: true },
  BLD: { organization: "Blade Industries", hosts: ["blade"], initPrice: [12000, 25000], marketCap: 1600000000000, mv: [0.7, 0.8], spreadPerc: [0.1, 0.6], shareTxForMovement: [30000, 90000], otlkMag: 13, bull: true },
  CLRK: { organization: "Clarke Incorporated", hosts: ["clarkinc"], initPrice: [10000, 25000], marketCap: 1500000000000, mv: [0.65, 0.75], spreadPerc: [0.1, 0.5], shareTxForMovement: [30000, 90000], otlkMag: 12, bull: true },
  OMTK: { organization: "OmniTek Incorporated", hosts: ["omnitek"], initPrice: [32000, 43000], marketCap: 1800000000000, mv: [0.6, 0.7], spreadPerc: [0.1, 0.6], shareTxForMovement: [30000, 90000], otlkMag: 12, bull: true },
  FSIG: { organization: "Four Sigma", hosts: ["4sigma"], initPrice: [50000, 80000], marketCap: 2000000000000, mv: [1, 1.1], spreadPerc: [0.1, 1], shareTxForMovement: [30000, 90000], otlkMag: 17, bull: true },
  KGI: { organization: "KuaiGong International", hosts: ["kuai-gong"], initPrice: [16000, 28000], marketCap: 1900000000000, mv: [0.75, 0.85], spreadPerc: [0.1, 0.7], shareTxForMovement: [30000, 90000], otlkMag: 10, bull: true },
  FLCM: { organization: "Fulcrum Technologies", hosts: ["fulcrumtech", "fulcrumassets"], initPrice: [29000, 36000], marketCap: 2000000000000, mv: [1.2, 1.3], spreadPerc: [0.1, 1], shareTxForMovement: [30000, 90000], otlkMag: 16, bull: true },
  STM: { organization: "Storm Technologies", hosts: ["stormtech"], initPrice: [20000, 25000], marketCap: 1200000000000, mv: [0.8, 0.9], spreadPerc: [0.2, 1], shareTxForMovement: [36000, 108000], otlkMag: 7, bull: true },
  DCOMM: { organization: "DefComm", hosts: ["defcomm"], initPrice: [6000, 19000], marketCap: 900000000000, mv: [0.6, 0.7], spreadPerc: [0.2, 1], shareTxForMovement: [36000, 108000], otlkMag: 10, bull: true },
  HLS: { organization: "Helios Labs", hosts: ["helios"], initPrice: [10000, 18000], marketCap: 825000000000, mv: [0.55, 0.65], spreadPerc: [0.2, 1], shareTxForMovement: [36000, 108000], otlkMag: 9, bull: true },
  VITA: { organization: "VitaLife", hosts: ["vitalife"], initPrice: [8000, 14000], marketCap: 1000000000000, mv: [0.7, 0.8], spreadPerc: [0.2, 1], shareTxForMovement: [36000, 108000], otlkMag: 7, bull: true },
  ICRS: { organization: "Icarus Microsystems", hosts: ["icarus"], initPrice: [12000, 24000], marketCap: 800000000000, mv: [0.6, 0.7], spreadPerc: [0.3, 1], shareTxForMovement: [36000, 108000], otlkMag: 7.5, bull: true },
  UNV: { organization: "Universal Energy", hosts: ["univ-energy"], initPrice: [16000, 29000], marketCap: 900000000000, mv: [0.5, 0.6], spreadPerc: [0.2, 1], shareTxForMovement: [36000, 108000], otlkMag: 10, bull: true },
  AERO: { organization: "AeroCorp", hosts: ["aerocorp"], initPrice: [8000, 17000], marketCap: 640000000000, mv: [0.55, 0.65], spreadPerc: [0.3, 1], shareTxForMovement: [42000, 126000], otlkMag: 6, bull: true },
  OMN: { organization: "Omnia Cybersystems", hosts: ["omnia"], initPrice: [6000, 15000], marketCap: 600000000000, mv: [0.65, 0.75], spreadPerc: [0.4, 1.1], shareTxForMovement: [42000, 126000], otlkMag: 4.5, bull: true },
  SLRS: { organization: "Solaris Space Systems", hosts: ["solaris"], initPrice: [14000, 28000], marketCap: 705000000000, mv: [0.7, 0.8], spreadPerc: [0.4, 1.2], shareTxForMovement: [42000, 126000], otlkMag: 8.5, bull: true },
  GPH: { organization: "Global Pharmaceuticals", hosts: ["global-pharm"], initPrice: [12000, 30000], marketCap: 695000000000, mv: [0.55, 0.65], spreadPerc: [0.4, 1], shareTxForMovement: [42000, 126000], otlkMag: 10.5, bull: true },
  NVMD: { organization: "Nova Medical", hosts: ["nova-med"], initPrice: [15000, 27000], marketCap: 600000000000, mv: [0.7, 0.8], spreadPerc: [0.4, 1.1], shareTxForMovement: [42000, 126000], otlkMag: 5, bull: true },
  WDS: { organization: "Watchdog Security", hosts: [], initPrice: [4000, 8500], marketCap: 450000000000, mv: [2.4, 2.6], spreadPerc: [0.5, 1.2], shareTxForMovement: [12000, 54000], otlkMag: 1.5, bull: true },
  LXO: { organization: "LexoCorp", hosts: ["lexo-corp"], initPrice: [4500, 8000], marketCap: 300000000000, mv: [1.15, 1.35], spreadPerc: [0.5, 1.2], shareTxForMovement: [36000, 108000], otlkMag: 6, bull: true },
  RHOC: { organization: "Rho Construction", hosts: ["rho-construction"], initPrice: [2000, 7000], marketCap: 180000000000, mv: [0.5, 0.7], spreadPerc: [0.3, 1], shareTxForMovement: [60000, 126000], otlkMag: 1, bull: true },
  APHE: { organization: "Alpha Enterprises", hosts: ["alpha-ent"], initPrice: [4000, 8500], marketCap: 240000000000, mv: [1.75, 2.05], spreadPerc: [0.5, 1.6], shareTxForMovement: [30000, 90000], otlkMag: 10, bull: true },
  SYSC: { organization: "SysCore Securities", hosts: ["syscore"], initPrice: [3000, 8000], marketCap: 200000000000, mv: [1.5, 1.7], spreadPerc: [0.5, 1.2], shareTxForMovement: [15000, 90000], otlkMag: 3, bull: true },
  CTK: { organization: "CompuTek", hosts: ["computek"], initPrice: [1000, 6000], marketCap: 185000000000, mv: [0.8, 1], spreadPerc: [0.4, 1.2], shareTxForMovement: [60000, 126000], otlkMag: 4, bull: true },
  NTLK: { organization: "NetLink Technologies", hosts: ["netlink"], initPrice: [1000, 5000], marketCap: 58000000000, mv: [2, 4], spreadPerc: [0.5, 2], shareTxForMovement: [18000, 54000], otlkMag: 1, bull: true },
  OMGA: { organization: "Omega Software", hosts: ["omega-net"], initPrice: [1000, 8000], marketCap: 60000000000, mv: [0.9, 1.1], spreadPerc: [0.4, 1.3], shareTxForMovement: [30000, 90000], otlkMag: 0.5, bull: true },
  FNS: { organization: "FoodNStuff", hosts: ["foodnstuff"], initPrice: [500, 4500], marketCap: 45000000000, mv: [0.7, 0.8], spreadPerc: [0.6, 1], shareTxForMovement: [60000, 180000], otlkMag: 1, bull: false },
  SGC: { organization: "Sigma Cosmetics", hosts: ["sigma-cosmetics"], initPrice: [1500, 3500], marketCap: 30000000000, mv: [1, 2.75], spreadPerc: [0.6, 1.4], shareTxForMovement: [20000, 70000], otlkMag: 0, bull: true },
  JGN: { organization: "Joe's Guns", hosts: ["joesguns"], initPrice: [250, 1500], marketCap: 42000000000, mv: [2, 3.5], spreadPerc: [0.6, 1.4], shareTxForMovement: [15000, 52000], otlkMag: 1, bull: true },
  CTYS: { organization: "Catalyst Ventures", hosts: ["catalyst"], initPrice: [250, 1500], marketCap: 100000000000, mv: [1.2, 1.75], spreadPerc: [0.5, 1.4], shareTxForMovement: [24000, 72000], otlkMag: 13.5, bull: true },
  MDYN: { organization: "Microdyne Technologies", hosts: ["microdyne"], initPrice: [15000, 30000], marketCap: 360000000000, mv: [0.7, 0.8], spreadPerc: [0.3, 1], shareTxForMovement: [90000, 216000], otlkMag: 8, bull: true },
  TITN: { organization: "Titan Laboratories", hosts: ["titan-labs"], initPrice: [12000, 24000], marketCap: 420000000000, mv: [0.5, 0.7], spreadPerc: [0.2, 1], shareTxForMovement: [90000, 216000], otlkMag: 11, bull: true },
};

export const STOCK_SYMBOLS: readonly string[] = Object.keys(STOCK_METADATA);

export function stockMetadata(symbol: string): StockMetadata | undefined {
  return STOCK_METADATA[symbol];
}

/** hostname -> symbol. Two Fulcrum hosts collapse onto FLCM. */
export const SYMBOL_BY_HOST: Readonly<Record<string, string>> = Object.fromEntries(
  Object.entries(STOCK_METADATA).flatMap(([symbol, meta]) => meta.hosts.map((host) => [host, symbol])),
);

export function symbolForHost(hostname: string): string | undefined {
  return SYMBOL_BY_HOST[hostname];
}

/** Midpoint of a generation range — the best point estimate before the live
 *  value is readable, and the ONLY estimate available for volatility without
 *  4S. `mid` of a degenerate range is the value itself. */
export function midpoint(range: Range): number {
  return (range[0] + range[1]) / 2;
}

/** `ns.stock.getVolatility()`'s units (a per-tick fraction) from the metadata's
 *  percent, so callers never have to remember the /100. */
export function volatilityEstimate(symbol: string): number {
  const meta = STOCK_METADATA[symbol];
  return meta ? midpoint(meta.mv) / 100 : 0;
}

/** Worst-case round-trip spread cost as a FRACTION of notional, from the
 *  metadata alone: `2 * spreadPerc/100` at the top of the range.
 *
 *  Deliberately pessimistic. The live ask/bid give the exact figure once the
 *  probe has run; this is what bounds a decision taken before it has, and
 *  overestimating a cost can only make us trade too little. */
export function worstSpreadFraction(symbol: string): number {
  const meta = STOCK_METADATA[symbol];
  return meta ? (2 * meta.spreadPerc[1]) / 100 : 0;
}
