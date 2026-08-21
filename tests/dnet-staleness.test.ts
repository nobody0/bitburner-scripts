import { describe, expect, test } from "bun:test";
import { DARKNET_CODES, LOCAL_CODES, codeName, stripCredentials } from "../shared/strategy/dnet/courier.ts";
import {
  jobIdFrom,
  overseerArgs,
  parseOverseerArgs,
  parseWorkerArgs,
  workerArgs,
} from "../shared/strategy/dnet/mission.ts";
import {
  FACT_CLASS,
  coverage,
  emptyKnowledge,
  expiryMs,
  foldReports,
  forgetMs,
  freeRam,
  fresh,
  isImmune,
  staleness,
} from "../shared/strategy/dnet/knowledge.ts";
import type { ReportHost } from "../shared/strategy/dnet/courier.ts";
import {
  JOB_TIMEOUT_MS,
  overseerIsLive,
  RENDEZVOUS_PROTOCOL,
  RESIDENT_BEAT_MS,
  RESIDENT_BEAT_MISSES,
  sweepQueues,
  type DnetHostQueue,
  type DnetJob,
  type DnetRendezvous,
} from "../game/dnet/realm.ts";
import { deriveTasks } from "../shared/strategy/dnet/queue.ts";
import { foldAttempts, type DarknetHostKnowledge } from "../shared/strategy/dnet/knowledge.ts";
import type { AttemptOutcome } from "../shared/strategy/dnet/courier.ts";
import { mutationIntervalMs, msPerHostEvent } from "../shared/strategy/dnet/rates.ts";

const GEN = "run-1";

/** One host as a job saw it. `at` is the observation time, which is the whole
 *  reason the fold can order two residents that ran seconds apart. */
function report(hostname: string, at: number, facts: Record<string, unknown> = {}): ReportHost {
  return { hostname, at, present: true, ...facts } as ReportHost;
}

function absent(hostname: string, at: number): ReportHost {
  return { hostname, at, present: false };
}

describe("darknet mutation rates, transcribed", () => {
  test("the net churns in seconds while a named host is stable for minutes", () => {
    // getDarknetCyclesPerMutation: (1 * 150 cycles) / depth at 200ms a cycle.
    expect(mutationIntervalMs(10, 15)).toBe(3_000);
    // Twice as slow outside its own BitNode.
    expect(mutationIntervalMs(10, 1)).toBe(6_000);
    // Faster the deeper the labyrinth goes.
    expect(mutationIntervalMs(40, 15)).toBeLessThan(mutationIntervalMs(10, 15));

    // But any ONE host is far more stable than the net, which is the whole
    // reason a per-host expiry is worth deriving rather than guessing.
    const perHost = msPerHostEvent("moved", 10, 15);
    expect(perHost).toBeGreaterThan(60_000);
  });

  test("backdooring makes the net measurably more violent", () => {
    // 10% restart and 5% delete branches only exist once something is
    // backdoored, so this is a real cost the API docs describe only as an
    // authentication penalty.
    expect(msPerHostEvent("deleted", 10, 15, 3))
      .toBeLessThan(msPerHostEvent("deleted", 10, 15, 0));
    expect(msPerHostEvent("restarted", 10, 15, 3))
      .toBeLessThan(msPerHostEvent("restarted", 10, 15, 0));
  });
});

describe("every fact carries an observation time", () => {
  test("the fold stamps the time the JOB looked, not the time home drained", () => {
    const { knowledge } = foldReports(
      emptyKnowledge(GEN),
      [report("dn-1", 1_000, { depth: 2, modelId: "TopPass" })],
      2_000,
    );
    const host = knowledge.hosts["dn-1"]!;
    expect(host.facts["depth"]).toEqual({ value: 2, at: 1_000 });
    expect(host.lastSeenAt).toBe(1_000);
  });

  test("identity facts never age out, topology facts do", () => {
    // A host's password format cannot change while the host lives; its
    // neighbour list is the first thing a mutation breaks.
    expect(FACT_CLASS["passwordFormat"]).toBe("identity");
    expect(FACT_CLASS["neighbours"]).toBe("topology");
    expect(expiryMs("identity")).toBe(Infinity);
    expect(expiryMs("topology")).toBeLessThan(expiryMs("position"));
  });

  test("a fact past its expiry is reported stale and refused to callers", () => {
    const { knowledge } = foldReports(
      emptyKnowledge(GEN),
      [report("dn-1", 0, { neighbours: ["dn-2"], modelId: "TopPass" })],
      0,
    );
    const host = knowledge.hosts["dn-1"]!;
    const beyond = expiryMs("topology") + 1;

    expect(staleness(host.facts["neighbours"], "neighbours", 0)!.stale).toBe(false);
    expect(fresh<string[]>(host, "neighbours", 0)).toEqual(["dn-2"]);

    expect(staleness(host.facts["neighbours"], "neighbours", beyond)!.stale).toBe(true);
    // Refused, but still HELD — a caller that wants to explain the refusal can
    // still read the raw fact and its age.
    expect(fresh<string[]>(host, "neighbours", beyond)).toBeUndefined();
    expect(host.facts["neighbours"]!.value).toEqual(["dn-2"]);
    // Identity survives the same passage of time.
    expect(fresh<string>(host, "modelId", beyond)).toBe("TopPass");
  });

  test("facts merge by observation time, not arrival order", () => {
    // Two residents adjacent to the same host, seconds apart, arriving in ONE
    // drain — which is exactly why the stamp has to be per host rather than per
    // batch. The newer sighting is listed first; the slow one must not win.
    const newer = report("dn-1", 5_000, { depth: 9 });
    const older = report("dn-1", 1_000, { depth: 1 });
    const { knowledge, superseded } = foldReports(emptyKnowledge(GEN), [newer, older], 6_000);
    expect(knowledge.hosts["dn-1"]!.facts["depth"]).toEqual({ value: 9, at: 5_000 });
    expect(superseded).toBeGreaterThan(0);
  });

  test("a future timestamp is clamped rather than trusted", () => {
    const { knowledge } = foldReports(emptyKnowledge(GEN), [report("dn-1", 999_999, { depth: 1 })], 1_000);
    // Otherwise a clock we do not control could make a fact immortal.
    expect(knowledge.hosts["dn-1"]!.facts["depth"]!.at).toBe(1_000);
  });
});

describe("a run from a dead world is refused at the channel", () => {
  // Agents outlive controllers — they survive a cold boot, a build handoff and a
  // page reload — so a live script from a dead run really can be talking to us.
  // The refusal belongs to the WHOLE rendezvous rather than to each fact: by the
  // time a report reaches the fold, the channel it arrived on has already been
  // accepted, and re-checking a value the caller just compared cannot fail.
  const rendezvous = (over: Partial<DnetRendezvous> = {}) => ({
    protocol: RENDEZVOUS_PROTOCOL,
    generation: GEN,
    controllerPid: 1,
    startedAt: 0,
    lastBeatAt: 1_000,
    ...over,
  } as DnetRendezvous);

  test("a foreign generation is not live however recently it beat", () => {
    expect(overseerIsLive(rendezvous(), GEN, 1_100)).toBe(true);
    expect(overseerIsLive(rendezvous({ generation: "run-0" }), GEN, 1_100)).toBe(false);
    // A protocol we do not speak is refused for the same reason.
    expect(overseerIsLive(rendezvous({ protocol: RENDEZVOUS_PROTOCOL + 1 }), GEN, 1_100)).toBe(false);
    expect(overseerIsLive(undefined, GEN, 1_100)).toBe(false);
  });
});

describe("a host outside the mutation clock never ages", () => {
  // getAllMovableDarknetServers skips isStationary and hasStasisLink servers,
  // and EVERY mutation branch draws from that pool — move, delete, disconnect
  // and restart alike. So immunity is not per fact class.
  test("darkweb is stationary, so its position never expires", () => {
    const { knowledge } = foldReports(
      emptyKnowledge(GEN),
      [report("darkweb", 0, { depth: -1, isStationary: true })],
      0,
    );
    const host = knowledge.hosts["darkweb"]!;
    expect(isImmune(host)).toBe(true);
    // Upstream raises rather than move darkweb; showing this expiring in a
    // minute was the bug that made the guard worth writing.
    const wayLater = expiryMs("position") * 100;
    expect(staleness(host.facts["depth"], "depth", wayLater, { immune: true })!.stale).toBe(false);
    expect(fresh<number>(host, "depth", wayLater)).toBe(-1);
  });

  test("a stasis link freezes a neighbour list, and releasing it thaws again", () => {
    const { knowledge } = foldReports(emptyKnowledge(GEN), [report("dn-1", 0, { neighbours: ["dn-2"] })], 0);
    const host = knowledge.hosts["dn-1"]!;
    const beyond = expiryMs("topology") + 1;
    const linked = { stasisLinked: new Set(["dn-1"]) };

    expect(isImmune(host, linked)).toBe(true);
    expect(fresh<string[]>(host, "neighbours", beyond, linked)).toEqual(["dn-2"]);
    // Released: it is an ordinary host again and the edge is the first thing to
    // go, exactly as before.
    expect(isImmune(host, { stasisLinked: new Set<string>() })).toBe(false);
    expect(fresh<string[]>(host, "neighbours", beyond)).toBeUndefined();
  });

  test("an immune host is never forgotten, because it is never deleted", () => {
    const { knowledge } = foldReports(
      emptyKnowledge(GEN),
      [report("darkweb", 0, { isStationary: true }), report("dn-1", 0, { depth: 1 })],
      0,
    );
    const later = forgetMs() + 1;
    const { knowledge: after, hostsForgotten } = foldReports(knowledge, [], later);
    expect(hostsForgotten).toEqual(["dn-1"]);
    expect(after.hosts["darkweb"]).toBeDefined();
  });
});

describe("a host that goes away is forgotten, not remembered for ever", () => {
  test("absence wipes identity, because a returning host is a new host", () => {
    const seen = report("dn-1", 1_000, { modelId: "TopPass", depth: 3 });
    const { knowledge } = foldReports(emptyKnowledge(GEN), [seen, absent("dn-1", 2_000)], 2_000);
    const host = knowledge.hosts["dn-1"]!;
    expect(host.goneAt).toBe(2_000);
    // Upstream, a server that reappears is cleaned and given a NEW password, so
    // keeping the old identity would be worse than knowing nothing.
    expect(host.facts).toEqual({});
    expect(fresh<string>(host, "modelId", 2_000)).toBeUndefined();
  });

  test("seeing it again overrides the note that it was gone", () => {
    const back = report("dn-1", 2_000, { depth: 4 });
    const { knowledge } = foldReports(emptyKnowledge(GEN), [absent("dn-1", 1_000), back], 2_000);
    expect(knowledge.hosts["dn-1"]!.goneAt).toBeUndefined();
    expect(fresh<number>(knowledge.hosts["dn-1"], "depth", 2_000)).toBe(4);
  });

  test("a host unseen past the forget window is dropped from the map", () => {
    const { knowledge: first } = foldReports(emptyKnowledge(GEN), [report("dn-1", 0, { depth: 1 })], 0);
    const later = forgetMs() + 1;
    const { knowledge, hostsForgotten } = foldReports(first, [], later);
    expect(hostsForgotten).toEqual(["dn-1"]);
    expect(knowledge.hosts["dn-1"]).toBeUndefined();
  });

  test("coverage separates what we hold from what we still believe", () => {
    const { knowledge } = foldReports(
      emptyKnowledge(GEN),
      [report("dn-1", 0, { neighbours: ["dn-2"], modelId: "TopPass" }), report("dn-2", 0, { modelId: "Laika4" })],
      0,
    );
    expect(coverage(knowledge, 0)).toMatchObject({ known: 2, adjacencyKnown: 1, freshFraction: 1 });
    // Later, the neighbour list is no longer believable but identity still is,
    // so coverage falls without collapsing.
    const after = coverage(knowledge, expiryMs("topology") + 1);
    expect(after.adjacencyKnown).toBe(0);
    expect(after.freshFraction).toBeLessThan(1);
    expect(after.freshFraction).toBeGreaterThan(0);
  });
});

describe("mission arguments", () => {
  test("mission args round-trip through their encoder, per role", () => {
    // The encoders exist so the launcher and the parser cannot drift: an agent
    // launched with the wrong positional order would fail silently at 3am on a
    // darknet host, which is the worst place to discover a typo.
    const worker = {
      missionId: "m-1",
      generation: GEN,
      identity: "identity-json",
      role: "resident" as const,
      agentId: "resident-dn-1",
    };
    expect(parseWorkerArgs(workerArgs(worker))).toEqual(worker);

    const overseer = {
      missionId: "m-1",
      generation: GEN,
      identity: "identity-json",
      charisma: 120,
      agentFile: "dnet/agent.abc123.js",
    };
    expect(parseOverseerArgs(overseerArgs(overseer))).toEqual(overseer);
  });

  test("a wrong argument shape exits quietly instead of crashing the game log", () => {
    expect(parseWorkerArgs(["only-one"])).toBeUndefined();
    // An unrecognised role is refused rather than coerced: an agent that does not
    // know what it is would take work it cannot perform.
    expect(parseWorkerArgs(["m", "g", "i", "saboteur", "a"])).toBeUndefined();
    expect(parseOverseerArgs(["m", "g", "i", "not-a-number", "f"])).toBeUndefined();
    expect(parseOverseerArgs(["m", "g", "i", 1])).toBeUndefined();
  });

  test("the job id is what selects an agent's MODE", () => {
    // One binary, two modes: absent it is the host's resident, present it is the
    // one job with that id. The same trick dodge-stub uses for its two lanes.
    const base = workerArgs({
      missionId: "m",
      generation: GEN,
      identity: "i",
      role: "resident",
      agentId: "a",
    });
    expect(jobIdFrom(base)).toBeUndefined();
    expect(jobIdFrom([...base, "survey:dn-1"])).toBe("survey:dn-1");
  });
});

describe("a credential is never written down", () => {
  /** Telemetry is mirrored over a socket and written to disk as JSONL, so a
   * password that gets through here outlives the run in a file nobody
   * remembers. The wire that used to carry these is gone — the darknet talks
   * through the page realm now — but the rule it enforced still needs exactly
   * one home, because the things being recorded are nested objects built from
   * log lines we did not write. */

  test("a nested password is stripped, not just a top-level one", () => {
    // An attempt carries an oracle, and an oracle is parsed out of a line that
    // may itself have contained a password. A strip that only reached the top
    // level would be reopened by the next field anyone added.
    const record = {
      hostname: "dn-1",
      present: true,
      attempts: [{ at: 1, status: "implemented", code: 401, password: "hunter2" }],
      nested: { deeper: { credential: "swordfish" } },
    };
    const serialised = JSON.stringify(stripCredentials(record));
    expect(serialised).not.toContain("hunter2");
    expect(serialised).not.toContain("swordfish");
    // ...and it takes nothing else with it.
    expect(serialised).toContain("dn-1");
    expect(serialised).toContain("401");
  });

  test("oracle output that is NOT a credential survives", () => {
    // `passwordExpected` is the buffer half of a Pr0verFl0 failure — what our
    // own attempt overwrote, not the server's secret. Stripping it would blind
    // the one model whose whole trick is reading that value back.
    const kept = stripCredentials({ passwordAttempted: "aaaa", passwordExpected: "####" });
    expect(JSON.stringify(kept)).toContain("####");
    expect(JSON.stringify(kept)).toContain("aaaa");
  });

  test("our own response codes are named and kept clear of the engine's", () => {
    expect(codeName(900)).toBe("UnknownModel");
    expect(codeName(903)).toBe("NotEnoughRam");
    // They must not collide with the engine's range, or a refusal would be
    // attributed to the wrong side of the boundary.
    for (const code of Object.keys(LOCAL_CODES)) {
      expect(Object.keys(DARKNET_CODES)).not.toContain(code);
      expect(Number(code)).toBeGreaterThan(599);
    }
    expect(codeName(451)).toBe("NotEnoughCharisma");
    // 408 is instability, not a wrong password — "the password may or may not
    // have been correct" — so any retry policy has to keep them apart.
    expect(codeName(408)).toBe("RequestTimeOut");
    expect(codeName(401)).toBe("AuthFailure");
    expect(Object.keys(DARKNET_CODES)).toHaveLength(11);
  });
});

describe("the facts the spreading agents added", () => {
  test("the new fact classes expire on the right clock", () => {
    expect(expiryMs("identity")).toBe(Infinity);
    // A session belongs to the PID that won it, so it is worthless the moment
    // its observer dies. The shortest expiry we have is the honest answer.
    expect(FACT_CLASS["hasSession"]).toBe("resource");
    expect(FACT_CLASS["usedRam"]).toBe("resource");
  });

  test("cracking progress is dropped when the host disappears", () => {
    // A host that comes back is CLEANED and given a new password upstream, so a
    // ledger saying "the first 40 candidates are ruled out" would be ruling out
    // candidates for a password that no longer exists.
    let knowledge = emptyKnowledge(GEN);
    knowledge = foldReports(knowledge, [report("dn-1", 1_000, { modelId: "TopPass" })], 1_000).knowledge;
    knowledge.hosts["dn-1"]!.attempts = { modelId: "TopPass", tried: 40, probes: 0 };
    knowledge.hosts["dn-1"]!.credentialKnown = true;

    const gone = foldReports(knowledge, [absent("dn-1", 2_000)], 2_000).knowledge;
    expect(gone.hosts["dn-1"]!.attempts).toBeUndefined();
    expect(gone.hosts["dn-1"]!.credentialKnown).toBeUndefined();
  });

  test("freeRam does not double-count owner-blocked RAM", () => {
    // Blocked RAM presents AS used RAM upstream: updateRamUsed(blockedRam) runs
    // at construction and again on every recalculation. A naive
    // max - blocked - used therefore subtracts the block twice and can go
    // negative on a host doing nothing wrong.
    const at = 1_000;
    const host = {
      hostname: "dn-1",
      lastSeenAt: at,
      facts: {
        maxRam: { value: 16, at },
        blockedRam: { value: 4, at },
        usedRam: { value: 4, at },
      },
    };
    expect(freeRam(host, at)).toBe(12);

    // ...but a host observed before updateRamUsed ran reports used < blocked,
    // and there the block really is unaccounted for.
    const early = {
      ...host,
      facts: { ...host.facts, usedRam: { value: 0, at } },
    };
    expect(freeRam(early, at)).toBe(12);

    // An unknown capacity must never read as "room for an agent".
    expect(freeRam(undefined, at)).toBe(0);
    expect(freeRam({ hostname: "x", lastSeenAt: at, facts: {} }, at)).toBe(0);
  });

  test("coverage separates what we opened from what we can actually stand on", () => {
    const at = 1_000;
    let knowledge = emptyKnowledge(GEN);
    knowledge = foldReports(
      knowledge,
      [
        report("roomy", at, { maxRam: 16, blockedRam: 0, usedRam: 0 }),
        // A big host can arrive with ALL of its RAM blocked, which is a
        // different problem from not having the password.
        report("blocked", at, { maxRam: 128, blockedRam: 128, usedRam: 128 }),
      ],
      at,
    ).knowledge;
    knowledge.hosts["roomy"]!.credentialKnown = true;
    knowledge.hosts["blocked"]!.credentialKnown = true;

    const cover = coverage(knowledge, at, {}, 2.6);
    expect(cover.cracked).toBe(2);
    expect(cover.plantable).toBe(1);
  });

});

describe("the sweep does not race a running job", () => {
  const BEAT_WINDOW = RESIDENT_BEAT_MS * RESIDENT_BEAT_MISSES;

  const job = (over: Partial<DnetJob> = {}): DnetJob => ({
    id: "survey:dn-1",
    kind: "survey",
    label: "test",
    budgetGb: 2.6,
    longLived: false,
    state: { host: "dn-1", from: "dn-1" },
    body: async () => ({ ok: true }),
    settle: () => {},
    fail: () => {},
    ...over,
  });

  const queueOf = (over: Partial<DnetHostQueue> = {}): Map<string, DnetHostQueue> =>
    new Map([["dn-1", { host: "dn-1", pending: [], lastBeatAt: 0, completed: 0, failed: 0, ...over }]]);

  test("an idle resident that stops beating is retired after three beats", () => {
    const queues = queueOf();
    expect(sweepQueues(queues, BEAT_WINDOW)).toHaveLength(0);
    expect(sweepQueues(queues, BEAT_WINDOW + 1)).toHaveLength(1);
    expect(queues.size).toBe(0);
  });

  test("an active job is evidence of life until its own timeout has passed", () => {
    // While a job runs the resident is dead BY DESIGN — spawn killed it — so
    // lastBeatAt freezes for the whole job. Sweeping on the beat window alone
    // retired any queue whose job outran three beats, losing the result of a
    // merely slow authenticate and miscounting it as a lost resident.
    const startedAt = 10_000;
    const queues = queueOf({ active: job({ startedAt }) });
    // Far past the beat window, well inside the job timeout: alive.
    expect(sweepQueues(queues, startedAt + JOB_TIMEOUT_MS)).toHaveLength(0);
    // The controller's own timeout loop fires at startedAt + JOB_TIMEOUT_MS, so
    // the sweep concedes it a full beat window before treating silence as death.
    expect(sweepQueues(queues, startedAt + JOB_TIMEOUT_MS + BEAT_WINDOW)).toHaveLength(0);
    expect(sweepQueues(queues, startedAt + JOB_TIMEOUT_MS + BEAT_WINDOW + 1)).toHaveLength(1);
  });

  test("a long-lived job holds its queue open indefinitely", () => {
    const queues = queueOf({ active: job({ startedAt: 0, longLived: true }) });
    expect(sweepQueues(queues, Number.MAX_SAFE_INTEGER)).toHaveLength(0);
  });
});

describe("a bleed leaves a mark, so the task stops re-deriving", () => {
  // The queue is DERIVED, and heartbleed with `peek` leaves the ring intact —
  // the game gives no signal that a host was just listened to. The controller's
  // own `lastBleedAt` stamp is therefore the only thing standing between one
  // bleed and an endless spawn/heartbleed/spawn loop on every held host.
  test("a fresh stamp suppresses the bleed; an expired one revives it", () => {
    // Late enough that the never-bled default of 0 reads as overdue.
    const at = expiryMs("topology") + 1_000;
    const { knowledge } = foldReports(emptyKnowledge(GEN), [report("dn-1", at, { depth: 1 })], at);
    const agents = new Set(["dn-1"]);
    const bleeds = (now: number) => deriveTasks(knowledge, now, { agents }).filter((t) => t.kind === "bleed");

    expect(bleeds(at)).toHaveLength(1);

    knowledge.hosts["dn-1"]!.facts["lastBleedAt"] = { value: true, at };
    expect(bleeds(at + 1)).toHaveLength(0);

    const expired = at + expiryMs("topology") + 1;
    expect(bleeds(expired)).toHaveLength(1);
  });
});

describe("the charisma gate withholds what heartbleed would refuse", () => {
  // `heartbleed` is the ONE charisma-gated call: below the host's requirement
  // it can only answer 451. A bleed below the gate is a wasted job, and a probe
  // attempt's whole payoff is the oracle heartbleed reads back — so both are
  // withheld until charisma catches up. Candidates are NOT gated: authenticate
  // has no charisma gate and a dictionary hit reports success in its return.
  const at = expiryMs("topology") + 1_000;

  test("bleeds derive only above the host's requirement — or when it is unknown", () => {
    const { knowledge } = foldReports(
      emptyKnowledge(GEN),
      [report("dn-1", at, { depth: 1, requiredCharisma: 120 })],
      at,
    );
    const agents = new Set(["dn-1"]);
    const bleeds = (charisma?: number) =>
      deriveTasks(knowledge, at, { agents, ...(charisma !== undefined ? { charisma } : {}) })
        .filter((t) => t.kind === "bleed");

    expect(bleeds(50)).toHaveLength(0);
    expect(bleeds(120)).toHaveLength(1);
    // No charisma supplied: nothing is gated (backward-compatible callers).
    expect(bleeds(undefined)).toHaveLength(1);

    // Requirement unknown: the refused call's own describeHost report is what
    // teaches us the number, so the first try IS the survey.
    const unknown = foldReports(emptyKnowledge(GEN), [report("dn-2", at, { depth: 1 })], at).knowledge;
    expect(
      deriveTasks(unknown, at, { agents: new Set(["dn-2"]), charisma: 1 }).filter((t) => t.kind === "bleed"),
    ).toHaveLength(1);
  });

  test("probe attempts are withheld below the gate; candidates are not", () => {
    const { knowledge } = foldReports(
      emptyKnowledge(GEN),
      [
        report("dn-0", at, { neighbours: ["probe-me", "dict-me"] }),
        // An unrecognised model plans a PROBE — its payoff is the oracle.
        report("probe-me", at, { depth: 1, modelId: "Mystery_9000", requiredCharisma: 120 }),
        // A dictionary model plans CANDIDATES — no oracle needed.
        report("dict-me", at, { depth: 1, modelId: "FreshInstall_1.0", requiredCharisma: 120 }),
      ],
      at,
    );
    const attempts = (charisma: number) =>
      deriveTasks(knowledge, at, { agents: new Set(["dn-0"]), charisma }).filter((t) => t.kind === "attempt");

    expect(attempts(50).map((t) => t.host)).toEqual(["dict-me"]);
    expect(attempts(200).map((t) => t.host).sort()).toEqual(["dict-me", "probe-me"]);
  });
});

describe("home and the controller count an attempt the same way", () => {
  // One helper folds attempt outcomes on both sides of the drain, so the ledger
  // that drives planAttempt and the ledger the panel shows can never disagree.
  test("candidates advance the tried count, probes only accumulate", () => {
    const host: DarknetHostKnowledge = { hostname: "dn-1", lastSeenAt: 0, facts: {} };
    const outcome = (over: Partial<AttemptOutcome> = {}): AttemptOutcome => ({
      at: 1_000,
      modelId: "TopPass",
      status: "implemented",
      code: 401,
      success: false,
      ...over,
    });

    foldAttempts(host, [outcome({ candidateIndex: 0 })]);
    expect(host.attempts).toMatchObject({ modelId: "TopPass", tried: 1, probes: 0, lastCode: 401 });

    foldAttempts(host, [outcome({ candidateIndex: 1 }), outcome({ status: "unattempted", candidateIndex: undefined })]);
    expect(host.attempts).toMatchObject({ tried: 2, probes: 1 });

    foldAttempts(host, [outcome({ candidateIndex: 2, code: 200, success: true })]);
    expect(host.attempts).toMatchObject({ tried: 3, solved: true, lastCode: 200 });

    // A missing host is a host that disappeared between the job and the drain:
    // nothing to count against.
    expect(() => foldAttempts(undefined, [outcome()])).not.toThrow();
  });

  test("a gone host's ledger stays dropped", () => {
    // The fold discards cracking progress when a host disappears, because a
    // returning host is a new host with a new password. An attempt outcome that
    // lands in the same drain as the gone report — the job saw the host die —
    // must not resurrect counts that belong to the dead identity.
    const gone: DarknetHostKnowledge = { hostname: "dn-2", lastSeenAt: 0, goneAt: 5_000, facts: {} };
    foldAttempts(gone, [{
      at: 6_000,
      modelId: "TopPass",
      status: "implemented",
      code: 401,
      success: false,
      candidateIndex: 0,
    }]);
    expect(gone.attempts).toBeUndefined();
  });
});
