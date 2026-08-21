import { describe, expect, test } from "bun:test";
import { DEFAULT_SPREAD_LIMITS, planSpread, type SpreadCandidate } from "../shared/strategy/dnet/spread.ts";
import { deriveTasks } from "../shared/strategy/dnet/queue.ts";
import {
  emptyKnowledge,
  foldReports,
  type DarknetKnowledge,
} from "../shared/strategy/dnet/knowledge.ts";
import type { ReportHost } from "../shared/strategy/dnet/courier.ts";
import { msPerHostEvent } from "../shared/strategy/dnet/rates.ts";

const GEN = "15:0";
const NOW = 10_000_000;

function candidate(over: Partial<SpreadCandidate> & { host: string }): SpreadCandidate {
  return { from: "darkweb", hasCredential: true, agentAlive: false, freeRam: 16, depth: 0, ...over };
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

function fold(hosts: Seen[], at = NOW): DarknetKnowledge {
  return foldReports(emptyKnowledge(GEN), reports(hosts, at), at).knowledge;
}

describe("every refusal to spread is named", () => {
  /** A planner that silently skipped a host would make four independent limits
   * invisible at once. When the net stops growing, these strings are the answer
   * to "why" — so each is asserted individually rather than as "not planted". */

  test("a host that is simply gone is not reported as anything else", () => {
    // Order matters: a refusal that sends someone looking at the wrong problem
    // is worse than no refusal at all.
    const plan = planSpread([candidate({ host: "dead", goneAt: NOW - 1, freeRam: 0, hasCredential: false })], DEFAULT_SPREAD_LIMITS, NOW);
    expect(plan.plant).toEqual([]);
    expect(plan.refused[0]!.why).toBe("gone");
  });

  test("no credential is a CRACKING failure, and says so", () => {
    // Spreading and cracking want different fixes, and conflating them is how a
    // password problem gets debugged as a RAM problem.
    const plan = planSpread([candidate({ host: "locked", hasCredential: false })], DEFAULT_SPREAD_LIMITS, NOW);
    expect(plan.refused[0]!.why).toBe("no-credential");
    expect(plan.refused[0]!.detail).toContain("attempt, not a plant");
  });

  test("unknown RAM never reads as room for an agent", () => {
    // exec on a full host returns a silent 0, indistinguishable from a missing
    // file. Guessing here would burn a plant and report success.
    const plan = planSpread([candidate({ host: "unknown", freeRam: undefined })], DEFAULT_SPREAD_LIMITS, NOW);
    expect(plan.refused[0]!.why).toBe("unknown-ram");
  });

  test("not enough RAM names the number and the likely cause", () => {
    // A big darknet host can arrive with ALL of its RAM blocked by its owner,
    // which is a different problem from a small host.
    const plan = planSpread([candidate({ host: "blocked", freeRam: 1 })], DEFAULT_SPREAD_LIMITS, NOW);
    expect(plan.refused[0]!.why).toBe("not-enough-ram");
    expect(plan.refused[0]!.detail).toContain("1.00GB free");
    expect(plan.refused[0]!.detail).toContain("memoryReallocation");
  });

  test("the hop budget, the fan-out cap and the agent cap each refuse by name", () => {
    const deep = planSpread([candidate({ host: "deep", depth: 9 })], DEFAULT_SPREAD_LIMITS, NOW);
    expect(deep.refused[0]!.why).toBe("too-deep");

    // One source host must not spend the whole agent budget on its own
    // neighbourhood.
    const many = Array.from({ length: 5 }, (_, i) => candidate({ host: `n${i}`, from: "darkweb" }));
    const fanned = planSpread(many, DEFAULT_SPREAD_LIMITS, NOW);
    expect(fanned.plant).toHaveLength(DEFAULT_SPREAD_LIMITS.fanOut);
    expect(fanned.refused.every((r) => r.why === "fan-out")).toBe(true);

    // ...and the total is capped too, because the report port is a 50-entry
    // queue drained every 30 seconds.
    const spread = Array.from({ length: 40 }, (_, i) => candidate({ host: `n${i}`, from: `src${i}` }));
    const capped = planSpread(spread, { ...DEFAULT_SPREAD_LIMITS, fanOut: 99 }, NOW, 10);
    expect(capped.plant).toHaveLength(2);
    expect(capped.refused.some((r) => r.why === "agent-cap")).toBe(true);
  });

  test("a host that keeps restarting is not allowed to absorb every worker", () => {
    const hot = candidate({ host: "flapping", lastPlantAt: NOW - 1_000 });
    expect(planSpread([hot], DEFAULT_SPREAD_LIMITS, NOW).refused[0]!.why).toBe("cooldown");
    // ...but the cooldown does expire.
    expect(planSpread([hot], DEFAULT_SPREAD_LIMITS, NOW + 120_000).plant).toHaveLength(1);
  });

  test("an agent already standing there is not replaced", () => {
    const plan = planSpread([candidate({ host: "occupied", agentAlive: true })], DEFAULT_SPREAD_LIMITS, NOW);
    expect(plan.refused[0]!.why).toBe("agent-alive");
  });
});

describe("spreading prefers the shallow and the roomy, deterministically", () => {
  test("shallow first, then most room, then by name", () => {
    // Depth is what the exercise is for, and a shallow host is also the cheapest
    // place to stand while cracking the next one.
    const plan = planSpread(
      [
        candidate({ host: "deep", depth: 3, from: "a" }),
        candidate({ host: "shallow-small", depth: 0, freeRam: 4, from: "b" }),
        candidate({ host: "shallow-big", depth: 0, freeRam: 32, from: "c" }),
      ],
      { ...DEFAULT_SPREAD_LIMITS, liveAgentCap: 99 },
      NOW,
    );
    expect(plan.plant.map((entry) => entry.host)).toEqual(["shallow-big", "shallow-small", "deep"]);
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
    // Both adjacency lists are fresh and both hosts are already open, so the
    // only thing left worth doing is listening to their logs.
    expect(tasks.filter((t) => t.kind === "survey")).toEqual([]);
    expect(tasks.filter((t) => t.kind === "attempt")).toEqual([]);
  });

  test("an expired adjacency brings the survey back by itself", () => {
    const knowledge = fold([
      { hostname: "darkweb", present: true, facts: { neighbours: ["dn-1"], depth: -1 } },
      { hostname: "dn-1", present: true, facts: { neighbours: ["darkweb"], depth: 0 } },
    ]);
    const later = NOW + msPerHostEvent("moved") * 100;
    const tasks = deriveTasks(knowledge, later, { agents: new Set(["darkweb"]) });
    // ...which is also the self-healing property: a worker that died mid-survey
    // left the fact stale, so the task simply reappears with no death detection.
    expect(tasks.some((t) => t.id === "survey:darkweb")).toBe(true);
    expect(tasks.find((t) => t.id === "survey:darkweb")!.reason).toBe("adjacency expired");
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
    knowledge = foldReports(knowledge, [{ hostname: "dn-1", at: NOW + 1, present: false }], NOW + 1).knowledge;
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
    expect(first?.reason).toBe("DefaultPassword candidate 1/4");

    // Walk the ledger to the end of the four-entry dictionary...
    knowledge.hosts["dn-1"]!.attempts = { modelId: "FreshInstall_1.0", tried: 4, probes: 0 };
    expect(deriveTasks(knowledge, NOW, opts).some((t) => t.kind === "attempt")).toBe(false);
  });

  test("an unsolved model gets one probe, and the probe outranks nothing", () => {
    // The probe exists only to make the oracle appear in the log ring. It buys
    // information, not a vantage, so it must not outrank a dictionary attack
    // that is a few calls from opening the net.
    const knowledge = fold([
      { hostname: "darkweb", present: true, facts: { neighbours: ["hard", "easy"], depth: -1 } },
      { hostname: "hard", present: true, facts: { depth: 0, modelId: "DeepGreen", passwordLength: 4, passwordFormat: "numeric" } },
      { hostname: "easy", present: true, facts: { depth: 0, modelId: "ZeroLogon" } },
    ]);
    const tasks = deriveTasks(knowledge, NOW, { agents: new Set(["darkweb"]) }).filter((t) => t.kind === "attempt");
    expect(tasks[0]!.host).toBe("easy");
    expect(tasks[1]!.host).toBe("hard");
    expect(tasks[1]!.reason).toBe("mastermind solver not written");

    // Once the probe is spent the ATTEMPT retires. The host still has other
    // work — its own adjacency is unknown — so the assertion is about attempts,
    // not about the host vanishing from the queue.
    knowledge.hosts["hard"]!.attempts = { modelId: "DeepGreen", tried: 0, probes: 1 };
    const after = deriveTasks(knowledge, NOW, { agents: new Set(["darkweb"]) });
    expect(after.some((t) => t.kind === "attempt" && t.host === "hard")).toBe(false);
    expect(after.some((t) => t.kind === "survey" && t.host === "hard")).toBe(true);
  });

  test("a plant outranks everything, because it is the only thing that grows the map", () => {
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
