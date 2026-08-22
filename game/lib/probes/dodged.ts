import type { NS } from "@ns";
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
import type { CorpState } from "../../../shared/telemetry/topics/corp.ts";
import type { BladeburnerState } from "../../../shared/telemetry/topics/bladeburner.ts";
import type { ReportHost } from "../../../shared/strategy/dnet/courier.ts";
import {
  contractKey,
  darknetContractsFromListings,
  mergeContractQueue,
  pendingDarknetContracts,
  type ContractQueueEntry,
} from "../contracts.ts";
import { emit, emitPartial, type DodgedProbe, type Emission, type ProbeAcc, type ProbeContext } from "./index.ts";
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
 * waits in the broker queue and surfaces as `ram.starvation` rather than
 * failing silently. */

/** Cadences as plain literals, never `2 * MINUTE`. esbuild cannot prove a
 * multiplication pure (an operand could have a valueOf), so an arithmetic
 * initializer pins the whole probe object into --perf bundles instead of
 * letting it tree-shake away with the rest of the telemetry code. */
const SEC_2 = 2_000;
/** Stock sampling cadence. Strictly BELOW `msPerStockUpdateMin` (4 s): during
 * stored-cycle catch-up the market ticks every 4 s exactly, so a 4 s sampler has
 * zero margin — any stub latency or scheduler jitter straddles two ticks, and a
 * missed tick folds two price moves into one observed step, corrupting the
 * volatility inversion and the cycle clock's tick count. 3 s leaves ~1 s of
 * jitter margin; `observeMarket` is idempotent under the resulting oversampling. */
const SEC_3 = 3_000;
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
/** Darknet password hints and their extracted data are free text of unknown
 *  length upstream, and one record carries a page of hosts. Clip at the source
 *  rather than trusting the field to be short. */
const HINT_LIMIT = 120;

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
  run(stubNs: NS, { servers, caps }: ProbeContext) {
    const fleet = fleetFrom(servers);
    fleet.purchased.limit = stubNs["cloud"]["getServerLimit"]();
    fleet.purchased.maxRamPerServer = stubNs["cloud"]["getRamLimit"]();
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
        const cost = stubNs["cloud"]["getServerCost"](quote.targetRam);
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
      const cost = stubNs["cloud"]["getServerUpgradeCost"](server.hostname, quote.targetRam);
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

const NEUROFLUX_GOVERNOR = "NeuroFlux Governor";

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
        // https://github.com/bitburner-official/bitburner-src/blob/3162fd2590e221eadd0c0fbd46151913f7c4c41c/src/NetscriptFunctions/Singularity.ts#L128-L133
        const owned = new Set((acc["owned"] as string[]) ?? []);
        const byFaction: Record<string, string[]> = {};
        let total = 0;
        for (const faction of Object.values(stubNs["enums"]["FactionName"]) as string[]) {
          try {
            const names = stubNs["singularity"]["getAugmentationsFromFaction"](faction as never)
              .map(String)
              // NeuroFlux is repeatable: owning/queueing one level must not
              // remove the next level from the final purchase sweep.
              // https://github.com/bitburner-official/bitburner-src/blob/3162fd2590e221eadd0c0fbd46151913f7c4c41c/src/Faction/FactionHelpers.tsx#L73-L91
              .filter((name) => name === NEUROFLUX_GOVERNOR || !owned.has(name));
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
      // Split from the multipliers below: both are SingularityFn3, so pairing
      // them made an 11.6 GB block at SF4 level 3 and 162.1 GB at level 0.
      methods: ["singularity.getAugmentationPrereq"],
      run(stubNs: NS, _ctx: ProbeContext, acc) {
        const prereqs: Record<string, string[]> = {};
        for (const name of listedAugs(acc)) {
          prereqs[name] = stubNs["singularity"]["getAugmentationPrereq"](name as never).map(String);
        }
        acc["prereqs"] = prereqs;
      },
    },
    {
      id: "mults",
      methods: ["singularity.getAugmentationStats"],
      run(stubNs: NS, _ctx: ProbeContext, acc) {
        const mults: Record<string, Record<string, number>> = {};
        for (const name of listedAugs(acc)) {
          // The multipliers are what the objective SCORES; without them the
          // planner can only rank by price, which is not the objective at all.
          //
          // Per-augmentation isolation: Unstable Circadian Modulator has no
          // stable stats (upstream randomises them at load), so the simulator
          // refuses rather than inventing a value. One refusal must not cost
          // the other ~200 augmentations their multipliers.
          // Source: https://github.com/bitburner-official/bitburner-src/blob/3162fd2590e221eadd0c0fbd46151913f7c4c41c/src/Augmentation/CircadianModulator.ts#L9-L25 and https://github.com/bitburner-official/bitburner-src/blob/3162fd2590e221eadd0c0fbd46151913f7c4c41c/src/Prestige.ts#L108-L120
          try {
            mults[name] = { ...stubNs["singularity"]["getAugmentationStats"](name as never) } as Record<string, number>;
          } catch {
            /* no stable multipliers for this augmentation */
          }
        }
        acc["mults"] = mults;
      },
    },
    {
      id: "graft-list",
      // Grafting is gated by BN10/SF10, NOT the SF4 that gates the rest of
      // this probe, and it THROWS rather than returning empty. Its own step,
      // so a save with Singularity but no Grafting still gets everything else.
      //
      // The list is also split from the per-augmentation price/time reads: all
      // three are 5 GB SingularityFn3-priced, so together they demanded a
      // 14.1 GB contiguous block — and 4x that at SF4 level 2, 16x at level 0,
      // where the probe simply never ran.
      methods: ["grafting.getGraftableAugmentations"],
      run(stubNs: NS, _ctx: ProbeContext, acc) {
        try {
          acc["graftNames"] = stubNs["grafting"]["getGraftableAugmentations"]()
            .slice(0, LIST_LIMIT).map(String);
        } catch {
          /* no Grafting API in this BitNode */
        }
      },
    },
    {
      id: "graft-terms",
      methods: [
        "grafting.getAugmentationGraftPrice",
        "grafting.getAugmentationGraftTime",
      ],
      run(stubNs: NS, _ctx: ProbeContext, acc) {
        const graftable: { name: string; price: number; timeMs: number }[] = [];
        try {
          for (const name of (acc["graftNames"] as string[] | undefined) ?? []) {
            graftable.push({
              name,
              price: stubNs["grafting"]["getAugmentationGraftPrice"](name as never),
              timeMs: stubNs["grafting"]["getAugmentationGraftTime"](name as never),
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

const CRIME_NAMES = [
  "Shoplift", "Rob Store", "Mug", "Larceny", "Deal Drugs", "Bond Forgery",
  "Traffick Arms", "Homicide", "Grand Theft Auto", "Kidnap", "Assassination", "Heist",
];

const careerCrimes: DodgedProbe = {
  id: "career.crimes",
  kind: "dodged",
  feature: "career",
  requires: "factions",
  everyMs: MIN_5,
  merge: true,
  // Two INDEPENDENT SingularityFn3 reads. At SF4 level 3 they are 5 GB each and
  // this is an 11.6 GB block; the singularity multiplier makes the same probe
  // 41.6 GB at level 2 and 162.1 GB at level 0, where it simply never ran. Split
  // one method per step, the peak follows the multiplier down to a single call.
  steps: [
    {
      id: "stats",
      methods: ["singularity.getCrimeStats"],
      run(stubNs: NS, _ctx: ProbeContext, acc) {
        const stats: Record<string, Record<string, number>> = {};
        for (const name of CRIME_NAMES) {
          stats[name] = stubNs["singularity"]["getCrimeStats"](name as never) as unknown as Record<string, number>;
        }
        acc["crimeStats"] = stats;
      },
    },
    {
      id: "chance",
      methods: ["singularity.getCrimeChance"],
      run(stubNs: NS, _ctx: ProbeContext, acc) {
        const chances: Record<string, number> = {};
        for (const name of CRIME_NAMES) chances[name] = stubNs["singularity"]["getCrimeChance"](name as never);
        acc["crimeChance"] = chances;
      },
    },
  ],
  // Both halves are required to rank a crime — a rate needs the odds and the
  // payout — so a partial accumulator emits nothing rather than a table sorted
  // by a fabricated zero.
  finish(acc) {
    const statsByName = acc["crimeStats"] as Record<string, Record<string, number>> | undefined;
    const chanceByName = acc["crimeChance"] as Record<string, number> | undefined;
    if (!statsByName || !chanceByName) return [];
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
    // Hacknet Servers are selected by the BN9/SF9 feature gate, unless the
    // BitNode option disables them.
    // Source: https://github.com/bitburner-official/bitburner-src/blob/3162fd2590e221eadd0c0fbd46151913f7c4c41c/src/Hacknet/HacknetHelpers.tsx#L34-L36
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
    // Hash economy exists only for Hacknet Servers (BN9/SF9). On plain nodes
    // these APIs return 0/Infinity/[]/false; omitting them keeps the topic's
    // semantics explicit rather than publishing an unusable hash economy.
    // Source: https://github.com/bitburner-official/bitburner-src/blob/3162fd2590e221eadd0c0fbd46151913f7c4c41c/src/NetscriptFunctions/Hacknet.ts#L164-L224
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
 * on the ladder we are. BN8/SF8 grants WSE and TIX on prestige; the two 4S
 * products are purchases. Read directly instead of inferred from whether
 * `getForecast` threw: that call checks `has4SDataTixApi` (the $25b API), not
 * `has4SData` (the $1b ticker data), so inferring conflated the two and left the
 * driver unable to tell "bought the useless one" from "bought nothing".
 * Source: https://github.com/bitburner-official/bitburner-src/blob/3162fd2590e221eadd0c0fbd46151913f7c4c41c/src/Prestige.ts#L163-L168
 * Source: https://github.com/bitburner-official/bitburner-src/blob/3162fd2590e221eadd0c0fbd46151913f7c4c41c/src/NetscriptFunctions/StockMarket.ts#L226-L246 */
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

/** Prices and positions, faster than the market's own cadence.
 *
 * 3 s, and that is the whole point of this probe: the market updates every 6 s
 * (4 s while burning stored cycles), and sampling slower than the tick makes the
 * tick structure unobservable — no up-tick count, so no forecast without 4S; no
 * per-tick magnitude, so no measured volatility; and no way to see the 45%-flip
 * cycle boundary that ends every regime. The old 30 s cadence saw one tick in
 * five and could recover none of it; the 4 s cadence that replaced it matched
 * `msPerStockUpdateMin` exactly and could still miss catch-up ticks (see SEC_3).
 * Source: https://github.com/bitburner-official/bitburner-src/blob/3162fd2590e221eadd0c0fbd46151913f7c4c41c/src/StockMarket/StockMarket.ts#L218-L258
 * Source: https://github.com/bitburner-official/bitburner-src/blob/3162fd2590e221eadd0c0fbd46151913f7c4c41c/src/StockMarket/data/Constants.ts#L3-L8
 *
 * `getAskPrice`/`getBidPrice` rather than `getPrice`: the mid is not a price
 * anything trades at, and the spread it hides is 10x-200x the commission on any
 * position worth opening. The mid is recovered as their mean, so nothing is lost
 * by dropping `getPrice` and 2 GB is saved. */
const stockTick: DodgedProbe = {
  id: "stock.tick",
  kind: "dodged",
  feature: "stock",
  everyMs: SEC_3,
  merge: true,
  when: (_caps, topics) => topics.stock?.hasTixApiAccess === true,
  methods: [
    "stock.getSymbols",
    "stock.getAskPrice",
    "stock.getBidPrice",
    "stock.getPosition",
    "stock.getMaxShares",
    "getServerMoneyAvailable",
  ],
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
    const cash = stubNs["getServerMoneyAvailable"]("home");
    return [emitPartial("stock", { positions, portfolioValue, portfolioCost, wealth: cash + portfolioValue })];
  },
};

/** The 4S signal. Gated on `has4SDataApi` rather than try/catch: the flag is
 *  already probed for 0.05 GB, so launching a 7 GB stub to discover it throws is
 *  pure waste. Same 3 s cadence as the prices, because the forecast is half of
 *  each tick's observation and the two must describe the same tick. */
const stockForecast: DodgedProbe = {
  id: "stock.forecast",
  kind: "dodged",
  feature: "stock",
  everyMs: SEC_3,
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
      // Undefined until the member has enough exp to gain anything.
      // Source: https://github.com/bitburner-official/bitburner-src/blob/3162fd2590e221eadd0c0fbd46151913f7c4c41c/src/NetscriptFunctions/Gang.ts#L283-L302
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
    const taskRates = Object.fromEntries(members.map((member) => [member.name, [{
      name: member.task,
      respect: member.respectGain,
      money: member.moneyGain,
      wanted: member.wantedLevelGain,
    }]]));
    // The API exposes exact rates only for each member's CURRENT task. We do
    // not pretend these are rates for unobserved tasks; without Formulas.exe
    // there is no side-effect-free API that prices every member/task pair.
    // Source: https://github.com/bitburner-official/bitburner-src/blob/3162fd2590e221eadd0c0fbd46151913f7c4c41c/src/NetscriptFunctions/Gang.ts#L151-L164
    const ascensionGain = Object.fromEntries(members.map((member) => {
      const result = member.ascensionResult;
      if (!result) return [member.name, 0];
      return [member.name, info.isHacking
        ? result.hack
        : Math.min(result.str, result.def, result.dex, result.agi)];
    }));
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
        taskRates,
        ascensionGain,
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
  // Two INDEPENDENT CorporationInfo reads at 10 GB each. Together they demanded
  // a 21.6 GB contiguous block once a minute; apart, 11.6 GB each for one extra
  // stub base (+1.6 GB) — the cheapest split on the board.
  steps: [
    {
      id: "corporation",
      methods: ["corporation.getCorporation"],
      run(stubNs: NS, _ctx: ProbeContext, acc) {
        const c = stubNs["corporation"]["getCorporation"]();
        acc["corp"] = {
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
        } satisfies CorpCoreAcc;
      },
    },
    {
      id: "offer",
      methods: ["corporation.getInvestmentOffer"],
      run(stubNs: NS, _ctx: ProbeContext, acc) {
        const offer = stubNs["corporation"]["getInvestmentOffer"]();
        // Public/exhausted corporations receive a zero-valued offer rather than
        // an exception. Keep the optional topic field for an actionable offer.
        // Source: https://github.com/bitburner-official/bitburner-src/blob/3162fd2590e221eadd0c0fbd46151913f7c4c41c/src/Corporation/Corporation.ts#L333-L354
        acc["offerRead"] = true;
        if (offer.funds > 0 && offer.shares > 0) {
          acc["investmentOffer"] = { round: offer.round, funds: offer.funds, shares: offer.shares };
        }
      },
    },
  ],
  // The corporation identity is what makes the topic meaningful, so an
  // unaffordable first step emits nothing rather than an offer with no corp.
  // A missing offer, by contrast, is the ordinary case and already optional.
  finish(acc) {
    const corp = acc["corp"] as CorpCoreAcc | undefined;
    if (!corp) return [];
    return [
      // emitPartial, not a cast: this probe declares `merge: true`, and the
      // partial helper is what keeps every field name checked against CorpState
      // instead of `as never` silently accepting a renamed one.
      emitPartial("corp", {
        ...corp,
        // `divisions` belongs to the corp.divisions probe — see CorpState.
        // The offer key is written ONLY when its step ran: a step the fleet
        // could not afford must leave a known offer standing rather than
        // clearing it, which is the difference between "no offer" and "not
        // asked".
        ...(acc["offerRead"] ? { investmentOffer: acc["investmentOffer"] as CorpState["investmentOffer"] } : {}),
      }),
    ];
  },
};

/** The identity half of the core digest. The offer is accumulated separately
 * because its step can be the one that does not fit. */
type CorpCoreAcc = Omit<CorpState, "divisions" | "investmentOffer" | "bonusTime" | "plan">;

/** Shapes accumulated across the division steps. Each step reads ONE
 * CorporationInfo-priced method (10 GB apiece), so keeping them in one stub cost
 * 51.6 GB of CONTIGUOUS RAM on a single host — large enough that a busy fleet
 * simply never placed it, and this probe runs every two minutes. Split, the peak
 * is one 11.6 GB step. The extra cost is four more stub bases (+6.4 GB total)
 * spread across sequential launches, which is the trade this shape exists for.
 *
 * They are pure reads chained only by data — corporation -> division names ->
 * per-division cities -> per-(division, city) office/warehouse — which is
 * exactly what the accumulator carries between steps. */
interface CorpDivisionAcc {
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

function corpDivisionAcc(acc: ProbeAcc): CorpDivisionAcc[] {
  return (acc["divisions"] as CorpDivisionAcc[] | undefined) ?? [];
}

const corpDivisions: DodgedProbe = {
  id: "corp.divisions",
  kind: "dodged",
  feature: "corp",
  requires: "corp",
  everyMs: MIN_2,
  merge: true,
  steps: [
    {
      id: "names",
      methods: ["corporation.getCorporation"],
      run(stubNs: NS, _ctx: ProbeContext, acc) {
        acc["names"] = stubNs["corporation"]["getCorporation"]().divisions.map(String);
      },
    },
    {
      id: "divisions",
      methods: ["corporation.getDivision"],
      run(stubNs: NS, _ctx: ProbeContext, acc) {
        acc["divisions"] = ((acc["names"] as string[] | undefined) ?? []).map((name) => {
          const d = stubNs["corporation"]["getDivision"](name);
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
            offices: [],
            warehouses: [],
          } satisfies CorpDivisionAcc;
        });
      },
    },
    {
      id: "offices",
      methods: ["corporation.getOffice"],
      run(stubNs: NS, _ctx: ProbeContext, acc) {
        for (const division of corpDivisionAcc(acc)) {
          for (const city of division.cities) {
            const office = stubNs["corporation"]["getOffice"](division.name, city as never);
            division.offices.push({
              city,
              size: office.size,
              numEmployees: office.numEmployees,
              avgEnergy: office.avgEnergy,
              avgMorale: office.avgMorale,
              jobs: Object.fromEntries(Object.entries(office.employeeJobs).map(([k, v]) => [String(k), v])),
            });
          }
        }
      },
    },
    {
      id: "warehouse-presence",
      // hasWarehouse is its own CorporationInfo read, so asking it in the same
      // stub as getWarehouse would put two 10 GB methods back in one block.
      methods: ["corporation.hasWarehouse"],
      run(stubNs: NS, _ctx: ProbeContext, acc) {
        const stocked: Record<string, string[]> = {};
        for (const division of corpDivisionAcc(acc)) {
          stocked[division.name] = division.cities.filter((city) =>
            stubNs["corporation"]["hasWarehouse"](division.name, city as never));
        }
        acc["stocked"] = stocked;
      },
    },
    {
      id: "warehouses",
      methods: ["corporation.getWarehouse"],
      run(stubNs: NS, _ctx: ProbeContext, acc) {
        const stocked = (acc["stocked"] as Record<string, string[]> | undefined) ?? {};
        for (const division of corpDivisionAcc(acc)) {
          for (const city of stocked[division.name] ?? []) {
            const w = stubNs["corporation"]["getWarehouse"](division.name, city as never);
            division.warehouses.push({
              city,
              level: w.level,
              size: w.size,
              sizeUsed: w.sizeUsed,
              smartSupplyEnabled: w.smartSupplyEnabled,
            });
          }
        }
        acc["complete"] = true;
      },
    },
  ],
  // Published ONLY when every step ran. A partial table is worse than none
  // here: the topic merges shallowly, so an empty `divisions` (the getDivision
  // step did not fit) or an empty `warehouses` (the getWarehouse step did not)
  // replaces a good table with one the corp stages read as "not built yet" —
  // and they answer that by re-issuing expandIndustry/buyWarehouse for things
  // that already exist. Keeping the previous sweep is the correct partial.
  finish(acc) {
    if (!acc["complete"]) return [];
    return [emitPartial("corp", { divisions: corpDivisionAcc(acc) })];
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
  // Six independent 4 GB reads summed to a 24.6 GB contiguous block every 30 s.
  // Split three ways the peak is 9.6 GB, for two extra stub bases (+3.2 GB).
  steps: [
    {
      id: "action",
      // getCurrentAction and getActionCurrentTime MUST stay in one stub: the
      // elapsed time is reported for whatever action is current when it is
      // asked, so reading them from separate stubs would attribute one action's
      // progress to another whenever the action changes in between.
      methods: [
        "bladeburner.getCurrentAction",
        "bladeburner.getActionCurrentTime",
        "bladeburner.getNextBlackOp",
        "bladeburner.getBlackOpNames",
      ],
      run(stubNs: NS, _ctx: ProbeContext, acc) {
        acc["actionRead"] = true;
        const action = stubNs["bladeburner"]["getCurrentAction"]();
        if (action) {
          acc["current"] = {
            type: String(action.type),
            name: String(action.name),
            elapsedMs: stubNs["bladeburner"]["getActionCurrentTime"](),
          };
        }
        const next = stubNs["bladeburner"]["getNextBlackOp"]();
        // Black ops complete in a fixed order, so the next uncompleted op's
        // index IS the completed count (null next = all done). getBlackOpNames
        // is 0 GB, which keeps this on the cheap 30 s core tier instead of the
        // ~28 GB detail probe the endgame estimate would otherwise wait
        // minutes for.
        const blackOpNames = stubNs["bladeburner"]["getBlackOpNames"]().map(String);
        const nextIndex = next ? blackOpNames.indexOf(String(next.name)) : blackOpNames.length;
        if (next) acc["nextBlackOp"] = { name: String(next.name), rank: next.rank };
        if (nextIndex >= 0) acc["blackOpsComplete"] = nextIndex;
      },
    },
    {
      id: "standing",
      methods: ["bladeburner.getRank", "bladeburner.getSkillPoints"],
      run(stubNs: NS, _ctx: ProbeContext, acc) {
        acc["rank"] = stubNs["bladeburner"]["getRank"]();
        acc["skillPoints"] = stubNs["bladeburner"]["getSkillPoints"]();
      },
    },
    {
      id: "position",
      methods: ["bladeburner.getStamina", "bladeburner.getCity"],
      run(stubNs: NS, _ctx: ProbeContext, acc) {
        acc["stamina"] = stubNs["bladeburner"]["getStamina"]();
        acc["city"] = String(stubNs["bladeburner"]["getCity"]());
      },
    },
  ],
  // Rank is the field everything else is judged against, so an unaffordable
  // standing step emits nothing rather than a division with no rank.
  finish(acc) {
    if (acc["rank"] === undefined) return [];
    return [
      // emitPartial, not a cast: this probe declares `merge: true`, and the
      // partial helper keeps every field name checked against BladeburnerState
      // instead of `as never` accepting anything.
      emitPartial("bladeburner", {
        rank: acc["rank"] as number,
        skillPoints: acc["skillPoints"] as number | undefined,
        stamina: acc["stamina"] as [number, number] | undefined,
        city: acc["city"] as string | undefined,
        // Written only when the action step ran, for the same reason as the
        // corporation offer above: an unaffordable step must not read as "no
        // action in progress".
        ...(acc["actionRead"] ? {
          current: acc["current"] as BladeburnerState["current"],
          nextBlackOp: acc["nextBlackOp"] as BladeburnerState["nextBlackOp"],
          blackOpsComplete: acc["blackOpsComplete"] as number | undefined,
        } : {}),
        // skills/actions/cities belong to the detail probes — see
        // BladeburnerState; emitting placeholders here would blank them.
      }),
    ];
  },
};

/** One row per Bladeburner action, filled in across several steps.
 *
 * Every getter here is BladeburnerApiBase (4 GB) and they summed to 39.6 GB of
 * CONTIGUOUS RAM in a single stub. The four name lists and getSkillNames are
 * 0 GB, so re-declaring them in each step is FREE — which is what makes this
 * split cheap: the peak drops to 13.6 GB for four more stub bases (+4.8 GB).
 *
 * Each getter is an independent per-(type, name) read, so the only thing the
 * steps share is the action list itself. */
interface BladeActionAcc {
  type: "contract" | "operation" | "blackop" | "general";
  name: string;
  chance: [number, number];
  timeMs: number;
  countRemaining: number;
  level: number;
  maxLevel: number;
  rankGain: number;
  rankLoss: number;
  rankNeeded?: number;
}

/** The 0 GB name lists. Declared by every step that needs to address actions,
 * because they cost nothing and re-reading them keeps the steps independent. */
const BLADE_NAME_METHODS = [
  "bladeburner.getContractNames",
  "bladeburner.getOperationNames",
  "bladeburner.getBlackOpNames",
  "bladeburner.getGeneralActionNames",
];

function bladeActionRows(stubNs: NS): BladeActionAcc[] {
  const groups: { type: BladeActionAcc["type"]; names: string[] }[] = [
    { type: "contract", names: stubNs["bladeburner"]["getContractNames"]().map(String) },
    { type: "operation", names: stubNs["bladeburner"]["getOperationNames"]().map(String) },
    { type: "blackop", names: stubNs["bladeburner"]["getBlackOpNames"]().map(String) },
    { type: "general", names: stubNs["bladeburner"]["getGeneralActionNames"]().map(String) },
  ];
  return groups.flatMap(({ type, names }) => names.map((name) => ({
    type,
    name,
    chance: [0, 0] as [number, number],
    timeMs: 0,
    countRemaining: 0,
    level: 0,
    maxLevel: 0,
    rankGain: 0,
    rankLoss: 0,
  })));
}

function bladeActions(acc: ProbeAcc): BladeActionAcc[] {
  return (acc["actions"] as BladeActionAcc[] | undefined) ?? [];
}

const bladeActionsProbe: DodgedProbe = {
  id: "bladeburner.actions",
  kind: "dodged",
  feature: "bladeburner",
  requires: "bladeburner",
  everyMs: MIN_2,
  merge: true,
  steps: [
    {
      id: "timing",
      methods: [
        ...BLADE_NAME_METHODS,
        "bladeburner.getActionEstimatedSuccessChance",
        "bladeburner.getActionTime",
      ],
      run(stubNs: NS, _ctx: ProbeContext, acc) {
        const actions = bladeActionRows(stubNs);
        for (const action of actions) {
          action.chance = stubNs["bladeburner"]["getActionEstimatedSuccessChance"](action.type as never, action.name as never);
          action.timeMs = stubNs["bladeburner"]["getActionTime"](action.type as never, action.name as never);
        }
        acc["actions"] = actions;
      },
    },
    {
      id: "levels",
      methods: [
        ...BLADE_NAME_METHODS,
        "bladeburner.getActionCountRemaining",
        "bladeburner.getActionCurrentLevel",
        "bladeburner.getActionMaxLevel",
      ],
      run(stubNs: NS, _ctx: ProbeContext, acc) {
        for (const action of bladeActions(acc)) {
          action.countRemaining = stubNs["bladeburner"]["getActionCountRemaining"](action.type as never, action.name as never);
          action.level = stubNs["bladeburner"]["getActionCurrentLevel"](action.type as never, action.name as never);
          action.maxLevel = stubNs["bladeburner"]["getActionMaxLevel"](action.type as never, action.name as never);
        }
      },
    },
    {
      id: "rank",
      methods: [
        ...BLADE_NAME_METHODS,
        "bladeburner.getActionRankGain",
        "bladeburner.getActionRankLoss",
        "bladeburner.getBlackOpRank",
      ],
      run(stubNs: NS, _ctx: ProbeContext, acc) {
        for (const action of bladeActions(acc)) {
          // Both values are public in v3.0.1. Reading them prevents a made-up
          // rank reward and enforces each Black Op's hard rank gate.
          // Source: https://github.com/bitburner-official/bitburner-src/blob/3162fd2590e221eadd0c0fbd46151913f7c4c41c/src/NetscriptFunctions/Bladeburner.ts#L165-L171
          // Source: https://github.com/bitburner-official/bitburner-src/blob/3162fd2590e221eadd0c0fbd46151913f7c4c41c/src/NetscriptFunctions/Bladeburner.ts#L94-L99
          action.rankGain = stubNs["bladeburner"]["getActionRankGain"](action.type as never, action.name as never);
          // Failure rank loss is independently level-adjusted; expected-rank
          // scheduling must not treat a failed action as a zero-rank outcome.
          // Source: https://github.com/bitburner-official/bitburner-src/blob/3162fd2590e221eadd0c0fbd46151913f7c4c41c/src/NetscriptFunctions/Bladeburner.ts#L164-L181
          action.rankLoss = stubNs["bladeburner"]["getActionRankLoss"](action.type as never, action.name as never);
          if (action.type === "blackop") {
            action.rankNeeded = stubNs["bladeburner"]["getBlackOpRank"](action.name as never);
          }
        }
        acc["actionsComplete"] = true;
      },
    },
    {
      id: "skills",
      methods: [
        "bladeburner.getSkillNames",
        "bladeburner.getSkillLevel",
        "bladeburner.getSkillUpgradeCost",
      ],
      run(stubNs: NS, _ctx: ProbeContext, acc) {
        const skills: Record<string, { level: number; upgradeCost: number }> = {};
        for (const skill of stubNs["bladeburner"]["getSkillNames"]()) {
          skills[String(skill)] = {
            level: stubNs["bladeburner"]["getSkillLevel"](skill),
            upgradeCost: stubNs["bladeburner"]["getSkillUpgradeCost"](skill, 1),
          };
        }
        acc["skills"] = skills;
      },
    },
  ],
  // The action table is published ONLY once every step that fills a row has
  // run. A half-filled row is not a missing field, it is a WRONG one: the topic
  // merges shallowly, so `countRemaining: 0` on every row replaces a good table
  // with one stepBladeburner filters away entirely (decide.ts, `countRemaining
  // > 0`), and one the endgame estimate reads as "every Black Op complete".
  // Keeping the previous sweep is the correct partial. Skills are their own
  // independent field and are emitted whenever their step ran.
  finish(acc) {
    const skills = acc["skills"] as Record<string, { level: number; upgradeCost: number }> | undefined;
    if (!acc["actionsComplete"] && !skills) return [];
    return [emitPartial("bladeburner", {
      ...(acc["actionsComplete"] ? { actions: bladeActions(acc) } : {}),
      ...(skills ? { skills } : {}),
    })];
  },
};

const BLADE_CITY_NAMES = ["Aevum", "Chongqing", "Sector-12", "New Tokyo", "Ishima", "Volhaven"];

interface BladeCityAcc { name: string; population: number; communities: number; chaos: number }

function bladeCityRows(acc: ProbeAcc): BladeCityAcc[] {
  return (acc["cities"] as BladeCityAcc[] | undefined) ?? [];
}

const bladeCities: DodgedProbe = {
  id: "bladeburner.cities",
  kind: "dodged",
  feature: "bladeburner",
  requires: "bladeburner",
  everyMs: MIN_2,
  merge: true,
  // Three independent 4 GB per-city reads over a fixed name list; getBonusTime
  // is 0 GB and rides along. 13.6 GB in one block becomes 5.6 GB peak for two
  // extra stub bases (+3.2 GB).
  steps: [
    {
      id: "population",
      methods: ["bladeburner.getCityEstimatedPopulation"],
      run(stubNs: NS, _ctx: ProbeContext, acc) {
        acc["cities"] = BLADE_CITY_NAMES.map((name) => ({
          name,
          population: stubNs["bladeburner"]["getCityEstimatedPopulation"](name as never),
          communities: 0,
          chaos: 0,
        }));
      },
    },
    {
      id: "communities",
      methods: ["bladeburner.getCityCommunities"],
      run(stubNs: NS, _ctx: ProbeContext, acc) {
        for (const city of bladeCityRows(acc)) {
          city.communities = stubNs["bladeburner"]["getCityCommunities"](city.name as never);
        }
      },
    },
    {
      id: "chaos",
      methods: ["bladeburner.getCityChaos", "bladeburner.getBonusTime"],
      run(stubNs: NS, _ctx: ProbeContext, acc) {
        for (const city of bladeCityRows(acc)) {
          city.chaos = stubNs["bladeburner"]["getCityChaos"](city.name as never);
        }
        acc["bonusTime"] = stubNs["bladeburner"]["getBonusTime"]();
        acc["citiesComplete"] = true;
      },
    },
  ],
  // Same rule as the action table: a row whose communities/chaos step did not
  // fit would publish 0 for both, and a shallow merge turns that into a chaos
  // reading the decider trusts (CHAOS_CEILING) — silently disabling Diplomacy
  // in a city that is actually over the ceiling. A missed sweep keeps the last
  // good one instead. `bonusTime` is read in the same step, so it is never a
  // fabricated 0 either.
  finish(acc) {
    if (!acc["citiesComplete"]) return [];
    return [emitPartial("bladeburner", {
      cities: bladeCityRows(acc),
      bonusTime: acc["bonusTime"] as number | undefined,
    })];
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
        width: stubNs["stanek"]["giftWidth"](),
        height: stubNs["stanek"]["giftHeight"](),
        occupied,
        fragments,
        availableTypes: stubNs["stanek"]["fragmentDefinitions"]().map((f) => ({
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

// --- darknet ---------------------------------------------------------------

const dnetCore: DodgedProbe = {
  id: "dnet.core",
  kind: "dodged",
  feature: "dnet",
  requires: "dnet",
  everyMs: MIN_1,
  merge: true,
  // getServerDetails already carries depth, blockedRam and requiredCharismaSkill,
  // so getDepth / getBlockedRam / getServerRequiredCharismaLevel would be three
  // extra distinct-function charges for values we already hold. The RAM getters
  // answer the one question the details object does not: whether a darknet host
  // has room to run an agent at all.
  methods: [
    "getHostname",
    "getServerMaxRam",
    "getServerUsedRam",
    "dnet.probe",
    "dnet.getServerDetails",
    "dnet.getStasisLinkLimit",
    "dnet.getStasisLinkedServers",
    "dnet.getDarknetInstability",
  ],
  run(stubNs: NS) {
    const observedFrom = stubNs["getHostname"]();
    // probe() returns only Darknet neighbors of the SCRIPT EXECUTION host and
    // shuffles their order. One launch is not a complete graph traversal.
    // Source: https://github.com/bitburner-official/bitburner-src/blob/3162fd2590e221eadd0c0fbd46151913f7c4c41c/src/NetscriptFunctions/Darknet.ts#L314-L335
    // probe() only sees the CALLING host's darknet neighbours, and a dodged
    // probe lands wherever the broker leased RAM — usually not home, the one
    // fleet host that neighbours darkweb. So the local neighbour list is a
    // bonus, not the source: getServerDetails takes no connection requirement
    // (checkDarknetServer is called with no options upstream), so `darkweb` —
    // the one darknet hostname guaranteed to exist — is readable from anywhere.
    // Source: https://github.com/bitburner-official/bitburner-src/blob/3162fd2590e221eadd0c0fbd46151913f7c4c41c/src/NetscriptFunctions/Darknet.ts#L382-L385
    const hosts = [...new Set(["darkweb", ...stubNs["dnet"]["probe"]()])];
    const linked = new Set(stubNs["dnet"]["getStasisLinkedServers"]().map(String));
    let maxDepth = -1;
    // ReportHost, the same shape a resident sends: home's one hop is one more
    // vantage on the same map rather than a second representation of it.
    const probed: ReportHost[] = [];
    const at = Date.now();
    for (const host of hosts.slice(0, LIST_LIMIT)) {
      // A host that has gone offline recently answers with a DUMMY details
      // object carrying isOnline: false. Its other fields describe nothing, so
      // publish the liveness bit and no more.
      const details = stubNs["dnet"]["getServerDetails"](host);
      if (details.isOnline === false) {
        probed.push({ hostname: host, at, present: false });
        continue;
      }
      if (details.depth > maxDepth) maxDepth = details.depth;
      // Ordinary server getters are not darknet-aware and throw on a host that
      // vanished between probe() and here.
      let maxRam: number | undefined;
      let usedRam: number | undefined;
      try {
        maxRam = stubNs["getServerMaxRam"](host);
        usedRam = stubNs["getServerUsedRam"](host);
      } catch {
        /* host went away mid-batch; the details above still stand */
      }
      probed.push({
        hostname: host,
        at,
        present: true,
        depth: details.depth,
        blockedRam: details.blockedRam,
        requiredCharisma: details.requiredCharismaSkill,
        // The discovery surface. Every one of these is undocumented upstream and
        // is what a password attack would have to reason from, so acquire it now
        // and let the tab show what the darknet actually looks like.
        modelId: details.modelId,
        passwordLength: details.passwordLength,
        passwordFormat: details.passwordFormat,
        passwordHint: details.passwordHint.slice(0, HINT_LIMIT),
        data: details.data.slice(0, HINT_LIMIT),
        logTrafficInterval: details.logTrafficInterval,
        difficulty: details.difficulty,
        isStationary: details.isStationary,
        ...(maxRam !== undefined ? { maxRam } : {}),
        ...(usedRam !== undefined ? { usedRam } : {}),
      });
    }
    return [
      emit("dnet", {
        observedFrom,
        topologyComplete: false,
        maxDepth,
        stasisLinkLimit: stubNs["dnet"]["getStasisLinkLimit"](),
        stasisLinked: [...linked],
        instability: stubNs["dnet"]["getDarknetInstability"](),
        probed,
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
    const ordinary: ContractQueueEntry[] = [];
    // Track only quarantined keys, not every contract in a large save. Each
    // discovered file removes itself; leftovers are stale failures to reap.
    const staleQuarantine = new Set(Object.keys(state.contractQuarantine ?? {}));
    let contractTotal = 0;
    for (const host of Object.keys(servers).sort()) {
      for (const file of stubNs["ls"](host, ".cct").sort()) {
        contractTotal++;
        const key = `${host}\0${file}`;
        staleQuarantine.delete(key);
        if (!state.contractQuarantine?.[key] && ordinary.length < CONTRACT_QUEUE_LIMIT) ordinary.push({ host, file });
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
        contracts: queue.slice(0, CONTRACT_REPORT_LIMIT).map(({ host, file }) => ({ host, file })),
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
  bladeActionsProbe,
  bladeCities,
  sleevesCore,
  stanekCore,
  dnetCore,
  sideContracts,
];

export type { Emission };
