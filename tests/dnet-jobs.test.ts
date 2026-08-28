import { describe, expect, test } from "bun:test";
import {
  JOBS, TASK_KINDS, canPreempt, isSameTurn, priorityOf, type TaskKind,
} from "../shared/strategy/dnet/jobs.ts";
import { KIND_CALLS, ORDER_PRICES } from "../game/dnet/shared.ts";

/** The kind table is now the single authority for every per-kind scheduling
 * fact, so the facts are checked HERE, once, instead of being asserted
 * piecemeal wherever they happened to be read.
 *
 * These are shape and consistency checks. The BEHAVIOUR built on them — victim
 * selection, the farm ladder, the storm gates, each order body — is tested
 * where that behaviour lives. */
describe("the darknet job table", () => {
  test("every kind is priced and has a call surface, and vice versa", () => {
    // A kind exists only if it has a row, a price, and a declared surface.
    for (const kind of TASK_KINDS) {
      expect(ORDER_PRICES[kind], `${kind} has no price`).toBeGreaterThan(0);
      expect(KIND_CALLS[kind], `${kind} has no declared surface`).toBeDefined();
    }
    // The extra key is the private bootstrap call: priced, but never planned
    // or dispatched through the order switch.
    const priced = new Set(Object.keys(ORDER_PRICES));
    for (const kind of TASK_KINDS) priced.delete(kind);
    expect([...priced].sort()).toEqual(["bootstrapReclaim"]);
  });

  test("priorities are unique, so queue order never depends on the tie-break", () => {
    const seen = new Map<number, TaskKind>();
    for (const kind of TASK_KINDS) {
      const at = priorityOf(kind);
      expect(seen.get(at), `${kind} and ${seen.get(at)} share priority ${at}`).toBeUndefined();
      seen.set(at, kind);
    }
  });

  test("the bootstrap call is not schedulable work", () => {
    // `priorityOf` answering +Infinity keeps it out of every comparison.
    expect(priorityOf("bootstrapReclaim")).toBe(Number.POSITIVE_INFINITY);
    expect(isSameTurn("bootstrapReclaim")).toBe(false);
    expect(canPreempt("bootstrapReclaim", "promote")).toBe(false);
  });

  test("exactly four kinds may cancel running work", () => {
    // `promote` is the cheapest thing a host can be doing, so anything allowed
    // to preempt at all outranks it. That makes this the whole preempting set.
    const preempting = TASK_KINDS.filter((kind) => canPreempt(kind, "promote"));
    expect(preempting.sort()).toEqual(["attempt", "pin", "plant", "walk"]);

    // Farm work is filed only onto an already-spare host, so a farm kind that
    // preempted would cancel an order it cannot then replace: the host is not
    // spare in the pass that cancelled, the next derive re-files the victim,
    // and the two loop at engine speed. Observed exactly that way — a cache on
    // one vantage killed a fresh attempt every pass, ~1ms after it adopted,
    // for thousands of spawns, and the cache never ran once.
    expect(preempting.filter((k) => JOBS[k].farm)).toEqual([]);
    // Same-turn work settles instantly, so it has nothing to gain by
    // cancelling: it queues ahead of blocking work and waits for a free slot.
    expect(preempting.filter(isSameTurn)).toEqual([]);
  });

  test("the same-turn lane is the instant work, and only that", () => {
    expect(TASK_KINDS.filter(isSameTurn).sort()).toEqual(["inventory", "relaunchProbe"]);
  });

  test("protected work cannot be displaced by anything", () => {
    // A walk holds a PID-bound maze position, a pin is one atomic 12 GB call,
    // and a storm has already consumed its seed by the time it reports.
    const protectedKinds = TASK_KINDS.filter((victim) =>
      TASK_KINDS.every((incoming) => !canPreempt(incoming, victim)));
    expect(protectedKinds).toContain("walk");
    expect(protectedKinds).toContain("pin");
    expect(protectedKinds).toContain("storm");
  });

  test("only the two host-consuming kinds are exempt from release", () => {
    // A pin is one atomic call whose result we need; a walk is PID-BOUND, so
    // dropping out of a move loses the maze. Both still stop at their own next
    // boundary. Both also end by leaving the host empty, which is the same
    // pair for a different reason — so the two flags travel together.
    expect(TASK_KINDS.filter((k) => JOBS[k].releaseExempt).sort()).toEqual(["pin", "walk"]);
    expect(TASK_KINDS.filter((k) => JOBS[k].consumesHost).sort()).toEqual(["pin", "walk"]);
  });

  test("no kind carries a launcher", () => {
    // Every worker is exec'd by the controller through the host's lender, so
    // nothing pays the 2.0 GB for `spawn` — and `ramOverride` is charged PER
    // THREAD, so one stray declaration would cost that on every thread.
    for (const kind of Object.keys(KIND_CALLS)) {
      expect(KIND_CALLS[kind as TaskKind], `${kind} must not spawn`).not.toContain("spawn");
    }
  });
});
