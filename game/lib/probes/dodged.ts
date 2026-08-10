import type { NS } from "@ns";
import { armWorkCompletion, workDetail, type WorkTaskLike } from "../work-completion.ts";
import { armSleeveCompletion } from "../sleeve-completion.ts";
import { sfLevel } from "../../../shared/features/unlock.ts";
import {
  canSolve,
  CONTRACT_QUEUE_LIMIT,
  CONTRACT_TELEMETRY_LIMIT,
} from "../../../shared/strategy/side/contracts.ts";
import { GO_REWARD_OPPONENTS, type GoObservedBoardSize } from "../../../shared/strategy/go/decide.ts";
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
const SEC_2 = 2_000;
const SEC_4 = 4_000;
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
  methods: [
    "cloud.getServerLimit", "cloud.getRamLimit", "cloud.getServerCost", "cloud.getServerUpgradeCost",
    "getTotalScriptIncome", "getTotalScriptExpGain", "getSharePower",
  ],
  run(stubNs: NS, { servers }: ProbeContext) {
    const fleet = fleetFrom(servers);
    fleet.purchased.limit = stubNs["cloud"]["getServerLimit"]();
    fleet.purchased.maxRamPerServer = stubNs["cloud"]["getRamLimit"]();
    const options: NonNullable<typeof fleet.infrastructureOptions> = [];
    const cloudServers = Object.values(servers).filter((server) =>
      server.purchasedByPlayer && server.hostname !== "home" && !server.hostname.startsWith("hacknet-server-"),
    );
    if (cloudServers.length < fleet.purchased.limit) {
      // Quote a LADDER of sizes, not just the 8 GB starter. Cloud cost is
      // linear in RAM, so return-per-dollar ties across sizes and the ranking
      // then prefers the largest income — which is exactly the compounding a
      // growing bankroll wants. The driver filters the ladder to what the
      // current bankroll can actually pay (a quote that cannot execute this
      // pass would freeze the whole infrastructure lane behind it). Measured
      // before this: an hour-long run bought fifteen 8 GB servers while the
      // bank could long since have carried 512 GB ones.
      // The ladder starts at the cap when the cap is below the 8 GB starter
      // (a node multiplier can push it there — with no rung the fleet would
      // silently lose the ability to buy servers at all), and always includes
      // the cap itself: 8·4^k only visits odd exponents, so the game's
      // even-exponent maximum (2^20) was otherwise never quoted.
      const maxRam = fleet.purchased.maxRamPerServer;
      const rungs = new Set<number>();
      // Ladder base floored at 1: with maxRam <= 0 (a degenerate probe value)
      // a 0 start would loop forever (0 <= 0, 0*4 = 0) inside the dodge stub.
      for (let targetRam = Math.max(1, Math.min(8, maxRam)); targetRam <= maxRam; targetRam *= 4) rungs.add(targetRam);
      if (maxRam >= 2) rungs.add(maxRam);
      for (const targetRam of [...rungs].sort((a, b) => a - b)) {
        const cost = stubNs["cloud"]["getServerCost"](targetRam);
        if (targetRam >= 2 && Number.isFinite(cost)) options.push({ kind: "buyServer", cost, addedRam: targetRam, targetRam });
      }
    }
    for (const server of cloudServers) {
      const targetRam = Math.min(fleet.purchased.maxRamPerServer, server.maxRam * 2);
      if (targetRam <= server.maxRam) continue;
      const cost = stubNs["cloud"]["getServerUpgradeCost"](server.hostname, targetRam);
      if (Number.isFinite(cost) && cost > 0) {
        options.push({ kind: "upgradeServer", host: server.hostname, cost, addedRam: targetRam - server.maxRam, targetRam });
      }
    }
    fleet.infrastructureOptions = options;
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
        // A join bans these for the current install cycle, so the panel must
        // show what a join gives up before it happens.
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
    {
      id: "files",
      methods: ["ls"],
      run(stubNs: NS, _ctx: ProbeContext, acc) {
        acc["files"] = stubNs.ls("home").filter((file) => file.endsWith(".lit") || file.endsWith(".msg"));
      },
    },
  ],
  finish(acc) {
    return [
      emitPartial("factions", {
        requirements: (acc["requirements"] ?? {}) as never,
        files: (acc["files"] ?? []) as string[],
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
  methods: ["singularity.getCurrentWork", "singularity.isFocused", "singularity.getCompanyRep", "singularity.getCompanyFavor", "singularity.getCompanyPositionInfo"],
  run(stubNs: NS, { player }: ProbeContext) {
    const work = stubNs["singularity"]["getCurrentWork"]() as (({ type: string } & Record<string, unknown>) & WorkTaskLike) | null;
    if (work) armWorkCompletion(work);
    const companies: Record<string, { rep: number; favor: number; salaryPerCycle?: number }> = {};
    const jobs = player.jobs as unknown as Record<string, string>;
    for (const company of Object.keys(player.jobs)) {
      companies[company] = {
        rep: stubNs["singularity"]["getCompanyRep"](company as never),
        favor: stubNs["singularity"]["getCompanyFavor"](company as never),
        salaryPerCycle: stubNs["singularity"]["getCompanyPositionInfo"](company as never, jobs[company] as never).salary,
      };
    }
    return [
      emitPartial("career", {
        currentWork: work
          ? {
              type: work.type,
              detail: workDetail(work) ?? "",
              ...(work.factionWorkType !== undefined ? { workType: String(work.factionWorkType) } : {}),
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
        difficulty: stats.difficulty,
        weights: {
          hacking: stats.hacking_success_weight,
          strength: stats.strength_success_weight,
          defense: stats.defense_success_weight,
          dexterity: stats.dexterity_success_weight,
          agility: stats.agility_success_weight,
          charisma: stats.charisma_success_weight,
        },
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
  methods: [
    "hacknet.numNodes", "hacknet.maxNumNodes", "hacknet.getNodeStats", "hacknet.getPurchaseNodeCost",
    "hacknet.numHashes", "hacknet.hashCapacity", "hacknet.hashCost",
  ],
  run(stubNs: NS, { caps }: ProbeContext) {
    const numNodes = stubNs["hacknet"]["numNodes"]();
    const nodes = [];
    let totalProduction = 0;
    let productionPerSec = 0;
    const servers =
      caps.restrictions.disableHacknetServer !== true &&
      (caps.bitNode === 9 || (caps.sourceFiles["9"] ?? 0) > 0);
    for (let i = 0; i < Math.min(numNodes, LIST_LIMIT); i++) {
      const stats = stubNs["hacknet"]["getNodeStats"](i);
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
    const hashes = servers
      ? {
          current: stubNs["hacknet"]["numHashes"](),
          capacity: stubNs["hacknet"]["hashCapacity"](),
          sellForMoneyCost: stubNs["hacknet"]["hashCost"]("Sell for Money"),
        }
      : undefined;
    const reportedMax = stubNs["hacknet"]["maxNumNodes"]();
    return [
      emit("hacknet", {
        servers,
        numNodes,
        maxNumNodes: Number.isFinite(reportedMax) ? reportedMax : null,
        purchaseNodeCost: stubNs["hacknet"]["getPurchaseNodeCost"](),
        totalProduction,
        productionPerSec,
        nodes,
        hashes,
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
    "hacknet.getCacheUpgradeCost",
    "hacknet.getHashUpgrades",
    "hacknet.getHashUpgradeLevel",
    "hacknet.hashCost",
  ],
  run(stubNs: NS, { caps }: ProbeContext) {
    const numNodes = stubNs["hacknet"]["numNodes"]();
    const servers = caps.restrictions.disableHacknetServer !== true &&
      (caps.bitNode === 9 || (caps.sourceFiles["9"] ?? 0) > 0);
    const kinds: { kind: string; cost: (i: number) => number }[] = [
      { kind: "level", cost: (i) => stubNs["hacknet"]["getLevelUpgradeCost"](i, 1) },
      { kind: "ram", cost: (i) => stubNs["hacknet"]["getRamUpgradeCost"](i, 1) },
      { kind: "core", cost: (i) => stubNs["hacknet"]["getCoreUpgradeCost"](i, 1) },
      ...(servers ? [{ kind: "cache", cost: (i: number) => stubNs["hacknet"]["getCacheUpgradeCost"](i, 1) }] : []),
    ];
    const nextUpgrades = [];
    for (const { kind, cost } of kinds) {
      for (let i = 0; i < Math.min(numNodes, LIST_LIMIT); i++) {
        const value = cost(i);
        if (Number.isFinite(value)) nextUpgrades.push({ kind, node: i, cost: value });
      }
    }
    // Hash economy exists only for hacknet servers (BN9/SF9). On plain nodes
    // these read as 0 — and in some BitNodes they throw — so the whole read is
    // optional and the panel simply omits the hash tiles.
    const hashUpgrades = servers
      ? stubNs["hacknet"]["getHashUpgrades"]().map((name) => ({
          name: String(name),
          level: stubNs["hacknet"]["getHashUpgradeLevel"](name),
          cost: stubNs["hacknet"]["hashCost"](name),
        }))
      : undefined;
    return [emitPartial("hacknet", { nextUpgrades, ...(hashUpgrades ? { hashUpgrades } : {}) })];
  },
};

const hackingInfrastructure: DodgedProbe = {
  id: "hacking.infrastructure",
  kind: "dodged",
  feature: "hacking",
  everyMs: SEC_30,
  merge: true,
  when: (caps) =>
    caps.restrictions.restrictHomePCUpgrade !== true &&
    (caps.bitNode === 4 || (caps.sourceFiles["4"] ?? 0) > 0),
  methods: ["singularity.getUpgradeHomeRamCost", "singularity.getUpgradeHomeCoresCost"],
  run(stubNs: NS) {
    return [emitPartial("fleet", {
      homeRamUpgradeCost: stubNs["singularity"]["getUpgradeHomeRamCost"](),
      homeCoreUpgradeCost: stubNs["singularity"]["getUpgradeHomeCoresCost"](),
    })];
  },
};

// --- stock -----------------------------------------------------------------

/** The account ladder, at 0.05 GB per call — the cheapest probe in the table.
 *
 * Runs UNCONDITIONALLY, because these four flags are the only way to know where
 * on the ladder we are, and every one of them is bought with money rather than
 * granted by a source file. Read directly instead of inferred from whether
 * `getForecast` threw: that call checks `has4SDataTixApi` (the $25b API), not
 * `has4SData` (the $1b ticker data), so inferring conflated the two and left the
 * driver unable to tell "bought the useless one" from "bought nothing". */
const stockAccount: DodgedProbe = {
  id: "stock.account",
  kind: "dodged",
  feature: "stock",
  everyMs: MIN_1,
  merge: true,
  methods: ["stock.hasWseAccount", "stock.hasTixApiAccess", "stock.has4SData", "stock.has4SDataTixApi"],
  run(stubNs: NS) {
    return [
      emitPartial("stock", {
        hasWseAccount: stubNs["stock"]["hasWseAccount"](),
        hasTixApiAccess: stubNs["stock"]["hasTixApiAccess"](),
        has4SData: stubNs["stock"]["has4SData"](),
        has4SDataApi: stubNs["stock"]["has4SDataTixApi"](),
      }),
    ];
  },
};

/** Prices and positions, at the market's own cadence.
 *
 * 4 s, and that is the whole point of this probe: the market updates every 6 s
 * (4 s while burning stored cycles), and sampling slower than the tick makes the
 * tick structure unobservable — no up-tick count, so no forecast without 4S; no
 * per-tick magnitude, so no measured volatility; and no way to see the 45%-flip
 * cycle boundary that ends every regime. The old 30 s cadence saw one tick in
 * five and could recover none of it.
 *
 * `getAskPrice`/`getBidPrice` rather than `getPrice`: the mid is not a price
 * anything trades at, and the spread it hides is 10x-200x the commission on any
 * position worth opening. The mid is recovered as their mean, so nothing is lost
 * by dropping `getPrice` and 2 GB is saved. */
const stockTick: DodgedProbe = {
  id: "stock.tick",
  kind: "dodged",
  feature: "stock",
  everyMs: SEC_4,
  merge: true,
  when: (_caps, topics) => topics.stock?.hasTixApiAccess === true,
  methods: ["stock.getSymbols", "stock.getAskPrice", "stock.getBidPrice", "stock.getPosition", "stock.getMaxShares"],
  run(stubNs: NS) {
    const positions = [];
    let portfolioValue = 0;
    let portfolioCost = 0;
    for (const sym of stubNs["stock"]["getSymbols"]()) {
      const ask = stubNs["stock"]["getAskPrice"](sym);
      const bid = stubNs["stock"]["getBidPrice"](sym);
      const [shares, avgPx, sharesShort, avgPxShort] = stubNs["stock"]["getPosition"](sym);
      // Mark to what we could actually GET: a long exits at the bid, and a
      // short's value is its entry price less what buying back costs at the ask.
      const value = shares * bid + sharesShort * (2 * avgPxShort - ask);
      portfolioValue += value;
      const costBasis = shares * avgPx + sharesShort * avgPxShort;
      portfolioCost += costBasis;
      positions.push({
        sym,
        price: (ask + bid) / 2,
        ask,
        bid,
        maxShares: stubNs["stock"]["getMaxShares"](sym),
        shares,
        avgPx,
        sharesShort,
        avgPxShort,
        value,
        costBasis,
      });
    }
    return [emitPartial("stock", { positions, portfolioValue, portfolioCost })];
  },
};

/** The 4S signal. Gated on `has4SDataApi` rather than try/catch: the flag is
 *  already probed for 0.05 GB, so launching a 7 GB stub to discover it throws is
 *  pure waste. Same 4 s cadence as the prices, because the forecast is half of
 *  each tick's observation and the two must describe the same tick. */
const stockForecast: DodgedProbe = {
  id: "stock.forecast",
  kind: "dodged",
  feature: "stock",
  everyMs: SEC_4,
  merge: true,
  when: (_caps, topics) => topics.stock?.has4SDataApi === true,
  methods: ["stock.getSymbols", "stock.getForecast", "stock.getVolatility"],
  run(stubNs: NS) {
    // Writes `signals`, never `positions`: this probe and stock.tick are gated
    // separately, so sharing a field would let one clobber the other's data.
    // `getOrganization` is deliberately absent — the symbol/organization/host
    // mapping is static game data (shared/features/stocks.ts), and paying 2 GB
    // every 4 s for a compile-time constant is the sort of thing the RAM budget
    // exists to catch.
    const signals: Record<string, { forecast: number; volatility: number }> = {};
    for (const sym of stubNs["stock"]["getSymbols"]()) {
      signals[sym] = {
        forecast: stubNs["stock"]["getForecast"](sym),
        volatility: stubNs["stock"]["getVolatility"](sym),
      };
    }
    return [emitPartial("stock", { signals })];
  },
};

/** Open limit/stop orders — BN8 or SF8.3 only, and rare enough to be slow. */
const stockOrders: DodgedProbe = {
  id: "stock.orders",
  kind: "dodged",
  feature: "stock",
  everyMs: MIN_5,
  merge: true,
  when: (caps, topics) =>
    topics.stock?.hasTixApiAccess === true && (caps.bitNode === 8 || sfLevel(caps.sourceFiles, 8) >= 3),
  methods: ["stock.getOrders"],
  run(stubNs: NS) {
    const orders: Record<string, { type: string; position: string; shares: number; price: number }[]> = {};
    for (const [sym, list] of Object.entries(stubNs["stock"]["getOrders"]())) {
      orders[sym] = list.map((o) => ({
        type: String(o.type),
        position: String(o.position),
        shares: o.shares,
        price: o.price,
      }));
    }
    return [emitPartial("stock", { orders })];
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
      armSleeveCompletion(i, task as (WorkTaskLike & Record<string, unknown>) | null);
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
          intelligence: s.skills.intelligence,
        },
        mults: { ...s.mults },
        task: task
          ? {
              type: task.type,
              detail: String(task.factionName ?? task.companyName ?? task.crimeType ?? task.classType ?? ""),
              ...(task.factionWorkType !== undefined ? { workType: String(task.factionWorkType) } : {}),
            }
          : undefined,
      });
    }
    return [emit("sleeves", { count, sleeves })];
  },
};

// --- go --------------------------------------------------------------------

function goBoardSize(board: string[]): GoObservedBoardSize {
  const size = board.length;
  if ((size !== 5 && size !== 7 && size !== 9 && size !== 13 && size !== 19) || board.some((column) => column.length !== size)) {
    throw new Error(`unexpected Go board dimensions ${size}x${board[0]?.length ?? 0}`);
  }
  return size;
}

const goCore: DodgedProbe = {
  id: "go.core",
  kind: "dodged",
  feature: "go",
  requires: "go",
  everyMs: SEC_2,
  merge: true,
  methods: ["go.getGameState", "go.getOpponent", "go.analysis.getStats"],
  run(stubNs: NS) {
    const state = stubNs["go"]["getGameState"]();
    const rawStats = stubNs["go"]["analysis"]["getStats"]();
    const stats = GO_REWARD_OPPONENTS.flatMap((opponent) => {
      const s = rawStats[opponent];
      return s
        ? [{
            opponent,
            wins: s.wins,
            losses: s.losses,
            winStreak: s.winStreak,
            highestWinStreak: s.highestWinStreak,
            rep: s.rep,
            bonusPercent: s.bonusPercent,
            bonusDescription: s.bonusDescription,
          }]
        : [];
    });
    return [
      emitPartial("go", {
        status: state.currentPlayer === "None" ? "gameOver" : state.currentPlayer === "White" ? "waitingOnAI" : "inProgress",
        currentPlayer: state.currentPlayer,
        opponent: stubNs["go"]["getOpponent"](),
        whiteScore: state.whiteScore,
        blackScore: state.blackScore,
        komi: state.komi,
        bonusCycles: state.bonusCycles,
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
  everyMs: SEC_2,
  merge: true,
  methods: ["go.getBoardState", "go.getMoveHistory"],
  run(stubNs: NS) {
    const board = stubNs["go"]["getBoardState"]();
    const history = stubNs["go"]["getMoveHistory"]();
    return [
      emitPartial("go", {
        board,
        boardSize: goBoardSize(board),
        moveCount: history.length,
        previousBoards: history,
      }),
    ];
  },
};

/** Territory is useful telemetry but costs 16 GB. It must not be bundled with
 * the 4 GB board read that the player needs every turn. */
const goTerritory: DodgedProbe = {
  id: "go.territory",
  kind: "dodged",
  feature: "go",
  requires: "go",
  everyMs: SEC_30,
  merge: true,
  methods: ["go.analysis.getControlledEmptyNodes"],
  run(stubNs: NS) {
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

/** Contract discovery keeps a private bounded work queue and sends only its
 * front batch. Counts, solver coverage and quarantine summaries describe the
 * rest without repeating a network-sized file list on the wire.
 *
 * A long-lived save can accumulate thousands of .cct files: a real BN12
 * save reached 8,557 contracts, of which 3,730 were unsolvable. Dumping that
 * list made a single `side` state record 1.66 MB — 88 MB across one run, and
 * the viewer's snapshot alone was then large enough to stall the browser
 * before first paint.
 *
 * The list is only a work window. Discovery intentionally calls `ls` and the
 * free type-registry getter—never a per-file codingcontract getter. The driver
 * inspects and drains bounded batches under separate RAM dodges.
 *
 * The limits live with the solver registry because both probe and driver use
 * them, and a drift between the two would stall or over-publish the queue. */

const sideContracts: DodgedProbe = {
  id: "side.contracts",
  kind: "dodged",
  feature: "side",
  everyMs: SEC_30,
  merge: true,
  methods: ["ls", "codingcontract.getContractTypes"],
  run(stubNs: NS, { servers, state }: ProbeContext) {
    const queue: ContractDigest[] = [];
    // Track only quarantined keys, not every contract in a large save. Each
    // discovered file removes itself; leftovers are stale failures to reap.
    const staleQuarantine = new Set(Object.keys(state.contractQuarantine ?? {}));
    let contractTotal = 0;
    for (const host of Object.keys(servers).sort()) {
      for (const file of stubNs["ls"](host, ".cct").sort()) {
        contractTotal++;
        const key = `${host}\0${file}`;
        staleQuarantine.delete(key);
        if (!state.contractQuarantine?.[key] && queue.length < CONTRACT_QUEUE_LIMIT) queue.push({ host, file });
      }
    }

    // A manually solved/deleted quarantined contract is no longer a failure
    // in the current world. This full-network ls sweep is the authoritative
    // and cheapest place to reap it.
    for (const key of staleQuarantine) delete state.contractQuarantine![key];
    state.contractQueue = queue;
    const contractTypes = stubNs["codingcontract"]["getContractTypes"]().map(String);
    const unsupported = contractTypes.filter((type) => !canSolve(type));
    const registryComplete = unsupported.length === 0;
    const quarantine = Object.values(state.contractQuarantine ?? {});
    const unsolvableByType = Object.fromEntries(unsupported.map((type) => [type, 0])) as Record<string, number>;
    for (const failure of quarantine) {
      if (failure.reason === "no solver registered") {
        unsolvableByType[failure.type] = (unsolvableByType[failure.type] ?? 0) + 1;
      }
    }
    const unsolvableTotal = Object.values(unsolvableByType).reduce((total, count) => total + count, 0);
    const failures = quarantine
      .sort((a, b) => b.at - a.at)
      .slice(0, 8)
      .map(({ data: _data, answer: _answer, ...summary }) => summary);
    return [
      emit("side", {
        contracts: queue.slice(0, CONTRACT_TELEMETRY_LIMIT),
        contractTotal,
        // Types are intentionally unknown until the bounded driver inspection.
        // This is therefore the unquarantined candidate count; unsupported
        // files move out of it as their batches are inspected.
        solvableTotal: Math.max(0, contractTotal - quarantine.length),
        unsolvableByType,
        unsolvableTotal,
        registryComplete,
        contractTypeTotal: contractTypes.length,
        supportedTypeTotal: contractTypes.length - unsupported.length,
        contractScannedAt: Date.now(),
        failures,
        quarantinedTotal: quarantine.length,
      }),
    ];
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
  hackingInfrastructure,
  stockAccount,
  stockTick,
  stockForecast,
  stockOrders,
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
  goTerritory,
  stanekCore,
  dnetCore,
  sideContracts,
];

export type { Emission };
