import { describe, expect, test } from "bun:test";
import { planStorm as planLiveStorm } from "../shared/strategy/dnet/plan.ts";
import { emptyHost, stormWipe, type DnetHost, type DnetHosts } from "../shared/strategy/dnet/host.ts";
import { STORM_PHISH_OVERLAP_MS, STORM_QUIET_MS } from "../shared/strategy/dnet/rates.ts";
import { planFarm, type FarmHost, type FarmInputs } from "../shared/strategy/dnet/farm.ts";
import { deriveTasks } from "../shared/strategy/dnet/plan.ts";

/** The one decision in the feature that destroys most of what we know on
 * purpose, so what these tests pin is the GATES: each refusal encodes a
 * mechanic that, gotten backwards, burns the scarcest one-shot in the feature —
 * a seed fired into our own storm, before the links are spent, or across an
 * open phish window. */

const host = (over: Partial<StormHost> & { hostname: string }): StormHost => ({
  agentAlive: false,
  hasCredential: true,
  blockedRam: 0,
  caches: [],
  ...over,
});

const NOW = 10_000_000;

interface StormHost extends Partial<DnetHost> {
  hostname: string;
  hasCredential?: boolean;
  harvestBusy?: boolean;
  stasisLinked?: boolean;
  gone?: boolean;
}

interface StormView {
  hosts: readonly StormHost[];
  now: number;
  stasisLimit: number;
  stasisLinked: number;
  pinsPending: boolean;
  walkInFlight: boolean;
  walkerPinned: boolean;
  labWalked: boolean;
  lastPhishCacheAt?: number;
  lastStormFiredAt?: number;
}

/** Preserve the compact gate fixtures while sending every assertion through
 * the same flat-host planner used by the controller. */
function planStorm(view: StormView) {
  const linked = new Set(view.hosts.filter((host) => host.stasisLinked).map((host) => host.hostname));
  const vault = new Set(view.hosts.filter((host) => host.hasCredential).map((host) => host.hostname));
  const hosts = view.hosts.filter((source) => !source.gone).map((source): DnetHost => {
    const { hasCredential: _credential, harvestBusy, stasisLinked: _linked, gone: _gone, ...fields } = source;
    return {
      ...emptyHost(source.hostname, view.now),
      ...fields,
      ...(harvestBusy ? { busy: new Set(["reclaim"]) } : {}),
    };
  });
  return planLiveStorm(hosts, {
    now: view.now,
    vault,
    stasisLinked: linked,
    stasisLimit: view.stasisLimit,
    stasisLinkedCount: view.stasisLinked,
    pinsPending: view.pinsPending,
    walkInFlight: view.walkInFlight,
    walkerPinned: view.walkerPinned,
    labWalked: view.labWalked,
    lastPhishCacheAt: view.lastPhishCacheAt,
    lastStormFiredAt: view.lastStormFiredAt,
  });
}

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

describe("harvest-incomplete: exhaust movable-host rewards before rerolling", () => {
  test("authentication, blocked RAM, cache files, and active harvest work each hold the seed", () => {
    const cases: StormHost[] = [
      host({ hostname: "auth", hasCredential: false }),
      host({ hostname: "ram", blockedRam: 0.01 }),
      host({ hostname: "cache", caches: ["reward.cache"] }),
      host({ hostname: "busy", harvestBusy: true }),
    ];
    for (const incomplete of cases) {
      const seeded = host({ hostname: "seed", stormSeed: true, agentAlive: true, stasisLinked: true });
      const plan = planStorm(green({ hosts: [seeded, incomplete] }));
      expect(plan.refused[0]?.why, incomplete.hostname).toBe("harvest-incomplete");
    }
  });

  test("stationary hosts use their separate cache policy", () => {
    const lab = host({ hostname: "lab", isStationary: true, hasCredential: false, blockedRam: undefined, caches: ["lab.cache"] });
    expect(planStorm(green({ hosts: [green().hosts[0]!, lab] })).fire).toBeDefined();
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

describe("a storm task sits below losable caches and above ordinary farm work", () => {
  test("a cache is collected before the pin/fire sequence; the fire outranks reclaim", () => {
    // The ordering IS the policy: `links-unspent` argues a pending pin holds
    // the storm, and the priorities enforce it even if both are filed in the
    // same derivation. A discovered cache is the exception: the storm can
    // destroy its host, so it must be collected first. A storm queued behind a
    // lower-value attempt or farm work could miss the phish window its policy
    // just proved.
    const tasks = deriveTasks(new Map(), NOW, {
      agents: new Set(["dn-5-1", "dn-6-1"]),
      hold: [
        { kind: "storm", host: "dn-5-1", from: "dn-5-1", reason: "fire" },
        { kind: "pin", host: "dn-6-1", from: "dn-6-1", reason: "pin" },
        { kind: "walk", host: "th3_l4byr1nth", from: "dn-6-1", reason: "walk" },
      ],
      farm: [
        { kind: "cache", host: "dn-5-1", threads: 1, filename: "cache_1.cache", reason: "open" },
        { kind: "reclaim", host: "dn-6-1", threads: 1, reason: "grind" },
      ],
    });
    const order = tasks.map((task) => task.kind);
    expect(order.indexOf("walk")).toBeLessThan(order.indexOf("storm"));
    expect(order.indexOf("cache")).toBeLessThan(order.indexOf("pin"));
    expect(order.indexOf("pin")).toBeLessThan(order.indexOf("storm"));
    expect(order.indexOf("storm")).toBeLessThan(order.indexOf("reclaim"));
  });
});

// --- the wipe ----------------------------------------------------------------

describe("stormWipe drops what the burst destroyed and keeps what survived", () => {
  const knowledgeWith = (): DnetHosts => new Map<string, DnetHost>([
    ["dn-2-1", {
      ...emptyHost("dn-2-1", NOW),
      identity: "10.0.0.1",
      identitySeenAt: NOW,
      modelId: "PlainVanilla",
      passwordLength: 8,
      depth: 2,
      neighbours: ["dn-3-1"],
      blockedRam: 32,
      caches: ["cache_1.cache"],
      stormSeed: false,
      seenAt: { position: NOW, topology: NOW, ram: NOW, files: NOW },
      ring: { pendingAuthRecords: 3 },
      attempts: { tried: 4, probes: 1 },
    }],
    ["dn-6-9", {
      ...emptyHost("dn-6-9", NOW),
      depth: 6,
      neighbours: ["th3_l4byr1nth"],
      maxRam: 128,
      seenAt: { position: NOW, topology: NOW, ram: NOW },
      ring: { pendingAuthRecords: 1 },
    }],
    ["darkweb", {
      ...emptyHost("darkweb", NOW),
      isStationary: true,
      neighbours: ["dn-2-1"],
      seenAt: { position: NOW, topology: NOW },
    }],
  ]);

  test("a movable host keeps identity facts and loses position, topology and resource", () => {
    const wiped = stormWipe(knowledgeWith());
    const host = wiped.get("dn-2-1")!;
    expect(host.modelId).toBe("PlainVanilla");
    expect(host.passwordLength).toBe(8);
    expect(host.depth).toBeUndefined();
    expect(host.neighbours).toBeUndefined();
    expect(host.blockedRam).toBeUndefined();
    expect(host.caches).toBeUndefined();
    expect(host.stormSeed).toBeUndefined();
  });

  test("the log ring goes with the restart; the attempt ledger does not", () => {
    // A restart resets the server's logs, so a pending-records count would
    // send a bleed to drain records that no longer exist. The password did NOT
    // change — restart and move touch no credential — so the cracking ledger
    // survives for a host that does.
    const wiped = stormWipe(knowledgeWith());
    expect(wiped.get("dn-2-1")!.ring).toBeUndefined();
    expect(wiped.get("dn-2-1")!.attempts).toBeDefined();
  });

  test("a stasis-linked host keeps everything", () => {
    const wiped = stormWipe(knowledgeWith(), { stasisLinked: new Set(["dn-6-9"]) });
    expect(wiped.get("dn-6-9")!.neighbours).toBeDefined();
    expect(wiped.get("dn-6-9")!.ring).toBeDefined();
  });

  test("a stationary host keeps everything", () => {
    const wiped = stormWipe(knowledgeWith());
    expect(wiped.get("darkweb")!.neighbours).toBeDefined();
  });

  test("pure: the input knowledge is untouched", () => {
    const knowledge = knowledgeWith();
    stormWipe(knowledge);
    expect(knowledge.get("dn-2-1")!.depth).toBe(2);
    expect(knowledge.get("dn-2-1")!.ring).toBeDefined();
  });
});
