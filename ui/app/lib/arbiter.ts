import { NONE, card, collapsible, dot, hint, meter, note, rankedTable, shownOf, table } from "./dom.ts";
import { esc, fmtMoney, fmtNum, fmtPct, fmtRam, fmtTime } from "./format.ts";
import { html } from "./html.ts";
import type { DecisionEpisode, ProjectedState } from "../project.ts";

/** The arbiter drawer: the cross-feature resource view, reachable from every
 * tab.
 *
 * The arbiter allocates money and the work slot ACROSS features
 * (shared/strategy/arbiter.ts), so its output is not any one tab's — the
 * "Needs & investment arbiter" card used to sit on the progression tab and the
 * decision history was scattered per feature, which put the arbitration
 * evidence everywhere except beside the arbitration. Both now live here. */

type Arbitration = NonNullable<ProjectedState["topics"]["arbitration"]>;

export function arbiterDrawer(state: ProjectedState): string {
  return (
    card("Needs & investment arbiter", coordinationPanel(state)) +
    card("Decision log", decisionLogPanel(state))
  );
}

/** Needs, grants/denials and the work-slot bids — moved verbatim from the
 * progression tab, which the drawer replaces as the arbiter's home. */
function coordinationPanel(state: ProjectedState): string {
  const needs = (state.topics.progression?.needs ?? []).filter((need) => !need.satisfied);
  const arbitration: Arbitration | undefined = state.topics.arbitration;
  const slot = arbitration?.slot;
  const bids = arbitration?.slotValues ?? [];
  const waterline = (resource: string, priority: number | undefined): number | undefined =>
    arbitration?.waterlines?.find((entry) => entry.resource === resource && entry.priority === priority)?.lambda;
  const quantity = (resource: string, amount: number): string =>
    resource === "money" ? fmtMoney(amount) : fmtNum(amount, 2);
  const arbitrationRows = [
    ...(arbitration?.grants ?? []).map((grant) => [
      // A `reserve` grant is cash WITHHELD, not spent, and `partial` means two
      // different things on the two modes: still saving on a reserve, filled
      // short on a spend (shared/strategy/arbiter.ts). Calling all three
      // "granted" claimed a purchase that never happened.
      grant.mode === "reserve"
        ? `${dot("wait", "money sequestered, not spent")} reserved${grant.partial ? " (saving)" : ""}`
        : grant.partial
          ? `${dot("wait", "filled short of the bid")} partial`
          : "granted",
      esc(grant.by),
      esc(grant.id),
      esc(grant.resource),
      // `wanted` is absent for a grant the arbiter synthesised from a next
      // step (it was never in the claim list), so the bare amount is the
      // fallback — not a zero bid.
      grant.wanted !== undefined
        ? `${quantity(grant.resource, grant.amount)} of ${quantity(grant.resource, grant.wanted)}`
        : quantity(grant.resource, grant.amount),
      fmtNum(grant.priority),
      grant.returnPerDollarSec !== undefined ? fmtNum(grant.returnPerDollarSec, 8) : "–",
      waterline(grant.resource, grant.priority) !== undefined ? fmtNum(waterline(grant.resource, grant.priority), 5) : "–",
      grant.marginalValue !== undefined ? fmtNum(grant.marginalValue, 5) : "–",
    ]),
    ...(arbitration?.denied ?? []).map((denial) => [
      `denied: ${esc(denial.reason)}`,
      esc(denial.by),
      esc(denial.id),
      esc(denial.resource),
      quantity(denial.resource, denial.wanted),
      fmtNum(denial.priority),
      denial.returnPerDollarSec !== undefined ? fmtNum(denial.returnPerDollarSec, 8) : "–",
      waterline(denial.resource, denial.priority) !== undefined ? fmtNum(waterline(denial.resource, denial.priority), 5) : "–",
      "–",
    ]),
  ];
  return (
    (needs.length
      ? table(
          ["urgency", "requested by", "need", "progress", "weight", "value (s)"],
          needs.map((need) => [
            esc(need.urgency),
            esc(need.by),
            esc(`${need.kind}${need.subject ? `: ${need.subject}` : ""}`),
            // `progress` is precomputed because the DIRECTION rule lives in
            // shared/strategy/needs.ts, not in a renderer: karma counts DOWN,
            // so the raw pair "-12.0 / -54.0" carries no readable fraction.
            // The tooltip states the percentage because the producer reports 0
            // both for "just started" and for the zero-crossing case, and an
            // empty bar alone cannot say which.
            meter(
              need.progress,
              `${fmtNum(need.have, 1)} / ${fmtNum(need.target, 1)}`,
              need.satisfied,
              `${fmtPct(need.progress)} of the way there`,
            ),
            fmtNum(need.weight, 2),
            need.valueSec !== undefined ? fmtNum(need.valueSec, 0) : "–",
          ]),
          { left: [0, 1, 2] },
        )
      : note("no open cross-feature needs")) +
    (arbitrationRows.length
      ? table(["outcome", "feature", "claim", "resource", "amount", "priority", "return/$", "λ", "marginal"], arbitrationRows, { left: [0, 1, 2, 3] })
      : note("no contended resource claims")) +
    // Every bid for Player.currentWork and what it was worth. The slot is the
    // one resource where the losers matter as much as the winner: the loser
    // is not delayed, it is cancelled.
    //
    // Ranked rather than plain, because the winner is NOT bids[0]: hysteresis
    // and holdUntil let a lower-valued incumbent keep the slot
    // (shared/strategy/arbiter.ts), so a best-first table with no ▶ reads as a
    // result it is not. With no reported holder the marker is simply absent,
    // which is the honest rendering — never row 0 by default.
    (bids.length
      ? rankedTable(
          ["claim", "feature", "worth (s)", "priced on"],
          bids.map((bid) => [
            esc(bid.id),
            esc(bid.by),
            bid.pricing === "hard"
              ? `<span class="muted">lock @ ${fmtNum(bid.priority)}</span>`
              : bid.valueSec !== undefined
                ? fmtNum(bid.valueSec, 2)
                : `<span class="muted">${fmtMoney(bid.moneyPerSec ?? 0)}/s unpriced</span>`,
            (bid.channels ?? []).length
              ? (bid.channels ?? []).map((channel) =>
                  `${esc(channel.channel)} ${fmtNum(channel.ourRate, 3)}` +
                  `${channel.bestRate !== undefined ? `/${fmtNum(channel.bestRate, 3)}` : ""}` +
                  ` × ${fmtNum(channel.worthSec, 0)}s`,
                ).join("<br>")
              : `<span class="muted">not a rate</span>`,
          ]),
          {
            selected: (i) => bids[i]!.by === slot?.by && bids[i]!.id === slot?.id,
            left: [0, 1, 3],
          },
        )
      : "") +
    // `heldMs` is bucketed to 10 s by the digest, hence the tilde.
    (slot
      ? note(html`slot held by ${slot.by} · ${slot.id} · priority ${fmtNum(slot.priority)} · held ~${fmtTime(slot.heldMs)}`)
      : "") +
    (arbitration?.preempted
      ? note(
          html`preempted: ${arbitration.preempted.by} · ${arbitration.preempted.id}, after ~${fmtTime(arbitration.preempted.heldMs)}`,
        )
      : "")
  );
}

/** Rows shown before the log truncates. The retained log is longer
 * (project.ts DECISION_LOG_LIMIT); this is a display bound. */
const LOG_SHOWN = 30;

/** The coalesced cross-feature decision log.
 *
 * Episodes, not events: a refusal repeated every pass is ONE row with a
 * climbing ×N and a time range, so the table holds still instead of scrolling
 * (the coalescing lives in project.ts, where it also escapes the event ring's
 * eviction). Every money-arbitrated subsystem lands in the same table because
 * the funding decisions were never per-feature — "what was funded instead" is
 * only answerable across all of them. */
function decisionLogPanel(state: ProjectedState): string {
  const episodes = state.decisionLog.slice(-LOG_SHOWN).reverse();
  if (episodes.length === 0) return note("no arbitrated decisions yet");
  const t0 = state.t0 ?? episodes[episodes.length - 1]!.firstT;
  const at = (episode: DecisionEpisode): string =>
    episode.count > 1
      ? `${fmtTime(episode.firstT - t0)}–${fmtTime(episode.lastT - t0)}`
      : fmtTime(episode.firstT - t0);
  const rows = episodes.map((episode) => [
    at(episode),
    esc(episode.subsystem),
    decisionCell(episode),
    moneyCell(episode),
    arbiterCell(episode),
  ]);
  const body = table(["at", "feature", "decision / outcome", "wanted → got", "arbiter"], rows, {
    left: [1, 2, 3, 4],
    wrap: [4],
  });
  const total = state.decisionLog.length;
  return body + (total > episodes.length ? shownOf(episodes.length, total, "older episodes") : "") + rankedDetail(state);
}

function decisionCell(episode: DecisionEpisode): string {
  const times = episode.count > 1 ? ` <span class="muted">×${episode.count}</span>` : "";
  if (episode.kind === "result") {
    const label = episode.detail || episode.choice || NONE;
    return (
      (episode.ok === undefined ? "" : `${dot(episode.ok ? "good" : "bad", episode.ok ? "succeeded" : "failed")} `) +
      esc(label) +
      times
    );
  }
  return esc(episode.choice || NONE) + times;
}

function moneyCell(episode: DecisionEpisode): string {
  if (episode.wanted === undefined && episode.granted === undefined) return NONE;
  const wanted = episode.wanted !== undefined ? fmtMoney(episode.wanted) : NONE;
  // A denial's "got" is $0 by definition; showing the pool it lost against is
  // the useful number, so that goes to the arbiter column instead.
  const got = episode.funded === false ? "$0" : episode.granted !== undefined ? fmtMoney(episode.granted) : NONE;
  return `${wanted} → ${got}`;
}

function arbiterCell(episode: DecisionEpisode): string {
  if (episode.funded === undefined) return NONE;
  const winners = (episode.winners ?? [])
    .map((winner) => `${winner.by}:${winner.id} ${fmtMoney(winner.amount)}`)
    .join(", ");
  if (episode.funded) return "funded";
  return esc(
    `denied: ${episode.denialReason ?? "unfunded"}` +
      (episode.available !== undefined ? ` · ${fmtMoney(episode.available)} avail` : "") +
      (winners ? ` · funded ${winners}` : ""),
  );
}

/** The newest decision's ranked alternatives — the comparison behind the top
 * row's choice. One expander under the table rather than one per row: a
 * `<details>` cannot legally sit inside a table cell, and the newest decision
 * is the one still being argued with. */
function rankedDetail(state: ProjectedState): string {
  let newest: DecisionEpisode | undefined;
  for (let i = state.decisionLog.length - 1; i >= 0; i--) {
    if (state.decisionLog[i]!.ranked?.length) {
      newest = state.decisionLog[i];
      break;
    }
  }
  if (!newest?.ranked) return "";
  const ranked = newest.ranked;
  return collapsible(
    "arbiter.ranked",
    // Plain string: collapsible() escapes its summary.
    `options considered — ${newest.subsystem}, newest decision`,
    rankedTable(
      ["option", "adds", "cost", "adds $/sec", "payback", "horizon net", "status"],
      ranked.map((entry) => [
        esc(
          entry.kind === "upgradeServer"
            ? `${entry.host ?? "server"} → ${fmtRam(entry.targetRam)}`
            : entry.kind === "buyServer"
              ? `new server ${fmtRam(entry.targetRam)}`
              : entry.kind === "homeRam"
                ? `home → ${fmtRam(entry.targetRam)}`
                : entry.kind,
        ),
        entry.addedRam > 0 ? fmtRam(entry.addedRam) : "+1 core",
        fmtMoney(entry.cost),
        fmtMoney(entry.incomePerSec),
        hint(fmtTime(entry.paybackSec * 1000), `return/$ ${fmtNum(entry.returnPerDollarSec, 8)}`),
        fmtMoney(entry.netOverHorizon),
        entry.worthBuying === true ? "repays" : entry.worthBuying === false ? "past horizon" : NONE,
      ]),
      {
        selected: (i) => ranked[i]!.selected,
        left: [0, 6],
        shown: ranked.length,
        total: newest.rankedTotal ?? ranked.length,
      },
    ),
  );
}
