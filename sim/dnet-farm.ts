import { attemptCharismaExp } from "./features/dnet.ts";
import {
  ATTEMPT_GB,
  CONTROLLER_GB,
  crackAttemptsFor,
  price,
  PROBER_GB,
  PROBER_STASIS_GB,
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
import { planFarm, type FarmHost } from "../shared/strategy/dnet/farm.ts";
import { planArmour, type ArmourCandidate } from "../shared/strategy/dnet/armour.ts";
import {
  authenticateWaitMs,
  isLabyrinth,
  mutationIntervalMs,
  phishWaitMs,
  reclaimWaitMs,
  STORM_COOLDOWN_MS,
  type DnetTimingProfile,
} from "../shared/strategy/dnet/rates.ts";
import { KIND_CALLS, PROBER_ARMOURED_GB, PROBER_GB as PRODUCTION_PROBER_GB } from "../game/dnet/shared.ts";

/** What one host's armour costs: the `spawn` chain and nothing else. */
const ARMOUR_GB = PROBER_ARMOURED_GB - PRODUCTION_PROBER_GB;


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

export interface FarmScenario {
  name: string;
  /** Fire the storm when `planStorm` admits it (shipped) or never. */
  stormEnabled: boolean;
  /** A walker is mid-walk on a pinned lab vantage (the shipped shape while the
   *  lab is unfinished). False models the post-lab net. */
  labPresent?: boolean;
  charisma?: number;
  /** Run `planArmour`, so the fleet wears the `spawn` chain that dodges
   * `restartServer` around a storm.
   *
   * `"off"` is the shipped fleet today and the honest baseline. `"firing"` arms
   * only once the storm is being fired or is already burning. `"ready"` also
   * arms while every gate but the phish window is green, buying lead time — more
   * of the fleet reaches an order boundary before the burst — at the cost of
   * wearing armour while nothing is happening.
   *
   * Only the storm rung can be exercised here: `planArmour`'s other rung is a
   * backdoor, and `#backdoored()` excludes stasis-linked hosts while a stasis
   * link is the only thing in either arena that sets `backdoorInstalled` — so
   * that pool is always empty. `tests/dnet-armour.test.ts` covers it. */
  armour?: "off" | "firing" | "ready";
}

export const SHIPPED_FARM: FarmScenario = { name: "shipped", stormEnabled: true, labPresent: true };

export interface FarmRun {
  caseId: string;
  policy: string;
  hours: number;
  warmupHours: number;
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
  /** File-listing jobs required by action invalidations and freshness. */
  inventoryCalls: number;
  /** Times the walker's host was found unpinned, offline, or targeted by farm
   *  work. The whole point of the storm gating is that this stays 0. */
  walkerInterruptions: number;
  walkerAttempts: number;
  /** Restarts that killed one of our residents. The storm's own mass restart
   *  (`restartAllDarknetServers`, every movable survivor at once) is the bulk
   *  of these, which is exactly why the lane could not price the storm honestly
   *  while it ignored them. */
  occupiedRestarts: number;
  /** Occupied restarts that arrived inside a storm burst. */
  stormRestarts: number;
  /** Restarted hosts whose armoured prober dodged the kill and re-planted in
   *  the same virtual instant. */
  restartsDodged: number;
  /** Restarted hosts that had to wait for a neighbour to replant them. */
  restartRecovered: number;
  restartUnrecovered: number;
  /** Usable resident capacity stranded while restarted hosts had no agent. */
  restartLostGbMs: number;
  /** What armour actually cost: 2 GB per armoured host per unit of time. */
  armourGbMs: number;
  /** Peak simultaneously-armoured hosts, for reading the policy's reach. */
  armourPeak: number;
}

interface Job {
  kind: "inventory" | "attempt" | "reclaim" | "phish" | "cache" | "storm";
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
  policy: FarmScenario,
  hours = DEFAULT_HOURS,
  warmupHours = 1,
): FarmRun {
  const { system, world } = net;
  const labPresent = policy.labPresent ?? true;
  const netDepth = system.netDepth();
  const mutationEveryMs = mutationIntervalMs(netDepth, 15);
  const mutationCycles = 150 / netDepth + 1;
  if (!Number.isFinite(hours) || hours <= 0) throw new Error(`hours must be positive, got ${hours}`);
  if (!Number.isFinite(warmupHours) || warmupHours < 0) {
    throw new Error(`warmupHours must be non-negative, got ${warmupHours}`);
  }
  const measurementStartsAt = warmupHours * 3_600_000;
  const capMs = (warmupHours + hours) * 3_600_000;
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
  /** Hosts whose prober carries the `spawn` chain right now. Membership costs
   *  `ARMOUR_GB` of job capacity and buys a same-instant recovery from a
   *  restart; `applyMutation` is the only reader that matters. */
  const armoured = new Set<string>();
  const agents = new Map<string, Agent>();
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
    warmupHours,
    moneyEarned: 0,
    moneyPerHour: 0,
    cachesOpened: 0,
    cachesPerHour: 0,
    phishCaches: 0,
    stormsFired: 0,
    seedsSighted: 0,
    crackedTotal: 0,
    inventoryCalls: 0,
    walkerInterruptions: 0,
    walkerAttempts: 0,
    occupiedRestarts: 0,
    stormRestarts: 0,
    restartsDodged: 0,
    restartRecovered: 0,
    restartUnrecovered: 0,
    restartLostGbMs: 0,
    armourGbMs: 0,
    armourPeak: 0,
  };

  const maxRamOf = (name: string): number => world.servers.get(name)?.maxRam ?? 0;
  const truth = (name: string) => {
    const record = system.record(name);
    return record !== undefined && record.online ? record : undefined;
  };
  const jobFreeGb = (name: string): number => {
    const record = truth(name);
    if (!record) return 0;
    const reserve = (stasisLinked.has(name) ? PROBER_STASIS_GB : PROBER_GB)
      + (armoured.has(name) ? ARMOUR_GB : 0)
      + (name === "darkweb" ? CONTROLLER_GB : 0);
    return Math.max(0, maxRamOf(name) - record.blockedRam - reserve);
  };
  const expiry = (): ExpiryOpts => ({ netDepth, bitNode: 15, stasisLinked });

  /** A host whose resident a restart killed, and when. Closed by the replant
   *  that puts an agent back on it. */
  const restartOutages = new Map<string, { at: number; usableGb: number }>();

  /** Put an agent on a host, closing any restart outage it was carrying.
   *
   * Every path that stands a resident goes through here, so the recovery
   * accounting cannot be forgotten by a new caller — the spread lane learned
   * that the same way. */
  /** Take a host's resident away.
   *
   * The armour set has to come with it. An armoured host that is restarted or
   * deleted keeps nothing standing, so leaving its name behind bills capacity
   * on a process that no longer exists — and because the arm/disarm pass walks
   * `agents`, a name that has left that map can never be released again. The
   * set grew monotonically and made a storm-only policy read like a blanket
   * fleet reserve. */
  const dropAgent = (name: string): void => {
    agents.delete(name);
    armoured.delete(name);
  };

  const plantAgent = (name: string, agent: Agent): void => {
    agents.set(name, agent);
    const outage = restartOutages.get(name);
    if (outage === undefined) return;
    const recoveryMs = clock - outage.at;
    run.restartRecovered++;
    run.restartLostGbMs += outage.usableGb * recoveryMs;
    restartOutages.delete(name);
  };


  const observeHost = (name: string, mode: "details" | "inventory" = "details"): ReportHost => {
    const withFiles = mode === "inventory";
    const record = truth(name);
    if (!record) {
      // A mutation ate the believed seed carrier: the seed is gone with it, so
      // clear the sighting or seed-hunting (and the seed count) stall forever.
      if (seedSighted && knowledge.get(name)?.stormSeed === true) seedSighted = false;
      return { hostname: name, at: clock, present: false };
    }
    const seed = withFiles && system.stormSeedOn(name);
    if (withFiles) {
      if (seed && !seedSighted) {
        seedSighted = true;
        run.seedsSighted++;
      }
      if (!seed && seedSighted && knowledge.get(name)?.stormSeed === true) seedSighted = false;
    }
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
      ...(withFiles ? {
        caches: [...system.cachesOn(name)],
        contracts: [],
        stormSeed: seed,
      } : {}),
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
      reports.push(observeHost(host.hostname, "inventory"));
      reports.push({ hostname: host.hostname, at: clock, present: true, neighbours: system.probeFrom(host.hostname) });
      if (!host.isStationary && crackAttemptsFor(host) !== undefined) vault.add(host.hostname);
    }
    reports.push(observeHost("darkweb", "inventory"));
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
        fold([observeHost(walkerHost, "inventory")]);
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
      fold([observeHost(name, "inventory")]);
      if (name === walkerHost) continue;
      if (!truth(name)) continue;
      if (maxRamOf(name) - truth(name)!.blockedRam < DEFAULT_SPREAD_LIMITS.agentRamGb) continue;
      plantAgent(name, {});
    }
    plantAgent("darkweb", {});
  }

  let moneyStart = world.player.money;

  let stormImminent = false;

  /** Move the fleet's armour toward what `planArmour` wants.
   *
   * Production can only resize a prober at an order boundary — the microtask
   * between one job dying and the next being dispatched — because that is the
   * only instant the host's RAM is free and nothing is interrupted. This lane
   * has the same constraint for the same reason, so a host with a job in the
   * air keeps whatever armour it already has and is revisited next derive.
   *
   * That partial coverage is not a defect of the policy, it is the policy: a
   * storm that finds half the fleet armoured still re-cascades from every
   * survivor, and each survivor's `exec` reaches its own neighbours. */
  const applyArmourPolicy = (): void => {
    if ((policy.armour ?? "off") === "off") return;
    const candidates: ArmourCandidate[] = [];
    for (const [name, agent] of agents) {
      if (agent.bootstrap || name === walkerHost || !truth(name)) continue;
      candidates.push({
        hostname: name,
        // What arming would have to come OUT of: the free capacity this host
        // has on top of the armour it is already wearing.
        usableGb: jobFreeGb(name) + (armoured.has(name) ? ARMOUR_GB : 0),
        proberStanding: true,
        stasisLinked: stasisLinked.has(name),
      });
    }
    const wanted = planArmour(candidates, { stormImminent, armourGb: ARMOUR_GB });
    for (const [name, agent] of agents) {
      // An order boundary only. A host mid-job is not resizable.
      if (agent.job !== undefined) continue;
      if (wanted.has(name)) armoured.add(name);
      else armoured.delete(name);
    }
    run.armourPeak = Math.max(run.armourPeak, armoured.size);
  };

  /** Advance the engine one mutation step and settle what it did to our
   * residents.
   *
   * A restart is the one mutation that leaves the HOST intact and takes only
   * what is standing on it, so nothing else in this lane notices it: `truth()`
   * still answers, the files are still there, and the agent map would happily
   * keep crediting work to a process the engine killed. That blind spot
   * flattered every storm number this lane has ever produced, because
   * `restartAllDarknetServers` kills the entire movable fleet at once and this
   * loop simply did not look.
   *
   * Detection is the spread lane's: the engine replaces `host.logs` wholesale
   * on a restart, so an identity change plus the restart banner is the fact.
   * Both the ordinary per-tick restarts and the storm's mass restart arrive
   * through `darknetProcess`, so one hook covers both. */
  const applyMutation = (): void => {
    const logRefs = new Map([...system.hosts].map(([name, host]) => [name, host.logs] as const));
    const inStorm = system.stormActive();
    system.darknetProcess(mutationCycles);
    const restarted = [...system.hosts.values()].filter((host) =>
      logRefs.get(host.hostname) !== host.logs
      && host.logs[0]?.includes("Server restarting, terminating scripts"));
    for (const host of restarted) {
      const name = host.hostname;
      const agent = agents.get(name);
      if (agent === undefined) continue;
      run.occupiedRestarts++;
      if (inStorm || system.stormActive()) run.stormRestarts++;
      // ARMOUR. The prober's delayed `spawn` lands after the whole restart
      // transaction, so the host still has the one process that can `exec`
      // locally and its resident is back in the same virtual instant. The
      // agent's own in-flight job is still lost — the armour saves the host's
      // ability to act, never the work that was in the air.
      if (armoured.has(name)) {
        run.restartsDodged++;
        agents.set(name, {});
        // The armour is SPENT. The successor spawns unarmoured, because no host
        // is restarted twice by one storm — `mutationLock` freezes the ordinary
        // clock and `restartAllDarknetServers` walks the fleet once — so a coat
        // kept on after the wave has passed is paid for nothing.
        armoured.delete(name);
        continue;
      }
      // Unarmoured: the host has nothing left standing and must wait for a
      // surviving neighbour to plant it again.
      restartOutages.set(name, { at: clock, usableGb: jobFreeGb(name) });
      dropAgent(name);
    }
  };

  const observationSweep = (): void => {
    const reports: ReportHost[] = [];
    for (const name of [...agents.keys()]) {
      if (!truth(name)) {
        dropAgent(name);
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
        remoteExec: new Set(stasisLinked),
        remoteVantages: [...agents.keys()].map((host) => ({ host, freeGb: jobFreeGb(host) })),
        stasisLinked,
        expiry: expiry(),
      });
      let planted = 0;
      for (const plant of planSpread(candidates, DEFAULT_SPREAD_LIMITS).plant) {
        if (plant.host === walkerHost || agents.has(plant.host) || !truth(plant.host)) continue;
        plantAgent(plant.host, plant.bootstrapReclaim === true ? { bootstrap: true } : {});
        fold([
          observeHost(plant.host),
          { hostname: plant.host, at: clock, present: true, neighbours: system.probeFrom(plant.host) },
        ]);
        planted++;
      }
      if (planted === 0) break;
    }

    // Production marks file facts dirty when an action may create a cache and
    // restores them through one same-turn inventory order. Do not let this
    // arena acquire `ls` knowledge for free in its mutation sweep.
    for (const [name, agent] of agents) {
      if (agent.job !== undefined || agent.bootstrap || !truth(name)) continue;
      const view = planningView(
        knowledge.get(name) ?? { hostname: name, lastSeenAt: 0, seenAt: {}, dirty: {} },
        clock,
        expiry(),
      );
      if (view.caches === undefined) {
        agent.job = { kind: "inventory", target: name, threads: 1, doneAt: clock };
        run.inventoryCalls++;
      }
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
      };
      const storm = planStorm(views, ctx);
      if (storm.fire) {
        hold.push({ kind: "storm", host: storm.fire.host, from: storm.fire.from, reason: storm.fire.reason });
      }
      stormImminent = storm.imminent
        || (policy.armour === "ready" && storm.awaitingPhishWindow === true);
    }
    applyArmourPolicy();

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
    if (job.kind === "inventory") {
      if (!record) return;
      fold([observeHost(job.target, "inventory")]);
    } else if (job.kind === "attempt") {
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
        fold([{ hostname: job.target, at: clock, present: true, invalidates: ["files"] }]);
      }
    } else if (job.kind === "reclaim") {
      if (!record) return;
      const result = system.reallocateRam(job.target, job.threads, charisma, clock);
      if (result) {
        gainCharisma(result.charismaExp);
        fold([{ hostname: job.target, at: clock, present: true, blockedRam: result.blockedRam }]);
        if (result.cleared) fold([{ hostname: job.target, at: clock, present: true, invalidates: ["files"] }]);
        if (result.cleared && agent.bootstrap) dropAgent(name);
      }
    } else if (job.kind === "phish") {
      if (!record) return;
      const result = system.phish(job.target, job.threads, charisma, clock);
      gainCharisma(result.charismaExp);
      if (result.success && result.message.includes("cache")) {
        lastPhishCacheAt = clock;
        run.phishCaches++;
        fold([{ hostname: job.target, at: clock, present: true, invalidates: ["files"] }]);
      }
    } else if (job.kind === "cache") {
      if (!record || job.filename === undefined) return;
      if (system.cachesOn(job.target).includes(job.filename)) {
        const result = system.openCache(job.target, job.filename);
        if (result.success) run.cachesOpened++;
      }
      fold([observeHost(job.target, "inventory")]);
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
  let measurementStarted = warmupHours === 0;

  const beginMeasurement = (): void => {
    measurementStarted = true;
    moneyStart = world.player.money;
    run.cachesOpened = 0;
    run.phishCaches = 0;
    run.stormsFired = 0;
    run.seedsSighted = 0;
    run.crackedTotal = 0;
    run.inventoryCalls = 0;
    run.walkerInterruptions = 0;
    run.walkerAttempts = 0;
    run.occupiedRestarts = 0;
    run.stormRestarts = 0;
    run.restartsDodged = 0;
    run.restartRecovered = 0;
    run.restartUnrecovered = 0;
    run.restartLostGbMs = 0;
    run.armourGbMs = 0;
    run.armourPeak = armoured.size;
    // An outage opened during the warmup would otherwise charge its warmup
    // milliseconds to the measured window when it finally recovers. Re-stamp
    // rather than discard: the host really is still down, and pretending it
    // recovered at the boundary would understate the cost.
    for (const outage of restartOutages.values()) outage.at = clock;
  };

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
    if (!measurementStarted) next = Math.min(next, measurementStartsAt);
    if (deriveDue) next = Math.min(next, lastDeriveAt + DERIVE_COALESCE_MS);
    for (const agent of agents.values()) {
      if (agent.job && agent.job.doneAt < next) next = agent.job.doneAt;
    }
    // What armour costs, integrated the way the spread lane integrates the
    // capacity a restart strands — so the two sides of the trade are measured
    // on the same clock and in the same unit.
    run.armourGbMs += ARMOUR_GB * armoured.size * (Math.min(next, capMs) - clock);
    clock = Math.min(next, capMs);
    if (clock >= capMs) break;
    // Keep the warmed world and RNG position, but measure only the steady
    // window. Events exactly on the boundary count, so reset before settling
    // walker, mutation, and job completions at this clock instant.
    if (!measurementStarted && clock >= measurementStartsAt) beginMeasurement();
    if (clock >= nextWalkerAttemptAt) {
      run.walkerAttempts++;
      nextWalkerAttemptAt = clock + walkerAuthMs();
    }
    if (clock >= nextMutationAt) {
      applyMutation();
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

  // Outages still open at the cap never recovered; charge their capacity to
  // the end of the run so an unrecovered host is not silently free.
  for (const outage of restartOutages.values()) {
    run.restartLostGbMs += outage.usableGb * (clock - outage.at);
  }
  run.restartUnrecovered = restartOutages.size;

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
  meanInventoryCallsPerHour: number;
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
    meanInventoryCallsPerHour: meanOf(runs.map((run) => run.inventoryCalls / run.hours)),
    totalWalkerInterruptions: runs.reduce((sum, run) => sum + run.walkerInterruptions, 0),
    meanWalkerAttempts: meanOf(runs.map((run) => run.walkerAttempts)),
  };
}
