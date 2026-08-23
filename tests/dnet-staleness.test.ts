import { describe, expect, test } from "bun:test";
import type { NS } from "@ns";
import { DARKNET_CODES, LOCAL_CODES, codeName, stripCredentials } from "../shared/strategy/dnet/courier.ts";
import {
  FACT_CLASS,
  coverage,
  emptyKnowledge,
  expiryMs,
  foldLogDrain,
  foldReports,
  forgetMs,
  freeRam,
  fresh,
  isImmune,
  markCredentialKnown,
  staleness,
} from "../shared/strategy/dnet/knowledge.ts";
import type { ReportHost } from "../shared/strategy/dnet/courier.ts";
import { deriveTasks } from "../shared/strategy/dnet/queue.ts";
import { foldAttempts, type DarknetHostKnowledge } from "../shared/strategy/dnet/knowledge.ts";
import type { AttemptOutcome } from "../shared/strategy/dnet/courier.ts";
import { mutationIntervalMs, msPerHostEvent } from "../shared/strategy/dnet/rates.ts";

/** NOTE: the runtime blocks that once lived here — the resident beat sweep,
 * `nextJob`, the single-controller election, and the mutation-triggered edge/pin
 * retirement — moved into `game/dnet/controller.ts` when the overseer/realm/jobs
 * split was replaced by the controller/agent protocol. Their end-to-end
 * behavior is now exercised by `sim/tests/dnet-session.test.ts` and the agent
 * lifecycle by `tests/dnet-hard-cancel.test.ts`. What remains here is the
 * knowledge fold and the derived-queue behavior, which are still pure. */

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

  test("an IP change replaces the whole server lifetime, and a late old IP cannot replace it back", () => {
    let knowledge = foldReports(
      emptyKnowledge(GEN),
      [report("dn-1", 1_000, { identity: "10.0.0.1", modelId: "TopPass", depth: 1 })],
      1_000,
    ).knowledge;
    const old = knowledge.hosts["dn-1"]!;
    old.attempts = { tried: 3, probes: 0 };
    old.ring = { pendingAuthRecords: 2 };
    old.credentialKnown = true;

    const replaced = foldReports(
      knowledge,
      [report("dn-1", 2_000, { identity: "10.0.0.2", modelId: "DeskMemo_3.1", depth: 4 })],
      2_000,
    );
    knowledge = replaced.knowledge;
    expect(replaced.hostsReplaced).toEqual(["dn-1"]);
    expect(knowledge.hosts["dn-1"]).toMatchObject({
      identity: "10.0.0.2",
      facts: { modelId: { value: "DeskMemo_3.1", at: 2_000 } },
    });
    expect(knowledge.hosts["dn-1"]!.attempts).toBeUndefined();
    expect(knowledge.hosts["dn-1"]!.ring).toBeUndefined();
    expect(knowledge.hosts["dn-1"]!.credentialKnown).toBeUndefined();

    const late = foldReports(
      knowledge,
      [report("dn-1", 1_500, { identity: "10.0.0.1", modelId: "TopPass", depth: 9 })],
      3_000,
    );
    expect(late.hostsReplaced).toEqual([]);
    expect(late.knowledge.hosts["dn-1"]!.identity).toBe("10.0.0.2");
    expect(fresh<number>(late.knowledge.hosts["dn-1"], "depth", 3_000)).toBe(4);
  });

  test("an absence older than the newest sighting cannot delete the live host", () => {
    const knowledge = foldReports(
      emptyKnowledge(GEN),
      [report("dn-1", 2_000, { identity: "10.0.0.2", depth: 2 })],
      2_000,
    ).knowledge;
    const late = foldReports(knowledge, [absent("dn-1", 1_000)], 3_000).knowledge;
    expect(late.hosts["dn-1"]!.goneAt).toBeUndefined();
    expect(late.hosts["dn-1"]!.identity).toBe("10.0.0.2");
  });

  test("a future timestamp is clamped rather than trusted", () => {
    const { knowledge } = foldReports(emptyKnowledge(GEN), [report("dn-1", 999_999, { depth: 1 })], 1_000);
    // Otherwise a clock we do not control could make a fact immortal.
    expect(knowledge.hosts["dn-1"]!.facts["depth"]!.at).toBe(1_000);
  });
});

describe("host immunity freezes its lifetime, not its neighbours", () => {
  // getAllMovableDarknetServers skips isStationary and hasStasisLink servers,
  // and EVERY mutation branch draws its victim from that pool. The host itself
  // is immutable, but mutable neighbours can still invalidate its edge list.
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

  test("a stasis link freezes position, but its neighbours can still change", () => {
    const { knowledge } = foldReports(emptyKnowledge(GEN), [report("dn-1", 0, { neighbours: ["dn-2"] })], 0);
    const host = knowledge.hosts["dn-1"]!;
    const beyond = expiryMs("topology") + 1;
    const linked = { stasisLinked: new Set(["dn-1"]) };

    expect(isImmune(host, linked)).toBe(true);
    expect(fresh<string[]>(host, "neighbours", beyond, linked)).toBeUndefined();
    // Released: it remains stale, and its position resumes ageing too.
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
  });
});

describe("the facts the spreading agents added", () => {
  test("the new fact classes expire on the right clock", () => {
    expect(expiryMs("identity")).toBe(Infinity);
    // A session belongs to the PID that won it, so it is worthless the moment
    // its observer dies. The shortest expiry we have is the honest answer.
    expect(FACT_CLASS["hasSession"]).toBeUndefined();
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

describe("target-owned bleed scheduling", () => {
  test("pending records derive one serialized full-ring drain", () => {
    const at = 100_000;
    const { knowledge } = foldReports(emptyKnowledge(GEN), [report("dn-1", at, { depth: 1 })], at);
    const agents = new Set(["dn-1"]);
    const tasks = () => deriveTasks(knowledge, at, {
      agents,
      guesses: [{ host: "dn-1", id: "leak", reason: "compatible leaked password" }],
    });

    expect(tasks().filter((task) => task.kind === "bleed")).toHaveLength(0);
    knowledge.hosts["dn-1"]!.attempts = { tried: 1, probes: 0 };
    knowledge.hosts["dn-1"]!.ring = { pendingAuthRecords: 2 };
    const pending = tasks();
    expect(pending.filter((task) => task.kind === "bleed")).toHaveLength(1);
    expect(pending.find((task) => task.kind === "bleed")?.reason).toContain("2 authentication log record");
    expect(pending.filter((task) => task.kind === "attempt")).toHaveLength(0);
  });

  test("initial reads happen once per identity; elapsed time cannot materialize Netscript-visible logs", () => {
    const at = 100_000;
    const knowledge = foldReports(emptyKnowledge(GEN), [
      report("dn-1", at, { depth: 1, neighbours: ["dn-2"], logTrafficInterval: 2 }),
      report("dn-2", at, { depth: 2 }),
    ], at).knowledge;
    const opts = { agents: new Set(["dn-1"]), vault: new Set(["dn-1"]) };
    knowledge.hosts["dn-1"]!.attempts = { tried: 0, probes: 0 };
    expect(deriveTasks(knowledge, at, opts).find((task) => task.kind === "bleed")?.reason)
      .toContain("initial log ring");
    knowledge.hosts["dn-1"]!.ring = {
      pendingAuthRecords: 0,
      lastBleedAt: at - 40_000,
      lastBleedAttemptAt: at - 40_000,
    };
    expect(deriveTasks(knowledge, at, opts).some((task) => task.id === "bleed:dn-1")).toBe(false);
  });

  test("failed and successful reads fold their distinct timestamps monotonically", () => {
    const host = report("dn-1", 1_000, { depth: 1 });
    const knowledge = foldReports(emptyKnowledge(GEN), [host], 1_000).knowledge;
    foldLogDrain(knowledge.hosts["dn-1"], {
      pendingAuthRecords: 2,
      evidence: [],
      attemptedAt: 2_000,
    });
    foldLogDrain(knowledge.hosts["dn-1"], {
      pendingAuthRecords: 0,
      evidence: [],
      attemptedAt: 3_000,
      drainedAt: 3_100,
    });
    expect(knowledge.hosts["dn-1"]!.ring).toMatchObject({
      lastBleedAttemptAt: 3_000,
      lastBleedAt: 3_100,
    });
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
      [report("dn-1", at, { depth: 1, requiredCharisma: 120, logTrafficInterval: 1 })],
      at,
    );
    const agents = new Set(["dn-1"]);
    knowledge.hosts["dn-1"]!.attempts = { tried: 1, probes: 0 };
    knowledge.hosts["dn-1"]!.ring = { pendingAuthRecords: 1 };
    const bleeds = (charisma?: number) =>
      deriveTasks(knowledge, at, { agents, ...(charisma !== undefined ? { charisma } : {}) })
        .filter((t) => t.kind === "bleed");

    expect(bleeds(50)).toHaveLength(0);
    expect(bleeds(120)).toHaveLength(1);
    // No charisma supplied: nothing is gated (backward-compatible callers).
    expect(bleeds(undefined)).toHaveLength(1);

    // Requirement unknown: the refused call's own describeHost report is what
    // teaches us the number, so the first try IS the survey.
    const unknown = foldReports(
      emptyKnowledge(GEN),
      [report("dn-2", at, { depth: 1, logTrafficInterval: 1 })],
      at,
    ).knowledge;
    unknown.hosts["dn-2"]!.attempts = { tried: 1, probes: 0 };
    unknown.hosts["dn-2"]!.ring = { pendingAuthRecords: 1 };
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
  test("only conclusive candidates and probes advance their counters", () => {
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

    foldAttempts(host, [
      outcome({ candidateIndex: 1 }),
      outcome({
        status: "unattempted",
        candidateIndex: undefined,
        oracle: { kind: "oracle", passwordAttempted: "x", code: 401 },
      }),
    ]);
    expect(host.attempts).toMatchObject({ tried: 2, probes: 1 });

    foldAttempts(host, [outcome({ candidateIndex: 2, code: 408, disposition: "transient" })]);
    expect(host.attempts).toMatchObject({ tried: 2, probes: 1, lastCode: 408 });

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

  test("verifying a credential prunes cracking history but preserves ring scheduling", () => {
    const host: DarknetHostKnowledge = {
      hostname: "dn-3",
      lastSeenAt: 0,
      facts: {},
      attempts: { tried: 20, probes: 2, history: [] },
      ring: { pendingAuthRecords: 1, lastBleedAt: 5_000 },
    };
    markCredentialKnown(host);
    expect(host.credentialKnown).toBe(true);
    expect(host.attempts).toBeUndefined();
    expect(host.ring).toEqual({ pendingAuthRecords: 1, lastBleedAt: 5_000 });
  });
});
