import { AUGMENTATIONS, describeMults, multLabel } from "../../../shared/features/augmentations.ts";
import { effectiveBitNodeMultipliers } from "../../../shared/features/bitnode.ts";
import { sfLevel } from "../../../shared/features/unlock.ts";
import { NEUROFLUX } from "../../../shared/strategy/factions/augs.ts";
import type { AugmentationOffer } from "../../../shared/telemetry/topics/factions.ts";
import { definitions, note, table, tiles, type Status } from "../lib/dom.ts";
import { esc, fmtMoney, fmtNum, fmtTime } from "../lib/format.ts";
import { raw } from "../lib/html.ts";
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
 * distinct here because the panel exists to answer exactly that question.
 *
 * Two of the nine are deliberately NOT conclusions. `owned` is a purchase whose
 * install state nothing on the wire can settle, and `unknown` is an
 * augmentation with no live offer — no price, no reputation gate, no seller
 * list from this node. Both used to be answered with a confident word taken
 * from an absence (`installed`, and `short`/`locked` respectively), which is
 * the one thing this panel must not do. */
export type AugState =
  | "installed"
  | "queued"
  | "owned"
  | "banked"
  | "planned"
  | "buyable"
  | "short"
  | "locked"
  | "unknown";

const STATE_LABELS: Record<AugState, string> = {
  installed: "installed",
  queued: "queued",
  owned: "owned",
  banked: "banked",
  planned: "planned",
  buyable: "buyable",
  short: "rep short",
  locked: "locked",
  unknown: "unknown",
};

const STATE_TITLES: Record<AugState, string> = {
  installed: "installed and its multipliers are live",
  queued: "bought this cycle — its multipliers arrive at the next install",
  owned: "bought — whether it is installed yet is not on the wire",
  banked: "reputation is banked for it; the end-loaded sweep will buy it",
  planned: "in the committed plan for this install cycle",
  buyable: "reputation met at a joined faction — purchasable now",
  short: "a joined faction sells it, but its reputation gate is not met",
  locked: "no faction we are in sells it",
  unknown: "no live offer: neither the price, the reputation gate nor this node's seller list is measured for it",
};

const STATE_STATUS: Record<AugState, Status> = {
  installed: "good",
  queued: "good",
  owned: "wait",
  banked: "ready",
  planned: "ready",
  buyable: "ready",
  short: "wait",
  locked: "off",
  unknown: "off",
};

/** The two "we do not know" states have no colour rule of their own in
 * `app.css`, and a `.augstate` with no colour inherits the cell's — which would
 * make the least certain word in the row the loudest. `muted` is the existing
 * token class for exactly that, so no new palette is needed. */
const STATE_TONE: Partial<Record<AugState, string>> = { owned: "muted", unknown: "muted" };

/** Said once, in every place a BUNDLED figure can reach the reader. The static
 * table is base cost and base reputation: no BitNode `AugmentationMoneyCost`
 * (3x in BN3, 5x in BN10), no `AugmentationRepCost`, and no `1.9^queued`
 * escalation. Presenting it unmarked under a heading that means "measured" was
 * wrong by up to a factor of five. */
const BUNDLED_COST_TITLE =
  "the bundled v3.0.1 table, not a measurement: base cost, before this BitNode's AugmentationMoneyCost and before the purchase-queue escalation";
const BUNDLED_REP_TITLE =
  "the bundled v3.0.1 table, not a measurement: base reputation, before this BitNode's AugmentationRepCost";
const BUNDLED_SELLERS_TITLE =
  "the bundled v3.0.1 seller list: this node's live catalogue is absent or capped, so a faction the node has retired is still listed here";

export interface AugRow {
  name: string;
  state: AugState;
  owned: boolean;
  offer?: AugmentationOffer;
  cost: number;
  rep: number;
  /** Where `cost` and `rep` came from. Only a live offer is a PRICE: the bundled
   *  table carries base figures with no BitNode multiplier and no queue
   *  escalation, so a cell showing one has to say so. */
  priced: "live" | "bundled";
  /** Reputation still needed at the cheapest offering faction. */
  repGap?: number;
  /** Who sells it — the node's live catalogue when the probe proved it
   *  complete, else the bundled transcription. */
  factions: readonly string[];
  sellerSource: "live" | "bundled";
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
  const joined = new Set(f?.joined ?? []);
  const ownedList = f?.ownedAugs ?? [];

  // The queue is the multiset DIFFERENCE of the two ownership lists on the
  // wire, and both producers derive it exactly this way (`buildFactionsView`
  // in game/lib/features/factions.ts, and progression's plan in
  // game/lib/features/remaining.ts). `factions.ownedAugs` is
  // `getOwnedAugmentations(true)` — installed PLUS queued, with one extra list
  // entry per queued NeuroFlux level — while `progression.ownedAugs` is
  // `ResetInfo.ownedAugs`, installed only.
  //
  // The panel used to take the queue from `progression.plan.queuedAugmentations`
  // alone. That is a 60 s driver's digest, while `factions` merges a purchase
  // into `ownedAugs` the instant `purchaseAugmentation` returns — so every
  // augmentation bought during the end-loaded sweep, the one minute of the cycle
  // an operator is actually watching, read `installed` with a green dot and
  // "its multipliers are live" for up to a minute. The plan-absent window (a run
  // resumed with a queue already standing, a replay scrubbed before
  // progression's first record) was the same claim for longer.
  const installedLevels = state.topics.progression?.ownedAugs;
  const planQueue = state.topics.progression?.plan?.queuedAugmentations;
  const installed = new Set(
    Object.entries(installedLevels ?? {})
      .filter(([, level]) => level > 0)
      .map(([name]) => name),
  );
  // NOT deduped first: the duplicate entries ARE the queued NeuroFlux levels.
  const occurrences = new Map<string, number>();
  for (const name of ownedList) occurrences.set(name, (occurrences.get(name) ?? 0) + 1);
  const queued = new Set<string>();
  if (installedLevels !== undefined) {
    // One occurrence is spoken for by an installed copy and the rest are
    // queued, so NeuroFlux installed at level 3 with one more bought still
    // reads `queued`. `progression.ownedAugs` is a 60 s probe reading, so for a
    // moment after an install a freshly installed augmentation can read
    // `queued` here — the exposure both producers already accept, and the
    // honest way round. Guarding against it is what reintroduces the confident
    // `installed` this replaced.
    for (const [name, count] of occurrences) {
      if (count > (installed.has(name) ? 1 : 0)) queued.add(name);
    }
  } else {
    for (const name of planQueue ?? []) queued.add(name);
  }
  // With neither source on the wire the queue is genuinely unknown: what we own
  // cannot be split into installed and queued at all, and `owned` is the word
  // for that. Nothing may fall through to `installed` on an absence.
  const queueKnown = installedLevels !== undefined || planQueue !== undefined;

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

  // Live seller sets, but only once the stepped probe proves its capped result
  // COMPLETE — the same test and the same reason as `buildFactionsView`: The Red
  // Pill is removed from Daedalus in BN15 and gang factions get a filtered
  // catalogue, so the bundled transcription is wrong in exactly the nodes where
  // the seller matters. The `augTotal > 0` half is not redundant: each
  // `getAugmentationsFromFaction` call may throw on its own, and an empty
  // catalogue would otherwise pass `offers.length === augTotal` and blank every
  // seller list in the panel.
  const sellersLive = f?.augTotal !== undefined && f.augTotal > 0 && (f.offers?.length ?? 0) === f.augTotal;
  const liveSellers = new Map<string, string[]>();
  if (sellersLive) {
    for (const offer of f?.offers ?? []) {
      const sellers = liveSellers.get(offer.name) ?? [];
      if (!sellers.includes(offer.faction)) sellers.push(offer.faction);
      liveSellers.set(offer.name, sellers);
    }
  }

  return Object.entries(AUGMENTATIONS).map(([name, info]) => {
    const offer = bestOffer.get(name);
    // The live probe wins on multipliers where it has them: one augmentation
    // has its multipliers randomised per save, so the static table is wrong
    // for it by design.
    const mults = info.multsUnknown ? meta[name]?.mults : (info.mults ?? meta[name]?.mults);
    const isInstalled = installed.has(name);
    const isQueued = queued.has(name);
    const isOwned = isInstalled || occurrences.has(name);
    // `offers` omits owned non-repeatables, so the live catalogue is silent
    // about anything we already hold: applying it there would print "not sold"
    // for an augmentation sitting in our own list. Same carve-out as the
    // strategy's, NeuroFlux included because it is repeatable.
    const liveFactions =
      sellersLive && (!isOwned || name === NEUROFLUX) ? (liveSellers.get(name) ?? []) : undefined;
    const factions = liveFactions ?? info.factions;
    const fromJoined = factions.filter((faction) => joined.has(faction));
    // Who we would actually transact with: the faction behind the cheapest live
    // offer, else one we are already in, else whoever sells it at all.
    const seller = offer?.faction ?? fromJoined[0] ?? factions[0];
    const priced: "live" | "bundled" = offer ? "live" : "bundled";
    const sellerSource: "live" | "bundled" = liveFactions ? "live" : "bundled";

    const state: AugState = isQueued
      ? "queued"
      : isInstalled
        ? "installed"
        : isOwned
          ? queueKnown
            ? "installed"
            : "owned"
          : banked.has(name)
            ? "banked"
            : planned.has(name)
              ? "planned"
              : offer?.affordableRep
                ? "buyable"
                : offer !== undefined
                  ? fromJoined.length > 0
                    ? "short"
                    : "locked"
                  // No offer: `short` and `locked` are claims about a reputation
                  // gate and a seller list that nothing measured, and without SF4
                  // that was EVERY unowned augmentation — a filter badge reading
                  // "rep short 137" for an unmeasured world. `locked` survives
                  // only where the live catalogue is complete, because then an
                  // augmentation missing from it genuinely is not sold in this
                  // node.
                  : sellersLive
                    ? "locked"
                    : "unknown";

    return {
      name,
      state,
      owned: isOwned,
      ...(offer ? { offer } : {}),
      cost: offer?.price ?? info.cost,
      rep: offer?.repReq ?? info.rep,
      priced,
      ...(offer?.repGap !== undefined ? { repGap: offer.repGap } : {}),
      factions,
      sellerSource,
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
  const tone = STATE_TONE[row.state];
  return `<span class="augstate ${row.state}${tone ? ` ${tone}` : ""}" title="${esc(STATE_TITLES[row.state])}">${
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
  if (row.factions.length === 0) {
    return row.sellerSource === "live"
      ? `<span class="muted" title="this node's live catalogue names no faction selling it">not sold</span>`
      : `<span class="muted">not sold</span>`;
  }
  const seller = row.seller ?? row.factions[0]!;
  const inside = row.fromJoined.includes(seller);
  // The seller comes off the wire and need not appear in the bundled table — a
  // BitNode-specific or newly-added faction does not. Counting alternatives
  // against a list that does not contain it reports one too many and lists them
  // without the one actually named beside the count.
  const all = row.factions.includes(seller) ? row.factions : [seller, ...row.factions];
  const rest = all.length - 1;
  // Where the list came from, said on the cell that shows it: the bundled
  // transcription keeps a seller the node has retired (The Red Pill leaves
  // Daedalus in BN15), so this column must not be read as this node's catalogue
  // unless it is one.
  const source = row.sellerSource === "live" ? "" : ` title="${esc(BUNDLED_SELLERS_TITLE)}"`;
  return (
    `<span class="${inside ? "good" : "muted"}"${source}>${esc(seller)}</span>` +
    (rest > 0
      ? ` <span class="muted" title="${esc(all.join(", "))}">+${rest}</span>`
      : "")
  );
}

/** The line under the price tile: the queue escalation when the price is live,
 * and what the static table would become in this BitNode when it is not.
 *
 * Two prices for a live offer because the `1.9^queued` escalation should read as
 * an escalation rather than as a price change. One scaled figure for a bundled
 * one because the bundled number alone is wrong by 3x in BN3 and 5x in BN10 —
 * and it stays in the sub, muted and labelled, because it is arithmetic on a
 * static table rather than something the run observed. */
function priceSub(row: AugRow, costMult: number | undefined): { sub?: string } {
  if (row.priced === "live") {
    return row.offer?.basePrice !== undefined && row.offer.basePrice !== row.cost
      ? { sub: `base ${fmtMoney(row.offer.basePrice)} before the queue escalation` }
      : {};
  }
  if (!Number.isFinite(row.cost)) return {};
  // A zero-cost entry (The Red Pill) scales to zero, so the scaled line would
  // repeat the value and say nothing.
  return costMult !== undefined && costMult !== 1 && row.cost > 0
    ? { sub: `${fmtMoney(row.cost * costMult)} at this BitNode's AugmentationMoneyCost — still the static table` }
    : { sub: "static table — no live offer to price it" };
}

/** The detail panel for one selected augmentation, rendered below the table in
 * the same card — the master–detail shape the hacking tab already uses. */
export function augInspector(row: AugRow, state: ProjectedState): string {
  const f = state.topics.factions;
  const p = state.topics.progression;
  const joined = new Set(f?.joined ?? []);
  const rep = new Map((f?.standings ?? []).map((s) => [s.name, s.rep]));
  const offers = (f?.offers ?? []).filter((offer) => offer.name === row.name);
  // Prerequisites are ticked off against both readings: `progression.ownedAugs`
  // is free (`getResetInfo`) and is the only one of the two that exists without
  // SF4, while `factions.ownedAugs` additionally carries queued purchases. Their
  // union is what "we already have this one" means.
  const owned = new Set([...(f?.ownedAugs ?? []), ...Object.keys(p?.ownedAugs ?? {})]);
  // What this BitNode does to a bundled base figure. It goes in the SUB of a
  // tile, never in its value: scaling the static table is still a derivation,
  // and the value slot in this panel means measured.
  const nodeMults = effectiveBitNodeMultipliers(p?.bitNode, sfLevel(p?.sourceFiles, 12), p?.multipliers);
  const costMult = nodeMults?.["AugmentationMoneyCost"];
  const repMult = nodeMults?.["AugmentationRepCost"];

  const sellerRows = row.factions.map((faction) => {
    const offer = offers.find((entry) => entry.faction === faction);
    const have = rep.get(faction);
    const need = offer?.repReq ?? row.rep;
    const member = joined.has(faction);
    // A requirement with no offer behind it is the bundled base figure, so
    // neither it nor the gap taken from it may read as measured — least of all a
    // green "met", which in BN3 (`AugmentationRepCost` 3) is wrong by a factor
    // of three.
    const measured = offer !== undefined;
    return [
      `<span class="${member ? "good" : "muted"}">${esc(faction)}</span>`,
      member ? `<span class="good">joined</span>` : `<span class="muted">not joined</span>`,
      have === undefined ? `<span class="muted">–</span>` : fmtNum(have, 0),
      !Number.isFinite(need)
        ? `<span class="muted">–</span>`
        : measured
          ? fmtNum(need, 0)
          : `<span class="muted" title="${esc(BUNDLED_REP_TITLE)}">${fmtNum(need, 0)}</span>`,
      member && have !== undefined && Number.isFinite(need)
        ? have >= need
          ? measured
            ? `<span class="good">met</span>`
            : `<span class="muted" title="${esc(BUNDLED_REP_TITLE)}">met vs the bundled figure</span>`
          : `<span class="muted"${measured ? "" : ` title="${esc(BUNDLED_REP_TITLE)}"`}>${fmtNum(need - have, 0)} short</span>`
        : `<span class="muted">–</span>`,
    ];
  });

  const graft = f?.graftable?.find((entry) => entry.name === row.name);

  return (
    `<div class="server-inspector">` +
    `<h3>${esc(row.name)}</h3>` +
    tiles([
      // `raw`, because a tile value is a TEXT slot: the state chip's markup was
      // being escaped and the operator was reading `&lt;span class=…` where the
      // word should have been.
      { label: "state", value: raw(stateCell(row)) },
      { label: "price",
        value: !Number.isFinite(row.cost)
          ? "unbuyable"
          : row.priced === "live"
            ? fmtMoney(row.cost)
            : raw(`<span class="muted" title="${esc(BUNDLED_COST_TITLE)}">${fmtMoney(row.cost)}</span>`),
        ...priceSub(row, costMult) },
      { label: "reputation",
        value: !Number.isFinite(row.rep)
          ? "–"
          : row.priced === "live"
            ? fmtNum(row.rep, 0)
            : raw(`<span class="muted" title="${esc(BUNDLED_REP_TITLE)}">${fmtNum(row.rep, 0)}</span>`),
        ...(row.repGap !== undefined
          ? { sub: `${fmtNum(row.repGap, 0)} short at the cheapest seller` }
          : row.priced === "bundled" && Number.isFinite(row.rep) && repMult !== undefined && repMult !== 1
            ? { sub: `${fmtNum(row.rep * repMult, 0)} at this BitNode's AugmentationRepCost` }
            : {}) },
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
      empty: row.sellerSource === "live"
        ? "not sold by any faction in this BitNode"
        : "the bundled table lists no seller for it",
    }) +
    // The panel's empty state claims BitNode awareness ("not sold by any faction
    // in this BitNode"), so where the list is NOT the node's own catalogue it has
    // to say so once.
    (row.sellerSource === "live"
      ? ""
      : note(
          "Sellers are the bundled transcription, not this node's catalogue: it is absent or capped, so a faction the node has retired — The Red Pill leaves Daedalus in BN15 — is still listed above.",
        )) +
    `<p class="muted">${esc(stateTitle(row))}</p>` +
    `</div>` +
    `</div>` +
    `</div>`
  );
}
