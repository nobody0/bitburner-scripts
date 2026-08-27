import { describe, expect, test } from "bun:test";
import {
  emptyKnowledge,
  foldKnowledgeReports,
  type DnetKnowledge,
} from "../shared/strategy/dnet/host.ts";
import type { ReportHost } from "../shared/strategy/dnet/courier.ts";
import { KNOWLEDGE_MAX_HOSTS, publishKnowledge } from "../shared/strategy/dnet/publish.ts";
import { modelEntry } from "../shared/strategy/dnet/models.ts";
import { msPerHostEvent } from "../shared/strategy/dnet/rates.ts";

/** What the panel is allowed to see.
 *
 * These tests pin the three properties that make publishing the fold safe: every
 * fact arrives with the time it was OBSERVED, nothing derivable from that time
 * or from `modelId` is shipped alongside it, and no credential arrives at all. */

const GEN = "15:0";
const NOW = 10_000_000;

type Seen = { hostname: string; present: boolean; facts?: Record<string, unknown> };

function fold(hosts: Seen[], at = NOW): DnetKnowledge {
  const reports: ReportHost[] = hosts.map((host) => ({
    hostname: host.hostname,
    at,
    present: host.present,
    ...(host.present ? host.facts : {}),
  } as ReportHost));
  return foldKnowledgeReports(emptyKnowledge(GEN), reports, at).knowledge;
}

describe("the wire carries only what cannot be derived", () => {
  test("a fact arrives as the time it was observed, and nothing more", () => {
    const knowledge = fold([
      { hostname: "dn-1", present: true, facts: { depth: 2, modelId: "TopPass", neighbours: ["dn-2"] } },
    ]);
    const digest = publishKnowledge(knowledge, NOW + 5_000);
    const host = digest.hosts.find((entry) => entry.hostname === "dn-1")!;

    expect(host.depth).toBe(2);
    // One number per fact. Age, expiry class and staleness all follow from it
    // plus the mutation clock, and `ui/` derives them from the same modules the
    // controller uses. Shipping them instead would add six fields to each of the
    // sixteen published facts, plus six model strings per host, every tick.
    expect(host.facts["depth"]).toBe(NOW);
    expect(Object.values(host.facts).every((at) => typeof at === "number")).toBe(true);
  });

  test("the caches a host is holding", () => {
    // Cache listings are timestamped because a cache dies with its host.
    const knowledge = fold([{
      hostname: "dn-1",
      present: true,
      facts: { depth: 0, caches: ["loot.cache", "phish.d.cache"] },
    }]);
    const host = publishKnowledge(knowledge, NOW + 1_000).hosts[0]!;

    expect(host.caches).toEqual(["loot.cache", "phish.d.cache"]);
    // Acting on a stale listing means calling openCache on a filename the host
    // no longer holds, and that call throws rather than refusing.
    expect(host.facts["caches"]).toBe(NOW);
  });

  test("a stale value is still SHOWN rather than hidden", () => {
    // Blanking it would leave the operator with nothing exactly when they most
    // want to know what we last believed and how long ago. The digest publishes
    // the value and the timestamp; the panel decides how to draw it.
    const knowledge = fold([{ hostname: "dn-1", present: true, facts: { neighbours: ["dn-2"] } }]);
    const later = NOW + msPerHostEvent("moved") * 100;
    const host = publishKnowledge(knowledge, later).hosts[0]!;
    expect(host.neighbours).toEqual(["dn-2"]);
    expect(host.facts["neighbours"]).toBe(NOW);
  });

  test("the model registry is NOT shipped, because modelId already identifies it", () => {
    const knowledge = fold([{ hostname: "dn-1", present: true, facts: { depth: 4, modelId: "2G_cellular" } }]);
    const host = publishKnowledge(knowledge, NOW).hosts[0]!;
    expect(host.modelId).toBe("2G_cellular");
    // Everything the panel shows about the model is a pure function of the id,
    // and the registry lives in shared/ precisely so both ends can read it.
    const entry = modelEntry(host.modelId)!;
    expect(entry.name).toBe("TimingAttack");
    expect(entry.family).toBe("timing");
    expect(entry.oracle).toContain("50ms");
    // It has a solver now, so it carries no `blocked` note — and `status` is
    // read off the solver registry rather than written by hand, which is what
    // stops the panel reporting a reason that stopped being true.
    expect(entry.status).toBe("implemented");
    expect(entry.blocked).toBeUndefined();
    expect(JSON.stringify(host)).not.toContain("50ms");
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

  test("solve progress travels; the solver's scratch does not", () => {
    // `scratch` accumulates resolved characters and known prefixes — late in a
    // solve it IS the password — while `phase` and `spent` are ordinary
    // progress. Publishing the second without leaking the first is the whole
    // reason `attempt.solve` is built by an allow-list rather than a spread.
    const knowledge = fold([{ hostname: "dn-1", present: true, facts: { depth: 0, modelId: "DeepGreen" } }]);
    knowledge.hosts.get("dn-1")!.attempts = {
      tried: 4,
      probes: 2,
      solver: {
        model: "DeepGreen",
        fingerprint: "fp-1",
        phase: "narrowing",
        spent: 12,
        scratch: { prefix: "hunter", residue: 7, resolved: ["h", "u", "n"] },
      },
    };

    const digest = publishKnowledge(knowledge, NOW, {});
    const attempt = digest.hosts[0]!.attempt!;

    // The progress an operator wants.
    expect(attempt.solving).toBe(true);
    expect(attempt.solve).toEqual({ phase: "narrowing", spent: 12 });
    // EXACTLY those two keys. A new field on SolverState must not become a new
    // field here by default — that is what an allow-list buys over a spread.
    expect(Object.keys(attempt.solve!).sort()).toEqual(["phase", "spent"]);

    // And nothing of the scratch, anywhere in the serialised digest.
    const serialised = JSON.stringify(digest);
    expect(serialised).not.toContain("hunter");
    expect(serialised).not.toContain("scratch");
    expect(serialised).not.toContain("fp-1");
    expect(serialised).not.toContain("residue");
  });

  test("stripCredentials still deletes the solver state wholesale", () => {
    // The guard against "simplifying" CREDENTIAL_KEYS once `attempt.solve`
    // exists. The two are not alternatives: `solve` is published BECAUSE the
    // redaction below stays absolute.
    const knowledge = fold([{ hostname: "dn-1", present: true, facts: { depth: 0, modelId: "DeepGreen" } }]);
    knowledge.hosts.get("dn-1")!.attempts = {
      tried: 1,
      probes: 0,
      solver: { model: "DeepGreen", fingerprint: "f", phase: "p", spent: 1, scratch: { secret: "s3cr3t" } },
    };
    const digest = publishKnowledge(knowledge, NOW, {});
    expect(JSON.stringify(digest)).not.toContain("s3cr3t");
    expect((digest.hosts[0]!.attempt as Record<string, unknown>)["solver"]).toBeUndefined();
  });

  test("a phase longer than a label is capped rather than trusted", () => {
    // `phase` is solver-defined free text. A solver that wrote password material
    // into it would be a bug, but the cap means it could not write MUCH.
    const knowledge = fold([{ hostname: "dn-1", present: true, facts: { depth: 0, modelId: "DeepGreen" } }]);
    knowledge.hosts.get("dn-1")!.attempts = {
      tried: 0,
      probes: 0,
      solver: { model: "DeepGreen", fingerprint: "f", phase: "x".repeat(200), spent: 0, scratch: {} },
    };
    const solve = publishKnowledge(knowledge, NOW, {}).hosts[0]!.attempt!.solve!;
    expect(solve.phase.length).toBe(32);
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

  test("the frontier is what is adjacent to something we HOLD, not what has its own map", () => {
    // THE BUG this replaced: `authState` used to ask whether the host had its
    // own fresh `neighbours` fact. That fact only exists once an agent is
    // standing on the host, which only happens after it is cracked — so every
    // host we could crack right now reported "(no connection)" and the panel
    // called the entire work queue unreachable. Upstream's rule looks OUTWARD:
    // `hasAdminRights || serversOnNetwork.some((n) => n.hasAdminRights)`.
    //
    // Nothing is cracked here. darkweb is held by construction, and its own
    // one-hop list is the only thing that makes depth 0 actionable.
    const knowledge = fold([
      { hostname: "darkweb", present: true, facts: { depth: -1, neighbours: ["near-a", "near-b"] } },
      { hostname: "near-a", present: true, facts: { depth: 0 } },
      { hostname: "near-b", present: true, facts: { depth: 0 } },
      { hostname: "far", present: true, facts: { depth: 3 } },
    ]);
    const digest = publishKnowledge(knowledge, NOW);
    const state = (name: string) => digest.hosts.find((h) => h.hostname === name)!.authState;
    expect(state("near-a")).toBe("auth-required");
    expect(state("near-b")).toBe("auth-required");
    // Genuinely out of reach, and still said so.
    expect(state("far")).toBe("no-connection");
  });

  test("a one-sided adjacency claim still puts a host on the frontier", () => {
    // `probe()` is host-local, so darkweb's own list comes only from home's
    // one-hop probe. A depth-0 host reporting "my neighbour is darkweb" is
    // exactly as good evidence, and often lands first.
    const knowledge = fold([
      { hostname: "darkweb", present: true, facts: { depth: -1 } },
      { hostname: "claims-it", present: true, facts: { depth: 0, neighbours: ["darkweb"] } },
    ]);
    const digest = publishKnowledge(knowledge, NOW);
    expect(digest.hosts.find((h) => h.hostname === "claims-it")!.authState).toBe("auth-required");
  });

  test("a cracked host opens the frontier one hop deeper", () => {
    const knowledge = fold([
      { hostname: "darkweb", present: true, facts: { depth: -1, neighbours: ["shallow"] } },
      { hostname: "shallow", present: true, facts: { depth: 0, neighbours: ["deeper"] } },
      { hostname: "deeper", present: true, facts: { depth: 1 } },
      { hostname: "deepest", present: true, facts: { depth: 2 } },
    ]);
    const state = (vault: string[], name: string) =>
      publishKnowledge(knowledge, NOW, { vault: new Set(vault) }).hosts
        .find((h) => h.hostname === name)!.authState;
    // Before cracking `shallow`, its neighbour is out of reach...
    expect(state([], "deeper")).toBe("no-connection");
    // ...and after, it is the next thing to work on.
    expect(state(["shallow"], "shallow")).toBe("authenticated");
    expect(state(["shallow"], "deeper")).toBe("auth-required");
    expect(state(["shallow"], "deepest")).toBe("no-connection");
  });

  test("a gone host keeps its name and its death, and loses everything else", () => {
    let knowledge = fold([{ hostname: "dn-1", present: true, facts: { depth: 0, modelId: "TopPass" } }]);
    knowledge = foldKnowledgeReports(knowledge, [{ hostname: "dn-1", at: NOW + 1, present: false }], NOW + 1).knowledge;
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

describe("what the panel still needs the controller to decide", () => {
  test("an unrecognised model id stays loud, and is counted", () => {
    // A transcription hole that fails quietly survives for months. The id itself
    // travels, and the counter is what makes a game update audible.
    const knowledge = fold([{ hostname: "dn-1", present: true, facts: { modelId: "Quantum_9000" } }]);
    const digest = publishKnowledge(knowledge, NOW, { unknownModels: { Quantum_9000: 3 } });
    expect(digest.hosts[0]!.modelId).toBe("Quantum_9000");
    expect(modelEntry("Quantum_9000")).toBeUndefined();
    expect(digest.unknownModels).toEqual({ Quantum_9000: 3 });
  });

  test("a stasis link is the controller's own fact, not an observation", () => {
    // We are the only thing that links or releases one, so an observed copy
    // could only ever be staler than the set we are holding.
    const knowledge = fold([{ hostname: "dn-1", present: true, facts: { depth: 1 } }]);
    const linked = publishKnowledge(knowledge, NOW, { stasisLinked: new Set(["dn-1"]) }).hosts[0]!;
    expect(linked.stasisLinked).toBe(true);
    expect(publishKnowledge(knowledge, NOW).hosts[0]!.stasisLinked).toBeUndefined();
    // And it puts the host outside the mutation clock: nothing about it ages.
    const later = NOW + msPerHostEvent("moved") * 100;
    const stillFresh = publishKnowledge(knowledge, later, { stasisLinked: new Set(["dn-1"]) }).hosts[0]!;
    expect(stillFresh.depth).toBe(1);
  });

  test("usable RAM is published from durable capacity", () => {
    const knowledge = fold([
      { hostname: "dn-1", present: true, facts: { maxRam: 16, blockedRam: 4 } },
    ]);
    expect(publishKnowledge(knowledge, NOW).hosts[0]!.usableRam).toBe(12);
    knowledge.hosts.get("dn-1")!.dirty.ram = true;
    expect(publishKnowledge(knowledge, NOW).hosts[0]!.usableRam).toBe(12);
  });

  test("runtime RAM stays separate from durable capacity, and does not age out", () => {
    const knowledge = fold([
      { hostname: "dn-1", present: true, facts: { maxRam: 16, blockedRam: 4 } },
    ]);
    const ram = new Map([["dn-1", { at: NOW, total: 16, blocked: 4, used: 5 }]]);
    expect(publishKnowledge(knowledge, NOW, { ram }).hosts[0]!.ram).toEqual(ram.get("dn-1"));
    // Three of these four fields cannot go stale on a clock — `total` never
    // changes and is re-read on every `getServerDetails`, `blocked` has its own
    // dirty bit — so a cutoff hid the entire readout over one volatile field.
    // The sample carries `at`; the panel can say how old it is.
    expect(publishKnowledge(knowledge, NOW + 60 * 60_000, { ram }).hosts[0]!.ram)
      .toEqual(ram.get("dn-1"));
    // A host that is gone keeps nothing.
    knowledge.hosts.get("dn-1")!.goneAt = NOW;
    expect(publishKnowledge(knowledge, NOW, { ram }).hosts[0]!.ram).toBeUndefined();
  });
});

describe("agent mortality, and the caps", () => {
  test("agents seen but no longer beating are counted as lost", () => {
    // spec/dnet.md names this as the loss that actually matters out there: the
    // transport does not drop data, hosts drop agents.
    const knowledge = fold([{ hostname: "dn-1", present: true, facts: { depth: 0 } }]);
    const digest = publishKnowledge(knowledge, NOW, {
      agents: {
        "dn-1": {
          role: "resident", lastBeatAt: NOW, alive: true, targets: [],
          ram: { jobGb: 0, proberGb: 3.15, controllerGb: 0 },
        },
      },
      agentsSeenEver: 5,
      agentsLost: 4,
    });
    expect(digest.agents).toEqual({ live: 1, seenEver: 5, lostSinceBoot: 4 });
    expect(digest.hosts[0]!.agent).toMatchObject({ role: "resident", alive: true });
    expect(digest.hosts[0]!.authState).toBe("session");
  });

  test("a very large net is capped, and says that it was", () => {
    // The deepest labyrinth builds ~173 servers, so the cap clears the largest
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
