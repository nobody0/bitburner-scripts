import { describe, expect, test } from "bun:test";
import { classifyPlantRoute, DEFAULT_SPREAD_LIMITS, allocateCredentialChecks, candidatesFrom, deriveTasks, planSpread, type RefusalReason, type SpreadCandidate } from "../shared/strategy/dnet/plan.ts";
import { choosePreemptionVantage } from "../shared/strategy/dnet/priority.ts";
import { foldReports, type DnetHosts } from "../shared/strategy/dnet/host.ts";
import type { ReportHost } from "../shared/strategy/dnet/courier.ts";
import { msPerHostEvent } from "../shared/strategy/dnet/rates.ts";

const NOW = 10_000_000;

function candidate(over: Partial<SpreadCandidate> & { host: string }): SpreadCandidate {
  return { from: "darkweb", hasCredential: true, agentAlive: false, usableRam: 16, depth: 0, ...over };
}

/** The fixtures read better with the facts grouped, so they are flattened into
 *  the `ReportHost` the fold takes here rather than at every call site. */
type Seen = { hostname: string; present: boolean; facts?: Record<string, unknown> };

function reports(hosts: Seen[], at = NOW): ReportHost[] {
  return hosts.map((host) => ({
    hostname: host.hostname,
    at,
    present: host.present,
    ...(host.present ? host.facts : {}),
  } as ReportHost));
}

function fold(hosts: Seen[], at = NOW): DnetHosts {
  const knowledge: DnetHosts = new Map();
  foldReports(knowledge, reports(hosts, at), at);
  return knowledge;
}

describe("every refusal to spread is named", () => {
  /** A planner that silently skipped a host would make four independent limits
   * invisible at once. When the net stops growing, these strings are the answer
   * to "why" — so each is asserted individually rather than as "not planted". */

  test.each([
    ["gone", { host: "dead", goneAt: NOW - 1, usableRam: 0, hasCredential: false }, []],
    ["no-credential", { host: "locked", hasCredential: false }, ["attempt, not a plant"]],
    ["unknown-ram", { host: "unknown", usableRam: undefined }, []],
    ["not-enough-ram", { host: "blocked", usableRam: 1 }, ["1.00GB usable", "memoryReallocation"]],
  ] satisfies readonly [RefusalReason, Partial<SpreadCandidate> & { host: string }, readonly string[]][])(
    "%s is reported with its actionable diagnostic",
    (why, input, details) => {
      const plan = planSpread([candidate(input)], DEFAULT_SPREAD_LIMITS, NOW);
      expect(plan.plant).toEqual([]);
      expect(plan.refused[0]!.why).toBe(why);
      for (const detail of details) expect(plan.refused[0]!.detail).toContain(detail);
    },
  );

  test("an ordinary cramped blocked host is refused, not bootstrapped", () => {
    // The bootstrap used to plant here too; the deep-world benchmark priced
    // ordinary bootstraps at 1.26x walker-start on the two-gap world (CI
    // excluding zero) and a pure tie shallow — the reclaimer is reserved for
    // the lab candidate, whose block gates the whole walk.
    const plan = planSpread([
      candidate({ host: "blocked", usableRam: 5.3, blockedRam: 10 }),
    ], DEFAULT_SPREAD_LIMITS, NOW);
    expect(plan.plant).toEqual([]);
    expect(plan.refused[0]?.why).toBe("not-enough-ram");
  });

  test("a stasis-managed target is priced at managed resident + prober, not the full agent", () => {
    // The exact band the observed prober-only orphan lived in: 3.5GB usable
    // fits the spawn-free managed resident (1.6) beside the prober (1.8), but
    // the flat 5.4GB unmanaged bar refused it forever — the stasis link's
    // whole point is that its host never needs the spawn safety net.
    const managed = planSpread([
      candidate({ host: "pinned", usableRam: 3.5, blockedRam: 10, stasisManaged: true }),
    ], DEFAULT_SPREAD_LIMITS, NOW);
    expect(managed.plant.map((p) => p.host)).toEqual(["pinned"]);
    const ordinary = planSpread([
      candidate({ host: "plain", usableRam: 3.5, blockedRam: 10 }),
    ], DEFAULT_SPREAD_LIMITS, NOW);
    expect(ordinary.plant).toEqual([]);
    expect(ordinary.refused[0]?.why).toBe("not-enough-ram");
  });

  test("an ordinary host that fits the resident and prober uses the normal plant", () => {
    const plan = planSpread([
      candidate({ host: "roomy", usableRam: 5.4, blockedRam: 10 }),
    ], DEFAULT_SPREAD_LIMITS, NOW);
    expect(plan.plant[0]?.bootstrapReclaim).toBeUndefined();
  });

  test("a pinned lab candidate reclaims without a prober even when a resident would fit", () => {
    const plan = planSpread([
      candidate({ host: "walker", usableRam: 12, blockedRam: 4, reclaimOnly: true, omitProber: true }),
    ], DEFAULT_SPREAD_LIMITS, NOW);
    expect(plan.plant[0]).toEqual(expect.objectContaining({
      bootstrapReclaim: true,
      bootstrapThreads: 4,
      omitProber: true,
    }));
  });

  test("a host that was planted and is empty again is replanted AT ONCE", () => {
    // There is no hold for having been planted. That was justified as anti-flap
    // for a host stuck restarting, which the game does not produce — a restart
    // is a per-mutation roll across the whole net, and the right answer to one
    // is to replant immediately. What it actually did was exile every host
    // that emptied for an ordinary reason: a managed stasis handoff, a kind
    // that hands its host back, an agent chaining out of its last order.
    const emptied = candidate({ host: "replant-me" });
    expect(planSpread([emptied], DEFAULT_SPREAD_LIMITS, NOW).plant.map((p) => p.host))
      .toEqual(["replant-me"]);
    expect(planSpread([emptied], DEFAULT_SPREAD_LIMITS, NOW).refused).toEqual([]);
  });

  test("nothing is refused for being far away, or for being the third one", () => {
    // The three invented budgets are GONE — hop budget, per-source fan-out and
    // global agent cap — and with them their refusal names. Every neighbour we
    // can reach gets an agent, at any depth, unconditionally. A refusal that can
    // never fire tells the panel reader a limit is in force when it is not, so
    // this asserts the deletion rather than an unused name.
    const deep = planSpread([candidate({ host: "deep", depth: 39 })], DEFAULT_SPREAD_LIMITS, NOW);
    expect(deep.plant.map((entry) => entry.host)).toEqual(["deep"]);
    expect(deep.refused).toEqual([]);

    // One source host places as many as it has candidates. How many actually
    // FIT is a queue-depth fact, enforced by the controller's
    // MAX_QUEUED_PER_HOST, not a spreading policy.
    const many = Array.from({ length: 5 }, (_, i) => candidate({ host: `n${i}`, from: "darkweb" }));
    const fanned = planSpread(many, DEFAULT_SPREAD_LIMITS, NOW);
    expect(fanned.plant).toHaveLength(5);
    expect(fanned.refused).toEqual([]);

    // ...and there is no total either, however many are already live.
    const spread = Array.from({ length: 40 }, (_, i) => candidate({ host: `n${i}`, from: `src${i}` }));
    expect(planSpread(spread, DEFAULT_SPREAD_LIMITS, NOW).plant).toHaveLength(40);
  });

  test("every surviving refusal is a fact about the host in front of us", () => {
    // The ones that are left, as a set. This is what makes the deletions above
    // durable: a budget re-introduced as a refusal name shows up here. Note
    // what is NOT here — there is no refusal for having been planted before.
    const named = new Set<string>();
    for (const plan of [
      planSpread([candidate({ host: "a", goneAt: NOW - 1 })], DEFAULT_SPREAD_LIMITS, NOW),
      planSpread([candidate({ host: "b", agentAlive: true })], DEFAULT_SPREAD_LIMITS, NOW),
      planSpread([candidate({ host: "c", hasCredential: false })], DEFAULT_SPREAD_LIMITS, NOW),
      planSpread([candidate({ host: "d", usableRam: undefined })], DEFAULT_SPREAD_LIMITS, NOW),
      planSpread([candidate({ host: "e", usableRam: 0.5 })], DEFAULT_SPREAD_LIMITS, NOW),
    ]) {
      for (const refusal of plan.refused) named.add(refusal.why);
    }
    expect([...named].sort()).toEqual([
      "agent-alive",
      "gone",
      "no-credential",
      "not-enough-ram",
      "unknown-ram",
    ]);
  });

  test("a plant that failed to launch is re-derived at once, never held off", () => {
    // There is NO hold. Root, a credential and no agent is the whole rule, and
    // a failed launch does not subtract from it: the next pass plants again.
    // A hold here only ever meant "a real bug is now invisible for N seconds".
    const failed = candidate({ host: "refused-me" });
    expect(planSpread([failed], DEFAULT_SPREAD_LIMITS, NOW).plant).toHaveLength(1);
    expect(planSpread([failed], DEFAULT_SPREAD_LIMITS, NOW + 1).plant).toHaveLength(1);
  });

  test("an agent already standing there is not replaced", () => {
    const plan = planSpread([candidate({ host: "occupied", agentAlive: true })], DEFAULT_SPREAD_LIMITS, NOW);
    expect(plan.refused[0]!.why).toBe("agent-alive");
  });
});

describe("spreading prefers the deep and the roomy, deterministically", () => {
  test("deepest first, then most room, then by name", () => {
    // Inverted deliberately. Shallow-first was argued from "a shallow host is
    // the cheapest place to stand", which only held while depth was also a
    // BOUND. Now that we take every host, the order answers a different
    // question: which do we want first when the net rearranges under us? The
    // deep one — it is the only route to anything deeper, its facts expire
    // fastest, and a shallow host is reachable again in a moment from anywhere.
    const plan = planSpread(
      [
        candidate({ host: "shallow", depth: 0, from: "a" }),
        candidate({ host: "deep-small", depth: 3, usableRam: 4, from: "b" }),
        candidate({ host: "deep-big", depth: 3, usableRam: 32, from: "c" }),
      ],
      DEFAULT_SPREAD_LIMITS,
      NOW,
    );
    expect(plan.plant.map((entry) => entry.host)).toEqual(["deep-big", "shallow"]);
  });

  test("a host we cannot place sorts after every host we can", () => {
    // Unplaceable depth means unsurveyed, and preferring it would spend the
    // scarce plant on the candidate we know least about.
    const plan = planSpread(
      [
        candidate({ host: "nowhere", depth: undefined, from: "a" }),
        candidate({ host: "shallow", depth: 0, from: "b" }),
        candidate({ host: "deep", depth: 7, from: "c" }),
      ],
      DEFAULT_SPREAD_LIMITS,
      NOW,
    );
    expect(plan.plant.map((entry) => entry.host)).toEqual(["deep", "shallow", "nowhere"]);
  });

  test("the same input plans the same way regardless of arrival order", () => {
    const hosts = [
      candidate({ host: "b", from: "x" }),
      candidate({ host: "a", from: "y" }),
      candidate({ host: "c", from: "z" }),
    ];
    const forward = planSpread(hosts, DEFAULT_SPREAD_LIMITS, NOW).plant.map((h) => h.host);
    const backward = planSpread([...hosts].reverse(), DEFAULT_SPREAD_LIMITS, NOW).plant.map((h) => h.host);
    expect(forward).toEqual(backward);
  });
});

describe("classifyPlantRoute — the who-may-launch axis", () => {
  const route = (over: Partial<Parameters<typeof classifyPlantRoute>[0]>) =>
    classifyPlantRoute({
      target: "target",
      vantage: "vantage",
      vantageNeighbours: undefined,
      targetNeighbours: undefined,
      remoteExecCapable: false,
      ...over,
    });

  test("adjacent when either direction of the symmetric edge names the other", () => {
    expect(route({ vantageNeighbours: ["target"] })).toBe("adjacent");
    expect(route({ targetNeighbours: ["vantage"] })).toBe("adjacent");
  });

  test("adjacency wins over remote — an edge keeps the authenticate fallback", () => {
    expect(route({ vantageNeighbours: ["target"], remoteExecCapable: true })).toBe("adjacent");
  });

  test("remote only with the capability and no edge", () => {
    expect(route({ remoteExecCapable: true })).toBe("remote");
  });

  test("ineligible without an edge or the capability — a credential alone is not a route", () => {
    expect(route({})).toBe("ineligible");
    expect(route({ vantageNeighbours: ["other"], targetNeighbours: ["other"] })).toBe("ineligible");
  });
});

describe("remote recovery candidates", () => {
  test("a fresh backdoor can be replanted from the roomiest resident without adjacency", () => {
    const knowledge = fold([
      { hostname: "resident-a", present: true, facts: { neighbours: [], depth: 1 } },
      { hostname: "resident-b", present: true, facts: { neighbours: [], depth: 2 } },
      { hostname: "target", present: true, facts: { depth: 7, maxRam: 32, blockedRam: 0 } },
    ]);
    const candidates = candidatesFrom(knowledge, NOW, {
      standing: new Set(["resident-a", "resident-b"]),
      vault: new Set(["target"]),
      remoteExec: new Set(["target"]),
      remoteVantages: [{ host: "resident-a", freeGb: 4 }, { host: "resident-b", freeGb: 12 }],
    });
    expect(candidates).toContainEqual(expect.objectContaining({
      host: "target",
      from: "resident-b",
      remote: true,
    }));
  });

  test("a target that names a standing host is plantable even if the vantage's own adjacency is unknown", () => {
    // The stasis case: an immune host whose neighbour list never expires names a
    // resident whose OWN neighbours we have not surveyed. Adjacency is symmetric,
    // so that resident is a valid vantage — without this the host is unreachable
    // for planting and sits agent-less for ever.
    const knowledge = fold([
      { hostname: "resident", present: true, facts: { depth: 3 } }, // no neighbours fact
      { hostname: "pinned", present: true, facts: { depth: 7, neighbours: ["resident"], maxRam: 32, blockedRam: 0 } },
    ]);
    const candidates = candidatesFrom(knowledge, NOW, {
      standing: new Set(["resident"]),
      vault: new Set(["pinned"]),
      expiry: { stasisLinked: new Set(["pinned"]) },
    });
    expect(candidates).toContainEqual(expect.objectContaining({ host: "pinned", from: "resident" }));
    // And it is NOT a remote plant — the edge is a real one, so it authenticates
    // and execs directly.
    expect(candidates.find((c) => c.host === "pinned")!.remote).toBeUndefined();
  });

  test("a credential alone never creates a non-adjacent plant", () => {
    const knowledge = fold([
      { hostname: "resident", present: true, facts: { neighbours: [], depth: 1 } },
      { hostname: "target", present: true, facts: { depth: 7, maxRam: 32, blockedRam: 0 } },
    ]);
    expect(candidatesFrom(knowledge, NOW, {
      standing: new Set(["resident"]),
      vault: new Set(["target"]),
      remoteVantages: [{ host: "resident", freeGb: 12 }],
    })).toEqual([]);
  });

  test("a stasis-immune host plants the moment it is empty", () => {
    // No cooldown, immune or otherwise: an empty host with a credential is a
    // plant on the very next pass.
    const knowledge = fold([
      { hostname: "resident", present: true, facts: { neighbours: ["pinned", "mortal"], depth: 1 } },
      { hostname: "pinned", present: true, facts: { depth: 7, maxRam: 32, blockedRam: 0 } },
      { hostname: "mortal", present: true, facts: { depth: 7, maxRam: 32, blockedRam: 0 } },
    ]);
    const cands = candidatesFrom(knowledge, NOW, {
      standing: new Set(["resident"]),
      vault: new Set(["pinned", "mortal"]),
      expiry: { stasisLinked: new Set(["pinned"]) },
    });
    for (const host of ["pinned", "mortal"]) {
      const c = cands.find((entry) => entry.host === host)!;
      expect(planSpread([c], DEFAULT_SPREAD_LIMITS, NOW).plant).toHaveLength(1);
    }
  });
});

describe("spreading preempts to take a vantage", () => {
  test("a free vantage wins outright, and nothing is cancelled", () => {
    const choice = choosePreemptionVantage("plant", [
      { host: "busy", activeKind: "attempt", activeStartedAt: NOW - 5_000 },
      { host: "free" },
    ], NOW);
    expect(choice).toEqual({ vantage: "free", preempt: false });
  });

  test("with none free, the lowest-priority active job is the one we cancel", () => {
    const choice = choosePreemptionVantage("plant", [
      { host: "old", activeKind: "attempt", activeStartedAt: NOW - 9_000 },
      { host: "fresh", activeKind: "induce", activeStartedAt: NOW - 500 },
      { host: "mid", activeKind: "bleed", activeStartedAt: NOW - 4_000 },
    ], NOW);
    expect(choice).toEqual({ vantage: "fresh", preempt: true });
  });

  test("the lab and its pin are never sacrificed for a plant", () => {
    // Every vantage is busy with something a plant may not touch → no choice,
    // the plant waits rather than cancelling the walk, its pin or a storm.
    expect(choosePreemptionVantage("plant", [
      { host: "walker", activeKind: "walk", activeStartedAt: NOW - 1_000 },
      { host: "pinner", activeKind: "pin", activeStartedAt: NOW - 1_000 },
    ], NOW)).toBeUndefined();
  });

  test("a free vantage beats a just-started preemptible one", () => {
    expect(choosePreemptionVantage("plant", [
      { host: "z-free" },
      { host: "a-fresh", activeKind: "attempt", activeStartedAt: NOW },
    ], NOW)).toEqual({ vantage: "z-free", preempt: false });
  });

  test("ties break by name, so the derivation is reproducible", () => {
    expect(choosePreemptionVantage("plant", [
      { host: "b", activeKind: "attempt", activeStartedAt: NOW - 1_000 },
      { host: "a", activeKind: "attempt", activeStartedAt: NOW - 1_000 },
    ], NOW)).toEqual({ vantage: "a", preempt: true });
  });
});

describe("the queue is derived, so dedup needs no bookkeeping", () => {
  /** There is no "add task" call anywhere in this module, and that is the design.
   * A fact that is still believable produces no task, so two workers cannot
   * duplicate the work — not because they coordinate, but because after the
   * first one finishes there is nothing there to pick up. */

  test("a fresh fact produces no work at all", () => {
    const knowledge = fold([
      { hostname: "darkweb", present: true, facts: { neighbours: ["dn-1"], depth: -1 } },
      { hostname: "dn-1", present: true, facts: { neighbours: ["darkweb"], depth: 0, modelId: "ZeroLogon" } },
    ]);
    const tasks = deriveTasks(knowledge, NOW, { agents: new Set(["darkweb"]), vault: new Set(["dn-1", "darkweb"]) });
    // Both adjacency lists are fresh and both hosts are already open.
    expect(tasks.filter((t) => t.kind === "inventory")).toEqual([]);
    expect(tasks.filter((t) => t.kind === "attempt")).toEqual([]);
    expect(tasks.filter((t) => t.kind === "bleed")).toEqual([]);
  });

  test("an expired adjacency is left to the permanent prober", () => {
    const knowledge = fold([
      { hostname: "darkweb", present: true, facts: { neighbours: ["dn-1"], depth: -1 } },
      { hostname: "dn-1", present: true, facts: { neighbours: ["darkweb"], depth: 0 } },
    ]);
    const later = NOW + msPerHostEvent("moved") * 100;
    const tasks = deriveTasks(knowledge, later, { agents: new Set(["darkweb"]) });
    // ...which is also the self-healing property: a worker that died mid-survey
    // left the fact stale, so the task simply reappears with no death detection.
    expect(tasks.some((t) => t.kind === "inventory")).toBe(false);
  });

  test("a host nobody can reach produces no task, because there is no vantage", () => {
    // probe, authenticate and heartbleed all need a DIRECT connection. A task
    // for an unreachable host would be claimed and then refused by the engine.
    const knowledge = fold([
      { hostname: "darkweb", present: true, facts: { neighbours: [], depth: -1 } },
      { hostname: "rumour", present: true, facts: { depth: 4, modelId: "ZeroLogon" } },
    ]);
    const tasks = deriveTasks(knowledge, NOW, { agents: new Set(["darkweb"]) });
    expect(tasks.some((t) => t.host === "rumour")).toBe(false);
  });

  test("a gone host retires its work", () => {
    let knowledge = fold([
      { hostname: "darkweb", present: true, facts: { neighbours: ["dn-1"], depth: -1 } },
      { hostname: "dn-1", present: true, facts: { depth: 0, modelId: "TopPass" } },
    ]);
    foldReports(knowledge, [{ hostname: "dn-1", at: NOW + 1, present: false }], NOW + 1);
    const tasks = deriveTasks(knowledge, NOW + 1, { agents: new Set(["darkweb"]) });
    expect(tasks.some((t) => t.host === "dn-1")).toBe(false);
  });

  test("an attempt exists only while the model has something left to try", () => {
    const knowledge = fold([
      { hostname: "darkweb", present: true, facts: { neighbours: ["dn-1"], depth: -1 } },
      { hostname: "dn-1", present: true, facts: { depth: 0, modelId: "FreshInstall_1.0", passwordLength: 5, passwordFormat: "numeric" } },
    ]);
    const opts = { agents: new Set(["darkweb"]) };
    const first = deriveTasks(knowledge, NOW, opts).find((t) => t.kind === "attempt");
    expect(first?.reason).toBe("DefaultPassword candidate 1/1");

    // Length and format reduce this identity to the sole compatible default.
    knowledge.get("dn-1")!.attempts = { modelId: "FreshInstall_1.0", tried: 1, probes: 0 };
    expect(deriveTasks(knowledge, NOW, opts).some((t) => t.kind === "attempt")).toBe(false);
  });

  test("cheapest-certain first: a dictionary outranks a conversation", () => {
    // Both open the net, so neither is a probe — but a dictionary hit is one
    // call away and a feedback solver has to converse first, so the order has
    // to reflect that rather than treating every attempt alike.
    const knowledge = fold([
      { hostname: "darkweb", present: true, facts: { neighbours: ["hard", "easy"], depth: -1 } },
      { hostname: "hard", present: true, facts: { depth: 0, modelId: "DeepGreen", passwordLength: 4, passwordFormat: "numeric" } },
      { hostname: "easy", present: true, facts: { depth: 0, modelId: "ZeroLogon" } },
    ]);
    const tasks = deriveTasks(knowledge, NOW, { agents: new Set(["darkweb"]) }).filter((t) => t.kind === "attempt");
    expect(tasks[0]!.host).toBe("easy");
    expect(tasks[1]!.host).toBe("hard");
    // The reason names the model and what the conversation will cost, because a
    // solve that may take dozens of calls should not read like a single guess.
    expect(tasks[1]!.reason).toContain("Mastermind");
    expect(tasks[1]!.reason).toContain("attempts");

    // And a solve does NOT retire after one deliberate failure the way a probe
    // does: the ledger's probe count is not what bounds it.
    knowledge.get("hard")!.attempts = { modelId: "DeepGreen", tried: 0, probes: 1 };
    const after = deriveTasks(knowledge, NOW, { agents: new Set(["darkweb"]) });
    expect(after.some((t) => t.kind === "attempt" && t.host === "hard")).toBe(true);
  });

  test("the labyrinth is the one model left with no solver, and it gets a probe", () => {
    // Every other model now has either a dictionary or a solver, so the probe
    // path — one deliberate failure to make an oracle appear — survives for
    // exactly one case, and it must still retire after that one attempt.
    const knowledge = fold([
      { hostname: "darkweb", present: true, facts: { neighbours: ["maze"], depth: -1 } },
      { hostname: "maze", present: true, facts: { depth: 0, modelId: "(The Labyrinth)", passwordLength: 4, passwordFormat: "numeric" } },
    ]);
    const tasks = deriveTasks(knowledge, NOW, { agents: new Set(["darkweb"]) }).filter((t) => t.kind === "attempt");
    expect(tasks).toHaveLength(1);
    expect(tasks[0]!.reason).toContain("maze");

    knowledge.get("maze")!.attempts = { modelId: "(The Labyrinth)", tried: 0, probes: 1 };
    const after = deriveTasks(knowledge, NOW, { agents: new Set(["darkweb"]) });
    expect(after.some((t) => t.kind === "attempt" && t.host === "maze")).toBe(false);
    expect(after.some((t) => t.kind === "inventory" && t.host === "maze")).toBe(false);
  });

  test("work a live process is already doing derives no second task", () => {
    // The hole structural dedup cannot close. `attempt:<host>` writes no fact
    // when it starts, so it re-derives every 2 s tick for the whole duration of
    // a multi-second authenticate; only the controller's per-queue duplicate
    // check hides it, and that check stops covering the case the moment a target
    // has two adjacent vantages.
    const knowledge = fold([
      { hostname: "darkweb", present: true, facts: { neighbours: ["dn-1"], depth: -1 } },
      { hostname: "dn-1", present: true, facts: { depth: 0, modelId: "ZeroLogon" } },
    ]);
    const opts = { agents: new Set(["darkweb"]) };
    expect(deriveTasks(knowledge, NOW, opts).some((t) => t.id === "attempt:dn-1")).toBe(true);

    const inFlight = new Map([["dn-1", [{ from: "darkweb", kind: "attempt" as const }]]]);
    const during = deriveTasks(knowledge, NOW, { ...opts, inFlight });
    expect(during.some((t) => t.id === "attempt:dn-1")).toBe(false);
    // ...and only that pair. The host's adjacency is still unknown, so the
    // survey is untouched: a claim suppresses one KIND, not a host.
    expect(during.some((t) => t.kind === "inventory")).toBe(false);
  });

  test("a bleed claim owns the target ring until it finishes", () => {
    const knowledge = fold([
      { hostname: "darkweb", present: true, facts: { neighbours: ["dn-1"], depth: -1 } },
      { hostname: "dn-1", present: true, facts: { depth: 0, modelId: "ZeroLogon" } },
    ]);
    const inFlight = new Map([["dn-1", [{ from: "darkweb", kind: "bleed" as const }]]]);
    const tasks = deriveTasks(knowledge, NOW, { agents: new Set(["darkweb"]), inFlight });
    expect(tasks.some((t) => t.id === "attempt:dn-1")).toBe(false);
    expect(tasks.some((t) => t.kind === "inventory")).toBe(false);
  });

  test("pending records derive one serialized drain and suppress password work", () => {
    const knowledge = fold([
      { hostname: "darkweb", present: true, facts: { neighbours: ["dn-1"], depth: -1 } },
      { hostname: "dn-1", present: true, facts: { depth: 1 } },
    ]);
    knowledge.get("dn-1")!.attempts = { tried: 1, probes: 0 };
    knowledge.get("dn-1")!.ring = { pendingAuthRecords: 2 };
    const tasks = deriveTasks(knowledge, NOW, {
      agents: new Set(["darkweb"]),
      guesses: [{ host: "dn-1", id: "leak", reason: "compatible leaked password" }],
    });
    const targetBleeds = tasks.filter((task) => task.kind === "bleed" && task.host === "dn-1");
    expect(targetBleeds).toHaveLength(1);
    expect(targetBleeds[0]?.reason).toContain("2 authentication log record");
    expect(tasks.filter((task) => task.kind === "attempt")).toHaveLength(0);
  });

  test("an initial ring read happens once; elapsed time cannot invent logs", () => {
    const knowledge = fold([
      { hostname: "dn-1", present: true, facts: { neighbours: ["dn-2"], depth: 1, logTrafficInterval: 2 } },
      { hostname: "dn-2", present: true, facts: { depth: 2 } },
    ]);
    knowledge.get("dn-1")!.attempts = { tried: 0, probes: 0 };
    const opts = { agents: new Set(["dn-1"]), vault: new Set(["dn-1"]) };
    expect(deriveTasks(knowledge, NOW, opts).find((task) => task.kind === "bleed")?.reason)
      .toContain("initial log ring");
    knowledge.get("dn-1")!.ring = {
      pendingAuthRecords: 0,
      lastBleedAt: NOW - 40_000,
      lastBleedAttemptAt: NOW - 40_000,
    };
    expect(deriveTasks(knowledge, NOW, opts).some((task) => task.id === "bleed:dn-1")).toBe(false);
  });

  test("charisma gates oracle work but never a dictionary candidate", () => {
    const knowledge = fold([
      { hostname: "dn-0", present: true, facts: { neighbours: ["probe-me", "dict-me", "bleed-me"] } },
      { hostname: "probe-me", present: true, facts: { depth: 1, modelId: "Mystery_9000", requiredCharisma: 120 } },
      { hostname: "dict-me", present: true, facts: { depth: 1, modelId: "FreshInstall_1.0", requiredCharisma: 120 } },
      { hostname: "bleed-me", present: true, facts: { depth: 1, requiredCharisma: 120, logTrafficInterval: 1 } },
    ]);
    knowledge.get("bleed-me")!.attempts = { tried: 1, probes: 0 };
    knowledge.get("bleed-me")!.ring = { pendingAuthRecords: 1 };
    const attempts = (charisma: number) => deriveTasks(knowledge, NOW, {
      agents: new Set(["dn-0"]), charisma,
    }).filter((task) => task.kind === "attempt");
    expect(attempts(50).map((task) => task.host)).toEqual(["dict-me"]);
    expect(attempts(200).map((task) => task.host).sort()).toEqual(["dict-me", "probe-me"]);
    expect(deriveTasks(knowledge, NOW, { agents: new Set(["dn-0"]), charisma: 50 })
      .some((task) => task.kind === "bleed" && task.host === "bleed-me")).toBe(false);
    expect(deriveTasks(knowledge, NOW, { agents: new Set(["dn-0"]), charisma: 120 })
      .some((task) => task.kind === "bleed" && task.host === "bleed-me")).toBe(true);
  });

  test("a plant already in flight is not filed twice", () => {
    // The spread planner has its own cooldown, but it is per HOST and measured
    // from the last plant that FINISHED. A plant in flight is a different fact.
    const knowledge = fold([
      { hostname: "darkweb", present: true, facts: { neighbours: ["dn-1"], depth: -1 } },
      { hostname: "dn-1", present: true, facts: { depth: 0, modelId: "ZeroLogon" } },
    ]);
    const plantable = [{ host: "dn-1", from: "darkweb" }];
    expect(deriveTasks(knowledge, NOW, { agents: new Set(["darkweb"]), plantable })
      .some((t) => t.kind === "plant")).toBe(true);
    const inFlight = new Map([["dn-1", [{ from: "darkweb", kind: "plant" as const }]]]);
    expect(deriveTasks(knowledge, NOW, { agents: new Set(["darkweb"]), plantable, inFlight })
      .some((t) => t.kind === "plant")).toBe(false);
  });

  test("an attempt does not create a separate bleed task", () => {
    const knowledge = fold([
      { hostname: "darkweb", present: true, facts: { neighbours: ["a", "b"], depth: -1 } },
      { hostname: "a", present: true, facts: { neighbours: ["target"], depth: 0 } },
      { hostname: "b", present: true, facts: { neighbours: ["target"], depth: 0 } },
      { hostname: "target", present: true, facts: { depth: 1, modelId: "ZeroLogon" } },
    ]);
    // An attempt drains its own authentication record; it does not derive a
    // second, speculative listening task.
    const tasks = deriveTasks(knowledge, NOW, { agents: new Set(["a", "b", "target"]) });
    const bleed = tasks.find((t) => t.id === "bleed:target");
    const attempt = tasks.find((t) => t.id === "attempt:target");
    expect(bleed).toBeUndefined();
    expect(attempt).toBeDefined();
  });

  test("a one-shot candidate prequeues a bleed on the smaller second vantage", () => {
    const knowledge = fold([
      { hostname: "a", present: true, facts: { neighbours: ["target"], depth: 0, maxRam: 64, blockedRam: 0 } },
      { hostname: "b", present: true, facts: { neighbours: ["target"], depth: 0, maxRam: 16, blockedRam: 0 } },
      { hostname: "target", present: true, facts: { depth: 1, modelId: "FreshInstall_1.0", requiredCharisma: 1 } },
    ]);
    const tasks = deriveTasks(knowledge, NOW, {
      agents: new Set(["a", "b"]),
      agentFreeGb: new Map([["a", 60], ["b", 12]]),
      attemptGbPerThread: 4,
      bleedGbPerThread: 3,
      charisma: 10,
    });
    const attempt = tasks.find((task) => task.id === "attempt:target")!;
    const bleed = tasks.find((task) => task.followAttemptIds?.includes(attempt.id))!;
    expect(attempt.from).toBe("a");
    expect(bleed.from).toBe("b");
    expect(bleed.threads).toBe(4);
  });

  test("two narrowed passwords fill two available vantages", () => {
    const knowledge = fold([
      { hostname: "a", present: true, facts: { neighbours: ["target"], depth: 0 } },
      { hostname: "b", present: true, facts: { neighbours: ["target"], depth: 0 } },
      { hostname: "target", present: true, facts: { depth: 1, modelId: "ZeroLogon" } },
    ]);
    const tasks = deriveTasks(knowledge, NOW, {
      agents: new Set(["a", "b"]),
      guesses: [
        { host: "target", id: "one", reason: "candidate one" },
        { host: "target", id: "two", reason: "candidate two" },
      ],
    });
    const attempts = tasks.filter((task) => task.kind === "attempt" && task.host === "target");
    expect(attempts.map((task) => task.from).sort()).toEqual(["a", "b"]);
    expect(attempts.every((task) => task.skipInitialBleed === true)).toBe(true);
    expect(tasks.some((task) => task.followAttemptIds !== undefined)).toBe(false);
  });

  test.each([
    [10, 1, true, { authSlots: 1, bleedSlots: 0 }],
    [2, 2, true, { authSlots: 2, bleedSlots: 0 }],
    [3, 3, true, { authSlots: 3, bleedSlots: 0 }],
    [3, 2, true, { authSlots: 1, bleedSlots: 1 }],
    [10, 3, true, { authSlots: 2, bleedSlots: 1 }],
    [10, 10, true, { authSlots: 3, bleedSlots: 1 }],
    [10, 10, false, { authSlots: 10, bleedSlots: 0 }],
  ] as const)("candidate allocation (%i choices, %i vantages)", (choices, vantages, oracle, expected) => {
    expect(allocateCredentialChecks(choices, vantages, oracle)).toEqual(expected);
  });

  test("ten choices on ten vantages use three auth records and one shared follower bleed", () => {
    const vantageNames = Array.from({ length: 10 }, (_, index) => `a${index}`);
    const knowledge = fold([
      ...vantageNames.map((hostname) => ({ hostname, present: true, facts: { neighbours: ["target"], depth: 0 } })),
      { hostname: "target", present: true, facts: { depth: 1, modelId: "AccountsManager_4.2" } },
    ]);
    const tasks = deriveTasks(knowledge, NOW, {
      agents: new Set(vantageNames),
      guesses: Array.from({ length: 10 }, (_, index) => ({
        host: "target",
        id: String(index),
        reason: `candidate ${index}`,
      })),
    });
    const attempts = tasks.filter((task) => task.kind === "attempt" && task.host === "target");
    const follower = tasks.find((task) => task.followAttemptIds !== undefined)!;
    expect(attempts.map((task) => task.from)).toEqual(["a0", "a1", "a2"]);
    expect(follower.from).toBe("a3");
    expect(follower.followAttemptIds).toEqual(attempts.map((task) => task.id));
  });

  test("duplicate clue paths never authenticate the same password twice", () => {
    const knowledge = fold([
      { hostname: "a", present: true, facts: { neighbours: ["target"], depth: 0 } },
      { hostname: "b", present: true, facts: { neighbours: ["target"], depth: 0 } },
      { hostname: "target", present: true, facts: { depth: 1, modelId: "ZeroLogon" } },
    ]);
    const tasks = deriveTasks(knowledge, NOW, {
      agents: new Set(["a", "b"]),
      guesses: [
        { host: "target", id: "same", reason: "attributed copy" },
        { host: "target", id: "same", reason: "loose copy" },
        { host: "target", id: "other", reason: "other candidate" },
      ],
    });
    expect(tasks.filter((task) => task.kind === "attempt").map((task) => task.guessId).sort())
      .toEqual(["other", "same"]);
  });

  test("an unreadable oracle spends every available slot on authentication", () => {
    const vantageNames = Array.from({ length: 5 }, (_, index) => `v${index}`);
    const knowledge = fold([
      ...vantageNames.map((hostname) => ({ hostname, present: true, facts: { neighbours: ["target"], depth: 0 } })),
      { hostname: "target", present: true, facts: { depth: 1, modelId: "AccountsManager_4.2", requiredCharisma: 100 } },
    ]);
    const tasks = deriveTasks(knowledge, NOW, {
      agents: new Set(vantageNames),
      charisma: 1,
      guesses: Array.from({ length: 10 }, (_, index) => ({ host: "target", id: String(index), reason: "candidate" })),
    });
    expect(tasks.filter((task) => task.kind === "attempt" && task.host === "target")).toHaveLength(5);
    expect(tasks.some((task) => task.followAttemptIds !== undefined)).toBe(false);
  });

  test("a single available vantage is selected directly", () => {
    const knowledge = fold([
      { hostname: "darkweb", present: true, facts: { neighbours: ["target"], depth: -1 } },
      { hostname: "target", present: true, facts: { depth: 0, modelId: "ZeroLogon" } },
    ]);
    const tasks = deriveTasks(knowledge, NOW, { agents: new Set(["darkweb"]) });
    expect(tasks.find((t) => t.id === "attempt:target")!.from).toBe("darkweb");
  });

  test("another vantage does not bypass target-ring ownership", () => {
    const knowledge = fold([
      { hostname: "darkweb", present: true, facts: { neighbours: ["a", "b"], depth: -1 } },
      { hostname: "a", present: true, facts: { neighbours: ["target"], depth: 0 } },
      { hostname: "b", present: true, facts: { neighbours: ["target"], depth: 0 } },
      { hostname: "target", present: true, facts: { depth: 1, modelId: "ZeroLogon" } },
    ]);
    const inFlight = new Map([["target", [{ from: "a", kind: "bleed" as const }]]]);
    expect(deriveTasks(knowledge, NOW, { agents: new Set(["a", "b"]), inFlight })
      .find((t) => t.id === "attempt:target")).toBeUndefined();
  });

  test("vantages are ordered by name, not by the order hosts were planted", () => {
    // `agents` is a Set, so its iteration order is insertion order — which would
    // make the derived queue depend on the sequence in which the net happened to
    // be planted, and two derivations of the same knowledge disagree.
    const knowledge = fold([
      { hostname: "darkweb", present: true, facts: { neighbours: ["a", "b"], depth: -1 } },
      { hostname: "a", present: true, facts: { neighbours: ["target"], depth: 0 } },
      { hostname: "b", present: true, facts: { neighbours: ["target"], depth: 0 } },
      { hostname: "target", present: true, facts: { depth: 1, modelId: "ZeroLogon" } },
    ]);
    const forward = deriveTasks(knowledge, NOW, { agents: new Set(["a", "b"]) });
    const backward = deriveTasks(knowledge, NOW, { agents: new Set(["b", "a"]) });
    expect(forward.map((t) => `${t.id}@${t.from}`)).toEqual(backward.map((t) => `${t.id}@${t.from}`));
  });

  test("a loose password outranks the model attempt on the same host, and suppresses it", () => {
    // Branch 6 of the noise generator leaks a random MOVABLE host's password
    // with no name on it, and the controller has already narrowed it to hosts
    // whose length and format match. Spending one is a SINGLE authenticate with
    // no penalty for being wrong, so running a solver alongside it would be
    // paying for information the guess may make unnecessary.
    //
    // The password itself never reaches this module: the task carries an id and
    // the controller resolves it. That is the same rule `inFlight` keeps.
    const knowledge = fold([
      { hostname: "darkweb", present: true, facts: { neighbours: ["dn-1"], depth: -1 } },
      { hostname: "dn-1", present: true, facts: { neighbours: ["darkweb"], depth: 0, modelId: "ZeroLogon" } },
    ]);
    const tasks = deriveTasks(knowledge, NOW, {
      agents: new Set(["darkweb"]),
      guesses: [{ host: "dn-1", id: "7", reason: "a log leaked a 4-character numeric password" }],
    });
    const guess = tasks.find((t) => t.guessId !== undefined)!;
    expect(guess.kind).toBe("attempt");
    expect(guess.host).toBe("dn-1");
    expect(guess.id).toBe("guess:dn-1:7");
    // No second attempt against the same host this tick.
    expect(tasks.filter((t) => t.kind === "attempt")).toHaveLength(1);
    expect(JSON.stringify(tasks)).not.toContain("password\":");
  });

  test("a guess yields to work already in flight against the host", () => {
    const knowledge = fold([
      { hostname: "darkweb", present: true, facts: { neighbours: ["dn-1"], depth: -1 } },
      { hostname: "dn-1", present: true, facts: { neighbours: ["darkweb"], depth: 0, modelId: "ZeroLogon" } },
    ]);
    const inFlight = new Map([["dn-1", [{ from: "darkweb", kind: "attempt" as const }]]]);
    const tasks = deriveTasks(knowledge, NOW, {
      agents: new Set(["darkweb"]),
      inFlight,
      guesses: [{ host: "dn-1", id: "7", reason: "leak" }],
    });
    expect(tasks.filter((t) => t.kind === "attempt")).toEqual([]);
    // An unrelated identity may still need its one initial ring drain; only
    // this target's shared ring is owned by the in-flight attempt.
    expect(tasks.filter((t) => t.kind === "bleed" && t.host === "dn-1")).toEqual([]);
  });

  test("the deliberate three are merged with their own vantage, and only the push waits", () => {
    // `pin` and `walk` are decided once for the whole net and outrank the farm:
    // a pin that queues behind a forty-second phish may be spent on a host that
    // has already been restarted. A `push` is the opposite — hundreds of calls
    // whose value arrives at the end — so it sorts behind everything that opens
    // the net. And `induce` is the one kind whose target is not where it runs.
    const knowledge = fold([
      { hostname: "darkweb", present: true, facts: { neighbours: ["dn-1"], depth: -1 } },
      { hostname: "dn-1", present: true, facts: { neighbours: ["darkweb", "dn-2"], depth: 0 } },
      { hostname: "dn-2", present: true, facts: { neighbours: ["dn-1"], depth: 1 } },
    ]);
    const tasks = deriveTasks(knowledge, NOW, {
      agents: new Set(["darkweb", "dn-1"]),
      vault: new Set(["darkweb", "dn-1", "dn-2"]),
      hold: [
        { kind: "pin", host: "dn-1", from: "dn-1", reason: "pin the host nothing can replace" },
        { kind: "induce", host: "dn-2", from: "dn-1", reason: "push it toward the bottom row" },
      ],
    });
    const pin = tasks.find((t) => t.kind === "pin")!;
    const push = tasks.find((t) => t.kind === "induce")!;
    // The WALK now outranks EVERYTHING, the pin included: completing the lab is
    // the point of the darknet, so until it is done the walker is the most
    // important script on its host and nothing may take its slot. A walker's host
    // is protected by being the walker (the controller marks it irreplaceable),
    // not by a prior pin.
    const walking = deriveTasks(knowledge, NOW, {
      agents: new Set(["darkweb", "dn-1"]),
      vault: new Set(["darkweb", "dn-1", "dn-2"]),
      hold: [
        { kind: "pin", host: "dn-1", from: "dn-1", reason: "pin it" },
        { kind: "walk", host: "dn-2", from: "dn-1", reason: "walk the maze" },
      ],
    });
    const order = walking.filter((t) => t.kind === "pin" || t.kind === "walk").map((t) => t.kind);
    expect(order).toEqual(["walk", "pin"]);
    expect(pin.from).toBe("dn-1");
    expect(push.host).toBe("dn-2");
    expect(push.from).toBe("dn-1");
    expect(pin.priority).toBeLessThan(push.priority);
    expect(tasks.indexOf(pin)).toBeLessThan(tasks.indexOf(push));
  });

  test("walks file per vantage: the finisher and its scout coexist, neither re-derives", () => {
    // The maze is global while positions are per PID. How MANY walks exist is
    // `planWalk`'s decision alone (one pinned finisher, at most one mortal
    // scout); the queue's job is to file exactly what it admitted, so walk
    // dedup is per (target, VANTAGE) — the same treatment an induce push gets.
    const knowledge = fold([
      { hostname: "darkweb", present: true, facts: { neighbours: ["dn-1"], depth: -1 } },
      { hostname: "dn-1", present: true, facts: { neighbours: ["darkweb", "dn-2"], depth: 0 } },
      { hostname: "dn-2", present: true, facts: { neighbours: ["dn-1"], depth: 1 } },
    ]);
    const hold = [
      { kind: "walk" as const, host: "dn-2", from: "dn-1", reason: "walk the maze" },
      { kind: "walk" as const, host: "dn-2", from: "darkweb", scout: true as const, reason: "mortal scout" },
    ];
    const base = { agents: new Set(["darkweb", "dn-1"]), vault: new Set(["darkweb", "dn-1", "dn-2"]) };
    const both = deriveTasks(knowledge, NOW, { ...base, hold }).filter((t) => t.kind === "walk");
    // Equal priority; the id tie-break orders them.
    expect(both.map((t) => t.id)).toEqual(["walk:dn-2:darkweb", "walk:dn-2:dn-1"]);

    // A walk already in flight suppresses only ITS vantage; the other files.
    const rederived = deriveTasks(knowledge, NOW, {
      ...base,
      hold,
      inFlight: new Map([["dn-2", [{ from: "dn-1", kind: "walk" as const }]]]),
    }).filter((t) => t.kind === "walk");
    expect(rederived.map((t) => t.id)).toEqual(["walk:dn-2:darkweb"]);
  });

  test("a plant outranks every other blocking task because it grows the map", () => {
    const knowledge = fold([
      { hostname: "darkweb", present: true, facts: { neighbours: ["dn-1"], depth: -1 } },
      { hostname: "dn-1", present: true, facts: { depth: 0, modelId: "ZeroLogon" } },
    ]);
    const tasks = deriveTasks(knowledge, NOW, {
      agents: new Set(["darkweb"]),
      plantable: [{ host: "dn-1", from: "darkweb" }],
    });
    // Placing a process is the only action that grows the set of places we can
    // act FROM, which is what makes it the scarcest thing we do.
    expect(tasks[0]!.kind).toBe("plant");
  });
});

describe("attempts stand on the roomiest vantage, and buy threads with it", () => {
  // `authenticate`'s duration scales 1/(1 + 0.2*(threads-1)) with the calling
  // script's threads, and threads are bought with the vantage's free RAM — so
  // the vantage with the most room is the fastest crack, and the thread count
  // is sized where the vantage is chosen.
  const net = () => fold([
    { hostname: "darkweb", present: true, facts: { neighbours: ["dn-a", "dn-b"], depth: -1 } },
    { hostname: "dn-a", present: true, facts: { neighbours: ["target"], depth: 0 } },
    { hostname: "dn-b", present: true, facts: { neighbours: ["target"], depth: 0 } },
    { hostname: "target", present: true, facts: { depth: 1, modelId: "ZeroLogon" } },
  ]);
  const agents = () => new Set(["darkweb", "dn-a", "dn-b"]);

  test("the biggest free RAM wins the vantage, and sizes the threads", () => {
    const attempt = deriveTasks(net(), NOW, {
      agents: agents(),
      agentFreeGb: new Map([["dn-a", 4], ["dn-b", 6.4]]),
      attemptGbPerThread: 2,
    }).find((t) => t.kind === "attempt" && t.host === "target")!;
    expect(attempt.from).toBe("dn-b");
    // floor(6.4 / 2) = 3, under the cap.
    expect(attempt.threads).toBe(3);
  });

  test("threads scale with RAM, with no ceiling but the RAM itself", () => {
    const attempt = deriveTasks(net(), NOW, {
      agents: agents(),
      agentFreeGb: new Map([["dn-a", 4], ["dn-b", 1000]]),
      attemptGbPerThread: 2,
    }).find((t) => t.kind === "attempt" && t.host === "target")!;
    // floor(1000 / 2) = 500 — the whole vantage, no arbitrary cap.
    expect(attempt.threads).toBe(500);
  });

  test("a bleed is threaded from its vantage too, on its own price", () => {
    // `heartbleed` scales with the calling script's threads exactly as
    // `authenticate` does, so a drain uses the RAM its vantage can spare. A
    // pending-record drain is the deterministic case.
    const knowledge = fold([
      { hostname: "darkweb", present: true, facts: { neighbours: ["dn-a"], depth: -1 } },
      { hostname: "dn-a", present: true, facts: { neighbours: ["target"], depth: 0 } },
      { hostname: "target", present: true, facts: { depth: 1, modelId: "ZeroLogon", requiredCharisma: 1 } },
    ]);
    knowledge.get("target")!.ring = { pendingAuthRecords: 2 };
    const bleed = deriveTasks(knowledge, NOW, {
      agents: new Set(["darkweb", "dn-a"]),
      charisma: 500,
      agentFreeGb: new Map([["dn-a", 12]]),
      bleedGbPerThread: 3,
    }).find((t) => t.kind === "bleed" && t.host === "target");
    expect(bleed?.threads).toBe(4);
  });

  test("an equal-RAM tie breaks by name, so the queue stays deterministic", () => {
    const attempt = deriveTasks(net(), NOW, {
      agents: agents(),
      agentFreeGb: new Map([["dn-a", 8], ["dn-b", 8]]),
      attemptGbPerThread: 2,
    }).find((t) => t.kind === "attempt" && t.host === "target")!;
    expect(attempt.from).toBe("dn-a");
  });

  test("unknown RAM still chooses a deterministic vantage", () => {
    const attempt = deriveTasks(net(), NOW, {
      agents: agents(),
    }).find((t) => t.kind === "attempt" && t.host === "target")!;
    expect(attempt.from).toBe("dn-a");
    expect(attempt.threads).toBeUndefined();
  });

});

describe("a plant task is a FRONTIER, and `host` is only its name", () => {
  // The invariant every reader downstream depends on. `Order.host` is the
  // generic identity each order carries; for a plant it names `targets[0]` and
  // nothing more, and asking "does this order concern host X" by reading it was
  // one defect that showed up as six: the in-flight overlay left siblings free
  // to be re-derived onto a second vantage, the plant cooldown protected one
  // host out of five, and one gone target retired a healthy frontier.
  const knowledge: DnetHosts = new Map();
  const at = 1_000_000;
  const seen: ReportHost[] = [
    { hostname: "darkweb", at, present: true, depth: -1, maxRam: 64, blockedRam: 0, neighbours: ["a.corp", "b.corp", "c.corp"] },
    { hostname: "a.corp", at, present: true, depth: 0, maxRam: 32, blockedRam: 0 },
    { hostname: "b.corp", at, present: true, depth: 1, maxRam: 32, blockedRam: 0 },
    { hostname: "c.corp", at, present: true, depth: 2, maxRam: 32, blockedRam: 0 },
  ];
  foldReports(knowledge, seen, at, {});

  const plantable = candidatesFrom(knowledge, at, {
    standing: new Set(["darkweb"]),
    vault: new Set(["a.corp", "b.corp", "c.corp"]),
  });
  const plan = planSpread(plantable, DEFAULT_SPREAD_LIMITS, at);

  test("one vantage's whole frontier is one task", () => {
    expect(plan.plant.map((entry) => entry.host).sort()).toEqual(["a.corp", "b.corp", "c.corp"]);

    const tasks = deriveTasks(knowledge, at, {
      agents: new Set(["darkweb"]),
      vault: new Set(["a.corp", "b.corp", "c.corp"]),
      plantable: plan.plant.map((entry) => ({ host: entry.host, from: entry.from })),
    }).filter((task) => task.kind === "plant");

    // Three targets, ONE order. Serialised behind three spawns they would be
    // three prober round trips deep; together they cost one.
    expect(tasks).toHaveLength(1);
    expect(tasks[0]!.from).toBe("darkweb");
    expect(tasks[0]!.targets?.map((target) => target.host).sort()).toEqual(["a.corp", "b.corp", "c.corp"]);
  });

  test("`host` names the first target and never stands in for the frontier", () => {
    const tasks = deriveTasks(knowledge, at, {
      agents: new Set(["darkweb"]),
      vault: new Set(["a.corp", "b.corp", "c.corp"]),
      plantable: plan.plant.map((entry) => ({ host: entry.host, from: entry.from })),
    }).filter((task) => task.kind === "plant");

    const task = tasks[0]!;
    expect(task.host).toBe(task.targets![0]!.host);
    expect(task.targets!.length).toBeGreaterThan(1);
  });

  test("a target already carrying an agent never joins a frontier", () => {
    const tasks = deriveTasks(knowledge, at, {
      agents: new Set(["darkweb", "b.corp"]),
      vault: new Set(["a.corp", "b.corp", "c.corp"]),
      plantable: plan.plant.map((entry) => ({ host: entry.host, from: entry.from })),
    }).filter((task) => task.kind === "plant");

    expect(tasks[0]!.targets?.map((target) => target.host).sort()).toEqual(["a.corp", "c.corp"]);
  });
});
