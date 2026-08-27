import { makeOrder } from './support/dnet-order.ts';
import { describe, expect, test } from "bun:test";
import type { NS } from "@ns";
import { runOrder } from "../game/dnet/orders.ts";
import {
  KIND_CALLS,
  type AgentIo,
  type ControllerDeps,
  type Order,
  type OrderKind,
} from "../game/dnet/shared.ts";
import { LAB_LADDER } from "../shared/strategy/dnet/rates.ts";
import type { LabField } from "../shared/strategy/dnet/maze.ts";

/** The DELIBERATE order bodies, driven against a fake `ns`.
 *
 * The same gap `tests/dnet-attempt-job.test.ts` exists for, one layer along:
 * the policies are pure and unit-tested in `tests/dnet-hold.test.ts`, and the
 * engine behaviour is transcribed and tested in `sim/tests/dnet-hold.test.ts`,
 * but the BODIES are the part that reads a response and decides what to do
 * next. Every one of their failure modes is silent — a walker that mis-reads a
 * wall walks into it for hours, a promoter with no symbol spends a batch doing
 * nothing, a pin that ignores a 453 reports success for a link it never got. */

interface Rig {
  ns: NS;
  calls: string[];
  /** Direction words the walker sent, in order. */
  walked: string[];
}

/** A tiny maze, in the exact shape the engine renders and answers.
 *
 * Odd cells are standing positions and the even ones between them are wall
 * slots, which is what makes a step two cells. `#` is wall, ` ` is path. */
const MAZE = [
  "#####",
  "#   #",
  "# # #",
  "#   #",
  "#####",
];

function render(x: number, y: number): string {
  const rows: string[] = [];
  for (let row = y - 1; row <= y + 1; row++) {
    let line = "";
    for (let col = x - 1; col <= x + 1; col++) {
      line += row === y && col === x ? "@" : (MAZE[row]?.[col] ?? " ");
    }
    rows.push(line);
  }
  return rows.join("\n");
}

const STEP: Record<string, [number, number]> = {
  north: [0, -1],
  east: [1, 0],
  south: [0, 1],
  west: [-1, 0],
};

function rig(over: {
  charismaGate?: number;
  exit?: [number, number];
  promoteFails?: boolean;
  /** Refuse from this call onward. Atomic orders make at most one call; this
   * remains useful for proving that refusal is reported honestly. */
  promoteFailAfter?: number;
  pinCode?: number;
  induceCodes?: number[];
  depths?: number[];
  /** What `probe()` reports as connected, for the pin's act-time edge check. */
  probe?: string[];
} = {}): Rig {
  const state: Rig = { ns: undefined as unknown as NS, calls: [], walked: [] };
  let at: [number, number] = [1, 1];
  const exit = over.exit ?? [3, 3];
  let induceCall = 0;
  let promoteCall = 0;
  let describeCall = 0;
  state.ns = {
    dnet: {
      getServerDetails: () => ({
        isOnline: true,
        isConnectedToCurrentServer: true,
        hasSession: false,
        modelId: "(The Labyrinth)",
        passwordHint: "",
        data: "",
        logTrafficInterval: 30,
        passwordLength: 0,
        passwordFormat: "ASCII",
        blockedRam: 0,
        difficulty: 10,
        depth: over.depths?.[Math.min(describeCall++, (over.depths.length ?? 1) - 1)] ?? 3,
        requiredCharismaSkill: over.charismaGate ?? 1,
        isStationary: false,
      }),
      authenticate: (_host: string, word: string) => {
        state.calls.push(`authenticate:${word}`);
        state.walked.push(word);
        if ((over.charismaGate ?? 1) > 500) {
          return Promise.resolve({ success: false, code: 451, message: "You find yourself lost", data: "" });
        }
        const [dx, dy] = STEP[word] ?? [0, 0];
        // THE WALL RULE: the cell BETWEEN is what is tested, and a refusal
        // leaves the position untouched.
        if (MAZE[at[1] + dy]?.[at[0] + dx] !== " ") {
          return Promise.resolve({
            success: false,
            code: 401,
            message: `You cannot go that way. You are still at ${at[0]},${at[1]}.`,
            data: render(at[0], at[1]),
          });
        }
        at = [at[0] + dx * 2, at[1] + dy * 2];
        if (at[0] === exit[0] && at[1] === exit[1]) {
          return Promise.resolve({
            success: true,
            code: 200,
            message: "You have successfully navigated the labyrinth! Congratulations",
            data: "",
          });
        }
        return Promise.resolve({
          success: false,
          code: 401,
          message: `You have moved to ${at[0]},${at[1]}.`,
          data: render(at[0], at[1]),
        });
      },
      promoteStock: (symbol: string) => {
        state.calls.push(`promoteStock:${symbol}`);
        promoteCall++;
        const refuse = over.promoteFails === true
          || (over.promoteFailAfter !== undefined && promoteCall > over.promoteFailAfter);
        return Promise.resolve(refuse
          ? { success: false, code: 503, message: "no" }
          : { success: true, code: 200, message: "Success" });
      },
      labradar: () => {
        // The rig's maze is a hand-made sliver, so a radar has nothing honest
        // to render; a riddle-worded refusal makes the walker skip it, which is
        // exactly what the walk body must do in a game that answers the same way.
        state.calls.push("labradar");
        return Promise.resolve({ success: false, message: "You feel blind..." });
      },
      probe: () => {
        state.calls.push("probe");
        return over.probe ?? [];
      },
      setStasisLink: (should: boolean) => {
        state.calls.push(`setStasisLink:${String(should)}`);
        const code = over.pinCode ?? 200;
        return Promise.resolve(code === 200
          ? { success: true, code, message: "Stasis link applied" }
          : { success: false, code, message: "Stasis link limit reached" });
      },
      induceServerMigration: (host: string) => {
        state.calls.push(`induce:${host}`);
        const code = over.induceCodes?.[induceCall++] ?? 200;
        return Promise.resolve(code === 200
          ? { success: true, code, message: "Migration prep is now at 3%." }
          : { success: false, code, message: "Direct Connection Required" });
      },
    },
    ls: () => ["the_great_work_123.cache", "found.cct", "note.txt", "mail.msg", "story.lit"],
    getServerMaxRam: () => 32,
    getServerUsedRam: () => 0,
    getServer: () => ({ ip: "10.0.0.1" }),
  } as unknown as NS;
  return state;
}


function makeDeps(over: Partial<ControllerDeps> = {}, charisma = 1000): ControllerDeps {
  return {
    charisma: () => charisma,
    ledgerFor: () => undefined,
    ringFor: () => undefined,
    recordAttempt: () => {},
    recordLogDrain: () => {},
    recordCredential: () => {},
    recordLoose: () => {},
    recordProvisional: () => {},
    recordNeighbourPassword: () => {},
    recordFileEvidence: () => {},
    labField: () => undefined,
    publishLabField: () => {},
    ...over,
    timing: over.timing ?? (() => ({ charisma, intelligence: 0, hasBoots: false, sf15Level: 0, authenticationDurationMultiplier: 1 })),
    expectedDelayMs: over.expectedDelayMs ?? (() => 0),
  };
}

function makeIo(over: Partial<AgentIo> = {}, charisma = 1000): AgentIo {
  return { beat: () => {}, hold: () => {}, cancelled: () => undefined, deps: makeDeps({}, charisma), ...over, setExpectedDoneAt: over.setExpectedDoneAt ?? (() => {}), inFlight: over.inFlight ?? (() => {}) };
}

describe("the walker", () => {
  test("it walks the maze on parsed coordinates alone, and stops at the exit", async () => {
    const r = rig();
    const result = await runOrder(r.ns, makeOrder("walk", { host: LAB_LADDER[0]!.hostname, from: "dn-1" }, {}), makeIo());
    expect(result.ok, result.detail).toBe(true);
    expect(r.walked.length).toBeGreaterThan(0);
    // This is the production policy's selected blind probe, not a simulator
    // default: runWalk imports LAB_FIRST_PROBE and sends it to authenticate.
    expect(r.walked[0]).toBe("east");
    // Every word it sent is one the engine's parser accepts. The direction word
    // IS the password: there is no move call.
    for (const word of r.walked) expect(["north", "east", "south", "west"]).toContain(word);
    // The walker does NOT list the exit's `.cache` — no `ls` on the walk, so no
    // caches/contracts ride home. The ordinary worker `planSpread` re-plants here
    // the instant the walk ends reads it, paying `ls` on one resident instead of
    // on every authenticate thread.
    expect(result.hosts?.[0]?.caches).toBeUndefined();
    expect(result.hosts?.[0]?.contracts).toBeUndefined();
  });

  test("a wall does not move it, and it does not walk into the same wall twice", async () => {
    // The failure this rules out is the expensive one: a walker that assumed
    // its move landed would read every later response relative to a position it
    // invented, and nothing would ever correct it.
    const r = rig();
    const result = await runOrder(r.ns, makeOrder("walk", { host: LAB_LADDER[0]!.hostname, from: "dn-1" }, {}), makeIo());
    // The planner only ever steps into an edge the render showed open, so after
    // the blind first probe a wall is never chosen at all — which shows up here
    // as a walk that terminates in a handful of moves rather than by exhausting
    // the loop.
    expect(result.ok).toBe(true);
    expect(r.walked.length).toBeLessThan(10);
  });

  test("an unexpected act-time charisma refusal ends the walker immediately", async () => {
    // Every move would be a 451 and nothing would be learned, so the walk is a
    // host held for hours in exchange for refusals. The requirement travels to
    // home's existing career need instead.
    const r = rig({ charismaGate: 600 });
    const result = await runOrder(r.ns, makeOrder("walk", { host: LAB_LADDER[0]!.hostname, from: "dn-1" }, {}), makeIo({}, 300));
    expect(result.ok).toBe(false);
    expect(result.charismaNeeded).toBeUndefined();
    expect(r.walked).toEqual(["east"]);
  });

  test("it is the one long-lived kind, and it runs its host ALONE with no spawn", () => {
    // Position is `DarknetState.labLocations[pid]`: a dead PID abandons the walk
    // with no way to resume, which is what `longLived` and the beat exist for.
    // But it carries NO `spawn`: while it is the lab walker its host is the most
    // important in the net and runs it alone — every byte a spawn-back would cost
    // is an `authenticate` thread instead — and it ends by letting `planSpread`
    // re-plant the host as an ordinary worker once the lab is done (the
    // controller re-execs through the freed, now-immutable host).
    expect(KIND_CALLS["walk"]).not.toContain("spawn");
    // And NO `heartbleed`, ever: the lab answers through `authenticate`'s own
    // return value, and the only extra vision the walker pays for — `labradar` —
    // is a same-PID, 0 GB call whose render also comes back in the return value.
    expect(KIND_CALLS["walk"]).toContain("dnet.labradar");
    expect(KIND_CALLS["walk"]).not.toContain("dnet.heartbleed");
    // Its ONLY job is to walk to completion — no `ls` (the exit cache is read by
    // the ordinary worker re-planted afterwards) and no `getServer` (2.0 GB of ip
    // the controller never uses), so its per-thread price is as small as possible
    // and the thread count as large as possible.
    expect(KIND_CALLS["walk"]).not.toContain("ls");
    expect(KIND_CALLS["walk"]).not.toContain("getServer");
  });

  test("it beats every move, so its queue is not swept out from under it", async () => {
    // A long-lived job is skipped by the controller's timeout loop, so its own
    // beat is the only evidence it is alive. Without it the claim sweep would
    // drop the walk after a minute and a second vantage would file a SECOND
    // walker: two PIDs in one maze.
    const r = rig();
    const beats: Record<string, unknown>[] = [];
    await runOrder(r.ns, makeOrder("walk", { host: LAB_LADDER[0]!.hostname, from: "dn-1" }, {}), makeIo({
      beat: (progress) => {
        if (progress) beats.push(progress);
      },
    }));
    // One beat per response that was not the exit: the last move settles the
    // job rather than beating.
    expect(beats.length).toBe(r.walked.length - 1);
    expect(beats[beats.length - 1]).toHaveProperty("at");
    expect(beats[beats.length - 1]).toHaveProperty("learned");
  });

  test("it publishes its map through the controller, and a successor walks the seeded maze straighter", async () => {
    // The one piece of walk progress that survives a PID: the field. The first
    // walker pays for the map; a re-seeded successor starts from it and stops
    // paying for walls the first one already found.
    let shared: LabField | undefined;
    const io = makeIo();
    io.deps.labField = () => shared;
    io.deps.publishLabField = (_host, field) => { shared = field; };
    const first = rig();
    const blind = await runOrder(first.ns, makeOrder("walk", { host: LAB_LADDER[0]!.hostname, from: "dn-1" }, {}), io);
    expect(blind.ok).toBe(true);
    expect(shared).toBeDefined();
    expect(Object.keys(shared!.slots).length).toBeGreaterThan(0);

    const second = rig();
    const seeded = await runOrder(second.ns, makeOrder("walk", { host: LAB_LADDER[0]!.hostname, from: "dn-1" }, {}), io);
    expect(seeded.ok).toBe(true);
    expect(second.walked.length).toBeLessThanOrEqual(first.walked.length);
  });

});

describe("the pin", () => {
  test("a required edge is probed at act time, and a severed one refuses WITHOUT spending", async () => {
    // The mutation clock can cut every connection on one host between the
    // derivation that planned this pin and the 12 GB call landing. A pin
    // freezes edges only from the moment it is applied, so the last look
    // happens here — and a refusal must not touch `setStasisLink`, because the
    // slot is near-irrevocable (no job carries the release).
    const r = rig({ probe: ["dn-9", "dn-2"] });
    const result = await runOrder(r.ns, makeOrder("pin", { host: "dn-1", from: "dn-1" }, { edge: "th3_l4byr1nth" }), makeIo());
    expect(result.ok).toBe(false);
    expect(result.codes).toEqual({ "912": 1 });
    expect(r.calls).toContain("probe");
    expect(r.calls).not.toContain("setStasisLink:true");

    // With the edge alive, the pin proceeds.
    const alive = rig({ probe: ["th3_l4byr1nth", "dn-2"] });
    const pinned = await runOrder(alive.ns, makeOrder("pin", { host: "dn-1", from: "dn-1" }, { edge: "th3_l4byr1nth" }), makeIo());
    expect(pinned.ok).toBe(true);
    expect(alive.calls).toContain("setStasisLink:true");
  });

  test("the unpin direction releases the link, and never probes for an edge", async () => {
    // A release is filed precisely BECAUSE the edge is gone, so the pin's
    // act-time edge check must not apply — it would refuse the one job that
    // frees the slot.
    const r = rig({ probe: [] });
    const result = await runOrder(r.ns, makeOrder("pin", { host: "dn-1", from: "dn-1" }, { unpin: true, edge: "th3_l4byr1nth" }), makeIo());
    expect(result.ok).toBe(true);
    expect(r.calls).toContain("setStasisLink:false");
    expect(r.calls).not.toContain("probe");
    expect(result.detail).toContain("released");
  });

  test("it pins the host it is standing on and reports the code", async () => {
    const r = rig();
    const result = await runOrder(r.ns, makeOrder("pin", { host: "dn-1", from: "dn-1" }, {}), makeIo());
    expect(result.ok).toBe(true);
    // No hostname: `setStasisLink` takes none, which is the whole reason a pin
    // needs a resident standing on the host being pinned.
    expect(r.calls).toContain("setStasisLink:true");
    expect(result.codes).toEqual({ "200": 1 });
  });

  test("a 453 is reported rather than swallowed", async () => {
    // The limit is GLOBAL — `1 + TheBrokenWings + TheHammer + TheStaff` — so a
    // 453 means home's belief about which hosts are pinned has drifted from the
    // engine's, and reporting success would spend the belief as well as the
    // call.
    const r = rig({ pinCode: 453 });
    const result = await runOrder(r.ns, makeOrder("pin", { host: "dn-1", from: "dn-1" }, {}), makeIo());
    expect(result.ok).toBe(false);
    expect(result.codes).toEqual({ "453": 1 });
  });
});

describe("the push", () => {
  test("it charges the NEIGHBOUR exactly once and notices a landing", async () => {
    // `induceServerMigration` refuses its own host, so `order.host` is the
    // target and `order.from` is where the process stands. The accumulated
    // charge is engine state no member reads back, so the only evidence a move
    // landed is the DEPTH changing.
    // Two readings of the depth: the one the job takes before its first call,
    // and the one `describeHost` takes after its last. In the game the batch is
    // bounded by wall clock — six seconds a call against forty of batch — so a
    // fake engine that answers instantly has to be bounded by a refusal
    // instead.
    const r = rig({ depths: [3, 1], induceCodes: [200] });
    const result = await runOrder(r.ns, makeOrder("induce", { host: "dn-2", from: "dn-1" }, {}), makeIo());
    expect(result.ok).toBe(true);
    expect(r.calls.filter((call) => call.startsWith("induce:")).length).toBe(1);
    expect(r.calls[0]).toBe("induce:dn-2");
    // The landing, inferred from the only evidence there is.
    expect(result.detail).toContain("migrated from depth 3 to 1");
  });

  test("a refusal still consumes only the order's one call", async () => {
    // A 351 is the vantage gone, and every later call in the batch would answer
    // the same thing six seconds apart.
    const r = rig({ induceCodes: [351] });
    const result = await runOrder(r.ns, makeOrder("induce", { host: "dn-2", from: "dn-1" }, {}), makeIo());
    expect(r.calls.filter((call) => call.startsWith("induce:")).length).toBe(1);
    expect(result.codes).toEqual({ "351": 1 });
  });
});

describe("propaganda", () => {
  test("a job cannot be given a promote it has no symbol for", () => {
    // Nothing standing on a darknet host can see the market, so the symbol is
    // home's or there is no job. That used to be a runtime guard in the body
    // ("no symbol; a job never invents one") answering with local code 902,
    // one wasted order after the mistake. `promote`'s payload requires the
    // symbol, so the order cannot be built at all — and `@ts-expect-error`
    // fails the build if that ever stops being true.
    // @ts-expect-error - promote requires { symbol }
    makeOrder("promote", { host: "dn-1" }, {});
  });

  test("each order spreads exactly once", async () => {
    const r = rig({ promoteFailAfter: 3 });
    const result = await runOrder(r.ns, makeOrder("promote", { host: "dn-1", from: "dn-1" }, { symbol: "ECP" }), makeIo());
    expect(result.ok).toBe(true);
    // Three that paid, and the fourth — the refusal — ends the batch.
    expect(r.calls.filter((call) => call === "promoteStock:ECP").length).toBe(1);
    expect(result.detail).toContain("one promotion of ECP");

    const refused = rig({ promoteFails: true });
    const stopped = await runOrder(refused.ns, makeOrder("promote", { host: "dn-1", from: "dn-1" }, { symbol: "ECP" }), makeIo());
    expect(stopped.ok).toBe(false);
    expect(refused.calls.filter((call) => call === "promoteStock:ECP").length).toBe(1);
  });
});

describe("the storm job", () => {
  /** A purpose-built fake: the storm body touches only `ls`, the fire member
   * and (on the 404 path) describeHost's getters. */
  const stormRig = (over: { seeded?: boolean; fireOk?: boolean } = {}) => {
    const calls: string[] = [];
    const ns = {
      dnet: {
        unleashStormSeed: () => {
          calls.push("unleashStormSeed");
          return over.fireOk === false
            ? { success: false, code: 503, message: "Service Unavailable" }
            : { success: true, code: 200, message: "The webstorm approaches." };
        },
        getServerDetails: () => ({
          isOnline: true, depth: 3, blockedRam: 0, requiredCharismaSkill: 1,
          difficulty: 10, isStationary: false, modelId: "PlainVanilla",
          passwordLength: 8, passwordFormat: "ASCII", passwordHint: "", data: "",
          logTrafficInterval: 30,
        }),
      },
      ls: () => (over.seeded === false ? ["cache_1.cache"] : ["STORM_SEED.exe", "cache_1.cache"]),
      getServerMaxRam: () => 32,
      getServerUsedRam: () => 0,
    } as unknown as NS;
    return { ns, calls };
  };

  test("a stale sighting is a 404 report, not a spent call", async () => {
    // The listing is re-read before firing, exactly as the cache job re-reads
    // its filename: the seed can be consumed or deleted between the derivation
    // and the job. The failure report carries `stormSeed: false`, which is
    // what retires the stale fact on the next fold.
    const r = stormRig({ seeded: false });
    const result = await runOrder(r.ns, makeOrder("storm", { host: "dn-1", from: "dn-1" }, {}), makeIo());
    expect(result.ok).toBe(false);
    expect(result.codes).toEqual({ "404": 1 });
    expect(r.calls).toEqual([]);
    expect((result.hosts?.[0] as { stormSeed?: boolean } | undefined)?.stormSeed).toBe(false);
    expect(result.stormFiredAt).toBeUndefined();
  });

  test("a fire stamps its own clock and reports nothing else", async () => {
    // The success path is deliberately minimal — no describeHost, because the
    // host dies seconds later and the facts are about to be garbage. The stamp
    // is the whole payload.
    const r = stormRig();
    const result = await runOrder(r.ns, makeOrder("storm", { host: "dn-1", from: "dn-1" }, {}), makeIo());
    expect(result.ok).toBe(true);
    expect(r.calls).toEqual(["unleashStormSeed"]);
    expect(result.stormFiredAt).toBeDefined();
    expect(result.hosts).toBeUndefined();
  });

  test("an engine refusal carries no stamp, so the controller's pessimistic one rolls back", async () => {
    const r = stormRig({ fireOk: false });
    const result = await runOrder(r.ns, makeOrder("storm", { host: "dn-1", from: "dn-1" }, {}), makeIo());
    expect(result.ok).toBe(false);
    expect(result.codes).toEqual({ "503": 1 });
    expect(result.stormFiredAt).toBeUndefined();
  });

  test("the kind is deliberate: not routine, and priced", () => {
    expect(KIND_CALLS["storm"]).toContain("dnet.unleashStormSeed");
    expect(KIND_CALLS["storm"]).toContain("ls");
  });
});
