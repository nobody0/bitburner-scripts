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
  foldObservations,
  forgetMs,
  freeRam,
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
    // An IP is assigned at construction and dies with the host, exactly like the
    // password model does — so it never expires with age.
    expect(FACT_CLASS["ip"]).toBe("identity");
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
    knowledge = foldObservations(
      knowledge,
      [observation({ at: 1_000, hosts: [{ hostname: "dn-1", present: true, facts: { modelId: "TopPass" } }] })],
      1_000,
    ).knowledge;
    knowledge.hosts["dn-1"]!.attempts = { modelId: "TopPass", tried: 40, probes: 0 };
    knowledge.hosts["dn-1"]!.credentialKnown = true;

    const gone = foldObservations(
      knowledge,
      [observation({ at: 2_000, hosts: [{ hostname: "dn-1", present: false, facts: {} }] })],
      2_000,
    ).knowledge;
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
        maxRam: { value: 16, at, from: "agent" as const },
        blockedRam: { value: 4, at, from: "agent" as const },
        usedRam: { value: 4, at, from: "agent" as const },
      },
    };
    expect(freeRam(host, at)).toBe(12);

    // ...but a host observed before updateRamUsed ran reports used < blocked,
    // and there the block really is unaccounted for.
    const early = {
      ...host,
      facts: { ...host.facts, usedRam: { value: 0, at, from: "agent" as const } },
    };
    expect(freeRam(early, at)).toBe(12);

    // An unknown capacity must never read as "room for an agent".
    expect(freeRam(undefined, at)).toBe(0);
    expect(freeRam({ hostname: "x", lastSeenAt: at, facts: {} }, at)).toBe(0);
  });

  test("coverage separates what we opened from what we can actually stand on", () => {
    const at = 1_000;
    let knowledge = emptyKnowledge(GEN);
    knowledge = foldObservations(
      knowledge,
      [
        observation({
          at,
          hosts: [
            { hostname: "roomy", present: true, facts: { maxRam: 16, blockedRam: 0, usedRam: 0 } },
            // A big host can arrive with ALL of its RAM blocked, which is a
            // different problem from not having the password.
            { hostname: "blocked", present: true, facts: { maxRam: 128, blockedRam: 128, usedRam: 128 } },
          ],
        }),
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
