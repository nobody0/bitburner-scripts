import type { SimServer } from "./core/effects.ts";
import { mockServer } from "./core/mocks.ts";
import { mulberry32 } from "./core/rng.ts";
import { attemptCharismaExp, DarknetSystem } from "./features/dnet.ts";
import { StockMarketSystem } from "./features/stock.ts";
import { ProcessTable } from "./ns/process.ts";
import { getFunctionRamCost } from "./ns/ram-costs.ts";
import { SimWorld } from "./world.ts";
import { expForSkill, skillFromExp } from "../shared/formulas.ts";
import type { ReportHost } from "../shared/strategy/dnet/courier.ts";
import { foldReports, type DnetHosts, type ExpiryOpts } from "../shared/strategy/dnet/host.ts";
import { modelEntry, type PasswordFacts } from "../shared/strategy/dnet/models.ts";
import {
  candidatesFrom,
  DEFAULT_SPREAD_LIMITS,
  deriveTasks,
  planSpread,
  type DeriveOptions,
  type SpreadLimits,
  type Task,
} from "../shared/strategy/dnet/plan.ts";
import {
  authenticateWaitMs,
  isLabyrinth,
  mutationIntervalMs,
  reclaimWaitMs,
  stasisWaitMs,
  type DnetTimingProfile,
} from "../shared/strategy/dnet/rates.ts";
import { solverFor } from "../shared/strategy/dnet/solvers/index.ts";
import { CONTROLLER_CALLS, KIND_CALLS, SCRIPT_BASE_GB } from "../game/dnet/shared.ts";

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
 *   — the worst case, which is deliberately conservative and identical across
 *   policy variants, so paired comparisons stay paired;
 * - a dictionary model is charged the true password's position in the same
 *   filtered candidate list `planAttempt` walks — exact, since the arena holds
 *   the generated password;
 * - a model neither can open is never cracked, exactly as deployed.
 *
 * Not modelled (documented, not forgotten): heartbleed/oracle feedback (which
 * would only SHORTEN solver conversations below their budget), induced
 * migration, backdoors, and money. The walk itself belongs to lane 1. */

// --- pricing, from the same table the game bills against ----------------------

export const price = (calls: readonly string[]): number => {
  let total = SCRIPT_BASE_GB;
  for (const call of new Set(calls)) total += getFunctionRamCost(call);
  return total;
};

export const PROBER_GB = price(["dnet.probe"]);
export const CONTROLLER_GB = price(CONTROLLER_CALLS);
export const ATTEMPT_GB = price(KIND_CALLS.attempt);
export const RECLAIM_GB = price(KIND_CALLS.reclaim);
export const BOOTSTRAP_GB = price(KIND_CALLS.bootstrapReclaim);
export const PIN_GB = price(KIND_CALLS.pin);
export const WALK_GB = price(KIND_CALLS.walk);
export const RESIDENT_GB = price(KIND_CALLS.idle);

// --- the world fixture --------------------------------------------------------

export interface SpreadNet {
  world: SimWorld;
  system: DarknetSystem;
  network: Map<string, string[]>;
}

/** The same minimal recipe the sim's own dnet tests use: BN15, full access, no
 * augmentations, darkweb pinned beside home. The farm lane opens caches, whose
 * reward table can draw a stock grant, so it asks for the market too. */
export function generateNet(seed: number, opts: { stock?: boolean } = {}): SpreadNet {
  const world = new SimWorld({ seed, bitnode: 15, network: [] });
  const servers = world.servers;
  const darkweb = mockServer({ hostname: "darkweb", maxRam: 16, hasAdminRights: true }) as SimServer;
  darkweb.simKind = "DarknetServer";
  servers.set("darkweb", darkweb);
  const network = new Map<string, string[]>([["home", ["darkweb"]], ["darkweb", ["home"]]]);
  const stock = opts.stock === true
    ? new StockMarketSystem(world, world.player, mulberry32(seed + 2), {
      hasWseAccount: true,
      hasTixApiAccess: true,
    })
    : undefined;
  const system = new DarknetSystem({
    servers,
    network,
    processes: new ProcessTable(servers, world.clock),
    generate: mulberry32(seed),
    random: mulberry32(seed + 1),
    bitNode: 15,
    fullAccess: () => true,
    hasProgram: () => true,
    installedAugmentations: () => new Set<string>(),
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

// --- policy -------------------------------------------------------------------

/** The dials a benchmark wiggles. Shipped values mirror the deployed
 * controller; every variant must keep the same world seed to stay paired. */
export interface SpreadPolicy {
  name: string;
  /** Fill the roomiest vantage with attempt threads (shipped) or send one. */
  threadScaledAttempts: boolean;
  /** Plant the minimal spawn-free reclaimer on cramped hosts (shipped) or wait
   *  for full agent room. */
  bootstrapReclaim: boolean;
  /** Grind every host's owner block down, not just the cramped ones (shipped:
   *  true — a cleared block is threads, and threads are crack speed). */
  eagerReclaim?: boolean;
  limits?: Partial<SpreadLimits>;
  /** Player charisma at case start. */
  charisma?: number;
}

export const SHIPPED_SPREAD: SpreadPolicy = {
  name: "shipped",
  threadScaledAttempts: true,
  bootstrapReclaim: true,
  eagerReclaim: true,
};

// --- run ----------------------------------------------------------------------

export interface SpreadRun {
  caseId: string;
  policy: string;
  /** The walker could start: lab vantage cracked, pinned, block at zero. */
  solved: boolean;
  msToFirstCrack?: number;
  msToHalfCracked?: number;
  msToLabSighted?: number;
  msToLabVantageCracked?: number;
  msToLabPinned?: number;
  msToWalkerStart?: number;
  walkerThreads?: number;
  crackedCount: number;
  crackableCount: number;
  plantedPeak: number;
  mutations: number;
  elapsedMs: number;
  reason?: string;
}

interface Job {
  kind: "attempt" | "reclaim" | "pin" | "unpin";
  target: string;
  threads: number;
  doneAt: number;
}

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
  policy: SpreadPolicy,
  capMs = DEFAULT_CAP_MS,
): SpreadRun {
  const { system, world } = net;
  const limits: SpreadLimits = { ...DEFAULT_SPREAD_LIMITS, ...policy.limits };
  const labHost = [...system.hosts.values()]
    .find((host) => isLabyrinth(host.hostname, host.modelId))?.hostname;
  const netDepth = system.netDepth();
  const mutationEveryMs = mutationIntervalMs(netDepth, 15);
  const mutationCycles = 150 / netDepth + 1;

  // One charisma pool, exactly as `labPlayer` keeps one for the lab arenas.
  const skillMult = 1;
  let charismaExp = expForSkill(policy.charisma ?? 60, skillMult);
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
  /** Conclusive attempts spent per host, the arena's own ledger. */
  const tried = new Map<string, number>();
  /** Attempts that open each host, resolved once per identity. */
  const crackCost = new Map<string, number | undefined>();

  let clock = 0;
  let nextMutationAt = mutationEveryMs;
  let nextPid = 1;
  let plantedPeak = 0;
  const run: SpreadRun = {
    caseId: `spread:${netDepth}`,
    policy: policy.name,
    solved: false,
    crackedCount: 0,
    crackableCount: 0,
    plantedPeak: 0,
    mutations: 0,
    elapsedMs: 0,
  };

  const maxRamOf = (name: string): number => world.servers.get(name)?.maxRam ?? 0;
  const truth = (name: string) => {
    const record = system.record(name);
    return record !== undefined && record.online ? record : undefined;
  };

  // What a JOB gets on this host: everything but the block and the prober's
  // fixed reserve (plus the controller's own slice on darkweb). The job's
  // per-thread price already includes the resident's spawn-back.
  const jobFreeGb = (name: string): number => {
    const record = truth(name);
    if (!record) return 0;
    const reserve = PROBER_GB + (name === "darkweb" ? CONTROLLER_GB : 0);
    return Math.max(0, maxRamOf(name) - record.blockedRam - reserve);
  };

  const observeHost = (name: string): ReportHost => {
    const record = truth(name);
    if (!record) return { hostname: name, at: clock, present: false };
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
      stormSeed: system.stormSeedOn(name),
    };
  };

  const expiry = (): ExpiryOpts => ({ netDepth, bitNode: 15, stasisLinked });

  const fold = (reports: ReportHost[]): void => {
    foldReports(knowledge, reports, clock, expiry());
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
    fold(reports);
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

  /** The lab candidate: a cracked host we can see standing next to the lab —
   * an already-linked one first (commitment, `chooseLabVantage`'s own rule),
   * then biggest RAM. */
  const labVantage = (): string | undefined => {
    if (labHost === undefined) return undefined;
    const adjacent = [...knowledge.values()]
      .filter((host) => host.goneAt === undefined
        && host.neighbours?.includes(labHost) === true
        && vault.has(host.hostname)
        && truth(host.hostname) !== undefined);
    if (adjacent.length === 0) return undefined;
    const linkBias = (name: string): number => (stasisLinked.has(name) ? 1 : 0);
    return [...adjacent].sort((a, b) =>
      linkBias(b.hostname) - linkBias(a.hostname)
      || maxRamOf(b.hostname) - maxRamOf(a.hostname)
      || (a.hostname < b.hostname ? -1 : 1))[0]!.hostname;
  };

  // --- one derive pass: plant, then file and assign -------------------------

  const derivePass = (): void => {
    // Plants cascade: a plant probes, the probe reveals candidates. Loop to a
    // fixpoint with a hard stop far above any real chain.
    for (let round = 0; round < 32; round++) {
      const standing = new Set(["darkweb", ...agents.keys()]);
      const candidates = candidatesFrom(knowledge, clock, {
        standing,
        vault,
        lastPlantAt,
        // A pinned host is remotely reachable: `setStasisLink` installs a
        // backdoor beside the link, which is what lets the controller re-plant
        // (and release) a stasis host that mutations have orphaned.
        remoteExec: new Set(stasisLinked),
        remoteVantages: [...agents.keys()].map((host) => ({ host, freeGb: jobFreeGb(host) })),
        expiry: expiry(),
      });
      const plan = planSpread(candidates, limits, clock);
      let planted = 0;
      for (const plant of plan.plant) {
        if (agents.has(plant.host) || !truth(plant.host)) continue;
        if (plant.bootstrapReclaim === true && !policy.bootstrapReclaim) continue;
        agents.set(plant.host, plant.bootstrapReclaim === true ? { bootstrap: true } : {});
        lastPlantAt.set(plant.host, clock);
        fold([
          observeHost(plant.host),
          { hostname: plant.host, at: clock, present: true, neighbours: system.probeFrom(plant.host) },
        ]);
        planted++;
      }
      plantedPeak = Math.max(plantedPeak, [...agents.keys()].filter((h) => !agents.get(h)!.bootstrap).length);
      if (planted === 0) break;
    }
    if (labHost !== undefined && knowledge.has(labHost)) milestone("msToLabSighted");

    // The arena's hold policy is a deliberate stand-in for `hold.ts`'s
    // `planWalk`/`admitPins` (this lane predates their extraction and does not
    // model their full refusal checklist): pin the lab vantage, grind its
    // block, start the walker when both are done.
    const vantage = labVantage();
    const hold: Array<NonNullable<DeriveOptions["hold"]>[number]> = [];
    // Release a link whose lab edge is gone: with one slot, a mispin held
    // forever is a permanent stall. The deployed planner's release rule —
    // "the walker evicts anything" — needs an agent standing on the host,
    // which the remote re-plant above provides.
    for (const linked of stasisLinked) {
      if (linked === vantage) continue;
      if (agents.get(linked) === undefined || agents.get(linked)!.job !== undefined) continue;
      hold.push({ kind: "pin", host: linked, from: linked, unpin: true, reason: "release a mispinned link" });
    }
    if (vantage !== undefined) {
      const record = truth(vantage);
      if (record !== undefined && !stasisLinked.has(vantage)
        && maxRamOf(vantage) - record.blockedRam >= PIN_GB) {
        hold.push({ kind: "pin", host: vantage, from: vantage, edge: labHost!, reason: "pin the lab vantage" });
      }
      if (stasisLinked.has(vantage) && record !== undefined && record.blockedRam <= 0
        && agents.has(vantage)) {
        hold.push({
          kind: "walk",
          host: labHost!,
          from: vantage,
          threads: Math.max(1, Math.floor(maxRamOf(vantage) / WALK_GB)),
          reason: "walk the labyrinth",
        });
      }
    }

    const farm: Array<NonNullable<DeriveOptions["farm"]>[number]> = [];
    for (const [name, agent] of agents) {
      const record = truth(name);
      if (!record || record.blockedRam <= 0) continue;
      const wantsGrind = agent.bootstrap === true
        || name === vantage
        || policy.eagerReclaim === true
        || jobFreeGb(name) < ATTEMPT_GB;
      if (!wantsGrind) continue;
      const perThread = agent.bootstrap === true ? BOOTSTRAP_GB : RECLAIM_GB;
      const room = agent.bootstrap === true
        ? Math.max(0, maxRamOf(name) - record.blockedRam)
        : jobFreeGb(name);
      const threads = Math.max(1, Math.floor(room / perThread));
      farm.push({ kind: "reclaim", host: name, threads, reason: "grind the owner block" });
    }

    const inFlight = new Map<string, { from: string; kind: Task["kind"] }[]>();
    for (const [name, agent] of agents) {
      if (!agent.job) continue;
      const claims = inFlight.get(agent.job.target) ?? [];
      claims.push({ from: name, kind: agent.job.kind === "unpin" ? "pin" : agent.job.kind });
      inFlight.set(agent.job.target, claims);
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
      if (!agent || agent.job) continue;
      if (agent.bootstrap && task.kind !== "reclaim") continue;
      if (task.kind === "attempt") {
        if (crackAttempts(task.host) === undefined || vault.has(task.host)) continue;
        const record = truth(task.host);
        if (!record) continue;
        const threads = policy.threadScaledAttempts
          ? Math.max(1, Math.floor(jobFreeGb(task.from) / ATTEMPT_GB))
          : 1;
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
      } else if (task.kind === "pin") {
        agent.job = {
          kind: task.unpin === true ? "unpin" : "pin",
          target: task.host,
          threads: 1,
          doneAt: clock + stasisWaitMs(charisma),
        };
      } else if (task.kind === "walk") {
        // The walker CAN start: this lane's finish line. The walk itself is
        // lane 1's subject.
        milestone("msToWalkerStart");
        run.walkerThreads = task.threads ?? 1;
        run.solved = true;
      }
      // Everything else (inventory, bleed, cache, phish, promote, induce) is
      // out of this lane's scope and deliberately unassigned.
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
    } else if (job.kind === "pin") {
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
      lastPlantAt.delete(job.target);
    } else if (job.kind === "unpin") {
      system.setStasisLink(job.target, false);
      stasisLinked.delete(job.target);
      agents.delete(name);
      lastPlantAt.delete(job.target);
    }
  };

  // --- boot: the controller and first agent stand on darkweb -----------------
  agents.set("darkweb", {});
  fold([
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
    clock = next;
    if (clock >= nextMutationAt) {
      system.darknetProcess(mutationCycles);
      nextMutationAt += mutationEveryMs;
      run.mutations++;
      observationSweep();
    }
    for (const [name, agent] of agents) {
      if (agent.job && agent.job.doneAt <= clock) completeJob(name, agent);
    }
  }

  run.crackableCount = crackables().length + [...vault].filter((name) => !truth(name)).length;
  run.crackedCount = vault.size;
  run.plantedPeak = plantedPeak;
  run.elapsedMs = clock;
  if (!run.solved) run.reason = `walker not started within ${Math.round(capMs / 60_000)} minutes`;
  return run;
}

export interface SpreadSummary {
  policy: string;
  cases: number;
  solved: number;
  meanMsToWalkerStart: number;
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
    policy: runs[0]!.policy,
    cases: runs.length,
    solved: runs.filter((run) => run.solved).length,
    meanMsToWalkerStart: meanOf(runs.map((run) => run.msToWalkerStart)),
    meanMsToFirstCrack: meanOf(runs.map((run) => run.msToFirstCrack)),
    meanMsToHalfCracked: meanOf(runs.map((run) => run.msToHalfCracked)),
    meanCracked: meanOf(runs.map((run) => run.crackedCount)),
    meanPlantedPeak: meanOf(runs.map((run) => run.plantedPeak)),
  };
}
