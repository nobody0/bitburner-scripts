import type { NS } from "@ns";
import { sfLevel } from "../../../shared/features/unlock.ts";
import { emit, emitPartial, type DodgedProbe, type Emission, type ProbeContext } from "./index.ts";
import { fleetFrom } from "./local.ts";

/** The dodged probe table — one entry per (feature, cost tier).
 *
 * Every body runs inside a dodge stub and calls ns through BRACKET NOTATION
 * on its own `stubNs`, so nothing here is charged to start.js. `methods` is
 * the contract with the runner: it prices the probe with
 * ns.getFunctionRamCost (itself 0 GB, and it already folds in the singularity
 * 16/4/1 multiplier) and only launches probes that fit the current budget.
 *
 * Features are split into `core` / detail tiers on purpose. Home RAM above
 * HOME_RESERVE_GB belongs to the dispatcher, so the dodge budget stays near
 * ~2.5 GB indefinitely; a cheap core tier that fits is worth far more than
 * one perfect probe that is skipped forever. Anything still too expensive
 * reports `probe.skipped` with its price rather than failing silently. */

/** Cadences as plain literals, never `2 * MINUTE`. esbuild cannot prove a
 * multiplication pure (an operand could have a valueOf), so an arithmetic
 * initializer pins the whole probe object into --perf bundles instead of
 * letting it tree-shake away with the rest of the telemetry code. */
const SEC_30 = 30_000;
const MIN_1 = 60_000;
const MIN_2 = 120_000;
const MIN_5 = 300_000;
const MIN_10 = 600_000;

/** Cap on per-probe list lengths. Records are last-write-wins and rare, but a
 * late-game save has ~1000 augmentations and 33 stock symbols; the panels
 * only ever show a page of them. Totals are reported alongside. */
const LIST_LIMIT = 60;

// --- hacking ---------------------------------------------------------------

const hackingCloud: DodgedProbe = {
  id: "hacking.cloud",
  kind: "dodged",
  feature: "hacking",
  everyMs: SEC_30,
  merge: true,
  methods: ["cloud.getServerLimit", "cloud.getRamLimit", "getTotalScriptIncome", "getTotalScriptExpGain", "getSharePower"],
  run(stubNs: NS, { servers }: ProbeContext) {
    const fleet = fleetFrom(servers);
    fleet.purchased.limit = stubNs["cloud"]["getServerLimit"]();
    fleet.purchased.maxRamPerServer = stubNs["cloud"]["getRamLimit"]();
    fleet.scriptIncome = stubNs["getTotalScriptIncome"]();
    fleet.scriptExpGain = stubNs["getTotalScriptExpGain"]();
    fleet.sharePower = stubNs["getSharePower"]();
    return [emit("fleet", fleet)];
  },
};

// --- progression -----------------------------------------------------------

const progressionMoney: DodgedProbe = {
  id: "progression.money",
  kind: "dodged",
  feature: "progression",
  everyMs: MIN_2,
  merge: true,
  methods: ["getMoneySources"],
  run(stubNs: NS) {
    return [emitPartial("progression", { moneySources: stubNs["getMoneySources"]() })];
  },
};

/** Split out from the money probe and latched, because it is expensive and
 * constant. ns.getBitNodeMultipliers costs 4 GB — more than the whole dodge
 * budget on a fresh 8 GB home (~2.3 GB) — so pricing it together with the free
 * getMoneySources would have made BOTH unaffordable for the entire early game.
 *
 * The multipliers only change when the BitNode does, so `when` reads them once
 * and never again: the controller clears the cached value on a node reset,
 * which re-arms this probe. Without SF5/BN5 the call throws, so `when` also
 * refuses to spend a stub launch discovering that. */
const progressionMults: DodgedProbe = {
  id: "progression.mults",
  kind: "dodged",
  feature: "progression",
  everyMs: MIN_10,
  merge: true,
  methods: ["getBitNodeMultipliers"],
  when: (caps, topics) =>
    (caps.bitNode === 5 || sfLevel(caps.sourceFiles, 5) > 0) && topics.progression?.multipliers === undefined,
  run(stubNs: NS) {
    return [
      emitPartial("progression", {
        multipliers: { ...stubNs["getBitNodeMultipliers"]() } as unknown as Record<string, number>,
      }),
    ];
  },
};

// --- factions (singularity) ------------------------------------------------

const factionStandings: DodgedProbe = {
  id: "factions.standings",
  kind: "dodged",
  feature: "factions",
  requires: "factions",
  everyMs: MIN_1,
  merge: true,
  methods: [
    "singularity.getFactionRep",
    "singularity.getFactionFavor",
    "singularity.checkFactionInvitations",
    "singularity.getFactionInviteRequirements",
    "getFavorToDonate",
  ],
  run(stubNs: NS, { player }: ProbeContext) {
    const favorToDonate = stubNs["getFavorToDonate"]();
    const standings = player.factions.map((faction) => ({
      name: String(faction),
      rep: stubNs["singularity"]["getFactionRep"](faction),
      favor: stubNs["singularity"]["getFactionFavor"](faction),
      favorToDonate,
    }));
    const invites = stubNs["singularity"]["checkFactionInvitations"]().map(String);
    const inviteRequirements: Record<string, string[]> = {};
    for (const invite of invites) {
      inviteRequirements[invite] = stubNs["singularity"]["getFactionInviteRequirements"](
        invite as never,
      ).map((requirement) => JSON.stringify(requirement));
    }
    return [emit("factions", { joined: player.factions.map(String), standings, invites, inviteRequirements })];
  },
};

const factionAugs: DodgedProbe = {
  id: "factions.augs",
  kind: "dodged",
  feature: "factions",
  requires: "factions",
  everyMs: MIN_5,
  merge: true,
  methods: [
    "singularity.getOwnedAugmentations",
    "singularity.getAugmentationsFromFaction",
    "singularity.getAugmentationPrice",
    "singularity.getAugmentationRepReq",
    "singularity.getAugmentationPrereq",
    "singularity.getFactionRep",
    "grafting.getGraftableAugmentations",
    "grafting.getAugmentationGraftPrice",
    "grafting.getAugmentationGraftTime",
  ],
  run(stubNs: NS, { player }: ProbeContext) {
    const owned = new Set(stubNs["singularity"]["getOwnedAugmentations"](true).map(String));
    const offers = [];
    let augTotal = 0;
    for (const faction of player.factions) {
      const rep = stubNs["singularity"]["getFactionRep"](faction);
      for (const name of stubNs["singularity"]["getAugmentationsFromFaction"](faction)) {
        if (owned.has(String(name))) continue;
        augTotal++;
        if (offers.length >= LIST_LIMIT) continue;
        const repReq = stubNs["singularity"]["getAugmentationRepReq"](name);
        offers.push({
          name: String(name),
          faction: String(faction),
          price: stubNs["singularity"]["getAugmentationPrice"](name),
          repReq,
          affordableRep: rep >= repReq,
          owned: false,
          prereqs: stubNs["singularity"]["getAugmentationPrereq"](name).map(String),
        });
      }
    }
    offers.sort((a, b) => a.price - b.price);

    // Grafting is gated by BN10/SF10, NOT by the SF4 that gates the rest of
    // this probe, and it throws rather than returning empty. Isolated so a
    // save with Singularity but no Grafting still gets its augmentation list.
    const graftable = [];
    try {
      for (const name of stubNs["grafting"]["getGraftableAugmentations"]().slice(0, LIST_LIMIT)) {
        graftable.push({
          name: String(name),
          price: stubNs["grafting"]["getAugmentationGraftPrice"](name),
          timeMs: stubNs["grafting"]["getAugmentationGraftTime"](name),
        });
      }
    } catch {
      /* no Grafting API in this BitNode */
    }
    return [emit("factions", { joined: player.factions.map(String), ownedAugs: [...owned], offers, augTotal, graftable })];
  },
};

// --- career (singularity) --------------------------------------------------

const careerWork: DodgedProbe = {
  id: "career.work",
  kind: "dodged",
  feature: "career",
  requires: "factions", // singularity access, same SF4 gate
  everyMs: SEC_30,
  merge: true,
  methods: ["singularity.getCurrentWork", "singularity.isFocused", "singularity.getCompanyRep", "singularity.getCompanyFavor"],
  run(stubNs: NS, { player }: ProbeContext) {
    const work = stubNs["singularity"]["getCurrentWork"]() as ({ type: string } & Record<string, unknown>) | null;
    const companies: Record<string, { rep: number; favor: number }> = {};
    for (const company of Object.keys(player.jobs)) {
      companies[company] = {
        rep: stubNs["singularity"]["getCompanyRep"](company as never),
        favor: stubNs["singularity"]["getCompanyFavor"](company as never),
      };
    }
    return [
      emitPartial("career", {
        currentWork: work
          ? {
              type: work.type,
              detail: String(work.factionName ?? work.companyName ?? work.crimeType ?? work.classType ?? ""),
              focused: stubNs["singularity"]["isFocused"](),
            }
          : undefined,
        companies,
      }),
    ];
  },
};

const careerCrimes: DodgedProbe = {
  id: "career.crimes",
  kind: "dodged",
  feature: "career",
  requires: "factions",
  everyMs: MIN_5,
  merge: true,
  methods: ["singularity.getCrimeChance", "singularity.getCrimeStats"],
  run(stubNs: NS) {
    const names = [
      "Shoplift", "Rob Store", "Mug", "Larceny", "Deal Drugs", "Bond Forgery",
      "Traffick Arms", "Homicide", "Grand Theft Auto", "Kidnap", "Assassination", "Heist",
    ];
    const crimes = names.map((name) => {
      const stats = stubNs["singularity"]["getCrimeStats"](name as never);
      const chance = stubNs["singularity"]["getCrimeChance"](name as never);
      return {
        name,
        chance,
        money: stats.money,
        timeMs: stats.time,
        karma: stats.karma,
        moneyPerSec: stats.time > 0 ? (stats.money * chance) / (stats.time / 1000) : 0,
      };
    });
    crimes.sort((a, b) => b.moneyPerSec - a.moneyPerSec);
    return [emitPartial("career", { crimes })];
  },
};

// --- hacknet ---------------------------------------------------------------

const hacknetCore: DodgedProbe = {
  id: "hacknet.core",
  kind: "dodged",
  feature: "hacknet",
  everyMs: SEC_30,
  merge: true,
  methods: ["hacknet.numNodes", "hacknet.maxNumNodes", "hacknet.getNodeStats", "hacknet.getPurchaseNodeCost"],
  run(stubNs: NS) {
    const numNodes = stubNs["hacknet"]["numNodes"]();
    const nodes = [];
    let totalProduction = 0;
    let productionPerSec = 0;
    let servers = false;
    for (let i = 0; i < Math.min(numNodes, LIST_LIMIT); i++) {
      const stats = stubNs["hacknet"]["getNodeStats"](i);
      if (stats.hashCapacity !== undefined) servers = true;
      totalProduction += stats.totalProduction;
      productionPerSec += stats.production;
      nodes.push({
        name: stats.name,
        level: stats.level,
        ram: stats.ram,
        cores: stats.cores,
        production: stats.production,
        totalProduction: stats.totalProduction,
        timeOnline: stats.timeOnline,
        cache: stats.cache,
        hashCapacity: stats.hashCapacity,
        ramUsed: stats.ramUsed,
      });
    }
    return [
      emit("hacknet", {
        servers,
        numNodes,
        maxNumNodes: stubNs["hacknet"]["maxNumNodes"](),
        purchaseNodeCost: stubNs["hacknet"]["getPurchaseNodeCost"](),
        totalProduction,
        productionPerSec,
        nodes,
      }),
    ];
  },
};

const hacknetUpgrades: DodgedProbe = {
  id: "hacknet.upgrades",
  kind: "dodged",
  feature: "hacknet",
  everyMs: MIN_1,
  merge: true,
  methods: [
    "hacknet.numNodes",
    "hacknet.getLevelUpgradeCost",
    "hacknet.getRamUpgradeCost",
    "hacknet.getCoreUpgradeCost",
    "hacknet.numHashes",
    "hacknet.hashCapacity",
  ],
  run(stubNs: NS) {
    const numNodes = stubNs["hacknet"]["numNodes"]();
    const kinds: { kind: string; cost: (i: number) => number }[] = [
      { kind: "level", cost: (i) => stubNs["hacknet"]["getLevelUpgradeCost"](i, 1) },
      { kind: "ram", cost: (i) => stubNs["hacknet"]["getRamUpgradeCost"](i, 1) },
      { kind: "core", cost: (i) => stubNs["hacknet"]["getCoreUpgradeCost"](i, 1) },
    ];
    const nextUpgrades = [];
    for (const { kind, cost } of kinds) {
      let best: { kind: string; node: number; cost: number } | undefined;
      for (let i = 0; i < Math.min(numNodes, LIST_LIMIT); i++) {
        const value = cost(i);
        if (Number.isFinite(value) && (!best || value < best.cost)) best = { kind, node: i, cost: value };
      }
      if (best) nextUpgrades.push(best);
    }
    // Hash economy exists only for hacknet servers (BN9/SF9). On plain nodes
    // these read as 0 — and in some BitNodes they throw — so the whole read is
    // optional and the panel simply omits the hash tiles.
    let hashes: { current: number; capacity: number } | undefined;
    try {
      const capacity = stubNs["hacknet"]["hashCapacity"]();
      if (capacity > 0) hashes = { current: stubNs["hacknet"]["numHashes"](), capacity };
    } catch {
      /* not a hacknet-server BitNode */
    }
    return [emitPartial("hacknet", { nextUpgrades, hashes })];
  },
};

// --- stock -----------------------------------------------------------------

const stockCore: DodgedProbe = {
  id: "stock.core",
  kind: "dodged",
  feature: "stock",
  requires: "stock",
  everyMs: SEC_30,
  merge: true,
  methods: ["stock.getSymbols", "stock.getPrice", "stock.getPosition", "stock.getMaxShares"],
  run(stubNs: NS) {
    // The capability gate for this feature is hasWseAccount; positions need
    // the separate TIX API, which throws rather than returning empty. Probe it
    // once and degrade to a price-only view — the panel reports which we got.
    let tix = true;
    const positions = [];
    let portfolioValue = 0;
    let portfolioCost = 0;
    for (const sym of stubNs["stock"]["getSymbols"]()) {
      const price = stubNs["stock"]["getPrice"](sym);
      let shares = 0;
      let avgPx = 0;
      let sharesShort = 0;
      let avgPxShort = 0;
      if (tix) {
        try {
          [shares, avgPx, sharesShort, avgPxShort] = stubNs["stock"]["getPosition"](sym);
        } catch {
          tix = false;
        }
      }
      const value = shares * price + sharesShort * price;
      portfolioValue += value;
      portfolioCost += shares * avgPx + sharesShort * avgPxShort;
      positions.push({
        sym,
        price,
        ask: price,
        bid: price,
        maxShares: stubNs["stock"]["getMaxShares"](sym),
        shares,
        avgPx,
        sharesShort,
        avgPxShort,
        value,
        costBasis: shares * avgPx + sharesShort * avgPxShort,
      });
    }
    return [
      emit("stock", {
        hasWseAccount: true,
        hasTixApiAccess: tix,
        // has4SData/has4SDataApi belong to stock.forecast — see StockState.
        positions,
        portfolioValue,
        portfolioCost,
      }),
    ];
  },
};

const stockForecast: DodgedProbe = {
  id: "stock.forecast",
  kind: "dodged",
  feature: "stock",
  requires: "stock",
  everyMs: MIN_1,
  merge: true,
  methods: ["stock.getSymbols", "stock.getForecast", "stock.getVolatility", "stock.getOrganization", "stock.getOrders"],
  run(stubNs: NS) {
    // 4S-only. One try/catch around the lot: without market data every call
    // throws identically, and the panel simply shows prices without signal.
    try {
      // Writes `signals`, never `positions`: this probe runs at half the rate
      // of stock.core and has no position data, so sharing that field would
      // replace real prices with stubs on every merge.
      const signals: Record<string, { organization: string; forecast: number; volatility: number }> = {};
      for (const sym of stubNs["stock"]["getSymbols"]()) {
        signals[sym] = {
          organization: stubNs["stock"]["getOrganization"](sym),
          forecast: stubNs["stock"]["getForecast"](sym),
          volatility: stubNs["stock"]["getVolatility"](sym),
        };
      }
      let orders: Record<string, { type: string; position: string; shares: number; price: number }[]> | undefined;
      try {
        orders = {};
        for (const [sym, list] of Object.entries(stubNs["stock"]["getOrders"]())) {
          orders[sym] = list.map((o) => ({
            type: String(o.type),
            position: String(o.position),
            shares: o.shares,
            price: o.price,
          }));
        }
      } catch {
        orders = undefined; // BN8/SF8.2 only
      }
      return [emitPartial("stock", { has4SData: true, has4SDataApi: true, signals, orders })];
    } catch {
      return [emitPartial("stock", { has4SData: false, has4SDataApi: false })];
    }
  },
};

// --- gang ------------------------------------------------------------------

const gangCore: DodgedProbe = {
  id: "gang.core",
  kind: "dodged",
  feature: "gang",
  requires: "gang",
  everyMs: SEC_30,
  merge: true,
  methods: [
    "gang.getGangInformation",
    "gang.getMemberNames",
    "gang.getMemberInformation",
    "gang.getRecruitsAvailable",
    "gang.canRecruitMember",
    "gang.getAscensionResult",
  ],
  run(stubNs: NS) {
    const info = stubNs["gang"]["getGangInformation"]();
    const members = stubNs["gang"]["getMemberNames"]().map((name) => {
      const m = stubNs["gang"]["getMemberInformation"](name);
      // undefined until the member has enough exp to gain anything.
      const ascension = stubNs["gang"]["getAscensionResult"](name);
      return {
        ascensionResult: ascension
          ? {
              respect: ascension.respect,
              hack: ascension.hack,
              str: ascension.str,
              def: ascension.def,
              dex: ascension.dex,
              agi: ascension.agi,
              cha: ascension.cha,
            }
          : undefined,
        name: m.name,
        task: m.task,
        earnedRespect: m.earnedRespect,
        respectGain: m.respectGain,
        wantedLevelGain: m.wantedLevelGain,
        moneyGain: m.moneyGain,
        skills: { hack: m.hack, str: m.str, def: m.def, dex: m.dex, agi: m.agi, cha: m.cha },
        ascMults: {
          hack: m.hack_asc_mult, str: m.str_asc_mult, def: m.def_asc_mult,
          dex: m.dex_asc_mult, agi: m.agi_asc_mult, cha: m.cha_asc_mult,
        },
        upgrades: m.upgrades.length,
        augmentations: m.augmentations.length,
      };
    });
    return [
      emit("gang", {
        faction: String(info.faction),
        isHacking: info.isHacking,
        respect: info.respect,
        respectGainRate: info.respectGainRate,
        wantedLevel: info.wantedLevel,
        wantedLevelGainRate: info.wantedLevelGainRate,
        wantedPenalty: info.wantedPenalty,
        moneyGainRate: info.moneyGainRate,
        power: info.power,
        territory: info.territory,
        territoryClashChance: info.territoryClashChance,
        territoryWarfareEngaged: info.territoryWarfareEngaged,
        respectForNextRecruit: info.respectForNextRecruit,
        recruitsAvailable: stubNs["gang"]["getRecruitsAvailable"](),
        canRecruit: stubNs["gang"]["canRecruitMember"](),
        members,
      }),
    ];
  },
};

const gangDetail: DodgedProbe = {
  id: "gang.detail",
  kind: "dodged",
  feature: "gang",
  requires: "gang",
  everyMs: MIN_2,
  merge: true,
  // Ascension results live on the member digest, so they are collected by
  // gang.core (which owns `members`) rather than here — this probe cannot
  // write into that array without clobbering it on every merge.
  methods: ["gang.getAllGangInformation", "gang.getChanceToWinClash", "gang.getBonusTime"],
  run(stubNs: NS) {
    const clashChances: Record<string, number> = {};
    for (const other of Object.keys(stubNs["gang"]["getAllGangInformation"]())) {
      clashChances[other] = stubNs["gang"]["getChanceToWinClash"](other as never);
    }
    return [emitPartial("gang", { clashChances, bonusTime: stubNs["gang"]["getBonusTime"]() })];
  },
};

// --- corp ------------------------------------------------------------------

const corpCore: DodgedProbe = {
  id: "corp.core",
  kind: "dodged",
  feature: "corp",
  requires: "corp",
  everyMs: MIN_1,
  merge: true,
  methods: ["corporation.getCorporation", "corporation.getInvestmentOffer"],
  run(stubNs: NS) {
    const c = stubNs["corporation"]["getCorporation"]();
    let investmentOffer;
    try {
      const offer = stubNs["corporation"]["getInvestmentOffer"]();
      investmentOffer = { round: offer.round, funds: offer.funds, shares: offer.shares };
    } catch {
      /* no offer available (already public, or round exhausted) */
    }
    return [
      emit("corp", {
        name: c.name,
        funds: c.funds,
        revenue: c.revenue,
        expenses: c.expenses,
        public: c.public,
        valuation: c.valuation,
        sharePrice: c.sharePrice,
        totalShares: c.totalShares,
        numShares: c.numShares,
        issuedShares: c.issuedShares,
        dividendRate: c.dividendRate,
        dividendEarnings: c.dividendEarnings,
        state: String(c.nextState),
        // `divisions` belongs to the corp.divisions probe — see CorpState.
        investmentOffer,
      }),
    ];
  },
};

const corpDivisions: DodgedProbe = {
  id: "corp.divisions",
  kind: "dodged",
  feature: "corp",
  requires: "corp",
  everyMs: MIN_2,
  merge: true,
  methods: [
    "corporation.getCorporation",
    "corporation.getDivision",
    "corporation.getOffice",
    "corporation.getWarehouse",
    "corporation.hasWarehouse",
  ],
  run(stubNs: NS) {
    const divisions = stubNs["corporation"]["getCorporation"]().divisions.map((name) => {
      const d = stubNs["corporation"]["getDivision"](name);
      const offices = [];
      const warehouses = [];
      for (const city of d.cities) {
        const office = stubNs["corporation"]["getOffice"](name, city);
        offices.push({
          city: String(city),
          size: office.size,
          numEmployees: office.numEmployees,
          avgEnergy: office.avgEnergy,
          avgMorale: office.avgMorale,
          jobs: Object.fromEntries(Object.entries(office.employeeJobs).map(([k, v]) => [String(k), v])),
        });
        if (stubNs["corporation"]["hasWarehouse"](name, city)) {
          const w = stubNs["corporation"]["getWarehouse"](name, city);
          warehouses.push({
            city: String(city),
            level: w.level,
            size: w.size,
            sizeUsed: w.sizeUsed,
            smartSupplyEnabled: w.smartSupplyEnabled,
          });
        }
      }
      return {
        name: d.name,
        industry: String(d.industry),
        awareness: d.awareness,
        popularity: d.popularity,
        productionMult: d.productionMult,
        researchPoints: d.researchPoints,
        lastCycleRevenue: d.lastCycleRevenue,
        lastCycleExpenses: d.lastCycleExpenses,
        numAdVerts: d.numAdVerts,
        cities: d.cities.map(String),
        products: d.products.map(String),
        maxProducts: d.maxProducts,
        offices,
        warehouses,
      };
    });
    return [emitPartial("corp", { divisions })];
  },
};

// --- bladeburner -----------------------------------------------------------

const bladeCore: DodgedProbe = {
  id: "bladeburner.core",
  kind: "dodged",
  feature: "bladeburner",
  requires: "bladeburner",
  everyMs: SEC_30,
  merge: true,
  methods: [
    "bladeburner.getRank",
    "bladeburner.getSkillPoints",
    "bladeburner.getStamina",
    "bladeburner.getCity",
    "bladeburner.getCurrentAction",
    "bladeburner.getActionCurrentTime",
    "bladeburner.getNextBlackOp",
  ],
  run(stubNs: NS) {
    const action = stubNs["bladeburner"]["getCurrentAction"]();
    const next = stubNs["bladeburner"]["getNextBlackOp"]();
    return [
      emit("bladeburner", {
        rank: stubNs["bladeburner"]["getRank"](),
        skillPoints: stubNs["bladeburner"]["getSkillPoints"](),
        stamina: stubNs["bladeburner"]["getStamina"](),
        city: String(stubNs["bladeburner"]["getCity"]()),
        current: action
          ? { type: String(action.type), name: String(action.name), elapsedMs: stubNs["bladeburner"]["getActionCurrentTime"]() }
          : undefined,
        nextBlackOp: next ? { name: String(next.name), rank: next.rank } : undefined,
        // skills/actions/cities belong to the detail probes — see
        // BladeburnerState; emitting placeholders here would blank them.
      }),
    ];
  },
};

const bladeActions: DodgedProbe = {
  id: "bladeburner.actions",
  kind: "dodged",
  feature: "bladeburner",
  requires: "bladeburner",
  everyMs: MIN_2,
  merge: true,
  methods: [
    "bladeburner.getContractNames",
    "bladeburner.getOperationNames",
    "bladeburner.getBlackOpNames",
    "bladeburner.getGeneralActionNames",
    "bladeburner.getActionEstimatedSuccessChance",
    "bladeburner.getActionTime",
    "bladeburner.getActionCountRemaining",
    "bladeburner.getActionCurrentLevel",
    "bladeburner.getActionMaxLevel",
    "bladeburner.getSkillNames",
    "bladeburner.getSkillLevel",
    "bladeburner.getSkillUpgradeCost",
  ],
  run(stubNs: NS) {
    const groups: { type: "contract" | "operation" | "blackop" | "general"; names: string[] }[] = [
      { type: "contract", names: stubNs["bladeburner"]["getContractNames"]().map(String) },
      { type: "operation", names: stubNs["bladeburner"]["getOperationNames"]().map(String) },
      { type: "blackop", names: stubNs["bladeburner"]["getBlackOpNames"]().map(String) },
      { type: "general", names: stubNs["bladeburner"]["getGeneralActionNames"]().map(String) },
    ];
    const actions = [];
    for (const { type, names } of groups) {
      for (const name of names) {
        actions.push({
          type,
          name,
          chance: stubNs["bladeburner"]["getActionEstimatedSuccessChance"](type as never, name as never),
          timeMs: stubNs["bladeburner"]["getActionTime"](type as never, name as never),
          countRemaining: stubNs["bladeburner"]["getActionCountRemaining"](type as never, name as never),
          level: stubNs["bladeburner"]["getActionCurrentLevel"](type as never, name as never),
          maxLevel: stubNs["bladeburner"]["getActionMaxLevel"](type as never, name as never),
        });
      }
    }
    const skills: Record<string, { level: number; upgradeCost: number }> = {};
    for (const skill of stubNs["bladeburner"]["getSkillNames"]()) {
      skills[String(skill)] = {
        level: stubNs["bladeburner"]["getSkillLevel"](skill),
        upgradeCost: stubNs["bladeburner"]["getSkillUpgradeCost"](skill, 1),
      };
    }
    return [emitPartial("bladeburner", { actions, skills })];
  },
};

const bladeCities: DodgedProbe = {
  id: "bladeburner.cities",
  kind: "dodged",
  feature: "bladeburner",
  requires: "bladeburner",
  everyMs: MIN_2,
  merge: true,
  methods: [
    "bladeburner.getCityEstimatedPopulation",
    "bladeburner.getCityCommunities",
    "bladeburner.getCityChaos",
    "bladeburner.getBonusTime",
  ],
  run(stubNs: NS) {
    const names = ["Aevum", "Chongqing", "Sector-12", "New Tokyo", "Ishima", "Volhaven"];
    const cities = names.map((name) => ({
      name,
      population: stubNs["bladeburner"]["getCityEstimatedPopulation"](name as never),
      communities: stubNs["bladeburner"]["getCityCommunities"](name as never),
      chaos: stubNs["bladeburner"]["getCityChaos"](name as never),
    }));
    return [emitPartial("bladeburner", { cities, bonusTime: stubNs["bladeburner"]["getBonusTime"]() })];
  },
};

// --- sleeves ---------------------------------------------------------------

const sleevesCore: DodgedProbe = {
  id: "sleeves.core",
  kind: "dodged",
  feature: "sleeves",
  requires: "sleeves",
  everyMs: SEC_30,
  merge: true,
  methods: ["sleeve.getNumSleeves", "sleeve.getSleeve", "sleeve.getTask"],
  run(stubNs: NS) {
    const count = stubNs["sleeve"]["getNumSleeves"]();
    const sleeves = [];
    for (let i = 0; i < count; i++) {
      const s = stubNs["sleeve"]["getSleeve"](i);
      const task = stubNs["sleeve"]["getTask"](i) as ({ type: string } & Record<string, unknown>) | null;
      sleeves.push({
        index: i,
        shock: s.shock,
        sync: s.sync,
        memory: s.memory,
        storedCycles: s.storedCycles,
        city: String(s.city),
        hp: { current: s.hp.current, max: s.hp.max },
        skills: {
          hacking: s.skills.hacking, strength: s.skills.strength, defense: s.skills.defense,
          dexterity: s.skills.dexterity, agility: s.skills.agility, charisma: s.skills.charisma,
        },
        task: task
          ? { type: task.type, detail: String(task.factionName ?? task.companyName ?? task.crimeType ?? task.classType ?? "") }
          : undefined,
      });
    }
    return [emit("sleeves", { count, sleeves })];
  },
};

// --- go --------------------------------------------------------------------

const goCore: DodgedProbe = {
  id: "go.core",
  kind: "dodged",
  feature: "go",
  requires: "go",
  everyMs: SEC_30,
  merge: true,
  methods: ["go.getGameState", "go.getCurrentPlayer", "go.getOpponent", "go.analysis.getStats"],
  run(stubNs: NS) {
    const state = stubNs["go"]["getGameState"]();
    const stats = Object.entries(stubNs["go"]["analysis"]["getStats"]()).map(([opponent, s]) => ({
      opponent,
      wins: s.wins,
      losses: s.losses,
      winStreak: s.winStreak,
      highestWinStreak: s.highestWinStreak,
      rep: s.rep,
      bonusPercent: s.bonusPercent,
      bonusDescription: s.bonusDescription,
    }));
    return [
      emitPartial("go", {
        status: state.currentPlayer === "None" ? "gameOver" : "inProgress",
        currentPlayer: stubNs["go"]["getCurrentPlayer"](),
        opponent: String(stubNs["go"]["getOpponent"]()),
        whiteScore: state.whiteScore,
        blackScore: state.blackScore,
        stats,
      }),
    ];
  },
};

const goBoard: DodgedProbe = {
  id: "go.board",
  kind: "dodged",
  feature: "go",
  requires: "go",
  everyMs: MIN_1,
  merge: true,
  methods: ["go.getBoardState", "go.getMoveHistory", "go.analysis.getControlledEmptyNodes"],
  run(stubNs: NS) {
    const board = stubNs["go"]["getBoardState"]();
    const controlled = stubNs["go"]["analysis"]["getControlledEmptyNodes"]();
    let black = 0;
    let white = 0;
    for (const row of controlled) {
      for (const cell of row) {
        if (cell === "X") black++;
        else if (cell === "O") white++;
      }
    }
    return [
      emitPartial("go", {
        board,
        boardSize: board.length,
        moveCount: stubNs["go"]["getMoveHistory"]().length,
        territory: { black, white },
      }),
    ];
  },
};

// --- stanek ----------------------------------------------------------------

const stanekCore: DodgedProbe = {
  id: "stanek.core",
  kind: "dodged",
  feature: "stanek",
  requires: "stanek",
  everyMs: MIN_1,
  merge: true,
  methods: ["stanek.giftWidth", "stanek.giftHeight", "stanek.activeFragments", "stanek.fragmentDefinitions"],
  run(stubNs: NS) {
    const active = stubNs["stanek"]["activeFragments"]();
    const occupied: Record<string, number> = {};
    const fragments = active.map((f) => {
      // shape is the unrotated footprint; the exact cells matter less to the
      // panel than "this fragment sits here", so anchor + shape is enough.
      for (let dy = 0; dy < f.shape.length; dy++) {
        for (let dx = 0; dx < (f.shape[dy]?.length ?? 0); dx++) {
          if (f.shape[dy]![dx]) occupied[`${f.x + dx},${f.y + dy}`] = f.id;
        }
      }
      return {
        id: f.id,
        type: String(f.type),
        x: f.x,
        y: f.y,
        rotation: f.rotation,
        power: f.power,
        limit: f.limit,
        effect: f.effect,
        numCharge: f.numCharge,
        highestCharge: f.highestCharge,
        chargedEffect: f.chargedEffect,
      };
    });
    return [
      emit("stanek", {
        width: stubNs["stanek"]["giftWidth"](),
        height: stubNs["stanek"]["giftHeight"](),
        occupied,
        fragments,
        availableTypes: stubNs["stanek"]["fragmentDefinitions"]().map((f) => ({
          id: f.id,
          type: String(f.type),
          power: f.power,
          limit: f.limit,
        })),
      }),
    ];
  },
};

// --- darknet ---------------------------------------------------------------

const dnetCore: DodgedProbe = {
  id: "dnet.core",
  kind: "dodged",
  feature: "dnet",
  requires: "dnet",
  everyMs: MIN_1,
  merge: true,
  methods: [
    "dnet.probe",
    "dnet.getServerDetails",
    "dnet.getDepth",
    "dnet.getBlockedRam",
    "dnet.getStasisLinkLimit",
    "dnet.getStasisLinkedServers",
    "dnet.getDarknetInstability",
    "dnet.getServerRequiredCharismaLevel",
  ],
  run(stubNs: NS) {
    const hosts = stubNs["dnet"]["probe"]();
    const linked = new Set(stubNs["dnet"]["getStasisLinkedServers"]().map(String));
    let maxDepth = 0;
    const servers = [];
    for (const host of hosts.slice(0, LIST_LIMIT)) {
      const depth = stubNs["dnet"]["getDepth"](host);
      if (depth > maxDepth) maxDepth = depth;
      servers.push({
        hostname: host,
        depth,
        blockedRam: stubNs["dnet"]["getBlockedRam"](host),
        isOnline: stubNs["dnet"]["getServerDetails"](host).isOnline,
        requiredCharisma: stubNs["dnet"]["getServerRequiredCharismaLevel"](host),
        stasisLinked: linked.has(host),
      });
    }
    return [
      emit("dnet", {
        reachable: hosts.length,
        maxDepth,
        stasisLinkLimit: stubNs["dnet"]["getStasisLinkLimit"](),
        stasisLinked: [...linked],
        instability: stubNs["dnet"]["getDarknetInstability"](),
        servers,
      }),
    ];
  },
};

// --- side ------------------------------------------------------------------

const sideContracts: DodgedProbe = {
  id: "side.contracts",
  kind: "dodged",
  feature: "side",
  everyMs: MIN_1,
  merge: true,
  methods: ["ls", "codingcontract.getContractType", "codingcontract.getNumTriesRemaining"],
  run(stubNs: NS, { servers }: ProbeContext) {
    const contracts = [];
    for (const host of Object.keys(servers)) {
      for (const file of stubNs["ls"](host, ".cct")) {
        contracts.push({
          host,
          file,
          type: stubNs["codingcontract"]["getContractType"](file, host),
          triesRemaining: stubNs["codingcontract"]["getNumTriesRemaining"](file, host),
        });
      }
    }
    return [emit("side", { contracts })];
  },
};

const sideInfiltration: DodgedProbe = {
  id: "side.infiltration",
  kind: "dodged",
  feature: "side",
  everyMs: MIN_10,
  merge: true,
  methods: ["infiltration.getPossibleLocations", "infiltration.getInfiltration"],
  run(stubNs: NS) {
    const locations = stubNs["infiltration"]["getPossibleLocations"]();
    const infiltration = [];
    for (const location of locations) {
      const info = stubNs["infiltration"]["getInfiltration"](location.name);
      infiltration.push({
        location: String(location.name),
        city: String(location.city),
        difficulty: info.difficulty,
        maxClearanceLevel: info.maxClearanceLevel,
        startingSecurityLevel: info.startingSecurityLevel,
        repReward: info.reward.tradeRep,
        moneyReward: info.reward.sellCash,
        moneyPerDifficulty: info.difficulty > 0 ? info.reward.sellCash / info.difficulty : 0,
      });
    }
    infiltration.sort((a, b) => b.moneyPerDifficulty - a.moneyPerDifficulty);
    return [emitPartial("side", { infiltration, infiltrationTotal: locations.length })];
  },
};

export const DODGED_PROBES: readonly DodgedProbe[] = [
  hackingCloud,
  progressionMoney,
  progressionMults,
  factionStandings,
  factionAugs,
  careerWork,
  careerCrimes,
  hacknetCore,
  hacknetUpgrades,
  stockCore,
  stockForecast,
  gangCore,
  gangDetail,
  corpCore,
  corpDivisions,
  bladeCore,
  bladeActions,
  bladeCities,
  sleevesCore,
  goCore,
  goBoard,
  stanekCore,
  dnetCore,
  sideContracts,
  sideInfiltration,
];

export type { Emission };
