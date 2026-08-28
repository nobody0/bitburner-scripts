import { armWorkCompletion, workDetail, type WorkTaskLike } from "../work-completion.ts";
import { armSleeveCompletion } from "../sleeve-completion.ts";
import { sfLevel } from "../../../shared/features/unlock.ts";
import { effectiveBitNodeMultipliers } from "../../../shared/features/bitnode.ts";
import { marginalCostPerGb } from "../../../shared/strategy/ram-supply.ts";
import {
  canSolve,
  CONTRACT_QUEUE_LIMIT,
  CONTRACT_REPORT_LIMIT,
} from "../../../shared/strategy/side/contracts.ts";
import { rotate } from "../../../shared/strategy/stanek/pack.ts";
import type { AugmentationMeta } from "../../../shared/telemetry/topics/factions.ts";
import type { BladeActionDigest } from "../../../shared/telemetry/topics/bladeburner.ts";
import {
  contractKey,
  contractOrigin,
  darknetContractsFromListings,
  mergeContractQueue,
  pendingDarknetContracts,
  type ContractQueueEntry,
} from "../contracts.ts";
import { emit, emitPartial, type PricedProbe, type Emission, type ProbeContext } from "./index.ts";
import { fleetFrom } from "./local.ts";
import { bladeburnerApiActionType } from "../bladeburner.ts";

/** The priced probe table — one entry per (feature, cost tier).
 *
 * Every body reads through `ctx.nsp`, which runs the member on a resident
 * script of its own, so nothing here is charged to main.js. The member is
 * named as a STRING PATH and never as a property: Bitburner charges by member
 * NAME across the whole bundle regardless of the receiver, so a property
 * access — dotted or bracketed, on `ns` or on anything else — bills main.js.
 *
 * There is no `methods` table any more, and nothing declares a price. The
 * resident prices each member when the body first calls it, memoises it, and
 * respawns into a larger allocation when its budget fills; the call IS the
 * price, so the two cannot drift. Sequential calls remain placeable because
 * the resident can resize between first calls.
 *
 * Features are still split into `core` / detail tiers, but for CADENCE rather
 * than for cost: the facts a driver acts on every 30 s and the ones a panel
 * shows every few minutes have different clocks, and reading the slow ones
 * fast buys nothing. */

/** Cadences as plain literals, never `2 * MINUTE`. esbuild cannot prove a
 * multiplication pure (an operand could have a valueOf), so an arithmetic
 * initializer pins the whole probe object into --perf bundles instead of
 * letting it tree-shake away with the rest of the telemetry code. */
/** Stock sampling cadence. Strictly BELOW `msPerStockUpdateMin` (4 s): during
 * stored-cycle catch-up the market ticks every 4 s exactly, so a 4 s sampler has
 * zero margin — any stub latency or scheduler jitter straddles two ticks, and a
 * missed tick folds two price moves into one observed step, corrupting the
 * volatility inversion and the cycle clock's tick count. 3 s leaves ~1 s of
 * jitter margin; `observeMarket` is idempotent under the resulting oversampling. */
const SEC_3 = 3_000;
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

const hackingCloud: PricedProbe = {
  id: "hacking.cloud",
  kind: "priced",
  feature: "hacking",
  everyMs: SEC_30,
  merge: true,
  async run(ctx: ProbeContext) {
    const { servers, caps } = ctx;
    const fleet = fleetFrom(servers);
    fleet.purchased.limit = await ctx.nsp("cloud.getServerLimit");
    fleet.purchased.maxRamPerServer = await ctx.nsp("cloud.getRamLimit");
    const options: NonNullable<typeof fleet.infrastructureOptions> = [];
    const cloudServers = Object.values(servers).filter((server) =>
      server.purchasedByPlayer && server.hostname !== "home" && !server.hostname.startsWith("hacknet-server-"),
    );
    const mults = effectiveBitNodeMultipliers(caps.bitNode, sfLevel(caps.sourceFiles, 12), undefined);
    const costMultiplier = mults?.CloudServerCost ?? 1;
    const softcap = mults?.CloudServerSoftcap ?? 1;
    if (cloudServers.length < fleet.purchased.limit) {
      // Quote the largest cheapest-per-GB rung. With a softcap above one this
      // derives 2^6 GB, the last exponent before the penalty; a neutral or
      // different multiplier is handled by the same formula.
      const quote = marginalCostPerGb("cloud", {
        cloud: {
          costMultiplier,
          softcap,
          maxRam: fleet.purchased.maxRamPerServer,
          slotsAvailable: 1,
          servers: [],
        },
      });
      if (quote) {
        const cost = await ctx.nsp("cloud.getServerCost", quote.targetRam);
        if (Number.isFinite(cost)) {
          options.push({ kind: "buyServer", cost, addedRam: quote.addedRam, targetRam: quote.targetRam });
        }
      }
    }
    for (const server of cloudServers) {
      const quote = marginalCostPerGb("cloud", {
        cloud: {
          costMultiplier,
          softcap,
          maxRam: fleet.purchased.maxRamPerServer,
          slotsAvailable: 0,
          servers: [{ host: server.hostname, ram: server.maxRam }],
        },
      });
      if (!quote) continue;
      const cost = await ctx.nsp("cloud.getServerUpgradeCost", server.hostname, quote.targetRam);
      if (Number.isFinite(cost) && cost > 0) {
        options.push({
          kind: "upgradeServer",
          host: server.hostname,
          cost,
          addedRam: quote.addedRam,
          targetRam: quote.targetRam,
        });
      }
    }
    fleet.infrastructureOptions = options;
    fleet.scriptIncome = await ctx.nsp("getTotalScriptIncome");
    fleet.scriptExpGain = await ctx.nsp("getTotalScriptExpGain");
    fleet.sharePower = await ctx.nsp("getSharePower");
    return [emit("fleet", fleet)];
  },
};

// --- progression -----------------------------------------------------------

const progressionMoney: PricedProbe = {
  id: "progression.money",
  kind: "priced",
  feature: "progression",
  everyMs: MIN_2,
  merge: true,
  async run(ctx: ProbeContext) {
    return [emitPartial("progression", { moneySources: await ctx.nsp("getMoneySources") })];
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
const progressionMults: PricedProbe = {
  id: "progression.mults",
  kind: "priced",
  feature: "progression",
  everyMs: MIN_10,
  merge: true,
  when: (caps, topics) =>
    (caps.bitNode === 5 || sfLevel(caps.sourceFiles, 5) > 0) && topics.progression?.multipliers === undefined,
  async run(ctx: ProbeContext) {
    return [
      emitPartial("progression", {
        multipliers: { ...await ctx.nsp("getBitNodeMultipliers") } as unknown as Record<string, number>,
      }),
    ];
  },
};

// --- factions (singularity) ------------------------------------------------

const NEUROFLUX_GOVERNOR = "NeuroFlux Governor";

/** Standing at every joined faction, plus pending invitations and enemies.
 *
 * Five singularity getters cost 5 GB each once SF4's 16/4/1 multiplier is
 * applied. The resident pays for them one at a time and recycles when its
 * budget fills, so they remain sequential reads. */
const factionStandings: PricedProbe = {
  id: "factions.standings",
  kind: "priced",
  feature: "factions",
  requires: "factions",
  everyMs: MIN_1,
  merge: true,
  async run(ctx: ProbeContext) {
    const { player } = ctx;
    const rep: Record<string, number> = {};
    const favor: Record<string, number> = {};
    for (const faction of player.factions) {
      rep[String(faction)] = await ctx.nsp("singularity.getFactionRep", faction);
      favor[String(faction)] = await ctx.nsp("singularity.getFactionFavor", faction);
    }
    const favorToDonate = await ctx.nsp("getFavorToDonate");
    const invites = (await ctx.nsp("singularity.checkFactionInvitations")).map(String);

    // Which work types each faction actually offers, and which factions a join
    // would make enemies of. Neither is optional: without the work types the
    // planner has to guess, and guessing "all three" makes it issue
    // `workForFaction(Tetrads, "hacking")` — which Tetrads does not offer, so
    // the call fails every tick and reputation never accrues; without the
    // enemies the panel cannot show what a join gives up before it happens.
    //
    // EVERY faction, not just the joined ones. The planner estimates how long a
    // faction would take to earn reputation at BEFORE deciding to join it, so
    // restricting this to current members leaves every candidate looking
    // unworkable and empties the objective. Each read is guarded on its own,
    // because a faction this node does not define throws for one getter
    // independently of the other.
    const workTypes: Record<string, string[]> = {};
    const enemies: Record<string, string[]> = {};
    for (const faction of Object.values(ctx.enums["FactionName"]) as string[]) {
      try {
        workTypes[faction] = (await ctx.nsp("singularity.getFactionWorkTypes", faction as never)).map(String);
      } catch {
        /* a faction this node does not define */
      }
      try {
        enemies[faction] = (await ctx.nsp("singularity.getFactionEnemies", faction as never)).map(String);
      } catch {
        /* a faction this node does not define */
      }
    }

    const standings = Object.keys({ ...rep, ...favor }).map((name) => ({
      name,
      rep: rep[name] ?? 0,
      favor: favor[name] ?? 0,
    }));
    return [emitPartial("factions", { standings, invites, favorToDonate, workTypes, enemies })];
  },
};

/** STRUCTURED invite requirements for every faction the game knows about.
 *
 * Three things make this its own probe. `ns.enums.FactionName` is a 0 GB
 * property the runner hands down on the context, so enumerating ALL factions
 * costs nothing beyond the per-faction getter —
 * which matters because the planner must reason about factions it has not been
 * invited to yet. The tree only changes when the BitNode does, so `when`
 * latches it. And the requirements must be the STRUCTURED tree: the strategy
 * has to tell an OR branch from an AND, which a display string cannot express. */
const factionRequirements: PricedProbe = {
  id: "factions.requirements",
  kind: "priced",
  feature: "factions",
  requires: "factions",
  everyMs: MIN_10,
  merge: true,
  when: (_caps, topics) => topics.factions?.requirements === undefined,
  async run(ctx: ProbeContext) {
    const requirements: Record<string, unknown[]> = {};
    for (const name of Object.values(ctx.enums["FactionName"]) as string[]) {
      try {
        requirements[name] = await ctx.nsp("singularity.getFactionInviteRequirements", name as never);
      } catch {
        /* a faction this node does not define */
      }
    }
    // The .lit/.msg files on home are half of what several invite requirements
    // are actually testing, so they are read here rather than left to the
    // planner to infer.
    const files = (await ctx.nsp("ls", "home")).filter((file) => file.endsWith(".lit") || file.endsWith(".msg"));
    return [emitPartial("factions", { requirements: requirements as never, files })];
  },
};

/** The augmentation catalogue.
 *
 * This is the probe that motivated stepped dodging: nine singularity methods
 * in one stub summed to ~33.5 GB even inside BN4, against a dodge budget
 * pinned near 2.4 GB, so it could never run and was hand-split into eight
 * stubs with a partial-accumulator contract between them. The resident pays
 * the same ~33.5 GB, but one member at a time and across as many respawns as
 * it takes, so the reads below are plain sequential code and the only price
 * that has to be placeable is the largest SINGLE getter. */
const factionAugs: PricedProbe = {
  id: "factions.augs",
  kind: "priced",
  feature: "factions",
  requires: "factions",
  everyMs: MIN_5,
  merge: true,
  async run(ctx: ProbeContext) {
    const { player } = ctx;
    const owned = (await ctx.nsp("singularity.getOwnedAugmentations", true)).map(String);
    const ownedSet = new Set(owned);

    // EVERY faction, not just the joined ones. This getter does not require
    // membership, and restricting it to joined factions would leave the planner
    // unable to value a faction it has not joined — which is precisely the
    // decision it needs to make.
    // https://github.com/bitburner-official/bitburner-src/blob/3162fd2590e221eadd0c0fbd46151913f7c4c41c/src/NetscriptFunctions/Singularity.ts#L128-L133
    const byFaction: Record<string, string[]> = {};
    let augTotal = 0;
    for (const faction of Object.values(ctx.enums["FactionName"]) as string[]) {
      try {
        const names = (await ctx.nsp("singularity.getAugmentationsFromFaction", faction as never))
          .map(String)
          // NeuroFlux is repeatable: owning/queueing one level must not remove
          // the next level from the final purchase sweep.
          // https://github.com/bitburner-official/bitburner-src/blob/3162fd2590e221eadd0c0fbd46151913f7c4c41c/src/Faction/FactionHelpers.tsx#L73-L91
          .filter((name) => name === NEUROFLUX_GOVERNOR || !ownedSet.has(name));
        if (names.length === 0) continue;
        byFaction[faction] = names;
        augTotal += names.length;
      } catch {
        /* a faction this node does not define */
      }
    }
    const listed = listedAugs(byFaction);

    const prices: Record<string, number> = {};
    const repReq: Record<string, number> = {};
    const prereqs: Record<string, string[]> = {};
    const mults: Record<string, Record<string, number>> = {};
    for (const name of listed) {
      prices[name] = await ctx.nsp("singularity.getAugmentationPrice", name as never);
      repReq[name] = await ctx.nsp("singularity.getAugmentationRepReq", name as never);
      prereqs[name] = (await ctx.nsp("singularity.getAugmentationPrereq", name as never)).map(String);
      // The multipliers are what the objective SCORES; without them the planner
      // can only rank by price, which is not the objective at all.
      //
      // Per-augmentation isolation: Unstable Circadian Modulator has no stable
      // stats (upstream randomises them at load), so the simulator refuses
      // rather than inventing a value. One refusal must not cost the other
      // ~200 augmentations their multipliers.
      // Source: https://github.com/bitburner-official/bitburner-src/blob/3162fd2590e221eadd0c0fbd46151913f7c4c41c/src/Augmentation/CircadianModulator.ts#L9-L25 and https://github.com/bitburner-official/bitburner-src/blob/3162fd2590e221eadd0c0fbd46151913f7c4c41c/src/Prestige.ts#L108-L120
      try {
        mults[name] = { ...await ctx.nsp("singularity.getAugmentationStats", name as never) } as Record<string, number>;
      } catch {
        /* no stable multipliers for this augmentation */
      }
    }

    const factionRep: Record<string, number> = {};
    for (const faction of player.factions) {
      factionRep[String(faction)] = await ctx.nsp("singularity.getFactionRep", faction);
    }

    // Grafting is gated by BN10/SF10, NOT the SF4 that gates the rest of this
    // probe, and it THROWS rather than returning empty — so the whole grafting
    // read is guarded and a save with Singularity but no Grafting still gets
    // everything above.
    const graftable: { name: string; price: number; timeMs: number }[] = [];
    try {
      const graftNames = (await ctx.nsp("grafting.getGraftableAugmentations")).slice(0, LIST_LIMIT).map(String);
      for (const name of graftNames) {
        graftable.push({
          name,
          price: await ctx.nsp("grafting.getAugmentationGraftPrice", name as never),
          timeMs: await ctx.nsp("grafting.getAugmentationGraftTime", name as never),
        });
      }
    } catch {
      /* no Grafting API in this BitNode */
    }

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

    return [emitPartial("factions", { ownedAugs: owned, offers, augMeta, augTotal, graftable })];
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

/** Distinct augmentation names the catalogue sweep found, capped so the
 * per-augmentation loops cannot become unbounded on a late-game save. */
function listedAugs(byFaction: Record<string, string[]>): string[] {
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

const careerWork: PricedProbe = {
  id: "career.work",
  kind: "priced",
  feature: "career",
  requires: "factions", // singularity access, same SF4 gate
  everyMs: SEC_30,
  merge: true,
  async run(ctx: ProbeContext) {
    const { player } = ctx;
    const work = await ctx.nsp("singularity.getCurrentWork") as (({ type: string } & Record<string, unknown>) & WorkTaskLike) | null;
    if (work) armWorkCompletion(work);
    const companies: Record<string, { rep: number; favor: number; salaryPerCycle?: number }> = {};
    const jobs = player.jobs as unknown as Record<string, string>;
    for (const company of Object.keys(player.jobs)) {
      companies[company] = {
        rep: await ctx.nsp("singularity.getCompanyRep", company as never),
        favor: await ctx.nsp("singularity.getCompanyFavor", company as never),
        salaryPerCycle: (await ctx.nsp("singularity.getCompanyPositionInfo", company as never, jobs[company] as never)).salary,
      };
    }
    return [
      emitPartial("career", {
        currentWork: work
          ? {
              type: work.type,
              detail: workDetail(work) ?? "",
              ...(work.factionWorkType !== undefined ? { workType: String(work.factionWorkType) } : {}),
              focused: await ctx.nsp("singularity.isFocused"),
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

const CRIME_NAMES = [
  "Shoplift", "Rob Store", "Mug", "Larceny", "Deal Drugs", "Bond Forgery",
  "Traffick Arms", "Homicide", "Grand Theft Auto", "Kidnap", "Assassination", "Heist",
];

const careerCrimes: PricedProbe = {
  id: "career.crimes",
  kind: "priced",
  feature: "career",
  requires: "factions",
  everyMs: MIN_5,
  merge: true,
  // Two INDEPENDENT SingularityFn3 reads over the same twelve crimes. A rate
  // needs both the payout and the odds, so they are read together and the whole
  // table is built in one pass.
  async run(ctx: ProbeContext) {
    const statsByName: Record<string, Record<string, number>> = {};
    const chanceByName: Record<string, number> = {};
    for (const name of CRIME_NAMES) {
      statsByName[name] = await ctx.nsp("singularity.getCrimeStats", name as never) as unknown as Record<string, number>;
      chanceByName[name] = await ctx.nsp("singularity.getCrimeChance", name as never);
    }
    const crimes = CRIME_NAMES.map((name) => {
      const stats = statsByName[name]!;
      const chance = chanceByName[name] ?? 0;
      return {
        name,
        chance,
        // getCrimeStats returns calculateCrimeWorkStats(), not base table
        // gains: money and exp already include player and BitNode multipliers.
        // https://github.com/bitburner-official/bitburner-src/blob/3162fd2590e221eadd0c0fbd46151913f7c4c41c/src/NetscriptFunctions/Singularity.ts#L1068-L1090
        gainsAreEffective: true,
        money: stats["money"]!,
        timeMs: stats["time"]!,
        karma: stats["karma"]!,
        kills: stats["kills"]!,
        difficulty: stats["difficulty"]!,
        weights: {
          hacking: stats["hacking_success_weight"]!,
          strength: stats["strength_success_weight"]!,
          defense: stats["defense_success_weight"]!,
          dexterity: stats["dexterity_success_weight"]!,
          agility: stats["agility_success_weight"]!,
          charisma: stats["charisma_success_weight"]!,
        },
        // The planner scores actions by how fast they move POSTED NEEDS, and
        // several of those are stat thresholds — so the experience table is a
        // decision input, not decoration.
        exp: {
          hacking: stats["hacking_exp"]!,
          strength: stats["strength_exp"]!,
          defense: stats["defense_exp"]!,
          dexterity: stats["dexterity_exp"]!,
          agility: stats["agility_exp"]!,
          charisma: stats["charisma_exp"]!,
          intelligence: stats["intelligence_exp"]!,
        },
        moneyPerSec: stats["time"]! > 0 ? (stats["money"]! * chance) / (stats["time"]! / 1000) : 0,
      };
    });
    crimes.sort((a, b) => b.moneyPerSec - a.moneyPerSec);
    return [emitPartial("career", { crimes })];
  },
};

// --- hacknet ---------------------------------------------------------------

const hacknetCore: PricedProbe = {
  id: "hacknet.core",
  kind: "priced",
  feature: "hacknet",
  everyMs: SEC_30,
  merge: true,
  async run(ctx: ProbeContext) {
    const { caps } = ctx;
    const numNodes = await ctx.nsp("hacknet.numNodes");
    const nodes = [];
    let totalProduction = 0;
    let productionPerSec = 0;
    // Hacknet Servers are selected by the BN9/SF9 feature gate, unless the
    // BitNode option disables them.
    // Source: https://github.com/bitburner-official/bitburner-src/blob/3162fd2590e221eadd0c0fbd46151913f7c4c41c/src/Hacknet/HacknetHelpers.tsx#L34-L36
    const servers =
      caps.restrictions.disableHacknetServer !== true &&
      (caps.bitNode === 9 || (caps.sourceFiles["9"] ?? 0) > 0);
    for (let i = 0; i < Math.min(numNodes, LIST_LIMIT); i++) {
      const stats = await ctx.nsp("hacknet.getNodeStats", i);
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
          current: await ctx.nsp("hacknet.numHashes"),
          capacity: await ctx.nsp("hacknet.hashCapacity"),
          sellForMoneyCost: await ctx.nsp("hacknet.hashCost", "Sell for Money"),
        }
      : undefined;
    const reportedMax = await ctx.nsp("hacknet.maxNumNodes");
    return [
      emit("hacknet", {
        servers,
        numNodes,
        maxNumNodes: Number.isFinite(reportedMax) ? reportedMax : null,
        purchaseNodeCost: await ctx.nsp("hacknet.getPurchaseNodeCost"),
        totalProduction,
        productionPerSec,
        nodes,
        hashes,
      }),
    ];
  },
};

const hacknetUpgrades: PricedProbe = {
  id: "hacknet.upgrades",
  kind: "priced",
  feature: "hacknet",
  everyMs: MIN_1,
  merge: true,
  async run(ctx: ProbeContext) {
    const { caps } = ctx;
    const numNodes = await ctx.nsp("hacknet.numNodes");
    const servers = caps.restrictions.disableHacknetServer !== true &&
      (caps.bitNode === 9 || (caps.sourceFiles["9"] ?? 0) > 0);
    const kinds: { kind: string; cost: (i: number) => Promise<number> }[] = [
      { kind: "level", cost: (i) => ctx.nsp("hacknet.getLevelUpgradeCost", i, 1) },
      { kind: "ram", cost: (i) => ctx.nsp("hacknet.getRamUpgradeCost", i, 1) },
      { kind: "core", cost: (i) => ctx.nsp("hacknet.getCoreUpgradeCost", i, 1) },
      ...(servers ? [{ kind: "cache", cost: (i: number) => ctx.nsp("hacknet.getCacheUpgradeCost", i, 1) }] : []),
    ];
    const nextUpgrades = [];
    for (const { kind, cost } of kinds) {
      for (let i = 0; i < Math.min(numNodes, LIST_LIMIT); i++) {
        const value = await cost(i);
        if (Number.isFinite(value)) nextUpgrades.push({ kind, node: i, cost: value });
      }
    }
    // Hash economy exists only for Hacknet Servers (BN9/SF9). On plain nodes
    // these APIs return 0/Infinity/[]/false; omitting them keeps the topic's
    // semantics explicit rather than publishing an unusable hash economy.
    // Source: https://github.com/bitburner-official/bitburner-src/blob/3162fd2590e221eadd0c0fbd46151913f7c4c41c/src/NetscriptFunctions/Hacknet.ts#L164-L224
    let hashUpgrades: { name: string; level: number; cost: number }[] | undefined;
    if (servers) {
      hashUpgrades = [];
      for (const name of await ctx.nsp("hacknet.getHashUpgrades")) {
        hashUpgrades.push({
          name: String(name),
          level: await ctx.nsp("hacknet.getHashUpgradeLevel", name),
          cost: await ctx.nsp("hacknet.hashCost", name),
        });
      }
    }
    return [emitPartial("hacknet", { nextUpgrades, ...(hashUpgrades ? { hashUpgrades } : {}) })];
  },
};

const hackingInfrastructure: PricedProbe = {
  id: "hacking.infrastructure",
  kind: "priced",
  feature: "hacking",
  everyMs: SEC_30,
  merge: true,
  when: (caps) =>
    caps.restrictions.restrictHomePCUpgrade !== true &&
    (caps.bitNode === 4 || (caps.sourceFiles["4"] ?? 0) > 0),
  async run(ctx: ProbeContext) {
    return [emitPartial("fleet", {
      homeRamUpgradeCost: await ctx.nsp("singularity.getUpgradeHomeRamCost"),
      homeCoreUpgradeCost: await ctx.nsp("singularity.getUpgradeHomeCoresCost"),
    })];
  },
};

// --- stock -----------------------------------------------------------------

/** The account ladder, at 0.05 GB per call — the cheapest probe in the table.
 *
 * Runs UNCONDITIONALLY, because these four flags are the only way to know where
 * on the ladder we are. BN8/SF8 grants WSE and TIX on prestige; the two 4S
 * products are purchases. Read directly instead of inferred from whether
 * `getForecast` threw: that call checks `has4SDataTixApi` (the $25b API), not
 * `has4SData` (the $1b ticker data), so inferring conflated the two and left the
 * driver unable to tell "bought the useless one" from "bought nothing".
 * Source: https://github.com/bitburner-official/bitburner-src/blob/3162fd2590e221eadd0c0fbd46151913f7c4c41c/src/Prestige.ts#L163-L168
 * Source: https://github.com/bitburner-official/bitburner-src/blob/3162fd2590e221eadd0c0fbd46151913f7c4c41c/src/NetscriptFunctions/StockMarket.ts#L226-L246 */
const stockAccount: PricedProbe = {
  id: "stock.account",
  kind: "priced",
  feature: "stock",
  everyMs: MIN_1,
  merge: true,
  async run(ctx: ProbeContext) {
    return [
      emitPartial("stock", {
        hasWseAccount: await ctx.nsp("stock.hasWseAccount"),
        hasTixApiAccess: await ctx.nsp("stock.hasTixApiAccess"),
        has4SData: await ctx.nsp("stock.has4SData"),
        has4SDataApi: await ctx.nsp("stock.has4SDataTixApi"),
      }),
    ];
  },
};

/** Prices and positions, faster than the market's own cadence.
 *
 * 3 s, and that is the whole point of this probe: the market updates every 6 s
 * (4 s while burning stored cycles), and sampling slower than the tick makes the
 * tick structure unobservable — no up-tick count, so no forecast without 4S; no
 * per-tick magnitude, so no measured volatility; and no way to see the 45%-flip
 * cycle boundary that ends every regime. Sampling at the 4 s minimum can still
 * miss catch-up ticks (see SEC_3), so the probe runs every 3 s.
 * Source: https://github.com/bitburner-official/bitburner-src/blob/3162fd2590e221eadd0c0fbd46151913f7c4c41c/src/StockMarket/StockMarket.ts#L218-L258
 * Source: https://github.com/bitburner-official/bitburner-src/blob/3162fd2590e221eadd0c0fbd46151913f7c4c41c/src/StockMarket/data/Constants.ts#L3-L8
 *
 * `getAskPrice`/`getBidPrice` rather than `getPrice`: the mid is not a price
 * anything trades at, and the spread it hides is 10x-200x the commission on any
 * position worth opening. The mid is recovered as their mean, so nothing is lost
 * by dropping `getPrice` and 2 GB is saved. */
const stockTick: PricedProbe = {
  id: "stock.tick",
  kind: "priced",
  feature: "stock",
  everyMs: SEC_3,
  merge: true,
  when: (_caps, topics) => topics.stock?.hasTixApiAccess === true,
  async run(ctx: ProbeContext) {
    const positions = [];
    let portfolioValue = 0;
    let portfolioCost = 0;
    for (const sym of await ctx.nsp("stock.getSymbols")) {
      const ask = await ctx.nsp("stock.getAskPrice", sym);
      const bid = await ctx.nsp("stock.getBidPrice", sym);
      const [shares, avgPx, sharesShort, avgPxShort] = await ctx.nsp("stock.getPosition", sym);
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
        maxShares: await ctx.nsp("stock.getMaxShares", sym),
        shares,
        avgPx,
        sharesShort,
        avgPxShort,
        value,
        costBasis,
      });
    }
    const cash = await ctx.nsp("getServerMoneyAvailable", "home");
    return [emitPartial("stock", { positions, portfolioValue, portfolioCost, wealth: cash + portfolioValue })];
  },
};

/** The 4S signal. Gated on `has4SDataApi` rather than try/catch: the flag is
 *  already probed for 0.05 GB, so launching a 7 GB stub to discover it throws is
 *  pure waste. Same 3 s cadence as the prices, because the forecast is half of
 *  each tick's observation and the two must describe the same tick. */
const stockForecast: PricedProbe = {
  id: "stock.forecast",
  kind: "priced",
  feature: "stock",
  everyMs: SEC_3,
  merge: true,
  when: (_caps, topics) => topics.stock?.has4SDataApi === true,
  async run(ctx: ProbeContext) {
    // Writes `signals`, never `positions`: this probe and stock.tick are gated
    // separately, so sharing a field would let one clobber the other's data.
    // `getOrganization` is deliberately absent — the symbol/organization/host
    // mapping is static game data (shared/features/stocks.ts), and paying 2 GB
    // every 4 s for a compile-time constant is the sort of thing the RAM budget
    // exists to catch.
    const signals: Record<string, { forecast: number; volatility: number }> = {};
    for (const sym of await ctx.nsp("stock.getSymbols")) {
      signals[sym] = {
        forecast: await ctx.nsp("stock.getForecast", sym),
        volatility: await ctx.nsp("stock.getVolatility", sym),
      };
    }
    return [emitPartial("stock", { signals })];
  },
};

/** Open limit/stop orders — BN8 or SF8.3 only, and rare enough to be slow. */
const stockOrders: PricedProbe = {
  id: "stock.orders",
  kind: "priced",
  feature: "stock",
  everyMs: MIN_5,
  merge: true,
  when: (caps, topics) =>
    topics.stock?.hasTixApiAccess === true && (caps.bitNode === 8 || sfLevel(caps.sourceFiles, 8) >= 3),
  async run(ctx: ProbeContext) {
    const orders: Record<string, { type: string; position: string; shares: number; price: number }[]> = {};
    for (const [sym, list] of Object.entries(await ctx.nsp("stock.getOrders"))) {
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

const gangCore: PricedProbe = {
  id: "gang.core",
  kind: "priced",
  feature: "gang",
  requires: "gang",
  everyMs: 10_000,
  merge: true,
  async run(ctx: ProbeContext) {
    const info = await ctx.nsp("gang.getGangInformation");
    const members = [];
    const ascensionGain: Record<string, number> = {};
    for (const name of await ctx.nsp("gang.getMemberNames")) {
      const m = await ctx.nsp("gang.getMemberInformation", name);
      // Undefined until the member has enough exp to gain anything.
      // Source: https://github.com/bitburner-official/bitburner-src/blob/3162fd2590e221eadd0c0fbd46151913f7c4c41c/src/NetscriptFunctions/Gang.ts#L283-L302
      const ascension = await ctx.nsp("gang.getAscensionResult", name);
      ascensionGain[name] = ascension
        ? info.isHacking
          ? ascension.hack
          : Math.min(ascension.str, ascension.def, ascension.dex, ascension.agi)
        : 0;
      members.push({
        name: m.name,
        task: m.task,
        respectGain: m.respectGain,
        wantedLevelGain: m.wantedLevelGain,
        moneyGain: m.moneyGain,
        skills: { hack: m.hack, str: m.str, def: m.def, dex: m.dex, agi: m.agi, cha: m.cha },
      });
    }
    const tasks = [];
    for (const name of await ctx.nsp("gang.getTaskNames")) {
      const task = await ctx.nsp("gang.getTaskStats", name);
      tasks.push({
        name: String(task.name), baseRespect: task.baseRespect, baseWanted: task.baseWanted,
        difficulty: task.difficulty,
        hackWeight: task.hackWeight, strWeight: task.strWeight, defWeight: task.defWeight,
        dexWeight: task.dexWeight, agiWeight: task.agiWeight, chaWeight: task.chaWeight,
        territory: { respect: task.territory.respect, wanted: task.territory.wanted },
      });
    }
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
        territory: info.territory,
        territoryWarfareEngaged: info.territoryWarfareEngaged,
        respectForNextRecruit: info.respectForNextRecruit,
        recruitsAvailable: await ctx.nsp("gang.getRecruitsAvailable"),
        members,
        tasks,
        gangSoftcap: effectiveBitNodeMultipliers(
          ctx.caps.bitNode,
          sfLevel(ctx.caps.sourceFiles, 12),
          ctx.state.topics.progression?.multipliers,
        )?.GangSoftcap ?? 1,
        ascensionGain,
      }),
    ];
  },
};

// --- corp ------------------------------------------------------------------

const corpCore: PricedProbe = {
  id: "corp.core",
  kind: "priced",
  feature: "corp",
  requires: "corp",
  everyMs: MIN_1,
  merge: true,
  async run(ctx: ProbeContext) {
    const c = await ctx.nsp("corporation.getCorporation");
    const offer = await ctx.nsp("corporation.getInvestmentOffer");
    // Public/exhausted corporations receive a zero-valued offer rather than an
    // exception, so the optional topic field is kept for an ACTIONABLE offer
    // and left undefined otherwise.
    // Source: https://github.com/bitburner-official/bitburner-src/blob/3162fd2590e221eadd0c0fbd46151913f7c4c41c/src/Corporation/Corporation.ts#L333-L354
    const investmentOffer = offer.funds > 0 && offer.shares > 0
      ? { round: offer.round, funds: offer.funds, shares: offer.shares }
      : undefined;
    return [
      // emitPartial, not a cast: this probe declares `merge: true`, and the
      // partial helper is what keeps every field name checked against CorpState
      // instead of `as never` silently accepting a renamed one.
      // `divisions` belongs to the corp.divisions probe — see CorpState.
      emitPartial("corp", {
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
        investmentOffer,
      }),
    ];
  },
};

/** One division's digest. Its five 10 GB CorporationInfo getters are chained
 * only by data. The resident charges them as separate first calls and may
 * respawn between them. */
interface CorpDivision {
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
  offices: {
    city: string;
    size: number;
    numEmployees: number;
    avgEnergy: number;
    avgMorale: number;
    jobs: Record<string, number>;
  }[];
  warehouses: {
    city: string;
    level: number;
    size: number;
    sizeUsed: number;
    smartSupplyEnabled: boolean;
  }[];
}

const corpDivisions: PricedProbe = {
  id: "corp.divisions",
  kind: "priced",
  feature: "corp",
  requires: "corp",
  everyMs: MIN_2,
  merge: true,
  async run(ctx: ProbeContext) {
    const names = (await ctx.nsp("corporation.getCorporation")).divisions.map(String);
    const divisions: CorpDivision[] = [];
    for (const name of names) {
      const d = await ctx.nsp("corporation.getDivision", name);
      const division: CorpDivision = {
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
        offices: [],
        warehouses: [],
      };
      for (const city of division.cities) {
        const office = await ctx.nsp("corporation.getOffice", division.name, city as never);
        division.offices.push({
          city,
          size: office.size,
          numEmployees: office.numEmployees,
          avgEnergy: office.avgEnergy,
          avgMorale: office.avgMorale,
          jobs: Object.fromEntries(Object.entries(office.employeeJobs).map(([k, v]) => [String(k), v])),
        });
        // getWarehouse throws for a city with no warehouse, so presence is
        // asked first rather than inferred from a caught exception.
        if (!await ctx.nsp("corporation.hasWarehouse", division.name, city as never)) continue;
        const w = await ctx.nsp("corporation.getWarehouse", division.name, city as never);
        division.warehouses.push({
          city,
          level: w.level,
          size: w.size,
          sizeUsed: w.sizeUsed,
          smartSupplyEnabled: w.smartSupplyEnabled,
        });
      }
      divisions.push(division);
    }
    return [emitPartial("corp", { divisions })];
  },
};

// --- bladeburner -----------------------------------------------------------

const bladeCore: PricedProbe = {
  id: "bladeburner.core",
  kind: "priced",
  feature: "bladeburner",
  requires: "bladeburner",
  everyMs: SEC_30,
  merge: true,
  async run(ctx: ProbeContext) {
    const rank = await ctx.nsp("bladeburner.getRank");
    const skillPoints = await ctx.nsp("bladeburner.getSkillPoints");
    const stamina = await ctx.nsp("bladeburner.getStamina");
    const city = String(await ctx.nsp("bladeburner.getCity"));
    const chaos = await ctx.nsp("bladeburner.getCityChaos", city as never);

    // getCurrentAction and getActionCurrentTime are read back to back: the
    // elapsed time is reported for whatever action is current when it is asked,
    // so anything that lets the action change in between attributes one
    // action's progress to another.
    const action = await ctx.nsp("bladeburner.getCurrentAction");
    const current = action
      ? {
        type: String(action.type),
        name: String(action.name),
        elapsedMs: await ctx.nsp("bladeburner.getActionCurrentTime"),
      }
      : undefined;

    // Black ops complete in a fixed order, so the next uncompleted op's index
    // IS the completed count (null next = all done). getBlackOpNames is 0 GB,
    // which is why the endgame estimate can live on this 30 s tier rather than
    // waiting minutes for the detail probe.
    const next = await ctx.nsp("bladeburner.getNextBlackOp");
    const blackOpNames = (await ctx.nsp("bladeburner.getBlackOpNames")).map(String);
    const nextIndex = next ? blackOpNames.indexOf(String(next.name)) : blackOpNames.length;

    return [
      // emitPartial, not a cast: this probe declares `merge: true`, and the
      // partial helper keeps every field name checked against BladeburnerState
      // instead of `as never` accepting anything.
      // skills/actions/cities belong to the detail probes — see
      // BladeburnerState; emitting placeholders here would blank them.
      emitPartial("bladeburner", {
        rank,
        skillPoints,
        stamina,
        city,
        chaos,
        current,
        ...(next ? { nextBlackOp: { name: String(next.name), rank: next.rank } } : {}),
        ...(nextIndex >= 0 ? { blackOpsComplete: nextIndex } : {}),
      }),
    ];
  },
};

/** One row per Bladeburner action.
 *
 * The per-action getters here are BladeburnerApiBase (4 GB), with seven calls
 * for a levelable row. The four name lists and getSkillNames are 0 GB, so
 * addressing the actions costs nothing either way. Contracts and operations
 * alone have level getters; calling those APIs for a general action or Black
 * Op is rejected by the game. */
const bladeActionsProbe: PricedProbe = {
  id: "bladeburner.actions",
  kind: "priced",
  feature: "bladeburner",
  requires: "bladeburner",
  everyMs: MIN_2,
  merge: true,
  async run(ctx: ProbeContext) {
    const groups: { type: BladeActionDigest["type"]; names: string[] }[] = [
      { type: "contract", names: (await ctx.nsp("bladeburner.getContractNames")).map(String) },
      { type: "operation", names: (await ctx.nsp("bladeburner.getOperationNames")).map(String) },
      { type: "blackop", names: (await ctx.nsp("bladeburner.getBlackOpNames")).map(String) },
      { type: "general", names: (await ctx.nsp("bladeburner.getGeneralActionNames")).map(String) },
    ];
    const actions: BladeActionDigest[] = [];
    for (const { type, names } of groups) {
      for (const name of names) {
        const apiType = bladeburnerApiActionType(type);
        const action: BladeActionDigest = {
          type,
          name,
          chance: await ctx.nsp("bladeburner.getActionEstimatedSuccessChance", apiType, name as never),
          timeMs: await ctx.nsp("bladeburner.getActionTime", apiType, name as never),
          countRemaining: await ctx.nsp("bladeburner.getActionCountRemaining", apiType, name as never),
          // Both rank values are public in v3.0.1. Reading them prevents a
          // made-up rank reward and enforces each Black Op's hard rank gate;
          // failure rank loss is independently level-adjusted, so
          // expected-rank scheduling must not treat a failure as a zero-rank
          // outcome.
          // Source: https://github.com/bitburner-official/bitburner-src/blob/3162fd2590e221eadd0c0fbd46151913f7c4c41c/src/NetscriptFunctions/Bladeburner.ts#L165-L171
          // Source: https://github.com/bitburner-official/bitburner-src/blob/3162fd2590e221eadd0c0fbd46151913f7c4c41c/src/NetscriptFunctions/Bladeburner.ts#L164-L181
          rankGain: await ctx.nsp("bladeburner.getActionRankGain", apiType, name as never),
          rankLoss: await ctx.nsp("bladeburner.getActionRankLoss", apiType, name as never),
        };
        // The game rejects getActionCurrentLevel/getActionMaxLevel for general
        // actions and Black Ops; only contracts and operations are levelable.
        if (type === "contract" || type === "operation") {
          action.level = await ctx.nsp("bladeburner.getActionCurrentLevel", apiType, name as never);
          action.maxLevel = await ctx.nsp("bladeburner.getActionMaxLevel", apiType, name as never);
        }
        if (type === "blackop") {
          action.rankNeeded = await ctx.nsp("bladeburner.getBlackOpRank", name as never);
        }
        actions.push(action);
      }
    }

    const skills: Record<string, { level: number; upgradeCost: number }> = {};
    for (const skill of await ctx.nsp("bladeburner.getSkillNames")) {
      skills[String(skill)] = {
        level: await ctx.nsp("bladeburner.getSkillLevel", skill),
        upgradeCost: await ctx.nsp("bladeburner.getSkillUpgradeCost", skill, 1),
      };
    }
    return [emitPartial("bladeburner", { actions, skills })];
  },
};

const BLADE_CITY_NAMES = ["Aevum", "Chongqing", "Sector-12", "New Tokyo", "Ishima", "Volhaven"];

const bladeCities: PricedProbe = {
  id: "bladeburner.cities",
  kind: "priced",
  feature: "bladeburner",
  requires: "bladeburner",
  everyMs: MIN_2,
  merge: true,
  async run(ctx: ProbeContext) {
    const cities = [];
    for (const name of BLADE_CITY_NAMES) {
      cities.push({
        name,
        population: await ctx.nsp("bladeburner.getCityEstimatedPopulation", name as never),
        communities: await ctx.nsp("bladeburner.getCityCommunities", name as never),
        chaos: await ctx.nsp("bladeburner.getCityChaos", name as never),
      });
    }
    return [emitPartial("bladeburner", { cities, bonusTime: await ctx.nsp("bladeburner.getBonusTime") })];
  },
};

// --- sleeves ---------------------------------------------------------------

const sleevesCore: PricedProbe = {
  id: "sleeves.core",
  kind: "priced",
  feature: "sleeves",
  requires: "sleeves",
  everyMs: SEC_30,
  merge: true,
  async run(ctx: ProbeContext) {
    const count = await ctx.nsp("sleeve.getNumSleeves");
    const sleeves = [];
    for (let i = 0; i < count; i++) {
      const s = await ctx.nsp("sleeve.getSleeve", i);
      const task = await ctx.nsp("sleeve.getTask", i) as ({ type: string } & Record<string, unknown>) | null;
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

// --- stanek ----------------------------------------------------------------

const stanekCore: PricedProbe = {
  id: "stanek.core",
  kind: "priced",
  feature: "stanek",
  requires: "stanek",
  everyMs: MIN_1,
  merge: true,
  async run(ctx: ProbeContext) {
    const active = await ctx.nsp("stanek.activeFragments");
    const occupied: Record<string, number> = {};
    const fragments = active.map((f) => {
      const shape = f.shape.flatMap((row, y) => row.flatMap((full, x) => full ? [{ x, y }] : []));
      // activeFragments merges the ActiveFragment rotation with the base
      // Fragment's unrotated shape. Apply Fragment.fullAt's quarter-turn
      // convention before publishing occupied world cells.
      // Source: https://github.com/bitburner-official/bitburner-src/blob/3162fd2590e221eadd0c0fbd46151913f7c4c41c/src/NetscriptFunctions/Stanek.ts#L63-L73
      // Source: https://github.com/bitburner-official/bitburner-src/blob/3162fd2590e221eadd0c0fbd46151913f7c4c41c/src/CotMG/Fragment.ts#L24-L41
      for (const cell of rotate(shape, f.rotation)) occupied[`${f.x + cell.x},${f.y + cell.y}`] = f.id;
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
        // chargeFragment rejects FragmentType.Booster (numeric value 18).
        // Source: https://github.com/bitburner-official/bitburner-src/blob/3162fd2590e221eadd0c0fbd46151913f7c4c41c/src/NetscriptFunctions/Stanek.ts#L34-L43
        chargeable: f.type !== 18,
      };
    });
    return [
      emit("stanek", {
        width: await ctx.nsp("stanek.giftWidth"),
        height: await ctx.nsp("stanek.giftHeight"),
        occupied,
        fragments,
        availableTypes: (await ctx.nsp("stanek.fragmentDefinitions")).map((f) => ({
          id: f.id,
          type: String(f.type),
          power: f.power,
          limit: f.limit,
          shape: f.shape.flatMap((row, y) => row.flatMap((full, x) => full ? [{ x, y }] : [])),
        })),
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
 * inspects and drains bounded batches of its own.
 *
 * The limits live with the solver registry because both probe and driver use
 * them, and a drift between the two would stall or over-publish the queue. */

const sideContracts: PricedProbe = {
  id: "side.contracts",
  kind: "priced",
  feature: "side",
  everyMs: SEC_30,
  merge: true,
  async run(ctx: ProbeContext) {
    const { servers, state } = ctx;
    const ordinary: ContractQueueEntry[] = [];
    // Track only quarantined keys, not every contract in a large save. Each
    // discovered file removes itself; leftovers are stale failures to reap.
    const staleQuarantine = new Set(Object.keys(state.contractQuarantine ?? {}));
    let contractTotal = 0;
    let ordinaryCandidates = 0;
    for (const host of Object.keys(servers).sort()) {
      for (const file of (await ctx.nsp("ls", host, ".cct")).sort()) {
        contractTotal++;
        const key = `${host}\0${file}`;
        staleQuarantine.delete(key);
        if (!state.contractQuarantine?.[key]) {
          ordinaryCandidates++;
          if (ordinary.length < CONTRACT_QUEUE_LIMIT) ordinary.push({ host, file });
        }
      }
    }

    // A normal network scan cannot see darknet hosts. Preserve only resident
    // observations that are still inside their mutation-clock validity window,
    // and keep their quarantines until a newer resident listing proves absence.
    const now = Date.now();
    const allDarknet = darknetContractsFromListings(state.darknetContractListings, now);
    const darknet = pendingDarknetContracts(
      allDarknet,
      state.darknetContractHandledAt,
      state.contractQuarantine,
    );
    for (const [host, listing] of Object.entries(state.darknetContractListings ?? {})) {
      for (const file of listing.files) staleQuarantine.delete(contractKey({ host, file }));
    }
    const queue = mergeContractQueue(darknet, ordinary, CONTRACT_QUEUE_LIMIT);
    contractTotal += allDarknet.length;

    // A manually solved/deleted quarantined contract is no longer a failure
    // in the current world. This full-network ls sweep is the authoritative
    // and cheapest place to reap it.
    for (const key of staleQuarantine) delete state.contractQuarantine![key];
    state.contractQueue = queue;
    const contractTypes = (await ctx.nsp("codingcontract.getContractTypes")).map(String);
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
        contracts: queue.slice(0, CONTRACT_REPORT_LIMIT)
          .map((contract) => ({ host: contract.host, file: contract.file, origin: contractOrigin(contract) })),
        contractTotal,
        // Types are intentionally unknown until the bounded driver inspection.
        // This is therefore the unquarantined candidate count; unsupported
        // files move out of it as their batches are inspected.
        solvableTotal: Math.max(0, contractTotal - quarantine.length),
        contractsByOrigin: {
          network: { observed: contractTotal - allDarknet.length, solvable: ordinaryCandidates },
          darknet: { observed: allDarknet.length, solvable: darknet.length },
        },
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

export const PRICED_PROBES: readonly PricedProbe[] = [
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
  corpCore,
  corpDivisions,
  bladeCore,
  bladeActionsProbe,
  bladeCities,
  sleevesCore,
  stanekCore,
  sideContracts,
];

export type { Emission };
