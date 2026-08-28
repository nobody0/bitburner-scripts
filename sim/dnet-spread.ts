import type { SimServer } from "./core/effects.ts";
import { mockServer } from "./core/mocks.ts";
import { mulberry32 } from "./core/rng.ts";
import { attemptCharismaExp, DarknetSystem, LAB_AUGMENTATIONS } from "./features/dnet.ts";
import { StockMarketSystem } from "./features/stock.ts";
import { ProcessTable } from "./ns/process.ts";
import { getFunctionRamCost } from "./ns/ram-costs.ts";
import { SimWorld } from "./world.ts";
import { expForSkill, skillFromExp } from "../shared/formulas.ts";
import type { ReportHost } from "../shared/strategy/dnet/courier.ts";
import { discoverReports, foldReports, planningView, type DnetHosts, type ExpiryOpts } from "../shared/strategy/dnet/host.ts";
import { chooseLabVantage, holdHostFrom, planHold, type HoldHost } from "../shared/strategy/dnet/hold.ts";
import { planFarm, type FarmHost } from "../shared/strategy/dnet/farm.ts";
import { modelEntry, type PasswordFacts } from "../shared/strategy/dnet/models.ts";
import {
  candidatesFrom,
  DEFAULT_SPREAD_LIMITS,
  deriveTasks,
  planSpread,
  type DeriveOptions,
  type Task,
} from "../shared/strategy/dnet/plan.ts";
import {
  authenticateWaitMs,
  INDUCE_WAIT_MS,
  isLabyrinth,
  isOnAirGap,
  mutationIntervalMs,
  reclaimWaitMs,
  stasisWaitMs,
  type DnetTimingProfile,
} from "../shared/strategy/dnet/rates.ts";
import { solverFor } from "../shared/strategy/dnet/solvers/index.ts";
import {
  CONTROLLER_CALLS, KIND_CALLS, PROBER_ARMOURED_CALLS, PROBER_CALLS,
  PROBER_STASIS_CALLS, SCRIPT_BASE_GB,
} from "../game/dnet/shared.ts";

/** Reach-the-lab arena: cold start on darkweb, spread, crack, grind, pin, and
 * measure when the lab walker could START at full threads.
 *
 * The question `dnet-lab.ts` cannot ask — that lane begins where this one ends.
 * The REAL planners run here (`candidatesFrom` → `planSpread` → `deriveTasks`)
 * against the real `DarknetSystem` topology and mutation clock; only execution
 * is abstracted. An order costs exactly the wait `rates.ts` transcribes for it,
 * at the threads its vantage's RAM buys, and cracking a host costs one wave of
 * attempts per candidate:
 *
 * - a model with a solver is charged the solver's own DECLARED `budget(facts)`
 *   — the worst case, which is deliberately conservative and repeatable;
 * - a dictionary model is charged the true password's position in the same
 *   filtered candidate list `planAttempt` walks — exact, since the arena holds
 *   the generated password;
 * - a model neither can open is never cracked, exactly as deployed.
 *
 * Not modelled (documented, not forgotten): heartbleed/oracle feedback (which
 * would only SHORTEN solver conversations below their budget), backdoors,
 * money, and the maze walk after launch. Induced migration, planting,
 * reclaiming, pinning, and walker placement all execute in this arena. */

// --- pricing, from the same table the game bills against ----------------------

export const price = (calls: readonly string[]): number => {
  let total = SCRIPT_BASE_GB;
  for (const call of new Set(calls)) total += getFunctionRamCost(call);
  return total;
};

/** Each reserve comes from the SAME call list production sizes it with.
 * Ordinary hosts need local `exec + connectToSession`; stasis hosts deliberately
 * keep only the topology observer and launch jobs through the shared resident's
 * atomic authority lease. */
export const PROBER_GB = price(PROBER_CALLS);
export const PROBER_ARMOURED_SIM_GB = price(PROBER_ARMOURED_CALLS);
export const PROBER_STASIS_GB = price(PROBER_STASIS_CALLS);
export const CONTROLLER_GB = price(CONTROLLER_CALLS);
export const ATTEMPT_GB = price(KIND_CALLS.attempt);
export const RECLAIM_GB = price(KIND_CALLS.reclaim);
export const BOOTSTRAP_GB = price(KIND_CALLS.bootstrapReclaim);
export const PIN_GB = price(KIND_CALLS.pin);
export const WALK_GB = price(KIND_CALLS.walk);
export const CACHE_GB = price(KIND_CALLS.cache);
export const PHISH_GB = price(KIND_CALLS.phish);
export const PROMOTE_GB = price(KIND_CALLS.promote);
export const INDUCE_GB = price(KIND_CALLS.induce);

// --- the world fixture --------------------------------------------------------

export interface SpreadNet {
  world: SimWorld;
  system: DarknetSystem;
  network: Map<string, string[]>;
}

/** The same minimal recipe the sim's own dnet tests use: BN15, full access,
 * darkweb pinned beside home. Both lanes open caches, whose reward table can
 * draw a stock grant, so the market rides along by default.
 *
 * `augs` installs the first N labyrinth augmentations, which is how the world
 * DEEPENS: the current lab advances down `LAB_LADDER` (rung 1 is depth 12 with
 * one air gap; rung 3 is depth 23 with two) and the stasis limit grows with
 * the limit-bearing augs. The default 0 is the rung-0 world every earlier
 * baseline was recorded on: depth 7, no gaps, one stasis slot. */
export function generateNet(seed: number, opts: { stock?: boolean; augs?: number; redPill?: boolean } = {}): SpreadNet {
  const world = new SimWorld({ seed, bitnode: 15, network: [] });
  const servers = world.servers;
  const darkweb = mockServer({ hostname: "darkweb", maxRam: 16, hasAdminRights: true }) as SimServer;
  darkweb.simKind = "DarknetServer";
  servers.set("darkweb", darkweb);
  const network = new Map<string, string[]>([["home", ["darkweb"]], ["darkweb", ["home"]]]);
  const stock = opts.stock !== false
    ? new StockMarketSystem(world, world.player, mulberry32(seed + 2), {
      hasWseAccount: true,
      hasTixApiAccess: true,
    })
    : undefined;
  const installed = new Set<string>(LAB_AUGMENTATIONS.slice(0, opts.augs ?? 0));
  // BN15 hands the Red Pill over at the fifth lab, and the depth-36 rungs
  // (f1n4l, b0nus) sit behind it — augs alone stop the ladder at depth 29.
  if (opts.redPill === true) installed.add("The Red Pill");
  const system = new DarknetSystem({
    servers,
    network,
    processes: new ProcessTable(servers, world.clock),
    generate: mulberry32(seed),
    random: mulberry32(seed + 1),
    bitNode: 15,
    fullAccess: () => true,
    hasProgram: () => true,
    installedAugmentations: () => installed,
    allowRedPill: () => true,
    world,
    player: world.player,
    homeFiles: () => new Set<string>(),
    darknetMoneyMultiplier: () => 1,
    ...(stock !== undefined ? { stock } : {}),
  });
  system.populate();
  return { world, system, network };
}

/** Refuse a warmed or partially conquered fixture. This lane measures the
 * entire road from a newly populated Dnet, so inherited sessions, roots,
 * stasis links, mutations, or elapsed time would silently shorten it. */
export function assertFreshSpreadNet(net: SpreadNet): void {
  if (net.world.clock.now() !== 0) throw new Error("spread arena requires virtual time zero");
  if (net.system.mutations !== 0) throw new Error("spread arena requires an unmutated Dnet");
  const lab = [...net.system.hosts.values()].find((host) => isLabyrinth(host.hostname, host.modelId));
  if (lab === undefined) throw new Error("spread arena requires a current labyrinth");
  for (const host of net.system.hosts.values()) {
    if (host.sessions.size > 0) throw new Error(`spread arena requires no existing sessions (${host.hostname})`);
    if (host.stasisLinked) throw new Error(`spread arena requires no existing stasis links (${host.hostname})`);
    if (!host.isStationary && net.world.servers.get(host.hostname)?.hasAdminRights === true) {
      throw new Error(`spread arena requires every movable host unrooted (${host.hostname})`);
    }
  }
}

// --- run ----------------------------------------------------------------------

export interface SpreadRun {
  caseId: string;
  /** The walker could start: lab vantage cracked, pinned, block at zero. */
  solved: boolean;
  /** Pinned to the current lab's gate so this measures spreading, not levelling. */
  startingCharisma: number;
  labRequiredCharisma: number;
  msToFirstCrack?: number;
  msToHalfCracked?: number;
  msToLabSighted?: number;
  msToLabVantageCracked?: number;
  msToLabPinned?: number;
  msToWalkerStart?: number;
  /** The actual walk task admitted at the finish line. */
  walkerFrom?: string;
  walkerTarget?: string;
  /** First moment every air-gapped band held an agent of ours. */
  msToAllBandsReached?: number;
  walkerThreads?: number;
  plantCalls: number;
  bootstrapPlants: number;
  attemptCalls: number;
  reclaimCalls: number;
  cacheCalls: number;
  pinCalls: number;
  crackedCount: number;
  crackableCount: number;
  plantedPeak: number;
  mutations: number;
  /** Migration charges spent, hosts moved by them, and hosts a full-band
   *  re-roll deleted. */
  induceCalls: number;
  /** One wave is all induce calls assigned to one target in one planning pass. */
  induceWaves: number;
  /** Waves that reached charge 1, including the full-net deletion edge case. */
  completedInduceWaves: number;
  /** Completed waves whose target landed at a greater depth. */
  deeperInduceWaves: number;
  /** Waves that directly conquered a new air-gap band or revealed the lab. */
  usefulInduceWaves: number;
  induceMoves: number;
  induceDeletes: number;
  /** Restarts that killed one of our residents or bootstrap reclaimers. */
  occupiedRestarts: number;
  /** Killed hosts named by a surviving neighbour's immediate probe. */
  restartImmediatelyVisible: number;
  /** Killed hosts absent from every surviving agent's immediate probe. */
  restartLost: number;
  /** Restarted hosts replanted in the same virtual instant. */
  restartImmediateReplants: number;
  /** Initially lost hosts reached by a zero-time plant cascade in that tick. */
  restartLostSameTickReplants: number;
  restartRecovered: number;
  restartUnrecovered: number;
  restartRecoveryMs: number;
  restartMaxRecoveryMs: number;
  /** Usable resident capacity stranded while restarted hosts lacked an agent. */
  restartLostGbMs: number;
  /** Arithmetic cost of a hypothetical 2 GB reserve; never affects capacity. */
  hypotheticalRestartReserveGbMs: number;
  /** maxRam of each host holding a stasis link when the run ended. */
  linkedRam: number[];
  elapsedMs: number;
  reason?: string;
}

interface Job {
  kind: "attempt" | "reclaim" | "cache" | "pin" | "unpin" | "induce";
  target: string;
  threads: number;
  doneAt: number;
  filename?: string;
  induceWave?: string;
}

interface RestartOutage {
  at: number;
  usableGb: number;
  immediatelyVisible: boolean;
}

const CACHE_OPEN_MS = 200;

interface Agent {
  job?: Job;
  /** A spawn-free local reclaimer, not a full agent: it only grinds its own
   *  block and exits when the block clears. */
  bootstrap?: boolean;
}

const DEFAULT_CAP_MS = 6 * 60 * 60 * 1000;

/** How many conclusive attempts open this host, or undefined for a model the
 * deployed stack cannot open. See the module header for why solver models are
 * charged their declared budget. */
export function crackAttemptsFor(record: {
  modelId: string;
  password: string;
  passwordLength: number;
  passwordFormat: string;
  passwordHint: string;
  data: string;
  difficulty: number;
}): number | undefined {
  const facts: PasswordFacts = {
    passwordLength: record.passwordLength,
    passwordFormat: record.passwordFormat,
    passwordHint: record.passwordHint,
    data: record.data,
    difficulty: record.difficulty,
  };
  const solver = solverFor(record.modelId);
  if (solver) {
    const budget = solver.budget(facts);
    return Number.isFinite(budget) && budget > 0 ? Math.ceil(budget) : undefined;
  }
  const entry = modelEntry(record.modelId);
  const list = entry?.candidates?.(facts)
    .filter((candidate) => candidate.length === record.passwordLength);
  if (!list) return undefined;
  const index = list.indexOf(record.password);
  return index >= 0 ? index + 1 : undefined;
}

export function runSpreadCase(
  net: SpreadNet,
  capMs = DEFAULT_CAP_MS,
): SpreadRun {
  assertFreshSpreadNet(net);
  const { system, world } = net;
  const labHost = [...system.hosts.values()]
    .find((host) => isLabyrinth(host.hostname, host.modelId))?.hostname;
  const netDepth = system.netDepth();
  const mutationEveryMs = mutationIntervalMs(netDepth, 15);
  const mutationCycles = 150 / netDepth + 1;

  // One charisma pool, exactly as `labPlayer` keeps one for the lab arenas.
  // The default starts AT the current lab's charisma gate: below it the real
  // `planWalk` refuses `charisma` without even naming a candidate, and the
  // road to the gate is charisma farming — a different mode with its own
  // economics, not this lane's question.
  const skillMult = 1;
  const labGate = system.currentLab()?.cha;
  if (labGate === undefined) throw new Error("spread arena requires a current labyrinth");
  let charismaExp = expForSkill(labGate, skillMult);
  let charisma = skillFromExp(charismaExp, skillMult);
  const gainCharisma = (exp: number): void => {
    charismaExp += exp;
    charisma = skillFromExp(charismaExp, skillMult);
  };
  const profile = (): DnetTimingProfile => ({
    charisma,
    intelligence: 0,
    hasBoots: false,
    sf15Level: 0,
    authenticationDurationMultiplier: system.instability().authenticationDurationMultiplier,
  });

  const knowledge: DnetHosts = new Map();
  const vault = new Set<string>();
  const stasisLinked = new Set<string>();
  const agents = new Map<string, Agent>();
  /** Conclusive attempts spent per host, the arena's own ledger. */
  const tried = new Map<string, number>();
  /** Per-target migration-charge estimate, exactly as the deployed controller
   * keeps it: from each induce call's own readback, reset on a move. */
  const migrationCharge = new Map<string, number>();
  /** Attempts that open each host, resolved once per identity. */
  const crackCost = new Map<string, number | undefined>();

  let clock = 0;
  let nextMutationAt = mutationEveryMs;
  let nextPid = 1;
  let plantedPeak = 0;
  const debug = typeof process !== "undefined" && process.env["DNET_SPREAD_DEBUG"] === "1";
  let nextDebugAt = 0;
  const run: SpreadRun = {
    caseId: `spread:${netDepth}`,
    solved: false,
    startingCharisma: charisma,
    labRequiredCharisma: labGate,
    plantCalls: 0,
    bootstrapPlants: 0,
    attemptCalls: 0,
    reclaimCalls: 0,
    cacheCalls: 0,
    pinCalls: 0,
    crackedCount: 0,
    crackableCount: 0,
    plantedPeak: 0,
    mutations: 0,
    induceCalls: 0,
    induceWaves: 0,
    completedInduceWaves: 0,
    deeperInduceWaves: 0,
    usefulInduceWaves: 0,
    induceMoves: 0,
    induceDeletes: 0,
    occupiedRestarts: 0,
    restartImmediatelyVisible: 0,
    restartLost: 0,
    restartImmediateReplants: 0,
    restartLostSameTickReplants: 0,
    restartRecovered: 0,
    restartUnrecovered: 0,
    restartRecoveryMs: 0,
    restartMaxRecoveryMs: 0,
    restartLostGbMs: 0,
    hypotheticalRestartReserveGbMs: 0,
    linkedRam: [],
    elapsedMs: 0,
  };
  const induceWaves = new Map<string, { completed: boolean; deeper: boolean; useful: boolean }>();
  const restartOutages = new Map<string, RestartOutage>();
  let derivePassSequence = 0;

  /** The contiguous non-gap depth bands of this world, deepest first, for the
   * bands-reached milestone. */
  const bands: Array<{ lo: number; hi: number }> = [];
  for (let depth = 0; depth < netDepth; depth++) {
    if (isOnAirGap(depth)) continue;
    const held = bands[bands.length - 1];
    if (held !== undefined && held.hi === depth - 1) held.hi = depth;
    else bands.push({ lo: depth, hi: depth });
  }
  const bandsReached = new Set<number>();
  const noteBandsReached = (): void => {
    if (run.msToAllBandsReached !== undefined) return;
    for (const name of agents.keys()) {
      const depth = truth(name)?.depth;
      if (depth === undefined) continue;
      const index = bands.findIndex((band) => depth >= band.lo && depth <= band.hi);
      if (index >= 0) bandsReached.add(index);
    }
    if (bandsReached.size === bands.length) run.msToAllBandsReached = clock;
  };

  const maxRamOf = (name: string): number => world.servers.get(name)?.maxRam ?? 0;
  const truth = (name: string) => {
    const record = system.record(name);
    return record !== undefined && record.online ? record : undefined;
  };

  // What a JOB gets on this host: everything but the block and the prober's
  // reserve (plus the controller's own slice on darkweb). The job's per-thread
  // price already includes the resident's spawn-back.
  //
  // The reserve is not one number, and modelling it as one made every
  // stasis-linked host — the deepest and most valuable ones we hold — look
  // 1.3 GB poorer than it is. `proberReserveGb` mirrors production's own
  // branch: a linked host is exempt from the engine's restart and delete
  // guard, so it pays for no `exec` it could never need.
  const jobFreeGb = (name: string): number => {
    const record = truth(name);
    if (!record) return 0;
    const reserve = proberReserveGb(name) + (name === "darkweb" ? CONTROLLER_GB : 0);
    return Math.max(0, maxRamOf(name) - record.blockedRam - reserve);
  };

  /** Production's own two-branch prober reserve (`proberReserveGb`,
   *  controller.ts): a stasis-linked host drops `exec`, because the engine's
   *  mutation guard means it can never lose the processes `exec` would
   *  relaunch. */
  const proberReserveGb = (name: string): number =>
    stasisLinked.has(name) ? PROBER_STASIS_GB : PROBER_GB;

  const plantAgent = (name: string, agent: Agent): void => {
    agents.set(name, agent);
    const outage = restartOutages.get(name);
    if (outage === undefined) return;
    const recoveryMs = clock - outage.at;
    run.restartRecovered++;
    run.restartRecoveryMs += recoveryMs;
    run.restartMaxRecoveryMs = Math.max(run.restartMaxRecoveryMs, recoveryMs);
    run.restartLostGbMs += outage.usableGb * recoveryMs;
    if (recoveryMs === 0) {
      run.restartImmediateReplants++;
      if (!outage.immediatelyVisible) run.restartLostSameTickReplants++;
    }
    restartOutages.delete(name);
  };

  const observeHost = (name: string): ReportHost => {
    const record = truth(name);
    if (!record) return { hostname: name, at: clock, present: false };
    return {
      hostname: name,
      ...(world.servers.get(name)?.ip ? { identity: world.servers.get(name)!.ip } : {}),
      at: clock,
      present: true,
      depth: record.depth,
      blockedRam: record.blockedRam,
      maxRam: maxRamOf(name),
      difficulty: record.difficulty,
      isStationary: record.isStationary,
      modelId: record.modelId,
      passwordLength: record.passwordLength,
      passwordFormat: record.passwordFormat,
      passwordHint: record.passwordHint,
      data: record.data,
      requiredCharisma: record.requiredCharismaSkill,
      caches: [...system.cachesOn(name)],
      contracts: [],
      stormSeed: system.stormSeedOn(name),
    };
  };

  const expiry = (): ExpiryOpts => ({ netDepth, bitNode: 15, stasisLinked });

  const fold = (reports: ReportHost[]): void => {
    foldReports(knowledge, reports, clock, expiry());
  };
  const discover = (reports: ReportHost[]): void => {
    discoverReports(knowledge, reports, clock, expiry());
  };

  /** Probe from every standing host, then details for every name we know —
   * `getServerDetails` answers from any distance once a name is held, exactly
   * as the controller sweeps after `nextMutation`. */
  const observationSweep = (): void => {
    const reports: ReportHost[] = [];
    for (const name of [...agents.keys()]) {
      if (!truth(name)) {
        // The mutation ate the host, and every process on it.
        agents.delete(name);
        stasisLinked.delete(name);
        continue;
      }
      reports.push({ hostname: name, at: clock, present: true, neighbours: system.probeFrom(name) });
    }
    const known = new Set([...knowledge.keys(), ...reports.flatMap((r) => r.neighbours ?? [])]);
    for (const name of known) reports.push(observeHost(name));
    discover(reports);
  };

  const crackAttempts = (name: string): number | undefined => {
    if (!crackCost.has(name)) {
      const record = truth(name);
      crackCost.set(name, record ? crackAttemptsFor(record) : undefined);
    }
    return crackCost.get(name);
  };

  const milestone = (key: "msToFirstCrack" | "msToHalfCracked" | "msToLabSighted" | "msToLabVantageCracked" | "msToLabPinned" | "msToWalkerStart"): void => {
    if (run[key] === undefined) run[key] = clock;
  };

  const crackables = (): string[] => [...system.hosts.values()]
    .filter((host) => host.online && !host.isStationary && crackAttemptsFor(host) !== undefined)
    .map((host) => host.hostname);

  const onCracked = (name: string): void => {
    vault.add(name);
    milestone("msToFirstCrack");
    run.crackedCount = vault.size;
    if (vault.size * 2 >= crackables().length) milestone("msToHalfCracked");
    if (labVantage() === name || (labHost !== undefined && truth(name)?.hostname === labVantage())) {
      milestone("msToLabVantageCracked");
    }
  };

  /** The same projection the controller hands `planHold`: the shared core
   * from `holdHostFrom` plus the extras only the runtime knows. */
  const projectHoldHosts = (): HoldHost[] =>
    [...knowledge.values()].map((host) => {
      const view = planningView(host, clock, expiry());
      return {
        ...holdHostFrom(host, {
          at: clock,
          expiry: expiry(),
          agentAlive: agents.has(host.hostname) && agents.get(host.hostname)!.bootstrap !== true,
          hasCredential: vault.has(host.hostname),
          stasisLinked: stasisLinked.has(host.hostname),
        }),
        ...(view.blockedRam !== undefined ? { blockedRam: view.blockedRam } : {}),
        ...(view.difficulty !== undefined ? { difficulty: view.difficulty } : {}),
        ...(view.maxRam !== undefined ? { maxRam: view.maxRam } : {}),
        freeGb: jobFreeGb(host.hostname),
      };
    });

  /** The believed lab candidate, by the REAL `chooseLabVantage` — used only
   * for the crack milestone; the pin/walk decisions are `planHold`'s. */
  const labVantage = (): string | undefined => {
    if (labHost === undefined) return undefined;
    return chooseLabVantage(projectHoldHosts().filter((h) =>
      (h.agentAlive || h.stasisLinked === true)
      && h.neighbours?.includes(labHost) === true
      && h.hasCredential
      && truth(h.hostname) !== undefined), {
        charisma,
        walkGb: WALK_GB,
        reclaimGb: RECLAIM_GB,
      })?.hostname;
  };

  // --- one derive pass: plant, then file and assign -------------------------

  const derivePass = (): void => {
    const pass = derivePassSequence++;
    // Plants cascade: a plant probes, the probe reveals candidates. Loop to a
    // fixpoint with a hard stop far above any real chain.
    for (let round = 0; round < 32; round++) {
      const standing = new Set(["darkweb", ...agents.keys()]);
      const candidates = candidatesFrom(knowledge, clock, {
        standing,
        vault,
        // A pinned host is remotely reachable: `setStasisLink` installs a
        // backdoor beside the link, which is what lets the controller re-plant
        // (and release) a stasis host that mutations have orphaned.
        remoteExec: new Set(stasisLinked),
        remoteVantages: [...agents.keys()].map((host) => ({ host, freeGb: jobFreeGb(host) })),
        stasisLinked,
        expiry: expiry(),
      });
      const plan = planSpread(candidates, DEFAULT_SPREAD_LIMITS);
      let planted = 0;
      for (const plant of plan.plant) {
        if (agents.has(plant.host) || !truth(plant.host)) continue;
        plantAgent(plant.host, plant.bootstrapReclaim === true ? { bootstrap: true } : {});
        run.plantCalls++;
        if (plant.bootstrapReclaim === true) run.bootstrapPlants++;
        fold([
          observeHost(plant.host),
          { hostname: plant.host, at: clock, present: true, neighbours: system.probeFrom(plant.host) },
        ]);
        planted++;
      }
      plantedPeak = Math.max(plantedPeak, [...agents.keys()].filter((h) => !agents.get(h)!.bootstrap).length);
      if (planted > 0) noteBandsReached();
      if (planted === 0) break;
    }
    if (labHost !== undefined && knowledge.has(labHost)) milestone("msToLabSighted");

    // The REAL hold planner decides the pin, release, induced migrations, and
    // walk — the exact refusal checklist the controller runs.
    // Hosts one in-flight authenticate away from cracked, with the time left
    // on that call — the pre-charge pipeline's admission ticket.
    const aboutToCrack = new Map<string, number>();
    for (const agent of agents.values()) {
      const job = agent.job;
      if (!job || job.kind !== "attempt") continue;
      const needed = crackCost.get(job.target);
      if (needed === undefined) continue;
      if ((tried.get(job.target) ?? 0) === needed - 1) {
        aboutToCrack.set(job.target, Math.max(0, job.doneAt - clock));
      }
    }
    const holdPlan = planHold({
      hosts: projectHoldHosts(),
      netDepth,
      stasisLimit: system.stasisLinkLimit(),
      stasisLinkedCount: stasisLinked.size,
      labExpected: true,
      charisma,
      walkGb: WALK_GB,
      pinGb: PIN_GB,
      reclaimGb: RECLAIM_GB,
      induceGbPerThread: INDUCE_GB,
      migrationCharge,
      aboutToCrack,
    });
    const hold = holdPlan.tasks;
    if (debug && clock >= nextDebugAt) {
      nextDebugAt += 60_000;
      const kinds = hold.map((t) => `${t.kind}:${t.host}`).join(",");
      const refused = holdPlan.refused.map((r) => `${r.why}@${r.hostname}`).join(",");
      console.error(`[spread] t=${(clock / 60_000).toFixed(1)}m agents=${agents.size} vault=${vault.size} hold=[${kinds}] refused=[${refused}]`);
    }

    // The REAL farm ladder decides the grind (and the cache openings that
    // unblock it — planFarm's rungs are exclusive per host, so a cache task
    // must actually run or its host never reaches the reclaim rung). Phish
    // and promote are skipped at assignment: money is out of scope here.
    const farm: Array<NonNullable<DeriveOptions["farm"]>[number]> = [];
    const farmHosts: FarmHost[] = [];
    for (const [name, agent] of agents) {
      if (agent.bootstrap === true) {
        // The spawn-free reclaimer is not a resident and never reaches the
        // ladder: it grinds its own block outright, exactly as deployed.
        const record = truth(name);
        if (!record || record.blockedRam <= 0) continue;
        const room = Math.max(0, maxRamOf(name) - record.blockedRam);
        farm.push({
          kind: "reclaim",
          host: name,
          threads: Math.max(1, Math.floor(room / BOOTSTRAP_GB)),
          reason: "bootstrap: grind the owner block",
        });
        continue;
      }
      const view = planningView(knowledge.get(name) ?? { hostname: name, lastSeenAt: 0, seenAt: {}, dirty: {} }, clock, expiry());
      farmHosts.push({
        host: name,
        depth: view.depth,
        difficulty: view.difficulty,
        blockedRam: view.blockedRam,
        freeGb: jobFreeGb(name),
        caches: view.caches,
        isLab: false,
        busy: new Set(),
        neighbours: view.neighbours,
        hasCredential: vault.has(name),
      });
    }
    const farmPlan = planFarm(farmHosts, {
      now: clock,
      charisma,
      gbPerThread: { cache: CACHE_GB, reclaim: RECLAIM_GB, phish: PHISH_GB, promote: PROMOTE_GB },
      wantedGb: ATTEMPT_GB,
      openLabCache: false,
      ...(holdPlan.labCandidate !== undefined
        ? { walkerCandidate: holdPlan.labCandidate }
        : {}),
    });
    for (const task of farmPlan.tasks) {
      if (task.kind !== "reclaim" && task.kind !== "cache") continue;
      farm.push({
        kind: task.kind,
        host: task.host,
        ...(task.from !== undefined ? { from: task.from } : {}),
        threads: task.threads,
        ...(task.filename !== undefined ? { filename: task.filename } : {}),
        reason: task.reason,
        ...(task.gang === true ? { perVantage: true } : {}),
      });
    }

    const inFlight = new Map<string, { from: string; kind: Task["kind"] }[]>();
    for (const [name, agent] of agents) {
      const job = agent.job;
      if (job) {
        const claims = inFlight.get(job.target) ?? [];
        claims.push({ from: name, kind: job.kind === "unpin" ? "pin" : job.kind });
        inFlight.set(job.target, claims);
      }
    }

    const agentFreeGb = new Map<string, number>();
    for (const name of agents.keys()) agentFreeGb.set(name, jobFreeGb(name));

    const tasks = deriveTasks(knowledge, clock, {
      netDepth,
      bitNode: 15,
      stasisLinked,
      agents: new Set([...agents.keys()].filter((name) => !agents.get(name)!.bootstrap)),
      agentFreeGb,
      attemptGbPerThread: ATTEMPT_GB,
      vault,
      hold,
      farm,
      inFlight,
    });

    for (const task of [...tasks].sort((a, b) => a.priority - b.priority)) {
      const agent = agents.get(task.from);
      if (!agent) continue;
      // One whole-RAM job at a time: a busy vantage takes nothing more.
      if (agent.job) continue;
      if (agent.bootstrap && task.kind !== "reclaim") continue;
      if (task.kind === "attempt") {
        if (crackAttempts(task.host) === undefined || vault.has(task.host)) continue;
        const record = truth(task.host);
        if (!record) continue;
        const threads = Math.max(1, Math.floor(jobFreeGb(task.from) / ATTEMPT_GB));
        const wait = authenticateWaitMs(
          {
            modelId: record.modelId,
            difficulty: record.difficulty,
            depth: record.depth,
            requiredCharismaSkill: record.requiredCharismaSkill,
          },
          profile(),
          threads,
        );
        agent.job = { kind: "attempt", target: task.host, threads, doneAt: clock + wait };
      } else if (task.kind === "reclaim") {
        agent.job = {
          kind: "reclaim",
          target: task.host,
          threads: task.threads ?? 1,
          doneAt: clock + reclaimWaitMs(charisma),
        };
      } else if (task.kind === "cache") {
        if (task.filename === undefined) continue;
        agent.job = {
          kind: "cache",
          target: task.host,
          threads: 1,
          doneAt: clock + CACHE_OPEN_MS,
          filename: task.filename,
        };
      } else if (task.kind === "pin") {
        agent.job = {
          kind: task.unpin === true ? "unpin" : "pin",
          target: task.host,
          threads: 1,
          doneAt: clock + stasisWaitMs(charisma),
        };
      } else if (task.kind === "induce") {
        const induceWave = `${pass}:${task.host}`;
        if (!induceWaves.has(induceWave)) {
          induceWaves.set(induceWave, { completed: false, deeper: false, useful: false });
          run.induceWaves++;
        }
        agent.job = {
          kind: "induce",
          target: task.host,
          threads: task.threads ?? 1,
          doneAt: clock + INDUCE_WAIT_MS,
          induceWave,
        };
      } else if (task.kind === "walk") {
        // The walker CAN start: this lane's finish line. The walk itself is
        // lane 1's subject.
        milestone("msToWalkerStart");
        run.walkerThreads = task.threads ?? 1;
        run.walkerFrom = task.from;
        run.walkerTarget = task.host;
        run.solved = true;
      }
      // Inventory and bleed are observation mechanics already represented by
      // the arena's fold; phish and promote are money work and stay unassigned.
    }
  };

  const completeJob = (name: string, agent: Agent): void => {
    const job = agent.job!;
    agent.job = undefined;
    const record = truth(job.target);
    if (job.kind === "attempt") {
      run.attemptCalls++;
      if (!record) return;
      gainCharisma(attemptCharismaExp(record.difficulty, false, job.threads, false));
      const spent = (tried.get(job.target) ?? 0) + 1;
      tried.set(job.target, spent);
      const held = knowledge.get(job.target);
      if (held) held.attempts = { tried: spent, probes: 0 };
      const needed = crackAttempts(job.target);
      if (needed !== undefined && spent >= needed) {
        if (held) {
          held.credentialKnown = true;
          delete held.attempts;
        }
        // The successful authentication roots the host, which feeds the
        // engine's own instability curve (and mints the first-auth clue).
        system.addSession(job.target, nextPid++);
        onCracked(job.target);
      }
    } else if (job.kind === "reclaim") {
      run.reclaimCalls++;
      if (!record) return;
      const result = system.reallocateRam(job.target, job.threads, charisma, clock);
      if (result) {
        gainCharisma(result.charismaExp);
        fold([{ hostname: job.target, at: clock, present: true, blockedRam: result.blockedRam }]);
        if (result.cleared && agent.bootstrap) {
          // The spawn-free reclaimer's exit: the host is clear, a full plant
          // may now take it (after the cooldown, exactly as deployed).
          agents.delete(name);
        }
      }
    } else if (job.kind === "cache") {
      run.cacheCalls++;
      if (!record || job.filename === undefined) return;
      if (system.cachesOn(job.target).includes(job.filename)) {
        system.openCache(job.target, job.filename);
      }
      fold([observeHost(job.target)]);
    } else if (job.kind === "pin") {
      run.pinCalls++;
      // The deployed pin job probes before it links (`KIND_CALLS.pin` carries
      // `dnet.probe`): a stale believed edge refuses rather than spending the
      // scarce slot on a host the net has already walked away from.
      const edges = system.probeFrom(job.target);
      fold([{ hostname: job.target, at: clock, present: true, neighbours: edges }]);
      if (labHost !== undefined && edges.includes(labHost)) {
        const code = system.setStasisLink(job.target, true);
        if (code === 200) {
          stasisLinked.add(job.target);
          milestone("msToLabPinned");
        }
      }
      // The pin job carries no spawn budget: it ends with the host empty and
      // the spread re-plants it. Clearing the stamp is the controller's own
      // successful-pin rule.
      agents.delete(name);
    } else if (job.kind === "unpin") {
      system.setStasisLink(job.target, false);
      stasisLinked.delete(job.target);
      agents.delete(name);
    } else if (job.kind === "induce") {
      run.induceCalls++;
      const beforeDepth = record?.depth;
      const result = system.chargeMigration(job.target, job.threads, charisma);
      gainCharisma(result.charismaExp);
      const completed = result.newCharge >= 1;
      const wave = job.induceWave === undefined ? undefined : induceWaves.get(job.induceWave);
      if (completed && wave !== undefined && !wave.completed) {
        wave.completed = true;
        run.completedInduceWaves++;
      }
      if (result.deleted) {
        // A full destination band re-rolled the host out of existence.
        run.induceDeletes++;
        agents.delete(job.target);
        stasisLinked.delete(job.target);
        vault.delete(job.target);
        migrationCharge.delete(job.target);
        fold([{ hostname: job.target, at: clock, present: false }]);
        return;
      }
      // The charge estimate, from the same readback the deployed order
      // parses out of the engine's response. A landing resets it.
      migrationCharge.set(job.target, completed ? 0 : result.newCharge);
      const afterDepth = truth(job.target)?.depth;
      // A closed charge is not a relocation: `moveWithin` can re-place a host
      // inside its own row. `completedInduceWaves` already counts the closes,
      // so this stays the count of calls that actually moved the host.
      if (result.moved) run.induceMoves++;
      if (completed && beforeDepth !== undefined && afterDepth !== undefined && afterDepth > beforeDepth
        && wave !== undefined && !wave.deeper) {
        wave.deeper = true;
        run.deeperInduceWaves++;
      }
      // The deployed order learns only what a fresh details read shows.
      fold([observeHost(job.target)]);
      if (completed) {
        const bandsBefore = bandsReached.size;
        const labKnownBefore = labHost !== undefined && knowledge.has(labHost);
        // A move rewires the target: its own and its old neighbours' edges are
        // stale until the probers re-report. Mark topology dirty the honest
        // way — a fresh probe from every standing host.
        for (const standing of agents.keys()) {
          if (!truth(standing)) continue;
          fold([{ hostname: standing, at: clock, present: true, neighbours: system.probeFrom(standing) }]);
        }
        noteBandsReached();
        const madeProgress = bandsReached.size > bandsBefore
          || (!labKnownBefore && labHost !== undefined && knowledge.has(labHost));
        if (madeProgress && wave !== undefined && !wave.useful) {
          wave.useful = true;
          run.usefulInduceWaves++;
        }
      }
    }
  };

  // --- boot: the controller and first agent stand on darkweb -----------------
  agents.set("darkweb", {});
  discover([
    observeHost("darkweb"),
    { hostname: "darkweb", at: clock, present: true, neighbours: system.probeFrom("darkweb") },
  ]);
  observationSweep();

  while (clock < capMs && !run.solved) {
    derivePass();
    if (run.solved) break;
    let next = nextMutationAt;
    for (const agent of agents.values()) {
      if (agent.job && agent.job.doneAt < next) next = agent.job.doneAt;
    }
    const elapsed = next - clock;
    const vulnerableAgents = [...agents.keys()].filter((name) =>
      name !== "darkweb" && !stasisLinked.has(name) && truth(name) !== undefined).length;
    run.hypotheticalRestartReserveGbMs += 2 * vulnerableAgents * elapsed;
    clock = next;
    if (clock >= nextMutationAt) {
      const logRefs = new Map([...system.hosts].map(([name, host]) => [name, host.logs] as const));
      system.darknetProcess(mutationCycles);
      nextMutationAt += mutationEveryMs;
      run.mutations++;
      const restarted = [...system.hosts.values()]
        .filter((host) => logRefs.get(host.hostname) !== host.logs
          && host.logs[0]?.includes("Server restarting, terminating scripts"));
      const occupied = restarted.filter((host) => agents.has(host.hostname));
      for (const host of occupied) {
        restartOutages.set(host.hostname, { at: clock, usableGb: jobFreeGb(host.hostname), immediatelyVisible: false });
        agents.delete(host.hostname);
        run.occupiedRestarts++;
      }
      for (const host of occupied) {
        const immediatelyVisible = system.probeFrom(host.hostname)
          .some((neighbour) => agents.has(neighbour) && truth(neighbour) !== undefined);
        restartOutages.get(host.hostname)!.immediatelyVisible = immediatelyVisible;
        if (immediatelyVisible) run.restartImmediatelyVisible++;
        else run.restartLost++;
      }
      observationSweep();
      noteBandsReached();
    }
    for (const [name, agent] of agents) {
      if (agent.job && agent.job.doneAt <= clock) completeJob(name, agent);
    }
  }

  run.crackableCount = crackables().length + [...vault].filter((name) => !truth(name)).length;
  run.crackedCount = vault.size;
  run.plantedPeak = plantedPeak;
  run.linkedRam = [...stasisLinked].map((name) => maxRamOf(name)).sort((a, b) => b - a);
  run.elapsedMs = clock;
  for (const outage of restartOutages.values()) {
    const recoveryMs = clock - outage.at;
    run.restartLostGbMs += outage.usableGb * recoveryMs;
  }
  run.restartUnrecovered = restartOutages.size;
  if (!run.solved) run.reason = `walker not started within ${Math.round(capMs / 60_000)} minutes`;
  return run;
}

export interface SpreadSummary {
  cases: number;
  solved: number;
  meanMsToWalkerStart: number;
  /** Time after first seeing the lab spent cracking, planting, reclaiming,
   * pinning, and finally admitting the real walk task. */
  meanMsLabToWalkerStart: number;
  meanMsToFirstCrack: number;
  meanMsToHalfCracked: number;
  meanCracked: number;
  meanPlantedPeak: number;
}

export function summarizeSpreadRuns(runs: readonly SpreadRun[]): SpreadSummary {
  if (runs.length === 0) throw new Error("cannot summarize an empty spread run set");
  const meanOf = (values: readonly (number | undefined)[]): number => {
    const held = values.filter((v): v is number => v !== undefined);
    return held.length === 0 ? Infinity : held.reduce((sum, v) => sum + v, 0) / held.length;
  };
  return {
    cases: runs.length,
    solved: runs.filter((run) => run.solved).length,
    meanMsToWalkerStart: meanOf(runs.map((run) => run.msToWalkerStart)),
    meanMsLabToWalkerStart: meanOf(runs.map((run) =>
      run.msToWalkerStart !== undefined && run.msToLabSighted !== undefined
        ? run.msToWalkerStart - run.msToLabSighted
        : undefined)),
    meanMsToFirstCrack: meanOf(runs.map((run) => run.msToFirstCrack)),
    meanMsToHalfCracked: meanOf(runs.map((run) => run.msToHalfCracked)),
    meanCracked: meanOf(runs.map((run) => run.crackedCount)),
    meanPlantedPeak: meanOf(runs.map((run) => run.plantedPeak)),
  };
}
