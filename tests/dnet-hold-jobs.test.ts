import { describe, expect, test } from "bun:test";
import type { NS } from "@ns";
import { makeJobBodies } from "../game/dnet/jobs.ts";
import { NO_RESPAWN_KINDS, JOB_METHODS } from "../game/dnet/realm.ts";
import { LAB_LADDER } from "../shared/strategy/dnet/rates.ts";

/** The four DELIBERATE job bodies, driven against a fake `ns`.
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
  /** Refuse from this call onward, so a batch bounded by WALL CLOCK in the game
   *  is bounded by the fake engine here. Every farm batch runs until its next
   *  call would overrun `FARM_BATCH_MS`, and against an `ns` that answers
   *  instantly that is forty seconds of spinning — so these tests end their
   *  batches the way a real one usually ends: the engine says no. */
  promoteFailAfter?: number;
  pinCode?: number;
  induceCodes?: number[];
  depths?: number[];
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
    ls: () => ["the_great_work_123.cache"],
    getServerMaxRam: () => 32,
    getServerUsedRam: () => 0,
    getHostname: () => "dn-1",
  } as unknown as NS;
  return state;
}

const bodies = (charisma = 1000) => makeJobBodies({ charisma: () => charisma, ledgerFor: () => undefined });

describe("the walker", () => {
  test("it walks the maze on parsed coordinates alone, and stops at the exit", async () => {
    const r = rig();
    const result = await bodies().walk!(r.ns, { host: LAB_LADDER[0]!.hostname, from: "dn-1" });
    expect(result.ok, result.detail).toBe(true);
    expect(r.walked.length).toBeGreaterThan(0);
    // Every word it sent is one the engine's parser accepts. The direction word
    // IS the password: there is no move call.
    for (const word of r.walked) expect(["north", "east", "south", "west"]).toContain(word);
    // The lab's cache listing rides home with the success, because reaching the
    // exit is what drops it.
    expect(result.hosts?.[0]!.caches).toContain("the_great_work_123.cache");
  });

  test("a wall does not move it, and it does not walk into the same wall twice", async () => {
    // The failure this rules out is the expensive one: a walker that assumed
    // its move landed would read every later response relative to a position it
    // invented, and nothing would ever correct it.
    const r = rig();
    const result = await bodies().walk!(r.ns, { host: LAB_LADDER[0]!.hostname, from: "dn-1" });
    // The DFS only ever steps into a direction the render showed open, so after
    // the blind first probe a wall is never chosen twice from the same cell —
    // which shows up here as a walk that terminates at all, in a handful of
    // moves rather than by exhausting the loop.
    expect(result.ok).toBe(true);
    expect(r.walked.length).toBeLessThan(10);
  });

  test("below the lab's charisma it refuses to START, and posts the need", async () => {
    // Every move would be a 451 and nothing would be learned, so the walk is a
    // host held for hours in exchange for refusals. The requirement travels to
    // home's existing career need instead.
    const r = rig({ charismaGate: 600 });
    const result = await bodies(300).walk!(r.ns, { host: LAB_LADDER[0]!.hostname, from: "dn-1" });
    expect(result.ok).toBe(false);
    expect(result.charismaNeeded).toBe(600);
    // ...and it never sent a single move.
    expect(r.walked).toEqual([]);
  });

  test("it is the one long-lived kind, and it never spawns mid-walk", () => {
    // Position is `DarknetState.labLocations[pid]`: a dead PID abandons the
    // walk with no way to resume. `spawn` ends the PID, so the walk has to be
    // one process from start to finish — which is what `longLived` and the beat
    // exist for.
    expect(JOB_METHODS["walk"]).toContain("spawn");
    expect(NO_RESPAWN_KINDS).not.toContain("walk");
  });

  test("it beats every move, so its queue is not swept out from under it", async () => {
    // A long-lived job is skipped by the controller's timeout loop, so its own
    // beat is the only evidence it is alive. Without it the claim sweep would
    // drop the walk after a minute and a second vantage would file a SECOND
    // walker: two PIDs in one maze.
    const r = rig();
    const beats: Record<string, unknown>[] = [];
    await bodies().walk!(r.ns, { host: LAB_LADDER[0]!.hostname, from: "dn-1" }, (progress) => {
      if (progress) beats.push(progress);
    });
    // One beat per response that was not the exit: the last move settles the
    // job rather than beating.
    expect(beats.length).toBe(r.walked.length - 1);
    expect(beats[beats.length - 1]).toHaveProperty("at");
    expect(beats[beats.length - 1]).toHaveProperty("visited");
  });
});

describe("the pin", () => {
  test("it pins the host it is standing on and reports the code", async () => {
    const r = rig();
    const result = await bodies().pin!(r.ns, { host: "dn-1", from: "dn-1" });
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
    const result = await bodies().pin!(r.ns, { host: "dn-1", from: "dn-1" });
    expect(result.ok).toBe(false);
    expect(result.codes).toEqual({ "453": 1 });
  });
});

describe("the push", () => {
  test("it charges the NEIGHBOUR, in a bounded batch, and notices a landing", async () => {
    // `induceServerMigration` refuses its own host, so `state.host` is the
    // target and `state.from` is where the process stands. The accumulated
    // charge is engine state no member reads back, so the only evidence a move
    // landed is the DEPTH changing.
    // Two readings of the depth: the one the job takes before its first call,
    // and the one `describeHost` takes after its last. In the game the batch is
    // bounded by wall clock — six seconds a call against forty of batch — so a
    // fake engine that answers instantly has to be bounded by a refusal
    // instead.
    const r = rig({ depths: [3, 1], induceCodes: [200, 200, 351] });
    const result = await bodies().induce!(r.ns, { host: "dn-2", from: "dn-1" });
    expect(result.ok).toBe(true);
    expect(r.calls.filter((call) => call.startsWith("induce:")).length).toBe(3);
    expect(r.calls[1]).toBe("induce:dn-2");
    // The landing, inferred from the only evidence there is.
    expect(result.detail).toContain("migrated from depth 3 to 1");
  });

  test("it stops on the first refusal rather than spending the batch", async () => {
    // A 351 is the vantage gone, and every later call in the batch would answer
    // the same thing six seconds apart.
    const r = rig({ induceCodes: [200, 351] });
    const result = await bodies().induce!(r.ns, { host: "dn-2", from: "dn-1" });
    expect(r.calls.filter((call) => call.startsWith("induce:")).length).toBe(2);
    expect(result.codes).toEqual({ "200": 1, "351": 1 });
  });
});

describe("propaganda", () => {
  test("a job never invents a symbol", async () => {
    // Nothing standing on a darknet host can see the market, so the symbol is
    // home's or there is no job.
    const r = rig();
    const result = await bodies().promote!(r.ns, { host: "dn-1", from: "dn-1" });
    expect(result.ok).toBe(false);
    expect(result.codes).toEqual({ "902": 1 });
    expect(r.calls).toEqual([]);
  });

  test("it spreads in a bounded batch and stops on a refusal", async () => {
    const r = rig({ promoteFailAfter: 3 });
    const result = await bodies().promote!(r.ns, { host: "dn-1", from: "dn-1", symbol: "ECP" });
    expect(result.ok).toBe(true);
    // Three that paid, and the fourth — the refusal — ends the batch.
    expect(r.calls.filter((call) => call === "promoteStock:ECP").length).toBe(4);
    expect(result.detail).toContain("3 promotions of ECP");

    const refused = rig({ promoteFails: true });
    const stopped = await bodies().promote!(refused.ns, { host: "dn-1", from: "dn-1", symbol: "ECP" });
    expect(stopped.ok).toBe(false);
    expect(refused.calls.filter((call) => call === "promoteStock:ECP").length).toBe(1);
  });
});
