import { attemptCharismaExp } from "./features/dnet.ts";
import {
  ATTEMPT_GB,
  CONTROLLER_GB,
  crackAttemptsFor,
  price,
  PROBER_GB,
  RECLAIM_GB,
  WALK_GB,
  type SpreadNet,
} from "./dnet-spread.ts";
import { expForSkill, skillFromExp } from "../shared/formulas.ts";
import type { ReportHost } from "../shared/strategy/dnet/courier.ts";
import {
  foldReports,
  planningView,
  stormWipe,
  type DnetHost,
  type DnetHosts,
  type ExpiryOpts,
} from "../shared/strategy/dnet/host.ts";
import {
  candidatesFrom,
  DEFAULT_SPREAD_LIMITS,
  deriveTasks,
  planSpread,
  planStorm,
  type DeriveOptions,
  type StormContext,
  type Task,
} from "../shared/strategy/dnet/plan.ts";
import { planFarm, type FarmHost, type HunterElection } from "../shared/strategy/dnet/farm.ts";
import {
  authenticateWaitMs,
  isLabyrinth,
  mutationIntervalMs,
  phishWaitMs,
  reclaimWaitMs,
  STORM_COOLDOWN_MS,
  type DnetTimingProfile,
} from "../shared/strategy/dnet/rates.ts";
import { KIND_CALLS } from "../game/dnet/shared.ts";

/** Earn-in-a-full-net arena: an established darknet — spread done, lab vantage
 * pinned, a walker mid-walk — mining caches and money over hours of virtual
 * time. This is the lane for the question neither other lane can ask: what is
 * the STORM worth, in caches per hour, and does chasing it ever disturb the
 * walker?
 *
 * The real planners run (`planFarm`, `planStorm`, and the spread/attempt pair
 * for post-storm reconquest) against the real `DarknetSystem` — its cache
 * drops, the one net-wide `.d.cache` window, the 15% seed roll on a cleared
 * block, and the six-phase storm burst are all the engine's own. Execution is
 * abstracted to the transcribed `rates.ts` waits, exactly as in the spread
 * lane. Promote is deliberately absent (no market here), and the walker is a
 * fixed metronome on its pinned host: the lane measures whether anything ever
 * interrupts it, not how fast it walks — that is lane 1's subject. */

const PHISH_GB = price(KIND_CALLS.phish);
const CACHE_GB = price(KIND_CALLS.cache);
const PROMOTE_GB = price(KIND_CALLS.promote);

export interface FarmPolicy {
  name: string;
  /** Fire the storm when `planStorm` admits it (shipped) or never. */
  stormEnabled: boolean;
  /** A walker is mid-walk on a pinned lab vantage (the shipped shape while the
   *  lab is unfinished). False models the post-lab net. */
  labPresent?: boolean;
  charisma?: number;
  /** `FarmInputs.hunterElection` — which sort elects the cache hunter. */
  hunterElection?: HunterElection;
  /** `FarmInputs.clearBudgetMs` — the grind-for-the-cache wall-clock budget. */
  clearBudgetMs?: number;
  /** `StormContext.phishOverlapMs` — gate 7's fire window. */
  phishOverlapMs?: number;
}

export const SHIPPED_FARM: FarmPolicy = { name: "shipped", stormEnabled: true, labPresent: true };

export interface FarmRun {
  caseId: string;
  policy: string;
  hours: number;
  moneyEarned: number;
  moneyPerHour: number;
  /** Caches opened, all sources: phish `.d.cache`, block-clear rewards, and
   *  whatever the storm's reconquest mints. */
  cachesOpened: number;
  cachesPerHour: number;
  phishCaches: number;
  stormsFired: number;
  seedsSighted: number;
  crackedTotal: number;
  /** Times the walker's host was found unpinned, offline, or targeted by farm
   *  work. The whole point of the storm gating is that this stays 0. */
  walkerInterruptions: number;
  walkerAttempts: number;
}

interface Job {
  kind: "attempt" | "reclaim" | "phish" | "cache" | "storm";
  target: string;
  threads: number;
  doneAt: number;
  filename?: string;
}

interface Agent {
  job?: Job;
  bootstrap?: boolean;
}

const DEFAULT_HOURS = 3;
const CACHE_OPEN_MS = 200;
const STORM_FIRE_MS = 1_000;

export function runFarmCase(
  net: SpreadNet,
  policy: FarmPolicy,
  hours = DEFAULT_HOURS,
): FarmRun {
  const { system, world } = net;
  const labPresent = policy.labPresent ?? true;
  const netDepth = system.netDepth();
  const mutationEveryMs = mutationIntervalMs(netDepth, 15);
  const mutationCycles = 150 / netDepth + 1;
  const capMs = hours * 3_600_000;
  const labHost = [...system.hosts.values()]
    .find((host) => isLabyrinth(host.hostname, host.modelId))?.hostname;

  const skillMult = 1;
  let charismaExp = expForSkill(policy.charisma ?? 150, skillMult);
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
  const lastPlantAt = new Map<string, number>();
  const tried = new Map<string, number>();
  const crackCost = new Map<string, number | undefined>();

  let clock = 0;
  let nextMutationAt = mutationEveryMs;
  let nextPid = 1;
  let lastPhishCacheAt: number | undefined;
  let lastStormFiredAt: number | undefined;
  let seedSighted = false;

  const run: FarmRun = {
    caseId: `farm:${netDepth}`,
    policy: policy.name,
    hours,
    moneyEarned: 0,
    moneyPerHour: 0,
    cachesOpened: 0,
    cachesPerHour: 0,
    phishCaches: 0,
    stormsFired: 0,
    seedsSighted: 0,
    crackedTotal: 0,
    walkerInterruptions: 0,
    walkerAttempts: 0,
  };

  const maxRamOf = (name: string): number => world.servers.get(name)?.maxRam ?? 0;
  const truth = (name: string) => {
    const record = system.record(name);
    return record !== undefined && record.online ? record : undefined;
  };
  const jobFreeGb = (name: string): number => {
    const record = truth(name);
    if (!record) return 0;
    const reserve = PROBER_GB + (name === "darkweb" ? CONTROLLER_GB : 0);
    return Math.max(0, maxRamOf(name) - record.blockedRam - reserve);
  };
  const expiry = (): ExpiryOpts => ({ netDepth, bitNode: 15, stasisLinked });

  const observeHost = (name: string): ReportHost => {
    const record = truth(name);
    if (!record) {
      // A mutation ate the believed seed carrier: the seed is gone with it, so
      // clear the sighting or seed-hunting (and the seed count) stall forever.
      if (seedSighted && knowledge.get(name)?.stormSeed === true) seedSighted = false;
      return { hostname: name, at: clock, present: false };
    }
    const seed = system.stormSeedOn(name);
    if (seed && !seedSighted) {
      seedSighted = true;
      run.seedsSighted++;
    }
    if (!seed && seedSighted && knowledge.get(name)?.stormSeed === true) seedSighted = false;
    return {
      hostname: name,
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
      stormSeed: seed,
    };
  };
  const fold = (reports: ReportHost[]): void => {
    foldReports(knowledge, reports, clock, expiry());
  };

  // --- the walker: a fixed metronome on a pinned vantage --------------------

  let walkerHost: string | undefined;
  let walkerThreads = 1;
  let nextWalkerAttemptAt = Infinity;

  const walkerAuthMs = (): number => {
    const lab = labHost !== undefined ? system.record(labHost) : undefined;
    if (!lab) return 850;
    return authenticateWaitMs(
      { modelId: lab.modelId, difficulty: lab.difficulty, depth: lab.depth, requiredCharismaSkill: lab.requiredCharismaSkill },
      profile(),
      walkerThreads,
    );
  };

  // --- established-net setup -------------------------------------------------

  const crackAttempts = (name: string): number | undefined => {
    if (!crackCost.has(name)) {
      const record = truth(name);
      crackCost.set(name, record ? crackAttemptsFor(record) : undefined);
    }
    return crackCost.get(name);
  };

  {
    // Spread already happened: every crackable host is in the vault with an
    // agent standing on it (walker host excepted), and the whole map is known.
    const reports: ReportHost[] = [];
    for (const host of [...system.hosts.values()]) {
      if (!host.online) continue;
      reports.push(observeHost(host.hostname));
      reports.push({ hostname: host.hostname, at: clock, present: true, neighbours: system.probeFrom(host.hostname) });
      if (!host.isStationary && crackAttemptsFor(host) !== undefined) vault.add(host.hostname);
    }
    reports.push(observeHost("darkweb"));
    reports.push({ hostname: "darkweb", at: clock, present: true, neighbours: system.probeFrom("darkweb") });
    fold(reports);

    if (labPresent && labHost !== undefined) {
      // The lab vantage was pinned and fully harvested before the walker took
      // the host — the deployed precondition (`planWalk` refuses until the
      // block is zero and the caches are cleared).
      const vantage = [...system.hosts.values()]
        .filter((host) => host.online && !host.isStationary
          && system.probeFrom(host.hostname).includes(labHost)
          && vault.has(host.hostname))
        .sort((a, b) => maxRamOf(b.hostname) - maxRamOf(a.hostname)
          || (a.hostname < b.hostname ? -1 : 1))[0];
      if (vantage) {
        walkerHost = vantage.hostname;
        system.setStasisLink(walkerHost, true);
        stasisLinked.add(walkerHost);
        const server = world.servers.get(walkerHost);
        if (server) server.ramUsed = Math.max(0, server.ramUsed - vantage.blockedRam);
        vantage.blockedRam = 0;
        for (const filename of [...system.cachesOn(walkerHost)]) {
          system.openCache(walkerHost, filename);
        }
        fold([observeHost(walkerHost)]);
        walkerThreads = Math.max(1, Math.floor(maxRamOf(walkerHost) / WALK_GB));
        nextWalkerAttemptAt = walkerAuthMs();
      }
    }
    if (!labPresent) {
      // The post-lab shape has already spent its links — that is `planStorm`'s
      // gate 5 (`links-unspent`), and a lab-less arm with no links could never
      // fire a storm and would measure nothing. Deepest and biggest first,
      // the same order the spare planner claims its targets.
      const limit = system.stasisLinkLimit();
      const linkable = [...system.hosts.values()]
        .filter((host) => host.online && !host.isStationary && vault.has(host.hostname))
        .sort((a, b) => b.depth - a.depth
          || maxRamOf(b.hostname) - maxRamOf(a.hostname)
          || (a.hostname < b.hostname ? -1 : 1));
      for (const host of linkable) {
        if (stasisLinked.size >= limit) break;
        if (system.setStasisLink(host.hostname, true) === 200) stasisLinked.add(host.hostname);
      }
    }

    for (const name of vault) {
      // Spread's endgame already rooted these; the first-auth caches that
      // rooting minted are opened silently here — an established net has
      // harvested its history, and counting it would gift both A/B arms the
      // same free spike.
      system.addSession(name, nextPid++);
      for (const filename of [...system.cachesOn(name)]) system.openCache(name, filename);
      fold([observeHost(name)]);
      if (name === walkerHost) continue;
      if (!truth(name)) continue;
      if (maxRamOf(name) - truth(name)!.blockedRam < DEFAULT_SPREAD_LIMITS.agentRamGb) continue;
      agents.set(name, {});
      lastPlantAt.set(name, clock);
    }
    agents.set("darkweb", {});
  }

  const moneyStart = world.player.money;

  const observationSweep = (): void => {
    const reports: ReportHost[] = [];
    for (const name of [...agents.keys()]) {
      if (!truth(name)) {
        agents.delete(name);
        continue;
      }
      reports.push({ hostname: name, at: clock, present: true, neighbours: system.probeFrom(name) });
    }
    if (walkerHost !== undefined) {
      const pinned = system.record(walkerHost)?.stasisLinked === true && truth(walkerHost) !== undefined;
      if (!pinned) run.walkerInterruptions++;
    }
    const known = new Set([...knowledge.keys(), ...reports.flatMap((r) => r.neighbours ?? [])]);
    for (const name of known) reports.push(observeHost(name));
    fold(reports);
  };

  // --- one derive pass -------------------------------------------------------

  const derivePass = (): void => {
    // Reconquest: post-storm hosts get planted and cracked the same way the
    // spread lane does it.
    for (let round = 0; round < 32; round++) {
      const standing = new Set(["darkweb", ...agents.keys()]);
      const candidates = candidatesFrom(knowledge, clock, {
        standing,
        vault,
        lastPlantAt,
        remoteExec: new Set(stasisLinked),
        remoteVantages: [...agents.keys()].map((host) => ({ host, freeGb: jobFreeGb(host) })),
        stasisLinked,
        expiry: expiry(),
      });
      let planted = 0;
      for (const plant of planSpread(candidates, DEFAULT_SPREAD_LIMITS, clock).plant) {
        if (plant.host === walkerHost || agents.has(plant.host) || !truth(plant.host)) continue;
        agents.set(plant.host, plant.bootstrapReclaim === true ? { bootstrap: true } : {});
        lastPlantAt.set(plant.host, clock);
        fold([
          observeHost(plant.host),
          { hostname: plant.host, at: clock, present: true, neighbours: system.probeFrom(plant.host) },
        ]);
        planted++;
      }
      if (planted === 0) break;
    }

    const inFlight = new Map<string, { from: string; kind: Task["kind"] }[]>();
    const busyByHost = new Map<string, Set<string>>();
    for (const [name, agent] of agents) {
      if (!agent.job) continue;
      const claims = inFlight.get(agent.job.target) ?? [];
      claims.push({ from: name, kind: agent.job.kind as Task["kind"] });
      inFlight.set(agent.job.target, claims);
      const busy = busyByHost.get(agent.job.target) ?? new Set<string>();
      busy.add(agent.job.kind);
      busyByHost.set(agent.job.target, busy);
    }

    // The farm ladder, over every staffed host but the walker's.
    const farmHosts: FarmHost[] = [];
    for (const [name, agent] of agents) {
      if (agent.bootstrap || name === walkerHost) continue;
      const view = planningView(knowledge.get(name) ?? { hostname: name, lastSeenAt: 0, seenAt: {}, dirty: {} }, clock, expiry());
      farmHosts.push({
        host: name,
        depth: view.depth,
        difficulty: view.difficulty,
        blockedRam: view.blockedRam,
        freeGb: jobFreeGb(name),
        caches: view.caches,
        isLab: false,
        busy: (busyByHost.get(name) ?? new Set()) as ReadonlySet<"cache" | "reclaim" | "phish" | "promote">,
        neighbours: view.neighbours,
        hasCredential: vault.has(name),
      });
    }
    const seedHunt = !seedSighted
      && (lastStormFiredAt === undefined || clock - lastStormFiredAt > STORM_COOLDOWN_MS);
    const farmPlan = planFarm(farmHosts, {
      now: clock,
      charisma,
      gbPerThread: { cache: CACHE_GB, reclaim: RECLAIM_GB, phish: PHISH_GB, promote: PROMOTE_GB },
      wantedGb: ATTEMPT_GB,
      lastPhishCacheAt,
      openLabCache: false,
      seedHunt,
      ...(policy.hunterElection !== undefined ? { hunterElection: policy.hunterElection } : {}),
      ...(policy.clearBudgetMs !== undefined ? { clearBudgetMs: policy.clearBudgetMs } : {}),
    });

    // The storm, through its own gates.
    const hold: Array<NonNullable<DeriveOptions["hold"]>[number]> = [];
    if (policy.stormEnabled) {
      const views: DnetHost[] = [];
      for (const host of knowledge.values()) {
        const view = planningView(host, clock, expiry());
        view.agentAlive = agents.has(host.hostname) && !agents.get(host.hostname)!.bootstrap;
        view.busy = busyByHost.get(host.hostname) ?? new Set();
        views.push(view);
      }
      const ctx: StormContext = {
        now: clock,
        vault,
        stasisLinked,
        stasisLimit: system.stasisLinkLimit(),
        stasisLinkedCount: stasisLinked.size,
        pinsPending: false,
        walkInFlight: labPresent && walkerHost !== undefined,
        walkerPinned: true,
        labWalked: !labPresent,
        ...(lastPhishCacheAt !== undefined ? { lastPhishCacheAt } : {}),
        ...(lastStormFiredAt !== undefined ? { lastStormFiredAt } : {}),
        // Same-plan agreement, as the controller wires it: blocks the farm
        // refused on budget do not hold the fire.
        budgetRefusedBlocks: new Set(
          farmPlan.refused.filter((r) => r.why === "reclaim-not-needed").map((r) => r.host),
        ),
        ...(policy.phishOverlapMs !== undefined ? { phishOverlapMs: policy.phishOverlapMs } : {}),
      };
      const storm = planStorm(views, ctx);
      if (storm.fire) {
        hold.push({ kind: "storm", host: storm.fire.host, from: storm.fire.from, reason: storm.fire.reason });
      }
    }

    const agentFreeGb = new Map<string, number>();
    for (const name of agents.keys()) agentFreeGb.set(name, jobFreeGb(name));

    const tasks = deriveTasks(knowledge, clock, {
      netDepth,
      bitNode: 15,
      stasisLinked,
      agents: new Set([...agents.keys()].filter((name) => !agents.get(name)!.bootstrap && name !== walkerHost)),
      agentFreeGb,
      attemptGbPerThread: ATTEMPT_GB,
      vault,
      hold,
      farm: farmPlan.tasks.map((task) => ({
        kind: task.kind,
        host: task.host,
        ...(task.from !== undefined ? { from: task.from } : {}),
        threads: task.threads,
        ...(task.filename !== undefined ? { filename: task.filename } : {}),
        reason: task.reason,
      })),
      inFlight,
    });

    for (const task of [...tasks].sort((a, b) => a.priority - b.priority)) {
      const agent = agents.get(task.from);
      if (!agent || agent.job) continue;
      if (task.from === walkerHost
        || (task.host === walkerHost && ["reclaim", "plant", "pin", "attempt", "cache"].includes(task.kind))) {
        // Nothing may RUN on the walker's host, and nothing may touch its RAM
        // or session from outside. A task that would actually do either is the
        // disturbance this lane exists to catch; a neighbour merely READING it
        // (a heartbleed, a survey) costs the walk nothing.
        run.walkerInterruptions++;
        continue;
      }
      if (agent.bootstrap && task.kind !== "reclaim") continue;
      if (task.kind === "attempt") {
        if (crackAttempts(task.host) === undefined || vault.has(task.host)) continue;
        const record = truth(task.host);
        if (!record) continue;
        const threads = Math.max(1, Math.floor(jobFreeGb(task.from) / ATTEMPT_GB));
        const wait = authenticateWaitMs(
          { modelId: record.modelId, difficulty: record.difficulty, depth: record.depth, requiredCharismaSkill: record.requiredCharismaSkill },
          profile(),
          threads,
        );
        agent.job = { kind: "attempt", target: task.host, threads, doneAt: clock + wait };
      } else if (task.kind === "reclaim") {
        agent.job = { kind: "reclaim", target: task.host, threads: task.threads ?? 1, doneAt: clock + reclaimWaitMs(charisma) };
      } else if (task.kind === "phish") {
        agent.job = { kind: "phish", target: task.host, threads: task.threads ?? 1, doneAt: clock + phishWaitMs(charisma) };
      } else if (task.kind === "cache") {
        if (task.filename === undefined) continue;
        agent.job = { kind: "cache", target: task.host, threads: 1, doneAt: clock + CACHE_OPEN_MS, filename: task.filename };
      } else if (task.kind === "storm") {
        agent.job = { kind: "storm", target: task.host, threads: 1, doneAt: clock + STORM_FIRE_MS };
      }
    }
  };

  const completeJob = (name: string, agent: Agent): void => {
    const job = agent.job!;
    agent.job = undefined;
    const record = truth(job.target);
    if (job.kind === "attempt") {
      if (!record) return;
      gainCharisma(attemptCharismaExp(record.difficulty, false, job.threads, false));
      const spent = (tried.get(job.target) ?? 0) + 1;
      tried.set(job.target, spent);
      const needed = crackAttempts(job.target);
      if (needed !== undefined && spent >= needed) {
        vault.add(job.target);
        run.crackedTotal++;
        const held = knowledge.get(job.target);
        if (held) held.credentialKnown = true;
        // The successful authentication that ends a crack roots the host: the
        // engine mints a clue and rolls the first-auth cache there.
        system.addSession(job.target, nextPid++);
        fold([observeHost(job.target)]);
      }
    } else if (job.kind === "reclaim") {
      if (!record) return;
      const result = system.reallocateRam(job.target, job.threads, charisma, clock);
      if (result) {
        gainCharisma(result.charismaExp);
        fold([{ hostname: job.target, at: clock, present: true, blockedRam: result.blockedRam }]);
        if (result.cleared) {
          fold([observeHost(job.target)]);
        }
        if (result.cleared && agent.bootstrap) agents.delete(name);
      }
    } else if (job.kind === "phish") {
      if (!record) return;
      const result = system.phish(job.target, job.threads, charisma, clock);
      gainCharisma(result.charismaExp);
      if (result.success && result.message.includes("cache")) {
        lastPhishCacheAt = clock;
        run.phishCaches++;
        fold([observeHost(job.target)]);
      }
    } else if (job.kind === "cache") {
      if (!record || job.filename === undefined) return;
      if (system.cachesOn(job.target).includes(job.filename)) {
        const result = system.openCache(job.target, job.filename);
        if (result.success) run.cachesOpened++;
      }
      fold([observeHost(job.target)]);
    } else if (job.kind === "storm") {
      const result = system.unleashStormSeed(job.target, clock);
      if (result.success) {
        run.stormsFired++;
        lastStormFiredAt = clock;
        seedSighted = false;
        // The controller's own storm rule: everything a reroll can touch is
        // wiped the moment the burst is believed to begin.
        const wiped = stormWipe(knowledge, expiry());
        knowledge.clear();
        for (const [key, value] of wiped) knowledge.set(key, value);
      }
    }
  };

  observationSweep();

  // Derives are event-driven AND coalesced, the way the real controller
  // batches its wakes: every completion and mutation due at one clock instant
  // settles first (the microtask flush), then ONE planner pass serves the
  // whole batch, and a quiet net never wakes the planner at all. The window
  // is virtual idle an agent may sit between jobs — small against
  // multi-second waits, and what keeps a three-hour case affordable.
  const DERIVE_COALESCE_MS = 500;
  let lastDeriveAt = -Infinity;
  let deriveDue = true;
  const debug = typeof process !== "undefined" && process.env["DNET_FARM_DEBUG"] === "1";
  let iterations = 0;
  let derives = 0;
  let nextDebugAt = 10 * 60_000;
  const wallStart = Date.now();

  while (clock < capMs) {
    iterations++;
    if (debug && (clock >= nextDebugAt || iterations % 200_000 === 0)) {
      if (clock >= nextDebugAt) nextDebugAt += 10 * 60_000;
      const busy = [...agents.values()].filter((a) => a.job !== undefined);
      const soonest = Math.min(...busy.map((a) => a.job!.doneAt));
      console.error(`[farm] t=${(clock / 60_000).toFixed(1)}m wall=${((Date.now() - wallStart) / 1000).toFixed(1)}s iter=${iterations} derives=${derives} agents=${agents.size} busy=${busy.length} clock=${clock} mutAt=${nextMutationAt} walkAt=${nextWalkerAttemptAt} deriveDue=${deriveDue} lastDerive=${lastDeriveAt} soonestJob=${soonest}`);
    }
    // `clock >= lastDeriveAt + MS`, spelled EXACTLY like the wake target below:
    // `clock - lastDeriveAt >= MS` can be false by one ulp at the very instant
    // the loop woke to run this derive, which is a spin, not a wait.
    if (deriveDue && clock >= lastDeriveAt + DERIVE_COALESCE_MS) {
      derivePass();
      derives++;
      lastDeriveAt = clock;
      deriveDue = false;
    }
    let next = Math.min(nextMutationAt, nextWalkerAttemptAt);
    if (deriveDue) next = Math.min(next, lastDeriveAt + DERIVE_COALESCE_MS);
    for (const agent of agents.values()) {
      if (agent.job && agent.job.doneAt < next) next = agent.job.doneAt;
    }
    clock = Math.min(next, capMs);
    if (clock >= capMs) break;
    if (clock >= nextWalkerAttemptAt) {
      run.walkerAttempts++;
      nextWalkerAttemptAt = clock + walkerAuthMs();
    }
    if (clock >= nextMutationAt) {
      system.darknetProcess(mutationCycles);
      nextMutationAt += mutationEveryMs;
      observationSweep();
      deriveDue = true;
    }
    for (const [name, agent] of agents) {
      if (agent.job && agent.job.doneAt <= clock) {
        completeJob(name, agent);
        deriveDue = true;
      }
    }
  }

  run.moneyEarned = world.player.money - moneyStart;
  run.moneyPerHour = run.moneyEarned / hours;
  run.cachesPerHour = run.cachesOpened / hours;
  return run;
}

export interface FarmSummary {
  policy: string;
  cases: number;
  meanCachesPerHour: number;
  meanMoneyPerHour: number;
  meanPhishCaches: number;
  meanStormsFired: number;
  totalWalkerInterruptions: number;
  meanWalkerAttempts: number;
}

export function summarizeFarmRuns(runs: readonly FarmRun[]): FarmSummary {
  if (runs.length === 0) throw new Error("cannot summarize an empty farm run set");
  const meanOf = (values: readonly number[]): number =>
    values.reduce((sum, v) => sum + v, 0) / values.length;
  return {
    policy: runs[0]!.policy,
    cases: runs.length,
    meanCachesPerHour: meanOf(runs.map((run) => run.cachesPerHour)),
    meanMoneyPerHour: meanOf(runs.map((run) => run.moneyPerHour)),
    meanPhishCaches: meanOf(runs.map((run) => run.phishCaches)),
    meanStormsFired: meanOf(runs.map((run) => run.stormsFired)),
    totalWalkerInterruptions: runs.reduce((sum, run) => sum + run.walkerInterruptions, 0),
    meanWalkerAttempts: meanOf(runs.map((run) => run.walkerAttempts)),
  };
}
