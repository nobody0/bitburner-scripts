import { describe, expect, test } from "bun:test";
import {
  emptyKnowledge,
  foldObservations,
  type DarknetKnowledge,
  type Observation,
} from "../shared/strategy/dnet/knowledge.ts";
import { KNOWLEDGE_MAX_HOSTS, publishKnowledge } from "../shared/strategy/dnet/publish.ts";
import { msPerHostEvent } from "../shared/strategy/dnet/rates.ts";

/** What the panel is allowed to see.
 *
 * The controller has always folded agent reports into a provenance-stamped fact
 * set and then thrown it away, which is why the Darknet tab could only ever show
 * `darkweb`. These tests pin the two properties that make publishing it safe:
 * every fact arrives WITH its age and source, and no credential arrives at all. */

const GEN = "15:0";
const NOW = 10_000_000;

function fold(hosts: Observation["hosts"], at = NOW, from = "darkweb"): DarknetKnowledge {
  return foldObservations(
    emptyKnowledge(GEN),
    [{ from, provenance: "agent", at, generation: GEN, hosts }],
    at,
  ).knowledge;
}

describe("every published fact carries where it came from and when", () => {
  test("a fact arrives with its age, provenance and the agent that saw it", () => {
    const knowledge = fold([
      { hostname: "dn-1", present: true, facts: { depth: 2, modelId: "TopPass", neighbours: ["dn-2"] } },
    ]);
    const digest = publishKnowledge(knowledge, NOW + 5_000);
    const host = digest.hosts.find((entry) => entry.hostname === "dn-1")!;

    expect(host.depth).toBe(2);
    expect(host.facts["depth"]).toMatchObject({ at: NOW, from: "agent", via: "darkweb", ageMs: 5_000 });
    // The whole point of the split: which clock a fact dies on is a property of
    // the FACT, not of the host, and the panel must not re-derive it.
    expect(host.facts["modelId"]!.class).toBe("identity");
    expect(host.facts["depth"]!.class).toBe("position");
    expect(host.facts["neighbours"]!.class).toBe("topology");
  });

  test("identity facts report null rather than a number they cannot have", () => {
    // expiryMs returns Infinity for the identity class and JSON cannot carry it.
    // A 0 would read as "expired" and a missing field as "unknown", so null is
    // the only value that reads as "never, by age".
    const knowledge = fold([{ hostname: "dn-1", present: true, facts: { modelId: "TopPass", depth: 1 } }]);
    const host = publishKnowledge(knowledge, NOW).hosts[0]!;
    expect(host.facts["modelId"]!.expiresInMs).toBeNull();
    expect(host.facts["modelId"]!.stale).toBe(false);
    expect(typeof host.facts["depth"]!.expiresInMs).toBe("number");
  });

  test("a stale value is still SHOWN, and flagged, rather than hidden", () => {
    // Blanking it would leave the operator with nothing exactly when they most
    // want to know what we last believed and how long ago.
    const knowledge = fold([{ hostname: "dn-1", present: true, facts: { neighbours: ["dn-2"] } }]);
    const later = NOW + msPerHostEvent("moved") * 100;
    const host = publishKnowledge(knowledge, later).hosts[0]!;
    expect(host.neighbours).toEqual(["dn-2"]);
    expect(host.facts["neighbours"]!.stale).toBe(true);
    expect(host.facts["neighbours"]!.expiresInMs).toBe(0);
  });
});

describe("a credential never reaches the panel", () => {
  test("the digest carries a flag, and a deep scan of the JSON finds no password", () => {
    const knowledge = fold([{ hostname: "dn-1", present: true, facts: { depth: 0, modelId: "ZeroLogon" } }]);
    const digest = publishKnowledge(knowledge, NOW, { vault: new Set(["dn-1"]) });
    const host = digest.hosts[0]!;
    expect(host.credentialKnown).toBe(true);
    // The vault holds "hunter2" for dn-1; the digest is written to disk as JSONL
    // and must not. A field-by-field assertion would miss a new nested field, so
    // this scans the serialised form.
    const serialised = JSON.stringify(digest);
    expect(serialised).not.toContain("hunter2");
    expect(serialised).not.toContain("password\"");
    expect(serialised.toLowerCase()).not.toContain("credential\":\"");
  });

  test("a host we hold no credential for says so plainly", () => {
    const knowledge = fold([{ hostname: "dn-1", present: true, facts: { depth: 0 } }]);
    const host = publishKnowledge(knowledge, NOW, { vault: new Set() }).hosts[0]!;
    expect(host.credentialKnown).toBe(false);
  });
});

describe("the map's layout inputs are unambiguous", () => {
  test("depth is OMITTED when unknown, never sent as the darkweb sentinel", () => {
    // -1 is darkweb's real depth. If it doubled as "no idea", the root of the
    // net would land in the unplaced row and the map would draw itself wrong.
    const knowledge = fold([
      { hostname: "darkweb", present: true, facts: { depth: -1 } },
      { hostname: "mystery", present: true, facts: { modelId: "NIL" } },
    ]);
    const digest = publishKnowledge(knowledge, NOW);
    const darkweb = digest.hosts.find((h) => h.hostname === "darkweb")!;
    const mystery = digest.hosts.find((h) => h.hostname === "mystery")!;
    expect(darkweb.depth).toBe(-1);
    expect(darkweb.isDarkweb).toBe(true);
    expect("depth" in mystery).toBe(false);
    expect(mystery.isDarkweb).toBeUndefined();
  });

  test("hosts are ordered by depth then name, so the map does not shimmer", () => {
    // A live run re-renders twice a second. Insertion order would reshuffle
    // whenever a host was forgotten, and a map that moves is a map nobody reads.
    const knowledge = fold([
      { hostname: "z-shallow", present: true, facts: { depth: 0 } },
      { hostname: "deep", present: true, facts: { depth: 3 } },
      { hostname: "a-shallow", present: true, facts: { depth: 0 } },
    ]);
    const names = publishKnowledge(knowledge, NOW).hosts.map((h) => h.hostname);
    expect(names).toEqual(["a-shallow", "z-shallow", "deep"]);
  });

  test("authState is decided once, so the map and the table cannot disagree", () => {
    const knowledge = fold([
      { hostname: "darkweb", present: true, facts: { depth: -1 } },
      { hostname: "known", present: true, facts: { depth: 0, neighbours: ["darkweb"] } },
      { hostname: "seen", present: true, facts: { depth: 0, neighbours: ["darkweb"] } },
      { hostname: "rumoured", present: true, facts: { depth: 1 } },
    ]);
    const digest = publishKnowledge(knowledge, NOW, { vault: new Set(["known"]) });
    const state = (name: string) => digest.hosts.find((h) => h.hostname === name)!.authState;
    // darkweb is authenticated by construction upstream, whatever we hold.
    expect(state("darkweb")).toBe("session");
    expect(state("known")).toBe("authenticated");
    expect(state("seen")).toBe("auth-required");
    // No believable neighbour list means we cannot even claim it is reachable,
    // which is the distinction the in-game map draws too.
    expect(state("rumoured")).toBe("no-connection");
  });

  test("a gone host keeps its name and its death, and loses everything else", () => {
    let knowledge = fold([{ hostname: "dn-1", present: true, facts: { depth: 0, modelId: "TopPass" } }]);
    knowledge = foldObservations(
      knowledge,
      [{ from: "darkweb", provenance: "agent", at: NOW + 1, generation: GEN, hosts: [{ hostname: "dn-1", present: false, facts: {} }] }],
      NOW + 1,
    ).knowledge;
    const host = publishKnowledge(knowledge, NOW + 1).hosts[0]!;
    expect(host.goneAt).toBe(NOW + 1);
    expect(host.authState).toBe("offline");
    // Identity facts die with the host: one that returns is a NEW host with a
    // new password, so keeping its model would be fabricating a map.
    expect(host.modelId).toBeUndefined();
    expect(host.facts).toEqual({});
    expect(publishKnowledge(knowledge, NOW + 1).gone).toBe(1);
  });
});

describe("the model registry reaches the panel with it", () => {
  test("an unattempted model publishes the reason it is untouched", () => {
    // A blank where a reason belongs is the thing this whole feature is trying
    // to avoid: the panel should say WHY a host is untouched.
    const knowledge = fold([{ hostname: "dn-1", present: true, facts: { depth: 4, modelId: "2G_cellular" } }]);
    const host = publishKnowledge(knowledge, NOW).hosts[0]!;
    expect(host.modelName).toBe("TimingAttack");
    expect(host.modelFamily).toBe("timing");
    expect(host.modelOracle).toContain("50ms");
    expect(host.modelBlocked).toBe("timing climb not written");
  });

  test("a model id we do not recognise is shown AS unrecognised", () => {
    // Falling back to a generic family here would hide a game update behind a
    // shrug, which is exactly how a transcription hole survives for months.
    const knowledge = fold([{ hostname: "dn-1", present: true, facts: { modelId: "Quantum_9000" } }]);
    const host = publishKnowledge(knowledge, NOW, { unknownModels: { Quantum_9000: 3 } }).hosts[0]!;
    expect(host.modelId).toBe("Quantum_9000");
    expect(host.modelName).toBeUndefined();
    expect(host.modelBlocked).toBe("unrecognised model id");
    expect(publishKnowledge(knowledge, NOW, { unknownModels: { Quantum_9000: 3 } }).unknownModels)
      .toEqual({ Quantum_9000: 3 });
  });

  test("free RAM is published, and does not double-count the owner's block", () => {
    const knowledge = fold([
      { hostname: "dn-1", present: true, facts: { maxRam: 16, blockedRam: 4, usedRam: 4 } },
    ]);
    expect(publishKnowledge(knowledge, NOW).hosts[0]!.freeRam).toBe(12);
  });
});

describe("agent mortality, and the caps", () => {
  test("agents seen but no longer beating are counted as lost", () => {
    // spec/dnet.md names this as the loss that actually matters out there: the
    // transport does not drop data, hosts drop agents.
    const knowledge = fold([{ hostname: "dn-1", present: true, facts: { depth: 0 } }]);
    const digest = publishKnowledge(knowledge, NOW, {
      agents: { "dn-1": { role: "resident", lastBeatAt: NOW, alive: true } },
      agentsSeenEver: 5,
      agentsLost: 4,
    });
    expect(digest.agents).toEqual({ live: 1, seenEver: 5, lostSinceBoot: 4 });
    expect(digest.hosts[0]!.agent).toMatchObject({ role: "resident", alive: true });
    expect(digest.hosts[0]!.authState).toBe("session");
  });

  test("a very large net is capped, and says that it was", () => {
    // The deepest labyrinth builds ~163 servers, so the cap clears the largest
    // real net; it exists to bound a runaway, not to hide data. Truncating
    // silently would read as "we know of 220 hosts" when we know of more.
    const hosts = Array.from({ length: KNOWLEDGE_MAX_HOSTS + 30 }, (_, i) => ({
      hostname: `dn-${String(i).padStart(4, "0")}`,
      present: true,
      facts: { depth: i % 30 },
    }));
    const digest = publishKnowledge(fold(hosts), NOW);
    expect(digest.hosts).toHaveLength(KNOWLEDGE_MAX_HOSTS);
    expect(digest.truncated).toBe(true);
    expect(digest.totalHosts).toBe(KNOWLEDGE_MAX_HOSTS + 30);
  });

  test("an empty net publishes an empty digest rather than nothing", () => {
    const digest = publishKnowledge(emptyKnowledge(GEN), NOW);
    expect(digest.hosts).toEqual([]);
    expect(digest.generation).toBe(GEN);
    expect(digest.truncated).toBeUndefined();
    expect(digest.agents.live).toBe(0);
  });
});
