import { describe, expect, test } from "bun:test";
import {
  DARKNET_CODES,
  REPORT_MAX_HINT_CHARS,
  REPORT_MAX_HOSTS,
  REPORT_VERSION,
  codeName,
  decodeReport,
  encodeReport,
  observationOf,
  type DnetReport,
} from "../shared/strategy/dnet/courier.ts";
import { parseMissionArgs } from "../shared/strategy/dnet/mission.ts";
import {
  FACT_CLASS,
  coverage,
  emptyKnowledge,
  expiryMs,
  foldObservations,
  forgetMs,
  fresh,
  staleness,
  type Observation,
} from "../shared/strategy/dnet/knowledge.ts";
import { mutationIntervalMs, msPerHostEvent } from "../shared/strategy/dnet/rates.ts";

const GEN = "run-1";

function observation(over: Partial<Observation> = {}): Observation {
  return {
    from: "darkweb",
    provenance: "agent",
    at: 1_000,
    generation: GEN,
    hosts: [],
    ...over,
  };
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

describe("every fact carries provenance and an expiry", () => {
  test("the fold stamps source, observer and observation time", () => {
    const { knowledge } = foldObservations(
      emptyKnowledge(GEN),
      [observation({ hosts: [{ hostname: "dn-1", present: true, facts: { depth: 2, modelId: "TopPass" } }] })],
      2_000,
    );
    const host = knowledge.hosts["dn-1"]!;
    expect(host.facts["depth"]).toMatchObject({ value: 2, at: 1_000, from: "agent", via: "darkweb" });
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
    const { knowledge } = foldObservations(
      emptyKnowledge(GEN),
      [observation({ at: 0, hosts: [{ hostname: "dn-1", present: true, facts: { neighbours: ["dn-2"], modelId: "TopPass" } }] })],
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
    const older = observation({ at: 1_000, hosts: [{ hostname: "dn-1", present: true, facts: { depth: 1 } }] });
    const newer = observation({ at: 5_000, hosts: [{ hostname: "dn-1", present: true, facts: { depth: 9 } }] });
    // The newer observation arrives FIRST; a slow report must not overwrite it.
    const { knowledge, superseded } = foldObservations(emptyKnowledge(GEN), [newer, older], 6_000);
    expect(knowledge.hosts["dn-1"]!.facts["depth"]).toMatchObject({ value: 9, at: 5_000 });
    expect(superseded).toBeGreaterThan(0);
  });

  test("a future timestamp is clamped rather than trusted", () => {
    const { knowledge } = foldObservations(
      emptyKnowledge(GEN),
      [observation({ at: 999_999, hosts: [{ hostname: "dn-1", present: true, facts: { depth: 1 } }] })],
      1_000,
    );
    // Otherwise a clock we do not control could make a fact immortal.
    expect(knowledge.hosts["dn-1"]!.facts["depth"]!.at).toBe(1_000);
  });
});

describe("reports from a dead run are discarded, not merged", () => {
  test("a mismatched generation is rejected and counted", () => {
    const { knowledge, rejectedGenerations } = foldObservations(
      emptyKnowledge(GEN),
      [observation({ generation: "run-0", hosts: [{ hostname: "ghost", present: true, facts: { depth: 1 } }] })],
      2_000,
    );
    // Agents outlive controllers: they survive a cold boot, a build handoff and
    // a page reload, so a live script from a dead run can still be reporting.
    expect(rejectedGenerations).toBe(1);
    expect(knowledge.hosts["ghost"]).toBeUndefined();
  });
});

describe("a host that goes away is forgotten, not remembered for ever", () => {
  test("absence wipes identity, because a returning host is a new host", () => {
    const seen = observation({ at: 1_000, hosts: [{ hostname: "dn-1", present: true, facts: { modelId: "TopPass", depth: 3 } }] });
    const gone = observation({ at: 2_000, hosts: [{ hostname: "dn-1", present: false, facts: {} }] });
    const { knowledge } = foldObservations(emptyKnowledge(GEN), [seen, gone], 2_000);
    const host = knowledge.hosts["dn-1"]!;
    expect(host.goneAt).toBe(2_000);
    // Upstream, a server that reappears is cleaned and given a NEW password, so
    // keeping the old identity would be worse than knowing nothing.
    expect(host.facts).toEqual({});
    expect(fresh<string>(host, "modelId", 2_000)).toBeUndefined();
  });

  test("seeing it again overrides the note that it was gone", () => {
    const gone = observation({ at: 1_000, hosts: [{ hostname: "dn-1", present: false, facts: {} }] });
    const back = observation({ at: 2_000, hosts: [{ hostname: "dn-1", present: true, facts: { depth: 4 } }] });
    const { knowledge } = foldObservations(emptyKnowledge(GEN), [gone, back], 2_000);
    expect(knowledge.hosts["dn-1"]!.goneAt).toBeUndefined();
    expect(fresh<number>(knowledge.hosts["dn-1"], "depth", 2_000)).toBe(4);
  });

  test("a host unseen past the forget window is dropped from the map", () => {
    const { knowledge: first } = foldObservations(
      emptyKnowledge(GEN),
      [observation({ at: 0, hosts: [{ hostname: "dn-1", present: true, facts: { depth: 1 } }] })],
      0,
    );
    const later = forgetMs() + 1;
    const { knowledge, hostsForgotten } = foldObservations(first, [], later);
    expect(hostsForgotten).toEqual(["dn-1"]);
    expect(knowledge.hosts["dn-1"]).toBeUndefined();
  });

  test("coverage separates what we hold from what we still believe", () => {
    const { knowledge } = foldObservations(
      emptyKnowledge(GEN),
      [observation({
        at: 0,
        hosts: [
          { hostname: "dn-1", present: true, facts: { neighbours: ["dn-2"], modelId: "TopPass" } },
          { hostname: "dn-2", present: true, facts: { modelId: "Laika4" } },
        ],
      })],
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

describe("the report and mission wire", () => {
  const report: DnetReport = {
    v: REPORT_VERSION,
    missionId: "m-1",
    generation: GEN,
    agentHost: "darkweb",
    phase: "final",
    at: 1_000,
    hosts: [{ hostname: "dn-1", present: true, depth: 0, neighbours: ["dn-2"], modelId: "TopPass" }],
    codes: { "200": 1, "451": 2 },
    logs: ["login failed"],
  };

  test("round-trips through encode and decode", () => {
    const decoded = decodeReport(encodeReport(report));
    expect(decoded.ok).toBe(true);
    if (!decoded.ok) return;
    expect(decoded.report).toMatchObject({ missionId: "m-1", agentHost: "darkweb" });
    const seen = observationOf(decoded.report);
    expect(seen).toMatchObject({ from: "darkweb", provenance: "agent", generation: GEN });
    expect(seen.hosts[0]).toMatchObject({ hostname: "dn-1", present: true });
    expect(seen.hosts[0]!.facts).toMatchObject({ depth: 0, neighbours: ["dn-2"], modelId: "TopPass" });
  });

  test("a password can never leave home, even if one is handed to the encoder", () => {
    const leaky = { ...report, hosts: [{ ...report.hosts[0]!, password: "hunter2" } as never] };
    expect(encodeReport(leaky as DnetReport)).not.toContain("hunter2");
  });

  test("caps are applied and announced rather than silently dropping data", () => {
    const many = {
      ...report,
      hosts: Array.from({ length: REPORT_MAX_HOSTS + 5 }, (_, i) => ({ hostname: `dn-${i}`, present: true })),
      logs: Array.from({ length: 40 }, () => "x".repeat(500)),
    };
    const decoded = decodeReport(encodeReport(many));
    expect(decoded.ok).toBe(true);
    if (!decoded.ok) return;
    expect(decoded.report.hosts).toHaveLength(REPORT_MAX_HOSTS);
    expect(decoded.report.truncated).toBe(true);
    expect(decoded.report.logs.every((line) => line.length <= 240)).toBe(true);
  });

  test("hint text is clipped, since it is free-form and unbounded upstream", () => {
    const long = { ...report, hosts: [{ ...report.hosts[0]!, passwordHint: "y".repeat(400) }] };
    const decoded = decodeReport(encodeReport(long));
    expect(decoded.ok).toBe(true);
    if (!decoded.ok) return;
    expect(decoded.report.hosts[0]!.passwordHint!.length).toBe(REPORT_MAX_HINT_CHARS);
  });

  test("an unknown version is a counted rejection, never a throw or a partial merge", () => {
    for (const raw of ["", "{", "null", JSON.stringify({ v: 99, missionId: "m" }), JSON.stringify({ v: 1 })]) {
      const decoded = decodeReport(raw);
      expect(decoded.ok).toBe(false);
      if (decoded.ok) continue;
      expect(decoded.reason).toMatch(/unparseable|version|shape/);
    }
  });

  test("response codes are named, and instability is not mistaken for a bad password", () => {
    expect(codeName(451)).toBe("NotEnoughCharisma");
    expect(codeName(999)).toBe("Unknown(999)");
    expect(Object.keys(DARKNET_CODES)).toHaveLength(11);
    // 408 exists as a distinct code from 401 precisely because it is
    // instability, not a wrong password — "the password may or may not have been
    // correct". Any retry policy has to keep them apart.
    expect(codeName(408)).toBe("RequestTimeOut");
    expect(codeName(401)).toBe("AuthFailure");
  });

  test("mission args parse positionally, and a wrong shape exits quietly", () => {
    expect(parseMissionArgs(["m-1", GEN, "identity-json", 7, 120])).toEqual({
      missionId: "m-1",
      generation: GEN,
      identity: "identity-json",
      port: 7,
      charisma: 120,
    });
    // A wrong shape exits quietly instead of crashing into the game's log.
    expect(parseMissionArgs(["only-one"])).toBeUndefined();
    expect(parseMissionArgs(["m", "g", "i", "not-a-number", 1])).toBeUndefined();
  });
});
