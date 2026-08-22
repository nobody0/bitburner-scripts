import { describe, expect, test } from "bun:test";
import {
  JOB_TIMEOUT_MS,
  LONG_JOB_BEAT_MS,
  sweepClaims,
  type DnetClaim,
  type DnetHostQueue,
  type DnetJob,
} from "../game/dnet/realm.ts";
import { stripCredentials } from "../shared/strategy/dnet/courier.ts";

/** A claim is the one piece of darknet state that is neither knowledge nor a
 * queue: it says "a process is alive doing this to that host, right now".
 *
 * Everything else in the feature is derived, so it self-heals — a stale fact
 * simply re-derives its task. A claim cannot work that way, because its whole
 * job is to SUPPRESS a derivation, so a claim that outlives its process silences
 * work that nobody is doing. These tests are therefore about the three ways a
 * claim dies, and about the one case where it must not. */

const NOW = 1_000_000;

function job(over: Partial<DnetJob> = {}): DnetJob {
  return {
    id: "attempt:dn-1",
    kind: "attempt",
    label: "test",
    budgetGb: 4,
    threads: 1,
    priority: 0,
    longLived: false,
    state: { host: "dn-1", from: "dn-0" },
    body: async () => ({ ok: true }),
    settle: () => {},
    fail: () => {},
    ...over,
  };
}

function queues(over: Partial<DnetHostQueue> = {}): Map<string, DnetHostQueue> {
  return new Map([[
    "dn-0",
    { host: "dn-0", pending: [job()], lastBeatAt: NOW, completed: 0, failed: 0, ...over },
  ]]);
}

function claim(over: Partial<DnetClaim> = {}): Map<string, DnetClaim[]> {
  const entry: DnetClaim = {
    target: "dn-1",
    from: "dn-0",
    kind: "attempt",
    jobId: "attempt:dn-1",
    claimedAt: NOW,
    expectedDoneAt: NOW + JOB_TIMEOUT_MS,
    ...over,
  };
  return new Map([[entry.target, [entry]]]);
}

describe("a claim dies with the thing that made it true", () => {
  test("a live job's claim survives, and that is the whole point", () => {
    // The case every other assertion here is the exception to. While the job is
    // filed and the window is open, `attempt:dn-1` must not be derived again —
    // it has no fact stamp, so without this it re-derives on every 2 s tick for
    // the whole duration of a multi-second authenticate.
    const held = claim();
    expect(sweepClaims(held, queues(), NOW + 1_000)).toEqual([]);
    expect(held.get("dn-1")).toHaveLength(1);
  });

  test("the vantage is gone: no queue, no claim", () => {
    // `sweepQueues` deletes a retired resident's queue, and this runs right
    // after it, so "the vantage died" costs no clock and cannot disagree with
    // the sweep that decided it. A resident dies with its host out here, and
    // whatever it was holding died with it.
    const held = claim();
    const dropped = sweepClaims(held, new Map(), NOW);
    expect(dropped).toHaveLength(1);
    expect(dropped[0]!.target).toBe("dn-1");
    expect(held.size).toBe(0);
  });

  test("the job left the queue: settled, failed or timed out, all the same", () => {
    // The completion protocol that is deliberately absent. A job that settled
    // is no longer pending and no longer active, and the tick that cleared it is
    // the tick that ends its claim — so there is no acknowledgement to lose.
    const held = claim();
    expect(sweepClaims(held, queues({ pending: [] }), NOW)).toHaveLength(1);
    expect(held.size).toBe(0);

    // ...and a job that is ACTIVE rather than pending is still filed.
    const running = claim();
    expect(sweepClaims(running, queues({ pending: [], active: job() }), NOW)).toEqual([]);
  });

  test("a claim for a DIFFERENT job on the same vantage is not kept alive by it", () => {
    // The queue is per-host and holds several jobs, so "the vantage is alive" is
    // not the question — the claim names one job id, and only that one counts.
    const held = claim({ jobId: "attempt:dn-2" });
    expect(sweepClaims(held, queues(), NOW)).toHaveLength(1);
  });

  test("past its window a claim expires, however healthy the queue looks", () => {
    // The one rule that needs a clock. It exists for the case the structural
    // pair cannot see: a job still sitting in a queue long after the adjacency
    // it depends on has rotated away underneath it.
    const held = claim();
    expect(sweepClaims(held, queues(), NOW + JOB_TIMEOUT_MS)).toEqual([]);
    expect(sweepClaims(held, queues(), NOW + JOB_TIMEOUT_MS + 1)).toHaveLength(1);
  });

  test("other targets' claims are left alone", () => {
    const held = claim();
    held.set("dn-9", [{
      target: "dn-9",
      from: "dn-0",
      kind: "bleed",
      jobId: "bleed:dn-9",
      claimedAt: NOW,
      expectedDoneAt: NOW + JOB_TIMEOUT_MS,
    }]);
    // dn-9's job is not in the queue, dn-1's is: exactly one dies.
    expect(sweepClaims(held, queues(), NOW)).toHaveLength(1);
    expect([...held.keys()]).toEqual(["dn-1"]);
  });
});

describe("a claim carries a credential, and it never leaves the realm", () => {
  test("stripCredentials empties a claim's password if one ever reaches a channel", () => {
    // Claims are not drained and not published — that is the primary defence,
    // and it is structural. This is the backstop `courier.ts` exists to be: the
    // field is named `password`, so any channel that ever carried a claim would
    // still not carry the secret.
    const held = claim({ password: "hunter2" })!.get("dn-1")!;
    const stripped = stripCredentials(held);
    expect(JSON.stringify(stripped)).not.toContain("hunter2");
    // ...and the rest of the claim survives, so the panel could still say what
    // is in flight.
    expect(stripped[0]!.target).toBe("dn-1");
    expect(stripped[0]!.kind).toBe("attempt");
  });
});

describe("a job that is MEANT to sit there keeps its claim", () => {
  // The failure this guards is silent and total. `DarknetState.labLocations` is
  // keyed by PID, so one process must walk an entire maze — a dead PID abandons
  // the walk and the next one is re-seeded at a random offset. A deep lab is
  // 60x40 and takes hours.
  //
  // Judged by `JOB_TIMEOUT_MS`, that walker's claim died after sixty seconds.
  // The derivation then stopped seeing the lab as busy and filed a second
  // walker from another vantage: two PIDs in one maze, which is exactly what
  // the claim exists to prevent, and neither would ever finish.
  const walker = (over: Partial<DnetJob> = {}): DnetJob =>
    job({ id: "maze:lab", kind: "maze", longLived: true, state: { host: "lab", from: "dn-0" }, ...over });

  const held = (jobs: DnetJob[]): Map<string, DnetClaim[]> =>
    new Map([["lab", [{
      target: "lab",
      from: "dn-0",
      kind: "maze" as never,
      jobId: "maze:lab",
      claimedAt: NOW,
      expectedDoneAt: NOW + JOB_TIMEOUT_MS,
    }]]]);

  const withJob = (j: DnetJob): Map<string, DnetHostQueue> =>
    new Map([["dn-0", { host: "dn-0", pending: [], active: j, lastBeatAt: NOW, completed: 0, failed: 0 }]]);

  test("a beating walker outlives the ordinary job timeout many times over", () => {
    const beating = walker({ startedAt: NOW, beatAt: NOW + 50 * JOB_TIMEOUT_MS });
    const claims = held([beating]);
    // An hour in, and still going.
    const dropped = sweepClaims(claims, withJob(beating), NOW + 50 * JOB_TIMEOUT_MS + 1_000);
    expect(dropped).toHaveLength(0);
    expect(claims.get("lab")).toHaveLength(1);
  });

  test("but a walker that stopped beating still loses its claim", () => {
    // The exemption is from the fixed timeout, not from liveness: a process that
    // died with its host must still release the lab, or nothing can ever walk it
    // again. Same rule `residentLastLife` uses.
    const silent = walker({ startedAt: NOW, beatAt: NOW });
    const claims = held([silent]);
    const dropped = sweepClaims(claims, withJob(silent), NOW + LONG_JOB_BEAT_MS + 1);
    expect(dropped).toHaveLength(1);
    expect(claims.has("lab")).toBe(false);
  });

  test("a short job is unaffected — it is still judged by the fixed timeout", () => {
    const short = job({ startedAt: NOW, beatAt: NOW });
    const claims = claim();
    const queue = new Map([[
      "dn-0",
      { host: "dn-0", pending: [], active: short, lastBeatAt: NOW, completed: 0, failed: 0 },
    ]]);
    expect(sweepClaims(claims, queue, NOW + JOB_TIMEOUT_MS + 1)).toHaveLength(1);
  });
});
