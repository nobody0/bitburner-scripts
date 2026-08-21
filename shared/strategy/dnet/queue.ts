import { expiryMs, fresh, type DarknetKnowledge, type DarknetHostKnowledge } from "./knowledge.ts";
import { modelEntry, planAttempt } from "./models.ts";

/** What there is to do out there, and who is doing it.
 *
 * The controller does not keep a task list. It DERIVES one, and that is the
 * whole of the dedup.
 *
 * **The queue is DERIVED from knowledge, never appended to.** There is no
 * "add task" call anywhere. `deriveTasks` looks at what we believe and emits
 * only the work that belief does not already cover: a survey for a host whose
 * neighbour list has expired, an attempt for a host whose model has something
 * left to try, a plant for a host the spread planner admits. A fact that is
 * still believable produces no task at all.
 *
 * That is what makes dedup structural rather than bookkeeping. Nothing can
 * duplicate a survey, because once the first one lands the fact is fresh and the
 * task stops existing — no completion message, no acknowledgement, nothing to
 * get out of sync. It also self-heals: a job that dies mid-task leaves the fact
 * stale, so the task simply reappears on the next derivation.
 *
 * There is deliberately no claim or lease protocol here. An earlier design had
 * one, for workers that polled a coordinator; the controller now owns a queue
 * per host and hands each job to the one resident standing there, so there is
 * nothing for two processes to race over. */

export type TaskKind = "survey" | "bleed" | "attempt" | "plant";

export interface Task {
  id: string;
  kind: TaskKind;
  /** The target. */
  host: string;
  /** Where a process must be STANDING to do it. probe, authenticate and
   *  heartbleed all require a direct connection, so the vantage is part of the
   *  task rather than a detail of whoever runs it — and it is what decides which
   *  host's queue the job is filed against. */
  from: string;
  /** Lower is more urgent. */
  priority: number;
  /** Why this task exists, in one line, for the panel and the failure line. */
  reason: string;
}

export interface DeriveOptions {
  netDepth?: number;
  bitNode?: number;
  backdoored?: number;
  /** Hosts with a live agent, so we do not survey what is already being watched
   *  and do not plant where someone is standing. */
  agents?: ReadonlySet<string>;
  /** Hosts we hold a credential for. */
  vault?: ReadonlySet<string>;
  /** Hosts admitted by `planSpread`, already filtered and ordered. */
  plantable?: readonly { host: string; from: string }[];
  /** How many deliberate probes an unsolved model may cost, per host. */
  probeLimit?: number;
}

/** Where a process would have to stand to reach `host`: any neighbour of it we
 * have a resident on. Returns undefined when there is no vantage, which is itself
 * the answer — the host is a rumour until someone stands next to it. */
function vantageFor(
  host: DarknetHostKnowledge,
  knowledge: DarknetKnowledge,
  now: number,
  opts: DeriveOptions,
): string | undefined {
  const agents = opts.agents ?? new Set<string>();
  if (agents.has(host.hostname)) return host.hostname;
  const expiry = { netDepth: opts.netDepth, bitNode: opts.bitNode, backdoored: opts.backdoored };
  for (const agentHost of agents) {
    const standing = knowledge.hosts[agentHost];
    if (!standing) continue;
    const neighbours = fresh<string[]>(standing, "neighbours", now, expiry);
    if (neighbours?.includes(host.hostname)) return agentHost;
  }
  return undefined;
}

/** Everything worth doing, given what we believe right now.
 *
 * Deterministic and ordered, so two derivations of the same knowledge produce
 * the same queue. */
export function deriveTasks(
  knowledge: DarknetKnowledge,
  now: number,
  opts: DeriveOptions = {},
): Task[] {
  const expiry = { netDepth: opts.netDepth, bitNode: opts.bitNode, backdoored: opts.backdoored };
  const agents = opts.agents ?? new Set<string>();
  const vault = opts.vault ?? new Set<string>();
  const tasks: Task[] = [];

  for (const host of Object.values(knowledge.hosts)) {
    if (host.goneAt !== undefined) continue;
    const from = vantageFor(host, knowledge, now, opts);
    if (from === undefined) continue;

    const depth = fresh<number>(host, "depth", now, expiry) ?? 99;

    // SURVEY: only when the adjacency we hold has stopped being believable.
    // While it is fresh there is nothing to learn, so there is no task, so two
    // workers cannot both go and learn it.
    if (fresh<string[]>(host, "neighbours", now, expiry) === undefined) {
      tasks.push({
        id: `survey:${host.hostname}`,
        kind: "survey",
        host: host.hostname,
        from,
        priority: depth,
        reason: host.facts["neighbours"] ? "adjacency expired" : "never surveyed",
      });
    }

    // ATTEMPT: only for a host we cannot already open, and only while its model
    // has something left to try.
    if (!vault.has(host.hostname) && host.hostname !== "darkweb") {
      const modelId = fresh<string>(host, "modelId", now, expiry);
      const entry = modelEntry(modelId);
      const ledger = host.attempts;
      const attempt = planAttempt(
        entry,
        {
          ...(fresh<number>(host, "passwordLength", now, expiry) !== undefined
            ? { passwordLength: fresh<number>(host, "passwordLength", now, expiry)! }
            : {}),
          ...(fresh<string>(host, "passwordFormat", now, expiry) !== undefined
            ? { passwordFormat: fresh<string>(host, "passwordFormat", now, expiry)! }
            : {}),
        },
        ledger?.tried ?? 0,
        ledger?.probes ?? 0,
        opts.probeLimit ?? 1,
      );
      if (attempt.kind !== "none" && modelId !== undefined) {
        tasks.push({
          id: `attempt:${host.hostname}`,
          kind: "attempt",
          host: host.hostname,
          from,
          // An implemented model is a handful of calls away from a new vantage;
          // a probe only buys information. Prefer the one that opens the net.
          priority: depth + (attempt.kind === "candidate" ? 0 : 50),
          reason: attempt.kind === "candidate"
            ? `${entry?.name ?? modelId} candidate ${attempt.index + 1}/${attempt.total}`
            : attempt.reason,
        });
      }
    }

    // BLEED: a host we can already open is still worth listening to, because its
    // logs leak its NEIGHBOURS' passwords. That is the cheapest credential in
    // the game and it owes nothing to any minigame.
    if (agents.has(host.hostname) || vault.has(host.hostname)) {
      const bled = host.facts["lastBleedAt"]?.at ?? 0;
      if (now - bled > expiryMs("topology", expiry)) {
        tasks.push({
          id: `bleed:${host.hostname}`,
          kind: "bleed",
          host: host.hostname,
          from,
          priority: depth + 10,
          reason: "logs leak neighbour credentials",
        });
      }
    }
  }

  // PLANT: whatever the spread planner already admitted. It has its own bounds
  // and its own refusals; the queue does not second-guess them.
  for (const entry of opts.plantable ?? []) {
    if (agents.has(entry.host)) continue;
    tasks.push({
      id: `plant:${entry.host}`,
      kind: "plant",
      host: entry.host,
      from: entry.from,
      // Placing a process is the scarcest thing we do — it is the only action
      // that grows the set of places we can act FROM — so it outranks everything.
      priority: -100,
      reason: "a credential and room for an agent",
    });
  }

  tasks.sort((a, b) => a.priority - b.priority || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return tasks;
}
