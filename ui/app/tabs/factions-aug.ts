import { AUGMENTATIONS, describeMults, multLabel } from "../../../shared/features/augmentations.ts";
import type { AugmentationOffer } from "../../../shared/telemetry/topics/factions.ts";
import { definitions, note, table, tiles, type Status } from "../lib/dom.ts";
import { esc, fmtMoney, fmtNum, fmtTime } from "../lib/format.ts";
import type { ProjectedState } from "../project.ts";

/** The augmentation half of the factions tab: what state each augmentation is
 * in, what it is worth to THIS run, and the detail panel behind a selected row.
 *
 * Split out of `factions.ts` for the same reason `hacking-server.ts` is split
 * out of `hacking.ts`: the row model and the inspector are one subject, and the
 * tab file is a layout. */

/** Where an augmentation stands, as a WORD.
 *
 * A coloured dot used to carry all of this, which meant "installed", "bought
 * but not yet installed" and "reputation already banked for it" rendered
 * identically — three states that call for three different actions. They are
 * distinct here because the panel exists to answer exactly that question. */
export type AugState = "installed" | "queued" | "banked" | "planned" | "buyable" | "short" | "locked";

const STATE_LABELS: Record<AugState, string> = {
  installed: "installed",
  queued: "queued",
  banked: "banked",
  planned: "planned",
  buyable: "buyable",
  short: "rep short",
  locked: "locked",
};

const STATE_TITLES: Record<AugState, string> = {
  installed: "installed and its multipliers are live",
  queued: "bought this cycle — its multipliers arrive at the next install",
  banked: "reputation is banked for it; the end-loaded sweep will buy it",
  planned: "in the committed plan for this install cycle",
  buyable: "reputation met at a joined faction — purchasable now",
  short: "a joined faction sells it, but its reputation gate is not met",
  locked: "no faction we are in sells it",
};

const STATE_STATUS: Record<AugState, Status> = {
  installed: "good",
  queued: "good",
  banked: "ready",
  planned: "ready",
  buyable: "ready",
  short: "wait",
  locked: "off",
};

export interface AugRow {
  name: string;
  state: AugState;
  owned: boolean;
  offer?: AugmentationOffer;
  cost: number;
  rep: number;
  /** Reputation still needed at the cheapest offering faction. */
  repGap?: number;
  factions: readonly string[];
  /** Factions we are in that sell it. */
  fromJoined: string[];
  /** Who we would actually buy from: a joined seller, else the first seller. */
  seller?: string;
  mults?: Readonly<Record<string, number>>;
  gives: string;
  multsUnknown: boolean;
  /** What it is worth under the run's objective weights, in BN-seconds. */
  score?: number;
  prereqs: readonly string[];
  startingMoney?: number;
  programs?: readonly string[];
}

export function augRows(state: ProjectedState): AugRow[] {
  const f = state.topics.factions;
  const owned = new Set(f?.ownedAugs ?? []);
  const joined = new Set(f?.joined ?? []);
  // `ownedAugs` deliberately includes purchases that have not been installed
  // yet, so the queue is what separates "working for us" from "paid for".
  const queued = new Set(state.topics.progression?.plan?.queuedAugmentations ?? []);
  const banked = new Set(f?.plan?.bankedAugmentations ?? []);
  // `objective.augmentations` is the prerequisite-CLOSED list the plan will
  // actually buy; `portfolio.augmentations` is the raw union behind it. Prefer
  // the closed one, or every prerequisite the plan is committed to purchasing
  // reads as `buyable`/`short`/`locked` rather than `planned`.
  const portfolio = f?.plan?.objective?.augmentations ?? f?.plan?.objective?.portfolio?.augmentations ?? [];
  const planned = new Set(portfolio);

  // Cheapest live offer per augmentation: the same aug from four factions is
  // one decision, not four rows.
  const bestOffer = new Map<string, AugmentationOffer>();
  for (const offer of f?.offers ?? []) {
    const existing = bestOffer.get(offer.name);
    if (!existing || offer.price < existing.price) bestOffer.set(offer.name, offer);
  }
  const meta = f?.augMeta ?? {};

  return Object.entries(AUGMENTATIONS).map(([name, info]) => {
    const offer = bestOffer.get(name);
    // The live probe wins on multipliers where it has them: one augmentation
    // has its multipliers randomised per save, so the static table is wrong
    // for it by design.
    const mults = info.multsUnknown ? meta[name]?.mults : (info.mults ?? meta[name]?.mults);
    const fromJoined = info.factions.filter((faction) => joined.has(faction));
    const isOwned = owned.has(name);
    const isQueued = queued.has(name);
    // Who we would actually transact with: the faction behind the cheapest live
    // offer, else one we are already in, else whoever sells it at all.
    const seller = offer?.faction ?? fromJoined[0] ?? info.factions[0];

    const state: AugState = isQueued
      ? "queued"
      : isOwned
        ? "installed"
        : banked.has(name)
          ? "banked"
          : planned.has(name)
            ? "planned"
            : offer?.affordableRep
              ? "buyable"
              : fromJoined.length > 0
                ? "short"
                : "locked";

    return {
      name,
      state,
      owned: isOwned,
      ...(offer ? { offer } : {}),
      cost: offer?.price ?? info.cost,
      rep: offer?.repReq ?? info.rep,
      ...(offer?.repGap !== undefined ? { repGap: offer.repGap } : {}),
      factions: info.factions,
      fromJoined,
      ...(seller !== undefined ? { seller } : {}),
      ...(mults ? { mults } : {}),
      gives:
        describeMults(mults, 3)
          .map((m) => m.text)
          .join(", ") ||
        (info.startingMoney ? `${fmtMoney(info.startingMoney)} on install` : "") ||
        (info.programs?.length ? `${info.programs.length} program(s)` : "") ||
        "—",
      multsUnknown: info.multsUnknown === true && meta[name]?.mults === undefined,
      ...(offer?.score !== undefined ? { score: offer.score } : {}),
      prereqs: info.prereqs ?? [],
      ...(info.startingMoney !== undefined ? { startingMoney: info.startingMoney } : {}),
      ...(info.programs ? { programs: info.programs } : {}),
    };
  });
}

export function stateCell(row: AugRow): string {
  return `<span class="augstate ${row.state}" title="${esc(STATE_TITLES[row.state])}">${
    esc(STATE_LABELS[row.state])
  }</span>`;
}

export function stateStatus(row: AugRow): Status {
  return STATE_STATUS[row.state];
}

export function stateTitle(row: AugRow): string {
  return STATE_TITLES[row.state];
}

/** Multiplier chips rather than one comma-joined muted string.
 *
 * The fields an augmentation touches are the reason to buy it, and reading them
 * out of a wrapped sentence is slower than scanning chips. The two largest
 * effects carry the emphasis: `describeMults` already orders by magnitude, and
 * an augmentation's headline is what it moves MOST. Emphasis is deliberately
 * not "fields the objective weights" — those weights are not published, and
 * inferring them from what happens to be on the wire would put a number in
 * front of the reader that no part of the run actually decided with. */
export function givesCell(row: AugRow): string {
  if (row.multsUnknown) {
    return `<span class="chip unknown" title="upstream randomises this augmentation's multipliers per save">randomised</span>`;
  }
  const entries = Object.entries(row.mults ?? {});
  if (entries.length === 0) {
    if (row.startingMoney) return `<span class="chip idle">${fmtMoney(row.startingMoney)} on install</span>`;
    if (row.programs?.length) return `<span class="chip idle">${row.programs.length} program(s)</span>`;
    return `<span class="muted">—</span>`;
  }
  const shown = describeMults(row.mults, 4);
  const rest = entries.length - shown.length;
  return (
    `<span class="chips">` +
    shown
      .map((m, index) => `<span class="chip ${index < 2 ? "on" : "idle"}">${esc(m.text)}</span>`)
      .join("") +
    (rest > 0 ? `<span class="chip off" title="${esc(allMultText(row))}">+${rest}</span>` : "") +
    `</span>`
  );
}

function allMultText(row: AugRow): string {
  return Object.entries(row.mults ?? {})
    .map(([field, value]) => `${multLabel(field)} ${value >= 1 ? "+" : ""}${((value - 1) * 100).toFixed(0)}%`)
    .join(", ");
}

/** Sellers, compactly. This column used to be the reason `gives` had no room:
 * it wrapped a comma list of up to thirty-one full faction names (NeuroFlux is
 * sold by nearly everyone), inside a card that is not that wide. What the
 * reader needs at a glance is who we would buy from and how many alternatives
 * exist; the list itself belongs in the inspector. */
export function sellerCell(row: AugRow): string {
  if (row.factions.length === 0) return `<span class="muted">not sold</span>`;
  const seller = row.seller ?? row.factions[0]!;
  const inside = row.fromJoined.includes(seller);
  // The seller comes off the wire and need not appear in the bundled table — a
  // BitNode-specific or newly-added faction does not. Counting alternatives
  // against a list that does not contain it reports one too many and lists them
  // without the one actually named beside the count.
  const all = row.factions.includes(seller) ? row.factions : [seller, ...row.factions];
  const rest = all.length - 1;
  return (
    `<span class="${inside ? "good" : "muted"}">${esc(seller)}</span>` +
    (rest > 0
      ? ` <span class="muted" title="${esc(all.join(", "))}">+${rest}</span>`
      : "")
  );
}

/** The detail panel for one selected augmentation, rendered below the table in
 * the same card — the master–detail shape the hacking tab already uses. */
export function augInspector(row: AugRow, state: ProjectedState): string {
  const f = state.topics.factions;
  const joined = new Set(f?.joined ?? []);
  const rep = new Map((f?.standings ?? []).map((s) => [s.name, s.rep]));
  const offers = (f?.offers ?? []).filter((offer) => offer.name === row.name);
  const owned = new Set(f?.ownedAugs ?? []);

  const sellerRows = row.factions.map((faction) => {
    const offer = offers.find((entry) => entry.faction === faction);
    const have = rep.get(faction);
    const need = offer?.repReq ?? row.rep;
    const member = joined.has(faction);
    return [
      `<span class="${member ? "good" : "muted"}">${esc(faction)}</span>`,
      member ? `<span class="good">joined</span>` : `<span class="muted">not joined</span>`,
      have === undefined ? `<span class="muted">–</span>` : fmtNum(have, 0),
      Number.isFinite(need) ? fmtNum(need, 0) : `<span class="muted">–</span>`,
      member && have !== undefined && Number.isFinite(need)
        ? have >= need
          ? `<span class="good">met</span>`
          : `<span class="muted">${fmtNum(need - have, 0)} short</span>`
        : `<span class="muted">–</span>`,
    ];
  });

  const graft = f?.graftable?.find((entry) => entry.name === row.name);

  return (
    `<div class="server-inspector">` +
    `<h3>${esc(row.name)}</h3>` +
    tiles([
      { label: "state", value: stateCell(row) },
      { label: "price", value: Number.isFinite(row.cost) ? fmtMoney(row.cost) : "unbuyable",
        ...(row.offer?.basePrice !== undefined && row.offer.basePrice !== row.cost
          ? { sub: `base ${fmtMoney(row.offer.basePrice)} before the queue escalation` }
          : {}) },
      { label: "reputation", value: Number.isFinite(row.rep) ? fmtNum(row.rep, 0) : "–",
        ...(row.repGap !== undefined ? { sub: `${fmtNum(row.repGap, 0)} short at the cheapest seller` } : {}) },
      { label: "worth to this run", value: row.score !== undefined ? `${fmtNum(row.score, 2)}` : "–",
        sub: row.score !== undefined ? "BN-seconds under the run's weights" : "not scored — no live offer" },
    ]) +
    `<div class="server-detail-grid">` +
    `<div><h4>Effect</h4>` +
    (row.multsUnknown
      ? note("Upstream randomises this augmentation's multipliers per save, so the bundled table is not the truth for this run.")
      : Object.keys(row.mults ?? {}).length > 0
        ? table(
            ["multiplier", "value"],
            Object.entries(row.mults ?? {})
              .sort((a, b) => Math.abs(b[1] - 1) - Math.abs(a[1] - 1))
              .map(([field, value]) => [
                esc(multLabel(field)),
                `<span class="${value >= 1 ? "good" : "bad"}">${value >= 1 ? "+" : ""}${((value - 1) * 100).toFixed(0)}%</span>`,
              ]),
            { left: [0] },
          )
        : note("No multipliers.")) +
    definitions([
      ...(row.startingMoney !== undefined ? [["cash on install", fmtMoney(row.startingMoney)] as [string, string]] : []),
      ...(row.programs?.length ? [["programs", esc(row.programs.join(", "))] as [string, string]] : []),
      [
        "prerequisites",
        row.prereqs.length === 0
          ? `<span class="muted">none</span>`
          : row.prereqs
              .map((name) => `<span class="${owned.has(name) ? "good" : "warn"}">${esc(name)}</span>`)
              .join(", "),
      ],
      [
        "grafting",
        graft
          ? `${fmtMoney(graft.price)} over ${esc(fmtTime(graft.timeMs))} — no reputation needed`
          : `<span class="muted">not graftable here</span>`,
      ],
    ]) +
    `</div>` +
    `<div><h4>Sellers</h4>` +
    table(["faction", "member", "rep", "needs", "gap"], sellerRows, {
      left: [0, 1],
      empty: "not sold by any faction in this BitNode",
    }) +
    `<p class="muted">${esc(stateTitle(row))}</p>` +
    `</div>` +
    `</div>` +
    `</div>`
  );
}
