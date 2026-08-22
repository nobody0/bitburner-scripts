import { describe, expect, test } from "bun:test";
import { planStorm, type StormHost, type StormView } from "../shared/strategy/dnet/storm.ts";
import { STORM_PHISH_OVERLAP_MS, STORM_QUIET_MS } from "../shared/strategy/dnet/rates.ts";
import { planFarm, type FarmHost, type FarmInputs } from "../shared/strategy/dnet/farm.ts";
import { FACT_CLASS, emptyKnowledge, stormWipe, type DarknetKnowledge } from "../shared/strategy/dnet/knowledge.ts";
import { deriveTasks } from "../shared/strategy/dnet/queue.ts";

/** The one decision in the feature that destroys most of what we know on
 * purpose, so what these tests pin is the GATES: each refusal encodes a
 * mechanic that, gotten backwards, burns the scarcest one-shot in the feature —
 * a seed fired into our own storm, before the links are spent, or across an
 * open phish window. */

const host = (over: Partial<StormHost> & { hostname: string }): StormHost => ({
  agentAlive: false,
  ...over,
});

const NOW = 10_000_000;

/** Every gate green: a live seeded holder with a resident, all links spent, no
 * walk exposed, a `.d.cache` seconds old, no storm in flight. Tests then break
 * exactly one gate each. */
const green = (over: Partial<StormView> = {}): StormView => ({
  hosts: [host({ hostname: "dn-5-1", stormSeed: true, agentAlive: true })],
  now: NOW,
  stasisLimit: 2,
  stasisLinked: 2,
  pinsPending: false,
  walkInFlight: false,
  walkerPinned: false,
  labWalked: true,
  lastPhishCacheAt: NOW - 5_000,
  ...over,
});

describe("all gates green admits exactly one fire, from the holder", () => {
  test("the admitted fire runs on the seed's own host", () => {
    const plan = planStorm(green());
    expect(plan.fire).toBeDefined();
    expect(plan.fire?.host).toBe("dn-5-1");
    expect(plan.fire?.from).toBe("dn-5-1");
    expect(plan.refused).toEqual([]);
  });

  test("deterministic: two derivations of the same view agree", () => {
    expect(planStorm(green())).toEqual(planStorm(green()));
  });

  test("a stasis-linked holder is preferred, then name order", () => {
    // Upstream mints at most one seed among the movables, but a pinned host can
    // hold a second — and the pinned seed is the one we can ALWAYS still fire,
    // so it goes first. Names break the remaining tie so the choice never
    // moves under the panel.
    const plan = planStorm(green({
      hosts: [
        host({ hostname: "dn-2-b", stormSeed: true, agentAlive: true }),
        host({ hostname: "dn-9-a", stormSeed: true, agentAlive: true, stasisLinked: true }),
      ],
    }));
    expect(plan.fire?.host).toBe("dn-9-a");
  });
});

describe("storm-in-flight: never burn a seed into our own storm", () => {
  test("refused inside the quiet window", () => {
    // The engine consumes the seed and stamps its clock BEFORE checking the
    // lock, so a second fire mid-burst is a total loss.
    const plan = planStorm(green({ lastStormFiredAt: NOW - STORM_QUIET_MS + 1 }));
    expect(plan.fire).toBeUndefined();
    expect(plan.refused[0]?.why).toBe("storm-in-flight");
  });

  test("the window boundary is exact", () => {
    expect(planStorm(green({ lastStormFiredAt: NOW - STORM_QUIET_MS })).fire).toBeDefined();
    expect(planStorm(green({ lastStormFiredAt: NOW - STORM_QUIET_MS + 1 })).fire).toBeUndefined();
  });
});

describe("no-seed: only a fresh sighting on a live host admits", () => {
  test("no host carries a fresh stormSeed fact", () => {
    const plan = planStorm(green({ hosts: [host({ hostname: "dn-5-1", agentAlive: true })] }));
    expect(plan.refused[0]?.why).toBe("no-seed");
  });

  test("explicit false is looked-and-absent, and does not admit", () => {
    const plan = planStorm(green({
      hosts: [host({ hostname: "dn-5-1", stormSeed: false, agentAlive: true })],
    }));
    expect(plan.refused[0]?.why).toBe("no-seed");
  });

  test("a gone holder's seed died with the host", () => {
    const plan = planStorm(green({
      hosts: [host({ hostname: "dn-5-1", stormSeed: true, agentAlive: true, gone: true })],
    }));
    expect(plan.refused[0]?.why).toBe("no-seed");
  });
});

describe("seed-unreachable: the fire job runs ON the holder", () => {
  test("a holder with no resident refuses rather than pretending", () => {
    // The call takes no target and scp cannot move the file, so the only fix
    // is a plant — which `planSpread` files on its own.
    const plan = planStorm(green({
      hosts: [host({ hostname: "dn-5-1", stormSeed: true })],
    }));
    expect(plan.refused[0]?.why).toBe("seed-unreachable");
    expect(plan.refused[0]?.hostname).toBe("dn-5-1");
  });
});

describe("links-unspent: the survivors ARE the reconquest", () => {
  test("an unspent slot holds the fire", () => {
    const plan = planStorm(green({ stasisLinked: 1 }));
    expect(plan.refused[0]?.why).toBe("links-unspent");
  });

  test("a pin still in flight holds it too, even at the limit", () => {
    // A slot mid-spend: firing under it wastes the 12 GB and the wait already
    // committed, and the pin's host would face the burst unprotected.
    const plan = planStorm(green({ pinsPending: true }));
    expect(plan.refused[0]?.why).toBe("links-unspent");
  });
});

describe("walker-unpinned: a finisher's walk is hours one restart from zero", () => {
  test("a finisher on an unpinned host holds the fire", () => {
    const plan = planStorm(green({ labWalked: false, walkInFlight: true, walkerPinned: false }));
    expect(plan.refused[0]?.why).toBe("walker-unpinned");
  });

  test("a pinned finisher lets a storm fire MID-WALK", () => {
    // The whole point of pinning the walker first: a stasis-linked host keeps
    // its running scripts through the burst, so the walk continues.
    const plan = planStorm(green({ labWalked: false, walkInFlight: true, walkerPinned: true }));
    expect(plan.fire).toBeDefined();
  });

  test("the gate retires itself once the lab is walked", () => {
    // A stale walkInFlight flag with the vault already holding the lab's
    // password protects nothing.
    const plan = planStorm(green({ labWalked: true, walkInFlight: true, walkerPinned: false }));
    expect(plan.fire).toBeDefined();
  });

  test("a lab-less world fires with no walker at all — links spent is the whole preparation", () => {
    // Program-only darknet access never generates a labyrinth, so there is no
    // walk and never will be: labWalked stays false for the whole run and no
    // finisher exists. The gate keys on `walkInFlight`, not on the lab, so the
    // storm is reachable there — `stasisTargetDepths` hands the bottom-row
    // anchor to the spares in that world, so the links actually get spent.
    const plan = planStorm(green({ labWalked: false, walkInFlight: false, walkerPinned: false }));
    expect(plan.fire).toBeDefined();
  });
});

describe("phish-window-open: fire into the dead window, not across an open one", () => {
  test("never having seen a .d.cache reads as open, and refuses", () => {
    const plan = planStorm(green({ lastPhishCacheAt: undefined }));
    expect(plan.refused[0]?.why).toBe("phish-window-open");
  });

  test("the overlap boundary is exact", () => {
    expect(planStorm(green({ lastPhishCacheAt: NOW - STORM_PHISH_OVERLAP_MS })).fire).toBeDefined();
    expect(planStorm(green({ lastPhishCacheAt: NOW - STORM_PHISH_OVERLAP_MS - 1 })).fire).toBeUndefined();
  });
});

// --- the seed hunt -----------------------------------------------------------

describe("seedHunt lifts the reclaim clear budget", () => {
  const grinder = (over: Partial<FarmHost> = {}): FarmHost => ({
    host: "dn-3-1",
    depth: 3,
    difficulty: 2,
    blockedRam: 64,
    freeGb: 32,
    caches: [],
    ...over,
  });
  const inputs = (over: Partial<FarmInputs> = {}): FarmInputs => ({
    now: NOW,
    charisma: 100,
    gbPerThread: { cache: 4, reclaim: 4, phish: 4, promote: 4 },
    // The host already has room, so only the clear budget can admit a grind.
    wantedGb: 8,
    maxReclaimThreads: 1,
    ...over,
  });

  test("off by default: a roomy host with a slow clear is refused reclaim", () => {
    const plan = planFarm([grinder()], inputs());
    const refusal = plan.refused.find((entry) => entry.why === "reclaim-not-needed");
    expect(refusal).toBeDefined();
    expect(plan.tasks.find((task) => task.kind === "reclaim")).toBeUndefined();
  });

  test("on, the same host grinds — every cleared block is a seed roll", () => {
    const plan = planFarm([grinder()], inputs({ seedHunt: true }));
    const task = plan.tasks.find((entry) => entry.kind === "reclaim");
    expect(task).toBeDefined();
    expect(task?.reason).toContain("storm seed");
  });

  test("the hunt does not override the stall gate: a grind that frees nothing stays refused", () => {
    // roundToTwo takes anything under 0.005 to exactly zero — the hunt wants
    // cleared blocks, and a stalled grind never clears one.
    const plan = planFarm(
      [grinder({ difficulty: 60 })],
      inputs({ seedHunt: true, charisma: 0 }),
    );
    expect(plan.refused.find((entry) => entry.why === "reclaim-grind-stalled")).toBeDefined();
    expect(plan.tasks.find((task) => task.kind === "reclaim")).toBeUndefined();
  });
});

// --- the queue's ordering ----------------------------------------------------

describe("a storm task sits between the walk and the attempt bands", () => {
  test("a pending pin structurally outranks the fire; the fire outranks the farm", () => {
    // The ordering IS the policy: `links-unspent` argues a pending pin holds
    // the storm, and the priorities enforce it even if both are filed in the
    // same derivation. Below them, a storm queued behind a 36 s attempt or a
    // 40 s farm batch could miss the phish window its policy just proved.
    const tasks = deriveTasks(emptyKnowledge("test:1"), NOW, {
      agents: new Set(["dn-5-1", "dn-6-1"]),
      hold: [
        { kind: "storm", host: "dn-5-1", from: "dn-5-1", reason: "fire" },
        { kind: "pin", host: "dn-6-1", from: "dn-6-1", reason: "pin" },
        { kind: "walk", host: "th3_l4byr1nth", from: "dn-6-1", reason: "walk" },
      ],
      farm: [{ kind: "cache", host: "dn-5-1", threads: 1, filename: "cache_1.cache", reason: "open" }],
    });
    const order = tasks.map((task) => task.kind);
    expect(order.indexOf("pin")).toBeLessThan(order.indexOf("storm"));
    expect(order.indexOf("walk")).toBeLessThan(order.indexOf("storm"));
    expect(order.indexOf("storm")).toBeLessThan(order.indexOf("cache"));
  });
});

// --- the wipe ----------------------------------------------------------------

describe("stormWipe drops what the burst destroyed and keeps what survived", () => {
  const knowledgeWith = (): DarknetKnowledge => ({
    generation: "test:1",
    mutationsSeen: 5,
    hosts: {
      "dn-2-1": {
        hostname: "dn-2-1",
        identity: "10.0.0.1",
        lastSeenAt: NOW,
        facts: {
          modelId: { value: "PlainVanilla", at: NOW },
          passwordLength: { value: 8, at: NOW },
          depth: { value: 2, at: NOW },
          neighbours: { value: ["dn-3-1"], at: NOW },
          blockedRam: { value: 32, at: NOW },
          usedRam: { value: 4, at: NOW },
          caches: { value: ["cache_1.cache"], at: NOW },
          stormSeed: { value: false, at: NOW },
        },
        ring: { pendingAuthRecords: 3 },
        attempts: { tried: 4, probes: 1 },
      },
      "dn-6-9": {
        hostname: "dn-6-9",
        lastSeenAt: NOW,
        facts: {
          depth: { value: 6, at: NOW },
          neighbours: { value: ["th3_l4byr1nth"], at: NOW },
          maxRam: { value: 128, at: NOW },
        },
        ring: { pendingAuthRecords: 1 },
      },
      darkweb: {
        hostname: "darkweb",
        lastSeenAt: NOW,
        facts: {
          isStationary: { value: true, at: NOW },
          neighbours: { value: ["dn-2-1"], at: NOW },
        },
      },
    },
  });

  test("a movable host keeps identity facts and loses position, topology and resource", () => {
    const wiped = stormWipe(knowledgeWith());
    const facts = wiped.hosts["dn-2-1"]!.facts;
    expect(facts["modelId"]).toBeDefined();
    expect(facts["passwordLength"]).toBeDefined();
    expect(facts["depth"]).toBeUndefined();
    expect(facts["neighbours"]).toBeUndefined();
    expect(facts["blockedRam"]).toBeUndefined();
    expect(facts["caches"]).toBeUndefined();
    expect(facts["stormSeed"]).toBeUndefined();
  });

  test("the log ring goes with the restart; the attempt ledger does not", () => {
    // A restart resets the server's logs, so a pending-records count would
    // send a bleed to drain records that no longer exist. The password did NOT
    // change — restart and move touch no credential — so the cracking ledger
    // survives for a host that does.
    const wiped = stormWipe(knowledgeWith());
    expect(wiped.hosts["dn-2-1"]!.ring).toBeUndefined();
    expect(wiped.hosts["dn-2-1"]!.attempts).toBeDefined();
  });

  test("a stasis-linked host keeps everything", () => {
    const wiped = stormWipe(knowledgeWith(), { stasisLinked: new Set(["dn-6-9"]) });
    expect(wiped.hosts["dn-6-9"]!.facts["neighbours"]).toBeDefined();
    expect(wiped.hosts["dn-6-9"]!.ring).toBeDefined();
  });

  test("a stationary host keeps everything", () => {
    const wiped = stormWipe(knowledgeWith());
    expect(wiped.hosts["darkweb"]!.facts["neighbours"]).toBeDefined();
  });

  test("an unclassified fact wipes rather than survives", () => {
    // Unknown keys default to `topology` everywhere else too — the
    // conservative side for a fact nobody classified.
    expect(FACT_CLASS["someFutureFact"]).toBeUndefined();
    const knowledge = knowledgeWith();
    knowledge.hosts["dn-2-1"]!.facts["someFutureFact"] = { value: 1, at: NOW };
    expect(stormWipe(knowledge).hosts["dn-2-1"]!.facts["someFutureFact"]).toBeUndefined();
  });

  test("pure: the input knowledge is untouched", () => {
    const knowledge = knowledgeWith();
    stormWipe(knowledge);
    expect(knowledge.hosts["dn-2-1"]!.facts["depth"]).toBeDefined();
    expect(knowledge.hosts["dn-2-1"]!.ring).toBeDefined();
  });
});
