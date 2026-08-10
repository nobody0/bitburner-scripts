import { AUGMENTATIONS, describeMults, offeredBy } from "../../../shared/features/augmentations.ts";
import type {
  AugmentationOffer,
  FactionGate,
  FactionPlan,
  FactionStanding,
  GateBlocker,
} from "../../../shared/telemetry/topics/factions.ts";
import { formatScientific } from "../../../shared/format.ts";
import {
  card,
  collapsible,
  dataTable,
  dot,
  filters,
  meter,
  note,
  search,
  table,
  tiles,
  type Column,
  type Status,
} from "../lib/dom.ts";
import { esc, fmtMoney, fmtNum, fmtTime } from "../lib/format.ts";
import { view } from "../lib/viewstate.ts";
import type { ProjectedState } from "../project.ts";
import type { Tab } from "./index.ts";

/** Factions tab: three questions, three cards.
 *
 *  1. **Plan** — what the driver selected and the inputs it selected from. A
 *     faction run spends most of its time doing one long thing, so the action
 *     belongs beside its target, ETA, package economics, and alternatives,
 *     and a blocked feature must name the feature it is waiting on.
 *  2. **Factions** — every faction the game has, whether we are in, how close
 *     an invitation is, and exactly what is still missing. This replaces what
 *     used to be three separate cards (standings, invitations, blockers) that
 *     each showed a different subset of the same 34 rows.
 *  3. **Augmentations** — the whole catalogue, what each one gives and who
 *     sells it. Not just the ones our current factions offer: which faction to
 *     join is the decision this panel exists to support, and it cannot be made
 *     from a list that only contains factions already joined. Static facts come
 *     from the bundled transcription; live price, rep gap and ownership are
 *     overlaid from telemetry. */

// --- plan ------------------------------------------------------------------

const ACTION_LABELS: Record<string, string> = {
  idle: "idle",
  joinFaction: "join",
  workForFaction: "work",
  stopWork: "stop work",
  donate: "donate",
  purchaseAugmentation: "buy",
  graft: "graft",
  travelTo: "travel",
  installAugmentations: "install",
};

interface FactionPlanAction {
  type: string;
  faction?: string;
  augmentation?: string;
  city?: string;
  workType?: string;
  amount?: number;
  purchaseCost?: number;
}

function actionLine(action: FactionPlanAction): string {
  const label = ACTION_LABELS[action.type] ?? action.type;
  const subject = action.type === "donate" && action.amount !== undefined
    ? `${fmtMoney(action.amount)}${action.faction ? ` to ${action.faction}` : ""}`
    : action.augmentation
      ? `${action.augmentation}${action.faction ? ` from ${action.faction}` : ""}`
      : (action.faction ?? action.city ?? "");
  const work = action.workType ? ` (${action.workType})` : "";
  return `${esc(label)}${subject ? ` <strong>${esc(subject)}</strong>` : ""}${esc(work)}`;
}

function fmtRate(value: number | undefined): string {
  if (value === undefined || Number.isNaN(value)) return "–";
  return Math.abs(value) >= 0.001 ? fmtNum(value, 3) : formatScientific(value);
}

function planCard(state: ProjectedState): string {
  const plan = state.topics.factions?.plan;
  if (!plan) return card("Plan", note("no decision yet — the factions driver has not run"));

  const parts: string[] = [];

  if (plan.blocked) {
    if (typeof plan.blocked === "object") {
      parts.push(tiles([
        { label: "blocker", value: esc(plan.blocked.kind) },
        { label: "BitNode", value: String(plan.blocked.bitNode) },
        { label: "SF4", value: String(plan.blocked.sf4Level) },
        { label: "RAM / call", value: `${fmtNum(plan.blocked.callRamGb)} GB` },
      ]));
    } else {
      // Old JSONL can contain the former prose-only shape. Do not repeat it;
      // there are no structured facts to recover from that record.
      parts.push(note("legacy blocked record (no structured RAM facts)"));
    }
  }

  parts.push(`<div class="row"><span class="muted">next</span> ${actionLine(plan.action as FactionPlanAction)}</div>`);

  {
    const context = plan.context;
    const augGoal = context.targetAugCount === undefined
      ? `${context.ownedAugCount} owned`
      : `${context.ownedAugCount} / ${context.targetAugCount}`;
    parts.push(tiles([
      { label: "planning window", value: fmtTime(context.horizonSec * 1000), sub: context.route ?? "no end route" },
      { label: "income", value: `${fmtMoney(context.incomePerSec)}/s` },
      { label: "cash", value: fmtMoney(context.moneyAvailable), sub: `${fmtMoney(context.moneyGranted)} granted` },
      { label: "augmentation goal", value: augGoal, sub: `${context.queuedAugCount} queued (included)` },
    ]));
    const inputRows = [
      ["work slot", context.holdsWorkSlot ? "granted" : "held elsewhere"],
      ["donation favor", fmtNum(context.favorToDonate, 0)],
      ["normal queue", String(context.priceQueue.nonSoA)],
      ["SoA owned", String(context.priceQueue.ownedSoA)],
      ["NeuroFlux level", String(context.priceQueue.neurofluxLevel)],
      ...(plan.invalidation ?? []).map((entry) => [`replan: ${entry.label}`, esc(entry.value)]),
    ];
    parts.push(collapsible("factions.inputs", "decision inputs", table(["input", "value"], inputRows, { left: [0, 1] })));
  }

  if (plan.until) {
    const eta = Number.isFinite(plan.until.etaSec) ? fmtTime(plan.until.etaSec * 1000) : "never at this rate";
    parts.push(
      `<div class="row"><span class="muted">until</span> ` +
        `${fmtNum(plan.until.have, 0)} / ${fmtNum(plan.until.target, 0)} ${esc(plan.until.kind)}` +
        `${plan.until.faction ? ` @ ${esc(plan.until.faction)}` : ""} — ${esc(eta)}</div>`,
    );
  }

  if (plan.lastResult) {
    // Every singularity call's `false` return is a MODELLED OUTCOME, not an
    // error, so a rejection is shown as a result rather than swallowed.
    const cls = plan.lastResult.ok ? "good" : "bad";
    parts.push(
      `<div class="row"><span class="muted">last</span> ` +
        `<span class="${cls}">${esc(plan.lastResult.action)}: ${esc(plan.lastResult.detail)}</span></div>`,
    );
  }

  if (plan.objective) {
    const objective = plan.objective;
    // Chips, not a comma-separated paragraph: twenty faction names wrapped
    // across three lines of prose is unreadable and unscannable.
    parts.push(
      `<div class="row"><span class="muted">objective</span></div>` +
        `<div class="chips">${
          objective.factions.map((name) => `<span class="chip idle">${esc(name)}</span>`).join("") ||
          `<span class="muted">none</span>`
        }</div>`,
    );
    if (objective.intent) {
      const intent = objective.intent;
      parts.push(
        `<div class="row"><span class="muted">breakpoint</span> ` +
          `<strong>${esc(intent.faction)}</strong> to ${fmtNum(intent.repTarget, 0)} rep ` +
          `(${intent.augmentations.length} aug, ${esc(fmtTime(intent.etaSec * 1000))})</div>` +
          `<div class="muted">favor after install ${fmtNum(intent.favorAfterInstall, 1)}</div>` +
          table(
            ["package", "value", "avg/sec", "marginal/sec", "ETA", "cash"],
            [
              [
                "chosen",
                fmtNum(intent.value, 3),
                fmtRate(intent.rate),
                fmtRate(intent.marginalRate),
                esc(fmtTime(intent.etaSec * 1000)),
                fmtMoney(intent.totalCost),
              ],
              ...(objective.runnerUp
                ? [[
                    `${esc(objective.runnerUp.faction)} @ ${fmtNum(objective.runnerUp.repTarget, 0)} rep`,
                    fmtNum(objective.runnerUp.value, 3),
                    fmtRate(objective.runnerUp.rate),
                    fmtRate(objective.runnerUp.marginalRate),
                    esc(fmtTime(objective.runnerUp.etaSec * 1000)),
                    fmtMoney(objective.runnerUp.totalCost),
                  ]]
                : []),
            ],
            { left: [0] },
          ) +
          `<div class="muted">ETA: unlock ${esc(fmtTime(intent.unlockSec * 1000))}, rep ${esc(fmtTime(intent.repSec * 1000))}, ` +
          `money ${esc(fmtTime(intent.moneySec * 1000))}; cash: ${fmtMoney(intent.purchaseCost)} purchase` +
          `${intent.donationCost > 0 ? ` + ${fmtMoney(intent.donationCost)} donation` : ""}</div>`,
      );
    }
    if (objective.foreclosed.length > 0) {
      // Enemy exclusions last for this install cycle, so show the trade-off.
      parts.push(
        `<div class="muted">forecloses this install cycle: ${objective.foreclosed
          .map((entry) => `${esc(entry.name)} (via ${esc(entry.bannedBy)})`)
          .join(", ")}</div>`,
      );
    }
    if (objective.augmentations.length > 0) {
      parts.push(
        collapsible(
          "factions.shopping",
          `shopping list — ${objective.augmentations.length} augmentation(s)`,
          table(
            ["#", "augmentation", "gives"],
            objective.augmentations.slice(0, 30).map((name, i) => [
              String(i + 1),
              esc(name),
              `<span class="muted">${esc(
                describeMults(AUGMENTATIONS[name]?.mults, 2)
                  .map((m) => m.text)
                  .join(", ") || "—",
              )}</span>`,
            ]),
            { left: [1, 2] },
          ),
        ),
      );
    }
  }

  if (plan.nextBuy) {
    parts.push(
      `<div><strong>next purchase:</strong> ${esc(plan.nextBuy.name)} at ${fmtMoney(plan.nextBuy.price)}</div>` +
        note("priced at its slot in the purchase order, dearest first — this is what the money claim reserves"),
    );
  }

  if (plan.recommendInstall) {
    parts.push(
      `<div class="good"><strong>install candidate:</strong> ${plan.recommendInstall.augmentations.length} augmentation(s) acquired</div>` +
        note("advisory — the reset cadence belongs to the BitNode feature"),
    );
  }

  return card("Plan", parts.join(""));
}

function decisionHistory(state: ProjectedState): string {
  const decisions = state.events
    .filter((record) => record.kind === "event" && record.name === "faction.decision")
    .slice(-8)
    .reverse()
    .map((record) => {
      const data = record.data as { plan?: FactionPlan } | undefined;
      const plan = data?.plan;
      if (!plan) return undefined;
      const ageMs = Math.max(0, state.lastT - record.t);
      const when = ageMs < 1_000 ? "now" : `${fmtTime(ageMs)} ago`;
      const target = plan.objective?.intent;
      return [
        esc(when),
        actionLine(plan.action),
        target ? `${esc(target.faction)} @ ${fmtNum(target.repTarget, 0)} rep` : `<span class="muted">none</span>`,
      ];
    })
    .filter((row): row is string[] => row !== undefined);
  return decisions.length > 0
    ? table(["when", "decision", "target"], decisions, { left: [0, 1, 2] })
    : note("decision transitions will appear here as the plan changes");
}

// --- factions --------------------------------------------------------------

interface FactionRow {
  name: string;
  joined: boolean;
  invited: boolean;
  reachable: boolean;
  /** [0, 1] toward an invitation; 1 once joined or invited. */
  progress: number;
  rep: number;
  favor: number;
  /** Fraction of the donation favor gate. */
  favorFrac: number;
  canDonate: boolean;
  missing: GateBlocker[];
  workTypes: string[];
  enemies: string[];
  /** Augmentations this faction sells that we do not own. */
  augsLeft: number;
  inObjective: boolean;
}

function describeBlocker(blocker: GateBlocker): string {
  const subject = blocker.subject ? ` ${blocker.subject}` : "";
  const amounts =
    blocker.target > 0 && blocker.have >= 0 && blocker.kind !== "bitNode" && blocker.kind !== "sourceFile"
      ? ` ${fmtNum(blocker.have)}/${fmtNum(blocker.target)}`
      : "";
  return `${blocker.negated ? "not " : ""}${blocker.kind}${subject}${amounts}`;
}

function factionRows(state: ProjectedState): FactionRow[] {
  const f = state.topics.factions;
  if (!f) return [];
  const gates = f.gates ?? {};
  const standings = new Map<string, FactionStanding>((f.standings ?? []).map((s) => [s.name, s]));
  const joined = new Set(f.joined);
  const invited = new Set(f.invites ?? []);
  const owned = new Set(f.ownedAugs ?? []);
  const objective = new Set(f.plan?.objective?.factions ?? []);
  const gate = f.favorToDonate;

  // Every faction we know of from any source: the gate map is complete once
  // the driver has run, but before that the joined list is all we have.
  const names = new Set<string>([
    ...Object.keys(gates),
    ...Object.keys(f.requirements ?? {}),
    ...joined,
    ...invited,
  ]);

  return [...names].map((name) => {
    const g: FactionGate | undefined = gates[name];
    const standing = standings.get(name);
    const favor = standing?.favor ?? 0;
    const augsLeft = Object.entries(AUGMENTATIONS).filter(
      ([aug, info]) => info.factions.includes(name) && !owned.has(aug),
    ).length;
    return {
      name,
      joined: joined.has(name),
      invited: invited.has(name),
      reachable: g?.reachable ?? true,
      progress: joined.has(name) || invited.has(name) ? 1 : (g?.progress ?? 0),
      rep: standing?.rep ?? 0,
      favor,
      favorFrac: gate ? Math.min(1, favor / gate) : 0,
      canDonate: gate !== undefined && favor >= gate,
      missing: g?.missing ?? [],
      workTypes: f.workTypes?.[name] ?? [],
      enemies: f.enemies?.[name] ?? [],
      augsLeft,
      inObjective: objective.has(name),
    };
  });
}

function factionStatus(row: FactionRow): { status: Status; tooltip: string } {
  if (row.joined) return { status: "good", tooltip: "joined" };
  if (row.invited) return { status: "ready", tooltip: "invitation pending — join it" };
  if (!row.reachable) return { status: "bad", tooltip: "not reachable in this run" };
  return { status: "wait", tooltip: `${row.missing.length} requirement(s) still missing` };
}

const FACTION_COLUMNS: Column<FactionRow>[] = [
  {
    id: "name",
    label: "faction",
    left: true,
    sort: (r) => r.name,
    cell: (r) => {
      const { status, tooltip } = factionStatus(r);
      const star = r.inObjective ? ` <span class="warn" title="in the current objective">★</span>` : "";
      return `${dot(status, tooltip)}${esc(r.name)}${star}`;
    },
  },
  {
    id: "progress",
    label: "invite",
    sort: (r) => r.progress,
    cell: (r) => {
      if (r.joined) return `<span class="good">joined</span>`;
      if (r.invited) return `<span class="good">invited</span>`;
      if (!r.reachable) return `<span class="bad">unreachable</span>`;
      return meter(r.progress, `${(r.progress * 100).toFixed(0)}%`, false, "progress on the bottleneck requirement");
    },
  },
  {
    id: "missing",
    label: "still needs",
    wrap: true,
    sort: (r) => r.missing.length,
    cell: (r) => {
      if (r.missing.length === 0) return `<span class="muted">—</span>`;
      return r.missing
        .slice(0, 4)
        .map(
          (blocker) =>
            `<span class="need ${blocker.reachable ? "" : "bad"}">` +
            `${esc(describeBlocker(blocker))}` +
            `<span class="owner">${esc(blocker.owner)}</span></span>`,
        )
        .join(" ")
        .concat(r.missing.length > 4 ? ` <span class="muted">+${r.missing.length - 4}</span>` : "");
    },
  },
  { id: "rep", label: "rep", sort: (r) => r.rep, cell: (r) => (r.joined ? fmtNum(r.rep, 0) : `<span class="muted">–</span>`) },
  {
    id: "favor",
    label: "favor",
    sort: (r) => r.favor,
    cell: (r) => {
      if (!r.joined) return `<span class="muted">–</span>`;
      // Favor only matters as a donation gate, so it is shown as progress
      // toward that gate rather than as a bare number.
      return meter(r.favorFrac, fmtNum(r.favor, 1), r.canDonate, r.canDonate ? "donations unlocked" : "favor needed to donate");
    },
  },
  {
    id: "augs",
    label: "augs left",
    sort: (r) => r.augsLeft,
    cell: (r) => (r.augsLeft > 0 ? String(r.augsLeft) : `<span class="muted">—</span>`),
  },
  {
    id: "work",
    label: "work",
    left: true,
    sort: (r) => r.workTypes.join(","),
    cell: (r) => (r.workTypes.length ? `<span class="muted">${esc(r.workTypes.join(", "))}</span>` : `<span class="muted">–</span>`),
  },
];

// --- augmentations ---------------------------------------------------------

interface AugRow {
  name: string;
  owned: boolean;
  /** Live offer from a joined faction, when there is one. */
  offer?: AugmentationOffer;
  cost: number;
  rep: number;
  factions: readonly string[];
  /** Factions we are in that sell it. */
  fromJoined: string[];
  gives: string;
  multsUnknown: boolean;
  prereqs: readonly string[];
  inPlan: boolean;
}

function augRows(state: ProjectedState): AugRow[] {
  const f = state.topics.factions;
  const owned = new Set(f?.ownedAugs ?? []);
  const joined = new Set(f?.joined ?? []);
  const planned = new Set(f?.plan?.objective?.augmentations ?? []);
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
    return {
      name,
      owned: owned.has(name),
      ...(offer ? { offer } : {}),
      cost: offer?.price ?? info.cost,
      rep: offer?.repReq ?? info.rep,
      factions: info.factions,
      fromJoined: info.factions.filter((faction) => joined.has(faction)),
      gives:
        describeMults(mults, 3)
          .map((m) => m.text)
          .join(", ") ||
        (info.startingMoney ? `${fmtMoney(info.startingMoney)} on install` : "") ||
        (info.programs?.length ? `${info.programs.length} program(s)` : "") ||
        "—",
      multsUnknown: info.multsUnknown === true && meta[name]?.mults === undefined,
      prereqs: info.prereqs ?? [],
      inPlan: planned.has(name),
    };
  });
}

const AUG_COLUMNS: Column<AugRow>[] = [
  {
    id: "name",
    label: "augmentation",
    left: true,
    sort: (r) => r.name,
    cell: (r) => {
      const status: Status = r.owned ? "good" : r.offer?.affordableRep ? "ready" : r.fromJoined.length ? "wait" : "off";
      const tooltip = r.owned
        ? "owned"
        : r.offer?.affordableRep
          ? "reputation met — purchasable"
          : r.fromJoined.length
            ? "offered by a faction we are in, reputation short"
            : "no faction we are in offers this";
      const plan = r.inPlan ? ` <span class="warn" title="in the current shopping list">★</span>` : "";
      const pre = r.prereqs.length
        ? ` <span class="muted" title="${esc(`needs ${r.prereqs.join(", ")}`)}">(needs ${r.prereqs.length})</span>`
        : "";
      return `${dot(status, tooltip)}${esc(r.name)}${plan}${pre}`;
    },
  },
  {
    id: "gives",
    label: "gives",
    left: true,
    wrap: true,
    sort: (r) => r.gives,
    cell: (r) =>
      r.multsUnknown
        ? `<span class="muted" title="upstream randomises this augmentation's multipliers per save">randomised</span>`
        : `<span class="muted">${esc(r.gives)}</span>`,
  },
  {
    id: "from",
    label: "from",
    left: true,
    wrap: true,
    sort: (r) => r.factions.length,
    cell: (r) => {
      if (r.factions.length === 0) return `<span class="muted">not sold</span>`;
      // Factions we are already in first, and marked: that is the difference
      // between "buy it" and "join something first".
      const inside = r.fromJoined.map((name) => `<span class="good">${esc(name)}</span>`);
      const outside = r.factions
        .filter((name) => !r.fromJoined.includes(name))
        .map((name) => `<span class="muted">${esc(name)}</span>`);
      return [...inside, ...outside].join(", ");
    },
  },
  {
    id: "cost",
    label: "price",
    sort: (r) => r.cost,
    cell: (r) => {
      if (!Number.isFinite(r.cost)) return `<span class="muted">unbuyable</span>`;
      const base = r.offer?.basePrice;
      // Both prices when they differ: the 1.9^queued escalation should be
      // visible as an escalation, not look like a price change.
      return base !== undefined && base !== r.cost
        ? `${fmtMoney(r.cost)} <span class="muted">(base ${fmtMoney(base)})</span>`
        : fmtMoney(r.cost);
    },
  },
  {
    id: "rep",
    label: "rep",
    sort: (r) => r.rep,
    cell: (r) => {
      if (!Number.isFinite(r.rep)) return `<span class="muted">–</span>`;
      if (r.owned) return `<span class="muted">owned</span>`;
      if (r.offer?.affordableRep) return `<span class="good">met</span>`;
      const gap = r.offer?.repGap;
      return gap !== undefined
        ? `<span class="muted" title="reputation still needed at the cheapest offering faction">${fmtNum(gap, 0)} short</span>`
        : fmtNum(r.rep, 0);
    },
  },
];

// --- tab -------------------------------------------------------------------

export const factionsTab: Tab = {
  id: "factions",
  render(state: ProjectedState) {
    const f = state.topics.factions;
    if (!f) return note("waiting for the factions probe");

    const rows = factionRows(state);
    // One predicate per filter, used for BOTH the badge and the filtering. A
    // badge computed separately drifts from the rows it promises: "reachable"
    // counted only un-invited factions while the filter included invited ones,
    // so every pending invitation made the badge undercount its own view.
    const FACTION_VIEWS: { value: string; label: string; match(row: (typeof rows)[number]): boolean }[] = [
      { value: "all", label: "all", match: () => true },
      { value: "joined", label: "joined", match: (r) => r.joined },
      { value: "open", label: "reachable", match: (r) => !r.joined && r.reachable },
      { value: "objective", label: "objective", match: (r) => r.inObjective },
      { value: "unreachable", label: "unreachable", match: (r) => !r.reachable },
    ];
    const counts = {
      joined: rows.filter((r) => r.joined).length,
      invited: rows.filter((r) => r.invited).length,
    };
    const factionMode = view("factions.mode", "all");
    const active = FACTION_VIEWS.find((v) => v.value === factionMode) ?? FACTION_VIEWS[0]!;
    const shown = rows.filter((r) => active.match(r));

    const factionControls = filters(
      "factions.mode",
      FACTION_VIEWS.map((v) => ({
        value: v.value,
        label: v.label,
        badge: String(rows.filter((r) => v.match(r)).length),
      })),
      "all",
    );

    const factionTable = f.gates
      ? dataTable("factions.list", shown, FACTION_COLUMNS, {
          defaultSort: { key: "progress", dir: -1 },
          empty: "no factions match this filter",
        })
      : dataTable("factions.list", shown, FACTION_COLUMNS, {
          defaultSort: { key: "name", dir: 1 },
          empty: "no factions known yet",
        }) + note("requirement evaluation needs the factions driver — joined/rep only until it runs");

    // --- augmentations ---
    const augs = augRows(state);
    const augMode = view("augs.mode", "available");
    const needle = view("augs.search").trim().toLowerCase();
    const augCounts = {
      owned: augs.filter((a) => a.owned).length,
      available: augs.filter((a) => !a.owned && a.fromJoined.length > 0).length,
      planned: augs.filter((a) => a.inPlan).length,
    };
    const shownAugs = augs.filter((a) => {
      if (needle && !a.name.toLowerCase().includes(needle) && !a.gives.toLowerCase().includes(needle)) return false;
      if (augMode === "owned") return a.owned;
      if (augMode === "available") return !a.owned && a.fromJoined.length > 0;
      if (augMode === "planned") return a.inPlan;
      if (augMode === "locked") return !a.owned && a.fromJoined.length === 0;
      return true;
    });

    const augControls =
      filters(
        "augs.mode",
        [
          { value: "available", label: "buyable", badge: String(augCounts.available) },
          { value: "planned", label: "planned", badge: String(augCounts.planned) },
          { value: "owned", label: "owned", badge: String(augCounts.owned) },
          { value: "locked", label: "locked" },
          { value: "all", label: "all", badge: String(augs.length) },
        ],
        "available",
      ) + search("augs.search", "name or effect…");

    const summary = tiles([
      { label: "joined", value: String(counts.joined), sub: `${rows.length} exist` },
      { label: "invites", value: String(counts.invited) },
      { label: "augs owned", value: String(augCounts.owned), sub: `${augs.length} exist` },
      { label: "buyable now", value: String(augCounts.available) },
    ]);

    const graft =
      f.graftable && f.graftable.length > 0
        ? table(
            ["augmentation", "price", "time"],
            f.graftable.slice(0, 40).map((g) => [esc(g.name), fmtMoney(g.price), fmtTime(g.timeMs)]),
            { left: [0] },
          )
        : note("nothing graftable (needs New Tokyo's VitaLife clinic)");

    const alternatives =
      f.plan && f.plan.alternatives.length > 0
        ? table(
            ["alternative", "value"],
            f.plan.alternatives
              .slice()
              .sort((a, b) => b.value - a.value)
              .slice(0, 6)
              .map((entry) => [esc(entry.label), fmtNum(entry.value, 3)]),
            { left: [0] },
          )
        : note("no scored alternatives");

    return (
      `<div class="col wide">` +
      planCard(state) +
      card("Factions", summary + factionTable, factionControls) +
      card("Augmentations", dataTable("augs.list", shownAugs, AUG_COLUMNS, {
        defaultSort: { key: "cost", dir: 1 },
        empty: "nothing matches this filter",
        limit: 200,
      }), augControls) +
      `</div>` +
      `<div class="col">` +
      card("Decision history", decisionHistory(state)) +
      card("Alternatives considered", alternatives) +
      card("Grafting", graft) +
      `</div>`
    );
  },
};

/** Re-exported for the tests, which assert the catalogue joins correctly. */
export { augRows, factionRows, offeredBy };
