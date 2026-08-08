import type { NS } from "@ns";
import { armWorkCompletion, workDetail, type WorkTaskLike } from "../work-completion.ts";
import { sfLevel } from "../../../shared/features/unlock.ts";
import { canSolve } from "../../../shared/strategy/side/contracts.ts";
import type { AugmentationMeta } from "../../../shared/telemetry/topics/factions.ts";
import type { ContractDigest } from "../../../shared/telemetry/topics/side.ts";
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

/** Standing at every joined faction, plus pending invitations and enemies.
 *
 * Stepped, because the singularity getters cost 5 GB EACH once SF4's 16/4/1
 * multiplier is applied: five of them in one closure is ~25 GB, against a
 * dodge budget that is a fraction of that on any early home. One method per
 * step makes the PEAK price 5 GB instead of the sum. */
const factionStandings: DodgedProbe = {
  id: "factions.standings",
  kind: "dodged",
  feature: "factions",
  requires: "factions",
  everyMs: MIN_1,
  merge: true,
  steps: [
    {
      id: "rep",
      methods: ["singularity.getFactionRep"],
      run(stubNs: NS, { player }: ProbeContext, acc) {
        const rep: Record<string, number> = {};
        for (const faction of player.factions) rep[String(faction)] = stubNs["singularity"]["getFactionRep"](faction);
        acc["rep"] = rep;
      },
    },
    {
      id: "favor",
      methods: ["singularity.getFactionFavor", "getFavorToDonate"],
      run(stubNs: NS, { player }: ProbeContext, acc) {
        const favor: Record<string, number> = {};
        for (const faction of player.factions) {
          favor[String(faction)] = stubNs["singularity"]["getFactionFavor"](faction);
        }
        acc["favor"] = favor;
        acc["favorToDonate"] = stubNs["getFavorToDonate"]();
      },
    },
    {
      id: "invites",
      methods: ["singularity.checkFactionInvitations"],
      run(stubNs: NS, _ctx: ProbeContext, acc) {
        acc["invites"] = stubNs["singularity"]["checkFactionInvitations"]().map(String);
      },
    },
    {
      id: "workTypes",
      methods: ["singularity.getFactionWorkTypes"],
      run(stubNs: NS, _ctx: ProbeContext, acc) {
        // Which work types each faction actually offers. NOT optional: without
        // it the planner has to guess, and guessing "all three" makes it issue
        // `workForFaction(Tetrads, "hacking")` — which Tetrads does not offer,
        // so the call fails every tick and reputation never accrues.
        //
        // EVERY faction, not just the joined ones. The planner estimates how
        // long a faction would take to earn reputation at BEFORE deciding to
        // join it, so restricting this to current members leaves every
        // candidate looking unworkable and empties the objective.
        const workTypes: Record<string, string[]> = {};
        for (const faction of Object.values(stubNs["enums"]["FactionName"]) as string[]) {
          try {
            workTypes[faction] = stubNs["singularity"]["getFactionWorkTypes"](faction as never).map(String);
          } catch {
            /* a faction this node does not define */
          }
        }
        acc["workTypes"] = workTypes;
      },
    },
    {
      id: "enemies",
      methods: ["singularity.getFactionEnemies"],
      run(stubNs: NS, _ctx: ProbeContext, acc) {
        // A join permanently BANS these, so the panel must be able to show
        // what a join gives up before it happens.
        const enemies: Record<string, string[]> = {};
        for (const faction of Object.values(stubNs["enums"]["FactionName"]) as string[]) {
          try {
            enemies[faction] = stubNs["singularity"]["getFactionEnemies"](faction as never).map(String);
          } catch {
            /* a faction this node does not define */
          }
        }
        acc["enemies"] = enemies;
      },
    },
  ],
  finish(acc) {
    // Tolerates a partial accumulator: a later step being unaffordable does
    // not invalidate what the earlier ones learned.
    const rep = (acc["rep"] as Record<string, number>) ?? {};
    const favor = (acc["favor"] as Record<string, number>) ?? {};
    const enemies = (acc["enemies"] as Record<string, string[]>) ?? {};
    const workTypes = (acc["workTypes"] as Record<string, string[]>) ?? {};
    const favorToDonate = acc["favorToDonate"] as number | undefined;
    const standings = Object.keys({ ...rep, ...favor }).map((name) => ({
      name,
      rep: rep[name] ?? 0,
      favor: favor[name] ?? 0,
    }));
    return [
      emitPartial("factions", {
        standings,
        ...(acc["invites"] !== undefined ? { invites: acc["invites"] as string[] } : {}),
        ...(favorToDonate !== undefined ? { favorToDonate } : {}),
        ...(acc["workTypes"] !== undefined ? { workTypes } : {}),
        ...(acc["enemies"] !== undefined ? { enemies } : {}),
      }),
    ];
  },
};

/** STRUCTURED invite requirements for every faction the game knows about.
 *
 * Three things make this its own probe. `ns.enums.FactionName` is a 0 GB
 * property, so enumerating ALL factions costs nothing beyond the getter —
 * which matters because the planner must reason about factions it has not been
 * invited to yet. The tree only changes when the BitNode does, so `when`
 * latches it. And the requirements must be the STRUCTURED tree: the strategy
 * has to tell an OR branch from an AND, which a display string cannot express. */
const factionRequirements: DodgedProbe = {
  id: "factions.requirements",
  kind: "dodged",
  feature: "factions",
  requires: "factions",
  everyMs: MIN_10,
  merge: true,
  when: (_caps, topics) => topics.factions?.requirements === undefined,
  steps: [
    {
      id: "all",
      methods: ["singularity.getFactionInviteRequirements"],
      run(stubNs: NS, _ctx: ProbeContext, acc) {
        const requirements: Record<string, unknown[]> = {};
        const names = Object.values(stubNs["enums"]["FactionName"]) as string[];
        for (const name of names) {
          try {
            requirements[name] = stubNs["singularity"]["getFactionInviteRequirements"](name as never);
          } catch {
            /* a faction this node does not define */
          }
        }
        acc["requirements"] = requirements;
      },
    },
  ],
  finish(acc) {
    return [
      emitPartial("factions", {
        requirements: (acc["requirements"] ?? {}) as never,
      }),
    ];
  },
};

/** The augmentation catalogue.
 *
 * This is the probe that motivated stepped dodging. Nine singularity methods
 * in one closure sum to ~33.5 GB even inside BN4, against a dodge budget that
 * used to be pinned near 2.4 GB — so it could never run. One or two methods
 * per step brings the PEAK to ~5-10 GB, which the fleet can serve.
 *
 * Every step tolerates the previous ones having been skipped, and `finish`
 * emits whatever was learned. */
const factionAugs: DodgedProbe = {
  id: "factions.augs",
  kind: "dodged",
  feature: "factions",
  requires: "factions",
  everyMs: MIN_5,
  merge: true,
  steps: [
    {
      id: "owned",
      methods: ["singularity.getOwnedAugmentations"],
      run(stubNs: NS, _ctx: ProbeContext, acc) {
        acc["owned"] = stubNs["singularity"]["getOwnedAugmentations"](true).map(String);
      },
    },
    {
      id: "catalog",
      methods: ["singularity.getAugmentationsFromFaction"],
      run(stubNs: NS, _ctx: ProbeContext, acc) {
        // EVERY faction, not just the joined ones. This getter does not
        // require membership, and restricting it to joined factions would
        // leave the planner unable to value a faction it has not joined —
        // which is precisely the decision it needs to make.
        const owned = new Set((acc["owned"] as string[]) ?? []);
        const byFaction: Record<string, string[]> = {};
        let total = 0;
        for (const faction of Object.values(stubNs["enums"]["FactionName"]) as string[]) {
          try {
            const names = stubNs["singularity"]["getAugmentationsFromFaction"](faction as never)
              .map(String)
              .filter((name) => !owned.has(name));
            if (names.length === 0) continue;
            byFaction[faction] = names;
            total += names.length;
          } catch {
            /* a faction this node does not define */
          }
        }
        acc["byFaction"] = byFaction;
        acc["augTotal"] = total;
      },
    },
    {
      id: "price",
      methods: ["singularity.getAugmentationPrice"],
      run(stubNs: NS, _ctx: ProbeContext, acc) {
        const prices: Record<string, number> = {};
        for (const name of listedAugs(acc)) prices[name] = stubNs["singularity"]["getAugmentationPrice"](name as never);
        acc["prices"] = prices;
      },
    },
    {
      id: "rep",
      methods: ["singularity.getAugmentationRepReq", "singularity.getFactionRep"],
      run(stubNs: NS, { player }: ProbeContext, acc) {
        const repReq: Record<string, number> = {};
        for (const name of listedAugs(acc)) repReq[name] = stubNs["singularity"]["getAugmentationRepReq"](name as never);
        acc["repReq"] = repReq;
        const rep: Record<string, number> = {};
        for (const faction of player.factions) rep[String(faction)] = stubNs["singularity"]["getFactionRep"](faction);
        acc["factionRep"] = rep;
      },
    },
    {
      id: "prereqs",
      methods: ["singularity.getAugmentationPrereq", "singularity.getAugmentationStats"],
      run(stubNs: NS, _ctx: ProbeContext, acc) {
        const prereqs: Record<string, string[]> = {};
        const mults: Record<string, Record<string, number>> = {};
        for (const name of listedAugs(acc)) {
          prereqs[name] = stubNs["singularity"]["getAugmentationPrereq"](name as never).map(String);
          // The multipliers are what the objective SCORES; without them the
          // planner can only rank by price, which is not the objective at all.
          //
          // Per-augmentation isolation: Unstable Circadian Modulator has no
          // stable stats (upstream randomises them at load), so the simulator
          // refuses rather than inventing a value. One refusal must not cost
          // the other ~200 augmentations their multipliers.
          try {
            mults[name] = { ...stubNs["singularity"]["getAugmentationStats"](name as never) } as Record<string, number>;
          } catch {
            /* no stable multipliers for this augmentation */
          }
        }
        acc["prereqs"] = prereqs;
        acc["mults"] = mults;
      },
    },
    {
      id: "graft",
      // Grafting is gated by BN10/SF10, NOT the SF4 that gates the rest of
      // this probe, and it THROWS rather than returning empty. Its own step,
      // so a save with Singularity but no Grafting still gets everything else.
      methods: [
        "grafting.getGraftableAugmentations",
        "grafting.getAugmentationGraftPrice",
        "grafting.getAugmentationGraftTime",
      ],
      run(stubNs: NS, _ctx: ProbeContext, acc) {
        const graftable: { name: string; price: number; timeMs: number }[] = [];
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
        acc["graftable"] = graftable;
      },
    },
  ],
  finish(acc) {
    const byFaction = (acc["byFaction"] as Record<string, string[]>) ?? {};
    const prices = (acc["prices"] as Record<string, number>) ?? {};
    const repReq = (acc["repReq"] as Record<string, number>) ?? {};
    const factionRep = (acc["factionRep"] as Record<string, number>) ?? {};
    const prereqs = (acc["prereqs"] as Record<string, string[]>) ?? {};
    const mults = (acc["mults"] as Record<string, Record<string, number>>) ?? {};

    const offers = [];
    // Per-augmentation facts go here ONCE. Carrying prereqs and the multiplier
    // table on every (faction, augmentation) pair duplicated them up to four
    // times each and was most of this topic's 198 KB per record.
    const augMeta: Record<string, AugmentationMeta> = {};
    for (const [faction, names] of Object.entries(byFaction)) {
      for (const name of names) {
        if (offers.length >= FACTION_AUG_LIMIT) break;
        const required = repReq[name] ?? 0;
        const have = factionRep[faction] ?? 0;
        offers.push({
          name,
          faction,
          price: prices[name] ?? 0,
          repReq: required,
          affordableRep: have >= required,
          repGap: Math.max(0, required - have),
          owned: false,
        });
        if (augMeta[name] === undefined) {
          const requires = prereqs[name] ?? [];
          augMeta[name] = {
            ...(requires.length > 0 ? { prereqs: requires } : {}),
            ...(mults[name] ? { mults: mults[name] } : {}),
          };
        }
      }
    }
    offers.sort((a, b) => a.price - b.price);

    return [
      emitPartial("factions", {
        ...(acc["owned"] !== undefined ? { ownedAugs: acc["owned"] as string[] } : {}),
        offers,
        augMeta,
        ...(acc["augTotal"] !== undefined ? { augTotal: acc["augTotal"] as number } : {}),
        ...(acc["graftable"] !== undefined
          ? { graftable: acc["graftable"] as { name: string; price: number; timeMs: number }[] }
          : {}),
      }),
    ];
  },
};

/** The augmentation list is capped far higher than the display lists, because
 * the PLANNER reads it, not just the panel.
 *
 * It has to cover every (faction, augmentation) pair: there are ~137
 * augmentations across 34 factions, so ~400 pairs. A tighter cap truncates in
 * `FactionName` enum order — under which CyberSec is 31st — so the early-game
 * factions the planner most needs would score ZERO and never be chosen, while
 * the endgame ones at the top of the enum looked like the only options. That
 * is a silent wrong answer, not a missing panel row. */
const FACTION_AUG_LIMIT = 500;

/** Distinct augmentation names the catalog step found, capped so one step's
 * loop cannot become unbounded on a late-game save. */
function listedAugs(acc: Record<string, unknown>): string[] {
  const byFaction = (acc["byFaction"] as Record<string, string[]>) ?? {};
  const seen = new Set<string>();
  for (const names of Object.values(byFaction)) {
    for (const name of names) {
      if (seen.size >= FACTION_AUG_LIMIT) return [...seen];
      seen.add(name);
    }
  }
  return [...seen];
}

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
    const work = stubNs["singularity"]["getCurrentWork"]() as (({ type: string } & Record<string, unknown>) & WorkTaskLike) | null;
    if (work) armWorkCompletion(work);
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
              detail: workDetail(work) ?? "",
              focused: stubNs["singularity"]["isFocused"](),
              // How far in the activity already is. Load-bearing for the work
              // slot: without it a driver can only say "a crime is running",
              // not "it has 90 seconds left", and the arbiter cannot tell a
              // nearly-finished activity from one just started.
              cyclesWorked: typeof work.cyclesWorked === "number" ? work.cyclesWorked : 0,
              observedAt: Date.now(),
            }
          : null,
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
        kills: stats.kills,
        // The planner scores actions by how fast they move POSTED NEEDS, and
        // several of those are stat thresholds — so the experience table is a
        // decision input, not decoration.
        exp: {
          hacking: stats.hacking_exp,
          strength: stats.strength_exp,
          defense: stats.defense_exp,
          dexterity: stats.dexterity_exp,
          agility: stats.agility_exp,
          charisma: stats.charisma_exp,
          intelligence: stats.intelligence_exp,
        },
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
    "bladeburner.getBlackOpNames",
  ],
  run(stubNs: NS) {
    const action = stubNs["bladeburner"]["getCurrentAction"]();
    const next = stubNs["bladeburner"]["getNextBlackOp"]();
    // Black ops complete in a fixed order, so the next uncompleted op's index
    // IS the completed count (null next = all done). getBlackOpNames is 0 GB,
    // which keeps this on the cheap 30 s core tier instead of the ~28 GB
    // detail probe the endgame estimate would otherwise wait minutes for.
    const blackOpNames = stubNs["bladeburner"]["getBlackOpNames"]().map(String);
    const nextIndex = next ? blackOpNames.indexOf(String(next.name)) : blackOpNames.length;
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
        blackOpsComplete: nextIndex >= 0 ? nextIndex : undefined,
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

/** Cap on the contract rows that reach the store and the wire.
 *
 * A long-lived save accumulates .cct files faster than one-per-minute solving
 * retires them, and every type without a solver stays forever: a real BN12
 * save reached 8,557 contracts, of which 3,730 were unsolvable. Dumping that
 * list made a single `side` state record 1.66 MB — 88 MB across one run, and
 * the viewer's snapshot alone was then large enough to stall the browser
 * before first paint.
 *
 * The driver only ever attempts the HEAD of this list, once a minute, so a
 * hundred is already a queue nothing can drain. Unsolvable contracts are not
 * rows at all: they collapse to a count per type, which is the actionable
 * form, since the fix is a solver rather than a file listing.
 *
 * Lives here rather than beside the topic because a `--perf` build must not
 * link anything under shared/telemetry (tests/build-perf.test.ts). */
const CONTRACT_LIMIT = 100;

const sideContracts: DodgedProbe = {
  id: "side.contracts",
  kind: "dodged",
  feature: "side",
  everyMs: MIN_1,
  merge: true,
  methods: ["ls", "codingcontract.getContractType", "codingcontract.getNumTriesRemaining"],
  run(stubNs: NS, { servers }: ProbeContext) {
    // PARTITION, DO NOT DUMP. The network can hold thousands of .cct files and
    // every type without a solver stays there forever (see CONTRACT_LIMIT).
    // Solvable ones are carried as rows because the driver attempts the head
    // of that list; the rest collapse to a count per type, which is the only
    // actionable form — the fix is a solver, not a file listing.
    const solvable: ContractDigest[] = [];
    const unsolvableByType: Record<string, number> = {};
    let contractTotal = 0;
    let unsolvableTotal = 0;
    for (const host of Object.keys(servers)) {
      for (const file of stubNs["ls"](host, ".cct")) {
        contractTotal++;
        const type = stubNs["codingcontract"]["getContractType"](file, host);
        if (!canSolve(type)) {
          unsolvableTotal++;
          unsolvableByType[type] = (unsolvableByType[type] ?? 0) + 1;
          continue;
        }
        solvable.push({
          host,
          file,
          type,
          triesRemaining: stubNs["codingcontract"]["getNumTriesRemaining"](file, host),
        });
      }
    }
    // Most-at-risk first, so the capped window is the one worth working on;
    // host/file breaks ties so the window is stable between sweeps.
    solvable.sort(
      (a, b) =>
        a.triesRemaining - b.triesRemaining ||
        a.host.localeCompare(b.host) ||
        a.file.localeCompare(b.file),
    );
    return [
      emit("side", {
        contracts: solvable.slice(0, CONTRACT_LIMIT),
        contractTotal,
        solvableTotal: solvable.length,
        unsolvableByType,
        unsolvableTotal,
      }),
    ];
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
  factionRequirements,
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
