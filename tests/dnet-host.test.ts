import { describe, expect, test } from "bun:test";
import type { ReportHost, AttemptOutcome } from "../shared/strategy/dnet/courier.ts";
import {
  compareDepthDesc,
  coverage,
  emptyHost,
  expiryMs,
  fieldGroup,
  foldAttempts,
  foldLogDrain,
  foldReports,
  forgetMs,
  freeRam,
  fresh,
  groupFresh,
  groupStaleness,
  isImmune,
  markCredentialKnown,
  planningView,
  stormWipe,
  type DnetHost,
  type DnetHosts,
} from "../shared/strategy/dnet/host.ts";
import { mutationIntervalMs, msPerHostEvent } from "../shared/strategy/dnet/rates.ts";

/** One host as a job saw it. `at` is the observation time, which is the whole
 *  reason the fold can order two residents that ran seconds apart. */
function report(hostname: string, at: number, facts: Record<string, unknown> = {}): ReportHost {
  return { hostname, at, present: true, ...facts } as ReportHost;
}

function absent(hostname: string, at: number): ReportHost {
  return { hostname, at, present: false };
}

function mapOf(...reports: ReportHost[]): DnetHosts {
  const hosts: DnetHosts = new Map();
  const now = Math.max(0, ...reports.map((r) => r.at));
  foldReports(hosts, reports, now);
  return hosts;
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
    expect(msPerHostEvent("deleted", 10, 15, 3))
      .toBeLessThan(msPerHostEvent("deleted", 10, 15, 0));
    expect(msPerHostEvent("restarted", 10, 15, 3))
      .toBeLessThan(msPerHostEvent("restarted", 10, 15, 0));
  });
});

describe("every group carries an observation time", () => {
  test("the fold stamps the time the JOB looked, not the time home drained", () => {
    const hosts: DnetHosts = new Map();
    foldReports(hosts, [report("dn-1", 1_000, { depth: 2, modelId: "TopPass" })], 2_000);
    const host = hosts.get("dn-1")!;
    expect(host.depth).toBe(2);
    expect(host.seenAt.position).toBe(1_000);
    expect(host.modelId).toBe("TopPass");
    expect(host.identitySeenAt).toBe(1_000);
    expect(host.lastSeenAt).toBe(1_000);
  });

  test("identity fields never age out, topology fields do", () => {
    // A host's password format cannot change while the host lives; its
    // neighbour list is the first thing a mutation breaks.
    expect(fieldGroup("passwordFormat")).toBe("identity");
    expect(fieldGroup("neighbours")).toBe("topology");
    expect(expiryMs("identity")).toBe(Infinity);
    expect(expiryMs("topology")).toBeLessThan(expiryMs("position"));
  });

  test("a group past its expiry is reported stale and refused to callers", () => {
    const hosts = mapOf(report("dn-1", 0, { neighbours: ["dn-2"], modelId: "TopPass" }));
    const host = hosts.get("dn-1")!;
    const beyond = expiryMs("topology") + 1;

    expect(groupStaleness(host, "topology", 0)!.stale).toBe(false);
    expect(fresh<string[]>(host, "neighbours", 0)).toEqual(["dn-2"]);

    expect(groupStaleness(host, "topology", beyond)!.stale).toBe(true);
    // Refused, but still HELD — a caller that wants to explain the refusal can
    // still read the raw field and its age.
    expect(fresh<string[]>(host, "neighbours", beyond)).toBeUndefined();
    expect(host.neighbours).toEqual(["dn-2"]);
    // ...and planningView strips it so planners see unknown.
    expect(planningView(host, beyond).neighbours).toBeUndefined();
    // Identity survives the same passage of time.
    expect(fresh<string>(host, "modelId", beyond)).toBe("TopPass");
    expect(planningView(host, beyond).modelId).toBe("TopPass");
  });

  test("groups merge by observation time, not arrival order", () => {
    // Two residents adjacent to the same host, seconds apart, arriving in ONE
    // drain — which is exactly why the stamp has to be per host rather than per
    // batch. The newer sighting is listed first; the slow one must not win.
    const hosts: DnetHosts = new Map();
    const newer = report("dn-1", 5_000, { depth: 9 });
    const older = report("dn-1", 1_000, { depth: 1 });
    const { superseded } = foldReports(hosts, [newer, older], 6_000);
    expect(hosts.get("dn-1")!.depth).toBe(9);
    expect(hosts.get("dn-1")!.seenAt.position).toBe(5_000);
    expect(superseded).toBeGreaterThan(0);
  });

  test("a dirty group reads unknown until its refresh channel clears it", () => {
    const hosts = mapOf(report("dn-1", 1_000, { depth: 3, blockedRam: 4, usedRam: 4, maxRam: 16 }));
    const host = hosts.get("dn-1")!;
    expect(fresh<number>(host, "blockedRam", 1_000)).toBe(4);

    // The controller marks ram dirty — our own reclaim just changed it.
    host.dirty.ram = true;
    expect(groupFresh(host, "ram", 1_000)).toBe(false);
    expect(fresh<number>(host, "blockedRam", 1_000)).toBeUndefined();
    expect(planningView(host, 1_000).blockedRam).toBeUndefined();
    // Position is untouched.
    expect(fresh<number>(host, "depth", 1_000)).toBe(3);

    // A newer observation through the group's channel clears the bit.
    foldReports(hosts, [report("dn-1", 2_000, { blockedRam: 2, usedRam: 2 })], 2_000);
    expect(host.dirty.ram).toBeUndefined();
    expect(fresh<number>(host, "blockedRam", 2_000)).toBe(2);
  });

  test("an IP change replaces the whole server lifetime, and a late old IP cannot replace it back", () => {
    const hosts = mapOf(report("dn-1", 1_000, { identity: "10.0.0.1", modelId: "TopPass", depth: 1 }));
    const old = hosts.get("dn-1")!;
    old.attempts = { tried: 3, probes: 0 };
    old.ring = { pendingAuthRecords: 2 };
    old.credentialKnown = true;

    const replaced = foldReports(
      hosts,
      [report("dn-1", 2_000, { identity: "10.0.0.2", modelId: "DeskMemo_3.1", depth: 4 })],
      2_000,
    );
    expect(replaced.hostsReplaced).toEqual(["dn-1"]);
    const host = hosts.get("dn-1")!;
    // The record object survives — runtime fields hang off it — but the
    // knowledge belongs to the new lifetime.
    expect(host).toBe(old);
    expect(host.identity).toBe("10.0.0.2");
    expect(host.modelId).toBe("DeskMemo_3.1");
    expect(host.depth).toBe(4);
    expect(host.attempts).toBeUndefined();
    expect(host.ring).toBeUndefined();
    expect(host.credentialKnown).toBeUndefined();

    const late = foldReports(
      hosts,
      [report("dn-1", 1_500, { identity: "10.0.0.1", modelId: "TopPass", depth: 9 })],
      3_000,
    );
    expect(late.hostsReplaced).toEqual([]);
    expect(hosts.get("dn-1")!.identity).toBe("10.0.0.2");
    expect(fresh<number>(hosts.get("dn-1"), "depth", 3_000)).toBe(4);
  });

  test("an absence older than the newest sighting cannot delete the live host", () => {
    const hosts = mapOf(report("dn-1", 2_000, { identity: "10.0.0.2", depth: 2 }));
    foldReports(hosts, [absent("dn-1", 1_000)], 3_000);
    expect(hosts.get("dn-1")!.goneAt).toBeUndefined();
    expect(hosts.get("dn-1")!.identity).toBe("10.0.0.2");
  });

  test("a future timestamp is clamped rather than trusted", () => {
    const hosts: DnetHosts = new Map();
    foldReports(hosts, [report("dn-1", 999_999, { depth: 1 })], 1_000);
    // Otherwise a clock we do not control could make a fact immortal.
    expect(hosts.get("dn-1")!.seenAt.position).toBe(1_000);
  });
});

describe("host immunity freezes its lifetime, not its neighbours", () => {
  // getAllMovableDarknetServers skips isStationary and hasStasisLink servers,
  // and EVERY mutation branch draws its victim from that pool. The host itself
  // is immutable, but mutable neighbours can still invalidate its edge list.
  test("darkweb is stationary, so its position never expires", () => {
    const hosts = mapOf(report("darkweb", 0, { depth: -1, isStationary: true }));
    const host = hosts.get("darkweb")!;
    expect(isImmune(host)).toBe(true);
    // Upstream raises rather than move darkweb; showing this expiring in a
    // minute was the bug that made the guard worth writing.
    const wayLater = expiryMs("position") * 100;
    expect(groupStaleness(host, "position", wayLater, { immune: true })!.stale).toBe(false);
    expect(fresh<number>(host, "depth", wayLater)).toBe(-1);
  });

  test("a stasis link freezes position, but its neighbours can still change", () => {
    const hosts = mapOf(report("dn-1", 0, { neighbours: ["dn-2"], depth: 3 }));
    const host = hosts.get("dn-1")!;
    const beyond = expiryMs("topology") + 1;
    const linked = { stasisLinked: new Set(["dn-1"]) };

    expect(isImmune(host, linked)).toBe(true);
    expect(fresh<string[]>(host, "neighbours", beyond, linked)).toBeUndefined();
    // ...while its pinned position holds.
    const wayLater = expiryMs("position") * 100;
    expect(fresh<number>(host, "depth", wayLater, linked)).toBe(3);
    // Released: it remains stale, and its position resumes ageing too.
    expect(isImmune(host, { stasisLinked: new Set<string>() })).toBe(false);
    expect(fresh<string[]>(host, "neighbours", beyond)).toBeUndefined();
    expect(fresh<number>(host, "depth", wayLater)).toBeUndefined();
  });

  test("an immune host is never forgotten, because it is never deleted", () => {
    const hosts = mapOf(
      report("darkweb", 0, { isStationary: true }),
      report("dn-1", 0, { depth: 1 }),
    );
    const later = forgetMs() + 1;
    const { hostsForgotten } = foldReports(hosts, [], later);
    expect(hostsForgotten).toEqual(["dn-1"]);
    expect(hosts.get("darkweb")).toBeDefined();
  });
});

describe("a host that goes away is forgotten, not remembered for ever", () => {
  test("absence wipes identity, because a returning host is a new host", () => {
    const hosts: DnetHosts = new Map();
    foldReports(hosts, [
      report("dn-1", 1_000, { modelId: "TopPass", depth: 3 }),
      absent("dn-1", 2_000),
    ], 2_000);
    const host = hosts.get("dn-1")!;
    expect(host.goneAt).toBe(2_000);
    // Upstream, a server that reappears is cleaned and given a NEW password, so
    // keeping the old identity would be worse than knowing nothing.
    expect(host.modelId).toBeUndefined();
    expect(host.depth).toBeUndefined();
    expect(fresh<string>(host, "modelId", 2_000)).toBeUndefined();
  });

  test("seeing it again overrides the note that it was gone", () => {
    const hosts: DnetHosts = new Map();
    foldReports(hosts, [absent("dn-1", 1_000), report("dn-1", 2_000, { depth: 4 })], 2_000);
    expect(hosts.get("dn-1")!.goneAt).toBeUndefined();
    expect(fresh<number>(hosts.get("dn-1"), "depth", 2_000)).toBe(4);
  });

  test("a host unseen past the forget window is dropped from the map", () => {
    const hosts = mapOf(report("dn-1", 0, { depth: 1 }));
    const later = forgetMs() + 1;
    const { hostsForgotten } = foldReports(hosts, [], later);
    expect(hostsForgotten).toEqual(["dn-1"]);
    expect(hosts.get("dn-1")).toBeUndefined();
  });

  test("coverage separates what we hold from what we still believe", () => {
    const hosts = mapOf(
      report("dn-1", 0, { neighbours: ["dn-2"], modelId: "TopPass" }),
      report("dn-2", 0, { modelId: "Laika4" }),
    );
    expect(coverage(hosts, 0)).toMatchObject({ known: 2, adjacencyKnown: 1, freshFraction: 1 });
    // Later, the neighbour list is no longer believable but identity still is,
    // so coverage falls without collapsing.
    const after = coverage(hosts, expiryMs("topology") + 1);
    expect(after.adjacencyKnown).toBe(0);
    expect(after.freshFraction).toBeLessThan(1);
    expect(after.freshFraction).toBeGreaterThan(0);
  });
});

describe("a storm wipes what it can reach, the moment we believe it is over", () => {
  test("a movable host keeps identity and the ledger, loses position, topology, ram and files", () => {
    const hosts = mapOf(report("dn-1", 1_000, {
      identity: "10.0.0.1", modelId: "TopPass", difficulty: 4, maxRam: 32,
      depth: 5, neighbours: ["dn-2"], blockedRam: 8, usedRam: 8,
      caches: ["a.cache"], contracts: [], stormSeed: false,
    }));
    const before = hosts.get("dn-1")!;
    before.attempts = { tried: 7, probes: 1 };
    before.ring = { pendingAuthRecords: 3 };
    before.credentialKnown = true;

    const after = stormWipe(hosts).get("dn-1")!;
    expect(after.modelId).toBe("TopPass");
    expect(after.maxRam).toBe(32);
    expect(after.identity).toBe("10.0.0.1");
    expect(after.attempts).toEqual({ tried: 7, probes: 1 });
    expect(after.credentialKnown).toBe(true);
    expect(after.depth).toBeUndefined();
    expect(after.neighbours).toBeUndefined();
    expect(after.blockedRam).toBeUndefined();
    expect(after.caches).toBeUndefined();
    expect(after.stormSeed).toBeUndefined();
    // The log ring goes with the restart; the attempt ledger does not.
    expect(after.ring).toBeUndefined();
    // Everything wiped is marked dirty so a survey has to re-earn it.
    expect(after.dirty).toEqual({ position: true, topology: true, ram: true, files: true });
  });

  test("stasis-linked and stationary hosts keep everything", () => {
    const hosts = mapOf(
      report("lab", 1_000, { isStationary: true, depth: 7, neighbours: ["dn-1"] }),
      report("pinned", 1_000, { depth: 9, neighbours: ["dn-2"], caches: ["x.cache"] }),
    );
    const wiped = stormWipe(hosts, { stasisLinked: new Set(["pinned"]) });
    // Kept by reference: the storm cannot touch them at all.
    expect(wiped.get("lab")).toBe(hosts.get("lab")!);
    expect(wiped.get("pinned")).toBe(hosts.get("pinned")!);
    expect(wiped.get("pinned")!.caches).toEqual(["x.cache"]);
  });

  test("the function is pure", () => {
    const hosts = mapOf(report("dn-1", 1_000, { depth: 5, neighbours: ["dn-2"] }));
    const snapshot = JSON.stringify([...hosts.entries()]);
    stormWipe(hosts);
    expect(JSON.stringify([...hosts.entries()])).toBe(snapshot);
  });
});

describe("the fields the spreading agents added", () => {
  test("unclassified fields do not exist: every reportable field has a group", () => {
    // The old model defaulted unknown fact names to the shortest expiry. A flat
    // record cannot carry an unclassified field at all — a new field must be
    // placed in a group at its declaration site — so the check becomes: the
    // fold only moves fields the groups name.
    expect(fieldGroup("usedRam")).toBe("ram");
    expect(fieldGroup("hasSession")).toBeUndefined();
    expect(fieldGroup("stormSeed")).toBe("files");
  });

  test("cracking progress is dropped when the host disappears", () => {
    const hosts = mapOf(report("dn-1", 1_000, { modelId: "TopPass" }));
    hosts.get("dn-1")!.attempts = { modelId: "TopPass", tried: 40, probes: 0 };
    hosts.get("dn-1")!.credentialKnown = true;

    foldReports(hosts, [absent("dn-1", 2_000)], 2_000);
    expect(hosts.get("dn-1")!.attempts).toBeUndefined();
    expect(hosts.get("dn-1")!.credentialKnown).toBeUndefined();
  });

  test("freeRam does not double-count owner-blocked RAM", () => {
    // Blocked RAM presents AS used RAM upstream: updateRamUsed(blockedRam) runs
    // at construction and again on every recalculation. A naive
    // max - blocked - used therefore subtracts the block twice and can go
    // negative on a host doing nothing wrong.
    const at = 1_000;
    const hosts = mapOf(report("dn-1", at, { maxRam: 16, blockedRam: 4, usedRam: 4 }));
    expect(freeRam(hosts.get("dn-1"), at)).toBe(12);

    // ...but a host observed before updateRamUsed ran reports used < blocked,
    // and there the block really is unaccounted for.
    const early = mapOf(report("dn-1", at, { maxRam: 16, blockedRam: 4, usedRam: 0 }));
    expect(freeRam(early.get("dn-1"), at)).toBe(12);

    // An unknown capacity must never read as "room for an agent" — and neither
    // may a known capacity whose ram group has gone stale or dirty.
    expect(freeRam(undefined, at)).toBe(0);
    expect(freeRam(emptyHost("x", at), at)).toBe(0);
    const stale = mapOf(report("dn-1", at, { maxRam: 16, blockedRam: 0, usedRam: 0 }));
    expect(freeRam(stale.get("dn-1"), at + expiryMs("ram") + 1)).toBe(0);
    stale.get("dn-1")!.dirty.ram = true;
    expect(freeRam(stale.get("dn-1"), at)).toBe(0);
  });

  test("coverage separates what we opened from what we can actually stand on", () => {
    const at = 1_000;
    const hosts = mapOf(
      report("roomy", at, { maxRam: 16, blockedRam: 0, usedRam: 0 }),
      // A big host can arrive with ALL of its RAM blocked, which is a
      // different problem from not having the password.
      report("blocked", at, { maxRam: 128, blockedRam: 128, usedRam: 128 }),
    );
    hosts.get("roomy")!.credentialKnown = true;
    hosts.get("blocked")!.credentialKnown = true;

    const cover = coverage(hosts, at, {}, 2.6);
    expect(cover.cracked).toBe(2);
    expect(cover.plantable).toBe(1);
  });

  test("deepest first, unplaceable last", () => {
    expect([3, undefined, 9, 1].sort(compareDepthDesc)).toEqual([9, 3, 1, undefined]);
  });
});

describe("home and the controller count an attempt the same way", () => {
  // One helper folds attempt outcomes on both sides of the drain, so the ledger
  // that drives attempt planning and the ledger the panel shows can never
  // disagree.
  test("only conclusive candidates and probes advance their counters", () => {
    const host: DnetHost = emptyHost("dn-1", 0);
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
    const gone: DnetHost = { ...emptyHost("dn-2", 0), goneAt: 5_000 };
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
    const host: DnetHost = {
      ...emptyHost("dn-3", 0),
      attempts: { tried: 20, probes: 2, history: [] },
      ring: { pendingAuthRecords: 1, lastBleedAt: 5_000 },
    };
    markCredentialKnown(host);
    expect(host.credentialKnown).toBe(true);
    expect(host.attempts).toBeUndefined();
    expect(host.ring).toEqual({ pendingAuthRecords: 1, lastBleedAt: 5_000 });
  });

  test("failed and successful reads fold their distinct timestamps monotonically", () => {
    const hosts = mapOf(report("dn-1", 1_000, { depth: 1 }));
    foldLogDrain(hosts.get("dn-1"), {
      pendingAuthRecords: 2,
      evidence: [],
      attemptedAt: 2_000,
    });
    foldLogDrain(hosts.get("dn-1"), {
      pendingAuthRecords: 0,
      evidence: [],
      attemptedAt: 3_000,
      drainedAt: 3_100,
    });
    expect(hosts.get("dn-1")!.ring).toMatchObject({
      lastBleedAttemptAt: 3_000,
      lastBleedAt: 3_100,
    });
  });
});
