import { describe, expect, test } from "bun:test";
import type { LogRecord } from "../shared/telemetry/schema.ts";
import { appendRecords, emptyState, DECISION_LOG_LIMIT, EVENT_RING } from "../ui/app/project.ts";
import { arbiterDrawer } from "../ui/app/lib/arbiter.ts";
import { fmtMoney } from "../ui/app/lib/format.ts";

/** The arbiter drawer: the cross-feature decision log folded in project.ts and
 * rendered by ui/app/lib/arbiter.ts. Exercised through appendRecords — the
 * real fold — never by pushing onto state.events, which the log deliberately
 * does not read. */

let seq = 0;
function event(t: number, name: string, data: unknown): LogRecord {
  return { t, seq: ++seq, run: "r", src: "sim", kind: "event", name, data } as LogRecord;
}

const refusal = (t: number) =>
  event(t, "investment.result", { subsystem: "infrastructure", result: { action: "purchase", ok: false, detail: "purchase refused" } });

describe("the decision log coalesces repeated outcomes", () => {
  test("nine identical refusals are one episode with a count and a span", () => {
    const state = appendRecords(
      emptyState(),
      Array.from({ length: 9 }, (_, i) => refusal(1_000 * (i + 1))),
    );
    expect(state.decisionLog).toHaveLength(1);
    const episode = state.decisionLog[0]!;
    expect(episode.count).toBe(9);
    expect(episode.firstT).toBe(1_000);
    expect(episode.lastT).toBe(9_000);

    state.t0 = 0;
    const html = arbiterDrawer(state);
    expect(html).toContain("×9");
    // A range, not a single stamp: 1s–9s.
    expect(html).toContain("1s–9s");
  });

  test("detail strings that differ only in figures coalesce", () => {
    const state = appendRecords(emptyState(), [
      event(1_000, "investment.result", { subsystem: "infrastructure", result: { action: "purchase", ok: true, detail: "bought 1 upgradeServer rung(s) for $1.2m" } }),
      event(2_000, "investment.result", { subsystem: "infrastructure", result: { action: "purchase", ok: true, detail: "bought 2 upgradeServer rung(s) for $2.9m" } }),
    ]);
    expect(state.decisionLog).toHaveLength(1);
    // The newest occurrence's figures win.
    expect(state.decisionLog[0]!.detail).toContain("$2.9m");
    expect(state.decisionLog[0]!.count).toBe(2);
  });

  test("an interleaved episode from another subsystem breaks the run", () => {
    // Interleaving is real ordering information: the log compares against its
    // tail only, so the same refusal after a stock trade is a NEW episode.
    const state = appendRecords(emptyState(), [
      refusal(1_000),
      refusal(2_000),
      event(3_000, "investment.result", { subsystem: "stock", result: { action: "buy", ok: true, detail: "bought 1000 ECP" } }),
      refusal(4_000),
    ]);
    expect(state.decisionLog.map((episode) => episode.subsystem)).toEqual(["infrastructure", "stock", "infrastructure"]);
    expect(state.decisionLog[0]!.count).toBe(2);
    expect(state.decisionLog[2]!.count).toBe(1);
  });

  test("the log outlives the event ring and respects its own bound", () => {
    // Alternate two signatures so nothing coalesces, at more episodes than the
    // ring holds records of anything.
    const records: LogRecord[] = [];
    for (let i = 0; i < EVENT_RING + 200; i++) {
      records.push(
        i % 2 === 0
          ? refusal(1_000 * i)
          : event(1_000 * i, "investment.result", { subsystem: "stock", result: { action: "buy", ok: true, detail: "bought" } }),
      );
    }
    const state = appendRecords(emptyState(), records);
    expect(state.decisionLog).toHaveLength(DECISION_LOG_LIMIT);
    expect(state.events.length).toBe(EVENT_RING);
  });
});

describe("the decision log answers how much and who won", () => {
  test("a denial names the reason, the pool it lost against and the winners", () => {
    const state = appendRecords(emptyState(), [
      event(5_000, "investment.decision", {
        subsystem: "infrastructure",
        plan: { moneyAvailable: 9.96e7, moneyGranted: 0, buy: { kind: "upgradeServer", cost: 9.96e7 } },
        arbitration: {
          grants: [{ by: "hacknet", id: "hacknet:node", resource: "money", amount: 5e7, mode: "spend", partial: false }],
          denied: [{ by: "hacking", id: "infrastructure:ram", resource: "money", wanted: 9.96e7, available: 5e7, reason: "outbid" }],
        },
      }),
    ]);
    const episode = state.decisionLog[0]!;
    expect(episode.funded).toBe(false);
    expect(episode.wanted).toBe(9.96e7);
    expect(episode.available).toBe(5e7);
    expect(episode.winners).toEqual([{ by: "hacknet", id: "hacknet:node", amount: 5e7 }]);

    state.t0 = 0;
    const html = arbiterDrawer(state);
    expect(html).toContain("denied: outbid");
    expect(html).toContain(`funded hacknet:hacknet:node ${fmtMoney(5e7)}`);
    // wanted → got, with a denial's got pinned to $0.
    expect(html).toContain(`${fmtMoney(9.96e7)} → $0`);
  });

  test("a funded decision shows wanted → granted", () => {
    const state = appendRecords(emptyState(), [
      event(5_000, "investment.decision", {
        subsystem: "infrastructure",
        plan: { moneyAvailable: 2e8, moneyGranted: 9.96e7, buy: { kind: "upgradeServer", cost: 9.96e7 } },
        arbitration: {
          grants: [{ by: "hacking", id: "infrastructure:ram", resource: "money", amount: 9.96e7, mode: "spend", partial: false, wanted: 9.96e7 }],
          denied: [],
        },
      }),
    ]);
    const episode = state.decisionLog[0]!;
    expect(episode.funded).toBe(true);
    expect(episode.granted).toBe(9.96e7);

    state.t0 = 0;
    const html = arbiterDrawer(state);
    expect(html).toContain(">funded<");
    expect(html).toContain(`${fmtMoney(9.96e7)} → ${fmtMoney(9.96e7)}`);
  });

  test("the newest decision's ranked alternatives render with the chosen row marked", () => {
    const state = appendRecords(emptyState(), [
      event(5_000, "investment.decision", {
        subsystem: "infrastructure",
        plan: {
          moneyAvailable: 2e8,
          moneyGranted: 9.96e7,
          buy: { kind: "upgradeServer", cost: 9.96e7, host: "pserv-5", targetRam: 512 },
          rankedTotal: 3,
          ranked: [
            { kind: "upgradeServer", host: "pserv-5", targetRam: 512, addedRam: 256, cost: 9.96e7, incomePerSec: 1.011e6, returnPerDollarSec: 1e-8, paybackSec: 98, netOverHorizon: 1.6e10, worthBuying: true, selected: true },
            { kind: "buyServer", targetRam: 256, addedRam: 256, cost: 1.4e8, incomePerSec: 9e5, returnPerDollarSec: 6e-9, paybackSec: 150, netOverHorizon: 1.1e10, worthBuying: true, selected: false },
          ],
        },
      }),
    ]);
    state.t0 = 0;
    const html = arbiterDrawer(state);
    expect(html).toContain("options considered — infrastructure");
    expect(html).toContain("pserv-5 → 512GB");
    // The ▶ marker and the .picked row class both mark the selected option.
    expect(html).toContain("picked");
    // 2 of 3 candidates shown → the truncation note.
    expect(html).toContain("2 of 3");
  });

  test("hash spending folds as its own subsystem, without arbiter columns", () => {
    const state = appendRecords(emptyState(), [
      event(1_000, "hash.decision", { plan: { spend: { name: "Sell for Money" } } }),
      event(2_000, "hash.result", { action: "sell", ok: true, detail: "sold 4 hashes" }),
    ]);
    expect(state.decisionLog.map((episode) => [episode.subsystem, episode.choice])).toEqual([
      ["hashes", "Sell for Money"],
      ["hashes", "sell"],
    ]);
    expect(state.decisionLog[0]!.funded).toBeUndefined();
  });
});
