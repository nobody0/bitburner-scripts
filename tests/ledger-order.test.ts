/** The ordered ledger replaces "materialise the whole in-flight set and sort
 * it" on the dispatcher's hot path, so its order has to be indistinguishable
 * from that sort — including the tie-break at equal landings, which decides
 * which of two same-instant operations folds first and is therefore observable
 * in every prediction downstream.
 *
 * Held against a plain sorted array after every mutation, over randomized
 * lifecycles, in the style of `tests/dispatch-index.test.ts`. */
import { describe, expect, test } from "bun:test";
import { mulberry32 } from "../sim/core/rng.ts";
import { OrderedLedger, type LedgerKeyed } from "../shared/strategy/ledger-order.ts";

interface Entry extends LedgerKeyed {
  readonly landing: number;
  readonly opId: number;
  /** A field that changes after insertion, to pin that entries are held by
   * reference rather than copied. */
  threads: number;
}

const key = (entry: Entry): string => `${entry.landing}:${entry.opId}`;

/** What a sort of the same entries would produce. */
function expected(entries: readonly Entry[]): string[] {
  return [...entries]
    .sort((a, b) => a.landing - b.landing || a.opId - b.opId)
    .map(key);
}

describe("ordered ledger", () => {
  test("matches a sorted array through randomized inserts and removals", () => {
    const random = mulberry32(20260820);
    const ledger = new OrderedLedger<Entry>();
    const live: Entry[] = [];
    let nextOpId = 1;

    for (let step = 0; step < 4_000; step++) {
      if (random() < 0.6 || live.length === 0) {
        const entry: Entry = {
          // Landings collide deliberately and often: a spread weaken is many
          // operations on one landing, and negative ids (pending work) sort
          // against positive ones (tracked work) at the same instant.
          landing: Math.floor(random() * 40) * 5,
          opId: random() < 0.3 ? -nextOpId : nextOpId,
          threads: 1,
        };
        nextOpId++;
        ledger.insert(entry);
        live.push(entry);
      } else {
        const at = Math.floor(random() * live.length);
        const [gone] = live.splice(at, 1);
        expect(ledger.remove(gone!.landing, gone!.opId)).toBe(true);
      }
      if (step % 25 === 0 || live.length < 4) {
        expect([...ledger].map(key)).toEqual(expected(live));
        expect(ledger.size).toBe(live.length);
      }
    }

    expect([...ledger].map(key)).toEqual(expected(live));
    for (const entry of live) expect(ledger.remove(entry.landing, entry.opId)).toBe(true);
    expect(ledger.size).toBe(0);
    expect([...ledger]).toEqual([]);
  });

  test("survives crossing the chunk boundary in both directions", () => {
    // 512 is the split threshold, so a run that grows well past it and then
    // drains exercises every split and every chunk drop.
    const ledger = new OrderedLedger<Entry>();
    const entries: Entry[] = [];
    for (let i = 0; i < 2_000; i++) {
      const entry = { landing: i * 5, opId: i, threads: 1 };
      entries.push(entry);
      ledger.insert(entry);
    }
    expect([...ledger].map(key)).toEqual(expected(entries));

    // Remove from the head, as landings actually drain.
    for (let i = 0; i < 1_500; i++) expect(ledger.remove(i * 5, i)).toBe(true);
    expect(ledger.size).toBe(500);
    expect([...ledger].map(key)).toEqual(expected(entries.slice(1_500)));

    // And re-fill into the middle, which is where a tail-only structure breaks.
    for (let i = 0; i < 800; i++) {
      const entry = { landing: 7_500 + i * 2, opId: 100_000 + i, threads: 1 };
      entries.push(entry);
      ledger.insert(entry);
    }
    expect([...ledger].map(key)).toEqual(expected(entries.filter((e) => e.landing >= 7_500)));
  });

  test("inserts before an existing entry at the same landing by opId", () => {
    const ledger = new OrderedLedger<Entry>();
    ledger.insert({ landing: 100, opId: 5, threads: 1 });
    ledger.insert({ landing: 100, opId: -2, threads: 1 });
    ledger.insert({ landing: 100, opId: -7, threads: 1 });
    ledger.insert({ landing: 90, opId: 900, threads: 1 });
    // Pending work carries negative ids and folds before tracked work at the
    // same instant; more-negative folds first. This is the relation the old
    // rebuild produced by construction, and dropping it silently changes
    // which operation a prediction sees first.
    expect([...ledger].map(key)).toEqual(["90:900", "100:-7", "100:-2", "100:5"]);
  });

  test("holds entries by reference, so a later resize is visible", () => {
    const ledger = new OrderedLedger<Entry>();
    const entry: Entry = { landing: 10, opId: 1, threads: 4 };
    ledger.insert(entry);
    // An arrival brake shrinks an operation after it is in flight; the fold
    // must see the new size, which only works if nothing here copied it.
    entry.threads = 1;
    expect([...ledger][0]!.threads).toBe(1);
  });

  test("refuses to remove a key it does not hold", () => {
    const ledger = new OrderedLedger<Entry>();
    ledger.insert({ landing: 10, opId: 1, threads: 1 });
    expect(ledger.remove(10, 2)).toBe(false);
    expect(ledger.remove(11, 1)).toBe(false);
    expect(ledger.size).toBe(1);
  });

  test("a cursor resumes where it stopped", () => {
    const ledger = new OrderedLedger<Entry>();
    for (let i = 0; i < 1_200; i++) ledger.insert({ landing: i, opId: i, threads: 1 });
    const cursor = ledger.cursor();
    let seen = 0;
    while ((cursor.peek()?.landing ?? Infinity) < 600) {
      cursor.next();
      seen++;
    }
    expect(seen).toBe(600);
    // Crossing chunk boundaries is the case the fold depends on: resuming must
    // not re-read the chunk it stopped inside.
    expect(cursor.next()!.landing).toBe(600);
    let rest = 0;
    while (cursor.next() !== undefined) rest++;
    expect(rest).toBe(599);
  });

});
